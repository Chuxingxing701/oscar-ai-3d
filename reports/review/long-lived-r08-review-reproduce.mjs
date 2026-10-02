// Further independent acceptance. Real Runtime HTTP, isolated SQLite/data.
// Every assertion expects correct behavior; exit 0 requires every case pass.
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
import {SKILLS} from '../../services/culture-agent/src/skills.ts';
import {spawnRuntimeProc, waitFor, sleep} from '../../services/culture-agent/test/procs.ts';

const results = [], contexts = [];
const gate = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const output = effects => ({ok: true, assistantText: 'ack', toolLog: [],
  usage: {requests: 1, inputTokens: 0, outputTokens: 0},
  effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null,
    goalUpdated: null, planUpdated: false, stopRequested: false, ...effects}});
const backend = fn => ({id: 'explicit-independent-review-backend', available: () => ({ok: true}),
  capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}), runTurn: fn,
  compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => {}});
const baseSpec = normalizeGoalSpec({description: 'maintain A', scope: {plates: ['plate-01'], rows: ['A', 'B']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', row_id: 'A', value: 330}],
  allowed_operations: ['imaging.scan', 'media.add', 'plate.shake']});
const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken});
const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken});
const exp = await operator.currentExperimentId(); await operator.control(exp, {speed: 100});
const health = await client.health();
function context(spec = baseSpec) {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-r08-review-'));
  const agentStore = new AgentStore(dir), store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: health.instance_id, experiment_id: exp});
  const task = store.createTask(session.session_id, {goal_text: spec.description, goal_spec: spec});
  const c = {dir, agentStore, store, session, task, spec, manager: null}; contexts.push(c); return c;
}
function record(name, pass, actual, expected) {
  const row = {name, pass, actual, expected}; results.push(row); console.log(JSON.stringify(row));
}
function manager(c, fn, fetchImpl = fetch) {
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, backend: backend(fn), fetchImpl, log: () => {}});
  return c.manager.ensureScheduler(c.store.getSession(c.session.session_id));
}
async function settle(id) {
  return waitFor(async () => {const a = await client.action(exp, id);
    return ['succeeded', 'failed', 'cancelled'].includes(a.status) ? a : null;}, {timeoutMs: 15000});
}
async function observationOf(id) {
  const listed = await client.observations(exp);
  const hit = listed.find(o => o.action_id === id);
  assert.ok(hit, `observation for ${id}`); return client.observation(exp, hit.observation_id);
}
try {
  // The FIFO admission decision has to honor an EXISTING queue even in the
  // legitimate terminal -> asynchronous promotion gap.
  {
    const c = context(); const b = c.store.createTask(c.session.session_id, {goal_text: 'B', goal_spec: baseSpec});
    c.store.updateTaskStatus(c.task.task_id, 'completed');
    const newer = c.store.createTask(c.session.session_id, {goal_text: 'C', goal_spec: baseSpec});
    record('fifo_new_arrival_during_promotion_gap', newer.status === 'queued',
      {older_task_status: c.store.getTask(b.task_id).status, newer_task_status: newer.status,
        current_task: c.store.activeTask(c.session.session_id)?.goal_text},
      {newer_task_status: 'queued', next_task: 'B'});
  }
  // Async plan validation must re-check the turn before replacing a NEWER
  // goal's plan. Device state comes from the real Runtime through fetch.
  {
    const c = context(), entered = gate(), release = gate(); let hold = false, result;
    const delayedFetch = async (url, init) => {
      const shouldHold = hold && new URL(String(url)).pathname.endsWith('/state');
      if (shouldHold) hold = false;
      const response = await fetch(url, init);
      if (shouldHold) {entered.resolve(); await release.promise;}
      return response;
    };
    manager(c, async (_input, host) => {
      if (!result) {hold = true; result = await host.replacePlan([
        {skill: 'monitor_until', skill_version: '1', inputs: {until_sim_s: 1000}}]);}
      return output();
    }, delayedFetch);
    await entered.promise;
    c.store.updateTaskGoal(c.task.task_id, {expected_revision: 1, goal_text: 'new goal'});
    c.store.replacePlan(c.task.task_id, 2,
      [{skill: 'monitor_until', skill_version: '1', inputs: {until_sim_s: 2000}}]);
    release.resolve(); await waitFor(() => result ?? null, {timeoutMs: 10000});
    const plan = c.store.listPlanSteps(c.task.task_id);
    record('late_plan_validation_preserves_new_goal_plan', !result.ok && plan[0].plan_revision === 2,
      {tool_ok: result.ok, live_goal_revision: c.store.getTask(c.task.task_id).goal_revision,
        plan_revision: plan[0].plan_revision, until_sim_s: plan[0].inputs.until_sim_s},
      {tool_ok: false, plan_revision: 2, until_sim_s: 2000});
    await c.manager.stopAll();
  }
  // Async postcondition verification cannot commit a step after goal edit.
  {
    const c = context(), entered = gate(), release = gate(); let hold = false, result;
    c.store.replacePlan(c.task.task_id, 1,
      [{skill: 'monitor_until', skill_version: '1', inputs: {until_sim_s: 0}}]);
    const wake = c.store.armWake({session_id: c.session.session_id, task_id: c.task.task_id,
      kind: 'sim_time', target_sim_s: 0, predicate: null}); c.store.fireWake(wake.wake_id);
    const delayedFetch = async (url, init) => {
      const shouldHold = hold && new URL(String(url)).pathname.endsWith('/state');
      if (shouldHold) hold = false;
      const response = await fetch(url, init);
      if (shouldHold) {entered.resolve(); await release.promise;}
      return response;
    };
    manager(c, async (_input, host) => {
      if (!result) {hold = true; result = await host.updateStep(0, {status: 'done'});}
      return output();
    }, delayedFetch);
    await entered.promise; c.store.updateTaskGoal(c.task.task_id, {expected_revision: 1, goal_text: 'new deadline'});
    release.resolve(); await waitFor(() => result ?? null, {timeoutMs: 10000});
    const step = c.store.listPlanSteps(c.task.task_id)[0];
    record('late_step_verification_after_goal_edit_is_refused', !result.ok && step.status === 'pending',
      {tool_ok: result.ok, step_status: step.status, verification_pass: step.verification?.pass,
        goal_revision: c.store.getTask(c.task.task_id).goal_revision, plan_revision: step.plan_revision},
      {tool_ok: false, step_status: 'pending'});
    await c.manager.stopAll();
  }
  // A plan whose mandatory maintenance verification failed must not produce
  // a successful task while the real plate remains below its goal.
  {
    const spec = normalizeGoalSpec({...baseSpec, description: 'A >= 1500 µL',
      metrics: [{metric: 'medium_volume_ul', op: '>=', row_id: 'A', value: 1500}]});
    const c = context(spec); let gateResult, verification;
    const generation = c.store.claimOwnership(c.session.session_id);
    const executor = new SessionExecutor({store: c.store, client, emit: () => {}, log: () => {}});
    const write = async (capability, args, refs = []) => {
      const r = await executor.submitWrite({session: c.session, task: c.task, spec: c.spec, capability,
        args, evidence_refs: refs, generation, turnGoalRevision: 1}); assert.equal(r.ok, true, JSON.stringify(r.error));
      await settle(r.action.action_id); return r.action;
    };
    const scanArgs = {plate_id: 'plate-01', wells: ['A1','A2','A3','A4','A5','A6'], mode: 'mono'};
    const beforeScan = await write('imaging.scan', scanArgs);
    const beforeObs = await observationOf(beforeScan.action_id);
    const addA = await write('media.add', {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01',
      volume_ul_per_well: 10}, [beforeObs.observation_id]);
    const afterScan = await write('imaging.scan', scanArgs);
    const afterObs = await observationOf(afterScan.action_id);
    c.store.replacePlan(c.task.task_id, 1, [{skill: 'exchange_row_and_verify',
      skill_version: '1', inputs: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01'}}]);
    manager(c, async (_input, host) => {
      if (!verification) verification = await host.updateStep(0, {status: 'done',
        action_ids: [addA.action_id], evidence_refs: [afterObs.observation_id]});
      gateResult = host.planGate();
      return output({taskCompleted: {summary: 'claimed complete', evidence_refs: []}});});
    await waitFor(() => c.store.sessionEventsAfter(c.session.session_id, 0, 1000)
      .some(e => e.type === 'turn.completed') ? true : null, {timeoutMs: 10000});
    const status = c.store.getTask(c.task.task_id).status;
    const snap = await client.state(exp);
    const levels = snap.plates.find(p => p.plate_id === 'plate-01').wells.filter(w => w.well_id.startsWith('A'));
    record('failed_verification_does_not_complete_unmet_goal', status !== 'completed',
      {status, gate_ok: gateResult.ok, verification_code: verification.code,
        step_status: c.store.listPlanSteps(c.task.task_id)[0].status,
        min_actual_volume_ul: Math.min(...levels.map(w => w.volume_ul)), target_ul: 1500},
      {status_not: 'completed', gate_ok: false});
    await c.manager.stopAll();
  }
  // A fired temperature<38 condition is not proof of temperature>45. The
  // real chamber is near 37, and the required condition has never fired.
  {
    const c = context();
    const fired = c.store.armWake({session_id: c.session.session_id, task_id: c.task.task_id,
      kind: 'condition', predicate: {metric: 'temperature_c', op: 'below', value: 38}, target_sim_s: null});
    c.store.fireWake(fired.wake_id);
    const outcome = await SKILLS.find(s => s.skill === 'monitor_until').verify({
      task_id: c.task.task_id, goal_revision: 1, spec: c.spec,
      step: {index: 0, skill: 'monitor_until', skill_version: '1',
        inputs: {condition: {metric: 'temperature_c', op: 'above', value: 45}}},
      action_ids: [], evidence_refs: [], firedWakes: c.store.firedWakes(c.session.session_id, c.task.task_id),
      ownsAction: () => null, readAction: id => client.action(exp, id),
      readObservation: id => client.observation(exp, id), readState: () => client.state(exp),
    });
    record('different_monitor_condition_cannot_verify_required_condition', !outcome.ok,
      {verification_ok: outcome.ok, fired_condition: fired.predicate,
        required_condition: {metric: 'temperature_c', op: 'above', value: 45}}, {verification_ok: false});
  }
  // A successful maintenance of B is not evidence of maintenance of A,
  // even if a fresh A observation already satisfies the threshold.
  {
    const c = context(), generation = c.store.claimOwnership(c.session.session_id);
    const executor = new SessionExecutor({store: c.store, client, emit: () => {}, log: () => {}});
    const write = async (capability, args, refs = []) => {
      const r = await executor.submitWrite({session: c.session, task: c.task, spec: c.spec, capability,
        args, evidence_refs: refs, generation, turnGoalRevision: 1}); assert.equal(r.ok, true, JSON.stringify(r.error));
      await settle(r.action.action_id); return r.action;
    };
    const scanB = await write('imaging.scan', {plate_id: 'plate-01', wells: ['B1','B2','B3','B4','B5','B6'], mode: 'mono'});
    const obsB = await observationOf(scanB.action_id);
    const addB = await write('media.add', {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01',
      volume_ul_per_well: 10}, [obsB.observation_id]);
    const scanA = await write('imaging.scan', {plate_id: 'plate-01', wells: ['A1','A2','A3','A4','A5','A6'], mode: 'mono'});
    const obsA = await observationOf(scanA.action_id);
    const outcome = await SKILLS.find(s => s.skill === 'exchange_row_and_verify').verify({
      task_id: c.task.task_id, goal_revision: 1, spec: c.spec,
      step: {index: 0, skill: 'exchange_row_and_verify', skill_version: '1',
        inputs: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01'}},
      action_ids: [addB.action_id], evidence_refs: [obsA.observation_id], firedWakes: [],
      ownsAction: id => {const i = c.store.listSessionIntents(c.session.session_id).find(i => i.action_id === id);
        return i ? {task_id: i.task_id, goal_revision: i.goal_revision} : null;},
      readAction: id => client.action(exp, id), readObservation: id => client.observation(exp, id),
      readState: () => client.state(exp),
    });
    record('wrong_row_maintenance_cannot_verify_requested_row', !outcome.ok,
      {verification_ok: outcome.ok, maintenance_row: addB.arguments.row_id,
        requested_row: 'A', observation_id: obsA.observation_id}, {verification_ok: false});
  }
  // A transient action read error must not permanently disable cancellation
  // retries; a second explicit cancel still has to reach the device.
  {
    await operator.control(exp, {speed: 1});
    const c = context(); let failRead = false, cancelPosts = 0;
    const action = (await client.submit(exp, {capability: 'plate.shake',
      arguments: {plate_id: 'plate-01', speed_rpm: 180, duration_sim_s: 120}})).action;
    c.store.insertSessionIntent({session_id: c.session.session_id, task_id: c.task.task_id,
      key: 'review-shake', capability: 'plate.shake', canonical: '{}', goal_revision: 1});
    c.store.accountIntent(c.session.session_id, 'review-shake', action.action_id);
    const injectedFetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/actions/${action.action_id}/cancel`)) cancelPosts++;
      if (failRead && path.endsWith(`/actions/${action.action_id}`)) {
        failRead = false; throw new Error('injected transient action query error');
      }
      return fetch(url, init);
    };
    const scheduler = manager(c, async () => output(), injectedFetch);
    await waitFor(() => c.store.getSession(c.session.session_id).loop_state !== 'recovering' ? true : null,
      {timeoutMs: 10000}); await sleep(100);
    failRead = true; await scheduler.cancelTask(c.task.task_id);
    await scheduler.cancelTask(c.task.task_id); // lookup recovers, explicit retry
    const live = await client.action(exp, action.action_id);
    record('cancel_query_failure_does_not_suppress_retry', cancelPosts > 0,
      {task_status: c.store.getTask(c.task.task_id).status, device_action_status: live.status, cancel_posts: cancelPosts},
      {cancel_posts_at_least: 1});
    await operator.cancel(exp, action.action_id); await c.manager.stopAll();
  }
} finally {
  for (const c of contexts) {if (c.manager) await c.manager.stopAll(); c.agentStore.close();
    rmSync(c.dir, {recursive: true, force: true});}
  await runtime.stop();
  writeFileSync(new URL('./long-lived-r08-review-reproductions.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
}
assert.equal(results.filter(r => !r.pass).length, 0, 'independent acceptance failures (see JSON)');
