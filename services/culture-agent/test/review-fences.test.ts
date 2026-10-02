// Regression for the D1–D5 review fences (reports/review/long-lived-review.md).
// These assert the corrected behavior, not the original defects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ServerResponse} from 'node:http';
import {DeviceClient, DeviceError} from '@oscar/device-contract';
import type {StateSnapshot} from '@oscar/device-contract';
import {AgentStore} from '../src/store.ts';
import {SessionStore} from '../src/session-store.ts';
import {SessionManager} from '../src/session-manager.ts';
import {SessionExecutor} from '../src/executor.ts';
import {normalizeGoalSpec, scopeAllowsWrite} from '../src/goal.ts';
import {PiAgentBackend, buildSystemPrompt} from '../src/backend.ts';
import type {AgentBackend, TurnInput, TurnOutput} from '../src/backend.ts';
import {SessionApiRouter} from '../src/sessions-api.ts';
import type {RouteContext} from '../src/sessions-api.ts';
import {SupervisorApiRouter} from '../src/supervisor-api.ts';
import {makeSnapshot} from './helpers.ts';
import {spawnRuntimeProc, sleep, waitFor} from './procs.ts';
import {startModelStub} from './model-stub.ts';

const spec = normalizeGoalSpec({
  description: 'review row A',
  scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'}],
  allowed_operations: ['imaging.scan', 'media.add'],
  monitoring: {interval_sim_s: 21600},
});
const scanArgs = {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'};
const addArgs = {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 10};

function output(patch: Partial<TurnOutput['effects']> = {}): TurnOutput {
  return {ok: true, assistantText: 'review response', toolLog: [],
    effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null, goalUpdated: null,
      planUpdated: false, stopRequested: false, ...patch},
    usage: {requests: 1, inputTokens: 0, outputTokens: 0}};
}

function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(r => {resolve = r;});
  return {promise, resolve};
}

function explicitBackend(runTurn: AgentBackend['runTurn']): AgentBackend {
  return {id: 'explicit-review-backend', available: () => ({ok: true}),
    capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}),
    runTurn, compact: () => ({summary: 'Task goal', facts: [], open_questions: []}), close: async () => undefined};
}

test('goal scope rejects scan wells outside the authorized row', () => {
  const verdict = scopeAllowsWrite(spec, 'imaging.scan', {plate_id: 'plate-01', wells: ['B1'], mode: 'mono'});
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /B1/);
  assert.equal(scopeAllowsWrite(spec, 'imaging.scan', scanArgs).ok, true);
});

test('compaction keeps a user constraint across a second round and into the prompt', () => {
  const backend = new PiAgentBackend({});
  const line = '任何时候不要使用 media-02，只准 media-01。';
  const first = backend.compact({history: [{role: 'user', content: line}], task: null, facts: [], evidenceRefs: []});
  assert.match(first.summary, /media-01/);
  assert.ok(first.facts.some(f => f.includes('media-02') && f.startsWith('constraint:')));
  const second = backend.compact({
    history: [{role: 'user', content: '继续监测。'}],
    task: null, facts: ['imaging.scan act-1 [1]'], evidenceRefs: [],
    previous: {summary: first.summary, facts: first.facts, open_questions: ['下一步？']},
    plan: [{skill: 'scan_and_assess', status: 'pending'}],
    wakes: [{kind: 'sim_time', target_sim_s: 100, predicate: null}],
  });
  assert.match(second.summary, /media-01/);
  assert.ok(second.facts.some(f => f.includes('不要使用 media-02')));
  assert.ok(second.open_questions.some(q => q.includes('下一步')));
  const prompt = buildSystemPrompt({
    session: {session_id: 's', experiment_id: 'exp-001'} as TurnInput['session'],
    task: null, spec: null, wake: null, state: makeSnapshot('routine_maintenance', 1, [400, 400, 400, 400, 400, 400]),
    history: [], checkpointSummary: second.summary, checkpointFacts: second.facts,
    checkpointQuestions: second.open_questions, plan: [], deviceResults: [],
    budget: {actions_used: 0, max_actions: 1, model_turns_used: 0, max_model_turns: 1},
  }, 'stub');
  assert.match(prompt, /media-02/);
  assert.match(prompt, /propose_task/);
});

test('review fences: pause, stale turns, recovery, budget, scope, freshness', {timeout: 180_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 20_000});
  const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken, timeoutMs: 20_000});
  const exp = await operator.currentExperimentId();
  await operator.control(exp, {speed: 600});
  const health = await client.health() as {instance_id?: string};
  const instanceId = health.instance_id ?? 'rt-review';
  const contexts: Array<{dir: string; close: () => Promise<void>}> = [];

  function open(backend: AgentBackend, budget?: {max_model_turns?: number; max_actions?: number}) {
    const dir = mkdtempSync(join(tmpdir(), 'oscar-review-fence-'));
    const agentStore = new AgentStore(dir);
    const store = new SessionStore(agentStore.db);
    const session = store.createSession({runtime_instance_id: instanceId, experiment_id: exp});
    const task = store.createTask(session.session_id, {goal_text: 'review', goal_spec: spec as unknown as Record<string, unknown>, budget});
    const manager = new SessionManager({store, runtimeUrl: runtime.baseUrl, getServiceToken: () => runtime.serviceToken,
      backend, log: () => undefined});
    const router = new SessionApiRouter({manager, runtimeUrl: runtime.baseUrl, getServiceToken: () => runtime.serviceToken, log: () => undefined});
    const supervisor = new SupervisorApiRouter({manager, runtimeUrl: runtime.baseUrl, getServiceToken: () => runtime.serviceToken, log: () => undefined});
    const bag = {dir, agentStore, store, session, task, manager, router, supervisor};
    contexts.push({dir, close: async () => {await manager.stopAll(); agentStore.close(); rmSync(dir, {recursive: true, force: true});}});
    return bag;
  }
  async function start(c: ReturnType<typeof open>) {
    const scheduler = c.manager.ensureScheduler(c.store.getSession(c.session.session_id)!);
    await waitFor(() => c.store.getSession(c.session.session_id)!.loop_state !== 'recovering' ? true : null, {timeoutMs: 10_000, label: 'scheduler recovered'});
    return scheduler!;
  }
  async function serviceAdds(): Promise<number> {
    const {actions} = await client.actions(exp);
    return actions.filter(a => a.principal.kind === 'service').length;
  }
  function fakeRes(): {res: ServerResponse; status: () => number; json: () => Record<string, unknown>} {
    let status = 0; let raw = '';
    const res = {writeHead(code: number) {status = code;}, end(body?: string) {raw = body ?? '';}} as ServerResponse;
    return {res, status: () => status, json: () => raw ? JSON.parse(raw) as Record<string, unknown> : {}};
  }
  async function callRoute(run: (ctx: RouteContext) => Promise<boolean>, method: string, path: string, body: Record<string, unknown>) {
    const cap = fakeRes();
    const ctx = {method, path, body, res: cap.res, url: new URL('http://127.0.0.1' + path), req: {}} as RouteContext;
    try {
      await run(ctx);
      return {status: cap.status(), json: cap.json(), error: null as DeviceError | null};
    } catch (e) {
      if (e instanceof DeviceError) return {status: 0, json: {}, error: e};
      throw e;
    }
  }
  const callSession = (c: ReturnType<typeof open>, method: string, path: string, body: Record<string, unknown>) =>
    callRoute(ctx => path.startsWith('/tasks') ? c.router.handleTaskRoutes(ctx) : c.router.handle(ctx), method, path, body);
  const callSupervisor = (c: ReturnType<typeof open>, method: string, path: string, body: Record<string, unknown>) =>
    callRoute(ctx => c.supervisor.handle(ctx), method, path, body);

  try {
    // F01 — paused executor refuses before any device write.
    {
      const c = open(explicitBackend(async () => output()));
      const gen = c.store.claimOwnership(c.session.session_id);
      c.store.updateTaskStatus(c.task.task_id, 'running', 'test');
      c.store.updateSession(c.session.session_id, {agent_paused: true});
      const before = await serviceAdds();
      const executor = new SessionExecutor({store: c.store, client, emit: () => undefined, log: () => undefined});
      const refused = await executor.submitWrite({session: c.session, task: c.task, spec, capability: 'media.add', args: addArgs,
        turnGoalRevision: 1, generation: gen});
      assert.equal(refused.ok, false);
      assert.equal(refused.error?.code, 'agent_paused');
      assert.equal(await serviceAdds(), before);
      // task-level pause is refused the same way (agent itself unpaused)
      c.store.updateSession(c.session.session_id, {agent_paused: false});
      c.store.updateTaskStatus(c.task.task_id, 'paused', 'operator');
      const taskRefused = await executor.submitWrite({session: c.session, task: c.store.getTask(c.task.task_id)!,
        spec, capability: 'media.add', args: addArgs, turnGoalRevision: 1, generation: gen});
      assert.equal(taskRefused.ok, false);
      assert.equal(taskRefused.error?.code, 'task_paused');
      assert.equal(await serviceAdds(), before);
    }

    // F01 — stop closes the executor; a late tool submit adds no action.
    {
      const gate = deferred();
      let entered = false;
      let submit: {ok: boolean; error?: {code: string}} | null = null;
      const c = open(explicitBackend(async (_input, host) => {
        entered = true;
        await gate.promise;
        submit = await host.submitWrite('imaging.scan', scanArgs, {});
        return output();
      }));
      await start(c);
      await waitFor(() => entered ? true : null, {timeoutMs: 10_000, label: 'stop-path turn entered'});
      const before = await serviceAdds();
      const stopping = c.manager.stopAll();
      gate.resolve();
      await stopping;
      assert.equal(submit!.ok, false);
      assert.ok(submit!.error?.code === 'scheduler_stopped' || submit!.error?.code === 'stale_turn', submit!.error?.code);
      assert.equal(await serviceAdds(), before);
    }

    // F02 — a cancelled task stays cancelled when the old turn completes.
    {
      const gate = deferred();
      let entered = false;
      let n = 0;
      const c = open(explicitBackend(async () => {
        n += 1;
        if (n === 1) {entered = true; await gate.promise; return output({taskCompleted: {summary: 'old', evidence_refs: []}});}
        return output();
      }));
      const scheduler = await start(c);
      await waitFor(() => entered ? true : null, {timeoutMs: 10_000, label: 'cancel-path turn entered'});
      await scheduler.cancelTask(c.task.task_id);
      assert.equal(c.store.getTask(c.task.task_id)!.status, 'cancelled');
      gate.resolve();
      await sleep(400);
      assert.equal(c.store.getTask(c.task.task_id)!.status, 'cancelled');
      await c.manager.stopAll();
    }

    // F02 — an old turn cannot complete a goal the user already replaced.
    {
      const gate = deferred();
      let entered = false;
      let n = 0;
      const c = open(explicitBackend(async () => {
        n += 1;
        if (n === 1) {entered = true; await gate.promise; return output({taskCompleted: {summary: 'r1', evidence_refs: []}});}
        return output();
      }));
      await start(c);
      await waitFor(() => entered ? true : null, {timeoutMs: 10_000, label: 'goal-path turn entered'});
      const edited = c.store.updateTaskGoal(c.task.task_id, {expected_revision: 1, goal_text: 'r2 must stay open'});
      assert.equal(edited.ok, true);
      gate.resolve();
      await sleep(400);
      const task = c.store.getTask(c.task.task_id)!;
      assert.equal(task.goal_revision, 2);
      assert.notEqual(task.status, 'completed');
      await c.manager.stopAll();
    }

    // F04 — a ready task is resumed once on scheduler start, not left idle.
    {
      let calls = 0;
      const c = open(explicitBackend(async () => {calls += 1; return output();}));
      await start(c);
      await waitFor(() => calls >= 1 ? true : null, {timeoutMs: 10_000, label: 'recovery turn'});
      assert.notEqual(c.store.getTask(c.task.task_id)!.status, 'ready');
      await c.manager.stopAll();
    }

    // F04 — waiting_condition with NO armed wake (goal edit cancelled the
    // planning wakes, then the process died before the re-decision turn) also
    // gets the one recovery turn.
    {
      let calls = 0;
      const c = open(explicitBackend(async () => {calls += 1; return output();}));
      c.store.updateTaskStatus(c.task.task_id, 'waiting_condition', 'crashed mid-goal-edit');
      c.store.cancelPlanningWakes(c.session.session_id, c.task.task_id);
      assert.equal(c.store.armedWakes(c.session.session_id).length, 0);
      await start(c);
      await waitFor(() => calls >= 1 ? true : null, {timeoutMs: 10_000, label: 'wakeless recovery turn'});
      await c.manager.stopAll();
    }

    // F12 — model turns are reserved before the call and a restart cannot exceed the cap.
    {
      let calls = 0;
      const c = open(explicitBackend(async (_input, host) => {
        calls += 1;
        host.armWake({kind: 'sim_time', at_sim_s: 1e9, reason: 'review wait'});
        return output();
      }), {max_model_turns: 1});
      const scheduler = await start(c);
      await waitFor(() => c.store.getTask(c.task.task_id)!.budget.model_turns_used >= 1 ? true : null,
        {timeoutMs: 10_000, label: 'first reserved turn'});
      scheduler.onUserMessage();
      await waitFor(() => c.store.getTask(c.task.task_id)!.status === 'failed' ? true : null,
        {timeoutMs: 10_000, label: 'budget failure'});
      assert.equal(calls, 1);
      assert.equal(c.store.getTask(c.task.task_id)!.budget.model_turns_used, 1);
      assert.equal(c.store.getTask(c.task.task_id)!.reason, 'budget_exhausted');
      await c.manager.stopAll();
    }

    // F07 — creating an incomplete task does not clear needs_input or submit a write.
    {
      let calls = 0;
      const c = open(explicitBackend(async (_input, host) => {
        calls += 1;
        await host.submitWrite('media.add', addArgs, {});
        return output();
      }));
      c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'make room');
      await start(c);
      const before = await serviceAdds();
      const created = await callSession(c, 'POST', `/sessions/${c.session.session_id}/tasks`, {
        goal_text: 'incomplete',
        goal_spec: {description: 'missing target', scope: {plates: ['plate-01'], rows: ['A']}, allowed_operations: ['media.add']},
      });
      assert.equal(created.error, null);
      assert.equal(created.status, 201);
      const view = created.json.task as {status: string; task_id: string};
      assert.equal(view.status, 'needs_input');
      await sleep(500);
      assert.equal(calls, 0);
      assert.equal(c.store.getTask(view.task_id)!.status, 'needs_input');
      assert.equal(await serviceAdds(), before);
      await c.manager.stopAll();
    }

    // F08 — an HTTP goal edit cancels the old sim wait and schedules another turn.
    {
      let calls = 0;
      const c = open(explicitBackend(async (_input, host) => {
        calls += 1;
        host.armWake({kind: 'sim_time', at_sim_s: 1e9, reason: 'old goal wait'});
        return output();
      }));
      await start(c);
      await waitFor(() => calls >= 1 && c.store.armedWakes(c.session.session_id).some(w => w.kind === 'sim_time') ? true : null,
        {timeoutMs: 10_000, label: 'old wait armed'});
      const oldId = c.store.armedWakes(c.session.session_id).find(w => w.kind === 'sim_time')!.wake_id;
      const edited = await callSession(c, 'POST', `/tasks/${c.task.task_id}`,
        {expected_revision: c.store.getTask(c.task.task_id)!.goal_revision, goal_text: 'urgent new goal'});
      assert.equal(edited.error, null);
      assert.notEqual(c.store.getWake(oldId)!.status, 'armed');
      await waitFor(() => calls >= 2 ? true : null, {timeoutMs: 10_000, label: 'replanned after goal edit'});
      await c.manager.stopAll();
    }

    // F14 — request_id replay returns the original task; a different body conflicts; a second active task is still refused.
    {
      const c = open(explicitBackend(async () => output()));
      c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'make room');
      const body = {goal_text: 'idem', request_id: 'req-keep', goal_spec: {
        description: 'idempotent goal', scope: {plates: ['plate-01'], rows: ['A']},
        metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'}],
        allowed_operations: ['imaging.scan'], monitoring: {interval_sim_s: 60}}};
      const first = await callSession(c, 'POST', `/sessions/${c.session.session_id}/tasks`, body);
      assert.equal(first.status, 201);
      const taskId = (first.json.task as {task_id: string}).task_id;
      c.store.updateTaskStatus(taskId, 'completed', 'done');
      const replay = await callSession(c, 'POST', `/sessions/${c.session.session_id}/tasks`, body);
      assert.equal(replay.status, 200);
      assert.equal((replay.json.task as {task_id: string}).task_id, taskId);
      const resumed = await callSession(c, 'POST', `/tasks/${taskId}/control`, {action: 'resume'});
      assert.equal(resumed.error?.code, 'invalid_argument');
      const clash = await callSession(c, 'POST', `/sessions/${c.session.session_id}/tasks`,
        {...body, goal_text: 'different body'});
      assert.equal(clash.error?.code, 'idempotency_conflict');
      const sup = await callSupervisor(c, 'POST', `/supervisor/v1/sessions/${c.session.session_id}/tasks`,
        {...body, request_id: 'req-sup', delegated_principal: 'review'});
      assert.equal(sup.error, null);
      // R07: with the req-sup task now current, a DIFFERENT request_id no
      // longer gets task_already_active — it joins the FIFO queue instead.
      const again = await callSupervisor(c, 'POST', `/supervisor/v1/sessions/${c.session.session_id}/tasks`,
        {...body, request_id: 'req-other', delegated_principal: 'review'});
      assert.equal(again.error, null);
      assert.equal(again.status, 202);
      assert.equal((again.json as {status: string}).status, 'queued');
      assert.equal((again.json as {queue_position: number}).queue_position, 1);
      assert.equal(c.store.queuedTasks(c.session.session_id).length, 1);
      // pausing a queued task is refused with the dedicated code (cancel only)
      const queuedId = c.store.queuedTasks(c.session.session_id)[0].task_id;
      const pauseQueued = await callSession(c, 'POST', `/tasks/${queuedId}/control`, {action: 'pause'});
      assert.equal(pauseQueued.error?.code, 'task_queued');
      await c.manager.stopAll();
    }

    // F10 — archived sessions reject supervisor writes; a terminal task cannot be resumed.
    {
      const c = open(explicitBackend(async () => output()));
      c.store.archiveSession(c.session.session_id, 'explicit archive');
      const write = await callSupervisor(c, 'POST', `/supervisor/v1/tasks/${c.task.task_id}`,
        {expected_revision: 1, goal_text: 'should fail', delegated_principal: 'review'});
      assert.equal(write.error?.code, 'session_archived');
      const resumed = await callSupervisor(c, 'POST', `/supervisor/v1/tasks/${c.task.task_id}/control`,
        {action: 'resume', delegated_principal: 'review'});
      // archived is checked first
      assert.equal(resumed.error?.code, 'session_archived');
      await c.manager.stopAll();
    }

    // F15 + F06 — out-of-row scan is refused; a new task does not reuse a cancelled task's pending key.
    {
      const c = open(explicitBackend(async () => output()));
      const gen = c.store.claimOwnership(c.session.session_id);
      c.store.updateTaskStatus(c.task.task_id, 'running', 'test');
      const before = await serviceAdds();
      const executor = new SessionExecutor({store: c.store, client, emit: () => undefined, log: () => undefined});
      const outside = await executor.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
        args: {plate_id: 'plate-01', wells: ['B1'], mode: 'mono'}, turnGoalRevision: 1, generation: gen});
      assert.equal(outside.ok, false);
      assert.equal(outside.error?.code, 'out_of_scope');
      assert.equal(await serviceAdds(), before);

      const loss = {state: (id: string) => client.state(id),
        submit: async () => {throw new TypeError('injected pre-send network failure');},
        actionByKey: async () => null} as unknown as DeviceClient;
      const ex1 = new SessionExecutor({store: c.store, client: loss, emit: () => undefined, log: () => undefined});
      const failed = await ex1.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan', args: scanArgs,
        turnGoalRevision: 1, generation: gen});
      assert.equal(failed.ok, false);
      assert.equal(failed.error?.code, 'network');
      const pending = c.store.pendingSessionIntents(c.session.session_id);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].task_id, c.task.task_id);
      c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'operator');
      const t2 = c.store.createTask(c.session.session_id, {goal_text: 'independent', goal_spec: spec as unknown as Record<string, unknown>});
      c.store.updateTaskStatus(t2.task_id, 'running', 'test');
      const ex2 = new SessionExecutor({store: c.store, client, emit: () => undefined, log: () => undefined});
      const accepted = await ex2.submitWrite({session: c.session, task: t2, spec, capability: 'imaging.scan', args: scanArgs,
        turnGoalRevision: 1, generation: gen});
      assert.equal(accepted.ok, true, accepted.error?.message);
      await waitFor(async () => {
        const action = await client.action(exp, accepted.action!.action_id);
        return action.status === 'succeeded' || action.status === 'failed' ? action : null;
      }, {timeoutMs: 20_000, label: 'attribution scan finished'});
      const intents = c.store.listSessionIntents(c.session.session_id);
      const owned = intents.find(i => i.action_id === accepted.action!.action_id);
      assert.equal(owned?.task_id, t2.task_id);
      assert.notEqual(owned?.key, pending[0].key);
      assert.equal(intents.find(i => i.key === pending[0].key)?.action_id ?? null, null);
      await c.manager.stopAll();
    }

    // F05 — a liquid write decided against the turn-start revision is refused after a human add commits.
    {
      const gate = deferred();
      let entered = false;
      let submit: {ok: boolean; error?: {code: string}} | null = null;
      const c = open(explicitBackend(async (_input, host) => {
        entered = true;
        await gate.promise;
        submit = await host.submitWrite('media.add', addArgs, {evidence_refs: ['obs-stale-for-review']});
        return output();
      }));
      await start(c);
      await waitFor(() => entered ? true : null, {timeoutMs: 10_000, label: 'freshness turn entered'});
      const human = await operator.submit(exp, {capability: 'media.add', arguments: {...addArgs, volume_ul_per_well: 5}, basis: 'operator'});
      await waitFor(async () => {
        const action = await operator.action(exp, human.action.action_id);
        return action.status === 'succeeded' ? action : null;
      }, {timeoutMs: 20_000, label: 'operator add committed'});
      const before = await serviceAdds();
      gate.resolve();
      await waitFor(() => submit ? true : null, {timeoutMs: 10_000, label: 'stale liquid decision'});
      assert.equal(submit!.ok, false);
      assert.equal(submit!.error?.code, 'revision_conflict');
      assert.equal(await serviceAdds(), before);
      await c.manager.stopAll();
    }

    // F03 — an action-succeeded row left in 'received' is drained into a turn and marked processed.
    {
      let calls = 0;
      const c = open(explicitBackend(async () => {calls += 1; return output();}));
      c.store.updateTaskStatus(c.task.task_id, 'waiting_condition', 'holding');
      const scan = await client.submit(exp, {capability: 'imaging.scan', arguments: scanArgs});
      await waitFor(async () => {
        const action = await client.action(exp, scan.action.action_id);
        return action.status === 'succeeded' ? action : null;
      }, {timeoutMs: 20_000, label: 'scan succeeded'});
      c.store.insertSessionIntent({session_id: c.session.session_id, task_id: c.task.task_id, key: `review-scan-${c.task.task_id}`,
        capability: 'imaging.scan', canonical: '{}', goal_revision: 1});
      c.store.setSessionIntentAction(c.session.session_id, `review-scan-${c.task.task_id}`, scan.action.action_id);
      c.store.armWake({session_id: c.session.session_id, task_id: c.task.task_id, kind: 'action_terminal',
        predicate: {action_ids: [scan.action.action_id]}});
      const batch = await client.events(exp, 0, 10_000);
      for (const event of batch.events) {
        if (event.action_id === scan.action.action_id || event.payload.action_id === scan.action.action_id) {
          c.store.recordInbox(c.session.session_id, 'device', event.seq, event.type, event.payload);
        }
      }
      assert.equal(c.store.inboxByType(c.session.session_id, 'action.succeeded').at(-1)?.state, 'received');
      await start(c);
      await waitFor(() => calls >= 1 ? true : null, {timeoutMs: 10_000, label: 'drained terminal wake'});
      assert.equal(c.store.inboxByType(c.session.session_id, 'action.succeeded').at(-1)?.state, 'processed');
      assert.equal(c.store.armedWakes(c.session.session_id).some(w => w.kind === 'action_terminal'), false);
      await c.manager.stopAll();
    }

    // F05 read tool + F11 propose_task over the real pi tool protocol, two non-demo goals.
    {
      const stub = await startModelStub({decide: (messages, stats) => {
        const textOf = (m: {content?: unknown}): string => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        const blob = messages.map(textOf).join('\n');
        const chats = messages.filter(m => m.role === 'user' && !textOf(m).startsWith('WAKE:'));
        const latest = chats.length ? textOf(chats[chats.length - 1]) : '';
        if (messages.some(m => m.role === 'tool')) {stats.texts += 1; return {text: 'ack'};}
        if (latest.includes('PLEASE_READ')) {
          return {toolCalls: [{name: 'device_read_state', args: {}}]};
        }
        const hasTask = /ACTIVE TASK /.test(blob);
        if (!hasTask && latest.includes('腔室温度')) {
          return {toolCalls: [{name: 'propose_task', args: {goal_text: '保持腔室温度', goal_spec: {
            description: '保持腔室温度不低于 36°C',
            scope: {plates: ['plate-01'], rows: ['A']},
            metrics: [{metric: 'temperature_c', op: '>=', value: 36, source: 'chamber'}],
            allowed_operations: ['environment.set_targets'],
            monitoring: {conditions: [{metric: 'temperature_c', op: 'below', value: 36, debounce_sim_s: 60, hysteresis: 0.5, cooldown_sim_s: 600}]},
          }}}]};
        }
        if (!hasTask && latest.includes('B 排')) {
          return {toolCalls: [{name: 'propose_task', args: {goal_text: '维持 B 排液位', goal_spec: {
            description: '维持 plate-01 B 排各孔培养液 ≥ 400 µL',
            scope: {plates: ['plate-01'], rows: ['B']},
            metrics: [{metric: 'medium_volume_ul', op: '>=', value: 400, source: 'observation', row_id: 'B'}],
            allowed_operations: ['imaging.scan', 'media.add'],
            monitoring: {interval_sim_s: 3600},
          }}}]};
        }
        stats.texts += 1;
        return {text: 'ack'};
      }});
      try {
        const pi = new PiAgentBackend({OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
          OSCAR_MODEL_API_KEY: 'stub-key', OSCAR_MODEL_NAME: 'oscar-stub'});
        const live = makeSnapshot('routine_maintenance', 4242, [400, 400, 400, 400, 400, 400]);
        const c = open(pi);
        const session = c.session;
        const input: TurnInput = {session, task: null, spec: null, wake: {kind: 'message', reason: 'PLEASE_READ'},
          state: makeSnapshot('routine_maintenance', 1, [100, 100, 100, 100, 100, 100]),
          history: [{role: 'user', content: 'PLEASE_READ'}], checkpointSummary: null, plan: [], deviceResults: [],
          budget: {actions_used: 0, max_actions: 0, model_turns_used: 0, max_model_turns: 0}};
        let reads = 0;
        const readTurn = await pi.runTurn(input, {
          generation: 1,
          readState: async () => {reads += 1; return live;},
          createTask: async () => ({ok: false, code: 'unused', message: 'unused'}),
          submitWrite: async () => {throw new Error('read turn must not write');},
          armWake: () => {throw new Error('read turn must not arm');},
          updateTaskGoal: () => ({ok: false as const, conflict: {actual: 0}}),
          replacePlan: async () => ({ok: false as const, code: 'unused', problems: ['unused']}),
          updateStep: async () => ({ok: false as const, code: 'unused', message: 'unused'}),
          planGate: () => ({ok: true}),
          completeGate: async () => ({ok: true as const, evidence: {}}),
        }, new AbortController().signal);
        assert.equal(readTurn.ok, true, readTurn.error);
        assert.ok(reads >= 1, 'device_read_state must call host.readState');
        assert.ok(readTurn.toolLog.some(t => t.name === 'device_read_state' && t.summary.includes('sim_time=4242')));

        c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'chat starts empty');
        const before = await serviceAdds();
        await start(c);
        c.store.appendMessage(c.session.session_id, {role: 'user', content: '请把腔室温度维持在不低于 36°C，不要改培养液。'});
        c.manager.schedulerFor(c.session.session_id)!.onUserMessage();
        const temperature = await waitFor(() => {
          const task = c.store.listTasks(c.session.session_id).find(t => t.goal_text.includes('腔室温度') && t.status !== 'cancelled');
          return task ?? null;
        }, {timeoutMs: 20_000, label: 'temperature task'});
        assert.equal((temperature.goal_spec as {metrics: Array<{metric: string}>}).metrics[0].metric, 'temperature_c');
        await c.manager.schedulerFor(c.session.session_id)!.cancelTask(temperature.task_id);
        await waitFor(() => c.store.getTask(temperature.task_id)!.status === 'cancelled' ? true : null, {timeoutMs: 10_000, label: 'temperature cancelled'});
        c.store.appendMessage(c.session.session_id, {role: 'user', content: '上一任务结束了。请维持 B 排液位不低于 400 µL。'});
        c.manager.schedulerFor(c.session.session_id)!.onUserMessage();
        const rowB = await waitFor(() => {
          const task = c.store.listTasks(c.session.session_id).find(t => {
            const rows = (t.goal_spec.scope as {rows?: string[]} | undefined)?.rows ?? [];
            return rows.includes('B') && t.status !== 'cancelled';
          });
          return task ?? null;
        }, {timeoutMs: 20_000, label: 'row B task'});
        assert.equal((rowB.goal_spec as {metrics: Array<{value: number}>}).metrics[0].value, 400);
        assert.equal(await serviceAdds(), before, 'proposing a task must not itself operate the device');
        await c.manager.stopAll();
      } finally {
        await stub.close();
      }
    }
  } finally {
    for (const c of contexts) await c.close();
    await runtime.stop();
  }
});
