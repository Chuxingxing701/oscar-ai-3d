// Long-lived culture session persistence (design §4.2). Schema v2 lives in
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

export const AGENT_SCHEMA_VERSION = 2;

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
  inbox_cursor INTEGER NOT NULL DEFAULT 0,         -- device event seq consumed
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
  status TEXT NOT NULL,                            -- draft|ready|running|waiting_device|waiting_condition|needs_input|paused|completed|failed|cancelled
  reason TEXT,
  queue_index INTEGER NOT NULL DEFAULT 0,
  budget TEXT NOT NULL,
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

export type TaskStatus = 'draft' | 'ready' | 'running' | 'waiting_device' | 'waiting_condition'
  | 'needs_input' | 'paused' | 'completed' | 'failed' | 'cancelled';
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
  inbox_cursor: number;
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
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  action_ids: string[];
  evidence_refs: string[];
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
  created_at_wall: string;
  fired_at_wall: string | null;
}

export interface SessionIntentRow {
  session_id: string;
  task_id: string;
  key: string;
  capability: string;
  canonical_request: string;
  action_id: string | null;
  goal_revision: number;
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
    const current = this.db.prepare("SELECT value FROM agent_meta WHERE key='schema_version'")
      .get() as {value: string} | undefined;
    const version = Number(current?.value ?? 0);
    if (version > AGENT_SCHEMA_VERSION) {
      throw new Error(`agent store schema v${version} is newer than this build (v${AGENT_SCHEMA_VERSION}); upgrade the Agent first`);
    }
    // v1 (runs/intents/events/seen) needs no transformation; v2 adds the
    // session tables above. Re-running the DDL is idempotent.
    this.db.prepare("INSERT INTO agent_meta (key, value) VALUES ('schema_version', ?) "
      + "ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(AGENT_SCHEMA_VERSION));
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

  // -- tasks ----------------------------------------------------------------------

  createTask(sessionId: string, input: {goal_text: string; goal_spec: Record<string, unknown>;
    budget?: Partial<TaskBudget>; request_id?: string | null}): TaskRow {
    return this.tx(() => {
      if (input.request_id) {
        const hit = this.stmt('SELECT task_id FROM tasks WHERE session_id=? AND json_extract(goal_spec, "$.request_id")=?')
          .get(sessionId, input.request_id) as {task_id: string} | undefined;
        if (hit) return this.getTask(hit.task_id)!;
      }
      const now = new Date().toISOString();
      const taskId = `task-${randomUUID().slice(0, 12)}`;
      const queue = (this.stmt('SELECT COALESCE(MAX(queue_index), 0) AS q FROM tasks WHERE session_id=?')
        .get(sessionId) as {q: number}).q + 1;
      const budget: TaskBudget = {max_actions: input.budget?.max_actions ?? 40,
        actions_used: 0, max_model_turns: input.budget?.max_model_turns ?? 200, model_turns_used: 0};
      const spec = input.request_id ? {...input.goal_spec, request_id: input.request_id} : input.goal_spec;
      this.stmt(`INSERT INTO tasks (task_id, session_id, goal_text, goal_spec, goal_revision, status, queue_index,
        budget, created_at_wall, updated_at_wall) VALUES (?,?,?,?,1,'ready',?,?,?,?)`)
        .run(taskId, sessionId, input.goal_text, JSON.stringify(spec), queue, JSON.stringify(budget), now, now);
      return this.getTask(taskId)!;
    });
  }

  getTask(taskId: string): TaskRow | undefined {
    const r = this.stmt('SELECT * FROM tasks WHERE task_id=?').get(taskId) as Record<string, unknown> | undefined;
    return r ? toTaskRow(r) : undefined;
  }

  listTasks(sessionId: string): TaskRow[] {
    return (this.stmt('SELECT * FROM tasks WHERE session_id=? ORDER BY queue_index ASC').all(sessionId) as Record<string, unknown>[])
      .map(toTaskRow);
  }

  activeTask(sessionId: string): TaskRow | undefined {
    // one active task per session; others queue (design §4.1)
    const r = this.stmt(`SELECT * FROM tasks WHERE session_id=? AND status IN
      ('draft','ready','running','waiting_device','waiting_condition','needs_input') ORDER BY queue_index ASC LIMIT 1`)
      .get(sessionId) as Record<string, unknown> | undefined;
    return r ? toTaskRow(r) : undefined;
  }

  updateTaskStatus(taskId: string, status: TaskStatus, reason?: string | null): void {
    this.stmt('UPDATE tasks SET status=?, reason=?, updated_at_wall=? WHERE task_id=?')
      .run(status, reason ?? null, new Date().toISOString(), taskId);
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

  /** Count a recovered-by-key intent against its task budget exactly once. */
  incrementTaskBudgetByIntent(sessionId: string, key: string): void {
    const intent = this.stmt('SELECT task_id FROM session_intents WHERE session_id=? AND key=?')
      .get(sessionId, key) as {task_id: string} | undefined;
    if (intent) this.incrementTaskBudget(intent.task_id, {actions: 1});
  }

  // -- plan steps -----------------------------------------------------------------

  replacePlan(taskId: string, planRevision: number, steps: Array<{skill: string; skill_version?: string;
    inputs?: Record<string, unknown> | null}>): PlanStepRow[] {
    return this.tx(() => {
      this.stmt('DELETE FROM plan_steps WHERE task_id=?').run(taskId);
      const now = new Date().toISOString();
      const rows: PlanStepRow[] = steps.map((s, i) => {
        const stepId = `step-${randomUUID().slice(0, 10)}`;
        this.stmt(`INSERT INTO plan_steps (step_id, task_id, plan_revision, index_in_plan, skill, skill_version,
          inputs, status, action_ids, evidence_refs, updated_at_wall) VALUES (?,?,?,?,?,?,?, 'pending', '[]', '[]', ?)`)
          .run(stepId, taskId, planRevision, i, s.skill, s.skill_version ?? null,
            s.inputs ? JSON.stringify(s.inputs) : null, now);
        return {step_id: stepId, task_id: taskId, plan_revision: planRevision, index_in_plan: i, skill: s.skill,
          skill_version: s.skill_version ?? null, inputs: s.inputs ?? null, status: 'pending' as const,
          action_ids: [], evidence_refs: [], updated_at_wall: now};
      });
      return rows;
    });
  }

  listPlanSteps(taskId: string): PlanStepRow[] {
    return (this.stmt('SELECT * FROM plan_steps WHERE task_id=? ORDER BY index_in_plan ASC').all(taskId) as Record<string, unknown>[])
      .map(toPlanStepRow);
  }

  updatePlanStep(stepId: string, fields: Partial<Pick<PlanStepRow, 'status' | 'action_ids' | 'evidence_refs'>>): void {
    const current = this.stmt('SELECT * FROM plan_steps WHERE step_id=?').get(stepId) as Record<string, unknown> | undefined;
    if (!current) throw new Error(`no plan step ${stepId}`);
    this.stmt('UPDATE plan_steps SET status=?, action_ids=?, evidence_refs=?, updated_at_wall=? WHERE step_id=?')
      .run(fields.status ?? String(current.status),
        JSON.stringify(fields.action_ids ?? JSON.parse(String(current.action_ids))),
        JSON.stringify(fields.evidence_refs ?? JSON.parse(String(current.evidence_refs))),
        new Date().toISOString(), stepId);
  }

  // -- wakes ------------------------------------------------------------------------

  armWake(input: {session_id: string; task_id: string; kind: WakeRow['kind'];
    predicate?: Record<string, unknown> | null; target_sim_s?: number | null; source_watermark?: number | null;
    dedupe_key?: string | null}): WakeRow {
    return this.tx(() => {
      if (input.dedupe_key) {
        const hit = this.stmt("SELECT * FROM wakes WHERE session_id=? AND dedupe_key=? AND status='armed'")
          .get(input.session_id, input.dedupe_key) as Record<string, unknown> | undefined;
        if (hit) return toWakeRow(hit);
      }
      const id = `wake-${randomUUID().slice(0, 10)}`;
      const now = new Date().toISOString();
      this.stmt(`INSERT INTO wakes (wake_id, session_id, task_id, kind, predicate, target_sim_s, source_watermark,
        status, dedupe_key, created_at_wall) VALUES (?,?,?,?,?,?,?,'armed',?,?)`)
        .run(id, input.session_id, input.task_id, input.kind,
          input.predicate ? JSON.stringify(input.predicate) : null, input.target_sim_s ?? null,
          input.source_watermark ?? null, input.dedupe_key ?? null, now);
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

  markInboxProcessed(sessionId: string, source: string, seq: number, state: 'processed' | 'dropped'): void {
    this.stmt('UPDATE inbox SET state=? WHERE session_id=? AND source=? AND source_seq=?').run(state, sessionId, source, seq);
  }

  setInboxCursor(sessionId: string, seq: number): void {
    this.stmt('UPDATE sessions SET inbox_cursor=?, updated_at_wall=? WHERE session_id=?')
      .run(seq, new Date().toISOString(), sessionId);
  }

  // -- session intents (persisted BEFORE submit; recovery by idempotency key) -------------

  insertSessionIntent(input: {session_id: string; task_id: string; key: string; capability: string;
    canonical: string; goal_revision: number}): void {
    this.stmt(`INSERT OR IGNORE INTO session_intents (session_id, task_id, key, capability, canonical_request,
      action_id, goal_revision, created_at_wall) VALUES (?,?,?,?,?,NULL,?,?)`)
      .run(input.session_id, input.task_id, input.key, input.capability, input.canonical, input.goal_revision,
        new Date().toISOString());
  }

  setSessionIntentAction(sessionId: string, key: string, actionId: string): void {
    this.stmt('UPDATE session_intents SET action_id=? WHERE session_id=? AND key=?').run(actionId, sessionId, key);
  }

  listSessionIntents(sessionId: string): SessionIntentRow[] {
    return (this.stmt('SELECT * FROM session_intents WHERE session_id=? ORDER BY created_at_wall, key')
      .all(sessionId) as Record<string, unknown>[]).map(toSessionIntentRow);
  }

  pendingSessionIntents(sessionId: string): SessionIntentRow[] {
    return (this.stmt('SELECT * FROM session_intents WHERE session_id=? AND action_id IS NULL ORDER BY created_at_wall, key')
      .all(sessionId) as Record<string, unknown>[]).map(toSessionIntentRow);
  }

  findPendingSessionIntentByCanonical(sessionId: string, canonical: string): SessionIntentRow | undefined {
    const r = this.stmt(`SELECT * FROM session_intents WHERE session_id=? AND canonical_request=? AND action_id IS NULL
      ORDER BY created_at_wall LIMIT 1`).get(sessionId, canonical) as Record<string, unknown> | undefined;
    return r ? toSessionIntentRow(r) : undefined;
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
    inbox_cursor: Number(r.inbox_cursor), model_state: r.model_state ? String(r.model_state) : null,
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
    created_at_wall: String(r.created_at_wall), updated_at_wall: String(r.updated_at_wall),
  };
}

function toPlanStepRow(r: Record<string, unknown>): PlanStepRow {
  return {
    step_id: String(r.step_id), task_id: String(r.task_id), plan_revision: Number(r.plan_revision),
    index_in_plan: Number(r.index_in_plan), skill: String(r.skill),
    skill_version: r.skill_version ? String(r.skill_version) : null,
    inputs: r.inputs ? JSON.parse(String(r.inputs)) as Record<string, unknown> : null,
    status: String(r.status) as PlanStepRow['status'],
    action_ids: JSON.parse(String(r.action_ids)) as string[],
    evidence_refs: JSON.parse(String(r.evidence_refs)) as string[],
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
    created_at_wall: String(r.created_at_wall),
    fired_at_wall: r.fired_at_wall ? String(r.fired_at_wall) : null,
  };
}

function toSessionIntentRow(r: Record<string, unknown>): SessionIntentRow {
  return {
    session_id: String(r.session_id), task_id: String(r.task_id), key: String(r.key),
    capability: String(r.capability), canonical_request: String(r.canonical_request),
    action_id: r.action_id ? String(r.action_id) : null, goal_revision: Number(r.goal_revision),
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
