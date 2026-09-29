// Runtime entrypoint. CLI flags per contract §1. On start prints one
// machine-readable line OSCAR_RUNTIME_READY {...} plus a human pairing hint.
import {existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseConfig} from './config.ts';
import {Store} from './store.ts';
import {Runtime} from './runtime.ts';
import {Clock} from './clock.ts';
import {HttpApi} from './http.ts';
import {Auth} from './auth.ts';

function ensureToken(path: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  mkdirSync(join(path, '..'), {recursive: true});
  writeFileSync(path, token, {mode: 0o600});
  chmodSync(path, 0o600);
  return token;
}

export async function main(argv: string[]): Promise<{http: HttpApi; runtime: Runtime; clock: Clock; port: number}> {
  const config = parseConfig(argv);
  if (config.lan) {
    if (!config.accessCode || config.accessCode.length < 16) {
      console.error('--lan requires an access code of at least 16 characters (--access-code-file or OSCAR_ACCESS_CODE)');
      process.exit(2);
    }
  }
  const dataDir = isAbsolute(config.dataDir) ? resolve(config.dataDir) : join(config.repoRoot, config.dataDir);
  const runtimeDir = join(dataDir, 'runtime');
  mkdirSync(runtimeDir, {recursive: true});
  const store = new Store(runtimeDir);
  const operatorToken = ensureToken(join(runtimeDir, 'operator.token'));
  const serviceToken = ensureToken(join(dataDir, 'secrets', 'service.token'));
  const runtime = new Runtime(config, store, operatorToken, serviceToken);

  // Restart recovery BEFORE anything else touches state (§5).
  runtime.recoverOnStartup();
  if (!runtime.currentExperiment()) {
    runtime.createExperiment({scenario_id: config.scenario, seed: config.seed, clock_mode: config.clockMode});
  }

  const clock = new Clock(runtime);
  const http = new HttpApi({runtime, config, clock});
  const port = await http.listen(config.port, config.host);
  clock.start();

  // One-time pairing code (loopback mode; LAN uses the access code login).
  let pairUrl: string | null = null;
  if (!config.lan) {
    const auth = new Auth(runtime, config);
    const {code} = auth.newPairingCode();
    pairUrl = `http://127.0.0.1:${port}/pair#code=${code}`;
  }
  const ready = {port, pair_url: pairUrl, data_dir: dataDir, agent_url: config.agentUrl,
    clock_mode: firstClockMode(runtime)};
  process.stdout.write(`OSCAR_RUNTIME_READY ${JSON.stringify(ready)}\n`);
  if (pairUrl) {
    process.stdout.write(`Pair this browser once: ${pairUrl}\n`);
  } else {
    process.stdout.write(`LAN mode: open http://<host>:${port}/login and sign in with the access code.\n`);
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clock.stop();
    void http.close().then(() => {
      runtime.close();
      process.exit(0);
    });
    setTimeout(() => {
      runtime.close();
      process.exit(0);
    }, 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return {http, runtime, clock, port};
}

function firstClockMode(runtime: Runtime): string {
  return runtime.currentExperiment()?.clock_mode ?? 'lockstep';
}

// Direct execution: node services/runtime/src/main.ts --port 0 --data-dir ...
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  void main(process.argv.slice(2));
}
