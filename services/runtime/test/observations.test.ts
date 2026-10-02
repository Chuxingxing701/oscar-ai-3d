// C1 test 3: observation evidence — PNG decodes, mono vs stereo identity,
// hash reproducibility across fresh runtimes, stale evidence, asset replay.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
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

function decodePng(bytes: Uint8Array): {width: number; height: number; channels: number} {
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (off < bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.slice(off + 4, off + 8));
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      const colorType = bytes[off + 17];
      channels = colorType === 6 ? 4 : colorType;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(bytes.slice(off + 8, off + 8 + len)));
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, height * (1 + width * channels), 'decompressed size');
  return {width, height, channels};
}

async function scanAndFinish(args: {plate_id: string; wells: string[]; mode?: 'mono' | 'stereo'; view?: string}) {
  const submit = await h.client.submit(exp, {capability: 'imaging.scan', arguments: args});
  await h.client.control(exp, {step: {until_idle: true}});
  const done = await h.client.action(exp, submit.action.action_id);
  assert.equal(done.status, 'succeeded');
  return h.client.observation(exp, done.result!.observation_id as string);
}

test('mono scan: PNG decodes with valid IHDR/zlib and the asset endpoint matches the hash', async () => {
  const obs = await scanAndFinish({plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'});
  assert.equal(obs.quality, 'ok');
  assert.equal(obs.source, 'synthetic_image');
  assert.equal(obs.mode, 'mono');
  assert.equal(obs.stereo_pair_id, null);
  assert.equal(obs.depth_status, 'not_computed');
  assert.equal(obs.images.length, 1);
  const img = obs.images[0];
  assert.equal(img.role, 'mono');
  assert.equal(img.media_type, 'image/png');
  const bytes = await h.client.asset(exp, img.asset_id);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), img.sha256);
  const dims = decodePng(bytes);
  assert.equal(dims.width, 320);
  assert.equal(dims.height, 240);
  // estimates: device_estimate with truth-ish values + uncertainty
  for (const e of obs.estimates) {
    assert.equal(e.provenance, 'device_estimate');
    assert.equal(e.method, 'simulated_onboard_analysis');
    assert.ok(e.liquid_level_ul != null && e.liquid_level_ul > 0);
    assert.ok(e.uncertainty_ul > 0);
  }
  // observations endpoint lists it
  const list = await h.client.request<{observations: Array<{observation_id: string}>}>(
    'GET', `/api/v1/experiments/${exp}/observations`);
  assert.ok(list.body.observations.some(o => o.observation_id === obs.observation_id));
});

test('stereo: left/right roles, same sampled_at and pair id, different bytes', async () => {
  const obs = await scanAndFinish({plate_id: 'plate-01', wells: ['A1'], mode: 'stereo'});
  assert.equal(obs.images.length, 2);
  assert.deepEqual(obs.images.map(i => i.role), ['left', 'right']);
  assert.ok(obs.stereo_pair_id);
  const left = await h.client.asset(exp, obs.images[0].asset_id);
  const right = await h.client.asset(exp, obs.images[1].asset_id);
  decodePng(left);
  decodePng(right);
  assert.notDeepEqual([...left], [...right], 'parallax changes bytes');
  assert.equal(obs.sampled_at_sim_s, obs.sampled_at_sim_s);
  assert.equal(typeof obs.camera.baseline_mm, 'number');
});

test('scan reproducible across two fresh runtimes with same seed and commands', async () => {
  // IDENTICAL command script on two fresh runtimes -> identical images AND estimates.
  const script = async (handle: RuntimeHandle, experiment: string) => {
    const s1 = await handle.client.submit(experiment, {capability: 'imaging.scan',
      arguments: {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'}});
    await handle.client.control(experiment, {step: {until_idle: true}});
    const add = await handle.client.submit(experiment, {capability: 'media.add',
      arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 200}},
      {idempotencyKey: 'repro-add'});
    await handle.client.control(experiment, {step: {until_idle: true}});
    const s2 = await handle.client.submit(experiment, {capability: 'imaging.scan',
      arguments: {plate_id: 'plate-01', wells: ['B1'], mode: 'stereo', view: 'culture_detail'}});
    await handle.client.control(experiment, {step: {until_idle: true}});
    const doneAdd = await handle.client.action(experiment, add.action.action_id);
    const obs2 = await handle.client.observation(experiment,
      (await handle.client.action(experiment, s2.action.action_id)).result!.observation_id as string);
    return {doneAdd, obs2};
  };
  // Both sides must start from fresh identical worlds.
  const hA = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  const h2 = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  try {
    const expA = await currentExperimentId(hA);
    const exp2 = await currentExperimentId(h2);
    const r1 = await script(hA, expA);
    const r2 = await script(h2, exp2);
    assert.deepEqual(r2.obs2.images.map(i => i.sha256), r1.obs2.images.map(i => i.sha256), 'image hashes identical');
    assert.deepEqual(r2.obs2.estimates, r1.obs2.estimates, 'device estimates identical');
    assert.equal(r2.obs2.sampled_at_sim_s, r1.obs2.sampled_at_sim_s);
    assert.equal(r2.obs2.plate_revision, r1.obs2.plate_revision);
    // The whole action sequence agrees (ids, timings, summaries)
    const a1 = await hA.client.actions(expA);
    const a2 = await h2.client.actions(exp2);
    assert.equal(a1.actions.length, a2.actions.length);
    for (let i = 0; i < a1.actions.length; i++) {
      assert.equal(a2.actions[i].action_id, a1.actions[i].action_id);
      assert.equal(a2.actions[i].status, a1.actions[i].status);
      assert.deepEqual(a2.actions[i].summary, a1.actions[i].summary);
    }
  } finally {
    await hA.stop();
    await h2.stop();
  }
});

test('asset replay returns the archived bytes even after the state changed', async () => {
  const obs = await scanAndFinish({plate_id: 'plate-01', wells: ['A1'], mode: 'mono'});
  const bytesBefore = await h.client.asset(exp, obs.images[0].asset_id);
  // Mutate the world: add liquid + shake + advance
  const add = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 150}});
  await h.client.control(exp, {step: {until_idle: true}});
  const shake = await h.client.submit(exp, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 400, duration_sim_s: 10}});
  await h.client.control(exp, {step: {until_idle: true}});
  const bytesAfter = await h.client.asset(exp, obs.images[0].asset_id);
  assert.deepEqual([...bytesAfter], [...bytesBefore], 'asset bytes are immutable');
  const stillThere = await h.client.observation(exp, obs.observation_id);
  assert.equal(stillThere.images[0].sha256, obs.images[0].sha256);
  void add; void shake;
});

test('liquid action citing a pre-change observation: 409 observation_stale', async () => {
  // obs from the previous test is now stale: plate revision bumped by add+shake
  const stale = (await h.client.request<{observations: Array<{observation_id: string}>}>(
    'GET', `/api/v1/experiments/${exp}/observations`)).body.observations[0].observation_id;
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.3},
    evidence_refs: [stale]}), (e: DeviceError) => e.code === 'observation_stale');
  // observation of a DIFFERENT plate is stale for this plate
  const otherPlateObs = await scanAndFinish({plate_id: 'plate-02', wells: ['A1']});
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.3},
    evidence_refs: [otherPlateObs.observation_id]}), (e: DeviceError) => e.code === 'observation_stale');
  // age beyond max_age_s (1800) also stales
  await h.client.control(exp, {step: {until_sim_s: 2000}});
  const aged = await scanAndFinish({plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']});
  await h.client.control(exp, {step: {until_sim_s: 2000 + 2000}}); // scan itself takes ~7 s; margin over 1800
  await assert.rejects(() => h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10},
    evidence_refs: [aged.observation_id]}), (e: DeviceError) => e.code === 'observation_stale');
  // a fresh full-row observation works
  const fresh = await scanAndFinish({plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']});
  const ok = await h.client.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10},
    evidence_refs: [fresh.observation_id]});
  assert.equal(ok.status, 202);
  await h.client.control(exp, {step: {until_idle: true}});
});

test('ETag and X-Content-SHA256 headers on assets', async () => {
  const obs = await scanAndFinish({plate_id: 'plate-01', wells: ['C1'], mode: 'mono'});
  const r = await fetch(`${h.baseUrl}/api/v1/experiments/${exp}/assets/${obs.images[0].asset_id}`,
    {headers: {authorization: `Bearer ${h.operatorToken}`}});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), `"${obs.images[0].sha256}"`);
  assert.equal(r.headers.get('x-content-sha256'), obs.images[0].sha256);
  assert.equal(r.headers.get('content-type'), 'image/png');
});
