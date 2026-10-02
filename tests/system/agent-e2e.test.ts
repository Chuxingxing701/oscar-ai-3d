// End-to-end system test with REAL Runtime + Culture Agent child processes.
// - routine_maintenance runs to completion through the gateway (no SSE clients
//   connected anywhere: closing/never-opening browser streams must not matter)
// - SIGKILL of the Agent mid-action + restart -> paused(agent_restarted), no
//   duplicate media action, operator resume completes the run
// - with the Agent process gone the gateway returns 503 agent_unavailable and
//   manual operator actions still work (after hold/end).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer as netServer, type AddressInfo} from 'node:net';
import {DeviceClient, isTerminal} from '@oscar/device-contract';
import {waitLine} from '../../scripts/proc-lines.ts';

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

interface Stack {
  dataDir: string;
  runtimeUrl: string;
  operator: DeviceClient;
  agentPort: number;
  agentChild: ChildProcess;
  runtimeChild: ChildProcess;
  stopAgent: (signal?: NodeJS.Signals) => Promise<void>;
  startAgent: () => Promise<void>;
  stop: () => Promise<void>;
}

async function startStack(env: Record<string, string> = {}): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), 'oscar-agent-e2e-'));
  const runtimePort = await freePort();
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  let agentChild: ChildProcess;
  let agentPort = 0;
  const spawnAgent = (): ChildProcess => spawn(process.execPath,
    ['services/culture-agent/src/main.ts', '--port', String(agentPort || 0), '--data-dir', dataDir,
      '--runtime-url', runtimeUrl], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ...env}});
  agentChild = spawnAgent();
  const listening = await waitLine(agentChild, 'OSCAR_AGENT_LISTENING ');
  agentPort = (JSON.parse(listening.slice('OSCAR_AGENT_LISTENING '.length)) as {port: number}).port;
  const runtimeChild = spawn(process.execPath, ['services/runtime/src/main.ts', '--port', String(runtimePort),
    '--data-dir', dataDir, '--scenario', 'routine_maintenance', '--seed', '42', '--clock-mode', 'lockstep',
    '--agent-url', `http://127.0.0.1:${agentPort}`], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ...env}});
  await waitLine(runtimeChild, 'OSCAR_RUNTIME_READY ');
  await waitLine(agentChild, 'OSCAR_AGENT_READY ');
  const operatorToken = readFileSync(join(dataDir, 'runtime', 'operator.token'), 'utf8').trim();
  const operator = new DeviceClient({baseUrl: runtimeUrl, token: operatorToken, timeoutMs: 15_000});
  const stopAgent = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    if (agentChild.exitCode == null && !agentChild.killed) {
      agentChild.kill(signal);
      await new Promise<void>(r => {
        const t = setTimeout(() => r(), 3000);
        agentChild.on('exit', () => { clearTimeout(t); r(); });
      });
    }
  };
  const startAgent = async (): Promise<void> => {
    agentChild = spawnAgent();
    await waitLine(agentChild, 'OSCAR_AGENT_READY ');
  };
  const stop = async (): Promise<void> => {
    await stopAgent();
    if (runtimeChild.exitCode == null && !runtimeChild.killed) {
      runtimeChild.kill('SIGTERM');
      await new Promise<void>(r => {
        const t = setTimeout(() => { runtimeChild.kill('SIGKILL'); r(); }, 3000);
        runtimeChild.on('exit', () => { clearTimeout(t); r(); });
      });
    }
    try { rmSync(dataDir, {recursive: true, force: true}); } catch { /* ignore */ }
  };
  return {dataDir, runtimeUrl, operator, agentPort, agentChild, runtimeChild, stopAgent, startAgent, stop};
}

async function waitUntil(pred: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('waitUntil timed out');
}

async function createRun(operator: DeviceClient, exp: string, mode: 'scripted' | 'llm' = 'scripted'): Promise<string> {
  const r = await operator.request<{run: {run_id: string}}>('POST', '/api/v1/agent/runs', {experiment_id: exp, mode});
  return r.body.run.run_id;
}

test('routine_maintenance end-to-end via the gateway; completes with no SSE clients connected', async () => {
  const stack = await startStack();
  try {
    const exp = await stack.operator.currentExperimentId();
    await stack.operator.control(exp, {speed: 600});
    const runId = await createRun(stack.operator, exp);
    await waitUntil(async () => {
      const run = await stack.operator.request<{status: string; reason: string | null}>('GET', `/api/v1/runs/${runId}`);
      return run.body.status === 'ended';
    }, 90_000);
    const run = await stack.operator.request<{status: string; reason: string | null; determinism_broken: boolean}>(
      'GET', `/api/v1/runs/${runId}`);
    assert.equal(run.body.reason, 'completed');
    assert.equal(run.body.determinism_broken, false);
    const actions = (await stack.operator.actions(exp)).actions;
    const add = actions.filter(a => a.capability === 'media.add');
    assert.equal(add.length, 1);
    assert.equal(add[0].status, 'succeeded');
    assert.ok(add[0].evidence_refs.length > 0, 'liquid action cites evidence');
    const report = await stack.operator.request<{report: {outcome: string; inventory: unknown}}>(
      'GET', `/api/v1/runs/${runId}/report`);
    assert.equal(report.body.report.outcome, 'completed');
    assert.ok(report.body.report.inventory, 'report carries inventory reconciliation');
    // agent session stream is reachable through the gateway
    const events = await stack.operator.request<{events: Array<{type: string}>}>(
      'GET', `/api/v1/agent/runs/${runId}/events?format=json`);
    const types = events.body.events.map(e => e.type);
    assert.ok(types.includes('run.accepted') && types.includes('decision') && types.includes('report'));
  } finally {
    await stack.stop();
  }
});

test('agent SIGKILL mid-action: restart -> paused(agent_restarted), no duplicate media action, resume completes', async () => {
  const stack = await startStack({OSCAR_LEASE_TTL_MS: '120000', OSCAR_LEASE_MAX_HOLD_MS: '300000'});
  try {
    const exp = await stack.operator.currentExperimentId();
    await stack.operator.control(exp, {speed: 600});
    const runId = await createRun(stack.operator, exp);
    // wait until the media.add is running, then SIGKILL the agent
    await waitUntil(async () => {
      const actions = (await stack.operator.actions(exp)).actions;
      return actions.some(a => a.capability === 'media.add' && a.status === 'running');
    }, 90_000, 20);
    stack.agentChild.kill('SIGKILL');
    await new Promise<void>(r => stack.agentChild.on('exit', () => r()));
    const actionsAtKill = (await stack.operator.actions(exp)).actions.length;

    await stack.startAgent(); // same data dir, same port
    await waitUntil(async () => {
      const run = await stack.operator.request<{status: string; reason: string | null}>('GET', `/api/v1/runs/${runId}`);
      return run.body.status === 'paused' && run.body.reason === 'agent_restarted';
    }, 30_000);
    // no new actions while paused
    const pausedCount = (await stack.operator.actions(exp)).actions.length;
    assert.equal(pausedCount, actionsAtKill, 'no new actions after the agent restart');

    const resume = await stack.operator.request('POST', `/api/v1/agent/runs/${runId}/control`, {action: 'resume'});
    assert.equal(resume.status, 200);
    await waitUntil(async () => {
      const run = await stack.operator.request<{status: string; reason: string | null}>(
        'GET', `/api/v1/runs/${runId}`);
      return run.body.status === 'ended';
    }, 90_000);
    const run = await stack.operator.request<{status: string; reason: string | null}>(
      'GET', `/api/v1/runs/${runId}`);
    assert.equal(run.body.reason, 'completed');
    const actions = (await stack.operator.actions(exp)).actions;
    const liquid = actions.filter(a => a.capability === 'media.add' || a.capability === 'media.exchange');
    assert.equal(liquid.length, 1, 'exactly one liquid op overall — the exchange/add was not repeated');
    assert.equal(liquid[0].status, 'succeeded');
    assert.ok(Object.keys(liquid[0].summary.wells).length === 6, 'the single liquid op committed 6 wells');
    const report = await stack.operator.request<{report: {outcome: string}}>('GET', `/api/v1/runs/${runId}/report`);
    assert.equal(report.body.report.outcome, 'completed');
  } finally {
    await stack.stop();
  }
});

test('agent down: gateway 503 agent_unavailable; operator manual actions still work after hold/end', async () => {
  const stack = await startStack();
  try {
    const exp = await stack.operator.currentExperimentId();
    await stack.operator.control(exp, {speed: 600});
    const runId = await createRun(stack.operator, exp);
    await stack.stopAgent('SIGKILL');
    // gateway proxy now fails with 503 agent_unavailable
    await assert.rejects(() => stack.operator.request('GET', '/api/v1/agent/runs'),
      (e: {code: string; status: number}) => e.code === 'agent_unavailable' && e.status === 503);
    // while the (Runtime-side) run is still active, manual writes demand a hold
    await assert.rejects(() => stack.operator.submit(exp, {capability: 'environment.set_targets',
      arguments: {chamber_id: 'chamber-01', temperature_c: 36.5}}),
      (e: {code: string}) => e.code === 'hold_required');
    await stack.operator.control(exp, {hold: {run_id: runId, on: true}});
    const manual = await stack.operator.submit(exp, {capability: 'environment.set_targets',
      arguments: {chamber_id: 'chamber-01', temperature_c: 36.5}});
    assert.equal(manual.action.status, 'succeeded');
    // end the run (operator cancel; agent is gone so this must still work)
    await stack.operator.control(exp, {hold: {run_id: runId, on: false}});
    const cancel = await stack.operator.request('POST', `/api/v1/agent/runs/${runId}/control`, {action: 'cancel'});
    assert.equal(cancel.status, 200);
    const after = await stack.operator.submit(exp, {capability: 'environment.set_targets',
      arguments: {chamber_id: 'chamber-01', temperature_c: 36.6}});
    assert.equal(after.action.status, 'succeeded');
    // operator stepping the clock also works without an agent
    await stack.operator.control(exp, {step: {steps: 5}});
    const state = await stack.operator.state(exp);
    assert.ok(state.experiment.sim_time_s >= 5);
    assert.ok(isTerminal('succeeded'));
  } finally {
    await stack.stop();
  }
});
