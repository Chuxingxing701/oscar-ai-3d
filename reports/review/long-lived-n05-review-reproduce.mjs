// Independent acceptance: correct behavior assertions only; isolated Runtime/store.
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
import {verifyGoalSatisfied} from '../../services/culture-agent/src/skills.ts';
import {spawnRuntimeProc, waitFor} from '../../services/culture-agent/test/procs.ts';

const gate = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const output = effects => ({ok: true, assistantText: 'ack', toolLog: [],
  usage: {requests: 1, inputTokens: 0, outputTokens: 0},
  effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null,
    goalUpdated: null, planUpdated: false, stopRequested: false, ...effects}});
const backend = fn => ({id: 'explicit-independent-n05-review', available: () => ({ok: true}),
  capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}),
  runTurn: fn, compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => {}});
const spec = normalizeGoalSpec({description: 'maintain row A', scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', row_id: 'A', value: 330}],
  allowed_operations: ['imaging.scan', 'plate.shake']});
const contexts = [], results = [];
const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken});
const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken});
const exp = await client.currentExperimentId(), health = await client.health();
await operator.control(exp, {speed: 1});
function context(goal = spec) {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-n05-review-'));
  const agentStore = new AgentStore(dir), store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: health.instance_id, experiment_id: exp});
  const task = store.createTask(session.session_id, {goal_text: goal.description, goal_spec: goal});
  const c = {dir, agentStore, store, session, task, spec: goal, manager: null}; contexts.push(c); return c;
}
function start(c, fn, fetchImpl = fetch) {
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, backend: backend(fn), fetchImpl, log: () => {}});
  return c.manager.ensureScheduler(c.store.getSession(c.session.session_id));
}
function record(name, pass, actual, expected) {
  const result = {name, pass, actual, expected}; results.push(result); console.log(JSON.stringify(result));
}
async function settle(id) {
  return waitFor(async () => {const a = await client.action(exp, id);
    return ['succeeded', 'failed', 'cancelled'].includes(a.status) ? a : null;}, {timeoutMs: 20000});
}
async function observationOf(id) {
  const hit = (await client.observations(exp)).find(o => o.action_id === id);
  assert.ok(hit); return client.observation(exp, hit.observation_id);
}
try {
  // A cancelled task still owns a live device action. If its GET fails,
  // the handoff must stay pending, not silently grant B the execution slot.
  {
    const c = context();
    const submitted = await client.submit(exp, {capability: 'plate.shake',
      arguments: {plate_id: 'plate-01', speed_rpm: 180, duration_sim_s: 120}});
    const id = submitted.action.action_id;
    c.store.insertSessionIntent({session_id: c.session.session_id, task_id: c.task.task_id,
      key: 'handoff-shake', capability: 'plate.shake', canonical: '{}', goal_revision: 1});
    c.store.accountIntent(c.session.session_id, 'handoff-shake', id);
    const next = c.store.createTask(c.session.session_id, {goal_text: 'next task', goal_spec: spec});
    let failReads = false, nextTurns = 0;
    const wrappedFetch = async (url, init) => {
      if (failReads && new URL(String(url)).pathname.endsWith(`/actions/${id}`)) {
        throw new TypeError('injected temporary action-status outage');
      }
      return fetch(url, init);
    };
    const scheduler = start(c, async input => {
      if (input.task?.task_id === next.task_id) nextTurns++;
      return output();
    }, wrappedFetch);
    await waitFor(() => c.store.getSession(c.session.session_id).loop_state !== 'recovering' ? true : null,
      {timeoutMs: 10000});
    failReads = true;
    await scheduler.cancelTask(c.task.task_id);
    const oldAction = await client.action(exp, id);
    const nextStatus = c.store.getTask(next.task_id).status;
    record('unknown_action_status_blocks_handoff', nextStatus === 'queued'
      && c.store.sessionHandoffPending(c.session.session_id),
      {next_status: nextStatus, old_device_action: oldAction.status,
        handoff_pending: c.store.sessionHandoffPending(c.session.session_id), next_turns: nextTurns,
        cancel_state: c.store.findIntentByAction(c.session.session_id, id).cancel_state},
      {next_status: 'queued', handoff_pending: true});
    failReads = false;
    await scheduler.cancelTask(c.task.task_id);
    await waitFor(() => c.store.getTask(next.task_id).status !== 'queued' ? true : null, {timeoutMs: 10000});
    assert.equal((await client.action(exp, id)).status, 'cancelled', 'recovery cancels the old action');
    await c.manager.stopAll();
  }
  // Park the decision-start state read. The task pause API writes exactly
  // this same store status. A ready->running transition must not erase it.
  {
    const c = context(), entered = gate(), release = gate();
    let readCount = 0, submitResult, modelCalls = 0;
    const delayedFetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      const hold = path.endsWith('/state') && ++readCount === 2;
      const response = await fetch(url, init);
      if (hold) {entered.resolve(); await release.promise;}
      return response;
    };
    start(c, async (_input, host) => {
      modelCalls++;
      if (!submitResult) submitResult = await host.submitWrite('imaging.scan',
        {plate_id: 'plate-01', wells: ['A1','A2','A3','A4','A5','A6'], mode: 'mono'}, {});
      return output();
    }, delayedFetch);
    await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('state gate not reached')), 10000).unref())]);
    c.store.updateTaskStatus(c.task.task_id, 'paused', 'operator');
    release.resolve();
    await waitFor(() => c.store.sessionEventsAfter(c.session.session_id, 0, 1000)
      .some(e => e.type === 'turn.completed') ? true : null, {timeoutMs: 10000});
    const intents = c.store.listSessionIntents(c.session.session_id);
    record('task_pause_during_initial_read_is_preserved', c.store.getTask(c.task.task_id).status === 'paused'
      && intents.length === 0,
      {task_status: c.store.getTask(c.task.task_id).status, model_calls: modelCalls,
        tool_ok: submitResult?.ok, intents: intents.map(i => ({action_id: i.action_id, capability: i.capability}))},
      {task_status: 'paused', device_writes: 0});
    for (const intent of intents) if (intent.action_id) await operator.cancel(exp, intent.action_id);
    await c.manager.stopAll();
  }
  // Monitoring-only task has no metric to fall back on: an empty plan has
  // no verified success evidence and cannot satisfy a future wait goal.
  {
    const goal = normalizeGoalSpec({description: 'monitor until sim 100000', scope: {plates: ['plate-01']},
      allowed_operations: ['imaging.scan'], metrics: [], monitoring: {interval_sim_s: 3600},
      deadline_sim_s: 100000, success: {description: 'monitor_until reaches sim 100000'}});
    const c = context(goal); let verdict;
    start(c, async (_input, host) => {
      verdict = await host.completeGate([]);
      return output({taskCompleted: {summary: 'claimed done without a plan', evidence_refs: []}});
    });
    await waitFor(() => c.store.sessionEventsAfter(c.session.session_id, 0, 1000)
      .some(e => e.type === 'turn.completed') ? true : null, {timeoutMs: 10000});
    record('monitor_without_verified_plan_cannot_complete', !verdict.ok
      && c.store.getTask(c.task.task_id).status !== 'completed',
      {complete_gate: verdict, task_status: c.store.getTask(c.task.task_id).status,
        steps: c.store.listPlanSteps(c.task.task_id).length,
        sim_time_s: (await client.state(exp)).experiment.sim_time_s},
      {complete_gate_ok: false, status_not: 'completed'});
    await c.manager.stopAll();
  }
  // Two current-revision, task-owned row observations jointly prove a
  // multi-row goal. A later B scan must not discard the still-valid A scan.
  {
    await operator.control(exp, {speed: 100});
    const goal = normalizeGoalSpec({...spec, scope: {plates: ['plate-01'], rows: ['A', 'B']},
      metrics: [{metric: 'medium_volume_ul', op: '>=', row_id: 'A', value: 100},
        {metric: 'medium_volume_ul', op: '>=', row_id: 'B', value: 100}]});
    const c = context(goal), generation = c.store.claimOwnership(c.session.session_id);
    const executor = new SessionExecutor({store: c.store, client, emit: () => {}, log: () => {}});
    const observations = [];
    for (const row of ['A', 'B']) {
      const r = await executor.submitWrite({session: c.session, task: c.task, spec: goal, generation,
        turnGoalRevision: 1, capability: 'imaging.scan',
        args: {plate_id: 'plate-01', wells: [1,2,3,4,5,6].map(n => `${row}${n}`), mode: 'mono'}});
      assert.equal(r.ok, true, JSON.stringify(r.error)); await settle(r.action.action_id);
      observations.push(await observationOf(r.action.action_id));
    }
    const check = refs => verifyGoalSatisfied({task_id: c.task.task_id, goal_revision: 1, spec: goal,
      observationRefs: refs, maintenanceActionIds: [],
      ownsAction: id => {const i = c.store.findIntentByAction(c.session.session_id, id);
        return i ? {task_id: i.task_id, goal_revision: i.goal_revision} : null;},
      readAction: id => client.action(exp, id), readObservation: id => client.observation(exp, id),
      readState: () => client.state(exp)});
    const verdict = await check(observations.map(o => o.observation_id));
    record('separate_row_observations_verify_multirow_goal', verdict.ok,
      {verdict, observations: observations.map(o => ({id: o.observation_id, wells: o.wells,
        sampled_at_sim_s: o.sampled_at_sim_s, plate_revision: o.plate_revision,
        min_estimate_ul: Math.min(...o.estimates.map(e => e.liquid_level_ul))}))},
      {ok: true});
    // Positive/control oracle: one full-plate scan satisfies the same goal.
    const full = await executor.submitWrite({session: c.session, task: c.task, spec: goal, generation,
      turnGoalRevision: 1, capability: 'imaging.scan',
      args: {plate_id: 'plate-01', wells: observations.flatMap(o => o.wells), mode: 'mono'}});
    assert.equal(full.ok, true, JSON.stringify(full.error)); await settle(full.action.action_id);
    const fullObs = await observationOf(full.action.action_id);
    assert.equal((await check([fullObs.observation_id])).ok, true, 'full target scan control must pass');
  }
} finally {
  for (const c of contexts) {await c.manager?.stopAll().catch(() => {});
    c.agentStore.close(); rmSync(c.dir, {recursive: true, force: true});}
  await runtime.stop();
  writeFileSync(new URL('./long-lived-n05-review-reproductions.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
}
assert.equal(results.filter(r => !r.pass).length, 0, 'independent correct-behavior assertions must all pass');
