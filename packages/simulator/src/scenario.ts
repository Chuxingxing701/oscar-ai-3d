// Versioned demo scenario definitions (scenarios/*.json). Every number is an
// explicit DEMO parameter, not a calibrated protocol.
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

export interface ScenarioChamberInit {
  targets: {temperature_c: number; co2_pct: number; humidity_pct: number};
  actual?: {temperature_c: number; co2_pct: number; humidity_pct: number};
}

export interface ScenarioPlateInit {
  id: string;
  station_id: string;
  format: '24' | '96';
  medium_id: string;
  /** Row -> one volume per column, µL (demo values). */
  wells_volume_ul: Record<string, number[]>;
  /** Default culture indices for all wells (0–1, dimensionless demo indices). */
  culture?: {nutrient?: number; metabolite?: number; morphology?: number};
  /** Optional per-row culture override. */
  culture_rows?: Record<string, {nutrient?: number; metabolite?: number; morphology?: number}>;
}

export interface ScenarioInit {
  chamber: ScenarioChamberInit;
  plates: ScenarioPlateInit[];
  reservoirs: {id: string; station_id: string; medium_id: string; remaining_ul: number; capacity_ul: number}[];
  waste: {id: string; station_id: string; used_ul: number; capacity_ul: number};
  tip_racks: {id: string; station_id: string; remaining: number; capacity: number}[];
}

export interface ScenarioFault {
  kind: 'camera_blur';
  first_scans?: number;
  description?: string;
}

export interface Scenario {
  id: string;
  version: string;
  seed: number;
  description: string;
  initial: ScenarioInit;
  task: {
    goal: string;
    allowed_capabilities: string[];
    plates: string[];
    env_targets: {temperature_c: number; co2_pct: number; humidity_pct: number};
    tolerances: {temperature_c: number; co2_pct: number; humidity_pct: number};
    budgets: {max_actions: number; max_sim_time_s: number};
    policy_hints: Record<string, unknown>;
  };
  faults: ScenarioFault[];
}

export const SCENARIO_DIR_ENV = 'OSCAR_SCENARIO_DIR';
const cache = new Map<string, Scenario>();

/** Load a scenario JSON by id from <root>/scenarios. Cached; pure read. */
export function loadScenario(id: string, dir?: string): Scenario {
  const key = `${dir ?? ''}/${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const base = dir ?? process.env[SCENARIO_DIR_ENV] ?? join(repoRoot(), 'scenarios');
  const scenario = JSON.parse(readFileSync(join(base, `${id}.json`), 'utf8')) as Scenario;
  if (scenario.id !== id) throw new Error(`Scenario id mismatch: file says ${scenario.id}, asked for ${id}`);
  cache.set(key, scenario);
  return scenario;
}

export function listScenarios(dir?: string): string[] {
  const base = dir ?? process.env[SCENARIO_DIR_ENV] ?? join(repoRoot(), 'scenarios');
  return readdirSync(base).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
}

/** Walk up from this file to the directory containing package.json with workspaces. */
function repoRoot(): string {
  // packages/simulator/src -> repo root is three levels up.
  return join(import.meta.dirname, '..', '..', '..');
}
