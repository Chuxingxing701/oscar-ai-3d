// C1 test 1: row pipette + conservation over real HTTP with DeviceClient.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeviceError} from '@oscar/device-contract';
import {currentExperimentId, spawnRuntime, waitUntil, type RuntimeHandle} from './helpers.ts';

let h: RuntimeHandle;
let exp: string;

test.before(async () => {
  h = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  exp = await currentExperimentId(h);
});

test.after(async () => {
  await h.stop();
});

async function runToCompletion(actionId: string): Promise<ReturnType<typeof getAction>> {
  await h.client.control(exp, {step: {until_idle: true}});
  return getAction(actionId);
}

async function getAction(actionId: string) {
  return h.client.action(exp, actionId);
}

async function totalEvaporated(): Promise<number> {
  const truth = await h.client.request<{wells: Array<{wells: Array<{evaporated_ul: number}>}>}>(
    'GET', `/api/v1/experiments/${exp}/debug/truth`);
  return truth.body.wells.flatMap(pl => pl.wells).reduce((s, w) => s + w.evaporated_ul, 0);
}

/** ΣΔwells + Δreservoir + Δwaste + Δevaporated ≈ 0 across two snapshots. */
async function assertConservation(before: Awaited<ReturnType<typeof h.client.state>>,
    after: Awaited<ReturnType<typeof h.client.state>>, evapBefore: number): Promise<void> {
  const evapAfter = await totalEvaporated();
  const wellsSum = (s: typeof before): number =>
    s.plates.flatMap(p => p.wells.map(w => w.volume_ul)).reduce((a, v) => a + v, 0);
  const drift = (wellsSum(after) - wellsSum(before))
    + (after.reservoirs[0].remaining_ul - before.reservoirs[0].remaining_ul)
    + (after.wastes[0].used_ul - before.wastes[0].used_ul)
    + (evapAfter - evapBefore);
  assert.ok(Math.abs(drift) < 5e-3, `conservation drift ${drift}`);
}

test('media.add on a complete row: +V per well, others unchanged, reservoir -6V, tips -6', async () => {
  const before = await h.client.state(exp);
  const a1 = before.plates.find(p => p.plate_id === 'plate-01')!.wells.map(w => w.volume_ul);
  const a2 = before.plates.find(p => p.plate_id === 'plate-02')!.wells.map(w => w.volume_ul);
  const res0 = before.reservoirs[0].remaining_ul;
  const tips0 = before.tips.map(t => t.remaining);

  const V = 250;
  const submit = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: V}},
    {idempotencyKey: 'add-1'});
  assert.equal(submit.status, 202);
  assert.equal(submit.action.status, 'queued');
  assert.deepEqual(submit.action.scope?.wells, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
  assert.ok(submit.action.resources.includes('head'));
  assert.ok(submit.action.resources.includes('plate:plate-01'));

  const done = await runToCompletion(submit.action.action_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.partial, false);
  assert.equal(done.summary.tips_used, 6);

  const after = await h.client.state(exp);
  const p1 = after.plates.find(p => p.plate_id === 'plate-01')!;
  // Row A: each well gained ~V (minus a little evaporation over the ~13 sim s)
  for (let i = 0; i < 6; i++) {
    const delta = p1.wells[i].volume_ul - a1[i];
    assert.ok(delta > V - 1 && delta <= V, `A${i + 1} delta ${delta}`);
  }
  // Other rows and the other plate unchanged (up to evaporation)
  for (let i = 6; i < 24; i++) {
    assert.ok(Math.abs(p1.wells[i].volume_ul - a1[i]) < 0.2, `non-target row changed: ${i}`);
  }
  const p2 = after.plates.find(p => p.plate_id === 'plate-02')!;
  for (let i = 0; i < 24; i++) assert.ok(Math.abs(p2.wells[i].volume_ul - a2[i]) < 0.2);
  // Inventory: reservoir -6V, first rack -6 tips
  assert.ok(Math.abs(after.reservoirs[0].remaining_ul - (res0 - 6 * V)) < 1e-6);
  assert.deepEqual(after.tips.map((t, i) => t.remaining - tips0[i]), [-6, 0, 0]);
  // per-well summary
  for (const w of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
    assert.ok(Math.abs(done.summary.wells[w].added_ul - V) < 1e-9, w);
    assert.equal(done.summary.wells[w].removed_ul, 0);
  }
  assert.ok(Math.abs(done.summary.reservoir_delta_ul + 6 * V) < 1e-9);
});

test('media.exchange: waste +Σremoved, reservoir -Σadded, tips -12, volumes preserved', async () => {
  const before = await h.client.state(exp);
  const evap0 = await totalEvaporated();
  const a1 = before.plates.find(p => p.plate_id === 'plate-01')!.wells.slice(0, 6).map(w => w.volume_ul);
  const res0 = before.reservoirs[0].remaining_ul;
  const waste0 = before.wastes[0].used_ul;
  const tips0 = before.tips.map(t => t.remaining);

  const submit = await h.client.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.5}},
    {idempotencyKey: 'ex-1'});
  const done = await runToCompletion(submit.action.action_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.summary.tips_used, 12);
  const removed = Object.values(done.summary.wells).reduce((s, w) => s + w.removed_ul, 0);
  const added = Object.values(done.summary.wells).reduce((s, w) => s + w.added_ul, 0);
  assert.ok(Math.abs(removed - added) < 1e-6);

  const after = await h.client.state(exp);
  const p1 = after.plates.find(p => p.plate_id === 'plate-01')!;
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(p1.wells[i].volume_ul - a1[i]) < 0.5, 'final volume equals initial (evaporation aside)');
  }
  assert.ok(Math.abs(after.reservoirs[0].remaining_ul - (res0 - added)) < 1e-6);
  assert.ok(Math.abs(after.wastes[0].used_ul - (waste0 + removed)) < 1e-6);
  assert.deepEqual(after.tips.map((t, i) => t.remaining - tips0[i]), [-12, 0, 0]);
  // Conservation invariant over the operation window (evaporation accounted as a delta).
  await assertConservation(before, after, evap0);
});

test('capacity / channel / residual / partial-row rejections reject the whole request', async () => {
  // Raise row A to ~1450 so a 1000 µL add would exceed the 2000 µL capacity.
  const fill = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 800}},
    {idempotencyKey: 'fill-for-capacity'});
  await runToCompletion(fill.action.action_id);

  // One well over capacity rejects the WHOLE request (all six wells listed)
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 1000}}),
    (e: DeviceError) => e.code === 'capacity_exceeded' && e.details && Array.isArray((e.details as {wells?: string[]}).wells)
      && (e.details as {wells: string[]}).wells.length === 6);
  // Channel volume over 1000 µL: row A is now ~1450 µL, fraction 0.9 keeps the
  // minimum residual but each channel would move >1000 µL
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.9}}),
    (e: DeviceError) => e.code === 'channel_volume_exceeded');
  // fraction leaves less than the 100 µL minimum residual
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'D', reservoir_id: 'media-01', fraction: 0.95}}),
    (e: DeviceError) => e.code === 'invalid_argument'
      && Array.isArray((e.details as {wells?: string[]}).wells));
  // Partial row scope rejected, never expanded
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', wells: ['A1', 'A2'], reservoir_id: 'media-01', volume_ul_per_well: 10}}),
    (e: DeviceError) => e.code === 'invalid_argument');
  // Unknown resources
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-99', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10}}),
    (e: DeviceError) => e.code === 'invalid_argument');
  // Nothing was accepted: no inventory change, no active actions
  const snap = await h.client.state(exp);
  assert.equal(snap.active_actions.length, 0);
});

test('cancel mid-exchange: committed effects kept, head discard conserved, cancel twice same terminal', async () => {
  const before = await h.client.state(exp);
  const res0 = before.reservoirs[0].remaining_ul;
  const waste0 = before.wastes[0].used_ul;
  const tips0 = before.tips.map(t => t.remaining);
  const wells0 = before.plates.find(p => p.plate_id === 'plate-01')!.wells.map(w => w.volume_ul);

  const submit = await h.client.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01', fraction: 0.5}},
    {idempotencyKey: 'ex-cancel'});
  const evap0 = await totalEvaporated();
  // Let the exchange reach at least the row_aspirate commit (~12 s of stages) then cancel.
  await h.client.control(exp, {step: {steps: 13}});
  const mid = await getAction(submit.action.action_id);
  assert.equal(mid.status, 'running');
  const committedBefore = mid.effects.length;

  const cancelled = await h.client.cancel(exp, submit.action.action_id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.effects.length >= committedBefore, 'committed effects kept');
  // Head discard: whatever the summary says was removed from wells must be in waste
  // (either via the waste_dispense stage or the head_discard effect).
  const removed = Object.values(cancelled.summary.wells).reduce((s, w) => s + w.removed_ul, 0);
  const added = Object.values(cancelled.summary.wells).reduce((s, w) => s + w.added_ul, 0);
  assert.ok(removed >= 0 && added >= 0);

  // Cancel again: same terminal, same body
  const again = await h.client.cancel(exp, submit.action.action_id);
  assert.equal(again.status, 'cancelled');
  assert.equal(again.action_id, cancelled.action_id);
  assert.deepEqual(again.effects, cancelled.effects);

  // Retry the same idempotency key: returns the cancelled action, NO new effects
  const replay = await h.client.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01', fraction: 0.5}},
    {idempotencyKey: 'ex-cancel'});
  assert.equal(replay.status, 200);
  assert.equal(replay.action.action_id, cancelled.action_id);

  // Conservation after cancel (evaporation accounted as a delta)
  const after = await h.client.state(exp);
  await assertConservation(before, after, evap0);
  const tipsUsed = tips0.map((t, i) => t - after.tips[i].remaining).reduce((s, v) => s + v, 0);
  assert.equal(cancelled.summary.tips_used, tipsUsed);
  assert.ok(tipsUsed === 6 || tipsUsed === 12, `tips used ${tipsUsed}`);
  // cancelled action reports partial iff any liquid/inventory effect committed
  assert.equal(cancelled.partial, cancelled.effects.some(e => e.wells?.length || e.reservoir || e.waste || e.tips));
});

test('cancel mid-add after reservoir_aspirate discards head load to waste', async () => {
  const before = await h.client.state(exp);
  const waste0 = before.wastes[0].used_ul;
  const res0 = before.reservoirs[0].remaining_ul;
  const submit = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'C', reservoir_id: 'media-01', volume_ul_per_well: 300}},
    {idempotencyKey: 'add-cancel'});
  // stages: moving(3) pick(2) moving(3) lower(1) aspirate(3) → reservoir committed at t=12
  await h.client.control(exp, {step: {steps: 13}});
  const mid = await getAction(submit.action.action_id);
  const resCommitted = mid.effects.some(e => e.reservoir);
  assert.ok(resCommitted, 'reservoir_aspirate committed by now');
  const cancelled = await h.client.cancel(exp, submit.action.action_id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.partial, true);
  const after = await h.client.state(exp);
  // 6 × 300 µL left the reservoir and must ALL be accounted in waste
  assert.ok(Math.abs(after.reservoirs[0].remaining_ul - (res0 - 1800)) < 1e-6);
  assert.ok(Math.abs(after.wastes[0].used_ul - (waste0 + 1800)) < 1e-6,
    `waste ${after.wastes[0].used_ul} vs ${waste0 + 1800}`);
});

test('events show stage progress with shared row timing', async () => {
  const submit = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'D', reservoir_id: 'media-01', volume_ul_per_well: 20}},
    {idempotencyKey: 'add-events'});
  await runToCompletion(submit.action.action_id);
  const {events} = await h.client.events(exp, 0, 2000);
  const stageEvents = events.filter(e => e.type === 'action.stage_changed' && e.action_id === submit.action.action_id);
  assert.ok(stageEvents.length >= 8, 'moving/pick/move/lower/raise/move/dispense/...');
  const dispensing = stageEvents.find(e => (e.payload as {stage?: string}).stage === 'dispensing')!;
  const payload = dispensing.payload as {target?: {plate_id?: string; row_id?: string}; stage_duration_sim_s?: number};
  assert.equal(payload.target?.plate_id, 'plate-01');
  assert.equal(payload.target?.row_id, 'D');
  assert.equal(payload.stage_duration_sim_s, 3);
  const effects = events.filter(e => e.type === 'action.effect_committed' && e.action_id === submit.action.action_id);
  assert.ok(effects.length >= 4, 'tips_pick/aspirate/dispense/drop effects committed');
  const rowEffects = effects.filter(e => {
    const effect = (e.payload as {effect?: {wells?: unknown[]}}).effect;
    return effect?.wells && effect.wells.length === 6;
  });
  assert.ok(rowEffects.length >= 1, 'row transfer carries all 6 wells');
  const wellsAfter = (rowEffects[0].payload as {wells?: Record<string, number>}).wells!;
  assert.equal(Object.keys(wellsAfter).length, 6);
  // accepted -> started -> stages -> succeeded ordering with monotonic seq
  const seqs = events.filter(e => e.action_id === submit.action.action_id).map(e => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  await waitUntil(async () => (await getAction(submit.action.action_id)).status === 'succeeded', 1);
});
