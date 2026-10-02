// N05 regression (reports/review/long-lived-r08-independent-review.md §N05):
// a transient error must never permanently suppress a device cancel. The
// cancel intent is persisted per action (session_intents.cancel_state
// none|requested|confirmed) and driven by a bounded-backoff state machine:
//   requested  — recorded durably BEFORE the attempt; any failure (GET or
//                POST network error, 5xx, response lost after acceptance)
//                leaves it retryable;
//   confirmed  — POST accepted, or the action is already terminal (the
//                Runtime answers a cancel of a terminal action with its
//                current state, so "already cancelled" is confirmation).
// Cases (real Runtime HTTP, isolated SQLite, injected fetch faults):
//   1. one GET failure then an explicit retry still reaches the device
//      (the oracle case: cancel_query_failure_does_not_suppress_retry);
//   2. a POST failure is retried by the AUTOMATIC backoff with no user
//      action at all;
//   3. a POST accepted whose response was lost: the retry sees the already
//      cancelled action, confirms WITHOUT a second POST and does not loop
//      errors;
//   4. a crash while 'requested' (automatic retries failing too): the
//      restart recovery delivers the cancel on the same persisted store;
//   plus idempotency: a confirmed cancel is never re-POSTed.
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '@oscar/device-contract';
import {AgentStore} from '../src/store.ts';
import {SessionStore} from '../src/session-store.ts';
import {SessionManager} from '../src/session-manager.ts';
import {normalizeGoalSpec} from '../src/goal.ts';
import type {AgentBackend, TurnOutput} from '../src/backend.ts';
import {spawnRuntimeProc, sleep, waitFor} from './procs.ts';

const spec = normalizeGoalSpec({description: 'cancel retry row A', scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', value: 330}], allowed_operations: ['imaging.scan']});

function output(): TurnOutput {
  return {ok: true, assistantText: 'cancel-retry ack', toolLog: [], usage: {requests: 1, inputTokens: 0, outputTokens: 0},
    effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null, goalUpdated: null,
      planUpdated: false, stopRequested: false}};
}

function backend(): AgentBackend {
  return {id: 'explicit-cancel-retry-backend', available: () => ({ok: true}),
    capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}),
    runTurn: async () => output(), compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => undefined};
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
  // speed 1: plate.shake 120 sim s stays non-terminal for ~120 wall s — a
  // stable in-flight action to cancel
  await operator.control(experimentId, {speed: 1});
  instanceId = ((await client.health()) as {instance_id?: string}).instance_id ?? 'rt-cancel-retry';
}, {timeout: 60_000});

after(async () => {
  for (const c of contexts) {
    if (c.manager) await c.manager.stopAll().catch(() => undefined);
    c.agentStore.close();
    rmSync(c.dir, {recursive: true, force: true});
  }
  await runtime.stop();
});

interface Case {
  dir: string;
  agentStore: AgentStore;
  store: SessionStore;
  sessionId: string;
  taskId: string;
  actionId: string;
  ctx: {dir: string; agentStore: AgentStore; manager: SessionManager | null};
  start(fetchImpl: typeof fetch): Promise<import('../src/scheduler.ts').SessionScheduler>;
}

/**
 * One case = one isolated store/session/task plus a REAL device action
 * (plate.shake, 120 sim s at speed 1) bound to the task through the same
 * ledger path production uses (intent row + accountIntent).
 */
async function setup(name: string): Promise<Case> {
  const dir = mkdtempSync(join(tmpdir(), `oscar-cancel-${name}-`));
  const agentStore = new AgentStore(dir);
  const store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: instanceId, experiment_id: experimentId});
  const task = store.createTask(session.session_id,
    {goal_text: 'cancel retry', goal_spec: spec as unknown as Record<string, unknown>});
  const action = await client.submit(experimentId, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 180, duration_sim_s: 120}});
  store.insertSessionIntent({session_id: session.session_id, task_id: task.task_id, key: `${name}-shake`,
    capability: 'plate.shake', canonical: '{}', goal_revision: 1});
  store.accountIntent(session.session_id, `${name}-shake`, action.action.action_id);
  const ctx = {dir, agentStore, manager: null as SessionManager | null};
  contexts.push(ctx);
  return {dir, agentStore, store, sessionId: session.session_id, taskId: task.task_id,
    actionId: action.action.action_id, ctx,
    start(fetchImpl) {
      const manager = new SessionManager({store, runtimeUrl: runtime.baseUrl,
        getServiceToken: () => runtime.serviceToken, backend: backend(), fetchImpl, log: () => undefined});
      ctx.manager = manager;
      return Promise.resolve(manager.ensureScheduler(store.getSession(session.session_id)!)!)
        .then(async scheduler => {
          await waitFor(() => store.getSession(session.session_id)!.loop_state !== 'recovering' ? true : null,
            {timeoutMs: 10_000, label: 'scheduler recovered'});
          return scheduler!;
        });
    }};
}

/** Session events of one case's store, filtered by type. */
function eventsOf(c: Case): Array<{type: string; payload: Record<string, unknown>}> {
  return c.store.sessionEventsAfter(c.sessionId, 0, 10_000)
    .filter(e => e.type === 'error' || e.type === 'action.cancel_requested');
}

test('cancel retry: transient action-read failure does not suppress an explicit retry (N05 oracle case)', {timeout: 120_000}, async () => {
  const c = await setup('read');
  let failRead = false;
  let cancelPosts = 0;
  const injectedFetch: typeof fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(`/actions/${c.actionId}/cancel`)) cancelPosts += 1;
    if (failRead && path.endsWith(`/actions/${c.actionId}`)) {
      failRead = false;
      throw new TypeError('injected transient action query error');
    }
    return fetch(url, init);
  }) as typeof fetch;
  const scheduler = await c.start(injectedFetch);
  try {
    failRead = true;
    await scheduler.cancelTask(c.taskId);
    assert.equal(c.store.getTask(c.taskId)!.status, 'cancelled', 'the task is cancelled regardless');
    const requested = c.store.intentsCancelRequested(c.sessionId);
    assert.equal(requested.length, 1, 'the failed attempt stays durably requested');
    assert.ok(requested[0].cancel_last_error, 'the failure is visible on the row');
    // lookup recovered: an EXPLICIT second cancel must re-attempt — the
    // in-memory dedupe may only suppress concurrent in-flight attempts
    await scheduler.cancelTask(c.taskId);
    const live = await waitFor(async () => {
      const a = await client.action(experimentId, c.actionId);
      return a.status === 'cancelled' ? a : null;
    }, {timeoutMs: 15_000, label: 'device action cancelled after explicit retry'});
    assert.ok(live);
    assert.ok(cancelPosts >= 1, `at least one cancel POST reached the device (got ${cancelPosts})`);
    // idempotency: a further explicit cancel never re-POSTs a confirmed cancel
    const postsBefore = cancelPosts;
    await scheduler.cancelTask(c.taskId);
    await sleep(1500); // past one backoff slot
    assert.equal(cancelPosts, postsBefore, 'a confirmed cancel is never re-POSTed');
    assert.equal(c.store.intentsCancelRequested(c.sessionId).length, 0);
  } finally {
    await operator.cancel(experimentId, c.actionId).catch(() => undefined);
    await c.ctx.manager?.stopAll().catch(() => undefined);
  }
});

test('cancel retry: POST failure is retried automatically without any user action', {timeout: 120_000}, async () => {
  const c = await setup('post');
  let failPosts = 1; // the first POST fails; everything after is healthy
  let cancelPosts = 0;
  const injectedFetch: typeof fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(`/actions/${c.actionId}/cancel`)) {
      if (failPosts > 0) {
        failPosts -= 1;
        throw new TypeError('injected cancel POST network failure');
      }
      cancelPosts += 1;
    }
    return fetch(url, init);
  }) as typeof fetch;
  const scheduler = await c.start(injectedFetch);
  try {
    await scheduler.cancelTask(c.taskId); // the only user action; its POST fails
    assert.equal(c.store.getTask(c.taskId)!.status, 'cancelled');
    assert.equal(c.store.intentsCancelRequested(c.sessionId).length, 1, 'still requested, not dropped');
    assert.ok(eventsOf(c).some(e => e.type === 'error' && (e.payload as {where?: string}).where === 'cancel'),
      'the failed attempt emitted a visible error');
    // NO further cancelTask call: the bounded backoff (1 s first slot) must
    // deliver the cancel on its own
    await waitFor(async () => {
      const a = await client.action(experimentId, c.actionId);
      return a.status === 'cancelled' ? a : null;
    }, {timeoutMs: 15_000, label: 'backoff retry cancelled the device action'});
    assert.ok(cancelPosts >= 1, 'the retry POST reached the device');
  } finally {
    await operator.cancel(experimentId, c.actionId).catch(() => undefined);
    await c.ctx.manager?.stopAll().catch(() => undefined);
  }
});

test('cancel retry: response lost after acceptance confirms via already-cancelled, no error loop', {timeout: 120_000}, async () => {
  const c = await setup('lost');
  let dropResponses = 1; // first POST reaches the device, its response is lost
  let cancelPosts = 0;
  const injectedFetch: typeof fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(`/actions/${c.actionId}/cancel`)) {
      cancelPosts += 1;
      const response = await fetch(url, init); // the Runtime HAS accepted the cancel
      if (dropResponses > 0) {
        dropResponses -= 1;
        throw new TypeError('injected response loss after cancel acceptance');
      }
      return response;
    }
    return fetch(url, init);
  }) as typeof fetch;
  const scheduler = await c.start(injectedFetch);
  try {
    await scheduler.cancelTask(c.taskId);
    await waitFor(async () => {
      const a = await client.action(experimentId, c.actionId);
      return a.status === 'cancelled' ? a : null;
    }, {timeoutMs: 15_000, label: 'device action cancelled (response was lost, effect was not)'});
    // the retry's GET sees the already-cancelled action and confirms WITHOUT
    // another POST — exactly one POST ever reached the device
    await sleep(2600); // past a further backoff slot: nothing may fire again
    assert.equal(cancelPosts, 1, `exactly one cancel POST (got ${cancelPosts})`);
    const cancelErrors = eventsOf(c).filter(e => (e.payload as {where?: string}).where === 'cancel').length;
    const exhausted = eventsOf(c).filter(e => (e.payload as {code?: string}).code === 'cancel_retry_exhausted').length;
    assert.equal(exhausted, 0, 'no retry-exhaustion loop for a lost response');
    await sleep(1200);
    assert.equal(eventsOf(c).filter(e => (e.payload as {where?: string}).where === 'cancel').length, cancelErrors,
      'the error stream is quiet after confirmation');
    assert.equal(c.store.intentsCancelRequested(c.sessionId).length, 0, 'confirmed, nothing left requested');
  } finally {
    await operator.cancel(experimentId, c.actionId).catch(() => undefined);
    await c.ctx.manager?.stopAll().catch(() => undefined);
  }
});

test('cancel retry: restart with a persisted requested entry delivers the cancel after recovery', {timeout: 120_000}, async () => {
  const c = await setup('restart');
  let failAllCancels = true;
  let cancelPosts = 0;
  const injectedFetch: typeof fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(`/actions/${c.actionId}/cancel`)) {
      if (failAllCancels) throw new TypeError('injected runtime cut off from the agent');
      cancelPosts += 1;
    }
    return fetch(url, init);
  }) as typeof fetch;
  const scheduler = await c.start(injectedFetch);
  await scheduler.cancelTask(c.taskId); // fails: 'requested' persists
  assert.equal(c.store.intentsCancelRequested(c.sessionId).length, 1);
  const liveBefore = await client.action(experimentId, c.actionId);
  assert.notEqual(liveBefore.status, 'cancelled', 'the device never saw a cancel yet');
  // crash: stop the whole manager (retry timer cleared, nothing in memory)
  await c.ctx.manager!.stopAll();
  c.ctx.manager = null;
  // recovery: the runtime link is healthy again; a NEW scheduler on the SAME
  // persisted store must re-attempt the requested cancel during recovery
  failAllCancels = false;
  await c.start(injectedFetch);
  await waitFor(async () => {
    const a = await client.action(experimentId, c.actionId);
    return a.status === 'cancelled' ? a : null;
  }, {timeoutMs: 15_000, label: 'cancel delivered after restart recovery'});
  assert.ok(cancelPosts >= 1, 'the restart recovery POSTed the cancel');
  assert.equal(c.store.intentsCancelRequested(c.sessionId).length, 0);
  await c.ctx.manager!.stopAll().catch(() => undefined);
  c.ctx.manager = null;
});
