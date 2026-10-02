// C1 test 5: decision barriers over the gateway flow with a stub Agent.
// Uses a REAL Runtime child process; the Agent is a tiny in-test HTTP double
// (only accepts POST /runs — the Agent itself is C3).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeviceClient, DeviceError} from '@oscar/device-contract';
import {currentExperimentId, spawnRuntime, startStubAgent, waitUntil, type RuntimeHandle} from './helpers.ts';

let h: RuntimeHandle;
let agent: Awaited<ReturnType<typeof startStubAgent>>;
let exp: string;
let runToken: string;
let runId: string;

test.before(async () => {
  agent = await startStubAgent();
  h = await spawnRuntime({scenario: 'routine_maintenance', seed: 42,
    args: ['--agent-url', agent.url], env: {OSCAR_LEASE_TTL_MS: '4000', OSCAR_LEASE_MAX_HOLD_MS: '12000'}});
  exp = await currentExperimentId(h);
  await h.client.control(exp, {speed: 2000}); // lockstep pacing while a run is active
});
test.after(async () => {
  await h.stop();
  await agent.close();
});

test('run created via gateway: Runtime tx first (run + token + first lease), then forwarded', async () => {
  const r = await fetch(`${h.baseUrl}/api/v1/agent/runs`, {
    method: 'POST',
    headers: {authorization: `Bearer ${h.operatorToken}`, 'content-type': 'application/json', 'idempotency-key': 'run-1'},
    body: JSON.stringify({experiment_id: exp, mode: 'scripted', goal: 'test barrier protocol'}),
  });
  assert.equal(r.status, 200);
  const body = await r.json() as {run: {run_id: string}; lease: {lease_id: number; state: string; triggers: Array<{kind: string}>} | null};
  runId = body.run.run_id;
  assert.ok(body.lease, 'lockstep creates the first lease in the same transaction');
  assert.equal(body.lease.state, 'active');
  assert.equal(body.lease.triggers[0]?.kind, 'run_started');

  // The Agent double received the forward with the run token + service token
  await waitUntil(async () => agent.received.length > 0);
  const forwarded = agent.received[0];
  assert.equal(forwarded.run_id, runId);
  assert.equal(forwarded.experiment_id, exp);
  assert.ok(String(forwarded.run_token).startsWith('rt_'));
  runToken = String(forwarded.run_token);
  assert.ok(forwarded.lease);

  // run.created + decision.granted share the creation transaction; nothing between them at the end
  const {events} = await h.client.events(exp, 0, 100);
  const runCreated = events.findIndex(e => e.type === 'run.created');
  const granted = events.findIndex(e => e.type === 'decision.granted');
  assert.ok(runCreated >= 0 && granted > runCreated);
  for (let i = runCreated + 1; i < granted; i++) {
    assert.equal(events[i].type === 'run.created', true, 'no foreign events between run.created and decision.granted');
  }

  // one active run per experiment
  const dup = await fetch(`${h.baseUrl}/api/v1/agent/runs`, {
    method: 'POST',
    headers: {authorization: `Bearer ${h.operatorToken}`, 'content-type': 'application/json'},
    body: JSON.stringify({experiment_id: exp}),
  });
  assert.equal(dup.status, 409);
  assert.equal(((await dup.json()) as {code: string}).code, 'run_already_active');
});

test('run token scope: reads OK, control/reset/create forbidden, budget enforced', async () => {
  const rc = new DeviceClient({baseUrl: h.baseUrl, token: runToken, timeoutMs: 10_000});
  const state = await rc.state(exp);
  assert.equal(state.run?.run_id, runId);
  await assert.rejects(() => rc.control(exp, {pause: true}), (e: DeviceError) => e.code === 'forbidden');
  await assert.rejects(() => rc.request('POST', '/api/v1/experiments', {scenario_id: 'environment_drift'}),
    (e: DeviceError) => e.code === 'forbidden');
  await assert.rejects(() => rc.request('POST', '/api/v1/agent/runs', {}),
    (e: DeviceError) => e.code === 'forbidden');
});

test('under an active lease: set_targets immediate, scan queued, no second decision.granted', async () => {
  const rc = new DeviceClient({baseUrl: h.baseUrl, token: runToken, timeoutMs: 10_000});
  const leaseBefore = await rc.currentLease(exp);
  assert.ok(leaseBefore);
  const leaseId = leaseBefore.lease_id;

  const setT = await rc.submit(exp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 37, co2_pct: 5, humidity_pct: 95}},
    {idempotencyKey: 'run-set-1', leaseId});
  assert.equal(setT.status, 202);
  assert.equal(setT.action.status, 'succeeded', 'immediate terminal in the accepting response');

  // lease unchanged, no new decision.granted, trigger appended
  const leaseAfter = await rc.currentLease(exp);
  assert.equal(leaseAfter?.lease_id, leaseId, 'lease_id unchanged');
  assert.ok(leaseAfter!.triggers.some(t => t.kind === 'appended' && t.action_id === setT.action.action_id),
    'appended trigger');
  const {events} = await h.client.events(exp, 0, 500);
  const grants = events.filter(e => e.type === 'decision.granted');
  assert.equal(grants.length, 1, 'no second decision.granted for immediate terminals');

  // submit a scan under the same lease: stays queued while the lease is held
  const scan = await rc.submit(exp, {capability: 'imaging.scan',
    arguments: {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'}},
    {idempotencyKey: 'run-scan-1', leaseId});
  assert.equal(scan.status, 202);
  assert.equal(scan.action.status, 'queued');
  // clock frozen while the lease is active
  const sim1 = (await rc.state(exp)).experiment.sim_time_s;
  await new Promise(r => setTimeout(r, 300));
  const sim2 = (await rc.state(exp)).experiment.sim_time_s;
  assert.equal(sim2, sim1, 'no clock progress under an active lease');

  // run liquid action needs evidence and a lease
  await assert.rejects(() => rc.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10}}),
    (e: DeviceError) => e.code === 'lease_required');
  await assert.rejects(() => rc.submit(exp, {capability: 'media.add',
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10}},
    {leaseId}), (e: DeviceError) => e.code === 'observation_stale');
});

test('release(on_actions=[scan]) lets the clock advance; terminal and next barrier share sim_time', async () => {
  const rc = new DeviceClient({baseUrl: h.baseUrl, token: runToken, timeoutMs: 10_000});
  const leaseBefore = await rc.currentLease(exp);
  const leaseId = leaseBefore!.lease_id;
  const simAtRelease = (await rc.state(exp)).experiment.sim_time_s;

  const scanActionId = (await rc.actionByKey(exp, 'run-scan-1'))!.action_id;
  const release = await rc.releaseLease(exp, leaseId, {on_actions: [scanActionId]});
  assert.equal(release.lease.state, 'released');
  assert.equal(release.next_lease, null, 'scan not terminal yet: no immediate handoff');

  // clock now advances (lockstep, run active, no lease) and the scan finishes
  await waitUntil(async () => (await rc.action(exp, scanActionId)).status === 'succeeded', 20_000);
  // ...at which point a new barrier exists
  await waitUntil(async () => (await rc.currentLease(exp)) != null, 20_000);
  const next = await rc.currentLease(exp);
  assert.ok(next);
  assert.equal(next.state, 'active');
  assert.ok(next.triggers.some(t => t.kind === 'action_terminal' && t.action_id === scanActionId));

  // the terminal event and decision.granted share sim_time with NOTHING between
  const {events} = await h.client.events(exp, 0, 1000);
  const terminalIdx = events.findIndex(e => e.type === 'action.succeeded' && e.action_id === scanActionId);
  const grantedIdx = events.findIndex(e => e.type === 'decision.granted' && e.seq > (next?.event_seq ?? 0) - 1
    && (e.payload as {lease_id?: number}).lease_id === next.lease_id);
  assert.ok(terminalIdx >= 0 && grantedIdx === terminalIdx + 1,
    `terminal at ${terminalIdx}, granted at ${grantedIdx} — must be adjacent`);
  assert.equal(events[terminalIdx].sim_time_s, events[grantedIdx].sim_time_s, 'same sim_time');
  assert.ok(events[terminalIdx].sim_time_s > simAtRelease, 'clock advanced after release');
});

test('release(on_actions=[already terminal]) returns next_lease immediately with no clock progress', async () => {
  const rc = new DeviceClient({baseUrl: h.baseUrl, token: runToken, timeoutMs: 10_000});
  const current = await rc.currentLease(exp);
  const leaseId = current!.lease_id;
  const setTargetsId = (await rc.actionByKey(exp, 'run-set-1'))!.action_id;
  const simBefore = (await rc.state(exp)).experiment.sim_time_s;

  // Immediate terminal under the CURRENT lease, then release on it
  const setT2 = await rc.submit(exp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 36.9}}, {idempotencyKey: 'run-set-2', leaseId});
  assert.equal(setT2.action.status, 'succeeded');
  const release = await rc.releaseLease(exp, leaseId, {on_actions: [setT2.action.action_id]});
  assert.equal(release.lease.state, 'released');
  assert.ok(release.next_lease, 'immediate handoff in the same transaction');
  assert.notEqual(release.next_lease!.lease_id, leaseId);
  assert.ok(release.next_lease!.triggers.some(t => t.action_id === setT2.action.action_id));
  const simAfter = (await rc.state(exp)).experiment.sim_time_s;
  assert.equal(simAfter, simBefore, 'no clock progress during immediate handoff');

  // repeating the SAME release body returns the original response
  const repeat = await rc.releaseLease(exp, leaseId, {on_actions: [setT2.action.action_id]});
  assert.deepEqual(repeat, release);
  // a DIFFERENT body for a released lease -> lease_not_active
  await assert.rejects(() => rc.releaseLease(exp, leaseId, {at_sim_s: simBefore + 100}),
    (e: DeviceError) => e.code === 'lease_not_active');

  // the old lease can no longer write
  await assert.rejects(() => rc.submit(exp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 36.8}}, {idempotencyKey: 'run-set-3', leaseId}),
    (e: DeviceError) => e.code === 'lease_not_active');
  // missing lease header -> lease_required
  await assert.rejects(() => rc.submit(exp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 36.8}}, {idempotencyKey: 'run-set-4'}),
    (e: DeviceError) => e.code === 'lease_required');
  // unknown lease -> lease_not_active
  await assert.rejects(() => rc.submit(exp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 36.8}}, {idempotencyKey: 'run-set-5', leaseId: 99999}),
    (e: DeviceError) => e.code === 'lease_not_active');
});

test('lease timeout: expired, run paused(lease_timeout), determinism_broken', async () => {
  const rc = new DeviceClient({baseUrl: h.baseUrl, token: runToken, timeoutMs: 10_000});
  const current = await rc.currentLease(exp);
  const leaseId = current!.lease_id;
  // TTL is 4 s: wait without renewing
  await waitUntil(async () => {
    const l = await rc.currentLease(exp);
    return l == null || l.state !== 'active';
  }, 15_000, 100);
  void 0;
  const lease = await h.client.request<{lease: {state: string} | null}>('GET', `/api/v1/experiments/${exp}/leases/current`);
  assert.notEqual(lease.body.lease?.state ?? 'none', 'active');
  const state = await rc.state(exp);
  assert.equal(state.run?.status, 'paused');
  assert.equal(state.run?.reason, 'lease_timeout');
  assert.equal(state.run?.determinism_broken, true);
  assert.equal(state.experiment.determinism_broken, true);
  // writing with the expired lease is rejected
  await assert.rejects(() => rc.submit(exp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 37}}, {idempotencyKey: 'run-set-6', leaseId}),
    (e: DeviceError) => e.code === 'lease_not_active');
  void leaseId;
});

test('operator device writes during an active run require hold; run writes while on_hold are 403', async () => {
  // operator device write while the run is active -> hold_required
  await assert.rejects(() => h.client.submit(exp, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 10}}),
    (e: DeviceError) => e.code === 'hold_required');
  // set hold: run -> on_hold, lease revoked
  const held = await h.client.control(exp, {hold: {run_id: runId, on: true}});
  assert.equal(((held as {run: {status: string}}).run).status, 'on_hold');
  const rc0 = new DeviceClient({baseUrl: h.baseUrl, token: runToken, timeoutMs: 10_000});
  assert.equal((await rc0.state(exp)).lease, null);
  // run write while on hold -> run_on_hold (even with a lease header)
  await assert.rejects(() => rc0.submit(exp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 37}}, {idempotencyKey: 'held-1', leaseId: 1}),
    (e: DeviceError) => e.code === 'run_on_hold');
  // operator may now write manually
  const manual = await h.client.submit(exp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 37}});
  assert.equal(manual.action.status, 'succeeded');
  // release hold: run active again with a fresh barrier
  const off = await h.client.control(exp, {hold: {run_id: runId, on: false}});
  assert.equal(((off as {run: {status: string}}).run).status, 'active');
  const lease = await rc0.currentLease(exp);
  assert.ok(lease && lease.state === 'active', 'new barrier after hold release');
});

test('agent-status self-pause, resume creates a new barrier; other run lease is 403', async () => {
  const rc = new DeviceClient({baseUrl: h.baseUrl, token: runToken, timeoutMs: 10_000});
  const status = await rc.request('POST', `/api/v1/runs/${runId}/agent-status`, {status: 'paused', reason: 'agent_restarted'});
  assert.equal(status.status, 200);
  const state = await rc.state(exp);
  assert.equal(state.run?.status, 'paused');
  assert.equal(state.run?.reason, 'agent_restarted');

  // resume via gateway control: run active again with a NEW barrier
  const resume = await h.client.request('POST', `/api/v1/agent/runs/${runId}/control`, {action: 'resume'});
  assert.equal(resume.status, 200);
  const newLease = await rc.currentLease(exp);
  assert.ok(newLease && newLease.state === 'active');
  assert.ok(newLease.triggers.some(t => t.kind === 'run_resumed'));

  // another run's lease is forbidden: reset creates a fresh world + second run
  const resetResult = await h.client.control(exp, {reset: {}});
  const newExp = (resetResult.experiment as {experiment_id: string}).experiment_id;
  assert.notEqual(newExp, exp);
  // old run token is dead: reset revoked it (401), and even the operator
  // cannot write to the archived experiment anymore
  await assert.rejects(() => rc.state(exp), (e: DeviceError) => e.code === 'unauthenticated');

  // create a second run in the new experiment, then try to use ITS lease
  // while authenticating as... it must be usable only by its own run.
  const r2 = await fetch(`${h.baseUrl}/api/v1/agent/runs`, {
    method: 'POST',
    headers: {authorization: `Bearer ${h.operatorToken}`, 'content-type': 'application/json'},
    body: JSON.stringify({experiment_id: newExp}),
  });
  assert.equal(r2.status, 200);
  const body2 = await r2.json() as {run: {run_id: string}};
  const run2Id = body2.run.run_id;
  await waitUntil(async () => {
    const last = agent.received.at(-1);
    return last != null && typeof last.run_token === 'string' && String(last.run_id) === run2Id;
  });
  const token2 = String(agent.received.at(-1)!.run_token);
  const rc2 = new DeviceClient({baseUrl: h.baseUrl, token: token2, timeoutMs: 10_000});
  const lease2 = await rc2.currentLease(newExp);
  assert.ok(lease2);

  // the FIRST run's (now revoked) lease id used by run 2 -> belongs to another run -> 403
  await assert.rejects(() => rc2.submit(newExp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 37}},
    {idempotencyKey: 'run2-1', leaseId: lease2.lease_id === 1 ? 2 : 1}),
    (e: DeviceError) => e.code === 'lease_forbidden');
  // and its own lease works, then a liquid action without evidence is stale
  const okSet = await rc2.submit(newExp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 37}}, {idempotencyKey: 'run2-2', leaseId: lease2.lease_id});
  assert.equal(okSet.action.status, 'succeeded');
  // cancel the run cleanly (this also revokes the run token)
  const cancel = await h.client.request('POST', `/api/v1/agent/runs/${run2Id}/control`, {action: 'cancel'});
  assert.equal(cancel.status, 200);
  const final = await h.client.state(newExp);
  assert.equal(final.run?.status, 'ended');
  await assert.rejects(() => rc2.state(newExp), (e: DeviceError) => e.code === 'unauthenticated');
});

test('run budget: max_actions exhausts with 403 budget_exhausted', async () => {
  const list = await h.client.experiments();
  const current = list.current_id!;
  // fresh world for a clean run
  const reset = await h.client.control(current, {reset: {}});
  const newExp = (reset.experiment as {experiment_id: string}).experiment_id;
  const r = await fetch(`${h.baseUrl}/api/v1/agent/runs`, {
    method: 'POST',
    headers: {authorization: `Bearer ${h.operatorToken}`, 'content-type': 'application/json'},
    body: JSON.stringify({experiment_id: newExp, budget: {max_actions: 1}}),
  });
  assert.equal(r.status, 200);
  await waitUntil(async () => {
    const last = agent.received.at(-1);
    return last != null && typeof last.run_token === 'string' && String(last.run_id).includes(newExp.replace('exp-', ''));
  }, 10_000);
  const token = String(agent.received.at(-1)!.run_token);
  const rc = new DeviceClient({baseUrl: h.baseUrl, token, timeoutMs: 10_000});
  const lease = await rc.currentLease(newExp);
  const first = await rc.submit(newExp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 37}}, {idempotencyKey: 'budget-1', leaseId: lease!.lease_id});
  assert.equal(first.action.status, 'succeeded');
  await assert.rejects(() => rc.submit(newExp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', co2_pct: 5}}, {idempotencyKey: 'budget-2', leaseId: lease!.lease_id}),
    (e: DeviceError) => e.code === 'budget_exhausted');
  // idempotent replay of the accepted action still returns it (no budget double-count)
  const replay = await rc.submit(newExp, {capability: 'environment.set_targets',
    arguments: {chamber_id: 'chamber-01', temperature_c: 37}}, {idempotencyKey: 'budget-1', leaseId: lease!.lease_id});
  assert.equal(replay.status, 200);
});

test('agent unavailable at run creation: rollback (run ended, lease revoked) and 503', async () => {
  // second runtime whose agent URL points at a dead port
  const hDead = await spawnRuntime({scenario: 'routine_maintenance', seed: 42,
    args: ['--agent-url', 'http://127.0.0.1:9']});
  try {
    const expDead = await currentExperimentId(hDead);
    const r = await fetch(`${hDead.baseUrl}/api/v1/agent/runs`, {
      method: 'POST',
      headers: {authorization: `Bearer ${hDead.operatorToken}`, 'content-type': 'application/json'},
      body: JSON.stringify({experiment_id: expDead}),
    });
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as {code: string}).code, 'agent_unavailable');
    // the run was rolled back: record exists but is ended, lease revoked
    const state = await hDead.client.state(expDead);
    assert.equal(state.run?.status, 'ended');
    assert.equal(state.run?.reason, 'agent_unavailable');
    assert.equal(state.lease, null, 'lease revoked');
    const events = await hDead.client.events(expDead, 0, 100);
    const ended = events.events.filter(e => e.type === 'run.ended');
    assert.equal(ended.length, 1);
    assert.equal((ended[0].payload as {reason?: string}).reason, 'agent_unavailable');
    // barrier events: granted then revoked
    assert.ok(events.events.some(e => e.type === 'decision.granted'));
    assert.ok(events.events.some(e => e.type === 'lease.revoked'));
  } finally {
    await hDead.stop();
  }
});
