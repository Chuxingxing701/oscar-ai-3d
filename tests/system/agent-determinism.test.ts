// Determinism acceptance (§9 可重现): the same scripted scenario in lockstep
// produces IDENTICAL action sequences (capability, arguments, submitted/ended
// sim times, status), per-well final volumes and observation image hashes at
// speed 1 and speed 600, WITH random wall-time decision delays injected
// (OSCAR_AGENT_DECISION_DELAY_MS). determinism_broken must stay false.
// Real Runtime + Agent processes on isolated temp dirs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer as netServer, type AddressInfo} from 'node:net';
import {DeviceClient, type Action, type Observation} from '@oscar/device-contract';
import {bufferOf, waitLine} from '../../scripts/proc-lines.ts';

const ROOT = join(import.meta.dirname, '..', '..');

async function freePort(): Promise<number> {
  return new Promise(resolvePromise => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolvePromise(port));
    });
  });
}

interface Trace {
  actions: Array<{capability: string; arguments: Record<string, unknown>; submitted_at_sim_s: number;
    status: string; ended_at_sim_s: number | null}>;
  wells: Array<{well_id: string; volume_ul: number}>;
  imageHashes: string[];
  determinism_broken: boolean;
}

async function runOnce(speed: number, delayEnv: string): Promise<Trace> {
  const dataDir = mkdtempSync(join(tmpdir(), `oscar-det-${speed}-`));
  const env = {...process.env, OSCAR_AGENT_DECISION_DELAY_MS: delayEnv};
  const runtimePort = await freePort();
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const agent = spawn(process.execPath, ['services/culture-agent/src/main.ts', '--port', '0',
    '--data-dir', dataDir, '--runtime-url', runtimeUrl], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env});
  bufferOf(agent);
  const listening = await waitLine(agent, 'OSCAR_AGENT_LISTENING ');
  const agentPort = (JSON.parse(listening.slice('OSCAR_AGENT_LISTENING '.length)) as {port: number}).port;
  const runtime = spawn(process.execPath, ['services/runtime/src/main.ts', '--port', String(runtimePort),
    '--data-dir', dataDir, '--scenario', 'routine_maintenance', '--seed', '42', '--clock-mode', 'lockstep',
    '--agent-url', `http://127.0.0.1:${agentPort}`], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env});
  bufferOf(runtime);
  try {
    await waitLine(runtime, 'OSCAR_RUNTIME_READY ');
    await waitLine(agent, 'OSCAR_AGENT_READY ');
    const operatorToken = readFileSync(join(dataDir, 'runtime', 'operator.token'), 'utf8').trim();
    const client = new DeviceClient({baseUrl: runtimeUrl, token: operatorToken, timeoutMs: 15_000});
    const exp = await client.currentExperimentId();
    await client.control(exp, {speed});
    const created = await client.request<{run: {run_id: string}}>('POST', '/api/v1/agent/runs',
      {experiment_id: exp, mode: 'scripted'});
    const runId = created.body.run.run_id;
    const deadline = Date.now() + 170_000;
    for (;;) {
      const run = await client.request<{status: string; reason: string | null; determinism_broken: boolean}>(
        'GET', `/api/v1/runs/${runId}`);
      if (run.body.status === 'ended') {
        assert.equal(run.body.reason, 'completed', 'the run must complete normally');
        assert.equal(run.body.determinism_broken, false, 'determinism_broken must stay false');
        break;
      }
      if (Date.now() > deadline) throw new Error(`run did not end in time at speed ${speed}`);
      await new Promise(r => setTimeout(r, 150));
    }
    const actions: Action[] = (await client.actions(exp)).actions;
    const observations: Observation[] = (await client.request<{observations: Observation[]}>('GET',
      `/api/v1/experiments/${exp}/observations`)).body.observations;
    const state = await client.state(exp);
    return {
      actions: actions.map(a => ({capability: a.capability, arguments: a.arguments,
        submitted_at_sim_s: a.submitted_at_sim_s, status: a.status, ended_at_sim_s: a.ended_at_sim_s})),
      wells: state.plates.flatMap(p => p.wells.map(w => ({well_id: `${p.plate_id}/${w.well_id}`,
        volume_ul: Math.round(w.volume_ul * 1e6) / 1e6}))),
      imageHashes: observations.flatMap(o => o.images.map(i => i.sha256)),
      determinism_broken: state.experiment.determinism_broken || Boolean(state.run?.determinism_broken),
    };
  } finally {
    for (const c of [agent, runtime]) {
      if (c.exitCode == null && !c.killed) {
        c.kill('SIGTERM');
        await new Promise<void>(r => {
          const t = setTimeout(() => { c.kill('SIGKILL'); r(); }, 3000);
          c.on('exit', () => { clearTimeout(t); r(); });
        });
      }
    }
    try { rmSync(dataDir, {recursive: true, force: true}); } catch { /* ignore */ }
  }
}

test('scripted routine_maintenance: speed 1 vs speed 600 with random decision delays -> identical traces', async () => {
  // speed 1 walks the run in near-real time (~60–90 s wall); speed 600 is fast.
  // Different random delay windows per run prove decisions cannot depend on wall time.
  const slow = await runOnce(1, '50-350');
  const fast = await runOnce(600, '10-500');
  assert.deepEqual(slow.actions, fast.actions,
    'normalized action sequences (capability, arguments, submitted/ended sim time, status) must be identical');
  assert.deepEqual(slow.wells, fast.wells, 'per-well final volumes must be identical');
  assert.deepEqual(slow.imageHashes, fast.imageHashes, 'observation image sha256 list must be identical');
  assert.equal(slow.determinism_broken, false);
  assert.equal(fast.determinism_broken, false);
  assert.ok(slow.actions.length >= 3, 'the trace covers scan + add + rescan');
  assert.ok(slow.imageHashes.length >= 2);
});
