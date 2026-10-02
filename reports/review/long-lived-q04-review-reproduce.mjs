// Correct-behavior assertions; actual scheduler ToolHost and isolated Runtime.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '../../packages/device-contract/src/client.ts';
import {AgentStore} from '../../services/culture-agent/src/store.ts';
import {SessionStore} from '../../services/culture-agent/src/session-store.ts';
import {SessionManager} from '../../services/culture-agent/src/session-manager.ts';
import {normalizeGoalSpec, GoalSpecError} from '../../services/culture-agent/src/goal.ts';
import {spawnRuntimeProc, waitFor} from '../../services/culture-agent/test/procs.ts';

const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken});
const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken});
const exp = await client.currentExperimentId(), health = await client.health();
const contexts = [], results = [];
const output = (completed = true) => ({ok: true, assistantText: 'ack', toolLog: [],
  usage: {requests: 1, inputTokens: 0, outputTokens: 0},
  effects: {wakes: [], taskCompleted: completed ? {summary: 'claimed complete', evidence_refs: []} : null,
    taskFailed: null, inputRequested: null, goalUpdated: null, planUpdated: false, stopRequested: false}});
function context(goal) {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-q04-review-'));
  const agentStore = new AgentStore(dir), store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: health.instance_id, experiment_id: exp});
  const task = store.createTask(session.session_id, {goal_text: goal.description, goal_spec: goal});
  const c = {dir, agentStore, store, session, task, manager: null}; contexts.push(c); return c;
}
function start(c, fn) {
  const backend = {id: 'explicit-independent-q04-review', available: () => ({ok: true}),
    capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}), runTurn: fn,
    compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => {}};
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, backend, log: () => {}});
  return c.manager.ensureScheduler(c.store.getSession(c.session.session_id));
}
function record(name, pass, actual, expected) {
  const row = {name, pass, actual, expected}; results.push(row); console.log(JSON.stringify(row));
}
async function finished(c) {
  await waitFor(() => c.store.sessionEventsAfter(c.session.session_id, 0, 1000)
    .some(e => e.type === 'turn.completed') ? true : null, {timeoutMs: 10000});
}
try {
  // A real Runtime environment sample should fire an r1 wake. If the raw
  // contract is not consumed, record that failure FIRST, then normalize only
  // the SAME authoritative sample as a component-test control so the
  // independent revision proof is not masked by the adapter failure.
  // No wake or verification row is fabricated. The model then updates the goal via
  // the production host tool to r2, requesting a 600-s debounce. The r1
  // evidence cannot satisfy a new-revision wait (N03/current-revision rule).
  {
    const condition = {metric: 'temperature_c', op: 'below', value: 38,
      debounce_sim_s: 0, hysteresis: 0, cooldown_sim_s: 0};
    const goal = normalizeGoalSpec({description: 'wait for temperature <38', scope: {plates: ['plate-01']},
      metrics: [], allowed_operations: ['imaging.scan'], monitoring: {conditions: [condition]}});
    const state = await client.state(exp);
    assert.ok(state.chamber.temperature_c.observed < 38, 'r1 predicate actually holds');
    const c = context(goal);
    let verification, before, after, update, phase = 0, goalEditSim, registrationSeq = null;
    await operator.control(exp, {speed: 100});
    await operator.control(exp, {resume: true});
    const scheduler = start(c, async (_input, host) => {
      if (phase === 0) {
        phase = 1;
        const plan = await host.replacePlan([{skill: 'monitor_until', skill_version: '1',
          inputs: {condition: {metric: condition.metric, op: condition.op, value: condition.value}}}]);
        assert.equal(plan.ok, true, JSON.stringify(plan));
        const wake = host.armWake({kind: 'condition', predicate: condition,
          reason: 'real r1 condition evidence', step_index: 0});
        assert.equal(wake.status, 'armed');
        registrationSeq = c.store.getSession(c.session.session_id).inbox_cursor;
        return output(false);
      }
      verification = await host.updateStep(0, {status: 'done'});
      assert.equal(verification.ok, true, JSON.stringify(verification));
      before = await host.completeGate([]);
      assert.equal(before.ok, true, 'valid r1 monitor evidence must complete r1');
      goalEditSim = (await client.state(exp)).experiment.sim_time_s;
      update = host.updateTaskGoal({expected_revision: 1, goal_text: 'wait again, now debounce 600 sim seconds',
        goal_spec: normalizeGoalSpec({...goal,
          monitoring: {conditions: [{...condition, debounce_sim_s: 600}]}})});
      assert.equal(update.ok, true);
      after = await host.completeGate([]);
      return output();
    });
    await waitFor(() => c.store.firedWakes(c.session.session_id, c.task.task_id).length > 0
      || (registrationSeq !== null && c.store.inboxByType(c.session.session_id, 'environment.sampled')
        .filter(s => s.source_seq > registrationSeq && s.state === 'processed').length >= 3) ? true : null,
      {timeoutMs: 10000, label: 'three actual environment samples or a fired condition'});
    const allSamples = c.store.inboxByType(c.session.session_id, 'environment.sampled');
    const samples = allSamples.filter(s => s.source_seq > registrationSeq);
    const latestSample = JSON.parse((samples.at(-1) ?? allSamples.at(-1)).payload).sample;
    assert.ok(latestSample.temperature_c < condition.value, 'the real sample satisfies the registered predicate');
    const firedNaturally = c.store.firedWakes(c.session.session_id, c.task.task_id).length > 0;
    record('actual_environment_contract_fires_threshold_wake', firedNaturally,
      {samples_processed: samples.filter(s => s.state === 'processed').length,
        sample: latestSample, predicate: condition,
        fired_wakes: c.store.firedWakes(c.session.session_id, c.task.task_id).length},
      {fired_wakes_at_least: 1});
    if (!firedNaturally) {
      // Component control: the evaluator already supports flat readings;
      // normalize payload.sample to those readings without changing any
      // reading, predicate, Runtime fact, or product implementation.
      scheduler.evaluateConditions(latestSample.sampled_at_sim_s, latestSample);
    }
    await waitFor(() => after !== undefined
      && c.store.sessionEventsAfter(c.session.session_id, 0, 1000)
        .filter(e => e.type === 'turn.completed').length >= 2 ? true : null,
      {timeoutMs: 15000, label: 'verified condition followed by revised-goal completion attempt'});
    const task = c.store.getTask(c.task.task_id), plan = c.store.listPlanSteps(c.task.task_id);
    record('old_revision_monitor_evidence_cannot_complete_new_goal', !after.ok && task.status !== 'completed',
      {before_gate_ok: before.ok, after_gate: after, task_status: task.status,
        normalized_sample_control_needed: !firedNaturally,
        goal_revision: task.goal_revision, plan_revision: plan[0].plan_revision,
        verification_pass: plan[0].verification.pass,
        fired_wake_revisions: c.store.firedWakes(c.session.session_id, c.task.task_id).map(w => w.goal_revision),
        goal_edited_at_sim_s: goalEditSim,
        sim_time_s: (await client.state(exp)).experiment.sim_time_s},
      {after_gate_ok: false, status_not: 'completed', required_evidence_revision: 2});
    await c.manager.stopAll();
  }
  // Keep the plate valid; row Z in the documented GoalSpec is nonexistent.
  // Input validation currently accepts Z. Either validation must reject
  // it, or completion must be goal_unverified; zero checks cannot be success.
  {
    let goal;
    const rawGoal = {description: 'row Z >=1000 µL', scope: {plates: ['plate-01'], rows: ['Z']},
      metrics: [{metric: 'medium_volume_ul', op: '>=', value: 1000, row_id: 'Z'}],
      allowed_operations: ['imaging.scan']};
    try {goal = normalizeGoalSpec(rawGoal);} catch (e) {
      assert.ok(e instanceof GoalSpecError, 'only a deliberate invalid-goal rejection is correct');
      record('nonexistent_metric_row_cannot_complete_with_zero_checks', true,
        {invalid_goal_rejected: true, problems: e.problems}, {invalid_goal_rejected: true});
    }
    if (goal) {
      const c = context(goal); let verdict;
      start(c, async (_input, host) => {verdict = await host.completeGate([]); return output();});
      await finished(c);
      record('nonexistent_metric_row_cannot_complete_with_zero_checks', !verdict.ok
        && c.store.getTask(c.task.task_id).status !== 'completed',
        {complete_gate: verdict, task_status: c.store.getTask(c.task.task_id).status,
          actual_rows: (await client.state(exp)).plates.find(p => p.plate_id === 'plate-01').rows,
          target_row: 'Z'},
        {complete_gate_ok: false, status_not: 'completed'});
      await c.manager.stopAll();
    }
  }
} finally {
  for (const c of contexts) {await c.manager?.stopAll().catch(() => {});
    c.agentStore.close(); rmSync(c.dir, {recursive: true, force: true});}
  await runtime.stop();
  writeFileSync(new URL('./long-lived-q04-review-reproductions.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
}
assert.equal(results.filter(r => !r.pass).length, 0, 'independent correct-behavior assertions must all pass');
