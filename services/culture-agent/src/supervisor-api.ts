// Supervisor (总助手) contract v1 (design §9): the future higher-level
// assistant delegates and observes Agent–device loops WITHOUT DOM or database
// access. It reuses the exact same session core, queue, permissions, budget
// and revision checks — only the surface differs (delegated_principal,
// request_id, expected_revision everywhere; long tasks return task_id
// immediately; a dropped subscription NEVER cancels a device task).
//
//   GET  /supervisor/v1/overview                     devices × sessions × loops
//   POST /supervisor/v1/sessions                     {experiment_id} → session (idempotent)
//   POST /supervisor/v1/sessions/:id/messages        {content, request_id}
//   POST /supervisor/v1/sessions/:id/tasks           {goal_text, goal_spec, request_id} → task_id
//   GET  /supervisor/v1/sessions/:id/status          aggregated status
//   POST /supervisor/v1/tasks/:id                    update goal (expected_revision)
//   POST /supervisor/v1/tasks/:id/control            pause/resume/cancel
//   GET  /supervisor/v1/sessions/:id/events?after_seq=  subscribe (SSE/JSON)
import {DeviceError} from '@oscar/device-contract';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {normalizeGoalSpec, GoalSpecError, missingExecutionParameters} from './goal.ts';
import type {SessionManager} from './session-manager.ts';
import type {RouteContext} from './sessions-api.ts';

export interface SupervisorDeps {
  manager: SessionManager;
  runtimeUrl: string;
  getServiceToken: () => string | null;
  fetchImpl?: typeof fetch;
  log: (message: string) => void;
}

export const SUPERVISOR_CONTRACT_VERSION = '1.0.0';

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
            'sessions/:id/status', 'sessions/:id/events', 'tasks/:id', 'tasks/:id/control']});
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
        this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task});
        return true;
      }
      if (rest === '' && method === 'POST') return this.updateTask(ctx, task);
      if (rest === '/control' && method === 'POST') return this.controlTask(ctx, task);
      throw new DeviceError('not_found', `No supervisor route ${method} ${path}`);
    }
    throw new DeviceError('not_found', `No supervisor route ${method} ${path}`);
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
        const task = this.deps.manager.store.activeTask(s.session_id);
        return {session_id: s.session_id, experiment_id: s.experiment_id, lifecycle: s.lifecycle,
          loop_state: s.loop_state, agent_paused: s.agent_paused,
          active_task: task ? {task_id: task.task_id, status: task.status, goal_revision: task.goal_revision,
            budget: task.budget} : null,
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

  private createTask(ctx: RouteContext, session: {session_id: string; lifecycle: string}): boolean {
    if (session.lifecycle !== 'active') {
      throw new DeviceError('session_archived', 'session is archived; read-only');
    }
    const {body, res} = ctx;
    const goalText = typeof body.goal_text === 'string' ? body.goal_text.trim() : '';
    if (!goalText) throw new DeviceError('invalid_argument', 'goal_text is required');
    let spec: Record<string, unknown>;
    try {
      spec = normalizeGoalSpec(body.goal_spec) as unknown as Record<string, unknown>;
    } catch (e) {
      if (e instanceof GoalSpecError) {
        throw new DeviceError('invalid_argument', `goal_spec invalid: ${e.problems.join('; ')}`);
      }
      throw e;
    }
    const store = this.deps.manager.store;
    if (store.activeTask(session.session_id)) {
      throw new DeviceError('task_already_active', 'one active task per session (MVP); queue via messages');
    }
    const task = store.createTask(session.session_id, {goal_text: goalText, goal_spec: spec,
      request_id: typeof body.request_id === 'string' ? body.request_id : null});
    const missing = missingExecutionParameters(normalizeGoalSpec(spec));
    if (missing.length) store.updateTaskStatus(task.task_id, 'needs_input', missing.join(' | '));
    this.deps.manager.emitSessionEvent(session.session_id, 'task.created',
      {task_id: task.task_id, goal_text: goalText, goal_revision: 1, by: 'supervisor',
        delegated_principal: body.delegated_principal, status: missing.length ? 'needs_input' : 'ready'});
    this.deps.manager.ensureScheduler(store.getSession(session.session_id)!);
    this.deps.manager.schedulerFor(session.session_id)?.onUserMessage();
    // long task → task_id immediately; progress via status/subscribe only
    this.sendJson(res, 202, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
      status: task.status, accepted: true});
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
    this.deps.manager.emitSessionEvent(task.session_id, 'task.goal_updated',
      {task_id: task.task_id, goal_revision: result.revision, by: 'supervisor',
        delegated_principal: body.delegated_principal});
    this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id,
      goal_revision: result.revision});
    return true;
  }

  private controlTask(ctx: RouteContext, task: {task_id: string; session_id: string}): boolean {
    const {body, res} = ctx;
    const action = String(body.action ?? '');
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      throw new DeviceError('invalid_argument', "action must be 'pause' | 'resume' | 'cancel'");
    }
    const store = this.deps.manager.store;
    if (action === 'cancel') {
      const scheduler = this.deps.manager.schedulerFor(task.session_id);
      if (scheduler) void scheduler.cancelTask(task.task_id);
      else {
        store.updateTaskStatus(task.task_id, 'cancelled', `supervisor cancel (${String(body.delegated_principal)})`);
        store.cancelWakes(task.session_id, task.task_id);
      }
      this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id, status: 'cancelled'});
      return true;
    }
    if (action === 'pause') {
      store.updateTaskStatus(task.task_id, 'paused', `supervisor pause (${String(body.delegated_principal)})`);
      this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id, status: 'paused'});
      return true;
    }
    store.updateTaskStatus(task.task_id, 'waiting_condition', 'supervisor resume');
    this.deps.manager.emitSessionEvent(task.session_id, 'task.status',
      {task_id: task.task_id, status: 'waiting_condition', by: 'supervisor'});
    this.deps.manager.schedulerFor(task.session_id)?.onUserMessage();
    this.sendJson(res, 200, {contract_version: SUPERVISOR_CONTRACT_VERSION, task_id: task.task_id, status: 'waiting_condition'});
    return true;
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end(JSON.stringify(body));
  }
}
