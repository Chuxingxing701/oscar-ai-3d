// Chamber environment: first-order response toward targets, periodic sensor
// sampling with seeded noise, per-channel stability tracking.
import {DEMO_PROFILE} from '@oscar/device-contract';
import {normal} from './rand.ts';
import type {EnvChannelName, EnvValues, World} from './world.ts';

const CHANNELS: {name: EnvChannelName; key: keyof typeof DEMO_PROFILE.environment}[] = [
  {name: 'temperature_c', key: 'temperature_c'},
  {name: 'co2_pct', key: 'co2_pct'},
  {name: 'humidity_pct', key: 'humidity_pct'},
];

/** One first-order step of dt seconds toward the targets (tau from the profile). */
export function stepEnvironment(world: World, dt: number): void {
  for (const {name} of CHANNELS) {
    const cfg = DEMO_PROFILE.environment[name] as {tau_s: number};
    const target = world.chamber.targets[name];
    const actual = world.chamber.actual[name];
    // Discrete first-order response; identical op order everywhere.
    world.chamber.actual[name] = actual + (target - actual) * (1 - Math.exp(-dt / cfg.tau_s));
  }
}

/** Take a sensor sample with seeded noise. Called every sample_interval_s and at t=0. */
export function sampleEnvironment(world: World): void {
  let settling = false;
  const t = world.sim_time_s;
  for (const {name} of CHANNELS) {
    const cfg = DEMO_PROFILE.environment[name] as {noise: number; tolerance: number};
    const observed = world.chamber.actual[name] + normal(world.seed, `env:${name}`, t, 0) * cfg.noise;
    world.chamber.sample[name] = round6(observed);
    const err = Math.abs(observed - world.chamber.targets[name]);
    if (err > cfg.tolerance) {
      settling = true;
      world.chamber.within_tolerance_since[name] = null;
    } else if (world.chamber.within_tolerance_since[name] == null) {
      world.chamber.within_tolerance_since[name] = t;
    }
  }
  world.chamber.sample.sampled_at_sim_s = t;
  world.chamber.sample.quality = settling ? 'settling' : 'ok';
}

/** Whether every channel stayed within tolerance for at least holdS continuously. */
export function environmentStableFor(world: World, holdS: number): boolean {
  const t = world.sim_time_s;
  return CHANNELS.every(({name}) => {
    const since = world.chamber.within_tolerance_since[name];
    return since != null && t - since >= holdS - 1e-9;
  });
}

export const envChannelNames: readonly EnvChannelName[] = CHANNELS.map(c => c.name);
export type EnvTargets = EnvValues;

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Apply new targets (partial). Resets stability tracking; bumps handled by the caller. */
export function setChamberTargets(world: World, targets: Partial<EnvValues>): void {
  for (const name of envChannelNames) {
    if (targets[name] !== undefined) {
      world.chamber.targets[name] = targets[name] as number;
      world.chamber.within_tolerance_since[name] = null;
    }
  }
  // Re-evaluate the current sample against the new targets immediately.
  let settling = false;
  for (const {name} of CHANNELS) {
    const cfg = DEMO_PROFILE.environment[name] as {tolerance: number};
    if (Math.abs(world.chamber.sample[name] - world.chamber.targets[name]) > cfg.tolerance) settling = true;
  }
  world.chamber.sample.quality = settling ? 'settling' : 'ok';
}
