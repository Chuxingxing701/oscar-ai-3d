// D5 acceptance: ONE long-lived session over 26+ simulated hours on REAL
// processes (Runtime + Culture Agent + HTTP model stub on the OpenAI wire).
//
// EXPLICIT DEMO PARAMETERS (recorded, deterministic — no random model output
// decides whether this test passes):
//   scenario routine_maintenance, realtime clock, speed 1200 (1 sim h = 3 wall s)
//   goal: plate-01 row A per-well medium ≥ 330 µL, check every 6 sim h,
//         deadline 26 sim h; allowed ops imaging.scan + media.add
//   expected trace: checks at t0/6h/12h are no-ops (min 380→332), maintenance
//   at t18h and t24h (min falls below 330), final check at the 26h deadline
//   completes the task (min ≥ 330 after maintenance)
//   evaporation: 4 µL/h per well (simulator profile)
// Assertions: ≥3 monitor wakes, ≥2 maintenances, ≥1 no-op decision, task
// completes with evidence; per-well + inventory conservation; bounded model
// calls; strictly monotonic session seq. Model stub ≠ scripted run path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceClient} from '@oscar/device-contract';
import {startModelStub} from './model-stub.ts';
import {AgentApiClient, spawnAgentProc, spawnRuntimeProc, sleep, waitFor} from './procs.ts';

const ROW_A_INITIAL = [400, 380, 410, 420, 395, 405];
const EVAP_UL_PER_H = 4;

const goalSpec = {
  description: '维持 plate-01 A 排各孔培养液 ≥ 330 µL：定期扫描评估，低于阈值整排补液并复查',
  scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'}],
  allowed_operations: ['imaging.scan', 'media.add'],
  monitoring: {interval_sim_s: 21_600},
  deadline_sim_s: 93_600,
  success: {description: 'monitoring window finished with all checks at/above threshold after maintenance'},
  stop: {description: 'budget exhausted or user cancel', max_corrections: 8},
};

interface SessionStatus {
  session: {session_id: string; experiment_id: string; lifecycle: string; loop_state: string};
  device: {sim_time_s?: number; clock_mode?: string; reachable: boolean};
  task: {task_id: string; status: string; reason: string | null; goal_revision: number;
    budget: {actions_used: number; max_actions: number; model_turns_used: number; max_model_turns: number};
    plan: Array<{index: number; skill: string; status: string}>} | null;
  next_wake: {kind: string; target_sim_s: number | null} | null;
  wakes_armed: number;
}

test('long-lived session: 26 sim hours, monitoring wakes, maintenance, conservation', {timeout: 240_000}, async () => {
  const stub = await startModelStub();
  const runtime = await spawnRuntimeProc({clockMode: 'realtime', scenario: 'routine_maintenance'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl,
    env: {OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stub.port}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
      OSCAR_MODEL_NAME: 'oscar-stub', OSCAR_MODEL_PROVIDER: 'oscar-stub'}});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    // realtime product path with an accelerated demo clock
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const initial = await operator.state(experimentId);

    // 1. one long-lived session for the current experiment (idempotent create)
    const created = await api.post<{session: {session_id: string}; created: boolean}>('/sessions', {});
    assert.equal(created.created, true);
    const again = await api.post<{session: {session_id: string}; created: boolean}>('/sessions', {});
    assert.equal(again.created, false, 'second create must return the SAME session');
    assert.equal(again.session.session_id, created.session.session_id);
    const sessionId = created.session.session_id;

    // 2. create the monitoring task
    const {task} = await api.post<{task: {task_id: string; status: string}}>('/sessions/' + sessionId + '/tasks',
      {goal_text: '照看 plate-01 A 排：定期扫描，液位低于 330 µL 时整排补液并复查', goal_spec: goalSpec});
    const taskId = task.task_id;

    // 3. drive to completion (26 sim h ≈ 78 wall s at speed 1200 + turns)
    const finalStatus = await waitFor<SessionStatus>(async () => {
      const t = await api.get<{task: {status: string} | null}>('/tasks/' + taskId);
      if (t.task?.status !== 'completed') return null;
      return api.get<SessionStatus>('/sessions/' + sessionId + '/status');
    }, {timeoutMs: 200_000, intervalMs: 1000, label: 'task completion'});

    // -- wakes & decisions ------------------------------------------------------
    const events = await api.get<{events: Array<{seq: number; type: string; payload: Record<string, unknown>}>}>(
      '/sessions/' + sessionId + '/events?format=json&limit=10000');
    const seqs = events.events.map(e => e.seq);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'session seq strictly increasing');
    const simWakes = events.events.filter(e => e.type === 'wake.fired' && e.payload.kind === 'sim_time');
    const observations = events.events.filter(e => e.type === 'observation.recorded');
    assert.ok(simWakes.length >= 3, `expected ≥3 monitor wakes, got ${simWakes.length}`);
    assert.ok(observations.length >= 3, `expected ≥3 observations, got ${observations.length}`);
    const noOpReports = events.events.filter(e => e.type === 'message.appended'
      && String((e.payload as {message?: {content?: string}})?.message?.content ?? '').includes('No operation needed'));
    assert.ok(noOpReports.length >= 1, `expected ≥1 no-operation decision, got ${noOpReports.length}`);
    // -- actions, no duplicates, conservation ------------------------------------
    const {actions} = await operator.actions(experimentId);
    const sessionActions = actions.filter(a => a.principal.kind === 'service');
    const mediaAdds = sessionActions.filter(a => a.capability === 'media.add');
    const scans = sessionActions.filter(a => a.capability === 'imaging.scan');
    assert.ok(mediaAdds.length >= 2, `expected ≥2 maintenance media.add, got ${mediaAdds.length}`);
    assert.ok(scans.length >= 3, `expected ≥3 scans, got ${scans.length}`);
    assert.ok(mediaAdds.every(a => a.status === 'succeeded'), 'all maintenances succeeded');
    const keys = new Set<string>();
    for (const a of sessionActions) {
      assert.ok(a.idempotency_key, 'session actions carry idempotency keys');
      assert.ok(!keys.has(a.idempotency_key!), 'duplicate idempotency key — double submission');
      keys.add(a.idempotency_key!);
    }

    // per-well conservation: final = initial + Σ effects − evaporation
    const finalState = await operator.state(experimentId);
    const elapsedSimH = (finalState.experiment.sim_time_s - initial.experiment.sim_time_s) / 3600;
    const wellEffects = new Map<string, number>();
    let reservoirDelta = 0, tipsUsed = 0, wasteDelta = 0;
    for (const action of sessionActions) {
      for (const effect of action.effects) {
        for (const w of effect.wells ?? []) {
          wellEffects.set(w.well_id, (wellEffects.get(w.well_id) ?? 0) + w.delta_ul);
        }
        if (effect.reservoir) reservoirDelta += effect.reservoir.delta_ul;
        if (effect.waste) wasteDelta += effect.waste.delta_ul;
        if (effect.tips) tipsUsed += effect.tips.delta;
      }
    }
    const finalPlate = finalState.plates.find(p => p.plate_id === 'plate-01')!;
    ROW_A_INITIAL.forEach((initialUl, i) => {
      const wellId = `A${i + 1}`;
      const finalUl = finalPlate.wells.find(w => w.well_id === wellId)!.volume_ul;
      const expected = initialUl + (wellEffects.get(wellId) ?? 0) - EVAP_UL_PER_H * elapsedSimH;
      assert.ok(Math.abs(finalUl - expected) <= 2,
        `${wellId}: final ${finalUl.toFixed(1)} ≠ expected ${expected.toFixed(1)} (initial ${initialUl}, effects ${wellEffects.get(wellId) ?? 0}, evap ${(EVAP_UL_PER_H * elapsedSimH).toFixed(1)})`);
    });
    const reservoir = finalState.reservoirs.find(r => r.id === 'media-01')!;
    assert.ok(Math.abs((50_000 + reservoirDelta) - reservoir.remaining_ul) <= 1,
      `reservoir conservation: expected ~${50_000 + reservoirDelta}, got ${reservoir.remaining_ul}`);
    assert.equal(wasteDelta, 0, 'media.add must not write waste');
    const totalTips = finalState.tips.reduce((n, t) => n + t.remaining, 0);
    assert.equal(totalTips, 288 + tipsUsed, 'tips consumed = 6 per media.add pickup');

    // -- model call bound ---------------------------------------------------------
    const requests = stub.requests();
    const modelTurns = finalStatus.task?.budget.model_turns_used ?? 0;
    assert.ok(requests.length <= 80, `model requests bounded (got ${requests.length})`);
    assert.ok(modelTurns >= 6 && modelTurns <= 60, `model turns counted (${modelTurns})`);
    // every request went through the OpenAI wire with the tool protocol
    assert.ok(requests.length > 0 && requests.every(r => r.tools.length >= 3), 'tools present on every request');

    // -- task evidence -------------------------------------------------------------
    const taskView = await api.get<{task: {status: string; plan: Array<{skill: string; status: string; evidence_refs: string[]}>}}>(
      '/tasks/' + taskId);
    assert.equal(taskView.task.status, 'completed');
    assert.ok(taskView.task.plan.length >= 2, 'plan persisted');
    const doneSteps = taskView.task.plan.filter(s => s.status === 'done');
    assert.ok(doneSteps.length >= 1, 'at least one plan step completed with evidence');

    // 4. conversation continues after task completion (session outlives tasks)
    const msg = await api.post<{message_id: string}>('/sessions/' + sessionId + '/messages',
      {content: '任务完成了，请总结一下这轮维护。', request_id: 'summary-1'});
    assert.ok(msg.message_id);
    const reply = await waitFor(async () => {
      const detail = await api.get<{messages: Array<{role: string; content: string}>}>('/sessions/' + sessionId);
      const last = detail.messages.at(-1);
      return last?.role === 'assistant' ? last : null;
    }, {timeoutMs: 20_000, label: 'post-task conversation reply'});
    assert.equal(reply.role, 'assistant');

    // 5. user returns later: same session id, history intact
    const sessions = await api.get<{sessions: Array<{session_id: string; experiment_id: string}>}>('/sessions');
    assert.ok(sessions.sessions.some(s => s.session_id === sessionId));
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await stub.close();
  }
});

test('clock/sensor sampling alone never wakes the model (bounded calls)', {timeout: 120_000}, async () => {
  const stub = await startModelStub();
  const runtime = await spawnRuntimeProc({clockMode: 'realtime', scenario: 'routine_maintenance'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl,
    env: {OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stub.port}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
      OSCAR_MODEL_NAME: 'oscar-stub'}});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const {session} = await api.post<{session: {session_id: string}}>('/sessions', {});
    // long interval: nothing due for 16 sim h
    await api.post('/sessions/' + session.session_id + '/tasks',
      {goal_text: '长期监测 A 排', goal_spec: {...goalSpec, monitoring: {interval_sim_s: 57_600},
        deadline_sim_s: 61_200, metrics: [{metric: 'medium_volume_ul', op: '>=', value: 100, source: 'observation', row_id: 'A'}]}});
    // wait for the initial scan+assess turns to settle (task → waiting_condition)
    await waitFor(async () => {
      const s = await api.get<SessionStatus>('/sessions/' + session.session_id + '/status');
      return s.task?.status === 'waiting_condition' ? s : null;
    }, {timeoutMs: 30_000, label: 'task waiting_condition'});
    const baseline = stub.requests().length;
    // 12 wall s ≈ 4 sim h of clock steps + environment.sampled events: NO wake
    await sleep(12_000);
    assert.equal(stub.requests().length, baseline,
      'model must not be called for clock/sensor sampling alone');
    const status = await api.get<SessionStatus>('/sessions/' + session.session_id + '/status');
    assert.ok(status.wakes_armed >= 1, 'wake stays armed');
    assert.equal(status.task?.status, 'waiting_condition');
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await stub.close();
  }
});
