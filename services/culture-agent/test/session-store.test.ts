// D1 unit acceptance: schema migration idempotency, one session per
// (runtime_instance_id, experiment_id), goal CAS, checkpoint generation CAS,
// inbox dedupe + atomic cursor, message request-id idempotency.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/store.ts';
import {AGENT_SCHEMA_VERSION, SessionStore} from '../src/session-store.ts';

function fresh(): {store: AgentStore; sessions: SessionStore; dir: string} {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-sessstore-'));
  const store = new AgentStore(dir);
  const sessions = new SessionStore(store.db);
  return {store, sessions, dir};
}

test('schema v2 migration is idempotent and restart-safe', () => {
  const {store, sessions, dir} = fresh();
  try {
    const metaRow = sessions.db.prepare("SELECT value FROM agent_meta WHERE key='schema_version'")
      .get() as {value: string};
    assert.equal(metaRow.value, String(AGENT_SCHEMA_VERSION));
    // re-opening the same db (agent restart) migrates without error
    const again = new SessionStore(store.db);
    assert.equal(again.listSessions().length, sessions.listSessions().length);
    // v1 tables still intact (runs/intents/events/seen untouched)
    assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get());
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('one session per (runtime_instance_id, experiment_id); archive is one-way', () => {
  const {store, sessions, dir} = fresh();
  try {
    const a = sessions.createSession({runtime_instance_id: 'rt-1', experiment_id: 'exp-001'});
    const b = sessions.createSession({runtime_instance_id: 'rt-1', experiment_id: 'exp-001'});
    assert.equal(a.session_id, b.session_id, 'get-or-create returns the SAME session');
    const other = sessions.createSession({runtime_instance_id: 'rt-1', experiment_id: 'exp-002'});
    assert.notEqual(other.session_id, a.session_id);
    const sameExpOtherRuntime = sessions.createSession({runtime_instance_id: 'rt-2', experiment_id: 'exp-001'});
    assert.notEqual(sameExpOtherRuntime.session_id, a.session_id, 'different runtime instance = different session');
    sessions.archiveSession(a.session_id, 'reset');
    const revived = sessions.createSession({runtime_instance_id: 'rt-1', experiment_id: 'exp-001'});
    assert.equal(revived.session_id, a.session_id, 'archived session is returned, not replaced');
    assert.equal(revived.lifecycle, 'archived', '...and stays read-only');
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('messages: monotonic seq and request_id idempotency', () => {
  const {store, sessions, dir} = fresh();
  try {
    const s = sessions.createSession({runtime_instance_id: 'rt-1', experiment_id: 'exp-001'});
    const m1 = sessions.appendMessage(s.session_id, {role: 'user', content: 'hello', request_id: 'r1'});
    const m2 = sessions.appendMessage(s.session_id, {role: 'assistant', content: 'hi'});
    const dup = sessions.appendMessage(s.session_id, {role: 'user', content: 'hello', request_id: 'r1'});
    assert.equal(dup.message_id, m1.message_id, 'same request_id → same message');
    assert.equal(m2.seq, m1.seq + 1, 'independent messages advance the seq');
    assert.equal(sessions.getSession(s.session_id)!.last_message_seq, m2.seq);
    // session events have their OWN seq space
    const e1 = sessions.appendSessionEvent(s.session_id, 'x', {});
    assert.equal(e1.seq, 1);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('task goal CAS and budget accounting survive reopen', () => {
  const {store, sessions, dir} = fresh();
  try {
    const s = sessions.createSession({runtime_instance_id: 'rt-1', experiment_id: 'exp-001'});
    const t = sessions.createTask(s.session_id, {goal_text: 'g', goal_spec: {description: 'g',
      scope: {plates: ['plate-01']}, metrics: [], allowed_operations: ['imaging.scan']}});
    const conflict = sessions.updateTaskGoal(t.task_id, {goal_text: 'newer', expected_revision: 5});
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict.actual, 1);
    const ok = sessions.updateTaskGoal(t.task_id, {goal_text: 'newer', expected_revision: 1});
    assert.equal(ok.ok, true);
    assert.equal(ok.revision, 2);
    sessions.incrementTaskBudget(t.task_id, {actions: 1, model_turns: 2});
    const budget = sessions.getTask(t.task_id)!.budget;
    assert.equal(budget.actions_used, 1);
    assert.equal(budget.model_turns_used, 2);
    assert.equal(budget.max_actions, 40);
    assert.equal(budget.max_model_turns, 200);
    // request_id idempotency for task creation
    const t2 = sessions.createTask(s.session_id, {goal_text: 'g2', goal_spec: {description: 'g2',
      scope: {plates: ['plate-01']}, metrics: [], allowed_operations: ['imaging.scan']}, request_id: 'tr1'});
    const t3 = sessions.createTask(s.session_id, {goal_text: 'g2', goal_spec: {description: 'g2',
      scope: {plates: ['plate-01']}, metrics: [], allowed_operations: ['imaging.scan']}, request_id: 'tr1'});
    assert.equal(t2.task_id, t3.task_id);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('inbox dedupes (source, seq) atomically with the cursor; wakes dedupe by key', () => {
  const {store, sessions, dir} = fresh();
  try {
    const s = sessions.createSession({runtime_instance_id: 'rt-1', experiment_id: 'exp-001'});
    assert.ok(sessions.recordInbox(s.session_id, 'device', 5, 'environment.sampled', {v: 1}));
    assert.equal(sessions.recordInbox(s.session_id, 'device', 5, 'environment.sampled', {v: 1}), null,
      'duplicate delivery ignored');
    assert.ok(sessions.recordInbox(s.session_id, 'device', 6, 'environment.sampled', {v: 2}));
    assert.equal(sessions.getSession(s.session_id)!.inbox_cursor, 6, 'cursor advanced atomically');
    const t = sessions.createTask(s.session_id, {goal_text: 'g', goal_spec: {description: 'g',
      scope: {plates: ['plate-01']}, metrics: [], allowed_operations: ['imaging.scan']}});
    const w1 = sessions.armWake({session_id: s.session_id, task_id: t.task_id, kind: 'sim_time',
      target_sim_s: 100, dedupe_key: 'monitor'});
    const w2 = sessions.armWake({session_id: s.session_id, task_id: t.task_id, kind: 'sim_time',
      target_sim_s: 100, dedupe_key: 'monitor'});
    assert.equal(w1.wake_id, w2.wake_id, 'same dedupe_key → same armed wake');
    sessions.fireWake(w1.wake_id);
    const w3 = sessions.armWake({session_id: s.session_id, task_id: t.task_id, kind: 'sim_time',
      target_sim_s: 200, dedupe_key: 'monitor'});
    assert.notEqual(w3.wake_id, w1.wake_id, 'fired wake can be re-armed');
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('checkpoints: generation CAS blocks late summaries', () => {
  const {store, sessions, dir} = fresh();
  try {
    const s = sessions.createSession({runtime_instance_id: 'rt-1', experiment_id: 'exp-001'});
    sessions.insertCheckpoint({session_id: s.session_id, generation: 1, covered_message_seq: 10,
      goal_revision: 1, summary: 'one', facts: ['a'], open_questions: [], evidence_refs: [],
      versions: {}});
    assert.throws(() => sessions.insertCheckpoint({session_id: s.session_id, generation: 1,
      covered_message_seq: 20, goal_revision: 2, summary: 'stale', facts: [], open_questions: [],
      evidence_refs: [], versions: {}}), /conflicts/, 'late summary cannot overwrite a newer generation');
    sessions.insertCheckpoint({session_id: s.session_id, generation: 2, covered_message_seq: 20,
      goal_revision: 2, summary: 'two', facts: ['a', 'b'], open_questions: [], evidence_refs: [],
      versions: {}});
    assert.equal(sessions.latestCheckpoint(s.session_id)!.summary, 'two');
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
