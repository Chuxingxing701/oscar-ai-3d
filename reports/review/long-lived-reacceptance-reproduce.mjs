// Independent reacceptance: the process/data are isolated. Exit 0 requires
// correct behavior; failures are collected so every case can be inspected.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '../../packages/device-contract/src/client.ts';
import {AgentStore} from '../../services/culture-agent/src/store.ts';
import {SessionStore} from '../../services/culture-agent/src/session-store.ts';
import {SessionExecutor} from '../../services/culture-agent/src/executor.ts';
import {SessionManager} from '../../services/culture-agent/src/session-manager.ts';
import {PiAgentBackend} from '../../services/culture-agent/src/backend.ts';
import {normalizeGoalSpec} from '../../services/culture-agent/src/goal.ts';
import {spawnRuntimeProc, sleep, waitFor} from '../../services/culture-agent/test/procs.ts';

const results = [];
const contexts = [];
const gate = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const spec = normalizeGoalSpec({description: 'scan row A', scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', value: 330}], allowed_operations: ['imaging.scan']});
const output = () => ({ok: true, assistantText: 'ack', toolLog: [], usage: {requests: 1, inputTokens: 0, outputTokens: 0},
  effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null, goalUpdated: null,
    planUpdated: false, stopRequested: false}});
const backend = fn => ({id: 'explicit-review-backend', available: () => ({ok: true}),
  capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}), runTurn: fn,
  compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => {}});
const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken});
const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken});
const exp = await operator.currentExperimentId();
await operator.control(exp, {speed: 100});
const health = await client.health();
function context() {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-reaccept-'));
  const agentStore = new AgentStore(dir);
  const store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: health.instance_id, experiment_id: exp});
  const task = store.createTask(session.session_id, {goal_text: 'review scan', goal_spec: spec});
  const c = {dir, agentStore, store, session, task, manager: null}; contexts.push(c); return c;
}
function record(name, pass, actual, expected) {
  const row = {name, pass, actual, expected}; results.push(row); console.log(JSON.stringify(row));
}
const actions = async () => (await client.actions(exp)).actions.filter(a => a.principal.kind === 'service');
async function settle(action) {
  await waitFor(async () => {
    const a = await client.action(exp, action.action_id);
    return ['succeeded', 'failed', 'cancelled'].includes(a.status) ? a : null;
  }, {timeoutMs: 15000});
}
try {
  // Compaction may summarize, but must preserve operative user constraints
  // and already checkpointed facts independent of their wording.
  const pi = new PiAgentBackend({});
  const constraint = '储液限定为 media-01，作用范围限定为 B 排。';
  const compressed = pi.compact({history: [{role: 'user', content: constraint}], task: null,
    facts: [], evidenceRefs: []});
  record('compaction_preserves_non_marker_constraint', JSON.stringify(compressed).includes('media-01'),
    compressed, {retains: constraint});
  const oldFact = 'media-02 是本实验的保留对照液。';
  const nextCheckpoint = pi.compact({history: [{role: 'user', content: '继续监测'}], task: null,
    facts: [], evidenceRefs: [], previous: {summary: oldFact, facts: [oldFact], open_questions: []}});
  record('compaction_carries_previous_facts', JSON.stringify(nextCheckpoint).includes('media-02'),
    nextCheckpoint, {retains: oldFact});
  const baseline = await client.submit(exp, {capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'}});
  await settle(baseline.action);
  // Revoke AFTER the submit passes its initial checks, while the actual
  // Runtime state read is in progress. The Runtime submit remains real HTTP.
  for (const change of ['agent_pause', 'executor_close', 'task_cancel', 'task_pause', 'goal_edit', 'owner_change', 'archive']) {
    const c = context(); const generation = c.store.claimOwnership(c.session.session_id);
    const entered = gate(); const release = gate();
    const proxy = new Proxy(client, {get(target, prop) {
      if (prop === 'state') return async (...args) => {
        const snapshot = await target.state(...args); entered.resolve(); await release.promise; return snapshot;
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const executor = new SessionExecutor({store: c.store, client: proxy, emit: () => {}, log: () => {}});
    const before = (await actions()).length;
    const pending = executor.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
      args: {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'},
      turnGoalRevision: 1, generation});
    await entered.promise;
    if (change === 'agent_pause') c.store.updateSession(c.session.session_id, {agent_paused: true});
    if (change === 'executor_close') executor.close();
    if (change === 'task_cancel') c.store.updateTaskStatus(c.task.task_id, 'cancelled');
    if (change === 'task_pause') c.store.updateTaskStatus(c.task.task_id, 'paused');
    if (change === 'goal_edit') c.store.updateTaskGoal(c.task.task_id, {expected_revision: 1, goal_text: 'changed goal'});
    if (change === 'owner_change') c.store.claimOwnership(c.session.session_id);
    if (change === 'archive') c.store.archiveSession(c.session.session_id, 'review');
    release.resolve(); const r = await pending;
    const after = (await actions()).length;
    record(`revoke_during_state_read:${change}`, !r.ok && after === before,
      {ok: r.ok, error: r.error?.code, actions_added: after - before, action_id: r.action?.action_id},
      {ok: false, actions_added: 0});
    if (r.action) await settle(r.action);
  }
  // An accepted response is lost and by-key lookup remains unavailable.
  // The unresolved old operation must block another task from writing.
  {
    const c = context(); const generation = c.store.claimOwnership(c.session.session_id);
    let lost = true; let accepted;
    const proxy = new Proxy(client, {get(target, prop) {
      if (prop === 'actionByKey') return async () => {throw new Error('injected lookup unavailable');};
      if (prop === 'submit') return async (...args) => {
        const r = await target.submit(...args);
        if (lost) {lost = false; accepted = r.action; throw new Error('injected accepted response loss');}
        return r;
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const executor = new SessionExecutor({store: c.store, client: proxy, emit: () => {}, log: () => {}});
    const args = {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'};
    const first = await executor.submitWrite({session: c.session, task: c.task, spec,
      capability: 'imaging.scan', args, turnGoalRevision: 1, generation});
    assert.equal(first.ok, false); assert.ok(accepted); await settle(accepted);
    c.store.updateTaskStatus(c.task.task_id, 'cancelled');
    const task2 = c.store.createTask(c.session.session_id, {goal_text: 'next scan', goal_spec: spec});
    const before = (await actions()).length;
    const next = await executor.submitWrite({session: c.session, task: task2, spec,
      capability: 'imaging.scan', args, turnGoalRevision: 1, generation});
    const added = (await actions()).length - before;
    const pendingOld = c.store.pendingSessionIntents(c.session.session_id).filter(i => i.task_id === c.task.task_id).length;
    record('unresolved_previous_task_blocks_new_write', !next.ok && added === 0,
      {ok: next.ok, actions_added: added, unresolved_old_intents: pendingOld},
      {ok: false, actions_added: 0, reason: 'old accepted outcome cannot be reconciled'});
    if (next.action) await settle(next.action);
  }
  // The user supplies the missing parameters in a real scheduler turn.
  // No second message, clock sample or restart should be needed to execute.
  {
    const c = context(); let calls = 0; let submitted;
    c.store.updateTaskGoal(c.task.task_id, {goal_spec: {...spec, metrics: [], missing_parameters: ['target volume']}});
    c.store.updateTaskStatus(c.task.task_id, 'needs_input', 'target volume');
    c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
      getServiceToken: () => runtime.serviceToken, log: () => {}, backend: backend(async (input, host) => {
        calls++;
        if (calls === 1) {
          const r = host.updateTaskGoal({expected_revision: input.task.goal_revision, goal_spec: spec});
          assert.equal(r.ok, true);
        } else submitted = await host.submitWrite('imaging.scan',
          {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'}, {});
        return output();
      })});
    const scheduler = c.manager.ensureScheduler(c.store.getSession(c.session.session_id));
    await waitFor(() => c.store.getSession(c.session.session_id).loop_state !== 'recovering' ? true : null,
      {timeoutMs: 10000});
    await sleep(200); assert.equal(calls, 0);
    c.store.appendMessage(c.session.session_id, {role: 'user', content: 'target volume 330 µL'});
    scheduler.onUserMessage();
    await waitFor(() => c.store.sessionEventsAfter(c.session.session_id, 0, 1000)
      .some(e => e.type === 'turn.completed') ? true : null, {timeoutMs: 10000});
    await sleep(1500);
    const task = c.store.getTask(c.task.task_id);
    record('needs_input_parameters_complete_continues', calls >= 2 && !!submitted?.ok,
      {calls, status: task.status, submitted: submitted?.ok ?? false,
        armed_wakes: c.store.armedWakes(c.session.session_id).length},
      {follow_up_turn: true, submits_without_another_user_message: true});
    await c.manager.stopAll();
    if (submitted?.action) await settle(submitted.action);
  }
  // Two user messages while no task exists still require two conversation
  // turns. A queued message must not be discarded by the task-only path.
  {
    const c = context(); let calls = 0; let sawSecond = false;
    const entered = gate(); const release = gate();
    c.store.updateTaskStatus(c.task.task_id, 'cancelled');
    c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
      getServiceToken: () => runtime.serviceToken, log: () => {}, backend: backend(async input => {
        calls++; sawSecond ||= input.history.some(m => m.content === 'SECOND MESSAGE');
        if (calls === 1) {entered.resolve(); await release.promise;}
        return output();
      })});
    const scheduler = c.manager.ensureScheduler(c.store.getSession(c.session.session_id));
    await waitFor(() => c.store.getSession(c.session.session_id).loop_state !== 'recovering' ? true : null,
      {timeoutMs: 10000});
    await sleep(200);
    c.store.appendMessage(c.session.session_id, {role: 'user', content: 'FIRST MESSAGE'});
    scheduler.onUserMessage(); await entered.promise;
    c.store.appendMessage(c.session.session_id, {role: 'user', content: 'SECOND MESSAGE'});
    scheduler.onUserMessage(); await sleep(100); release.resolve();
    await sleep(1500);
    record('conversation_message_queued_during_turn_is_processed', sawSecond,
      {calls, second_message_seen_by_model: sawSecond, stored_user_messages:
        c.store.listMessages(c.session.session_id).filter(m => m.role === 'user').length},
      {second_message_seen_by_model: true});
    await c.manager.stopAll();
  }
} finally {
  for (const c of contexts) {
    if (c.manager) await c.manager.stopAll();
    c.agentStore.close(); rmSync(c.dir, {recursive: true, force: true});
  }
  await runtime.stop();
  writeFileSync(new URL('./long-lived-reacceptance-reproductions.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
}
assert.equal(results.filter(r => !r.pass).length, 0, 'independent reacceptance failures (details in JSON)');
