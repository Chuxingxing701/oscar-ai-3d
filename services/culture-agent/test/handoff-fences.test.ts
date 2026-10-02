// Q01/Q02 regression (reports/review/long-lived-n05-independent-review.md §2).
//  Q01 — the N04 handoff barrier must treat a bound action whose terminal
//        state cannot be CONFIRMED (GET/query failure) as BLOCKING: unknown
//        must never read as "not in flight". maybePromoteNext keeps
//        sessions.handoff_pending, promotes nothing, and the watchdog tick
//        retries; EVERY bound intent of the session is checked (the last ten
//        are not a complete proof). Recovery: once queries succeed and the
//        old action is terminal — e.g. the persisted cancel_state 'requested'
//        delivered by an explicit cancel — the handoff clears, the queue head
//        promotes and the old action is cancelled (N05 stays intact).
//  Q02 — a task pause landing while runTurn awaits its decision-start Runtime
//        state read must survive: after the read the FULL revocation fence
//        re-runs (session lifecycle/owner/agent pause, task terminal/paused,
//        status allow-list) and ready→running is a conditional store CAS
//        (status='ready' AND goal_revision=?). A turn that loses exits with
//        zero device writes, no model call, no budget reservation and without
//        consuming the user-message watermark (R04).
// Real Runtime HTTP + isolated SQLite per case; faults are injected through
// the scheduler's fetchImpl only — the device itself stays healthy.
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
import type {SessionScheduler} from '../src/scheduler.ts';
import {spawnRuntimeProc, sleep, waitFor} from './procs.ts';

const spec = normalizeGoalSpec({description: 'handoff fence row A',
  scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', row_id: 'A', value: 330}],
  allowed_operations: ['imaging.scan', 'plate.shake']});
const scanArgs = {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'};
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

function output(): TurnOutput {
  return {ok: true, assistantText: 'handoff-fence ack', toolLog: [],
    usage: {requests: 1, inputTokens: 0, outputTokens: 0},
    effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null, goalUpdated: null,
      planUpdated: false, stopRequested: false}};
}

function explicitBackend(runTurn: AgentBackend['runTurn']): AgentBackend {
  return {id: 'explicit-handoff-fence-backend', available: () => ({ok: true}),
    capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}),
    runTurn, compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => undefined};
}

function gate(): {promise: Promise<void>; resolve: () => void} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(r => {resolve = r;});
  return {promise, resolve};
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
  // speed 1: the 120/100000 sim-s shakes stay non-terminal for the whole test
  await operator.control(experimentId, {speed: 1});
  instanceId = ((await client.health()) as {instance_id?: string}).instance_id ?? 'rt-handoff-fence';
}, {timeout: 60_000});

after(async () => {
  for (const c of contexts) {
    if (c.manager) await c.manager.stopAll().catch(() => undefined);
    c.agentStore.close();
    rmSync(c.dir, {recursive: true, force: true});
  }
  await runtime.stop();
});

/** One isolated store/session/current task, like the independent-review harness. */
function context() {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-handoff-fence-'));
  const agentStore = new AgentStore(dir);
  const store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: instanceId, experiment_id: experimentId});
  const task = store.createTask(session.session_id,
    {goal_text: 'handoff fence', goal_spec: spec as unknown as Record<string, unknown>});
  const c = {dir, agentStore, store, session, task, manager: null as SessionManager | null};
  contexts.push(c);
  return c;
}

function start(c: ReturnType<typeof context>, runTurn: AgentBackend['runTurn'],
  fetchImpl: typeof fetch = fetch): Promise<SessionScheduler> {
  c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken, backend: explicitBackend(runTurn), fetchImpl, log: () => undefined});
  const scheduler = c.manager.ensureScheduler(c.store.getSession(c.session.session_id)!);
  return waitFor(() => c.store.getSession(c.session.session_id)!.loop_state !== 'recovering' ? true : null,
    {timeoutMs: 10_000, label: 'scheduler recovered'}).then(() => scheduler!);
}

/** Bind a REAL device action to a task through the ledger path production uses. */
async function bindAction(c: ReturnType<typeof context>, taskId: string, key: string,
  capability: 'plate.shake' | 'imaging.scan', durationSimS = 120): Promise<string> {
  const submitted = await client.submit(experimentId, {capability,
    arguments: capability === 'plate.shake'
      ? {plate_id: 'plate-01', speed_rpm: 180, duration_sim_s: durationSimS}
      : scanArgs});
  const actionId = submitted.action.action_id;
  c.store.insertSessionIntent({session_id: c.session.session_id, task_id: taskId, key,
    capability, canonical: '{}', goal_revision: 1});
  c.store.accountIntent(c.session.session_id, key, actionId);
  return actionId;
}

async function terminalStatus(actionId: string): Promise<string> {
  return (await waitFor(async () => {
    const a = await client.action(experimentId, actionId);
    return TERMINAL.includes(a.status) ? a : null;
  }, {timeoutMs: 20_000, label: `action ${actionId} terminal`})).status;
}

function turnCompletedEvents(c: ReturnType<typeof context>) {
  return c.store.sessionEventsAfter(c.session.session_id, 0, 1000).filter(e => e.type === 'turn.completed');
}

// -- Q01 --------------------------------------------------------------------------

// The independent-review oracle case (unknown_action_status_blocks_handoff):
// task A is cancelled while its bound 120 s shake is still queued/running and
// ONLY that action's GET fails. The cancel intent correctly stays 'requested'
// — and the handoff must stay PENDING too: the queue head is neither promoted
// nor given a model turn until the old action's terminal state is CONFIRMED.
// Recovery (queries healthy again + explicit cancel): the handoff clears, the
// head promotes and runs, the old action is cancelled.
test('Q01: an unconfirmable action status blocks the handoff; recovery clears it, cancels the old action and promotes the head',
  {timeout: 180_000}, async () => {
    const c = context();
    const actionId = await bindAction(c, c.task.task_id, 'hf-q01-shake', 'plate.shake', 120);
    const next = c.store.createTask(c.session.session_id, {goal_text: 'next task',
      goal_spec: spec as unknown as Record<string, unknown>});
    assert.equal(next.status, 'queued');
    let failReads = false;
    let nextTurns = 0;
    const wrappedFetch: typeof fetch = async (url, init) => {
      if (failReads && new URL(String(url)).pathname.endsWith(`/actions/${actionId}`)) {
        throw new TypeError('injected temporary action-status outage');
      }
      return fetch(url, init);
    };
    const scheduler = await start(c, async input => {
      if (input.task?.task_id === next.task_id) nextTurns += 1;
      return output();
    }, wrappedFetch);
    try {
      failReads = true;
      await scheduler.cancelTask(c.task.task_id);
      assert.equal(c.store.getTask(c.task.task_id)!.status, 'cancelled');
      // N05 stays intact: the failed cancel attempt is durably requested
      const requested = c.store.intentsCancelRequested(c.session.session_id);
      assert.equal(requested.length, 1);
      assert.equal(requested[0].cancel_state, 'requested');
      assert.ok(requested[0].cancel_last_error, 'the query failure is visible on the row');
      assert.equal(c.store.getTask(next.task_id)!.status, 'queued',
        'unknown action status never grants the execution slot');
      assert.equal(c.store.sessionHandoffPending(c.session.session_id), true, 'the handoff marker stays set');
      assert.equal(nextTurns, 0, 'the model was never called for the queue head');
      // the barrier must hold across the watchdog's 5 s retries AND the
      // automatic cancel backoff — not just the first attempt in cancelTask
      await sleep(6500);
      assert.equal(c.store.getTask(next.task_id)!.status, 'queued', 'watchdog retries stay blocked while unknown');
      assert.equal(c.store.sessionHandoffPending(c.session.session_id), true);
      assert.equal(nextTurns, 0);
      assert.ok(!TERMINAL.includes((await client.action(experimentId, actionId)).status),
        'the old action never reached a terminal state while queries failed');
      // recovery: the outage lifts and the explicit cancel (user confirm path)
      // delivers the persisted 'requested' cancel
      failReads = false;
      await scheduler.cancelTask(c.task.task_id);
      await waitFor(() => c.store.getTask(next.task_id)!.status !== 'queued' ? true : null,
        {timeoutMs: 15_000, label: 'queue head promoted after the handoff cleared'});
      assert.equal(await terminalStatus(actionId), 'cancelled', 'recovery cancelled the old action');
      assert.equal(c.store.sessionHandoffPending(c.session.session_id), false, 'handoff cleared');
      assert.ok(nextTurns >= 1, 'the promoted head ran its own turn');
      assert.equal(c.store.intentsCancelRequested(c.session.session_id).length, 0, 'cancel confirmed');
    } finally {
      await operator.cancel(experimentId, actionId).catch(() => undefined);
      await c.manager?.stopAll().catch(() => undefined);
    }
  });

// The barrier checks EVERY bound intent: the LIVE action belongs to the
// OLDEST of eleven rows; ten newer scans already settled. The old last-ten
// window never saw the live shake — with the complete iteration the queue
// stays blocked until the shake actually terminates.
test('Q01: a live action beyond the last-ten bound intents still blocks the handoff', {timeout: 240_000}, async () => {
  const c = context();
  // intent row #1 (OLDEST): the shake, bound to its action only after the
  // scans settled (the runtime rejects scans on a plate while it shakes)
  c.store.insertSessionIntent({session_id: c.session.session_id, task_id: c.task.task_id,
    key: 'hf-win-00-shake', capability: 'plate.shake', canonical: '{}', goal_revision: 1});
  // intent rows #2..#11: scans that all settle first
  await operator.control(experimentId, {speed: 600});
  for (let n = 1; n <= 10; n++) {
    const scanId = await bindAction(c, c.task.task_id, `hf-win-${String(n).padStart(2, '0')}-scan`, 'imaging.scan');
    await terminalStatus(scanId);
  }
  await operator.control(experimentId, {speed: 1});
  // now the long shake (600 sim s at speed 1) binds to the OLDEST row
  const shakeSubmitted = await client.submit(experimentId, {capability: 'plate.shake',
    arguments: {plate_id: 'plate-01', speed_rpm: 180, duration_sim_s: 600}});
  const shakeId = shakeSubmitted.action.action_id;
  c.store.accountIntent(c.session.session_id, 'hf-win-00-shake', shakeId);
  const bound = c.store.listSessionIntents(c.session.session_id).filter(i => i.action_id);
  assert.equal(bound.length, 11, 'one live shake (oldest row) + ten settled scans');
  assert.equal(bound[0].action_id, shakeId, 'the live shake is the oldest bound intent');
  const next = c.store.createTask(c.session.session_id, {goal_text: 'after the window',
    goal_spec: spec as unknown as Record<string, unknown>});
  assert.equal(next.status, 'queued');
  // the current task goes terminal while its FIRST bound action is still in
  // flight (the fail_task effect path — no cancel sweep keeps the shake live)
  c.store.updateTaskStatus(c.task.task_id, 'failed', 'failed while the old shake is still in flight');
  assert.equal(c.store.sessionHandoffPending(c.session.session_id), true);
  let nextTurns = 0;
  await start(c, async input => {
    if (input.task?.task_id === next.task_id) nextTurns += 1;
    return output();
  });
  try {
    // restart-time promotion + at least one watchdog tick: all stay blocked
    await sleep(6500);
    assert.equal(c.store.getTask(next.task_id)!.status, 'queued',
      'the early live action blocks despite ten newer terminal intents');
    assert.equal(c.store.sessionHandoffPending(c.session.session_id), true);
    assert.equal(nextTurns, 0, 'no model turn may run for the queue head');
    // the shake terminates → its terminal event clears the barrier and the
    // queue head is promoted
    await operator.cancel(experimentId, shakeId);
    await waitFor(() => c.store.getTask(next.task_id)!.status !== 'queued' ? true : null,
      {timeoutMs: 15_000, label: 'queue head promoted after the live action terminated'});
    assert.equal(c.store.sessionHandoffPending(c.session.session_id), false);
    assert.ok(nextTurns >= 1);
  } finally {
    await operator.cancel(experimentId, shakeId).catch(() => undefined);
    await c.manager?.stopAll().catch(() => undefined);
  }
});

// A permanently unreadable action: even after the AUTOMATIC cancel retry
// chain has given up (cancel_attempts exhausted), the handoff barrier keeps
// refusing — "unknown" is not "absent". The ONLY user confirm path today is
// an explicit cancelTask (it resets the attempt counter and retries); with
// the outage lifted it delivers the cancel and promotion proceeds.
test('Q01: a permanently unreadable action never unblocks promotion until the user confirm path', {timeout: 240_000}, async () => {
  const c = context();
  const actionId = await bindAction(c, c.task.task_id, 'hf-stuck-shake', 'plate.shake', 600);
  const next = c.store.createTask(c.session.session_id, {goal_text: 'stuck behind',
    goal_spec: spec as unknown as Record<string, unknown>});
  let outage = true;
  let nextTurns = 0;
  const wrappedFetch: typeof fetch = async (url, init) => {
    if (outage && new URL(String(url)).pathname.endsWith(`/actions/${actionId}`)) {
      throw new TypeError('injected permanent action-status outage');
    }
    return fetch(url, init);
  };
  const scheduler = await start(c, async input => {
    if (input.task?.task_id === next.task_id) nextTurns += 1;
    return output();
  }, wrappedFetch);
  try {
    await scheduler.cancelTask(c.task.task_id); // the cancel attempt fails (GET)
    const key = c.store.findIntentByAction(c.session.session_id, actionId)!.key;
    // simulate the AUTOMATIC retry chain having given up (bounded at
    // CANCEL_RETRY_MAX_ATTEMPTS = 8): waiting out the real 1 s→30 s backoff
    // chain (>2 min) is not worth the wall clock — the durable row is what
    // gates the automatic retries, exactly as an exhausted chain would leave it.
    while (c.store.findIntentByAction(c.session.session_id, actionId)!.cancel_attempts < 8) {
      c.store.markIntentCancelRequested(c.session.session_id, key);
    }
    // nothing in the system still expects the cancel to land — yet the
    // promotion barrier must keep refusing (watchdog ticks included)
    await sleep(6500);
    assert.equal(c.store.getTask(next.task_id)!.status, 'queued', 'still queued after the cancel chain gave up');
    assert.equal(c.store.sessionHandoffPending(c.session.session_id), true);
    assert.equal(nextTurns, 0);
    // the user confirm path: an EXPLICIT cancel retries with a reset counter;
    // with the outage lifted it confirms and the queue head promotes
    outage = false;
    await scheduler.cancelTask(c.task.task_id);
    await waitFor(() => c.store.getTask(next.task_id)!.status !== 'queued' ? true : null,
      {timeoutMs: 15_000, label: 'promotion after the user-confirmed cancel'});
    assert.equal(await terminalStatus(actionId), 'cancelled');
    assert.ok(nextTurns >= 1, 'the promoted head ran its own turn');
  } finally {
    await operator.cancel(experimentId, actionId).catch(() => undefined);
    await c.manager?.stopAll().catch(() => undefined);
  }
});

// -- Q02 --------------------------------------------------------------------------

// The independent-review oracle case (task_pause_during_initial_read_is_
// preserved): the turn-start /state response is held; the task pause API's
// exact store entry lands in that window. The turn must exit BEFORE the
// ready→running write and the model call: the pause survives, zero device
// writes, no budget reservation — and no later turn resurrects it.
test('Q02: a task pause during the decision-start state read is preserved (zero device writes, no model call)',
  {timeout: 120_000}, async () => {
    const c = context();
    const entered = gate(), release = gate();
    let readCount = 0;
    let modelCalls = 0;
    let submitResult: {ok: boolean; error?: {code: string}} | undefined;
    const delayedFetch: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      const hold = path.endsWith('/state') && ++readCount === 2; // 1st read = recovery, 2nd = the turn's
      const response = await fetch(url, init);
      if (hold) {entered.resolve(); await release.promise;}
      return response;
    };
    await start(c, async (_input, host) => {
      modelCalls += 1;
      if (!submitResult) submitResult = await host.submitWrite('imaging.scan', scanArgs, {});
      return output();
    }, delayedFetch);
    await Promise.race([entered.promise, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('state gate not reached')), 10_000).unref())]);
    // exactly what POST /tasks/{id}/control {action: 'pause'} writes
    c.store.updateTaskStatus(c.task.task_id, 'paused', 'operator');
    release.resolve();
    await waitFor(() => turnCompletedEvents(c).length > 0 ? true : null,
      {timeoutMs: 10_000, label: 'the gated turn completed'});
    const completed = turnCompletedEvents(c).at(-1)!.payload as {ok?: boolean; code?: string};
    assert.equal(completed.ok, false);
    assert.equal(completed.code, 'stale_turn', 'the turn exited at the revocation fence');
    assert.equal(c.store.getTask(c.task.task_id)!.status, 'paused', 'the pause survived the turn');
    assert.equal(c.store.listSessionIntents(c.session.session_id).length, 0, 'zero device writes');
    assert.equal(modelCalls, 0, 'the model was never called');
    assert.equal(submitResult, undefined, 'no tool call ever executed');
    assert.equal(c.store.getTask(c.task.task_id)!.budget.model_turns_used, 0, 'no model turn was reserved');
    assert.equal(c.store.getSession(c.session.session_id)!.loop_state, 'paused', 'the loop label reports the pause');
    // no later turn resurrects it: the paused task holds the slot, every
    // trigger faces the fence again (watchdog ticks included)
    await sleep(6500);
    assert.equal(c.store.getTask(c.task.task_id)!.status, 'paused', 'still paused after watchdog ticks');
    assert.equal(modelCalls, 0);
    assert.equal(c.store.listSessionIntents(c.session.session_id).length, 0);
    await c.manager?.stopAll().catch(() => undefined);
  });

// Supervisor/operator pause of the whole AGENT in the same window: the fence
// (session lifecycle + agent_paused) stops the turn even though no signal
// abort helps it here — only the store write happened, the harder case.
test('Q02: an agent pause during the window stops the turn before the model and the ready→running write',
  {timeout: 120_000}, async () => {
    const c = context();
    const entered = gate(), release = gate();
    let readCount = 0;
    let modelCalls = 0;
    const delayedFetch: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      const hold = path.endsWith('/state') && ++readCount === 2;
      const response = await fetch(url, init);
      if (hold) {entered.resolve(); await release.promise;}
      return response;
    };
    await start(c, async () => {
      modelCalls += 1;
      return output();
    }, delayedFetch);
    await Promise.race([entered.promise, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('state gate not reached')), 10_000).unref())]);
    // exactly what POST /sessions/{id}/control {action: 'pause_agent'} writes
    // when the scheduler is live (pause() then aborts the turn signal — not
    // needed here; the fence must catch the store fact alone)
    c.store.updateSession(c.session.session_id, {agent_paused: true, loop_state: 'paused', loop_state_detail: 'operator'});
    release.resolve();
    await waitFor(() => turnCompletedEvents(c).length > 0 ? true : null,
      {timeoutMs: 10_000, label: 'the gated turn completed'});
    assert.equal(modelCalls, 0, 'the model was never called');
    assert.equal(c.store.getTask(c.task.task_id)!.status, 'ready', 'the task never became running');
    assert.equal(c.store.listSessionIntents(c.session.session_id).length, 0, 'zero device writes');
    const session = c.store.getSession(c.session.session_id)!;
    assert.equal(session.agent_paused, true);
    assert.equal(session.loop_state, 'paused');
    // the pause holds: no trigger may launch a turn while agent_paused
    await sleep(3000);
    assert.equal(c.store.getTask(c.task.task_id)!.status, 'ready');
    assert.equal(modelCalls, 0);
    await c.manager?.stopAll().catch(() => undefined);
  });

// Store-level unit: the ready→running transition is a CAS on status='ready'
// AND goal_revision — a concurrent pause (or any other status write) wins and
// is never overwritten; a healthy row starts exactly once.
test('Q02 store unit: startTaskTurn is a ready+goal_revision CAS and never overwrites a pause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-handoff-fence-unit-'));
  const agent = new AgentStore(dir);
  const store = new SessionStore(agent.db);
  try {
    const mk = (n: number) => {
      const s = store.createSession({runtime_instance_id: 'rt-handoff-fence-unit', experiment_id: `exp-unit-${n}`});
      return store.createTask(s.session_id, {goal_text: `cas ${n}`, goal_spec: spec as unknown as Record<string, unknown>});
    };
    // healthy path: still ready at the same revision → running
    const healthy = mk(1);
    const started = store.startTaskTurn(healthy.task_id, 1, 'first turn (test)');
    assert.ok(started, 'a ready row at the decided revision starts');
    assert.equal(started!.status, 'running');
    assert.equal(started!.reason, 'first turn (test)');
    // a pause that lands first wins and is never erased
    const paused = mk(2);
    store.updateTaskStatus(paused.task_id, 'paused', 'operator');
    assert.equal(store.startTaskTurn(paused.task_id, 1, 'first turn'), null, 'a paused row is refused');
    assert.equal(store.getTask(paused.task_id)!.status, 'paused');
    assert.equal(store.getTask(paused.task_id)!.reason, 'operator', 'the pause write is untouched');
    // a goal edit moved the revision → the stale decision cannot start it
    const edited = mk(3);
    store.updateTaskGoal(edited.task_id, {expected_revision: 1, goal_text: 'v2'});
    assert.equal(store.startTaskTurn(edited.task_id, 1, 'first turn'), null, 'stale goal revision is refused');
    assert.equal(store.getTask(edited.task_id)!.status, 'ready');
    // terminal stays terminal; an already-running task is not re-started
    const cancelled = mk(4);
    store.updateTaskStatus(cancelled.task_id, 'cancelled', 'operator');
    assert.equal(store.startTaskTurn(cancelled.task_id, 1, 'first turn'), null);
    assert.equal(store.getTask(cancelled.task_id)!.status, 'cancelled');
    const running = mk(5);
    store.updateTaskStatus(running.task_id, 'running', 'already going');
    assert.equal(store.startTaskTurn(running.task_id, 1, 'first turn'), null, 'running is not restarted');
  } finally {
    agent.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
