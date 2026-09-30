// D5 fault acceptance: goal fencing, accepted-response loss, agent/runtime
// SIGKILL recovery, archive isolation and forced compaction — on real
// processes with isolated temp data dirs. Every fault asserts the ledger:
// no duplicate device submissions, conservation, visible states.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceClient} from '@oscar/device-contract';
import {AgentStore} from '../src/store.ts';
import {SessionStore} from '../src/session-store.ts';
import {SessionExecutor} from '../src/executor.ts';
import {normalizeGoalSpec} from '../src/goal.ts';
import {startModelStub} from './model-stub.ts';
import {acceptedResponseLossFetch, AgentApiClient, spawnAgentProc, spawnRuntimeProc, sleep, waitFor} from './procs.ts';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CultureAgent} from '../src/agent.ts';

const goalSpec = (value = 330): Record<string, unknown> => ({
  description: `维持 plate-01 A 排各孔培养液 ≥ ${value} µL`,
  scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', value, source: 'observation', row_id: 'A'}],
  allowed_operations: ['imaging.scan', 'media.add'],
  monitoring: {interval_sim_s: 21_600},
  deadline_sim_s: 93_600,
  success: {description: 'window finished above threshold'},
  stop: {description: 'budget or cancel'},
});

const stubEnv = (port: number): Record<string, string> => ({
  OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
  OSCAR_MODEL_NAME: 'oscar-stub'});

async function countServiceActions(operator: DeviceClient, experimentId: string): Promise<{total: number; byKey: Map<string, string>}> {
  const {actions} = await operator.actions(experimentId);
  const service = actions.filter(a => a.principal.kind === 'service');
  const byKey = new Map<string, string>();
  for (const a of service) byKey.set(a.idempotency_key ?? '', a.action_id);
  return {total: service.length, byKey};
}

test('executor fencing: goal_revision, ownership generation and archived sessions refuse writes', {timeout: 90_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const dir = mkdtempSync(join(tmpdir(), 'oscar-fence-'));
  try {
    const store = new AgentStore(dir);
    const sessions = new SessionStore(store.db);
    const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken, timeoutMs: 15_000});
    const experimentId = await client.currentExperimentId();
    const executor = new SessionExecutor({store: sessions, client,
      emit: () => undefined, log: () => undefined});
    const session = sessions.createSession({runtime_instance_id: 'rt-test', experiment_id: experimentId});
    const spec = normalizeGoalSpec(goalSpec());
    const task = sessions.createTask(session.session_id,
      {goal_text: 'fence test', goal_spec: spec as unknown as Record<string, unknown>});
    sessions.updateTaskStatus(task.task_id, 'running', 'test');
    const gen = sessions.claimOwnership(session.session_id);

    // 1. in-scope write under the current revision is accepted
    const ok = await executor.submitWrite({session, task, spec, capability: 'imaging.scan',
      args: {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'},
      reason: 'fence', turnGoalRevision: 1, generation: gen});
    assert.equal(ok.ok, true, 'current-revision write accepted');

    // 2. a late model response decided under revision 1 is refused after a user edit
    sessions.updateTaskGoal(task.task_id, {goal_text: 'narrowed',
      goal_spec: {...spec, scope: {plates: ['plate-01'], rows: ['B']}} as unknown as Record<string, unknown>});
    const stale = await executor.submitWrite({session, task, spec, capability: 'imaging.scan',
      args: {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'},
      reason: 'late response', turnGoalRevision: 1, generation: gen});
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, 'goal_revision_stale');

    // 3. an old scheduler owner (superseded generation) is refused
    sessions.claimOwnership(session.session_id); // a restart claimed ownership
    const oldOwner = await executor.submitWrite({session, task, spec: normalizeGoalSpec(goalSpec()),
      capability: 'imaging.scan', args: {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'},
      reason: 'old owner', turnGoalRevision: 2, generation: gen});
    assert.equal(oldOwner.ok, false);
    assert.equal(oldOwner.error?.code, 'stale_owner');

    // 4. out-of-scope capability/plate is refused
    sessions.claimOwnership(session.session_id);
    const fresh = sessions.getTask(task.task_id)!;
    const outOfScope = await executor.submitWrite({session, task: fresh, spec: normalizeGoalSpec(fresh.goal_spec),
      capability: 'media.add', args: {plate_id: 'plate-02', row_id: 'B', reservoir_id: 'media-01',
        volume_ul_per_well: 50}, reason: 'scope', turnGoalRevision: fresh.goal_revision,
      generation: sessions.getSession(session.session_id)!.owner_generation});
    assert.equal(outOfScope.ok, false);
    assert.equal(outOfScope.error?.code, 'out_of_scope');

    // 5. archived sessions lose write capability entirely
    sessions.archiveSession(session.session_id, 'test reset');
    const archived = await executor.submitWrite({session, task: fresh, spec: normalizeGoalSpec(fresh.goal_spec),
      capability: 'imaging.scan', args: {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'},
      reason: 'archived', turnGoalRevision: fresh.goal_revision,
      generation: sessions.getSession(session.session_id)!.owner_generation});
    assert.equal(archived.ok, false);
    assert.equal(archived.error?.code, 'session_archived');
    store.close();
  } finally {
    await runtime.stop();
    try {rmSync(dir, {recursive: true, force: true});} catch { /* ignore */ }
  }
});

test('accepted-response loss resolves by idempotency key; no second liquid', {timeout: 120_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const stub = await startModelStub();
  const dir = mkdtempSync(join(tmpdir(), 'oscar-loss-'));
  let agent: CultureAgent | null = null;
  let store: AgentStore | null = null;
  try {
    const loss = acceptedResponseLossFetch(fetch, 1); // drop the FIRST accepted submit response
    process.env.OSCAR_MODEL_BASE_URL = `http://127.0.0.1:${stub.port}/v1`;
    process.env.OSCAR_MODEL_API_KEY = 'stub-key';
    process.env.OSCAR_MODEL_NAME = 'oscar-stub';
    store = new AgentStore(dir);
    agent = new CultureAgent({config: {port: 0, dataDir: dir, runtimeUrl: runtime.baseUrl, repoRoot: process.cwd(),
      decisionDelayMs: null}, getServiceToken: () => runtime.serviceToken, store, fetchImpl: loss.fetch,
      log: () => undefined});
    const port = await agent.listen(0, '127.0.0.1');
    const api = new AgentApiClient(`http://127.0.0.1:${port}`, runtime.serviceToken);
    const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});

    const created0 = await api.post<{session: {session_id: string}}>('/sessions', {experiment_id: experimentId});
    await api.post<{task: {task_id: string}}>(`/sessions/${created0.session.session_id}/tasks`,
      {goal_text: 'keep row A', goal_spec: goalSpec(358)}); // below initial min → immediate maintenance
    const session = created0.session;
    // wait until at least one maintenance was submitted and verified
    await waitFor(async () => {
      const s = await api.get<{task: {status: string; budget: {actions_used: number}}}>(`/sessions/${session.session_id}/status`);
      return (s.task?.budget.actions_used ?? 0) >= 2 ? s : null;
    }, {timeoutMs: 60_000, label: 'maintenance submitted'});
    assert.equal(loss.dropped(), 1, 'exactly one response was dropped');
    await sleep(1500);
    // by-key resolution: the intent got its action; exactly ONE media.add on the device
    const {total, byKey} = await countServiceActions(operator, experimentId);
    assert.ok(total >= 2, `expected scan+maintenance, got ${total}`);
    const keys = [...byKey.keys()].filter(Boolean);
    assert.equal(new Set(keys).size, keys.length, 'idempotency keys unique');
    const {actions} = await operator.actions(experimentId);
    const adds = actions.filter(a => a.principal.kind === 'service' && a.capability === 'media.add');
    assert.equal(adds.length, 1, `exactly one media.add (got ${adds.length}) — no duplicate after response loss`);
    assert.ok(adds[0].idempotency_key, 'recovered action carries the original key');
  } finally {
    delete process.env.OSCAR_MODEL_BASE_URL;
    delete process.env.OSCAR_MODEL_API_KEY;
    delete process.env.OSCAR_MODEL_NAME;
    await agent?.close();
    store?.close();
    await stub.close();
    await runtime.stop();
    try {rmSync(dir, {recursive: true, force: true});} catch { /* ignore */ }
  }
});

test('agent SIGKILL + restart: session resumes, no duplicate maintenance, budget survives', {timeout: 150_000}, async () => {
  const stub = await startModelStub();
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  let agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const createdS = await api.post<{session: {session_id: string}}>('/sessions', {experiment_id: experimentId});
    const taskS = await api.post<{task: {task_id: string}}>(`/sessions/${createdS.session.session_id}/tasks`,
      {goal_text: 'keep row A', goal_spec: goalSpec(358)});
    const session = createdS.session;
    const task = taskS.task;
    // wait for the first maintenance, then SIGKILL the agent mid-monitoring
    await waitFor(async () => {
      const s = await api.get<{task: {budget: {actions_used: number}}}>(`/sessions/${session.session_id}/status`);
      return (s.task?.budget.actions_used ?? 0) >= 2 ? s : null;
    }, {timeoutMs: 60_000, label: 'first maintenance'});
    agent.kill9();
    await sleep(500);
    const before = await countServiceActions(operator, experimentId);

    // restart on the same data dir: session must resume the SAME conversation
    agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
    const api2 = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
    const sessions = await api2.get<{sessions: Array<{session_id: string}>}>('/sessions');
    assert.ok(sessions.sessions.some(s => s.session_id === session.session_id), 'session survived the restart');
    const detail = await api2.get<{messages: unknown[]}>(`/sessions/${session.session_id}`);
    assert.ok(detail.messages.length >= 2, 'conversation history intact');
    // let it run to the deadline; conservation must hold throughout
    await waitFor(async () => {
      const t = await api2.get<{task: {status: string} | null}>(`/tasks/${task.task_id}`);
      return t.task?.status === 'completed' ? t : null;
    }, {timeoutMs: 90_000, label: 'task completion after restart'});
    const after = await countServiceActions(operator, experimentId);
    assert.ok(after.total >= before.total, 'actions continued');
    const {actions} = await operator.actions(experimentId);
    const keys = actions.filter(a => a.principal.kind === 'service').map(a => a.idempotency_key ?? '');
    assert.equal(new Set(keys).size, keys.length, 'no duplicate idempotency keys across the restart');
    const adds = actions.filter(a => a.capability === 'media.add' && a.principal.kind === 'service');
    for (const a of adds) assert.equal(a.status, 'succeeded');
    // conservation: media.add volumes match reservoir delta exactly
    const finalState = await operator.state(experimentId);
    let reservoirUsed = 0;
    for (const a of adds) reservoirUsed += Math.abs(a.summary.reservoir_delta_ul);
    const remaining = finalState.reservoirs.find(r => r.id === 'media-01')!.remaining_ul;
    assert.ok(Math.abs(50_000 - reservoirUsed - remaining) <= 1,
      `reservoir conservation after restart: used ${reservoirUsed}, remaining ${remaining}`);
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop();
    await stub.close();
  }
});

test('runtime SIGKILL + restart: agent reconnects, catches up missed events, no double submit', {timeout: 150_000}, async () => {
  const stub = await startModelStub();
  const fixedPort = 20_000 + Math.floor(Math.random() * 20_000);
  const runtime = await spawnRuntimeProc({clockMode: 'realtime', port: fixedPort});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const createdR = await api.post<{session: {session_id: string}}>('/sessions', {experiment_id: experimentId});
    const session = createdR.session;
    await api.post(`/sessions/${session.session_id}/tasks`, {goal_text: 'keep row A', goal_spec: goalSpec(358)});
    await waitFor(async () => {
      const s = await api.get<{task: {budget: {actions_used: number}}}>(`/sessions/${session.session_id}/status`);
      return (s.task?.budget.actions_used ?? 0) >= 2 ? s : null;
    }, {timeoutMs: 60_000, label: 'first maintenance'});

    // SIGKILL the RUNTIME (device) while the agent keeps waiting
    runtime.kill9();
    await sleep(1500);
    const statusWhileDown = await api.get<{device: {reachable: boolean}}>(`/sessions/${session.session_id}/status`);
    assert.equal(statusWhileDown.device.reachable, false, 'device reported unreachable');

    // restart the runtime on the same data dir + SAME port; the experiment survives
    const rt2 = await spawnRuntimeProc({clockMode: 'realtime', dataDir: runtime.dataDir, port: fixedPort});
    try {
      const op0 = new DeviceClient({baseUrl: rt2.baseUrl, token: rt2.operatorToken, timeoutMs: 15_000});
      const st = await op0.state(experimentId);
      if (st.experiment.paused) await op0.control(experimentId, {resume: true});
      await waitFor(async () => {
        const s = await api.get<{device: {reachable: boolean}}>(`/sessions/${session.session_id}/status`);
        return s.device.reachable ? s : null;
      }, {timeoutMs: 30_000, label: 'device reachable again'});
      // the scheduler catches up on missed events and finishes the window
      const tasks = await api.get<{tasks: Array<{task_id: string}>}>(`/sessions/${session.session_id}/tasks`);
      await waitFor(async () => {
        const t = await api.get<{task: {status: string} | null}>(`/tasks/${tasks.tasks[0].task_id}`);
        return t.task?.status === 'completed' ? t : null;
      }, {timeoutMs: 90_000, label: 'completion after runtime restart'});
      const op2 = new DeviceClient({baseUrl: rt2.baseUrl, token: rt2.operatorToken, timeoutMs: 15_000});
      const {actions} = await op2.actions(experimentId);
      const keys = actions.filter(a => a.principal.kind === 'service').map(a => a.idempotency_key ?? '');
      assert.equal(new Set(keys).size, keys.length, 'no duplicate submissions across the runtime restart');
    } finally {
      await rt2.stop();
    }
  } finally {
    await agent.stop();
    try {await runtime.stop();} catch { /* already dead */ }
    await stub.close();
  }
});

test('archive isolation: reset archives the session; old session read-only, new experiment gets a new session', {timeout: 120_000}, async () => {
  const stub = await startModelStub();
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const createdA = await api.post<{session: {session_id: string}}>('/sessions', {experiment_id: experimentId});
    const session = createdA.session;
    await api.post(`/sessions/${session.session_id}/tasks`, {goal_text: 'keep row A', goal_spec: goalSpec(358)});
    await waitFor(async () => {
      const s = await api.get<{task: {budget: {actions_used: number}}}>(`/sessions/${session.session_id}/status`);
      return (s.task?.budget.actions_used ?? 0) >= 1 ? s : null;
    }, {timeoutMs: 60_000, label: 'first action'});

    // reset: old experiment archives, successor created
    await operator.control(experimentId, {reset: {}});
    await waitFor(async () => {
      const s = await api.get<{session: {lifecycle: string}}>(`/sessions/${session.session_id}/status`);
      return s.session.lifecycle === 'archived' ? s : null;
    }, {timeoutMs: 20_000, label: 'old session archived'});

    // old session is read-only
    const write = await api.post(`/sessions/${session.session_id}/messages`, {content: 'hello?'})
      .catch((e: unknown) => e) as {code?: string};
    assert.equal(write.code, 'session_archived', 'messages refused on archived session');
    const read = await api.get<{messages: unknown[]}>(`/sessions/${session.session_id}`);
    assert.ok(read.messages.length >= 1, 'archived session still readable');

    // new experiment → new session, distinct id and no cross-reading
    const created = await api.post<{session: {session_id: string}; created: boolean}>('/sessions', {});
    assert.equal(created.created, true);
    assert.notEqual(created.session.session_id, session.session_id);
    const fresh = await api.get<{messages: unknown[]}>(`/sessions/${created.session.session_id}`);
    assert.equal(fresh.messages.length, 0, 'new session starts empty — no cross-session leakage');
  } finally {
    await agent.stop();
    await runtime.stop();
    await stub.close();
  }
});

test('forced compaction keeps plan/evidence/constraints in the model context', {timeout: 120_000}, async () => {
  const stub = await startModelStub();
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const createdC = await api.post<{session: {session_id: string}}>('/sessions', {experiment_id: experimentId});
    const session = createdC.session;
    await api.post(`/sessions/${session.session_id}/tasks`, {goal_text: 'keep row A ≥ 358', goal_spec: goalSpec(358)});
    await waitFor(async () => {
      const s = await api.get<{task: {budget: {actions_used: number}}}>(`/sessions/${session.session_id}/status`);
      return (s.task?.budget.actions_used ?? 0) >= 2 ? s : null;
    }, {timeoutMs: 60_000, label: 'maintenance done'});

    // force compaction (test hook; the scheduler compacts automatically at a
    // higher threshold) — raw messages must remain stored
    const before = await api.get<{messages: unknown[]}>(`/sessions/${session.session_id}`);
    const compacted = await api.post<{compacted: boolean; generation: number}>(`/sessions/${session.session_id}/compact`, {});
    assert.equal(compacted.compacted, true);
    const after = await api.get<{messages: unknown[]}>(`/sessions/${session.session_id}`);
    assert.equal(after.messages.length, before.messages.length, 'compaction never deletes raw messages');
    const memory = await api.get<{checkpoint: {summary: string} | null}>(`/sessions/${session.session_id}/memory`);
    assert.ok(memory.checkpoint, 'checkpoint exists');
    assert.ok(memory.checkpoint!.summary.includes('Task goal'), 'checkpoint keeps the goal/constraints');

    // the next model turn carries the checkpoint summary; unfinished plan and
    // evidence remain visible to the model
    const requestsBefore = stub.requests().length;
    await api.post(`/sessions/${session.session_id}/messages`, {content: '继续监测直到期限。', request_id: 'post-compact'});
    await waitFor(() => {
      const reqs = stub.requests();
      return reqs.length > requestsBefore ? reqs.at(-1) : null;
    }, {timeoutMs: 30_000, label: 'next model request after compaction'});
    const last = stub.requests().at(-1)!;
    assert.ok(last.roles.includes('system'), 'system prompt present');
    assert.ok(last.tools.length >= 3, 'tools still offered after compaction');
  } finally {
    await agent.stop();
    await runtime.stop();
    await stub.close();
  }
});

test('no model configured: visible model_unavailable, no scripted fallback', {timeout: 60_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl,
    env: {OSCAR_MODEL_BASE_URL: '', OSCAR_MODEL_API_KEY: '', OSCAR_MODEL_NAME: ''}});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    const createdU = await api.post<{session: {session_id: string}}>('/sessions', {experiment_id: experimentId});
    const session = createdU.session;
    await api.post(`/sessions/${session.session_id}/tasks`, {goal_text: 'keep row A', goal_spec: goalSpec()});
    await sleep(1500);
    const status = await api.get<{loop: {state: string}; model: {configured: boolean}}>(`/sessions/${session.session_id}/status`);
    assert.equal(status.model.configured, false);
    assert.equal(status.loop.state, 'unavailable', `loop reports unavailable (got ${status.loop.state})`);
    const events = await api.get<{events: Array<{type: string}>}>(`/sessions/${session.session_id}/events?format=json`);
    assert.ok(events.events.some(e => e.type === 'model.unavailable'), 'model.unavailable emitted');
    // and absolutely no device actions happened
    const {actions} = await operator.actions(experimentId);
    assert.equal(actions.filter(a => a.principal.kind === 'service').length, 0, 'no device writes without a model');
  } finally {
    await agent.stop();
    await runtime.stop();
  }
});
