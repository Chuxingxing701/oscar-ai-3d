// Review regressions for the D1–D5 fixes over the REAL pi tool protocol
// (reports/review/long-lived-review.md F01/F05/F10/F14). Converted from the
// defect-reproduction diagnostic: every scenario now asserts the CORRECT
// behavior. Explicit slow OpenAI wire fixture + real Runtime, real Pi backend
// and Agent HTTP API.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DeviceClient} from '../../packages/device-contract/src/client.ts';
import {AgentStore} from '../../services/culture-agent/src/store.ts';
import {CultureAgent} from '../../services/culture-agent/src/agent.ts';
import {AgentApiClient, spawnRuntimeProc, sleep, waitFor} from '../../services/culture-agent/test/procs.ts';

const results = [];
function record(name, actual) {results.push({name, actual}); console.log(JSON.stringify({name, actual}));}
const gate = (() => {let resolve; return {promise: new Promise(r => {resolve = r;}), release: () => resolve()};})();
let requests = 0; let captured;
const wire = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  captured = JSON.parse(body); requests++;
  await gate.promise;
  const base = {id: 'review-slow', object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'review'};
  res.writeHead(200, {'content-type': 'text/event-stream'});
  for (const choices of [
    [{index: 0, delta: {role: 'assistant', tool_calls: [{index: 0, id: 'slow_call', type: 'function',
      function: {name: 'media_add', arguments: JSON.stringify({plate_id: 'plate-01', row_id: 'A',
        reservoir_id: 'media-01', volume_ul_per_well: 10})}}]}}],
    [{index: 0, delta: {}, finish_reason: 'tool_calls'}],
  ]) res.write(`data: ${JSON.stringify({...base, choices})}\n\n`);
  res.write('data: [DONE]\n\n'); res.end();
});
await new Promise(r => wire.listen(0, '127.0.0.1', r));
const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
const dir = mkdtempSync(join(tmpdir(), 'oscar-http-review-'));
const envKeys = ['OSCAR_MODEL_BASE_URL', 'OSCAR_MODEL_API_KEY', 'OSCAR_MODEL_NAME'];
const previous = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
process.env.OSCAR_MODEL_BASE_URL = `http://127.0.0.1:${wire.address().port}/v1`;
process.env.OSCAR_MODEL_API_KEY = 'explicit-review-stub-key';
process.env.OSCAR_MODEL_NAME = 'review';
const store = new AgentStore(dir);
const agent = new CultureAgent({config: {port: 0, dataDir: dir, runtimeUrl: runtime.baseUrl,
  repoRoot: process.cwd(), decisionDelayMs: null}, store, getServiceToken: () => runtime.serviceToken,
  log: () => {}});
await agent.listen(0, '127.0.0.1');
const api = new AgentApiClient(`http://127.0.0.1:${agent.boundPort}`, runtime.serviceToken);
const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken});
const exp = await operator.currentExperimentId();
await operator.control(exp, {speed: 100});
const goal = {description: 'review', scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', value: 330}], allowed_operations: ['media.add']};
try {
  const {session} = await api.post('/sessions', {experiment_id: exp});
  const taskBody = {goal_text: 'review', goal_spec: goal, request_id: 'same-task-request'};
  const {task} = await api.post(`/sessions/${session.session_id}/tasks`, taskBody);
  await waitFor(() => requests ? true : null, {timeoutMs: 10000});
  // F14 — replaying the same request_id returns the ORIGINAL task (200), not task_already_active.
  const replay = await api.post(`/sessions/${session.session_id}/tasks`, taskBody);
  assert.equal(replay.task.task_id, task.task_id);
  record('task_creation_retry_idempotent', {replay_task_id: replay.task.task_id, original_task_id: task.task_id});

  // F01 + F05 — while the real pi request is outstanding, the physical state
  // changes and the agent is paused: the late tool call must produce NO action.
  const before = await operator.state(exp);
  const manual = await operator.submit(exp, {capability: 'media.add', arguments: {plate_id: 'plate-01',
    row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 30}}, {idempotencyKey: 'review-manual-add'});
  await waitFor(async () => (await operator.action(exp, manual.action.action_id)).status === 'succeeded' ? true : null,
    {timeoutMs: 10000});
  await api.post(`/sessions/${session.session_id}/control`, {action: 'pause_agent'});
  gate.release();
  await sleep(3000); // the late response arrives; every fence must refuse it
  const serviceActions = (await operator.actions(exp)).actions.filter(a => a.principal.kind === 'service');
  const after = await api.get(`/sessions/${session.session_id}/status`);
  assert.equal(serviceActions.length, 0, `expected no service action, got ${serviceActions.map(a => a.action_id)}`);
  assert.equal(after.loop.agent_paused, true);
  record('real_pi_slow_response_refused_after_pause_and_state_change', {
    model_requests: requests, agent_paused: after.loop.agent_paused, service_actions: 0,
    old_plate_revision: before.plates[0].revision,
    newer_plate_revision: (await operator.state(exp)).plates[0].revision,
    wire_has_media_add_tool: captured.tools.some(t => t.function.name === 'media_add'),
  });
  await api.post(`/tasks/${task.task_id}/control`, {action: 'cancel'});
  await waitFor(async () => (await api.get(`/tasks/${task.task_id}`)).task.status === 'cancelled' ? true : null,
    {timeoutMs: 10000});

  // F10 — reset archives even an idle session (no armed wakes, no turn in flight).
  await operator.control(exp, {reset: {clock_mode: 'realtime'}});
  await sleep(7000); // one full watchdog period
  const lifecycle = (await api.get(`/sessions/${session.session_id}`)).session.lifecycle;
  assert.equal(lifecycle, 'archived');
  record('idle_session_archived_after_runtime_reset', {runtime_experiment_status: 'archived', session_lifecycle: lifecycle});
  // F10 — the supervisor surface cannot edit or resume anything on the archived session.
  let editError; let resumeError;
  try {await api.post(`/supervisor/v1/tasks/${task.task_id}`, {
    delegated_principal: 'review-supervisor', expected_revision: 1, goal_text: 'mutated archived goal'});}
  catch (e) {editError = {code: e.code, status: e.status};}
  try {await api.post(`/supervisor/v1/tasks/${task.task_id}/control`, {
    delegated_principal: 'review-supervisor', action: 'resume'});}
  catch (e) {resumeError = {code: e.code, status: e.status};}
  assert.equal(editError.code, 'session_archived');
  assert.equal(resumeError.code, 'session_archived');
  record('supervisor_cannot_mutate_archived_session', {
    session_lifecycle: 'archived', edit: editError, resume: resumeError});
} finally {
  gate.release(); await agent.close(); store.close(); await runtime.stop();
  wire.closeAllConnections(); await new Promise(r => wire.close(r));
  for (const k of envKeys) {if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];}
  rmSync(dir, {recursive: true, force: true});
  writeFileSync(new URL('./long-lived-http-reproductions.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
}
