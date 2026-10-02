// The simulated world: a plain JSON-serializable value. The Runtime persists
// it per experiment and feeds it back after restarts; the simulator itself
// keeps no hidden state (all noise is hash-derived, see rand.ts).
import {DEMO_PROFILE, PLATE_LAYOUTS, rowIds, rowWellIds, type PlateLayout} from '@oscar/device-contract';
import type {Scenario} from './scenario.ts';
import {sampleEnvironment} from './env.ts';

export const SIMULATOR_VERSION = '0.1.0';

export interface WellSim {
  well_id: string;
  volume_ul: number;
  capacity_ul: number;
  medium_id: string | null;
  /** Cumulative volume removed by evaporation since world start (µL). */
  evaporated_ul: number;
  culture: {
    nutrient: number;   // 0–1 fresh-medium richness (dimensionless demo index)
    metabolite: number; // 0–1 waste accumulation
    mixing: number;     // 0–1 how well mixed after shake
    morphology: number; // 0–1 schematic organoid development index
  };
}

export interface ShakeSim {
  active: boolean;
  started_at_sim_s: number;
  duration_sim_s: number;
  speed_rpm: number;
  action_id: string | null;
  ended_at_sim_s: number | null;
  /** Images stay blurred until this sim time after the shake ended. */
  settle_until_sim_s: number;
}

export interface PlateSim {
  plate_id: string;
  station_id: string;
  format: '24' | '96';
  rows: string[];
  columns: number;
  revision: number;
  shake: ShakeSim;
  wells: WellSim[];
}

export interface ReservoirSim {id: string; station_id: string; medium_id: string; remaining_ul: number; capacity_ul: number}
export interface WasteSim {id: string; station_id: string; used_ul: number; capacity_ul: number}
export interface TipRackSim {id: string; station_id: string; remaining: number; capacity: number}

export interface HeadSim {
  /** Liquid held per channel, index 0..channels-1 (µL). */
  load_ul: number[];
  has_tips: boolean;
  tip_rack_id: string | null;
  /** Medium the head is carrying (fresh from a reservoir). */
  medium_id: string | null;
}

export interface EnvValues {temperature_c: number; co2_pct: number; humidity_pct: number}
export type EnvChannelName = keyof EnvValues;

export interface ChamberSim {
  targets: EnvValues;
  /** simulator_truth (internal; never sent to clients directly). */
  actual: EnvValues;
  /** Last observed sample (synthetic_sensor, seeded noise), visible to clients. */
  sample: EnvValues & {quality: 'ok' | 'settling'; sampled_at_sim_s: number};
  target_revision: number;
  /** Per channel: sim time since which |observed-target| stayed within tolerance. */
  within_tolerance_since: Record<EnvChannelName, number | null>;
}

export interface FaultsSim {
  camera_blur: {remaining_scans: number};
}

export interface World {
  simulator_version: string;
  scenario_id: string;
  scenario_version: string;
  seed: number;
  sim_time_s: number;
  chamber: ChamberSim;
  plates: PlateSim[];
  reservoirs: ReservoirSim[];
  wastes: WasteSim[];
  tip_racks: TipRackSim[];
  head: HeadSim;
  faults: FaultsSim;
  counters: {scan_count: number; shake_count: number};
}

export function plateLayout(plate: PlateSim): PlateLayout {
  return PLATE_LAYOUTS[plate.format];
}

export function findPlate(world: World, plateId: string): PlateSim | undefined {
  return world.plates.find(p => p.plate_id === plateId);
}

export function findWell(world: World, plateId: string, wellId: string): WellSim | undefined {
  return findPlate(world, plateId)?.wells.find(w => w.well_id === wellId);
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Build a fresh world from a scenario and seed. Pure; no wall clock, no RNG state. */
export function createWorld(scenario: Scenario, seed: number): World {
  const init = scenario.initial;
  const actual = init.chamber.actual ?? init.chamber.targets;
  const world: World = {
    simulator_version: SIMULATOR_VERSION,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    seed,
    sim_time_s: 0,
    chamber: {
      targets: {...init.chamber.targets},
      actual: {...actual},
      sample: {...actual, quality: 'ok', sampled_at_sim_s: 0},
      target_revision: 1,
      within_tolerance_since: {temperature_c: 0, co2_pct: 0, humidity_pct: 0},
    },
    plates: [],
    reservoirs: init.reservoirs.map(r => ({...r})),
    wastes: [{...init.waste}],
    tip_racks: init.tip_racks.map(t => ({...t})),
    head: {load_ul: Array.from({length: DEMO_PROFILE.head.channels}, () => 0), has_tips: false, tip_rack_id: null, medium_id: null},
    faults: {camera_blur: {remaining_scans: scenario.faults.find(f => f.kind === 'camera_blur')?.first_scans ?? 0}},
    counters: {scan_count: 0, shake_count: 0},
  };
  for (const p of init.plates) {
    const layout = PLATE_LAYOUTS[p.format];
    const rows = rowIds(layout);
    const wells: WellSim[] = [];
    for (const row of rows) {
      const volumes = p.wells_volume_ul[row] ?? Array.from({length: layout.columns}, () => 0);
      const rowCulture = p.culture_rows?.[row] ?? {};
      for (let c = 0; c < layout.columns; c++) {
        wells.push({
          well_id: `${row}${c + 1}`,
          volume_ul: volumes[c] ?? 0,
          capacity_ul: DEMO_PROFILE.liquid.well_capacity_ul,
          medium_id: p.medium_id,
          evaporated_ul: 0,
          culture: {
            nutrient: clamp01(rowCulture.nutrient ?? p.culture?.nutrient ?? 1),
            metabolite: clamp01(rowCulture.metabolite ?? p.culture?.metabolite ?? 0),
            mixing: 0.5,
            morphology: clamp01(rowCulture.morphology ?? p.culture?.morphology ?? 0.2),
          },
        });
      }
    }
    world.plates.push({
      plate_id: p.id, station_id: p.station_id, format: p.format, rows, columns: layout.columns,
      revision: 1,
      shake: {active: false, started_at_sim_s: 0, duration_sim_s: 0, speed_rpm: 0, action_id: null, ended_at_sim_s: null, settle_until_sim_s: 0},
      wells,
    });
  }
  // Sample the initial sensor reading (t=0) with the seeded noise.
  sampleEnvironment(world);
  return world;
}

/** Wells of a complete row in column order, e.g. A -> A1..A6. */
export function rowWells(world: World, plateId: string, rowId: string): WellSim[] {
  const plate = findPlate(world, plateId);
  if (!plate) return [];
  return rowWellIds(plateLayout(plate), rowId).map(id => plate.wells.find(w => w.well_id === id)!);
}
