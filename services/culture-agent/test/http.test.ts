// Culture Agent HTTP surface: listens on 127.0.0.1 only, rejects every
// request without a matching X-Service-Token (constant-time compare), and
// mode 'llm' without credentials pauses the run with model_unavailable
// (surfaced in the agent session stream; never a silent scripted fallback).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/store.ts';
import {CultureAgent} from '../src/agent.ts';
import {parseAgentConfig} from '../src/config.ts';
import {SERVICE_TOKEN} from './helpers.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'oscar-agent-http-'));
let agent: CultureAgent;
let baseUrl: string;

test.before(async () => {
  const config = parseAgentConfig(['--port', '0', '--data-dir', dataDir, '--runtime-url', 'http://127.0.0.1:9']);
  const store = new AgentStore(dataDir);
  agent = new CultureAgent({config, getServiceToken: () => SERVICE_TOKEN, store,
    log: () => undefined});
  const port = await agent.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  const addr = agent.server.address();
  assert.ok(typeof addr === 'object' && addr && addr.address === '127.0.0.1',
    `agent must bind loopback only, got ${JSON.stringify(addr)}`);
});

test.after(async () => {
  await agent.close();
  rmSync(dataDir, {recursive: true, force: true});
});

test('every request without a matching X-Service-Token is rejected 401', async () => {
  const noToken = await fetch(`${baseUrl}/runs`);
  assert.equal(noToken.status, 401);
  const wrongToken = await fetch(`${baseUrl}/runs`, {headers: {'x-service-token': 'wrong-token-value'}});
  assert.equal(wrongToken.status, 401);
  const emptyToken = await fetch(`${baseUrl}/runs`, {headers: {'x-service-token': ''}});
  assert.equal(emptyToken.status, 401);
  const noTokenPost = await fetch(`${baseUrl}/runs`, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(noTokenPost.status, 401);
  const ok = await fetch(`${baseUrl}/runs`, {headers: {'x-service-token': SERVICE_TOKEN}});
  assert.equal(ok.status, 200);
  const body = await ok.json() as {runs: unknown[]};
  assert.deepEqual(body.runs, []);
});

test('health endpoint also requires the service token', async () => {
  const r = await fetch(`${baseUrl}/health`);
  assert.equal(r.status, 401);
  const ok = await fetch(`${baseUrl}/health`, {headers: {'x-service-token': SERVICE_TOKEN}});
  assert.equal(ok.status, 200);
});

test('POST /runs validates the payload', async () => {
  const r = await fetch(`${baseUrl}/runs`, {method: 'POST',
    headers: {'x-service-token': SERVICE_TOKEN, 'content-type': 'application/json'},
    body: JSON.stringify({experiment_id: 'exp-001'})});
  assert.equal(r.status, 422);
  assert.match(await r.text(), /run_id/);
});

test('mode llm without OSCAR_LLM_* credentials -> run paused(model_unavailable), surfaced in the session stream', async () => {
  const previous = {...process.env};
  delete process.env.OSCAR_LLM_PROVIDER;
  delete process.env.OSCAR_LLM_API_KEY;
  delete process.env.OSCAR_LLM_MODEL;
  try {
    const accept = await fetch(`${baseUrl}/runs`, {method: 'POST',
      headers: {'x-service-token': SERVICE_TOKEN, 'content-type': 'application/json'},
      body: JSON.stringify({run_id: 'run-001-9', run_token: 'rt_llm', experiment_id: 'exp-001',
        clock_mode: 'lockstep', lease: null, mode: 'llm', scenario_id: 'routine_maintenance', seed: 42,
        plates: ['plate-01'], capabilities: ['imaging.scan'], budget: {max_actions: 10}})});
    assert.equal(accept.status, 202);
    const detailBody = await (await fetch(`${baseUrl}/runs/run-001-9`,
      {headers: {'x-service-token': SERVICE_TOKEN}})).json() as {status: string; pause_reason: string | null};
    assert.equal(detailBody.status, 'paused');
    assert.equal(detailBody.pause_reason, 'model_unavailable');
    const eventsBody = await (await fetch(`${baseUrl}/runs/run-001-9/events?format=json`,
      {headers: {'x-service-token': SERVICE_TOKEN}})).json() as {events: Array<{type: string; payload: Record<string, unknown>}>};
    const types = eventsBody.events.map(e => e.type);
    assert.ok(types.includes('run.accepted'));
    assert.ok(types.includes('error'), 'the session stream surfaces the failure');
    const error = eventsBody.events.find(e => e.type === 'error')!;
    assert.equal(error.payload.code, 'model_unavailable');
    assert.match(String(error.payload.message), /not falling back to scripted/);
    assert.ok(types.includes('paused'), 'a paused event is in the stream');
    // no decisions were ever made by a fallback policy
    assert.ok(!types.includes('decision'), 'no scripted fallback decisions');
  } finally {
    process.env.OSCAR_LLM_PROVIDER = previous.OSCAR_LLM_PROVIDER;
    process.env.OSCAR_LLM_API_KEY = previous.OSCAR_LLM_API_KEY;
    process.env.OSCAR_LLM_MODEL = previous.OSCAR_LLM_MODEL;
  }
});

test('duplicate POST /runs for the same run_id does not start a second loop', async () => {
  const payload = {run_id: 'run-001-10', run_token: 'rt_dup', experiment_id: 'exp-001',
    clock_mode: 'lockstep', lease: null, mode: 'scripted', scenario_id: 'routine_maintenance', seed: 42};
  const first = await fetch(`${baseUrl}/runs`, {method: 'POST',
    headers: {'x-service-token': SERVICE_TOKEN, 'content-type': 'application/json'},
    body: JSON.stringify(payload)});
  assert.equal(first.status, 202);
  assert.equal(((await first.json()) as {duplicate?: boolean}).duplicate, undefined);
  const second = await fetch(`${baseUrl}/runs`, {method: 'POST',
    headers: {'x-service-token': SERVICE_TOKEN, 'content-type': 'application/json'},
    body: JSON.stringify(payload)});
  assert.equal(second.status, 202);
  assert.equal(((await second.json()) as {duplicate?: boolean}).duplicate, true);
});

test('control on an unknown run is 404; unknown action is 422', async () => {
  const missing = await fetch(`${baseUrl}/runs/run-nope`, {headers: {'x-service-token': SERVICE_TOKEN}});
  assert.equal(missing.status, 404);
  const bad = await fetch(`${baseUrl}/runs/run-001-10/control`, {method: 'POST',
    headers: {'x-service-token': SERVICE_TOKEN, 'content-type': 'application/json'},
    body: JSON.stringify({action: 'explode'})});
  assert.equal(bad.status, 422);
});

test('run control cancel writes a local report and ends the run', async () => {
  const accept = await fetch(`${baseUrl}/runs`, {method: 'POST',
    headers: {'x-service-token': SERVICE_TOKEN, 'content-type': 'application/json'},
    body: JSON.stringify({run_id: 'run-001-11', run_token: 'rt_cancel', experiment_id: 'exp-001',
      clock_mode: 'lockstep', lease: null, mode: 'scripted', scenario_id: 'routine_maintenance', seed: 42})});
  assert.equal(accept.status, 202);
  const cancel = await fetch(`${baseUrl}/runs/run-001-11/control`, {method: 'POST',
    headers: {'x-service-token': SERVICE_TOKEN, 'content-type': 'application/json'},
    body: JSON.stringify({action: 'cancel'})});
  assert.equal(cancel.status, 200);
  const detail = await (await fetch(`${baseUrl}/runs/run-001-11`,
    {headers: {'x-service-token': SERVICE_TOKEN}})).json() as {status: string; report: {outcome: string} | null};
  assert.equal(detail.status, 'ended');
  assert.equal(detail.report?.outcome, 'aborted');
});
