// Trial defect regression (scheduler guardrail): a model that keeps
// re-submitting a plan the server keeps refusing (invalid_plan) used to loop
// "refusal → 30 sim s retry wake → same plan again" FOREVER — the task sat in
// waiting_condition, burning model turns until the 200-turn budget backstop,
// and stop.max_corrections was parsed (goal.ts) but never enforced anywhere.
//
// Repro shape (internal trial J3/T2): a legitimate monitoring goal whose
// allowed_operations is ['imaging.scan'] only. The model stub publishes its
// standard three-step plan; step 1 (exchange_row_and_verify) needs a
// maintenance capability, so the WHOLE plan is refused with invalid_plan and
// the deterministic stub re-submits it every 30 sim s.
//
// The guardrail: after stop.max_corrections (default 3) CONSECUTIVE
// deterministic plan refusals, the task is parked as needs_input, its
// planning wakes are cancelled, and no further model turns run until a real
// user/supervisor message or a goal edit (both restart the streak).
//
// Real processes end to end: Runtime + Culture Agent + HTTP model stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceClient} from '@oscar/device-contract';
import {startModelStub} from './model-stub.ts';
import {AgentApiClient, spawnAgentProc, spawnRuntimeProc, sleep, waitFor} from './procs.ts';

interface TaskView {task_id: string; status: string; reason: string | null;
  budget: {model_turns_used: number; max_model_turns: number}}
interface StatusView {task: {status: string} | null; wakes_armed: number}

const goalSpec = {
  description: '监测 plate-01 A 排液位（仅允许扫描）',
  scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', value: 358, source: 'observation', row_id: 'A'}],
  // deliberately WITHOUT any maintenance capability: the model stub's standard
  // plan (step 1 exchange_row_and_verify) can never validate against it
  allowed_operations: ['imaging.scan'],
  monitoring: {interval_sim_s: 600},
  deadline_sim_s: 90_000,
  success: {description: 'window finished above threshold'},
  stop: {description: 'budget or cancel'},
};

test('plan-refusal guardrail: repeated invalid_plan submissions park the task as needs_input instead of looping forever', {timeout: 150_000}, async () => {
  const stub = await startModelStub();
  const {createServer} = await import('node:http');
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const agentPort = (probe.address() as {port: number}).port;
  probe.close();
  const runtime = await spawnRuntimeProc({clockMode: 'realtime', agentUrl: `http://127.0.0.1:${agentPort}`});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, port: agentPort,
    env: {OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stub.port}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
      OSCAR_MODEL_NAME: 'oscar-stub'}});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  try {
    // accelerated demo clock: the stub's 30 sim s retry wake must elapse in
    // milliseconds, not real 30 s intervals
    const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});

    const session = await api.post<{session: {session_id: string}}>('/sessions', {});
    const sessionId = session.session.session_id;
    const {task} = await api.post<{task: {task_id: string; status: string}}>(`/sessions/${sessionId}/tasks`,
      {goal_text: '照看 A 排（计划拒绝护栏回归）', goal_spec: goalSpec});
    const taskId = task.task_id;

    // 1. the loop is REAL: the deterministic stub gets its plan refused
    //    (invalid_plan: no maintenance capability in allowed_operations) and
    //    retries on a short sim wake — until the guardrail parks the task.
    const parked = await waitFor(async () => {
      const {task: t} = await api.get<{task: TaskView}>(`/tasks/${taskId}`);
      return t.status === 'needs_input' && (t.reason ?? '').includes('plan_refusal_limit') ? t : null;
    }, {timeoutMs: 60_000, label: 'task parked as needs_input after repeated plan refusals'});
    assert.ok(parked.reason && parked.reason.includes('invalid_plan'),
      `park reason names the refusals (got: ${parked.reason})`);

    // the refusal loop actually ran up to the bound (assistant messages), and
    // the burn stayed bounded — nowhere near the model-turn budget backstop
    const events = await api.get<{events: Array<{seq: number; type: string; payload: Record<string, unknown>}>}>(
      `/sessions/${sessionId}/events?format=json&limit=10000`);
    const refusalTexts = events.events.filter(e => e.type === 'message.appended'
      && String((e.payload as {message?: {content?: string}})?.message?.content ?? '').includes('REFUSED invalid_plan'));
    assert.ok(refusalTexts.length >= 3, `the plan was refused at least 3 times (got ${refusalTexts.length})`);
    assert.ok(events.events.some(e => e.type === 'task.status'
      && (e.payload as {reason?: string}).reason === 'plan_refusal_limit'),
    'a task.status event documents the guardrail trip');
    assert.ok(parked.budget.model_turns_used <= 8,
      `bounded burn: ${parked.budget.model_turns_used} model turns for ${refusalTexts.length} refusals (budget backstop is ${parked.budget.max_model_turns})`);

    // 2. the parking is TERMINAL for the autonomous loop: the retry wake is
    //    cancelled, so letting many wake intervals of sim time pass must not
    //    spend a single further model turn (speed 1200 → 2.5 wall s ≈ 3000
    //    sim s ≈ 100 of the stub's 30 sim s retry wakes).
    const turnsAtPark = parked.budget.model_turns_used;
    await sleep(2500);
    const after = (await api.get<{task: TaskView}>(`/tasks/${taskId}`)).task;
    assert.equal(after.status, 'needs_input', 'the parked task stays needs_input');
    assert.equal(after.budget.model_turns_used, turnsAtPark,
      `no further model turns while parked (${after.budget.model_turns_used} vs ${turnsAtPark} at park)`);
    const status = await api.get<StatusView>(`/sessions/${sessionId}/status`);
    assert.equal(status.wakes_armed, 0, 'the retry wake was cancelled with the park');
  } finally {
    await agent.stop();
    await runtime.stop();
    await stub.close();
  }
});
