// Long-lived session HTTP API (design §9). Mounted inside the Culture Agent
// behind X-Service-Token; the Runtime gateway exposes it same-origin at
// /api/v1/agent/sessions* for the browser and the supervisor contract reuses
// the same core. request_id idempotency everywhere a write can be retried.
import {DeviceClient, DeviceError} from '@oscar/device-contract';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {missingExecutionParameters, normalizeGoalSpec, GoalSpecError} from './goal.ts';
import type {SessionManager} from './session-manager.ts';
import type {SessionRow} from './session-store.ts';

export interface SessionRouterDeps {
  manager: SessionManager;
  runtimeUrl: string;
  getServiceToken: () => string | null;
  fetchImpl?: typeof fetch;
  log: (message: string) => void;
}

export interface RouteContext {
  req: IncomingMessage;
  method: string;
  path: string;
  url: URL;
  body: Record<string, unknown>;
  res: ServerResponse;
}

export class SessionApiRouter {
  private readonly deps: SessionRouterDeps;
  readonly prefix = '/sessions';

  constructor(deps: SessionRouterDeps) { this.deps = deps; }

  private deviceClient(): DeviceClient {
    return new DeviceClient({baseUrl: this.deps.runtimeUrl, token: () => this.deps.getServiceToken() ?? undefined,
      timeoutMs: 15_000, fetch: this.deps.fetchImpl});
  }

  /** Returns true when the request was handled. Throws DeviceError for API errors. */
  async handle(ctx: RouteContext): Promise<boolean> {
    const {method, path, res} = ctx;
    if (path === this.prefix && method === 'GET') return this.listSessions(res);
    if (path === this.prefix && method === 'POST') return this.createSession(ctx);
    const m = /^\/sessions\/([^/]+)(\/[a-z_]*)?$/.exec(path);
    if (!m) return false;
    const sessionId = decodeURIComponent(m[1]);
    const rest = m[2] ?? '';
    const session = this.deps.manager.store.getSession(sessionId);
    if (!session) throw new DeviceError('not_found', `No session ${sessionId}`);
    if (rest === '' && method === 'GET') return this.sessionDetail(res, session);
    if (rest === '/events' && method === 'GET') return this.sessionEvents(ctx, session);
    if (rest === '/messages' && method === 'POST') return this.postMessage(ctx, session);
    if (rest === '/tasks' && method === 'GET') return this.listTasks(res, session);
    if (rest === '/tasks' && method === 'POST') return this.createTask(ctx, session);
    if (rest === '/status' && method === 'GET') return this.sessionStatus(ctx, session);
    if (rest === '/control' && method === 'POST') return this.sessionControl(ctx, session);
    if (rest === '/compact' && method === 'POST') return this.forceCompact(ctx, session);
    if (rest === '/memory' && method === 'GET') return this.memory(res, session);
    return false;
  }

  // -- sessions ------------------------------------------------------------------

  private listSessions(res: ServerResponse): boolean {
    const sessions = this.deps.manager.store.listSessions().map(s => this.sessionSummary(s));
    this.sendJson(res, 200, {sessions});
    return true;
  }

  private sessionSummary(s: SessionRow): Record<string, unknown> {
    const task = this.deps.manager.store.activeTask(s.session_id);
    return {session_id: s.session_id, experiment_id: s.experiment_id, runtime_instance_id: s.runtime_instance_id,
      scenario_id: s.scenario_id, lifecycle: s.lifecycle, archived_reason: s.archived_reason,
      loop_state: s.loop_state, agent_paused: s.agent_paused, backend: s.backend,
      last_message_seq: s.last_message_seq, last_event_seq: s.last_event_seq,
      active_task: task ? {task_id: task.task_id, status: task.status, goal_text: task.goal_text,
        goal_revision: task.goal_revision} : null,
      created_at_wall: s.created_at_wall, updated_at_wall: s.updated_at_wall};
  }

  private async createSession(ctx: RouteContext): Promise<boolean> {
    const {body, res} = ctx;
    const client = this.deviceClient();
    const health = await client.health().catch(() => null);
    const instanceId = (health as {instance_id?: string} | null)?.instance_id ?? this.deps.runtimeUrl;
    let experimentId = typeof body.experiment_id === 'string' && body.experiment_id ? body.experiment_id : null;
    if (!experimentId) {
      const experiments = await client.experiments();
      if (!experiments.current_id) {
        throw new DeviceError('invalid_argument', 'No current experiment on the Runtime; pass experiment_id explicitly');
      }
      experimentId = experiments.current_id;
    }
    const state = await client.state(experimentId);
    if (state.experiment.status !== 'active') {
      throw new DeviceError('experiment_archived',
        `Experiment ${experimentId} is ${state.experiment.status}; archived experiments are read-only`);
    }
    const store = this.deps.manager.store;
    const existing = store.sessionByExperiment(instanceId, experimentId);
    if (existing) {
      this.sendJson(res, 200, {session: this.sessionSummary(existing), created: false});
      return true;
    }
    const session = store.createSession({runtime_instance_id: instanceId, experiment_id: experimentId,
      scenario_id: state.experiment.scenario_id});
    this.deps.manager.emitSessionEvent(session.session_id, 'session.created',
      {experiment_id: experimentId, runtime_instance_id: instanceId, scenario_id: session.scenario_id});
    this.deps.manager.ensureScheduler(session);
    this.deps.log(`[sessions] created ${session.session_id} for ${experimentId}`);
    this.sendJson(res, 201, {session: this.sessionSummary(session), created: true});
    return true;
  }

  private sessionDetail(res: ServerResponse, session: SessionRow): boolean {
    const store = this.deps.manager.store;
    const messages = store.listMessages(session.session_id, 0, 500).slice(-50);
    const tasks = store.listTasks(session.session_id);
    // R07: current task first (never a queued one), else the last terminal one
    const task = store.activeTask(session.session_id)
      ?? [...tasks].reverse().find(t => ['completed', 'failed', 'cancelled'].includes(t.status))
      ?? tasks.at(-1) ?? null;
    this.sendJson(res, 200, {
      session: this.sessionSummary(session),
      messages: messages.map(m => ({message_id: m.message_id, seq: m.seq, role: m.role, content: m.content,
        task_id: m.task_id, created_at_wall: m.created_at_wall})),
      tasks: tasks.map(t => ({task_id: t.task_id, status: t.status, goal_text: t.goal_text,
        goal_revision: t.goal_revision, reason: t.reason, budget: t.budget})),
      queue: store.queuedTasks(session.session_id).map(q => ({task_id: q.task_id, goal_text: q.goal_text,
        status: q.status, position: q.position})),
      plan: task ? store.listPlanSteps(task.task_id).map(s => ({index: s.index_in_plan, skill: s.skill,
        status: s.status, action_ids: s.action_ids, evidence_refs: s.evidence_refs})) : [],
      wakes: store.armedWakes(session.session_id).map(w => ({wake_id: w.wake_id, kind: w.kind,
        target_sim_s: w.target_sim_s, predicate: w.predicate})),
      checkpoint: store.latestCheckpoint(session.session_id) ?? null,
      last_seq: session.last_event_seq,
    });
    return true;
  }

  private memory(res: ServerResponse, session: SessionRow): boolean {
    const checkpoint = this.deps.manager.store.latestCheckpoint(session.session_id);
    this.sendJson(res, 200, {checkpoint});
    return true;
  }

  private sessionEvents(ctx: RouteContext, session: SessionRow): boolean {
    const {url, res, req} = ctx;
    const store = this.deps.manager.store;
    const afterSeq = Number(url.searchParams.get('after_seq') ?? 0) || 0;
    if (url.searchParams.get('format') === 'json') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000) || 1000, 10_000);
      const events = store.sessionEventsAfter(session.session_id, afterSeq, limit);
      this.sendJson(res, 200, {events, last_seq: events.at(-1)?.seq ?? afterSeq,
        session_id: session.session_id});
      return true;
    }
    // SSE with the session's own monotonic seq + Last-Event-ID resume
    const headerSeq = Number(Array.isArray(req.headers['last-event-id'])
      ? req.headers['last-event-id'][0] : req.headers['last-event-id'] ?? 0) || 0;
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
    res.write(': connected\n\n');
    let sent = Math.max(afterSeq, headerSeq);
    const writeEvent = (e: {seq: number; type: string; created_at_wall: string; payload: Record<string, unknown>}): void => {
      res.write(`id: ${e.seq}\nevent: session\ndata: ${JSON.stringify({session_id: session.session_id, seq: e.seq,
        created_at_wall: e.created_at_wall, type: e.type, payload: e.payload})}\n\n`);
      sent = e.seq;
    };
    for (const e of store.sessionEventsAfter(session.session_id, sent, 10_000)) writeEvent(e);
    const unsubscribe = this.deps.manager.onEvents(session.session_id, () => {
      for (const e of store.sessionEventsAfter(session.session_id, sent, 10_000)) writeEvent(e);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref?.();
    req.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
    return true;
  }

  private async sessionStatus(ctx: RouteContext, session: SessionRow): Promise<boolean> {
    const client = this.deviceClient();
    const status = await this.deps.manager.status(session.session_id, session.lifecycle === 'active' ? client : undefined);
    if (!status) throw new DeviceError('not_found', `No session ${session.session_id}`);
    this.sendJson(ctx.res, 200, status);
    return true;
  }

  private postMessage(ctx: RouteContext, session: SessionRow): boolean {
    const {body, res} = ctx;
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw new DeviceError('invalid_argument', 'content (non-empty string) is required');
    if (content.length > 8000) throw new DeviceError('invalid_argument', 'content too long (max 8000 chars)');
    this.requireWritable(session);
    const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : null;
    const before = this.deps.manager.store.getSession(session.session_id)!.last_message_seq;
    const message = this.deps.manager.store.appendMessage(session.session_id,
      {role: 'user', content, request_id: requestId});
    const after = this.deps.manager.store.getSession(session.session_id)!.last_message_seq;
    if (after > before) {
      this.deps.manager.emitSessionEvent(session.session_id, 'message.appended',
        {message_id: message.message_id, seq: message.seq, role: 'user', content});
      this.deps.manager.ensureScheduler(this.deps.manager.store.getSession(session.session_id)!);
      this.deps.manager.schedulerFor(session.session_id)?.onUserMessage();
    }
    this.sendJson(res, 202, {message_id: message.message_id, seq: message.seq, duplicate: after === before});
    return true;
  }

  // -- tasks ----------------------------------------------------------------------

  private listTasks(res: ServerResponse, session: SessionRow): boolean {
    const tasks = this.deps.manager.store.listTasks(session.session_id);
    this.sendJson(res, 200, {tasks: tasks.map(t => this.taskView(t.task_id))});
    return true;
  }

  private async createTask(ctx: RouteContext, session: SessionRow): Promise<boolean> {
    const {body, res} = ctx;
    this.requireWritable(session);
    const goalText = typeof body.goal_text === 'string' ? body.goal_text.trim() : '';
    if (!goalText) throw new DeviceError('invalid_argument', 'goal_text is required');
    const store = this.deps.manager.store;
    // 1. budget (when present): finite integers, 0..100000
    const budget = typeof body.budget === 'object' && body.budget !== null
      ? body.budget as Record<string, unknown> : undefined;
    if (budget) {
      for (const key of ['max_actions', 'max_model_turns']) {
        const v = budget[key];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > 100_000) {
          throw new DeviceError('invalid_argument', `budget.${key} must be an integer between 0 and 100000`);
        }
      }
    }
    // 2. normalize goal spec
    let spec: Record<string, unknown>;
    try {
      spec = normalizeGoalSpec(body.goal_spec) as unknown as Record<string, unknown>;
    } catch (e) {
      if (e instanceof GoalSpecError) {
        throw new DeviceError('invalid_argument', `goal_spec invalid: ${e.problems.join('; ')}`, {problems: e.problems});
      }
      throw e;
    }
    const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : null;
    const mapCreateTaskError = (e: unknown): Error => {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith('request_conflict:')) {
        return new DeviceError('idempotency_conflict', message, {request_id: requestId});
      }
      if (message.startsWith('invalid_budget:')) {
        return new DeviceError('invalid_argument', message);
      }
      return e instanceof Error ? e : new Error(message);
    };
    // 3. request_id idempotency: a replay must return the original task
    // (INCLUDING while it is queued), a divergent body must conflict — both
    // WITHOUT any queue/current-task consideration (store.createTask decides).
    if (requestId) {
      const prior = store.findTaskByRequest(session.session_id, requestId);
      if (prior) {
        // createTask compares the canonical body itself: same row when it
        // matches, request_conflict: when it does not.
        let replayed;
        try {
          replayed = store.createTask(session.session_id, {goal_text: goalText, goal_spec: spec,
            budget: budget as Record<string, number> | undefined, request_id: requestId});
        } catch (e) {
          throw mapCreateTaskError(e);
        }
        this.sendJson(res, 200, {task: this.taskView(replayed.task_id)});
        return true;
      }
    }
    // 4. R07/N04: NO active-task rejection — the store's single idempotent
    // entry persists the task as 'queued' (FIFO) when a current task exists
    // (any non-terminal status, paused/needs_input included), when a queue
    // already exists, or when the previous current task's handoff is still
    // pending (terminal but promotion barriers uncleared).
    let task;
    try {
      task = store.createTask(session.session_id, {goal_text: goalText, goal_spec: spec,
        budget: budget as Record<string, number> | undefined, request_id: requestId});
    } catch (e) {
      throw mapCreateTaskError(e);
    }
    const queued = task.status === 'queued';
    if (!queued) {
      // a task that holds the slot is judged now; a queued task's parameters
      // are judged at promotion (updateTaskGoal may complete them first)
      const missing = missingExecutionParameters(normalizeGoalSpec(spec));
      if (missing.length) {
        store.updateTaskStatus(task.task_id, 'needs_input', missing.join(' | '));
      }
    }
    const queuePosition = store.queuePosition(session.session_id, task.task_id);
    this.deps.manager.emitSessionEvent(session.session_id, 'task.created',
      {task_id: task.task_id, goal_text: goalText, goal_revision: 1, queued,
        queue_position: queuePosition,
        status: queued ? 'queued' : (this.deps.manager.store.getTask(task.task_id)?.status ?? task.status)});
    // 5. scheduler kick: a created task (not user text); a QUEUED create must
    // NOT kick a task turn — the current task keeps the execution slot. N04:
    // it DOES kick the promotion path, so when the slot is genuinely free
    // (terminal previous task, handoff barriers cleared) the queue head
    // becomes ready quickly instead of waiting for the next device event.
    const freshTask = this.deps.manager.store.getTask(task.task_id) ?? task;
    if (!queued && freshTask.status !== 'needs_input') {
      const scheduler = this.deps.manager.ensureScheduler(this.deps.manager.store.getSession(session.session_id)!);
      scheduler?.onTaskCreated();
    } else if (queued) {
      const scheduler = this.deps.manager.ensureScheduler(this.deps.manager.store.getSession(session.session_id)!);
      // bounded wait: the response reports the post-handoff status when the
      // barriers clear at once; slow lookups leave it queued (promotion continues)
      if (scheduler) await Promise.race([scheduler.onTaskQueued(), new Promise(r => setTimeout(r, 3000).unref())]);
    }
    this.sendJson(res, 201, {task: this.taskView(task.task_id)});
    return true;
  }

  private taskView(taskId: string): Record<string, unknown> | null {
    const task = this.deps.manager.store.getTask(taskId);
    if (!task) return null;
    const queued = task.status === 'queued';
    return {task_id: task.task_id, session_id: task.session_id, goal_text: task.goal_text,
      goal_spec: task.goal_spec, goal_revision: task.goal_revision, status: task.status, reason: task.reason,
      queued, queue_position: queued ? this.deps.manager.store.queuePosition(task.session_id, task.task_id) : null,
      budget: task.budget, created_at_wall: task.created_at_wall, updated_at_wall: task.updated_at_wall,
      plan: this.deps.manager.store.listPlanSteps(task.task_id).map(s => ({index: s.index_in_plan, skill: s.skill,
        status: s.status, action_ids: s.action_ids, evidence_refs: s.evidence_refs}))};
  }

  /** Task update + control are also reachable as /tasks/:id[/...] (no session prefix). */
  async handleTaskRoutes(ctx: RouteContext): Promise<boolean> {
    const {method, path, res} = ctx;
    const m = /^\/tasks\/([^/]+)(\/[a-z_]*)?$/.exec(path);
    if (!m) return false;
    const taskId = decodeURIComponent(m[1]);
    const rest = m[2] ?? '';
    const task = this.deps.manager.store.getTask(taskId);
    if (!task) throw new DeviceError('not_found', `No task ${taskId}`);
    if (rest === '' && method === 'GET') {
      this.sendJson(res, 200, {task: this.taskView(taskId)});
      return true;
    }
    if (rest === '' && method === 'POST') return this.updateTask(ctx, task);
    if (rest === '/control' && method === 'POST') return this.controlTask(ctx, task);
    if (rest === '/input' && method === 'POST') return this.provideInput(ctx, task);
    return false;
  }

  private updateTask(ctx: RouteContext, task: {task_id: string; goal_revision: number; session_id: string}): boolean {
    const {body, res} = ctx;
    const store = this.deps.manager.store;
    const session = store.getSession(task.session_id)!;
    this.requireWritable(session);
    if (body.expected_revision !== undefined && typeof body.expected_revision !== 'number') {
      throw new DeviceError('invalid_argument', 'expected_revision must be a number');
    }
    let spec: Record<string, unknown> | undefined;
    if (body.goal_spec !== undefined) {
      try {
        spec = normalizeGoalSpec(body.goal_spec) as unknown as Record<string, unknown>;
      } catch (e) {
        if (e instanceof GoalSpecError) {
          throw new DeviceError('invalid_argument', `goal_spec invalid: ${e.problems.join('; ')}`, {problems: e.problems});
        }
        throw e;
      }
    }
    const result = store.updateTaskGoal(task.task_id, {
      goal_text: typeof body.goal_text === 'string' ? body.goal_text : undefined,
      goal_spec: spec, expected_revision: body.expected_revision as number | undefined});
    if (!result.ok) {
      throw new DeviceError('revision_conflict', `goal_revision is ${result.conflict.actual}, not ${body.expected_revision}`,
        {actual_revision: result.conflict.actual});
    }
    // a goal edit invalidates armed planning waits under the old revision and
    // re-triggers scheduling — but it is NOT user text (no onUserMessage)
    store.cancelPlanningWakes(task.session_id, task.task_id);
    this.deps.manager.emitSessionEvent(task.session_id, 'task.goal_updated',
      {task_id: task.task_id, goal_revision: result.revision, by: 'operator'});
    this.deps.manager.ensureScheduler(store.getSession(task.session_id)!)?.onGoalUpdated();
    this.sendJson(res, 200, {task_id: task.task_id, goal_revision: result.revision});
    return true;
  }

  private controlTask(ctx: RouteContext, task: {task_id: string; session_id: string; status: string}): boolean {
    const {body, res} = ctx;
    const action = String(body.action ?? '');
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      throw new DeviceError('invalid_argument', "action must be 'pause' | 'resume' | 'cancel'");
    }
    const store = this.deps.manager.store;
    const session = store.getSession(task.session_id)!;
    const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
    if (action === 'cancel') {
      // an already-terminal task stays exactly as it is (no resurrection)
      if (terminal) {
        this.sendJson(res, 200, {task_id: task.task_id, status: task.status});
        return true;
      }
      // R07: cancelling a QUEUE item (head or middle) — cancelled, no device
      // effect, remaining order preserved (queue_index is never reused)
      const scheduler = this.deps.manager.schedulerFor(session.session_id);
      if (scheduler) void scheduler.cancelTask(task.task_id);
      else {
        const wasQueued = task.status === 'queued';
        store.updateTaskStatus(task.task_id, 'cancelled',
          wasQueued ? 'cancelled from the queue by operator' : 'cancelled by operator');
        store.cancelWakes(session.session_id, task.task_id);
      }
      this.sendJson(res, 200, {task_id: task.task_id, status: 'cancelled'});
      return true;
    }
    this.requireWritable(session);
    // R07: pause/resume are queue-slot controls — a QUEUED task holds no slot
    // yet; only cancel applies while queued (documented in API_CONTRACT.md)
    if (task.status === 'queued') {
      throw new DeviceError('task_queued',
        `task ${task.task_id} is queued (position ${store.queuePosition(session.session_id, task.task_id) ?? '?'}); `
        + 'only cancel applies to a queued task — pause/resume take effect after promotion');
    }
    if (action === 'pause') {
      // pausing a terminal task is a no-op that reports the current status
      if (terminal) {
        this.sendJson(res, 200, {task_id: task.task_id, status: task.status});
        return true;
      }
      store.updateTaskStatus(task.task_id, 'paused', 'operator');
      this.deps.manager.emitSessionEvent(session.session_id, 'task.status',
        {task_id: task.task_id, status: 'paused', reason: 'operator'});
      this.sendJson(res, 200, {task_id: task.task_id, status: 'paused'});
      return true;
    }
    // resume: only from paused; a terminal task can never be resumed
    if (terminal) {
      throw new DeviceError('invalid_argument',
        `task ${task.task_id} is ${task.status} and cannot be resumed; create a new task instead`);
    }
    if (task.status !== 'paused') {
      this.sendJson(res, 200, {task_id: task.task_id, status: task.status});
      return true;
    }
    store.updateTaskStatus(task.task_id, 'waiting_condition', 'resumed by operator');
    this.deps.manager.emitSessionEvent(session.session_id, 'task.status',
      {task_id: task.task_id, status: 'waiting_condition', reason: 'operator_resume'});
    this.deps.manager.ensureScheduler(store.getSession(session.session_id)!)?.onTaskResumed();
    this.sendJson(res, 200, {task_id: task.task_id, status: 'waiting_condition'});
    return true;
  }

  private provideInput(ctx: RouteContext, task: {task_id: string; session_id: string; status: string}): boolean {
    const {body, res} = ctx;
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw new DeviceError('invalid_argument', 'content is required');
    const store = this.deps.manager.store;
    const session = store.getSession(task.session_id)!;
    this.requireWritable(session);
    const message = store.appendMessage(session.session_id, {role: 'user', content,
      request_id: typeof body.request_id === 'string' ? body.request_id : null, task_id: task.task_id});
    this.deps.manager.emitSessionEvent(session.session_id, 'message.appended',
      {message_id: message.message_id, seq: message.seq, role: 'user', content, task_id: task.task_id});
    this.deps.manager.schedulerFor(session.session_id)?.onUserMessage();
    this.sendJson(res, 202, {message_id: message.message_id});
    return true;
  }

  // -- session-level control --------------------------------------------------------

  private sessionControl(ctx: RouteContext, session: SessionRow): boolean {
    const {body, res} = ctx;
    const action = String(body.action ?? '');
    const manager = this.deps.manager;
    if (action === 'pause_agent') {
      this.requireWritable(session);
      manager.schedulerFor(session.session_id)?.pause();
      if (!manager.schedulerFor(session.session_id)) {
        manager.store.updateSession(session.session_id, {agent_paused: true, loop_state: 'paused',
          loop_state_detail: 'operator (scheduler not running)'});
      }
      this.sendJson(res, 200, {session_id: session.session_id, agent_paused: true});
      return true;
    }
    if (action === 'resume_agent') {
      this.requireWritable(session);
      const scheduler = manager.schedulerFor(session.session_id) ?? manager.ensureScheduler(manager.store.getSession(session.session_id)!);
      scheduler?.resume();
      if (!scheduler) {
        manager.store.updateSession(session.session_id, {agent_paused: false, loop_state: 'idle', loop_state_detail: null});
      }
      this.sendJson(res, 200, {session_id: session.session_id, agent_paused: false});
      return true;
    }
    throw new DeviceError('invalid_argument', "action must be 'pause_agent' | 'resume_agent'");
  }

  private forceCompact(ctx: RouteContext, session: SessionRow): boolean {
    void ctx;
    const store = this.deps.manager.store;
    this.requireWritable(session);
    // Reuse the scheduler's compaction by arming a tiny wake? No — compaction
    // here is the deterministic backend.compact over stored history.
    const checkpoint = store.latestCheckpoint(session.session_id);
    const task = store.activeTask(session.session_id);
    const messages = store.listMessages(session.session_id, checkpoint?.covered_message_seq ?? 0, 10_000)
      .filter(m => m.role !== 'system');
    const facts: string[] = [];
    for (const intent of store.listSessionIntents(session.session_id).slice(-20)) {
      facts.push(`${intent.capability} ${intent.action_id ?? '(pending)'} [r${intent.goal_revision}]`);
    }
    for (const step of task ? store.listPlanSteps(task.task_id) : []) {
      facts.push(`step ${step.index_in_plan} ${step.skill} ${step.status} ${step.action_ids.join(',')}`);
    }
    const history = messages.map(m => ({role: m.role as 'user' | 'assistant', content: m.content}));
    const evidenceRefs = store.listSessionIntents(session.session_id).filter(i => i.action_id).map(i => i.action_id!);
    // F09: constraints/open questions must survive forced compaction rounds —
    // feed the previous checkpoint back in, plus the live plan and wakes.
    const planSteps = (task ? store.listPlanSteps(task.task_id) : []).map(s => ({skill: s.skill, status: s.status}));
    const wakes = store.armedWakes(session.session_id)
      .map(w => ({kind: w.kind, target_sim_s: w.target_sim_s, predicate: w.predicate}));
    const compacted = this.deps.manager.backend.compact({history, task: task ?? null,
      facts, evidenceRefs,
      previous: checkpoint ? {summary: checkpoint.summary, facts: checkpoint.facts,
        open_questions: checkpoint.open_questions} : null,
      plan: planSteps, wakes});
    try {
      const covered = store.getSession(session.session_id)!.last_message_seq;
      store.insertCheckpoint({session_id: session.session_id, generation: (checkpoint?.generation ?? 0) + 1,
        covered_message_seq: covered, goal_revision: task?.goal_revision ?? 0, summary: compacted.summary,
        facts: compacted.facts, open_questions: compacted.open_questions,
        evidence_refs: evidenceRefs, versions: {backend: this.deps.manager.backend.id, forced: true}});
      this.deps.manager.emitSessionEvent(session.session_id, 'checkpoint.created',
        {generation: (checkpoint?.generation ?? 0) + 1, covered_message_seq: covered, forced: true});
      this.sendJson(ctx.res, 200, {compacted: true, generation: (checkpoint?.generation ?? 0) + 1});
    } catch (e) {
      throw new DeviceError('internal', `compaction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  }

  // -- helpers -----------------------------------------------------------------------

  private requireWritable(session: SessionRow): void {
    if (session.lifecycle !== 'active') {
      throw new DeviceError('session_archived',
        `Session ${session.session_id} is archived (${session.archived_reason}); read-only`);
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end(JSON.stringify(body));
  }
}
