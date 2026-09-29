import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pipetteLayout, sampleMotion, sampleShake, validateSnapshot} from '../state.js';
import {previewSnapshot} from '../fixtures.js';
// Use exactly the shipped browser dependency, without node_modules or a new lockfile.
registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return {url: new URL('../../vendor/three.module.js', import.meta.url).href, shortCircuit: true};
  if (specifier.startsWith('three/addons/')) return {url: new URL('../../vendor/addons/' + specifier.slice(13), import.meta.url).href, shortCircuit: true};
  return nextResolve(specifier, context);
}});
const THREE = await import('three');
const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
const {buildSceneModel} = await import('../model.js');
const map = JSON.parse(readFileSync(new URL('../scene-map.json', import.meta.url)));
const blob = readFileSync(new URL('../../../models/OSCAR_full.glb', import.meta.url));
const json = JSON.parse(blob.subarray(20, 20 + blob.readUInt32LE(12)));
const nodes = new Map(json.nodes.map(n => [n.name, n]));
function near(actual, expected, epsilon = 1e-6) {assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);}
async function loadRig() {
  const loader = new GLTFLoader();
  loader.register(() => ({name: 'Headless_skip_textures', loadTexture: () => Promise.resolve(null)}));
  const gltf = await loader.parseAsync(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength), '');
  const rig = buildSceneModel(gltf.scene, map);
  return {gltf, rig};
}

test('scene map binds the exact GLB, stable station IDs, counts and actual world coordinates', () => {
  assert.equal(createHash('sha256').update(blob).digest('hex'), map.model_sha256);
  assert.deepEqual(map.stations.map(s => s.id), ['plate-01', 'plate-02', 'media-01', 'waste-01', 'tips-01', 'tips-02', 'tips-03']);
  for (const s of map.stations) {
    for (const name of s.nodes) assert.ok(nodes.has(name), name);
    const prefixNodes = json.nodes.filter(n => n.name.startsWith(s.prefix + '_')).map(n => n.name).sort();
    assert.deepEqual(s.nodes, prefixNodes);
    s.center_m.forEach((v, i) => near(v, nodes.get(s.anchor_node).translation[i]));
    if (!s.wells) continue;
    assert.equal(s.wells.length, s.rows * s.columns);
    assert.equal(new Set(s.wells.map(w => w.well_id)).size, s.wells.length);
    for (const w of s.wells) {
      w.center_m.forEach((v, i) => near(v, nodes.get(w.node).translation[i]));
      const [, i, j] = /_well_(\d+)_(\d+)$/.exec(w.node);
      assert.equal(w.well_id, String.fromCharCode(65 + s.rows - 1 - Number(j)) + (Number(i) + 1));
    }
    assert.ok(s.wells[0].center_m[2] < s.wells.at(-1).center_m[2], 'A far, last row near');
    assert.ok(s.wells[0].center_m[0] < s.wells[1].center_m[0], 'columns left to right');
  }
  assert.equal(nodes.get('Motion_X').children.includes(json.nodes.indexOf(nodes.get('Motion_Y'))), true);
  assert.equal(nodes.get('Motion_Y').children.includes(json.nodes.indexOf(nodes.get('Motion_Z'))), true);
});

test('every six-channel row aligns with all six wells at the original vertical gap', () => {
  for (const s of map.stations.filter(s => s.kind === 'plate')) for (const row of 'ABCD') {
    const target = {plate_id: s.id, row_id: row};
    const action = {stage: 'dispensing', target, stage_started_at_sim_s: 0, stage_duration_sim_s: 6};
    const {pose, effect} = sampleMotion(map, action, 3);
    const layout = pipetteLayout(map, target);
    assert.equal(layout.wells.length, 6);
    layout.wells.forEach((well, i) => {
      near(pose[0] + layout.tips[i][0], well.center_m[0]);
      near(pose[2] + layout.tips[i][2], well.center_m[2]);
      near(pose[1] + layout.tips[i][1] - well.center_m[1], .0435);
    });
    assert.equal(effect, 'dispensing');
    assert.equal(sampleMotion(map, action, 6).effect, null);
    assert.equal(sampleMotion(map, action, -1).effect, null);
  }
});

test('stage interpolation is replayable, clamped and high during lateral motion', () => {
  const a = {stage: 'lowering', target: {plate_id: 'plate-01', row_id: 'A'}, stage_started_at_sim_s: 10, stage_duration_sim_s: 4};
  near(sampleMotion(map, a, 0).pose[1], 0); near(sampleMotion(map, a, 12).pose[1], -.06); near(sampleMotion(map, a, 999).pose[1], -.12);
  const direct = sampleMotion(map, a, 12);
  for (let t = 0; t < 50; t++) sampleMotion(map, a, t);
  assert.deepEqual(sampleMotion(map, a, 12), direct);
  near(sampleMotion(map, {...a, stage: 'moving', from_pose_m: [0, -.12, 0]}, 12).pose[1], 0);
  near(sampleMotion(map, {...a, stage_duration_sim_s: 0}, 10).pose[1], -.12);
});

test('shake samples depend on sim time and reset exactly on cancellation/completion', () => {
  const s = {active: true, started_at_sim_s: 2, duration_sim_s: 20, frequency_hz: 2, amplitude_m: .0012};
  assert.deepEqual(sampleShake(s, 1), [0, 0, 0]);
  assert.notDeepEqual(sampleShake(s, 5.125), [0, 0, 0]);
  assert.deepEqual(sampleShake(s, 5.125), sampleShake(s, 5.125));
  assert.deepEqual(sampleShake(s, 22), [0, 0, 0]);
  assert.deepEqual(sampleShake({...s, active: false}, 5.125), [0, 0, 0]);
});

test('invalid snapshots fail before they can replace the current display', () => {
  const s = previewSnapshot(map, 'dispense', 10).state;
  assert.equal(validateSnapshot(map, s), s);
  for (const change of [x => x.sim_time_s = NaN, x => x.plates[0].wells[0].volume_ul = -1,
    x => x.plates[0].wells[0].capacity_ul = 0, x => x.actions[0].target.row_id = 'Z',
    x => x.actions[0].target = {plate_id: 'plate-01', well_id: 'A1'},
    x => x.actions.push(x.actions[0]), x => x.actions[0].stage = 'unknown',
    x => x.actions[0].from_pose_m = [0, -.5, 0]]) {
    const bad = structuredClone(s); change(bad); assert.throws(() => validateSnapshot(map, bad));
  }
});

test('real GLB batching preserves controlled nodes, head camera and plate/well picking', async () => {
  const {gltf, rig} = await loadRig();
  for (const s of map.stations) for (const name of s.nodes) assert.ok(gltf.scene.getObjectByName(name), name);
  assert.equal(rig.virtualCamera.parent.name, 'Motion_Z');
  assert.ok(gltf.scene.getObjectByName('DisplayBatch_Brushed stainless steel'));
  const target = {plate_id: 'plate-01', well_id: 'A1'};
  const {state} = previewSnapshot(map, 'dispense', 14);
  const before = JSON.stringify(state); rig.update(state); assert.equal(JSON.stringify(state), before);
  const well = map.stations[0].wells[0]; gltf.scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(well.center_m[0], 1.0, well.center_m[2]), new THREE.Vector3(0, -1, 0));
  const hit = ray.intersectObject(rig.instances.get('plate-01'))[0];
  assert.ok(hit); assert.equal(hit.object.userData.instanceSelections[hit.instanceId].well_id, 'A1');
  rig.select(target); assert.deepEqual(rig.selection(), target);
  assert.equal(rig.effects.flow.visible, true);
  assert.equal(rig.effects.scan.visible, false);
  const scan = previewSnapshot(map, 'scan', 14).state; rig.update(scan);
  assert.equal(rig.effects.flow.visible, false); assert.equal(rig.effects.scan.visible, true);
  rig.update(previewSnapshot(map, 'shake', 5.125).state);
  assert.notDeepEqual(rig.plates.get('plate-01').position.toArray(), [0, 0, 0]);
  rig.update({experiment_id: 'reset', sim_time_s: 0, paused: true, plates: [], actions: []});
  assert.deepEqual(rig.plates.get('plate-01').position.toArray(), [0, 0, 0]);
  const matrix = new THREE.Matrix4(); rig.instances.get('plate-01').getMatrixAt(0, matrix);
  assert.equal(matrix.elements[0], 0, 'missing plate must not retain previous liquid');
  assert.equal(rig.effects.flow.visible, false); assert.equal(rig.effects.scan.visible, false);
});

test('liquid height tracks supplied volume only, not progress or wall time', async () => {
  const {rig} = await loadRig();
  const state = previewSnapshot(map, 'dispense', 10).state;
  const mesh = rig.instances.get('plate-01'), matrix = new THREE.Matrix4();
  rig.update(state); mesh.getMatrixAt(0, matrix); const height = matrix.elements[5];
  state.sim_time_s = 18; rig.update(state); mesh.getMatrixAt(0, matrix); near(matrix.elements[5], height);
  state.plates[0].wells[0].volume_ul = 2000; rig.update(state); mesh.getMatrixAt(0, matrix);
  assert.ok(matrix.elements[5] > height);
  mesh.getMatrixAt(1, matrix); near(matrix.elements[5], height, 1e-6);
  state.plates[0].wells[0].volume_ul = 0; rig.update(state); mesh.getMatrixAt(0, matrix); assert.equal(matrix.elements[0], 0);
});


test('actual needle shafts and all six beams align, including non-first rows and reset', async () => {
  const {rig, gltf} = await loadRig();
  for (const plate of ['plate-01', 'plate-02']) for (const row of 'ABCD') {
    rig.update(previewSnapshot(map, 'dispense', 12, plate, row + '4').state);
    gltf.scene.updateMatrixWorld(true);
    const station = map.stations.find(s => s.id === plate);
    assert.equal(rig.rowHeadStatus().activeFlows, 6);
    const rowWells = station.wells.filter(w => w.well_id.startsWith(row));
    rowWells.forEach((w, i) => {
      const shaft = gltf.scene.getObjectByName(`Visible_needle_${String(i).padStart(2, '0')}`);
      assert.equal(shaft.visible, true);
      const bounds = new THREE.Box3().setFromObject(shaft);
      near((bounds.min.x + bounds.max.x) / 2, w.center_m[0]);
      near((bounds.min.z + bounds.max.z) / 2, w.center_m[2]);
      near(bounds.min.y - w.center_m[1], .0435);
      const beam = rig.effects.flow.children[i];
      near(beam.position.x, w.center_m[0]); near(beam.position.z, w.center_m[2]);
    });
    for (const i of ['06', '07']) {
      assert.equal(gltf.scene.getObjectByName(`Visible_needle_${i}`).visible, false);
      assert.equal(gltf.scene.getObjectByName(`Needle_connector_${i}`).visible, false);
      assert.equal(gltf.scene.getObjectByName(`Pipette_upper_tube_${i}`).visible, false);
    }
  }
  rig.update(null);
  assert.equal(rig.rowHeadStatus().activeFlows, 0);
});

test('preview changes an entire selected row simultaneously and leaves other rows/plates intact', () => {
  for (const kind of ['dispense', 'exchange']) {
    const initial = previewSnapshot(map, kind, 7, 'plate-02', 'C4').state;
    const middle = previewSnapshot(map, kind, 10, 'plate-02', 'C4').state;
    const before = initial.plates[1].wells, after = middle.plates[1].wells;
    const changed = after.filter((w, i) => w.volume_ul !== before[i].volume_ul);
    assert.deepEqual(changed.map(w => w.well_id), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    assert.equal(new Set(changed.map(w => w.volume_ul)).size, 1);
    assert.deepEqual(initial.plates[0], middle.plates[0]);
    assert.deepEqual(middle.actions[0].target, {plate_id: 'plate-02', row_id: 'C'});
    validateSnapshot(map, middle);
  }
});
