import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildManifest, buildTools, canonicalJson, capabilityFromTool, DEMO_PROFILE, DeviceError, normalizeRowScope,
  PLATE_LAYOUTS, rowWellIds, toolName, validateArguments} from '../src/index.ts';

const layout = PLATE_LAYOUTS['24'];

test('manifest exposes every capability with schema, units and limits', () => {
  const m = buildManifest();
  assert.equal(m.profile, 'oscar-mhs-demo/0.1');
  const names = m.capabilities.map(c => c.name);
  for (const n of ['device.describe', 'device.read_state', 'media.add', 'media.exchange', 'imaging.scan',
    'environment.set_targets', 'environment.read', 'environment.await_stable', 'plate.shake', 'action.get',
    'action.cancel', 'observation.get']) assert.ok(names.includes(n), n);
  for (const c of m.capabilities) {
    assert.equal(typeof c.input_schema, 'object');
    if (c.limits_ref) assert.ok(m.limits[c.limits_ref], c.limits_ref);
  }
  assert.equal(m.units.co2, '% (0–100)');
  assert.equal(DEMO_PROFILE.head.channels, 6);
  assert.equal(DEMO_PROFILE.head.pitch_mm, 21.6);
});

test('row pipette contract uses plate_id + row_id; partial rows are rejected, never expanded', () => {
  const args = validateArguments('media.add', {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 200});
  const scope = normalizeRowScope(layout, args as {plate_id: string; row_id: string}, 6);
  assert.deepEqual(scope.wells, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
  assert.equal(scope.label, 'plate-01 A1–A6');
  assert.deepEqual(normalizeRowScope(layout, {plate_id: 'plate-01', row_id: 'B', wells: rowWellIds(layout, 'B').reverse()}, 6).wells,
    ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
  assert.throws(() => normalizeRowScope(layout, {plate_id: 'plate-01', row_id: 'A', wells: ['A1']}, 6), DeviceError);
  assert.throws(() => normalizeRowScope(layout, {plate_id: 'plate-01', row_id: 'A', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'B6']}, 6));
  assert.throws(() => normalizeRowScope(layout, {plate_id: 'plate-01', row_id: 'E'}, 6), /does not exist/);
  assert.throws(() => normalizeRowScope(PLATE_LAYOUTS['96'], {plate_id: 'p', row_id: 'A'}, 6), /channels/);
  // well-only requests are structurally invalid (row_id required)
  assert.throws(() => validateArguments('media.add', {plate_id: 'plate-01', wells: ['A1'], reservoir_id: 'media-01', volume_ul_per_well: 1}),
    (e: DeviceError) => e.code === 'invalid_argument');
});

test('schema enforces units, finiteness, additionalProperties and limits', () => {
  const bad = [
    ['media.exchange', {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 1.5}],
    ['media.add', {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: Infinity}],
    ['media.add', {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10, extra: 1}],
    ['environment.set_targets', {chamber_id: 'chamber-01'}],
    ['environment.set_targets', {chamber_id: 'chamber-01', co2_pct: 50}],
    ['plate.shake', {plate_id: 'plate-01', speed_rpm: 5000, duration_sim_s: 10}],
    ['imaging.scan', {plate_id: 'plate-01', wells: ['Z9']}],
  ] as const;
  for (const [cap, args] of bad) assert.throws(() => validateArguments(cap, args), (e: DeviceError) => e.code === 'invalid_argument', cap);
  const scan = validateArguments('imaging.scan', {plate_id: 'plate-01', wells: ['A1']});
  assert.equal(scan.mode, 'mono');
  assert.equal(scan.view, 'medium_overview');
});

test('tool names derive mechanically from capability names and reuse manifest schemas', () => {
  const tools = buildTools(buildManifest(), ['media.add', 'imaging.scan']);
  const add = tools.find(t => t.name === 'media_add');
  assert.ok(add);
  assert.deepEqual(add.input_schema, buildManifest().capabilities.find(c => c.name === 'media.add')!.input_schema);
  assert.ok(!tools.some(t => t.name === 'media_exchange'), 'out-of-scope write capability filtered');
  assert.ok(tools.some(t => t.name === 'wait_until') && tools.some(t => t.name === 'finish'));
  assert.equal(toolName('environment.set_targets'), 'environment_set_targets');
  assert.equal(capabilityFromTool('plate_shake'), 'plate.shake');
  for (const t of tools) assert.match(t.name, /^[A-Za-z0-9_-]+$/);
});

test('canonical JSON ignores key order', () => {
  assert.equal(canonicalJson({b: 1, a: {d: [1, {z: 1, y: 2}], c: null}}), canonicalJson({a: {c: null, d: [1, {y: 2, z: 1}]}, b: 1}));
});

test('scene-map business IDs match the contract layout', () => {
  const map = JSON.parse(readFileSync(new URL('../../../web/scene/scene-map.json', import.meta.url), 'utf8'));
  const plate = map.stations.find((s: {id: string}) => s.id === 'plate-01');
  assert.equal(plate.rows, layout.rows);
  assert.equal(plate.columns, layout.columns);
  assert.equal(map.motion.row_head.channels, DEMO_PROFILE.head.channels);
  assert.ok(Math.abs(map.motion.row_head.pitch_m * 1000 - DEMO_PROFILE.head.pitch_mm) < 1e-9);
});
