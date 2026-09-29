// Culture Agent CLI/env configuration.
import {join} from 'node:path';
import {parseArgs} from 'node:util';

export interface AgentConfig {
  port: number;
  dataDir: string;
  runtimeUrl: string;
  repoRoot: string;
  /** Artificial decision delay range in wall ms (determinism test only). */
  decisionDelayMs: {min: number; max: number} | null;
}

const int = (v: string | undefined, d: number): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

export function parseAgentConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const {values} = parseArgs({
    args: argv,
    options: {
      port: {type: 'string'},
      'data-dir': {type: 'string'},
      'runtime-url': {type: 'string'},
      'repo-root': {type: 'string'},
    },
    strict: false,
  });
  let decisionDelayMs: AgentConfig['decisionDelayMs'] = null;
  const delayRaw = env.OSCAR_AGENT_DECISION_DELAY_MS;
  if (delayRaw) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(delayRaw.trim());
    if (m) {
      const min = Number(m[1]);
      const max = m[2] ? Number(m[2]) : min;
      decisionDelayMs = {min, max: Math.max(min, max)};
    }
  }
  return {
    port: int(String(values.port ?? env.OSCAR_AGENT_PORT ?? 8781), 8781),
    dataDir: String(values['data-dir'] ?? env.OSCAR_DATA_DIR ?? 'data'),
    runtimeUrl: String(values['runtime-url'] ?? env.OSCAR_RUNTIME_URL ?? 'http://127.0.0.1:8780').replace(/\/$/, ''),
    repoRoot: String(values['repo-root'] ?? join(import.meta.dirname, '..', '..', '..')),
    decisionDelayMs,
  };
}
