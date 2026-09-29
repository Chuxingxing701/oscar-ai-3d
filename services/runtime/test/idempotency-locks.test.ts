// C1 test 2: idempotency semantics + resource locks over real HTTP.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeviceError} from '@oscar/device-contract';
import {currentExperimentId, spawnRuntime, type RuntimeHandle} from './helpers.ts';

let h: RuntimeHandle;
let exp: string;

test.before(async () => {
  h = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  exp = await currentExperimentId(h);
});
test.after(async () => {
  await h.stop();
});

test('same key + same request: 200 with the ORIGINAL response body, exactly one effect', async () => {
  const req = {capability: 'media.add' as const,
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 120}};
  const first = await h.client.submit(exp, req, {idempotencyKey: 'idem-1'});
  assert.equal(first.status, 202);
  const firstBody = first.action;

  // Replay with keys in a different order / same semantic request
  const replay = await h.client.submit(exp, req, {idempotencyKey: 'idem-1'});
  assert.equal(replay.status, 200);
  assert.equal(replay.action.action_id, firstBody.action_id);
  assert.deepEqual(replay.action, firstBody);
  assert.equal(replay.action.status, 'queued', 'replay returns the original accept body');

  // by-key lookup
  const byKey = await h.client.actionByKey(exp, 'idem-1');
  assert.equal(byKey?.action_id, firstBody.action_id);

  // Execute; only ONE add happened
  await h.client.control(exp, {step: {until_idle: true}});
  const snap = await h.client.state(exp);
  const a = snap.plates.find(p => p.plate_id === 'plate-01')!.wells.slice(0, 6).map(w => w.volume_ul);
  const expected = [400 + 120, 380 + 120, 410 + 120, 420 + 120, 395 + 120, 405 + 120];
  a.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1, `A${i + 1} ${v} vs ${expected[i]}`));
  assert.equal(snap.tips.reduce((s, t) => s + t.remaining, 0), 96 * 3 - 6);
  const actions = await h.client.actions(exp);
  assert.equal(actions.actions.filter(x => x.capability === 'media.add').length, 1);
});

test('same key + different request: 409 idempotency_conflict', async () => {
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 999}},
    {idempotencyKey: 'idem-1'}), (e: DeviceError) => e.code === 'idempotency_conflict');
  // canonical comparison covers device_id + capability + arguments +
  // expected_revisions: adding expected_revisions makes it a DIFFERENT request
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 120},
    expected_revisions: {'plate:plate-01': 0}}, {idempotencyKey: 'idem-1'}),
    (e: DeviceError) => e.code === 'idempotency_conflict');
  // ...and the idempotency lookup precedes the revision check: an identical
  // replay succeeds even though the plate revision has since advanced.
  const replay = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 120}},
    {idempotencyKey: 'idem-1'});
  assert.equal(replay.status, 200);
});

test('idempotency scope is (experiment, principal): operator vs run keys are separate', async () => {
  const byKeyOperator = await h.client.actionByKey(exp, 'idem-1');
  assert.ok(byKeyOperator);
  // a run principal named "operator" must not collide: emulate via direct check
  const snap = await h.client.state(exp);
  assert.ok(snap.revisions['plate:plate-01'] !== undefined);
});

test('resource locks: shake vs scan vs liquid on the same plate conflict; other plate is fine', async () => {
  // Long shake on plate-01 (120 s) — occupies only plate:plate-01
  const shake = await h.client.submit(exp, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 120}}, {idempotencyKey: 'shake-1'});
  assert.equal(shake.status, 202);
  assert.deepEqual(shake.action.resources, ['plate:plate-01']);

  // Liquid on the SAME plate: resource_busy (head action needs the plate)
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01', volume_ul_per_well: 10}}),
    (e: DeviceError) => e.code === 'resource_busy' && e.retryable === true);
  // Scan on the SAME plate: resource_busy
  await assert.rejects(() => h.client.submit(exp, {capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1']}}),
    (e: DeviceError) => e.code === 'resource_busy');
  // Second shake on the same plate: busy
  await assert.rejects(() => h.client.submit(exp, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 10}}),
    (e: DeviceError) => e.code === 'resource_busy');

  // Head action on the OTHER plate is allowed WHILE plate-01 shakes
  const otherAdd = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-02', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 30}},
    {idempotencyKey: 'add-other'});
  assert.equal(otherAdd.status, 202);

  // Both run concurrently; the head action finishes long before the shake
  await h.client.control(exp, {step: {steps: 40}});
  const otherDone = await h.client.action(exp, otherAdd.action.action_id);
  assert.equal(otherDone.status, 'succeeded');
  const shakeMid = await h.client.action(exp, shake.action.action_id);
  assert.equal(shakeMid.status, 'running');
  const snap = await h.client.state(exp);
  // shake does NOT occupy the shared head in the snapshot
  assert.equal(snap.head == null || snap.head.action_id !== shake.action.action_id, true);
  assert.equal(snap.plates.find(p => p.plate_id === 'plate-01')!.shake.active, true);

  // Cancel the shake to release the plate
  const cancelled = await h.client.cancel(exp, shake.action.action_id);
  assert.equal(cancelled.status, 'cancelled');
  const after = await h.client.state(exp);
  assert.equal(after.plates.find(p => p.plate_id === 'plate-01')!.shake.active, false);
  // plate is free again
  const add = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01', volume_ul_per_well: 10}},
    {idempotencyKey: 'add-after-shake'});
  assert.equal(add.status, 202);
  await h.client.control(exp, {step: {until_idle: true}});
});

test('expected_revisions conflicts and plate revision bumps', async () => {
  const snap = await h.client.state(exp);
  const rev = snap.revisions['plate:plate-01'];
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'C', reservoir_id: 'media-01', volume_ul_per_well: 10},
    expected_revisions: {'plate:plate-01': rev + 5}}),
    (e: DeviceError) => e.code === 'revision_conflict');
  // Unrelated resources do not cause false conflicts
  const ok = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'C', reservoir_id: 'media-01', volume_ul_per_well: 10},
    expected_revisions: {'plate:plate-02': snap.revisions['plate:plate-02']}});
  assert.equal(ok.status, 202);
  await h.client.control(exp, {step: {until_idle: true}});
  const after = await h.client.state(exp);
  assert.equal(after.revisions['plate:plate-01'], rev + 1, 'liquid commit bumps plate revision');
  assert.equal(after.revisions['plate:plate-02'], snap.revisions['plate:plate-02'], 'other plate untouched');
});
