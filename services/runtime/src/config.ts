// Runtime CLI/env configuration. Every wall-clock TTL is overridable via env
// so tests can run quickly (e.g. OSCAR_LEASE_TTL_MS=1500).
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import type {ClockMode} from '@oscar/device-contract';

export interface RuntimeConfig {
  port: number;
  host: string;               // bind address
  dataDir: string;
  agentUrl: string;
  lan: boolean;
  allowHosts: string[];       // extra Host values (host or host:port)
  accessCode: string | null;  // LAN access code (>= 16 chars required in LAN mode)
  scenario: string;
  seed: number;
  clockMode: ClockMode;
  repoRoot: string;
  lease: {ttlWallMs: number; maxHoldWallMs: number};
  pairingTtlMs: number;
  sessionTtlMs: number;
  rateLimitBaseMs: number;
}

const int = (v: string | undefined, d: number): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const {values} = parseArgs({
    args: argv,
    options: {
      port: {type: 'string'},
      'data-dir': {type: 'string'},
      'agent-url': {type: 'string'},
      lan: {type: 'boolean', default: false},
      'allow-host': {type: 'string', multiple: true},
      'access-code-file': {type: 'string'},
      scenario: {type: 'string'},
      seed: {type: 'string'},
      'clock-mode': {type: 'string'},
      'repo-root': {type: 'string'},
    },
    strict: false,
  });
  const dataDir = String(values['data-dir'] ?? env.OSCAR_DATA_DIR ?? 'data');
  const port = int(String(values.port ?? env.OSCAR_RUNTIME_PORT ?? 8780), 8780);
  const lan = Boolean(values.lan);
  let accessCode: string | null = null;
  if (values['access-code-file']) {
    accessCode = await_read(String(values['access-code-file']));
  } else if (env.OSCAR_ACCESS_CODE) {
    accessCode = env.OSCAR_ACCESS_CODE;
  }
  return {
    port,
    host: lan ? '0.0.0.0' : '127.0.0.1',
    dataDir,
    agentUrl: String(values['agent-url'] ?? env.OSCAR_AGENT_URL ?? 'http://127.0.0.1:8781').replace(/\/$/, ''),
    lan,
    allowHosts: (values['allow-host'] as string[] | undefined) ?? [],
    accessCode,
    scenario: String(values.scenario ?? env.OSCAR_SCENARIO ?? 'routine_maintenance'),
    seed: int(String(values.seed ?? env.OSCAR_SEED ?? 42), 42),
    clockMode: values['clock-mode'] === 'realtime' ? 'realtime' : 'lockstep',
    repoRoot: String(values['repo-root'] ?? join(import.meta.dirname, '..', '..', '..')),
    lease: {
      ttlWallMs: int(env.OSCAR_LEASE_TTL_MS, 30_000),
      maxHoldWallMs: int(env.OSCAR_LEASE_MAX_HOLD_MS, 300_000),
    },
    pairingTtlMs: int(env.OSCAR_PAIRING_TTL_MS, 5 * 60_000),
    sessionTtlMs: int(env.OSCAR_SESSION_TTL_MS, 12 * 3600_000),
    rateLimitBaseMs: int(env.OSCAR_RATE_LIMIT_BLOCK_MS, 2_000),
  };
}

// Synchronous tiny read helper (config module must stay sync-friendly).
function await_read(path: string): string {
  return readFileSync(path, 'utf8').trim();
}
