// S01 regression (review reports/review/long-lived-q04-independent-review.md §2):
// a REAL Runtime environment sample must fire an armed threshold wake. The
// producer (services/runtime/src/runtime.ts stepOnce) emits
// `{chamber_id, sample:{temperature_c, co2_pct, humidity_pct,
// sampled_at_sim_s, quality}, targets, quality}`; before the fix
// scheduler.evaluateConditions only read chamber.*.observed / flat top-level
// fields, so all three readings were undefined and real conditions never woke
// the model.
//
// Everything here goes through the REAL event path: a spawned Runtime process
// (realtime clock, speed 100) → HTTP/SSE device stream → scheduler watcher →
// inbox → evaluateConditions → fired wake → model turn. Readings and
// predicates are NEVER rewritten into a synthetic shape: the operator only
// changes chamber TARGETS over real HTTP and the world physics produces the
// crossing. (Crossings therefore usually land on quality='settling' samples —
// the documented semantics: per-channel readings stay evidence; debounce /
// hysteresis / cooldown are the transient filters.)
//
// Coverage:
//  - temperature / CO₂ / humidity real crossings each fire EXACTLY ONE wake
//    (the tripped latch never re-fires on further out-of-band samples)
//  - debounce is enforced on the real sample stream: fire time − first
//    out-of-band sample ≥ debounce_sim_s (temperature uses debounce 0 and
//    fires on the first crossing sample)
//  - cooldown: after an in-band un-trip (hysteresis), a SECOND real crossing
//    inside cooldown_sim_s does not fire again
//  - a condition that is never satisfied runs ZERO model turns beyond the
//    arming turn while real samples keep flowing
//  - every environment.sampled inbox row is processed
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '@oscar/device-contract';
import {AgentStore} from '../src/store.ts';
import {SessionStore} from '../src/session-store.ts';
import {SessionManager} from '../src/session-manager.ts';
import {normalizeGoalSpec} from '../src/goal.ts';
import type {AgentBackend, TurnOutput} from '../src/backend.ts';
import {spawnRuntimeProc, waitFor} from './procs.ts';

type Metric = 'temperature_c' | 'co2_pct' | 'humidity_pct';
interface Condition {metric: Metric; op: 'below' | 'above'; value: number;
  debounce_sim_s: number; hysteresis: number; cooldown_sim_s: number}

interface ChamberSample {temperature_c: number; co2_pct: number; humidity_pct: number;
  quality: string; sampled_at_sim_s: number}
interface SampleRow {source_seq: number; state: string; sample: ChamberSample}

interface Ctx {dir: string; agentStore: AgentStore; store: SessionStore; sessionId: string;
  taskId: string; manager: SessionManager | null; turns: number; registrationSeq: number}

const out = (): TurnOutput => ({ok: true, assistantText: 'ack', toolLog: [],
  usage: {requests: 1, inputTokens: 0, outputTokens: 0},
  effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null,
    goalUpdated: null, planUpdated: false, stopRequested: false}});

/** One isolated long-lived session whose FIRST (recovery) turn arms the
 * condition through the production ToolHost; later turns are counted. */
async function armCondition(runtime: {baseUrl: string; serviceToken: string},
  instanceId: string, exp: string, condition: Condition): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-s01-reg-'));
  const agentStore = new AgentStore(dir);
  const store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: instanceId, experiment_id: exp});
  const goal = normalizeGoalSpec({description: `wait for ${condition.metric} ${condition.op} ${condition.value}`,
    scope: {plates: ['plate-01']}, metrics: [], allowed_operations: ['imaging.scan'],
    monitoring: {conditions: [condition]}});
  const task = store.createTask(session.session_id,
    {goal_text: goal.description, goal_spec: goal as unknown as Record<string, unknown>});
  const ctx: Ctx = {dir, agentStore, store, sessionId: session.session_id, taskId: task.task_id,
    manager: null, turns: 0, registrationSeq: 0};
  let armedOnce = false;
  const backend: AgentBackend = {
    id: 'explicit-s01-threshold-regression', available: () => ({ok: true}),
    capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}),
    runTurn: async (_input, host) => {
      ctx.turns += 1;
      if (!armedOnce) {
        armedOnce = true;
        const wake = host.armWake({kind: 'condition', predicate: {...condition},
          reason: `real ${condition.metric} crossing evidence`, step_index: null});
        assert.equal(wake.status, 'armed', 'the production host must arm the condition wake');
      }
      return out();
    },
    compact: () => ({summary: '', facts: [], open_questions: []}),
    close: async () => {}};
  ctx.manager = new SessionManager({store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, backend, log: () => {}});
  ctx.manager.ensureScheduler(store.getSession(ctx.sessionId)!);
  await waitFor(() => store.armedWakes(ctx.sessionId).some(w => w.kind === 'condition') ? true : null,
    {timeoutMs: 15_000, label: 'condition wake armed by the recovery turn'});
  ctx.registrationSeq = store.getSession(ctx.sessionId)!.inbox_cursor;
  return ctx;
}

async function stop(ctx: Ctx): Promise<void> {
  await ctx.manager?.stopAll().catch(() => {});
  ctx.agentStore.close();
  rmSync(ctx.dir, {recursive: true, force: true});
}

test('S01: real Runtime environment.sampled contract fires threshold wakes (debounce, latch, cooldown, zero-turn control)', {timeout: 240_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken, timeoutMs: 15_000});
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  const open: Ctx[] = [];
  try {
    const exp = await client.currentExperimentId();
    const health = await client.health() as {ok: boolean; service: string; version: string; instance_id: string};
    await operator.control(exp, {speed: 100});
    await operator.control(exp, {resume: true});

    const samplesOf = (ctx: Ctx): SampleRow[] => ctx.store.inboxByType(ctx.sessionId, 'environment.sampled')
      .map(r => ({source_seq: r.source_seq, state: r.state,
        sample: (JSON.parse(r.payload) as {sample: ChamberSample}).sample}));
    const reading = (s: ChamberSample, metric: Metric): number => s[metric];
    const outOfBand = (s: ChamberSample, c: Condition): boolean =>
      c.op === 'below' ? reading(s, c.metric) < c.value : reading(s, c.metric) > c.value;
    const setTarget = (args: Record<string, number>) => operator.submit(exp,
      {capability: 'environment.set_targets', arguments: {chamber_id: 'chamber-01', ...args}});
    const firedCount = (ctx: Ctx): number => ctx.store.firedWakes(ctx.sessionId, ctx.taskId).length;
    const fireEvent = (ctx: Ctx, metric: Metric): {sim_time_s: number; quality: unknown} | null => {
      const ev = ctx.store.sessionEventsAfter(ctx.sessionId, 0, 2000)
        .find(e => e.type === 'wake.fired' && e.payload.kind === 'condition' && e.payload.metric === metric);
      return ev ? {sim_time_s: Number(ev.payload.sim_time_s), quality: ev.payload.quality} : null;
    };
    const assertInboxProcessed = (ctx: Ctx, atLeast: number): void => {
      const rows = ctx.store.inboxByType(ctx.sessionId, 'environment.sampled')
        .filter(r => r.source_seq > ctx.registrationSeq);
      assert.ok(rows.length >= atLeast, `expected ≥${atLeast} real samples, got ${rows.length}`);
      assert.ok(rows.every(r => r.state === 'processed'),
        `every environment.sampled inbox row must be processed (states: ${rows.map(r => r.state).join(',')})`);
    };

    // -- temperature: debounce 0 fires on the FIRST crossing sample; the latch
    // holds across further out-of-band samples; a second real crossing inside
    // the cooldown is suppressed after an in-band un-trip ---------------------
    {
      const condition: Condition = {metric: 'temperature_c', op: 'below', value: 35.5,
        debounce_sim_s: 0, hysteresis: 0.2, cooldown_sim_s: 100_000};
      const before = await client.state(exp);
      assert.ok(before.chamber.temperature_c.observed > condition.value + 1,
        'temperature starts well inside the band');
      const ctx = await armCondition(runtime, health.instance_id, exp, condition); open.push(ctx);
      await setTarget({temperature_c: 32}); // real crossing via world physics
      await waitFor(() => firedCount(ctx) > 0 ? true : null,
        {timeoutMs: 20_000, label: 'temperature threshold wake fired through the real event path'});
      const oob = samplesOf(ctx).filter(r => outOfBand(r.sample, condition));
      assert.ok(oob.length >= 1, 'the fire is backed by a real out-of-band sample');
      const fire = fireEvent(ctx, 'temperature_c');
      assert.ok(fire, 'wake.fired session event emitted');
      assert.ok(Math.abs(fire!.sim_time_s - oob[0].sample.sampled_at_sim_s) < 1e-6,
        `debounce 0 must fire on the first out-of-band sample (fire ${fire!.sim_time_s}, sample ${oob[0].sample.sampled_at_sim_s})`);
      assert.ok(fire!.quality === 'ok' || fire!.quality === 'settling',
        'fire evidence carries the sample quality');
      assert.equal(firedCount(ctx), 1, 'exactly one fire for the crossing');
      assert.ok(ctx.turns >= 2, 'the fired wake ran a model turn beyond the arming turn');
      // latch: more out-of-band samples never re-fire
      await waitFor(() => samplesOf(ctx).filter(r => outOfBand(r.sample, condition)
        && r.sample.sampled_at_sim_s > oob[0].sample.sampled_at_sim_s).length >= 2 ? true : null,
        {timeoutMs: 15_000, label: 'further out-of-band temperature samples'});
      assert.equal(firedCount(ctx), 1, 'the tripped wake latches — no double fire');
      // un-trip via hysteresis (value ≥ threshold + hysteresis), then cross again
      await setTarget({temperature_c: 37});
      const untrip = await waitFor(() => {
        const s = samplesOf(ctx).find(r => r.state === 'processed'
          && r.sample.temperature_c >= condition.value + condition.hysteresis);
        return s ? s.sample.sampled_at_sim_s : null;
      }, {timeoutMs: 25_000, label: 'temperature back in band (hysteresis un-trip)'});
      await setTarget({temperature_c: 32}); // second REAL crossing, inside the cooldown
      await waitFor(() => samplesOf(ctx).filter(r => r.sample.sampled_at_sim_s > untrip
        && outOfBand(r.sample, condition)).length >= 2 ? true : null,
        {timeoutMs: 25_000, label: 'second real crossing samples'});
      assert.equal(firedCount(ctx), 1,
        'cooldown must suppress the second crossing (debounce 0 would hold immediately)');
      assertInboxProcessed(ctx, 3);
      await stop(ctx); open.pop();
    }

    // -- CO₂: debounce 60 must be measured on the real sample stream -----------
    {
      const condition: Condition = {metric: 'co2_pct', op: 'above', value: 6.8,
        debounce_sim_s: 60, hysteresis: 0.2, cooldown_sim_s: 100_000};
      const before = await client.state(exp);
      assert.ok(before.chamber.co2_pct.observed < condition.value - 0.5,
        'CO₂ starts well inside the band');
      const ctx = await armCondition(runtime, health.instance_id, exp, condition); open.push(ctx);
      await setTarget({co2_pct: 7.5});
      await waitFor(() => firedCount(ctx) > 0 ? true : null,
        {timeoutMs: 25_000, label: 'CO₂ threshold wake fired through the real event path'});
      const oob = samplesOf(ctx).filter(r => outOfBand(r.sample, condition));
      const fire = fireEvent(ctx, 'co2_pct');
      assert.ok(fire, 'wake.fired session event emitted');
      assert.ok(fire!.sim_time_s - oob[0].sample.sampled_at_sim_s >= condition.debounce_sim_s - 1e-6,
        `debounce enforced on real samples: fire ${fire!.sim_time_s} − first out-of-band ${oob[0].sample.sampled_at_sim_s} < ${condition.debounce_sim_s}`);
      assert.ok(oob.filter(r => r.sample.sampled_at_sim_s < fire!.sim_time_s).length >= 1,
        'the fire needed earlier out-of-band samples to accumulate the hold');
      await waitFor(() => samplesOf(ctx).filter(r => outOfBand(r.sample, condition)
        && r.sample.sampled_at_sim_s > fire!.sim_time_s).length >= 2 ? true : null,
        {timeoutMs: 15_000, label: 'further out-of-band CO₂ samples'});
      assert.equal(firedCount(ctx), 1, 'exactly one fire for the CO₂ crossing');
      assert.ok(ctx.turns >= 2, 'the fired wake ran a model turn');
      assertInboxProcessed(ctx, 3);
      await stop(ctx); open.pop();
    }

    // -- humidity: same one-fire proof on the third channel --------------------
    {
      const condition: Condition = {metric: 'humidity_pct', op: 'below', value: 91,
        debounce_sim_s: 30, hysteresis: 0.2, cooldown_sim_s: 100_000};
      const before = await client.state(exp);
      assert.ok(before.chamber.humidity_pct.observed > condition.value + 0.5,
        'humidity starts well inside the band');
      const ctx = await armCondition(runtime, health.instance_id, exp, condition); open.push(ctx);
      await setTarget({humidity_pct: 88});
      await waitFor(() => firedCount(ctx) > 0 ? true : null,
        {timeoutMs: 25_000, label: 'humidity threshold wake fired through the real event path'});
      const oob = samplesOf(ctx).filter(r => outOfBand(r.sample, condition));
      const fire = fireEvent(ctx, 'humidity_pct');
      assert.ok(fire, 'wake.fired session event emitted');
      assert.ok(fire!.sim_time_s - oob[0].sample.sampled_at_sim_s >= condition.debounce_sim_s - 1e-6,
        'debounce enforced on real humidity samples');
      await waitFor(() => samplesOf(ctx).filter(r => outOfBand(r.sample, condition)
        && r.sample.sampled_at_sim_s > fire!.sim_time_s).length >= 2 ? true : null,
        {timeoutMs: 15_000, label: 'further out-of-band humidity samples'});
      assert.equal(firedCount(ctx), 1, 'exactly one fire for the humidity crossing');
      assert.ok(ctx.turns >= 2, 'the fired wake ran a model turn');
      assertInboxProcessed(ctx, 3);
      await stop(ctx); open.pop();
    }

    // -- control: a condition that never crosses runs ZERO model turns ---------
    {
      const condition: Condition = {metric: 'co2_pct', op: 'above', value: 20,
        debounce_sim_s: 0, hysteresis: 0.2, cooldown_sim_s: 100_000};
      const ctx = await armCondition(runtime, health.instance_id, exp, condition); open.push(ctx);
      await waitFor(() => ctx.store.sessionEventsAfter(ctx.sessionId, 0, 1000)
        .some(e => e.type === 'turn.completed') ? true : null,
        {timeoutMs: 15_000, label: 'the arming turn completed'});
      await waitFor(() => ctx.store.inboxByType(ctx.sessionId, 'environment.sampled')
        .filter(r => r.source_seq > ctx.registrationSeq && r.state === 'processed').length >= 3 ? true : null,
        {timeoutMs: 20_000, label: 'three real samples processed while the condition waits'});
      const turnEvents = ctx.store.sessionEventsAfter(ctx.sessionId, 0, 1000)
        .filter(e => e.type === 'turn.completed');
      assert.equal(turnEvents.length, 1,
        'no unsatisfied condition may spend model turns (only the arming turn ran)');
      assert.equal(ctx.turns, 1, 'backend runTurn called exactly once (the arming turn)');
      assert.equal(firedCount(ctx), 0, 'no wake fired for an unsatisfied condition');
      assertInboxProcessed(ctx, 3);
      await stop(ctx); open.pop();
    }
  } finally {
    for (const ctx of open) await stop(ctx);
    await runtime.stop();
  }
});
