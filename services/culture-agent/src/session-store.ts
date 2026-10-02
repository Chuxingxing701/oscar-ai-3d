// Long-lived culture session persistence (design §4.2). Schema v3 lives in
// the SAME agent.sqlite as the run/intent ledger: one process, one store,
// incremental idempotent migrations keyed by agent_meta.schema_version.
//
// Objects: Session (unique per runtime_instance_id+experiment_id), messages
// with their own seq, session_events with an independent session_seq, tasks
// with goal_revision CAS + status, plan_steps, wakes, the device event inbox
// (dedupe + cursor), session-scoped intents and memory checkpoints.
// Raw action facts are never compacted away; checkpoints only bound the model
// context (covered_message_seq watermark).
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from '@oscar/device-contract';
import {missingExecutionParameters, normalizeGoalSpec} from './goal.ts';
import type {StepVerification} from './skills.ts';

export const AGENT_SCHEMA_VERSION = 3;

export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  runtime_instance_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  scenario_id TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active',        -- active | archived
  archived_reason TEXT,
  backend TEXT NOT NULL DEFAULT 'pi',
  owner_generation INTEGER NOT NULL DEFAULT 0,     -- scheduler fencing token
  agent_paused INTEGER NOT NULL DEFAULT 0,         -- operator pause: no new decisions/actions
  loop_state TEXT NOT NULL DEFAULT 'idle',
  loop_state_detail TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  consumed_user_seq INTEGER NOT NULL DEFAULT 0,    -- max user seq a committed turn saw
  inbox_cursor INTEGER NOT NULL DEFAULT 0,         -- device event seq consumed
  handoff_pending INTEGER NOT NULL DEFAULT 0,      -- N04: a current task went terminal but promotion barriers are uncleared
  model_state TEXT,                                -- backend continuity (pi context)
  created_at_wall TEXT NOT NULL,
  updated_at_wall TEXT NOT NULL,
  UNIQUE (runtime_instance_id, experiment_id)
);
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at_wall TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  message_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,                              -- user | assistant | system
  content TEXT NOT NULL,
  request_id TEXT,
  task_id TEXT,
  meta TEXT,                                       -- JSON {turn_id, tool_calls, ...}
  created_at_wall TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_request ON messages(session_id, request_id) WHERE request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  goal_spec TEXT NOT NULL,
  goal_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,                            -- queued|draft|ready|running|waiting_device|waiting_condition|needs_input|paused|completed|failed|cancelled
  reason TEXT,
  queue_index INTEGER NOT NULL DEFAULT 0,          -- FIFO position (global create order; the queue = 'queued' rows in this order)
  budget TEXT NOT NULL,
  create_request_id TEXT,                           -- F14 create idempotency (survives goal edits)
  create_canonical TEXT,                            -- canonical create body (goal + spec + resolved budget)
  created_at_wall TEXT NOT NULL,
  updated_at_wall TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE TABLE IF NOT EXISTS plan_steps (
  step_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  index_in_plan INTEGER NOT NULL,
  skill TEXT NOT NULL,
  skill_version TEXT,
  inputs TEXT,
  status TEXT NOT NULL,                            -- pending|running|done|failed|skipped
  action_ids TEXT NOT NULL DEFAULT '[]',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  updated_at_wall TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_task ON plan_steps(task_id);
CREATE TABLE IF NOT EXISTS wakes (
  wake_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,                              -- action_terminal|sim_time|condition
  predicate TEXT,                                  -- JSON threshold condition
  target_sim_s REAL,
  source_watermark REAL,
  status TEXT NOT NULL DEFAULT 'armed',            -- armed|fired|cancelled
  dedupe_key TEXT,
  goal_revision INTEGER,                           -- N03: goal revision the wake was armed under
  step_id TEXT,                                    -- N03: plan step the wake is bound to (monitor_until)
  created_at_wall TEXT NOT NULL,
  fired_at_wall TEXT
);
CREATE INDEX IF NOT EXISTS idx_wakes_session ON wakes(session_id, status);
CREATE TABLE IF NOT EXISTS inbox (
  inbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,                            -- 'device'
  source_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received',          -- received|processed|dropped
  created_at_wall TEXT NOT NULL,
  UNIQUE (session_id, source, source_seq)
);
CREATE TABLE IF NOT EXISTS session_intents (
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  key TEXT NOT NULL,
  capability TEXT NOT NULL,
  canonical_request TEXT NOT NULL,
  action_id TEXT,
  goal_revision INTEGER NOT NULL,
  operation_id TEXT,                                -- F06 planner operation identity (op1, op2, ...)
  budget_counted INTEGER NOT NULL DEFAULT 0,        -- F06 one-time action budget accounting
  state TEXT NOT NULL DEFAULT 'pending',            -- pending|bound|not_accepted|rejected (outcome certainty)
  cancel_state TEXT NOT NULL DEFAULT 'none',        -- N05 durable device-cancel intent: none|requested|confirmed
  cancel_attempts INTEGER NOT NULL DEFAULT 0,       -- N05 attempts of the recorded cancel intent
  cancel_last_error TEXT,                           -- N05 why the last cancel attempt failed
  created_at_wall TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
);
CREATE INDEX IF NOT EXISTS idx_session_intents_pending ON session_intents(session_id) WHERE action_id IS NULL;
CREATE TABLE IF NOT EXISTS memory_checkpoints (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  covered_message_seq INTEGER NOT NULL,
  goal_revision INTEGER NOT NULL,
  summary TEXT NOT NULL,
  facts TEXT,
  open_questions TEXT,
  evidence_refs TEXT,
  versions TEXT,
  created_at_wall TEXT NOT NULL,
  PRIMARY KEY (session_id, generation)
);
`;

export type TaskStatus = 'queued' | 'draft' | 'ready' | 'running' | 'waiting_device' | 'waiting_condition'
  | 'needs_input' | 'paused' | 'completed' | 'failed' | 'cancelled';

/**
 * R07 task queue. `queued` tasks hold NO execution rights: they wait in FIFO
 * queue_index order. The CURRENT task is the single non-terminal, non-queued
 * task (paused and needs_input included — they block the queue; they are not
 * terminal). Promotion (queued → ready/needs_input) happens only through the
 * CAS transaction in promoteQueuedTask, so exactly one task can ever hold the
 * execution slot.
 */
export const CURRENT_TASK_STATUSES: readonly TaskStatus[] = ['draft', 'ready', 'running', 'waiting_device',
  'waiting_condition', 'needs_input', 'paused'];
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];
/** Loop states are reported separately from task status (design §4.2). */
export type LoopState = 'idle' | 'thinking' | 'executing' | 'waiting_device' | 'waiting_condition'
  | 'needs_input' | 'paused' | 'recovering' | 'unavailable' | 'unsupported_clock_mode';

export interface SessionRow {
  session_id: string;
  runtime_instance_id: string;
  experiment_id: string;
  scenario_id: string | null;
  lifecycle: 'active' | 'archived';
  archived_reason: string | null;
  backend: string;
  owner_generation: number;
  agent_paused: boolean;
  loop_state: LoopState;
  loop_state_detail: string | null;
  last_event_seq: number;
  last_message_seq: number;
  consumed_user_seq: number;
  inbox_cursor: number;
  /** N04: the previous current task reached a terminal state, but promotion
   * has not cleared the handoff barriers yet (unresolved intents / in-flight
   * device actions). While set, NO new task may be born 'ready'. */
  handoff_pending: boolean;
  model_state: string | null;
  created_at_wall: string;
  updated_at_wall: string;
}

export interface MessageRow {
  message_id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  request_id: string | null;
  task_id: string | null;
  meta: Record<string, unknown> | null;
  created_at_wall: string;
}

export interface TaskBudget {
  max_actions: number;
  actions_used: number;
  max_model_turns: number;
  model_turns_used: number;
}

export interface TaskRow {
  task_id: string;
  session_id: string;
  goal_text: string;
  goal_spec: Record<string, unknown>;
  goal_revision: number;
  status: TaskStatus;
  reason: string | null;
  queue_index: number;
  budget: TaskBudget;
  create_request_id: string | null;
  create_canonical: string | null;
  created_at_wall: string;
  updated_at_wall: string;
}

export interface PlanStepRow {
  step_id: string;
  task_id: string;
  plan_revision: number;
  index_in_plan: number;
  skill: string;
  skill_version: string | null;
  inputs: Record<string, unknown> | null;
  /** Reviewed postcondition spec of the skill@version this step was planned with (R08). */
  postconditions: Record<string, unknown> | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  action_ids: string[];
  evidence_refs: string[];
  /** Last evaluator result: pass/fail + reasons + evidence (null = never evaluated). */
  verification: StepVerification | null;
  updated_at_wall: string;
}

export interface WakeRow {
  wake_id: string;
  session_id: string;
  task_id: string;
  kind: 'action_terminal' | 'sim_time' | 'condition';
  predicate: Record<string, unknown> | null;
  target_sim_s: number | null;
  source_watermark: number | null;
  status: 'armed' | 'fired' | 'cancelled';
  dedupe_key: string | null;
  /** N03: goal revision at arm time (null on pre-binding rows). */
  goal_revision: number | null;
  /** N03: plan step (monitor_until) the wake is bound to (null = unbound). */
  step_id: string | null;
  created_at_wall: string;
  fired_at_wall: string | null;
}

/** Certainty of an intent's device effect. `pending` = unknown (may or may
 * not have been accepted — blocks new session writes until reconciled);
 * `bound` = resolved to an action; `not_accepted` = the Runtime definitively
 * holds no action for the key (same-key retry stays allowed); `rejected` =
 * the Runtime definitively refused the submit. */
export type IntentState = 'pending' | 'bound' | 'not_accepted' | 'rejected';

/** N05 durable device-cancel intent per bound action. `none` = never
 * requested; `requested` = a cancel must reach the device (or already did —
 * the outcome is unknown) and stays retryable; `confirmed` = the Runtime
 * accepted the cancel or the action is already terminal (idempotent end
 * state, never re-POSTed). */
export type IntentCancelState = 'none' | 'requested' | 'confirmed';

export interface SessionIntentRow {
  session_id: string;
  task_id: string;
  key: string;
  capability: string;
  canonical_request: string;
  action_id: string | null;
  goal_revision: number;
  operation_id: string | null;
  budget_counted: boolean;
  state: IntentState;
  cancel_state: IntentCancelState;
  cancel_attempts: number;
  cancel_last_error: string | null;
  created_at_wall: string;
}

export interface MemoryCheckpointRow {
  session_id: string;
  generation: number;
  covered_message_seq: number;
  goal_revision: number;
  summary: string;
  facts: string[];
  open_questions: string[];
  evidence_refs: string[];
  versions: Record<string, unknown>;
  created_at_wall: string;
}

export interface SessionEventRow {
  session_id: string;
  seq: number;
  created_at_wall: string;
  type: string;
  payload: Record<string, unknown>;
}

export class SessionStore {
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, import('node:sqlite').StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.migrate();
  }

  migrate(): void {
    this.db.exec(SESSION_SCHEMA);
    this.addColumnIfMissing('tasks', 'create_request_id', 'TEXT');
    this.addColumnIfMissing('tasks', 'create_canonical', 'TEXT');
    this.addColumnIfMissing('session_intents', 'operation_id', 'TEXT');
    this.addColumnIfMissing('session_intents', 'budget_counted', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('session_intents', 'state', "TEXT NOT NULL DEFAULT 'pending'");
    // N04: persisted handoff marker — set in the same transaction that makes a
    // CURRENT task terminal, cleared by promotion once the barriers passed.
    this.addColumnIfMissing('sessions', 'handoff_pending', 'INTEGER NOT NULL DEFAULT 0');
    // N05: durable per-action cancel intent (survives restart; the in-memory
    // set could be lost by one transient error).
    this.addColumnIfMissing('session_intents', 'cancel_state', "TEXT NOT NULL DEFAULT 'none'");
    this.addColumnIfMissing('session_intents', 'cancel_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('session_intents', 'cancel_last_error', 'TEXT');
    this.addColumnIfMissing('sessions', 'consumed_user_seq', 'INTEGER NOT NULL DEFAULT 0');
    // R08 versioned skills: steps persist the reviewed postcondition spec and
    // every verification result (pass/fail + reasons + evidence).
    this.addColumnIfMissing('plan_steps', 'postconditions', 'TEXT');
    this.addColumnIfMissing('plan_steps', 'verification', 'TEXT');
    // N03: wakes persist the goal revision and plan-step identity they were
    // armed for, so monitor evidence cannot be substituted across revisions,
    // steps or thresholds.
    this.addColumnIfMissing('wakes', 'goal_revision', 'INTEGER');
    this.addColumnIfMissing('wakes', 'step_id', 'TEXT');
    // pre-state-schema rows that already carry an action are bound
    this.stmt("UPDATE session_intents SET state='bound' WHERE action_id IS NOT NULL AND state='pending'").run();
    const current = this.db.prepare("SELECT value FROM agent_meta WHERE key='schema_version'")
      .get() as {value: string} | undefined;
    const version = Number(current?.value ?? 0);
    if (version > AGENT_SCHEMA_VERSION) {
      throw new Error(`agent store schema v${version} is newer than this build (v${AGENT_SCHEMA_VERSION}); upgrade the Agent first`);
    }
    // v1 (runs/intents/events/seen) needs no transformation; v2 adds the
    // session tables above; v3 adds tasks.create_* and session_intents
    // operation/budget columns via additive ALTER. Re-running is idempotent.
    this.db.prepare("INSERT INTO agent_meta (key, value) VALUES ('schema_version', ?) "
      + "ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(AGENT_SCHEMA_VERSION));
  }

  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
    if (!cols.some(c => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
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

  // -- sessions ---------------------------------------------------------------

  createSession(input: {runtime_instance_id: string; experiment_id: string; scenario_id?: string | null;
    backend?: string}): SessionRow {
    return this.tx(() => {
      const existing = this.sessionByExperiment(input.runtime_instance_id, input.experiment_id);
      if (existing) return existing;
      const now = new Date().toISOString();
      const id = `cs-${input.experiment_id.replace(/^exp-/, '')}-${randomUUID().slice(0, 8)}`;
      this.stmt(`INSERT INTO sessions (session_id, runtime_instance_id, experiment_id, scenario_id, lifecycle,
        backend, created_at_wall, updated_at_wall) VALUES (?,?,?,?,'active',?,?,?)`)
        .run(id, input.runtime_instance_id, input.experiment_id, input.scenario_id ?? null,
          input.backend ?? 'pi', now, now);
      return this.getSession(id)!;
    });
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.stmt('SELECT * FROM sessions WHERE session_id=?').get(id) as Record<string, unknown> | undefined;
    return r ? toSessionRow(r) : undefined;
  }

  sessionByExperiment(runtimeInstanceId: string, experimentId: string): SessionRow | undefined {
    const r = this.stmt('SELECT * FROM sessions WHERE runtime_instance_id=? AND experiment_id=?')
      .get(runtimeInstanceId, experimentId) as Record<string, unknown> | undefined;
    return r ? toSessionRow(r) : undefined;
  }

  listSessions(): SessionRow[] {
    return (this.stmt('SELECT * FROM sessions ORDER BY created_at_wall ASC').all() as Record<string, unknown>[])
      .map(toSessionRow);
  }

  /** Seals write capability (experiment archived / reset). Kept readable. */
  archiveSession(id: string, reason: string): void {
    this.stmt("UPDATE sessions SET lifecycle='archived', archived_reason=?, updated_at_wall=? WHERE session_id=?")
      .run(reason, new Date().toISOString(), id);
  }

  updateSession(id: string, fields: Partial<Pick<SessionRow, 'loop_state' | 'loop_state_detail' | 'model_state'
    | 'inbox_cursor' | 'agent_paused'>>): void {
    const current = this.getSession(id);
    if (!current) throw new Error(`no session ${id}`);
    this.stmt(`UPDATE sessions SET loop_state=?, loop_state_detail=?, model_state=?, inbox_cursor=?, agent_paused=?, updated_at_wall=?
      WHERE session_id=?`)
      .run(fields.loop_state ?? current.loop_state, fields.loop_state_detail ?? current.loop_state_detail,
        fields.model_state !== undefined ? fields.model_state : current.model_state,
        fields.inbox_cursor ?? current.inbox_cursor,
        fields.agent_paused !== undefined ? (fields.agent_paused ? 1 : 0) : (current.agent_paused ? 1 : 0),
        new Date().toISOString(), id);
  }

  /** Fencing: a new scheduler owner takes the generation; older ones lose write rights. */
  claimOwnership(id: string): number {
    return this.tx(() => {
      this.stmt('UPDATE sessions SET owner_generation=owner_generation+1, updated_at_wall=? WHERE session_id=?')
        .run(new Date().toISOString(), id);
      return this.getSession(id)!.owner_generation;
    });
  }

  // -- session events (independent session_seq) ---------------------------------

  appendSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): SessionEventRow {
    return this.tx(() => {
      const row = this.stmt('SELECT seq FROM session_events WHERE session_id=? ORDER BY seq DESC LIMIT 1')
        .get(sessionId) as {seq: number} | undefined;
      const seq = Number(row?.seq ?? 0) + 1;
      const now = new Date().toISOString();
      this.stmt('INSERT INTO session_events (session_id, seq, created_at_wall, type, payload) VALUES (?,?,?,?,?)')
        .run(sessionId, seq, now, type, JSON.stringify(payload));
      this.stmt('UPDATE sessions SET last_event_seq=?, updated_at_wall=? WHERE session_id=?').run(seq, now, sessionId);
      return {session_id: sessionId, seq, created_at_wall: now, type, payload};
    });
  }

  sessionEventsAfter(sessionId: string, afterSeq: number, limit: number): SessionEventRow[] {
    const rows = this.stmt('SELECT * FROM session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(sessionId, afterSeq, limit) as Record<string, unknown>[];
    return rows.map(r => ({session_id: sessionId, seq: Number(r.seq), created_at_wall: String(r.created_at_wall),
      type: String(r.type), payload: JSON.parse(String(r.payload)) as Record<string, unknown>}));
  }

  // -- messages -----------------------------------------------------------------

  /** Idempotent on request_id: a retried send returns the original message. */
  appendMessage(sessionId: string, input: {role: MessageRow['role']; content: string; request_id?: string | null;
    task_id?: string | null; meta?: Record<string, unknown> | null}): MessageRow {
    return this.tx(() => {
      if (input.request_id) {
        const hit = this.stmt('SELECT * FROM messages WHERE session_id=? AND request_id=?')
          .get(sessionId, input.request_id) as Record<string, unknown> | undefined;
        if (hit) return toMessageRow(hit);
      }
      const row = this.stmt('SELECT seq FROM messages WHERE session_id=? ORDER BY seq DESC LIMIT 1')
        .get(sessionId) as {seq: number} | undefined;
      const seq = Number(row?.seq ?? 0) + 1;
      const now = new Date().toISOString();
      const message: MessageRow = {message_id: `msg-${randomUUID().slice(0, 12)}`, session_id: sessionId, seq,
        role: input.role, content: input.content, request_id: input.request_id ?? null, task_id: input.task_id ?? null,
        meta: input.meta ?? null, created_at_wall: now};
      this.stmt(`INSERT INTO messages (message_id, session_id, seq, role, content, request_id, task_id, meta, created_at_wall)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(message.message_id, sessionId, seq, input.role, input.content, message.request_id, message.task_id,
          message.meta ? JSON.stringify(message.meta) : null, now);
      this.stmt('UPDATE sessions SET last_message_seq=?, updated_at_wall=? WHERE session_id=?').run(seq, now, sessionId);
      return message;
    });
  }

  listMessages(sessionId: string, afterSeq = 0, limit = 500): MessageRow[] {
    const rows = this.stmt('SELECT * FROM messages WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(sessionId, afterSeq, limit) as Record<string, unknown>[];
    return rows.map(toMessageRow);
  }

  /** Advance the consumed-user-message watermark (monotonic; never moves back). */
  consumeUserMessages(sessionId: string, seq: number): void {
    if (seq <= 0) return;
    this.stmt('UPDATE sessions SET consumed_user_seq=MAX(consumed_user_seq, ?), updated_at_wall=? WHERE session_id=?')
      .run(seq, new Date().toISOString(), sessionId);
  }

  /** True when a persisted user message was never included in a committed turn. */
  hasUnconsumedUserMessages(sessionId: string): boolean {
    const hit = this.stmt(`SELECT 1 FROM messages WHERE session_id=? AND role='user'
      AND seq > COALESCE((SELECT consumed_user_seq FROM sessions WHERE session_id=?), 0) LIMIT 1`)
      .get(sessionId, sessionId);
    return hit != null;
  }

  // -- tasks ----------------------------------------------------------------------

  /**
   * R07 single store-level create entry for EVERY path (web UI, user HTTP,
   * supervisor delegation, model propose_task). Idempotent on request_id (a
   * replay returns the ORIGINAL task — including while it is queued; a
   * divergent body conflicts). N04 admission rule, shared with promotion:
   * a new task is born 'ready' ONLY when the execution slot is free — no
   * current task, no queued task, AND no pending handoff (a terminal previous
   * task whose barriers promotion has not cleared yet). Otherwise it is
   * persisted as 'queued' in FIFO queue_index order and promotion — which
   * owns the barriers — decides. This closes the terminal→promotion gap: a
   * later arrival can never jump an existing queue or skip the handoff.
   */
  createTask(sessionId: string, input: {goal_text: string; goal_spec: Record<string, unknown>;
    budget?: Partial<TaskBudget>; request_id?: string | null}): TaskRow {
    return this.tx(() => {
      const maxActions = createBudgetLimit(input.budget?.max_actions, 40, 'max_actions');
      const maxModelTurns = createBudgetLimit(input.budget?.max_model_turns, 200, 'max_model_turns');
      const canonical = createCanonical(input.goal_text, input.goal_spec, maxActions, maxModelTurns);
      if (input.request_id) {
        const existing = this.findTaskByRequest(sessionId, input.request_id);
        if (existing) {
          const same = existing.create_canonical !== null ? existing.create_canonical === canonical
            : createCanonical(existing.goal_text, existing.goal_spec, existing.budget.max_actions,
              existing.budget.max_model_turns) === canonical;
          if (same) return existing;
          throw new Error(`request_conflict: request_id '${input.request_id}' already created task `
            + `${existing.task_id} with a different goal or budget`);
        }
      }
      const now = new Date().toISOString();
      const taskId = `task-${randomUUID().slice(0, 12)}`;
      const queue = (this.stmt('SELECT COALESCE(MAX(queue_index), 0) AS q FROM tasks WHERE session_id=?')
        .get(sessionId) as {q: number}).q + 1;
      // queue behind the current task, an existing queue, or an uncleared
      // handoff; a queued task never holds execution rights
      const status: TaskStatus = this.executionSlotFree(sessionId) ? 'ready' : 'queued';
      const budget: TaskBudget = {max_actions: maxActions, actions_used: 0,
        max_model_turns: maxModelTurns, model_turns_used: 0};
      const spec = input.request_id ? {...input.goal_spec, request_id: input.request_id} : input.goal_spec;
      this.stmt(`INSERT INTO tasks (task_id, session_id, goal_text, goal_spec, goal_revision, status, queue_index,
        budget, create_request_id, create_canonical, created_at_wall, updated_at_wall) VALUES (?,?,?,?,1,?,?,?,?,?,?,?)`)
        .run(taskId, sessionId, input.goal_text, JSON.stringify(spec), status, queue, JSON.stringify(budget),
          input.request_id ?? null, canonical, now, now);
      return this.getTask(taskId)!;
    });
  }

  /** Create idempotency lookup: the v3 column first, then the legacy goal_spec copy. */
  findTaskByRequest(sessionId: string, requestId: string): TaskRow | undefined {
    const byColumn = this.stmt('SELECT * FROM tasks WHERE session_id=? AND create_request_id=?')
      .get(sessionId, requestId) as Record<string, unknown> | undefined;
    if (byColumn) return toTaskRow(byColumn);
    const legacy = this.stmt("SELECT * FROM tasks WHERE session_id=? AND json_extract(goal_spec, '$.request_id')=?")
      .get(sessionId, requestId) as Record<string, unknown> | undefined;
    return legacy ? toTaskRow(legacy) : undefined;
  }

  getTask(taskId: string): TaskRow | undefined {
    const r = this.stmt('SELECT * FROM tasks WHERE task_id=?').get(taskId) as Record<string, unknown> | undefined;
    return r ? toTaskRow(r) : undefined;
  }

  listTasks(sessionId: string): TaskRow[] {
    return (this.stmt('SELECT * FROM tasks WHERE session_id=? ORDER BY queue_index ASC').all(sessionId) as Record<string, unknown>[])
      .map(toTaskRow);
  }

  /**
   * The CURRENT task: the single non-terminal, non-queued task (paused and
   * needs_input included — they hold the execution slot and block the queue).
   * NEVER returns a 'queued' task; ordering by queue_index keeps the pick
   * deterministic during the terminal→promotion window.
   */
  activeTask(sessionId: string): TaskRow | undefined {
    const r = this.stmt(`SELECT * FROM tasks WHERE session_id=? AND status IN
      ('draft','ready','running','waiting_device','waiting_condition','needs_input','paused') ORDER BY queue_index ASC LIMIT 1`)
      .get(sessionId) as Record<string, unknown> | undefined;
    return r ? toTaskRow(r) : undefined;
  }

  /** R07: the ordered queue (queued tasks only, FIFO by queue_index). */
  queuedTasks(sessionId: string): Array<TaskRow & {position: number}> {
    return (this.stmt("SELECT * FROM tasks WHERE session_id=? AND status='queued' ORDER BY queue_index ASC")
      .all(sessionId) as Record<string, unknown>[])
      .map((r, i) => ({...toTaskRow(r), position: i + 1}));
  }

  /**
   * N04: the ONE admission rule shared by createTask (ready birth) and
   * promoteQueuedTask (slot handover). The execution slot is free only when
   * there is no current task, no queued task, and no pending handoff. All
   * three checks are synchronous SQL, so the rule is decided inside the
   * caller's transaction and survives restart.
   */
  private executionSlotFree(sessionId: string): boolean {
    const row = this.stmt(`SELECT
        (SELECT COUNT(*) FROM tasks WHERE session_id=? AND status IN
          ('draft','ready','running','waiting_device','waiting_condition','needs_input','paused')) AS current_n,
        (SELECT COUNT(*) FROM tasks WHERE session_id=? AND status='queued') AS queued_n,
        (SELECT handoff_pending FROM sessions WHERE session_id=?) AS handoff`)
      .get(sessionId, sessionId, sessionId) as {current_n: number; queued_n: number; handoff: number | undefined} | undefined;
    if (!row) return true; // no session row: createTask callers validated it exists
    return Number(row.current_n) === 0 && Number(row.queued_n) === 0 && Number(row.handoff ?? 0) === 0;
  }

  /** N04: a current task went terminal; promotion must clear the barriers. */
  sessionHandoffPending(sessionId: string): boolean {
    const row = this.stmt('SELECT handoff_pending FROM sessions WHERE session_id=?')
      .get(sessionId) as {handoff_pending: number} | undefined;
    return row != null && Number(row.handoff_pending) === 1;
  }

  /**
   * N04: promotion clears the persisted handoff marker AFTER the barriers
   * passed (no unresolved intents, no non-terminal in-flight actions —
   * checked by the scheduler, which owns them). Returns true when a marker
   * was actually cleared. Safe to call when nothing is pending.
   */
  clearSessionHandoff(sessionId: string): boolean {
    const r = this.stmt('UPDATE sessions SET handoff_pending=0, updated_at_wall=? '
      + 'WHERE session_id=? AND handoff_pending=1').run(new Date().toISOString(), sessionId);
    return Number(r.changes) > 0;
  }

  /** 1-based FIFO position of a queued task, or null when it is not queued. */
  queuePosition(sessionId: string, taskId: string): number | null {
    const row = this.stmt(`SELECT COUNT(*) AS ahead FROM tasks WHERE session_id=? AND status='queued'
      AND queue_index < (SELECT queue_index FROM tasks WHERE task_id=?)`)
      .get(sessionId, taskId) as {ahead: number} | undefined;
    if (!row) return null;
    const queued = this.stmt("SELECT status FROM tasks WHERE task_id=?").get(taskId) as {status: string} | undefined;
    return queued?.status === 'queued' ? Number(row.ahead) + 1 : null;
  }

  /**
   * R07 promotion, ONE SQLite transaction, CAS: the queue head is promoted
   * (queued → ready, or needs_input when its spec misses execution
   * parameters) ONLY when no current task exists AND no handoff is pending
   * (N04: promotion owns the barriers and is the only path that may clear
   * the marker, so admission and promotion share one rule). The status row
   * update is guarded by `AND status='queued'`, so two racing callers can
   * never promote two tasks — exactly one task holds execution rights at any
   * time.
   */
  promoteQueuedTask(sessionId: string): TaskRow | null {
    return this.tx(() => {
      if (this.activeTask(sessionId)) return null; // CAS: the slot is taken (incl. paused/needs_input)
      if (this.sessionHandoffPending(sessionId)) return null; // N04: barriers uncleared
      const head = this.stmt("SELECT * FROM tasks WHERE session_id=? AND status='queued' ORDER BY queue_index ASC LIMIT 1")
        .get(sessionId) as Record<string, unknown> | undefined;
      if (!head) return null;
      let status: TaskStatus = 'ready';
      let reason: string | null = 'promoted from queue (the previous task reached a terminal state)';
      try {
        const missing = missingExecutionParameters(normalizeGoalSpec(JSON.parse(String(head.goal_spec))));
        if (missing.length) {
          status = 'needs_input';
          reason = missing.join(' | ');
        }
      } catch {
        status = 'needs_input';
        reason = 'goal_spec is invalid; fix the task before it can run';
      }
      this.stmt("UPDATE tasks SET status=?, reason=?, updated_at_wall=? WHERE task_id=? AND status='queued'")
        .run(status, reason, new Date().toISOString(), String(head.task_id));
      return this.getTask(String(head.task_id)) ?? null;
    });
  }

  /**
   * R07: archive cancels the whole queue — queued tasks of an archived
   * session become cancelled (reason: session archived) and are never
   * promoted. Returns the number of tasks cancelled.
   */
  cancelQueuedTasks(sessionId: string, reason: string): number {
    const r = this.stmt("UPDATE tasks SET status='cancelled', reason=?, updated_at_wall=? WHERE session_id=? AND status='queued'")
      .run(reason, new Date().toISOString(), sessionId);
    return Number(r.changes);
  }

  /**
   * Terminal statuses are final: only the same status may be written again.
   * N04: when a CURRENT task (non-terminal, non-queued before this call)
   * reaches completed/failed/cancelled, the session's handoff marker is set
   * in the SAME transaction — from this instant no new task can be born
   * 'ready' until promotion clears the marker after its barriers pass.
   * A queued→terminal write (queue cancel/archive) never sets the marker:
   * it does not end a current task's handoff.
   */
  updateTaskStatus(taskId: string, status: TaskStatus, reason?: string | null): void {
    this.tx(() => {
      const current = this.stmt('SELECT session_id, status FROM tasks WHERE task_id=?')
        .get(taskId) as {session_id: string; status: string} | undefined;
      if (!current) return;
      if (['completed', 'failed', 'cancelled'].includes(current.status) && current.status !== status) return;
      const wasCurrent = (CURRENT_TASK_STATUSES as readonly string[]).includes(current.status);
      this.stmt('UPDATE tasks SET status=?, reason=?, updated_at_wall=? WHERE task_id=?')
        .run(status, reason ?? null, new Date().toISOString(), taskId);
      if (wasCurrent && (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) {
        this.stmt('UPDATE sessions SET handoff_pending=1, updated_at_wall=? WHERE session_id=?')
          .run(new Date().toISOString(), current.session_id);
      }
    });
  }

  /**
   * Q02 conditional turn-start write (ready→running). Unlike
   * updateTaskStatus, this is a CAS: the row must STILL be 'ready' at the
   * SAME goal revision the turn decided under — a task pause (or any other
   * status write) that landed while the turn awaited its decision-start
   * device state read is never overwritten. Returns the fresh running row on
   * success, or null when the CAS lost (0 rows): the caller must abort the
   * turn before any model call or device write. Never touches terminal rows
   * (the WHERE cannot match) and never sets the handoff marker (running is
   * not a terminal transition).
   */
  startTaskTurn(taskId: string, goalRevision: number, reason: string | null): TaskRow | null {
    return this.tx(() => {
      const r = this.stmt(`UPDATE tasks SET status='running', reason=?, updated_at_wall=?
        WHERE task_id=? AND status='ready' AND goal_revision=?`)
        .run(reason, new Date().toISOString(), taskId, goalRevision) as {changes: number | bigint};
      if (Number(r.changes) === 0) return null;
      return this.getTask(taskId) ?? null;
    });
  }

  /** CAS goal update: expected_revision guards concurrent user/model edits. */
  updateTaskGoal(taskId: string, patch: {goal_text?: string; goal_spec?: Record<string, unknown>;
    expected_revision?: number}): {ok: true; revision: number} | {ok: false; conflict: {actual: number}} {
    return this.tx(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`no task ${taskId}`);
      if (patch.expected_revision !== undefined && patch.expected_revision !== task.goal_revision) {
        return {ok: false, conflict: {actual: task.goal_revision}};
      }
      const revision = task.goal_revision + 1;
      this.stmt('UPDATE tasks SET goal_text=?, goal_spec=?, goal_revision=?, updated_at_wall=? WHERE task_id=?')
        .run(patch.goal_text ?? task.goal_text,
          JSON.stringify(patch.goal_spec ? {...patch.goal_spec, request_id: undefined} : task.goal_spec),
          revision, new Date().toISOString(), taskId);
      return {ok: true, revision};
    });
  }

  incrementTaskBudget(taskId: string, fields: {actions?: number; model_turns?: number}): TaskBudget {
    return this.tx(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`no task ${taskId}`);
      const budget: TaskBudget = {...task.budget,
        actions_used: task.budget.actions_used + (fields.actions ?? 0),
        model_turns_used: task.budget.model_turns_used + (fields.model_turns ?? 0)};
      this.stmt('UPDATE tasks SET budget=?, updated_at_wall=? WHERE task_id=?')
        .run(JSON.stringify(budget), new Date().toISOString(), taskId);
      return budget;
    });
  }

  /** Atomically bind an intent to its action and count it against the task budget exactly once. */
  accountIntent(sessionId: string, key: string, actionId: string): void {
    this.tx(() => {
      const intent = this.stmt('SELECT task_id, action_id, budget_counted FROM session_intents WHERE session_id=? AND key=?')
        .get(sessionId, key) as {task_id: string; action_id: string | null; budget_counted: number} | undefined;
      if (!intent) return;
      if (intent.action_id !== actionId) {
        this.stmt("UPDATE session_intents SET action_id=?, state='bound' WHERE session_id=? AND key=?")
          .run(actionId, sessionId, key);
      } else {
        this.stmt("UPDATE session_intents SET state='bound' WHERE session_id=? AND key=?").run(sessionId, key);
      }
      if (Number(intent.budget_counted) === 1) return;
      const budget = this.stmt('SELECT budget FROM tasks WHERE task_id=?')
        .get(intent.task_id) as {budget: string} | undefined;
      if (budget) {
        const parsed = JSON.parse(budget.budget) as TaskBudget;
        parsed.actions_used += 1;
        this.stmt('UPDATE tasks SET budget=?, updated_at_wall=? WHERE task_id=?')
          .run(JSON.stringify(parsed), new Date().toISOString(), intent.task_id);
      }
      this.stmt('UPDATE session_intents SET budget_counted=1 WHERE session_id=? AND key=?').run(sessionId, key);
    });
  }

  /** Count a recovered-by-key intent against its task budget exactly once. */
  incrementTaskBudgetByIntent(sessionId: string, key: string): void {
    const intent = this.stmt('SELECT action_id FROM session_intents WHERE session_id=? AND key=?')
      .get(sessionId, key) as {action_id: string | null} | undefined;
    if (!intent) return;
    this.accountIntent(sessionId, key, intent.action_id ?? key);
  }

  /** Reserve one model turn up front; refuses instead of exceeding max_model_turns. */
  tryReserveModelTurn(taskId: string): {ok: true; budget: TaskBudget} | {ok: false; budget: TaskBudget} {
    return this.tx(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`no task ${taskId}`);
      if (task.budget.model_turns_used >= task.budget.max_model_turns) {
        return {ok: false, budget: task.budget};
      }
      const budget: TaskBudget = {...task.budget, model_turns_used: task.budget.model_turns_used + 1};
      this.stmt('UPDATE tasks SET budget=?, updated_at_wall=? WHERE task_id=?')
        .run(JSON.stringify(budget), new Date().toISOString(), taskId);
      return {ok: true, budget};
    });
  }

  // -- plan steps -----------------------------------------------------------------

  /**
   * N01 CAS: the plan is replaced only while the task is still at
   * `planRevision` (the goal revision the deciding turn saw). Returns null
   * when the task's goal revision moved on — nothing is deleted or written,
   * so a late async tool can never clobber a newer goal's plan.
   */
  replacePlan(taskId: string, planRevision: number, steps: Array<{skill: string; skill_version?: string;
    inputs?: Record<string, unknown> | null; postconditions?: Record<string, unknown> | null}>): PlanStepRow[] | null {
    return this.tx(() => {
      const task = this.stmt('SELECT goal_revision FROM tasks WHERE task_id=?').get(taskId) as {goal_revision: unknown} | undefined;
      if (!task || Number(task.goal_revision) !== planRevision) return null;
      this.stmt('DELETE FROM plan_steps WHERE task_id=?').run(taskId);
      const now = new Date().toISOString();
      const rows: PlanStepRow[] = steps.map((s, i) => {
        const stepId = `step-${randomUUID().slice(0, 10)}`;
        this.stmt(`INSERT INTO plan_steps (step_id, task_id, plan_revision, index_in_plan, skill, skill_version,
          inputs, postconditions, status, action_ids, evidence_refs, updated_at_wall) VALUES (?,?,?,?,?,?,?,?,'pending','[]','[]',?)`)
          .run(stepId, taskId, planRevision, i, s.skill, s.skill_version ?? null,
            s.inputs ? JSON.stringify(s.inputs) : null, s.postconditions ? JSON.stringify(s.postconditions) : null, now);
        return {step_id: stepId, task_id: taskId, plan_revision: planRevision, index_in_plan: i, skill: s.skill,
          skill_version: s.skill_version ?? null, inputs: s.inputs ?? null, postconditions: s.postconditions ?? null,
          status: 'pending' as const, action_ids: [], evidence_refs: [], verification: null, updated_at_wall: now};
      });
      return rows;
    });
  }

  listPlanSteps(taskId: string): PlanStepRow[] {
    return (this.stmt('SELECT * FROM plan_steps WHERE task_id=? ORDER BY index_in_plan ASC').all(taskId) as Record<string, unknown>[])
      .map(toPlanStepRow);
  }

  /**
   * N01 CAS: the update lands only on the SAME row (step_id), the SAME plan
   * revision and the SAME prior status the caller decided against
   * (`UPDATE ... WHERE step_id=? AND plan_revision=? AND status=?`). A step
   * replaced by a newer plan, or changed by another writer while evidence was
   * being verified, matches 0 rows: the caller sees `false` and refuses.
   */
  updatePlanStep(stepId: string, fields: Partial<Pick<PlanStepRow, 'status' | 'action_ids' | 'evidence_refs'
    | 'verification' | 'postconditions'>>, expected?: {plan_revision?: number; status?: string}): boolean {
    return this.tx(() => {
      const current = this.stmt('SELECT * FROM plan_steps WHERE step_id=?').get(stepId) as Record<string, unknown> | undefined;
      if (!current) {
        // a CAS caller sees a miss (the row was deleted by a newer plan); the
        // unguarded legacy path keeps its explicit error
        if (expected) return false;
        throw new Error(`no plan step ${stepId}`);
      }
      const guards: string[] = [];
      const params: Array<string | number | null> = [fields.status ?? String(current.status),
        JSON.stringify(fields.action_ids ?? JSON.parse(String(current.action_ids))),
        JSON.stringify(fields.evidence_refs ?? JSON.parse(String(current.evidence_refs))),
        fields.verification !== undefined ? JSON.stringify(fields.verification)
          : (typeof current.verification === 'string' ? current.verification : null),
        fields.postconditions !== undefined ? JSON.stringify(fields.postconditions)
          : (typeof current.postconditions === 'string' ? current.postconditions : null),
        new Date().toISOString()];
      let sql = `UPDATE plan_steps SET status=?, action_ids=?, evidence_refs=?, verification=?, postconditions=?, updated_at_wall=?
        WHERE step_id=?`;
      params.push(stepId);
      if (expected?.plan_revision !== undefined) {
        guards.push('plan_revision=?');
        params.push(expected.plan_revision);
      }
      if (expected?.status !== undefined) {
        guards.push('status=?');
        params.push(expected.status);
      }
      if (guards.length) sql += ` AND ${guards.join(' AND ')}`;
      const r = this.stmt(sql).run(...params) as {changes: number | bigint};
      return Number(r.changes) > 0;
    });
  }

  // -- wakes ------------------------------------------------------------------------

  armWake(input: {session_id: string; task_id: string; kind: WakeRow['kind'];
    predicate?: Record<string, unknown> | null; target_sim_s?: number | null; source_watermark?: number | null;
    dedupe_key?: string | null; goal_revision?: number | null; step_id?: string | null}): WakeRow {
    return this.tx(() => {
      if (input.dedupe_key) {
        const hit = this.stmt("SELECT * FROM wakes WHERE session_id=? AND dedupe_key=? AND status='armed'")
          .get(input.session_id, input.dedupe_key) as Record<string, unknown> | undefined;
        if (hit) return toWakeRow(hit);
      }
      const id = `wake-${randomUUID().slice(0, 10)}`;
      const now = new Date().toISOString();
      this.stmt(`INSERT INTO wakes (wake_id, session_id, task_id, kind, predicate, target_sim_s, source_watermark,
        status, dedupe_key, goal_revision, step_id, created_at_wall) VALUES (?,?,?,?,?,?,?,'armed',?,?,?,?)`)
        .run(id, input.session_id, input.task_id, input.kind,
          input.predicate ? JSON.stringify(input.predicate) : null, input.target_sim_s ?? null,
          input.source_watermark ?? null, input.dedupe_key ?? null,
          input.goal_revision ?? null, input.step_id ?? null, now);
      return this.getWake(id)!;
    });
  }

  getWake(id: string): WakeRow | undefined {
    const r = this.stmt('SELECT * FROM wakes WHERE wake_id=?').get(id) as Record<string, unknown> | undefined;
    return r ? toWakeRow(r) : undefined;
  }

  armedWakes(sessionId: string): WakeRow[] {
    return (this.stmt("SELECT * FROM wakes WHERE session_id=? AND status='armed' ORDER BY created_at_wall")
      .all(sessionId) as Record<string, unknown>[]).map(toWakeRow);
  }

  /** Fired wakes of a session (optionally one task) — monitor_until evidence (R08). */
  firedWakes(sessionId: string, taskId?: string): WakeRow[] {
    const sql = taskId == null
      ? "SELECT * FROM wakes WHERE session_id=? AND status='fired' ORDER BY fired_at_wall"
      : "SELECT * FROM wakes WHERE session_id=? AND task_id=? AND status='fired' ORDER BY fired_at_wall";
    const rows = (taskId == null
      ? this.stmt(sql).all(sessionId)
      : this.stmt(sql).all(sessionId, taskId)) as Record<string, unknown>[];
    return rows.map(toWakeRow);
  }

  fireWake(id: string): void {
    this.stmt("UPDATE wakes SET status='fired', fired_at_wall=? WHERE wake_id=? AND status='armed'")
      .run(new Date().toISOString(), id);
  }

  cancelWakes(sessionId: string, taskId?: string): void {
    const now = new Date().toISOString();
    if (taskId) {
      this.stmt("UPDATE wakes SET status='cancelled', fired_at_wall=? WHERE session_id=? AND task_id=? AND status='armed'")
        .run(now, sessionId, taskId);
    } else {
      this.stmt("UPDATE wakes SET status='cancelled', fired_at_wall=? WHERE session_id=? AND status='armed'").run(now, sessionId);
    }
  }

  /** Planning wakes only (sim_time/condition); never touches action_terminal wakes. */
  cancelPlanningWakes(sessionId: string, taskId: string): void {
    this.stmt(`UPDATE wakes SET status='cancelled', fired_at_wall=? WHERE session_id=? AND task_id=? AND status='armed'
      AND kind IN ('sim_time','condition')`).run(new Date().toISOString(), sessionId, taskId);
  }

  // -- inbox (device events, at-least-once → dedupe by (source, seq)) -----------------

  /** Returns null when the seq was already recorded (duplicate delivery). Cursor update is atomic with the insert. */
  recordInbox(sessionId: string, source: string, seq: number, eventType: string,
    payload: Record<string, unknown>): {inboxId: number} | null {
    return this.tx(() => {
      const info = this.stmt('SELECT inbox_id FROM inbox WHERE session_id=? AND source=? AND source_seq=?')
        .get(sessionId, source, seq) as {inbox_id: number} | undefined;
      if (info) return null;
      const r = this.stmt(`INSERT INTO inbox (session_id, source, source_seq, event_type, payload, state, created_at_wall)
        VALUES (?,?,?,?,?,'received',?)`)
        .run(sessionId, source, seq, eventType, JSON.stringify(payload), new Date().toISOString()) as {changes: number; lastInsertRowid: number | bigint};
      this.stmt('UPDATE sessions SET inbox_cursor=?, updated_at_wall=? WHERE session_id=? AND inbox_cursor<?')
        .run(seq, new Date().toISOString(), sessionId, seq);
      return {inboxId: Number(r.lastInsertRowid)};
    });
  }

  inboxRow(sessionId: string, source: string, seq: number): {state: string; event_type: string} | undefined {
    const r = this.stmt('SELECT state, event_type FROM inbox WHERE session_id=? AND source=? AND source_seq=?')
      .get(sessionId, source, seq) as {state: string; event_type: string} | undefined;
    return r;
  }

  /** Consumed inbox rows of a type (payload JSON), oldest first. */
  inboxByType(sessionId: string, eventType: string): Array<{source_seq: number; state: string; payload: string}> {
    return (this.stmt('SELECT source_seq, state, payload FROM inbox WHERE session_id=? AND event_type=? ORDER BY source_seq')
      .all(sessionId, eventType) as Record<string, unknown>[]).map(r => ({source_seq: Number(r.source_seq),
      state: String(r.state), payload: String(r.payload)}));
  }

  markInboxProcessed(sessionId: string, source: string, seq: number, state: 'processed' | 'dropped'): void {
    this.stmt('UPDATE inbox SET state=? WHERE session_id=? AND source=? AND source_seq=?').run(state, sessionId, source, seq);
  }

  /** Undrained inbox rows for a session, oldest first (F03 drain half). */
  listReceivedInbox(sessionId: string): Array<{source: string; source_seq: number; event_type: string;
    payload: Record<string, unknown>}> {
    return (this.stmt("SELECT source, source_seq, event_type, payload FROM inbox WHERE session_id=? AND state='received' ORDER BY source_seq")
      .all(sessionId) as Record<string, unknown>[]).map(r => ({source: String(r.source), source_seq: Number(r.source_seq),
      event_type: String(r.event_type), payload: JSON.parse(String(r.payload)) as Record<string, unknown>}));
  }

  setInboxCursor(sessionId: string, seq: number): void {
    this.stmt('UPDATE sessions SET inbox_cursor=?, updated_at_wall=? WHERE session_id=?')
      .run(seq, new Date().toISOString(), sessionId);
  }

  // -- session intents (persisted BEFORE submit; recovery by idempotency key) -------------

  insertSessionIntent(input: {session_id: string; task_id: string; key: string; capability: string;
    canonical: string; goal_revision: number; operation_id?: string | null}): void {
    this.stmt(`INSERT OR IGNORE INTO session_intents (session_id, task_id, key, capability, canonical_request,
      action_id, goal_revision, operation_id, budget_counted, created_at_wall) VALUES (?,?,?,?,?,NULL,?,?,0,?)`)
      .run(input.session_id, input.task_id, input.key, input.capability, input.canonical, input.goal_revision,
        input.operation_id ?? null, new Date().toISOString());
  }

  /** Persisted monotonic per-session counter (agent_meta); independent of actions_used. */
  nextOperationId(sessionId: string): string {
    return this.tx(() => {
      const key = `operation_seq:${sessionId}`;
      const row = this.stmt('SELECT value FROM agent_meta WHERE key=?').get(key) as {value: string} | undefined;
      const n = Number(row?.value ?? 0) + 1;
      this.stmt('INSERT INTO agent_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, String(n));
      return `op${n}`;
    });
  }

  /** Reuse requires the same task, canonical request and goal revision, an
   * outcome that is still safely retryable with the SAME key (unknown, or the
   * Runtime's definite "no action for this key"), and no action yet. A
   * definitively rejected operation is finished; a re-plan gets a fresh key. */
  findReusableIntent(sessionId: string, taskId: string, canonical: string, goalRevision: number): SessionIntentRow | undefined {
    const r = this.stmt(`SELECT * FROM session_intents WHERE session_id=? AND task_id=? AND canonical_request=?
      AND goal_revision=? AND action_id IS NULL AND state IN ('pending','not_accepted') ORDER BY created_at_wall LIMIT 1`)
      .get(sessionId, taskId, canonical, goalRevision) as Record<string, unknown> | undefined;
    return r ? toSessionIntentRow(r) : undefined;
  }

  setSessionIntentAction(sessionId: string, key: string, actionId: string): void {
    this.stmt("UPDATE session_intents SET action_id=?, state='bound' WHERE session_id=? AND key=?")
      .run(actionId, sessionId, key);
  }

  /** Outcome-certainty transition (pending ⇄ terminal); bound goes through accountIntent. */
  setSessionIntentState(sessionId: string, key: string, state: IntentState): void {
    this.stmt('UPDATE session_intents SET state=? WHERE session_id=? AND key=? AND action_id IS NULL')
      .run(state, sessionId, key);
  }

  listSessionIntents(sessionId: string): SessionIntentRow[] {
    return (this.stmt('SELECT * FROM session_intents WHERE session_id=? ORDER BY created_at_wall, key')
      .all(sessionId) as Record<string, unknown>[]).map(toSessionIntentRow);
  }

  pendingSessionIntents(sessionId: string): SessionIntentRow[] {
    return (this.stmt('SELECT * FROM session_intents WHERE session_id=? AND action_id IS NULL ORDER BY created_at_wall, key')
      .all(sessionId) as Record<string, unknown>[]).map(toSessionIntentRow);
  }

  /** Intents whose device effect is UNKNOWN: no action bound and no definitive
   * not_accepted/rejected resolution. These block new session writes. */
  unresolvedSessionIntents(sessionId: string): SessionIntentRow[] {
    return (this.stmt(`SELECT * FROM session_intents WHERE session_id=? AND action_id IS NULL AND state='pending'
      ORDER BY created_at_wall, key`).all(sessionId) as Record<string, unknown>[]).map(toSessionIntentRow);
  }

  findPendingSessionIntentByCanonical(sessionId: string, canonical: string): SessionIntentRow | undefined {
    const r = this.stmt(`SELECT * FROM session_intents WHERE session_id=? AND canonical_request=? AND action_id IS NULL
      ORDER BY created_at_wall LIMIT 1`).get(sessionId, canonical) as Record<string, unknown> | undefined;
    return r ? toSessionIntentRow(r) : undefined;
  }

  // -- durable device-cancel intents (N05) -----------------------------------

  /** Find the bound intent that owns a device action. */
  findIntentByAction(sessionId: string, actionId: string): SessionIntentRow | undefined {
    const r = this.stmt('SELECT * FROM session_intents WHERE session_id=? AND action_id=?')
      .get(sessionId, actionId) as Record<string, unknown> | undefined;
    return r ? toSessionIntentRow(r) : undefined;
  }

  /**
   * N05: record the cancel intent DURABLY before the attempt (state stays
   * 'requested' even if the process dies mid-POST, so recovery retries).
   * `reset` (an explicit user/supervisor cancel) restarts the bounded
   * attempt counter after exhaustion.
   */
  markIntentCancelRequested(sessionId: string, key: string, opts: {reset?: boolean} = {}): void {
    if (opts.reset) {
      this.stmt(`UPDATE session_intents SET cancel_state='requested', cancel_attempts=0, cancel_last_error=NULL
        WHERE session_id=? AND key=? AND cancel_state!='confirmed'`).run(sessionId, key);
    }
    this.stmt(`UPDATE session_intents SET cancel_state='requested',
      cancel_attempts=cancel_attempts+1, cancel_last_error=NULL WHERE session_id=? AND key=?`)
      .run(sessionId, key);
  }

  /**
   * N05: the cancel is confirmed — the Runtime accepted the POST, or the
   * action was already terminal (incl. already cancelled). Confirmed is the
   * idempotent end state: no further cancel POST for this action.
   */
  markIntentCancelConfirmed(sessionId: string, key: string): void {
    this.stmt(`UPDATE session_intents SET cancel_state='confirmed', cancel_last_error=NULL
      WHERE session_id=? AND key=?`).run(sessionId, key);
  }

  /** N05: the attempt failed; 'requested' stays, the error is visible. */
  markIntentCancelFailed(sessionId: string, key: string, error: string): void {
    this.stmt(`UPDATE session_intents SET cancel_state='requested', cancel_last_error=?
      WHERE session_id=? AND key=? AND cancel_state!='confirmed'`).run(error, sessionId, key);
  }

  /** N05: intents whose cancel still has to reach the device (restart + backoff retries). */
  intentsCancelRequested(sessionId: string): SessionIntentRow[] {
    return (this.stmt(`SELECT * FROM session_intents WHERE session_id=? AND action_id IS NOT NULL
      AND cancel_state='requested' ORDER BY created_at_wall, key`).all(sessionId) as Record<string, unknown>[])
      .map(toSessionIntentRow);
  }

  // -- memory checkpoints (generation CAS; compaction never deletes raw facts) -------------

  latestCheckpoint(sessionId: string): MemoryCheckpointRow | undefined {
    const r = this.stmt('SELECT * FROM memory_checkpoints WHERE session_id=? ORDER BY generation DESC LIMIT 1')
      .get(sessionId) as Record<string, unknown> | undefined;
    return r ? toCheckpointRow(r) : undefined;
  }

  /** Fails when a newer generation already exists (late summary must not cover newer goals). */
  insertCheckpoint(input: Omit<MemoryCheckpointRow, 'created_at_wall'>): MemoryCheckpointRow {
    return this.tx(() => {
      const r = this.stmt('SELECT generation FROM memory_checkpoints WHERE session_id=? ORDER BY generation DESC LIMIT 1')
        .get(input.session_id) as {generation: number} | undefined;
      const latest = Number(r?.generation ?? 0);
      if (input.generation <= latest) {
        throw new Error(`checkpoint generation ${input.generation} conflicts with existing ${latest}`);
      }
      const now = new Date().toISOString();
      this.stmt(`INSERT INTO memory_checkpoints (session_id, generation, covered_message_seq, goal_revision, summary,
        facts, open_questions, evidence_refs, versions, created_at_wall) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(input.session_id, input.generation, input.covered_message_seq, input.goal_revision, input.summary,
          JSON.stringify(input.facts), JSON.stringify(input.open_questions), JSON.stringify(input.evidence_refs),
          JSON.stringify(input.versions), now);
      return {...input, created_at_wall: now};
    });
  }
}

// -- row mappers -------------------------------------------------------------------

function createBudgetLimit(value: number | undefined | null, fallback: number, what: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 100000) {
    throw new Error(`invalid_budget: ${what} must be an integer between 0 and 100000`);
  }
  return value;
}

function createCanonical(goalText: string, goalSpec: Record<string, unknown>, maxActions: number,
  maxModelTurns: number): string {
  return canonicalJson({goal_text: goalText, goal_spec: {...goalSpec, request_id: undefined},
    budget: {max_actions: maxActions, max_model_turns: maxModelTurns}});
}

function toSessionRow(r: Record<string, unknown>): SessionRow {
  return {
    session_id: String(r.session_id), runtime_instance_id: String(r.runtime_instance_id),
    experiment_id: String(r.experiment_id), scenario_id: r.scenario_id ? String(r.scenario_id) : null,
    lifecycle: r.lifecycle === 'archived' ? 'archived' : 'active',
    archived_reason: r.archived_reason ? String(r.archived_reason) : null,
    backend: String(r.backend), owner_generation: Number(r.owner_generation),
    agent_paused: Number(r.agent_paused) === 1,
    loop_state: String(r.loop_state) as SessionRow['loop_state'],
    loop_state_detail: r.loop_state_detail ? String(r.loop_state_detail) : null,
    last_event_seq: Number(r.last_event_seq), last_message_seq: Number(r.last_message_seq),
    consumed_user_seq: Number(r.consumed_user_seq ?? 0),
    inbox_cursor: Number(r.inbox_cursor),
    handoff_pending: Number(r.handoff_pending ?? 0) === 1,
    model_state: r.model_state ? String(r.model_state) : null,
    created_at_wall: String(r.created_at_wall), updated_at_wall: String(r.updated_at_wall),
  };
}

function toMessageRow(r: Record<string, unknown>): MessageRow {
  return {
    message_id: String(r.message_id), session_id: String(r.session_id), seq: Number(r.seq),
    role: r.role as MessageRow['role'], content: String(r.content),
    request_id: r.request_id ? String(r.request_id) : null, task_id: r.task_id ? String(r.task_id) : null,
    meta: r.meta ? JSON.parse(String(r.meta)) as Record<string, unknown> : null,
    created_at_wall: String(r.created_at_wall),
  };
}

function toTaskRow(r: Record<string, unknown>): TaskRow {
  return {
    task_id: String(r.task_id), session_id: String(r.session_id), goal_text: String(r.goal_text),
    goal_spec: JSON.parse(String(r.goal_spec)) as Record<string, unknown>,
    goal_revision: Number(r.goal_revision), status: String(r.status) as TaskStatus,
    reason: r.reason ? String(r.reason) : null, queue_index: Number(r.queue_index),
    budget: JSON.parse(String(r.budget)) as TaskBudget,
    create_request_id: r.create_request_id ? String(r.create_request_id) : null,
    create_canonical: r.create_canonical ? String(r.create_canonical) : null,
    created_at_wall: String(r.created_at_wall), updated_at_wall: String(r.updated_at_wall),
  };
}

function toPlanStepRow(r: Record<string, unknown>): PlanStepRow {
  return {
    step_id: String(r.step_id), task_id: String(r.task_id), plan_revision: Number(r.plan_revision),
    index_in_plan: Number(r.index_in_plan), skill: String(r.skill),
    skill_version: r.skill_version ? String(r.skill_version) : null,
    inputs: r.inputs ? JSON.parse(String(r.inputs)) as Record<string, unknown> : null,
    postconditions: r.postconditions ? JSON.parse(String(r.postconditions)) as Record<string, unknown> : null,
    status: String(r.status) as PlanStepRow['status'],
    action_ids: JSON.parse(String(r.action_ids)) as string[],
    evidence_refs: JSON.parse(String(r.evidence_refs)) as string[],
    verification: r.verification ? JSON.parse(String(r.verification)) as PlanStepRow['verification'] : null,
    updated_at_wall: String(r.updated_at_wall),
  };
}

function toWakeRow(r: Record<string, unknown>): WakeRow {
  return {
    wake_id: String(r.wake_id), session_id: String(r.session_id), task_id: String(r.task_id),
    kind: String(r.kind) as WakeRow['kind'],
    predicate: r.predicate ? JSON.parse(String(r.predicate)) as Record<string, unknown> : null,
    target_sim_s: r.target_sim_s == null ? null : Number(r.target_sim_s),
    source_watermark: r.source_watermark == null ? null : Number(r.source_watermark),
    status: String(r.status) as WakeRow['status'], dedupe_key: r.dedupe_key ? String(r.dedupe_key) : null,
    goal_revision: r.goal_revision == null ? null : Number(r.goal_revision),
    step_id: r.step_id ? String(r.step_id) : null,
    created_at_wall: String(r.created_at_wall),
    fired_at_wall: r.fired_at_wall ? String(r.fired_at_wall) : null,
  };
}

function toSessionIntentRow(r: Record<string, unknown>): SessionIntentRow {
  return {
    session_id: String(r.session_id), task_id: String(r.task_id), key: String(r.key),
    capability: String(r.capability), canonical_request: String(r.canonical_request),
    action_id: r.action_id ? String(r.action_id) : null, goal_revision: Number(r.goal_revision),
    operation_id: r.operation_id ? String(r.operation_id) : null,
    budget_counted: Number(r.budget_counted ?? 0) === 1,
    state: (r.state ? String(r.state) : 'pending') as SessionIntentRow['state'],
    cancel_state: (r.cancel_state ? String(r.cancel_state) : 'none') as SessionIntentRow['cancel_state'],
    cancel_attempts: Number(r.cancel_attempts ?? 0),
    cancel_last_error: r.cancel_last_error ? String(r.cancel_last_error) : null,
    created_at_wall: String(r.created_at_wall),
  };
}

function toCheckpointRow(r: Record<string, unknown>): MemoryCheckpointRow {
  return {
    session_id: String(r.session_id), generation: Number(r.generation),
    covered_message_seq: Number(r.covered_message_seq), goal_revision: Number(r.goal_revision),
    summary: String(r.summary), facts: JSON.parse(String(r.facts ?? '[]')) as string[],
    open_questions: JSON.parse(String(r.open_questions ?? '[]')) as string[],
    evidence_refs: JSON.parse(String(r.evidence_refs ?? '[]')) as string[],
    versions: JSON.parse(String(r.versions ?? '{}')) as Record<string, unknown>,
    created_at_wall: String(r.created_at_wall),
  };
}
