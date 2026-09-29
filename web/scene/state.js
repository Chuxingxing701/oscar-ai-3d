// Display projection only: no clock, inventory mutation, networking or completion callbacks.
export const clamp01 = value => Math.max(0, Math.min(1, value));
export const STAGES = ['moving', 'lowering', 'aspirating', 'dispensing', 'raising',
  'scanning', 'picking_tip', 'dropping_tip'];

export function findTarget(map, target) {
  if (!target) return null;
  const id = target.plate_id ?? target.resource_id;
  const station = map.stations.find(s => s.id === id);
  if (!station) throw new Error(`Unknown scene resource: ${id}`);
  const well = target.well_id ? station.wells?.find(w => w.well_id === target.well_id) : null;
  if (target.well_id && !well) throw new Error(`Unknown scene well: ${id}/${target.well_id}`);
  if (target.row_id && target.well_id) throw new Error('Specify row_id or well_id, not both');
  const wells = target.row_id ? station.wells?.filter(w => w.well_id.replace(/\d+$/, '') === target.row_id) : null;
  if (target.row_id && !wells?.length) throw new Error(`Unknown scene row: ${id}/${target.row_id}`);
  const center = wells ? [0, 1, 2].map(i => wells.reduce((sum, w) => sum + w.center_m[i], 0) / wells.length)
    : well?.center_m ?? station.center_m;
  return {station, well, wells, center};
}

// One head owns one complete row. A well selection is never silently expanded
// into an authoritative action: the adapter must submit the explicit row_id.
export function pipetteLayout(map, target) {
  const found = findTarget(map, target);
  const profile = map.motion.row_head;
  if (found?.station.kind === 'plate' && !found.wells) throw new Error('Plate pipetting requires an explicit row_id');
  if (found?.well) throw new Error('Row head cannot target a single well');
  if (found?.wells && found.wells.length !== profile.channels) throw new Error('Row width does not match the pipette head');
  const tips = Array.from({length: profile.channels}, (_, i) => [
    found?.wells ? found.wells[i].center_m[0] - found.center[0] : (i - (profile.channels - 1) / 2) * profile.pitch_m,
    profile.tip_height_m, profile.tip_depth_m,
  ]);
  return {tips, wells: found?.wells ?? [], center: found?.center};
}

export function progress(action, time) {
  const duration = action.stage_duration_sim_s;
  return duration === 0 ? (time >= action.stage_started_at_sim_s ? 1 : 0)
    : clamp01((time - action.stage_started_at_sim_s) / duration);
}

function targetPose(map, target, lowered = false, scanning = false) {
  const found = findTarget(map, target);
  if (!found) return [...map.motion.home_m];
  if (!scanning) pipetteLayout(map, target);
  const offset = scanning ? [.058, 1.325, .083] : [0, map.motion.row_head.tip_height_m, map.motion.row_head.tip_depth_m];
  return [found.center[0] - offset[0], lowered ? -map.motion.lowering_m : 0,
    found.center[2] - offset[2]];
}

export function sampleMotion(map, action, time) {
  if (!action) return {pose: [...map.motion.home_m], effect: null, progress: 0};
  const t = progress(action, time);
  const target = action.target;
  let from, to;
  switch (action.stage) {
    case 'moving':
      from = targetPose(map, action.from_target, false, action.tool === 'camera');
      to = targetPose(map, target, false, action.tool === 'camera');
      break;
    case 'lowering':
      from = targetPose(map, target); to = targetPose(map, target, true); break;
    case 'raising':
      from = targetPose(map, target, true); to = targetPose(map, target); break;
    case 'scanning':
      from = to = targetPose(map, target, false, true); break;
    default:
      from = to = targetPose(map, target, true);
  }
  // An explicit stage-start pose makes reconnect/replay independent of prior frames.
  if (action.from_pose_m) from = action.from_pose_m;
  const eased = t * t * (3 - 2 * t);
  const pose = from.map((v, i) => v + (to[i] - v) * eased);
  // Lateral travel always occurs raised, including malformed/low from_pose input.
  if (action.stage === 'moving') pose[1] = 0;
  const active = time >= action.stage_started_at_sim_s && t < 1;
  return {pose, progress: t,
    effect: active && ['aspirating', 'dispensing', 'scanning'].includes(action.stage) ? action.stage : null};
}

export function sampleShake(shake, time) {
  if (!shake?.active || time < shake.started_at_sim_s ||
      time >= shake.started_at_sim_s + shake.duration_sim_s) return [0, 0, 0];
  const elapsed = time - shake.started_at_sim_s;
  const remaining = shake.duration_sim_s - elapsed;
  const envelope = Math.min(1, elapsed / .3, remaining / .3);
  const angle = elapsed * Math.PI * 2 * Math.min(4, shake.frequency_hz ?? 2);
  const radius = Math.min(.0015, shake.amplitude_m ?? .0012) * envelope;
  return [Math.sin(angle) * radius, 0, (Math.cos(angle) - 1) * radius];
}

function finite(value, name, min = 0) {
  if (!Number.isFinite(value) || value < min) throw new Error(`Invalid ${name}`);
}

export function validateSnapshot(map, state) {
  if (!state || typeof state.experiment_id !== 'string' || !state.experiment_id) throw new Error('experiment_id required');
  finite(state.sim_time_s, 'sim_time_s');
  if (typeof state.paused !== 'boolean') throw new Error('paused must be boolean');
  if (!Array.isArray(state.plates) || !Array.isArray(state.actions)) throw new Error('plates/actions arrays required');
  const ids = new Set();
  for (const plate of state.plates) {
    const {station} = findTarget(map, {plate_id: plate.plate_id});
    if (station.kind !== 'plate' || ids.has(plate.plate_id)) throw new Error('Invalid/duplicate plate');
    ids.add(plate.plate_id);
    if (!Array.isArray(plate.wells)) throw new Error('wells array required');
    const wells = new Set();
    for (const well of plate.wells) {
      findTarget(map, {plate_id: plate.plate_id, well_id: well.well_id});
      if (!well.well_id || wells.has(well.well_id)) throw new Error('Invalid/duplicate well');
      wells.add(well.well_id);
      finite(well.volume_ul, 'volume_ul'); finite(well.capacity_ul, 'capacity_ul');
      if (well.capacity_ul === 0 || well.volume_ul > well.capacity_ul) throw new Error('Volume exceeds capacity');
    }
    if (plate.shake) {
      if (typeof plate.shake.active !== 'boolean') throw new Error('shake.active must be boolean');
      finite(plate.shake.started_at_sim_s, 'shake start'); finite(plate.shake.duration_sim_s, 'shake duration');
      if (plate.shake.frequency_hz !== undefined) finite(plate.shake.frequency_hz, 'shake frequency');
      if (plate.shake.amplitude_m !== undefined) finite(plate.shake.amplitude_m, 'shake amplitude');
    }
  }
  if (state.actions.length > 1) throw new Error('Only one action may own the shared head');
  for (const action of state.actions) {
    if (!STAGES.includes(action.stage)) throw new Error(`Unsupported display stage: ${action.stage}`);
    finite(action.stage_started_at_sim_s, 'stage start'); finite(action.stage_duration_sim_s, 'stage duration');
    // A null target is only meaningful for travel back to the home/park pose.
    if (!action.target && action.stage !== 'moving') throw new Error('Action target required');
    if (action.target) findTarget(map, action.target);
    if (action.from_target) findTarget(map, action.from_target);
    if (action.stage !== 'scanning' && action.tool !== 'camera') {
      if (action.target) pipetteLayout(map, action.target);
      if (action.from_target) pipetteLayout(map, action.from_target);
    }
    if (action.from_pose_m) {
      if (!Array.isArray(action.from_pose_m) || action.from_pose_m.length !== 3) throw new Error('Invalid from_pose_m');
      action.from_pose_m.forEach(v => finite(v, 'from_pose_m', -Infinity));
      if (action.from_pose_m[1] < -map.motion.lowering_m || action.from_pose_m[1] > 0) throw new Error('Unsafe lowering');
    }
  }
  return state;
}
