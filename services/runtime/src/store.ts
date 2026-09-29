// SQLite persistence (node:sqlite DatabaseSync). Single writer: the Runtime
// process. Every state commit happens in one explicit transaction together
// with its events (callers use store.tx).
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  scenario_version TEXT NOT NULL,
  simulator_version TEXT NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- active | archiving | archived
  sim_time_s REAL NOT NULL,
  clock_mode TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  speed REAL NOT NULL DEFAULT 1,
  reset_from TEXT,
  successor_id TEXT,
  determinism_broken INTEGER NOT NULL DEFAULT 0,
  created_at_wall TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  event_seq INTEGER NOT NULL DEFAULT 0,
  act_counter INTEGER NOT NULL DEFAULT 0,
  obs_counter INTEGER NOT NULL DEFAULT 0,
  asset_counter INTEGER NOT NULL DEFAULT 0,
  run_counter INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS worlds (
  experiment_id TEXT PRIMARY KEY REFERENCES experiments(id),
  version INTEGER NOT NULL DEFAULT 0,
  world_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  status TEXT NOT NULL,
  principal TEXT NOT NULL,
  idempotency_key TEXT,
  canonical_request TEXT,
  accept_seq INTEGER NOT NULL,
  action_json TEXT NOT NULL,
  plan_json TEXT,
  response_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_idem ON actions(experiment_id, principal, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_actions_exp_status ON actions(experiment_id, status, accept_seq);
CREATE INDEX IF NOT EXISTS idx_actions_exp_seq ON actions(experiment_id, accept_seq);
CREATE TABLE IF NOT EXISTS events (
  experiment_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sim_time_s REAL NOT NULL,
  type TEXT NOT NULL,
  action_id TEXT,
  run_id TEXT,
  observation_id TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (experiment_id, seq)
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  obs_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_exp ON observations(experiment_id);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  run_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_exp ON runs(experiment_id);
CREATE TABLE IF NOT EXISTS run_tokens (
  token_sha256 TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS leases (
  lease_id INTEGER PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,
  frozen_at_sim_s REAL NOT NULL,
  event_seq INTEGER NOT NULL,
  triggers TEXT NOT NULL,
  wake TEXT,
  granted_at_wall TEXT NOT NULL,
  expires_at_wall TEXT NOT NULL,
  release_request TEXT,
  release_response TEXT
);
CREATE INDEX IF NOT EXISTS idx_leases_exp ON leases(experiment_id, state);
CREATE TABLE IF NOT EXISTS wakes (
  experiment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  lease_id INTEGER NOT NULL,
  wake TEXT NOT NULL,
  PRIMARY KEY (experiment_id, run_id, lease_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_sha256 TEXT PRIMARY KEY,
  created_at_wall TEXT NOT NULL,
  expires_at_wall TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at_wall TEXT NOT NULL,
  expires_at_wall TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  blocked_until_wall TEXT
);
CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_wall TEXT NOT NULL,
  experiment_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT
);
`;

export class Store {
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, import('node:sqlite').StatementSync>();
  private inTx = 0;

  constructor(dataDir: string) {
    mkdirSync(dataDir, {recursive: true});
    mkdirSync(join(dataDir, 'secrets'), {recursive: true});
    this.db = new DatabaseSync(join(dataDir, 'runtime.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
  }

  /** Cached prepared statement. */
  stmt(sql: string): import('node:sqlite').StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Explicit immediate transaction; rolls back on throw. Not nestable. */
  tx<T>(fn: () => T): T {
    if (this.inTx > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx--;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as {value: string} | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  nextId(key: string): number {
    const current = Number(this.getMeta(key) ?? '0');
    const next = current + 1;
    this.setMeta(key, String(next));
    return next;
  }

  diagnostic(experimentId: string | null, kind: string, detail?: string): void {
    this.tx(() => {
      this.stmt('INSERT INTO diagnostics (created_at_wall, experiment_id, kind, detail) VALUES (?, ?, ?, ?)')
        .run(new Date().toISOString(), experimentId, kind, detail ?? null);
    });
  }

  close(): void {
    this.db.close();
  }
}
