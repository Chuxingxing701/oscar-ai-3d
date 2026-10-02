// R08 unit acceptance: the versioned skill registry. Input validation,
// unknown skill/version refusal, plan-time + step-start preconditions, every
// postcondition evaluator with good/old/wrong-plate/failed/cancelled/foreign
// evidence, wake/step binding (N03), target-bound actions (N03), the
// complete-task gate (N02) and the goal-level success check (N02). All
// evaluator device reads are synthetic but shaped exactly like Runtime wire
// objects.
import test from 'node:test';
import assert from 'node:assert/strict';
import type {Action, ActionStatus, Observation, StateSnapshot} from '@oscar/device-contract';
import {normalizeGoalSpec} from '../src/goal.ts';
import {
  SKILLS, defaultTolerance, listSkillIds, planCompletionGate, resolveSkillStep, validatePlanSteps,
  verifyGoalSatisfied, type GoalVerifyContext, type SkillVerifyContext,
} from '../src/skills.ts';
import {makeSnapshot} from './helpers.ts';

const ROW_A = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

function spec(allowed: string[] = ['imaging.scan', 'media.add', 'media.exchange', 'plate.shake'],
  overrides: Record<string, unknown> = {}) {
  return normalizeGoalSpec({
    description: 'keep row A >= 330 µL',
    scope: {plates: ['plate-01'], rows: ['A'], reservoirs: ['media-01']},
    metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'}],
    allowed_operations: allowed,
    ...overrides,
  });
}

const LIVE_PLATE_REVISION = 3;

function state(rowA: number[] = [400, 380, 410, 420, 395, 405], overrides: Partial<StateSnapshot> = {},
  simTime = 5_000): StateSnapshot {
  const snap = makeSnapshot('routine_maintenance', simTime, rowA, overrides);
  snap.plates[0].revision = LIVE_PLATE_REVISION;
  return snap;
}

/** Realistic default arguments per capability (N03 target checks read these). */
function defaultArgs(capability: string): Record<string, unknown> {
  if (capability === 'imaging.scan') return {plate_id: 'plate-01', wells: ROW_A, mode: 'mono'};
  if (capability === 'media.add') {
    return {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 20};
  }
  if (capability === 'media.exchange') return {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.3};
  if (capability === 'plate.shake') return {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60};
  return {};
}

function makeAction(actionId: string, capability: string, opts: {
  status?: ActionStatus; ended?: number; started?: number; args?: Record<string, unknown>;
  partial?: boolean; plateRevision?: number} = {}): Action {
  const status = opts.status ?? 'succeeded';
  return {
    action_id: actionId, experiment_id: 'exp-001', device_id: 'oscar-01', capability,
    arguments: opts.args ?? defaultArgs(capability), status,
    principal: {kind: 'service', id: 'agent'}, run_id: null, basis: 'llm', reason: 'test',
    evidence_refs: [], idempotency_key: `key-${actionId}`, resources: [], accept_seq: 1,
    submitted_at_sim_s: opts.started ?? 100, started_at_sim_s: opts.started ?? 110,
    ended_at_sim_s: opts.ended ?? (status === 'queued' ? null : 200),
    stages: [], current_stage_index: null, effects: [],
    summary: {wells: {}, reservoir_delta_ul: 0, waste_delta_ul: 0, tips_used: 0},
    partial: opts.partial ?? false, cancel_reason: status === 'cancelled' ? 'test' : null,
    error: status === 'failed' ? {code: 'constraint_violation', message: 'boom'} : null, result: null,
  };
}

function makeObservation(obsId: string, actionId: string, opts: {
  plateId?: string; sampledAt?: number; quality?: 'ok' | 'blurred'; levels?: number[];
  wells?: string[]; plateRevision?: number} = {}): Observation {
  const wells = opts.wells ?? ROW_A;
  const levels = opts.levels ?? [400, 380, 410, 420, 395, 405];
  return {
    observation_id: obsId, experiment_id: 'exp-001', action_id: actionId,
    plate_id: opts.plateId ?? 'plate-01', wells, mode: 'mono', view: 'medium_overview',
    sampled_at_sim_s: opts.sampledAt ?? 300, plate_revision: opts.plateRevision ?? LIVE_PLATE_REVISION,
    quality: opts.quality ?? 'ok', stereo_pair_id: null, depth_status: null, camera: {},
    images: [], source: 'synthetic_image',
    estimates: wells.map((w, i) => ({well_id: w, liquid_level_ul: opts.quality === 'blurred' ? null : levels[i % levels.length],
      color_index: null, turbidity: null, quality: opts.quality === 'blurred' ? 0.25 : 0.98,
      provenance: 'device_estimate' as const, method: 'simulated_onboard_analysis' as const,
      uncertainty_ul: 8})),
  };
}

/** Verification context over synthetic device facts + an intent ledger. */
function makeCtx(input: {
  owned?: Array<{action_id: string; task_id?: string; goal_revision?: number}>;
  actions?: Action[];
  observations?: Observation[];
  snapshot?: StateSnapshot;
  firedWakes?: Array<{wake_id: string; kind: string; target_sim_s?: number | null;
    predicate?: Record<string, unknown> | null; goal_revision?: number | null; step_id?: string | null}>;
  actionIds?: string[];
  evidenceRefs?: string[];
  step?: {skill: string; version?: string; inputs?: Record<string, unknown>;
    step_id?: string | null; plan_revision?: number | null};
  goalRevision?: number;
  specOverrides?: Record<string, unknown>;
}): SkillVerifyContext {
  const ledger = new Map<string, {task_id: string; goal_revision: number}>();
  for (const o of input.owned ?? []) {
    ledger.set(o.action_id, {task_id: o.task_id ?? 'task-1', goal_revision: o.goal_revision ?? 1});
  }
  const actions = new Map((input.actions ?? []).map(a => [a.action_id, a]));
  const observations = new Map((input.observations ?? []).map(o => [o.observation_id, o]));
  const snapshot = input.snapshot ?? state();
  const stepSkill = input.step?.skill ?? 'scan_and_assess';
  const goalRevision = input.goalRevision ?? 1;
  return {
    task_id: 'task-1', goal_revision: goalRevision, spec: spec(undefined, input.specOverrides ?? {}),
    step: {index: 0, skill: stepSkill, skill_version: input.step?.version ?? '1', inputs: input.step?.inputs ?? null,
      step_id: input.step?.step_id ?? null, plan_revision: input.step?.plan_revision ?? 1},
    action_ids: input.actionIds ?? [],
    evidence_refs: input.evidenceRefs ?? [],
    ownsAction: id => ledger.get(id) ?? null,
    readAction: async id => actions.get(id) ?? null,
    readObservation: async id => observations.get(id) ?? null,
    readState: async () => snapshot,
    firedWakes: (input.firedWakes ?? []).map(w => ({wake_id: w.wake_id, task_id: 'task-1', kind: w.kind,
      target_sim_s: w.target_sim_s ?? null, predicate: w.predicate ?? null, fired_at_wall: '2026-10-02T00:00:00Z',
      goal_revision: w.goal_revision ?? goalRevision, step_id: w.step_id ?? null})),
  };
}

const defOf = (name: string): (typeof SKILLS)[number] => SKILLS.find(s => s.skill === name)!;

// -- registry & resolution -------------------------------------------------------

test('registry exposes exactly the four reviewed skills at version 1', () => {
  const ids = listSkillIds();
  assert.deepEqual(ids.map(s => `${s.skill}@${s.version}`).sort(),
    ['exchange_row_and_verify@1', 'mix_and_rescan@1', 'monitor_until@1', 'scan_and_assess@1']);
  assert.deepEqual(defOf('scan_and_assess').capabilities, ['imaging.scan']);
  assert.deepEqual(defOf('mix_and_rescan').capabilities, ['plate.shake', 'imaging.scan']);
  assert.deepEqual(defOf('monitor_until').capabilities, []);
});

test('resolveSkillStep: unknown skill and unknown version are refused with reasons', () => {
  const unknownSkill = resolveSkillStep({skill: 'maintain_if_needed', skill_version: '1', inputs: {}});
  assert.equal(unknownSkill.ok, false);
  assert.match(unknownSkill.problems[0], /unknown skill 'maintain_if_needed'/);

  const unknownVersion = resolveSkillStep({skill: 'scan_and_assess', skill_version: '2.0.0', inputs: {}});
  assert.equal(unknownVersion.ok, false);
  assert.match(unknownVersion.problems[0], /no version '2\.0\.0'/);

  // omitted version defaults EXPLICITLY to the current version
  const defaulted = resolveSkillStep({skill: 'scan_and_assess', inputs: {plate_id: 'plate-01', row_id: 'A'}});
  assert.equal(defaulted.ok, true);
  assert.equal((defaulted as {resolved: {version: string}}).resolved.version, '1');
});

test('resolveSkillStep: invalid inputs are refused with field-level reasons', () => {
  const missing = resolveSkillStep({skill: 'exchange_row_and_verify', inputs: {plate_id: 'plate-01'}});
  assert.equal(missing.ok, false);
  assert.ok((missing as {problems: string[]}).problems.some(p => p.includes('row_id')));
  assert.ok((missing as {problems: string[]}).problems.some(p => p.includes('reservoir_id')));

  const badWells = resolveSkillStep({skill: 'scan_and_assess',
    inputs: {plate_id: 'plate-01', row_id: 'A', wells: ['A1', 'nope']}});
  assert.equal(badWells.ok, false);

  const badShake = resolveSkillStep({skill: 'mix_and_rescan',
    inputs: {plate_id: 'plate-01', speed_rpm: 10, duration_sim_s: 30}});
  assert.equal(badShake.ok, false);

  const noDeadline = resolveSkillStep({skill: 'monitor_until', inputs: {}});
  assert.equal(noDeadline.ok, false);
  assert.ok((noDeadline as {problems: string[]}).problems.some(p => p.includes('until_sim_s')));

  const badCondition = resolveSkillStep({skill: 'monitor_until',
    inputs: {condition: {metric: 'medium_volume_ul', op: 'below', value: 1}}});
  assert.equal(badCondition.ok, false);
});

// -- plan-time preconditions --------------------------------------------------------

test('validatePlanSteps: scope, allowed operations, plate/row/reservoir existence', async () => {
  const good = await validatePlanSteps([
    {skill: 'scan_and_assess', inputs: {plate_id: 'plate-01', row_id: 'A'}},
    {skill: 'exchange_row_and_verify', inputs: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01'}},
    {skill: 'monitor_until', inputs: {until_sim_s: 6_000}},
  ], spec(), state());
  assert.equal(good.ok, true);
  // wells normalized to the authoritative complete row
  const steps = (good as {steps: Array<{inputs: Record<string, unknown>}>}).steps;
  assert.deepEqual(steps[0].inputs.wells, ROW_A);

  const outOfScope = await validatePlanSteps([{skill: 'scan_and_assess',
    inputs: {plate_id: 'plate-02', row_id: 'A'}}], spec(), state());
  assert.equal(outOfScope.ok, false);
  assert.match((outOfScope as {problems: string[]}).problems.join(' '), /outside the goal scope/);

  const wrongRow = await validatePlanSteps([{skill: 'scan_and_assess',
    inputs: {plate_id: 'plate-01', row_id: 'Z'}}], spec(), state());
  assert.equal(wrongRow.ok, false);
  assert.match((wrongRow as {problems: string[]}).problems.join(' '), /no row 'Z'/);

  const capNotAllowed = await validatePlanSteps([{skill: 'mix_and_rescan',
    inputs: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 30}}],
  spec(['imaging.scan', 'media.add']), state());
  assert.equal(capNotAllowed.ok, false);
  assert.match((capNotAllowed as {problems: string[]}).problems.join(' '), /plate\.shake/);

  const missingReservoir = await validatePlanSteps([{skill: 'exchange_row_and_verify',
    inputs: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-99'}}], spec(), state());
  assert.equal(missingReservoir.ok, false);
  assert.match((missingReservoir as {problems: string[]}).problems.join(' '), /does not exist/);

  const shaking = await validatePlanSteps([{skill: 'scan_and_assess',
    inputs: {plate_id: 'plate-01', row_id: 'A'}}], spec(), state([400, 380, 410, 420, 395, 405], {
    plates: [Object.assign(structuredClone(state().plates[0]),
      {shake: {active: true, started_at_sim_s: 4_900, duration_sim_s: 60, speed_rpm: 300}})],
  }));
  assert.equal(shaking.ok, false);
  assert.match((shaking as {problems: string[]}).problems.join(' '), /shaking/);
});

test('preconditions: an insufficient reservoir refuses the plan-time estimate', async () => {
  const low = state([320, 315, 330, 340, 318, 325], {
    reservoirs: [{id: 'media-01', station_id: 'Station_3_3', medium_id: 'medium-a',
      remaining_ul: 30, capacity_ul: 50_000}],
  });
  const r = await validatePlanSteps([{skill: 'exchange_row_and_verify',
    inputs: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01'}}], spec(), low);
  assert.equal(r.ok, false);
  assert.match((r as {problems: string[]}).problems.join(' '), /µL is needed/);
});

// -- scan_and_assess postcondition ----------------------------------------------------

test('scan_and_assess verify: good evidence passes with per-well levels', async () => {
  const scan = makeAction('act-scan', 'imaging.scan', {ended: 250});
  const obs = makeObservation('obs-1', 'act-scan', {sampledAt: 240});
  const out = await defOf('scan_and_assess').verify(makeCtx({
    owned: [{action_id: 'act-scan'}], actions: [scan], observations: [obs],
    actionIds: ['act-scan'], evidenceRefs: ['obs-1'],
    step: {skill: 'scan_and_assess', inputs: {plate_id: 'plate-01', row_id: 'A', wells: ROW_A}},
  }));
  assert.equal(out.ok, true);
  assert.equal(out.verification.pass, true);
  assert.equal((out.verification.evidence as {observation_id: string}).observation_id, 'obs-1');
  assert.equal((out.verification.evidence as {min_level_ul: number}).min_level_ul, 380);
});

test('scan_and_assess verify: failed / cancelled / unowned / unknown actions refuse', async () => {
  for (const [label, action] of [
    ['failed', makeAction('act-x', 'imaging.scan', {status: 'failed'})],
    ['cancelled', makeAction('act-x', 'imaging.scan', {status: 'cancelled'})],
    ['partial', makeAction('act-x', 'imaging.scan', {partial: true})],
    ['running', makeAction('act-x', 'imaging.scan', {status: 'running'})],
  ] as const) {
    const out = await defOf('scan_and_assess').verify(makeCtx({
      owned: [{action_id: 'act-x'}], actions: [action as Action],
      observations: [makeObservation('obs-1', 'act-x')], actionIds: ['act-x'], evidenceRefs: ['obs-1'],
    }));
    assert.equal(out.ok, false, label);
    assert.equal(out.disposition, label === 'running' ? 'refuse' : 'fail', label);
    assert.match(out.code, new RegExp(`action_(failed|cancelled|partial|not_terminal)`), label);
  }
  // unowned: not in the intent ledger / another task / stale goal revision
  for (const owned of [undefined, {action_id: 'act-x', task_id: 'task-OTHER'},
    {action_id: 'act-x', goal_revision: 7}]) {
    const out = await defOf('scan_and_assess').verify(makeCtx({
      owned: owned ? [owned] : [], actions: [makeAction('act-x', 'imaging.scan')],
      observations: [makeObservation('obs-1', 'act-x')], actionIds: ['act-x'], evidenceRefs: ['obs-1'],
    }));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'action_not_owned');
  }
  // unknown action id: no Runtime record
  const unknown = await defOf('scan_and_assess').verify(makeCtx({
    owned: [{action_id: 'act-ghost'}], actions: [], actionIds: ['act-ghost'],
    evidenceRefs: ['obs-1'], observations: [makeObservation('obs-1', 'act-ghost')],
  }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown_action');
});

test('scan_and_assess verify: wrong-plate / stale-revision / unowned / missing / blurred evidence refuses', async () => {
  const owned = [{action_id: 'act-scan'}];
  const scan = makeAction('act-scan', 'imaging.scan');
  const cases: Array<{label: string; obs: Observation[]; refs: string[]; code: string; snapshot?: StateSnapshot}> = [
    {label: 'other plate', obs: [makeObservation('obs-2', 'act-op', {plateId: 'plate-02'})],
      refs: ['obs-2'], code: 'observation_wrong_plate'},
    {label: 'operator observation (not owned by this task)', obs: [makeObservation('obs-3', 'act-op')],
      refs: ['obs-3'], code: 'observation_not_owned'},
    {label: 'old plate revision', obs: [makeObservation('obs-4', 'act-scan', {plateRevision: 1})],
      refs: ['obs-4'], code: 'observation_stale'},
    {label: 'blurred', obs: [makeObservation('obs-5', 'act-scan', {quality: 'blurred'})],
      refs: ['obs-5'], code: 'observation_unusable'},
    {label: 'incomplete wells', obs: [makeObservation('obs-6', 'act-scan', {wells: ROW_A.slice(0, 3),
      levels: [400, 380, 410]})], refs: ['obs-6'], code: 'observation_unusable'},
  ];
  for (const c of cases) {
    const out = await defOf('scan_and_assess').verify(makeCtx({
      owned, actions: [scan], observations: c.obs, actionIds: ['act-scan'], evidenceRefs: c.refs,
      snapshot: c.snapshot,
      step: {skill: 'scan_and_assess', inputs: {plate_id: 'plate-01', row_id: 'A', wells: ROW_A}},
    }));
    assert.equal(out.ok, false, c.label);
    assert.equal(out.disposition, 'refuse', c.label);
    assert.equal(out.code, c.code, c.label);
  }
  const missing = await defOf('scan_and_assess').verify(makeCtx({
    owned, actions: [scan], observations: [makeObservation('obs-7', 'act-scan')],
    actionIds: ['act-scan'], evidenceRefs: [],
    step: {skill: 'scan_and_assess', inputs: {plate_id: 'plate-01', row_id: 'A', wells: ROW_A}},
  }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'observation_missing');
  const none = await defOf('scan_and_assess').verify(makeCtx({
    owned, actions: [scan], observations: [], actionIds: [], evidenceRefs: [],
    step: {skill: 'scan_and_assess', inputs: {plate_id: 'plate-01', row_id: 'A', wells: ROW_A}},
  }));
  assert.equal(none.ok, false);
  assert.equal(none.code, 'no_action_evidence');
});

// -- exchange_row_and_verify postcondition ----------------------------------------------

test('exchange_row_and_verify: maintenance + fresh in-tolerance scan passes', async () => {
  const add = makeAction('act-add', 'media.add', {ended: 400});
  const verifyScan = makeAction('act-vscan', 'imaging.scan', {ended: 500});
  const obs = makeObservation('obs-v', 'act-vscan', {sampledAt: 490, levels: [345, 338, 352, 360, 341, 349]});
  const snapshot = state([345, 338, 352, 360, 341, 349]);
  const out = await defOf('exchange_row_and_verify').verify(makeCtx({
    owned: [{action_id: 'act-add'}, {action_id: 'act-vscan'}],
    actions: [add, verifyScan], observations: [obs],
    actionIds: ['act-add', 'act-vscan'], evidenceRefs: ['obs-v'], snapshot,
    step: {skill: 'exchange_row_and_verify', inputs: {plate_id: 'plate-01', row_id: 'A',
      reservoir_id: 'media-01', wells: ROW_A}},
  }));
  assert.equal(out.ok, true, JSON.stringify(out.verification.reasons));
  assert.equal((out.verification.evidence as {target_volume_ul: number}).target_volume_ul, 330);
});

test('exchange_row_and_verify: below-target recheck FAILS with verify_below_target + next skill', async () => {
  const add = makeAction('act-add', 'media.add', {ended: 400});
  const verifyScan = makeAction('act-vscan', 'imaging.scan', {ended: 500});
  const obs = makeObservation('obs-v', 'act-vscan', {sampledAt: 490, levels: [300, 295, 312, 320, 301, 309]});
  const snapshot = state([300, 295, 312, 320, 301, 309]);
  const out = await defOf('exchange_row_and_verify').verify(makeCtx({
    owned: [{action_id: 'act-add'}, {action_id: 'act-vscan'}], actions: [add, verifyScan], observations: [obs],
    actionIds: ['act-add', 'act-vscan'], evidenceRefs: ['obs-v'], snapshot,
    step: {skill: 'exchange_row_and_verify', inputs: {plate_id: 'plate-01', row_id: 'A',
      reservoir_id: 'media-01'}},
  }));
  assert.equal(out.ok, false);
  assert.equal(out.disposition, 'fail', 'valid evidence, target missed: step must FAIL, not refuse');
  assert.equal(out.code, 'verify_below_target');
  assert.equal(out.next_skill, 'exchange_row_and_verify');
});

test('exchange_row_and_verify: an observation sampled before the maintenance ended is stale', async () => {
  const add = makeAction('act-add', 'media.add', {ended: 400});
  const obs = makeObservation('obs-old', 'act-scan0', {sampledAt: 150});
  const snapshot = state();
  const out = await defOf('exchange_row_and_verify').verify(makeCtx({
    owned: [{action_id: 'act-add'}, {action_id: 'act-scan0'}],
    actions: [add, makeAction('act-scan0', 'imaging.scan', {ended: 200})],
    observations: [obs], actionIds: ['act-add', 'act-scan0'], evidenceRefs: ['obs-old'], snapshot,
    step: {skill: 'exchange_row_and_verify', inputs: {plate_id: 'plate-01', row_id: 'A',
      reservoir_id: 'media-01'}},
  }));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'observation_stale');
});

test('exchange_row_and_verify: a maintenance under an OLD goal revision does not count', async () => {
  const add = makeAction('act-add', 'media.add', {ended: 400});
  const obs = makeObservation('obs-v', 'act-vscan', {sampledAt: 490});
  const snapshot = state();
  const out = await defOf('exchange_row_and_verify').verify(makeCtx({
    owned: [{action_id: 'act-add', goal_revision: 1}, {action_id: 'act-vscan'}],
    goalRevision: 2, actions: [add, makeAction('act-vscan', 'imaging.scan', {ended: 500})],
    observations: [obs], actionIds: ['act-add', 'act-vscan'], evidenceRefs: ['obs-v'], snapshot,
    step: {skill: 'exchange_row_and_verify', inputs: {plate_id: 'plate-01', row_id: 'A',
      reservoir_id: 'media-01'}},
  }));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'action_not_owned');
  assert.match(out.reasons.join(' '), /goal revision/);
});

// -- mix_and_rescan postcondition ---------------------------------------------------------

test('mix_and_rescan: shake + post-settle rescan passes; missing rescan or blur refuses', async () => {
  const shake = makeAction('act-shake', 'plate.shake', {ended: 600});
  const rescan = makeAction('act-rscan', 'imaging.scan', {ended: 700});
  const obs = makeObservation('obs-r', 'act-rscan', {sampledAt: 690});
  const good = await defOf('mix_and_rescan').verify(makeCtx({
    owned: [{action_id: 'act-shake'}, {action_id: 'act-rscan'}],
    actions: [shake, rescan], observations: [obs],
    actionIds: ['act-shake', 'act-rscan'], evidenceRefs: ['obs-r'],
    step: {skill: 'mix_and_rescan', inputs: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60,
      row_id: 'A', wells: ROW_A}},
  }));
  assert.equal(good.ok, true);

  const noScan = await defOf('mix_and_rescan').verify(makeCtx({
    owned: [{action_id: 'act-shake'}], actions: [shake], observations: [obs],
    actionIds: ['act-shake'], evidenceRefs: ['obs-r'],
    step: {skill: 'mix_and_rescan', inputs: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60}},
  }));
  assert.equal(noScan.ok, false);
  assert.equal(noScan.code, 'no_rescan_action');
  assert.equal(noScan.next_skill, 'scan_and_assess');

  const stillSettling = makeObservation('obs-blur', 'act-rscan', {sampledAt: 620, quality: 'blurred'});
  const blurred = await defOf('mix_and_rescan').verify(makeCtx({
    owned: [{action_id: 'act-shake'}, {action_id: 'act-rscan'}],
    actions: [shake, rescan], observations: [stillSettling],
    actionIds: ['act-shake', 'act-rscan'], evidenceRefs: ['obs-blur'],
    step: {skill: 'mix_and_rescan', inputs: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60,
      wells: ROW_A}},
  }));
  assert.equal(blurred.ok, false);
  assert.equal(blurred.code, 'observation_unusable');
});

// -- monitor_until postcondition -----------------------------------------------------------

test('monitor_until: fired sim_time wake at/after the deadline passes; early or unfired refuses', async () => {
  const base = {step: {skill: 'monitor_until', inputs: {until_sim_s: 5_500}}};
  const pass = await defOf('monitor_until').verify(makeCtx({
    ...base, firedWakes: [{wake_id: 'w1', kind: 'sim_time', target_sim_s: 5_500}],
    snapshot: state(undefined, {}, 6_000),
  }));
  assert.equal(pass.ok, true);
  assert.equal((pass.verification.evidence as {until_sim_s: number}).until_sim_s, 5_500);

  const early = await defOf('monitor_until').verify(makeCtx({
    ...base, firedWakes: [{wake_id: 'w1', kind: 'sim_time', target_sim_s: 5_500}],
    snapshot: state([400, 380, 410, 420, 395, 405], {}),
  }));
  // snapshot sim time is 5000 < 5500 → deadline not reached
  assert.equal(early.ok, false);
  assert.equal(early.code, 'deadline_not_reached');
  assert.equal(early.next_skill, 'monitor_until');

  const unfired = await defOf('monitor_until').verify(makeCtx({
    ...base, firedWakes: [], snapshot: state(undefined, {}, 6_000),
  }));
  assert.equal(unfired.ok, false);
  assert.equal(unfired.code, 'wake_not_fired');

  // N03: only the deadline wake (target >= until_sim_s) counts — an earlier
  // interval wake of the same step is not proof the deadline was reached
  const intervalOnly = await defOf('monitor_until').verify(makeCtx({
    ...base, firedWakes: [{wake_id: 'w0', kind: 'sim_time', target_sim_s: 4_800}],
    snapshot: state(undefined, {}, 6_000),
  }));
  assert.equal(intervalOnly.ok, false);
  assert.equal(intervalOnly.code, 'wake_not_fired');
  assert.match(intervalOnly.reasons.join(' '), /earlier sim time/);

  const condition = await defOf('monitor_until').verify(makeCtx({
    step: {skill: 'monitor_until', inputs: {condition: {metric: 'temperature_c', op: 'below', value: 36}}},
    firedWakes: [{wake_id: 'w2', kind: 'condition', target_sim_s: null,
      predicate: {metric: 'temperature_c', op: 'below', value: 36}}],
  }));
  assert.equal(condition.ok, true);
  const noCondition = await defOf('monitor_until').verify(makeCtx({
    step: {skill: 'monitor_until', inputs: {condition: {metric: 'temperature_c', op: 'below', value: 36}}},
    firedWakes: [],
  }));
  assert.equal(noCondition.ok, false);
  assert.equal(noCondition.code, 'condition_not_fired');
});

test('monitor_until (N03): same metric with a different op/value cannot verify the required condition', async () => {
  const step = {skill: 'monitor_until' as const,
    inputs: {condition: {metric: 'temperature_c', op: 'above', value: 45}}};
  // the real chamber sits near 37 °C and a temperature_c BELOW 38 wake fired
  const wrongOp = await defOf('monitor_until').verify(makeCtx({
    step, firedWakes: [{wake_id: 'w-below', kind: 'condition',
      predicate: {metric: 'temperature_c', op: 'below', value: 38, debounce_sim_s: 60}}],
  }));
  assert.equal(wrongOp.ok, false);
  assert.equal(wrongOp.code, 'wake_predicate_mismatch');
  assert.match(wrongOp.reasons.join(' '), /not the required temperature_c above 45/);

  const wrongValue = await defOf('monitor_until').verify(makeCtx({
    step, firedWakes: [{wake_id: 'w-val', kind: 'condition',
      predicate: {metric: 'temperature_c', op: 'above', value: 40}}],
  }));
  assert.equal(wrongValue.ok, false);
  assert.equal(wrongValue.code, 'wake_predicate_mismatch');

  // the exact condition still verifies
  const exact = await defOf('monitor_until').verify(makeCtx({
    step, firedWakes: [{wake_id: 'w-ok', kind: 'condition',
      predicate: {metric: 'temperature_c', op: 'above', value: 45, debounce_sim_s: 60, hysteresis: 2}}],
  }));
  assert.equal(exact.ok, true);
});

test('monitor_until (T01): a same-revision wake with a shorter debounce is not success evidence', async () => {
  const step = {skill: 'monitor_until' as const,
    inputs: {condition: {metric: 'temperature_c', op: 'below', value: 38}}};
  const specOverrides = {metrics: [], monitoring: {conditions: [{metric: 'temperature_c', op: 'below', value: 38,
    debounce_sim_s: 600, hysteresis: 0, cooldown_sim_s: 0}]}};
  const shortened = await defOf('monitor_until').verify(makeCtx({
    step, specOverrides, firedWakes: [{wake_id: 'w-short', kind: 'condition',
      predicate: {metric: 'temperature_c', op: 'below', value: 38, debounce_sim_s: 0}}],
  }));
  assert.equal(shortened.ok, false);
  assert.equal(shortened.code, 'debounce_shortened');
  assert.match(shortened.reasons.join(' '), /600/);
  // the goal's own hold, and a stricter one, still verify
  for (const hold of [600, 900]) {
    const ok = await defOf('monitor_until').verify(makeCtx({
      step, specOverrides, firedWakes: [{wake_id: `w-${hold}`, kind: 'condition',
        predicate: {metric: 'temperature_c', op: 'below', value: 38, debounce_sim_s: hold}}],
    }));
    assert.equal(ok.ok, true, `debounce ${hold} must cover the goal's 600s`);
  }
  // completion re-checks the recorded hold AND the wake ledger, so a step that
  // was somehow marked done on the short wake still cannot complete the goal
  const doneOnShort = {index_in_plan: 0, skill: 'monitor_until', status: 'done', plan_revision: 1,
    step_id: 'step-1', inputs: step.inputs,
    verification: {pass: true, evidence: {wake_id: 'w-short', wake_goal_revision: 1, wake_step_id: 'step-1',
      debounce_sim_s: 0}}};
  const refused = await verifyGoalSatisfied(goalCtx({
    specOverrides, planSteps: [doneOnShort],
    firedWakes: [{wake_id: 'w-short', kind: 'condition', step_id: 'step-1', goal_revision: 1,
      predicate: {metric: 'temperature_c', op: 'below', value: 38, debounce_sim_s: 0}}],
  }));
  assert.equal(refused.ok, false);
  assert.match((refused as {reasons: string[]}).reasons.join(' '), /600/);
});

test('monitor_until (N03): an old-revision wake or another step\'s wake never verifies the step', async () => {
  const step = {skill: 'monitor_until' as const, inputs: {until_sim_s: 5_500}, step_id: 'step-live'};
  // fired under goal revision 1 while the task (and this verification) is at 2
  const oldRevision = await defOf('monitor_until').verify(makeCtx({
    step, goalRevision: 2, snapshot: state(undefined, {}, 6_000),
    firedWakes: [{wake_id: 'w-old', kind: 'sim_time', target_sim_s: 5_500, goal_revision: 1, step_id: 'step-live'}],
  }));
  assert.equal(oldRevision.ok, false);
  assert.equal(oldRevision.code, 'wake_not_fired');

  // bound to a different plan step (a re-planned monitor step has a new identity)
  const otherStep = await defOf('monitor_until').verify(makeCtx({
    step, snapshot: state(undefined, {}, 6_000),
    firedWakes: [{wake_id: 'w-other', kind: 'sim_time', target_sim_s: 5_500, step_id: 'step-previous'}],
  }));
  assert.equal(otherStep.ok, false);
  assert.equal(otherStep.code, 'wake_not_fired');

  // unbound legacy rows (goal_revision null) fail closed as well
  const legacy = await defOf('monitor_until').verify(makeCtx({
    step, snapshot: state(undefined, {}, 6_000),
    firedWakes: [{wake_id: 'w-legacy', kind: 'sim_time', target_sim_s: 5_500, goal_revision: null}],
  }));
  assert.equal(legacy.ok, false);
  assert.equal(legacy.code, 'wake_not_fired');
});

// -- complete-task gate (N02) ---------------------------------------------------------------

test('planCompletionGate: failed/skipped steps block until a later verified success of the same skill and target', () => {
  const step = (index: number, status: string, pass: boolean | null, extra: Partial<{
    skill: string; plan_revision: number; inputs: Record<string, unknown>}> = {}) =>
    ({index_in_plan: index, skill: extra.skill ?? 'scan_and_assess', status,
      plan_revision: extra.plan_revision ?? 1, inputs: extra.inputs ?? null,
      verification: pass == null ? null
        : {pass, code: null, reasons: [], next_skill: null, evidence: {}, checked_at_wall: 'now'}});
  assert.equal(planCompletionGate([]).ok, true);
  assert.equal(planCompletionGate([step(0, 'done', true), step(1, 'done', true)]).ok, true);

  // N02: a failed or skipped step is NOT completable just for being terminal
  assert.equal(planCompletionGate([step(0, 'failed', false)]).ok, false, 'failed steps block completion');
  assert.equal(planCompletionGate([step(0, 'skipped', null)]).ok, false, 'skipped steps produced no success evidence');
  const skipped = planCompletionGate([step(0, 'skipped', null)]);
  assert.equal((skipped as {blockers: Array<{soft?: boolean}>}).blockers[0].soft, true,
    'skipped blockers are soft (resolvable by the goal-level check)');
  const failedGate = planCompletionGate([step(0, 'failed', false)]);
  assert.equal((failedGate as {blockers: Array<{soft?: boolean}>}).blockers[0].soft, false,
    'failed blockers are hard');

  const pending = planCompletionGate([step(0, 'done', true), step(1, 'pending', null)]);
  assert.equal(pending.ok, false);
  assert.equal((pending as {code: string}).code, 'plan_not_verifiable');
  assert.deepEqual((pending as {blockers: Array<{index: number}>}).blockers.map(b => b.index), [1]);

  const running = planCompletionGate([step(0, 'running', null)]);
  assert.equal(running.ok, false);

  const unverified = planCompletionGate([step(0, 'done', null)]);
  assert.equal(unverified.ok, false);
  assert.match((unverified as {blockers: Array<{problem: string}>}).blockers[0].problem, /verification/);
});

test('planCompletionGate: historical failure stops blocking once a LATER same-skill same-target step verified success', () => {
  const v = (pass: boolean | null) => ({verification: pass == null ? null
    : {pass, code: null, reasons: [], next_skill: null, evidence: {}, checked_at_wall: 'now'}});
  const exchange = (index: number, status: string, pass: boolean | null, planRevision = 1,
    inputs: Record<string, unknown> = {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01'}) =>
    ({index_in_plan: index, skill: 'exchange_row_and_verify', status, plan_revision: planRevision,
      inputs, ...v(pass)});

  // later index, same plan: remediation succeeded → completable
  assert.equal(planCompletionGate([
    exchange(0, 'failed', false),
    exchange(3, 'done', true),
    {index_in_plan: 1, skill: 'monitor_until', status: 'done', plan_revision: 1,
      inputs: {until_sim_s: 600}, ...v(true)},
  ]).ok, true, 'a later verified exchange of the same target supersedes the failure');

  // a different target (row B) does not supersede a failure on row A
  assert.equal(planCompletionGate([
    exchange(0, 'failed', false),
    exchange(3, 'done', true, 1, {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01'}),
  ]).ok, false, 'remediation of another row does not supersede');

  // a different skill does not supersede
  assert.equal(planCompletionGate([
    exchange(0, 'failed', false),
    {index_in_plan: 2, skill: 'scan_and_assess', status: 'done', plan_revision: 1,
      inputs: {plate_id: 'plate-01', row_id: 'A'}, ...v(true)},
  ]).ok, false, 'another skill never supersedes');

  // an EARLIER verified step does not supersede a LATER failure
  assert.equal(planCompletionGate([
    exchange(0, 'done', true),
    exchange(3, 'failed', false),
  ]).ok, false, 'only later success supersedes');

  // skipped steps never count as success — not even for another skipped step
  assert.equal(planCompletionGate([
    exchange(0, 'skipped', null),
    exchange(3, 'skipped', null),
  ]).ok, false, 'skipped never supersedes');

  // a step of a NEWER plan revision supersedes the old plan's failure
  assert.equal(planCompletionGate([
    exchange(0, 'failed', false, 1),
    exchange(0, 'done', true, 2),
  ]).ok, true, 'the re-planned step supersedes the old plan revision\'s failure');
});

// -- goal-level success check (N02) ----------------------------------------------------------

function goalCtx(input: {
  owned?: Array<{action_id: string; task_id?: string; goal_revision?: number}>;
  actions?: Action[];
  observations?: Observation[];
  snapshot?: StateSnapshot;
  observationRefs?: string[];
  maintenance?: string[];
  specOverrides?: Record<string, unknown>;
  goalRevision?: number;
  planSteps?: Array<{index_in_plan: number; skill: string; status: string;
    plan_revision?: number; step_id?: string | null; inputs?: Record<string, unknown> | null;
    verification?: {pass: boolean | null; evidence?: Record<string, unknown>} | null}>;
  firedWakes?: Array<{wake_id: string; kind: string; task_id?: string; target_sim_s?: number | null;
    predicate?: Record<string, unknown> | null; goal_revision?: number | null; step_id?: string | null}>;
}): GoalVerifyContext {
  const ledger = new Map<string, {task_id: string; goal_revision: number}>();
  for (const o of input.owned ?? []) {
    ledger.set(o.action_id, {task_id: o.task_id ?? 'task-1', goal_revision: o.goal_revision ?? 1});
  }
  const actions = new Map((input.actions ?? []).map(a => [a.action_id, a]));
  const observations = new Map((input.observations ?? []).map(o => [o.observation_id, o]));
  return {
    task_id: 'task-1', goal_revision: input.goalRevision ?? 1,
    spec: spec(['imaging.scan', 'media.add'], input.specOverrides),
    observationRefs: input.observationRefs ?? [],
    maintenanceActionIds: input.maintenance ?? [],
    planSteps: input.planSteps?.map(s => ({index_in_plan: s.index_in_plan, skill: s.skill,
      status: s.status, plan_revision: s.plan_revision ?? 1, step_id: s.step_id ?? null,
      inputs: s.inputs ?? null,
      verification: s.verification == null ? null
        : {pass: s.verification.pass, code: null, reasons: [], next_skill: null,
          evidence: s.verification.evidence ?? {}, checked_at_wall: 'now'}})),
    // pass firedWakes ONLY when the fixture provides them: an explicitly empty
    // ledger is a valid fail-closed cross-check, an absent one skips it
    ...(input.firedWakes ? {firedWakes: input.firedWakes.map(w => ({wake_id: w.wake_id,
      task_id: w.task_id ?? 'task-1', kind: w.kind, target_sim_s: w.target_sim_s ?? null,
      predicate: w.predicate ?? null, fired_at_wall: 'now',
      goal_revision: w.goal_revision ?? null, step_id: w.step_id ?? null}))} : {}),
    ownsAction: id => ledger.get(id) ?? null,
    readAction: async id => actions.get(id) ?? null,
    readObservation: async id => observations.get(id) ?? null,
    readState: async () => input.snapshot ?? state(),
  };
}

test('verifyGoalSatisfied: met metrics pass; unmet or unverifiable metrics refuse with codes', async () => {
  const scan = makeAction('act-vscan', 'imaging.scan', {ended: 500});
  const obs = makeObservation('obs-v', 'act-vscan', {sampledAt: 520, levels: [345, 338, 352, 360, 341, 349]});
  const met = await verifyGoalSatisfied(goalCtx({
    owned: [{action_id: 'act-vscan'}], actions: [scan], observations: [obs], observationRefs: ['obs-v'],
    snapshot: state([345, 338, 352, 360, 341, 349]),
  }));
  assert.equal(met.ok, true);
  assert.equal((met as {evidence: {mode: string}}).evidence.mode, 'metrics_verified');

  // a well that misses the target
  const unmet = await verifyGoalSatisfied(goalCtx({
    owned: [{action_id: 'act-vscan'}], actions: [scan],
    observations: [makeObservation('obs-lo', 'act-vscan', {sampledAt: 520, levels: [300, 338, 352, 360, 341, 349]})],
    observationRefs: ['obs-lo'],
    snapshot: state([300, 338, 352, 360, 341, 349]),
  }));
  assert.equal(unmet.ok, false);
  assert.equal((unmet as {code: string}).code, 'goal_unmet');
  assert.match((unmet as {reasons: string[]}).reasons.join(' '), /A1/);

  // no usable evidence at all
  const unverified = await verifyGoalSatisfied(goalCtx({observationRefs: []}));
  assert.equal(unverified.ok, false);
  assert.equal((unverified as {code: string}).code, 'goal_unverified');

  // a freshest observation that predates the last succeeded maintenance of
  // this task does not verify the goal
  const add = makeAction('act-add', 'media.add', {ended: 600});
  const staleAfterMaintenance = await verifyGoalSatisfied(goalCtx({
    owned: [{action_id: 'act-vscan'}, {action_id: 'act-add'}], actions: [scan, add],
    observations: [obs], observationRefs: ['obs-v'], maintenance: ['act-add'],
  }));
  assert.equal(staleAfterMaintenance.ok, false);
  assert.equal((staleAfterMaintenance as {code: string}).code, 'goal_unverified');
  assert.match((staleAfterMaintenance as {reasons: string[]}).reasons.join(' '), /after the last maintenance/);

  // another task's / an old revision's observation does not verify the goal
  const foreign = await verifyGoalSatisfied(goalCtx({
    owned: [{action_id: 'act-vscan', task_id: 'task-OTHER'}], actions: [scan], observations: [obs],
    observationRefs: ['obs-v'],
  }));
  assert.equal(foreign.ok, false);
  assert.equal((foreign as {code: string}).code, 'goal_unverified');

  // chamber metrics read the live chamber; a missed chamber target refuses
  const chamberOk = await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [{metric: 'temperature_c', op: '>=', value: 36, source: 'chamber'}]},
    observationRefs: [],
  }));
  assert.equal(chamberOk.ok, true, 'live chamber satisfies the metric');
  const chamberBad = await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [{metric: 'temperature_c', op: '>=', value: 40, source: 'chamber'}]},
    observationRefs: [],
  }));
  assert.equal(chamberBad.ok, false);
  assert.equal((chamberBad as {code: string}).code, 'goal_unmet');

  // Q03: a metric-less goal with NO deadline, NO monitoring conditions and NO
  // plan can no longer complete on nothing (previously mode plan_only ok)
  const noEvidence = await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: []}, observationRefs: [],
  }));
  assert.equal(noEvidence.ok, false);
  assert.equal((noEvidence as {code: string}).code, 'goal_unverified');
  assert.match((noEvidence as {reasons: string[]}).reasons.join(' '), /no verifiable success condition/);
});

// -- Q03: metric-less goals need verifiable success evidence -------------------

test('verifyGoalSatisfied (Q03): metric-less goals verify on deadline or matching monitor_until evidence only', async () => {
  // S02: a done+verified monitor step carries the proving wake's revision and
  // step binding on its verification evidence (written by monitor_until.verify)
  const monitorStep = (inputs: Record<string, unknown>, pass: boolean | null = true, status = 'done',
    extra: {plan_revision?: number; step_id?: string | null; wake_goal_revision?: number | null} = {}) =>
    ({index_in_plan: 0, skill: 'monitor_until', status, inputs,
      plan_revision: extra.plan_revision ?? 1, step_id: extra.step_id ?? null,
      verification: pass == null ? null
        : {pass, evidence: {wake_id: 'w-q03', wake_goal_revision: extra.wake_goal_revision ?? 1,
          wake_step_id: extra.step_id ?? null}}});
  // 1) deadline already reached on the authoritative clock → success evidence
  const deadlineReached = await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [], deadline_sim_s: 4_000},
    snapshot: state(undefined, {}, 5_000),
  }));
  assert.equal(deadlineReached.ok, true);
  assert.equal((deadlineReached as {evidence: {mode: string}}).evidence.mode, 'plan_only');

  // 2) deadline not reached, empty plan → refused (the Q03 oracle case)
  const deadlinePending = await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [], deadline_sim_s: 6_000},
    snapshot: state(undefined, {}, 5_000),
  }));
  assert.equal(deadlinePending.ok, false);
  assert.equal((deadlinePending as {code: string}).code, 'goal_unverified');
  assert.match((deadlinePending as {reasons: string[]}).reasons.join(' '), /deadline_sim_s=6000 is not reached/);

  // 3) a done+verified monitor_until step that waited out the deadline counts
  const stepEvidence = await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [], deadline_sim_s: 6_000},
    snapshot: state(undefined, {}, 5_000),
    planSteps: [monitorStep({until_sim_s: 6_000})],
  }));
  assert.equal(stepEvidence.ok, true, JSON.stringify((stepEvidence as {reasons?: string[]}).reasons));
  // a compatible LATER wait (until_sim_s past the deadline) is evidence too
  assert.equal((await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [], deadline_sim_s: 6_000},
    snapshot: state(undefined, {}, 5_000),
    planSteps: [monitorStep({until_sim_s: 7_200})],
  }))).ok, true, 'until_sim_s >= deadline_sim_s is compatible');

  // 4) a monitor step that only waited to an EARLIER sim time is not evidence
  assert.equal((await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [], deadline_sim_s: 6_000},
    snapshot: state(undefined, {}, 5_000),
    planSteps: [monitorStep({until_sim_s: 5_500})],
  }))).ok, false, 'until_sim_s < deadline_sim_s does not cover the deadline');

  // 5) done WITHOUT a passing verification (or not done) is not evidence
  for (const step of [monitorStep({until_sim_s: 6_000}, false), monitorStep({until_sim_s: 6_000}, null),
    monitorStep({until_sim_s: 6_000}, true, 'pending')]) {
    assert.equal((await verifyGoalSatisfied(goalCtx({
      specOverrides: {metrics: [], deadline_sim_s: 6_000},
      snapshot: state(undefined, {}, 5_000),
      planSteps: [step],
    }))).ok, false, `step status/pass ${step.status}/${String(step.verification?.pass)} is not success evidence`);
  }

  // 6) monitoring conditions: an IDENTICAL predicate on a done+verified
  // monitor_until step is success evidence
  const conditions = [{metric: 'temperature_c', op: 'below' as const, value: 36,
    debounce_sim_s: 60, hysteresis: 2, cooldown_sim_s: 1_800}];
  assert.equal((await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [], monitoring: {conditions}},
    planSteps: [monitorStep({condition: {metric: 'temperature_c', op: 'below', value: 36}})],
  }))).ok, true, 'identical condition predicate verifies');

  // a different threshold (or op) does not match the declared condition
  for (const wrong of [{metric: 'temperature_c', op: 'below', value: 37},
    {metric: 'temperature_c', op: 'above', value: 36}]) {
    const mismatch = await verifyGoalSatisfied(goalCtx({
      specOverrides: {metrics: [], monitoring: {conditions}},
      planSteps: [monitorStep({condition: wrong})],
    }));
    assert.equal(mismatch.ok, false, JSON.stringify(wrong));
    assert.match((mismatch as {reasons: string[]}).reasons.join(' '), /no done\+verified monitor_until step/);
  }

  // 7) another skill's done+pass step is never monitor evidence
  assert.equal((await verifyGoalSatisfied(goalCtx({
    specOverrides: {metrics: [], deadline_sim_s: 6_000},
    snapshot: state(undefined, {}, 5_000),
    planSteps: [{index_in_plan: 0, skill: 'scan_and_assess', status: 'done', inputs: {plate_id: 'plate-01'},
      verification: {pass: true}}],
  }))).ok, false, 'only monitor_until steps carry monitor evidence');
});

// -- S02: monitor success evidence must belong to the CURRENT goal revision --------------

test('verifyGoalSatisfied (S02): old-revision monitor evidence cannot complete a revised goal; re-verified r2 evidence can', async () => {
  const conditions = [{metric: 'temperature_c', op: 'below' as const, value: 38,
    debounce_sim_s: 0, hysteresis: 0, cooldown_sim_s: 0}];
  const specOverrides = {metrics: [], monitoring: {conditions}};
  const stepInputs = {condition: {metric: 'temperature_c', op: 'below', value: 38}};
  // r1 lifecycle: plan revision 1, step verified by a wake armed under revision 1
  const r1Step = {index_in_plan: 0, skill: 'monitor_until', status: 'done', plan_revision: 1,
    step_id: 'step-r1', inputs: stepInputs,
    verification: {pass: true, evidence: {wake_id: 'w1', wake_goal_revision: 1, wake_step_id: 'step-r1'}}};
  const w1 = {wake_id: 'w1', kind: 'condition', goal_revision: 1, step_id: 'step-r1',
    predicate: {metric: 'temperature_c', op: 'below', value: 38}};

  // positive control: r1 evidence completes the r1 goal (also with the fired-wake ledger)
  for (const firedWakes of [undefined, [w1]]) {
    const r1 = await verifyGoalSatisfied(goalCtx({specOverrides, planSteps: [r1Step], firedWakes}));
    assert.equal(r1.ok, true, `valid r1 monitor evidence must complete the r1 goal (ledger ${firedWakes ? 'given' : 'absent'})`);
  }

  // the goal is edited to r2 (same threshold, longer debounce) and NO new
  // proof exists: the old verified step is history, completion is refused
  const r2 = await verifyGoalSatisfied(goalCtx({
    specOverrides, goalRevision: 2, planSteps: [r1Step], firedWakes: [w1],
  }));
  assert.equal(r2.ok, false);
  assert.equal((r2 as {code: string}).code, 'goal_unverified');
  assert.match((r2 as {reasons: string[]}).reasons.join(' '),
    /revision 1 .*the task is at revision 2.*re-register and verify.*revision 2/s,
    'the refusal must say the old-revision wait is history and must be re-registered/verified under the current revision');

  // a stale step WITHOUT the fired-wake ledger is equally refused (plan_revision alone decides)
  const r2NoLedger = await verifyGoalSatisfied(goalCtx({
    specOverrides, goalRevision: 2, planSteps: [r1Step],
  }));
  assert.equal(r2NoLedger.ok, false);
  assert.equal((r2NoLedger as {code: string}).code, 'goal_unverified');

  // the model re-plans under r2, arms + verifies a NEW wait bound to the new
  // step: r2 now completes even though the old r1 step row is still around
  const r2Step = {index_in_plan: 0, skill: 'monitor_until', status: 'done', plan_revision: 2,
    step_id: 'step-r2', inputs: stepInputs,
    verification: {pass: true, evidence: {wake_id: 'w2', wake_goal_revision: 2, wake_step_id: 'step-r2'}}};
  const w2 = {wake_id: 'w2', kind: 'condition', goal_revision: 2, step_id: 'step-r2',
    predicate: {metric: 'temperature_c', op: 'below', value: 38}};
  const reverified = await verifyGoalSatisfied(goalCtx({
    specOverrides, goalRevision: 2, planSteps: [{...r1Step, index_in_plan: 0}, {...r2Step, index_in_plan: 1}],
    firedWakes: [w1, w2],
  }));
  assert.equal(reverified.ok, true, 'a monitor wait verified under the CURRENT revision completes the revised goal');

  // forged attribution: current plan revision but the proving wake was of the
  // OLD revision — refused (the recorded wake revision must be current too)
  const forged = await verifyGoalSatisfied(goalCtx({
    specOverrides, goalRevision: 2,
    planSteps: [{...r2Step, verification: {pass: true,
      evidence: {wake_id: 'w1', wake_goal_revision: 1, wake_step_id: 'step-r2'}}}],
    firedWakes: [w1],
  }));
  assert.equal(forged.ok, false, 'a current-plan step whose proving wake was armed under an old revision is not evidence');

  // the fired-wake ledger cross-check: evidence claims the current revision,
  // but no fired wake row of THIS task carries it — refused
  const ghost = await verifyGoalSatisfied(goalCtx({
    specOverrides, goalRevision: 2, planSteps: [r2Step], firedWakes: [w1],
  }));
  assert.equal(ghost.ok, false, 'a wake row of another revision/task never backs the claimed evidence');
  const foreignTask = await verifyGoalSatisfied(goalCtx({
    specOverrides, goalRevision: 2, planSteps: [r2Step],
    firedWakes: [{...w2, task_id: 'task-OTHER'}],
  }));
  assert.equal(foreignTask.ok, false, 'another task\'s fired wake never backs the claimed evidence');

  // a verification row without the recorded wake revision (legacy/hand-made)
  // fails closed: it cannot be attributed to the current goal version
  const legacy = await verifyGoalSatisfied(goalCtx({
    specOverrides, planSteps: [{...r1Step, verification: {pass: true, evidence: {}}}],
  }));
  assert.equal(legacy.ok, false, 'evidence without a recorded wake revision is not success evidence');
});

// -- S03: unknown metric targets refuse instead of a zero-well pass ------------------------

test('verifyGoalSatisfied (S03): unknown plate/row/well metric targets refuse completion, never a zero-check pass', async () => {
  // row Z: no in-scope plate carries it (the device has rows A–D only)
  const rowZ = await verifyGoalSatisfied(goalCtx({
    specOverrides: {scope: {plates: ['plate-01'], rows: ['Z']},
      metrics: [{metric: 'medium_volume_ul', op: '>=', value: 1000, source: 'observation', row_id: 'Z'}]},
    observationRefs: [],
  }));
  assert.equal(rowZ.ok, false, 'a nonexistent target row must not complete with zero checked wells');
  assert.equal((rowZ as {code: string}).code, 'goal_unverified');
  assert.match((rowZ as {reasons: string[]}).reasons.join(' '), /row 'Z' does not exist/);
  assert.match((rowZ as {reasons: string[]}).reasons.join(' '), /no verifiable well range/);

  // scope.rows Z with a metric WITHOUT row_id (the range comes from the scope)
  const scopeRowZ = await verifyGoalSatisfied(goalCtx({
    specOverrides: {scope: {plates: ['plate-01'], rows: ['Z']},
      metrics: [{metric: 'medium_volume_ul', op: '>=', value: 1000, source: 'observation'}]},
    observationRefs: [],
  }));
  assert.equal(scopeRowZ.ok, false);
  assert.match((scopeRowZ as {reasons: string[]}).reasons.join(' '), /row 'Z' does not exist/);

  // unknown plate
  const ghostPlate = await verifyGoalSatisfied(goalCtx({
    specOverrides: {scope: {plates: ['plate-ghost']},
      metrics: [{metric: 'medium_volume_ul', op: '>=', value: 1000, source: 'observation', row_id: 'A'}]},
    observationRefs: [],
  }));
  assert.equal(ghostPlate.ok, false);
  assert.match((ghostPlate as {reasons: string[]}).reasons.join(' '), /plate 'plate-ghost' does not exist/);

  // unknown well
  const ghostWell = await verifyGoalSatisfied(goalCtx({
    specOverrides: {scope: {plates: ['plate-01']},
      metrics: [{metric: 'medium_volume_ul', op: '>=', value: 1000, source: 'observation', well_id: 'Z9'}]},
    observationRefs: [],
  }));
  assert.equal(ghostWell.ok, false);
  assert.match((ghostWell as {reasons: string[]}).reasons.join(' '), /well 'Z9' does not exist/);

  // mixed valid + invalid: row A has real passing evidence, row Z is unknown —
  // the goal still refuses and NAMES the invalid target
  const scan = makeAction('act-vscan', 'imaging.scan', {ended: 500});
  const obs = makeObservation('obs-v', 'act-vscan', {sampledAt: 520, levels: [345, 338, 352, 360, 341, 349]});
  const mixed = await verifyGoalSatisfied(goalCtx({
    specOverrides: {scope: {plates: ['plate-01'], rows: ['A', 'Z']},
      metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'},
        {metric: 'medium_volume_ul', op: '>=', value: 1000, source: 'observation', row_id: 'Z'}]},
    owned: [{action_id: 'act-vscan'}], actions: [scan], observations: [obs], observationRefs: ['obs-v'],
    snapshot: state([345, 338, 352, 360, 341, 349]),
  }));
  assert.equal(mixed.ok, false, 'a valid metric cannot mask an invalid one');
  assert.equal((mixed as {code: string}).code, 'goal_unverified');
  assert.match((mixed as {reasons: string[]}).reasons.join(' '), /row 'Z' does not exist/);

  // control: the same valid row-A evidence alone still passes
  const validOnly = await verifyGoalSatisfied(goalCtx({
    specOverrides: {scope: {plates: ['plate-01'], rows: ['A']},
      metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'}]},
    owned: [{action_id: 'act-vscan'}], actions: [scan], observations: [obs], observationRefs: ['obs-v'],
    snapshot: state([345, 338, 352, 360, 341, 349]),
  }));
  assert.equal(validOnly.ok, true, 'valid, layout-checked targets keep verifying');
});

// -- Q04: per-well aggregation of observation evidence --------------------------

test('verifyGoalSatisfied (Q04): per-well freshest usable observation proves multirow goals', async () => {
  const rowB = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'];
  const multirow = {
    scope: {plates: ['plate-01'], rows: ['A', 'B']},
    metrics: [{metric: 'medium_volume_ul', op: '>=' as const, value: 330, source: 'observation' as const, row_id: 'A'},
      {metric: 'medium_volume_ul', op: '>=' as const, value: 330, source: 'observation' as const, row_id: 'B'}],
  };
  const scanA = makeAction('act-scanA', 'imaging.scan', {ended: 300});
  const scanB = makeAction('act-scanB', 'imaging.scan', {ended: 400, args: {plate_id: 'plate-01', wells: rowB, mode: 'mono'}});
  const obsA = makeObservation('obs-a', 'act-scanA', {sampledAt: 290});
  const obsB = makeObservation('obs-b', 'act-scanB', {sampledAt: 390, wells: rowB,
    levels: [790, 800, 810, 795, 805, 815]});

  // two separate single-row scans of the SAME plate jointly verify both rows
  const joint = await verifyGoalSatisfied(goalCtx({
    specOverrides: multirow, observationRefs: ['obs-a', 'obs-b'],
    owned: [{action_id: 'act-scanA'}, {action_id: 'act-scanB'}],
    actions: [scanA, scanB], observations: [obsA, obsB],
  }));
  assert.equal(joint.ok, true, JSON.stringify((joint as {reasons?: string[]}).reasons));
  const metricsEvidence = (joint as unknown as {evidence: {metrics: Array<{row_id: string;
    wells: Array<{well_id: string; observation_id: string}>; observations: Array<{observation_id: string}>}>}}).evidence.metrics;
  assert.ok(metricsEvidence.every(m => m.wells.length === 6));
  assert.ok(metricsEvidence.find(m => m.row_id === 'A')!.wells.every(w => w.observation_id === 'obs-a'),
    'row A proved by its own scan');
  assert.ok(metricsEvidence.find(m => m.row_id === 'B')!.wells.every(w => w.observation_id === 'obs-b'),
    'row B proved by its own scan');

  // one full-coverage observation also verifies (control)
  const full = makeObservation('obs-full', 'act-scanB', {sampledAt: 390, wells: [...ROW_A, ...rowB],
    levels: [400, 380, 410, 420, 395, 405, 790, 800, 810, 795, 805, 815]});
  assert.equal((await verifyGoalSatisfied(goalCtx({
    specOverrides: multirow, observationRefs: ['obs-full'],
    owned: [{action_id: 'act-scanB'}], actions: [scanB], observations: [full],
  }))).ok, true, 'a single full scan verifies the same goal');

  // a NEWER reading of the same wells that misses the target must NOT be
  // hidden by the older passing evidence: the freshest usable observation
  // decides the well verdict
  const rowAOnly = {
    scope: {plates: ['plate-01'], rows: ['A']},
    metrics: [{metric: 'medium_volume_ul', op: '>=' as const, value: 330, source: 'observation' as const, row_id: 'A'}],
  };
  const later = makeObservation('obs-late', 'act-scanB', {sampledAt: 500,
    levels: [400, 300, 410, 420, 395, 405]});   // A2 dropped to 300 < 330
  const masked = await verifyGoalSatisfied(goalCtx({
    specOverrides: rowAOnly, observationRefs: ['obs-a', 'obs-late'],
    owned: [{action_id: 'act-scanA'}, {action_id: 'act-scanB'}],
    actions: [scanA, scanB], observations: [obsA, later],
  }));
  assert.equal(masked.ok, false);
  assert.equal((masked as {code: string}).code, 'goal_unmet');
  assert.match((masked as {reasons: string[]}).reasons.join(' '), /well A2 .*observation obs-late/);

  // a newer but NON-usable observation (stale plate revision) never hides the
  // still-valid usable one — the verdict comes from the freshest USABLE read
  const staleRev = makeObservation('obs-stalerev', 'act-scanB', {sampledAt: 500, plateRevision: 1});
  assert.equal((await verifyGoalSatisfied(goalCtx({
    specOverrides: rowAOnly, observationRefs: ['obs-a', 'obs-stalerev'],
    owned: [{action_id: 'act-scanA'}, {action_id: 'act-scanB'}],
    actions: [scanA, scanB], observations: [obsA, staleRev],
  }))).ok, true, 'the freshest USABLE observation decides');
});

// -- N03: evidence must bind to the step's actual target -------------------------------------

test('exchange_row_and_verify: a maintenance of ANOTHER row/plate/reservoir is action_target_mismatch', async () => {
  const obs = makeObservation('obs-v', 'act-vscan', {sampledAt: 490, levels: [345, 338, 352, 360, 341, 349]});
  const snapshot = state([345, 338, 352, 360, 341, 349]);
  const base = {
    observations: [obs], evidenceRefs: ['obs-v'], snapshot,
    step: {skill: 'exchange_row_and_verify' as const, inputs: {plate_id: 'plate-01', row_id: 'A',
      reservoir_id: 'media-01', wells: ROW_A}},
    owned: [{action_id: 'act-add'}, {action_id: 'act-vscan'}],
    actions: [makeAction('act-vscan', 'imaging.scan', {ended: 500})],
  };
  // same task, row B maintenance, fresh row-A observation that meets the target
  const wrongRow = await defOf('exchange_row_and_verify').verify(makeCtx({
    ...base, actionIds: ['act-add-b', 'act-vscan'],
    owned: [{action_id: 'act-add-b'}, {action_id: 'act-vscan'}],
    actions: [...base.actions, makeAction('act-add-b', 'media.add',
      {ended: 400, args: {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01', volume_ul_per_well: 10}})],
  }));
  assert.equal(wrongRow.ok, false);
  assert.equal(wrongRow.code, 'action_target_mismatch');
  assert.match(wrongRow.reasons.join(' '), /row 'B', not 'A'/);

  // wrong reservoir
  const wrongReservoir = await defOf('exchange_row_and_verify').verify(makeCtx({
    ...base, actionIds: ['act-add-r', 'act-vscan'],
    owned: [{action_id: 'act-add-r'}, {action_id: 'act-vscan'}],
    actions: [...base.actions, makeAction('act-add-r', 'media.add',
      {ended: 400, args: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-02', volume_ul_per_well: 10}})],
  }));
  assert.equal(wrongReservoir.ok, false);
  assert.equal(wrongReservoir.code, 'action_target_mismatch');
  assert.match(wrongReservoir.reasons.join(' '), /reservoir 'media-02', not 'media-01'/);

  // wrong plate
  const wrongPlate = await defOf('exchange_row_and_verify').verify(makeCtx({
    ...base, actionIds: ['act-add-p', 'act-vscan'],
    owned: [{action_id: 'act-add-p'}, {action_id: 'act-vscan'}],
    actions: [...base.actions, makeAction('act-add-p', 'media.add',
      {ended: 400, args: {plate_id: 'plate-02', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10}})],
  }));
  assert.equal(wrongPlate.ok, false);
  assert.equal(wrongPlate.code, 'action_target_mismatch');
  assert.match(wrongPlate.reasons.join(' '), /plate 'plate-02', not 'plate-01'/);
});

test('scan_and_assess / mix_and_rescan: actions of another plate or incomplete row coverage refuse', async () => {
  // a scan of plate-02 cannot verify a plate-01 step even with a covering observation
  const foreignScan = await defOf('scan_and_assess').verify(makeCtx({
    owned: [{action_id: 'act-scan2'}],
    actions: [makeAction('act-scan2', 'imaging.scan',
      {args: {plate_id: 'plate-02', wells: ROW_A, mode: 'mono'}})],
    observations: [makeObservation('obs-2', 'act-scan2')], actionIds: ['act-scan2'], evidenceRefs: ['obs-2'],
    step: {skill: 'scan_and_assess', inputs: {plate_id: 'plate-01', row_id: 'A', wells: ROW_A}},
  }));
  assert.equal(foreignScan.ok, false);
  assert.equal(foreignScan.code, 'action_target_mismatch');

  // a partial-row scan (half the wells) does not cover the step
  const partial = await defOf('scan_and_assess').verify(makeCtx({
    owned: [{action_id: 'act-half'}],
    actions: [makeAction('act-half', 'imaging.scan', {args: {plate_id: 'plate-01', wells: ['A1', 'A2'], mode: 'mono'}})],
    observations: [makeObservation('obs-h', 'act-half', {wells: ['A1', 'A2'], levels: [400, 380]})],
    actionIds: ['act-half'], evidenceRefs: ['obs-h'],
    step: {skill: 'scan_and_assess', inputs: {plate_id: 'plate-01', row_id: 'A', wells: ROW_A}},
  }));
  assert.equal(partial.ok, false);
  assert.equal(partial.code, 'action_target_mismatch');
  assert.match(partial.reasons.join(' '), /did not cover the step's wells/);

  // a shake of another plate cannot verify a plate-01 mix step
  const shake = makeAction('act-shake2', 'plate.shake',
    {ended: 600, args: {plate_id: 'plate-02', speed_rpm: 300, duration_sim_s: 60}});
  const rescan = makeAction('act-rscan', 'imaging.scan', {ended: 700});
  const obs = makeObservation('obs-r', 'act-rscan', {sampledAt: 690});
  const wrongPlateShake = await defOf('mix_and_rescan').verify(makeCtx({
    owned: [{action_id: 'act-shake2'}, {action_id: 'act-rscan'}],
    actions: [shake, rescan], observations: [obs],
    actionIds: ['act-shake2', 'act-rscan'], evidenceRefs: ['obs-r'],
    step: {skill: 'mix_and_rescan', inputs: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60,
      row_id: 'A', wells: ROW_A}},
  }));
  assert.equal(wrongPlateShake.ok, false);
  assert.equal(wrongPlateShake.code, 'action_target_mismatch');
  assert.match(wrongPlateShake.reasons.join(' '), /plate 'plate-02', not 'plate-01'/);
});

test('exchange_row_and_verify: an observation not produced by a CITED scan of this step refuses', async () => {
  const add = makeAction('act-add', 'media.add', {ended: 400});
  const otherScan = makeAction('act-otherscan', 'imaging.scan', {ended: 500});
  const obs = makeObservation('obs-v', 'act-otherscan', {sampledAt: 490, levels: [345, 338, 352, 360, 341, 349]});
  const out = await defOf('exchange_row_and_verify').verify(makeCtx({
    owned: [{action_id: 'act-add'}, {action_id: 'act-otherscan'}],
    actions: [add, otherScan], observations: [obs],
    actionIds: ['act-add'], evidenceRefs: ['obs-v'],
    step: {skill: 'exchange_row_and_verify', inputs: {plate_id: 'plate-01', row_id: 'A',
      reservoir_id: 'media-01'}},
  }));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'observation_not_from_step_action');
});

test('defaultTolerance grows with the target', () => {
  assert.equal(defaultTolerance(100), 10);
  assert.equal(defaultTolerance(330), Math.ceil(330 * 0.03));
});
