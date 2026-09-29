// Workbench scene-adapter tests (node:test, no DOM). The projection must be
// accepted by A's scene validator against the real scene-map.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {projectDisplay, normalizeTarget, stageProgress} from '../../web/api/scene-adapter.js';
import {validateSnapshot} from '../../web/scene/state.js';
import {rowWellIds, rowScopeLabel, PLATE_LAYOUT_24} from '../../web/api/ids.js';
import {rowWellIds as tsRowWellIds, rowScopeLabel as tsRowScopeLabel} from '../../packages/device-contract/src/ids.ts';

const map = JSON.parse(readFileSync(fileURLToPath(new URL('../../web/scene/scene-map.json', import.meta.url)), 'utf8'));
const CAPACITY = 2000;

function plateFromMap(plateId, volume = 500) {
  const station = map.stations.find(s => s.id === plateId);
  return {
    plate_id: plateId, station_id: station.station ?? '', format: '24', rows: ['A', 'B', 'C', 'D'], columns: 6,
    revision: 1, shake: {active: false, started_at_sim_s: 0, duration_sim_s: 0},
    wells: station.wells.map(w => ({well_id: w.well_id, volume_ul: volume, capacity_ul: CAPACITY, medium_id: 'demo'})),
  };
}

function makeSnapshot({head = null, actions = new Map(), plates = null, simTime = 120, paused = false} = {}) {
  return {
    experiment: {experiment_id: 'exp-01', sim_time_s: simTime, paused, status: 'active'},
    event_seq: 10,
    plates: plates || [plateFromMap('plate-01'), plateFromMap('plate-02', 0)],
    head,
    actions,
    active_actions: [...actions.values()],
    clock: {sim_time_s: simTime, paused},
  };
}

const liquidAction = {
  action_id: 'act-01', capability: 'media.add', status: 'running',
  arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 200},
};

test('rowWellIds/rowScopeLabel match the TypeScript contract source', () => {
  for (const row of ['A', 'B', 'C', 'D']) {
    assert.deepEqual(rowWellIds(PLATE_LAYOUT_24, row), tsRowWellIds({format: '24', rows: 4, columns: 6}, row));
  }
  assert.equal(rowScopeLabel('plate-01', PLATE_LAYOUT_24, 'A'), tsRowScopeLabel('plate-01', {format: '24', rows: 4, columns: 6}, 'A'));
  assert.equal(rowScopeLabel('plate-01', PLATE_LAYOUT_24, 'A'), 'plate-01 A1–A6');
  assert.deepEqual(rowWellIds(PLATE_LAYOUT_24, 'Z'), []);
});

test('liquid head stage maps to the explicit full row and validates', () => {
  const head = {action_id: 'act-01', stage: {index: 6, stage: 'dispensing', primitive: 'pipette.dispense',
    target: {plate_id: 'plate-01', row_id: 'A'}, duration_sim_s: 3, started_at_sim_s: 117}};
  const display = projectDisplay(makeSnapshot({head, actions: new Map([['act-01', liquidAction]])}));
  assert.equal(display.actions.length, 1);
  assert.deepEqual(display.actions[0].target, {plate_id: 'plate-01', row_id: 'A'});
  assert.equal(display.actions[0].tool, undefined);
  validateSnapshot(map, display);
});

test('a single-well liquid target is expanded to its row, never left as one well', () => {
  const target = normalizeTarget(liquidAction, {stage: 'dispensing', target: {plate_id: 'plate-01', well_id: 'A3'}});
  assert.deepEqual(target, {plate_id: 'plate-01', row_id: 'A'});
});

test('scan stage uses well target with tool camera and validates', () => {
  const scanAction = {action_id: 'act-02', capability: 'imaging.scan', status: 'running',
    arguments: {plate_id: 'plate-02', wells: ['C2', 'C3'], mode: 'stereo'}};
  const head = {action_id: 'act-02', stage: {index: 1, stage: 'scanning', primitive: 'camera.capture',
    target: {plate_id: 'plate-02', well_id: 'C2'}, duration_sim_s: 3, started_at_sim_s: 118}};
  const display = projectDisplay(makeSnapshot({head, actions: new Map([['act-02', scanAction]])}));
  assert.deepEqual(display.actions[0].target, {plate_id: 'plate-02', well_id: 'C2'});
  assert.equal(display.actions[0].tool, 'camera');
  validateSnapshot(map, display);
  // Fallback derives the first well from the arguments when target is absent.
  assert.deepEqual(
    normalizeTarget(scanAction, {stage: 'scanning'}),
    {plate_id: 'plate-02', well_id: 'C2'});
});

test('park move uses target null and validates', () => {
  const head = {action_id: 'act-01', stage: {index: 8, stage: 'moving', primitive: 'motion.park',
    target: null, from_target: {resource_id: 'waste-01'}, duration_sim_s: 3, started_at_sim_s: 119}};
  const display = projectDisplay(makeSnapshot({head, actions: new Map([['act-01', liquidAction]])}));
  assert.equal(display.actions[0].target, null);
  assert.deepEqual(display.actions[0].from_target, {resource_id: 'waste-01'});
  validateSnapshot(map, display);
});

test('station stages map to resource ids and validate', () => {
  for (const [stageName, target] of [
    ['picking_tip', {resource_id: 'tips-01'}],
    ['aspirating', {resource_id: 'media-01'}],
  ]) {
    const head = {action_id: 'act-01', stage: {index: 1, stage: stageName, primitive: 'x', target,
      duration_sim_s: 3, started_at_sim_s: 117}};
    const display = projectDisplay(makeSnapshot({head, actions: new Map([['act-01', liquidAction]])}));
    assert.deepEqual(display.actions[0].target, target, stageName);
    validateSnapshot(map, display);
  }
});

test('shake never becomes a head stage; it projects into plate.shake with capped frequency', () => {
  const headShaking = {action_id: 'act-03', stage: {index: 0, stage: 'shaking', primitive: '', target: {plate_id: 'plate-01'},
    duration_sim_s: 30, started_at_sim_s: 100}};
  const plates = [plateFromMap('plate-01'), plateFromMap('plate-02', 0)];
  plates[0].shake = {active: true, started_at_sim_s: 100, duration_sim_s: 60, speed_rpm: 1200};
  const display = projectDisplay(makeSnapshot({head: headShaking, plates}));
  assert.deepEqual(display.actions, [], 'shaking is not a scene stage');
  assert.equal(display.plates[0].shake.active, true);
  assert.ok(display.plates[0].shake.frequency_hz <= 4, 'frequency capped at the scene limit');
  assert.equal(display.plates[0].shake.frequency_hz, 4);
  assert.ok(display.plates[0].shake.amplitude_m <= 0.0015);
  validateSnapshot(map, display);

  const waiting = {action_id: 'act-04', stage: {index: 0, stage: 'waiting', primitive: '', target: null,
    duration_sim_s: 30, started_at_sim_s: 100}};
  assert.deepEqual(projectDisplay(makeSnapshot({head: waiting})).actions, [], 'waiting is not a scene stage');
});

test('display time is the server-confirmed value, never extrapolated from stage progress', () => {
  const head = {action_id: 'act-01', stage: {index: 6, stage: 'dispensing', target: {plate_id: 'plate-01', row_id: 'B'},
    duration_sim_s: 30, started_at_sim_s: 110}};
  const snapshot = makeSnapshot({head, actions: new Map([['act-01', liquidAction]]), simTime: 120});
  const lateClock = projectDisplay(snapshot, 520);
  assert.equal(lateClock.sim_time_s, 520);
  assert.ok(stageProgress(head, 520) >= 0 && stageProgress(head, 520) <= 1);
  // A stale clock frame must not move the display backwards behind the snapshot.
  assert.equal(projectDisplay(snapshot, 90).sim_time_s, 120);
  // No clock value at all: snapshot time.
  assert.equal(projectDisplay(snapshot).sim_time_s, 120);
});

test('liquid volumes come only from the snapshot, never from animation progress', () => {
  const head = {action_id: 'act-01', stage: {index: 6, stage: 'dispensing', target: {plate_id: 'plate-01', row_id: 'A'},
    duration_sim_s: 30, started_at_sim_s: 110}};
  const snapshot = makeSnapshot({head, actions: new Map([['act-01', liquidAction]])});
  const before = projectDisplay(snapshot, 120);
  const after = projectDisplay(snapshot, 139); // progress ~1 but not committed
  assert.deepEqual(before.plates[0].wells, after.plates[0].wells);
  for (const well of after.plates[0].wells) assert.equal(well.volume_ul, 500);
});

test('empty head clears actions; plates still validate', () => {
  const display = projectDisplay(makeSnapshot({}));
  assert.deepEqual(display.actions, []);
  assert.equal(display.paused, false);
  validateSnapshot(map, display);
});

test('stageProgress clamps and handles zero duration', () => {
  assert.equal(stageProgress({started_at_sim_s: 10, duration_sim_s: 0}, 10), 1);
  assert.equal(stageProgress({started_at_sim_s: 10, duration_sim_s: 0}, 9), 0);
  assert.equal(stageProgress({started_at_sim_s: 10, duration_sim_s: 10}, 15), 0.5);
  assert.equal(stageProgress({started_at_sim_s: 10, duration_sim_s: 10}, 99), 1);
  assert.equal(stageProgress({started_at_sim_s: 10, duration_sim_s: 10}, 5), 0);
});
