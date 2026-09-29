// C1 end-to-end over real HTTP with DeviceClient (the "do it EARLY" check,
// formalized): scan -> row exchange -> shake -> rescan on the
// exchange_and_mix scenario, checking per-well volumes and inventory.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {currentExperimentId, spawnRuntime, type RuntimeHandle} from './helpers.ts';

let h: RuntimeHandle;
let exp: string;

test.before(async () => {
  h = await spawnRuntime({scenario: 'exchange_and_mix', seed: 42});
  exp = await currentExperimentId(h);
});
test.after(async () => {
  await h.stop();
});

test('scan -> row exchange (50 %) -> shake -> settle -> rescan', async () => {
  const c = h.client;

  // 1. scan row A
  const scan1 = (await c.submit(exp, {capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'}})).action;
  await c.control(exp, {step: {until_idle: true}});
  const scan1Done = await c.action(exp, scan1.action_id);
  assert.equal(scan1Done.status, 'succeeded');
  const obs1 = await c.observation(exp, scan1Done.result!.observation_id as string);
  assert.equal(obs1.quality, 'ok');
  // yellowish row: nutrient 0.12 -> color index below a fresh row
  assert.ok(obs1.estimates.every(e => (e.color_index ?? 1) < 0.35), 'depleted row reads yellowish');

  // 2. exchange 50 % of row A, citing the observation
  const before = await c.state(exp);
  const rowA0 = before.plates.find(p => p.plate_id === 'plate-01')!.wells.slice(0, 6).map(w => w.volume_ul);
  const res0 = before.reservoirs[0].remaining_ul;
  const waste0 = before.wastes[0].used_ul;
  const tips0 = before.tips.map(t => t.remaining);

  const exchange = (await c.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.5},
    evidence_refs: [obs1.observation_id], reason: 'exchange demo row A'}, {idempotencyKey: 'e2e-ex'})).action;
  await c.control(exp, {step: {until_idle: true}});
  const exchangeDone = await c.action(exp, exchange.action_id);
  assert.equal(exchangeDone.status, 'succeeded');
  assert.equal(exchangeDone.partial, false);

  const afterEx = await c.state(exp);
  const rowA1 = afterEx.plates.find(p => p.plate_id === 'plate-01')!.wells.slice(0, 6).map(w => w.volume_ul);
  rowA1.forEach((v, i) => assert.ok(Math.abs(v - rowA0[i]) < 0.5, `A${i + 1} volume preserved`));
  const removed = Object.values(exchangeDone.summary.wells).reduce((s, w) => s + w.removed_ul, 0);
  assert.ok(Math.abs(afterEx.wastes[0].used_ul - (waste0 + removed)) < 1e-6);
  assert.ok(Math.abs(afterEx.reservoirs[0].remaining_ul - (res0 - removed)) < 1e-6);
  assert.deepEqual(afterEx.tips.map((t, i) => tips0[i] - t.remaining), [12, 0, 0]);
  assert.equal(afterEx.revisions['plate:plate-01'], before.revisions['plate:plate-01'] + 2,
    'aspirate + dispense each bump the plate revision');

  // 3. shake 300 rpm 30 s
  const shake = (await c.submit(exp, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 30}}, {idempotencyKey: 'e2e-shake'})).action;
  await c.control(exp, {step: {until_idle: true}});
  const shakeDone = await c.action(exp, shake.action_id);
  assert.equal(shakeDone.status, 'succeeded');

  // scan during the settle window comes out blurred with NULL estimates
  const blurredScan = (await c.submit(exp, {capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1']}})).action;
  await c.control(exp, {step: {until_idle: true}});
  const blurredDone = await c.action(exp, blurredScan.action_id);
  const blurredObs = await c.observation(exp, blurredDone.result!.observation_id as string);
  assert.equal(blurredObs.quality, 'blurred');
  assert.ok(blurredObs.estimates.every(e => e.liquid_level_ul == null && e.color_index == null && e.turbidity == null));

  // 4. wait past the settle window (30 s) and rescan
  const simNow = (await c.state(exp)).experiment.sim_time_s;
  await c.control(exp, {step: {until_sim_s: simNow + 35}});
  const scan2 = (await c.submit(exp, {capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'}})).action;
  await c.control(exp, {step: {until_idle: true}});
  const scan2Done = await c.action(exp, scan2.action_id);
  assert.equal(scan2Done.status, 'succeeded');
  const obs2 = await c.observation(exp, scan2Done.result!.observation_id as string);
  assert.equal(obs2.quality, 'ok');
  // after exchanging 50 % of depleted medium with fresh: colour index improves
  const beforeAvg = obs1.estimates.reduce((s, e) => s + (e.color_index ?? 0), 0) / 6;
  const afterAvg = obs2.estimates.reduce((s, e) => s + (e.color_index ?? 0), 0) / 6;
  assert.ok(afterAvg > beforeAvg, `fresh medium brightens the colour index (${beforeAvg} -> ${afterAvg})`);

  // liquid actions citing the pre-exchange observation are stale now
  await assert.rejects(() => c.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10},
    evidence_refs: [obs1.observation_id]}),
    (e: import('@oscar/device-contract').DeviceError) => e.code === 'observation_stale');

  // events tell the whole story in order
  const {events} = await c.events(exp, 0, 2000);
  const types = events.map(e => e.type);
  for (const t of ['experiment.created', 'action.accepted', 'action.started', 'action.stage_changed',
    'action.effect_committed', 'observation.created', 'plate.shake_started', 'plate.shake_stopped',
    'action.succeeded', 'clock.stepped']) {
    assert.ok(types.includes(t), t);
  }
  const seqs = events.map(e => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'event seq monotonic');
});
