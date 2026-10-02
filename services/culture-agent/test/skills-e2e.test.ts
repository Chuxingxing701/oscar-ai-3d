// R08 end-to-end acceptance over REAL processes: Runtime + Culture Agent HTTP
// + the model stub on the OpenAI wire (never a scripted run path). Covers:
//   1. the normal chain: scan_and_assess → exchange_row_and_verify VERIFIED
//      done → monitor_until verified → complete_task;
//   2. a real media.exchange chain (fraction refresh verified against the
//      goal target) via a scenario-specific stub policy on the same wire;
//   3. the recheck-below-target failure branch: first maintenance under-doses
//      → verification fails with verify_below_target + recommended next skill
//      → second maintenance → verified done;
//   4. wrong evidence: an old (pre-maintenance) observation and a foreign
//      (other plate) observation are REFUSED for done;
//   5. cancel mid-step: the task is cancelled while maintenance is in flight;
//   6. restart continuation: SIGKILL the agent mid-plan, restart on the same
//      data dir, the plan resumes from persisted step state without redoing
//      the completed step.
// Model stub ≠ real LLM: the decisions are a deterministic fixture policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceClient} from '@oscar/device-contract';
import {startModelStub, type ModelStubHandle} from './model-stub.ts';
import {AgentApiClient, spawnAgentProc, spawnRuntimeProc, sleep, waitFor,
  type AgentProc, type RuntimeProc} from './procs.ts';

interface StepView {index: number; skill: string; status: string; action_ids: string[]; evidence_refs: string[]}
interface TaskView {task_id: string; status: string; reason: string | null; plan: StepView[]}
interface EventView {seq: number; type: string; payload: Record<string, unknown>}

interface Stack {
  runtime: RuntimeProc;
  agent: AgentProc;
  stub: ModelStubHandle;
  api: AgentApiClient;
  operator: DeviceClient;
  experimentId: string;
  sessionId: string;
  taskId: string;
  stop(): Promise<void>;
}

/** Phase 1: real processes + stub, before any task exists. */
async function prepareStack(opts: {stubPerturb?: NonNullable<Parameters<typeof startModelStub>[0]>['perturb'];
  decide?: NonNullable<Parameters<typeof startModelStub>[0]>['decide']} = {}):
  Promise<Omit<Stack, 'sessionId' | 'taskId'>> {
  const stub = await startModelStub({perturb: opts.stubPerturb, decide: opts.decide});
  const runtime = await spawnRuntimeProc({clockMode: 'realtime', scenario: 'routine_maintenance'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl,
    env: {OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stub.port}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
      OSCAR_MODEL_NAME: 'oscar-stub', OSCAR_MODEL_PROVIDER: 'oscar-stub'}});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  const experimentId = await operator.currentExperimentId();
  await operator.control(experimentId, {speed: 1200});
  return {runtime, agent, stub, api, operator, experimentId,
    async stop() {
      await agent.stop().catch(() => undefined);
      await runtime.stop().catch(() => undefined);
      await stub.close();
    }};
}

/** Phase 2: create the session + task on a prepared stack. */
async function createTaskOn(base: Omit<Stack, 'sessionId' | 'taskId'>, goalValue: number,
  opts: {allowed?: string[]; deadline?: number} = {}): Promise<Stack> {
  const operator = base.operator;
  const goal = {
    description: `keep plate-01 row A >= ${goalValue} µL; verify after maintenance`,
    scope: {plates: ['plate-01'], rows: ['A']},
    metrics: [{metric: 'medium_volume_ul', op: '>=', value: goalValue, source: 'observation', row_id: 'A'}],
    allowed_operations: opts.allowed ?? ['imaging.scan', 'media.add'],
    monitoring: {interval_sim_s: 600},
    deadline_sim_s: opts.deadline ?? 1_800,
    success: {description: 'window finished at/above threshold'},
    stop: {description: 'budget or cancel', max_corrections: 8},
  };
  const created = await base.api.post<{session: {session_id: string}}>('/sessions', {});
  const made = await base.api.post<{task: {task_id: string; status: string}}>(
    `/sessions/${created.session.session_id}/tasks`,
    {goal_text: `照看 plate-01 A 排（≥ ${goalValue} µL，复查后记录）`, goal_spec: goal});
  void operator;
  return {...base, sessionId: created.session.session_id, taskId: made.task.task_id};
}

async function startStack(goalValue: number, opts: {allowed?: string[]; deadline?: number;
  stubPerturb?: NonNullable<Parameters<typeof startModelStub>[0]>['perturb'];
  decide?: NonNullable<Parameters<typeof startModelStub>[0]>['decide']} = {}): Promise<Stack> {
  const base = await prepareStack(opts);
  return createTaskOn(base, goalValue, opts);
}

async function taskOf(stack: Stack): Promise<TaskView> {
  return (await stack.api.get<{task: TaskView}>(`/tasks/${stack.taskId}`)).task;
}

async function eventsOf(stack: Stack): Promise<EventView[]> {
  const r = await stack.api.get<{events: EventView[]}>(`/sessions/${stack.sessionId}/events?format=json&limit=10000`);
  return r.events;
}

async function serviceActions(stack: Stack): Promise<Array<{action_id: string; capability: string;
  status: string; idempotency_key: string | null}>> {
  const {actions} = await stack.operator.actions(stack.experimentId);
  return actions.filter(a => a.principal.kind === 'service')
    .map(a => ({action_id: a.action_id, capability: a.capability, status: a.status,
      idempotency_key: a.idempotency_key}));
}

/** plan.step events for one step index, optionally with a specific status. */
const stepEvents = (events: EventView[], index: number, status?: string): EventView[] =>
  events.filter(e => e.type === 'plan.step' && e.payload.index === index
    && (status === undefined || e.payload.status === status));

const verificationOf = (e: EventView): {pass: boolean | null; code: string | null; next_skill: string | null} =>
  (e.payload.verification ?? {}) as {pass: boolean | null; code: string | null; next_skill: string | null};

async function waitForTerminalTask(stack: Stack, timeoutMs: number): Promise<TaskView> {
  return waitFor(async () => {
    const t = await taskOf(stack);
    return ['completed', 'failed', 'cancelled'].includes(t.status) ? t : null;
  }, {timeoutMs, intervalMs: 500, label: 'task terminal'});
}

// -- 1. normal chain ---------------------------------------------------------------

test('skills e2e: normal chain scan_and_assess → exchange_row_and_verify verified done → complete', {timeout: 150_000}, async () => {
  const stack = await startStack(500);   // row min 380 < 500 → maintenance in cycle 1
  try {
    const final = await waitForTerminalTask(stack, 120_000);
    assert.equal(final.status, 'completed', `reason: ${final.reason}`);

    const plan = final.plan;
    assert.deepEqual(plan.map(s => s.skill), ['scan_and_assess', 'exchange_row_and_verify', 'monitor_until']);
    assert.ok(plan.every(s => s.status === 'done'), JSON.stringify(plan.map(s => s.status)));
    assert.ok(plan[0].evidence_refs.length >= 1, 'step 0 carries its observation evidence');
    assert.ok(plan[1].action_ids.length >= 2, 'step 1 links maintenance + verify scan actions');
    assert.ok(plan[1].evidence_refs.length >= 1, 'step 1 carries its verify observation');

    const events = await eventsOf(stack);
    for (const index of [0, 1, 2]) {
      const done = stepEvents(events, index, 'done');
      assert.ok(done.length >= 1, `step ${index} has a done plan.step event`);
      assert.equal(verificationOf(done.at(-1)!).pass, true, `step ${index} verified pass`);
    }
    // step 1 verification evidence names the maintenance action and observation
    const step1Evidence = (stepEvents(events, 1, 'done').at(-1)!.payload.verification as {
      evidence: {maintenance_action_ids?: string[]; observation_id?: string; min_level_ul?: number}}).evidence;
    assert.ok((step1Evidence.maintenance_action_ids ?? []).length >= 1);
    assert.ok(step1Evidence.observation_id);
    assert.ok((step1Evidence.min_level_ul ?? 0) >= 500 - 20, `recheck level ${step1Evidence.min_level_ul} at/above target`);

    const actions = await serviceActions(stack);
    assert.ok(actions.filter(a => a.capability === 'media.add').length >= 1, 'a real maintenance ran');
    assert.ok(actions.filter(a => a.capability === 'imaging.scan').length >= 2, 'scan + verify scan ran');
    assert.ok(actions.every(a => a.status === 'succeeded'), 'all service actions succeeded');
    const keys = new Set(actions.map(a => a.idempotency_key));
    assert.equal(keys.size, actions.length, 'no duplicate idempotency keys');
    assert.ok(stack.stub.stats().completes >= 1, 'the model issued complete_task');
  } finally {
    await stack.stop();
  }
});

// -- 2. real media.exchange chain ------------------------------------------------------

test('skills e2e: media.exchange fraction refresh verified within tolerance of the target', {timeout: 150_000}, async () => {
  // A scenario-specific stub policy (same wire, same tools): exchange 30% of
  // row A medium, rescan, record done. Exchange keeps volumes constant, so the
  // goal target sits below the current row minimum: the postcondition checks
  // the recheck scan against the goal target.
  const {parseBriefs, parsePlan, parseContext, rowWells, lastToolResult} = await import('./model-stub.ts');
  let scans = 0, exchanges = 0;
  const decide: NonNullable<Parameters<typeof startModelStub>[0]>['decide'] = (messages, stats) => {
    stats.turns += 1;
    const ctx = parseContext(messages);
    const goal = ctx.goal;
    if (!ctx.taskId || !goal) return {text: 'no task'};
    const plate = 'plate-01';
    const wells = rowWells('A');
    const briefs = parseBriefs(messages);
    const brief = briefs.at(-1) ?? null;
    const lastResult = lastToolResult(messages);
    if (lastResult?.startsWith('REFUSED')) {
      stats.waits += 1;
      return {toolCalls: [{name: 'register_wake', args: {at_sim_s: (ctx.state?.experiment.sim_time_s ?? 0) + 30,
        reason: 'refused; retry next turn'}}]};
    }
    const plan = parsePlan(messages);
    if (plan.length === 0) {
      if (ctx.lastToolName === 'update_plan') {
        scans += 1;
        return {toolCalls: [{name: 'imaging_scan', args: {plate_id: plate, wells, mode: 'mono'}}]};
      }
      return {toolCalls: [{name: 'update_plan', args: {steps: [
        {skill: 'scan_and_assess', skill_version: '1', inputs: {plate_id: plate, row_id: 'A', wells, mode: 'mono'}},
        {skill: 'exchange_row_and_verify', skill_version: '1',
          inputs: {plate_id: plate, row_id: 'A', reservoir_id: 'media-01', wells, target_volume_ul: 370}},
        {skill: 'monitor_until', skill_version: '1', inputs: {until_sim_s: 1_800, interval_sim_s: 600}},
      ]}}]};
    }
    const step0 = plan.find(s => s.index === 0);
    const step1 = plan.find(s => s.index === 1);
    const step2 = plan.find(s => s.index === 2);
    const exTerminals = brief?.terminals.filter(t => t.capability === 'media.exchange' && t.status === 'succeeded') ?? [];
    if (exTerminals.length > 0 && step1 && step1.status !== 'running') {
      return {toolCalls: [
        {name: 'record_step_result', args: {index: 1, status: 'running', action_ids: exTerminals.map(t => t.action_id)}},
        ...(scans++ ? [] : []),
        {name: 'imaging_scan', args: {plate_id: plate, wells, mode: 'mono'}},
      ]};
    }
    const obs = brief?.observation ?? null;
    if (obs?.observation_id && obs.estimates?.length) {
      if (step0 && step0.verification?.pass !== true && ctx.lastToolName !== 'record_step_result') {
        return {toolCalls: [{name: 'record_step_result', args: {index: 0, status: 'done',
          action_ids: (brief?.scans ?? []).map(s => s.action_id), evidence_refs: [obs.observation_id!]}}]};
      }
      if (step1 && step1.status === 'running' && step1.verification?.pass !== true) {
        return {toolCalls: [{name: 'record_step_result', args: {index: 1, status: 'done',
          action_ids: [...(step1.action_ids ?? []), ...(brief?.scans ?? []).map(s => s.action_id)],
          evidence_refs: [obs.observation_id!]}}]};
      }
      if (step1 && step1.status === 'pending' && exTerminals.length === 0 && exchanges === 0) {
        exchanges += 1;
        return {toolCalls: [{name: 'media_exchange', args: {plate_id: plate, row_id: 'A',
          reservoir_id: 'media-01', fraction: 0.3}}]};
      }
    }
    const simNow = ctx.state?.experiment.sim_time_s ?? 0;
    if (step2 && simNow >= 1_800) {
      if (step2.verification?.pass !== true && ctx.lastToolName !== 'record_step_result') {
        return {toolCalls: [{name: 'record_step_result', args: {index: 2, status: 'done'}}]};
      }
      stats.completes += 1;
      return {toolCalls: [{name: 'complete_task', args: {summary: 'exchange window done',
        evidence_refs: obs?.observation_id ? [obs.observation_id] : []}}]};
    }
    stats.waits += 1;
    return {toolCalls: [{name: 'register_wake', args: {at_sim_s: Math.min(simNow + 600, Math.max(simNow + 60, 1_800)),
      reason: 'wait'}}]};
  };

  const stack = await startStack(370, {allowed: ['imaging.scan', 'media.exchange'], decide});
  try {
    const final = await waitForTerminalTask(stack, 120_000);
    assert.equal(final.status, 'completed', `reason: ${final.reason}`);
    const events = await eventsOf(stack);
    const step1Done = stepEvents(events, 1, 'done').at(-1);
    assert.ok(step1Done, 'step 1 recorded done');
    assert.equal(verificationOf(step1Done!).pass, true);
    const evidence = (step1Done!.payload.verification as {evidence: {maintenance_action_ids?: string[];
      min_level_ul?: number}}).evidence;
    assert.equal(evidence.maintenance_action_ids?.length, 1);
    assert.ok((evidence.min_level_ul ?? 0) >= 370 - 12, `post-exchange min ${evidence.min_level_ul}`);
    const actions = await serviceActions(stack);
    assert.equal(actions.filter(a => a.capability === 'media.exchange').length, 1);
    assert.ok(actions.filter(a => a.capability === 'imaging.scan').length >= 2);
  } finally {
    await stack.stop();
  }
});

// -- 3. recheck below target -------------------------------------------------------------

test('skills e2e: recheck below target → step FAILED with next skill → second maintenance → done', {timeout: 150_000}, async () => {
  // the stub deliberately under-doses the FIRST maintenance (factor 0.4): the
  // postcondition evaluator must refuse `done`, FAIL the step with
  // verify_below_target and the recommended next skill, and the corrected
  // second maintenance then verifies.
  const stack = await startStack(500, {stubPerturb: {maintenanceVolumeFactor: {factor: 0.4, times: 1}}});
  try {
    const final = await waitForTerminalTask(stack, 120_000);
    assert.equal(final.status, 'completed', `reason: ${final.reason}`);

    const events = await eventsOf(stack);
    const step1Failed = stepEvents(events, 1, 'failed');
    assert.ok(step1Failed.length >= 1, 'step 1 recorded failed on the below-target recheck');
    const v = verificationOf(step1Failed.at(-1)!);
    assert.equal(v.code, 'verify_below_target');
    assert.equal(v.pass, false);
    assert.equal(v.next_skill, 'exchange_row_and_verify', 'explicit recommended next skill');

    const step1Done = stepEvents(events, 1, 'done').at(-1);
    assert.ok(step1Done, 'step 1 eventually done after the retry');
    assert.equal(verificationOf(step1Done!).pass, true);
    assert.equal(final.plan[1].status, 'done');

    const actions = await serviceActions(stack);
    const adds = actions.filter(a => a.capability === 'media.add');
    assert.equal(adds.length, 2, `exactly two maintenances (under-dose + correction), got ${adds.length}`);
    assert.ok(adds.every(a => a.status === 'succeeded'));
  } finally {
    await stack.stop();
  }
});

// -- 3b. N02 full regression: refused completion after a failed verification, then verified remediation --------

test('skills e2e (N02): failed verification → complete_task REFUSED → remediation → verified completion succeeds', {timeout: 200_000}, async () => {
  // The stub under-doses the first maintenance (verify_below_target → step
  // failed), then tries to COMPLETE the task anyway: the tool must refuse
  // (failed step without a later verified success + goal metrics unmet), the
  // task must stay open, and only the remediated, re-verified plan may complete.
  const {parsePlan, stubDecide, lastToolResult} = await import('./model-stub.ts');
  const refusedTexts = new Set<string>();
  let completionAttempted = false;
  const decide: NonNullable<Parameters<typeof startModelStub>[0]>['decide'] = (messages, stats, env) => {
    for (const m of messages) {
      if (m.role !== 'tool') continue;
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      if (/REFUSED (plan_not_verifiable|goal_unverified|goal_unmet)/.test(text)) refusedTexts.add(text.slice(0, 120));
    }
    const plan = parsePlan(messages);
    const step1 = plan.find(s => s.index === 1);
    if (step1?.status === 'failed' && !completionAttempted) {
      completionAttempted = true;
      stats.completes += 1;
      return {toolCalls: [{name: 'complete_task', args: {summary: 'claiming success despite the failed recheck',
        evidence_refs: []}}]};
    }
    return stubDecide(messages, stats, env);
  };
  void lastToolResult;
  const stack = await startStack(500, {stubPerturb: {maintenanceVolumeFactor: {factor: 0.4, times: 1}}, decide});
  try {
    await waitFor(() => refusedTexts.size >= 1 ? true : null, {timeoutMs: 120_000, label: 'complete_task refused while the goal is unmet'});
    const mid = await taskOf(stack);
    assert.notEqual(mid.status, 'completed', 'the task must not complete on a failed verification');

    const final = await waitForTerminalTask(stack, 120_000);
    assert.equal(final.status, 'completed', `reason: ${final.reason}`);
    assert.equal(final.plan[1].status, 'done');
    const events = await eventsOf(stack);
    assert.ok(stepEvents(events, 1, 'failed').length >= 1, 'the below-target recheck failed the step first');
    assert.equal(verificationOf(stepEvents(events, 1, 'done').at(-1)!).pass, true);
    const actions = await serviceActions(stack);
    assert.equal(actions.filter(a => a.capability === 'media.add').length, 2,
      'under-dose + remediation maintenances');
    assert.ok(refusedTexts.size >= 1, 'at least one complete_task refusal is on record');
  } finally {
    await stack.stop();
  }
});

// -- 4. wrong evidence --------------------------------------------------------------------

test('skills e2e: an OLD observation is refused for done; the corrected evidence then verifies', {timeout: 150_000}, async () => {
  const stack = await startStack(500,
    {stubPerturb: {evidenceRefsOverride: {kind: 'stale-observation', times: 1}}});
  try {
    const final = await waitForTerminalTask(stack, 120_000);
    assert.equal(final.status, 'completed', `reason: ${final.reason}`);
    const events = await eventsOf(stack);
    const refused = events.filter(e => e.type === 'plan.step' && e.payload.refused === true
      && e.payload.index === 1);
    assert.ok(refused.length >= 1, 'a refused done attempt was recorded');
    assert.equal(verificationOf(refused.at(-1)!).code, 'observation_stale');
    assert.equal(final.plan[1].status, 'done');
    assert.equal(verificationOf(stepEvents(events, 1, 'done').at(-1)!).pass, true);
  } finally {
    await stack.stop();
  }
});

test('skills e2e: an observation whose PRODUCING SCAN is not cited is refused for done', {timeout: 150_000}, async () => {
  // §3 of the N05 review: a separate case for the N03 scan-attribution
  // branch — the cited observation is current and valid, but the scan that
  // PRODUCED it is left out of action_ids, so done must be refused with
  // observation_not_from_step_action (not observation_stale).
  const stack = await startStack(500,
    {stubPerturb: {evidenceRefsOverride: {kind: 'uncited-producer-observation', times: 1}}});
  try {
    const final = await waitForTerminalTask(stack, 120_000);
    assert.equal(final.status, 'completed', `reason: ${final.reason}`);
    const events = await eventsOf(stack);
    const refused = events.filter(e => e.type === 'plan.step' && e.payload.refused === true
      && e.payload.index === 1);
    assert.ok(refused.length >= 1, 'a refused done attempt was recorded');
    assert.equal(verificationOf(refused.at(-1)!).code, 'observation_not_from_step_action');
    assert.equal(final.plan[1].status, 'done', 'the corrected citation still verifies');
    assert.equal(verificationOf(stepEvents(events, 1, 'done').at(-1)!).pass, true);
  } finally {
    await stack.stop();
  }
});

test('skills e2e: a FOREIGN (other plate) observation is refused for done', {timeout: 150_000}, async () => {
  // the perturbation object is shared by reference with the stub, so the
  // foreign observation id can be planted BEFORE the task exists
  const perturb = {evidenceRefsOverride: {kind: 'foreign-observation' as const, times: 1, foreignRef: ''}};
  const base = await prepareStack({stubPerturb: perturb});
  try {
    // the OPERATOR scans plate-02 (outside the session's goal scope)
    const submit = await base.operator.submit(base.experimentId,
      {capability: 'imaging.scan', arguments: {plate_id: 'plate-02', wells: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'],
        mode: 'mono'}, basis: 'operator'});
    const foreign = await waitFor(async () => {
      const action = await base.operator.action(base.experimentId, submit.action.action_id);
      if (action.status !== 'succeeded') return null;
      const obs = await base.operator.observation(base.experimentId,
        (action.result as {observation_id?: string} | null)?.observation_id ?? '');
      return obs.observation_id ? obs : null;
    }, {timeoutMs: 20_000, label: 'foreign plate-02 observation'});
    perturb.evidenceRefsOverride.foreignRef = foreign.observation_id;

    const stack = await createTaskOn(base, 500);
    const final = await waitForTerminalTask(stack, 120_000);
    assert.equal(final.status, 'completed', `reason: ${final.reason}`);
    const events = await eventsOf(stack);
    const refused = events.filter(e => e.type === 'plan.step' && e.payload.refused === true
      && e.payload.index === 1);
    assert.ok(refused.length >= 1, 'a refused done attempt was recorded');
    assert.equal(verificationOf(refused.at(-1)!).code, 'observation_wrong_plate');
    assert.equal(final.plan[1].status, 'done', 'the corrected evidence still verifies');
  } finally {
    await base.stop();
  }
});

// -- 5. cancel mid-step ---------------------------------------------------------------------

test('skills e2e: cancel mid-step cancels the in-flight maintenance; the step never reaches done', {timeout: 150_000}, async () => {
  // slow sim clock so the maintenance stays in flight long enough to cancel
  const base = await prepareStack();
  await base.operator.control(base.experimentId, {speed: 5});
  const stack = await createTaskOn(base, 500, {deadline: 100_000});
  try {
    // wait until the maintenance action is RUNNING on the device, then cancel
    const add = await waitFor(async () => {
      const {actions} = await base.operator.actions(base.experimentId);
      const found = actions.filter(a => a.principal.kind === 'service' && a.capability === 'media.add')
        .find(a => a.status === 'running');
      return found ? {action_id: found.action_id} : null;
    }, {timeoutMs: 90_000, intervalMs: 100, label: 'maintenance running'});
    await stack.api.post(`/tasks/${stack.taskId}/control`, {action: 'cancel'});
    const task = await waitFor(async () => {
      const t = await taskOf(stack);
      return t.status === 'cancelled' ? t : null;
    }, {timeoutMs: 20_000, label: 'task cancelled'});
    assert.equal(task.status, 'cancelled');
    assert.notEqual(task.plan[1].status, 'done', 'the mid-flight step cannot be done');

    const events = await waitFor(async () => {
      const all = await eventsOf(stack);
      return all.some(e => e.type === 'action.cancel_requested') ? all : null;
    }, {timeoutMs: 20_000, label: 'cancel request for the in-flight action'});
    assert.ok(events.some(e => e.type === 'action.cancel_requested'), 'the in-flight action got a cancel request');
    const terminal = await waitFor(async () => {
      const a = await stack.operator.action(stack.experimentId, add.action_id);
      return a.status === 'cancelled' ? a : null;
    }, {timeoutMs: 20_000, label: 'device action cancelled'});
    assert.equal(terminal.status, 'cancelled');
    // no done verification ever recorded for step 1
    const step1Done = stepEvents(events, 1, 'done');
    assert.equal(step1Done.length, 0, 'no done was recorded for the cancelled step');
    // no new service actions after the cancel settles
    const before = (await serviceActions(stack)).length;
    await sleep(2_000);
    const after = (await serviceActions(stack)).length;
    assert.equal(after, before, 'no new device actions after cancellation');
  } finally {
    await stack.stop();
  }
});

// -- 6. restart continuation -------------------------------------------------------------------

test('skills e2e: SIGKILL mid-plan resumes from persisted step state without redoing completed steps', {timeout: 180_000}, async () => {
  const stack = await startStack(500, {deadline: 2_400});
  try {
    // wait until step 0 is verified done AND the maintenance is in flight
    const add = await waitFor(async () => {
      const actions = await serviceActions(stack);
      return actions.find(a => a.capability === 'media.add') ?? null;
    }, {timeoutMs: 60_000, label: 'maintenance accepted before the kill'});
    const beforeEvents = await eventsOf(stack);
    const step0DoneBefore = stepEvents(beforeEvents, 0, 'done').at(-1);
    assert.ok(step0DoneBefore, 'step 0 verified done before the kill');
    assert.equal(verificationOf(step0DoneBefore!).pass, true);
    const step0EvidenceBefore = JSON.stringify((step0DoneBefore!.payload.verification as {
      evidence: Record<string, unknown>}).evidence);
    const scansBefore = (await serviceActions(stack)).filter(a => a.capability === 'imaging.scan').length;

    stack.agent.kill9();
    const restarted = await spawnAgentProc({dataDir: stack.runtime.dataDir, runtimeUrl: stack.runtime.baseUrl,
      env: {OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stack.stub.port}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
        OSCAR_MODEL_NAME: 'oscar-stub', OSCAR_MODEL_PROVIDER: 'oscar-stub'}});
    // the OLD agent's HTTP endpoint is gone: talk to the restarted process
    const restartedStack: Stack = {...stack, agent: restarted,
      api: new AgentApiClient(restarted.baseUrl, stack.runtime.serviceToken)};
    try {
      // the plan resumes from the PERSISTED step state and the task completes
      const final = await waitForTerminalTask(restartedStack, 150_000);
      assert.equal(final.status, 'completed', `reason: ${final.reason}`);
      assert.equal(final.plan[0].status, 'done');
      assert.equal(final.plan[1].status, 'done');

      const afterEvents = await eventsOf(restartedStack);
      // step 0's recorded verification evidence is IDENTICAL: no redo
      const step0DoneAfter = stepEvents(afterEvents, 0, 'done').at(-1);
      assert.ok(step0DoneAfter);
      const step0EvidenceAfter = JSON.stringify((step0DoneAfter!.payload.verification as {
        evidence: Record<string, unknown>}).evidence);
      assert.equal(step0EvidenceAfter, step0EvidenceBefore, 'step 0 verification evidence unchanged across restart');
      assert.equal(stepEvents(afterEvents, 0, 'done').length, stepEvents(beforeEvents, 0, 'done').length,
        'step 0 was not re-recorded after the restart');

      const actions = await serviceActions(restartedStack);
      // the in-flight maintenance was NEVER re-submitted (exactly one add)
      assert.equal(actions.filter(a => a.capability === 'media.add').length, 1,
        'the killed in-flight maintenance was resumed/reconciled, never redone');
      const keys = new Set(actions.map(a => a.idempotency_key));
      assert.equal(keys.size, actions.length, 'no duplicate idempotency keys across the restart');
      const scansAfter = actions.filter(a => a.capability === 'imaging.scan').length;
      assert.ok(scansAfter >= scansBefore, 'no scans were lost');
    } finally {
      await restarted.stop().catch(() => undefined);
    }
  } finally {
    await stack.stop();
  }
});
