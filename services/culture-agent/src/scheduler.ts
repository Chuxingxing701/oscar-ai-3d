// Event-driven single-writer scheduler for one long-lived session (design §6).
// Wake sources: user message, action terminal (own intents), observation
// ready, threshold condition (debounce/hysteresis/cooldown), sim timer,
// device recovery. Clock frames, RAF and ordinary sensor sampling NEVER wake
// the model — conditions are evaluated by the scheduler itself and only a
// genuine crossing (debounced) schedules a turn.
//
// Realtime is the product path: the device keeps running while the model
// thinks; every write re-checks ownership generation, goal_revision, scope
// and budget just before submit. Recovery order (§7.2): load session/task/
// messages + inbox cursor → read Runtime state → resolve uncertain intents
// by key → consume missed terminal events → then allow new decisions.
import {DeviceClient, DeviceError, isTerminal} from '@oscar/device-contract';
import type {DeviceEvent, Observation, StateSnapshot} from '@oscar/device-contract';
import {normalizeGoalSpec, type GoalSpec} from './goal.ts';
import {SessionExecutor} from './executor.ts';
import type {AgentBackend, DeviceResultDigest, TurnInput} from './backend.ts';
import type {LoopState, PlanStepRow, SessionRow, SessionStore, TaskRow, WakeRow} from './session-store.ts';

export interface SchedulerDeps {
  store: SessionStore;
  config: {runtimeUrl: string; compactionMessageThreshold: number};
  getServiceToken: () => string | null;
  backend: AgentBackend;
  fetchImpl?: typeof fetch;
  emit: (sessionId: string, type: string, payload: Record<string, unknown>) => void;
  log: (message: string) => void;
  onSessionArchived?: (sessionId: string) => void;
}

type Wakeup = {kind: 'deviceEvent'; event: DeviceEvent} | {kind: 'timer'} | {kind: 'message'}
  | {kind: 'control'} | {kind: 'stop'};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolvePromise => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolvePromise(); }, ms);
    const onAbort = (): void => { clearTimeout(t); resolvePromise(); };
    signal?.addEventListener('abort', onAbort, {once: true});
  });

const TERMINAL_ACTION_EVENTS = new Set(['action.succeeded', 'action.failed', 'action.cancelled']);

interface ConditionRuntime {
  tripped: boolean;
  outSinceSim: number | null;
  lastFireSim: number;
  value: number | null;
}

export class SessionScheduler {
  readonly sessionId: string;
  private readonly deps: SchedulerDeps;
  private readonly store: SessionStore;
  private generation = 0;
  private client!: DeviceClient;
  private executor!: SessionExecutor;
  private readonly wakeups: Wakeup[] = [];
  private readonly waiters: Array<(w: Wakeup) => void> = [];
  private readonly abort = new AbortController();
  private readonly turnAbort = new AbortController();
  private watcherAbort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private turnInFlight: Promise<void> | null = null;
  private turnQueued = false;
  private lastSimTime = 0;
  private lastSimWall = 0;
  private speed = 1;
  private readonly conditionState = new Map<string, ConditionRuntime>();
  private mainDone = false;
  private stopped = false;
  private consecutiveModelErrors = 0;
  private donePromise: Promise<void> = Promise.resolve();

  constructor(deps: SchedulerDeps, session: SessionRow) {
    this.deps = deps;
    this.store = deps.store;
    this.sessionId = session.session_id;
  }

  // -- lifecycle ----------------------------------------------------------------

  start(): void {
    this.donePromise = this.main().catch(e => {
      this.deps.log(`[scheduler ${this.sessionId}] crashed: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => {
      this.mainDone = true;
    });
  }

  get dead(): boolean { return this.mainDone; }
  get done(): Promise<void> { return this.donePromise; }

  stop(): void {
    this.stopped = true;
    this.turnAbort.abort();
    this.abort.abort();
    this.watcherAbort?.abort();
    this.stopTimer();
    this.push({kind: 'stop'});
  }

  /** User/agent-level pause: no new decisions or actions (task keeps waiting). */
  pause(): void {
    const session = this.store.getSession(this.sessionId);
    if (session && session.lifecycle === 'active') {
      this.store.updateSession(this.sessionId, {agent_paused: true, loop_state: 'paused', loop_state_detail: 'operator'});
      this.emit('loop.state', {loop_state: 'paused', reason: 'operator_paused_agent'});
      this.deps.log(`[scheduler ${this.sessionId}] paused by operator`);
    }
  }

  resume(): void {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    this.store.updateSession(this.sessionId, {agent_paused: false, loop_state: 'idle', loop_state_detail: null});
    this.emit('loop.state', {loop_state: 'idle', reason: 'operator_resumed_agent'});
    this.push({kind: 'message'}); // let pending input flow again
  }

  onUserMessage(): void { this.push({kind: 'message'}); }

  private push(w: Wakeup): void {
    const fn = this.waiters.shift();
    if (fn) fn(w); else this.wakeups.push(w);
  }

  private next(): Promise<Wakeup> {
    const w = this.wakeups.shift();
    if (w) return Promise.resolve(w);
    return new Promise(resolvePromise => this.waiters.push(resolvePromise));
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.deps.emit(this.sessionId, type, payload);
  }

  private setLoop(state: LoopState, detail?: string | null): void {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active' || session.agent_paused && state !== 'paused') {
      // keep an explicit operator pause visible
    }
    this.store.updateSession(this.sessionId, {loop_state: state, loop_state_detail: detail ?? null});
    this.emit('loop.state', {loop_state: state, detail: detail ?? null});
  }

  // -- main ---------------------------------------------------------------------

  private async main(): Promise<void> {
    this.generation = this.store.claimOwnership(this.sessionId);
    const token = () => this.deps.getServiceToken() ?? undefined;
    this.client = new DeviceClient({baseUrl: this.deps.config.runtimeUrl, token, timeoutMs: 15_000,
      fetch: this.deps.fetchImpl});
    this.executor = new SessionExecutor({store: this.store, client: this.client,
      emit: event => {
        if (event.kind === 'action.submitted') this.emit('action.submitted', {...event});
        else if (event.kind === 'action.result') this.emit('action.result', {...event});
        else this.emit('error', {where: event.where, code: event.code, message: event.message, key: event.key});
      },
      log: m => this.deps.log(m)});
    this.setLoop('recovering', 'startup reconciliation');

    // Recovery (§7.2): state read → archived check → intent reconcile → missed events.
    let state: StateSnapshot | null = null;
    try {
      state = await this.readState();
    } catch (e) {
      if (e instanceof DeviceError && e.code === 'not_found') {
        this.archiveSession('experiment not found (reset while the agent was down)');
        return;
      }
      // runtime unreachable right now: keep watching, retry below
    }
    if (state) await this.recover(state);
    this.startWatcher();
    this.stopTimerCheck(); // arm below if needed
    this.refreshTimer();
    // device may have produced terminal events while we reconcile; a first
    // catch-up already ran inside recover()/watcher.
    this.setLoop(this.loopStateForTask());
    for (;;) {
      const w = await this.next();
      if (w.kind === 'stop' || this.stopped) break;
      try {
        if (w.kind === 'deviceEvent') await this.processDeviceEvent(w.event);
        else if (w.kind === 'timer') await this.checkSimTimers();
        else if (w.kind === 'message') await this.onMessageWake();
        else if (w.kind === 'control') { /* handled via store flags */ }
      } catch (e) {
        this.emit('error', {where: 'scheduler', code: e instanceof DeviceError ? e.code : 'internal',
          message: e instanceof Error ? e.message : String(e)});
      }
      if (this.stopped) break;
    }
    this.watcherAbort?.abort();
    this.stopTimer();
  }

  private async readState(): Promise<StateSnapshot> {
    const session = this.store.getSession(this.sessionId)!;
    return this.executor.readState(session);
  }

  /** True when the experiment no longer accepts this session (reset/archived). */
  private async archiveSession(reason: string): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle === 'archived') return;
    const task = this.store.activeTask(this.sessionId);
    if (task && !['completed', 'failed', 'cancelled'].includes(task.status)) {
      this.store.updateTaskStatus(task.task_id, 'cancelled', `session archived: ${reason}`);
    }
    this.store.cancelWakes(this.sessionId);
    this.store.archiveSession(this.sessionId, reason);
    this.setLoop('idle', reason);
    this.emit('session.archived', {reason});
    this.deps.onSessionArchived?.(this.sessionId);
    this.deps.log(`[scheduler ${this.sessionId}] archived: ${reason}`);
  }

  private async recover(state: StateSnapshot): Promise<void> {
    this.lastSimTime = state.experiment.sim_time_s;
    this.lastSimWall = Date.now();
    this.speed = state.experiment.speed || 1;
    if (state.experiment.clock_mode !== 'realtime') {
      this.setLoop('unsupported_clock_mode', `experiment clock_mode=${state.experiment.clock_mode}; long-lived sessions run in realtime (lockstep stays on the run/lease path)`);
      this.emit('error', {where: 'scheduler', code: 'clock_mode_mismatch',
        message: 'Session tasks require a realtime experiment; switch the experiment clock or use the scripted run path.'});
    }
    const task = this.store.activeTask(this.sessionId);
    if (task) await this.executor.reconcileIntents(this.store.getSession(this.sessionId)!, task);
    // consume events missed while the agent was down (bounded catch-up)
    await this.catchUp(state.event_seq);
  }

  // -- device event watcher --------------------------------------------------------

  private startWatcher(): void {
    if (this.watcherAbort) return;
    const ac = new AbortController();
    this.watcherAbort = ac;
    void (async () => {
      let attempt = 0;
      while (!ac.signal.aborted && !this.stopped) {
        const session = this.store.getSession(this.sessionId);
        if (!session || session.lifecycle !== 'active') break;
        try {
          const cursor = this.store.getSession(this.sessionId)!.inbox_cursor;
          for await (const ev of this.client.stream(session.experiment_id, cursor, ac.signal)) {
            attempt = 0;
            this.push({kind: 'deviceEvent', event: ev});
          }
        } catch { /* connection dropped */ }
        if (ac.signal.aborted || this.stopped) break;
        attempt += 1;
        await sleep(Math.min(5000, 200 * 2 ** Math.min(attempt, 5)), ac.signal);
        if (ac.signal.aborted || this.stopped) break;
        // refetch snapshot + missed events after a disconnect/gap
        try {
          const state = await this.readState();
          this.lastSimTime = state.experiment.sim_time_s;
          this.lastSimWall = Date.now();
          await this.catchUp(state.event_seq);
          this.emit('loop.state', {loop_state: this.store.getSession(this.sessionId)?.loop_state ?? 'idle',
            detail: 'reconnected to device stream'});
        } catch (e) {
          if (e instanceof DeviceError && (e.code === 'not_found' || e.code === 'experiment_archived')) {
            await this.archiveSession('experiment archived or missing after disconnect');
            return;
          }
          /* runtime still down; loop again */
        }
      }
    })();
  }

  /** Fetch events after the persisted cursor and process them (gap recovery). */
  private async catchUp(uptoSeq: number): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    let after = session.inbox_cursor;
    for (;;) {
      const batch = await this.client.events(session.experiment_id, after, 500);
      for (const ev of batch.events) {
        if (ev.seq > uptoSeq) break;
        await this.processDeviceEvent(ev, true);
        after = ev.seq;
      }
      if (!batch.events.length || after >= Math.min(batch.last_seq, uptoSeq)) break;
    }
  }

  private async processDeviceEvent(ev: DeviceEvent, replay = false): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    // at-least-once delivery → dedupe + cursor in one transaction
    const fresh = this.store.recordInbox(this.sessionId, 'device', ev.seq, ev.type, ev.payload);
    if (!fresh) return;
    this.lastSimTime = ev.sim_time_s;
    this.lastSimWall = Date.now();
    if (ev.type === 'clock.speed_changed') {
      this.speed = Number((ev.payload as {speed?: number}).speed ?? this.speed) || 1;
      return;
    }
    if (ev.type === 'environment.sampled') {
      this.evaluateConditions(ev.sim_time_s, ev.payload as Record<string, unknown>);
      return; // ordinary sampling never wakes the model
    }
    const ownAction = ev.action_id ? this.ownsAction(ev.action_id) : false;
    if (TERMINAL_ACTION_EVENTS.has(ev.type)) {
      if (ownAction) {
        this.emit('action.result', {action_id: ev.action_id,
          capability: (ev.payload as {capability?: string}).capability, status: ev.type.split('.')[1],
          ...(ev.payload as Record<string, unknown>)});
        this.fireActionWakes(String(ev.action_id));
        this.scheduleTurn('action_terminal', `action ${ev.action_id} ${ev.type.split('.')[1]}`);
      }
      return;
    }
    if (ev.type === 'observation.created' && ownAction) {
      const obs = await this.fetchObservation(String(ev.observation_id));
      if (obs) {
        this.emit('observation.recorded', {observation_id: obs.observation_id, plate_id: obs.plate_id,
          wells: obs.wells, mode: obs.mode, quality: obs.quality, sampled_at_sim_s: obs.sampled_at_sim_s,
          plate_revision: obs.plate_revision,
          estimates: obs.estimates.map(e => ({well_id: e.well_id, liquid_level_ul: e.liquid_level_ul, quality: e.quality}))});
        this.scheduleTurn('observation', `observation ${obs.observation_id} ready`);
      }
      return;
    }
    if (ev.type === 'clock.paused' || ev.type === 'clock.resumed') {
      this.emit('device.clock', {type: ev.type, sim_time_s: ev.sim_time_s});
      return;
    }
    void replay;
  }

  private ownsAction(actionId: string): boolean {
    return this.store.listSessionIntents(this.sessionId).some(i => i.action_id === actionId);
  }

  private async fetchObservation(observationId: string): Promise<Observation | null> {
    const session = this.store.getSession(this.sessionId)!;
    try {
      return await this.client.observation(session.experiment_id, observationId);
    } catch {
      this.emit('error', {where: 'observation', code: 'fetch_failed', message: observationId});
      return null;
    }
  }

  private fireActionWakes(actionId: string): void {
    for (const wake of this.store.armedWakes(this.sessionId)) {
      if (wake.kind === 'action_terminal') {
        const ids = (wake.predicate as {action_ids?: string[]} | null)?.action_ids;
        if (!ids || ids.includes(actionId)) {
          this.store.fireWake(wake.wake_id);
          this.emit('wake.fired', {wake_id: wake.wake_id, kind: wake.kind, action_id: actionId});
        }
      }
    }
  }

  // -- condition wakes (debounce / hysteresis / cooldown) -----------------------------

  private evaluateConditions(simTime: number, payload: Record<string, unknown>): void {
    const chamber = payload.chamber as Record<string, {observed?: number}> | undefined;
    const readings: Record<string, number | undefined> = {
      temperature_c: chamber?.temperature_c?.observed ?? payload.temperature_c as number | undefined,
      co2_pct: chamber?.co2_pct?.observed ?? payload.co2_pct as number | undefined,
      humidity_pct: chamber?.humidity_pct?.observed ?? payload.humidity_pct as number | undefined,
    };
    for (const wake of this.store.armedWakes(this.sessionId)) {
      if (wake.kind !== 'condition') continue;
      const p = wake.predicate as {metric?: string; op?: string; value?: number; debounce_sim_s?: number;
        hysteresis?: number; cooldown_sim_s?: number} | null;
      if (!p?.metric) continue;
      const value = readings[p.metric];
      if (value === undefined) continue;
      const rt = this.conditionState.get(wake.wake_id) ?? {tripped: false, outSinceSim: null, lastFireSim: -1e12, value: null};
      rt.value = value;
      const outOfBand = p.op === 'below' ? value < (p.value ?? 0) : value > (p.value ?? 0);
      if (rt.tripped) {
        const backInBand = p.op === 'below'
          ? value >= (p.value ?? 0) + (p.hysteresis ?? 0)
          : value <= (p.value ?? 0) - (p.hysteresis ?? 0);
        if (backInBand) rt.tripped = false;
        this.conditionState.set(wake.wake_id, rt);
        continue;
      }
      if (outOfBand) {
        if (rt.outSinceSim == null) rt.outSinceSim = simTime;
        const held = simTime - rt.outSinceSim >= (p.debounce_sim_s ?? 60);
        const cooled = simTime - rt.lastFireSim >= (p.cooldown_sim_s ?? 1800);
        if (held && cooled) {
          this.store.fireWake(wake.wake_id);
          rt.tripped = true;
          rt.lastFireSim = simTime;
          this.emit('wake.fired', {wake_id: wake.wake_id, kind: 'condition', metric: p.metric,
            value, threshold: p.value, sim_time_s: simTime});
          this.scheduleTurn('condition', `${p.metric} ${value} ${p.op} ${p.value} (debounced)`);
        }
      } else {
        rt.outSinceSim = null;
      }
      this.conditionState.set(wake.wake_id, rt);
    }
  }

  // -- sim timers ---------------------------------------------------------------------

  private refreshTimer(): void {
    const wakes = this.store.armedWakes(this.sessionId).filter(w => w.kind === 'sim_time');
    if (!wakes.length || this.stopped) {
      this.stopTimer();
      return;
    }
    if (this.timer) return; // existing timer re-evaluates on every tick
    this.timer = setInterval(() => {
      void (async () => {
        try { await this.checkSimTimers(); } catch { /* transient */ }
      })();
    }, 1000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** stopTimer without disarming pending wakes (used at loop start). */
  private stopTimerCheck(): void { this.stopTimer(); }

  private async checkSimTimers(): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    const wakes = this.store.armedWakes(this.sessionId).filter(w => w.kind === 'sim_time');
    if (!wakes.length) { this.stopTimer(); return; }
    // Estimate sim advance since the last event (wall × speed), confirm with a
    // state read when close. Reads never wake the model; only firing does.
    const estimate = this.lastSimTime + ((Date.now() - this.lastSimWall) / 1000) * this.speed;
    const nearest = Math.min(...wakes.map(w => w.target_sim_s ?? Infinity));
    if (estimate + this.speed * 2 < nearest) return;
    let simNow = estimate;
    try {
      const state = await this.readState();
      simNow = state.experiment.sim_time_s;
      this.lastSimTime = simNow;
      this.lastSimWall = Date.now();
      this.speed = state.experiment.speed || 1;
    } catch { /* keep the estimate */ }
    for (const wake of wakes) {
      if (wake.target_sim_s != null && wake.target_sim_s <= simNow + 0.001) {
        this.store.fireWake(wake.wake_id);
        this.emit('wake.fired', {wake_id: wake.wake_id, kind: 'sim_time', target_sim_s: wake.target_sim_s, sim_time_s: simNow});
        this.scheduleTurn('sim_time', `sim clock reached ${wake.target_sim_s}s`);
      }
    }
    this.refreshTimer();
  }

  // -- turn scheduling ---------------------------------------------------------------

  private scheduleTurn(trigger: string, reason: string): void {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    if (session.agent_paused) return;
    const task = this.store.activeTask(this.sessionId);
    if (!task) return; // no task: conversation turns happen on message wake only
    if (!['draft', 'ready', 'running', 'waiting_device', 'waiting_condition'].includes(task.status)) return;
    const availability = this.deps.backend.available();
    if (!availability.ok) {
      if (session.loop_state !== 'unavailable') {
        this.setLoop('unavailable', `model backend unavailable: ${availability.reason}`);
        this.emit('model.unavailable', {reason: availability.reason, missing: availability.missing ?? []});
      }
      return;
    }
    if (this.turnInFlight) { this.turnQueued = true; return; }
    this.turnInFlight = this.runTurn(trigger, reason).finally(() => {
      this.turnInFlight = null;
      if (this.turnQueued && !this.stopped) {
        this.turnQueued = false;
        this.scheduleTurn('queued', 'event arrived during the previous turn');
      }
    });
  }

  private async onMessageWake(): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active' || session.agent_paused) return;
    const task = this.store.activeTask(this.sessionId);
    const availability = this.deps.backend.available();
    if (!availability.ok) {
      this.setLoop('unavailable', `model backend unavailable: ${availability.reason}`);
      this.emit('model.unavailable', {reason: availability.reason, missing: availability.missing ?? []});
      return;
    }
    if (!task) {
      // conversation without a task: still let the model answer the user
      if (this.turnInFlight) { this.turnQueued = true; return; }
      this.turnInFlight = this.runTurn('message', 'user message').finally(() => {
        this.turnInFlight = null;
        if (this.turnQueued && !this.stopped) {
          this.turnQueued = false;
          this.scheduleTurn('queued', 'event arrived during the previous turn');
        }
      });
      return;
    }
    if (task.status === 'needs_input') {
      this.store.updateTaskStatus(task.task_id, 'running', 'input received');
      this.emit('task.status', {task_id: task.task_id, status: 'running', reason: 'input received'});
    }
    this.scheduleTurn('message', 'user message');
  }

  private loopStateForTask(): LoopState {
    const session = this.store.getSession(this.sessionId);
    if (!session) return 'idle';
    if (session.agent_paused) return 'paused';
    const task = this.store.activeTask(this.sessionId);
    if (!task) return 'idle';
    switch (task.status) {
      case 'running': return 'thinking';
      case 'waiting_device': return 'waiting_device';
      case 'waiting_condition': return 'waiting_condition';
      case 'needs_input': return 'needs_input';
      case 'paused': return 'paused';
      default: return 'idle';
    }
  }

  private collectDeviceResults(): DeviceResultDigest[] {
    // everything since the last 'turn.completed' marker (durable → restart-safe)
    const events = this.store.sessionEventsAfter(this.sessionId, 0, 10_000);
    const lastMarker = [...events].reverse().find(e => e.type === 'turn.completed');
    const after = lastMarker ? lastMarker.seq : (events.length > 20 ? events[events.length - 20].seq - 1 : 0);
    return events.filter(e => e.seq > after
      && ['action.submitted', 'action.result', 'observation.recorded', 'wake.fired', 'model.unavailable', 'error'].includes(e.type))
      .slice(-24)
      .map(e => ({source: e.type, summary: summarizeResultEvent(e.type, e.payload),
        data: compactPayload(e.payload)}));
  }

  private assembleHistory(): {history: Array<{role: 'user' | 'assistant'; content: string}>; checkpointSummary: string | null} {
    const checkpoint = this.store.latestCheckpoint(this.sessionId);
    const messages = this.store.listMessages(this.sessionId, checkpoint?.covered_message_seq ?? 0, 500);
    return {
      history: messages.filter(m => m.role !== 'system').map(m => ({role: m.role as 'user' | 'assistant', content: m.content})),
      checkpointSummary: checkpoint ? checkpoint.summary : null,
    };
  }

  private async runTurn(trigger: string, reason: string): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    const task = this.store.activeTask(this.sessionId);
    this.setLoop('thinking', `${trigger}: ${reason}`);
    // realtime: re-read the authoritative state before deciding
    let state: StateSnapshot;
    try {
      state = await this.readState();
      this.lastSimTime = state.experiment.sim_time_s;
      this.lastSimWall = Date.now();
      this.speed = state.experiment.speed || 1;
    } catch (e) {
      if (e instanceof DeviceError && (e.code === 'not_found' || e.code === 'experiment_archived')) {
        await this.archiveSession('experiment archived or missing');
        return;
      }
      this.emit('error', {where: 'turn', code: 'device_unreachable',
        message: `could not read state before the turn: ${e instanceof Error ? e.message : String(e)}`});
      this.setLoop(this.loopStateForTask());
      return;
    }
    if (state.experiment.clock_mode !== 'realtime') {
      this.setLoop('unsupported_clock_mode', 'experiment is not realtime');
      return;
    }
    const spec = task ? this.parseSpec(task) : null;
    if (task && task.status === 'ready') {
      this.store.updateTaskStatus(task.task_id, 'running', `first turn (${trigger})`);
      this.emit('task.status', {task_id: task.task_id, status: 'running', reason: trigger});
    }
    const {history, checkpointSummary} = this.assembleHistory();
    const input: TurnInput = {
      session, task: task ?? null, spec,
      wake: {kind: trigger, reason},
      state,
      history: history.slice(-60),
      checkpointSummary,
      plan: task ? this.store.listPlanSteps(task.task_id) : [],
      deviceResults: this.collectDeviceResults(),
      budget: task ? {actions_used: task.budget.actions_used, max_actions: task.budget.max_actions,
        model_turns_used: task.budget.model_turns_used, max_model_turns: task.budget.max_model_turns} :
        {actions_used: 0, max_actions: 0, model_turns_used: 0, max_model_turns: 0},
    };
    let turnGoalRevision = task?.goal_revision ?? 0;
    const host = {
      generation: this.generation,
      submitWrite: async (capability: string, args: Record<string, unknown>, opts:
        {reason?: string; evidence_refs?: string[]}) => {
        const freshTask = task ? this.store.getTask(task.task_id) : null;
        if (!freshTask) return {ok: false, error: {code: 'task_gone', message: 'task disappeared', retryable: false}};
        const freshSpec = this.parseSpec(freshTask);
        if (!freshSpec) return {ok: false, error: {code: 'invalid_goal', message: 'stored goal_spec is invalid; fix the task first', retryable: false}};
        this.setLoop('executing', capability);
        try {
          const r = await this.executor.submitWrite({session: this.store.getSession(this.sessionId)!, task: freshTask,
            spec: freshSpec, capability, args, reason: opts.reason,
            evidence_refs: opts.evidence_refs, turnGoalRevision, generation: this.generation});
          this.setLoop('thinking', `${capability} submitted`);
          return r;
        } catch (e) {
          return {ok: false, error: {code: 'internal', message: e instanceof Error ? e.message : String(e), retryable: true}};
        }
      },
      armWake: (w: {kind: 'sim_time' | 'condition'; at_sim_s?: number | null; predicate?: Record<string, unknown> | null;
        dedupe_key?: string | null; reason: string}) => {
        const t = this.store.activeTask(this.sessionId);
        const wake = this.store.armWake({session_id: this.sessionId, task_id: t?.task_id ?? task?.task_id ?? 'none',
          kind: w.kind, predicate: w.predicate ?? null, target_sim_s: w.at_sim_s ?? null,
          source_watermark: this.lastSimTime, dedupe_key: w.dedupe_key ?? null});
        this.emit('wake.armed', {wake_id: wake.wake_id, kind: wake.kind, target_sim_s: wake.target_sim_s,
          predicate: wake.predicate, reason: w.reason});
        this.refreshTimer();
        return wake;
      },
      updateTaskGoal: (patch: {goal_text?: string; goal_spec?: Record<string, unknown>; expected_revision: number}) => {
        const t = task ? this.store.getTask(task.task_id) : null;
        if (!t) return {ok: false as const, conflict: {actual: 0}};
        const r = this.store.updateTaskGoal(t.task_id, patch);
        if (r.ok) {
          turnGoalRevision = r.revision;
          this.emit('task.goal_updated', {task_id: t.task_id, goal_revision: r.revision,
            goal_text: patch.goal_text ?? t.goal_text});
        }
        return r;
      },
      replacePlan: (steps: Array<{skill: string; skill_version?: string; inputs?: Record<string, unknown> | null}>) => {
        const t = task ? this.store.getTask(task.task_id) : null;
        if (!t) return [] as PlanStepRow[];
        const rows = this.store.replacePlan(t.task_id, t.goal_revision, steps);
        this.emit('plan.updated', {task_id: t.task_id, plan_revision: t.goal_revision,
          steps: rows.map(r => ({index: r.index_in_plan, skill: r.skill, status: r.status}))});
        return rows;
      },
      updateStep: (index: number, fields: {status: 'done' | 'failed' | 'skipped' | 'running'; action_ids?: string[];
        evidence_refs?: string[]}) => {
        const t = task ? this.store.getTask(task.task_id) : null;
        if (!t) return false;
        const steps = this.store.listPlanSteps(t.task_id);
        const step = steps.find(s => s.index_in_plan === index);
        if (!step) return false;
        this.store.updatePlanStep(step.step_id, {status: fields.status,
          action_ids: [...new Set([...step.action_ids, ...(fields.action_ids ?? [])])],
          evidence_refs: [...new Set([...step.evidence_refs, ...(fields.evidence_refs ?? [])])]});
        this.emit('plan.step', {task_id: t.task_id, index, status: fields.status,
          action_ids: fields.action_ids, evidence_refs: fields.evidence_refs});
        return true;
      },
    };

    const output = await this.deps.backend.runTurn(input, host, this.turnAbort.signal);
    if (this.stopped) return;
    const freshTask = task ? this.store.getTask(task.task_id) : null;
    if (freshTask) this.store.incrementTaskBudget(freshTask.task_id, {model_turns: 1});
    if (!output.ok) {
      this.consecutiveModelErrors += 1;
      this.emit('model.error', {code: output.code, message: output.error, consecutive: this.consecutiveModelErrors});
      this.store.appendMessage(this.sessionId, {role: 'system',
        content: `[model turn failed] ${output.code}: ${output.error ?? 'unknown error'}`, task_id: task?.task_id ?? null});
      if (freshTask && this.consecutiveModelErrors >= 8) {
        this.store.updateTaskStatus(freshTask.task_id, 'failed', 'model_unavailable');
        this.emit('task.status', {task_id: freshTask.task_id, status: 'failed', reason: 'model_unavailable'});
      } else {
        // bounded retry: a later event or a short sim-time wake retries
        this.setLoop('unavailable', `${output.code}: ${output.error ?? ''}`);
        if (freshTask && !this.store.armedWakes(this.sessionId).some(w => w.task_id === freshTask.task_id)) {
          host.armWake({kind: 'sim_time', at_sim_s: this.lastSimTime + 120,
            dedupe_key: `retry:${freshTask.task_id}:${this.consecutiveModelErrors}`, reason: `model error retry #${this.consecutiveModelErrors}`});
        }
      }
      this.emit('turn.completed', {trigger, ok: false, code: output.code});
      return;
    }
    this.consecutiveModelErrors = 0;
    // record the conversation
    const assistantText = output.assistantText
      || (output.toolLog.length ? `（${output.toolLog.map(t => `${t.name}: ${t.summary}`).join('；')}）` : '（本回合没有输出文本）');
    this.store.appendMessage(this.sessionId, {role: 'assistant', content: assistantText, task_id: task?.task_id ?? null,
      meta: {turn: trigger, tool_calls: output.toolLog, usage: output.usage}});
    this.emit('message.appended', {message: {role: 'assistant', content: assistantText}, turn: trigger,
      tool_calls: output.toolLog.map(t => ({name: t.name, ok: t.ok, summary: t.summary}))});
    // apply effects
    if (freshTask) {
      if (output.effects.taskCompleted) {
        this.store.updateTaskStatus(freshTask.task_id, 'completed', null);
        this.store.cancelWakes(this.sessionId, freshTask.task_id);
        this.emit('task.status', {task_id: freshTask.task_id, status: 'completed',
          summary: output.effects.taskCompleted.summary, evidence_refs: output.effects.taskCompleted.evidence_refs});
      } else if (output.effects.taskFailed) {
        this.store.updateTaskStatus(freshTask.task_id, 'failed', output.effects.taskFailed.reason);
        this.store.cancelWakes(this.sessionId, freshTask.task_id);
        this.emit('task.status', {task_id: freshTask.task_id, status: 'failed', reason: output.effects.taskFailed.reason,
          summary: output.effects.taskFailed.summary});
      } else if (output.effects.inputRequested) {
        this.store.updateTaskStatus(freshTask.task_id, 'needs_input', output.effects.inputRequested.join(' | '));
        this.emit('task.status', {task_id: freshTask.task_id, status: 'needs_input',
          questions: output.effects.inputRequested});
      } else {
        const armed = this.store.armedWakes(this.sessionId).filter(w => w.task_id === freshTask.task_id);
        const waiting = armed.some(w => w.kind === 'condition') ? 'waiting_condition'
          : armed.some(w => w.kind === 'sim_time') ? 'waiting_condition' : 'running';
        const inFlight = await this.hasInFlightActions(freshTask);
        this.store.updateTaskStatus(freshTask.task_id, inFlight ? 'waiting_device' : waiting,
          inFlight ? 'device actions in flight' : armed.map(w => `${w.kind}${w.target_sim_s ? `@${w.target_sim_s}s` : ''}`).join(', ') || null);
        this.emit('task.status', {task_id: freshTask.task_id, status: inFlight ? 'waiting_device' : waiting});
      }
    }
    this.setLoop(this.loopStateForTask());
    this.refreshTimer();
    this.emit('turn.completed', {trigger, ok: true, usage: output.usage,
      tools: output.toolLog.map(t => ({name: t.name, ok: t.ok}))});
    this.maybeCompact();
  }

  private parseSpec(task: TaskRow): GoalSpec | null {
    try {
      return normalizeGoalSpec(task.goal_spec);
    } catch {
      return null;
    }
  }

  private async hasInFlightActions(task: TaskRow): Promise<boolean> {
    const intents = this.store.listSessionIntents(this.sessionId).filter(i => i.task_id === task.task_id && i.action_id);
    const session = this.store.getSession(this.sessionId)!;
    for (const intent of intents.slice(-10)) {
      try {
        const action = await this.client.action(session.experiment_id, intent.action_id!);
        if (!isTerminal(action.status)) return true;
      } catch { /* unknown → treat as not blocking */ }
    }
    return false;
  }

  private maybeCompact(): void {
    const session = this.store.getSession(this.sessionId);
    if (!session) return;
    const checkpoint = this.store.latestCheckpoint(this.sessionId);
    const since = this.store.listMessages(this.sessionId, checkpoint?.covered_message_seq ?? 0, 10_000).length;
    if (since < this.deps.config.compactionMessageThreshold) return;
    const task = this.store.activeTask(this.sessionId);
    const {history} = this.assembleHistory();
    const facts: string[] = [];
    for (const intent of this.store.listSessionIntents(this.sessionId).slice(-20)) {
      facts.push(`${intent.capability} ${intent.action_id ?? '(pending)'} [${intent.goal_revision}]`);
    }
    for (const step of task ? this.store.listPlanSteps(task.task_id) : []) {
      facts.push(`step ${step.index_in_plan} ${step.skill} ${step.status} ${step.action_ids.join(',')}`);
    }
    const evidenceRefs = this.store.listSessionIntents(this.sessionId).filter(i => i.action_id).map(i => i.action_id!);
    const compacted = this.deps.backend.compact({history, task: task ?? null,
      facts, evidenceRefs});
    const generation = (checkpoint?.generation ?? 0) + 1;
    try {
      const covered = this.store.getSession(this.sessionId)!.last_message_seq;
      this.store.insertCheckpoint({session_id: this.sessionId, generation, covered_message_seq: covered,
        goal_revision: task?.goal_revision ?? 0, summary: compacted.summary, facts: compacted.facts,
        open_questions: compacted.open_questions, evidence_refs: evidenceRefs,
        versions: {backend: this.deps.backend.id, schema: 2}});
      this.emit('checkpoint.created', {generation, covered_message_seq: covered});
    } catch {
      // a concurrent compaction won the generation; keep the older checkpoint
    }
  }

  /** Cancel a task: cancel its in-flight device actions, reconcile, drop wakes. */
  async cancelTask(taskId: string): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    const task = this.store.getTask(taskId);
    if (!session || !task || task.session_id !== this.sessionId) return;
    this.store.cancelWakes(this.sessionId, taskId);
    for (const intent of this.store.listSessionIntents(this.sessionId)) {
      if (intent.task_id !== taskId || !intent.action_id) continue;
      try {
        const action = await this.client.action(session.experiment_id, intent.action_id);
        if (!isTerminal(action.status)) {
          await this.client.cancel(session.experiment_id, intent.action_id);
          this.emit('action.cancel_requested', {task_id: taskId, action_id: intent.action_id});
        }
      } catch (e) {
        this.emit('error', {where: 'cancel', code: e instanceof DeviceError ? e.code : 'network',
          message: `${intent.action_id}: ${e instanceof Error ? e.message : String(e)}`});
      }
    }
    this.store.updateTaskStatus(taskId, 'cancelled', 'cancelled by operator');
    this.emit('task.status', {task_id: taskId, status: 'cancelled', reason: 'operator'});
    this.setLoop(this.loopStateForTask());
  }
}

function summarizeResultEvent(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'action.submitted': return `${String(payload.capability ?? '')} accepted as ${String(payload.action_id ?? '')} (${String(payload.status ?? '')})`;
    case 'action.result': return `action ${String(payload.action_id ?? '')} ${String(payload.status ?? '')}${payload.error ? ` error=${JSON.stringify(payload.error)}` : ''}`;
    case 'observation.recorded': return `observation ${String(payload.observation_id ?? '')} plate ${String(payload.plate_id ?? '')} quality ${String(payload.quality ?? '')}`;
    case 'wake.fired': return `wake ${String(payload.wake_id ?? '')} (${String(payload.kind ?? '')}) fired`;
    case 'model.unavailable': return `model unavailable: ${String(payload.reason ?? '')}`;
    case 'error': return `${String(payload.where ?? '')}/${String(payload.code ?? '')}: ${String(payload.message ?? '')}`;
    default: return type;
  }
}

function compactPayload(payload: Record<string, unknown>): unknown {
  const json = JSON.stringify(payload);
  if (json.length <= 800) return payload;
  return {truncated: json.slice(0, 800)};
}
