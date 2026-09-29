// Dev launcher: `npm run dev`. Spawns the Runtime (OSCAR_RUNTIME_PORT, default
// 8780) and the Culture Agent (OSCAR_AGENT_PORT, default 8781) with
// --agent-url/--runtime-url wired, waits for both READY lines, prints the
// workbench URL, the one-time pairing link and the pure-showcase note.
// Forwards SIGINT/SIGTERM; exits when either child dies (killing the other).
import {spawn, type ChildProcess} from 'node:child_process';
import {isAbsolute, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';

const repoRoot = join(import.meta.dirname, '..');

const {values} = parseArgs({
  args: process.argv.slice(2),
  options: {
    'runtime-port': {type: 'string'},
    'agent-port': {type: 'string'},
    'data-dir': {type: 'string'},
  },
  strict: false,
});

const runtimePort = Number(values['runtime-port'] ?? process.env.OSCAR_RUNTIME_PORT ?? 8780);
const agentPort = Number(values['agent-port'] ?? process.env.OSCAR_AGENT_PORT ?? 8781);
const dataDirRaw = String(values['data-dir'] ?? process.env.OSCAR_DATA_DIR ?? 'data');
const dataDir = isAbsolute(dataDirRaw) ? resolve(dataDirRaw) : join(repoRoot, dataDirRaw);

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (c.exitCode == null && !c.killed) c.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const c of children) if (c.exitCode == null && !c.killed) c.kill('SIGKILL');
    process.exit(code);
  }, 2000).unref();
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('exit', () => {
  for (const c of children) {
    if (c.exitCode == null && !c.killed) c.kill('SIGKILL');
  }
});

function spawnChild(name: string, args: string[]): ChildProcess {
  const child = spawn(process.execPath, args, {cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, OSCAR_DATA_DIR: dataDir}});
  const prefix = (line: string): void => {
    process.stdout.write(`[${name}] ${line}\n`);
  };
  let buf = '';
  const pump = (chunk: string): void => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) prefix(line);
    }
  };
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', pump);
  child.stderr!.on('data', pump);
  child.on('exit', (code2, signal) => {
    if (!shuttingDown) {
      process.stderr.write(`\n[dev] ${name} exited (code=${code2} signal=${signal}); shutting down the other process.\n`);
      shutdown(1);
    }
    return undefined;
  });
  children.push(child);
  return child;
}

function waitReady(child: ChildProcess, prefix: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  return new Promise((resolveReady, reject) => {
    let acc = '';
    const onData = (d: Buffer): void => {
      acc += d.toString();
      for (const line of acc.split('\n')) {
        if (line.startsWith(prefix)) {
          child.stdout!.removeListener('data', onData);
          try {
            resolveReady(JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
          } catch (e) {
            reject(e);
          }
          return;
        }
      }
    };
    child.stdout!.on('data', onData);
    setTimeout(() => reject(new Error(`${prefix} not seen within ${timeoutMs} ms`)), timeoutMs).unref();
  });
}

// The Agent starts first (it waits for the service token the Runtime creates).
const agent = spawnChild('agent', ['services/culture-agent/src/main.ts',
  '--port', String(agentPort), '--data-dir', dataDir, '--runtime-url', `http://127.0.0.1:${runtimePort}`]);
const runtime = spawnChild('runtime', ['services/runtime/src/main.ts',
  '--port', String(runtimePort), '--data-dir', dataDir, '--agent-url', `http://127.0.0.1:${agentPort}`]);

const agentReady = waitReady(agent, 'OSCAR_AGENT_READY ');
const runtimeReady = waitReady(runtime, 'OSCAR_RUNTIME_READY ');

const [agentInfo, runtimeInfo] = await Promise.all([agentReady, runtimeReady]);
const rtPort = Number(runtimeInfo.port ?? runtimePort);
const agPort = Number(agentInfo.port ?? agentPort);
const pairUrl = typeof runtimeInfo.pair_url === 'string' ? runtimeInfo.pair_url : null;

process.stdout.write('\n================ OSCAR dev stack is up ================\n');
process.stdout.write(`Runtime:        http://127.0.0.1:${rtPort}  (data: ${dataDir})\n`);
process.stdout.write(`Culture Agent:  http://127.0.0.1:${agPort}  (loopback only)\n`);
process.stdout.write(`Workbench:      http://127.0.0.1:${rtPort}/web/workbench.html\n`);
if (pairUrl) {
  process.stdout.write(`Pair (once):    ${pairUrl}\n`);
  process.stdout.write(`                (expired? run: npm run pair)\n`);
} else {
  process.stdout.write(`Login:          http://127.0.0.1:${rtPort}/login (LAN access code)\n`);
}
process.stdout.write(`Agent panel:    http://127.0.0.1:${rtPort}/api/v1/agent/runs (via gateway)\n`);
process.stdout.write('\nPure showcase (display only, no API):  node server.mjs  ->  http://127.0.0.1:8765/web/\n');
process.stdout.write('========================================================\n');
process.stdout.write('Ctrl-C stops both processes.\n');
