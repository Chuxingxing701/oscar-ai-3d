// Real-process helpers for long-lived session acceptance: spawn the REAL
// Runtime and the REAL Culture Agent as child processes sharing an isolated
// temp data dir (never the user's data/), plus a tiny service-token HTTP
// client for the Agent API. Fault injection helpers included (SIGKILL,
// accepted-response-loss).
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

export interface RuntimeProc {
  port: number;
  baseUrl: string;
  dataDir: string;
  operatorToken: string;
  serviceToken: string;
  child: ChildProcess;
  stop(): Promise<void>;
  kill9(): void;
}

export async function spawnRuntimeProc(opts: {scenario?: string; clockMode?: 'lockstep' | 'realtime';
  env?: Record<string, string>; agentUrl?: string; dataDir?: string; port?: number} = {}): Promise<RuntimeProc> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'oscar-sess-rt-'));
  const args = ['services/runtime/src/main.ts', '--port', String(opts.port ?? 0), '--data-dir', dataDir,
    '--scenario', opts.scenario ?? 'routine_maintenance', '--clock-mode', opts.clockMode ?? 'realtime'];
  const child = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ...opts.env, ...(opts.agentUrl ? {OSCAR_AGENT_URL: opts.agentUrl} : {})}});
  let stdout = '';
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Runtime did not start. stdout:\n${stdout}`)), 20_000);
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.includes('OSCAR_RUNTIME_READY')) {clearTimeout(timer); resolvePromise();}
    });
    child.stderr!.on('data', (d: Buffer) => {stdout += d.toString();});
    child.on('exit', code => {clearTimeout(timer); reject(new Error(`Runtime exited early (${code}).\n${stdout}`));});
  });
  const info = JSON.parse(/OSCAR_RUNTIME_READY (.*)/.exec(stdout)![1]) as {port: number};
  const operatorToken = readFileSync(join(dataDir, 'runtime', 'operator.token'), 'utf8').trim();
  const serviceToken = readFileSync(join(dataDir, 'secrets', 'service.token'), 'utf8').trim();
  const stop = async (): Promise<void> => {
    if (child.exitCode == null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>(resolvePromise => {
        const t = setTimeout(() => {child.kill('SIGKILL'); resolvePromise();}, 3000);
        child.on('exit', () => {clearTimeout(t); resolvePromise();});
      });
    }
    try {rmSync(dataDir, {recursive: true, force: true});} catch { /* ignore */ }
  };
  return {port: info.port, baseUrl: `http://127.0.0.1:${info.port}`, dataDir, operatorToken, serviceToken, child, stop,
    kill9: () => {child.kill('SIGKILL');}};
}

export interface AgentProc {
  port: number;
  baseUrl: string;
  dataDir: string;
  child: ChildProcess;
  stdout: string;
  stop(): Promise<void>;
  kill9(): void;
}

export async function spawnAgentProc(opts: {dataDir: string; runtimeUrl: string; env?: Record<string, string>;
  port?: number}): Promise<AgentProc> {
  const child = spawn(process.execPath, ['services/culture-agent/src/main.ts', '--port', String(opts.port ?? 0),
    '--data-dir', opts.dataDir, '--runtime-url', opts.runtimeUrl],
  {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...opts.env}});
  let stdout = '';
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Agent did not start. stdout:\n${stdout}`)), 25_000);
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (/OSCAR_AGENT_READY .*\n/.test(stdout)) {clearTimeout(timer); resolvePromise();}
    });
    child.stderr!.on('data', (d: Buffer) => {stdout += d.toString();});
    child.on('exit', code => {clearTimeout(timer); reject(new Error(`Agent exited early (${code}).\n${stdout}`));});
  });
  const info = JSON.parse(/OSCAR_AGENT_READY (.*)/.exec(stdout)![1]) as {port: number};
  const stop = async (): Promise<void> => {
    if (child.exitCode == null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>(resolvePromise => {
        const t = setTimeout(() => {child.kill('SIGKILL'); resolvePromise();}, 3000);
        child.on('exit', () => {clearTimeout(t); resolvePromise();});
      });
    }
  };
  return {port: info.port, baseUrl: `http://127.0.0.1:${info.port}`, dataDir: opts.dataDir, child, stdout,
    stop, kill9: () => {child.kill('SIGKILL');}};
}

/** Minimal typed client for the Agent session/supervisor API (X-Service-Token). */
export class AgentApiClient {
  readonly baseUrl: string;
  readonly serviceToken: string;

  constructor(baseUrl: string, serviceToken: string) {
    this.baseUrl = baseUrl;
    this.serviceToken = serviceToken;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<{status: number; json: T}> {
    const r = await fetch(`${this.baseUrl}${path}`, {method,
      headers: {'content-type': 'application/json', 'x-service-token': this.serviceToken},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await r.text();
    let json: unknown = null;
    try {json = text ? JSON.parse(text) : null;} catch {json = {raw: text};}
    if (!r.ok) {
      const err = json as {code?: string; message?: string};
      throw Object.assign(new Error(`${err.code ?? r.status}: ${err.message ?? text}`),
        {status: r.status, code: err.code, body: json});
    }
    return {status: r.status, json: json as T};
  }

  get<T>(path: string): Promise<T> {return this.request<T>('GET', path).then(r => r.json);}
  post<T>(path: string, body?: unknown): Promise<T> {return this.request<T>('POST', path, body).then(r => r.json);}
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Poll until fn returns non-undefined; throws with the last error snapshot. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined> | T | null | undefined,
  opts: {timeoutMs: number; intervalMs?: number; label?: string}): Promise<T> {
  const start = Date.now();
  let last: T | null | undefined = null;
  for (;;) {
    last = await fn();
    if (last != null) return last;
    if (Date.now() - start > opts.timeoutMs) {
      throw new Error(`timeout after ${opts.timeoutMs}ms waiting for ${opts.label ?? 'condition'}`
        + (last === null ? '' : ` (last: ${JSON.stringify(last)})`));
    }
    await sleep(opts.intervalMs ?? 250);
  }
}

/**
 * fetch wrapper that DROPS the response of accepted action submissions:
 * the request reaches the Runtime (action accepted), then the connection
 * "dies" so the caller cannot know the outcome.
 */
export function acceptedResponseLossFetch(inner: typeof fetch, dropCount: number): {fetch: typeof fetch; dropped: () => number} {
  let dropped = 0;
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const isSubmit = method === 'POST' && /\/api\/v1\/experiments\/[^/]+\/actions$/.test(url.split('?')[0]);
    if (isSubmit && dropped < dropCount) {
      // forward, consume the outcome, then simulate a dead connection
      const response = await inner(input, init);
      await response.arrayBuffer().catch(() => undefined);
      dropped += 1;
      throw new TypeError('fetch failed: connection reset by peer AFTER the server responded (injected)');
    }
    return inner(input, init);
  }) as typeof fetch;
  return {fetch: wrapped, dropped: () => dropped};
}
