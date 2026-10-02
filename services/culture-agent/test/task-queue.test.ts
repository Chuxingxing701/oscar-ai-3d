// R07 acceptance (reports/review/long-lived-reacceptance.md §R07): the
// persistent FIFO task queue. Store-level unit tests plus REAL-process
// acceptance (Runtime + Culture Agent + HTTP model stub on the OpenAI wire,
// spawnRuntimeProc/spawnAgentProc): three tasks run to completion
// sequentially in order with only one task ever writing; queue head/middle
// cancel; pause/resume of the current task holds the queue; process restart
// preserves order and continues promotion; supervisor delegation idempotency;
// and old-turn isolation (a gated turn of a cancelled task cannot write for
// the promoted one).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, type Server} from 'node:http';
import {DeviceClient} from '@oscar/device-contract';
import {AgentStore} from '../src/store.ts';
import {SessionStore} from '../src/session-store.ts';
import {startModelStub, stubDecide} from './model-stub.ts';
import {AgentApiClient, spawnAgentProc, spawnRuntimeProc, sleep, waitFor} from './procs.ts';

/**
 * Multi-task wrapper around the shared stub policy. A queued session's
 * history accumulates the PREVIOUS tasks' action digests; the R08 step
 * verification (correctly) refuses citations of actions owned by another
 * task, and the single-task-era stub heuristics sometimes cite them. The
 * wrapper only removes FOREIGN-task action digest lines from the turn briefs
 * before the shared policy parses them — every decision is still the shared
 * policy's, over the current task's own evidence.
 */
function taskScopedDecide(messages: Array<{role: string; content?: unknown}>, stats: Parameters<typeof stubDecide>[1]) {
  const systemText = String(messages.find(m => m.role === 'system')?.content ?? '');
  const currentTask = /ACTIVE TASK (task-[a-z0-9-]+)/.exec(systemText)?.[1] ?? null;
  if (!currentTask) return stubDecide(messages as Parameters<typeof stubDecide>[0], stats);
  // action_id → owning task, from every submitted digest in the history
  const owner = new Map<string, string>();
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    for (const match of text.matchAll(/"key":"[^"]*?(task-[a-z0-9-]+):r\d+:op\d+","action_id":"(act-[^"]+)"/g)) {
      owner.set(match[2], match[1]);
    }
  }
  const scoped = messages.map(m => {
    const text = typeof m.content === 'string' ? m.content : null;
    if (m.role !== 'user' || text == null || !text.includes('WAKE:')) return m;
    const kept = text.split('\n').filter(line => {
      if (!/^- (action\.submitted|action\.result):/.test(line)) return true;
      const actionId = /"action_id":"(act-[^"]+)"/.exec(line)?.[1] ?? /action (act-\S+) /.exec(line)?.[1];
      const task = actionId ? owner.get(actionId) : undefined;
      return task == null || task === currentTask; // unknown/own digests stay
    }).join('\n');
    return {...m, content: kept};
  });
  return stubDecide(scoped as Parameters<typeof stubDecide>[0], stats);
}

// -- store-level unit tests ---------------------------------------------------------

function freshStore(): {agent: AgentStore; store: SessionStore; dir: string} {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-taskqueue-'));
  const agent = new AgentStore(dir);
  const store = new SessionStore(agent.db);
  return {agent, store, dir};
}

const queueSpec = {description: 'queue row A', scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', value: 100, source: 'observation', row_id: 'A'}],
  allowed_operations: ['imaging.scan'], monitoring: {interval_sim_s: 60}};
const incompleteSpec = {description: 'missing target', scope: {plates: ['plate-01'], rows: ['A']},
  allowed_operations: ['imaging.scan']} as Record<string, unknown>;

test('task queue unit: enqueue is FIFO behind the current task and request_id idempotent', () => {
  const {agent, store, dir} = freshStore();
  try {
    const s = store.createSession({runtime_instance_id: 'rt-q', experiment_id: 'exp-001'});
    const first = store.createTask(s.session_id, {goal_text: 'first', goal_spec: queueSpec});
    assert.equal(first.status, 'ready', 'no current task → born ready');
    // a paused or needs_input current task still blocks: new tasks queue
    store.updateTaskStatus(first.task_id, 'needs_input', 'missing');
    const second = store.createTask(s.session_id, {goal_text: 'second', goal_spec: queueSpec,
      request_id: 'req-second'});
    assert.equal(second.status, 'queued');
    store.updateTaskStatus(first.task_id, 'running', 'params filled');
    store.updateTaskStatus(first.task_id, 'needs_input', 'again');
    const third = store.createTask(s.session_id, {goal_text: 'third', goal_spec: queueSpec});
    assert.equal(third.status, 'queued');
    const queue = store.queuedTasks(s.session_id);
    assert.deepEqual(queue.map(q => [q.task_id, q.position]), [[second.task_id, 1], [third.task_id, 2]]);
    assert.equal(store.queuePosition(s.session_id, second.task_id), 1);
    assert.equal(store.queuePosition(s.session_id, first.task_id), null, 'non-queued has no position');
    // activeTask NEVER returns a queued task; paused/needs_input hold the slot
    assert.equal(store.activeTask(s.session_id)!.task_id, first.task_id);
    store.updateTaskStatus(first.task_id, 'paused', 'operator');
    assert.equal(store.activeTask(s.session_id)!.task_id, first.task_id, 'paused is still the current task');
    // replay returns the ORIGINAL task including while it is queued; a
    // divergent body under the same request_id conflicts
    const replay = store.createTask(s.session_id, {goal_text: 'second', goal_spec: queueSpec,
      request_id: 'req-second'});
    assert.equal(replay.task_id, second.task_id);
    assert.equal(replay.status, 'queued');
    assert.throws(() => store.createTask(s.session_id, {goal_text: 'different', goal_spec: queueSpec,
      request_id: 'req-second'}), /request_conflict/);
    store.updateTaskStatus(first.task_id, 'cancelled', 'done');
    assert.equal(store.activeTask(s.session_id), undefined, 'queued tasks do not become current by themselves');
    // N04: the terminal write left a pending handoff — the very next create
    // goes to the queue even though activeTask() is empty
    assert.equal(store.sessionHandoffPending(s.session_id), true);
    const afterTerminal = store.createTask(s.session_id, {goal_text: 'after terminal', goal_spec: queueSpec});
    assert.equal(afterTerminal.status, 'queued', 'no ready birth while the handoff is pending');
    assert.equal(store.activeTask(s.session_id), undefined);
  } finally {
    agent.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('task queue unit: promotion is a single-slot CAS and decides needs_input at promotion', () => {
  const {agent, store, dir} = freshStore();
  try {
    const s = store.createSession({runtime_instance_id: 'rt-q', experiment_id: 'exp-001'});
    const first = store.createTask(s.session_id, {goal_text: 'first', goal_spec: queueSpec});
    const second = store.createTask(s.session_id, {goal_text: 'second', goal_spec: queueSpec});
    const third = store.createTask(s.session_id, {goal_text: 'third', goal_spec: incompleteSpec});
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'CAS: a current task (ready) blocks promotion');
    store.updateTaskStatus(first.task_id, 'running', 'go');
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'CAS: running blocks promotion');
    store.updateTaskStatus(first.task_id, 'paused', 'operator');
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'CAS: paused blocks promotion');
    store.updateTaskStatus(first.task_id, 'waiting_condition', 'waiting');
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'CAS: waiting blocks promotion');
    // N04: a terminal CURRENT task sets the persisted handoff marker; the
    // store promotion CAS refuses to hand the slot over while it is set
    store.updateTaskStatus(first.task_id, 'completed', null);
    assert.equal(store.sessionHandoffPending(s.session_id), true, 'terminal current task leaves a pending handoff');
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'N04: an uncleared handoff blocks promotion');
    // the scheduler's promotion routine clears the marker once its barriers
    // passed (store-level test simulates that barrier pass)
    assert.equal(store.clearSessionHandoff(s.session_id), true);
    const promoted = store.promoteQueuedTask(s.session_id);
    assert.ok(promoted, 'slot free → head promoted');
    assert.equal(promoted!.task_id, second.task_id, 'FIFO: lowest queue_index first');
    assert.equal(promoted!.status, 'ready');
    assert.equal(store.activeTask(s.session_id)!.task_id, second.task_id);
    assert.deepEqual(store.queuedTasks(s.session_id).map(q => q.task_id), [third.task_id]);
    assert.equal(store.queuePosition(s.session_id, third.task_id), 1, 'position closes the gap');
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'CAS: the promoted task now blocks');
    store.updateTaskStatus(second.task_id, 'failed', 'boom');
    store.clearSessionHandoff(s.session_id); // scheduler barrier pass
    const promotedIncomplete = store.promoteQueuedTask(s.session_id);
    assert.equal(promotedIncomplete!.task_id, third.task_id);
    assert.equal(promotedIncomplete!.status, 'needs_input', 'incomplete spec → needs_input at promotion');
    assert.ok(promotedIncomplete!.reason);
    store.updateTaskStatus(third.task_id, 'cancelled', 'x');
    store.clearSessionHandoff(s.session_id); // scheduler barrier pass
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'empty queue → nothing to promote');
  } finally {
    agent.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

// N04 — the terminal→promotion gap: the previous current task is terminal,
// an existing queue is still waiting for the asynchronous promotion barriers
// (intent reconcile / in-flight device actions, owned by the scheduler), and
// activeTask() is empty in that window. A NEW arrival must join the queue
// behind the existing head — never be born 'ready' into the free slot.
test('task queue unit: a new arrival during the terminal→promotion gap queues behind the existing head', () => {
  const {agent, store, dir} = freshStore();
  try {
    const s = store.createSession({runtime_instance_id: 'rt-q', experiment_id: 'exp-001'});
    const a = store.createTask(s.session_id, {goal_text: 'A', goal_spec: queueSpec});
    assert.equal(a.status, 'ready');
    const b = store.createTask(s.session_id, {goal_text: 'B', goal_spec: queueSpec});
    assert.equal(b.status, 'queued');
    // A goes terminal through the store (the same entry every path uses);
    // the scheduler has NOT run its promotion barriers yet
    store.updateTaskStatus(a.task_id, 'completed', null);
    assert.equal(store.activeTask(s.session_id), undefined, 'the gap: no current task exists');
    const c = store.createTask(s.session_id, {goal_text: 'C', goal_spec: queueSpec});
    assert.equal(c.status, 'queued', 'N04: the gap admits new arrivals only into the queue');
    // B stays ahead of C, and promotion (once the handoff clears) picks B
    assert.deepEqual(store.queuedTasks(s.session_id).map(q => q.task_id), [b.task_id, c.task_id]);
    assert.equal(store.queuePosition(s.session_id, b.task_id), 1);
    assert.equal(store.queuePosition(s.session_id, c.task_id), 2);
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'promotion is still barrier-blocked');
    store.clearSessionHandoff(s.session_id); // scheduler barrier pass
    const promoted = store.promoteQueuedTask(s.session_id);
    assert.equal(promoted!.task_id, b.task_id, 'B is next, not C');
    assert.equal(store.getTask(c.task_id)!.status, 'queued', 'C stays queued behind the promoted head');
    // handoff also survives a store reopen (restart): the marker is persisted
    store.updateTaskStatus(promoted!.task_id, 'failed', 'done');
    assert.equal(store.sessionHandoffPending(s.session_id), true);
  } finally {
    agent.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('task queue unit: archive cancels the whole queue, never promotes it', () => {
  const {agent, store, dir} = freshStore();
  try {
    const s = store.createSession({runtime_instance_id: 'rt-q', experiment_id: 'exp-001'});
    const first = store.createTask(s.session_id, {goal_text: 'first', goal_spec: queueSpec});
    const second = store.createTask(s.session_id, {goal_text: 'second', goal_spec: queueSpec});
    const third = store.createTask(s.session_id, {goal_text: 'third', goal_spec: queueSpec});
    store.updateTaskStatus(first.task_id, 'completed', null);
    const cancelled = store.cancelQueuedTasks(s.session_id, 'session archived: reset');
    assert.equal(cancelled, 2);
    assert.equal(store.getTask(second.task_id)!.status, 'cancelled');
    assert.equal(store.getTask(second.task_id)!.reason, 'session archived: reset');
    assert.equal(store.getTask(third.task_id)!.status, 'cancelled');
    assert.equal(store.promoteQueuedTask(s.session_id), null, 'nothing left to promote');
  } finally {
    agent.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

// -- real-process helpers -----------------------------------------------------------

interface SessionStatus {
  session: {session_id: string; lifecycle: string};
  task: {task_id: string; status: string; reason: string | null} | null;
  queue: Array<{task_id: string; goal_text: string; status: string; position: number}>;
  queued_tasks: number;
}

interface TaskView {task: {task_id: string; status: string; reason: string | null;
  queued: boolean; queue_position: number | null}}

interface EventRow {seq: number; type: string; payload: Record<string, unknown>}

function goalSpec(opts: {deadlineOffsetSimS: number; intervalSimS: number; marker?: string}) {
  return {
    description: `queue acceptance ${opts.marker ?? ''}`,
    scope: {plates: ['plate-01'], rows: ['A']},
    metrics: [{metric: 'medium_volume_ul', op: '>=', value: 100, source: 'observation', row_id: 'A'}],
    // media.add is required for the versioned-skill plan (exchange_row_and_verify)
    // to validate; with the 100 µL threshold it is never actually used.
    // Deadlines stay well past one interval + the setup turns: the R08
    // monitor_until verification requires a fired sim_time wake whose target
    // is not after the deadline (a deadline swallowed by turn latency at
    // speed 1200 would never verify).
    allowed_operations: ['imaging.scan', 'media.add'],
    monitoring: {interval_sim_s: opts.intervalSimS},
    deadline_sim_s: opts.deadlineOffsetSimS,
    success: {description: 'window finished above threshold'},
    stop: {description: 'budget or cancel'},
  };
}

/** Extract the owning task id from a session intent key (`sid:task-…:rN:opM`). */
function taskOfKey(key: unknown): string {
  assert.equal(typeof key, 'string', `intent key missing: ${String(key)}`);
  return (key as string).split(':')[1];
}

async function sessionEvents(api: AgentApiClient, sessionId: string): Promise<EventRow[]> {
  const {events} = await api.get<{events: EventRow[]}>(`/sessions/${sessionId}/events?format=json&limit=10000`);
  return events;
}

/** All service actions in acceptance order, with the owning session task id. */
async function serviceActionsByTask(operator: DeviceClient, experimentId: string, sessionId: string) {
  const {actions} = await operator.actions(experimentId);
  return actions
    .filter(a => a.principal.kind === 'service' && a.idempotency_key?.startsWith(`${sessionId}:`))
    .sort((a, b) => a.accept_seq - b.accept_seq)
    .map(a => ({action_id: a.action_id, task_id: taskOfKey(a.idempotency_key), capability: a.capability}));
}

async function createTask(api: AgentApiClient, sessionId: string, goalText: string, spec: unknown,
  requestId?: string): Promise<{task_id: string; status: string; queued: boolean; queue_position: number | null}> {
  const {task} = await api.post<TaskView>(`/sessions/${sessionId}/tasks`,
    {goal_text: goalText, goal_spec: spec, ...(requestId ? {request_id: requestId} : {})});
  return {task_id: task.task_id, status: task.status, queued: task.queued, queue_position: task.queue_position};
}

async function taskStatus(api: AgentApiClient, taskId: string): Promise<string> {
  const {task} = await api.get<TaskView>(`/tasks/${taskId}`);
  return task.status;
}

/** The DeviceError code a write refused with (undefined when it succeeded). */
async function errorCode(api: AgentApiClient, path: string, body: unknown): Promise<string | undefined> {
  return api.post(path, body).then(() => undefined, (e: unknown) => (e as {code?: string}).code);
}

/**
 * Single-writer assertion: the ordered action.submitted session events must be
 * grouped per task in the expected order, every action's task must have been
 * current (non-terminal, non-queued) at submit, and each next task's first
 * submit must follow its promotion while the previous task is already
 * terminal — at no point may two tasks write.
 */
function assertSequentialSingleWriter(events: EventRow[], orderedTaskIds: string[], label: string): void {
  const submitted = events.filter(e => e.type === 'action.submitted')
    .map(e => ({seq: e.seq, task_id: taskOfKey(e.payload.key)}));
  assert.ok(submitted.length > 0, `${label}: expected device actions`);
  const unknown = submitted.filter(s => !orderedTaskIds.includes(s.task_id));
  assert.deepEqual(unknown.map(u => u.task_id), [], `${label}: actions from foreign tasks`);
  // grouping: consecutive runs per task, runs ordered exactly as the queue
  const runs: Array<{task_id: string; first: number; last: number}> = [];
  for (const s of submitted) {
    const lastRun = runs.at(-1);
    if (lastRun && lastRun.task_id === s.task_id) lastRun.last = s.seq;
    else runs.push({task_id: s.task_id, first: s.seq, last: s.seq});
  }
  const expectedRuns = orderedTaskIds.filter(id => submitted.some(s => s.task_id === id));
  assert.deepEqual(runs.map(r => r.task_id), expectedRuns, `${label}: interleaved writes — two tasks held the pen`);
  for (const [i, run] of runs.entries()) {
    const terminal = events.filter(e => e.type === 'task.status'
      && e.payload.task_id === run.task_id && ['completed', 'failed', 'cancelled'].includes(String(e.payload.status)))
      .map(e => e.seq).at(-1);
    assert.ok(terminal != null && terminal > run.last, `${label}: ${run.task_id} went terminal only after its last write`);
    if (i > 0) {
      const prev = runs[i - 1];
      const prevTerminal = events.filter(e => e.type === 'task.status'
        && e.payload.task_id === prev.task_id && ['completed', 'failed', 'cancelled'].includes(String(e.payload.status)))
        .map(e => e.seq).at(-1);
      const promoted = events.filter(e => e.type === 'task.promoted' && e.payload.task_id === run.task_id)
        .map(e => e.seq).at(0);
      assert.ok(promoted != null, `${label}: ${run.task_id} must be promoted from the queue`);
      assert.ok(prevTerminal! < promoted, `${label}: promotion only after the previous task is terminal`);
      assert.ok(promoted < run.first, `${label}: first write only after promotion`);
    }
  }
}

/** A model stub whose Nth response is held until the test releases it. */
async function startGatedStub(holdRequest: number): Promise<{port: number; close(): Promise<void>;
  release(): void; requestCount(): number}> {
  const stats = {turns: 0, scans: 0, liquidOps: 0, waits: 0, completes: 0, texts: 0};
  let n = 0;
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>(r => {releaseGate = r;});
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {body += c.toString('utf8');});
    req.on('end', () => {
      let parsed: {model?: string; messages?: Array<{role: string; content?: string | Array<{text?: string}>;
        tool_calls?: Array<{id: string; type: string; function: {name: string; arguments: string}}>}>} = {};
      try {parsed = JSON.parse(body);} catch { /* ignore */ }
      n += 1;
      const decision = stubDecide(parsed.messages ?? [], stats);
      void (async () => {
        if (n === holdRequest) await gate; // hold the model response (in-flight turn)
        writeStubResponse(res, parsed.model ?? 'oscar-stub', `gated-${n}`, decision);
      })();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as {port: number}).port;
  return {port, close: () => new Promise<void>(r => server.close(() => r())),
    release: () => releaseGate(), requestCount: () => n};
}

interface StubDecision {text?: string; toolCalls?: Array<{name: string; args: Record<string, unknown>}>}

/** SSE chat-completion response writer shared by the scripted stub servers. */
function writeStubResponse(res: import('node:http').ServerResponse, model: string, id: string,
  decision: StubDecision): void {
  res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
  const chunk = (o: unknown): void => {res.write(`data: ${JSON.stringify(o)}\n\n`);};
  const base = {id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model};
  if (decision.toolCalls?.length) {
    if (decision.text) chunk({...base, choices: [{index: 0, delta: {role: 'assistant', content: decision.text}}]});
    decision.toolCalls.forEach((call, i) => {
      chunk({...base, choices: [{index: 0, delta: {role: 'assistant',
        tool_calls: [{index: i, id: `${id}_${i}`, type: 'function',
          function: {name: call.name, arguments: JSON.stringify(call.args)}}]}}]});
    });
    chunk({...base, choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]});
  } else {
    if (decision.text) chunk({...base, choices: [{index: 0, delta: {role: 'assistant', content: decision.text}}]});
    chunk({...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
  }
  chunk({...base, choices: [], usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}});
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * A scripted stub for the N04 gap regression: task A's turns are fully
 * scripted (submit a LONG plate.shake, then fail the task while the shake is
 * still in flight); the "PROPOSE-C3" chat message proposes a task; every
 * other request (queue tasks B/C…) uses the shared task-scoped policy.
 */
async function startGapStub(scriptFor: (messages: Array<{role: string; content?: unknown;
  tool_calls?: unknown}>) => StubDecision | null): Promise<{port: number; close(): Promise<void>}> {
  const stats = {turns: 0, scans: 0, liquidOps: 0, waits: 0, completes: 0, texts: 0};
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {body += c.toString('utf8');});
    req.on('end', () => {
      let parsed: {model?: string; messages?: Array<{role: string; content?: string | Array<{text?: string}>}>} = {};
      try {parsed = JSON.parse(body);} catch { /* ignore */ }
      const scripted = scriptFor(parsed.messages ?? []);
      const decision = scripted ?? taskScopedDecide(parsed.messages ?? [], stats);
      writeStubResponse(res, parsed.model ?? 'oscar-stub', `gap-${Date.now()}-${Math.random()}`, decision);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as {port: number}).port;
  return {port, close: () => new Promise<void>(r => server.close(() => r()))};
}

const stubEnv = (stubPort: number): Record<string, string> => ({
  OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stubPort}/v1`, OSCAR_MODEL_API_KEY: 'stub-key',
  OSCAR_MODEL_NAME: 'oscar-stub', OSCAR_MODEL_PROVIDER: 'oscar-stub'});

// -- real-process acceptance --------------------------------------------------------

test('R07 queue: three tasks complete sequentially in order; only one task ever writes', {timeout: 240_000}, async () => {
  const stub = await startModelStub({decide: taskScopedDecide});
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const simNow = (await operator.state(experimentId)).experiment.sim_time_s;
    const {session} = await api.post<{session: {session_id: string}}>('/sessions', {});
    const sessionId = session.session_id;

    // t1 takes the slot; t2/t3 queue behind it in FIFO order
    const t1 = await createTask(api, sessionId, 'queue task one', goalSpec({deadlineOffsetSimS: simNow + 3600, intervalSimS: 300}), 'q-a');
    assert.equal(t1.status, 'ready');
    const t2 = await createTask(api, sessionId, 'queue task two', goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 300}), 'q-b');
    assert.equal(t2.status, 'queued', 'creating while a task is current queues instead of rejecting');
    assert.equal(t2.queue_position, 1);
    const t3 = await createTask(api, sessionId, 'queue task three', goalSpec({deadlineOffsetSimS: simNow + 10_800, intervalSimS: 300}), 'q-c');
    assert.equal(t3.status, 'queued');
    assert.equal(t3.queue_position, 2);
    const statusView = await api.get<SessionStatus>(`/sessions/${sessionId}/status`);
    assert.deepEqual(statusView.queue.map(q => q.task_id), [t2.task_id, t3.task_id]);
    assert.equal(statusView.queued_tasks, 2);
    assert.equal(statusView.task!.task_id, t1.task_id, 'the current task is never a queued one');

    // all three run to completion, strictly in queue order
    await waitFor(async () => (await taskStatus(api, t3.task_id)) === 'completed' ? true : null,
      {timeoutMs: 120_000, label: 'all three tasks completed'});
    assert.equal(await taskStatus(api, t1.task_id), 'completed');
    assert.equal(await taskStatus(api, t2.task_id), 'completed');

    const events = await sessionEvents(api, sessionId);
    const terminalSeq = (id: string) => events.filter(e => e.type === 'task.status' && e.payload.task_id === id
      && ['completed', 'failed', 'cancelled'].includes(String(e.payload.status))).map(e => e.seq).at(-1);
    assert.ok(terminalSeq(t1.task_id)! < terminalSeq(t2.task_id)!);
    assert.ok(terminalSeq(t2.task_id)! < terminalSeq(t3.task_id)!, 'completion order follows the queue order');

    // single writer: every Runtime action belongs to the task that was current
    assertSequentialSingleWriter(events, [t1.task_id, t2.task_id, t3.task_id], 'sequential');
    const actions = await serviceActionsByTask(operator, experimentId, sessionId);
    assert.ok(actions.length >= 3, 'each task scanned at least once');
    for (const id of [t1.task_id, t2.task_id, t3.task_id]) {
      assert.ok(actions.some(a => a.task_id === id), `${id} wrote at least one action`);
    }
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await stub.close();
  }
});

test('R07 queue: cancel head and middle items; pause/resume holds the queue; promotion after cancel', {timeout: 240_000}, async () => {
  const stub = await startModelStub({decide: taskScopedDecide});
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const simNow = (await operator.state(experimentId)).experiment.sim_time_s;
    const {session} = await api.post<{session: {session_id: string}}>('/sessions', {});
    const sessionId = session.session_id;

    // slow current task (long monitoring window) + three queued items
    const t1 = await createTask(api, sessionId, 'slow current', goalSpec({deadlineOffsetSimS: simNow + 500_000, intervalSimS: 3600, marker: 'SLOW'}));
    const t2 = await createTask(api, sessionId, 'queued head', goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 300}));
    const t3 = await createTask(api, sessionId, 'queued middle', goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 300}));
    const t4 = await createTask(api, sessionId, 'queued tail', goalSpec({deadlineOffsetSimS: simNow + 10_800, intervalSimS: 600}));
    assert.deepEqual([t2.queue_position, t3.queue_position, t4.queue_position], [1, 2, 3]);

    // wait until t1 is actually executing (its first scan landed) so the
    // queue faces a genuinely running current task
    await waitFor(async () => (await serviceActionsByTask(operator, experimentId, sessionId))
      .some(a => a.task_id === t1.task_id) ? true : null, {timeoutMs: 60_000, label: 't1 first scan'});

    // pause/resume on a QUEUED task is refused with the dedicated code
    assert.equal(await errorCode(api, `/tasks/${t2.task_id}/control`, {action: 'pause'}), 'task_queued');
    assert.equal(await errorCode(api, `/tasks/${t3.task_id}/control`, {action: 'resume'}), 'task_queued');

    // cancel the queue HEAD (t2) and a MIDDLE item (t3): no device effect,
    // remaining order preserved (t4 closes up to position 1)
    const before = (await serviceActionsByTask(operator, experimentId, sessionId)).length;
    for (const id of [t2.task_id, t3.task_id]) {
      const cancelled = await api.post<{status: string}>(`/tasks/${id}/control`, {action: 'cancel'});
      assert.equal(cancelled.status, 'cancelled');
    }
    await sleep(500);
    assert.equal((await serviceActionsByTask(operator, experimentId, sessionId)).length, before,
      'cancelling queued items has no device effect');
    assert.equal(await taskStatus(api, t2.task_id), 'cancelled');
    assert.equal(await taskStatus(api, t3.task_id), 'cancelled');
    const afterCancels = await api.get<SessionStatus>(`/sessions/${sessionId}/status`);
    assert.deepEqual(afterCancels.queue.map(q => [q.task_id, q.position]), [[t4.task_id, 1]],
      'remaining order preserved');

    // pause the CURRENT task: it keeps the slot — the queue must NOT advance
    const paused = await api.post<{status: string}>(`/tasks/${t1.task_id}/control`, {action: 'pause'});
    assert.equal(paused.status, 'paused');
    await waitFor(async () => (await api.get<SessionStatus>(`/sessions/${sessionId}/status`)).task?.status === 'paused'
      ? true : null, {timeoutMs: 10_000, label: 't1 paused'});
    const beforeActions = (await serviceActionsByTask(operator, experimentId, sessionId)).length;
    await sleep(1500);
    const duringPause = await api.get<SessionStatus>(`/sessions/${sessionId}/status`);
    assert.equal(duringPause.task!.task_id, t1.task_id, 'paused task remains the current task');
    assert.equal(duringPause.queue.map(q => q.task_id).includes(t4.task_id), true, 'queue intact during pause');
    assert.equal(await taskStatus(api, t4.task_id), 'queued', 'no promotion while the paused task holds the slot');
    assert.equal((await sessionEvents(api, sessionId)).filter(e => e.type === 'task.promoted').length, 0,
      'no promotion event during the pause');
    assert.equal((await serviceActionsByTask(operator, experimentId, sessionId)).length, beforeActions,
      'no device writes during the pause');

    // chat still works while the current task is paused (task-less turn)
    await api.post(`/sessions/${sessionId}/messages`, {content: '暂停期间确认一下状态。', request_id: 'pause-chat'});
    await waitFor(async () => {
      const detail = await api.get<{messages: Array<{role: string; content: string}>}>(`/sessions/${sessionId}`);
      return detail.messages.at(-1)?.role === 'assistant' ? true : null;
    }, {timeoutMs: 20_000, label: 'assistant reply during task pause'});

    // resume, then cancel the current task: NOW the queue advances to t4
    const resumed = await api.post<{status: string}>(`/tasks/${t1.task_id}/control`, {action: 'resume'});
    assert.equal(resumed.status, 'waiting_condition');
    await sleep(800);
    assert.equal(await taskStatus(api, t4.task_id), 'queued', 'resumed current task still holds the queue');
    const cancelledCurrent = await api.post<{status: string}>(`/tasks/${t1.task_id}/control`, {action: 'cancel'});
    assert.equal(cancelledCurrent.status, 'cancelled');
    await waitFor(async () => (await taskStatus(api, t4.task_id)) !== 'queued' ? true : null,
      {timeoutMs: 20_000, label: 't4 promoted after the current task was cancelled'});
    await waitFor(async () => (await taskStatus(api, t4.task_id)) === 'completed' ? true : null,
      {timeoutMs: 120_000, label: 't4 completed after promotion'});

    const events = await sessionEvents(api, sessionId);
    assertSequentialSingleWriter(events, [t1.task_id, t4.task_id], 'cancel+pause');
    const actions = await serviceActionsByTask(operator, experimentId, sessionId);
    assert.equal(actions.filter(a => a.task_id === t2.task_id || a.task_id === t3.task_id).length, 0,
      'cancelled queue items never touched the device');
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await stub.close();
  }
});

test('R07 queue: process restart preserves order; promotion continues', {timeout: 300_000}, async () => {
  const stub = await startModelStub({decide: taskScopedDecide});
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  let agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const simNow = (await operator.state(experimentId)).experiment.sim_time_s;
    const {session} = await api.post<{session: {session_id: string}}>('/sessions', {});
    const sessionId = session.session_id;

    const t1 = await createTask(api, sessionId, 'restart current', goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 600, marker: 'RESTART'}));
    const t2 = await createTask(api, sessionId, 'restart second', goalSpec({deadlineOffsetSimS: simNow + 14_400, intervalSimS: 300}));
    const t3 = await createTask(api, sessionId, 'restart third', goalSpec({deadlineOffsetSimS: simNow + 21_600, intervalSimS: 300}));
    assert.deepEqual([t2.status, t3.status], ['queued', 'queued']);
    // let t1 reach a stable wait (its first scan landed) before the crash
    await waitFor(async () => (await api.get<SessionStatus>(`/sessions/${sessionId}/status`)).task?.status === 'waiting_condition'
      ? true : null, {timeoutMs: 60_000, label: 't1 waiting_condition before crash'});

    // SIGKILL the agent mid-queue; the Runtime keeps running
    agent.kill9();
    await waitFor(() => agent.child.exitCode != null || agent.child.killed ? true : null,
      {timeoutMs: 10_000, label: 'agent killed'});

    // restart on the SAME data dir: recovery must preserve the queue order
    // and keep promoting until every task finished
    agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
    const api2 = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
    await waitFor(async () => (await taskStatus(api2, t3.task_id)) === 'completed' ? true : null,
      {timeoutMs: 180_000, label: 'queue drained after restart'});
    assert.equal(await taskStatus(api2, t1.task_id), 'completed');
    assert.equal(await taskStatus(api2, t2.task_id), 'completed');

    const events = await sessionEvents(api2, sessionId);
    const terminalSeq = (id: string) => events.filter(e => e.type === 'task.status' && e.payload.task_id === id
      && ['completed', 'failed', 'cancelled'].includes(String(e.payload.status))).map(e => e.seq).at(-1);
    assert.ok(terminalSeq(t1.task_id)! < terminalSeq(t2.task_id)!);
    assert.ok(terminalSeq(t2.task_id)! < terminalSeq(t3.task_id)!, 'order survives the restart');
    assertSequentialSingleWriter(events, [t1.task_id, t2.task_id, t3.task_id], 'restart');
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await stub.close();
  }
});

test('R07 queue: supervisor delegation idempotency — same request_id → one queued task; divergent body → conflict', {timeout: 180_000}, async () => {
  const stub = await startModelStub({decide: taskScopedDecide});
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const simNow = (await operator.state(experimentId)).experiment.sim_time_s;
    const {session} = await api.post<{session: {session_id: string}}>('/sessions', {});
    const sessionId = session.session_id;
    const t1 = await createTask(api, sessionId, 'current for delegation', goalSpec({deadlineOffsetSimS: simNow + 500_000, intervalSimS: 3600, marker: 'DELEG'}));

    const delegate = (requestId: string, marker: string) => api.post<{task_id: string; status: string;
      queue_position: number | null; contract_version: string}>(`/supervisor/v1/sessions/${sessionId}/tasks`,
      {goal_text: `delegated ${marker}`, goal_spec: goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 300}),
        delegated_principal: 'dsh-queue-test', request_id: requestId});

    const first = await delegate('deleg-1', 'one');
    assert.equal(first.status, 'queued', 'delegation while a task is current queues');
    assert.equal(first.queue_position, 1);
    // replaying the SAME request_id returns the ORIGINAL queued task — exactly one row
    const replay = await delegate('deleg-1', 'one');
    assert.equal(replay.task_id, first.task_id);
    assert.equal(replay.status, 'queued');
    const status = await api.get<SessionStatus>(`/sessions/${sessionId}/status`);
    assert.equal(status.queue.length, 1, 'one queued task, not two');
    assert.equal(status.queue[0].task_id, first.task_id);
    // a divergent body under the same request_id conflicts
    assert.equal(await errorCode(api, `/supervisor/v1/sessions/${sessionId}/tasks`,
      {goal_text: 'delegated DIFFERENT', goal_spec: goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 300}),
        delegated_principal: 'dsh-queue-test', request_id: 'deleg-1'}), 'idempotency_conflict');
    // supervisor overview carries the queue and the bumped contract version
    const overview = await api.get<{contract_version: string; sessions: Array<{session_id: string;
      queue: Array<{task_id: string; position: number}>}>}>('/supervisor/v1/overview');
    assert.equal(overview.contract_version, '1.1.0');
    const mine = overview.sessions.find(s => s.session_id === sessionId)!;
    assert.deepEqual(mine.queue.map(q => [q.task_id, q.position]), [[first.task_id, 1]]);

    // cleanup: cancel everything (queued cancel included) — the cancelled
    // QUEUE item never touches the device (t1's own in-flight scan may still
    // settle; that is the current task's legitimate work)
    await api.post(`/tasks/${first.task_id}/control`, {action: 'cancel'});
    await api.post(`/tasks/${t1.task_id}/control`, {action: 'cancel'});
    await sleep(500);
    assert.equal((await serviceActionsByTask(operator, experimentId, sessionId))
      .filter(a => a.task_id === first.task_id).length, 0,
      'the cancelled queued delegation produced no device action');
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await stub.close();
  }
});

test('R07 queue: old-turn isolation — a gated turn of cancelled task A writes nothing after B is promoted', {timeout: 240_000}, async () => {
  // request #2 is task A's scan turn: its model response is held while A is
  // cancelled and B created+promoted; releasing it must produce ZERO actions.
  const gated = await startGatedStub(2);
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(gated.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  try {
    const experimentId = await operator.currentExperimentId();
    await operator.control(experimentId, {speed: 1200});
    const simNow = (await operator.state(experimentId)).experiment.sim_time_s;
    const {session} = await api.post<{session: {session_id: string}}>('/sessions', {});
    const sessionId = session.session_id;

    // task A: its FIRST turn (plan) flows; its SECOND turn (imaging_scan) is held
    const a = await createTask(api, sessionId, 'gated task A', goalSpec({deadlineOffsetSimS: simNow + 500_000, intervalSimS: 3600, marker: 'GATED-A'}));
    assert.equal(a.status, 'ready');
    await waitFor(() => gated.requestCount() >= 2 ? true : null, {timeoutMs: 60_000, label: 'task A scan turn gated'});

    // cancel A while its scan turn is still in flight, then create B:
    // B takes the freed slot (promotion path or direct ready birth)
    const cancelled = await api.post<{status: string}>(`/tasks/${a.task_id}/control`, {action: 'cancel'});
    assert.equal(cancelled.status, 'cancelled');
    const b = await createTask(api, sessionId, 'task B after A', goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 600, marker: 'AFTER-A'}));
    // B holds the execution slot (status view shows it as the current task);
    // B's own turns cannot start yet — A's held turn is still in flight
    await waitFor(async () => (await api.get<SessionStatus>(`/sessions/${sessionId}/status`))
      .task?.task_id === b.task_id ? true : null, {timeoutMs: 20_000, label: 'B holds the execution slot'});

    // release A's held turn: its imaging_scan must be refused — B may start
    // its own work right after (its kick was pending behind A's turn), but
    // ZERO actions may exist under A: the stale turn cannot write for A, and
    // a turn bound to A cannot write for B either
    const eventsBefore = await sessionEvents(api, sessionId);
    const staleBefore = eventsBefore.filter(e => e.type === 'turn.completed'
      && (e.payload as {code?: string}).code === 'stale_turn').length;
    gated.release();
    await waitFor(async () => {
      const events = await sessionEvents(api, sessionId);
      return events.filter(e => e.type === 'turn.completed'
        && (e.payload as {code?: string}).code === 'stale_turn').length > staleBefore ? true : null;
    }, {timeoutMs: 30_000, label: 'gated turn completed stale'});
    await sleep(800); // B's own first scan lands here; any A write would too
    const actionsAfterRelease = await serviceActionsByTask(operator, experimentId, sessionId);
    assert.equal(actionsAfterRelease.filter(x => x.task_id === a.task_id).length, 0,
      'the released stale turn of A wrote NOTHING — not for A, not under B');
    // every action that did appear belongs to B (its own pending kick)
    assert.ok(actionsAfterRelease.every(x => x.task_id === b.task_id),
      'no third task could have written');

    // B now runs on its own turns and completes normally
    await waitFor(async () => (await taskStatus(api, b.task_id)) === 'completed' ? true : null,
      {timeoutMs: 120_000, label: 'task B completed'});
    const finalActions = await serviceActionsByTask(operator, experimentId, sessionId);
    assert.ok(finalActions.some(x => x.task_id === b.task_id), 'B did its own work');
    assert.equal(finalActions.some(x => x.task_id === a.task_id), false, 'A never wrote');
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await gated.close();
  }
});

// N04 — the terminal→promotion gap, real processes. Task A goes terminal
// (fail_task) while its own plate.shake is STILL RUNNING on the device: the
// promotion barrier (non-terminal in-flight action) keeps the queue blocked
// and the persisted handoff marker keeps admission queued-only. New arrivals
// through ALL THREE entry points (user HTTP, supervisor HTTP, chat
// propose_task) must join the queue BEHIND B; nothing gets execution rights
// before the barrier clears; once the shake terminates, B is promoted first.
test('N04 gap: arrivals during the terminal→promotion gap queue behind B via every entry point', {timeout: 300_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 15_000});
  const experimentId = await operator.currentExperimentId();
  // speed 12: a 600 sim s shake stays in flight ~50 wall s — a wide, stable gap
  await operator.control(experimentId, {speed: 12});
  const shakeSpec = (deadline: number) => ({
    description: 'N04 gap task A: shake while going terminal',
    scope: {plates: ['plate-01'], rows: ['A']},
    metrics: [{metric: 'medium_volume_ul', op: '>=', value: 100, source: 'observation', row_id: 'A'}],
    allowed_operations: ['imaging.scan', 'plate.shake'],
    monitoring: {interval_sim_s: 600},
    deadline_sim_s: deadline,
    success: {description: 'window finished above threshold'},
    stop: {description: 'budget or cancel'},
  });
  // the scripted branch keys on task A's concrete id (set once created); the
  // propose request fires once (it stays in the shared history afterwards)
  let taskAId: string | null = null;
  let proposed = false;
  const stub = await startGapStub(messages => {
    const serialized = JSON.stringify(messages);
    const systemText = String(messages.find(m => m.role === 'system')?.content ?? '');
    if (taskAId && systemText.includes(`ACTIVE TASK ${taskAId}`)) {
      if (!serialized.includes('plate_shake')) {
        return {toolCalls: [{name: 'plate_shake', args: {plate_id: 'plate-01', speed_rpm: 180, duration_sim_s: 600}}]};
      }
      // A's later turn (triggered by the STOP message): fail the task while
      // the shake is still in flight
      return {toolCalls: [{name: 'fail_task', args: {reason: 'gap_window',
        summary: 'N04 regression: fail while the device action is still in flight'}}]};
    }
    // the user's propose request rides in the conversation history (the turn
    // brief itself carries only the wake + device state)
    if (!proposed && serialized.includes('PROPOSE-C3')) {
      proposed = true;
      return {toolCalls: [{name: 'propose_task', args: {goal_text: 'C3 chat-proposed',
        goal_spec: shakeSpec(60_000)}}]};
    }
    return null; // shared policy drives everything else (B and the C tasks)
  });
  const agent = await spawnAgentProc({dataDir: runtime.dataDir, runtimeUrl: runtime.baseUrl, env: stubEnv(stub.port)});
  const api = new AgentApiClient(agent.baseUrl, runtime.serviceToken);
  try {
    const simNow = (await operator.state(experimentId)).experiment.sim_time_s;
    const {session} = await api.post<{session: {session_id: string}}>('/sessions', {});
    const sessionId = session.session_id;

    // A: current task; its first turn submits the long shake
    const a = await createTask(api, sessionId, 'N04 gap task A', shakeSpec(simNow + 500_000), 'gap-a');
    taskAId = a.task_id; // from here the scripted branch drives ONLY task A
    assert.equal(a.status, 'ready');
    await waitFor(async () => (await serviceActionsByTask(operator, experimentId, sessionId))
      .some(x => x.task_id === a.task_id && x.capability === 'plate.shake') ? true : null,
      {timeoutMs: 60_000, label: 'task A submitted its long shake'});
    // B queues behind the running A
    const b = await createTask(api, sessionId, 'queue head B', goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 300}), 'gap-b');
    assert.equal(b.status, 'queued');

    // A goes terminal (model fail_task) while the shake is still in flight:
    // the terminal→promotion gap opens and must stay open
    await api.post(`/sessions/${sessionId}/messages`, {content: 'STOP A NOW', request_id: 'gap-stop-a'});
    await waitFor(async () => (await taskStatus(api, a.task_id)) === 'failed' ? true : null,
      {timeoutMs: 30_000, label: 'task A failed while its shake is in flight'});
    const gapStatus = await api.get<SessionStatus & {session: {handoff_pending: boolean}}>(`/sessions/${sessionId}/status`);
    assert.equal(gapStatus.session.handoff_pending, true, 'the persisted handoff marker is visible');
    assert.equal(gapStatus.queued_tasks, 1);

    // arrivals during the gap — user HTTP, supervisor HTTP, chat propose_task
    const c1 = await createTask(api, sessionId, 'C1 user HTTP', goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 300}), 'gap-c1');
    assert.equal(c1.status, 'queued', 'N04: no ready birth during the gap (user HTTP)');
    assert.equal(c1.queue_position, 2, 'behind B, not ahead of it');
    const c2 = await api.post<{task_id: string; status: string; queue_position: number | null}>(
      `/supervisor/v1/sessions/${sessionId}/tasks`, {goal_text: 'C2 supervisor', delegated_principal: 'dsh-gap',
        goal_spec: goalSpec({deadlineOffsetSimS: simNow + 7200, intervalSimS: 300}), request_id: 'gap-c2'});
    assert.equal(c2.status, 'queued', 'N04: no ready birth during the gap (supervisor)');
    assert.equal(c2.queue_position, 3);
    await api.post(`/sessions/${sessionId}/messages`, {content: 'PROPOSE-C3 please', request_id: 'gap-propose'});
    const c3TaskId = await waitFor(async () => {
      const events = await sessionEvents(api, sessionId);
      const created = events.filter(e => e.type === 'task.created'
        && String(e.payload.goal_text) === 'C3 chat-proposed').at(-1);
      return created ? String(created.payload.task_id) : null;
    }, {timeoutMs: 30_000, label: 'chat propose_task created C3'});
    const c3 = (await api.get<TaskView>(`/tasks/${c3TaskId}`)).task;
    assert.equal(c3.status, 'queued', 'N04: no ready birth during the gap (chat propose_task)');
    assert.equal(c3.queue_position, 4);

    // the gap is still closed for execution: no promotion happened, nothing
    // wrote, and no task holds the slot
    const duringGap = await sessionEvents(api, sessionId);
    assert.equal(duringGap.filter(e => e.type === 'task.promoted').length, 0,
      'the in-flight action barrier blocks every promotion');
    const actionsDuringGap = await serviceActionsByTask(operator, experimentId, sessionId);
    assert.ok(actionsDuringGap.every(x => x.task_id === a.task_id),
      'no task but A (before its terminal point) touched the device during the gap');
    const gapQueue = await api.get<SessionStatus>(`/sessions/${sessionId}/status`);
    assert.deepEqual(gapQueue.queue.map(q => q.task_id), [b.task_id, c1.task_id, c2.task_id, c3TaskId]);
    assert.equal(gapQueue.task?.task_id, a.task_id, 'status shows the last terminal task, not a queued one');

    // close the gap: speed up so the shake terminates; the barrier clears and
    // B — the queue head — is promoted FIRST (never C1/C2/C3)
    await operator.control(experimentId, {speed: 1200});
    const dump = async (where: string): Promise<void> => {
      const events = await sessionEvents(api, sessionId);
      console.error(`[N04 diag ${where}]`, JSON.stringify(events.slice(-40), null, 1).slice(0, 12_000));
      const detail = await api.get<{tasks: Array<{task_id: string; status: string; reason: string | null}>}>(`/sessions/${sessionId}`);
      console.error(`[N04 diag ${where} tasks]`, JSON.stringify(detail.tasks));
    };
    const promotedId = await waitFor(async () => {
      const events = await sessionEvents(api, sessionId);
      const promoted = events.filter(e => e.type === 'task.promoted').at(0);
      return promoted ? String(promoted.payload.task_id) : null;
    }, {timeoutMs: 60_000, label: 'first promotion after the barrier cleared'}).catch(async e => {await dump('promotion'); throw e;});
    assert.equal(promotedId, b.task_id, 'B (queue head) is promoted first, before C1/C2/C3');
    await waitFor(async () => (await serviceActionsByTask(operator, experimentId, sessionId))
      .some(x => x.task_id === b.task_id) ? true : null,
      {timeoutMs: 60_000, label: 'B wrote its first action after promotion'}).catch(async e => {await dump('first-write'); throw e;});

    // cleanup: cancel the rest; the queued C tasks never wrote
    for (const id of [c1.task_id, c2.task_id, c3TaskId, b.task_id]) {
      await api.post(`/tasks/${id}/control`, {action: 'cancel'}).catch(() => undefined);
    }
    await sleep(800);
    const finalActions = await serviceActionsByTask(operator, experimentId, sessionId);
    assert.equal(finalActions.filter(x => x.task_id === a.task_id).length, 1, 'A wrote exactly its shake');
    assert.ok(finalActions.some(x => x.task_id === b.task_id), 'B did its own work after promotion');
    assert.equal(finalActions.some(x => x.task_id === c1.task_id || x.task_id === c2.task_id || x.task_id === c3TaskId),
      false, 'no arrival jumped the queue into the device');
    const finalEvents = await sessionEvents(api, sessionId);
    assertSequentialSingleWriter(finalEvents, [a.task_id, b.task_id, c1.task_id, c2.task_id, c3TaskId], 'N04 gap');
  } finally {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await stub.close();
  }
});
