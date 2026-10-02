// C1 test 4: determinism core — two fresh runtimes, same scenario/seed and
// command script driven by synchronous step control produce identical
// normalized action sequences, events (minus wall fields), well volumes and
// image hashes. Also verifies speed does not change results (lockstep).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Action, DeviceEvent} from '@oscar/device-contract';
import {currentExperimentId, spawnRuntime, type RuntimeHandle} from './helpers.ts';

interface Normalized {
  actions: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  wells: number[];
  reservoir: number;
  waste: number;
  tips: number[];
  hashes: string[];
  simTime: number;
}

async function runScript(h: RuntimeHandle, opts: {fast: boolean}): Promise<Normalized> {
  const exp = await currentExperimentId(h);
  const submit = (body: Parameters<typeof h.client.submit>[1], key?: string, leaseId?: number | null) =>
    h.client.submit(exp, body, {idempotencyKey: key, leaseId: leaseId ?? null});

  const scan1 = await submit({capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'stereo'}}, 's1');
  await h.client.control(exp, {step: {until_idle: true}});
  const obs1 = (await h.client.action(exp, scan1.action.action_id)).result!.observation_id as string;

  const add = await submit({capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 260},
    evidence_refs: [obs1]}, 'add-1');
  await h.client.control(exp, {step: {until_idle: true}});

  const exch = await submit({capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.4}}, 'ex-1');
  // fast variant advances in one go; slow variant steps in small chunks with
  // random-ish wall delays between them (lockstep: wall time must not matter)
  if (opts.fast) {
    await h.client.control(exp, {step: {until_idle: true}});
  } else {
    // identical TOTAL sim time, just chopped into small synchronous steps with
    // wall-time delays between them (lockstep: wall time must not matter)
    let guard = 0;
    while ((await h.client.action(exp, exch.action.action_id)).status !== 'succeeded' && guard++ < 300) {
      await h.client.control(exp, {step: {steps: 2}});
      await new Promise(r => setTimeout(r, (guard % 3) + 1));
    }
    await h.client.control(exp, {step: {until_idle: true}});
  }

  const shake = await submit({capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 320, duration_sim_s: 15}}, 'sh-1');
  await h.client.control(exp, {step: {until_idle: true}});
  const scan2 = await submit({capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1', 'B2'], mode: 'mono'}}, 's2');
  await h.client.control(exp, {step: {until_idle: true}});
  void shake;

  // environment response determinism: set targets then wait (env_drift scenario world already stable; use await_stable short)
  const setT = await submit({capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 36.5, co2_pct: 5.5}}, 'env-1');
  assert.equal(setT.action.status, 'succeeded', 'set_targets is immediate');
  await h.client.control(exp, {step: {steps: 90}});

  const snap = await h.client.state(exp);
  const actions = await h.client.actions(exp);
  const events = await h.client.events(exp, 0, 5000);
  const obs2 = await h.client.observation(exp,
    (await h.client.action(exp, scan2.action.action_id)).result!.observation_id as string);

  return {
    actions: actions.actions.map(normalizeAction),
    // clock.stepped is operator pacing telemetry (how many control calls were
    // made), not world causality: excluded from the determinism comparison.
    events: events.events.filter(e => e.type !== 'clock.stepped').map(normalizeEvent),
    wells: snap.plates.flatMap(p => p.wells.map(w => w.volume_ul)),
    reservoir: snap.reservoirs[0].remaining_ul,
    waste: snap.wastes[0].used_ul,
    tips: snap.tips.map(t => t.remaining),
    hashes: obs2.images.map(i => i.sha256),
    simTime: snap.experiment.sim_time_s,
  };
}

function normalizeAction(a: Action): Record<string, unknown> {
  return {
    action_id: a.action_id, capability: a.capability, status: a.status, scope: a.scope,
    resources: a.resources, accept_seq: a.accept_seq, submitted_at_sim_s: a.submitted_at_sim_s,
    started_at_sim_s: a.started_at_sim_s, ended_at_sim_s: a.ended_at_sim_s, partial: a.partial,
    summary: a.summary, effects: a.effects, stages: a.stages, result: a.result,
    arguments: a.arguments,
  };
}

function normalizeEvent(e: DeviceEvent): Record<string, unknown> {
  // `seq` is dropped: operator pacing events (clock.stepped) consume sequence
  // numbers in the chunked variant; array order already encodes causality.
  return {sim_time_s: e.sim_time_s, type: e.type, action_id: e.action_id,
    run_id: e.run_id, observation_id: e.observation_id, payload: e.payload};
}

test('two fresh runtimes with the same seed and command script are bit-identical', async () => {
  const h1 = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  const h2 = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  try {
    // h1: single fast until_idle bursts; h2: tiny chunks with wall delays.
    const r1 = await runScript(h1, {fast: true});
    const r2 = await runScript(h2, {fast: false});
    assert.deepEqual(r2, r1);
    assert.ok(r1.simTime > 150, `script advanced sim time (${r1.simTime})`);
    assert.equal(r1.events.filter(e => e.type === 'decision.granted').length, 0, 'no runs in this test');
  } finally {
    await h1.stop();
    await h2.stop();
  }
});

test('a different seed changes images but not the mechanics', async () => {
  const h1 = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  const h2 = await spawnRuntime({scenario: 'routine_maintenance', seed: 777});
  try {
    const exp1 = await currentExperimentId(h1);
    const exp2 = await currentExperimentId(h2);
    const scan = async (h: RuntimeHandle, exp: string) => {
      const s = await h.client.submit(exp, {capability: 'imaging.scan',
        arguments: {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'}});
      await h.client.control(exp, {step: {until_idle: true}});
      return h.client.observation(exp, (await h.client.action(exp, s.action.action_id)).result!.observation_id as string);
    };
    const o1 = await scan(h1, exp1);
    const o2 = await scan(h2, exp2);
    assert.notEqual(o1.images[0].sha256, o2.images[0].sha256, 'seed affects speckle noise');
    assert.deepEqual(o1.estimates.map(e => e.well_id), o2.estimates.map(e => e.well_id));
    // volume mechanics identical (initial volumes from the scenario, not the seed)
    const s1 = await h1.client.state(exp1);
    const s2 = await h2.client.state(exp2);
    assert.deepEqual(s2.plates.flatMap(p => p.wells.map(w => w.volume_ul)), s1.plates.flatMap(p => p.wells.map(w => w.volume_ul)));
  } finally {
    await h1.stop();
    await h2.stop();
  }
});

test('environment determinism: same targets -> same sampled readings at the same sim times', async () => {
  const h1 = await spawnRuntime({scenario: 'environment_drift', seed: 42});
  const h2 = await spawnRuntime({scenario: 'environment_drift', seed: 42});
  try {
    const exp1 = await currentExperimentId(h1);
    const exp2 = await currentExperimentId(h2);
    for (const [h, exp] of [[h1, exp1], [h2, exp2]] as const) {
      await h.client.submit(exp, {capability: 'environment.set_targets',
        arguments: {chamber_id: 'chamber-01', temperature_c: 37, co2_pct: 5, humidity_pct: 95}});
      await h.client.control(exp, {step: {steps: 200}});
    }
    const c1 = await h1.client.chamber(exp1);
    const c2 = await h2.client.chamber(exp2);
    assert.deepEqual(c2, c1);
    assert.ok(c1.temperature_c.observed > 35.5, `drift scenario warms up (${c1.temperature_c.observed})`);
    assert.equal(c1.provenance, 'synthetic_sensor');
    // events include environment.sampled frames at the sample grid
    const ev = await h1.client.events(exp1, 0, 2000);
    const sampled = ev.events.filter(e => e.type === 'environment.sampled');
    assert.equal(sampled.length, 6, 'samples at 30,60,...,180 s (t=0 sample is created with the world, not an event)');
    const targetsSet = ev.events.filter(e => e.type === 'environment.targets_set');
    assert.equal(targetsSet.length, 1);
    assert.equal((targetsSet[0].payload as {target_revision?: number}).target_revision, 2);
  } finally {
    await h1.stop();
    await h2.stop();
  }
});

test('environment.await_stable succeeds within tolerance after a hold, fails on target change', async () => {
  const h = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  try {
    const exp = await currentExperimentId(h);
    // already stable world: await_stable needs stable_hold_s (60 s) of continuous tolerance
    const wait = await h.client.submit(exp, {capability: 'environment.await_stable',
      arguments: {chamber_id: 'chamber-01', timeout_sim_s: 600}});
    await h.client.control(exp, {step: {until_idle: true}});
    const done = await h.client.action(exp, wait.action.action_id);
    assert.equal(done.status, 'succeeded');
    assert.ok((done.ended_at_sim_s ?? 0) - (done.started_at_sim_s ?? 0) >= 60);

    // Perturb targets first so stability cannot be already satisfied, then
    // change the target DURING the wait -> failed target_changed
    await h.client.submit(exp, {capability: 'environment.set_targets',
      arguments: {chamber_id: 'chamber-01', temperature_c: 33}});
    const wait2 = await h.client.submit(exp, {capability: 'environment.await_stable',
      arguments: {chamber_id: 'chamber-01', timeout_sim_s: 2000}});
    await h.client.control(exp, {step: {steps: 5}});
    await h.client.submit(exp, {capability: 'environment.set_targets',
      arguments: {chamber_id: 'chamber-01', temperature_c: 37}});
    await h.client.control(exp, {step: {until_idle: true}});
    const failed = await h.client.action(exp, wait2.action.action_id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'target_changed');
  } finally {
    await h.stop();
  }
});
