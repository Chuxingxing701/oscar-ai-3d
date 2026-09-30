// D0 regressions (formerly reports/review/reproduce.mjs "defect exists"
// assertions): cancel of a head-free action, shake/head wind-down on Runtime
// SIGKILL restart, and reset archive consistency. Real processes + HTTP,
// per-well and inventory reconciliation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {DeviceClient, type StateSnapshot} from '@oscar/device-contract';
import {spawnRuntime, currentExperimentId, opFetch, waitUntil, wellsOf, type RuntimeHandle} from './helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ADD = {capability: 'media.add', arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01',
  volume_ul_per_well: 100}};
const EPS = 0.05;

type Truth = {head: {load_ul: number[]; has_tips: boolean}};
const truth = async (h: {baseUrl: string; operatorToken: string}, e: string): Promise<Truth> => {
  const r = await fetch(`${h.baseUrl}/api/v1/experiments/${e}/debug/truth`,
    {headers: {authorization: `Bearer ${h.operatorToken}`}});
  return JSON.parse(await r.text()) as Truth;
};
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const inv = (s: StateSnapshot): {reservoir: number; waste: number; tips: number; wells: number[]} => ({
  reservoir: s.reservoirs.find(r => r.id === 'media-01')!.remaining_ul,
  waste: sum(s.wastes.map(w => w.used_ul)),
  tips: sum(s.tips.map(t => t.remaining)),
  wells: wellsOf(s, 'plate-01').slice(0, 6),
});

async function stepUntilLoaded(h: RuntimeHandle, e: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await h.client.control(e, {step: {steps: 1}});
    if ((await truth(h, e)).head.load_ul.some(v => v > 0)) return;
  }
  throw new Error('head never loaded');
}

async function restartSameDir(dataDir: string, operatorToken: string):
    Promise<{client: DeviceClient; baseUrl: string; operatorToken: string; child: ChildProcess; stop: () => Promise<void>}> {
  const child = spawn(process.execPath, ['services/runtime/src/main.ts', '--port', '0', '--data-dir', dataDir],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
  await waitUntil(async () => out.includes('OSCAR_RUNTIME_READY'), 20_000);
  const line = out.split('\n').find(l => l.startsWith('OSCAR_RUNTIME_READY'))!;
  const {port} = JSON.parse(line.slice('OSCAR_RUNTIME_READY '.length)) as {port: number};
  const baseUrl = `http://127.0.0.1:${port}`;
  return {client: new DeviceClient({baseUrl, token: operatorToken, timeoutMs: 15_000}), baseUrl, operatorToken, child,
    stop: async () => {
      if (child.exitCode == null) {
        const exit = new Promise(r => child.once('exit', r));
        child.kill('SIGTERM');
        await Promise.race([exit, new Promise(r => setTimeout(r, 3000))]);
        if (child.exitCode == null) child.kill('SIGKILL');
      }
      rmSync(dataDir, {recursive: true, force: true});
    }};
}

async function sigkill(h: RuntimeHandle): Promise<void> {
  const exit = new Promise(r => h.child.once('exit', r));
  h.child.kill('SIGKILL');
  await exit;
}

test('D0-1 cancelling a head-free wait leaves the parallel media.add load, tips and waste untouched', async () => {
  const h = await spawnRuntime();
  try {
    const e = await currentExperimentId(h);
    const start = inv(await h.client.state(e));
    await h.client.submit(e, {capability: 'environment.set_targets', arguments: {chamber_id: 'chamber-01', temperature_c: 40}});
    const wait = await h.client.submit(e, {capability: 'environment.await_stable',
      arguments: {chamber_id: 'chamber-01', timeout_sim_s: 600}});
    const add = await h.client.submit(e, ADD);
    await stepUntilLoaded(h, e);
    const before = await truth(h, e);
    const cancelled = await h.client.cancel(e, wait.action.action_id);
    const after = await truth(h, e);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.summary.waste_delta_ul, 0, 'the wait never owned any liquid');
    assert.equal(cancelled.effects.length, 0);
    assert.deepEqual(after.head, before.head, 'head load and tips unchanged by the unrelated cancel');
    await h.client.control(e, {step: {until_idle: true}});
    const done = await h.client.action(e, add.action.action_id);
    assert.equal(done.status, 'succeeded');
    const final = await truth(h, e);
    assert.ok(final.head.load_ul.every(v => Math.abs(v) < 1e-9), `head empty, never negative: ${final.head.load_ul}`);
    assert.equal(final.head.has_tips, false);
    const end = inv(await h.client.state(e));
    assert.ok(Math.abs(start.reservoir - end.reservoir - 600) < EPS, 'reservoir -600');
    assert.ok(Math.abs(end.waste - start.waste) < EPS, 'no waste from a plain add');
    assert.equal(start.tips - end.tips, 6, 'one tip pickup of 6');
    for (let i = 0; i < 6; i++) assert.ok(Math.abs(end.wells[i] - start.wells[i] - 100) < 1, `A${i + 1} +100`);
  } finally {
    await h.stop();
  }
});

test('D0-2a Runtime SIGKILL mid-shake: restart ends the shake and later pipetting is accepted', async () => {
  const h = await spawnRuntime();
  let r2: Awaited<ReturnType<typeof restartSameDir>> | null = null;
  try {
    const e = await currentExperimentId(h);
    const shake = await h.client.submit(e, {capability: 'plate.shake',
      arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60}});
    await h.client.control(e, {step: {steps: 10}});
    assert.equal((await h.client.state(e)).plates[0].shake.active, true);
    await sigkill(h);
    r2 = await restartSameDir(h.dataDir, h.operatorToken);
    const s = await r2.client.state(e);
    assert.equal(s.plates[0].shake.active, false, 'restart must terminate the orphaned shake');
    const a = await r2.client.action(e, shake.action.action_id);
    assert.equal(a.status, 'failed');
    assert.equal(a.error?.code, 'runtime_restarted');
    assert.equal(s.active_actions.length, 0);
    await r2.client.control(e, {resume: true});
    const add = await r2.client.submit(e, ADD);
    await r2.client.control(e, {step: {until_idle: true}});
    assert.equal((await r2.client.action(e, add.action.action_id)).status, 'succeeded');
  } finally {
    if (r2) await r2.stop(); else await h.stop();
  }
});

test('D0-2b Runtime SIGKILL with liquid in the head: load goes to waste, nothing replayed, inventory conserved', async () => {
  const h = await spawnRuntime();
  let r2: Awaited<ReturnType<typeof restartSameDir>> | null = null;
  try {
    const e = await currentExperimentId(h);
    const start = inv(await h.client.state(e));
    const add = await h.client.submit(e, ADD);
    await stepUntilLoaded(h, e);
    await sigkill(h);
    r2 = await restartSameDir(h.dataDir, h.operatorToken);
    const t = await truth(r2, e);
    assert.ok(t.head.load_ul.every(v => v === 0), 'head emptied on recovery');
    assert.equal(t.head.has_tips, false, 'tips dropped on recovery');
    const a = await r2.client.action(e, add.action.action_id);
    assert.equal(a.status, 'failed');
    assert.equal(a.partial, true);
    assert.ok(Math.abs(a.summary.waste_delta_ul - 600) < EPS);
    const end = inv(await r2.client.state(e));
    assert.ok(Math.abs(start.reservoir - end.reservoir - 600) < EPS);
    assert.ok(Math.abs(end.waste - start.waste - 600) < EPS, 'aspirated liquid accounted in waste');
    for (let i = 0; i < 6; i++) assert.ok(Math.abs(end.wells[i] - start.wells[i]) < 0.5, `A${i + 1} unchanged`);
    // no replay after resume + time
    await r2.client.control(e, {resume: true});
    await r2.client.control(e, {step: {steps: 60}});
    const later = inv(await r2.client.state(e));
    assert.ok(Math.abs(later.reservoir - end.reservoir) < EPS, 'no second aspiration');
    const actions = (await r2.client.request<{actions: unknown[]}>('GET', `/api/v1/experiments/${e}/actions`)).body.actions;
    assert.equal(actions.length, 1);
  } finally {
    if (r2) await r2.stop(); else await h.stop();
  }
});

test('D0-3 reset with a loaded head archives a world consistent with the recorded wind-down effects', async () => {
  const h = await spawnRuntime();
  try {
    const e = await currentExperimentId(h);
    const start = inv(await h.client.state(e));
    const add = await h.client.submit(e, ADD);
    await stepUntilLoaded(h, e);
    await h.client.control(e, {reset: {}});
    const old = await h.client.state(e);
    assert.equal(old.experiment.status, 'archived');
    const a = await h.client.action(e, add.action.action_id);
    assert.equal(a.status, 'cancelled');
    assert.ok(Math.abs(a.summary.waste_delta_ul - 600) < EPS);
    const end = inv(old);
    assert.ok(Math.abs(end.waste - start.waste - 600) < EPS, `archived waste includes the discard (${end.waste})`);
    assert.ok(Math.abs(start.reservoir - end.reservoir - 600) < EPS);
    const t = await truth(h, e);
    assert.ok(t.head.load_ul.every(v => v === 0));
    assert.equal(t.head.has_tips, false);
    // old experiment is frozen for writes
    const r = await opFetch(h, 'POST', `/api/v1/experiments/${e}/actions`, ADD);
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.text).code, 'experiment_archived');
  } finally {
    await h.stop();
  }
});

test('D0-3b reset during a shake archives shake stopped', async () => {
  const h = await spawnRuntime();
  try {
    const e = await currentExperimentId(h);
    await h.client.submit(e, {capability: 'plate.shake', arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60}});
    await h.client.control(e, {step: {steps: 10}});
    await h.client.control(e, {reset: {}});
    const old = await h.client.state(e);
    assert.equal(old.plates[0].shake.active, false);
  } finally {
    await h.stop();
  }
});
