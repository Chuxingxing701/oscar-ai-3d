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
  const required = {metric: 'temperature_c', op: 'below', value: 38,
    debounce_sim_s: 600, hysteresis: 0, cooldown_sim_s: 0};
  const goal = normalizeGoalSpec({description: 'temperature below 38 continuously for 600 simulated seconds',
    scope: {plates: ['plate-01']}, metrics: [], allowed_operations: ['imaging.scan'],
    monitoring: {conditions: [required]}});
  for (const shorten of [true, false]) {
  const c = context(goal);
  let registrationSim, verdict, verified, phase = 0;
  await operator.control(exp, {speed: 100});
  await operator.control(exp, {resume: true});
  start(c, async (_input, host) => {
    if (phase++ === 0) {
      const plan = await host.replacePlan([{skill: 'monitor_until', skill_version: '1',
        inputs: {condition: {metric: required.metric, op: required.op, value: required.value}}}]);
      assert.equal(plan.ok, true, JSON.stringify(plan));
      registrationSim = (await client.state(exp)).experiment.sim_time_s;
      const wake = host.armWake({kind: 'condition', predicate: {...required, debounce_sim_s: shorten ? 0 : 600},
        reason: shorten ? 'model shortens debounce while preserving the threshold' : 'positive control respects goal debounce', step_index: 0});
      if (wake.status !== 'armed') {
        verdict = {ok: false, code: 'wake_rejected'};
        return output(false);
      }
      return output(false);
    }
    verified = await host.updateStep(0, {status: 'done'});
    verdict = await host.completeGate([]);
    return output();
  });
  await waitFor(() => verdict !== undefined && c.store.sessionEventsAfter(c.session.session_id, 0, 1000)
    .filter(e => e.type === 'turn.completed').length >= (phase > 1 ? 2 : 1) ? true : null,
    {timeoutMs: 15000, label: 'shortened debounce must not complete the 600-second goal'});
  const now = (await client.state(exp)).experiment.sim_time_s;
  const task = c.store.getTask(c.task.task_id);
  record(shorten ? 'same_revision_shorter_debounce_cannot_complete_longer_goal' : 'full_debounce_positive_control',
    shorten ? !verdict.ok && task.status !== 'completed' : verdict.ok && task.status === 'completed' && now-registrationSim >= 600,
    {goal_condition: required, registration_sim_s: registrationSim, checked_at_sim_s: now,
      elapsed_sim_s: now-registrationSim, verification: verified, completion_gate: verdict,
      status: task.status, fired_wakes: c.store.firedWakes(c.session.session_id,c.task.task_id)},
    shorten ? {completion_gate_ok: false, status_not: 'completed', required_continuous_sim_s: 600}
      : {completion_gate_ok: true, status: 'completed', minimum_elapsed_sim_s: 600});
  await c.manager.stopAll();
  }
} finally {
  for (const c of contexts) {await c.manager?.stopAll(); c.agentStore.close(); rmSync(c.dir, {recursive:true,force:true});}
  await runtime.stop();
  writeFileSync(new URL('./long-lived-s03-review-reproductions.json',import.meta.url), JSON.stringify(results,null,2)+'\n');
}
assert.ok(results.every(r=>r.pass),'all independent checks must assert correct behavior');
