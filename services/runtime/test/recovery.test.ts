// C1 test 7: recovery with REAL processes — response loss (idempotent resend),
// kill -9 mid-exchange followed by restart on the same data dir, and SSE
// reconnect with Last-Event-ID (no gaps, no duplicates).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {DeviceClient, DeviceError} from '@oscar/device-contract';
import {currentExperimentId, spawnRuntime, waitUntil, type RuntimeHandle} from './helpers.ts';

let h: RuntimeHandle;
let exp: string;

test.before(async () => {
  h = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
  exp = await currentExperimentId(h);
});
test.after(async () => {
  await h.stop();
});

test('response loss: resend with the same idempotency key -> same action, one effect', async () => {
  const body = {capability: 'media.add' as const,
    arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 100}};
  const first = await h.client.submit(exp, body, {idempotencyKey: 'lost-1'});
  // "response lost": the client never saw it; query by key first, then resend
  const byKey = await h.client.actionByKey(exp, 'lost-1');
  assert.equal(byKey?.action_id, first.action.action_id);
  const resend = await h.client.submit(exp, body, {idempotencyKey: 'lost-1'});
  assert.equal(resend.status, 200);
  assert.equal(resend.action.action_id, first.action.action_id);
  await h.client.control(exp, {step: {until_idle: true}});
  const snap = await h.client.state(exp);
  const tips = snap.tips.reduce((s, t) => s + t.remaining, 0);
  assert.equal(tips, 96 * 3 - 6, 'exactly one tip pickup');
  const a1 = snap.plates.find(p => p.plate_id === 'plate-01')!.wells[0].volume_ul;
  assert.ok(Math.abs(a1 - 500) < 1, `one add applied (${a1})`);
});

test('kill -9 mid-exchange, restart on the same data dir: failed(runtime_restarted), committed effects kept, no re-execution', async () => {
  const before = await h.client.state(exp);
  const res0 = before.reservoirs[0].remaining_ul;
  const waste0 = before.wastes[0].used_ul;
  const tips0 = before.tips.map(t => t.remaining);

  // submit an exchange and advance into the second half (removal committed,
  // fresh-medium pickup possibly committed, dispense NOT yet)
  const submitted = await h.client.submit(exp, {capability: 'media.exchange',
    arguments: {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01', fraction: 0.5}},
    {idempotencyKey: 'crash-1'});
  await h.client.control(exp, {step: {steps: 22}});
  const mid = await h.client.action(exp, submitted.action.action_id);
  assert.equal(mid.status, 'running');
  const committed = mid.effects.length;
  assert.ok(committed >= 2, 'row_aspirate and waste_dispense committed');

  // SIGKILL and restart on the same data dir with the same port-free choice
  h.child.kill('SIGKILL');
  await new Promise<void>(resolveP => h.child.on('exit', () => resolveP()));

  const restarted = spawn(process.execPath,
    ['services/runtime/src/main.ts', '--port', '0', '--data-dir', h.dataDir],
    {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  restarted.stdout!.on('data', (d: Buffer) => {
    out += d.toString();
  });
  restarted.stderr!.on('data', (d: Buffer) => {
    out += d.toString();
  });
  await new Promise<void>(resolveP => {
    const iv = setInterval(() => {
      if (out.includes('OSCAR_RUNTIME_READY')) {
        clearInterval(iv);
        resolveP();
      }
    }, 25);
    setTimeout(() => { clearInterval(iv); resolveP(); }, 15_000);
  });
  const portLine = out.split('\n').find(l => l.startsWith('OSCAR_RUNTIME_READY'))!;
  const port = (JSON.parse(portLine.slice('OSCAR_RUNTIME_READY '.length)) as {port: number}).port;
  const token = readFileSync(`${h.dataDir}/runtime/operator.token`, 'utf8').trim();
  const client = new DeviceClient({baseUrl: `http://127.0.0.1:${port}`, token, timeoutMs: 15_000});

  try {
   try {
    const list = await client.experiments();
    assert.equal(list.current_id, exp);
    const state = await client.state(exp);
    // experiment paused after restart
    assert.equal(state.experiment.paused, true);
    const action = await client.action(exp, submitted.action.action_id);
    assert.equal(action.status, 'failed');
    assert.equal(action.error?.code, 'runtime_restarted');
    assert.equal(action.effects.length, committed, 'committed effects kept, nothing re-executed');
    // inventory consistent with the committed effects only
    const removed = Object.values(action.summary.wells).reduce((s, w) => s + w.removed_ul, 0);
    const added = Object.values(action.summary.wells).reduce((s, w) => s + w.added_ul, 0);
    const after = await client.state(exp);
    const dWells = after.plates.flatMap(p => p.wells).reduce((s, w, i) =>
      s + (w.volume_ul - before.plates.flatMap(pp => pp.wells)[i].volume_ul), 0);
    const dRes = after.reservoirs[0].remaining_ul - res0;
    const dWaste = after.wastes[0].used_ul - waste0;
    // removed went to waste; added (if any) came from the reservoir — no leaks
    // tolerance covers evaporation during the ~22 sim s between snapshots
    assert.ok(Math.abs(dWells + removed - added) < 2, `wells changed by -removed+added (${dWells}, -${removed}, +${added})`);
    assert.ok(Math.abs(dWaste - removed) < 1e-6, `waste gained exactly the removed liquid (${dWaste} vs ${removed})`);
    assert.ok(Math.abs(dRes + added) < 1e-6, 'reservoir lost exactly the added liquid');
    const tipsUsed = tips0.map((t, i) => t - after.tips[i].remaining).reduce((s, v) => s + v, 0);
    assert.ok(tipsUsed === 6 || tipsUsed === 12);
    assert.equal(after.active_actions.length, 0, 'locks released');
    assert.equal(after.lease, null);
    // resuming works and stepping continues from the frozen sim time
    await client.control(exp, {resume: true});
    const stepped = await client.control(exp, {step: {steps: 2}});
    assert.ok((stepped as {sim_time_s: number}).sim_time_s > after.experiment.sim_time_s);
    // a NEW submission after restart works
    const fresh = await client.submit(exp, {capability: 'plate.shake',
      arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 6}}, {idempotencyKey: 'post-crash'});
    assert.equal(fresh.status, 202);
    await client.control(exp, {step: {until_idle: true}});
    assert.equal((await client.action(exp, fresh.action.action_id)).status, 'succeeded');
   } finally {
    restarted.kill('SIGTERM');
    await new Promise<void>(resolveP => restarted.on('exit', () => resolveP()));
   }
  } finally {
    // The shared runtime was killed above: bring up a fresh one for the rest
    // (even when the verification above threw).
    h = await spawnRuntime({scenario: 'routine_maintenance', seed: 42});
    exp = await currentExperimentId(h);
  }
});

test('SSE reconnect with Last-Event-ID yields no gaps and no duplicates', async () => {
  // produce some events
  const s = await h.client.submit(exp, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 6}}, {idempotencyKey: 'sse-1'});
  await h.client.control(exp, {step: {until_idle: true}});
  void s;
  const {events} = await h.client.events(exp, 0, 1000);
  const cut = events[Math.floor(events.length / 2)].seq;

  // stream from 0, then "reconnect" from the cut
  const controller = new AbortController();
  const collected1: number[] = [];
  const stream1 = h.client.stream(exp, 0, controller.signal);
  const done1 = (async () => {
    for await (const e of stream1) {
      collected1.push(e.seq);
      if (e.seq >= events[events.length - 1].seq) break;
    }
  })();
  await done1;
  controller.abort();

  const collected2: number[] = [];
  const stream2 = h.client.stream(exp, cut, AbortSignal.timeout(5000));
  for await (const e of stream2) {
    collected2.push(e.seq);
    if (e.seq >= events[events.length - 1].seq) break;
  }
  // replay after the cut matches the first pass exactly (no gaps/duplicates)
  const expected2 = collected1.filter(seq => seq > cut);
  assert.deepEqual(collected2, expected2);
  assert.ok(collected2.length > 0);
});

test('run restart recovery: active run paused(runtime_restarted), lease revoked', async () => {
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
    const runId = (agent.received[0] as {run_id: string}).run_id;
    const snap = await h2.client.state(exp2);
    assert.ok(snap.lease && snap.run?.status === 'active');

    // SIGKILL + restart
    h2.child.kill('SIGKILL');
    await new Promise<void>(resolveP => h2.child.on('exit', () => resolveP()));
    const restarted = spawn(process.execPath,
      ['services/runtime/src/main.ts', '--port', '0', '--data-dir', h2.dataDir],
      {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    restarted.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
    });
    restarted.stderr!.on('data', (d: Buffer) => {
      out += d.toString();
    });
    await new Promise<void>(resolveP => {
      const iv = setInterval(() => {
        if (out.includes('OSCAR_RUNTIME_READY')) {
          clearInterval(iv);
          resolveP();
        }
      }, 25);
      setTimeout(() => { clearInterval(iv); resolveP(); }, 15_000);
    });
    const port = (JSON.parse(out.split('\n').find(l => l.startsWith('OSCAR_RUNTIME_READY'))!.slice('OSCAR_RUNTIME_READY '.length)) as {port: number}).port;
    const token = readFileSync(`${h2.dataDir}/runtime/operator.token`, 'utf8').trim();
    const client = new DeviceClient({baseUrl: `http://127.0.0.1:${port}`, token, timeoutMs: 15_000});
    try {
      const state = await client.state(exp2);
      assert.equal(state.run?.status, 'paused');
      assert.equal(state.run?.reason, 'runtime_restarted');
      assert.equal(state.lease, null, 'lease revoked on restart');
      assert.equal(state.experiment.paused, true);
      // run can be resumed after restart (new barrier)
      await client.control(exp2, {resume: true});
      const resumed = await client.request('POST', `/api/v1/agent/runs/${runId}/control`, {action: 'resume'});
      assert.equal(resumed.status, 200);
      const after = await client.state(exp2);
      assert.equal(after.run?.status, 'active');
      assert.ok(after.lease, 'resume creates a new barrier');
    } finally {
      restarted.kill('SIGTERM');
      await new Promise<void>(resolveP => restarted.on('exit', () => resolveP()));
    }
  } finally {
    await h2.stop();
    await agent.close();
  }
  void 0;
});

test('resume then simulation_paused rejects new device actions but reads work', async () => {
  // pause via control
  await h.client.control(exp, {pause: true});
  await assert.rejects(() => h.client.submit(exp, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 6}}),
    (e: DeviceError) => e.code === 'simulation_paused');
  const state = await h.client.state(exp);
  assert.ok(state);
  await h.client.control(exp, {resume: true});
});
