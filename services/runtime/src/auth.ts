// Access control (design §6.6 / contract §2): Host allowlist, Origin rules by
// method/credential, operator Bearer, one-time pairing codes, LAN access code
// with constant-time compare, per-IP rate limiting, session cookies. No CORS
// headers are ever returned. No tokens/codes appear in static responses.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {DeviceError, type Principal} from '@oscar/device-contract';
import type {Runtime} from './runtime.ts';
import type {RuntimeConfig} from './config.ts';

export const SESSION_COOKIE = 'oscar_session';

const sha = (v: string): Buffer => createHash('sha256').update(v).digest();

function constantTimeEqual(a: string, b: string): boolean {
  const da = sha(a);
  const db = sha(b);
  return timingSafeEqual(da, db);
}

export class Auth {
  private readonly runtime: Runtime;
  private readonly config: RuntimeConfig;
  constructor(runtime: Runtime, config: RuntimeConfig) {
    this.runtime = runtime;
    this.config = config;
  }

  // -- Host / Origin ---------------------------------------------------------

  allowedHosts(port: number): string[] {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    for (const entry of this.config.allowHosts) {
      hosts.push(entry.includes(':') ? entry : `${entry}:${port}`);
    }
    return hosts;
  }

  checkHost(host: string | undefined, port: number): void {
    if (!host || !this.allowedHosts(port).includes(host)) {
      throw new DeviceError('host_not_allowed', `Host ${host ?? '(missing)'} is not allowed`);
    }
  }

  checkOrigin(origin: string | undefined, host: string | undefined, port: number): void {
    if (origin === undefined) return; // no Origin: rules fall back to credential type
    const allowed = this.allowedHosts(port).map(h => `http://${h}`);
    if (!allowed.includes(origin)) {
      throw new DeviceError('origin_mismatch', `Origin ${origin} is not allowed here`);
    }
  }

  // -- credentials -----------------------------------------------------------

  /** Resolve the credential on the request. Cookie is IGNORED for non-GET/HEAD without Origin. */
  authenticate(headers: Record<string, string | string[] | undefined>, method: string): Principal | null {
    const h = (name: string): string | undefined => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const authorization = h('authorization');
    const origin = h('origin');
    const cookieHeader = h('cookie') ?? '';
    const cookieToken = /(?:^|;\s*)oscar_session=([A-Za-z0-9_-]+)/.exec(cookieHeader)?.[1];
    const safeMethod = method === 'GET' || method === 'HEAD';
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.slice(7).trim();
      if (constantTimeEqual(token, this.runtime.operatorToken)) return {kind: 'operator', id: 'operator'};
      // The Culture Agent's service token: durable read + realtime write
      // access for long-lived sessions. It is only known to processes that
      // can read <data>/secrets/ (mode 0700, Runtime + Agent).
      if (constantTimeEqual(token, this.runtime.serviceToken)) return {kind: 'service', id: `runtime:${this.runtime.instanceId}`};
      const run = this.runtime.resolveRunToken(token);
      if (run) return {kind: 'run', id: `run:${run.run_id}`, run_id: run.run_id};
      return null; // invalid bearer: do not fall through to cookies
    }
    if (cookieToken && (safeMethod || origin !== undefined)) {
      const hashed = sha(cookieToken).toString('hex');
      const row = this.runtime.store.stmt('SELECT expires_at_wall FROM sessions WHERE token_sha256 = ?')
        .get(hashed) as {expires_at_wall: string} | undefined;
      if (row && Date.parse(row.expires_at_wall) > Date.now()) return {kind: 'operator', id: 'operator'};
    }
    return null;
  }

  // -- sessions / pairing ------------------------------------------------------

  createSession(): {token: string; expiresAt: string} {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.sessionTtlMs).toISOString();
    this.runtime.store.tx(() => {
      this.runtime.store.stmt('INSERT INTO sessions (token_sha256, created_at_wall, expires_at_wall) VALUES (?,?,?)')
        .run(sha(token).toString('hex'), new Date().toISOString(), expiresAt);
    });
    return {token, expiresAt};
  }

  deleteSession(cookieHeader: string | undefined): void {
    const token = /(?:^|;\s*)oscar_session=([A-Za-z0-9_-]+)/.exec(cookieHeader ?? '')?.[1];
    if (!token) return;
    this.runtime.store.tx(() => {
      this.runtime.store.stmt('DELETE FROM sessions WHERE token_sha256 = ?').run(sha(token).toString('hex'));
    });
  }

  newPairingCode(): {code: string; expiresAt: string} {
    const code = randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.pairingTtlMs).toISOString();
    this.runtime.store.tx(() => {
      this.runtime.store.stmt('INSERT INTO pairing_codes (code_hash, created_at_wall, expires_at_wall) VALUES (?,?,?)')
        .run(sha(code).toString('hex'), new Date().toISOString(), expiresAt);
    });
    return {code, expiresAt};
  }

  login(body: {pairing_code?: string; access_code?: string}, ip: string): {ok: boolean; reason?: string} {
    // Rate limit FIRST (constant responses regardless of code validity).
    const limited = this.checkRateLimit(ip, false);
    if (limited) return {ok: false, reason: 'rate_limited'};
    if (body.pairing_code !== undefined) {
      const hash = sha(body.pairing_code).toString('hex');
      const row = this.runtime.store.stmt('SELECT used, expires_at_wall FROM pairing_codes WHERE code_hash = ?')
        .get(hash) as {used: number; expires_at_wall: string} | undefined;
      if (!row || row.used === 1 || Date.parse(row.expires_at_wall) <= Date.now()) {
        return {ok: false, reason: 'invalid'};
      }
      this.runtime.store.tx(() => {
        this.runtime.store.stmt('UPDATE pairing_codes SET used = 1 WHERE code_hash = ?').run(hash);
      });
      return {ok: true};
    }
    if (body.access_code !== undefined) {
      if (!this.config.accessCode || !constantTimeEqual(body.access_code, this.config.accessCode)) {
        return {ok: false, reason: 'invalid'};
      }
      return {ok: true};
    }
    return {ok: false, reason: 'invalid'};
  }

  // -- rate limiting -----------------------------------------------------------

  private checkRateLimit(ip: string, recordFailure: boolean): boolean {
    const row = this.runtime.store.stmt('SELECT failures, blocked_until_wall FROM auth_failures WHERE ip = ?')
      .get(ip) as {failures: number; blocked_until_wall: string | null} | undefined;
    if (row?.blocked_until_wall && Date.parse(row.blocked_until_wall) > Date.now()) return true;
    return false;
  }

  recordFailure(ip: string): void {
    const row = this.runtime.store.stmt('SELECT failures FROM auth_failures WHERE ip = ?')
      .get(ip) as {failures: number} | undefined;
    const failures = (row?.failures ?? 0) + 1;
    let blockedUntil: string | null = null;
    if (failures >= 5) {
      const base = this.config.rateLimitBaseMs;
      const backoff = base * Math.pow(2, failures - 5);
      blockedUntil = new Date(Date.now() + backoff).toISOString();
    }
    this.runtime.store.tx(() => {
      this.runtime.store.stmt(`INSERT INTO auth_failures (ip, failures, blocked_until_wall) VALUES (?,?,?)
        ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, blocked_until_wall = excluded.blocked_until_wall`)
        .run(ip, failures, blockedUntil);
    });
  }

  recordSuccess(ip: string): void {
    this.runtime.store.tx(() => {
      this.runtime.store.stmt('DELETE FROM auth_failures WHERE ip = ?').run(ip);
    });
  }

  /** Is this IP currently blocked? Used to answer 429 before validating. */
  isBlocked(ip: string): boolean {
    const row = this.runtime.store.stmt('SELECT blocked_until_wall FROM auth_failures WHERE ip = ?')
      .get(ip) as {blocked_until_wall: string | null} | undefined;
    return Boolean(row?.blocked_until_wall && Date.parse(row.blocked_until_wall!) > Date.now());
  }
}
