// Fixed-step world evolution: environment response, sensor sampling, culture
// evolution, evaporation, shake bookkeeping. Pure function of (world, dt).
// Same world + same dt sequence -> identical floats (fixed op order).
import {DEMO_PROFILE} from '@oscar/device-contract';
import {sampleEnvironment, stepEnvironment} from './env.ts';
import type {World} from './world.ts';

export interface StepReport {
  /** Environment was sampled this step (sensor tick). */
  sampled: boolean;
}

/** Advance the world by dt seconds (default one sim step). Mutates world. */
export function stepWorld(world: World, dt: number = DEMO_PROFILE.sim_step_s): StepReport {
  const t0 = world.sim_time_s;
  const t1 = t0 + dt;
  stepEnvironment(world, dt);

  // Sensor sampling every sample_interval_s on the grid (and at t=0, done at creation).
  let sampled = false;
  const interval = DEMO_PROFILE.environment.sample_interval_s;
  if (Math.floor(t1 / interval) > Math.floor(t0 / interval) || t1 === 0) {
    world.sim_time_s = t1;
    sampleEnvironment(world);
    sampled = true;
  }

  // Culture evolution on its own tick grid (every culture.tick_s).
  const tick = DEMO_PROFILE.culture.tick_s;
  if (Math.floor(t1 / tick) > Math.floor(t0 / tick)) {
    evolveCulture(world, tick);
  }

  // Evaporation every step (continuous demo rate), tracked separately in
  // evaporated_ul; does NOT bump plate.revision.
  evaporate(world, dt);

  world.sim_time_s = t1;
  // Keep fractional sim times on the integer grid.
  world.sim_time_s = Math.round(world.sim_time_s * 1e6) / 1e6;
  return {sampled};
}

/** Schematic culture evolution (demo indices, not biology). */
function evolveCulture(world: World, tickS: number): void {
  const dtH = tickS / 3600;
  const tempOffset = Math.abs(world.chamber.actual.temperature_c - 37);
  const stress = Math.min(1, tempOffset / 5); // demo stress factor from environment drift
  for (const plate of world.plates) {
    for (const well of plate.wells) {
      if (well.volume_ul <= 0) continue;
      const c = well.culture;
      // Nutrient is consumed faster when the environment is off-target (demo rule).
      c.nutrient = Math.max(0, c.nutrient - dtH * (0.05 + 0.1 * stress) * (0.5 + c.morphology));
      c.metabolite = Math.min(1, c.metabolite + dtH * 0.04 * (0.5 + c.morphology) * (1 + stress));
      // Morphology grows slowly while nutrient is available.
      c.morphology = Math.min(1, c.morphology + dtH * 0.02 * c.nutrient * (1 - stress * 0.8));
      // Mixing decays after a shake (exponential demo decay, ~30 min).
      c.mixing = Math.max(0, c.mixing * Math.exp(-tickS / 1800));
    }
  }
}

/** Evaporation: volume leaves the well, accounted separately in evaporated_ul. */
function evaporate(world: World, dt: number): void {
  const perWell = (DEMO_PROFILE.culture.evaporation_ul_per_h / 3600) * dt;
  for (const plate of world.plates) {
    for (const well of plate.wells) {
      if (well.volume_ul <= 0) continue;
      const d = Math.min(well.volume_ul, perWell);
      well.volume_ul -= d;
      well.evaporated_ul += d;
    }
  }
}
