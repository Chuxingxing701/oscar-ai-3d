// SessionManager: owns scheduler instances, startup recovery and the
// aggregated status view. One scheduler per active-lifecycle session; a
// restarted process re-claims ownership (fencing generation), so the previous
// owner's late model responses cannot write.
import type {DeviceClient, StateSnapshot} from '@oscar/device-contract';
import {DeviceError} from '@oscar/device-contract';
import type {AgentBackend} from './backend.ts';
import {SessionScheduler, type SchedulerDeps} from './scheduler.ts';
import type {LoopState, SessionStore, SessionRow} from './session-store.ts';

export interface SessionManagerDeps {
  store: SessionStore;
  runtimeUrl: string;
  getServiceToken: () => string | null;
  backend: AgentBackend;
  fetchImpl?: typeof fetch;
  compactionMessageThreshold?: number;
  log: (message: string) => void;
}

export interface SessionStatusView {
  session: SessionRow;
  device: {
    reachable: boolean;
    clock_mode?: string;
    paused?: boolean;
    speed?: number;
    sim_time_s?: number;
    event_seq?: number;
    in_flight_actions?: number;
    error?: string;
  };
  loop: {state: LoopState; detail: string | null; agent_paused: boolean; owner_generation: number};
  task: Record<string, unknown> | null;
  queued_tasks: number;
  next_wake: {wake_id: string; kind: string; target_sim_s: number | null; predicate: Record<string, unknown> | null} | null;
  wakes_armed: number;
  budget: {actions_used: number; max_actions: number; model_turns_used: number; max_model_turns: number} | null;
  watermarks: {last_message_seq: number; last_event_seq: number; inbox_cursor: number;
    checkpoint_generation: number; covered_message_seq: number | null};
  model: {backend: string; configured: boolean; missing?: string[]};
}

export class SessionManager {
  private readonly schedulers = new Map<string, SessionScheduler>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly deps: SessionManagerDeps;

  constructor(deps: SessionManagerDeps) { this.deps = deps; }

  get store(): SessionStore { return this.deps.store; }
  get backend(): AgentBackend { return this.deps.backend; }

  emitSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    this.deps.store.appendSessionEvent(sessionId, type, payload);
    const set = this.listeners.get(sessionId);
    if (set) for (const fn of set) fn();
  }

  onEvents(sessionId: string, fn: () => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** (Re)start the scheduler for a session if it should run. */
  ensureScheduler(session: SessionRow): SessionScheduler | null {
    if (session.lifecycle !== 'active') return null;
    const existing = this.schedulers.get(session.session_id);
    if (existing && !existing.dead) return existing;
    const deps: SchedulerDeps = {
      store: this.deps.store,
      config: {runtimeUrl: this.deps.runtimeUrl, compactionMessageThreshold: this.deps.compactionMessageThreshold ?? 40},
      getServiceToken: this.deps.getServiceToken,
      backend: this.deps.backend,
      fetchImpl: this.deps.fetchImpl,
      emit: (sessionId, type, payload) => this.emitSessionEvent(sessionId, type, payload),
      log: m => this.deps.log(m),
      onSessionArchived: sessionId => { void sessionId; },
    };
    const scheduler = new SessionScheduler(deps, session);
    this.schedulers.set(session.session_id, scheduler);
    scheduler.start();
    return scheduler;
  }

  schedulerFor(sessionId: string): SessionScheduler | undefined { return this.schedulers.get(sessionId); }

  async stopAll(): Promise<void> {
    const all = [...this.schedulers.values()];
    for (const s of all) s.stop();
    await Promise.race([Promise.all(all.map(s => s.done)), new Promise(r => setTimeout(r, 5000).unref())]);
    this.schedulers.clear();
  }

  /** Startup recovery: schedulers claim ownership and reconcile (§7.2). */
  recoverAll(): void {
    for (const session of this.deps.store.listSessions()) {
      if (session.lifecycle !== 'active') continue;
      this.ensureScheduler(session);
    }
  }

  /** Aggregated status for the UI / supervisor (freshness of device AND loop). */
  async status(sessionId: string, deviceClient?: DeviceClient): Promise<SessionStatusView | null> {
    const session = this.deps.store.getSession(sessionId);
    if (!session) return null;
    const tasks = this.deps.store.listTasks(sessionId);
    // the ACTIVE task, or the most recent terminal one (the UI and callers
    // still want to see what last happened on this session)
    const task = this.deps.store.activeTask(sessionId) ?? tasks.at(-1) ?? null;
    const wakes = this.deps.store.armedWakes(sessionId);
    const checkpoint = this.deps.store.latestCheckpoint(sessionId);
    const device: SessionStatusView['device'] = {reachable: false};
    if (deviceClient && session.lifecycle === 'active') {
      try {
        const state: StateSnapshot = await deviceClient.state(session.experiment_id);
        device.reachable = true;
        device.clock_mode = state.experiment.clock_mode;
        device.paused = state.experiment.paused;
        device.speed = state.experiment.speed;
        device.sim_time_s = state.experiment.sim_time_s;
        device.event_seq = state.event_seq;
        device.in_flight_actions = state.active_actions.length;
      } catch (e) {
        device.reachable = false;
        device.error = e instanceof DeviceError ? `${e.code}: ${e.message}` : String(e);
      }
    }
    const nextWake = wakes
      .filter(w => w.kind === 'sim_time')
      .sort((a, b) => (a.target_sim_s ?? Infinity) - (b.target_sim_s ?? Infinity))[0]
      ?? wakes[0] ?? null;
    const availability = this.deps.backend.available();
    return {
      session,
      device,
      loop: {state: session.loop_state, detail: session.loop_state_detail,
        agent_paused: session.agent_paused, owner_generation: session.owner_generation},
      task: task ? {task_id: task.task_id, status: task.status, reason: task.reason,
        goal_text: task.goal_text, goal_revision: task.goal_revision, budget: task.budget,
        plan: this.deps.store.listPlanSteps(task.task_id).map(s => ({index: s.index_in_plan, skill: s.skill,
          status: s.status, action_ids: s.action_ids, evidence_refs: s.evidence_refs}))} : null,
      queued_tasks: tasks.filter(t => t !== task && !['completed', 'failed', 'cancelled'].includes(t.status)).length,
      next_wake: nextWake ? {wake_id: nextWake.wake_id, kind: nextWake.kind, target_sim_s: nextWake.target_sim_s,
        predicate: nextWake.predicate} : null,
      wakes_armed: wakes.length,
      budget: task ? task.budget : null,
      watermarks: {last_message_seq: session.last_message_seq, last_event_seq: session.last_event_seq,
        inbox_cursor: session.inbox_cursor, checkpoint_generation: checkpoint?.generation ?? 0,
        covered_message_seq: checkpoint?.covered_message_seq ?? null},
      model: {backend: this.deps.backend.id, configured: availability.ok, missing: availability.missing},
    };
  }
}
