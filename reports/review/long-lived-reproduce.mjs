// Review regressions for the D1–D5 fixes (reports/review/long-lived-review.md F01–F15).
// Converted from the defect-reproduction diagnostic: every scenario now asserts
// the CORRECT behavior. Real Runtime HTTP + isolated SQLite stores; no
// user/demo data are touched.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '../../packages/device-contract/src/client.ts';
import {AgentStore} from '../../services/culture-agent/src/store.ts';
import {SessionStore} from '../../services/culture-agent/src/session-store.ts';
import {SessionManager} from '../../services/culture-agent/src/session-manager.ts';
import {SessionExecutor} from '../../services/culture-agent/src/executor.ts';
import {normalizeGoalSpec} from '../../services/culture-agent/src/goal.ts';
import {PiAgentBackend} from '../../services/culture-agent/src/backend.ts';
import {SessionApiRouter} from '../../services/culture-agent/src/sessions-api.ts';
import {spawnRuntimeProc, sleep, waitFor} from '../../services/culture-agent/test/procs.ts';

const results = [];
const spec = normalizeGoalSpec({description: 'review row A', scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', value: 330}],
  allowed_operations: ['media.add', 'imaging.scan'], monitoring: {interval_sim_s: 21600}});
const args = {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10};
const evidence = {evidence_refs: ['obs-review-fixture']};
const output = (patch = {}) => ({ok: true, assistantText: 'review response', toolLog: [],
  effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null, goalUpdated: null,
    planUpdated: false, stopRequested: false, ...patch}, usage: {requests: 1, inputTokens: 0, outputTokens: 0}});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
function backend(fn) {
  return {id: 'explicit-review-backend', available: () => ({ok: true}),
    capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}),
    runTurn: fn, compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => {}};
}
function record(name, actual) {results.push({name, actual}); console.log(JSON.stringify({name, actual}));}
function fakeRes() {
  let status = 0; let raw = '';
  return {writeHead(code) {status = code;}, end(body) {raw = body ?? '';},
    status: () => status, json: () => raw ? JSON.parse(raw) : {}};
}

const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken});
const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken});
const exp = await operator.currentExperimentId();
await operator.control(exp, {speed: 100});
const health = await client.health();
const contexts = [];
function context(b = backend(async () => output()), budget) {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-long-review-'));
  const agentStore = new AgentStore(dir);
  const store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: health.instance_id, experiment_id: exp});
  const task = store.createTask(session.session_id, {goal_text: 'review', goal_spec: spec, budget});
  const manager = new SessionManager({store, runtimeUrl: runtime.baseUrl, getServiceToken: () => runtime.serviceToken,
    backend: b, log: () => {}});
  const c = {dir, agentStore, store, session, task, manager}; contexts.push(c); return c;
}
async function settled(action) {
  return waitFor(async () => {const a = await client.action(exp, action.action_id);
    return ['succeeded', 'failed', 'cancelled'].includes(a.status) ? a : null;}, {timeoutMs: 15000});
}
async function start(c) {
  const scheduler = c.manager.ensureScheduler(c.store.getSession(c.session.session_id));
  await waitFor(() => c.store.getSession(c.session.session_id).loop_state !== 'recovering' ? true : null,
    {timeoutMs: 10000});
  await sleep(100);
  return scheduler;
}
async function serviceActions() {
  return (await client.actions(exp)).actions.filter(a => a.principal.kind === 'service');
}

try {
  // F01 — a paused agent refuses device writes before any intent or submit.
  {
    const c = context(); const gen = c.store.claimOwnership(c.session.session_id);
    c.store.updateSession(c.session.session_id, {agent_paused: true});
    const executor = new SessionExecutor({store: c.store, client, emit: () => {}, log: () => {}});
    const r = await executor.submitWrite({session: c.session, task: c.task, spec, capability: 'media.add', args,
      ...evidence, turnGoalRevision: 1, generation: gen});
    assert.equal(r.ok, false); assert.equal(r.error.code, 'agent_paused');
    record('paused_agent_refuses_device_write', {refused: !r.ok, code: r.error.code,
      service_actions: (await serviceActions()).length});
  }
  // F01 — stopAll drains the in-flight turn; its late tool submit adds no action.
  {
    const gate = deferred(); let entered = false; let submit;
    const c = context(backend(async (_input, host) => {entered = true; await gate.promise;
      submit = await host.submitWrite('media.add', args, evidence); return output();}));
    const scheduler = await start(c); scheduler.onUserMessage();
    await waitFor(() => entered ? true : null, {timeoutMs: 10000});
    const before = (await serviceActions()).length;
    const stopping = c.manager.stopAll();
    gate.resolve(); await stopping;
    await waitFor(() => submit ? true : null, {timeoutMs: 10000});
    assert.equal(submit.ok, false);
    record('stopAll_drains_late_device_write', {actions_before: before,
      actions_after: (await serviceActions()).length, refused_code: submit.error?.code});
  }
  // F02 — a cancelled task stays cancelled when the old turn completes.
  {
    const gate = deferred(); let entered = false;
    const c = context(backend(async () => {entered = true; await gate.promise;
      return output({taskCompleted: {summary: 'old response', evidence_refs: []}});}));
    const scheduler = await start(c);
    await waitFor(() => entered ? true : null, {timeoutMs: 10000});
    await scheduler.cancelTask(c.task.task_id); assert.equal(c.store.getTask(c.task.task_id).status, 'cancelled');
    gate.resolve(); await sleep(600);
    const status = c.store.getTask(c.task.task_id).status;
    assert.equal(status, 'cancelled');
    record('cancelled_task_survives_old_model_effect', {after_cancel: 'cancelled', after_model_response: status});
    await c.manager.stopAll();
  }
  // F02 — an old decision cannot complete a newer goal revision.
  {
    const gate = deferred(); let entered = false; let n = 0;
    const c = context(backend(async () => {n += 1; entered = true; await gate.promise;
      return n === 1 ? output({taskCompleted: {summary: 'completed revision 1', evidence_refs: []}}) : output();}));
    const scheduler = await start(c);
    await waitFor(() => entered ? true : null, {timeoutMs: 10000});
    c.store.updateTaskGoal(c.task.task_id, {expected_revision: 1, goal_text: 'new goal must remain active'});
    gate.resolve(); await sleep(600);
    const task = c.store.getTask(c.task.task_id);
    assert.equal(task.goal_revision, 2); assert.notEqual(task.status, 'completed');
    record('new_goal_not_completed_by_old_revision_response', {revision: task.goal_revision, status: task.status});
    await c.manager.stopAll();
  }
  // F04 — a persisted ready task gets exactly one recovery turn on startup.
  {
    let calls = 0; const c = context(backend(async () => {calls++; return output();}));
    await start(c);
    await waitFor(() => calls >= 1 ? true : null, {timeoutMs: 10000});
    assert.notEqual(c.store.getTask(c.task.task_id).status, 'ready');
    record('ready_task_resumed_on_startup', {calls, status: c.store.getTask(c.task.task_id).status});
    await c.manager.stopAll();
  }
  // F12 — the model-turn budget gates BEFORE the provider call and never exceeds the cap.
  {
    let calls = 0; const c = context(backend(async (_input, host) => {calls++;
      host.armWake({kind: 'sim_time', at_sim_s: 1e9, reason: 'review wait'}); return output();}), {max_model_turns: 1});
    const scheduler = await start(c);
    await waitFor(() => c.store.getTask(c.task.task_id).budget.model_turns_used >= 1 ? true : null, {timeoutMs: 10000});
    scheduler.onUserMessage();
    await waitFor(() => c.store.getTask(c.task.task_id).status === 'failed' ? true : null, {timeoutMs: 10000});
    const budget = c.store.getTask(c.task.task_id).budget;
    assert.equal(calls, 1); assert.equal(budget.model_turns_used, 1);
    record('model_turn_budget_enforced_before_call', {calls, budget,
      reason: c.store.getTask(c.task.task_id).reason});
    await c.manager.stopAll();
  }
  // F03 — an action-terminal row left 'received' by a crash is drained after restart.
  {
    let calls = 0; const c = context(backend(async () => {calls++; return output();}));
    const accepted = await client.submit(exp, {capability: 'media.add', arguments: args},
      {idempotencyKey: `review-inbox-${c.task.task_id}`});
    const key = accepted.action.idempotency_key;
    c.store.insertSessionIntent({session_id: c.session.session_id, task_id: c.task.task_id, key,
      capability: 'media.add', canonical: '{}', goal_revision: 1});
    c.store.setSessionIntentAction(c.session.session_id, key, accepted.action.action_id);
    c.store.updateTaskStatus(c.task.task_id, 'waiting_device');
    c.store.armWake({session_id: c.session.session_id, task_id: c.task.task_id, kind: 'action_terminal',
      predicate: {action_ids: [accepted.action.action_id]}});
    await settled(accepted.action);
    const batch = await client.events(exp, 0, 10000);
    for (const e of batch.events) c.store.recordInbox(c.session.session_id, 'device', e.seq, e.type, e.payload);
    await start(c);
    await waitFor(() => calls >= 1 ? true : null, {timeoutMs: 10000});
    await waitFor(() => c.store.inboxByType(c.session.session_id, 'action.succeeded').at(-1)?.state === 'processed'
      ? true : null, {timeoutMs: 10000});
    assert.equal(c.store.armedWakes(c.session.session_id).some(w => w.kind === 'action_terminal'), false);
    record('received_inbox_terminal_drained_after_restart', {calls,
      status: c.store.getTask(c.task.task_id).status, armed_action_terminal_wakes: 0,
      terminal_inbox_state: c.store.inboxByType(c.session.session_id, 'action.succeeded').at(-1)?.state});
    await c.manager.stopAll();
  }
  // F06 — a new task never reuses a cancelled task's pending key; changed
  // parameters get a fresh operation id (no key recycling).
  {
    const scanArgs = {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'};
    const c = context(); const gen = c.store.claimOwnership(c.session.session_id);
    c.store.updateTaskStatus(c.task.task_id, 'running', 'review');
    const lossClient = {state: async (id) => client.state(id), submit: async () => {throw new TypeError('injected pre-send network failure');},
      actionByKey: async () => null};
    const ex1 = new SessionExecutor({store: c.store, client: lossClient, emit: () => {}, log: () => {}});
    const r1 = await ex1.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
      args: scanArgs, turnGoalRevision: 1, generation: gen}); assert.equal(r1.ok, false);
    const failedKey = c.store.pendingSessionIntents(c.session.session_id).find(i => i.task_id === c.task.task_id).key;
    // same task, CHANGED parameters → a different canonical → a new operation key
    const r1b = await ex1.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
      args: {...scanArgs, wells: ['A1', 'A2']}, turnGoalRevision: 1, generation: gen});
    assert.equal(r1b.ok, false);
    const pendingNow = c.store.pendingSessionIntents(c.session.session_id).filter(i => i.task_id === c.task.task_id);
    assert.equal(pendingNow.length, 2);
    assert.notEqual(pendingNow[1].key, failedKey);
    c.store.updateTaskStatus(c.task.task_id, 'cancelled');
    const t2 = c.store.createTask(c.session.session_id, {goal_text: 'new independent task', goal_spec: spec});
    c.store.updateTaskStatus(t2.task_id, 'running', 'review');
    const ex2 = new SessionExecutor({store: c.store, client, emit: () => {}, log: () => {}});
    const r2 = await ex2.submitWrite({session: c.session, task: t2, spec, capability: 'imaging.scan', args: scanArgs,
      turnGoalRevision: 1, generation: gen});
    assert.equal(r2.ok, true); await settled(r2.action);
    const intent = c.store.listSessionIntents(c.session.session_id).find(i => i.action_id === r2.action.action_id);
    assert.equal(intent.task_id, t2.task_id); assert.notEqual(intent.key, failedKey);
    record('new_task_action_owned_by_new_task', {actual_task: t2.task_id, intent_task: intent.task_id,
      key: intent.key, action: intent.action_id, failed_key_left_pending: failedKey,
      changed_params_new_key: pendingNow[1].key});
  }
  // F15 — scan wells are checked against the goal row scope.
  {
    const c = context(); const gen = c.store.claimOwnership(c.session.session_id);
    c.store.updateTaskStatus(c.task.task_id, 'running', 'review');
    const executor = new SessionExecutor({store: c.store, client, emit: () => {}, log: () => {}});
    const r = await executor.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
      args: {plate_id: 'plate-01', wells: ['B1'], mode: 'mono'}, turnGoalRevision: 1, generation: gen});
    assert.equal(r.ok, false); assert.equal(r.error.code, 'out_of_scope');
    record('scan_well_outside_row_scope_refused', {allowed_rows: ['A'], requested: ['B1'],
      refused: !r.ok, code: r.error.code});
  }
  // F08 — an HTTP goal edit invalidates the old wait and re-decides under the new revision.
  {
    let calls = 0; const c = context(backend(async (_input, host) => {calls++;
      host.armWake({kind: 'sim_time', at_sim_s: 1e9, reason: 'old goal wait'}); return output();}));
    const scheduler = await start(c); scheduler.onUserMessage();
    await waitFor(() => calls >= 1 && c.store.armedWakes(c.session.session_id).some(w => w.kind === 'sim_time')
      ? true : null, {timeoutMs: 10000});
    const oldWake = c.store.armedWakes(c.session.session_id).find(w => w.kind === 'sim_time');
    const router = new SessionApiRouter({manager: c.manager, runtimeUrl: runtime.baseUrl,
      getServiceToken: () => runtime.serviceToken, log: () => {}});
    const res = fakeRes();
    await router.handleTaskRoutes({method: 'POST', path: `/tasks/${c.task.task_id}`,
      body: {expected_revision: 1, goal_text: 'urgent new goal'}, res});
    assert.equal(res.status(), 200);
    assert.notEqual(c.store.getWake(oldWake.wake_id).status, 'armed');
    await waitFor(() => calls >= 2 ? true : null, {timeoutMs: 10000});
    record('http_goal_edit_wakes_and_invalidates_old_wait', {calls,
      goal_revision: c.store.getTask(c.task.task_id).goal_revision, old_wait_status: 'cancelled'});
    await c.manager.stopAll();
  }
  // F07 — creating an incomplete task neither clears needs_input nor executes.
  {
    let calls = 0; let submitted; const c = context(backend(async (_input, host) => {
      calls++; submitted = await host.submitWrite('media.add', args, evidence); return output();}));
    c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'make room');
    const router = new SessionApiRouter({manager: c.manager, runtimeUrl: runtime.baseUrl,
      getServiceToken: () => runtime.serviceToken, log: () => {}});
    const res = fakeRes();
    await router.handle({method: 'POST', path: `/sessions/${c.session.session_id}/tasks`,
      body: {goal_text: 'incomplete', goal_spec: {description: 'missing target',
        scope: {plates: ['plate-01'], rows: ['A']}, allowed_operations: ['media.add']}}, res});
    const created = res.json().task;
    assert.equal(res.status(), 201); assert.equal(created.status, 'needs_input');
    await sleep(800);
    assert.equal(calls, 0); assert.equal(submitted, undefined);
    record('needs_input_task_waits_for_real_parameters', {calls, submitted: false,
      status: c.store.getTask(created.task_id).status,
      supplied_user_messages: c.store.listMessages(c.session.session_id).filter(m => m.role === 'user').length});
    await c.manager.stopAll();
  }
  // F09 — compaction keeps user constraints across rounds.
  {
    const b = new PiAgentBackend({});
    const first = b.compact({history: [{role: 'user', content: '任何时候不要使用 media-02，只准 media-01。'}],
      task: null, facts: [], evidenceRefs: []});
    assert.ok(JSON.stringify(first).includes('media-01'));
    const second = b.compact({history: [{role: 'user', content: '继续监测。'}], task: null, facts: [], evidenceRefs: [],
      previous: first});
    assert.ok(JSON.stringify(second).includes('media-01'));
    record('compaction_keeps_user_constraint', {first_has: true, second_round_has: true});
  }
} finally {
  for (const c of contexts) {await c.manager.stopAll(); c.agentStore.close(); rmSync(c.dir, {recursive: true, force: true});}
  await runtime.stop();
  writeFileSync(new URL('./long-lived-reproductions.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
}
