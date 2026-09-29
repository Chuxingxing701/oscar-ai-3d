// Demo device profile (oscar-mhs-demo/0.1). Every number here is an explicit
// DEMONSTRATION parameter. None is a calibrated hardware value; the 6-channel
// head matches the 24-well display plates, not a measured channel count.
export const DEMO_PROFILE = {
  profile_id: 'oscar-mhs-demo/0.1',
  profile_version: '0.1.0',
  sim_step_s: 1,
  note: 'Demonstration parameters. Not calibrated hardware limits, precision or geometry.',
  head: {
    kind: 'row_pipette',
    channels: 6,
    pitch_mm: 21.6,
    channel_max_ul: 1000,
    // Tip pickup geometry between the 96-position rack and the 6-channel head
    // is not confirmed; the pick stage is schematic and inventory is logical.
    tip_pickup: 'schematic_logical_inventory',
    note: 'Display configuration matching one 6-well row of the current 24-well plates.',
  },
  liquid: {
    well_capacity_ul: 2000,
    min_residual_ul: 100,
    min_transfer_ul: 10,
    max_add_ul_per_well: 1000,
    /** Tips consumed per head pickup = head.channels; media.add uses one pickup,
     * media.exchange uses two (removal set, fresh-medium set). */
    tips_per_pickup: 6,
  },
  /** Deterministic stage durations in simulated seconds (multiples of sim_step_s). */
  stage_s: {
    moving: 3,
    lowering: 1,
    raising: 1,
    aspirating: 3,
    dispensing: 3,
    picking_tip: 2,
    dropping_tip: 2,
    scanning_base: 2,
    scanning_per_well: 1,
  },
  environment: {
    temperature_c: {min: 20, max: 40, tolerance: 0.3, tau_s: 180, noise: 0.02},
    co2_pct: {min: 0, max: 10, tolerance: 0.2, tau_s: 240, noise: 0.01},
    humidity_pct: {min: 30, max: 99, tolerance: 3, tau_s: 300, noise: 0.2},
    stable_hold_s: 60,
    sample_interval_s: 30,
    max_await_s: 7200,
  },
  shake: {
    patterns: ['orbital'] as const,
    speed_rpm: {min: 100, max: 1200},
    duration_s: {min: 5, max: 600},
    orbit_mm: 1.5,
    settle_s: 30,
  },
  imaging: {
    max_wells_per_scan: 24,
    image_px: {width: 320, height: 240},
    stereo_baseline_mm: 12,
  },
  observation: {max_age_s: 1800},
  culture: {tick_s: 60, evaporation_ul_per_h: 4},
  wait: {max_wait_s: 14400},
  lease: {ttl_wall_s: 30, max_hold_wall_s: 300},
} as const;

export type DemoProfile = typeof DEMO_PROFILE;

/** Round a duration up to the fixed simulation grid (§5.3). */
export function alignToStep(seconds: number, step: number = DEMO_PROFILE.sim_step_s): number {
  return Math.ceil(seconds / step - 1e-9) * step;
}
