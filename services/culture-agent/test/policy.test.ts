// Scripted policy unit tests: decisions from synthetic snapshots for the three
// demo scenarios. Blurred observations must NEVER produce fabricated numbers.
// The llm adapter without credentials must report unavailable (never fall back).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadScenario} from '@oscar/simulator';
import type {Action} from '@oscar/device-contract';
import {adapterForRun, emptyMemory, hasLlmConfig, scriptedDecide, ScriptedAdapter,
  type ActionRecord, type ObservationRecord, type PolicyContext} from '@oscar/culture-policy';
import {fakeAction, makeSnapshot} from './helpers.ts';

const runInfo = (scenarioId: string): PolicyContext['run'] => ({run_id: 'run-001-1', experiment_id: 'exp-001',
  mode: 'scripted', scenario_id: scenarioId, seed: 42, plates: ['plate-01'],
  capabilities: ['media.add', 'media.exchange', 'imaging.scan', 'environment.set_targets', 'environment.read',
    'environment.await_stable', 'plate.shake', 'action.get', 'action.cancel', 'observation.get'],
  budget: {max_actions: 40, actions_used: 0}});

const ROW = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

function ctx(scenarioId: string, opts: {
  simTime?: number;
  rowA?: number[];
  actions?: ActionRecord[];
  observations?: ObservationRecord[];
  errors?: PolicyContext['lastErrors'];
  memory?: PolicyContext['memory'];
} = {}): PolicyContext {
  return {
    run: runInfo(scenarioId),
    task: loadScenario(scenarioId).task,
    state: makeSnapshot(scenarioId, opts.simTime ?? 0, opts.rowA ?? [400, 380, 410, 420, 395, 405]),
    observations: opts.observations ?? [],
    actions: opts.actions ?? [],
    lastErrors: opts.errors ?? [],
    memory: opts.memory ?? emptyMemory(),
    decisionIndex: 1,
    tools: [],
  };
}

function obs(id: string, quality: 'ok' | 'blurred', levels: Array<number | null>, opts: {sampledAt?: number;
  mode?: 'mono' | 'stereo'} = {}): ObservationRecord {
  return {
    observation_id: id, plate_id: 'plate-01', wells: ROW, mode: opts.mode ?? 'mono',
    sampled_at_sim_s: opts.sampledAt ?? 10, plate_revision: 0, quality,
    estimates: levels.map((v, i) => ({well_id: `A${i + 1}`, liquid_level_ul: v,
      color_index: quality === 'ok' ? 0.3 : null, turbidity: quality === 'ok' ? 0.4 : null,
      quality: quality === 'ok' ? 0.98 : 0.25, provenance: 'device_estimate' as const,
      method: 'simulated_onboard_analysis' as const, uncertainty_ul: 10})),
    image_sha256: [`sha-${id}`],
  };
}

function rec(action: Action, opts: {ended?: number; status?: ActionRecord['status']} = {}): ActionRecord {
  return {action_id: action.action_id, capability: action.capability, status: opts.status ?? action.status,
    arguments: action.arguments, submitted_at_sim_s: action.submitted_at_sim_s,
    ended_at_sim_s: opts.ended ?? action.ended_at_sim_s, summary: action.summary, error: action.error,
    result: action.result, partial: action.partial};
}

// -- routine_maintenance --------------------------------------------------------

test('routine: first decision is a mono scan of the focus row citing scheduled_policy', () => {
  const d = scriptedDecide(ctx('routine_maintenance'));
  assert.equal(d.kind, 'act');
  assert.equal(d.capability, 'imaging.scan');
  assert.deepEqual((d as unknown as {arguments: {wells: string[]}}).arguments.wells, ROW);
  assert.equal((d as unknown as {arguments: {mode: string}}).arguments.mode, 'mono');
  assert.match((d as {reason: string}).reason, /scheduled_policy/);
  assert.equal(d.basis, 'scripted');
});

test('routine: scan in flight -> wait on the scan action', () => {
  const scan = rec(fakeAction('act-1', 'imaging.scan', 'running', {plate_id: 'plate-01', wells: ROW, mode: 'mono'}));
  const d = scriptedDecide(ctx('routine_maintenance', {actions: [scan]}));
  assert.equal(d.kind, 'wait');
  assert.deepEqual((d as {wake: {on_actions?: string[]}}).wake.on_actions, ['act-1']);
});

test('routine: low estimates -> media.add to band midpoint on the whole row citing the observation', () => {
  const scan = rec(fakeAction('act-1', 'imaging.scan', 'succeeded', {plate_id: 'plate-01', wells: ROW, mode: 'mono'},
    {result: {observation_id: 'obs-001-001'}, ended: 12}), {ended: 12});
  const o = obs('obs-001-001', 'ok', [400, 380, 410, 420, 395, 405]);
  const d = scriptedDecide(ctx('routine_maintenance', {actions: [scan], observations: [o]}));
  assert.equal(d.kind, 'act');
  const act = d as Extract<typeof d, {kind: 'act'}>;
  assert.equal(act.capability, 'media.add');
  assert.equal(act.arguments.plate_id, 'plate-01');
  assert.equal(act.arguments.row_id, 'A');
  assert.equal(act.arguments.volume_ul_per_well, 370); // midpoint 750 - min estimate 380
  assert.deepEqual(act.evidence_refs, ['obs-001-001']);
  assert.match(act.reason, /obs-001-001/);
  assert.match(act.reason, /380\.0/);
});

test('routine: estimates already in band -> finish completed without a liquid op', () => {
  const scan = rec(fakeAction('act-1', 'imaging.scan', 'succeeded', {plate_id: 'plate-01', wells: ROW, mode: 'mono'},
    {result: {observation_id: 'obs-1'}, ended: 12}), {ended: 12});
  const o = obs('obs-1', 'ok', [750, 760, 770, 780, 750, 760]);
  const d = scriptedDecide(ctx('routine_maintenance', {actions: [scan], observations: [o]}));
  assert.equal(d.kind, 'finish');
  assert.equal((d as {outcome: string}).outcome, 'completed');
});

test('routine: add succeeded + verification scan within band -> finish completed citing both observations', () => {
  const scan1 = rec(fakeAction('act-1', 'imaging.scan', 'succeeded', {plate_id: 'plate-01', wells: ROW, mode: 'mono'},
    {result: {observation_id: 'obs-1'}, ended: 12}), {ended: 12});
  const add = rec(fakeAction('act-2', 'media.add', 'succeeded',
    {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 350},
    {result: {summary: 'ok'}, ended: 45}), {ended: 45});
  add.summary.wells = {A1: {removed_ul: 0, added_ul: 350}};
  const o1 = obs('obs-1', 'ok', [400, 380, 410, 420, 395, 405]);
  const o2 = obs('obs-2', 'ok', [750, 740, 760, 770, 745, 755], {sampledAt: 54});
  const d = scriptedDecide(ctx('routine_maintenance', {actions: [scan1, add], observations: [o1, o2]}));
  assert.equal(d.kind, 'finish');
  const fin = d as Extract<typeof d, {kind: 'finish'}>;
  assert.equal(fin.outcome, 'completed');
  assert.match(fin.summary, /obs-2/);
  assert.match(fin.summary, /act-2/);
});

test('routine: blurred observation -> no fabricated numbers, bounded rescan', () => {
  const scan = rec(fakeAction('act-1', 'imaging.scan', 'succeeded', {plate_id: 'plate-01', wells: ROW, mode: 'mono'},
    {result: {observation_id: 'obs-blur'}, ended: 12}), {ended: 12});
  const o = obs('obs-blur', 'blurred', [null, null, null, null, null, null]);
  const c = ctx('routine_maintenance', {actions: [scan], observations: [o]});
  const d = scriptedDecide(c);
  assert.equal(d.kind, 'act');
  const act = d as Extract<typeof d, {kind: 'act'}>;
  assert.equal(act.capability, 'imaging.scan');
  assert.match(act.reason, /no visual conclusion|no usable device_estimate/);
  // after the retry limit the policy stops instead of fabricating
  for (let i = 0; i < 4; i++) scriptedDecide(c); // each blurred pass increments the counter
  const d2 = scriptedDecide(c);
  if (d2.kind === 'finish') {
    assert.equal(d2.outcome, 'failed');
    assert.match(d2.summary, /not usable|fabricat/);
  } else {
    assert.match((d2 as {reason: string}).reason, /no usable device_estimate|no visual conclusion/);
  }
});

test('routine: observation_stale submit error -> wait, then forced rescan before any liquid op', () => {
  const o = obs('obs-old', 'ok', [400, 380, 410, 420, 395, 405]);
  const c = ctx('routine_maintenance', {observations: [o], errors: [{decision_index: 1, capability: 'media.add',
    code: 'observation_stale', message: 'Observation obs-old is 2000 s old'}]});
  const d = scriptedDecide(c);
  assert.equal(d.kind, 'wait');
  c.lastErrors = []; // the loop clears submit errors once the pass completes
  const next = scriptedDecide(c); // after the wait, the policy rescans first
  assert.equal(next.kind, 'act');
  assert.equal((next as Extract<typeof next, {kind: 'act'}>).capability, 'imaging.scan');
});

// -- exchange_and_mix -------------------------------------------------------------

test('exchange: full scripted chain scan -> exchange(fraction) -> shake -> settle wait -> stereo scan -> compare', () => {
  const mem = emptyMemory();
  const scan = rec(fakeAction('act-1', 'imaging.scan', 'succeeded', {plate_id: 'plate-01', wells: ROW, mode: 'mono'},
    {result: {observation_id: 'obs-1'}, ended: 12}), {ended: 12});
  const o1 = obs('obs-1', 'ok', [810, 800, 795, 805, 790, 800]);
  const d1 = scriptedDecide(ctx('exchange_and_mix', {actions: [scan], observations: [o1],
    rowA: [810, 800, 795, 805, 790, 800], memory: mem}));
  assert.equal(d1.kind, 'act');
  const ex = d1 as Extract<typeof d1, {kind: 'act'}>;
  assert.equal(ex.capability, 'media.exchange');
  assert.equal(ex.arguments.fraction, 0.5);
  assert.deepEqual(ex.evidence_refs, ['obs-1']);

  const exchange = rec(fakeAction('act-2', 'media.exchange', 'succeeded',
    {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.5}, {ended: 70}), {ended: 70});
  const d2 = scriptedDecide(ctx('exchange_and_mix', {actions: [scan, exchange], observations: [o1], memory: mem}));
  assert.equal(d2.kind, 'act');
  const shake = d2 as Extract<typeof d2, {kind: 'act'}>;
  assert.equal(shake.capability, 'plate.shake');
  assert.equal(shake.arguments.speed_rpm, 300);
  assert.equal(shake.arguments.duration_sim_s, 30);

  const shakeRec = rec(fakeAction('act-3', 'plate.shake', 'succeeded',
    {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 30}, {ended: 100}), {ended: 100});
  const d3 = scriptedDecide(ctx('exchange_and_mix', {actions: [scan, exchange, shakeRec], observations: [o1], simTime: 110, memory: mem}));
  assert.equal(d3.kind, 'wait');
  assert.equal((d3 as {wake: {at_sim_s?: number}}).wake.at_sim_s, 130); // ended 100 + settle 30

  const d4 = scriptedDecide(ctx('exchange_and_mix', {actions: [scan, exchange, shakeRec], observations: [o1], simTime: 130, memory: mem}));
  assert.equal(d4.kind, 'act');
  assert.equal((d4 as Extract<typeof d4, {kind: 'act'}>).arguments.mode, 'stereo');

  const stereo = rec(fakeAction('act-4', 'imaging.scan', 'succeeded', {plate_id: 'plate-01', wells: ROW, mode: 'stereo'},
    {result: {observation_id: 'obs-2'}, ended: 140}), {ended: 140});
  const o2 = obs('obs-2', 'ok', [810, 800, 795, 805, 790, 800], {sampledAt: 137, mode: 'stereo'});
  o2.estimates = o2.estimates.map(e => ({...e, color_index: 0.6, turbidity: 0.2}));
  const d5 = scriptedDecide(ctx('exchange_and_mix', {actions: [scan, exchange, shakeRec, stereo], observations: [o1, o2], memory: mem}));
  assert.equal(d5.kind, 'finish');
  const fin = d5 as Extract<typeof d5, {kind: 'finish'}>;
  assert.equal(fin.outcome, 'completed');
  assert.match(fin.summary, /obs-1/);
  assert.match(fin.summary, /obs-2/);
  assert.match(fin.summary, /Δcolor/);
});

// -- environment_drift ------------------------------------------------------------

test('drift: set_targets from task profile -> scan (blurred) -> await_stable without visual conclusion -> rescan -> verify', () => {
  const mem = emptyMemory();
  const c0 = ctx('environment_drift', {memory: mem});
  c0.state.chamber.temperature_c.observed = 34;
  const d1 = scriptedDecide(c0);
  assert.equal(d1.kind, 'act');
  const set = d1 as Extract<typeof d1, {kind: 'act'}>;
  assert.equal(set.capability, 'environment.set_targets');
  assert.equal(set.arguments.temperature_c, 37);
  assert.equal(set.arguments.co2_pct, 5);
  assert.equal(set.arguments.humidity_pct, 95);
  assert.match(set.reason, /scheduled_policy/);

  const setRec = rec(fakeAction('act-1', 'environment.set_targets', 'succeeded',
    {chamber_id: 'chamber-01', temperature_c: 37, co2_pct: 5, humidity_pct: 95}, {ended: 0}), {ended: 0});
  const d2 = scriptedDecide(ctx('environment_drift', {actions: [setRec], memory: mem}));
  assert.equal((d2 as Extract<typeof d2, {kind: 'act'}>).capability, 'imaging.scan');

  const scan = rec(fakeAction('act-2', 'imaging.scan', 'succeeded', {plate_id: 'plate-01', wells: ROW, mode: 'mono'},
    {result: {observation_id: 'obs-blur'}, ended: 15, submitted: 5}), {ended: 15});
  const blur = obs('obs-blur', 'blurred', [null, null, null, null, null, null]);
  const d3 = scriptedDecide(ctx('environment_drift', {actions: [setRec, scan], observations: [blur], memory: mem}));
  assert.equal(d3.kind, 'act');
  const aw = d3 as Extract<typeof d3, {kind: 'act'}>;
  assert.equal(aw.capability, 'environment.await_stable');
  assert.equal(aw.arguments.timeout_sim_s, 3600);
  assert.match(aw.reason, /no visual conclusion/);
  assert.match(aw.reason, /obs-blur/);

  const awRec = rec(fakeAction('act-3', 'environment.await_stable', 'succeeded',
    {chamber_id: 'chamber-01', timeout_sim_s: 3600}, {ended: 500}), {ended: 500});
  const d4 = scriptedDecide(ctx('environment_drift', {actions: [setRec, scan, awRec], observations: [blur], simTime: 500, memory: mem}));
  assert.equal((d4 as Extract<typeof d4, {kind: 'act'}>).capability, 'imaging.scan');

  const scan2 = rec(fakeAction('act-4', 'imaging.scan', 'succeeded', {plate_id: 'plate-01', wells: ROW, mode: 'mono'},
    {result: {observation_id: 'obs-ok'}, ended: 520, submitted: 505}), {ended: 520});
  const ok = obs('obs-ok', 'ok', [780, 790, 775, 785, 795, 780], {sampledAt: 515});
  const d5 = scriptedDecide(ctx('environment_drift', {actions: [setRec, scan, awRec, scan2], observations: [blur, ok], memory: mem}));
  assert.equal(d5.kind, 'finish');
  const fin = d5 as Extract<typeof d5, {kind: 'finish'}>;
  assert.equal(fin.outcome, 'completed');
  assert.match(fin.summary, /obs-ok/);
  assert.match(fin.summary, /within tolerance/);
});

// -- guards & adapters -------------------------------------------------------------

test('budget and sim-time guards finish failed', () => {
  const c1 = ctx('routine_maintenance');
  c1.run.budget = {max_actions: 3, actions_used: 3};
  const d1 = scriptedDecide(c1);
  assert.equal(d1.kind, 'finish');
  assert.match((d1 as {summary: string}).summary, /budget/);
  const c2 = ctx('routine_maintenance', {simTime: 99999});
  const d2 = scriptedDecide(c2);
  assert.equal(d2.kind, 'finish');
  assert.match((d2 as {summary: string}).summary, /sim time/);
});

test('resource_busy -> bounded wait on the busy holder', () => {
  const c = ctx('routine_maintenance', {errors: [{decision_index: 1, capability: 'imaging.scan',
    code: 'resource_busy', message: 'Resource head is busy with action act-x'}]});
  c.state.busy_resources = {head: 'act-x'};
  const busyAction = rec(fakeAction('act-x', 'imaging.scan', 'running', {plate_id: 'plate-01', wells: ROW, mode: 'mono'}));
  const d = scriptedDecide(c);
  assert.equal(d.kind, 'wait');
  const wake = (d as {wake: {on_actions?: string[]; at_sim_s?: number}}).wake;
  assert.ok(wake.on_actions?.includes('act-x') || wake.at_sim_s != null,
    'wakes on the busy holder or falls back to a time wake');
});

test('pure policy: identical inputs give identical decisions', () => {
  const build = (): PolicyContext => ctx('routine_maintenance', {
    actions: [rec(fakeAction('act-1', 'imaging.scan', 'succeeded',
      {plate_id: 'plate-01', wells: ROW, mode: 'mono'}, {result: {observation_id: 'obs-1'}, ended: 12}), {ended: 12})],
    observations: [obs('obs-1', 'ok', [400, 380, 410, 420, 395, 405])],
  });
  const a = scriptedDecide(build());
  const b = scriptedDecide(build());
  assert.deepEqual(a, b);
});

test('llm adapter: unavailable without OSCAR_LLM_* config; scripted always available', async () => {
  assert.equal(hasLlmConfig({}), false);
  assert.equal(await adapterForRun('llm', {}).available(), false);
  assert.equal(await adapterForRun('llm', {OSCAR_LLM_PROVIDER: 'p'}).available(), false);
  assert.equal(await new ScriptedAdapter().available(), true);
  const configured = adapterForRun('llm', {OSCAR_LLM_PROVIDER: 'p', OSCAR_LLM_API_KEY: 'k', OSCAR_LLM_MODEL: 'm'});
  assert.equal(await configured.available(), true);
  // even when configured, the placeholder refuses to guess (never silently scripted)
  await assert.rejects(() => configured.decide(ctx('routine_maintenance')), /llm_adapter_not_implemented/);
});
