// The deterministic scripted demo policy (design §3 scenarios, §7.2 loop).
// Pure function of the observed world: it uses ONLY device_estimate values,
// action results and the task profile — never simulator truth, never wall
// time. Reasons are short and cite evidence (observation ids, estimate
// values, scheduled_policy).
import {PLATE_LAYOUTS, isTerminal, rowWellIds, type PlateState} from '@oscar/device-contract';
import type {ObservationRecord, PolicyContext, PolicyDecision, ActionRecord} from './types.ts';
import {POLICY_LIMITS} from './types.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Focus {plate_id: string; row_id: string}

function focusOf(ctx: PolicyContext): Focus {
  const focus = ctx.task.policy_hints.focus as Focus | undefined;
  return focus ?? {plate_id: ctx.run.plates[0] ?? 'plate-01', row_id: 'A'};
}

function plateOf(ctx: PolicyContext, plateId: string): PlateState | undefined {
  return ctx.state.plates.find(p => p.plate_id === plateId);
}

function rowWellsOf(ctx: PolicyContext, focus: Focus): string[] {
  const plate = plateOf(ctx, focus.plate_id);
  const format = plate && plate.format === '96' ? '96' : '24';
  return rowWellIds(PLATE_LAYOUTS[format], focus.row_id);
}

function covers(wells: string[] | undefined, wanted: string[]): boolean {
  return Array.isArray(wells) && wanted.every(w => wells.includes(w));
}

function scansOf(ctx: PolicyContext, focus: Focus, wells: string[]): ActionRecord[] {
  return ctx.actions.filter(a => a.capability === 'imaging.scan'
    && a.arguments.plate_id === focus.plate_id && covers(a.arguments.wells as string[] | undefined, wells));
}

function obsOf(ctx: PolicyContext, focus: Focus, wells: string[]): ObservationRecord[] {
  return ctx.observations.filter(o => o.plate_id === focus.plate_id && covers(o.wells, wells));
}

function usable(obs: ObservationRecord): boolean {
  return obs.quality === 'ok' && obs.estimates.length > 0
    && obs.estimates.every(e => e.liquid_level_ul != null && e.color_index != null && e.turbidity != null);
}

function estimatesByWell(obs: ObservationRecord): Record<string, {level: number; color: number; turbidity: number}> {
  const out: Record<string, {level: number; color: number; turbidity: number}> = {};
  for (const e of obs.estimates) {
    out[e.well_id] = {level: e.liquid_level_ul ?? Number.NaN, color: e.color_index ?? Number.NaN,
      turbidity: e.turbidity ?? Number.NaN};
  }
  return out;
}

function waitOn(actions: ActionRecord[], why: string): PolicyDecision {
  return {kind: 'wait', wake: {on_actions: actions.map(a => a.action_id)}, reason: why, basis: 'scripted'};
}

function scanAction(focus: Focus, wells: string[], mode: 'mono' | 'stereo', reason: string): PolicyDecision {
  return {kind: 'act', capability: 'imaging.scan', arguments: {plate_id: focus.plate_id, wells, mode},
    reason, basis: 'scripted', evidence_refs: []};
}

function finishFailed(summary: string): PolicyDecision {
  return {kind: 'finish', outcome: 'failed', summary, basis: 'scripted'};
}

/** Common guards: budgets, sim-time deadline, submit errors from the loop. */
function commonGuards(ctx: PolicyContext): PolicyDecision | null {
  const mem = ctx.memory;
  if (ctx.run.budget.actions_used >= ctx.run.budget.max_actions) {
    return finishFailed(`action budget exhausted (${ctx.run.budget.actions_used}/${ctx.run.budget.max_actions}) after decision #${ctx.decisionIndex - 1}`);
  }
  if (ctx.state.experiment.sim_time_s > ctx.task.budgets.max_sim_time_s) {
    return finishFailed(`sim time ${ctx.state.experiment.sim_time_s} s exceeds the task budget ${ctx.task.budgets.max_sim_time_s} s`);
  }
  const err = ctx.lastErrors.at(-1);
  if (!err) return null;
  mem.busy_retries = err.code === 'resource_busy' ? mem.busy_retries : 0;
  mem.stale_retries = err.code === 'observation_stale' ? mem.stale_retries : 0;
  switch (err.code) {
    case 'resource_busy': {
      mem.busy_retries += 1;
      if (mem.busy_retries > POLICY_LIMITS.max_busy_retries) {
        return finishFailed(`resource_busy persisted after ${POLICY_LIMITS.max_busy_retries} retries (${err.message})`);
      }
      const busyIds = [...new Set(Object.values(ctx.state.busy_resources))];
      const knownBusy = ctx.actions.filter(a => busyIds.includes(a.action_id));
      if (knownBusy.length > 0) {
        return waitOn(knownBusy,
          `resource_busy on ${err.capability} (retry ${mem.busy_retries}/${POLICY_LIMITS.max_busy_retries}): waiting for ${knownBusy.map(a => a.action_id).join(',')} to finish`);
      }
      return {kind: 'wait', wake: {at_sim_s: ctx.state.experiment.sim_time_s + 60},
        reason: `resource_busy (retry ${mem.busy_retries}/${POLICY_LIMITS.max_busy_retries}) held by ${busyIds.join(',') || 'another principal'}; retry in 60 sim s`,
        basis: 'scripted'};
    }
    case 'observation_stale': {
      mem.stale_retries += 1;
      if (mem.stale_retries > POLICY_LIMITS.max_stale_retries) {
        return finishFailed(`observation_stale persisted after ${POLICY_LIMITS.max_stale_retries} rescans (${err.message})`);
      }
      mem.phase = 'rescan';
      return {kind: 'wait', wake: {at_sim_s: ctx.state.experiment.sim_time_s + 1},
        reason: `observation_stale for ${err.capability}: rescan for fresh evidence (retry ${mem.stale_retries}/${POLICY_LIMITS.max_stale_retries})`,
        basis: 'scripted'};
    }
    default:
      // Semantic rejections (capacity/channel/insufficient/invalid) and everything else
      // is not retried with identical arguments — report and stop.
      return finishFailed(`${err.capability} rejected (${err.code}): ${err.message}`);
  }
}

function blurredGuard(ctx: PolicyContext, obs: ObservationRecord, rescan: () => PolicyDecision): PolicyDecision {
  ctx.memory.blurred_scans += 1;
  if (ctx.memory.blurred_scans > POLICY_LIMITS.max_blurred_scans) {
    return finishFailed(`scan quality still not usable after ${POLICY_LIMITS.max_blurred_scans} attempts (last obs ${obs.observation_id}); refusing to fabricate visual conclusions`);
  }
  return rescan();
}

function cooldownWait(ctx: PolicyContext, key: string): PolicyDecision | null {
  const last = ctx.memory.last_liquid_at[key];
  if (last == null) return null;
  const ready = last + POLICY_LIMITS.liquid_cooldown_s;
  if (ctx.state.experiment.sim_time_s >= ready) return null;
  return {kind: 'wait', wake: {at_sim_s: ready},
    reason: `liquid cooldown for ${key}: last op at ${last} s, next allowed ${ready} s (scheduled_policy)`, basis: 'scripted'};
}

// ---------------------------------------------------------------------------
// routine_maintenance: scan -> add to band midpoint -> rescan -> verify
// ---------------------------------------------------------------------------

function routineDecide(ctx: PolicyContext): PolicyDecision {
  const mem = ctx.memory;
  const focus = focusOf(ctx);
  const wells = rowWellsOf(ctx, focus);
  const hints = ctx.task.policy_hints as {target_band_ul?: [number, number]};
  const band = hints.target_band_ul ?? [600, 900];
  const [lo, hi] = band;
  const mid = (lo + hi) / 2;
  const rowKey = `${focus.plate_id}:${focus.row_id}`;
  const scans = scansOf(ctx, focus, wells);
  const obsList = obsOf(ctx, focus, wells);
  const lastScan = scans.at(-1);
  const lastObs = obsList.at(-1);
  const reservoir = ctx.state.reservoirs[0]?.id ?? 'media-01';

  if (!lastScan) {
    return scanAction(focus, wells, 'mono',
      `scheduled_policy: first scan of focus row ${focus.plate_id} ${focus.row_id} (${wells[0]}–${wells[wells.length - 1]})`);
  }
  if (!isTerminal(lastScan.status)) return waitOn([lastScan], `imaging.scan ${lastScan.action_id} in progress`);
  if (lastScan.status !== 'succeeded') {
    return finishFailed(`imaging.scan ${lastScan.action_id} ended ${lastScan.status}: ${lastScan.error?.message ?? 'no error recorded'}`);
  }
  if (!lastObs) return finishFailed(`scan ${lastScan.action_id} succeeded but no observation covers ${focus.plate_id} ${focus.row_id}`);
  if (!usable(lastObs)) {
    return blurredGuard(ctx, lastObs, () => scanAction(focus, wells, 'mono',
      `obs ${lastObs.observation_id} quality=${lastObs.quality} with null device_estimate values: no visual conclusion drawn; rescanning (attempt ${mem.blurred_scans + 1}/${POLICY_LIMITS.max_blurred_scans})`));
  }
  if (!mem.baseline_observation_id) mem.baseline_observation_id = lastObs.observation_id;

  const adds = ctx.actions.filter(a => a.capability === 'media.add' && a.arguments.plate_id === focus.plate_id
    && a.arguments.row_id === focus.row_id);
  const lastAdd = adds.at(-1);

  if (mem.phase === 'rescan' && adds.length === 0) {
    // observation_stale recovery: force one fresh scan before any liquid op
    mem.phase = 'verify';
    return scanAction(focus, wells, 'mono',
      `rescan for fresh evidence (plate revision/age) after observation_stale; previous evidence obs ${lastObs.observation_id}`);
  }
  const est = estimatesByWell(lastObs);
  const levels = wells.map(w => est[w]?.level ?? Number.NaN);
  const minEst = Math.min(...levels);
  const maxEst = Math.max(...levels);
  const minWell = wells[levels.indexOf(minEst)];

  if (!lastAdd) {
    if (minEst >= lo && maxEst <= hi) {
      return {kind: 'finish', outcome: 'completed', basis: 'scripted',
        summary: `obs ${lastObs.observation_id}: focus row already within band ${lo}–${hi} µL (device_estimate ${minEst.toFixed(1)}–${maxEst.toFixed(1)} µL); no liquid op needed`};
    }
    if (maxEst > hi) {
      return finishFailed(`obs ${lastObs.observation_id} device_estimate max ${maxEst.toFixed(1)} µL is above the band ${lo}–${hi} µL; media.add cannot remove volume`);
    }
    const volume = Math.max(10, Math.min(1000, Math.round(mid - minEst)));
    const cooldown = cooldownWait(ctx, rowKey);
    if (cooldown) return cooldown;
    mem.last_liquid_at[rowKey] = ctx.state.experiment.sim_time_s;
    mem.liquid_evidence_observation_id = lastObs.observation_id;
    return {kind: 'act', capability: 'media.add',
      arguments: {plate_id: focus.plate_id, row_id: focus.row_id, reservoir_id: reservoir, volume_ul_per_well: volume},
      reason: `obs ${lastObs.observation_id} device_estimate liquid_level ${minWell}=${minEst.toFixed(1)} µL < band lower ${lo} µL (scheduled_policy band ${lo}–${hi}): media.add ${volume} µL/well to whole row ${focus.row_id} to reach midpoint ${mid} µL`,
      basis: 'scripted', evidence_refs: [lastObs.observation_id]};
  }

  if (!isTerminal(lastAdd.status)) return waitOn([lastAdd], `media.add ${lastAdd.action_id} in progress`);
  if (lastAdd.status !== 'succeeded') {
    return finishFailed(`media.add ${lastAdd.action_id} ended ${lastAdd.status}${lastAdd.partial ? ' (partial effects committed)' : ''}: ${lastAdd.error?.message ?? 'no error recorded'}`);
  }
  if (lastAdd.ended_at_sim_s != null) {
    mem.last_liquid_at[rowKey] = Math.max(mem.last_liquid_at[rowKey] ?? 0, lastAdd.ended_at_sim_s);
  }

  // verification rescan AFTER the add
  if (lastObs.sampled_at_sim_s <= (lastAdd.ended_at_sim_s ?? 0)) {
    return scanAction(focus, wells, 'mono',
      `media.add ${lastAdd.action_id} committed (+${lastAdd.summary.wells[minWell]?.added_ul ?? '?'} µL in ${minWell}): rescan ${focus.plate_id} ${focus.row_id} to verify band ${lo}–${hi} µL`);
  }
  if (!usable(lastObs)) {
    return blurredGuard(ctx, lastObs, () => scanAction(focus, wells, 'mono',
      `obs ${lastObs.observation_id} quality=${lastObs.quality}: no visual conclusion drawn; rescanning to verify`));
  }
  const verifyLevels = wells.map(w => est[w]?.level ?? Number.NaN);
  const vMin = Math.min(...verifyLevels);
  const vMax = Math.max(...verifyLevels);
  if (vMin >= lo && vMax <= hi) {
    return {kind: 'finish', outcome: 'completed', basis: 'scripted',
      summary: `routine maintenance complete: media.add ${lastAdd.action_id} (${Number(lastAdd.arguments.volume_ul_per_well)} µL/well, evidence obs ${mem.liquid_evidence_observation_id}) verified by obs ${lastObs.observation_id}: device_estimate ${vMin.toFixed(1)}–${vMax.toFixed(1)} µL within band ${lo}–${hi} µL; reservoir ${lastAdd.summary.reservoir_delta_ul} µL, tips ${lastAdd.summary.tips_used}`};
  }
  if (mem.corrections < POLICY_LIMITS.max_corrections && vMin < lo) {
    mem.corrections += 1;
    const volume = Math.max(10, Math.min(1000, Math.round(mid - vMin)));
    const cooldown = cooldownWait(ctx, rowKey);
    if (cooldown) return cooldown;
    mem.last_liquid_at[rowKey] = ctx.state.experiment.sim_time_s;
    return {kind: 'act', capability: 'media.add',
      arguments: {plate_id: focus.plate_id, row_id: focus.row_id, reservoir_id: reservoir, volume_ul_per_well: volume},
      reason: `obs ${lastObs.observation_id} device_estimate min ${vMin.toFixed(1)} µL still below ${lo} µL after ${lastAdd.action_id}: correction add ${volume} µL/well (correction ${mem.corrections}/${POLICY_LIMITS.max_corrections})`,
      basis: 'scripted', evidence_refs: [lastObs.observation_id]};
  }
  return finishFailed(`obs ${lastObs.observation_id}: focus row not within band ${lo}–${hi} µL after add and corrections (device_estimate ${vMin.toFixed(1)}–${vMax.toFixed(1)} µL)`);
}

// ---------------------------------------------------------------------------
// exchange_and_mix: scan -> exchange(fraction) -> shake -> settle -> stereo
// rescan -> compare
// ---------------------------------------------------------------------------

function exchangeDecide(ctx: PolicyContext): PolicyDecision {
  const mem = ctx.memory;
  const focus = focusOf(ctx);
  const wells = rowWellsOf(ctx, focus);
  const hints = ctx.task.policy_hints as {exchange_fraction?: number; shake?: {speed_rpm: number; duration_sim_s: number};
    settle_after_shake_s?: number};
  const fraction = hints.exchange_fraction ?? 0.5;
  const shakeHint = hints.shake ?? {speed_rpm: 300, duration_sim_s: 30};
  const settle = hints.settle_after_shake_s ?? 30;
  const rowKey = `${focus.plate_id}:${focus.row_id}`;
  const scans = scansOf(ctx, focus, wells);
  const obsList = obsOf(ctx, focus, wells);
  const lastScan = scans.at(-1);
  const lastObs = obsList.at(-1);
  const reservoir = ctx.state.reservoirs[0]?.id ?? 'media-01';

  if (!lastScan) {
    return scanAction(focus, wells, 'mono',
      `scheduled_policy: first scan of focus row ${focus.plate_id} ${focus.row_id} for exchange evidence`);
  }
  if (!isTerminal(lastScan.status)) return waitOn([lastScan], `imaging.scan ${lastScan.action_id} in progress`);
  if (lastScan.status !== 'succeeded') {
    return finishFailed(`imaging.scan ${lastScan.action_id} ended ${lastScan.status}: ${lastScan.error?.message ?? 'no error recorded'}`);
  }
  if (!lastObs) return finishFailed(`scan ${lastScan.action_id} succeeded but no observation recorded`);
  if (!usable(lastObs)) {
    return blurredGuard(ctx, lastObs, () => scanAction(focus, wells, 'mono',
      `obs ${lastObs.observation_id} quality=${lastObs.quality} with null device_estimate values: no visual conclusion drawn; rescanning`));
  }
  if (!mem.baseline_observation_id) mem.baseline_observation_id = lastObs.observation_id;
  const est = estimatesByWell(lastObs);

  const exchanges = ctx.actions.filter(a => a.capability === 'media.exchange'
    && a.arguments.plate_id === focus.plate_id && a.arguments.row_id === focus.row_id);
  const lastExchange = exchanges.at(-1);

  if (!lastExchange) {
    if (mem.phase === 'rescan') {
      mem.phase = 'exchange';
      return scanAction(focus, wells, 'mono', `rescan for fresh evidence after observation_stale (previous obs ${lastObs.observation_id})`);
    }
    const colors = wells.map(w => est[w]?.color ?? Number.NaN);
    const minColor = Math.min(...colors);
    const turb = wells.map(w => est[w]?.turbidity ?? Number.NaN);
    const maxTurb = Math.max(...turb);
    const cooldown = cooldownWait(ctx, rowKey);
    if (cooldown) return cooldown;
    mem.last_liquid_at[rowKey] = ctx.state.experiment.sim_time_s;
    mem.liquid_evidence_observation_id = lastObs.observation_id;
    return {kind: 'act', capability: 'media.exchange',
      arguments: {plate_id: focus.plate_id, row_id: focus.row_id, reservoir_id: reservoir, fraction},
      reason: `obs ${lastObs.observation_id} device_estimate color_index min ${minColor.toFixed(3)}, turbidity max ${maxTurb.toFixed(3)} (spent medium): media.exchange fraction ${fraction} of row ${focus.row_id} per policy_hints`,
      basis: 'scripted', evidence_refs: [lastObs.observation_id]};
  }
  if (!isTerminal(lastExchange.status)) return waitOn([lastExchange], `media.exchange ${lastExchange.action_id} in progress`);
  if (lastExchange.status !== 'succeeded') {
    return finishFailed(`media.exchange ${lastExchange.action_id} ended ${lastExchange.status}${lastExchange.partial ? ' (partial effects committed)' : ''}: ${lastExchange.error?.message ?? 'no error recorded'}`);
  }
  if (lastExchange.ended_at_sim_s != null) {
    mem.last_liquid_at[rowKey] = Math.max(mem.last_liquid_at[rowKey] ?? 0, lastExchange.ended_at_sim_s);
  }

  const shakes = ctx.actions.filter(a => a.capability === 'plate.shake' && a.arguments.plate_id === focus.plate_id);
  const lastShake = shakes.at(-1);
  if (!lastShake) {
    return {kind: 'act', capability: 'plate.shake',
      arguments: {plate_id: focus.plate_id, speed_rpm: shakeHint.speed_rpm, duration_sim_s: shakeHint.duration_sim_s},
      reason: `scheduled_policy: shake ${focus.plate_id} at ${shakeHint.speed_rpm} rpm for ${shakeHint.duration_sim_s} s after exchange ${lastExchange.action_id}`,
      basis: 'scripted', evidence_refs: []};
  }
  if (!isTerminal(lastShake.status)) return waitOn([lastShake], `plate.shake ${lastShake.action_id} in progress`);
  if (lastShake.status !== 'succeeded') {
    return finishFailed(`plate.shake ${lastShake.action_id} ended ${lastShake.status}: ${lastShake.error?.message ?? 'no error recorded'}`);
  }

  const settleEnd = (lastShake.ended_at_sim_s ?? 0) + settle;
  const stereoScans = scans.filter(s => s.arguments.mode === 'stereo');
  const lastStereo = stereoScans.at(-1);
  if (!lastStereo) {
    if (ctx.state.experiment.sim_time_s < settleEnd) {
      return {kind: 'wait', wake: {at_sim_s: settleEnd},
        reason: `shake ${lastShake.action_id} stopped; settle window ${settle} s (scheduled_policy) — stereo rescan at ${settleEnd} s`, basis: 'scripted'};
    }
    return scanAction(focus, wells, 'stereo',
      `settle window complete after shake ${lastShake.action_id}: stereo rescan of ${focus.plate_id} ${focus.row_id} for before/after comparison (baseline obs ${mem.baseline_observation_id})`);
  }
  if (!isTerminal(lastStereo.status)) return waitOn([lastStereo], `imaging.scan ${lastStereo.action_id} in progress`);
  if (lastStereo.status !== 'succeeded') {
    return finishFailed(`stereo scan ${lastStereo.action_id} ended ${lastStereo.status}: ${lastStereo.error?.message ?? 'no error recorded'}`);
  }
  const afterObs = obsList.find(o => o.mode === 'stereo' && o.observation_id === String(lastStereo.result?.observation_id ?? ''))
    ?? obsList.at(-1);
  if (!afterObs || !usable(afterObs)) {
    return blurredGuard(ctx, afterObs ?? lastObs, () => scanAction(focus, wells, 'stereo',
      `obs ${afterObs?.observation_id ?? '?'} not usable: no visual conclusion drawn; stereo rescan`));
  }
  const baseline = ctx.observations.find(o => o.observation_id === mem.baseline_observation_id);
  if (!baseline) return finishFailed(`baseline observation ${mem.baseline_observation_id} missing for comparison`);
  const before = estimatesByWell(baseline);
  const after = estimatesByWell(afterObs);
  const colorDelta = wells.reduce((a, w) => a + (after[w]?.color ?? 0) - (before[w]?.color ?? 0), 0) / wells.length;
  const turbDelta = wells.reduce((a, w) => a + (after[w]?.turbidity ?? 0) - (before[w]?.turbidity ?? 0), 0) / wells.length;
  const removed = wells.reduce((a, w) => a + (lastExchange.summary.wells[w]?.removed_ul ?? 0), 0);
  return {kind: 'finish', outcome: 'completed', basis: 'scripted',
    summary: `exchange_and_mix complete: exchange ${lastExchange.action_id} (fraction ${fraction}, removed ${removed.toFixed(1)} µL, evidence obs ${mem.liquid_evidence_observation_id}), shake ${lastShake.action_id}, settle ${settle} s; before obs ${baseline.observation_id} vs after obs ${afterObs.observation_id}: Δcolor ${colorDelta >= 0 ? '+' : ''}${colorDelta.toFixed(3)}, Δturbidity ${turbDelta >= 0 ? '+' : ''}${turbDelta.toFixed(3)} (fresh medium restored)`};
}

// ---------------------------------------------------------------------------
// environment_drift: set_targets -> scan (blurred, no conclusion) ->
// await_stable -> rescan -> verify
// ---------------------------------------------------------------------------

function driftDecide(ctx: PolicyContext): PolicyDecision {
  const mem = ctx.memory;
  const focus = focusOf(ctx);
  const wells = rowWellsOf(ctx, focus);
  const hints = ctx.task.policy_hints as {await_stable_timeout_s?: number};
  const timeout = hints.await_stable_timeout_s ?? 3600;
  const envT = ctx.task.env_targets;
  const chamber = ctx.state.chamber;

  const sets = ctx.actions.filter(a => a.capability === 'environment.set_targets');
  const lastSet = sets.at(-1);
  if (!lastSet) {
    return {kind: 'act', capability: 'environment.set_targets',
      arguments: {chamber_id: chamber.chamber_id, temperature_c: envT.temperature_c, co2_pct: envT.co2_pct,
        humidity_pct: envT.humidity_pct},
      reason: `scheduled_policy: set chamber to task targets ${envT.temperature_c} °C / ${envT.co2_pct} % CO₂ / ${envT.humidity_pct} % RH (observed ${chamber.temperature_c.observed.toFixed(2)} °C / ${chamber.co2_pct.observed.toFixed(2)} % / ${chamber.humidity_pct.observed.toFixed(2)} %)`,
      basis: 'scripted', evidence_refs: []};
  }
  // environment.set_targets is immediate-terminal
  if (lastSet.status !== 'succeeded') {
    return finishFailed(`environment.set_targets ${lastSet.action_id} ended ${lastSet.status}: ${lastSet.error?.message ?? 'no error recorded'}`);
  }

  const scans = scansOf(ctx, focus, wells);
  const obsList = obsOf(ctx, focus, wells);
  const lastScan = scans.at(-1);
  const lastObs = obsList.at(-1);

  if (!lastScan) {
    return scanAction(focus, wells, 'mono',
      `after set_targets ${lastSet.action_id} (immediate): scan focus row ${focus.plate_id} ${focus.row_id} while environment settles`);
  }
  if (!isTerminal(lastScan.status)) return waitOn([lastScan], `imaging.scan ${lastScan.action_id} in progress`);
  if (lastScan.status !== 'succeeded') {
    return finishFailed(`imaging.scan ${lastScan.action_id} ended ${lastScan.status}: ${lastScan.error?.message ?? 'no error recorded'}`);
  }
  if (!lastObs) return finishFailed(`scan ${lastScan.action_id} succeeded but no observation recorded`);

  const awaits = ctx.actions.filter(a => a.capability === 'environment.await_stable');
  const lastAwait = awaits.at(-1);
  if (!lastAwait) {
    let reason: string;
    if (usable(lastObs)) {
      reason = `obs ${lastObs.observation_id} quality=ok recorded (device_estimate available); awaiting environment stability per scheduled_policy before the verification scan`;
    } else {
      reason = `obs ${lastObs.observation_id} quality=${lastObs.quality} (device_estimate values null): no visual conclusion drawn; not fabricating readings — awaiting environment stability before rescanning (scheduled_policy)`;
      mem.blurred_scans += 1;
      if (mem.blurred_scans > POLICY_LIMITS.max_blurred_scans) {
        return finishFailed(`scans stayed unusable for ${mem.blurred_scans} attempts; refusing to fabricate visual conclusions`);
      }
    }
    return {kind: 'act', capability: 'environment.await_stable',
      arguments: {chamber_id: chamber.chamber_id, timeout_sim_s: timeout},
      reason, basis: 'scripted', evidence_refs: []};
  }
  if (!isTerminal(lastAwait.status)) return waitOn([lastAwait], `environment.await_stable ${lastAwait.action_id} in progress`);
  if (lastAwait.status !== 'succeeded') {
    return finishFailed(`environment.await_stable ${lastAwait.action_id} ended ${lastAwait.status}: ${lastAwait.error?.message ?? 'no error recorded'}`);
  }

  // verification scan after stability
  const stableAt = lastAwait.ended_at_sim_s ?? 0;
  const postScan = scans.find(s => (s.submitted_at_sim_s ?? 0) >= stableAt && s.action_id !== lastScan.action_id)
    ?? scans.filter(s => (s.submitted_at_sim_s ?? 0) >= stableAt).at(-1);
  if (!postScan || (postScan.ended_at_sim_s ?? 0) < stableAt) {
    return scanAction(focus, wells, 'mono',
      `environment stable (await_stable ${lastAwait.action_id} succeeded): rescan ${focus.plate_id} ${focus.row_id} for verification`);
  }
  if (!isTerminal(postScan.status)) return waitOn([postScan], `imaging.scan ${postScan.action_id} in progress`);
  if (postScan.status !== 'succeeded') {
    return finishFailed(`verification scan ${postScan.action_id} ended ${postScan.status}: ${postScan.error?.message ?? 'no error recorded'}`);
  }
  const postObs = obsList.find(o => o.observation_id === String(postScan.result?.observation_id ?? '')) ?? obsList.at(-1);
  if (!postObs) return finishFailed(`verification scan ${postScan.action_id} produced no observation`);
  if (!usable(postObs)) {
    return blurredGuard(ctx, postObs, () => scanAction(focus, wells, 'mono',
      `obs ${postObs.observation_id} quality=${postObs.quality}: no visual conclusion drawn; rescanning after stability`));
  }
  const tol = ctx.task.tolerances;
  const within = Math.abs(chamber.temperature_c.observed - envT.temperature_c) <= tol.temperature_c
    && Math.abs(chamber.co2_pct.observed - envT.co2_pct) <= tol.co2_pct
    && Math.abs(chamber.humidity_pct.observed - envT.humidity_pct) <= tol.humidity_pct;
  const chamberStr = `${chamber.temperature_c.observed.toFixed(2)} °C / ${chamber.co2_pct.observed.toFixed(2)} % / ${chamber.humidity_pct.observed.toFixed(2)} %`;
  if (!within) {
    return finishFailed(`chamber observed ${chamberStr} outside task tolerances (±${tol.temperature_c} °C / ±${tol.co2_pct} % / ±${tol.humidity_pct} %) after await_stable ${lastAwait.action_id}`);
  }
  const est = estimatesByWell(postObs);
  const levels = wells.map(w => est[w]?.level ?? Number.NaN);
  return {kind: 'finish', outcome: 'completed', basis: 'scripted',
    summary: `environment_drift complete: set_targets ${lastSet.action_id} → first obs ${lastObs.observation_id} quality=${lastObs.quality} (no visual conclusion drawn while blurred), await_stable ${lastAwait.action_id} succeeded, verification obs ${postObs.observation_id} quality=ok (device_estimate ${Math.min(...levels).toFixed(1)}–${Math.max(...levels).toFixed(1)} µL); chamber ${chamberStr} within tolerance`};
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

/** The scripted policy entry point. Mutates ctx.memory in place (counters, baselines). */
export function scriptedDecide(ctx: PolicyContext): PolicyDecision {
  const guard = commonGuards(ctx);
  if (guard) return guard;
  ctx.memory.focus_row_wells = rowWellsOf(ctx, focusOf(ctx));
  switch (ctx.run.scenario_id) {
    case 'routine_maintenance': return routineDecide(ctx);
    case 'exchange_and_mix': return exchangeDecide(ctx);
    case 'environment_drift': return driftDecide(ctx);
    default:
      return finishFailed(`no scripted policy for scenario ${ctx.run.scenario_id}`);
  }
}

/** Extract a plain decision description for logs/reports (no wall time). */
export function describeDecision(d: PolicyDecision): string {
  if (d.kind === 'act') return `act ${d.capability}`;
  if (d.kind === 'wait') return `wait ${JSON.stringify(d.wake)}`;
  return `finish ${d.outcome}`;
}
