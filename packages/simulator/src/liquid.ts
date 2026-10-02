// Row-pipette liquid primitives. Each operates on a COMPLETE row: the 6
// channels aspirate/dispense simultaneously with independent per-channel
// volumes (demo assumption: channels can carry different volumes, e.g. a
// per-well exchange fraction — this is a simulator convention, not a hardware
// claim). Medium nutrient/metabolite mix volume-weighted.
import {DEMO_PROFILE, type StepEffect, type WellDelta} from '@oscar/device-contract';
import type {HeadSim, PlateSim, ReservoirSim, TipRackSim, WasteSim, WellSim, World} from './world.ts';

/** Fresh medium is nutrient-rich and metabolite-free (demo indices). */
const FRESH = {nutrient: 1, metabolite: 0};

/** Volume-weighted mixture of two liquid parcels. */
function mixFraction(v1: number, c1: number, v2: number, c2: number): number {
  const total = v1 + v2;
  if (total <= 0) return (c1 + c2) / 2;
  return (v1 * c1 + v2 * c2) / total;
}

function wellDeltas(wells: WellSim[], deltas: number[]): WellDelta[] {
  return wells.map((w, i) => ({well_id: w.well_id, delta_ul: deltas[i]}));
}

/** Pick DEMO_PROFILE.head.channels tips from the first rack with enough left. */
export function tipsPick(world: World): {rack: TipRackSim; effect: StepEffect} {
  const n = DEMO_PROFILE.head.channels;
  const rack = world.tip_racks.find(r => r.remaining >= n);
  if (!rack) throw new Error('no tip rack with enough tips (should have been validated at accept)');
  rack.remaining -= n;
  world.head.has_tips = true;
  world.head.tip_rack_id = rack.id;
  return {rack, effect: {step_index: -1, stage: 'picking_tip', committed_at_sim_s: world.sim_time_s,
    tips: {id: rack.id, delta: -n}}};
}

export function tipsDrop(world: World): {rackId: string; effect: StepEffect} {
  const rackId = world.head.tip_rack_id ?? world.tip_racks[0]?.id ?? 'tips-01';
  world.head.has_tips = false;
  world.head.tip_rack_id = null;
  return {rackId, effect: {step_index: -1, stage: 'dropping_tip', committed_at_sim_s: world.sim_time_s,
    tips: {id: rackId, delta: 0}}};
}

/** Aspirate a complete row: each channel removes volumes[i] from its well into the head. */
export function rowAspirate(world: World, plateId: string, rowId: string, volumes: number[]):
    {plate: PlateSim; effect: StepEffect} {
  const plate = world.plates.find(p => p.plate_id === plateId);
  if (!plate) throw new Error(`unknown plate ${plateId}`);
  const wells = plate.wells.filter(w => w.well_id.startsWith(rowId));
  if (wells.length !== volumes.length) throw new Error('row/channel count mismatch');
  for (let i = 0; i < wells.length; i++) {
    wells[i].volume_ul -= volumes[i];
    world.head.load_ul[i] += volumes[i];
  }
  // Aspirated liquid leaves the wells; concentrations per well stay proportional.
  plate.revision += 1;
  return {plate, effect: {step_index: -1, stage: 'aspirating', committed_at_sim_s: world.sim_time_s,
    wells: wellDeltas(wells, volumes.map(v => -v)), head_load_ul: [...world.head.load_ul]}};
}

/** Dispense a complete row: each channel adds volumes[i] of the head medium to its well. */
export function rowDispense(world: World, plateId: string, rowId: string, volumes: number[]):
    {plate: PlateSim; effect: StepEffect} {
  const plate = world.plates.find(p => p.plate_id === plateId);
  if (!plate) throw new Error(`unknown plate ${plateId}`);
  const wells = plate.wells.filter(w => w.well_id.startsWith(rowId));
  if (wells.length !== volumes.length) throw new Error('row/channel count mismatch');
  for (let i = 0; i < wells.length; i++) {
    const w = wells[i];
    const v = volumes[i];
    w.culture.nutrient = mixFraction(w.volume_ul, w.culture.nutrient, v, FRESH.nutrient);
    w.culture.metabolite = mixFraction(w.volume_ul, w.culture.metabolite, v, FRESH.metabolite);
    w.volume_ul += v;
    world.head.load_ul[i] -= v;
  }
  plate.revision += 1;
  return {plate, effect: {step_index: -1, stage: 'dispensing', committed_at_sim_s: world.sim_time_s,
    wells: wellDeltas(wells, volumes), head_load_ul: [...world.head.load_ul]}};
}

/** Aspirate fresh medium from a reservoir into all channels (per-channel volumes). */
export function reservoirAspirate(world: World, reservoirId: string, volumes: number[]):
    {reservoir: ReservoirSim; effect: StepEffect} {
  const reservoir = world.reservoirs.find(r => r.id === reservoirId);
  if (!reservoir) throw new Error(`unknown reservoir ${reservoirId}`);
  const total = volumes.reduce((a, b) => a + b, 0);
  reservoir.remaining_ul -= total;
  for (let i = 0; i < world.head.load_ul.length; i++) world.head.load_ul[i] = volumes[i] ?? 0;
  world.head.medium_id = reservoir.medium_id;
  return {reservoir, effect: {step_index: -1, stage: 'aspirating', committed_at_sim_s: world.sim_time_s,
    reservoir: {id: reservoir.id, delta_ul: -total}, head_load_ul: [...world.head.load_ul]}};
}

/** Dispense everything the head holds into the waste container. */
export function wasteDispense(world: World, wasteId?: string): {waste: WasteSim; effect: StepEffect} {
  const waste = world.wastes.find(w => w.id === (wasteId ?? world.wastes[0]?.id));
  if (!waste) throw new Error('unknown waste container');
  const total = world.head.load_ul.reduce((a, b) => a + b, 0);
  waste.used_ul += total;
  world.head.load_ul = world.head.load_ul.map(() => 0);
  world.head.medium_id = null;
  return {waste, effect: {step_index: -1, stage: 'dispensing', committed_at_sim_s: world.sim_time_s,
    waste: {id: waste.id, delta_ul: total}, head_load_ul: [...world.head.load_ul]}};
}

/** Cancel/discard path: everything still held by the head goes to waste (conservation). */
export function headDiscard(world: World, wasteId?: string): {waste: WasteSim; effect: StepEffect} {
  return wasteDispense(world, wasteId);
}

export function headLoadTotal(head: HeadSim): number {
  return head.load_ul.reduce((a, b) => a + b, 0);
}
