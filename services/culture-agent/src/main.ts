// Culture Agent entrypoint. Listens ONLY on 127.0.0.1
// (--port/OSCAR_AGENT_PORT default 8781). Binds first (printing
// OSCAR_AGENT_LISTENING {"port":N}), then waits for the service token at
// <data>/secrets/service.token (created by the Runtime; wait/retry until it
// exists), reconciles persisted runs/intents and finally prints
// OSCAR_AGENT_READY {"port":N}. On start, every previously active run is
// paused (agent_restarted), reported to the Runtime and reconciled by
// idempotency key (nothing is resubmitted).
import {existsSync, readFileSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {parseAgentConfig} from './config.ts';
import {AgentStore} from './store.ts';
import {CultureAgent} from './agent.ts';

async function waitForServiceToken(path: string, timeoutMs = 120_000): Promise<string> {
  const start = Date.now();
  let lastLog = 0;
  for (;;) {
    if (existsSync(path)) {
      const token = readFileSync(path, 'utf8').trim();
      if (token) return token;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`service token file ${path} did not appear within ${timeoutMs} ms (start the Runtime first or share OSCAR_DATA_DIR)`);
    }
    if (Date.now() - lastLog > 5_000) {
      lastLog = Date.now();
      process.stdout.write(`[agent] waiting for ${path} ...\n`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

export async function main(argv: string[]): Promise<{agent: CultureAgent; port: number}> {
  const config = parseAgentConfig(argv);
  const dataDir = isAbsolute(config.dataDir) ? resolve(config.dataDir) : join(config.repoRoot, config.dataDir);
  let serviceToken: string | null = null;
  const store = new AgentStore(dataDir);
  const agent = new CultureAgent({config: {...config, dataDir}, getServiceToken: () => serviceToken, store,
    log: message => process.stdout.write(`${message}\n`)});
  const port = await agent.listen(config.port, '127.0.0.1');
  process.stdout.write(`OSCAR_AGENT_LISTENING ${JSON.stringify({port, data_dir: dataDir})}\n`);
  serviceToken = await waitForServiceToken(join(dataDir, 'secrets', 'service.token'));
  await agent.reconcileOnStartup();
  process.stdout.write(`OSCAR_AGENT_READY ${JSON.stringify({port, data_dir: dataDir, runtime_url: config.runtimeUrl})}\n`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void agent.close().then(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return {agent, port};
}

// Direct execution: node services/culture-agent/src/main.ts --port 0 --data-dir ...
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  void main(process.argv.slice(2)).catch(e => {
    console.error(`[agent] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
