// Shared test helpers: spawn the REAL Runtime as a child process (port 0,
// isolated temp data dir), read the OSCAR_RUNTIME_READY line, use DeviceClient
// with the operator token. Cleans up process + temp dir.
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '@oscar/device-contract';

const ROOT = join(import.meta.dirname, '..', '..', '..');

export interface RuntimeHandle {
  port: number;
  baseUrl: string;
  dataDir: string;
  operatorToken: string;
  client: DeviceClient;
  child: ChildProcess;
  stdout: string;
  stop: () => Promise<void>;
  kill9: () => void;
}

export interface SpawnOptions {
  scenario?: string;
  seed?: number;
  clockMode?: 'lockstep' | 'realtime';
  env?: Record<string, string>;
  args?: string[];
}

export async function spawnRuntime(opts: SpawnOptions = {}): Promise<RuntimeHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'oscar-rt-test-'));
  const args = ['services/runtime/src/main.ts', '--port', '0', '--data-dir', dataDir,
    ...(opts.scenario ? ['--scenario', opts.scenario] : []),
    ...(opts.seed != null ? ['--seed', String(opts.seed)] : []),
    ...(['--clock-mode', opts.clockMode ?? 'lockstep']),
    ...(opts.args ?? [])];
  const child = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ...opts.env}});
  let stdout = '';
  let readyLine = '';
  const chunks: Buffer[] = [];
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Runtime did not start. stdout:\n${stdout}`)), 20_000);
    child.stdout!.on('data', (d: Buffer) => {
      chunks.push(d);
      stdout += d.toString();
      for (const line of stdout.split('\n')) {
        if (line.startsWith('OSCAR_RUNTIME_READY') && !readyLine) {
          readyLine = line;
          clearTimeout(timer);
          resolvePromise();
        }
      }
    });
    child.stderr!.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Runtime exited early (${code}). output:\n${stdout}`));
    });
  });
  const info = JSON.parse(readyLine.slice('OSCAR_RUNTIME_READY '.length)) as {port: number};
  const operatorToken = readFileSync(join(dataDir, 'runtime', 'operator.token'), 'utf8').trim();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  const client = new DeviceClient({baseUrl, token: operatorToken, timeoutMs: 15_000});
  const stop = async (): Promise<void> => {
    if (child.exitCode == null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>(resolvePromise => {
        const t = setTimeout(() => { child.kill('SIGKILL'); resolvePromise(); }, 3000);
        child.on('exit', () => { clearTimeout(t); resolvePromise(); });
      });
    }
    try { rmSync(dataDir, {recursive: true, force: true}); } catch { /* ignore */ }
  };
  const kill9 = (): void => {
    child.kill('SIGKILL');
    try { rmSync(dataDir, {recursive: true, force: true}); } catch { /* keep dir on restart tests */ }
  };
  return {port: info.port, baseUrl, dataDir, operatorToken, client, child, stdout, stop, kill9};
}

/** Raw fetch with operator bearer and JSON helpers (no Origin header, like the CLI). */
export async function opFetch(h: RuntimeHandle, method: string, path: string, body?: unknown,
  headers: Record<string, string> = {}): Promise<{status: number; text: string; headers: Headers}> {
  const r = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {authorization: `Bearer ${h.operatorToken}`, ...(body !== undefined ? {'content-type': 'application/json'} : {}), ...headers},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {status: r.status, text: await r.text(), headers: r.headers};
}

export async function anonFetch(h: RuntimeHandle, method: string, path: string, body?: unknown,
  headers: Record<string, string> = {}): Promise<{status: number; text: string; headers: Headers}> {
  const r = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {...(body !== undefined ? {'content-type': 'application/json'} : {}), ...headers},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {status: r.status, text: await r.text(), headers: r.headers};
}

export async function currentExperimentId(h: RuntimeHandle): Promise<string> {
  const list = await h.client.experiments();
  if (!list.current_id) throw new Error('no current experiment');
  return list.current_id;
}

export async function waitUntil(pred: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('waitUntil timed out');
}

/** Minimal stub Agent for gateway tests: accepts POST /runs (and control). */
export async function startStubAgent(): Promise<{url: string; received: Array<Record<string, unknown>>; close: () => Promise<void>; failNext: boolean}> {
  const received: Array<Record<string, unknown>> = [];
  const state = {failNext: false};
  const server = (await import('node:http')).createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers['x-service-token'];
      if (auth !== 'stub-service-token' && auth !== undefined && String(auth).length === 0) {
        res.writeHead(401); res.end(); return;
      }
      let parsed: Record<string, unknown> = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* empty */ }
      if (req.method === 'POST' && req.url === '/runs') {
        received.push(parsed);
        if (state.failNext) { res.writeHead(500, {'content-type': 'application/json'}); res.end('{"error":"no"}'); return; }
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{"accepted":true}');
        return;
      }
      if (req.method === 'POST' && /\/runs\/[^/]+\/control/.test(req.url ?? '')) {
        received.push({control: parsed, url: req.url});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{"accepted":true}');
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{"runs":[],"ok":true}');
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {url: `http://127.0.0.1:${port}`, received,
    close: () => new Promise<void>(r => server.close(() => r())),
    get failNext() { return state.failNext; }, set failNext(v: boolean) { state.failNext = v; }};
}

/** Total volume accounting helper: read snapshot well sums per plate. */
export function wellsOf(snapshot: {plates: Array<{plate_id: string; wells: Array<{well_id: string; volume_ul: number}>}>}, plateId: string): number[] {
  return snapshot.plates.find(p => p.plate_id === plateId)!.wells.map(w => w.volume_ul);
}
