// D4 acceptance: an INDEPENDENT HTTP contract client (no DOM, no database
// access) drives the supervisor v1 API through the Runtime's same-origin
// gateway with an operator Bearer token — the surface a future DSH-style
// assistant would use. Long tasks return task_id immediately; subscriptions
// observe only (dropping them never cancels); expected_revision is enforced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceClient} from '@oscar/device-contract';
import {startModelStub} from '../services/culture-agent/test/model-stub.ts';
import {spawnAgentProc, spawnRuntimeProc, waitFor} from '../services/culture-agent/test/procs.ts';

/** The contract client: plain fetch, nothing else. */
class SupervisorClient {
  readonly runtimeUrl: string;
  readonly operatorToken: string;

  constructor(runtimeUrl: string, operatorToken: string) {
    this.runtimeUrl = runtimeUrl;
    this.operatorToken = operatorToken;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.runtimeUrl}/api/v1/agent/supervisor/v1${path}`, {method,
      headers: {'content-type': 'application/json', authorization: `Bearer ${this.operatorToken}`},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await r.text();
    const json = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!r.ok) {
      throw Object.assign(new Error(`${json.code ?? r.status}: ${json.message ?? text}`),
        {status: r.status, code: json.code, body: json});
    }
    return json as T;
  }

  overview() {return this.call<{contract_version: string; sessions: unknown[]}>('GET', '/overview');}
  createSession(experimentId: string) {
    return this.call<{session_id: string; created: boolean}>('POST', '/sessions',
      {experiment_id: experimentId, delegated_principal: 'dsh-test-client', request_id: 'sup-sess-1'});
  }
  submitTask(sessionId: string, goalText: string, goalSpec: unknown) {
    return this.call<{task_id: string; status: string; accepted: boolean}>('POST',
      `/sessions/${encodeURIComponent(sessionId)}/tasks`,
      {goal_text: goalText, goal_spec: goalSpec, delegated_principal: 'dsh-test-client', request_id: 'sup-task-1'});
  }
  status(sessionId: string) {
    return this.call<{loop: {state: string}; device: {sim_time_s?: number}; task: {status: string;
      budget: {actions_used: number}} | null; contract_version: string}>('GET',
      `/sessions/${encodeURIComponent(sessionId)}/status`);
  }
  updateTask(taskId: string, expectedRevision: number, goalText: string) {
    return this.call<{goal_revision: number}>('POST', `/tasks/${encodeURIComponent(taskId)}`,
      {expected_revision: expectedRevision, goal_text: goalText, delegated_principal: 'dsh-test-client'});
  }
  control(taskId: string, action: 'pause' | 'resume' | 'cancel') {
    return this.call<{status: string}>('POST', `/tasks/${encodeURIComponent(taskId)}/control`,
      {action, delegated_principal: 'dsh-test-client'});
  }
  events(sessionId: string, afterSeq: number) {
    return this.call<{events: Array<{seq: number; type: string}>; last_seq: number}>('GET',
      `/sessions/${encodeURIComponent(sessionId)}/events?after_seq=${afterSeq}&format=json&limit=1000`);
  }
  message(sessionId: string, content: string) {
    return this.call<{message_id: string}>('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`,
      {content, delegated_principal: 'dsh-test-client', request_id: `sup-msg-${Date.now()}`});
  }
}

const goalSpec = {
  description: '维持 plate-01 A 排各孔培养液 ≥ 358 µL（委托任务）',
  scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', value: 358, source: 'observation', row_id: 'A'}],
  allowed_operations: ['imaging.scan', 'media.add'],
  monitoring: {interval_sim_s: 21_600},
  deadline_sim_s: 60_000,
  success: {description: 'window finished above threshold'},
  stop: {description: 'budget or cancel'},
};

test('supervisor v1 contract client: delegate, observe, adjust, cancel without DOM/DB', {timeout: 150_000}, async () => {
  const stub = await startModelStub();
  // Pick the agent port up front so the runtime gateway can point at it.
  // The agent itself waits for the runtime's service token file.
  const {createServer} = await import('node:http');
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const agentPort = (probe.address() as {port: number}).port;
  probe.close();
  const runtime = await spawnRuntimeProc({clockMode: 'realtime',
    agentUrl: `http://127.0.0.1:${agentPort}`});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, port: agentPort,
    env: {OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stub.port}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
      OSCAR_MODEL_NAME: 'oscar-stub'}});
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  const sup = new SupervisorClient(runtime.baseUrl, runtime.operatorToken);
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});

    // 1. overview lists nothing yet; create session (idempotent)
    const empty = await sup.overview();
    assert.equal(empty.contract_version, '1.1.0'); // R07: queue additions are additive
    const created = await sup.createSession(experimentId);
    assert.equal(created.created, true);
    const again = await sup.createSession(experimentId);
    assert.equal(again.created, false);

    // 2. delegate a long task → task_id returns IMMEDIATELY
    const submitted = await sup.submitTask(created.session_id, '照看 A 排（supervisor 委托）', goalSpec);
    assert.ok(submitted.task_id, 'task_id returned synchronously');
    assert.equal(submitted.accepted, true);

    // 3. observe: status shows loop + device freshness and the task budget
    await waitFor(async () => {
      const s = await sup.status(created.session_id);
      return (s.task?.budget.actions_used ?? 0) >= 1 ? s : null;
    }, {timeoutMs: 40_000, label: 'supervisor-visible action'});
    const mid = await sup.status(created.session_id);
    assert.ok(mid.device.sim_time_s !== undefined, 'device projection visible');
    assert.ok(mid.contract_version);

    // 4. subscribe via events (JSON polling form); dropping it changes nothing
    const events1 = await sup.events(created.session_id, 0);
    assert.ok(events1.events.length >= 1, 'session events observable');
    // no subscription held — task keeps running
    await new Promise(r => setTimeout(r, 1500));
    const still = await sup.status(created.session_id);
    assert.notEqual(still.task?.status, 'cancelled', 'dropped subscription never cancels');

    // 5. adjust with expected_revision; a stale revision is refused
    const bad = await sup.updateTask(submitted.task_id, 999, 'stale edit').catch(e => e);
    assert.equal(bad.code, 'revision_conflict', 'stale expected_revision refused');
    const good = await sup.updateTask(submitted.task_id, 1, '照看 A 排（supervisor 调整：范围不变）');
    assert.equal(good.goal_revision, 2);

    // 6. conversation message through the same core
    const msg = await sup.message(created.session_id, '请继续监测。');
    assert.ok(msg.message_id);

    // 7. cancel: task ends cancelled; the device keeps running
    const cancelled = await sup.control(submitted.task_id, 'cancel');
    assert.equal(cancelled.status, 'cancelled');
    const overview = await sup.overview();
    assert.ok(Array.isArray(overview.sessions) && overview.sessions.length >= 1);
    const state = await operator.state(experimentId);
    assert.equal(state.experiment.paused, false, 'runtime unaffected by task cancel');
  } finally {
    await agent.stop();
    await runtime.stop();
    await stub.close();
  }
});
