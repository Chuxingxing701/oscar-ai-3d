// HTTP layer: request pipeline (Host → Origin → auth/scope → handler), JSON
// routes per the API contract, SSE, static whitelist, gateway. No CORS headers.
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {buildManifest, DeviceError, type Lease, type Principal, type SubmitActionRequest,
  type WakeCondition} from '@oscar/device-contract';
import type {RuntimeConfig} from './config.ts';
import {Auth, SESSION_COOKIE} from './auth.ts';
import {Runtime} from './runtime.ts';
import {handleEvents} from './sse.ts';
import {resolveStatic} from './static.ts';
import {proxyToAgent} from './gateway.ts';

const MAX_BODY = 2 * 1024 * 1024;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  body: Record<string, unknown> | null;
  rawBody: Buffer | null;
  principal: Principal | null;
  port: number;
}

export interface HttpServerOptions {
  runtime: Runtime;
  config: RuntimeConfig;
  clock: {start: () => void};
}

export class HttpApi {
  readonly server: Server;
  private readonly auth: Auth;
  private readonly opts: HttpServerOptions;
  private port = 0;

  constructor(opts: HttpServerOptions) {
    this.opts = opts;
    this.auth = new Auth(opts.runtime, opts.config);
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        this.sendError(res, req, e);
      });
    });
  }

  async listen(port: number, host: string): Promise<number> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolvePromise();
      });
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : port;
    return this.port;
  }

  close(): Promise<void> {
    return new Promise(resolvePromise => this.server.close(() => resolvePromise()));
  }

  // -- pipeline --------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      const host = req.headers.host;
      // 1. Host allowlist (DNS rebinding guard)
      this.auth.checkHost(host, this.port);

      const url = new URL(req.url ?? '/', `http://${host ?? 'localhost'}`);
      const path = url.pathname;

      // 2. anonymous surface: health, session login, static whitelist
      if (method === 'GET' && path === '/api/v1/health') {
        return this.sendJson(res, 200, {ok: true, service: 'oscar-runtime', version: '0.1.0',
          instance_id: this.opts.runtime.instanceId});
      }
      if (!path.startsWith('/api/')) {
        return this.serveStatic(req, res, path);
      }

      // read body (JSON only) for methods that carry one
      let rawBody: Buffer | null = null;
      let body: Record<string, unknown> | null = null;
      if (method !== 'GET' && method !== 'HEAD') {
        rawBody = await this.readBody(req);
        if (rawBody.length > 0) {
          const contentType = String(req.headers['content-type'] ?? '');
          if (!contentType.startsWith('application/json')) {
            throw new DeviceError('unsupported_media_type', `Content-Type must be application/json (got ${contentType || 'none'})`);
          }
          try {
            body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
          } catch {
            throw new DeviceError('invalid_request', 'Body is not valid JSON');
          }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            throw new DeviceError('invalid_request', 'Body must be a JSON object');
          }
        } else {
          body = {};
        }
      }

      // 3. Origin (any method, any credential, when the header is present)
      this.auth.checkOrigin(req.headers.origin, host, this.port);

      if (method === 'POST' && path === '/api/v1/session') {
        return this.handleSessionLogin(req, res, body ?? {});
      }

      // 4. credentials (cookie rules depend on method + Origin)
      const principal = this.auth.authenticate(req.headers, method);
      const ctx: Ctx = {req, res, url, method, body, rawBody, principal, port: this.port};

      await this.route(ctx);
    } catch (e) {
      this.sendError(res, req, e);
    }
  }

  private async route(ctx: Ctx): Promise<void> {
    const {res, method, url} = ctx;
    const path = url.pathname;
    const runtime = this.opts.runtime;

    // ---- session ----
    if (path === '/api/v1/session' && method === 'GET') {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, {authenticated: true, principal: ctx.principal!.id});
    }
    if (path === '/api/v1/session' && method === 'DELETE') {
      this.requireAuth(ctx);
      this.auth.deleteSession(ctx.req.headers.cookie);
      res.writeHead(204, {'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`});
      res.end();
      return;
    }
    if (path === '/api/v1/pairing-codes' && method === 'POST') {
      this.requireOperator(ctx);
      const {code, expiresAt} = this.auth.newPairingCode();
      return this.sendJson(res, 200, {code, url: `http://127.0.0.1:${this.port}/pair#code=${code}`,
        expires_at: expiresAt});
    }

    // ---- devices ----
    if (path === '/api/v1/devices' && method === 'GET') {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, {devices: [{device_id: 'oscar-01', profile: 'oscar-mhs-demo/0.1',
        manifest_version: '0.1.0'}]});
    }
    const manifestMatch = /^\/api\/v1\/devices\/([^/]+)\/manifest$/.exec(path);
    if (manifestMatch && method === 'GET') {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, buildManifest());
    }

    // ---- experiments ----
    if (path === '/api/v1/experiments' && method === 'GET') {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, runtime.listExperiments());
    }
    if (path === '/api/v1/experiments' && method === 'POST') {
      this.requireOperator(ctx);
      const exp = runtime.createExperiment(ctx.body as {scenario_id?: string; seed?: number;
        clock_mode?: 'lockstep' | 'realtime'});
      this.opts.clock.start();
      return this.sendJson(res, 201, runtime.toExperimentInfo(exp));
    }

    const expMatch = /^\/api\/v1\/experiments\/([^/]+)(\/.*)?$/.exec(path);
    if (expMatch) {
      return this.routeExperiment(ctx, expMatch[1], expMatch[2] ?? '');
    }

    const runMatch = /^\/api\/v1\/runs\/([^/]+)(\/.*)?$/.exec(path);
    if (runMatch) {
      return this.routeRun(ctx, runMatch[1], runMatch[2] ?? '');
    }

    const agentMatch = /^\/api\/v1\/agent(\/.*)?$/.exec(path);
    if (agentMatch) {
      return this.handleGateway(ctx, agentMatch[1] ?? '/');
    }

    throw new DeviceError('not_found', `No route ${method} ${path}`);
  }

  private async routeExperiment(ctx: Ctx, experimentId: string, rest: string): Promise<void> {
    const {res, method} = ctx;
    const runtime = this.opts.runtime;
    const exp = runtime.loadExp(decodeURIComponent(experimentId));
    if (!exp) throw new DeviceError('not_found', `No experiment ${experimentId}`);

    if (rest === '/state' && (method === 'GET' || method === 'HEAD')) {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, runtime.snapshot(exp.id));
    }
    if (rest === '/debug/truth' && method === 'GET') {
      this.requireOperator(ctx);
      return this.sendJson(res, 200, runtime.debugTruth(exp.id));
    }
    if (/^\/chambers\/[^/]+$/.test(rest) && (method === 'GET' || method === 'HEAD')) {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, runtime.chamberReading(runtime.loadWorld(exp.id)));
    }
    if (rest === '/actions' && method === 'POST') {
      this.requireAuth(ctx);
      const isRun = ctx.principal!.kind === 'run';
      if (isRun && exp.status !== 'active') throw new DeviceError('experiment_archived', `Experiment ${exp.id} is ${exp.status}`);
      const body = ctx.body as unknown as SubmitActionRequest;
      if (!body || typeof body.capability !== 'string') throw new DeviceError('invalid_argument', 'capability is required');
      const idempotencyKey = header(ctx.req, 'idempotency-key') ?? null;
      const leaseId = header(ctx.req, 'lease-id') != null ? Number(header(ctx.req, 'lease-id')) : null;
      const result = runtime.acceptAction(exp.id, ctx.principal!, body, {idempotencyKey, leaseId});
      this.opts.clock.start();
      return this.sendJson(res, result.status, result.action);
    }
    if (rest === '/actions' && method === 'GET') {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, {actions: runtime.listActions(exp.id)});
    }
    const byKey = /^\/actions\/by-key\/(.+)$/.exec(rest);
    if (byKey && method === 'GET') {
      this.requireAuth(ctx);
      const row = runtime.store.stmt('SELECT * FROM actions WHERE experiment_id=? AND principal=? AND idempotency_key=?')
        .get(exp.id, ctx.principal!.kind === 'operator' ? 'operator' : `run:${ctx.principal!.run_id}`,
          decodeURIComponent(byKey[1])) as Record<string, unknown> | undefined;
      if (!row) throw new DeviceError('not_found', 'Unknown idempotency key for this principal');
      return this.sendJson(res, 200, JSON.parse(String(row.response_json)));
    }
    const actionGet = /^\/actions\/([^/]+)$/.exec(rest);
    if (actionGet && method === 'GET') {
      this.requireAuth(ctx);
      const row = runtime.store.stmt('SELECT action_json FROM actions WHERE id=? AND experiment_id=?')
        .get(actionGet[1], exp.id) as {action_json: string} | undefined;
      if (!row) throw new DeviceError('not_found', `No action ${actionGet[1]}`);
      return this.sendJson(res, 200, JSON.parse(row.action_json));
    }
    const cancel = /^\/actions\/([^/]+)\/cancel$/.exec(rest);
    if (cancel && method === 'POST') {
      this.requireAuth(ctx);
      const result = runtime.cancelAction(exp.id, cancel[1], ctx.principal!);
      return this.sendJson(res, result.status, result.action);
    }
    if (rest === '/observations' && method === 'GET') {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, {observations: runtime.listObservations(exp.id)});
    }
    const obs = /^\/observations\/([^/]+)$/.exec(rest);
    if (obs && (method === 'GET' || method === 'HEAD')) {
      this.requireAuth(ctx);
      const observation = runtime.getObservation(exp.id, obs[1]);
      if (!observation) throw new DeviceError('not_found', `No observation ${obs[1]}`);
      return this.sendJson(res, 200, observation);
    }
    const asset = /^\/assets\/([^/]+)$/.exec(rest);
    if (asset && (method === 'GET' || method === 'HEAD')) {
      this.requireAuth(ctx);
      const a = runtime.getAsset(exp.id, asset[1]);
      if (!a) throw new DeviceError('not_found', `No asset ${asset[1]}`);
      res.writeHead(200, {'content-type': 'image/png', etag: `"${a.sha256}"`, 'x-content-sha256': a.sha256,
        'cache-control': 'no-store'});
      if (method !== 'HEAD') res.end(Buffer.from(a.bytes));
      else res.end();
      return;
    }
    if (rest === '/events' && (method === 'GET' || method === 'HEAD')) {
      this.requireAuth(ctx);
      return handleEvents(runtime, this.auth, ctx.req, res, exp.id, ctx.url);
    }
    if (rest === '/leases/current' && method === 'GET') {
      this.requireAuth(ctx);
      if (exp.clock_mode !== 'lockstep') throw new DeviceError('clock_mode_mismatch', 'leases exist only in lockstep');
      const lease = runtime.activeLease(exp.id);
      return this.sendJson(res, 200, {lease: lease ? wireLease(lease) : null});
    }
    const renew = /^\/leases\/(\d+)\/renew$/.exec(rest);
    if (renew && method === 'POST') {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, runtime.renewLease(exp.id, Number(renew[1]), ctx.principal!));
    }
    const release = /^\/leases\/(\d+)\/release$/.exec(rest);
    if (release && method === 'POST') {
      this.requireAuth(ctx);
      const wake = (ctx.body?.wake ?? null) as WakeCondition | null;
      if (!wake) throw new DeviceError('invalid_argument', 'release body must carry wake');
      const result = runtime.releaseLease(exp.id, Number(release[1]), wake, ctx.principal!);
      this.opts.clock.start();
      return this.sendJson(res, 200, result);
    }
    if (rest === '/control' && method === 'POST') {
      this.requireOperator(ctx);
      if (exp.status !== 'active') throw new DeviceError('experiment_archived', `Experiment ${exp.id} is ${exp.status}`);
      const result = runtime.control(exp.id, ctx.body ?? {});
      this.opts.clock.start();
      return this.sendJson(res, 200, result);
    }
    if (rest === '/runs' && method === 'GET') {
      this.requireAuth(ctx);
      return this.sendJson(res, 200, {runs: runtime.listRuns(exp.id)});
    }
    if (rest === '/runs/current' && method === 'GET') {
      this.requireAuth(ctx);
      const run = runtime.nonEndedRun(exp.id) ?? runtime.latestRun(exp.id);
      return this.sendJson(res, 200, {run: run?.run ?? null});
    }
    throw new DeviceError('not_found', `No route ${method} ${rest}`);
  }

  private async routeRun(ctx: Ctx, runId: string, rest: string): Promise<void> {
    const {res, method} = ctx;
    const runtime = this.opts.runtime;
    const run = runtime.runById(decodeURIComponent(runId));
    if (!run) throw new DeviceError('not_found', `No run ${runId}`);
    if (rest === '' && method === 'GET') {
      this.requireAuth(ctx);
      if (ctx.principal!.kind === 'run' && ctx.principal!.run_id !== run.id) {
        throw new DeviceError('forbidden', 'Run tokens may only read their own run');
      }
      return this.sendJson(res, 200, run.run);
    }
    if (rest === '/agent-status' && method === 'POST') {
      if (ctx.principal?.kind !== 'run' || ctx.principal.run_id !== run.id) {
        throw new DeviceError('forbidden', 'Only the run token may report agent status');
      }
      const status = String(ctx.body?.status ?? '');
      if (status === 'paused') {
        const updated = runtime.agentStatus(run.id, status, ctx.body?.reason ? String(ctx.body.reason) : null);
        return this.sendJson(res, 200, updated);
      }
      if (status === 'ended') {
        // 【C3 细化】final report delivery: ends the run via the existing
        // endRun path and stores the report JSON (agent_reports table).
        const reason = String(ctx.body?.reason ?? '');
        if (reason !== 'completed' && reason !== 'failed' && reason !== 'aborted') {
          throw new DeviceError('invalid_argument', "ended requires reason 'completed' | 'failed' | 'aborted'");
        }
        const updated = runtime.agentEnded(run.id, reason, ctx.body?.report ?? null);
        return this.sendJson(res, 200, updated);
      }
      throw new DeviceError('invalid_argument',
        "agent-status accepts {status:'paused', reason} or {status:'ended', reason:'completed'|'failed'|'aborted', report?}");
    }
    if (rest === '/report' && method === 'GET') {
      this.requireAuth(ctx);
      if (ctx.principal!.kind === 'run' && ctx.principal!.run_id !== run.id) {
        throw new DeviceError('forbidden', 'Run tokens may only read their own report');
      }
      const report = runtime.agentReport(run.id);
      if (!report) throw new DeviceError('not_found', `No agent report for run ${run.id}`);
      return this.sendJson(res, 200, report);
    }
    throw new DeviceError('not_found', `No route ${method} /api/v1/runs/${runId}${rest}`);
  }

  // -- gateway --------------------------------------------------------------

  private async handleGateway(ctx: Ctx, subPath: string): Promise<void> {
    this.requireOperator(ctx); // run tokens are forbidden on the gateway
    const {runtime, config} = this.opts;

    // POST /api/v1/agent/runs — Runtime transaction first, then forward (§4.1)
    if (subPath === '/runs' && ctx.method === 'POST') {
      const idempotencyKey = header(ctx.req, 'idempotency-key') ?? null;
      const result = await runtime.createRun(ctx.body as {experiment_id?: string; mode?: 'scripted' | 'llm';
        goal?: string; plates?: string[]; capabilities?: string[]; budget?: {max_actions?: number}},
        idempotencyKey, async payload => {
        const r = await fetch(`${config.agentUrl}/runs`, {method: 'POST',
          headers: {'content-type': 'application/json', 'x-service-token': runtime.serviceToken},
          body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000)});
        if (!r.ok) throw new Error(`agent responded ${r.status}`);
      });
      this.opts.clock.start();
      return this.sendJson(ctx.res, 200, {run: result.run, lease: result.lease});
    }

    // POST /api/v1/agent/runs/{id}/control — Runtime semantics first, then forward
    const controlMatch = /^\/runs\/([^/]+)\/control$/.exec(subPath);
    if (controlMatch && ctx.method === 'POST') {
      const action = String(ctx.body?.action ?? '');
      if (!['pause', 'resume', 'cancel'].includes(action)) {
        throw new DeviceError('invalid_argument', "action must be 'pause' | 'resume' | 'cancel'");
      }
      const experimentId = runtime.runById(decodeURIComponent(controlMatch[1]))?.experiment_id;
      if (!experimentId) throw new DeviceError('not_found', 'No such run');
      const updated = runtime.controlRun(experimentId, decodeURIComponent(controlMatch[1]),
        action as 'pause' | 'resume' | 'cancel');
      this.opts.clock.start();
      // Forward to the Agent best-effort (Runtime semantics are already committed).
      try {
        await fetch(`${config.agentUrl}${subPath}`, {method: 'POST',
          headers: {'content-type': 'application/json', 'x-service-token': runtime.serviceToken},
          body: JSON.stringify(ctx.body), signal: AbortSignal.timeout(5_000)});
      } catch {
        // agent down: Runtime state already updated; report it in the response
      }
      return this.sendJson(ctx.res, 200, {run: updated});
    }

    // Everything else: pure proxy (GET runs, run detail, agent event streams).
    await proxyToAgent(config, runtime.serviceToken, ctx.req, ctx.res, subPath, ctx.rawBody);
  }

  // -- session login ----------------------------------------------------------

  private handleSessionLogin(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (this.auth.isBlocked(ip)) {
      const err = new DeviceError('rate_limited', 'Too many failed attempts from this address; retry later');
      res.writeHead(err.status, {'content-type': 'application/json'});
      res.end(JSON.stringify(err.toBody()));
      return;
    }
    const result = this.auth.login(body as {pairing_code?: string; access_code?: string}, ip);
    if (!result.ok) {
      this.auth.recordFailure(ip);
      const err = result.reason === 'rate_limited'
        ? new DeviceError('rate_limited', 'Too many failed attempts; retry later')
        : new DeviceError('unauthenticated', 'Invalid or expired pairing/access code');
      res.writeHead(err.status, {'content-type': 'application/json'});
      res.end(JSON.stringify(err.toBody()));
      return;
    }
    this.auth.recordSuccess(ip);
    const {token, expiresAt} = this.auth.createSession();
    res.writeHead(200, {'content-type': 'application/json',
      'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(expiresAt).toUTCString()}`});
    res.end(JSON.stringify({authenticated: true, principal: 'operator', expires_at: expiresAt}));
  }

  // -- static -----------------------------------------------------------------

  private serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    const result = resolveStatic(this.opts.config, path);
    if (result.status === 302 && result.path) {
      res.writeHead(302, {location: result.path});
      res.end();
      return;
    }
    if (result.status !== 200 || !result.path || !result.stream) {
      res.writeHead(404, {'content-type': 'text/plain'});
      res.end('not found');
      return;
    }
    res.writeHead(200, {'content-type': result.mime ?? 'application/octet-stream', 'cache-control': 'no-cache'});
    const stream = result.stream as import('node:fs').ReadStream;
    if (req.method === 'HEAD') {
      stream.destroy();
      res.end();
      return;
    }
    stream.pipe(res);
    stream.on('error', () => {
      res.end();
    });
  }

  // -- helpers ------------------------------------------------------------------

  private requireAuth(ctx: Ctx): void {
    if (!ctx.principal) throw new DeviceError('unauthenticated', 'This endpoint requires an operator session or a Bearer token');
  }

  private requireOperator(ctx: Ctx): void {
    this.requireAuth(ctx);
    if (ctx.principal!.kind !== 'operator') {
      throw new DeviceError('forbidden', 'This endpoint is restricted to the operator');
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end(payload);
  }

  private sendError(res: ServerResponse, req: IncomingMessage, e: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (e instanceof DeviceError) {
      res.writeHead(e.status, {'content-type': 'application/json'});
      res.end(JSON.stringify(e.toBody()));
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[runtime] internal error ${req.method} ${req.url}: ${message}`);
    res.writeHead(500, {'content-type': 'application/json'});
    res.end(JSON.stringify({code: 'internal', message, retryable: true}));
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new DeviceError('invalid_request', 'Body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolvePromise(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const value = Array.isArray(v) ? v[0] : v;
  return value != null && value !== '' ? value : undefined;
}

function wireLease(l: import('./runtime.ts').LeaseRow): Lease {
  return {lease_id: l.lease_id, experiment_id: l.experiment_id, run_id: l.run_id, state: l.state,
    frozen_at_sim_s: l.frozen_at_sim_s, event_seq: l.event_seq, triggers: l.triggers, wake: l.wake ?? null,
    expires_at_wall: l.expires_at_wall, granted_at_wall: l.granted_at_wall};
}
