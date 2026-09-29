// Starts / stops an isolated Runtime + Agent pair (real processes) for e2e.
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const STATE_FILE = join(tmpdir(), 'oscar-e2e-stack.json');

export interface StackInfo {
  dataDir: string;
  runtimePort: number;
  agentPort: number;
  runtimePid: number;
  agentPid: number;
  baseUrl: string;
}

function waitReady(child: ChildProcess, tag: string, log: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag} not ready:\n${log.join('')}`)), 30_000);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      log.push(d.toString());
      const m = new RegExp(`${tag} (\\{.*\\})`).exec(buf);
      if (m) { clearTimeout(timer); resolve(JSON.parse(m[1])); }
    });
    child.stderr!.on('data', (d: Buffer) => log.push(d.toString()));
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`${tag} exited ${code}:\n${log.join('')}`)); });
  });
}

export function spawnAgent(dataDir: string, runtimeUrl: string, port = 0): {child: ChildProcess; ready: Promise<Record<string, unknown>>} {
  const log: string[] = [];
  const child = spawn(process.execPath, ['services/culture-agent/src/main.ts', '--port', String(port), '--data-dir', dataDir,
    '--runtime-url', runtimeUrl], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: false});
  return {child, ready: waitReady(child, 'OSCAR_AGENT_READY', log)};
}

export async function startStack(scenario = 'routine_maintenance'): Promise<StackInfo> {
  const dataDir = mkdtempSync(join(tmpdir(), 'oscar-e2e-'));
  // Agent first on a fixed free port chosen by the OS through a probe.
  const agentPort = await freePort();
  const runtimeLog: string[] = [];
  const runtime = spawn(process.execPath, ['services/runtime/src/main.ts', '--port', '0', '--data-dir', dataDir,
    '--scenario', scenario, '--seed', '42', '--clock-mode', 'lockstep', '--agent-url', `http://127.0.0.1:${agentPort}`],
  {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  const rt = await waitReady(runtime, 'OSCAR_RUNTIME_READY', runtimeLog);
  const runtimePort = Number(rt.port);
  runtime.stdout!.resume(); runtime.stderr!.resume();
  let agentPid = 0;
  if (process.env.OSCAR_E2E_NO_AGENT !== '1') {
    const agent = spawnAgent(dataDir, `http://127.0.0.1:${runtimePort}`, agentPort);
    await agent.ready;
    agent.child.stdout!.resume(); agent.child.stderr!.resume();
    agent.child.unref();
    agentPid = agent.child.pid!;
  }
  const info: StackInfo = {dataDir, runtimePort, agentPort, runtimePid: runtime.pid!, agentPid,
    baseUrl: `http://127.0.0.1:${runtimePort}`};
  runtime.unref();
  writeFileSync(STATE_FILE, JSON.stringify(info));
  return info;
}

export function readStack(): StackInfo {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackInfo;
}

export function writeStackPid(key: 'agentPid' | 'runtimePid', pid: number): void {
  writeFileSync(STATE_FILE, JSON.stringify({...readStack(), [key]: pid}));
}

export function operatorToken(info: StackInfo): string {
  return readFileSync(join(info.dataDir, 'runtime', 'operator.token'), 'utf8').trim();
}

export function killPid(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

export function alive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function stopStack(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  const info = readStack();
  for (const pid of [info.agentPid, info.runtimePid]) killPid(pid);
  for (let i = 0; i < 50 && (alive(info.agentPid) || alive(info.runtimePid)); i++) await new Promise(r => setTimeout(r, 100));
  for (const pid of [info.agentPid, info.runtimePid]) if (alive(pid)) killPid(pid, 'SIGKILL');
  rmSync(info.dataDir, {recursive: true, force: true});
  rmSync(STATE_FILE, {force: true});
}

async function freePort(): Promise<number> {
  const {createServer} = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as {port: number}).port;
      s.close(() => resolve(port));
    });
  });
}

/** Fresh one-time pairing link through the operator token (same as `npm run pair`). */
export async function pairingUrl(info: StackInfo): Promise<string> {
  const r = await fetch(`${info.baseUrl}/api/v1/pairing-codes`, {method: 'POST',
    headers: {authorization: `Bearer ${operatorToken(info)}`}});
  if (!r.ok) throw new Error(`pairing-codes HTTP ${r.status}`);
  const body = await r.json() as {code?: string; pair_url?: string; url?: string};
  return body.pair_url ?? body.url ?? `${info.baseUrl}/pair#code=${body.code}`;
}
