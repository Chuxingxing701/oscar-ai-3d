// Supervisor (总助手) contract v1.1 (design §9): the future higher-level
// assistant delegates and observes Agent–device loops WITHOUT DOM or database
// access. It reuses the exact same session core, queue, permissions, budget
// and revision checks — only the surface differs (delegated_principal,
// request_id, expected_revision everywhere; long tasks return task_id
// immediately; a dropped subscription NEVER cancels a device task).
// R07: delegating while a task is current returns status 'queued' with the
// FIFO queue_position; promotion to the execution slot is automatic.
//
//   GET  /supervisor/v1/overview                     devices × sessions × loops × queue
//   POST /supervisor/v1/sessions                     {experiment_id} → session (idempotent)
//   POST /supervisor/v1/sessions/:id/messages        {content, request_id}
//   POST /supervisor/v1/sessions/:id/tasks           {goal_text, goal_spec, request_id} → task_id (+queue_position)
//   GET  /supervisor/v1/sessions/:id/status          aggregated status (incl. queue)
//   GET  /supervisor/v1/tasks/:id                    task detail incl. the persisted plan (execution evidence)
//   POST /supervisor/v1/tasks/:id                    update goal (expected_revision)
//   POST /supervisor/v1/tasks/:id/control            pause/resume/cancel (queued: cancel only)
//   GET  /supervisor/v1/sessions/:id/events?after_seq=  subscribe (SSE/JSON)
import {DeviceError} from '@oscar/device-contract';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {normalizeGoalSpec, GoalSpecError, missingExecutionParameters} from './goal.ts';
import type {SessionManager} from './session-manager.ts';
import type {TaskRow} from './session-store.ts';
import type {RouteContext} from './sessions-api.ts';

export interface SupervisorDeps {
  manager: SessionManager;
  runtimeUrl: string;
  getServiceToken: () => string | null;
  fetchImpl?: typeof fetch;
  log: (message: string) => void;
}

export const SUPERVISOR_CONTRACT_VERSION = '1.1.0';

export class SupervisorApiRouter {
  private readonly deps: SupervisorDeps;

  constructor(deps: SupervisorDeps) { this.deps = deps; }

  async handle(ctx: RouteContext): Promise<boolean> {
    const {method, path, res} = ctx;
    if (!path.startsWith('/supervisor')) return false;
    const sub = path.slice('/supervisor'.length) || '/';
    const v = /^\/v1(\/.*)?$/.exec(sub);
    if (!v) {
      if (sub === '/' && method === 'GET') {
        this.sendJson(res, 200, {contract: 'oscar-supervisor', version: SUPERVISOR_CONTRACT_VERSION,
          operations: ['overview', 'sessions', 'sessions/:id/messages', 'sessions/:id/tasks',
            'sessions/:id/status', 'sessions/:id/events', 'GET tasks/:id', 'tasks/:id', 'tasks/:id/control']});
        return true;
      }
      throw new DeviceError('not_found', `No supervisor route ${method} ${path}`);
    }
    const p = v[1] ?? '/';
    this.requireDelegation(ctx.body, method);
    if (p === '/overview' && method === 'GET') return this.overview(res);
    if (p === '/sessions' && method === 'POST') return this.createSession(ctx);
    const sm = /^\/sessions\/([^/]+)(\/[a-z_]*)?$/.exec(p);
    if (sm) {
      const sessionId = decodeURIComponent(sm[1]);
      const rest = sm[2] ?? '';
      const session = this.deps.manager.store.getSession(sessionId);
      if (!session) throw new DeviceError('not_found', `No session ${sessionId}`);
      if (rest === '/messages' && method === 'POST') return this.message(ctx, session);
      if (rest === '/tasks' && method === 'POST') return this.createTask(ctx, session);
      if (rest === '/status' && method === 'GET') return this.status(ctx, session);
      if (rest === '/events' && method === 'GET') return this.events(ctx, session);
      throw new DeviceError('not_found', `No supervisor route ${method} ${path}`);
    }
    const tm = /^\/tasks\/([^/]+)(\/[a-z_]*)?$/.exec(p);
    if (tm) {
      const taskId = decodeURIComponent(tm[1]);
      const rest = tm[2] ?? '';
      const task = this.deps.manager.store.getTask(taskId);
      if (!task) throw new DeviceError('not_found', `No task ${taskId}`);
      if (rest === '' && method === 'GET') {
        this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task: this.taskView(task)});
        return true;
      }
      if (rest === '' && method === 'POST') return this.updateTask(ctx, task);
      if (rest === '/control' && method === 'POST') return this.controlTask(ctx, task);
      throw new DeviceError('not_found', `No supervisor route ${method} ${path}`);
    }
    throw new DeviceError('not_found', `No supervisor route ${method} ${path}`);
  }

  /**
   * The SAME task view the session API's GET /tasks/:id returns
   * (sessions-api.ts taskView): the bare store row carries no execution
   * evidence, so the delegator's task detail includes the persisted plan
   * (steps with their action ids and evidence refs) — the delegate cannot
   * observe progress without it.
   */
  private taskView(task: TaskRow): Record<string, unknown> {
    const store = this.deps.manager.store;
    const queued = task.status === 'queued';
    return {task_id: task.task_id, session_id: task.session_id, goal_text: task.goal_text,
      goal_spec: task.goal_spec, goal_revision: task.goal_revision, status: task.status, reason: task.reason,
      queued, queue_position: queued ? store.queuePosition(task.session_id, task.task_id) : null,
      budget: task.budget, created_at_wall: task.created_at_wall, updated_at_wall: task.updated_at_wall,
      plan: store.listPlanSteps(task.task_id).map(s => ({index: s.index_in_plan, skill: s.skill,
        status: s.status, action_ids: s.action_ids, evidence_refs: s.evidence_refs}))};
  }

  /** Server-side identity record: we log who delegated, we never trust it for rights. */
  private requireDelegation(body: Record<string, unknown>, method: string): void {
    if (method === 'GET') return;
    const principal = body.delegated_principal;
    if (typeof principal !== 'string' || !principal.trim()) {
      throw new DeviceError('invalid_argument',
        'supervisor writes require delegated_principal (recorded for audit; rights are enforced server-side)');
    }
  }

  private overview(res: ServerResponse): boolean {
    const sessions = this.deps.manager.store.listSessions();
    this.sendJson(res, 200, {
      contract_version: SUPERVISOR_CONTRACT_VERSION,
      runtime_url: this.deps.runtimeUrl,
      sessions: sessions.map(s => {
        const store = this.deps.manager.store;
        const task = store.activeTask(s.session_id);
        // R07: the ordered queue behind the current task
        const queue = store.queuedTasks(s.session_id)
          .map(q => ({task_id: q.task_id, goal_text: q.goal_text, status: q.status, position: q.position}));
        return {session_id: s.session_id, experiment_id: s.experiment_id, lifecycle: s.lifecycle,
          loop_state: s.loop_state, agent_paused: s.agent_paused,
          active_task: task ? {task_id: task.task_id, status: task.status, goal_revision: task.goal_revision,
            budget: task.budget} : null,
          queue, queued_tasks: queue.length,
          next_wake: this.deps.manager.store.armedWakes(s.session_id)
            .filter(w => w.kind === 'sim_time').map(w => w.target_sim_s).sort((a, b) => (a ?? 0) - (b ?? 0))[0] ?? null};
      }),
    });
    return true;
  }

  private async createSession(ctx: RouteContext): Promise<boolean> {
    const {body, res} = ctx;
    const {DeviceClient} = await import('@oscar/device-contract');
    const client = new DeviceClient({baseUrl: this.deps.runtimeUrl,
      token: () => this.deps.getServiceToken() ?? undefined, timeoutMs: 15_000, fetch: this.deps.fetchImpl});
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
      throw new DeviceError('experiment_archived', `Experiment ${experimentId} is ${state.experiment.status}`);
    }
    const store = this.deps.manager.store;
    const existing = store.sessionByExperiment(instanceId, experimentId);
    if (existing) {
      this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION,
        session_id: existing.session_id, created: false});
      return true;
    }
    const session = store.createSession({runtime_instance_id: instanceId, experiment_id: experimentId,
      scenario_id: state.experiment.scenario_id});
    this.deps.manager.emitSessionEvent(session.session_id, 'session.created',
      {experiment_id: experimentId, by: 'supervisor', delegated_principal: body.delegated_principal});
    this.deps.manager.ensureScheduler(session);
    this.sendJson(res, 201, {contract_version: SUPERVISOR_CONTRACT_VERSION,
      session_id: session.session_id, created: true});
    return true;
  }

  private message(ctx: RouteContext, session: {session_id: string; lifecycle: string}): boolean {
    if (session.lifecycle !== 'active') {
      throw new DeviceError('session_archived', 'session is archived; read-only');
    }
    const content = typeof ctx.body.content === 'string' ? ctx.body.content.trim() : '';
    if (!content) throw new DeviceError('invalid_argument', 'content is required');
    const store = this.deps.manager.store;
    const message = store.appendMessage(session.session_id, {role: 'user', content,
      request_id: typeof ctx.body.request_id === 'string' ? ctx.body.request_id : null});
    this.deps.manager.emitSessionEvent(session.session_id, 'message.appended',
      {message_id: message.message_id, seq: message.seq, role: 'user', content,
        by: 'supervisor', delegated_principal: ctx.body.delegated_principal});
    this.deps.manager.ensureScheduler(store.getSession(session.session_id)!);
    this.deps.manager.schedulerFor(session.session_id)?.onUserMessage();
    this.sendJson(ctx.res, 202, {contract_version: SUPERVISOR_CONTRACT_VERSION, message_id: message.message_id});
    return true;
  }

  private async createTask(ctx: RouteContext, session: {session_id: string; lifecycle: string}): Promise<boolean> {
    if (session.lifecycle !== 'active') {
      throw new DeviceError('session_archived', 'session is archived; read-only');
    }
    const {body, res} = ctx;
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
        throw new DeviceError('invalid_argument', `goal_spec invalid: ${e.problems.join('; ')}`);
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
    // 3. request_id idempotency: a replay returns the ORIGINAL task —
    // including while it is queued; a divergent body conflicts. The store's
    // createTask decides both (canonical body comparison).
    if (requestId) {
      const prior = store.findTaskByRequest(session.session_id, requestId);
      if (prior) {
        let replayed;
        try {
          replayed = store.createTask(session.session_id, {goal_text: goalText, goal_spec: spec,
            budget: budget as Record<string, number> | undefined, request_id: requestId});
        } catch (e) {
          throw mapCreateTaskError(e);
        }
        const fresh = store.getTask(replayed.task_id) ?? replayed;
        const queuedNow = fresh.status === 'queued';
        this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: replayed.task_id,
          status: fresh.status, queued: queuedNow,
          queue_position: queuedNow ? store.queuePosition(session.session_id, replayed.task_id) : null,
          accepted: true});
        return true;
      }
    }
    // 4. R07/N04: NO active-task rejection — the store's single idempotent
    // entry persists the task as 'queued' (FIFO) when a current task exists,
    // a queue already exists, or the previous current task's handoff is
    // still pending (terminal but promotion barriers uncleared).
    let task;
    try {
      task = store.createTask(session.session_id, {goal_text: goalText, goal_spec: spec,
        budget: budget as Record<string, number> | undefined, request_id: requestId});
    } catch (e) {
      throw mapCreateTaskError(e);
    }
    const queued = task.status === 'queued';
    if (!queued) {
      const missing = missingExecutionParameters(normalizeGoalSpec(spec));
      if (missing.length) store.updateTaskStatus(task.task_id, 'needs_input', missing.join(' | '));
    }
    const queuePosition = store.queuePosition(session.session_id, task.task_id);
    this.deps.manager.emitSessionEvent(session.session_id, 'task.created',
      {task_id: task.task_id, goal_text: goalText, goal_revision: 1, by: 'supervisor',
        delegated_principal: body.delegated_principal, queued, queue_position: queuePosition,
        status: queued ? 'queued' : (store.getTask(task.task_id)?.status ?? task.status)});
    // scheduler kick: a created task (not user text); a QUEUED create never
    // kicks a task turn — the current task keeps the execution slot. N04: it
    // DOES kick the promotion path (handoff barriers permitting) so a free
    // slot is taken by the queue head quickly.
    const freshTask = store.getTask(task.task_id) ?? task;
    if (!queued && freshTask.status !== 'needs_input') {
      const scheduler = this.deps.manager.ensureScheduler(store.getSession(session.session_id)!);
      scheduler?.onTaskCreated();
    } else if (queued) {
      const scheduler = this.deps.manager.ensureScheduler(store.getSession(session.session_id)!);
      // bounded wait: the response reports the post-handoff status when the
      // barriers clear at once; slow lookups leave it queued (promotion continues)
      if (scheduler) await Promise.race([scheduler.onTaskQueued(), new Promise(r => setTimeout(r, 3000).unref())]);
    }
    // long task → task_id immediately; progress via status/subscribe only.
    // Report the status AFTER the needs_input update, not the stale insert row.
    const fresh = store.getTask(task.task_id) ?? task;
    this.sendJson(res, 202, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
      status: fresh.status, queued: fresh.status === 'queued',
      queue_position: fresh.status === 'queued' ? store.queuePosition(session.session_id, task.task_id) : null,
      accepted: true});
    return true;
  }

  private async status(ctx: RouteContext, session: {session_id: string; lifecycle: string}): Promise<boolean> {
    const {DeviceClient} = await import('@oscar/device-contract');
    const client = new DeviceClient({baseUrl: this.deps.runtimeUrl,
      token: () => this.deps.getServiceToken() ?? undefined, timeoutMs: 15_000, fetch: this.deps.fetchImpl});
    const status = await this.deps.manager.status(session.session_id,
      session.lifecycle === 'active' ? client : undefined);
    if (!status) throw new DeviceError('not_found', 'no such session');
    this.sendJson(ctx.res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, ...status});
    return true;
  }

  private events(ctx: RouteContext, session: {session_id: string}): boolean {
    // subscriptions observe only: a dropped connection never cancels a task
    const accept = String(ctx.req.headers.accept ?? '');
    const wantSse = accept.includes('text/event-stream') && !ctx.url.searchParams.get('format');
    if (wantSse) {
      ctx.url.searchParams.set('format', '');
      ctx.url.searchParams.delete('format');
    }
    // Reuse the session event stream (SSE or JSON) verbatim.
    const store = this.deps.manager.store;
    const afterSeq = Number(ctx.url.searchParams.get('after_seq') ?? 0) || 0;
    if (ctx.url.searchParams.get('format') === 'json' || !wantSse) {
      const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 1000) || 1000, 10_000);
      const events = store.sessionEventsAfter(session.session_id, afterSeq, limit);
      this.sendJson(ctx.res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, events,
        last_seq: events.at(-1)?.seq ?? afterSeq});
      return true;
    }
    const res = ctx.res;
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
    res.write(': connected\n\n');
    let sent = afterSeq;
    const writeEvent = (e: {seq: number; type: string; created_at_wall: string; payload: Record<string, unknown>}): void => {
      res.write(`id: ${e.seq}\nevent: supervisor\ndata: ${JSON.stringify({session_id: session.session_id,
        seq: e.seq, type: e.type, payload: e.payload})}\n\n`);
      sent = e.seq;
    };
    for (const e of store.sessionEventsAfter(session.session_id, sent, 10_000)) writeEvent(e);
    const unsubscribe = this.deps.manager.onEvents(session.session_id, () => {
      for (const e of store.sessionEventsAfter(session.session_id, sent, 10_000)) writeEvent(e);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref?.();
    ctx.req.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
    return true;
  }

  private updateTask(ctx: RouteContext, task: {task_id: string; session_id: string; goal_revision: number}): boolean {
    const {body, res} = ctx;
    const store = this.deps.manager.store;
    const session = store.getSession(task.session_id);
    if (!session) throw new DeviceError('not_found', `No session for task ${task.task_id}`);
    if (session.lifecycle !== 'active') {
      throw new DeviceError('session_archived',
        `Session ${task.session_id} is archived (${session.archived_reason}); read-only`);
    }
    let spec: Record<string, unknown> | undefined;
    if (body.goal_spec !== undefined) {
      try {
        spec = normalizeGoalSpec(body.goal_spec) as unknown as Record<string, unknown>;
      } catch (e) {
        if (e instanceof GoalSpecError) throw new DeviceError('invalid_argument', `goal_spec invalid: ${e.problems.join('; ')}`);
        throw e;
      }
    }
    const result = store.updateTaskGoal(task.task_id, {goal_text: typeof body.goal_text === 'string' ? body.goal_text : undefined,
      goal_spec: spec, expected_revision: typeof body.expected_revision === 'number' ? body.expected_revision : undefined});
    if (!result.ok) {
      throw new DeviceError('revision_conflict', `goal_revision is ${result.conflict.actual}`,
        {actual_revision: result.conflict.actual});
    }
    // a goal edit invalidates armed planning waits and re-triggers scheduling;
    // it is NOT user text (no onUserMessage)
    store.cancelPlanningWakes(task.session_id, task.task_id);
    this.deps.manager.emitSessionEvent(task.session_id, 'task.goal_updated',
      {task_id: task.task_id, goal_revision: result.revision, by: 'supervisor',
        delegated_principal: body.delegated_principal});
    this.deps.manager.ensureScheduler(store.getSession(task.session_id)!)?.onGoalUpdated();
    this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
      goal_revision: result.revision});
    return true;
  }

  private controlTask(ctx: RouteContext, task: {task_id: string; session_id: string; status: string}): boolean {
    const {body, res} = ctx;
    const action = String(body.action ?? '');
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      throw new DeviceError('invalid_argument', "action must be 'pause' | 'resume' | 'cancel'");
    }
    const store = this.deps.manager.store;
    const session = store.getSession(task.session_id);
    if (!session) throw new DeviceError('not_found', `No session for task ${task.task_id}`);
    if (session.lifecycle !== 'active') {
      throw new DeviceError('session_archived',
        `Session ${task.session_id} is archived (${session.archived_reason}); read-only`);
    }
    const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
    if (action === 'cancel') {
      // an already-terminal task stays exactly as it is (no resurrection)
      if (terminal) {
        this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
          status: task.status});
        return true;
      }
      // R07: cancelling a QUEUE item (head or middle) — cancelled, no device
      // effect, remaining order preserved (queue_index is never reused)
      const scheduler = this.deps.manager.schedulerFor(task.session_id);
      if (scheduler) void scheduler.cancelTask(task.task_id);
      else {
        const wasQueued = task.status === 'queued';
        store.updateTaskStatus(task.task_id, 'cancelled',
          wasQueued ? `supervisor cancel from queue (${String(body.delegated_principal)})`
            : `supervisor cancel (${String(body.delegated_principal)})`);
        store.cancelWakes(task.session_id, task.task_id);
      }
      this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
        status: 'cancelled'});
      return true;
    }
    // R07: pause/resume are queue-slot controls — a QUEUED task holds no slot
    // yet; only cancel applies while queued (documented in API_CONTRACT.md)
    if (task.status === 'queued') {
      throw new DeviceError('task_queued',
        `task ${task.task_id} is queued (position ${store.queuePosition(task.session_id, task.task_id) ?? '?'}); `
        + 'only cancel applies to a queued task — pause/resume take effect after promotion');
    }
    if (action === 'pause') {
      // pausing a terminal task is a no-op that reports the current status
      if (terminal) {
        this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
          status: task.status});
        return true;
      }
      store.updateTaskStatus(task.task_id, 'paused', `supervisor pause (${String(body.delegated_principal)})`);
      this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
        status: 'paused'});
      return true;
    }
    // resume: only from paused; a terminal task can never be resumed
    if (terminal) {
      throw new DeviceError('invalid_argument',
        `task ${task.task_id} is ${task.status} and cannot be resumed; create a new task instead`);
    }
    if (task.status !== 'paused') {
      this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
        status: task.status});
      return true;
    }
    store.updateTaskStatus(task.task_id, 'waiting_condition', 'supervisor resume');
    this.deps.manager.emitSessionEvent(task.session_id, 'task.status',
      {task_id: task.task_id, status: 'waiting_condition', by: 'supervisor'});
    this.deps.manager.ensureScheduler(store.getSession(task.session_id)!)?.onTaskResumed();
    this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
      status: 'waiting_condition'});
    return true;
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end(JSON.stringify(body));
  }
}
