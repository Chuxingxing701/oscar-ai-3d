// Agent-side SQLite session store (node:sqlite). The agent never reads the
// Runtime DB; the two processes only exchange resource IDs over HTTP.
//
// SECURITY NOTE: runs.run_token stores the Runtime-issued run token. The
// database file lives in <data>/agent/ which is created with mode 0700, so
// only the owning user can read it. The token is never written to logs, never
// returned by any HTTP endpoint and never included in events or reports.
import {DatabaseSync} from 'node:sqlite';
import {chmodSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {PolicyMemory} from '@oscar/culture-policy';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  mode TEXT NOT NULL,
  goal TEXT,
  clock_mode TEXT NOT NULL,
  status TEXT NOT NULL,              -- active | paused | ended
  pause_reason TEXT,
  plates TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  budget TEXT NOT NULL,
  memory TEXT NOT NULL,
  initial_state TEXT,
  run_token TEXT NOT NULL,
  decision_counter INTEGER NOT NULL DEFAULT 0,
  report TEXT,
  created_at_wall TEXT NOT NULL,
  updated_at_wall TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intents (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  capability TEXT NOT NULL,
  canonical_request TEXT NOT NULL,
  action_id TEXT,
  created_at_wall TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
CREATE INDEX IF NOT EXISTS idx_intents_pending ON intents(run_id) WHERE action_id IS NULL;
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at_wall TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS seen (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
`;

export interface RunRow {
  run_id: string;
  experiment_id: string;
  scenario_id: string;
  seed: number;
  mode: 'scripted' | 'llm';
  goal: string | null;
  clock_mode: 'lockstep' | 'realtime';
  status: 'active' | 'paused' | 'ended';
  pause_reason: string | null;
  plates: string[];
  capabilities: string[];
  budget: {max_actions: number; actions_used: number};
  memory: PolicyMemory;
  initial_state: Record<string, unknown> | null;
  run_token: string;
  decision_counter: number;
  report: object | null;
  created_at_wall: string;
  updated_at_wall: string;
}

export interface IntentRow {
  run_id: string;
  key: string;
  capability: string;
  canonical_request: string;
  action_id: string | null;
  created_at_wall: string;
}

export interface AgentEvent {
  seq: number;
  run_id: string;
  created_at_wall: string;
  type: string;
  payload: Record<string, unknown>;
}

export class AgentStore {
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, import('node:sqlite').StatementSync>();

  constructor(dataDir: string) {
    const agentDir = join(dataDir, 'agent');
    mkdirSync(agentDir, {recursive: true});
    try { chmodSync(agentDir, 0o700); } catch { /* best effort on shared fs */ }
    this.db = new DatabaseSync(join(agentDir, 'agent.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(SCHEMA);
  }

  stmt(sql: string): import('node:sqlite').StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // -- runs -----------------------------------------------------------------

  insertRun(row: RunRow): void {
    this.stmt(`INSERT INTO runs (run_id, experiment_id, scenario_id, seed, mode, goal, clock_mode, status, pause_reason,
      plates, capabilities, budget, memory, initial_state, run_token, decision_counter, report, created_at_wall, updated_at_wall)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.run_id, row.experiment_id, row.scenario_id, row.seed, row.mode, row.goal, row.clock_mode, row.status,
        row.pause_reason, JSON.stringify(row.plates), JSON.stringify(row.capabilities), JSON.stringify(row.budget),
        JSON.stringify(row.memory), row.initial_state ? JSON.stringify(row.initial_state) : null, row.run_token,
        row.decision_counter, row.report ? JSON.stringify(row.report) : null, row.created_at_wall, row.updated_at_wall);
  }

  getRun(runId: string): RunRow | undefined {
    const r = this.stmt('SELECT * FROM runs WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
    return r ? this.toRunRow(r) : undefined;
  }

  listRuns(): RunRow[] {
    const rows = this.stmt('SELECT * FROM runs ORDER BY created_at_wall ASC').all() as Record<string, unknown>[];
    return rows.map(r => this.toRunRow(r));
  }

  listRunsByStatus(status: RunRow['status']): RunRow[] {
    const rows = this.stmt('SELECT * FROM runs WHERE status = ? ORDER BY created_at_wall ASC').all(status) as Record<string, unknown>[];
    return rows.map(r => this.toRunRow(r));
  }

  private toRunRow(r: Record<string, unknown>): RunRow {
    return {
      run_id: String(r.run_id), experiment_id: String(r.experiment_id), scenario_id: String(r.scenario_id),
      seed: Number(r.seed), mode: r.mode as RunRow['mode'], goal: r.goal ? String(r.goal) : null,
      clock_mode: r.clock_mode as RunRow['clock_mode'], status: r.status as RunRow['status'],
      pause_reason: r.pause_reason ? String(r.pause_reason) : null,
      plates: JSON.parse(String(r.plates)) as string[], capabilities: JSON.parse(String(r.capabilities)) as string[],
      budget: JSON.parse(String(r.budget)) as RunRow['budget'], memory: JSON.parse(String(r.memory)) as PolicyMemory,
      initial_state: r.initial_state ? JSON.parse(String(r.initial_state)) as Record<string, unknown> : null,
      run_token: String(r.run_token), decision_counter: Number(r.decision_counter),
      report: r.report ? JSON.parse(String(r.report)) as Record<string, unknown> : null,
      created_at_wall: String(r.created_at_wall), updated_at_wall: String(r.updated_at_wall),
    };
  }

  updateRun(runId: string, fields: Partial<Pick<RunRow, 'status' | 'pause_reason' | 'memory' | 'decision_counter'
    | 'report' | 'budget'>>): void {
    const current = this.getRun(runId);
    if (!current) throw new Error(`no run ${runId}`);
    this.stmt(`UPDATE runs SET status=?, pause_reason=?, memory=?, decision_counter=?, report=?, budget=?, updated_at_wall=? WHERE run_id=?`)
      .run(fields.status ?? current.status, fields.pause_reason !== undefined ? fields.pause_reason : current.pause_reason,
        JSON.stringify(fields.memory ?? current.memory), fields.decision_counter ?? current.decision_counter,
        fields.report !== undefined ? (fields.report ? JSON.stringify(fields.report) : null) : (current.report ? JSON.stringify(current.report) : null),
        JSON.stringify(fields.budget ?? current.budget), new Date().toISOString(), runId);
  }

  // -- intents (persisted BEFORE the HTTP submit; §6.4) ----------------------

  insertIntent(runId: string, key: string, capability: string, canonical: string): void {
    this.stmt('INSERT OR IGNORE INTO intents (run_id, key, capability, canonical_request, action_id, created_at_wall) VALUES (?,?,?,?,?,?)')
      .run(runId, key, capability, canonical, null, new Date().toISOString());
  }

  setIntentAction(runId: string, key: string, actionId: string): void {
    this.stmt('UPDATE intents SET action_id=? WHERE run_id=? AND key=?').run(actionId, runId, key);
  }

  getIntent(runId: string, key: string): IntentRow | undefined {
    const r = this.stmt('SELECT * FROM intents WHERE run_id=? AND key=?').get(runId, key) as Record<string, unknown> | undefined;
    return r ? this.toIntentRow(r) : undefined;
  }

  listIntents(runId: string): IntentRow[] {
    const rows = this.stmt('SELECT * FROM intents WHERE run_id=? ORDER BY created_at_wall, key').all(runId) as Record<string, unknown>[];
    return rows.map(r => this.toIntentRow(r));
  }

  pendingIntents(runId: string): IntentRow[] {
    const rows = this.stmt('SELECT * FROM intents WHERE run_id=? AND action_id IS NULL ORDER BY created_at_wall, key')
      .all(runId) as Record<string, unknown>[];
    return rows.map(r => this.toIntentRow(r));
  }

  findPendingIntentByCanonical(runId: string, canonical: string): IntentRow | undefined {
    const r = this.stmt('SELECT * FROM intents WHERE run_id=? AND canonical_request=? AND action_id IS NULL ORDER BY created_at_wall LIMIT 1')
      .get(runId, canonical) as Record<string, unknown> | undefined;
    return r ? this.toIntentRow(r) : undefined;
  }

  private toIntentRow(r: Record<string, unknown>): IntentRow {
    return {run_id: String(r.run_id), key: String(r.key), capability: String(r.capability),
      canonical_request: String(r.canonical_request), action_id: r.action_id ? String(r.action_id) : null,
      created_at_wall: String(r.created_at_wall)};
  }

  // -- events (own monotonic seq per run) -------------------------------------

  appendEvent(runId: string, type: string, payload: Record<string, unknown>): AgentEvent {
    return this.tx(() => {
      const row = this.stmt('SELECT seq FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(runId) as {seq: number} | undefined;
      const seq = Number(row?.seq ?? 0) + 1;
      const now = new Date().toISOString();
      this.stmt('INSERT INTO events (run_id, seq, created_at_wall, type, payload) VALUES (?,?,?,?,?)')
        .run(runId, seq, now, type, JSON.stringify(payload));
      return {seq, run_id: runId, created_at_wall: now, type, payload};
    });
  }

  eventsAfter(runId: string, afterSeq: number, limit: number): AgentEvent[] {
    const rows = this.stmt('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(runId, afterSeq, limit) as Record<string, unknown>[];
    return rows.map(r => ({seq: Number(r.seq), run_id: runId, created_at_wall: String(r.created_at_wall),
      type: String(r.type), payload: JSON.parse(String(r.payload)) as Record<string, unknown>}));
  }

  // -- dedupe markers (restart-safe: emit events exactly once) ----------------

  /** Returns true when key was unseen; stores value. */
  markSeen(runId: string, key: string, value: string): boolean {
    const r = this.stmt('SELECT value FROM seen WHERE run_id=? AND key=?').get(runId, key) as {value: string} | undefined;
    if (r && r.value === value) return false;
    this.stmt('INSERT INTO seen (run_id, key, value) VALUES (?,?,?) ON CONFLICT(run_id, key) DO UPDATE SET value=excluded.value')
      .run(runId, key, value);
    return true;
  }

  close(): void {
    this.db.close();
  }
}
