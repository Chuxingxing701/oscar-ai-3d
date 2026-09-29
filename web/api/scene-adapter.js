// Pure projection StateSnapshot (+ latest clock frame) → scene.update()
// display snapshot, per docs/API_CONTRACT.md §10 and docs/SCENE_HANDOFF.md.
//
// Rules enforced here:
// - Liquid stages on plates use the EXPLICIT full row {plate_id, row_id};
//   a single-well input is never passed to the scene as a pipette target.
// - Scanning uses {plate_id, well_id} with tool 'camera'.
// - Stations use {resource_id}; moving with target null = home/park.
// - Only snapshot.head (≤1 stage) goes into actions; concurrent shake lives in
//   plate.shake. 'shaking'/'waiting' are NEVER head stages.
// - Display time is the server-confirmed sim_time_s (snapshot or clock frame),
//   never extrapolated; liquid volumes come only from committed snapshot data,
//   never from animation progress.

import {SCENE_STAGES} from './store.js';
import {rowOfWell} from './ids.js';

// Demo display parameters mirrored from packages/device-contract/src/profile.ts
// (DEMO_PROFILE.shake): the scene clamps frequency to 4 Hz / 1.5 mm anyway.
const SHAKE_MAX_HZ = 4;
const SHAKE_ORBIT_M = 0.0015;

const LIQUID_CAPABILITIES = new Set(['media.add', 'media.exchange']);

/** Normalize one StageTarget for the scene; null means home/park. */
export function normalizeTarget(action, stage) {
  const args = {...(action?.scope || {}) , ...(action?.arguments || {})};
  const raw = stage?.target ?? null;
  if (LIQUID_CAPABILITIES.has(action?.capability)) {
    // Liquid stages on plates: explicit full row. Well targets are expanded
    // defensively — a single well must never be shown as a pipette endpoint.
    if (raw && typeof raw === 'object') {
      if (raw.plate_id && raw.row_id) return {plate_id: raw.plate_id, row_id: raw.row_id};
      if (raw.plate_id && raw.well_id) return {plate_id: raw.plate_id, row_id: rowOfWell(raw.well_id)};
      if (raw.resource_id) return {resource_id: raw.resource_id};
    }
    // Moving without an explicit target is the park move; other stages fall
    // back to the action's declared scope (display-only; effects are Runtime's).
    if (raw === null && stage?.stage === 'moving') return null;
    if (args.plate_id && args.row_id) return {plate_id: args.plate_id, row_id: args.row_id};
    if (args.reservoir_id) return {resource_id: args.reservoir_id};
    if (args.waste_id) return {resource_id: args.waste_id};
    return null;
  }
  if (action?.capability === 'imaging.scan') {
    if (raw && typeof raw === 'object') {
      if (raw.plate_id && raw.well_id) return {plate_id: raw.plate_id, well_id: raw.well_id};
      if (raw.plate_id && raw.row_id) return {plate_id: raw.plate_id, well_id: `${raw.row_id}1`};
      if (raw.resource_id) return {resource_id: raw.resource_id};
    }
    const firstWell = Array.isArray(args.wells) ? args.wells[0] : null;
    if (args.plate_id && firstWell && stage?.stage !== 'moving') return {plate_id: args.plate_id, well_id: firstWell};
    return null;
  }
  if (raw && typeof raw === 'object') {
    if (raw.plate_id && raw.row_id && !raw.well_id) return {plate_id: raw.plate_id, row_id: raw.row_id};
    if (raw.plate_id && raw.well_id) return {plate_id: raw.plate_id, well_id: raw.well_id};
    if (raw.resource_id) return {resource_id: raw.resource_id};
  }
  return raw ?? null;
}

/** True when the stage can own the shared head in the scene. */
export function isSceneStage(stage) { return SCENE_STAGES.includes(stage); }

/**
 * Build the display snapshot for scene.update().
 * @param {object} snapshot StateSnapshot (or replay projection)
 * @param {number} simTimeS server-confirmed display time (snapshot or clock frame)
 */
export function projectDisplay(snapshot, simTimeS = null) {
  const experiment = snapshot?.experiment || {};
  // Freshest server-confirmed value only (snapshot or clock frame); a stale
  // clock frame must not move the display backwards, and nothing here ever
  // extrapolates ahead of what the server committed.
  const snapshotTime = experiment.sim_time_s ?? snapshot?.clock?.sim_time_s ?? 0;
  const time = Number.isFinite(simTimeS) ? Math.max(simTimeS, snapshotTime) : snapshotTime;
  const plates = (snapshot?.plates || []).map(plate => {
    const shake = plate.shake || {active: false, started_at_sim_s: 0, duration_sim_s: 0};
    const displayShake = {
      active: Boolean(shake.active),
      started_at_sim_s: shake.started_at_sim_s ?? 0,
      duration_sim_s: shake.duration_sim_s ?? 0,
    };
    if (shake.speed_rpm != null) displayShake.frequency_hz = Math.min(SHAKE_MAX_HZ, shake.speed_rpm / 60);
    else displayShake.frequency_hz = 2;
    displayShake.amplitude_m = SHAKE_ORBIT_M;
    return {
      plate_id: plate.plate_id,
      wells: (plate.wells || []).map(w => ({well_id: w.well_id, volume_ul: w.volume_ul, capacity_ul: w.capacity_ul})),
      shake: displayShake,
    };
  });

  const actions = [];
  const head = snapshot?.head;
  if (head?.stage && isSceneStage(head.stage.stage)) {
    const action = snapshot?.actions?.get?.(head.action_id) || findActiveAction(snapshot, head.action_id);
    const target = normalizeTarget(action ?? null, head.stage);
    // A non-moving scene stage without a usable target cannot be displayed
    // safely — the scene rejects it — so we drop to home instead.
    if (target || head.stage.stage === 'moving') {
      const from = head.stage.from_target ? normalizeTarget(action ?? null, {target: head.stage.from_target}) : undefined;
      actions.push({
        stage: head.stage.stage,
        target,
        from_target: from ?? undefined,
        tool: head.stage.stage === 'scanning' ? 'camera' : head.stage.tool ?? undefined,
        stage_started_at_sim_s: head.stage.started_at_sim_s ?? time,
        stage_duration_sim_s: head.stage.duration_sim_s ?? 0,
      });
    }
  }

  return {
    experiment_id: experiment.experiment_id ?? snapshot?.experimentId ?? '',
    sim_time_s: time,
    paused: Boolean(snapshot?.clock?.paused ?? experiment.paused),
    plates,
    actions,
  };
}

function findActiveAction(snapshot, actionId) {
  for (const action of snapshot?.active_actions || []) if (action.action_id === actionId) return action;
  return null;
}

/** Stage progress for the action bar: server times only, clamped to [0,1]. */
export function stageProgress(stage, simTimeS) {
  const start = stage?.started_at_sim_s ?? 0;
  const duration = stage?.duration_sim_s ?? 0;
  if (!Number.isFinite(simTimeS)) return 0;
  if (duration <= 0) return simTimeS >= start ? 1 : 0;
  return Math.max(0, Math.min(1, (simTimeS - start) / duration));
}
