// C1 test 6: mid-action reset (during exchange, shake and scan separately).
// Old actions terminate with experiment_reset + partial effects; the old
// experiment freezes (state/inventory/event_seq); old run tokens die; writes
// to the old experiment get 409; the new world has no lease/run and does not
// auto-advance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeviceError} from '@oscar/device-contract';
import {currentExperimentId, spawnRuntime, waitUntil, type RuntimeHandle} from './helpers.ts';

let h: RuntimeHandle;

test.before(async () => {
  h = await spawnRuntime({scenario: 'exchange_and_mix', seed: 42});
});
test.after(async () => {
  await h.stop();
});

async function resetDuring(submit: {capability: string; arguments: Record<string, unknown>}, steps: number,
    name: string): Promise<void> {
  const exp = await currentExperimentId(h);
  const before = await h.client.state(exp);
  const submitResult = await h.client.submit(exp, submit as never);
  await h.client.control(exp, {step: {steps}});
  const mid = await h.client.action(exp, submitResult.action.action_id);
  assert.ok(mid.status === 'running' || mid.status === 'queued', `${name}: action in flight`);

  const reset = await h.client.control(exp, {reset: {}});
  const newExp = (reset.experiment as {experiment_id: string}).experiment_id;
  assert.notEqual(newExp, exp);

  // Old action cancelled with experiment_reset, effects kept
  const cancelled = await h.client.action(exp, submitResult.action.action_id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancel_reason, 'experiment_reset');
  // partial is true iff LIQUID/INVENTORY effects were committed (shake-only actions stay partial=false)
  assert.equal(cancelled.partial, cancelled.effects.some(e => e.wells?.length || e.reservoir || e.waste || e.tips));

  // New world: fresh scenario state, no lease, no run, lockstep, no auto-advance
  const fresh = await h.client.state(newExp);
  assert.equal(fresh.lease, null);
  assert.equal(fresh.run, null);
  assert.equal(fresh.experiment.clock_mode, 'lockstep');
  assert.equal(fresh.experiment.sim_time_s, 0);
  assert.equal(fresh.active_actions.length, 0);
  assert.equal(fresh.plates.find(p => p.plate_id === 'plate-01')!.wells[0].volume_ul, 810,
    'new world starts from the scenario initial state');
  const simA = fresh.experiment.sim_time_s;
  await new Promise(r => setTimeout(r, 250));
  const simB = (await h.client.state(newExp)).experiment.sim_time_s;
  assert.equal(simB, simA, `${name}: lockstep without a run does not auto-advance`);

  // Old experiment frozen: state, inventory and event_seq do not change while
  // the new world is stepped forward
  const frozen = await h.client.state(exp);
  await h.client.control(newExp, {step: {steps: 25}});
  const frozen2 = await h.client.state(exp);
  assert.equal(frozen2.event_seq, frozen.event_seq, `${name}: old event_seq unchanged`);
  assert.deepEqual(frozen2.plates.flatMap(p => p.wells.map(w => w.volume_ul)),
    frozen.plates.flatMap(p => p.wells.map(w => w.volume_ul)), `${name}: old inventory unchanged`);
  assert.equal(frozen2.experiment.sim_time_s, frozen.experiment.sim_time_s);

  // Writes and reset to the archived experiment -> experiment_archived
  await assert.rejects(() => h.client.submit(exp, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 10}}),
    (e: DeviceError) => e.code === 'experiment_archived');
  await assert.rejects(() => h.client.control(exp, {reset: {}}),
    (e: DeviceError) => e.code === 'experiment_archived');
  // explicit step works on the new world
  const stepped = await h.client.control(newExp, {step: {steps: 3}});
  assert.equal((stepped as {sim_time_s: number}).sim_time_s, 25 + 3);
  void before;
}

test('reset during exchange half-way', async () => {
  await resetDuring({capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', fraction: 0.5}}, 13, 'exchange');
});

test('reset during shake', async () => {
  await resetDuring({capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 400, duration_sim_s: 60}}, 10, 'shake');
});

test('reset during scan', async () => {
  await resetDuring({capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1', 'B2', 'C3'], mode: 'stereo'}}, 5, 'scan');
});

test('reset with a run active: run ended(experiment_reset), token revoked, successor archived event', async () => {
  const exp = await currentExperimentId(h);
  // No agent running: run creation through the gateway returns 503 and rolls
  // the run back — instead simulate an active run via a stub agent below.
  const {startStubAgent} = await import('./helpers.ts');
  const agent = await startStubAgent();
  const h2 = await spawnRuntime({scenario: 'routine_maintenance', seed: 42, args: ['--agent-url', agent.url]});
  try {
    const exp2 = await currentExperimentId(h2);
    const r = await fetch(`${h2.baseUrl}/api/v1/agent/runs`, {
      method: 'POST',
      headers: {authorization: `Bearer ${h2.operatorToken}`, 'content-type': 'application/json'},
      body: JSON.stringify({experiment_id: exp2}),
    });
    assert.equal(r.status, 200);
    await waitUntil(async () => agent.received.length > 0);
    const token = String(agent.received[0].run_token);
    // run holds an active lease; reset archives the experiment and ends the run
    const snap = await h2.client.state(exp2);
    assert.ok(snap.lease && snap.run);
    const reset = await h2.client.control(exp2, {reset: {}});
    const newExp = (reset.experiment as {experiment_id: string}).experiment_id;
    const old = await h2.client.state(exp2);
    assert.equal(old.run?.status, 'ended');
    assert.equal(old.run?.reason, 'experiment_reset');
    assert.equal(old.lease, null, 'lease revoked');
    // token revoked -> 401
    const dead = await fetch(`${h2.baseUrl}/api/v1/experiments/${newExp}/state`, {headers: {authorization: `Bearer ${token}`}});
    assert.equal(dead.status, 401);
    // archived experiment event carries the successor id
    const {events} = await h2.client.events(exp2, 0, 100);
    const archived = events.filter(e => e.type === 'experiment.archived');
    assert.equal(archived.length, 1);
    assert.equal((archived[0].payload as {successor_id?: string}).successor_id, newExp);
    // new experiment has no run and no lease and did not auto-advance
    await new Promise(r2 => setTimeout(r2, 250));
    const fresh = await h2.client.state(newExp);
    assert.equal(fresh.run, null);
    assert.equal(fresh.lease, null);
    assert.equal(fresh.experiment.sim_time_s, 0);
  } finally {
    await h2.stop();
    await agent.close();
  }
  void exp;
});

test('reset with overridden scenario/seed and clock_mode preserved', async () => {
  const exp = await currentExperimentId(h);
  const reset = await h.client.control(exp, {reset: {scenario_id: 'environment_drift', seed: 7, clock_mode: 'realtime'}});
  const info = reset.experiment as {scenario_id: string; seed: number; clock_mode: string; experiment_id: string};
  assert.equal(info.scenario_id, 'environment_drift');
  assert.equal(info.seed, 7);
  assert.equal(info.clock_mode, 'realtime');
  // realtime mode has no leases
  await assert.rejects(() => h.client.request('GET', `/api/v1/experiments/${info.experiment_id}/leases/current`),
    (e: DeviceError) => e.code === 'clock_mode_mismatch');
  // reset back to lockstep for cleanliness
  const back = await h.client.control(info.experiment_id, {reset: {clock_mode: 'lockstep'}});
  assert.equal((back.experiment as {clock_mode: string}).clock_mode, 'lockstep');
});

test('SSE on an archived experiment replays then sends event: archived', async () => {
  const exp = await currentExperimentId(h);
  await h.client.control(exp, {reset: {}});
  const list = await h.client.experiments();
  const old = list.experiments.find(e => e.status === 'archived')!;
  const response = await fetch(`${h.baseUrl}/api/v1/experiments/${old.experiment_id}/events?after_seq=0`,
    {headers: {authorization: `Bearer ${h.operatorToken}`, accept: 'text/event-stream'}});
  assert.equal(response.status, 200);
  assert.ok((response.headers.get('content-type') ?? '').includes('text/event-stream'));
  const reader = response.body!.getReader();
  const {value} = await reader.read();
  const text = new TextDecoder().decode(value);
  // Eventually the archived frame arrives; read until we see it (bounded).
  let all = text;
  for (let i = 0; i < 20 && !all.includes('event: archived'); i++) {
    const next = await reader.read();
    if (next.done) break;
    all += new TextDecoder().decode(next.value);
  }
  assert.match(all, /event: archived/);
  assert.match(all, new RegExp(`successor_id.*${old.successor_id ?? ''}`));
});
