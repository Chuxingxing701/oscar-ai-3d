// Versioned, verifiable skills (R08; design §2.4 + §5, prompt D3). A plan is
// not free text: every step names an explicitly versioned skill from this
// registry. Each skill defines
//   - a validated input schema (plate/row/wells/reservoir/targets/...),
//   - preconditions checked against the AUTHORITATIVE device state + the
//     GoalSpec scope/allowed_operations at plan time and again at step start,
//   - the ordered device capabilities it may use — every device write still
//     goes through the session executor (permissions/budget/revision/intent;
//     a skill NEVER submits directly), and
//   - a postcondition evaluator that decides `done` from verifiable
//     evidence: action ids that belong to THIS task and the CURRENT goal
//     revision (session intent ledger) in terminal status `succeeded`, plus
//     observations that are FRESH (sampled after the action ended, matching
//     plate_id and the current plate revision, covering the step's wells,
//     usable quality) and meet the goal target. `failed`/`cancelled`/`partial`
//     actions, old/other-plate/unowned evidence or a missed target can never
//     produce a silent `done`: they refuse the step or fail it with a reason
//     code and an explicit recommended next skill.
import type {Action, Observation, StateSnapshot} from '@oscar/device-contract';
import {DEMO_PROFILE} from '@oscar/device-contract';
import type {GoalSpec} from './goal.ts';

// -- shared types -----------------------------------------------------------------

/** What the scheduler knows about a fired wake (monitor_until evidence). */
export interface SkillFiredWake {
  wake_id: string;
  task_id: string;
  kind: string;
  target_sim_s: number | null;
  predicate: Record<string, unknown> | null;
  fired_at_wall: string | null;
  /** N03: goal revision the wake was armed under; null = pre-binding legacy
   * row, which never verifies (fail closed against old-revision wakes). */
  goal_revision: number | null;
  /** N03: plan step the wake was bound to (monitor_until); null = unbound. */
  step_id: string | null;
}

/** Evaluator result persisted on the plan step (and emitted as plan.step). */
export interface StepVerification {
  /** true = postconditions confirmed; false = refused/failed; null = not evaluated (reported failed/skipped). */
  pass: boolean | null;
  code: string | null;
  reasons: string[];
  /** Recommended next skill for a failed/refused verification (failure branch). */
  next_skill: string | null;
  evidence: Record<string, unknown>;
  checked_at_wall: string;
}

export type VerifyOutcome =
  | {ok: true; verification: StepVerification}
  | {ok: false; disposition: 'refuse' | 'fail'; code: string; reasons: string[];
    next_skill: string; verification: StepVerification};

/** Everything a postcondition evaluator may read. All device reads go through
 * the Runtime (authoritative); intent ownership comes from the session ledger. */
export interface SkillVerifyContext {
  task_id: string;
  goal_revision: number;
  spec: GoalSpec;
  step: {index: number; skill: string; skill_version: string | null;
    inputs: Record<string, unknown> | null;
    /** N03: persisted step identity, so wake evidence binds to THIS step. */
    step_id?: string | null;
    plan_revision?: number | null};
  action_ids: string[];
  evidence_refs: string[];
  /** Intent-ledger binding for an action id: owning task + goal revision, or null when unknown. */
  ownsAction(actionId: string): {task_id: string; goal_revision: number} | null;
  readAction(actionId: string): Promise<Action | null>;
  readObservation(observationId: string): Promise<Observation | null>;
  readState(): Promise<StateSnapshot>;
  firedWakes: SkillFiredWake[];
}

export interface SkillDefinition {
  readonly skill: string;
  /** Explicit, persisted version of this definition. */
  readonly version: string;
  readonly description: string;
  /** Ordered device capabilities this skill may drive (still via the executor). */
  readonly capabilities: string[];
  /** Declared postconditions, persisted on every step of this skill. */
  readonly postconditions: Record<string, unknown>;
  /** Machine-readable input schema surfaced to the model in the tool description. */
  readonly inputSchema: Record<string, unknown>;
  validateInputs(raw: unknown): {ok: true; inputs: Record<string, unknown>} | {ok: false; problems: string[]};
  /** Preconditions against the authoritative state + GoalSpec (plan time AND step start). */
  checkPreconditions(input: {inputs: Record<string, unknown>; spec: GoalSpec; state: StateSnapshot}):
    {ok: true; notes: string[]} | {ok: false; problems: string[]};
  verify(ctx: SkillVerifyContext): Promise<VerifyOutcome>;
}

export interface ResolvedSkill {
  skill: string;
  version: string;
  inputs: Record<string, unknown>;
  def: SkillDefinition;
}

// -- small validation helpers -------------------------------------------------------

const problems = (): string[] => [];

function asObject(raw: unknown, what: string, out: string[]): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    out.push(`${what} must be an object`);
    return null;
  }
  return raw as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string, out: string[], pattern?: RegExp): string | null {
  const v = o[key];
  if (typeof v !== 'string' || !v.trim()) {out.push(`${key} is required (string)`); return null;}
  const s = v.trim();
  if (pattern && !pattern.test(s)) {out.push(`${key} '${s}' does not match ${pattern}`); return null;}
  return s;
}

function optNumber(o: Record<string, unknown>, key: string, out: string[], bounds?: {min?: number; max?: number}):
  number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {out.push(`${key} must be a number`); return undefined;}
  if (bounds?.min !== undefined && v < bounds.min) {out.push(`${key} must be >= ${bounds.min}`); return undefined;}
  if (bounds?.max !== undefined && v > bounds.max) {out.push(`${key} must be <= ${bounds.max}`); return undefined;}
  return v;
}

function reqNumber(o: Record<string, unknown>, key: string, out: string[], bounds?: {min?: number; max?: number}): number | null {
  const v = optNumber(o, key, out, bounds);
  return v === undefined ? null : v;
}

const WELL_ID = /^[A-Za-z][0-9]{1,2}$/;
const RESOURCE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Complete row wells of a plate as the device sees it (authoritative layout). */
export function completeRowWells(state: StateSnapshot, plateId: string, rowId: string): string[] | null {
  const plate = state.plates.find(p => p.plate_id === plateId);
  if (!plate || !plate.rows.includes(rowId)) return null;
  return Array.from({length: plate.columns}, (_, i) => `${rowId}${i + 1}`);
}

/** Goal target for a row: first medium/level metric with op >= matching the row. */
export function goalTargetFor(spec: GoalSpec, rowId?: string): {metric: string; value: number} | null {
  const metric = spec.metrics.find(m => (m.metric === 'medium_volume_ul' || m.metric === 'liquid_level_ul')
    && m.op === '>=' && (m.row_id == null || m.row_id === rowId));
  return metric ? {metric: metric.metric, value: metric.value} : null;
}

/** Default verify tolerance for a volume target (>= estimate noise ~2%). */
export function defaultTolerance(target: number): number {
  return Math.max(10, Math.ceil(target * 0.03));
}

function scopeProblems(spec: GoalSpec, plateId: string, rowId: string | null, reservoirId: string | null): string[] {
  const out: string[] = [];
  if (spec.scope.plates.length && !spec.scope.plates.includes(plateId)) {
    out.push(`plate '${plateId}' is outside the goal scope ${spec.scope.plates.join(', ')}`);
  }
  if (rowId && spec.scope.rows?.length && !spec.scope.rows.includes(rowId)) {
    out.push(`row '${rowId}' is outside the goal scope rows ${spec.scope.rows.join(', ')}`);
  }
  if (reservoirId && spec.scope.reservoirs?.length && !spec.scope.reservoirs.includes(reservoirId)) {
    out.push(`reservoir '${reservoirId}' is outside the goal scope ${spec.scope.reservoirs.join(', ')}`);
  }
  return out;
}

// -- shared evidence gathering -------------------------------------------------------

interface BoundAction {action: Action}

/**
 * Every CITED action id must be a REAL Runtime action that belongs to THIS
 * task at the CURRENT goal revision (session intent ledger) and reached
 * terminal status `succeeded`. failed/cancelled/partial actions, actions of
 * another task or an older goal revision, and unknown ids all refuse.
 */
async function gatherCitedActions(ctx: SkillVerifyContext):
  Promise<{ok: true; bound: BoundAction[]} | {ok: false; outcome: VerifyOutcome}> {
  if (ctx.action_ids.length === 0) {
    return {ok: false, outcome: refused(ctx, 'no_action_evidence',
      ['done requires the action ids this step produced'], 'request_input')};
  }
  const bound: BoundAction[] = [];
  for (const id of ctx.action_ids) {
    const owner = ctx.ownsAction(id);
    if (!owner) {
      return {ok: false, outcome: refused(ctx, 'action_not_owned',
        [`action ${id} is not in this session's intent ledger`], 'request_input')};
    }
    if (owner.task_id !== ctx.task_id) {
      return {ok: false, outcome: refused(ctx, 'action_not_owned',
        [`action ${id} belongs to task ${owner.task_id}, not ${ctx.task_id}`], 'request_input')};
    }
    if (owner.goal_revision !== ctx.goal_revision) {
      return {ok: false, outcome: refused(ctx, 'action_not_owned',
        [`action ${id} was submitted under goal revision ${owner.goal_revision}; the task is at revision ${ctx.goal_revision}`],
        'request_input')};
    }
    const action = await ctx.readAction(id);
    if (!action) {
      return {ok: false, outcome: refused(ctx, 'unknown_action',
        [`action ${id} does not exist on the Runtime`], 'request_input')};
    }
    if (action.status === 'failed') {
      return {ok: false, outcome: failed(ctx, 'action_failed',
        [`action ${id} (${action.capability}) ended failed${action.error ? `: ${action.error.message}` : ''}`],
        nextForCapability(action.capability))};
    }
    if (action.status === 'cancelled') {
      return {ok: false, outcome: failed(ctx, 'action_cancelled',
        [`action ${id} (${action.capability}) was cancelled`], nextForCapability(action.capability))};
    }
    if (action.partial) {
      return {ok: false, outcome: failed(ctx, 'action_partial',
        [`action ${id} (${action.capability}) ended partial; committed effects are kept but incomplete`],
        nextForCapability(action.capability))};
    }
    if (action.status !== 'succeeded') {
      return {ok: false, outcome: refused(ctx, 'action_not_terminal',
        [`action ${id} (${action.capability}) is '${action.status}'; wait for its terminal state`],
        nextForCapability(action.capability))};
    }
    bound.push({action});
  }
  return {ok: true, bound};
}

function nextForCapability(capability: string): string {
  switch (capability) {
    case 'imaging.scan': return 'scan_and_assess';
    case 'media.add':
    case 'media.exchange': return 'exchange_row_and_verify';
    case 'plate.shake': return 'mix_and_rescan';
    default: return 'request_input';
  }
}

/** What a step requires of a cited action's REAL arguments (N03). Row identity
 * is only required for row-scoped capabilities (maintenance / scans); a
 * plate-scoped shake only binds to the plate. `wells` additionally requires
 * scan arguments to COVER the step's wells. */
interface ActionTarget {plateId: string; rowId?: string | null; reservoirId?: string | null; wells?: string[]}

/**
 * N03: an action only counts as evidence for a step when its REAL Runtime
 * arguments match the step's inputs — same plate, same row (or wells entirely
 * in that row), same reservoir where the skill has one, and (for scans)
 * coverage of the step's wells. Missing or divergent arguments refuse with
 * `action_target_mismatch`: a fresh observation of row A does not prove a
 * maintenance of row A, and a plate-02 scan never verifies a plate-01 step.
 */
function actionTargetProblems(action: Action, target: ActionTarget): string[] {
  const args = action.arguments ?? {};
  const out: string[] = [];
  const what = `action ${action.action_id} (${action.capability})`;
  const argPlate = typeof args.plate_id === 'string' ? args.plate_id : null;
  if (!argPlate) out.push(`${what} carries no plate_id argument; cannot confirm it targeted '${target.plateId}'`);
  else if (argPlate !== target.plateId) {
    out.push(`${what} targeted plate '${argPlate}', not '${target.plateId}'`);
  }
  if (target.rowId != null) {
    const argRow = typeof args.row_id === 'string' ? args.row_id : null;
    const argWells = Array.isArray(args.wells)
      ? args.wells.filter((w): w is string => typeof w === 'string') : [];
    if (argRow != null && argRow !== target.rowId) {
      out.push(`${what} targeted row '${argRow}', not '${target.rowId}'`);
    } else if (argRow == null && argWells.length) {
      const outside = argWells.filter(w => !w.startsWith(target.rowId!));
      if (outside.length) out.push(`${what} targeted wells outside row '${target.rowId}': ${outside.join(',')}`);
    } else if (argRow == null && !argWells.length) {
      out.push(`${what} carries neither row_id nor wells; cannot confirm it targeted row '${target.rowId}'`);
    }
  }
  if (target.reservoirId != null) {
    const argReservoir = typeof args.reservoir_id === 'string' ? args.reservoir_id : null;
    if (argReservoir == null) out.push(`${what} carries no reservoir_id argument; cannot confirm it used '${target.reservoirId}'`);
    else if (argReservoir !== target.reservoirId) {
      out.push(`${what} used reservoir '${argReservoir}', not '${target.reservoirId}'`);
    }
  }
  if (target.wells && Array.isArray(args.wells)) {
    const argWells = args.wells.filter((w): w is string => typeof w === 'string');
    const missing = target.wells.filter(w => !argWells.includes(w));
    if (missing.length) out.push(`${what} did not cover the step's wells (${missing.join(',')})`);
  }
  return out;
}

interface ObservationCheck {
  observation: Observation;
  levels: Record<string, number>;
  minLevel: number;
}

/**
 * Finds, among the cited evidence refs, an observation that is USABLE as this
 * step's verification evidence: produced by an action of THIS task at the
 * CURRENT goal revision, matching plate_id, covering the step's wells,
 * sampled after `afterSimS` (the end of any EARLIER action this step must
 * postdate — e.g. the maintenance write), at the CURRENT plate revision, with
 * quality ok and non-null estimates for every well.
 *
 * `producingActions` (when given) binds the observation to specific cited
 * actions: it must have been PRODUCED by one of them (obs.action_id). A scan
 * captures its observation during the scanning stage, slightly BEFORE its own
 * terminal state — so for scan-produced evidence the binding is the producing
 * action itself, not a sim-time race against its end.
 */
async function findFreshObservation(ctx: SkillVerifyContext, opts: {plateId: string; wells: string[];
  afterSimS: number; nextSkill: string; producingActions?: string[]}):
  Promise<{ok: true; hit: ObservationCheck} | {ok: false; outcome: VerifyOutcome}> {
  if (ctx.evidence_refs.length === 0) {
    return {ok: false, outcome: refused(ctx, 'observation_missing',
      ['done requires the observation id(s) this step produced'], opts.nextSkill)};
  }
  // live plate revision: the freshest revision the Runtime knows
  const state = await ctx.readState();
  const livePlate = state.plates.find(p => p.plate_id === opts.plateId);
  let staleFound = false;
  let wrongPlateFound = false;
  let notOwnedFound = false;
  let wrongProducerFound = false;
  for (const ref of ctx.evidence_refs) {
    const obs = await ctx.readObservation(ref);
    if (!obs) continue;
    if (obs.plate_id !== opts.plateId) {wrongPlateFound = true; continue;}
    const owner = ctx.ownsAction(obs.action_id);
    if (!owner || owner.task_id !== ctx.task_id || owner.goal_revision !== ctx.goal_revision) {
      notOwnedFound = true;
      continue;
    }
    if (opts.producingActions && !opts.producingActions.includes(obs.action_id)) {
      wrongProducerFound = true;
      continue;
    }
    if (obs.sampled_at_sim_s + 1e-6 < opts.afterSimS
      || (livePlate && obs.plate_revision !== livePlate.revision)) {staleFound = true; continue;}
    const missing = opts.wells.filter(w => !obs.wells.includes(w));
    if (missing.length) continue;
    if (obs.quality !== 'ok') continue;
    const levels: Record<string, number> = {};
    let usable = true;
    for (const well of opts.wells) {
      const est = obs.estimates.find(e => e.well_id === well);
      if (!est || est.liquid_level_ul == null) {usable = false; break;}
      levels[well] = est.liquid_level_ul;
    }
    if (!usable) continue;
    const values = Object.values(levels);
    return {ok: true, hit: {observation: obs, levels, minLevel: Math.min(...values)}};
  }
  if (wrongPlateFound) {
    return {ok: false, outcome: refused(ctx, 'observation_wrong_plate',
      [`cited observation covers another plate than ${opts.plateId}`], opts.nextSkill)};
  }
  if (notOwnedFound) {
    return {ok: false, outcome: refused(ctx, 'observation_not_owned',
      ['cited observation was produced by an action outside this task/goal revision'], opts.nextSkill)};
  }
  if (wrongProducerFound) {
    return {ok: false, outcome: refused(ctx, 'observation_not_from_step_action',
      ['cited observation was not produced by this step\'s cited scan action'], opts.nextSkill)};
  }
  if (staleFound) {
    return {ok: false, outcome: refused(ctx, 'observation_stale',
      ['cited observation predates the required action end or does not match the current plate revision; rescan and re-verify'],
      opts.nextSkill)};
  }
  return {ok: false, outcome: refused(ctx, 'observation_unusable',
    ['no cited observation covers all step wells with usable (ok, non-null) estimates'], opts.nextSkill)};
}

function refused(ctx: SkillVerifyContext, code: string, reasons: string[], nextSkill: string): VerifyOutcome {
  return {ok: false, disposition: 'refuse', code, reasons, next_skill: nextSkill,
    verification: verificationOf(ctx, false, code, reasons, nextSkill, {})};
}

function failed(ctx: SkillVerifyContext, code: string, reasons: string[], nextSkill: string): VerifyOutcome {
  return {ok: false, disposition: 'fail', code, reasons, next_skill: nextSkill,
    verification: verificationOf(ctx, false, code, reasons, nextSkill, {})};
}

function passed(ctx: SkillVerifyContext, evidence: Record<string, unknown>): VerifyOutcome {
  return {ok: true, verification: verificationOf(ctx, true, null, [], null, evidence)};
}

function verificationOf(ctx: SkillVerifyContext, pass: boolean, code: string | null, reasons: string[],
  nextSkill: string | null, evidence: Record<string, unknown>): StepVerification {
  return {pass, code, reasons, next_skill: nextSkill, evidence,
    checked_at_wall: new Date().toISOString()};
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

// -- skill 1: scan_and_assess ---------------------------------------------------------

const scanAndAssess: SkillDefinition = {
  skill: 'scan_and_assess',
  version: '1',
  description: 'Scan the goal row and assess it against the goal metric. Produces the fresh observation evidence every later step needs.',
  capabilities: ['imaging.scan'],
  postconditions: {
    requires: [{capability: 'imaging.scan', status: 'succeeded', owned_by: 'this task @ current goal revision'}],
    observation: {must_cover: 'all wells of the row', sampled_after: 'the scan action ended',
      plate_revision: 'current', quality: 'ok', estimates: 'non-null for every well'},
  },
  inputSchema: {type: 'object', required: ['plate_id', 'row_id'],
    properties: {plate_id: {type: 'string'}, row_id: {type: 'string'},
      wells: {type: 'array', items: {type: 'string'}, description: 'optional; must be exactly the complete row'},
      mode: {enum: ['mono', 'stereo']}}},
  validateInputs(raw) {
    const out = problems();
    const o = asObject(raw, 'inputs', out);
    if (!o) return {ok: false, problems: out};
    const plateId = reqString(o, 'plate_id', out, RESOURCE_ID);
    const rowId = reqString(o, 'row_id', out, /^[A-Za-z]$/);
    const mode = o.mode === 'stereo' ? 'stereo' : 'mono';
    if (o.mode !== undefined && o.mode !== 'mono' && o.mode !== 'stereo') out.push('mode must be mono|stereo');
    let wells: string[] | undefined;
    if (o.wells !== undefined) {
      if (!Array.isArray(o.wells) || !o.wells.every(w => typeof w === 'string' && WELL_ID.test(w))) {
        out.push('wells must be an array of well ids like A1');
      } else wells = (o.wells as string[]).map(String);
    }
    if (out.length || !plateId || !rowId) return {ok: false, problems: out};
    return {ok: true, inputs: {plate_id: plateId, row_id: rowId, ...(wells ? {wells} : {}), mode}};
  },
  checkPreconditions({inputs, spec, state}) {
    const plateId = str(inputs.plate_id);
    const rowId = str(inputs.row_id);
    const out: string[] = [];
    out.push(...scopeProblems(spec, plateId, rowId, null));
    if (!spec.allowed_operations.includes('imaging.scan')) {
      out.push("capability 'imaging.scan' is outside the goal's allowed_operations");
    }
    const rowWells = completeRowWells(state, plateId, rowId);
    if (!rowWells) {out.push(`plate '${plateId}' has no row '${rowId}' in the device state`);}
    else if (inputs.wells) {
      const given = (inputs.wells as string[]).slice().sort();
      const expected = rowWells.slice().sort();
      if (given.join(',') !== expected.join(',')) {
        out.push(`wells must list exactly the complete row ${rowId}: ${expected.join(',')}`);
      }
    }
    const plate = state.plates.find(p => p.plate_id === plateId);
    if (plate?.shake.active) out.push(`plate '${plateId}' is shaking; wait for it to settle`);
    if (out.length) return {ok: false, problems: out};
    return {ok: true, notes: [`wells resolved to the complete row: ${rowWells!.join(',')}`]};
  },
  async verify(ctx) {
    const gathered = await gatherCitedActions(ctx);
    if (!gathered.ok) return gathered.outcome;
    const scans = gathered.bound.map(b => b.action).filter(a => a.capability === 'imaging.scan');
    if (scans.length === 0) {
      return refused(ctx, 'no_scan_action',
        ['scan_and_assess requires at least one imaging.scan action of this step'], 'scan_and_assess');
    }
    const wells = (ctx.step.inputs?.wells && Array.isArray(ctx.step.inputs.wells)
      ? ctx.step.inputs.wells as string[]
      : completeRowWells(await ctx.readState(), str(ctx.step.inputs?.plate_id), str(ctx.step.inputs?.row_id)) ?? []);
    // N03: the scan's REAL arguments must target the step's plate/row and
    // cover the step's wells — a scan of another row or plate is not evidence.
    for (const scan of scans) {
      const problems = actionTargetProblems(scan, {plateId: str(ctx.step.inputs?.plate_id),
        rowId: ctx.step.inputs?.row_id != null ? str(ctx.step.inputs.row_id) : null, wells});
      if (problems.length) {
        return refused(ctx, 'action_target_mismatch',
          problems, 'scan_and_assess');
      }
    }
    // the observation must have been PRODUCED by one of this step's cited
    // scans (a scan captures its observation during the scanning stage) and
    // reflect the CURRENT plate revision
    const obs = await findFreshObservation(ctx, {plateId: str(ctx.step.inputs?.plate_id), wells,
      afterSimS: 0, nextSkill: 'scan_and_assess', producingActions: scans.map(a => a.action_id)});
    if (!obs.ok) return obs.outcome;
    return passed(ctx, {scan_action_ids: scans.map(a => a.action_id), observation_id: obs.hit.observation.observation_id,
      sampled_at_sim_s: obs.hit.observation.sampled_at_sim_s, plate_revision: obs.hit.observation.plate_revision,
      levels_ul: obs.hit.levels, min_level_ul: obs.hit.minLevel});
  },
};

// -- skill 2: exchange_row_and_verify --------------------------------------------------

const MAINTENANCE_CAPABILITIES = ['media.add', 'media.exchange'];

const exchangeRowAndVerify: SkillDefinition = {
  skill: 'exchange_row_and_verify',
  version: '1',
  description: 'Maintain one complete row with fresh medium (media.add top-up or media.exchange fraction exchange, whichever the goal allows), then verify with a fresh scan that every well of the row is within tolerance of the goal target volume.',
  capabilities: ['imaging.scan', 'media.add', 'media.exchange'],
  postconditions: {
    requires: [{capability: 'media.add|media.exchange', status: 'succeeded', owned_by: 'this task @ current goal revision'},
      {observation: 'post-maintenance scan'}],
    observation: {must_cover: 'all wells of the row', sampled_after: 'the maintenance action ended',
      plate_revision: 'current', quality: 'ok', estimates: 'non-null for every well'},
    target: 'every well of the row at/above (target_volume_ul − tolerance_ul); the goal metric target is the default',
  },
  inputSchema: {type: 'object', required: ['plate_id', 'row_id', 'reservoir_id'],
    properties: {plate_id: {type: 'string'}, row_id: {type: 'string'}, reservoir_id: {type: 'string'},
      wells: {type: 'array', items: {type: 'string'}, description: 'optional; must be exactly the complete row'},
      target_volume_ul: {type: 'number', description: 'defaults to the goal metric target'},
      tolerance_ul: {type: 'number', minimum: 1, description: `default ${defaultTolerance(330)} (3% of target, min 10)`}}},
  validateInputs(raw) {
    const out = problems();
    const o = asObject(raw, 'inputs', out);
    if (!o) return {ok: false, problems: out};
    const plateId = reqString(o, 'plate_id', out, RESOURCE_ID);
    const rowId = reqString(o, 'row_id', out, /^[A-Za-z]$/);
    const reservoirId = reqString(o, 'reservoir_id', out, RESOURCE_ID);
    const target = optNumber(o, 'target_volume_ul', out, {min: 0, max: 100_000});
    const tolerance = optNumber(o, 'tolerance_ul', out, {min: 1, max: 10_000});
    let wells: string[] | undefined;
    if (o.wells !== undefined) {
      if (!Array.isArray(o.wells) || !o.wells.every(w => typeof w === 'string' && WELL_ID.test(w))) {
        out.push('wells must be an array of well ids like A1');
      } else wells = (o.wells as string[]).map(String);
    }
    if (out.length || !plateId || !rowId || !reservoirId) return {ok: false, problems: out};
    return {ok: true, inputs: {plate_id: plateId, row_id: rowId, reservoir_id: reservoirId,
      ...(wells ? {wells} : {}), ...(target !== undefined ? {target_volume_ul: target} : {}),
      ...(tolerance !== undefined ? {tolerance_ul: tolerance} : {})}};
  },
  checkPreconditions({inputs, spec, state}) {
    const plateId = str(inputs.plate_id);
    const rowId = str(inputs.row_id);
    const reservoirId = str(inputs.reservoir_id);
    const out: string[] = [];
    out.push(...scopeProblems(spec, plateId, rowId, reservoirId));
    const maintenance = MAINTENANCE_CAPABILITIES.filter(c => spec.allowed_operations.includes(c));
    if (maintenance.length === 0) {
      out.push(`none of ${MAINTENANCE_CAPABILITIES.join(', ')} is in the goal's allowed_operations`);
    }
    if (!spec.allowed_operations.includes('imaging.scan')) {
      out.push("capability 'imaging.scan' is outside the goal's allowed_operations (the recheck scan)");
    }
    const rowWells = completeRowWells(state, plateId, rowId);
    if (!rowWells) {out.push(`plate '${plateId}' has no row '${rowId}' in the device state`);}
    else if (inputs.wells) {
      const given = (inputs.wells as string[]).slice().sort().join(',');
      if (given !== rowWells.slice().sort().join(',')) {
        out.push(`wells must list exactly the complete row ${rowId}: ${rowWells.join(',')}`);
      }
    }
    const plate = state.plates.find(p => p.plate_id === plateId);
    if (plate?.shake.active) out.push(`plate '${plateId}' is shaking; wait for it to settle`);
    const reservoir = state.reservoirs.find(r => r.id === reservoirId);
    if (!reservoir) {out.push(`reservoir '${reservoirId}' does not exist in the device state`);}
    else {
      // estimated need from the goal target vs the CURRENT row levels
      const target = typeof inputs.target_volume_ul === 'number' ? inputs.target_volume_ul
        : goalTargetFor(spec, rowId)?.value;
      if (target != null && rowWells) {
        const current = rowWells.map(w => plate?.wells.find(x => x.well_id === w)?.volume_ul ?? 0);
        const deficitPerWell = Math.max(0, target - Math.min(...current));
        const need = deficitPerWell * rowWells.length;
        if (need > reservoir.remaining_ul) {
          out.push(`reservoir '${reservoirId}' holds ${reservoir.remaining_ul} µL but ~${need} µL is needed to reach the target`);
        }
      }
    }
    if (out.length) return {ok: false, problems: out};
    return {ok: true, notes: [`maintenance capabilities allowed here: ${maintenance.join(', ')}`]};
  },
  async verify(ctx) {
    const gathered = await gatherCitedActions(ctx);
    if (!gathered.ok) return gathered.outcome;
    const maintenance = gathered.bound.map(b => b.action).filter(a => MAINTENANCE_CAPABILITIES.includes(a.capability));
    const scans = gathered.bound.map(b => b.action).filter(a => a.capability === 'imaging.scan');
    if (maintenance.length === 0) {
      return refused(ctx, 'no_maintenance_action',
        ['exchange_row_and_verify requires at least one media.add/media.exchange action of this step'],
        'exchange_row_and_verify');
    }
    const wells = (ctx.step.inputs?.wells && Array.isArray(ctx.step.inputs.wells)
      ? ctx.step.inputs.wells as string[]
      : completeRowWells(await ctx.readState(), str(ctx.step.inputs?.plate_id), str(ctx.step.inputs?.row_id)) ?? []);
    // N03: the maintenance's REAL arguments must match the step's
    // plate/row/reservoir — maintaining row B is not evidence for row A even
    // when a fresh row-A observation already meets the target.
    for (const action of maintenance) {
      const problems = actionTargetProblems(action, {plateId: str(ctx.step.inputs?.plate_id),
        rowId: ctx.step.inputs?.row_id != null ? str(ctx.step.inputs.row_id) : null,
        reservoirId: ctx.step.inputs?.reservoir_id != null ? str(ctx.step.inputs.reservoir_id) : null});
      if (problems.length) {
        return refused(ctx, 'action_target_mismatch', problems, 'exchange_row_and_verify');
      }
    }
    for (const scan of scans) {
      const problems = actionTargetProblems(scan, {plateId: str(ctx.step.inputs?.plate_id),
        rowId: ctx.step.inputs?.row_id != null ? str(ctx.step.inputs.row_id) : null, wells});
      if (problems.length) {
        return refused(ctx, 'action_target_mismatch', problems, 'scan_and_assess');
      }
    }
    // the verify observation must be sampled AFTER the maintenance action
    // ENDED (it is a separate, later scan), match the current plate revision,
    // and — N03 — be PRODUCED by a scan action THIS step cited
    const afterSim = Math.max(...maintenance.map(a => a.ended_at_sim_s ?? 0));
    const obs = await findFreshObservation(ctx, {plateId: str(ctx.step.inputs?.plate_id), wells,
      afterSimS: afterSim, nextSkill: 'scan_and_assess', producingActions: scans.map(a => a.action_id)});
    if (!obs.ok) return obs.outcome;
    // target check: every well of the row within tolerance of the target volume
    const target = typeof ctx.step.inputs?.target_volume_ul === 'number'
      ? ctx.step.inputs.target_volume_ul
      : goalTargetFor(ctx.spec, str(ctx.step.inputs?.row_id))?.value;
    if (target == null) {
      return refused(ctx, 'no_target_metric',
        ['no target_volume_ul input and no medium_volume_ul/liquid_level_ul >= metric in the goal for this row'],
        'request_input');
    }
    const tolerance = typeof ctx.step.inputs?.tolerance_ul === 'number'
      ? ctx.step.inputs.tolerance_ul : defaultTolerance(target);
    const below = wells.filter(w => obs.hit.levels[w] < target - tolerance);
    if (below.length > 0) {
      return failed(ctx, 'verify_below_target',
        [`post-maintenance scan shows ${below.join(', ')} below the target: ${below.map(w => `${obs.hit.levels[w].toFixed(1)} < ${target} (tolerance ${tolerance})`).join('; ')}`],
        'exchange_row_and_verify');
    }
    return passed(ctx, {maintenance_action_ids: maintenance.map(a => a.action_id),
      observation_id: obs.hit.observation.observation_id, sampled_at_sim_s: obs.hit.observation.sampled_at_sim_s,
      plate_revision: obs.hit.observation.plate_revision, target_volume_ul: target, tolerance_ul: tolerance,
      levels_ul: obs.hit.levels, min_level_ul: obs.hit.minLevel});
  },
};

// -- skill 3: mix_and_rescan -----------------------------------------------------------

const mixAndRescan: SkillDefinition = {
  skill: 'mix_and_rescan',
  version: '1',
  description: 'Shake the plate to mix, wait out the blur settle window, then rescan the row. Done only when the shake succeeded AND a usable post-settle observation of the wells exists.',
  capabilities: ['plate.shake', 'imaging.scan'],
  postconditions: {
    requires: [{capability: 'plate.shake', status: 'succeeded', owned_by: 'this task @ current goal revision'},
      {capability: 'imaging.scan', status: 'succeeded'}],
    observation: {must_cover: 'all wells of the row', sampled_after: 'the shake ended (settled, quality ok)',
      plate_revision: 'current', estimates: 'non-null for every well'},
  },
  inputSchema: {type: 'object', required: ['plate_id', 'speed_rpm', 'duration_sim_s'],
    properties: {plate_id: {type: 'string'}, row_id: {type: 'string'},
      wells: {type: 'array', items: {type: 'string'}, description: 'optional; must be a complete row'},
      speed_rpm: {type: 'number', minimum: DEMO_PROFILE.shake.speed_rpm.min, maximum: DEMO_PROFILE.shake.speed_rpm.max},
      duration_sim_s: {type: 'number', minimum: DEMO_PROFILE.shake.duration_s.min, maximum: DEMO_PROFILE.shake.duration_s.max}}},
  validateInputs(raw) {
    const out = problems();
    const o = asObject(raw, 'inputs', out);
    if (!o) return {ok: false, problems: out};
    const plateId = reqString(o, 'plate_id', out, RESOURCE_ID);
    const rowId = o.row_id !== undefined ? reqString(o, 'row_id', out, /^[A-Za-z]$/) : null;
    const speed = reqNumber(o, 'speed_rpm', out, {min: DEMO_PROFILE.shake.speed_rpm.min, max: DEMO_PROFILE.shake.speed_rpm.max});
    const duration = reqNumber(o, 'duration_sim_s', out, {min: DEMO_PROFILE.shake.duration_s.min, max: DEMO_PROFILE.shake.duration_s.max});
    let wells: string[] | undefined;
    if (o.wells !== undefined) {
      if (!Array.isArray(o.wells) || !o.wells.every(w => typeof w === 'string' && WELL_ID.test(w))) {
        out.push('wells must be an array of well ids like A1');
      } else wells = (o.wells as string[]).map(String);
    }
    if (out.length || !plateId || speed == null || duration == null) return {ok: false, problems: out};
    return {ok: true, inputs: {plate_id: plateId, speed_rpm: speed, duration_sim_s: duration,
      ...(rowId ? {row_id: rowId} : {}), ...(wells ? {wells} : {})}};
  },
  checkPreconditions({inputs, spec, state}) {
    const plateId = str(inputs.plate_id);
    const rowId = inputs.row_id ? str(inputs.row_id) : null;
    const out: string[] = [];
    out.push(...scopeProblems(spec, plateId, rowId, null));
    for (const cap of ['plate.shake', 'imaging.scan']) {
      if (!spec.allowed_operations.includes(cap)) {
        out.push(`capability '${cap}' is outside the goal's allowed_operations`);
      }
    }
    const plate = state.plates.find(p => p.plate_id === plateId);
    if (!plate) {out.push(`plate '${plateId}' does not exist in the device state`);}
    else {
      if (plate.shake.active) out.push(`plate '${plateId}' is already shaking`);
      if (rowId && !plate.rows.includes(rowId)) out.push(`plate '${plateId}' has no row '${rowId}'`);
      const rowWells = rowId ? completeRowWells(state, plateId, rowId) : null;
      if (inputs.wells && rowWells) {
        const given = (inputs.wells as string[]).slice().sort().join(',');
        if (given !== rowWells.slice().sort().join(',')) {
          out.push(`wells must list exactly the complete row ${rowId}: ${rowWells.join(',')}`);
        }
      }
    }
    if (out.length) return {ok: false, problems: out};
    return {ok: true, notes: []};
  },
  async verify(ctx) {
    const gathered = await gatherCitedActions(ctx);
    if (!gathered.ok) return gathered.outcome;
    const shakes = gathered.bound.map(b => b.action).filter(a => a.capability === 'plate.shake');
    const scans = gathered.bound.map(b => b.action).filter(a => a.capability === 'imaging.scan');
    if (shakes.length === 0) {
      return refused(ctx, 'no_mix_action',
        ['mix_and_rescan requires at least one plate.shake action of this step'], 'mix_and_rescan');
    }
    if (scans.length === 0) {
      return refused(ctx, 'no_rescan_action',
        ['mix_and_rescan requires the post-mix imaging.scan action of this step'], 'scan_and_assess');
    }
    const plateId = str(ctx.step.inputs?.plate_id);
    const wells = (ctx.step.inputs?.wells && Array.isArray(ctx.step.inputs.wells)
      ? ctx.step.inputs.wells as string[]
      : completeRowWells(await ctx.readState(), plateId, str(ctx.step.inputs?.row_id)) ?? []);
    // N03: the shake's REAL arguments must target the step's plate (a shake is
    // plate-scoped); the rescan must target the plate/row and cover the wells
    for (const shake of shakes) {
      const problems = actionTargetProblems(shake, {plateId});
      if (problems.length) {
        return refused(ctx, 'action_target_mismatch', problems, 'mix_and_rescan');
      }
    }
    for (const scan of scans) {
      const problems = actionTargetProblems(scan, {plateId,
        rowId: ctx.step.inputs?.row_id != null ? str(ctx.step.inputs.row_id) : null, wells});
      if (problems.length) {
        return refused(ctx, 'action_target_mismatch', problems, 'scan_and_assess');
      }
    }
    // the rescan observation must be PRODUCED by the cited rescan action and
    // sampled AFTER the shake ended (the settle window shows up as quality)
    const afterSim = Math.max(...shakes.map(a => a.ended_at_sim_s ?? 0));
    const obs = await findFreshObservation(ctx, {plateId, wells, afterSimS: afterSim,
      nextSkill: 'scan_and_assess', producingActions: scans.map(a => a.action_id)});
    if (!obs.ok) return obs.outcome;
    return passed(ctx, {shake_action_ids: shakes.map(a => a.action_id), scan_action_ids: scans.map(a => a.action_id),
      observation_id: obs.hit.observation.observation_id, sampled_at_sim_s: obs.hit.observation.sampled_at_sim_s,
      levels_ul: obs.hit.levels, min_level_ul: obs.hit.minLevel});
  },
};

// -- skill 4: monitor_until -------------------------------------------------------------

const CHAMBER_METRICS = new Set(['temperature_c', 'co2_pct', 'humidity_pct']);

/** N03: a fired condition wake verifies the step only when its predicate is
 * EXACTLY the step's condition — same metric, same op, same value. */
function conditionMatches(predicate: Record<string, unknown> | null,
  condition: {metric?: string; op?: string; value?: number}): boolean {
  if (!predicate) return false;
  const metric = str(predicate.metric);
  const op = str(predicate.op);
  const value = predicate.value;
  return metric === condition.metric && op === condition.op
    && typeof value === 'number' && typeof condition.value === 'number'
    && Math.abs(value - condition.value) <= 1e-9;
}

/** How long a fired condition wake actually required the reading to hold.
 * A missing field is the scheduler's own default (`debounce_sim_s ?? 60`);
 * an explicit 0 stays 0 — that is the weakened wake, not "unspecified". */
function effectiveDebounce(predicate: Record<string, unknown> | null): number {
  const d = predicate?.debounce_sim_s;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : 60;
}

/** The goal's monitoring condition behind a step condition, when one exists. */
function goalMonitorCondition(spec: GoalSpec, condition: {metric?: string; op?: string; value?: number}):
  {metric: string; op: string; value: number; debounce_sim_s: number} | undefined {
  const metric = condition.metric;
  const op = condition.op;
  const value = condition.value;
  if (typeof metric !== 'string' || typeof op !== 'string' || typeof value !== 'number') return undefined;
  return (spec.monitoring?.conditions ?? []).find(c => c.metric === metric
    && c.op === op && Math.abs(c.value - value) <= 1e-9);
}

const monitorUntil: SkillDefinition = {
  skill: 'monitor_until',
  version: '1',
  description: 'Watch without acting: persist a wake (deadline sim time and/or chamber condition) and end the turn. Done only when the wake actually fired and the sim clock reached the target (or the condition crossed with debounce).',
  capabilities: [],
  postconditions: {
    requires: [],
    evidence: 'a fired wake of this task (sim_time target reached, or condition fired) read back from the persisted wake ledger',
  },
  inputSchema: {type: 'object', properties: {
    until_sim_s: {type: 'number', minimum: 0, description: 'absolute simulated deadline'},
    interval_sim_s: {type: 'number', minimum: 0},
    condition: {type: 'object', required: ['metric', 'op', 'value'],
      properties: {metric: {enum: ['temperature_c', 'co2_pct', 'humidity_pct']}, op: {enum: ['below', 'above']},
        value: {type: 'number'}}}}},
  validateInputs(raw) {
    const out = problems();
    const o = asObject(raw, 'inputs', out);
    if (!o) return {ok: false, problems: out};
    const until = optNumber(o, 'until_sim_s', out, {min: 0, max: 10_000_000});
    const interval = optNumber(o, 'interval_sim_s', out, {min: 0, max: 1_000_000});
    let condition: Record<string, unknown> | undefined;
    if (o.condition !== undefined) {
      const c = asObject(o.condition, 'condition', out);
      if (c) {
        const metric = str(c.metric);
        if (!CHAMBER_METRICS.has(metric)) out.push(`condition.metric must be one of ${[...CHAMBER_METRICS].join(', ')}`);
        const op = c.op === 'above' ? 'above' : c.op === 'below' ? 'below' : null;
        if (!op) out.push('condition.op must be below|above');
        const value = reqNumber(c, 'value', out);
        if (metric && op && value != null) condition = {metric, op, value};
      }
    }
    if (until === undefined && !condition) out.push('until_sim_s or condition is required');
    if (out.length) return {ok: false, problems: out};
    return {ok: true, inputs: {...(until !== undefined ? {until_sim_s: until} : {}),
      ...(interval !== undefined ? {interval_sim_s: interval} : {}), ...(condition ? {condition} : {})}};
  },
  checkPreconditions({inputs}) {
    // no device writes; a deadline already in the past is immediately checkable
    const notes: string[] = [];
    if (typeof inputs.until_sim_s === 'number') notes.push(`deadline at sim ${inputs.until_sim_s}s`);
    if (inputs.condition) notes.push(`condition ${JSON.stringify(inputs.condition)}`);
    return {ok: true, notes};
  },
  async verify(ctx) {
    // any cited actions (e.g. monitoring scans) must still be owned + succeeded
    if (ctx.action_ids.length > 0) {
      const gathered = await gatherCitedActions(ctx);
      if (!gathered.ok) return gathered.outcome;
    }
    const state = await ctx.readState();
    const until = ctx.step.inputs?.until_sim_s;
    const condition = ctx.step.inputs?.condition as {metric?: string; op?: string; value?: number} | undefined;
    // N03: only wakes of THIS task, armed under the CURRENT goal revision and
    // bound to THIS step (when either side carries an identity) may verify it.
    // A different threshold, an old-revision wake or another step's wake never
    // substitutes for the required wait condition.
    const usable = ctx.firedWakes.filter(w => w.task_id === ctx.task_id
      && w.goal_revision === ctx.goal_revision
      && (w.step_id ?? null) === (ctx.step.step_id ?? null));
    const predicateText = (p: Record<string, unknown> | null): string =>
      p ? `${str(p.metric)} ${str(p.op)} ${String(p.value)}` : '(none)';
    if (condition && typeof condition.metric === 'string') {
      const exact = usable.filter(w => w.kind === 'condition' && conditionMatches(w.predicate, condition));
      if (!exact.length) {
        const sameMetric = usable.filter(w => w.kind === 'condition'
          && str((w.predicate as {metric?: unknown} | null)?.metric) === condition.metric);
        return refused(ctx, sameMetric.length ? 'wake_predicate_mismatch' : 'condition_not_fired',
          sameMetric.length
            ? [`a ${condition.metric} wake fired, but for ${sameMetric.map(w => predicateText(w.predicate)).join(', ')} — not the required ${condition.metric} ${condition.op} ${condition.value}`]
            : [`no fired ${condition.metric} condition wake of this task, goal revision ${ctx.goal_revision} and this step; keep the wake armed`],
          'monitor_until');
      }
      // T01: a wake may use a SHORTER debounce than the goal and still wake the
      // model, but it is not success evidence for that goal. The hold the wake
      // actually required (its predicate, not the step's metric/op/value) must
      // be at least the goal condition's debounce_sim_s.
      const required = goalMonitorCondition(ctx.spec, condition);
      const strong = required
        ? exact.filter(w => effectiveDebounce(w.predicate) + 1e-9 >= required.debounce_sim_s)
        : exact;
      if (!strong.length && required) {
        const seen = [...new Set(exact.map(w => effectiveDebounce(w.predicate)))].join(', ');
        return refused(ctx, 'debounce_shortened',
          [`goal requires ${condition.metric} ${condition.op} ${condition.value} to hold for ${required.debounce_sim_s} simulated seconds; `
            + `the fired wake only required ${seen}s. A shorter debounce may still wake the model, but it is not success evidence — `
            + `re-arm the wake with debounce_sim_s >= ${required.debounce_sim_s}`],
          'monitor_until');
      }
      const hit = strong.at(-1)!;
      // S02: persist WHICH wake proved the step, the hold it required, and the
      // goal revision / step binding it was armed under — the completion gate
      // re-checks them, so a goal edit or a shortened debounce turns this proof
      // into history.
      return passed(ctx, {wake_id: hit.wake_id, kind: 'condition', condition,
        debounce_sim_s: effectiveDebounce(hit.predicate),
        required_debounce_sim_s: required?.debounce_sim_s ?? null,
        sim_time_s: state.experiment.sim_time_s,
        wake_goal_revision: hit.goal_revision, wake_step_id: hit.step_id});
    }
    if (typeof until !== 'number') {
      return refused(ctx, 'no_deadline',
        ['no until_sim_s on the step and no condition fired'], 'request_input');
    }
    if (state.experiment.sim_time_s + 1e-6 < until) {
      return refused(ctx, 'deadline_not_reached',
        [`sim clock is at ${state.experiment.sim_time_s}s, deadline is ${until}s`], 'monitor_until');
    }
    // N03: the deadline wake itself must have fired — an earlier interval wake
    // of the same step is not proof that the deadline was reached.
    const fired = usable.filter(w => w.kind === 'sim_time'
      && w.target_sim_s != null && w.target_sim_s + 1e-6 >= until);
    const wake = fired.at(-1);
    if (!wake) {
      const earlier = usable.filter(w => w.kind === 'sim_time' && w.target_sim_s != null);
      return refused(ctx, 'wake_not_fired',
        earlier.length
          ? [`deadline ${until}s reached, but every fired wake of this step targeted an earlier sim time (${earlier.map(w => `${w.target_sim_s}s`).join(', ')}); the deadline wake itself has not fired`]
          : [`deadline ${until}s reached but no fired wake bound to this task, goal revision ${ctx.goal_revision} and this step is on record`],
        'monitor_until');
    }
    return passed(ctx, {wake_id: wake.wake_id, kind: wake.kind, until_sim_s: until,
      sim_time_s: state.experiment.sim_time_s, fired_at_wall: wake.fired_at_wall,
      wake_goal_revision: wake.goal_revision, wake_step_id: wake.step_id});
  },
};

// -- registry --------------------------------------------------------------------------

export const SKILLS: SkillDefinition[] = [scanAndAssess, exchangeRowAndVerify, mixAndRescan, monitorUntil];

const byName = new Map(SKILLS.map(s => [s.skill, s]));

/** Current (default) version of a skill, or null when the skill is unknown. */
export function currentSkillVersion(skill: string): string | null {
  return byName.get(skill)?.version ?? null;
}

export function listSkillIds(): Array<{skill: string; version: string; capabilities: string[]}> {
  return SKILLS.map(s => ({skill: s.skill, version: s.version, capabilities: [...s.capabilities]}));
}

/**
 * Resolve one plan step input: the skill must be known, the version must be a
 * known version of that skill (omitted → the CURRENT version, explicitly
 * persisted), and the inputs must satisfy the skill's schema. Unknown
 * skill/version or invalid input refuses the whole plan (nothing persisted).
 */
export function resolveSkillStep(step: {skill: string; skill_version?: string | null; inputs?: unknown}):
  {ok: true; resolved: ResolvedSkill} | {ok: false; problems: string[]} {
  const out: string[] = [];
  const def = byName.get(step.skill);
  if (!def) {
    out.push(`unknown skill '${step.skill}'; known skills: ${SKILLS.map(s => `${s.skill}@${s.version}`).join(', ')}`);
    return {ok: false, problems: out};
  }
  let version = def.version;
  if (step.skill_version !== undefined && step.skill_version !== null && step.skill_version !== '') {
    if (step.skill_version !== def.version) {
      out.push(`skill '${step.skill}' has no version '${step.skill_version}' (known: ${def.version})`);
      return {ok: false, problems: out};
    }
  }
  const validated = def.validateInputs(step.inputs ?? {});
  if (!validated.ok) {
    out.push(...validated.problems.map(p => `${step.skill}@${version} ${p}`));
    return {ok: false, problems: out};
  }
  return {ok: true, resolved: {skill: def.skill, version, inputs: validated.inputs, def}};
}

/**
 * Plan-time validation of a whole step list: every step resolves (skill,
 * version, inputs) and its preconditions hold against the AUTHORITATIVE
 * device state + GoalSpec. `wells` inputs are normalized to the complete row
 * the device reports.
 */
export async function validatePlanSteps(steps: Array<{skill: string; skill_version?: string | null;
  inputs?: unknown}>, spec: GoalSpec, state: StateSnapshot):
  Promise<{ok: true; steps: ResolvedSkill[]} | {ok: false; problems: string[]; index: number}> {
  const resolvedSteps: ResolvedSkill[] = [];
  for (let i = 0; i < steps.length; i++) {
    const r = resolveSkillStep(steps[i]);
    if (!r.ok) return {ok: false, problems: r.problems, index: i};
    const pre = r.resolved.def.checkPreconditions({inputs: r.resolved.inputs, spec, state});
    if (!pre.ok) return {ok: false, problems: pre.problems.map(p => `step ${i} (${r.resolved.skill}@${r.resolved.version}): ${p}`), index: i};
    // normalize wells to the authoritative complete row
    const plateId = r.resolved.inputs.plate_id;
    const rowId = r.resolved.inputs.row_id;
    if (typeof plateId === 'string' && typeof rowId === 'string') {
      const rowWells = completeRowWells(state, plateId, rowId);
      if (rowWells) r.resolved.inputs.wells = rowWells;
    }
    resolvedSteps.push(r.resolved);
  }
  return {ok: true, steps: resolvedSteps};
}

/** A plan step as seen by the completion gate. */
export interface PlanGateStep {
  index_in_plan: number;
  /** Plan revision the step belongs to (steps of a newer revision supersede older ones). */
  plan_revision?: number;
  /** Persisted step identity (S02: monitor evidence binds to THIS step). */
  step_id?: string | null;
  skill: string;
  inputs?: Record<string, unknown> | null;
  status: string;
  verification: StepVerification | null;
}

export interface PlanGateBlocker {
  index: number;
  skill: string;
  status: string;
  problem: string;
  /** N02: soft blockers (a skipped step without success evidence) can still be
   * resolved by the independent goal-level verification; everything else is hard. */
  soft?: boolean;
}

/** Same-skill, same-target identity for supersession (plate/row[/reservoir]). */
function stepTargetKey(step: PlanGateStep): string {
  const inputs = step.inputs ?? {};
  return JSON.stringify([inputs.plate_id ?? null, inputs.row_id ?? null, inputs.reservoir_id ?? null]);
}

/**
 * N02: a failed/skipped step is superseded only by a LATER step (higher index
 * in the same plan revision, or any step of a strictly newer plan revision) of
 * the SAME skill and the SAME target that is done with a passing verification.
 * Skipped steps never supersede anything — only real verified success does.
 */
function supersededBy(step: PlanGateStep, steps: PlanGateStep[]): boolean {
  const key = stepTargetKey(step);
  const revision = step.plan_revision ?? 0;
  return steps.some(s2 => s2 !== step
    && s2.status === 'done' && s2.verification?.pass === true
    && s2.skill === step.skill
    && stepTargetKey(s2) === key
    && ((s2.plan_revision ?? 0) > revision
      || ((s2.plan_revision ?? 0) === revision && s2.index_in_plan > step.index_in_plan)));
}

/**
 * The complete-task plan gate (N02): refuse while any step is pending/running
 * or done without a passing verification, and refuse while any step failed or
 * was skipped without a LATER verified success of the same skill and target —
 * historical failure must not block forever once remediation succeeded, but a
 * terminal state alone is never success evidence. `soft` marks skipped-step
 * blockers: the caller may still complete when the independent goal-level
 * verification (verifyGoalSatisfied) confirms the current goal revision.
 */
export function planCompletionGate(steps: PlanGateStep[]):
  {ok: true} | {ok: false; code: string; message: string; blockers: PlanGateBlocker[]} {
  const blockers: PlanGateBlocker[] = [];
  for (const s of steps) {
    if (s.status === 'pending' || s.status === 'running') {
      blockers.push({index: s.index_in_plan, skill: s.skill, status: s.status, problem: 'step is not terminal'});
    } else if (s.status === 'done' && s.verification?.pass !== true) {
      blockers.push({index: s.index_in_plan, skill: s.skill, status: s.status,
        problem: s.verification ? `verification did not pass (${s.verification.code ?? 'no code'})`
          : 'done without any recorded verification'});
    } else if ((s.status === 'failed' || s.status === 'skipped') && !supersededBy(s, steps)) {
      blockers.push({index: s.index_in_plan, skill: s.skill, status: s.status,
        problem: s.status === 'failed'
          ? `step failed (${s.verification?.code ?? 'reported'}) and no later ${s.skill} step of the same target verified success`
          : `step was skipped and produced no success evidence; no later ${s.skill} step of the same target verified success`,
        soft: s.status === 'skipped'});
    }
  }
  if (blockers.length) {
    return {ok: false, code: 'plan_not_verifiable',
      message: `cannot complete the task: ${blockers.map(b => `step ${b.index} (${b.skill}) ${b.problem}`).join('; ')}`,
      blockers};
  }
  return {ok: true};
}

// -- goal-level success verification (N02) ---------------------------------------------

/** Everything the goal-level success check may read. Device reads go through
 * the Runtime (authoritative); ownership comes from the session intent ledger. */
export interface GoalVerifyContext {
  task_id: string;
  goal_revision: number;
  spec: GoalSpec;
  /** Candidate observation ids: plan-step evidence refs, cited completion refs
   * and observations the scheduler recorded for this session. */
  observationRefs: string[];
  /** Action ids of maintenance intents (media.add/media.exchange) of this task —
   * used to require the freshest observation to postdate the last maintenance. */
  maintenanceActionIds: string[];
  /** Plan steps of THIS task (Q03): a metric-less goal completes only on
   * verifiable success evidence, and a done+verified `monitor_until` step that
   * demonstrably matches the goal's deadline / monitoring conditions is that
   * evidence. Optional — callers without a plan pass nothing. */
  planSteps?: PlanGateStep[];
  /** S02: fired wakes of this task, for an optional ledger cross-check of the
   * wake that proved a monitor step. When provided, the proving wake row must
   * still exist and carry the CURRENT goal revision; when absent, the revision
   * recorded on the step's verification evidence (written by the monitor_until
   * evaluator from the wake row itself) decides. */
  firedWakes?: SkillFiredWake[];
  ownsAction(actionId: string): {task_id: string; goal_revision: number} | null;
  readAction(actionId: string): Promise<Action | null>;
  readObservation(observationId: string): Promise<Observation | null>;
  readState(): Promise<StateSnapshot>;
}

export type GoalVerifyOutcome =
  | {ok: true; evidence: {mode: 'metrics_verified' | 'plan_only'} & Record<string, unknown>}
  | {ok: false; code: 'goal_unverified' | 'goal_unmet'; reasons: string[]; evidence: Record<string, unknown>};

/**
 * S03: resolve a metric's required wells against the AUTHORITATIVE layout.
 * Unknown plates/rows/wells are REPORTED as problems instead of being filtered
 * away — a metric that resolves to no well at all is an invalid target, not a
 * vacuous "every well checked" pass. A row is valid when at least one in-scope
 * plate carries it (multi-plate scopes may split rows across plates); a plate
 * is valid when the device state knows it; a well is valid when some in-scope
 * plate has it.
 */
function metricWells(spec: GoalSpec, state: StateSnapshot, metric: {row_id?: string; well_id?: string}):
  {entries: Array<{plateId: string; wells: string[]}>; problems: string[]} {
  const problems: string[] = [];
  const scopePlateIds = spec.scope.plates.length
    ? spec.scope.plates : state.plates.map(p => p.plate_id);
  const known = `known plates: ${state.plates.map(p => p.plate_id).join(', ') || 'none'}`;
  const plates = scopePlateIds.flatMap(id => {
    const plate = state.plates.find(p => p.plate_id === id);
    if (!plate) {
      problems.push(`plate '${id}' does not exist in the device state (${known})`);
      return [];
    }
    return [plate];
  });
  if (metric.well_id) {
    const carriers = plates.filter(p => p.wells.some(w => w.well_id === metric.well_id));
    if (carriers.length === 0) {
      problems.push(`well '${metric.well_id}' does not exist on any in-scope plate (${scopePlateIds.join(', ')})`);
    }
    return {entries: carriers.map(p => ({plateId: p.plate_id, wells: [metric.well_id!]})), problems};
  }
  if (metric.row_id) {
    const rowId = metric.row_id;
    const carriers = plates.filter(p => p.rows.includes(rowId));
    if (carriers.length === 0) {
      problems.push(`row '${rowId}' does not exist on any in-scope plate `
        + `(${plates.map(p => `${p.plate_id}: ${p.rows.join('/')}`).join(', ') || 'no in-scope plate'})`);
    }
    return {entries: carriers.map(p => ({plateId: p.plate_id,
      wells: rowWellsOf(p, rowId)})), problems};
  }
  const scopeRows = spec.scope.rows?.length ? [...new Set(spec.scope.rows)] : null;
  if (scopeRows) {
    const valid: string[] = [];
    for (const row of scopeRows) {
      if (plates.some(p => p.rows.includes(row))) valid.push(row);
      else {
        problems.push(`row '${row}' does not exist on any in-scope plate `
          + `(${plates.map(p => `${p.plate_id}: ${p.rows.join('/')}`).join(', ') || 'no in-scope plate'})`);
      }
    }
    return {entries: plates.flatMap(p => {
      const own = valid.filter(r => p.rows.includes(r));
      return own.length ? [{plateId: p.plate_id, wells: own.flatMap(r => rowWellsOf(p, r))}] : [];
    }), problems};
  }
  // no named target: every well of every in-scope plate
  return {entries: plates.map(p => ({plateId: p.plate_id, wells: p.rows.flatMap(r => rowWellsOf(p, r))})),
    problems};
}

/** All wells of one row of a plate, from the authoritative columns count. */
function rowWellsOf(plate: StateSnapshot['plates'][number], rowId: string): string[] {
  return Array.from({length: plate.columns}, (_, i) => `${rowId}${i + 1}`);
}

/**
 * Q03: a done `monitor_until` step with a PASSING verification demonstrably
 * matches the goal's structured success conditions when its inputs are equal
 * or compatible with one of them:
 *   - `until_sim_s >= deadline_sim_s` — the step waited out (a wake fired
 *     and was verified for) at least the goal's deadline, or
 *   - `condition` is IDENTICAL to one of `monitoring.conditions` — same
 *     metric, same op, same value (within float tolerance).
 * Pure input/condition compatibility — no revision knowledge (S02 splits that
 * out so stale evidence can be named precisely in refusal reasons).
 */
function monitorInputsMatchSuccessCondition(spec: GoalSpec, step: PlanGateStep): boolean {
  const inputs = step.inputs ?? {};
  if (typeof spec.deadline_sim_s === 'number' && typeof inputs.until_sim_s === 'number'
    && inputs.until_sim_s + 1e-6 >= spec.deadline_sim_s) {
    return true;
  }
  const cond = inputs.condition as {metric?: unknown; op?: unknown; value?: unknown} | undefined;
  const condMetric = cond?.metric, condOp = cond?.op, condValue = cond?.value;
  if (typeof condMetric === 'string' && typeof condOp === 'string' && typeof condValue === 'number') {
    return (spec.monitoring?.conditions ?? []).some(c => c.metric === condMetric
      && c.op === condOp && Math.abs(c.value - condValue) <= 1e-9);
  }
  return false;
}

/** S02 version attribution inputs: the task/revision the completion gate is
 * deciding for, plus the optional fired-wake ledger of this task. */
interface MonitorRevisionCheck {
  task_id: string;
  goal_revision: number;
  firedWakes?: SkillFiredWake[];
}

/**
 * S02: monitor success evidence must belong to the CURRENT goal version.
 * A passing step verification only proved the bound wake fired for this task
 * at the revision CURRENT AT VERIFICATION TIME; after a goal edit the old
 * plan (and its verified waits) is history. The evidence counts only when
 *   - the step's `plan_revision` equals the CURRENT goal revision
 *     (`replacePlan` writes the task's goal revision as the plan revision), AND
 *   - the wake that proved the step — whose goal revision / step binding the
 *     monitor_until evaluator persisted ON the verification evidence from the
 *     fired wake row itself — was armed under the CURRENT goal revision and
 *     bound to THIS step, AND
 *   - when the caller provides the fired-wake ledger, the wake row still
 *     exists, belongs to this task, and carries the current revision/binding.
 * Anything else (missing recorded revision, an old-revision wake, a step of an
 * old plan revision) fails closed: it is not success evidence for this goal.
 */
function monitorStepEvidenceOfCurrentRevision(step: PlanGateStep, check: MonitorRevisionCheck): boolean {
  if ((step.plan_revision ?? null) !== check.goal_revision) return false;
  const evidence = step.verification?.evidence as
    {wake_id?: unknown; wake_goal_revision?: unknown; wake_step_id?: unknown} | undefined;
  if (evidence?.wake_goal_revision !== check.goal_revision) return false;
  const wakeStepId = evidence.wake_step_id ?? null;
  if (wakeStepId !== (step.step_id ?? null)) return false;
  if (check.firedWakes) {
    const row = check.firedWakes.find(w => w.wake_id === evidence.wake_id);
    if (!row || row.task_id !== check.task_id || row.goal_revision !== check.goal_revision
      || (row.step_id ?? null) !== wakeStepId) {
      return false;
    }
  }
  return true;
}

/**
 * T01: success evidence must not be a WEAKER hold than the goal asked for.
 * The debounce that actually fired (the wake predicate, else the debounce the
 * verifier recorded on the evidence) must be >= the matching goal condition's
 * debounce_sim_s. A missing predicate field is the scheduler default of 60s;
 * an explicit 0 is 0. Hand-built evidence that records neither a debounce nor
 * a wake row is left to the revision check — live verification always records
 * the hold, and the scheduler passes the wake ledger.
 */
function monitorDebounceCoversGoal(spec: GoalSpec, step: PlanGateStep, check: MonitorRevisionCheck): boolean {
  const cond = step.inputs?.condition as {metric?: string; op?: string; value?: number} | undefined;
  const required = cond ? goalMonitorCondition(spec, cond) : undefined;
  if (!required) return true;
  const evidence = step.verification?.evidence as {wake_id?: unknown; debounce_sim_s?: unknown} | undefined;
  let actual: number | null = typeof evidence?.debounce_sim_s === 'number' ? evidence.debounce_sim_s : null;
  if (check.firedWakes && typeof evidence?.wake_id === 'string') {
    const row = check.firedWakes.find(w => w.wake_id === evidence.wake_id);
    if (row) actual = effectiveDebounce(row.predicate);
  }
  if (actual == null) return true;
  return actual + 1e-9 >= required.debounce_sim_s;
}

/** Q03 + S02 + T01: a done+verified monitor step is success evidence only when
 * its inputs match the goal, the proof belongs to the current goal revision,
 * AND the fired wake did not shorten the goal's debounce. */
function monitorStepMatchesSuccessCondition(spec: GoalSpec, step: PlanGateStep, check: MonitorRevisionCheck): boolean {
  if (step.skill !== 'monitor_until' || step.status !== 'done' || step.verification?.pass !== true) {
    return false;
  }
  return monitorInputsMatchSuccessCondition(spec, step)
    && monitorStepEvidenceOfCurrentRevision(step, check)
    && monitorDebounceCoversGoal(spec, step, check);
}

/**
 * Q03: success evidence for a goal WITHOUT metrics. `metrics: []` must not
 * complete on nothing; completion requires VERIFIABLE success evidence:
 *
 * 1. `deadline_sim_s` reached — the authoritative sim clock is the evidence;
 * 2. a done `monitor_until` step with a passing verification that matches the
 *    goal's structured success conditions AND belongs to the CURRENT goal
 *    revision (S02: plan revision + proving-wake revision, see
 *    monitorStepMatchesSuccessCondition);
 * 3. otherwise `goal_unverified`: there is no verifiable success condition to
 *    check completion against, so the task must ask the user (request_input),
 *    never complete on an empty plan.
 *
 * `normalizeGoalSpec` persists only `success.description` — free text, never
 * verifiable — so there are no structured `success.conditions` fields to
 * evaluate today; if such fields are added to the GoalSpec they must be
 * matched here exactly like monitoring conditions.
 */
async function verifySuccessConditionEvidence(ctx: GoalVerifyContext): Promise<GoalVerifyOutcome> {
  const spec = ctx.spec;
  const steps = ctx.planSteps ?? [];
  const hasDeadline = typeof spec.deadline_sim_s === 'number';
  const conditions = spec.monitoring?.conditions ?? [];
  const base = {mode: 'plan_only' as const, metrics: []};
  if (!hasDeadline && conditions.length === 0) {
    return {ok: false, code: 'goal_unverified', evidence: base,
      reasons: ['the goal declares no metrics and carries no verifiable success condition '
        + '(no deadline_sim_s, no monitoring conditions, no structured success conditions); '
        + 'completion cannot be verified — ask the user for a success condition or use request_input']};
  }
  const state = await ctx.readState();
  const simNow = state.experiment.sim_time_s;
  if (hasDeadline && simNow + 1e-6 >= (spec.deadline_sim_s as number)) {
    return {ok: true, evidence: {...base, note: 'deadline reached on the authoritative sim clock',
      deadline_sim_s: spec.deadline_sim_s, sim_time_s: simNow}};
  }
  const revisionCheck: MonitorRevisionCheck = {task_id: ctx.task_id, goal_revision: ctx.goal_revision,
    firedWakes: ctx.firedWakes};
  const step = steps.find(s => monitorStepMatchesSuccessCondition(spec, s, revisionCheck));
  if (step) {
    return {ok: true, evidence: {...base,
      note: 'verified monitor_until evidence: a done step with a passing verification of the CURRENT goal revision matches the goal success condition',
      step_index: step.index_in_plan, step_skill: step.skill, step_inputs: step.inputs ?? null,
      goal_revision: ctx.goal_revision, plan_revision: step.plan_revision ?? null,
      deadline_sim_s: spec.deadline_sim_s ?? null, sim_time_s: simNow}};
  }
  const reasons: string[] = [];
  if (hasDeadline) {
    reasons.push(`deadline_sim_s=${spec.deadline_sim_s} is not reached (sim clock is at ${simNow}s) `
      + `and no done+verified monitor_until step of this task waited out until_sim_s >= ${spec.deadline_sim_s}`);
  }
  if (conditions.length > 0) {
    reasons.push(`no done+verified monitor_until step of this task matches the monitoring conditions `
      + `(${conditions.map(c => `${c.metric} ${c.op} ${c.value}`).join('; ')}) at the current goal revision ${ctx.goal_revision}`);
  }
  // S02: name the stale evidence when input-compatible monitor steps exist but
  // their proof belongs to an OLD goal version — after a goal edit the old
  // verified wait is history; the wait must be re-registered and re-verified
  // under the CURRENT revision before it can complete the task.
  const weakened = steps.filter(s => s.skill === 'monitor_until' && s.status === 'done'
    && s.verification?.pass === true
    && monitorInputsMatchSuccessCondition(spec, s)
    && monitorStepEvidenceOfCurrentRevision(s, revisionCheck)
    && !monitorDebounceCoversGoal(spec, s, revisionCheck));
  for (const s of weakened) {
    const held = (s.verification?.evidence as {debounce_sim_s?: unknown} | null)?.debounce_sim_s;
    const cond = s.inputs?.condition as {metric?: string; op?: string; value?: number} | undefined;
    const required = cond ? goalMonitorCondition(spec, cond) : undefined;
    reasons.push(`done+verified monitor_until step ${s.index_in_plan} matches ${cond?.metric} ${cond?.op} ${cond?.value} `
      + `but its wake only required ${held ?? 'an unspecified'}s of hold, while the goal requires ${required?.debounce_sim_s ?? '?'}s; `
      + `a shorter debounce may wake the model but is not success evidence — re-arm with debounce_sim_s >= ${required?.debounce_sim_s ?? '?'}`);
  }
  const stale = steps.filter(s => s.skill === 'monitor_until' && s.status === 'done'
    && s.verification?.pass === true
    && monitorInputsMatchSuccessCondition(spec, s)
    && !monitorStepEvidenceOfCurrentRevision(s, revisionCheck));
  for (const s of stale) {
    reasons.push(`done+verified monitor_until step ${s.index_in_plan} carries proof of goal revision `
      + `${(s.verification!.evidence as {wake_goal_revision?: unknown} | null)?.wake_goal_revision ?? 'unknown'} `
      + `(step plan_revision ${s.plan_revision ?? 'unknown'}), but the task is at revision ${ctx.goal_revision}; `
      + `the old-revision wait is history — replace the plan, re-register and verify the wait under revision ${ctx.goal_revision}`);
  }
  return {ok: false, code: 'goal_unverified', reasons,
    evidence: {...base, sim_time_s: simNow,
      goal_revision: ctx.goal_revision,
      deadline_reached: hasDeadline ? false : null,
      monitor_steps: steps.map(s => ({index: s.index_in_plan, skill: s.skill, status: s.status,
        pass: s.verification?.pass ?? null,
        plan_revision: s.plan_revision ?? null,
        wake_goal_revision: (s.verification?.evidence as {wake_goal_revision?: unknown} | null)
          ?.wake_goal_revision ?? null}))}};
}

/**
 * N02 goal-level success check, independent of the plan: task success requires
 * verifiable success evidence for the CURRENT goal revision.
 *
 * - Metrics named by the GoalSpec are evaluated directly. Chamber metrics
 *   (temperature_c/co2_pct/humidity_pct) read the authoritative live chamber;
 *   observation metrics (medium_volume_ul/liquid_level_ul) are judged PER WELL
 *   (Q04): for every well a metric requires, the FRESHEST USABLE observation
 *   of THIS task at the CURRENT goal revision (intent ledger) that covers it
 *   — at the current plate revision, quality ok, non-null estimates, sampled
 *   after the last succeeded maintenance ended — decides the verdict. A later
 *   scan of another row no longer discards the still-valid earlier row's
 *   evidence, and a NEWER reading that misses the metric can never be hidden
 *   by an older passing one.
 * - A metric that cannot be verified refuses with `goal_unverified`; a metric
 *   whose verified readings miss the target refuses with `goal_unmet`.
 * - S03: a metric whose target (plate/row/well) is unknown to the AUTHORITATIVE
 *   layout, or that resolves to no well at all, refuses with `goal_unverified`
 *   naming the invalid target — it is never silently filtered into a zero-well
 *   "verified" pass, and a mix of valid and invalid metrics still refuses.
 * - Tasks WITHOUT metrics (Q03) need verifiable success evidence — the
 *   deadline reached, or a done+verified monitor_until step matching the
 *   goal's deadline / monitoring conditions; anything else refuses with
 *   `goal_unverified` (an empty plan is NOT success).
 */
export async function verifyGoalSatisfied(ctx: GoalVerifyContext): Promise<GoalVerifyOutcome> {
  const metrics = ctx.spec.metrics;
  if (metrics.length === 0) {
    return verifySuccessConditionEvidence(ctx);
  }
  const state = await ctx.readState();
  const problems: string[] = [];
  const unmet: string[] = [];
  const evidence: Record<string, unknown> = {mode: 'metrics_verified', metrics: []};
  // chamber metrics: authoritative live readings
  for (const m of metrics.filter(x => CHAMBER_METRICS.has(x.metric))) {
    const reading = m.metric === 'temperature_c' ? state.chamber.temperature_c?.observed
      : m.metric === 'co2_pct' ? state.chamber.co2_pct?.observed
        : state.chamber.humidity_pct?.observed;
    if (typeof reading !== 'number') {
      problems.push(`${m.metric}: the device state carries no chamber reading`);
      continue;
    }
    const satisfied = m.op === '>=' ? reading + 1e-6 >= m.value : reading <= m.value + 1e-6;
    (evidence.metrics as unknown[]).push({metric: m.metric, op: m.op, value: m.value, observed: reading});
    if (!satisfied) unmet.push(`${m.metric} is ${reading}, required ${m.op} ${m.value}`);
  }
  // observation metrics: freshest OWNED, current-revision, current-plate-revision evidence
  const liquidMetrics = metrics.filter(x => !CHAMBER_METRICS.has(x.metric));
  if (liquidMetrics.length > 0) {
    let lastMaintenanceEnd = 0;
    for (const actionId of ctx.maintenanceActionIds.slice(-20)) {
      const action = await ctx.readAction(actionId);
      if (action && action.status === 'succeeded' && action.capability !== 'imaging.scan'
        && MAINTENANCE_CAPABILITIES.includes(action.capability)) {
        lastMaintenanceEnd = Math.max(lastMaintenanceEnd, action.ended_at_sim_s ?? 0);
      }
    }
    // Q04: usable observations aggregated PER PLATE (all filters unchanged),
    // then judged PER WELL — one newest-per-plate observation can no longer
    // discard a still-valid earlier row scan of the same plate.
    const usableByPlate = new Map<string, Array<{observation: Observation; levels: Record<string, number>}>>();
    for (const ref of [...new Set(ctx.observationRefs)]) {
      const obs = await ctx.readObservation(ref);
      if (!obs) continue;
      const owner = ctx.ownsAction(obs.action_id);
      if (!owner || owner.task_id !== ctx.task_id || owner.goal_revision !== ctx.goal_revision) continue;
      if (obs.quality !== 'ok') continue;
      if (obs.sampled_at_sim_s + 1e-6 < lastMaintenanceEnd) continue;
      const plate = state.plates.find(p => p.plate_id === obs.plate_id);
      if (!plate || obs.plate_revision !== plate.revision) continue;
      const levels: Record<string, number> = {};
      let usable = true;
      for (const est of obs.estimates) {
        if (est.liquid_level_ul == null) {usable = false; break;}
        levels[est.well_id] = est.liquid_level_ul;
      }
      if (!usable) continue;
      const list = usableByPlate.get(obs.plate_id) ?? [];
      list.push({observation: obs, levels});
      usableByPlate.set(obs.plate_id, list);
    }
    for (const m of liquidMetrics) {
      // S03: resolve the metric's targets against the AUTHORITATIVE layout.
      // An unknown plate/row/well (or a metric resolving to no well at all) is
      // an INVALID target: it refuses completion instead of being silently
      // filtered into a zero-well "verified" loop.
      const resolved = metricWells(ctx.spec, state, m);
      if (resolved.problems.length > 0) {
        const what = `${m.metric}${m.row_id ? ` (row ${m.row_id})` : m.well_id ? ` (well ${m.well_id})` : ''}`;
        problems.push(...resolved.problems.map(p => `${what}: ${p}; the metric has no verifiable well range `
          + `— fix the goal target (update_task_goal) or supply the missing parameters; it cannot be skipped silently`));
        continue;
      }
      for (const required of resolved.entries) {
          // freshest usable observation PER WELL: candidates newest-first
          // (stable — on equal sampled_at the first cited wins), and the first
          // candidate covering a well decides that well's verdict. A newer
          // reading that misses the metric can therefore never be hidden by an
          // older passing one, and a usable older row scan still proves its row.
          const candidates = (usableByPlate.get(required.plateId) ?? [])
            .slice().sort((a, b) => b.observation.sampled_at_sim_s - a.observation.sampled_at_sim_s);
          const verdict = new Map<string, {observation: Observation; level: number}>();
          for (const c of candidates) {
            for (const well of required.wells) {
              if (verdict.has(well) || !c.observation.wells.includes(well)) continue;
              // covering means listed AND carrying a usable numeric estimate
              const level = c.levels[well];
              if (typeof level !== 'number') continue;
              verdict.set(well, {observation: c.observation, level});
            }
          }
          const missing = required.wells.filter(w => !verdict.has(w));
          if (missing.length > 0) {
            problems.push(`${m.metric}${m.row_id ? ` (row ${m.row_id})` : ''} on ${required.plateId}: `
              + `no usable observation of this task at goal revision ${ctx.goal_revision} `
              + `${lastMaintenanceEnd > 0 ? `(sampled after the last maintenance ended at sim ${lastMaintenanceEnd}s) ` : ''}`
              + `covers ${missing.join(',')} at the current plate revision`);
            continue;
          }
          for (const well of required.wells) {
            const hit = verdict.get(well)!;
            const satisfied = m.op === '>=' ? hit.level + 1e-6 >= m.value : hit.level <= m.value + 1e-6;
            if (!satisfied) unmet.push(`${m.metric}${m.row_id ? ` (row ${m.row_id})` : ''}: well ${well} of ${required.plateId} `
              + `is ${hit.level.toFixed ? hit.level.toFixed(1) : hit.level} µL, required ${m.op} ${m.value} µL `
              + `(observation ${hit.observation.observation_id} @ sim ${hit.observation.sampled_at_sim_s}s)`);
          }
          // evidence: WHICH observation proved WHICH wells (Q04) — a multirow
          // goal may be proven by several single-row scans of the same plate
          const byObservation = new Map<string, {observation_id: string; sampled_at_sim_s: number;
            wells: Array<{well_id: string; level_ul: number}>}>();
          for (const well of required.wells) {
            const hit = verdict.get(well)!;
            let group = byObservation.get(hit.observation.observation_id);
            if (!group) {
              group = {observation_id: hit.observation.observation_id,
                sampled_at_sim_s: hit.observation.sampled_at_sim_s, wells: []};
              byObservation.set(hit.observation.observation_id, group);
            }
            group.wells.push({well_id: well, level_ul: hit.level});
          }
          (evidence.metrics as unknown[]).push({metric: m.metric, op: m.op, value: m.value, row_id: m.row_id ?? null,
            plate_id: required.plateId,
            observations: [...byObservation.values()],
            wells: required.wells.map(w => ({well_id: w, level_ul: verdict.get(w)!.level,
              observation_id: verdict.get(w)!.observation.observation_id}))});
        }
    }
  }
  if (problems.length) {
    return {ok: false, code: 'goal_unverified', reasons: problems, evidence};
  }
  if (unmet.length) {
    return {ok: false, code: 'goal_unmet', reasons: unmet, evidence};
  }
  return {ok: true, evidence: evidence as {mode: 'metrics_verified'} & Record<string, unknown>};
}

/** Evaluator entry point used by the scheduler (and unit tests). */
export async function verifySkillStep(def: SkillDefinition, ctx: SkillVerifyContext): Promise<VerifyOutcome> {
  return def.verify(ctx);
}
