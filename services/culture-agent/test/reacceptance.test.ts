// Regression for the independent reacceptance findings R01–R04
// (reports/review/long-lived-reacceptance.md), ported from
// reports/review/long-lived-reacceptance-reproduce.mjs onto real Runtime
// processes with gates (never sleeps) for every race window.
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '@oscar/device-contract';
import {AgentStore} from '../src/store.ts';
import {SessionStore} from '../src/session-store.ts';
import {SessionManager} from '../src/session-manager.ts';
import {SessionExecutor} from '../src/executor.ts';
import {normalizeGoalSpec} from '../src/goal.ts';
import type {AgentBackend, TurnOutput} from '../src/backend.ts';
import {spawnRuntimeProc, sleep, waitFor} from './procs.ts';

const spec = normalizeGoalSpec({description: 'reaccept scan row A', scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', value: 330}], allowed_operations: ['imaging.scan']});
const scanArgs = {plate_id: 'plate-01', wells: ['A1'], mode: 'mono'};

function output(): TurnOutput {
  return {ok: true, assistantText: 'reaccept ack', toolLog: [], usage: {requests: 1, inputTokens: 0, outputTokens: 0},
    effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null, goalUpdated: null,
      planUpdated: false, stopRequested: false}};
}

function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(r => {resolve = r;});
  return {promise, resolve};
}

function explicitBackend(runTurn: AgentBackend['runTurn']): AgentBackend {
  return {id: 'explicit-reaccept-backend', available: () => ({ok: true}),
    capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}),
    runTurn, compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => undefined};
}

let runtime: Awaited<ReturnType<typeof spawnRuntimeProc>>;
let client: DeviceClient;
let operator: DeviceClient;
let experimentId: string;
let instanceId: string;
const contexts: Array<{dir: string; agentStore: AgentStore; manager: SessionManager | null}> = [];

before(async () => {
  runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken, timeoutMs: 20_000});
  operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 20_000});
  experimentId = await operator.currentExperimentId();
  await operator.control(experimentId, {speed: 100});
  instanceId = ((await client.health()) as {instance_id?: string}).instance_id ?? 'rt-reaccept';
}, {timeout: 60_000});

after(async () => {
  for (const c of contexts) {
    if (c.manager) await c.manager.stopAll();
    c.agentStore.close();
    rmSync(c.dir, {recursive: true, force: true});
  }
  await runtime.stop();
});

function context(): {dir: string; agentStore: AgentStore; store: SessionStore; manager: SessionManager | null;
  session: ReturnType<SessionStore['createSession']>; task: ReturnType<SessionStore['createTask']>} {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-reaccept-reg-'));
  const agentStore = new AgentStore(dir);
  const store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: instanceId, experiment_id: experimentId});
  const task = store.createTask(session.session_id, {goal_text: 'reaccept scan', goal_spec: spec as unknown as Record<string, unknown>});
  const c = {dir, agentStore, store, manager: null as SessionManager | null, session, task};
  contexts.push(c);
  return c;
}

async function serviceAdds(): Promise<number> {
  const {actions} = await client.actions(experimentId);
  return actions.filter(a => a.principal.kind === 'service').length;
}

async function settle(actionId: string): Promise<void> {
  await waitFor(async () => {
    const a = await client.action(experimentId, actionId);
    return ['succeeded', 'failed', 'cancelled'].includes(a.status) ? a : null;
  }, {timeoutMs: 20_000, label: `action ${actionId} terminal`});
}

async function start(c: ReturnType<typeof context>): Promise<NonNullable<ReturnType<SessionManager['ensureScheduler']>>> {
  const scheduler = c.manager!.ensureScheduler(c.store.getSession(c.session.session_id)!);
  await waitFor(() => c.store.getSession(c.session.session_id)!.loop_state !== 'recovering' ? true : null,
    {timeoutMs: 10_000, label: 'scheduler recovered'});
  return scheduler!;
}

// R01 — a revocation that lands while the executor's fresh state read is in
// flight must refuse the submit (zero new Runtime actions), for every fence.
test('reacceptance R01: revocation during the async state read refuses the write', {timeout: 180_000}, async () => {
  for (const change of ['agent_pause', 'executor_close', 'task_cancel', 'task_pause', 'goal_edit', 'owner_change', 'archive']) {
    const c = context();
    const generation = c.store.claimOwnership(c.session.session_id);
    const entered = deferred();
    const release = deferred();
    const proxy = new Proxy(client, {
      get(target, prop) {
        if (prop === 'state') {
          return async (...args: Parameters<DeviceClient['state']>) => {
            const snapshot = await (target.state as (...a: unknown[]) => Promise<unknown>)(...args);
            entered.resolve();
            await release.promise;
            return snapshot;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const executor = new SessionExecutor({store: c.store, client: proxy as DeviceClient, emit: () => undefined, log: () => undefined});
    const before = await serviceAdds();
    const pending = executor.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
      args: scanArgs, turnGoalRevision: 1, generation});
    await entered.promise;
    if (change === 'agent_pause') c.store.updateSession(c.session.session_id, {agent_paused: true});
    if (change === 'executor_close') executor.close();
    if (change === 'task_cancel') c.store.updateTaskStatus(c.task.task_id, 'cancelled');
    if (change === 'task_pause') c.store.updateTaskStatus(c.task.task_id, 'paused');
    if (change === 'goal_edit') c.store.updateTaskGoal(c.task.task_id, {expected_revision: 1, goal_text: 'changed goal'});
    if (change === 'owner_change') c.store.claimOwnership(c.session.session_id);
    if (change === 'archive') c.store.archiveSession(c.session.session_id, 'reacceptance');
    release.resolve();
    const r = await pending;
    const added = (await serviceAdds()) - before;
    assert.equal(r.ok, false, `${change}: submit must be refused`);
    assert.equal(r.error?.retryable, false);
    assert.equal(added, 0, `${change}: no new Runtime action may appear`);
    assert.equal(c.store.pendingSessionIntents(c.session.session_id).length, 0, `${change}: no intent may be created`);
  }
});

// R02 — an accepted-but-unbound old intent blocks a NEW key for another task;
// once the by-key lookup recovers, the old intent binds to its OWN task with
// exactly-once budget accounting and the new task may write.
test('reacceptance R02: unresolved previous-task intent blocks, then reconciles to its own task', {timeout: 180_000}, async () => {
  const c = context();
  const generation = c.store.claimOwnership(c.session.session_id);
  let loseAccepted = true;
  let lookupDown = true;
  let acceptedActionId = '';
  const proxy = new Proxy(client, {
    get(target, prop) {
      if (prop === 'actionByKey') {
        return async (...args: Parameters<DeviceClient['actionByKey']>) => {
          if (lookupDown) throw new Error('injected lookup unavailable');
          return (target.actionByKey as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      }
      if (prop === 'submit') {
        return async (...args: Parameters<DeviceClient['submit']>) => {
          const r = await (target.submit as (...a: unknown[]) => Promise<{action: {action_id: string}}>)
            .call(target, ...args) as {action: {action_id: string}};
          if (loseAccepted) {
            loseAccepted = false;
            acceptedActionId = r.action.action_id;
            throw new Error('injected accepted response loss');
          }
          return r;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const executor = new SessionExecutor({store: c.store, client: proxy as DeviceClient, emit: () => undefined, log: () => undefined});

  // 1. the accepted response is lost and the by-key lookup stays unavailable
  const first = await executor.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
    args: scanArgs, turnGoalRevision: 1, generation});
  assert.equal(first.ok, false);
  assert.ok(acceptedActionId, 'the first submit reached the Runtime before the response was dropped');
  await settle(acceptedActionId);
  const unresolved = c.store.unresolvedSessionIntents(c.session.session_id);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].task_id, c.task.task_id);
  assert.equal(unresolved[0].state, 'pending');

  // 2. a NEW task is admitted only into the QUEUE (N04: the cancelled task's
  // handoff — its still-unknown accepted effect — is pending), and a queued
  // task holds no execution rights: the write is refused without any intent
  c.store.updateTaskStatus(c.task.task_id, 'cancelled');
  const task2 = c.store.createTask(c.session.session_id, {goal_text: 'next scan', goal_spec: spec as unknown as Record<string, unknown>});
  assert.equal(task2.status, 'queued', 'N04: no ready birth while the previous task\'s handoff is pending');
  assert.equal(c.store.sessionHandoffPending(c.session.session_id), true);
  const before = await serviceAdds();
  const blocked = await executor.submitWrite({session: c.session, task: task2, spec, capability: 'imaging.scan',
    args: scanArgs, turnGoalRevision: 1, generation});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, 'task_queued', 'a queued task holds no execution rights');
  assert.equal(blocked.error?.retryable, false);
  assert.equal((await serviceAdds()) - before, 0, 'no second write while the old effect is unknown');
  assert.equal(c.store.pendingSessionIntents(c.session.session_id).filter(i => i.task_id === task2.task_id).length, 0,
    'the refused attempt must create no intent');
  assert.equal(c.store.unresolvedSessionIntents(c.session.session_id).length, 1,
    'the old accepted effect is still unresolved (the promotion barrier)');

  // 3. lookup recovers: the scheduler-equivalent barrier pass — the by-key
  // reconcile binds the old intent, the handoff clears and the queue head is
  // promoted; the new task's write then proceeds on its own key
  lookupDown = false;
  const resolvedCount = await executor.reconcileIntents(c.store.getSession(c.session.session_id)!);
  assert.equal(resolvedCount, 1, 'the old intent bound by the by-key lookup');
  assert.equal(c.store.clearSessionHandoff(c.session.session_id), true, 'barriers passed → handoff cleared');
  const promoted = c.store.promoteQueuedTask(c.session.session_id);
  assert.ok(promoted, 'the queue head is promoted once the handoff clears');
  assert.equal(promoted!.task_id, task2.task_id);
  const recovered = await executor.submitWrite({session: c.session, task: task2, spec, capability: 'imaging.scan',
    args: scanArgs, turnGoalRevision: 1, generation});
  assert.equal(recovered.ok, true, recovered.error?.message);
  const intents = c.store.listSessionIntents(c.session.session_id);
  const oldIntent = intents.find(i => i.task_id === c.task.task_id)!;
  assert.equal(oldIntent.action_id, acceptedActionId);
  assert.equal(oldIntent.state, 'bound');
  assert.equal(oldIntent.budget_counted, true);
  assert.equal(c.store.getTask(c.task.task_id)!.budget.actions_used, 1, 'exactly-once accounting on the owning task');
  const newIntent = intents.find(i => i.task_id === task2.task_id)!;
  assert.equal(newIntent.action_id, recovered.action!.action_id);
  assert.notEqual(newIntent.key, oldIntent.key);
  assert.equal(c.store.getTask(task2.task_id)!.budget.actions_used, 1);
  await settle(recovered.action!.action_id);
});

// R02 — a definitive "no action for this key" is a safe terminal: it does not
// block other tasks, and the identical re-plan still reuses the SAME key.
test('reacceptance R02: definitive not_accepted never blocks and keeps the same-key retry', {timeout: 120_000}, async () => {
  const c = context();
  const generation = c.store.claimOwnership(c.session.session_id);
  let submits = 0;
  const lossClient = new Proxy(client, {
    get(target, prop) {
      if (prop === 'submit') {
        return async (...args: Parameters<DeviceClient['submit']>) => {
          submits += 1;
          if (submits === 1) throw new TypeError('injected pre-send network failure');
          return (target.submit as (...a: unknown[]) => Promise<unknown>).call(target, ...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const executor = new SessionExecutor({store: c.store, client: lossClient as DeviceClient, emit: () => undefined, log: () => undefined});
  const failed = await executor.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
    args: scanArgs, turnGoalRevision: 1, generation});
  assert.equal(failed.ok, false);
  const notAccepted = c.store.pendingSessionIntents(c.session.session_id);
  assert.equal(notAccepted.length, 1);
  assert.equal(notAccepted[0].state, 'not_accepted');

  // the identical re-plan reuses the SAME key and succeeds
  const retried = await executor.submitWrite({session: c.session, task: c.task, spec, capability: 'imaging.scan',
    args: scanArgs, turnGoalRevision: 1, generation});
  assert.equal(retried.ok, true, retried.error?.message);
  const intents = c.store.listSessionIntents(c.session.session_id);
  assert.equal(intents.length, 1, 'same key, no second row');
  assert.equal(intents[0].key, notAccepted[0].key);
  assert.equal(intents[0].state, 'bound');
  await settle(retried.action!.action_id);

  // another task is NOT blocked by the terminal not_accepted outcome: with
  // the owning task terminal and its handoff cleared (a terminal not_accepted
  // intent is no promotion barrier), the next task is promoted and writes on
  // its own key — while QUEUED it correctly holds no execution rights (N04)
  c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'done with the first task');
  const task2 = c.store.createTask(c.session.session_id, {goal_text: 'unrelated', goal_spec: spec as unknown as Record<string, unknown>});
  assert.equal(task2.status, 'queued', 'N04: the terminal handoff queues the next arrival');
  const queuedWrite = await executor.submitWrite({session: c.session, task: task2, spec, capability: 'imaging.scan',
    args: {...scanArgs, wells: ['A2']}, turnGoalRevision: 1, generation});
  assert.equal(queuedWrite.ok, false, 'a queued task holds no execution rights');
  assert.equal(queuedWrite.error?.code, 'task_queued');
  assert.equal(c.store.clearSessionHandoff(c.session.session_id), true, 'no unresolved intent left → barrier passes');
  const promoted2 = c.store.promoteQueuedTask(c.session.session_id);
  assert.equal(promoted2!.task_id, task2.task_id);
  const other = await executor.submitWrite({session: c.session, task: task2, spec, capability: 'imaging.scan',
    args: {...scanArgs, wells: ['A2']}, turnGoalRevision: 1, generation});
  assert.equal(other.ok, true, other.error?.message);
  await settle(other.action!.action_id);
});

// R03 — a needs_input task whose parameters were completed in a turn gets
// exactly one follow-up decision; writes during the filling turn stay refused.
test('reacceptance R03: parameters completed mid-conversation continue without a second message', {timeout: 180_000}, async () => {
  const c = context();
  let calls = 0;
  let fillTurnWrite: {ok: boolean; error?: {code: string}} | null = null;
  let submitted: {ok: boolean; action?: {action_id: string}} | null = null;
  c.store.updateTaskGoal(c.task.task_id, {goal_spec: {...spec, metrics: [], missing_parameters: ['target volume']} as unknown as Record<string, unknown>});
  c.store.updateTaskStatus(c.task.task_id, 'needs_input', 'target volume');
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, log: () => undefined, backend: explicitBackend(async (input, host) => {
      calls += 1;
      if (calls === 1) {
        const before = await serviceAdds();
        fillTurnWrite = await host.submitWrite('imaging.scan', scanArgs, {});
        assert.equal(await serviceAdds(), before, 'a needs_input turn must not operate the device');
        const r = host.updateTaskGoal({expected_revision: input.task!.goal_revision, goal_spec: spec as unknown as Record<string, unknown>});
        assert.equal(r.ok, true);
      } else if (calls === 2) {
        submitted = await host.submitWrite('imaging.scan', scanArgs, {});
      }
      return output();
    })});
  const scheduler = await start(c);
  await sleep(200);
  assert.equal(calls, 0, 'recovery must not run a needs_input task');
  c.store.appendMessage(c.session.session_id, {role: 'user', content: 'target volume 330 µL'});
  scheduler.onUserMessage();
  await waitFor(() => c.store.sessionEventsAfter(c.session.session_id, 0, 1000).some(e => e.type === 'turn.completed')
    ? true : null, {timeoutMs: 10_000, label: 'parameter-filling turn completed'});
  await waitFor(() => submitted ? true : null, {timeoutMs: 15_000, label: 'follow-up turn submitted the scan'});
  assert.equal(fillTurnWrite!.ok, false);
  assert.equal(fillTurnWrite!.error?.code, 'task_paused', 'writes during the parameter-filling turn stay refused');
  assert.equal(submitted!.ok, true, 'the follow-up turn submits without another user message');
  assert.equal(c.store.getTask(c.task.task_id)!.status !== 'needs_input', true);
  assert.ok(submitted!.action);
  await settle(submitted!.action!.action_id);
  await c.manager.stopAll();
});

// R04 — a message persisted while a conversation turn is in flight is
// processed by exactly one further turn; the task-only queued path must not
// swallow it.
test('reacceptance R04: message queued during a turn is processed once', {timeout: 180_000}, async () => {
  const c = context();
  let calls = 0;
  let sawSecond = false;
  const entered = deferred();
  const release = deferred();
  c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'make room for chat');
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, log: () => undefined, backend: explicitBackend(async input => {
      calls += 1;
      sawSecond ||= input.history.some(m => m.content === 'SECOND MESSAGE');
      if (calls === 1) {entered.resolve(); await release.promise;}
      return output();
    })});
  const scheduler = await start(c);
  await sleep(200);
  c.store.appendMessage(c.session.session_id, {role: 'user', content: 'FIRST MESSAGE'});
  scheduler.onUserMessage();
  await entered.promise;
  c.store.appendMessage(c.session.session_id, {role: 'user', content: 'SECOND MESSAGE'});
  scheduler.onUserMessage();
  release.resolve();
  await waitFor(() => sawSecond ? true : null, {timeoutMs: 10_000, label: 'second message seen by the model'});
  await sleep(600);
  assert.equal(calls, 2, 'exactly one follow-up turn for the queued message');
  assert.equal(c.store.getSession(c.session.session_id)!.consumed_user_seq,
    c.store.listMessages(c.session.session_id).filter(m => m.role === 'user').at(-1)!.seq,
    'the watermark covers both user messages');
  await c.manager.stopAll();
});

// R04 — with the device unreachable, an unconsumed message must NOT spin the
// scheduler: bounded turn attempts with backoff, zero model calls, and the
// message is answered exactly once once the device returns.
test('reacceptance R04: unreachable device backs off instead of spinning, answers once on recovery', {timeout: 180_000}, async () => {
  const c = context();
  c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'no task for this chat');
  let deviceDown = true;
  const downFetch: typeof fetch = (async (input, init) => {
    if (deviceDown) throw new TypeError('fetch failed: ECONNREFUSED (injected)');
    return fetch(input, init);
  }) as typeof fetch;
  let calls = 0;
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, log: () => undefined, fetchImpl: downFetch,
    backend: explicitBackend(async () => {calls += 1; return output();})});
  const scheduler = await start(c);
  const unreachable = (): number => c.store.sessionEventsAfter(c.session.session_id, 0, 10_000)
    .filter(e => e.type === 'error' && (e.payload as {code?: string}).code === 'device_unreachable').length;
  c.store.appendMessage(c.session.session_id, {role: 'user', content: 'WHILE THE DEVICE IS DOWN'});
  scheduler.onUserMessage();
  await sleep(3000); // initial attempt + at most the 2 s retry inside the window
  const attempts = unreachable();
  assert.ok(attempts >= 1 && attempts <= 5, `bounded turn attempts while down (got ${attempts})`);
  assert.equal(calls, 0, 'no model call while the device is unreachable');
  deviceDown = false;
  await waitFor(() => c.store.listMessages(c.session.session_id).at(-1)?.role === 'assistant' ? true : null,
    {timeoutMs: 30_000, label: 'message answered after recovery'});
  assert.equal(calls, 1, 'the recovered message is answered exactly once');
  const message = c.store.listMessages(c.session.session_id).find(m => m.content === 'WHILE THE DEVICE IS DOWN')!;
  assert.equal(c.store.getSession(c.session.session_id)!.consumed_user_seq, message.seq);
  await sleep(800);
  assert.equal(calls, 1, 'no further turns after the message was consumed');
  await c.manager!.stopAll();
});

// R04 — a superseded-owner scheduler never re-calls the model in a loop for
// an unconsumed message, not even via the after-turn watermark retrigger.
test('reacceptance R04: superseded owner makes no model-call loop for an unconsumed message', {timeout: 180_000}, async () => {
  const c = context();
  c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'no task for this chat');
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, log: () => undefined, backend: explicitBackend(async () => {
      calls += 1;
      if (calls === 1) {entered.resolve(); await release.promise;}
      return output();
    })});
  const scheduler = await start(c);
  scheduler.onUserMessage(); // bare kick: one conversation turn
  await entered.promise;
  c.store.claimOwnership(c.session.session_id); // this scheduler is superseded
  c.store.appendMessage(c.session.session_id, {role: 'user', content: 'SUPERSEDED OWNER MESSAGE'});
  release.resolve(); // the stale turn ends: the watermark retrigger must be refused
  scheduler.onUserMessage();
  await sleep(1500);
  assert.ok(calls <= 1, `superseded owner must not loop model calls (got ${calls})`);
  assert.equal(c.store.getSession(c.session.session_id)!.consumed_user_seq, 0,
    'the stale turn consumed nothing');
  await c.manager!.stopAll();
});

// R01 (follow-up) — a submit that already passed the final revocation check
// when cancelTask lands is still bound and accounted: its accepted action
// gets a cancel request, the budget counts it exactly once, and the action
// and its result stay in the ledger.
test('reacceptance R01: cancel during an in-flight submit binds, is cancel-requested, counted once', {timeout: 180_000}, async () => {
  const c = context();
  const holdGate = deferred();
  let holding = false;
  const holdingFetch: typeof fetch = (async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && /\/api\/v1\/experiments\/[^/]+\/actions$/.test(url.split('?')[0]) && !holding) {
      holding = true;
      await holdGate.promise; // the Runtime HAS accepted; the response waits
    }
    return response;
  }) as typeof fetch;
  let calls = 0;
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, log: () => undefined, fetchImpl: holdingFetch,
    backend: explicitBackend(async (_input, host) => {
      calls += 1;
      await host.submitWrite('imaging.scan', scanArgs, {});
      return output();
    })});
  await operator.control(experimentId, {speed: 1}); // ~3 wall s per stage: the scan stays non-terminal
  try {
    const before = await serviceAdds();
    const scheduler = await start(c); // recovery turn submits the scan
    const accepted = await waitFor(async () => {
      const added = (await client.actions(experimentId)).actions
        .filter(a => a.principal.kind === 'service' && a.status !== undefined).length - before;
      return added >= 1 ? added : null;
    }, {timeoutMs: 15_000, label: 'held submit accepted by the Runtime'});
    assert.ok(accepted >= 1);
    const cancelling = scheduler.cancelTask(c.task.task_id);
    assert.equal(c.store.getTask(c.task.task_id)!.status, 'cancelled', 'write rights revoked immediately');
    holdGate.resolve();
    await cancelling;
    await waitFor(() => c.store.sessionEventsAfter(c.session.session_id, 0, 10_000)
      .some(e => e.type === 'action.cancel_requested') ? true : null,
      {timeoutMs: 10_000, label: 'late-bound action got a cancel request'});
    const intents = c.store.listSessionIntents(c.session.session_id);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].state, 'bound');
    assert.ok(intents[0].action_id);
    assert.equal(c.store.getTask(c.task.task_id)!.budget.actions_used, 1, 'budget counted exactly once');
    const cancelled = await waitFor(async () => {
      const a = await client.action(experimentId, intents[0].action_id!);
      return a.status === 'cancelled' ? a : null;
    }, {timeoutMs: 15_000, label: 'accepted action cancelled on the device'});
    assert.ok(cancelled);
    // the accepted effect stays in the ledger, never hidden
    const stillThere = (await client.actions(experimentId)).actions
      .some(a => a.action_id === intents[0].action_id);
    assert.ok(stillThere, 'the cancelled action remains in the action ledger');
    await c.manager!.stopAll();
  } finally {
    await operator.control(experimentId, {speed: 100});
    await c.manager!.stopAll().catch(() => undefined);
  }
});

// R04 — restart: an unconsumed user message is processed exactly once by the
// recovering scheduler; already-consumed messages never retrigger.
test('reacceptance R04: unconsumed message survives a restart exactly once', {timeout: 180_000}, async () => {
  const c = context();
  c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'no task for this chat');
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, log: () => undefined, backend: explicitBackend(async () => output())});
  await start(c);
  await c.manager.stopAll();
  c.manager = null;
  // the message arrives while NO scheduler owns the session
  const message = c.store.appendMessage(c.session.session_id, {role: 'user', content: 'UNCONSUMED ACROSS RESTART'});
  let calls = 0;
  let sawMessage = false;
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, log: () => undefined, backend: explicitBackend(async input => {
      calls += 1;
      sawMessage ||= input.history.some(m => m.content === 'UNCONSUMED ACROSS RESTART');
      return output();
    })});
  await start(c);
  await waitFor(() => sawMessage ? true : null, {timeoutMs: 10_000, label: 'recovery processed the message'});
  await waitFor(() => c.store.listMessages(c.session.session_id).at(-1)?.role === 'assistant' ? true : null,
    {timeoutMs: 10_000, label: 'assistant reply stored'});
  await sleep(700);
  assert.equal(calls, 1, 'exactly one message turn on recovery');
  assert.equal(c.store.getSession(c.session.session_id)!.consumed_user_seq, message.seq);
  await c.manager!.stopAll();
  c.manager = null;
  // a second restart must not re-process the consumed message
  let calls3 = 0;
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, log: () => undefined, backend: explicitBackend(async () => {
      calls3 += 1;
      return output();
    })});
  await start(c);
  await sleep(700);
  assert.equal(calls3, 0, 'consumed messages never retrigger after another restart');
  await c.manager!.stopAll();
});
