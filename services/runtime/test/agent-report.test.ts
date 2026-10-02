// C3 runtime extension tests: POST /runs/{id}/agent-status {status:'ended',
// reason, report} ends the run (existing endRun path), stores the report in
// agent_reports and emits run.ended with the outcome; GET /runs/{id}/report
// returns it (operator or that run token). Real Runtime child + stub agent.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {currentExperimentId, opFetch, spawnRuntime, startStubAgent, waitUntil, type RuntimeHandle} from './helpers.ts';

let h: RuntimeHandle;
let agent: Awaited<ReturnType<typeof startStubAgent>>;
let exp: string;
let runId: string;
let runToken: string;

test.before(async () => {
  agent = await startStubAgent();
  h = await spawnRuntime({scenario: 'routine_maintenance', seed: 42, args: ['--agent-url', agent.url]});
  exp = await currentExperimentId(h);
  const r = await opFetch(h, 'POST', '/api/v1/agent/runs', {experiment_id: exp, mode: 'scripted'},
    {'idempotency-key': 'ar-1'});
  assert.equal(r.status, 200);
  runId = ((await JSON.parse(r.text)) as {run: {run_id: string}}).run.run_id;
  await waitUntil(async () => agent.received.some(x => x.run_id === runId));
  runToken = String(agent.received.find(x => x.run_id === runId)!.run_token);
});

test.after(async () => {
  await h.stop();
  await agent.close();
});

const runAuth = (): Record<string, string> => ({authorization: `Bearer ${runToken}`});

test('agent-status ended requires the run token and a valid reason', async () => {
  // operator cannot use it
  const op = await opFetch(h, 'POST', `/api/v1/runs/${runId}/agent-status`, {status: 'ended', reason: 'completed'});
  assert.equal(op.status, 403);
  // run token but invalid reason
  const bad = await fetch(`${h.baseUrl}/api/v1/runs/${runId}/agent-status`, {method: 'POST',
    headers: {...runAuth(), 'content-type': 'application/json'}, body: JSON.stringify({status: 'ended', reason: 'maybe'})});
  assert.equal(bad.status, 422);
  assert.equal(((await bad.json()) as {code: string}).code, 'invalid_argument');
  // unknown status value
  const unknown = await fetch(`${h.baseUrl}/api/v1/runs/${runId}/agent-status`, {method: 'POST',
    headers: {...runAuth(), 'content-type': 'application/json'}, body: JSON.stringify({status: 'thinking'})});
  assert.equal(unknown.status, 422);
});

test('agent-status ended(completed, report) ends the run, stores the report, emits run.ended outcome', async () => {
  const report = {run_id: runId, outcome: 'completed', summary: 'demo report',
    steps: [{index: 1, kind: 'act', capability: 'media.add'}], inventory: {reservoirs: []}};
  const r = await fetch(`${h.baseUrl}/api/v1/runs/${runId}/agent-status`, {method: 'POST',
    headers: {...runAuth(), 'content-type': 'application/json'},
    body: JSON.stringify({status: 'ended', reason: 'completed', report})});
  assert.equal(r.status, 200);
  const run = await r.json() as {status: string; reason: string};
  assert.equal(run.status, 'ended');
  assert.equal(run.reason, 'completed');

  // run.ended carries the outcome; lease revoked; token now revoked
  const {events} = await h.client.events(exp, 0, 500);
  const ended = events.filter(e => e.type === 'run.ended').at(-1)!;
  assert.equal((ended.payload as {outcome?: string}).outcome, 'completed');
  assert.equal((ended.payload as {by?: string}).by, 'agent');
  assert.ok(events.some(e => e.type === 'lease.revoked'));
  const state = await h.client.state(exp);
  assert.equal(state.lease, null);
  assert.equal(state.run?.status, 'ended');
});

test('GET /runs/{id}/report: operator ok, foreign run token rejected, 404 without report', async () => {
  const op = await opFetch(h, 'GET', `/api/v1/runs/${runId}/report`);
  assert.equal(op.status, 200);
  const body = await JSON.parse(op.text) as {run_id: string; reason: string; report: {summary: string}};
  assert.equal(body.run_id, runId);
  assert.equal(body.reason, 'completed');
  assert.equal(body.report.summary, 'demo report');

  // the reporting run's own token was revoked when the run ended -> 401
  const own = await fetch(`${h.baseUrl}/api/v1/runs/${runId}/report`, {headers: runAuth()});
  assert.equal(own.status, 401);

  // a DIFFERENT (still valid) run's token is forbidden
  const second = await opFetch(h, 'POST', '/api/v1/agent/runs', {experiment_id: exp}, {'idempotency-key': 'ar-2'});
  assert.equal(second.status, 200);
  const secondRun = (await JSON.parse(second.text)) as {run: {run_id: string}};
  await waitUntil(async () => agent.received.some(x => x.run_id === secondRun.run.run_id));
  const token2 = String(agent.received.find(x => x.run_id === secondRun.run.run_id)!.run_token);
  const foreign = await fetch(`${h.baseUrl}/api/v1/runs/${runId}/report`, {headers: {authorization: `Bearer ${token2}`}});
  assert.equal(foreign.status, 403);
  // the second run has no report yet -> 404 for its own token
  const none = await fetch(`${h.baseUrl}/api/v1/runs/${secondRun.run.run_id}/report`,
    {headers: {authorization: `Bearer ${token2}`}});
  assert.equal(none.status, 404);
  // clean up: cancel the second run
  const cancel = await opFetch(h, 'POST', `/api/v1/agent/runs/${secondRun.run.run_id}/control`, {action: 'cancel'});
  assert.equal(cancel.status, 200);
});

test('run record stays readable (operator) after the report was delivered', async () => {
  const r = await opFetch(h, 'GET', `/api/v1/runs/${runId}`);
  assert.equal(r.status, 200);
  const body = await JSON.parse(r.text) as {status: string; reason: string};
  assert.equal(body.status, 'ended');
  assert.equal(body.reason, 'completed');
});
