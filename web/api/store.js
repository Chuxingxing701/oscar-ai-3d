// Pure client-side state reducer (no DOM, no fetch): applies StateSnapshots
// and DeviceEvents to an in-memory copy of the observable world. The snapshot
// is authoritative — events only smooth the gaps between snapshots; anything
// the reducer cannot parse is left untouched until the next snapshot.
// Live feed, replay reconstruction and unit tests all share this module.

export const SCENE_STAGES = ['moving', 'lowering', 'aspirating', 'dispensing', 'raising', 'scanning',
  'picking_tip', 'dropping_tip'];
const HEAD_HOGGING = new Set(['media.add', 'media.exchange', 'imaging.scan']);
const MAX_EVENTS = 400;
const MAX_ENV_SAMPLES = 720;

export function initialState() {
  return {
    experimentId: null,
    eventSeq: 0,
    experiment: null,
    device: null,
    chamber: null,
    plates: [],
    reservoirs: [],
    wastes: [],
    tips: [],
    busyResources: {},
    actions: new Map(),
    head: null,
    lease: null,
    run: null,
    revisions: {},
    clock: {sim_time_s: 0, paused: false, speed: 1, clock_mode: 'lockstep'},
    observations: new Map(),
    envSamples: [],
    envTargets: [],
    events: [],
    archived: null,
    connection: 'offline',
  };
}

const clone = value => (value && typeof value === 'object' ? structuredClone(value) : value);

function plateIndex(state, plateId) { return state.plates.findIndex(p => p.plate_id === plateId); }

/** Shallow-copy state and the plates slice so reducers never mutate input. */
function touch(state, plates = false) {
  const next = {...state};
  if (plates) next.plates = state.plates.map(p => ({...p, wells: p.wells.slice()}));
  next.actions = state.actions;
  return next;
}

function setWellVolume(plate, wellId, volume) {
  const well = plate.wells.find(w => w.well_id === wellId);
  if (well && Number.isFinite(volume)) well.volume_ul = Math.max(0, Math.round(volume * 1000) / 1000);
}

// --------------------------------------------------------------------------
// Payload helpers. Runtime payload field names are defensive: the snapshot
// stays authoritative for anything an event does not clearly provide.
// --------------------------------------------------------------------------

/** Post-commit per-well volumes from action.effect_committed payloads.
 *  Supports the runtime's `{wells: {A1: 700, …}}` record, array rows
 *  `{wells:[{well_id, volume_ul}]}` and `well_volumes`/`post_volumes` aliases. */
export function postCommitVolumes(payload = {}) {
  const out = [];
  const push = (plateId, wellId, volume) => {
    if (typeof wellId === 'string' && Number.isFinite(Number(volume))) out.push({plate_id: plateId, well_id: wellId, volume_ul: Number(volume)});
  };
  const scan = (rows, plateId) => {
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && typeof row === 'object' && 'volume_ul' in row) push(row.plate_id || plateId, row.well_id, row.volume_ul);
      }
    } else if (rows && typeof rows === 'object') {
      for (const [wellId, volume] of Object.entries(rows)) push(plateId, wellId, volume);
    }
  };
  const defaultPlate = payload.plate_id || payload.effect?.plate_id || null;
  scan(payload.well_volumes, null);
  scan(payload.post_volumes, null);
  scan(payload.volumes, null);
  scan(payload.wells, defaultPlate);
  for (const [k, v] of Object.entries(payload.well_volume_ul || {})) push(payload.plate_id, k, v);
  return out;
}

function stepEffect(payload = {}) {
  return payload.effect && typeof payload.effect === 'object' ? payload.effect : payload;
}

function plateIdOf(payload, action) {
  return payload.plate_id || payload.effect?.plate_id || action?.arguments?.plate_id || action?.scope?.plate_id || null;
}

/** Normalized ChamberReading-ish channels from an environment.sampled payload.
 *  Runtime shape: {sample: {temperature_c: 36.5, …, quality, sampled_at_sim_s},
 *  targets: {temperature_c: 37, …}}; per-channel objects also accepted. */
export function parseEnvSample(payload = {}) {
  const raw = payload.channels || payload.reading || payload.sample || payload;
  const targets = payload.targets || payload.chamber_targets || {};
  const channels = {};
  for (const key of ['temperature_c', 'co2_pct', 'humidity_pct']) {
    const value = raw[key];
    if (value == null) continue;
    if (typeof value === 'number') channels[key] = {observed: value, target: typeof targets[key] === 'number' ? targets[key] : undefined};
    else if (typeof value === 'object') {
      channels[key] = {
        target: value.target ?? (typeof targets[key] === 'number' ? targets[key] : undefined),
        observed: value.observed ?? value.value,
        error: value.error, quality: value.quality ?? payload.quality, sampled_at_sim_s: value.sampled_at_sim_s ?? raw.sampled_at_sim_s,
      };
    }
  }
  return Object.keys(channels).length ? channels : null;
}

export function parseEnvTargets(payload = {}) {
  const raw = payload.chamber_targets || payload.targets || payload;
  const targets = {};
  for (const key of ['temperature_c', 'co2_pct', 'humidity_pct']) {
    const value = raw[key];
    if (typeof value === 'number') targets[key] = value;
    else if (value && typeof value === 'object' && typeof value.target === 'number') targets[key] = value.target;
  }
  return Object.keys(targets).length ? targets : null;
}

// --------------------------------------------------------------------------
// Snapshot application (authoritative)
// --------------------------------------------------------------------------

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export function applySnapshot(state, snapshot) {
  const next = {...state};
  next.experimentId = snapshot.experiment?.experiment_id ?? next.experimentId;
  next.eventSeq = snapshot.event_seq ?? next.eventSeq;
  if (Array.isArray(snapshot.timeline_events)) {
    // History is for display only: reapplying effects would corrupt snapshot
    // inventory. Events newer than the snapshot arrive normally via SSE.
    next.events = clone(snapshot.timeline_events.filter(ev =>
      ev.experiment_id === next.experimentId && ev.seq <= next.eventSeq)).slice(-400);
  }
  next.experiment = clone(snapshot.experiment) ?? null;
  next.device = clone(snapshot.device) ?? null;
  next.chamber = clone(snapshot.chamber) ?? null;
  next.plates = clone(snapshot.plates) ?? [];
  next.reservoirs = clone(snapshot.reservoirs) ?? [];
  next.wastes = clone(snapshot.wastes) ?? [];
  next.tips = clone(snapshot.tips) ?? [];
  next.busyResources = clone(snapshot.busy_resources) ?? {};
  next.head = clone(snapshot.head) ?? null;
  next.lease = clone(snapshot.lease) ?? null;
  next.run = clone(snapshot.run) ?? null;
  next.revisions = clone(snapshot.revisions) ?? {};
  const actions = new Map();
  // `all_actions` (fetched right after the state) is authoritative for actions
  // that finished while no stream was attached; without it a previously seen
  // non-terminal copy would linger. Actives from the snapshot win.
  if (Array.isArray(snapshot.all_actions)) {
    for (const action of snapshot.all_actions) if (action?.action_id) actions.set(action.action_id, clone(action));
  }
  for (const action of snapshot.active_actions || []) {
    if (action?.action_id) actions.set(action.action_id, clone(action));
  }
  if (!Array.isArray(snapshot.all_actions)) {
    // Keep history already seen, but never a stale non-terminal copy the snapshot no longer lists.
    for (const [id, old] of state.actions) {
      if (!actions.has(id) && TERMINAL.has(old?.status)) actions.set(id, old);
    }
  }
  next.actions = actions;
  if (snapshot.experiment) {
    next.clock = {
      sim_time_s: snapshot.experiment.sim_time_s ?? next.clock.sim_time_s,
      paused: Boolean(snapshot.experiment.paused),
      speed: snapshot.experiment.speed ?? next.clock.speed,
      clock_mode: snapshot.experiment.clock_mode ?? next.clock.clock_mode,
    };
  }
  if (next.experiment?.status === 'archived' && snapshot.experiment?.successor_id) {
    next.archived = {successor_id: snapshot.experiment.successor_id};
  }
  return next;
}

/** Non-persisted `clock` SSE frame: latest server-confirmed time. */
export function applyClockFrame(state, frame) {
  if (!frame || (frame.experiment_id && frame.experiment_id !== state.experimentId)) return state;
  const next = {...state, clock: {...state.clock}};
  if (Number.isFinite(frame.sim_time_s)) next.clock.sim_time_s = Math.max(next.clock.sim_time_s, frame.sim_time_s);
  if (typeof frame.paused === 'boolean') next.clock.paused = frame.paused;
  if (Number.isFinite(frame.speed)) next.clock.speed = frame.speed;
  if (frame.clock_mode) next.clock.clock_mode = frame.clock_mode;
  return next;
}

// --------------------------------------------------------------------------
// Device event application
// --------------------------------------------------------------------------

function mergeAction(state, actionId, patch) {
  if (!actionId) return state;
  const actions = new Map(state.actions);
  const base = actions.get(actionId) || {action_id: actionId, status: 'queued', stages: [], effects: [], summary: null};
  actions.set(actionId, {...base, ...patch});
  return {...state, actions};
}

function pushEvent(state, ev) {
  const events = state.events.length >= MAX_EVENTS ? state.events.slice(state.events.length - MAX_EVENTS + 1) : state.events.slice();
  events.push(ev);
  return {...state, events};
}

export function applyEvent(state, ev) {
  if (!ev || typeof ev.seq !== 'number') return state;
  let next = {...state, eventSeq: ev.seq};
  next.clock = {...next.clock};
  if (Number.isFinite(ev.sim_time_s) && ev.sim_time_s >= next.clock.sim_time_s) next.clock.sim_time_s = ev.sim_time_s;

  const p = ev.payload || {};
  switch (ev.type) {
    case 'experiment.created':
      next.experiment = {...(next.experiment || {experiment_id: ev.experiment_id}), ...(p.experiment || p), experiment_id: ev.experiment_id, status: 'active'};
      next.experimentId = ev.experiment_id;
      break;
    case 'experiment.archived':
      next.archived = {successor_id: p.successor_id ?? null};
      if (next.experiment) next.experiment = {...next.experiment, status: 'archived', successor_id: p.successor_id ?? next.experiment.successor_id};
      break;
    case 'action.accepted': {
      const fromPayload = p.action || p;
      const scope = fromPayload.scope || p.scope;
      // The accepted event carries the normalized scope, not the raw
      // arguments; synthesize a minimal arguments view from it so effect
      // handlers and the scene adapter can resolve plate/row/wells.
      const argumentsFromScope = scope ? {
        ...(scope.plate_id != null ? {plate_id: scope.plate_id} : {}),
        ...(scope.row_id != null ? {row_id: scope.row_id} : {}),
        ...(Array.isArray(scope.wells) ? {wells: scope.wells} : {}),
      } : {};
      next = mergeAction(next, ev.action_id, {
        action_id: ev.action_id,
        capability: fromPayload.capability || p.capability,
        arguments: fromPayload.arguments || p.arguments || (Object.keys(argumentsFromScope).length ? argumentsFromScope : {}),
        scope,
        status: fromPayload.status || 'queued',
        principal: fromPayload.principal || null,
        run_id: fromPayload.run_id ?? ev.run_id ?? null,
        basis: fromPayload.basis || 'operator',
        resources: fromPayload.resources || [],
        accept_seq: ev.seq,
        submitted_at_sim_s: fromPayload.submitted_at_sim_s ?? ev.sim_time_s,
        evidence_refs: fromPayload.evidence_refs || [],
      });
      break;
    }
    case 'action.started':
      next = mergeAction(next, ev.action_id, {status: 'running', started_at_sim_s: p.started_at_sim_s ?? ev.sim_time_s});
      break;
    case 'action.stage_changed': {
      const stage = {
        index: p.step_index ?? p.index ?? 0,
        stage: p.stage,
        primitive: p.primitive || '',
        tool: p.tool,
        target: p.target ?? undefined,
        from_target: p.from_target ?? undefined,
        duration_sim_s: p.stage_duration_sim_s ?? 0,
        started_at_sim_s: p.stage_started_at_sim_s ?? null,
      };
      const action = next.actions.get(ev.action_id);
      next = mergeAction(next, ev.action_id, {current_stage_index: stage.index});
      const actions = new Map(next.actions);
      const merged = {...(actions.get(ev.action_id) || {})};
      const stages = Array.isArray(merged.stages) ? merged.stages.slice() : [];
      stages[stage.index] = {...stages[stage.index], ...stage};
      merged.stages = stages;
      actions.set(ev.action_id, merged);
      next = {...next, actions};
      const capability = merged.capability || '';
      if (HEAD_HOGGING.has(capability) || SCENE_STAGES.includes(p.stage)) {
        if (SCENE_STAGES.includes(p.stage)) next.head = {action_id: ev.action_id, stage: stage};
        else if (next.head?.action_id === ev.action_id) next.head = null;
      }
      break;
    }
    case 'action.effect_committed': {
      const effect = stepEffect(p);
      next = mergeAction(next, ev.action_id, {status: 'running'});
      const actions = new Map(next.actions);
      const merged = {...(actions.get(ev.action_id) || {})};
      merged.effects = [...(merged.effects || []), effect];
      actions.set(ev.action_id, merged);
      next = {...next, actions};
      next = touch(next, true);
      for (const {plate_id, well_id, volume_ul} of postCommitVolumes(p)) {
        const plate = next.plates.find(pl => pl.plate_id === plate_id || plate_id == null && pl.plate_id === (p.plate_id || merged.arguments?.plate_id));
        if (plate) setWellVolume(plate, well_id, volume_ul);
      }
      if (Array.isArray(effect.wells)) {
        const action = merged;
        const plate = next.plates.find(pl => pl.plate_id === plateIdOf(p, action));
        if (plate) for (const {well_id, delta_ul} of effect.wells) {
          const well = plate.wells.find(w => w.well_id === well_id);
          if (well && !postCommitVolumes(p).some(v => v.well_id === well_id)) setWellVolume(plate, well_id, well.volume_ul + (delta_ul || 0));
        }
      }
      if (effect.reservoir?.id && Number.isFinite(effect.reservoir.delta_ul)) {
        next.reservoirs = next.reservoirs.map(r => r.id === effect.reservoir.id
          ? {...r, remaining_ul: Math.max(0, r.remaining_ul + effect.reservoir.delta_ul)} : r);
      }
      if (effect.waste?.id && Number.isFinite(effect.waste.delta_ul)) {
        next.wastes = next.wastes.map(w => w.id === effect.waste.id
          ? {...w, used_ul: Math.max(0, w.used_ul + effect.waste.delta_ul)} : w);
      }
      if (effect.tips?.id && Number.isFinite(effect.tips.delta)) {
        next.tips = next.tips.map(t => t.id === effect.tips.id
          ? {...t, remaining: t.remaining + effect.tips.delta} : t);
      }
      // plate.shake_started/stopped carry authoritative motion parameters.
      // The following audit effect has no duration/speed/revision; projecting
      // it again erased those fields and incremented the revision twice.
      break;
    }
    case 'action.succeeded':
    case 'action.failed':
    case 'action.cancelled': {
      const status = ev.type.split('.')[1];
      next = mergeAction(next, ev.action_id, {
        status,
        ended_at_sim_s: p.ended_at_sim_s ?? ev.sim_time_s,
        reason: p.reason ?? p.error?.code ?? null,
        cancel_reason: status === 'cancelled' ? (p.cancel_reason || p.reason || null) : null,
        partial: Boolean(p.partial),
        summary: p.summary || undefined,
        error: p.error || null,
        result: p.result || undefined,
      });
      if (next.head?.action_id === ev.action_id) next.head = null;
      break;
    }
    case 'observation.created': {
      const obs = p.observation || p;
      const lite = {
        observation_id: obs.observation_id || ev.observation_id,
        action_id: obs.action_id || ev.action_id || null,
        plate_id: obs.plate_id || null,
        wells: obs.wells || [],
        mode: obs.mode || 'mono',
        view: obs.view || 'medium_overview',
        sampled_at_sim_s: obs.sampled_at_sim_s ?? ev.sim_time_s,
        plate_revision: obs.plate_revision,
        quality: obs.quality || 'ok',
        images: obs.images || [],
        estimates: obs.estimates || [],
      };
      if (lite.observation_id) {
        const observations = new Map(next.observations);
        observations.set(lite.observation_id, lite);
        next = {...next, observations};
      }
      break;
    }
    case 'environment.targets_set': {
      const targets = parseEnvTargets(p);
      if (targets) {
        next.envTargets = [...next.envTargets, {seq: ev.seq, sim_time_s: ev.sim_time_s, targets}].slice(-MAX_ENV_SAMPLES);
        if (next.chamber) {
          next.chamber = {...next.chamber};
          for (const [key, value] of Object.entries(targets)) {
            next.chamber[key] = {...(next.chamber[key] || {observed: value, error: 0, quality: 'ok', sampled_at_sim_s: ev.sim_time_s}), target: value};
          }
          next.chamber.target_revision = (next.chamber.target_revision || 0) + 1;
        }
      }
      break;
    }
    case 'environment.sampled': {
      const channels = parseEnvSample(p);
      if (channels) {
        next.envSamples = [...next.envSamples, {seq: ev.seq, sim_time_s: p.sim_time_s ?? ev.sim_time_s, channels}].slice(-MAX_ENV_SAMPLES);
        if (next.chamber) {
          next.chamber = {...next.chamber};
          for (const [key, value] of Object.entries(channels)) {
            const existing = next.chamber[key] || {};
            next.chamber[key] = {...existing, ...value, target: value.target ?? existing.target};
          }
        }
      }
      break;
    }
    case 'plate.shake_started':
      next = applyShakeFlag(next, p.plate_id, true, p, ev);
      break;
    case 'plate.shake_stopped':
      next = applyShakeFlag(next, p.plate_id, false, p, ev);
      break;
    case 'decision.granted':
      next.lease = p.lease ? clone(p.lease) : {
        lease_id: p.lease_id ?? null, run_id: p.run_id ?? ev.run_id ?? null, state: 'active',
        triggers: Array.isArray(p.triggers) ? p.triggers : [], frozen_at_sim_s: ev.sim_time_s,
      };
      if (p.run_id || ev.run_id) next.run = {...(next.run || {}), run_id: p.run_id || ev.run_id, status: 'active'};
      break;
    case 'lease.released':
    case 'lease.expired':
    case 'lease.revoked':
      if (next.lease) next.lease = {...next.lease, state: ev.type.split('.')[1]};
      if (ev.type !== 'lease.released' && next.run) next.run = {...next.run, status: ev.type === 'lease.expired' ? 'paused' : next.run.status};
      break;
    case 'run.created':
      next.run = clone(p.run || {...(next.run || {}), run_id: ev.run_id, status: 'active', mode: p.mode});
      break;
    case 'run.paused':
      next.run = {...(next.run || {run_id: ev.run_id}), status: 'paused', reason: p.reason || null};
      break;
    case 'run.resumed':
      next.run = {...(next.run || {run_id: ev.run_id}), status: 'active', reason: null};
      break;
    case 'run.on_hold':
      next.run = {...(next.run || {run_id: ev.run_id}), status: 'on_hold'};
      break;
    case 'run.ended':
      next.run = {...(next.run || {run_id: ev.run_id}), status: 'ended', reason: p.reason || null};
      if (next.lease) next.lease = {...next.lease, state: 'revoked'};
      break;
    case 'clock.paused':
      next.clock = {...next.clock, paused: true};
      if (next.experiment) next.experiment = {...next.experiment, paused: true};
      break;
    case 'clock.resumed':
      next.clock = {...next.clock, paused: false};
      if (next.experiment) next.experiment = {...next.experiment, paused: false};
      break;
    case 'clock.speed_changed':
      if (Number.isFinite(p.speed)) {
        next.clock = {...next.clock, speed: p.speed};
        if (next.experiment) next.experiment = {...next.experiment, speed: p.speed};
      }
      break;
    case 'clock.mode_changed':
      if (p.clock_mode) {
        next.clock = {...next.clock, clock_mode: p.clock_mode};
        if (next.experiment) next.experiment = {...next.experiment, clock_mode: p.clock_mode};
      }
      break;
    default:
      break;
  }
  return pushEvent(next, ev);
}

function applyShakeFlag(state, plateId, active, payload, ev) {
  const index = plateId ? plateIndex(state, plateId) : -1;
  if (index < 0) return state;
  const next = touch(state, true);
  const plate = next.plates[index];
  plate.shake = active
    ? {
        active: true,
        started_at_sim_s: payload.started_at_sim_s ?? ev.sim_time_s,
        duration_sim_s: payload.duration_sim_s ?? 0,
        speed_rpm: payload.speed_rpm,
        action_id: payload.action_id ?? ev.action_id ?? null,
      }
    : {active: false, started_at_sim_s: plate.shake?.started_at_sim_s ?? 0, duration_sim_s: plate.shake?.duration_sim_s ?? 0,
       ended_at_sim_s: payload.ended_at_sim_s ?? ev.sim_time_s, action_id: plate.shake?.action_id ?? null};
  if (payload.revision != null) plate.revision = payload.revision;
  else if (plate.revision != null) plate.revision += 1;
  return next;
}

// --------------------------------------------------------------------------
// Replay reconstruction (read-only, archived experiments)
// --------------------------------------------------------------------------

/**
 * Reconstruct the observable world at an arbitrary event seq from the final
 * snapshot plus the full persisted event list. Per-well volumes come from
 * action.effect_committed payloads (post-commit volumes when present, deltas
 * otherwise, with the untouched-well baseline derived from the final snapshot
 * minus the whole-timeline deltas). Stages from action.stage_changed, shake
 * from plate.shake_started/stopped. Returns a snapshot-shaped object usable
 * by the scene adapter and the panels.
 */
export function replayAt(finalSnapshot, events, seq) {
  const upTo = events.filter(e => typeof e.seq === 'number' && e.seq <= seq);

  // Baseline: final volumes minus every delta in the timeline = initial volumes.
  // Effects do not carry plate_id; resolve it from the action's accepted scope.
  const actionScope = new Map(); // action_id -> {plate_id, row_id, wells}
  for (const ev of events) {
    if (ev.type !== 'action.accepted' || !ev.action_id) continue;
    const scope = ev.payload?.scope || ev.payload?.action?.scope || null;
    if (scope?.plate_id) actionScope.set(ev.action_id, scope);
  }
  const plateOfEffect = ev => {
    const p = ev.payload || {};
    return p.plate_id || actionScope.get(ev.action_id)?.plate_id || null;
  };
  const deltas = new Map(); // plateId -> Map(wellId -> total delta over the whole timeline)
  const inventory = {reservoir: new Map(), waste: new Map(), tips: new Map()};
  for (const ev of events) {
    const p = ev.payload || {};
    if (ev.type === 'action.effect_committed') {
      const effect = stepEffect(p);
      const plateId = plateOfEffect(ev);
      for (const w of effect.wells || []) {
        if (!deltas.has(plateId)) deltas.set(plateId, new Map());
        const perWell = deltas.get(plateId);
        perWell.set(w.well_id, (perWell.get(w.well_id) || 0) + (w.delta_ul || 0));
      }
      if (effect.reservoir) inventory.reservoir.set(effect.reservoir.id, (inventory.reservoir.get(effect.reservoir.id) || 0) + effect.reservoir.delta_ul);
      if (effect.waste) inventory.waste.set(effect.waste.id, (inventory.waste.get(effect.waste.id) || 0) + effect.waste.delta_ul);
      if (effect.tips) inventory.tips.set(effect.tips.id, (inventory.tips.get(effect.tips.id) || 0) + effect.tips.delta);
    }
  }

  const plates = (finalSnapshot.plates || []).map(plate => {
    const initial = new Map();
    const total = deltas.get(plate.plate_id);
    for (const well of plate.wells) {
      initial.set(well.well_id, total ? well.volume_ul - (total.get(well.well_id) || 0) : well.volume_ul);
    }
    // Forward walk: post-commit volumes are absolute, deltas are relative.
    const volumes = new Map(initial);
    let shake = {active: false, started_at_sim_s: 0, duration_sim_s: 0};
    for (const ev of upTo) {
      const p = ev.payload || {};
      if (p.plate_id && p.plate_id !== plate.plate_id && ev.type !== 'action.effect_committed') continue;
      if (ev.type === 'action.effect_committed') {
        const eventPlate = plateOfEffect(ev);
        const posts = postCommitVolumes(p).filter(v => v.plate_id === plate.plate_id
          || (v.plate_id == null && eventPlate === plate.plate_id));
        const postsOnWell = new Set(posts.map(v => v.well_id));
        for (const {well_id, volume_ul} of posts) volumes.set(well_id, volume_ul);
        if (eventPlate === plate.plate_id || posts.length) {
          const effect = stepEffect(p);
          for (const w of effect.wells || []) {
            if (!postsOnWell.has(w.well_id)) volumes.set(well_id, (volumes.get(w.well_id) || 0) + (w.delta_ul || 0));
          }
        }
      } else if (ev.type === 'plate.shake_started' && p.plate_id === plate.plate_id) {
        shake = {active: true, started_at_sim_s: p.started_at_sim_s ?? ev.sim_time_s, duration_sim_s: p.duration_sim_s ?? 0, speed_rpm: p.speed_rpm};
      } else if (ev.type === 'plate.shake_stopped' && p.plate_id === plate.plate_id) {
        shake = {...shake, active: false, ended_at_sim_s: p.ended_at_sim_s ?? ev.sim_time_s};
      }
    }
    return {...plate, wells: plate.wells.map(well => {
      const volume = volumes.get(well.well_id);
      return {...well, volume_ul: Math.max(0, Math.round((Number.isFinite(volume) ? volume : well.volume_ul) * 1000) / 1000)};
    }), shake};
  });

  // Head stage: latest stage_changed of an action not terminal at `seq`.
  let head = null;
  let lastStageSeq = -1;
  const terminal = new Map();
  for (const ev of upTo) {
    if (ev.type === 'action.succeeded' || ev.type === 'action.failed' || ev.type === 'action.cancelled') terminal.set(ev.action_id, ev.type.split('.')[1]);
    if (ev.type !== 'action.stage_changed') continue;
    const p = ev.payload || {};
    if (!SCENE_STAGES.includes(p.stage)) continue;
    if (terminal.has(ev.action_id)) continue;
    if (ev.seq >= lastStageSeq) {
      lastStageSeq = ev.seq;
      head = {
        action_id: ev.action_id,
        stage: {
          index: p.step_index ?? p.index ?? 0, stage: p.stage, primitive: p.primitive || '',
          tool: p.tool, target: p.target ?? null, from_target: p.from_target ?? undefined,
          duration_sim_s: p.stage_duration_sim_s ?? 0, started_at_sim_s: p.stage_started_at_sim_s ?? null, committed: false,
        },
      };
    }
  }
  // Snap head window: the stage must still be within its action lifetime.
  if (head) {
    const terminalEvent = upTo.find(e => e.action_id === head.action_id &&
      (e.type === 'action.succeeded' || e.type === 'action.failed' || e.type === 'action.cancelled'));
    if (terminalEvent) head = null;
  }

  // Environment at seq: last sampled/targets events, else snapshot chamber.
  let chamber = clone(finalSnapshot.chamber);
  const samples = [];
  // Pause baseline: before the first transition the flag is the opposite of
  // that transition; with no transitions it is whatever the final snapshot has.
  const firstTransition = events.find(e => e.type === 'clock.paused' || e.type === 'clock.resumed');
  let paused = firstTransition ? firstTransition.type === 'clock.resumed' : Boolean(finalSnapshot.experiment?.paused);
  let simTime = finalSnapshot.experiment?.sim_time_s ?? 0;
  for (const ev of upTo) {
    simTime = ev.sim_time_s ?? simTime;
    const p = ev.payload || {};
    if (ev.type === 'clock.paused') paused = true;
    if (ev.type === 'clock.resumed') paused = false;
    if (ev.type === 'environment.targets_set') {
      const targets = parseEnvTargets(p);
      if (targets && chamber) {
        chamber = {...chamber};
        for (const [key, value] of Object.entries(targets)) {
          chamber[key] = {...(chamber[key] || {observed: value, error: 0, quality: 'ok'}), target: value};
        }
      }
    }
    if (ev.type === 'environment.sampled') {
      const channels = parseEnvSample(p);
      if (channels) {
        samples.push({seq: ev.seq, sim_time_s: p.sim_time_s ?? ev.sim_time_s, channels});
        if (chamber) {
          chamber = {...chamber};
          for (const [key, value] of Object.entries(channels)) {
            chamber[key] = {...(chamber[key] || {target: value.observed}), ...value, target: value.target ?? chamber[key]?.target};
          }
        }
      }
    }
  }

  const reservoirs = (finalSnapshot.reservoirs || []).map(r => {
    const total = inventory.reservoir.get(r.id) || 0;
    let volume = r.remaining_ul - total; // rewind signed committed deltas
    for (const ev of upTo) {
      const effect = ev.type === 'action.effect_committed' ? stepEffect(ev.payload || {}) : null;
      if (effect?.reservoir?.id === r.id) volume += effect.reservoir.delta_ul;
    }
    return {...r, remaining_ul: Math.max(0, Math.round(volume * 1000) / 1000)};
  });
  const wastes = (finalSnapshot.wastes || []).map(w => {
    const total = inventory.waste.get(w.id) || 0;
    let volume = w.used_ul - total; // deltas fill the waste container
    for (const ev of upTo) {
      const effect = ev.type === 'action.effect_committed' ? stepEffect(ev.payload || {}) : null;
      if (effect?.waste?.id === w.id) volume += effect.waste.delta_ul;
    }
    return {...w, used_ul: Math.max(0, Math.round(volume * 1000) / 1000)};
  });
  const tips = (finalSnapshot.tips || []).map(t => {
    const total = inventory.tips.get(t.id) || 0;
    let remaining = t.remaining - total; // initial
    for (const ev of upTo) {
      const effect = ev.type === 'action.effect_committed' ? stepEffect(ev.payload || {}) : null;
      if (effect?.tips?.id === t.id) remaining += effect.tips.delta;
    }
    return {...t, remaining: Math.max(0, remaining)};
  });

  const lastEvent = upTo.length ? upTo[upTo.length - 1] : null;
  return {
    experiment: {...(finalSnapshot.experiment || {}), sim_time_s: simTime, paused},
    event_seq: seq,
    device: finalSnapshot.device || null,
    chamber,
    plates,
    reservoirs, wastes, tips,
    busy_resources: {},
    active_actions: [],
    head,
    lease: null,
    run: null,
    revisions: {},
    replayOnly: true,
    replayObservations: upTo.filter(e => e.type === 'observation.created')
      .map(e => ({observation_id: e.observation_id || (e.payload || {}).observation_id, seq: e.seq})).filter(o => o.observation_id),
    envSamples: samples,
    _simTimeSource: lastEvent ? 'event' : 'snapshot',
  };
}

// --------------------------------------------------------------------------
// Seq plumbing shared with the stream manager
// --------------------------------------------------------------------------

/** Decisision for one incoming persisted event given the last applied seq. */
export function decideSeq(lastSeq, ev) {
  const seq = ev?.seq;
  if (typeof seq !== 'number') return {action: 'drop', reason: 'no-seq'};
  if (seq <= lastSeq) return {action: 'drop', reason: 'duplicate'};
  if (seq > lastSeq + 1) return {action: 'resync', reason: 'gap', gap: seq - lastSeq - 1};
  return {action: 'apply', reason: 'next'};
}
