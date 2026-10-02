// Trial defect regression (supervisor API): GET /supervisor/v1/tasks/:id used
// to return the BARE task row — no plan, so a delegating supervisor saw no
// execution evidence at all (the session API's GET /tasks/:id returns the
// plan with action ids and evidence refs), and the GET was missing from the
// contract self-description's operations list.
//
// Real processes end to end: Runtime + Culture Agent + HTTP model stub. The
// delegate's task detail must now expose the SAME persisted plan as the
// session API, including step action/evidence ids as the task executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startModelStub} from '../services/culture-agent/test/model-stub.ts';
import {AgentApiClient, spawnAgentProc, spawnRuntimeProc, waitFor} from '../services/culture-agent/test/procs.ts';

interface PlanStepView {index: number; skill: string; status: string; action_ids: string[]; evidence_refs: string[]}
interface TaskView {task_id: string; session_id: string; goal_text: string; goal_revision: number;
  status: string; reason: string | null; budget: {model_turns_used: number}; plan: PlanStepView[]}

const goalSpec = {
  description: '维持 plate-01 A 排各孔培养液 ≥ 358 µL（委托观察证据用）',
  scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', value: 358, source: 'observation', row_id: 'A'}],
  allowed_operations: ['imaging.scan', 'media.add'],
  monitoring: {interval_sim_s: 21_600},
  deadline_sim_s: 60_000,
  success: {description: 'window finished above threshold'},
  stop: {description: 'budget or cancel'},
};

test('supervisor GET /tasks/:id exposes the plan evidence (parity with the session API) and the self-description lists it', {timeout: 150_000}, async () => {
  const stub = await startModelStub();
  // pick the agent port up front so the runtime gateway can point at it
  const {createServer} = await import('node:http');
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const agentPort = (probe.address() as {port: number}).port;
  probe.close();
  const runtime = await spawnRuntimeProc({clockMode: 'realtime', agentUrl: `http://127.0.0.1:${agentPort}`});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, port: agentPort,
    env: {OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stub.port}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
      OSCAR_MODEL_NAME: 'oscar-stub'}});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const sup = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${runtime.baseUrl}/api/v1/agent/supervisor${path}`, {method,
      headers: {'content-type': 'application/json', authorization: `Bearer ${runtime.operatorToken}`},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const json = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${String(json.code ?? r.status)}: ${String(json.message ?? '')}`);
    return json as T;
  };
  try {
    // 1. the self-description must list the GET task operation
    const self = await sup<{operations: string[]}>('GET', '');
    assert.ok(Array.isArray(self.operations) && self.operations.includes('GET tasks/:id'),
      `operations must include the GET task entry (got ${JSON.stringify(self.operations)})`);

    // 2. delegate a maintenance task through the supervisor surface
    const session = await sup<{session_id: string}>('POST', '/v1/sessions',
      {delegated_principal: 'dsh-task-get-regression'});
    const submitted = await sup<{task_id: string; accepted: boolean}>('POST',
      `/v1/sessions/${encodeURIComponent(session.session_id)}/tasks`,
      {goal_text: '照看 A 排（GET 证据回归）', goal_spec: goalSpec, delegated_principal: 'dsh-task-get-regression'});
    assert.equal(submitted.accepted, true);
    const taskId = submitted.task_id;

    // 3. the delegated task detail must expose the model's persisted plan
    const withPlan = await waitFor(async () => {
      const {task} = await sup<{task: TaskView}>('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
      return task.plan.length >= 3 ? task : null;
    }, {timeoutMs: 60_000, label: 'supervisor task view carries the 3-step plan'});
    assert.equal(withPlan.task_id, taskId);
    assert.ok(withPlan.budget && typeof withPlan.budget.model_turns_used === 'number', 'budget visible to the delegate');
    for (const step of withPlan.plan) {
      assert.equal(typeof step.index, 'number', 'plan step index');
      assert.equal(typeof step.skill, 'string', 'plan step skill');
      assert.ok(['pending', 'running', 'done', 'failed', 'skipped'].includes(step.status), 'plan step status');
      assert.ok(Array.isArray(step.action_ids), 'plan step action_ids is an array');
      assert.ok(Array.isArray(step.evidence_refs), 'plan step evidence_refs is an array');
    }

    // 4. execution evidence accumulates on the SAME view (the scan binds to step 0)
    await waitFor(async () => {
      const {task} = await sup<{task: TaskView}>('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
      return task.plan.some(s => s.action_ids.length >= 1) ? task : null;
    }, {timeoutMs: 60_000, label: 'a plan step carries its action id evidence'});

    // 5. parity: the session API's GET /tasks/:id returns the same plan/fields
    const supervisorView = (await sup<{task: TaskView}>('GET', `/v1/tasks/${encodeURIComponent(taskId)}`)).task;
    const sessionView = (await api.get<{task: TaskView}>(`/tasks/${encodeURIComponent(taskId)}`)).task;
    assert.deepEqual(supervisorView.plan, sessionView.plan,
      'supervisor task detail must match the session API plan evidence exactly');
    for (const key of ['task_id', 'session_id', 'goal_revision', 'status', 'reason', 'budget'] as const) {
      assert.deepEqual(supervisorView[key], sessionView[key], `field parity: ${key}`);
    }
  } finally {
    await agent.stop();
    await runtime.stop();
    await stub.close();
  }
});
