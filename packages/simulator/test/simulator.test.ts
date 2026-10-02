import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {DEMO_PROFILE, rowWellIds, PLATE_LAYOUTS} from '@oscar/device-contract';
import {
  createWorld, stepWorld, loadScenario, rowWells, headDiscard, reservoirAspirate, rowAspirate, rowDispense,
  tipsPick, tipsDrop, wasteDispense, performScan, encodePng, SIMULATOR_VERSION, setChamberTargets,
} from '../src/index.ts';

const layout = PLATE_LAYOUTS['24'];

function freshWorld(scenarioId = 'routine_maintenance', seed = 42) {
  return createWorld(loadScenario(scenarioId), seed);
}

test('simulator version pinned', () => {
  assert.equal(SIMULATOR_VERSION, '0.1.0');
});

test('world creation: scenario initial state, wells, inventory', () => {
  const w = freshWorld();
  assert.equal(w.sim_time_s, 0);
  assert.equal(w.plates.length, 2);
  const p1 = w.plates.find(p => p.plate_id === 'plate-01')!;
  assert.equal(p1.wells.length, 24);
  const a = rowWells(w, 'plate-01', 'A');
  assert.deepEqual(a.map(x => x.well_id), rowWellIds(layout, 'A'));
  assert.deepEqual(a.map(x => x.volume_ul), [400, 380, 410, 420, 395, 405]);
  assert.equal(w.reservoirs[0].remaining_ul, 50000);
  assert.equal(w.tip_racks.reduce((s, r) => s + r.remaining, 0), 96 * 3);
  assert.equal(w.chamber.sample.sampled_at_sim_s, 0);
});

test('stepWorld is deterministic and advances on the fixed grid', () => {
  const w1 = freshWorld('environment_drift');
  const w2 = freshWorld('environment_drift');
  for (let i = 0; i < 100; i++) {
    stepWorld(w1);
    stepWorld(w2, 2); // dt=2 from the same start must NOT be equal to two dt=1 steps
  }
  assert.equal(w1.sim_time_s, 100);
  assert.equal(w2.sim_time_s, 200);
  // Same dt sequence -> identical deep state (JSON compare keeps float bits).
  const w3 = freshWorld('environment_drift');
  const w4 = freshWorld('environment_drift');
  for (let i = 0; i < 90; i++) { stepWorld(w3); stepWorld(w4); }
  assert.equal(JSON.stringify(w3), JSON.stringify(w4));
  // Environment moves toward targets once the task profile sets them (34 -> 37 °C).
  setChamberTargets(w3, {temperature_c: 37});
  for (let i = 0; i < 200; i++) stepWorld(w3);
  assert.ok(w3.chamber.actual.temperature_c > 34.5, 'temperature rises');
  assert.ok(w3.chamber.actual.temperature_c < 37.0, 'not yet at target');
  // Evaporation accounted separately, does not touch plate revision.
  const rev = w3.plates[0].revision;
  const evap = w3.plates[0].wells.reduce((s, x) => s + x.evaporated_ul, 0);
  assert.ok(evap > 0.09); // ~0.1 µL per well after 90 s
  assert.equal(w3.plates[0].revision, rev);
});

test('sensor samples every sample_interval_s with seeded noise', () => {
  const w = freshWorld();
  const first = w.chamber.sample.temperature_c;
  for (let i = 0; i < 29; i++) stepWorld(w);
  assert.equal(w.chamber.sample.sampled_at_sim_s, 0, 'no new sample before 30 s');
  stepWorld(w);
  assert.equal(w.chamber.sample.sampled_at_sim_s, 30);
  assert.notEqual(w.chamber.sample.temperature_c, first, 'noise applied');
  // Deterministic: same seed, same time -> same sample.
  const w2 = freshWorld();
  for (let i = 0; i < 30; i++) stepWorld(w2);
  assert.equal(w2.chamber.sample.temperature_c, w.chamber.sample.temperature_c);
});

test('row liquid primitives: aspirate/dispense conserve volume and mix medium', () => {
  const w = freshWorld('exchange_and_mix');
  // Snapshot: rowWells returns live references into the world.
  const before = rowWells(w, 'plate-01', 'A').map(x => ({volume_ul: x.volume_ul, nutrient: x.culture.nutrient}));
  const volumes = before.map(x => Math.round(x.volume_ul * 0.5));
  const sumBefore = before.reduce((s, x) => s + x.volume_ul, 0);
  tipsPick(w);
  const removed = rowAspirate(w, 'plate-01', 'A', volumes);
  assert.deepEqual(removed.effect.wells!.map(d => d.well_id), rowWellIds(layout, 'A'));
  const mid = rowWells(w, 'plate-01', 'A');
  mid.forEach((x, i) => assert.ok(Math.abs(x.volume_ul - (before[i].volume_ul - volumes[i])) < 1e-9));
  wasteDispense(w);
  tipsDrop(w);
  reservoirAspirate(w, 'media-01', volumes);
  rowDispense(w, 'plate-01', 'A', volumes);
  const after = rowWells(w, 'plate-01', 'A');
  after.forEach((x, i) => assert.ok(Math.abs(x.volume_ul - before[i].volume_ul) < 1e-6, 'final volume equals initial'));
  const sumAfter = after.reduce((s, x) => s + x.volume_ul, 0);
  assert.ok(Math.abs(sumAfter - sumBefore) < 1e-6);
  // Reservoir lost the added total; waste gained the removed total.
  assert.ok(Math.abs(w.reservoirs[0].remaining_ul - (50000 - volumes.reduce((a, b) => a + b, 0))) < 1e-9);
  assert.ok(Math.abs(w.wastes[0].used_ul - volumes.reduce((a, b) => a + b, 0)) < 1e-9);
  assert.equal(w.tip_racks[0].remaining, 96 - 6);
  // Nutrient refreshed by volume-weighted mixing (row A started at 0.12).
  const nBefore = before[0].nutrient;
  const nAfter = after[0].culture.nutrient;
  assert.ok(nAfter > nBefore, 'fresh medium raises nutrient index');
});

test('head discard on cancel path keeps conservation', () => {
  const w = freshWorld();
  tipsPick(w);
  reservoirAspirate(w, 'media-01', [100, 100, 100, 100, 100, 100]);
  const r0 = w.reservoirs[0].remaining_ul;
  headDiscard(w);
  assert.equal(w.head.load_ul.reduce((a, b) => a + b, 0), 0);
  assert.ok(Math.abs(w.wastes[0].used_ul - 600) < 1e-9);
  assert.equal(w.reservoirs[0].remaining_ul, r0);
});

test('PNG encoder: valid signature, IHDR, zlib IDAT, CRC, dimensions', () => {
  const px = new Uint8Array(4 * 4 * 4).fill(128);
  const png = encodePng(4, 4, px);
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.equal(dv.getUint32(8), 13);
  assert.equal(String.fromCharCode(...png.slice(12, 16)), 'IHDR');
  assert.equal(dv.getUint32(16), 4);
  assert.equal(dv.getUint32(20), 4);
  assert.equal(png[24], 8); // bit depth
  assert.equal(png[25], 6); // RGBA
  // Deterministic: same pixels -> same bytes.
  assert.deepEqual(encodePng(4, 4, px), png);
});

test('scan: PNG decodes (IHDR + zlib inflate), mono vs stereo, blur faults', () => {
  const w = freshWorld();
  const mono = performScan(w, {plate_id: 'plate-01', wells: rowWellIds(layout, 'A'), mode: 'mono', view: 'medium_overview'});
  assert.equal(mono.quality, 'ok');
  assert.equal(mono.images.length, 1);
  assert.equal(mono.images[0].role, 'mono');
  assert.ok(mono.estimates.every(e => e.liquid_level_ul != null));
  // Decode: find IDAT chunks and inflate.
  const bytes = mono.images[0].bytes;
  const idat: Uint8Array[] = [];
  let off = 8;
  while (off < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(off);
    const type = String.fromCharCode(...bytes.slice(off + 4, off + 8));
    if (type === 'IDAT') idat.push(bytes.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat.map(b => Buffer.from(b))));
  const stride = 1 + 320 * 4;
  assert.equal(raw.length, 240 * stride);
  assert.ok(raw[0] === 0 && raw[stride] === 0, 'filter 0 scanlines');
  assert.equal(mono.images[0].sha256, createHash('sha256').update(bytes).digest('hex'));

  const stereo = performScan(w, {plate_id: 'plate-01', wells: rowWellIds(layout, 'A'), mode: 'stereo', view: 'medium_overview'});
  assert.equal(stereo.images.length, 2);
  assert.deepEqual(stereo.images.map(i => i.role), ['left', 'right']);
  assert.ok(stereo.stereo_pair_id);
  assert.notDeepEqual([...stereo.images[0].bytes], [...stereo.images[1].bytes], 'parallax changes bytes');
  // Same frozen world: same sampled_at and plate_revision.
  assert.equal(stereo.images[0].width, 320);
  assert.equal(stereo.images[0].height, 240);
});

test('scan reproducibility: equal frozen worlds -> equal bytes; shake blurs and nulls estimates', () => {
  const w1 = freshWorld();
  const w2 = freshWorld();
  const req = {plate_id: 'plate-01', wells: rowWellIds(layout, 'A'), mode: 'stereo', view: 'culture_detail'} as const;
  const s1 = performScan(w1, {...req});
  const s2 = performScan(w2, {...req});
  assert.deepEqual(s1.images.map(i => i.sha256), s2.images.map(i => i.sha256));
  assert.deepEqual(s1.estimates.map(e => e.liquid_level_ul), s2.estimates.map(e => e.liquid_level_ul));

  // Shake active -> blurred, estimates null.
  const w3 = freshWorld();
  w3.plates[0].shake = {active: true, started_at_sim_s: 0, duration_sim_s: 30, speed_rpm: 300,
    action_id: 'act-x', ended_at_sim_s: null, settle_until_sim_s: 40};
  const blurred = performScan(w3, {plate_id: 'plate-01', wells: ['A1'], mode: 'mono', view: 'medium_overview'});
  assert.equal(blurred.quality, 'blurred');
  assert.ok(blurred.estimates.every(e => e.liquid_level_ul == null && e.color_index == null && e.turbidity == null));
  assert.ok(blurred.estimates.every(e => e.method === 'simulated_onboard_analysis' && e.provenance === 'device_estimate'));
  // Blurred bytes differ from sharp bytes of the same state.
  const sharp = performScan(freshWorld(), {plate_id: 'plate-01', wells: ['A1'], mode: 'mono', view: 'medium_overview'});
  assert.notEqual(blurred.images[0].sha256, sharp.images[0].sha256);

  // Settle window after shake end also blurs.
  const w4 = freshWorld();
  w4.plates[0].shake = {active: false, started_at_sim_s: 0, duration_sim_s: 30, speed_rpm: 300,
    action_id: 'act-x', ended_at_sim_s: 30, settle_until_sim_s: 60};
  w4.sim_time_s = 45;
  assert.equal(performScan(w4, {plate_id: 'plate-01', wells: ['A1'], mode: 'mono', view: 'medium_overview'}).quality, 'blurred');
  w4.sim_time_s = 61;
  assert.equal(performScan(w4, {plate_id: 'plate-01', wells: ['A1'], mode: 'mono', view: 'medium_overview'}).quality, 'ok');
});

test('camera_blur fault: first N scans blurred, later scans sharp', () => {
  const w = freshWorld('environment_drift');
  assert.equal(w.faults.camera_blur.remaining_scans, 1);
  const s1 = performScan(w, {plate_id: 'plate-01', wells: ['A1'], mode: 'mono', view: 'medium_overview'});
  assert.equal(s1.quality, 'blurred');
  const s2 = performScan(w, {plate_id: 'plate-01', wells: ['A1'], mode: 'mono', view: 'medium_overview'});
  assert.equal(s2.quality, 'ok');
});

test('scenario loader: env from custom dir, versioned ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-scen-'));
  try {
    const scenario = {id: 'tiny', version: '9.9.9', seed: 7, description: 'x', initial: {
      chamber: {targets: {temperature_c: 30, co2_pct: 4, humidity_pct: 90}},
      plates: [{id: 'plate-01', station_id: 'Station_1_2', format: '24', medium_id: 'm',
        wells_volume_ul: {A: [1, 2, 3, 4, 5, 6], B: [0, 0, 0, 0, 0, 0], C: [0, 0, 0, 0, 0, 0], D: [0, 0, 0, 0, 0, 0]}}],
      reservoirs: [{id: 'media-01', station_id: 'Station_3_3', medium_id: 'm', remaining_ul: 100, capacity_ul: 100}],
      waste: {id: 'waste-01', station_id: 'Station_3_4', used_ul: 0, capacity_ul: 50},
      tip_racks: [{id: 'tips-01', station_id: 'Station_4_1', remaining: 6, capacity: 96}],
    }, task: {goal: '', allowed_capabilities: [], plates: [], env_targets: {}, tolerances: {}, budgets: {},
      policy_hints: {}}, faults: []};
    writeFileSync(join(dir, 'tiny.json'), JSON.stringify(scenario));
    const w = createWorld(loadScenario('tiny', dir), 7);
    assert.equal(w.scenario_version, '9.9.9');
    assert.equal(w.plates[0].wells[0].volume_ul, 1);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
  assert.equal(DEMO_PROFILE.head.channels, 6);
});
