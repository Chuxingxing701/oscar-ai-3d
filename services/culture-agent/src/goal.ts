// GoalSpec: the structured, checkable counterpart of a natural-language goal
// (design §5). The scenario provides the initial world; the user's goal and
// its plan live independently of scenario_id. Missing critical parameters put
// the task into needs_input instead of inventing a protocol.
import {WRITE_CAPABILITIES} from '@oscar/device-contract';

export interface GoalMetric {
  metric: string;                       // medium_volume_ul | temperature_c | co2_pct | humidity_pct | liquid_level_ul
  op: '>=' | '<=';
  value: number;
  source: 'observation' | 'chamber';
  row_id?: string;
  well_id?: string;
}

export interface MonitorCondition {
  metric: string;                       // chamber metric or per-row medium level
  op: 'below' | 'above';
  value: number;
  debounce_sim_s: number;               // must hold this long before waking
  hysteresis: number;                   // re-arm only after crossing back by this much
  cooldown_sim_s: number;               // min sim time between two fires
}

export interface GoalSpec {
  description: string;
  scope: {plates: string[]; rows?: string[]; reservoirs?: string[]};
  metrics: GoalMetric[];
  allowed_operations: string[];
  monitoring?: {interval_sim_s?: number; conditions?: MonitorCondition[]};
  deadline_sim_s?: number | null;       // sim clock domain by definition
  success: {description: string};
  stop: {description: string; max_corrections?: number};
  budget?: {max_actions?: number; max_model_turns?: number};
  missing_parameters?: string[];        // open questions for the user (needs_input)
  request_id?: string;                  // set by the store for create idempotency
}

const METRICS = new Set(['medium_volume_ul', 'liquid_level_ul', 'temperature_c', 'co2_pct', 'humidity_pct']);
const OPERATIONS = new Set([...WRITE_CAPABILITIES, 'environment.set_targets', 'environment.await_stable']);

export class GoalSpecError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[]) { super(message); this.problems = problems; }
}

function strArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new GoalSpecError(`${what} must be an array`, [`${what} must be an array`]);
  return v.map(x => String(x));
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Validate and normalize a goal spec from user/model/API input. */
export function normalizeGoalSpec(input: unknown): GoalSpec {
  const problems: string[] = [];
  const add = (p: string): void => {problems.push(p);};
  if (typeof input !== 'object' || input === null) throw new GoalSpecError('goal_spec must be an object', ['goal_spec must be an object']);
  const raw = input as Record<string, unknown>;
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) add('description is required');
  const plates = strArray((raw.scope && (raw.scope as Record<string, unknown>).plates) ?? [], 'scope.plates');
  if (plates.length === 0) add('scope.plates must list at least one plate');
  const rows = raw.scope ? strArray((raw.scope as Record<string, unknown>).rows ?? [], 'scope.rows') : [];
  const metricsRaw = Array.isArray(raw.metrics) ? raw.metrics : [];
  const metrics: GoalMetric[] = metricsRaw.map((m, i) => {
    const mo = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
    const metric = String(mo.metric ?? '');
    const op = mo.op === '<=' ? '<=' : '>=';
    const value = num(mo.value);
    const source = mo.source === 'chamber' ? 'chamber' : 'observation';
    if (!METRICS.has(metric)) add(`metrics[${i}].metric '${metric}' is not one of ${[...METRICS].join(', ')}`);
    if (value === undefined) add(`metrics[${i}].value must be a number`);
    return {metric, op, value: value ?? 0, source,
      row_id: mo.row_id ? String(mo.row_id) : undefined, well_id: mo.well_id ? String(mo.well_id) : undefined};
  });
  const allowed = strArray(raw.allowed_operations ?? [], 'allowed_operations').filter(op => {
    if (OPERATIONS.has(op)) return true;
    add(`allowed_operations entry '${op}' is not a known OSCAR capability`);
    return false;
  });
  if (allowed.length === 0) add('allowed_operations must list at least one capability');
  const monitoringRaw = typeof raw.monitoring === 'object' && raw.monitoring !== null
    ? raw.monitoring as Record<string, unknown> : null;
  let monitoring: GoalSpec['monitoring'];
  if (monitoringRaw) {
    const conditions = Array.isArray(monitoringRaw.conditions) ? monitoringRaw.conditions.map((c, i) => {
      const co = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
      const metric = String(co.metric ?? '');
      if (!METRICS.has(metric)) add(`monitoring.conditions[${i}].metric '${metric}' is unknown`);
      return {metric, op: co.op === 'above' ? 'above' as const : 'below' as const,
        value: num(co.value) ?? 0, debounce_sim_s: num(co.debounce_sim_s) ?? 60,
        hysteresis: num(co.hysteresis) ?? Math.abs(num(co.value) ?? 0) * 0.05,
        cooldown_sim_s: num(co.cooldown_sim_s) ?? 1800};
    }) : undefined;
    monitoring = {interval_sim_s: num(monitoringRaw.interval_sim_s), conditions};
  }
  if (problems.length) throw new GoalSpecError('goal_spec has problems', problems);
  return {
    description, scope: {plates, rows: rows.length ? rows : undefined,
      reservoirs: raw.scope ? strArray((raw.scope as Record<string, unknown>).reservoirs ?? [], 'scope.reservoirs') : undefined},
    metrics, allowed_operations: allowed, monitoring,
    deadline_sim_s: num(raw.deadline_sim_s) ?? null,
    success: {description: typeof (raw.success as {description?: unknown})?.description === 'string'
      ? String((raw.success as {description: string}).description) : 'all metrics satisfied'},
    stop: {description: typeof (raw.stop as {description?: unknown})?.description === 'string'
      ? String((raw.stop as {description: string}).description) : 'user cancel or budget exhausted',
      max_corrections: num((raw.stop as {max_corrections?: unknown})?.max_corrections)},
    budget: typeof raw.budget === 'object' && raw.budget !== null
      ? {max_actions: num((raw.budget as {max_actions?: unknown}).max_actions),
        max_model_turns: num((raw.budget as {max_model_turns?: unknown}).max_model_turns)}
      : undefined,
    missing_parameters: Array.isArray(raw.missing_parameters) ? raw.missing_parameters.map(String) : undefined,
  };
}

/**
 * Parameters without which the task must NOT auto-execute. Metrics with a
 * value are executable; a monitoring-only task also needs at least one
 * condition or interval.
 */
export function missingExecutionParameters(spec: GoalSpec): string[] {
  const missing: string[] = [...(spec.missing_parameters ?? [])];
  if (spec.metrics.length === 0 && !spec.monitoring?.conditions?.length && spec.monitoring?.interval_sim_s == null) {
    missing.push('At least one target metric or monitoring condition is required (e.g. keep medium volume per well ≥ N µL).');
  }
  return missing;
}

/** Write-scope enforcement used by the tool executor before any submit. */
export function scopeAllowsWrite(spec: GoalSpec, capability: string, args: Record<string, unknown>): {ok: true} | {ok: false; reason: string} {
  if (!spec.allowed_operations.includes(capability)) {
    return {ok: false, reason: `capability '${capability}' is outside the goal's allowed_operations`};
  }
  const plateId = typeof args.plate_id === 'string' ? args.plate_id : null;
  if (plateId && spec.scope.plates.length && !spec.scope.plates.includes(plateId)) {
    return {ok: false, reason: `plate '${plateId}' is outside the goal scope ${spec.scope.plates.join(', ')}`};
  }
  const rowId = typeof args.row_id === 'string' ? args.row_id : null;
  if (rowId && spec.scope.rows?.length && !spec.scope.rows.includes(rowId)) {
    return {ok: false, reason: `row '${rowId}' is outside the goal scope ${spec.scope.rows.join(', ')}`};
  }
  const reservoirId = typeof args.reservoir_id === 'string' ? args.reservoir_id : null;
  if (reservoirId && spec.scope.reservoirs?.length && !spec.scope.reservoirs.includes(reservoirId)) {
    return {ok: false, reason: `reservoir '${reservoirId}' is outside the goal scope`};
  }
  return {ok: true};
}
