// Event-driven single-writer scheduler for one long-lived session (design §6).
// Wake sources: user message, action terminal (own intents), observation
// ready, threshold condition (debounce/hysteresis/cooldown), sim timer,
// device recovery. Clock frames, RAF and ordinary sensor sampling NEVER wake
// the model — conditions are evaluated by the scheduler itself and only a
// genuine crossing (debounced) schedules a turn.
//
// Realtime is the product path: the device keeps running while the model
// thinks; every write re-checks ownership generation, goal_revision, scope,
// budget and plate revisions just before submit. Recovery order (§7.2):
// load session/task/messages + inbox cursor → read Runtime state → drain
// received-but-unprocessed inbox rows → resolve uncertain intents by key →
// consume missed terminal events → one recovery turn → then new decisions.
import {DeviceClient, DeviceError, isTerminal} from '@oscar/device-contract';
import type {Action, DeviceEvent, Observation, StateSnapshot} from '@oscar/device-contract';
import {GoalSpecError, missingExecutionParameters, normalizeGoalSpec, type GoalSpec} from './goal.ts';
import {SessionExecutor} from './executor.ts';
import {planCompletionGate, resolveSkillStep, validatePlanSteps, verifyGoalSatisfied,
  type SkillFiredWake, type StepVerification, type VerifyOutcome} from './skills.ts';
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
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];
const EXECUTING_TASK_STATUSES = ['ready', 'running', 'waiting_device', 'waiting_condition'];
/** N05: bound on AUTOMATIC cancel retries (1s→30s backoff); an explicit
 * user/supervisor cancelTask always resets the counter and retries again. */
const CANCEL_RETRY_MAX_ATTEMPTS = 8;
/** Trial guardrail default: how many CONSECUTIVE deterministic plan refusals
 * (invalid_plan / invalid_goal) a task tolerates before it is parked as
 * needs_input. The goal's stop.max_corrections overrides this when set (its
 * first execution point — see SessionScheduler.planRefusals). */
const PLAN_REFUSAL_LIMIT_DEFAULT = 3;

/** Trial guardrail bound for one task: stop.max_corrections when it is a
 * positive finite number, otherwise the default. */
function planRefusalLimit(spec: GoalSpec | null): number {
  const max = spec?.stop.max_corrections;
  return typeof max === 'number' && Number.isFinite(max) && max >= 1 ? Math.floor(max) : PLAN_REFUSAL_LIMIT_DEFAULT;
}

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
  private turnAbort = new AbortController();
  private watcherAbort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private turnInFlight: Promise<void> | null = null;
  /** Trigger kinds that arrived while a turn was in flight; replayed (with
   * their kind) when it ends, so a message wake is never flattened into a
   * task-only 'queued' kick. */
  private readonly pendingTriggers = new Set<string>();
  /** Max user seq the last launched turn attempted (store-wide, set at turn
   * entry, refined at history assembly). afterTurn's watermark retrigger
   * fires only for messages NEWER than this: a turn that already attempted
   * (and could not consume) messages — stale fence, unreachable device —
   * must not relaunch itself in a tight loop. */
  private lastAttemptedUserSeq = 0;
  /** Bounded wall-clock retry when a turn could not even read device state
   * (2 s doubling to 30 s, unref'd, cleared on stop). */
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = 0;
  /** N05: action ids with a cancel attempt CURRENTLY executing. This is a
   * concurrent-in-flight dedupe ONLY — a finished attempt (success or
   * failure) is removed, so retries and explicit later cancels always
   * re-attempt. The durable state lives in session_intents.cancel_state. */
  private readonly cancelInFlight = new Set<string>();
  /** N05: bounded backoff retry of cancel intents that never reached the
   * device (1 s doubling to 30 s, unref'd, one timer at a time, cleared on
   * stop). */
  private cancelRetryTimer: NodeJS.Timeout | null = null;
  private cancelRetryDelayMs = 0;
  /** N05: intent keys whose automatic attempts were exhausted and reported
   * (one visible error event per exhaustion; an explicit cancel re-arms). */
  private readonly cancelExhaustedReported = new Set<string>();
  private lastSimTime = 0;
  private lastSimWall = 0;
  private speed = 1;
  private readonly conditionState = new Map<string, ConditionRuntime>();
  /** Trial guardrail: consecutive DETERMINISTIC replacePlan refusals per task
   * (codes invalid_plan / invalid_goal — refusals the model cannot turn into
   * an acceptance by waiting: unknown skill/version, invalid inputs, plan-time
   * precondition or scope/allowed_operations violations, broken stored spec).
   * Without a bound, a model that re-submits the same refused plan loops
   * "refusal → short sim wake → retry" forever, burning model turns until the
   * budget backstop and never reaching needs_input/failed. The streak is reset
   * by an ACCEPTED plan and by a goal edit (new revision = new intent);
   * enforcement lives at the end of runTurn. In-memory only: a restart grants
   * a fresh bounded streak — never an infinite one (the budget still bounds). */
  private readonly planRefusals = new Map<string, {count: number; problems: string[]}>();
  private mainDone = false;
  private stopped = false;
  private consecutiveModelErrors = 0;
  /** Session-event seq already digested into a turn brief (set at collect time). */
  private resultsCursor = 0;
  /** Own actions whose terminal event was already seen. Only scans that
   * SUCCEEDED matter (their observation may still be outstanding); other
   * terminals never produce observations, so nothing is recorded for them. */
  private readonly seenTerminals = new Set<string>();
  /** Own scans that recorded their observation BEFORE their terminal event:
   * scan_capture emits observation.created mid-action, so the assessing turn
   * must wait for the terminal — a submit racing the still-held head would be
   * refused resource_busy. The terminal schedules exactly one turn. */
  private readonly observationAwaitingTerminal = new Set<string>();
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
    if (this.executor) this.executor.close(); // F01: revoke in-flight writes
    if (this.retryTimer) {clearTimeout(this.retryTimer); this.retryTimer = null;}
    if (this.cancelRetryTimer) {clearTimeout(this.cancelRetryTimer); this.cancelRetryTimer = null;}
    this.turnAbort.abort();
    this.abort.abort();
    this.watcherAbort?.abort();
    this.stopTimer();
    this.push({kind: 'stop'});
  }

  /**
   * F01: wait until nothing this scheduler started can still run — the main
   * loop AND any in-flight turn (a tool submit inside it). Resolving stop()
   * alone could leave a submit racing process shutdown.
   */
  async drain(): Promise<void> {
    if (!this.stopped) this.stop();
    await this.done;
    const turn = this.turnInFlight;
    if (turn) await turn;
  }

  /** User/agent-level pause: no new decisions or actions (task keeps waiting). */
  pause(): void {
    const session = this.store.getSession(this.sessionId);
    if (session && session.lifecycle === 'active') {
      // F01: persist the flag FIRST (in-flight submitWrite re-reads it and
      // refuses without inserting an intent), then cancel the provider wait.
      this.store.updateSession(this.sessionId, {agent_paused: true, loop_state: 'paused', loop_state_detail: 'operator'});
      this.emit('loop.state', {loop_state: 'paused', reason: 'operator_paused_agent'});
      this.deps.log(`[scheduler ${this.sessionId}] paused by operator`);
    }
    this.turnAbort.abort();
  }

  resume(): void {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    this.store.updateSession(this.sessionId, {agent_paused: false, loop_state: 'idle', loop_state_detail: null});
    this.emit('loop.state', {loop_state: 'idle', reason: 'operator_resumed_agent'});
    this.push({kind: 'message'}); // let pending input flow again
  }

  onUserMessage(): void { this.push({kind: 'message'}); }

  /**
   * F07: a task-created notification starts work only for executable tasks.
   * It NEVER clears needs_input (only a real user message turn may run there,
   * and even then the status stays needs_input until parameters are complete).
   */
  onTaskCreated(): void {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active' || session.agent_paused) return;
    const task = this.store.activeTask(this.sessionId);
    if (!task || task.status === 'needs_input') return;
    if (EXECUTING_TASK_STATUSES.includes(task.status)) {
      this.scheduleTurn('task_created', `task ${task.task_id} created`);
    }
  }

  /**
   * N04: a task was just persisted as 'queued' (the slot is busy or a
   * previous task's handoff is still pending). Kick the promotion path —
   * when the barriers already pass, the queue head (which may be this task)
   * is promoted promptly instead of waiting for the next device terminal
   * event or watchdog tick. When they do not, this is a cheap no-op and the
   * existing retriggers (terminal events, watchdog, restart) carry it.
   */
  /** Resolves after the promotion attempt so a create response can report the post-handoff status. */
  async onTaskQueued(): Promise<void> {
    if (this.stopped) return;
    await this.maybePromoteNext('task queued behind a busy slot or pending handoff');
  }

  /**
   * Operator/supervisor resume is not a user message, but a paused task has no
   * armed wake to carry it. Schedule one turn once it is executable again.
   */
  onTaskResumed(): void {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active' || session.agent_paused || this.stopped) return;
    const task = this.store.activeTask(this.sessionId);
    if (!task || !EXECUTING_TASK_STATUSES.includes(task.status)) return;
    this.scheduleTurn('resume', 'operator resumed task');
  }

  /** F08: a goal edit drops the old plan's waits and re-decides under the new revision. */
  onGoalUpdated(): void {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    const task = this.store.activeTask(this.sessionId);
    if (!task) return;
    // the new revision is a new intent: plan refusals counted under the old
    // goal must not park the re-decision (trial guardrail reset)
    this.planRefusals.delete(task.task_id);
    // drop stale planning waits (sim_time / condition); action terminals stay
    this.store.cancelPlanningWakes(this.sessionId, task.task_id);
    this.refreshTimer(); // a running interval must not fire a just-cancelled wake
    if (!EXECUTING_TASK_STATUSES.includes(task.status)) return;
    this.scheduleTurn('goal_updated', 'goal revision changed');
  }

  /**
   * F01: the turn signal handed to the provider. pause()/stop() abort the
   * current controller to cancel an in-flight model wait; this swaps in a
   * fresh one when the previous is already aborted so resume() can run a
   * LATER turn on the same scheduler.
   */
  private beginTurnSignal(): AbortSignal {
    if (this.turnAbort.signal.aborted) this.turnAbort = new AbortController();
    return this.turnAbort.signal;
  }

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
        if (event.kind === 'action.submitted') {
          this.emit('action.submitted', {...event});
          if (event.action_id) {
            // an intent that bound AFTER its task was cancelled (submit raced
            // the cancel mark, by-key recovery, restart reconcile): request a
            // device cancel for the still-running action. The accepted
            // effect and its result stay in the ledger — never hidden.
            const intent = this.store.listSessionIntents(this.sessionId)
              .find(i => i.action_id === event.action_id);
            const owner = intent ? this.store.getTask(intent.task_id) : undefined;
            if (owner && owner.status === 'cancelled') {
              void this.requestActionCancel(event.action_id, owner.task_id);
            }
            // observation events that arrived during the uncertain window
            // were consumed unattributed — replay them now
            void this.replayAttributedObservations(event.action_id);
          }
        } else if (event.kind === 'action.result') this.emit('action.result', {...event});
        else this.emit('error', {where: event.where, code: event.code, message: event.message, key: event.key});
      },
      log: m => this.deps.log(m)});
    this.setLoop('recovering', 'startup reconciliation');
    // Recovery (§7.2): state read → archived check → inbox drain → intent
    // reconcile → missed events → one recovery turn.
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
    // A task-created notification can mark the loop unavailable during
    // recover; don't clobber that with the task's idle/thinking label.
    this.publishLoop();
    this.startWatchdog();
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
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
  }

  /**
   * Wall-time staleness check: after a reset the old experiment stops
   * advancing (the clock only serves the current experiment). Poll the
   * experiment status and archive the session when its experiment is no
   * longer active. Ordinary pauses are reported, never archived.
   * F10: every active tick is checked — an idle session (no armed wakes, no
   * turn in flight) on a reset experiment must still be archived.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void (async () => {
        if (this.stopped) return;
        const session = this.store.getSession(this.sessionId);
        if (!session || session.lifecycle !== 'active') return;
        try {
          const state = await this.readState();
          if (state.experiment.status !== 'active') {
            await this.archiveSession(`experiment is ${state.experiment.status} (reset produced ${state.experiment.successor_id ?? 'a successor'})`);
            return;
          }
          if (state.experiment.sim_time_s > this.lastSimTime) {
            this.lastSimTime = state.experiment.sim_time_s;
            this.lastSimWall = Date.now();
            this.speed = state.experiment.speed || 1;
          }
          // a queue head blocked by an unresolved intent (failed by-key
          // lookup) has no device event left to retry promotion — the
          // watchdog tick is the last-resort retry trigger. N04: it also
          // clears a stale handoff marker once the barriers pass (including
          // with an EMPTY queue, so a later create can be born ready).
          if (!this.turnInFlight && !this.store.activeTask(this.sessionId)
            && (this.store.queuedTasks(this.sessionId).length > 0
              || this.store.getSession(this.sessionId)?.handoff_pending)) {
            await this.maybePromoteNext('watchdog retry');
          }
        } catch { /* runtime unreachable: SSE watcher already retries */ }
      })();
    }, 5000);
    this.watchdogTimer.unref?.();
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
    if (task && !TERMINAL_TASK_STATUSES.includes(task.status)) {
      this.store.updateTaskStatus(task.task_id, 'cancelled', `session archived: ${reason}`);
    }
    // R07: the whole queue dies with the session — queued tasks are cancelled
    // (never promoted), preserving the archive's one-way read-only semantics.
    const queuedCancelled = this.store.cancelQueuedTasks(this.sessionId, `session archived: ${reason}`);
    if (queuedCancelled > 0) {
      this.emit('task.queue_cancelled', {reason: `session archived: ${reason}`, count: queuedCancelled});
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
    // F10: archive a reset experiment before any recovery turn is scheduled
    // (an ordinary experiment pause is NOT an archive).
    if (state.experiment.status !== 'active') {
      await this.archiveSession(`experiment is ${state.experiment.status} (reset produced ${state.experiment.successor_id ?? 'a successor'})`);
      return;
    }
    if (state.experiment.clock_mode !== 'realtime') {
      this.setLoop('unsupported_clock_mode', `experiment clock_mode=${state.experiment.clock_mode}; long-lived sessions run in realtime (lockstep stays on the run/lease path)`);
      this.emit('error', {where: 'scheduler', code: 'clock_mode_mismatch',
        message: 'Session tasks require a realtime experiment; switch the experiment clock or use the scripted run path.'});
    }
    // F06 before F03: bind action ids first, otherwise a received terminal
    // event cannot tell that it belongs to this session and would be dropped.
    await this.executor.reconcileIntents(this.store.getSession(this.sessionId)!);
    // N05: cancel intents left 'requested' by a crash or a failed attempt
    // are durable — re-attempt them now (bounded backoff takes over on
    // failure; an already-terminal action confirms without a POST).
    if (this.store.intentsCancelRequested(this.sessionId).length > 0) {
      await this.retryRequestedCancels();
    }
    // F03: a crash between recordInbox (cursor already advanced) and the
    // handler leaves state='received' rows; re-dispatch them after reconcile.
    await this.drainReceivedInbox();
    // consume events missed while the agent was down (bounded catch-up)
    await this.catchUp(state.event_seq);
    // R07: a crash between "previous task terminal" and promotion leaves the
    // execution slot empty with a queue behind it — promote before the
    // recovery turn so the promoted task is the one that resumes.
    await this.maybePromoteNext('scheduler restart');
    // F04: exactly one recovery turn, only from here (never from sampling)
    this.scheduleRecoveryTurn();
  }

  /**
   * F04: schedule ONE recovery turn after restart recovery. ready/running
   * tasks resume; waiting_device resumes only when nothing is in flight
   * (otherwise the terminal event wakes it); waiting_condition resumes only
   * when it has NO armed wake left (e.g. a goal edit cancelled the planning
   * wakes and the process died before the re-decision turn ran) — an armed
   * future wake carries the task on its own. needs_input is left alone
   * except for an unconsumed user message (the only trigger allowed there).
   * R04: with no task, the persisted user-message watermark (not "the last
   * message happens to be from the user") decides whether exactly one
   * conversation turn runs — consumed messages never retrigger.
   */
  private scheduleRecoveryTurn(): void {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active' || session.agent_paused || this.stopped) return;
    // R07: the current task may be 'paused' — it HOLDS the execution slot (no
    // queue promotion, no task turn) but chat continues task-less, exactly
    // like a session without a task.
    const current = this.store.activeTask(this.sessionId);
    const task = current && current.status !== 'paused' ? current : null;
    if (task) {
      if (task.status === 'ready' || task.status === 'running') {
        this.scheduleTurn('resume', 'recovered unfinished task');
        return;
      }
      if (task.status === 'waiting_device') {
        // in-flight actions wake the task on their own terminal events
        const unconsumed = this.hasUnconsumedUserMessages();
        void this.hasInFlightActions(task).then(inFlight => {
          if (this.stopped) return;
          if (!inFlight) this.scheduleTurn('resume', 'recovered unfinished task');
          else if (unconsumed) this.scheduleTurn('message', 'user message unconsumed across restart');
        });
        return;
      }
      if (task.status === 'waiting_condition'
        && !this.store.armedWakes(this.sessionId).some(w => w.task_id === task.task_id)) {
        this.scheduleTurn('resume', 'recovered task with no armed wake');
        return;
      }
      // needs_input / waiting on an armed wake: only a real user message the
      // previous process never consumed starts a turn here
      if (this.hasUnconsumedUserMessages()) this.scheduleTurn('message', 'user message unconsumed across restart');
      return;
    }
    // no executable task (none, or the current one is paused): chat-only
    if (this.hasUnconsumedUserMessages()) void this.onMessageWake();
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
        await this.processDeviceEvent(ev);
        after = ev.seq;
      }
      if (!batch.events.length || after >= Math.min(batch.last_seq, uptoSeq)) break;
    }
  }

  /**
   * F03: recordInbox advances the cursor when the row is inserted, BEFORE the
   * handler runs; a crash would leave state='received'. The row is marked
   * processed only AFTER the handler finished successfully — otherwise it
   * stays 'received' and the next process start re-drains it.
   */
  private async processDeviceEvent(ev: DeviceEvent): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    // Keep envelope ids in the stored payload so a crash-restart drain can
    // attribute the event without the live DeviceEvent object.
    const stored: Record<string, unknown> = {...ev.payload};
    if (ev.action_id && stored.action_id == null) stored.action_id = ev.action_id;
    if (ev.observation_id && stored.observation_id == null) stored.observation_id = ev.observation_id;
    // at-least-once delivery → dedupe + cursor in one transaction
    const fresh = this.store.recordInbox(this.sessionId, 'device', ev.seq, ev.type, stored);
    if (!fresh) return;
    if (await this.handleDeviceEvent(ev)) {
      this.store.markInboxProcessed(this.sessionId, 'device', ev.seq, 'processed');
    }
    // R07: a terminal device event may be the last thing the finished task
    // was waiting for — this is where a blocked promotion gets its retry.
    if (TERMINAL_ACTION_EVENTS.has(ev.type)
      && !this.store.activeTask(this.sessionId) && this.store.queuedTasks(this.sessionId).length > 0) {
      void this.maybePromoteNext(`device event ${ev.type}`);
    }
  }

  /** Shared device-event side effects (live path and received-inbox drain). */
  private async handleDeviceEvent(ev: DeviceEvent): Promise<boolean> {
    this.lastSimTime = ev.sim_time_s;
    this.lastSimWall = Date.now();
    if (ev.type === 'clock.speed_changed') {
      this.speed = Number((ev.payload as {speed?: number}).speed ?? this.speed) || 1;
      return true;
    }
    if (ev.type === 'environment.sampled') {
      this.evaluateConditions(ev.sim_time_s, ev.payload as Record<string, unknown>);
      return true; // ordinary sampling never wakes the model
    }
    const ownAction = ev.action_id ? this.ownsAction(ev.action_id) : false;
    if (TERMINAL_ACTION_EVENTS.has(ev.type)) {
      if (ownAction) {
        const intent = this.store.listSessionIntents(this.sessionId).find(i => i.action_id === ev.action_id);
        const isScan = intent?.capability === 'imaging.scan';
        if (ev.action_id && isScan && ev.type === 'action.succeeded') this.seenTerminals.add(ev.action_id);
        this.emit('action.result', {action_id: ev.action_id,
          capability: intent?.capability ?? (ev.payload as {capability?: string}).capability,
          status: ev.type.split('.')[1], ...(ev.payload as Record<string, unknown>)});
        this.fireActionWakes(String(ev.action_id));
        // A succeeded scan's observation.created either already arrived
        // (scan_capture emits it BEFORE the terminal) or follows immediately;
        // in both cases exactly ONE assessing turn runs, never two
        const scanAwaitingObservation = isScan && ev.type === 'action.succeeded';
        if (!scanAwaitingObservation || this.observationAwaitingTerminal.delete(String(ev.action_id))) {
          this.scheduleTurn('action_terminal', `action ${ev.action_id} ${ev.type.split('.')[1]}`);
        }
      }
      return true;
    }
    if (ev.type === 'observation.created' && ownAction) {
      const obs = await this.fetchObservation(String(ev.observation_id));
      if (obs) {
        // action_id FIRST so the exact producing action always survives the
        // turn brief's payload slice: observation→action attribution must be
        // an explicit id, never inferred from event order.
        this.emit('observation.recorded', {action_id: String(ev.action_id), observation_id: obs.observation_id,
          plate_id: obs.plate_id,
          wells: obs.wells, mode: obs.mode, quality: obs.quality, sampled_at_sim_s: obs.sampled_at_sim_s,
          plate_revision: obs.plate_revision,
          estimates: obs.estimates.map(e => ({well_id: e.well_id, liquid_level_ul: e.liquid_level_ul, quality: e.quality}))});
        if (this.seenTerminals.has(String(ev.action_id))) {
          // terminal already seen (observation after terminal): assess now
          this.seenTerminals.delete(String(ev.action_id));
          this.scheduleTurn('observation', `observation ${obs.observation_id} ready`);
        } else {
          // observation before terminal: hold the turn until the device
          // actually finishes the action
          this.observationAwaitingTerminal.add(String(ev.action_id));
        }
      } else {
        // observation unreachable: fall back to the terminal-driven turn and
        // leave the row 'received' so the next process start retries it
        this.scheduleTurn('action_terminal', `observation ${String(ev.observation_id)} could not be fetched`);
        return false;
      }
      return true;
    }
    if (ev.type === 'clock.paused' || ev.type === 'clock.resumed') {
      this.emit('device.clock', {type: ev.type, sim_time_s: ev.sim_time_s});
      return true;
    }
    return true;
  }

  /**
   * F03: re-dispatch inbox rows left in state='received' by a crash. The rows
   * already exist, so they are never re-recorded (recordInbox would return
   * null and skip) — the shared handler runs directly and marks them
   * processed. fireWake only touches armed rows, so this is idempotent; no
   * device action is ever submitted from here.
   */
  private async drainReceivedInbox(): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    for (const row of this.store.listReceivedInbox(session.session_id)) {
      if (this.stopped) return;
      const payload = row.payload ?? {};
      const p = payload as {sim_time_s?: unknown; action_id?: unknown; observation_id?: unknown};
      const ev: DeviceEvent = {
        seq: row.source_seq,
        experiment_id: session.experiment_id,
        sim_time_s: typeof p.sim_time_s === 'number' ? p.sim_time_s : this.lastSimTime,
        type: row.event_type,
        action_id: typeof p.action_id === 'string' ? p.action_id : null,
        run_id: null,
        observation_id: typeof p.observation_id === 'string' ? p.observation_id : null,
        payload,
      };
      if (await this.handleDeviceEvent(ev)) {
        this.store.markInboxProcessed(session.session_id, row.source, row.source_seq, 'processed');
      }
    }
  }

  private ownsAction(actionId: string): boolean {
    return this.store.listSessionIntents(this.sessionId).some(i => i.action_id === actionId);
  }

  /**
   * After an intent resolves to action_id (possibly minutes after acceptance,
   * e.g. response loss), re-check consumed observation.created rows for that
   * action and emit the ones never recorded as session evidence.
   */
  private async replayAttributedObservations(actionId: string): Promise<void> {
    try {
      const already = new Set(this.store.sessionEventsAfter(this.sessionId, 0, 10_000)
        .filter(e => e.type === 'observation.recorded')
        .map(e => String((e.payload as {observation_id?: string}).observation_id ?? '')));
      for (const row of this.store.inboxByType(this.sessionId, 'observation.created')) {
        let payload: {action_id?: string; observation_id?: string};
        try {payload = JSON.parse(row.payload) as {action_id?: string; observation_id?: string};} catch {continue;}
        if (payload.action_id !== actionId || !payload.observation_id) continue;
        if (already.has(payload.observation_id)) continue;
        const obs = await this.fetchObservation(payload.observation_id);
        if (obs) {
          // same exact attribution as the live path (action_id first)
          this.emit('observation.recorded', {action_id: actionId, observation_id: obs.observation_id,
            plate_id: obs.plate_id,
            wells: obs.wells, mode: obs.mode, quality: obs.quality, sampled_at_sim_s: obs.sampled_at_sim_s,
            plate_revision: obs.plate_revision,
            estimates: obs.estimates.map(e => ({well_id: e.well_id, liquid_level_ul: e.liquid_level_ul, quality: e.quality})),
            replayed_for: actionId});
          this.scheduleTurn('observation', `observation ${obs.observation_id} attributed to ${actionId}`);
        }
      }
    } catch { /* best effort */ }
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

  /**
   * S01: consume the OFFICIAL Runtime `environment.sampled` contract. The
   * producer (services/runtime/src/runtime.ts stepOnce) emits
   * `{chamber_id, sample: {temperature_c, co2_pct, humidity_pct,
   * sampled_at_sim_s, quality}, targets, quality}` — the channel readings
   * live under `payload.sample`, so that shape is read FIRST. The legacy
   * `chamber.*.observed` and flat top-level shapes stay supported so older
   * payloads (and the flat-reading component control used by review scripts)
   * keep working.
   *
   * Quality: the sample carries ONE flag for the whole chamber
   * ('ok' | 'settling'). 'settling' only means SOME channel is still
   * converging after a target change — the per-channel readings themselves
   * are the same synthetic-sensor facts the /state chamber endpoint and the
   * goal-level chamber verification (skills.ts) consume without a quality
   * gate. Gating a per-channel condition on that whole-sample flag would let
   * an unrelated channel's settling silently suppress a genuine crossing on
   * a stable channel, so non-'ok' samples are still EVALUATED; debounce,
   * hysteresis and cooldown remain the transient filters. The evidence
   * quality is surfaced on the `wake.fired` event for observability.
   */
  private evaluateConditions(simTime: number, payload: Record<string, unknown>): void {
    const sample = payload.sample as {temperature_c?: number; co2_pct?: number; humidity_pct?: number;
      quality?: unknown} | undefined;
    const chamber = payload.chamber as Record<string, {observed?: number}> | undefined;
    const readings: Record<string, number | undefined> = {
      temperature_c: sample?.temperature_c ?? chamber?.temperature_c?.observed ?? payload.temperature_c as number | undefined,
      co2_pct: sample?.co2_pct ?? chamber?.co2_pct?.observed ?? payload.co2_pct as number | undefined,
      humidity_pct: sample?.humidity_pct ?? chamber?.humidity_pct?.observed ?? payload.humidity_pct as number | undefined,
    };
    const quality = (sample?.quality ?? payload.quality) === 'settling' ? 'settling' : 'ok';
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
            value, threshold: p.value, quality, sim_time_s: simTime});
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
    if (session.owner_generation !== this.generation) return; // superseded owner stays silent
    const task = this.store.activeTask(this.sessionId);
    if (!task) return; // no task: conversation turns happen on message wake only
    // F07: needs_input runs a turn only for a real user message; every other
    // trigger keeps the old allow-list
    const allowed = trigger === 'message'
      ? ['draft', 'ready', 'running', 'waiting_device', 'waiting_condition', 'needs_input']
      : ['draft', 'ready', 'running', 'waiting_device', 'waiting_condition'];
    if (!allowed.includes(task.status)) return;
    const availability = this.deps.backend.available();
    if (!availability.ok) {
      if (session.loop_state !== 'unavailable') {
        this.setLoop('unavailable', `model backend unavailable: ${availability.reason}`);
        this.emit('model.unavailable', {reason: availability.reason, missing: availability.missing ?? []});
      }
      return;
    }
    if (this.turnInFlight) { this.pendingTriggers.add(trigger); return; }
    this.launchTurn(trigger, reason);
  }

  private launchTurn(trigger: string, reason: string): void {
    this.turnInFlight = this.runTurn(trigger, reason).finally(() => {
      this.turnInFlight = null;
      this.afterTurn();
    });
  }

  /**
   * R04: after every turn, replay the trigger KINDS that arrived mid-turn and
   * retrigger a message turn only for messages that are genuinely NEWER than
   * what the finished turn attempted (a stale/aborted or device-unreachable
   * turn leaves its messages unconsumed but must not relaunch itself in a
   * tight loop — explicit triggers and the bounded device retry carry them).
   */
  private afterTurn(): void {
    if (this.stopped) { this.pendingTriggers.clear(); return; }
    // R07: the turn may have driven the current task to a terminal state
    // (complete/fail/budget exhaustion) — promote the queue head before any
    // queued trigger replay so the promoted task's own turn is next.
    void this.maybePromoteNext('turn finished');
    const kinds = new Set(this.pendingTriggers);
    this.pendingTriggers.clear();
    if (this.maxUserSeq() > this.lastAttemptedUserSeq) kinds.add('message');
    for (const kind of kinds) {
      if (kind === 'message') void this.onMessageWake();
      else this.scheduleTurn(kind, 'event arrived during the previous turn');
    }
  }

  /** Store-wide max user message seq (0 when the user never spoke). */
  private maxUserSeq(): number {
    const users = this.store.listMessages(this.sessionId, 0, 100_000).filter(m => m.role === 'user');
    return users.at(-1)?.seq ?? 0;
  }

  private hasUnconsumedUserMessages(): boolean {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return false;
    return this.store.hasUnconsumedUserMessages(this.sessionId);
  }

  /**
   * Bounded wall-clock retry for an unanswered user message after a turn
   * failed to even read device state: 2 s doubling to 30 s, one timer at a
   * time, cleared on stop. Never a tight loop against a down Runtime.
   */
  private scheduleMessageRetry(reason: string): void {
    if (this.stopped || this.retryTimer) return;
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active' || session.agent_paused) return;
    if (session.owner_generation !== this.generation) return;
    if (!this.store.hasUnconsumedUserMessages(this.sessionId)) return;
    this.retryDelayMs = this.retryDelayMs ? Math.min(this.retryDelayMs * 2, 30_000) : 2_000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.deps.log(`[scheduler ${this.sessionId}] retrying unconsumed user message (${reason})`);
      void this.onMessageWake();
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }

  private async onMessageWake(): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active' || session.agent_paused) return;
    if (this.stopped) return;
    if (session.owner_generation !== this.generation) return; // superseded owner stays silent
    const task = this.store.activeTask(this.sessionId);
    const availability = this.deps.backend.available();
    if (!availability.ok) {
      this.setLoop('unavailable', `model backend unavailable: ${availability.reason}`);
      this.emit('model.unavailable', {reason: availability.reason, missing: availability.missing ?? []});
      return;
    }
    // R07: a PAUSED current task holds the execution slot (no queue advance,
    // no task turn) but must not silence the chat — the message runs as a
    // task-less conversation turn, exactly like a session without a task.
    if (!task || task.status === 'paused') {
      // conversation without a task: still let the model answer the user
      if (this.turnInFlight) { this.pendingTriggers.add('message'); return; }
      this.launchTurn('message', 'user message');
      return;
    }
    // F07: a user message may run a turn on a needs_input task, but it NEVER
    // flips the status — device writes stay refused (task_paused) until the
    // parameters are actually complete.
    this.scheduleTurn('message', 'user message');
  }

  /**
   * Loop label after startup. If a task is waiting to run and the model is not
   * configured, stay `unavailable` — a concurrent task-created turn may have
   * reported that already, and the plain task label (idle) must not hide it.
   */
  private publishLoop(): void {
    const session = this.store.getSession(this.sessionId);
    const task = this.store.activeTask(this.sessionId);
    const availability = this.deps.backend.available();
    if (session && session.lifecycle === 'active' && !session.agent_paused && task
      && (EXECUTING_TASK_STATUSES.includes(task.status) || task.status === 'needs_input')
      && !availability.ok) {
      if (session.loop_state !== 'unavailable') {
        this.setLoop('unavailable', `model backend unavailable: ${availability.reason}`);
        this.emit('model.unavailable', {reason: availability.reason, missing: availability.missing ?? []});
      }
      return;
    }
    this.setLoop(this.loopStateForTask());
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
    // Everything after the previous turn's collection boundary. The cursor is
    // advanced AT COLLECT TIME to the current last seq: events emitted while
    // this turn runs (e.g. the observation of the scan just submitted) keep a
    // HIGHER seq and are guaranteed to reach the next turn's brief — no
    // marker-ordering race can hide them.
    const events = this.store.sessionEventsAfter(this.sessionId, this.resultsCursor, 10_000);
    const boundary = this.store.getSession(this.sessionId)?.last_event_seq ?? this.resultsCursor;
    this.resultsCursor = Math.max(this.resultsCursor, boundary);
    return events.filter(e => ['action.submitted', 'action.result', 'observation.recorded', 'wake.fired',
      'model.unavailable', 'error'].includes(e.type))
      .slice(-24)
      .map(e => ({source: e.type, summary: summarizeResultEvent(e.type, e.payload),
        data: compactPayload(e.payload)}));
  }

  private assembleHistory(): {history: Array<{role: 'user' | 'assistant'; content: string}>;
    checkpointSummary: string | null;
    checkpointExtras: {checkpointFacts: string[]; checkpointQuestions: string[]} | null;
    /** R04: max user message seq fetched for this turn — the watermark the
     * turn consumes once the model has actually seen it. */
    maxUserSeq: number} {
    const checkpoint = this.store.latestCheckpoint(this.sessionId);
    const messages = this.store.listMessages(this.sessionId, checkpoint?.covered_message_seq ?? 0, 500);
    return {
      history: messages.filter(m => m.role !== 'system').map(m => ({role: m.role as 'user' | 'assistant', content: m.content})),
      checkpointSummary: checkpoint ? checkpoint.summary : null,
      // F09: carry the checkpoint facts and open questions, not only the summary
      checkpointExtras: checkpoint
        ? {checkpointFacts: checkpoint.facts, checkpointQuestions: checkpoint.open_questions}
        : null,
      maxUserSeq: messages.reduce((max, m) => m.role === 'user' && m.seq > max ? m.seq : max, 0),
    };
  }

  /**
   * F02 turn-effect fence. Returns null while the turn is still current, or a
   * reason when stale: scheduler stopped / turn signal aborted, session
   * missing/archived/paused, superseded owner generation, or the bound task
   * missing/terminal/paused/edited (goal_revision moved).
   * needs_input is deliberately NOT stale here: updateTaskGoal must keep
   * working so the model can fill missing parameters.
   */
  private turnStale(turnTaskId: string | null, turnGoalRevision: number, signal: AbortSignal): string | null {
    if (this.stopped || signal.aborted) return 'scheduler stopped or turn aborted';
    const session = this.store.getSession(this.sessionId);
    if (!session) return 'session is gone';
    if (session.lifecycle !== 'active') return 'session is archived';
    if (session.agent_paused) return 'agent is paused';
    if (session.owner_generation !== this.generation) {
      return `scheduler generation ${this.generation} is superseded by ${session.owner_generation}`;
    }
    if (turnTaskId) {
      const task = this.store.getTask(turnTaskId);
      if (!task) return `task ${turnTaskId} is gone`;
      if (TERMINAL_TASK_STATUSES.includes(task.status)) return `task ${turnTaskId} is ${task.status}`;
      if (task.status === 'paused') return `task ${turnTaskId} is paused`;
      if (task.goal_revision !== turnGoalRevision) {
        return `goal moved to revision ${task.goal_revision} (turn decided under ${turnGoalRevision})`;
      }
    }
    return null;
  }

  private async runTurn(trigger: string, reason: string): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    // every user message persisted so far is being ATTEMPTED by this turn:
    // afterTurn only rethrows for messages newer than this watermark-in-memory
    this.lastAttemptedUserSeq = Math.max(this.lastAttemptedUserSeq, this.maxUserSeq());
    // R07: a paused current task HOLDS the slot (blocks the queue) but runs no
    // task turn — a message wake during a task pause is a task-less chat turn.
    const current = this.store.activeTask(this.sessionId);
    const task = current && current.status !== 'paused' ? current : null;
    const turnSignal = this.beginTurnSignal();
    const turnTaskId = task?.task_id ?? null;
    let turnGoalRevision = task?.goal_revision ?? 0;
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
      // an unanswered message must still be answered once the device returns —
      // via a bounded backoff, never a tight relaunch loop
      this.scheduleMessageRetry('device unreachable before the turn');
      return;
    }
    if (state.experiment.clock_mode !== 'realtime') {
      this.setLoop('unsupported_clock_mode', 'experiment is not realtime');
      return;
    }
    const spec = task ? this.parseSpec(task) : null;
    // Q02: the state read above AWAITED — a task pause (user or supervisor),
    // a cancel, a goal edit or an operator agent pause may have landed in that
    // window (those entries write the store directly; nothing aborts this
    // turn). Re-run the FULL revocation fence before the first local write
    // and the model call: turnStale (stopped/aborted, session lifecycle, owner
    // generation, agent pause, task terminal/paused, goal revision) plus the
    // executable-status allow-list of scheduleTurn — paused (and needs_input
    // outside its F07 user-message path) stop the turn right here.
    const revocation = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
    const freshTurnTask = task ? this.store.getTask(task.task_id) ?? null : null;
    const allowedNow = trigger === 'message'
      ? ['draft', 'ready', 'running', 'waiting_device', 'waiting_condition', 'needs_input']
      : ['draft', 'ready', 'running', 'waiting_device', 'waiting_condition'];
    const statusBlocked = task && (!freshTurnTask || !allowedNow.includes(freshTurnTask.status))
      ? `task ${turnTaskId} is ${freshTurnTask?.status ?? 'gone'}` : null;
    if (revocation || statusBlocked) {
      const reason = revocation ?? statusBlocked!;
      this.emit('turn.completed', {trigger, ok: false, code: 'stale_turn', reason});
      this.setLoop(this.loopStateForTask());
      // R04 consistency: this turn never reached the model, so it consumes NO
      // user-message watermark (consumeUserMessages runs only after the model
      // has actually seen the history); lastAttemptedUserSeq keeps its entry
      // value, so afterTurn rethrows only genuinely NEWER messages while the
      // pause/cancel carries the old one (resume re-kicks a message turn).
      return;
    }
    if (task && freshTurnTask!.status === 'ready') {
      // Q02 CAS: the row must STILL be 'ready' at the goal revision this turn
      // decided under. 0 rows = a concurrent status write (a pause landing
      // between the fence and this UPDATE) won: the turn exits without
      // touching the task, without any device write and without consuming
      // the user-message watermark — the pause stays visible to every later
      // fence (ToolHost/executor) instead of being erased to running.
      const started = this.store.startTaskTurn(task.task_id, turnGoalRevision, `first turn (${trigger})`);
      if (!started) {
        this.emit('turn.completed', {trigger, ok: false, code: 'stale_turn',
          reason: 'the ready→running transition lost the race to a concurrent task-status write'});
        this.setLoop(this.loopStateForTask());
        return;
      }
      this.emit('task.status', {task_id: task.task_id, status: 'running', reason: trigger});
    }
    // F05: decision revisions captured from the snapshot read at the START of
    // this turn; the executor compares them against a fresh read inside the
    // write lock, immediately before the HTTP submit
    const decisionRevisions: Record<string, number> = {};
    for (const plate of state.plates) decisionRevisions[`plate:${plate.plate_id}`] = plate.revision;
    if (state.chamber.chamber_id) {
      decisionRevisions[`chamber:${state.chamber.chamber_id}`] = state.chamber.target_revision;
    }
    const {history, checkpointSummary, checkpointExtras, maxUserSeq: turnConsumedUserSeq} = this.assembleHistory();
    this.lastAttemptedUserSeq = Math.max(this.lastAttemptedUserSeq, turnConsumedUserSeq);
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
      ...(checkpointExtras ?? {}),
    };
    const host = {
      generation: this.generation,
      // F11: authoritative state read for read-only tools
      readState: (): Promise<StateSnapshot> => this.readState(),
      // F11: the model may create the FIRST task of a session mid-conversation
      // — or QUEUE the next one behind the current task (R07): the store's
      // createTask is the single idempotent entry and persists 'queued' when a
      // non-terminal task (paused/needs_input included) holds the slot.
      createTask: (createInput: {goal_text: string; goal_spec: Record<string, unknown>}):
        Promise<{ok: true; task_id: string; status: string} | {ok: false; code: string; message: string}> => {
        const currentSession = this.store.getSession(this.sessionId);
        if (this.stopped || turnSignal.aborted || !currentSession || currentSession.lifecycle !== 'active'
          || currentSession.agent_paused || currentSession.owner_generation !== this.generation) {
          return Promise.resolve({ok: false, code: 'stale_turn', message: 'turn is no longer current'});
        }
        let normalized: GoalSpec;
        try {
          normalized = normalizeGoalSpec(createInput.goal_spec);
        } catch (e) {
          const message = e instanceof GoalSpecError ? e.problems.join('; ')
            : e instanceof Error ? e.message : String(e);
          return Promise.resolve({ok: false, code: 'invalid_goal', message});
        }
        const created = this.store.createTask(this.sessionId,
          {goal_text: createInput.goal_text, goal_spec: normalized as unknown as Record<string, unknown>});
        const queued = created.status === 'queued';
        let status = created.status;
        if (!queued) {
          // only a task that holds the slot can become needs_input at create
          // time; a queued task's parameters are judged at promotion
          const missing = missingExecutionParameters(normalized);
          if (missing.length) this.store.updateTaskStatus(created.task_id, 'needs_input', missing.join(' | '));
          status = missing.length ? 'needs_input' : created.status;
        }
        const queuePosition = this.store.queuePosition(this.sessionId, created.task_id);
        this.emit('task.created', {task_id: created.task_id, status, goal_text: createInput.goal_text,
          goal_revision: created.goal_revision, queued, queue_position: queuePosition});
        if (!queued && status !== 'needs_input') {
          // ready: run on a later turn (this turn is still in flight; the
          // queued schedule fires after it ends). needs_input is never flipped.
          this.scheduleTurn('task_created', `task ${created.task_id} created`);
        } else if (queued) {
          // N04: the create went into the queue (busy slot, existing queue or
          // a pending handoff). Kick the promotion path so an immediately
          // promotable queue head becomes ready quickly — the barriers stay
          // owned by maybePromoteNext; a not-yet-clear handoff is not forced.
          void this.maybePromoteNext('task created behind the queue');
        }
        return Promise.resolve({ok: true, task_id: created.task_id, status});
      },
      submitWrite: async (capability: string, args: Record<string, unknown>, opts:
        {reason?: string; evidence_refs?: string[]; expected_revisions?: Record<string, number>}) => {
        const stale = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
        if (stale) return {ok: false, error: {code: 'stale_turn', message: stale, retryable: false}};
        const freshTask = task ? this.store.getTask(task.task_id) : null;
        if (!freshTask) return {ok: false, error: {code: 'task_gone', message: 'task disappeared', retryable: false}};
        const freshSpec = this.parseSpec(freshTask);
        if (!freshSpec) return {ok: false, error: {code: 'invalid_goal', message: 'stored goal_spec is invalid; fix the task first', retryable: false}};
        this.setLoop('executing', capability);
        try {
          const r = await this.executor.submitWrite({session: this.store.getSession(this.sessionId)!, task: freshTask,
            spec: freshSpec, capability, args, reason: opts.reason,
            evidence_refs: opts.evidence_refs, expected_revisions: opts.expected_revisions,
            decision_revisions: decisionRevisions, turnGoalRevision, generation: this.generation});
          this.setLoop('thinking', `${capability} submitted`);
          if (r.ok && r.action && !isTerminal(r.action.status)) {
            // async device action: wake on ITS terminal (bounded, per action)
            host.armWake({kind: 'action_terminal', predicate: {action_ids: [r.action.action_id]},
              dedupe_key: `act:${r.action.action_id}`, reason: `terminal of ${r.action.action_id}`});
          } else if (r.ok && r.action && isTerminal(r.action.status) && r.recovered === 'by_key') {
            // the terminal event raced past the inbox while the response was
            // lost (ownAction was still unknown) — continue explicitly
            this.scheduleTurn('action_terminal', `recovered ${r.action.action_id} already ${r.action.status}`);
          }
          return r;
        } catch (e) {
          return {ok: false, error: {code: 'internal', message: e instanceof Error ? e.message : String(e), retryable: true}};
        }
      },
      armWake: (w: {kind: 'sim_time' | 'condition' | 'action_terminal'; at_sim_s?: number | null;
        predicate?: Record<string, unknown> | null; dedupe_key?: string | null; reason: string;
        step_index?: number | null}) => {
        const t = this.store.activeTask(this.sessionId);
        // F02 fence + F07: no wake is armed from a stale turn or a needs_input task
        if (this.turnStale(turnTaskId, turnGoalRevision, turnSignal) || t?.status === 'needs_input') {
          return refusedWakeRow(this.sessionId, t?.task_id ?? task?.task_id ?? 'none', w);
        }
        // N03: a planning wake is bound to the CURRENT goal revision and to
        // the monitor_until step it waits for (the step the model named, or
        // the running/pending monitor step of the current task), so monitor
        // evidence can never be substituted across revisions, steps or
        // thresholds.
        let stepId: string | null = null;
        if (t && (w.kind === 'sim_time' || w.kind === 'condition')) {
          const planSteps = this.store.listPlanSteps(t.task_id);
          const named = typeof w.step_index === 'number'
            ? planSteps.find(s => s.index_in_plan === w.step_index) ?? null : null;
          const monitors = planSteps.filter(s => s.skill === 'monitor_until'
            && (s.status === 'running' || s.status === 'pending'));
          const chosen = named ?? monitors.find(s => s.status === 'running') ?? monitors[0] ?? null;
          if (chosen) stepId = chosen.step_id;
        }
        const wake = this.store.armWake({session_id: this.sessionId, task_id: t?.task_id ?? task?.task_id ?? 'none',
          kind: w.kind, predicate: w.predicate ?? null, target_sim_s: w.at_sim_s ?? null,
          source_watermark: this.lastSimTime, dedupe_key: w.dedupe_key ?? null,
          goal_revision: t?.goal_revision ?? null, step_id: stepId});
        this.emit('wake.armed', {wake_id: wake.wake_id, kind: wake.kind, target_sim_s: wake.target_sim_s,
          predicate: wake.predicate, reason: w.reason, goal_revision: wake.goal_revision, step_id: wake.step_id});
        this.refreshTimer();
        return wake;
      },
      updateTaskGoal: (patch: {goal_text?: string; goal_spec?: Record<string, unknown>; expected_revision: number}) => {
        const t = task ? this.store.getTask(task.task_id) : null;
        if (!t) return {ok: false as const, conflict: {actual: 0}};
        // F02 fence (needs_input is NOT stale: the model fills parameters)
        if (this.turnStale(turnTaskId, turnGoalRevision, turnSignal)) {
          return {ok: false as const, conflict: {actual: t.goal_revision}};
        }
        const r = this.store.updateTaskGoal(t.task_id, patch);
        if (r.ok) {
          turnGoalRevision = r.revision;
          // a new goal revision is a new intent: the model's plan-refusal
          // streak starts over under it
          this.planRefusals.delete(t.task_id);
          this.emit('task.goal_updated', {task_id: t.task_id, goal_revision: r.revision,
            goal_text: patch.goal_text ?? t.goal_text});
        }
        return r;
      },
      // R08: plans are made of explicitly versioned registry skills only.
      // Unknown skill/version, invalid inputs or failed plan-time
      // preconditions (checked against a FRESH authoritative state read)
      // refuse the whole plan — nothing is persisted.
      replacePlan: async (steps: Array<{skill: string; skill_version?: string;
        inputs?: Record<string, unknown> | null}>) => {
        const t = task ? this.store.getTask(task.task_id) : null;
        if (!t) return {ok: false as const, code: 'no_task', problems: ['no active task']};
        const stale = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
        if (stale || t.status === 'needs_input') {
          return {ok: false as const, code: 'stale_turn', problems: [stale ?? 'task is needs_input']};
        }
        const spec = this.parseSpec(t);
        if (!spec) {
          this.notePlanRefusal(t.task_id, ['stored goal_spec is invalid; fix the task first']);
          return {ok: false as const, code: 'invalid_goal', problems: ['stored goal_spec is invalid; fix the task first']};
        }
        let live: StateSnapshot;
        try {
          live = await this.readState();
        } catch (e) {
          return {ok: false as const, code: 'state_unreadable',
            problems: [`could not read the device state for plan-time preconditions: ${e instanceof Error ? e.message : String(e)}`]};
        }
        const validated = await validatePlanSteps(steps, spec, live);
        if (!validated.ok) {
          // deterministic refusal: counts toward the plan-refusal guardrail
          this.notePlanRefusal(t.task_id, validated.problems);
          return {ok: false as const, code: 'invalid_plan', problems: validated.problems};
        }
        this.planRefusals.delete(t.task_id); // accepted plan: the streak restarts
        // N01: re-run the FULL revocation check after the LAST await,
        // immediately before the write (no await in between): scheduler
        // stopped/turn aborted, session lifecycle, owner generation, agent
        // pause, task terminal/paused/needs_input, goal revision. The store
        // CAS below is the final guard against a race in between.
        const recheck = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
        const freshTask = this.store.getTask(t.task_id);
        if (recheck || !freshTask || freshTask.status === 'needs_input') {
          return {ok: false as const, code: 'stale_turn',
            problems: [recheck ?? (freshTask ? 'task is needs_input' : 'task is gone')]};
        }
        const rows = this.store.replacePlan(freshTask.task_id, turnGoalRevision,
          validated.steps.map(s => ({skill: s.skill, skill_version: s.version, inputs: s.inputs,
            postconditions: s.def.postconditions})));
        if (!rows) {
          return {ok: false as const, code: 'stale_turn',
            problems: [`the task moved past goal revision ${turnGoalRevision} while the plan was validated; the newer goal's plan was preserved`]};
        }
        this.emit('plan.updated', {task_id: t.task_id, plan_revision: turnGoalRevision,
          steps: rows.map(r => ({index: r.index_in_plan, skill: `${r.skill}@${r.skill_version}`,
            status: r.status}))});
        return {ok: true as const, rows};
      },
      // R08: `done` is accepted ONLY when the skill's postcondition evaluator
      // passes over the provided/linked action ids + evidence refs (see
      // verifyStepEvidence); `running` re-checks step-start preconditions;
      // `failed`/`skipped` are allowed with a reason. N01: every write is a
      // CAS on step_id + plan_revision + the prior status, re-checked for
      // revocation after the last await, so a stale turn can never commit a
      // step effect and a step replaced by a newer plan is never written.
      updateStep: async (index: number, fields: {status: 'done' | 'failed' | 'skipped' | 'running';
        action_ids?: string[]; evidence_refs?: string[]; reason?: string}) => {
        const t = task ? this.store.getTask(task.task_id) : null;
        if (!t) return {ok: false as const, code: 'no_task', message: 'no active task'};
        const stale = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
        if (stale || t.status === 'needs_input') {
          return {ok: false as const, code: 'stale_turn', message: stale ?? 'task is needs_input'};
        }
        const steps = this.store.listPlanSteps(t.task_id);
        const step = steps.find(s => s.index_in_plan === index);
        if (!step) return {ok: false as const, code: 'no_step', message: `no plan step at index ${index}`};
        const mergedActions = [...new Set([...step.action_ids, ...(fields.action_ids ?? [])])];
        const mergedRefs = [...new Set([...step.evidence_refs, ...(fields.evidence_refs ?? [])])];
        const expected = {plan_revision: step.plan_revision, status: step.status};
        const fresh = (): PlanStepRow => this.store.listPlanSteps(t.task_id).find(s => s.index_in_plan === index)!;
        const stepChanged = (): string =>
          `the plan changed while this update was decided (step ${index} was replaced or re-recorded under a different status); re-read the plan and retry`;
        if (fields.status === 'running') {
          // step start: preconditions re-checked against the authoritative state
          const spec = this.parseSpec(t);
          const resolved = resolveSkillStep({skill: step.skill, skill_version: step.skill_version, inputs: step.inputs ?? {}});
          if (spec && resolved.ok) {
            let live: StateSnapshot;
            try {
              live = await this.readState();
            } catch (e) {
              return {ok: false as const, code: 'state_unreadable',
                message: `could not read the device state for step-start preconditions: ${e instanceof Error ? e.message : String(e)}`};
            }
            const pre = resolved.resolved.def.checkPreconditions({inputs: resolved.resolved.inputs, spec, state: live});
            if (!pre.ok) {
              return {ok: false as const, code: 'preconditions_failed', message: pre.problems.join('; ')};
            }
          }
          // N01: full revocation re-check after the last await, then CAS write
          const recheck = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
          if (recheck) return {ok: false as const, code: 'stale_turn', message: recheck};
          if (!this.store.updatePlanStep(step.step_id, {status: 'running', action_ids: mergedActions,
            evidence_refs: mergedRefs, verification: null}, expected)) {
            return {ok: false as const, code: 'stale_turn', message: stepChanged()};
          }
          this.emit('plan.step', {task_id: t.task_id, index, status: 'running',
            action_ids: mergedActions, evidence_refs: mergedRefs});
          return {ok: true as const, step: fresh()};
        }
        if (fields.status === 'done') {
          const outcome = await this.verifyStepEvidence(t, step, mergedActions, mergedRefs);
          // N01: full revocation re-check after the last await (evidence reads
          // may have taken a while), then CAS write. A stale or replaced step
          // is refused before ANYTHING is persisted.
          const recheck = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
          if (recheck) {
            return {ok: false as const, code: 'stale_turn', message: recheck,
              next_skill: outcome.ok ? undefined : outcome.next_skill, verification: outcome.verification};
          }
          if (outcome.ok) {
            if (!this.store.updatePlanStep(step.step_id, {status: 'done', action_ids: mergedActions,
              evidence_refs: mergedRefs, verification: outcome.verification}, expected)) {
              return {ok: false as const, code: 'stale_turn', message: stepChanged()};
            }
            this.emit('plan.step', {task_id: t.task_id, index, status: 'done',
              action_ids: mergedActions, evidence_refs: mergedRefs, verification: outcome.verification});
            return {ok: true as const, step: fresh()};
          }
          if (outcome.disposition === 'refuse') {
            // invalid/incomplete/foreign evidence: the step is NOT done; the
            // failed verification attempt is still persisted and surfaced
            if (!this.store.updatePlanStep(step.step_id, {verification: outcome.verification}, expected)) {
              return {ok: false as const, code: 'stale_turn', message: stepChanged()};
            }
            this.emit('plan.step', {task_id: t.task_id, index, status: step.status, refused: true,
              verification: outcome.verification});
            return {ok: false as const, code: outcome.code, message: outcome.reasons.join('; '),
              next_skill: outcome.next_skill, verification: outcome.verification};
          }
          // valid evidence, target not met: the step FAILS with a reason code
          // and an explicit recommended next skill (never silently done)
          if (!this.store.updatePlanStep(step.step_id, {status: 'failed', action_ids: mergedActions,
            evidence_refs: mergedRefs, verification: outcome.verification}, expected)) {
            return {ok: false as const, code: 'stale_turn', message: stepChanged()};
          }
          this.emit('plan.step', {task_id: t.task_id, index, status: 'failed',
            verification: outcome.verification, next_skill: outcome.next_skill});
          return {ok: false as const, code: outcome.code, message: outcome.reasons.join('; '),
            next_skill: outcome.next_skill, verification: outcome.verification, step_failed: true};
        }
        // failed / skipped: reported, not verified (pass stays null). No await
        // happened since the entry fence; the CAS still guards the identity.
        const verification: StepVerification = {pass: null,
          code: fields.status === 'failed' ? 'reported_failed' : 'reported_skipped',
          reasons: [fields.reason?.trim() || `reported ${fields.status} by the model`], next_skill: null,
          evidence: {}, checked_at_wall: new Date().toISOString()};
        if (!this.store.updatePlanStep(step.step_id, {status: fields.status, action_ids: mergedActions,
          evidence_refs: mergedRefs, verification}, expected)) {
          return {ok: false as const, code: 'stale_turn', message: stepChanged()};
        }
        this.emit('plan.step', {task_id: t.task_id, index, status: fields.status,
          action_ids: mergedActions, evidence_refs: mergedRefs, verification});
        return {ok: true as const, step: fresh()};
      },
      // R08: complete_task is refused while any plan step is non-terminal,
      // done without a passing verification, or failed/skipped without a
      // later verified success of the same skill and target (N02).
      planGate: () => planCompletionGate(task ? this.store.listPlanSteps(task.task_id) : []),
      // N02: the full completion decision the complete_task tool enforces —
      // plan gate AND the independent goal-level verification of the CURRENT
      // goal revision (freshest owned evidence, live chamber readings).
      completeGate: (citedRefs: string[]) => this.evaluateTaskCompletion(
        task ? this.store.getTask(task.task_id) ?? null : null, citedRefs ?? []),
    };

    // F12: reserve the model turn BEFORE the provider call — the reservation
    // is the only increment and is never refunded (a restart must not get a
    // free extra turn). Turns that return before this point (device
    // unreachable, bad clock, archived) reserve nothing.
    if (task) {
      const reserved = this.store.tryReserveModelTurn(task.task_id);
      if (!reserved.ok) {
        this.emit('error', {where: 'turn', code: 'budget_exhausted',
          message: `model turn budget ${task.budget.max_model_turns} is exhausted`});
        this.store.appendMessage(this.sessionId, {role: 'system',
          content: `[budget exhausted] model turn budget ${task.budget.max_model_turns} reached; task failed`,
          task_id: task.task_id});
        const nowTask = this.store.getTask(task.task_id);
        if (nowTask && !TERMINAL_TASK_STATUSES.includes(nowTask.status)) {
          this.store.updateTaskStatus(nowTask.task_id, 'failed', 'budget_exhausted');
          this.emit('task.status', {task_id: nowTask.task_id, status: 'failed', reason: 'budget_exhausted'});
        }
        this.setLoop(this.loopStateForTask(), 'model turn budget exhausted');
        this.emit('turn.completed', {trigger, ok: false, code: 'budget_exhausted'});
        return;
      }
    }

    const output = await this.deps.backend.runTurn(input, host, turnSignal);
    if (this.stopped) return;
    // F02: the turn may have gone stale while the provider thought (pause,
    // goal edit, cancel, restart, stop). Refused tool effects never happened;
    // effects that passed the fence at call time may already be persisted and
    // are NOT rolled back — but nothing new is applied now.
    const staleMessage = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
    if (staleMessage) {
      this.emit('turn.completed', {trigger, ok: false, code: 'stale_turn'});
      return;
    }
    // R04: the model has now seen every user message up to this point (ok or
    // failed turn alike); a stale/aborted turn above consumes NOTHING, so a
    // pause/cancel never swallows a message the model never answered.
    this.store.consumeUserMessages(this.sessionId, turnConsumedUserSeq);
    this.retryDelayMs = 0; // a turn reached the model: the retry backoff resets
    const freshTask = task ? this.store.getTask(task.task_id) : null;
    if (!output.ok) {
      this.consecutiveModelErrors += 1;
      this.emit('model.error', {code: output.code, message: output.error, consecutive: this.consecutiveModelErrors});
      this.store.appendMessage(this.sessionId, {role: 'system',
        content: `[model turn failed] ${output.code}: ${output.error ?? 'unknown error'}`, task_id: task?.task_id ?? null});
      if (freshTask && this.consecutiveModelErrors >= 8) {
        this.store.updateTaskStatus(freshTask.task_id, 'failed', 'model_unavailable');
        this.emit('task.status', {task_id: freshTask.task_id, status: 'failed', reason: 'model_unavailable'});
        this.setLoop('unavailable', `model errors exceeded the consecutive limit (${this.consecutiveModelErrors})`);
      } else {
        // bounded retry: a later event or a short sim-time wake retries
        this.setLoop('unavailable', `${output.code}: ${output.error ?? ''}`);
        if (freshTask && !this.store.armedWakes(this.sessionId).some(w => w.task_id === freshTask.task_id)) {
          host.armWake({kind: 'sim_time', at_sim_s: state.experiment.sim_time_s + 120,
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
    // apply effects (fence checked above; complete_task can no longer touch a
    // cancelled task or a moved goal_revision)
    if (freshTask) {
      // R08 + N02: completion requires a verifiable plan — no non-terminal
      // steps, no step done without passing verification, no failed/skipped
      // step without a later verified success — AND an independent goal-level
      // verification of the CURRENT goal revision (the oracle path returns
      // taskCompleted directly as an effect, bypassing the tool, so this block
      // enforces the same decision the complete_task tool enforces).
      let completeAllowed = false;
      if (output.effects.taskCompleted) {
        const verdict = await this.evaluateTaskCompletion(freshTask,
          output.effects.taskCompleted.evidence_refs ?? []);
        if (verdict.ok) {
          // the goal check read the device while the turn was finishing: a
          // revocation that landed in that window still stops the completion
          const staleAfterCheck = this.turnStale(turnTaskId, turnGoalRevision, turnSignal);
          if (staleAfterCheck) {
            this.emit('turn.completed', {trigger, ok: false, code: 'stale_turn'});
            return;
          }
          completeAllowed = true;
        } else {
          this.emit('error', {where: 'turn', code: verdict.code, message: verdict.message});
          this.store.appendMessage(this.sessionId, {role: 'system',
            content: `[complete refused] ${verdict.code}: ${verdict.message}${verdict.reasons.length ? ` — ${verdict.reasons.join('; ')}` : ''}`,
            task_id: freshTask.task_id});
          // the refused task stays open; without an armed wake nothing would
          // ever re-decide it (bounded by sim time, not a tight model loop)
          if (!this.store.armedWakes(this.sessionId).some(w => w.task_id === freshTask.task_id)) {
            host.armWake({kind: 'sim_time', at_sim_s: state.experiment.sim_time_s + 60,
              dedupe_key: `complete-refused:${freshTask.task_id}:${freshTask.budget.model_turns_used}`,
              reason: `completion refused (${verdict.code}); re-decide`});
          }
        }
      }
      if (output.effects.taskCompleted && completeAllowed) {
        this.store.updateTaskStatus(freshTask.task_id, 'completed', null);
        this.store.cancelWakes(this.sessionId, freshTask.task_id);
        this.planRefusals.delete(freshTask.task_id); // terminal: streak state dies with the task
        this.emit('task.status', {task_id: freshTask.task_id, status: 'completed',
          summary: output.effects.taskCompleted.summary, evidence_refs: output.effects.taskCompleted.evidence_refs});
      } else if (output.effects.taskFailed) {
        this.store.updateTaskStatus(freshTask.task_id, 'failed', output.effects.taskFailed.reason);
        this.store.cancelWakes(this.sessionId, freshTask.task_id);
        this.planRefusals.delete(freshTask.task_id); // terminal: streak state dies with the task
        this.emit('task.status', {task_id: freshTask.task_id, status: 'failed', reason: output.effects.taskFailed.reason,
          summary: output.effects.taskFailed.summary});
      } else if (output.effects.inputRequested) {
        this.store.updateTaskStatus(freshTask.task_id, 'needs_input', output.effects.inputRequested.join(' | '));
        this.emit('task.status', {task_id: freshTask.task_id, status: 'needs_input',
          questions: output.effects.inputRequested});
      } else {
        // F07: missing critical parameters keep/set needs_input and are never
        // overwritten with running/waiting_*; a task whose parameters just
        // became complete is made executable again — without submitting
        // anything from this post-turn block.
        const freshSpec = this.parseSpec(freshTask);
        const missing = freshSpec ? missingExecutionParameters(freshSpec)
          : ['goal_spec is invalid; fix the task before it can run'];
        if (missing.length > 0) {
          if (freshTask.status !== 'needs_input') {
            this.store.updateTaskStatus(freshTask.task_id, 'needs_input', missing.join(' | '));
          }
          this.emit('task.status', {task_id: freshTask.task_id, status: 'needs_input', questions: missing});
        } else if (freshTask.status === 'needs_input') {
          const inFlight = await this.hasInFlightActions(freshTask);
          if (!this.turnStale(turnTaskId, turnGoalRevision, turnSignal)) {
            this.store.updateTaskStatus(freshTask.task_id, inFlight ? 'waiting_device' : 'running',
              inFlight ? 'device actions in flight' : 'parameters complete; work continues on a later turn');
            this.emit('task.status', {task_id: freshTask.task_id,
              status: inFlight ? 'waiting_device' : 'running', reason: 'parameters complete'});
            if (!inFlight) {
              // R03: the task is executable again — schedule exactly ONE
              // follow-up decision through the queued mechanism (this turn is
              // still in flight, so it runs right after it ends; no extra
              // user message, clock sample or restart may be required).
              // Writes during the parameter-filling turn itself stay refused
              // (the task was needs_input at decision time).
              this.scheduleTurn('parameters_complete', 'parameters complete; continuing');
            }
          }
        } else {
          const armed = this.store.armedWakes(this.sessionId).filter(w => w.task_id === freshTask.task_id);
          const waiting = armed.some(w => w.kind === 'condition') ? 'waiting_condition'
            : armed.some(w => w.kind === 'sim_time') ? 'waiting_condition' : 'running';
          const inFlight = await this.hasInFlightActions(freshTask);
          if (!this.turnStale(turnTaskId, turnGoalRevision, turnSignal)) {
            this.store.updateTaskStatus(freshTask.task_id, inFlight ? 'waiting_device' : waiting,
              inFlight ? 'device actions in flight' : armed.map(w => `${w.kind}${w.target_sim_s ? `@${w.target_sim_s}s` : ''}`).join(', ') || null);
            this.emit('task.status', {task_id: freshTask.task_id, status: inFlight ? 'waiting_device' : waiting});
          }
        }
      }
    }
    // Trial guardrail (see planRefusals): park a task whose plans keep being
    // deterministically refused as needs_input instead of letting it loop
    // "invalid_plan refusal → short sim wake → retry" until the model-turn
    // budget backstop. Runs AFTER the effect/status block so nothing above
    // flips the park back to running, and only while the turn is still
    // current (a concurrent goal edit both resets the streak and owns the
    // next transition — a late park must not strand the newer revision).
    if (freshTask && !this.turnStale(turnTaskId, turnGoalRevision, turnSignal)
      && !TERMINAL_TASK_STATUSES.includes(freshTask.status) && freshTask.status !== 'paused'
      && freshTask.status !== 'needs_input' && !this.stopped) {
      const refusals = this.planRefusals.get(freshTask.task_id);
      const limit = planRefusalLimit(this.parseSpec(freshTask));
      if (refusals && refusals.count >= limit) {
        const problems = refusals.problems.slice(0, 3).join('; ');
        const questions = [
          `the model's plan was refused ${refusals.count} times in a row (invalid_plan): ${problems}`,
          'adjust the goal (update_task_goal — e.g. allowed_operations) or answer with instructions; an accepted plan or a goal edit restarts planning under the new intent',
        ];
        this.store.updateTaskStatus(freshTask.task_id, 'needs_input', `plan_refusal_limit (${refusals.count} consecutive invalid_plan refusals): ${problems}`);
        // the model's short "retry" sim/condition wake must not keep burning
        // turns against a parked task — drop its planning waits
        this.store.cancelPlanningWakes(this.sessionId, freshTask.task_id);
        this.store.appendMessage(this.sessionId, {role: 'system',
          content: `[plan refused ${refusals.count}x] ${questions[0]} — task parked as needs_input (limit ${limit}, stop.max_corrections)`,
          task_id: freshTask.task_id});
        this.emit('task.status', {task_id: freshTask.task_id, status: 'needs_input',
          reason: 'plan_refusal_limit', questions, refusals: refusals.count, limit});
      }
    }
    this.setLoop(this.loopStateForTask());
    this.refreshTimer();
    this.emit('turn.completed', {trigger, ok: true, usage: output.usage,
      tools: output.toolLog.map(t => ({name: t.name, ok: t.ok}))});
    this.maybeCompact();
  }

  /**
   * R08 postcondition verification for one step: runs the step's registered
   * skill evaluator with AUTHORITATIVE reads — DeviceClient action/
   * observation/state lookups plus the session intent ledger, so evidence
   * only counts when the producing actions belong to THIS task at the
   * CURRENT goal revision.
   */
  private async verifyStepEvidence(task: TaskRow, step: PlanStepRow, actionIds: string[],
    evidenceRefs: string[]): Promise<VerifyOutcome> {
    const session = this.store.getSession(this.sessionId)!;
    const spec = this.parseSpec(task);
    const refuse = (code: string, reasons: string[], nextSkill: string): VerifyOutcome => ({
      ok: false, disposition: 'refuse', code, reasons, next_skill: nextSkill,
      verification: {pass: false, code, reasons, next_skill: nextSkill, evidence: {},
        checked_at_wall: new Date().toISOString()}});
    if (!spec) return refuse('invalid_goal', ['stored goal_spec is invalid; fix the task first'], 'request_input');
    const resolved = resolveSkillStep({skill: step.skill, skill_version: step.skill_version, inputs: step.inputs ?? {}});
    if (!resolved.ok) {
      return refuse('unknown_skill',
        [`plan step ${step.index_in_plan} carries '${step.skill}@${step.skill_version ?? '?'}' which is not in the skill registry: ${resolved.problems.join('; ')}`],
        'request_input');
    }
    const intents = new Map(this.store.listSessionIntents(this.sessionId)
      .filter(i => i.action_id).map(i => [i.action_id!, i]));
    const firedWakes: SkillFiredWake[] = this.store.firedWakes(this.sessionId, task.task_id)
      .map(w => ({wake_id: w.wake_id, task_id: w.task_id, kind: w.kind, target_sim_s: w.target_sim_s,
        predicate: w.predicate, fired_at_wall: w.fired_at_wall, goal_revision: w.goal_revision,
        step_id: w.step_id}));
    return resolved.resolved.def.verify({
      task_id: task.task_id,
      goal_revision: task.goal_revision,
      spec,
      step: {index: step.index_in_plan, skill: step.skill, skill_version: step.skill_version, inputs: step.inputs,
        step_id: step.step_id, plan_revision: step.plan_revision},
      action_ids: actionIds,
      evidence_refs: evidenceRefs,
      ownsAction: actionId => {
        const intent = intents.get(actionId);
        return intent ? {task_id: intent.task_id, goal_revision: intent.goal_revision} : null;
      },
      readAction: async (actionId): Promise<Action | null> => {
        try {return await this.client.action(session.experiment_id, actionId);} catch {return null;}
      },
      readObservation: async (observationId): Promise<Observation | null> => {
        try {return await this.client.observation(session.experiment_id, observationId);} catch {return null;}
      },
      readState: async () => this.readState(),
      firedWakes,
    });
  }

  /**
   * N02: the complete-task decision, enforced identically by the
   * complete_task tool and by runTurn's effect application (a backend may
   * return taskCompleted directly, bypassing the tool). Layer 1 is the plan
   * gate; layer 2 verifies the GoalSpec's success conditions independently —
   * the freshest observation owned by THIS task at the CURRENT goal revision,
   * or the live chamber for chamber metrics. A skipped step that produced no
   * success evidence only completes when that independent verification
   * confirms the goal; a failed step needs a later verified remediation of
   * the same skill and target.
   */
  private async evaluateTaskCompletion(task: TaskRow | null, citedRefs: string[]): Promise<
    {ok: true; evidence: Record<string, unknown>}
    | {ok: false; code: string; message: string; reasons: string[]}> {
    if (!task) return {ok: false, code: 'no_task', message: 'no active task', reasons: ['no active task']};
    const steps = this.store.listPlanSteps(task.task_id);
    const gate = planCompletionGate(steps);
    const goalCheck = async (): Promise<{ok: true; evidence: Record<string, unknown>}
      | {ok: false; code: string; message: string; reasons: string[]}> => {
      const spec = this.parseSpec(task);
      if (!spec) {
        return {ok: false, code: 'invalid_goal', message: 'stored goal_spec is invalid; fix the task first',
          reasons: ['stored goal_spec is invalid']};
      }
      const session = this.store.getSession(this.sessionId)!;
      const intents = this.store.listSessionIntents(this.sessionId);
      const byAction = new Map(intents.filter(i => i.action_id).map(i => [i.action_id!, i]));
      const maintenanceIds = intents.filter(i => i.task_id === task.task_id && i.action_id
        && (i.capability === 'media.add' || i.capability === 'media.exchange')).map(i => i.action_id!);
      const recordedObservations = this.store.sessionEventsAfter(this.sessionId, 0, 10_000)
        .filter(e => e.type === 'observation.recorded')
        .map(e => String((e.payload as {observation_id?: string}).observation_id ?? ''))
        .filter(Boolean);
      const outcome = await verifyGoalSatisfied({
        task_id: task.task_id,
        goal_revision: task.goal_revision,
        spec,
        observationRefs: [...new Set([...steps.flatMap(s => s.evidence_refs), ...citedRefs, ...recordedObservations])],
        maintenanceActionIds: maintenanceIds,
        // Q03: a metric-less goal completes only on verifiable success
        // evidence (deadline reached, or a done+verified monitor_until step
        // matching the goal's deadline / monitoring conditions)
        planSteps: steps,
        // T01/S02: the completion gate re-reads the fired wake's predicate
        // (debounce included) and revision binding, not only the step inputs.
        firedWakes: this.store.firedWakes(this.sessionId, task.task_id).map(w => ({
          wake_id: w.wake_id, task_id: w.task_id, kind: w.kind, target_sim_s: w.target_sim_s,
          predicate: w.predicate, fired_at_wall: w.fired_at_wall, goal_revision: w.goal_revision,
          step_id: w.step_id,
        })),
        ownsAction: actionId => {
          const intent = byAction.get(actionId);
          return intent ? {task_id: intent.task_id, goal_revision: intent.goal_revision} : null;
        },
        readAction: async actionId => {
          try {return await this.client.action(session.experiment_id, actionId);} catch {return null;}
        },
        readObservation: async observationId => {
          try {return await this.client.observation(session.experiment_id, observationId);} catch {return null;}
        },
        readState: async () => this.readState(),
      });
      if (!outcome.ok) {
        return {ok: false, code: outcome.code, message: outcome.reasons.join('; '), reasons: outcome.reasons};
      }
      return {ok: true, evidence: outcome.evidence as Record<string, unknown>};
    };
    if (!gate.ok) {
      const hard = gate.blockers.filter(b => !b.soft);
      if (hard.length) {
        return {ok: false, code: gate.code, message: gate.message, reasons: [gate.message]};
      }
      // only skipped-without-success-evidence: the independent goal-level
      // check decides whether the goal is in fact already satisfied
      const verdict = await goalCheck();
      if (!verdict.ok) return verdict;
      if ((verdict.evidence as {mode?: string}).mode !== 'metrics_verified') {
        // no verifiable metrics: the plan itself is the success evidence
        return {ok: false, code: gate.code, message: gate.message, reasons: [gate.message]};
      }
      return verdict;
    }
    return goalCheck();
  }

  private parseSpec(task: TaskRow): GoalSpec | null {
    try {
      return normalizeGoalSpec(task.goal_spec);
    } catch {
      return null;
    }
  }

  /** Trial guardrail bookkeeping: one more consecutive deterministic plan
   * refusal for a task (see planRefusals; reset paths delete the entry). */
  private notePlanRefusal(taskId: string, problems: string[]): void {
    const prev = this.planRefusals.get(taskId);
    this.planRefusals.set(taskId, {count: (prev?.count ?? 0) + 1, problems});
  }

  /**
   * LENIENT in-flight probe for a LIVE task: chooses waiting_device vs
   * running in the post-turn block (and restart recovery). A query failure
   * here only means "cannot prove in flight", which must not strand a live
   * task in waiting_device — the opposite default of the promotion barrier
   * sessionInFlightActions(), where unknown MUST block (Q01). Deliberately
   * not shared with that path.
   */
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
    // F09: hand the PREVIOUS checkpoint (summary + facts + open questions),
    // the armed wakes and the plan skeleton to the compactor so a new
    // checkpoint never drops them.
    const compactInput = {
      history, task: task ?? null, facts, evidenceRefs,
      previous: checkpoint ? {summary: checkpoint.summary, facts: checkpoint.facts,
        open_questions: checkpoint.open_questions} : null,
      wakes: this.store.armedWakes(this.sessionId).map(w =>
        ({kind: w.kind, target_sim_s: w.target_sim_s, predicate: w.predicate})),
      plan: task ? this.store.listPlanSteps(task.task_id).map(s => ({skill: s.skill, status: s.status})) : [],
    };
    const compacted = this.deps.backend.compact(compactInput);
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

  /**
   * Cancel a task. Ordering matters: the task is marked cancelled and its
   * wakes dropped FIRST, so write rights are revoked the moment cancellation
   * starts (an in-flight submitWrite re-checks status after its last await
   * and refuses); then the executor's write chain is awaited, so submits
   * that already passed the final check bind before the intent sweep and
   * their accepted actions get cancel requests too. Recorded results are
   * kept, never hidden or rolled back.
   * N05: the sweep passes explicit=true — an explicit user/supervisor cancel
   * ALWAYS re-attempts any cancel intent still in 'requested' (a transient
   * failure never permanently suppresses it); only a 'confirmed' cancel is
   * idempotent.
   */
  async cancelTask(taskId: string): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    const task = this.store.getTask(taskId);
    if (!session || !task || task.session_id !== this.sessionId) return;
    const wasQueued = task.status === 'queued';
    this.store.updateTaskStatus(taskId, 'cancelled',
      wasQueued ? 'cancelled from the queue by operator' : 'cancelled by operator');
    this.store.cancelWakes(this.sessionId, taskId);
    this.planRefusals.delete(taskId); // terminal: streak state dies with the task
    this.emit('task.status', {task_id: taskId, status: 'cancelled',
      reason: wasQueued ? 'operator_cancel_queued' : 'operator'});
    if (wasQueued) {
      // a queued item owns no device effects and no wake; nothing to sweep.
      // Remaining queue order is untouched (queue_index is never reused).
      this.setLoop(this.loopStateForTask());
      return;
    }
    await this.executor.settled(); // late-binding intents bind before the sweep
    for (const intent of this.store.listSessionIntents(this.sessionId)) {
      if (intent.task_id !== taskId || !intent.action_id) continue;
      await this.requestActionCancel(intent.action_id, taskId, {explicit: true});
    }
    this.setLoop(this.loopStateForTask());
    // R07: the cancelled task freed the execution slot — promote the queue
    // head once its device effects have settled (cancel requests above).
    await this.maybePromoteNext('current task cancelled');
  }

  /**
   * R07 queue promotion. Called whenever the current task may have reached a
   * terminal state (turn end, cancel, device terminal event, restart, queued
   * create). The single-writer guarantee is the store CAS in
   * promoteQueuedTask; this method owns the N04 handoff barriers and is the
   * ONLY path that clears the persisted marker:
   *  - unresolved intents of the finished task settle first (a by-key
   *    reconcile is attempted here; a lookup that itself fails retries on
   *    the next terminal event, watchdog tick or restart);
   *  - non-terminal in-flight device actions reach a terminal first (their
   *    terminal events retrigger this method).
   * Only after both barriers pass is sessions.handoff_pending cleared —
   * whether or not a queued task is then promoted — so the admission rule
   * (createTask ready birth) and promotion share one rule again. A paused or
   * needs_input current task holds the slot: no promotion.
   */
  private async maybePromoteNext(reason: string): Promise<void> {
    if (this.stopped) return;
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    if (session.owner_generation !== this.generation) return; // superseded owner stays silent
    if (this.store.activeTask(this.sessionId)) return; // slot still held (incl. paused/needs_input)
    const handoffPending = session.handoff_pending;
    if (!handoffPending && this.store.queuedTasks(this.sessionId).length === 0) return;
    if (this.store.unresolvedSessionIntents(this.sessionId).length > 0) {
      try {
        await this.executor.reconcileIntents(this.store.getSession(this.sessionId)!);
      } catch { /* stays pending: retried on the next trigger */ }
      if (this.store.unresolvedSessionIntents(this.sessionId).length > 0) return;
    }
    // Q01: a bound action whose terminal state cannot be CONFIRMED (query
    // failure, network error, unknown status) blocks the handoff exactly like
    // a live in-flight action — "unknown" must never read as "absent". The
    // persisted marker stays set, nothing is promoted, and the watchdog tick /
    // terminal device events / an explicit cancel retry this path until every
    // action of the session is confirmed terminal.
    const inFlight = await this.sessionInFlightActions();
    if (inFlight.inFlight || inFlight.unknown.length > 0) {
      if (inFlight.unknown.length > 0) {
        this.deps.log(`[scheduler ${this.sessionId}] handoff barriers uncleared: terminal state unknown for `
          + `${inFlight.unknown.join(', ')}; keeping handoff_pending and retrying later`);
      }
      return; // their terminals (or a recovered query) retrigger promotion
    }
    if (handoffPending) {
      this.store.clearSessionHandoff(this.sessionId);
      this.emit('task.handoff_cleared', {reason});
    }
    if (this.store.queuedTasks(this.sessionId).length === 0) return;
    const promoted = this.store.promoteQueuedTask(this.sessionId);
    if (!promoted) return;
    this.emit('task.promoted', {task_id: promoted.task_id, status: promoted.status,
      reason, queue_position_before: 1});
    this.emit('task.status', {task_id: promoted.task_id, status: promoted.status,
      reason: `promoted from queue (${reason})`, questions: promoted.status === 'needs_input' ? [promoted.reason] : undefined});
    this.setLoop(this.loopStateForTask());
    this.refreshTimer();
    if (EXECUTING_TASK_STATUSES.includes(promoted.status)) {
      // onTaskCreated-like kick: exactly one turn for the promoted task
      this.scheduleTurn('task_promoted', `task ${promoted.task_id} promoted from queue`);
    }
  }

  /**
   * Q01/N04 promotion barrier — deliberately STRICT. The handoff may clear
   * only when the terminal state of EVERY bound intent's action of the
   * session is CONFIRMED:
   *  - a non-terminal action blocks (its terminal event retriggers promotion);
   *  - a GET that fails (query failure, network error) blocks EQUALLY — the
   *    action may still be queued or running on the device, so the barrier
   *    must answer "unknown", never "not in flight". maybePromoteNext then
   *    keeps sessions.handoff_pending and retries on the next watchdog tick /
   *    terminal event / explicit cancel (N05's acceptedResponseLoss-style
   *    recovery: once queries succeed and the action is terminal — e.g. a
   *    persisted cancel_state 'requested' was delivered — the handoff clears
   *    and the queue head promotes);
   *  - ALL bound intents are checked: the last ten are not a complete
   *    handoff proof (an early action may still be the live one).
   * The sibling hasInFlightActions(task) below stays deliberately LENIENT (a
   * query failure only chooses waiting_device vs running for a LIVE task) and
   * must not share this strict default.
   */
  private async sessionInFlightActions(): Promise<{inFlight: boolean; unknown: string[]}> {
    const session = this.store.getSession(this.sessionId);
    if (!session) return {inFlight: false, unknown: []};
    const unknown: string[] = [];
    for (const intent of this.store.listSessionIntents(this.sessionId).filter(i => i.action_id)) {
      try {
        const action = await this.client.action(session.experiment_id, intent.action_id!);
        if (!isTerminal(action.status)) return {inFlight: true, unknown: []};
      } catch {
        unknown.push(intent.action_id!); // terminal state unconfirmed — blocks
      }
    }
    return {inFlight: false, unknown};
  }

  /**
   * N05 durable per-action cancel state machine (session_intents.cancel_state):
   *  - `requested` is persisted BEFORE the attempt — a crash, a failed GET or
   *    a lost POST response leaves it retryable, never silently dropped;
   *  - `confirmed` = the Runtime accepted the POST, OR the action is already
   *    terminal (the Runtime answers a cancel of a terminal action with its
   *    current state, so "already cancelled" is confirmation, not an error).
   *    Confirmed is idempotent: no second POST for that action;
   *  - any failure schedules a bounded backoff retry (1s→30s, unref'd,
   *    cleared on stop, at most CANCEL_RETRY_MAX_ATTEMPTS automatic attempts
   *    with one visible error event when exhausted).
   * `explicit` (a real cancelTask) always re-attempts 'requested' entries and
   * resets the attempt counter; the in-memory set dedupes only CONCURRENT
   * in-flight attempts, never retries. Restart recovery re-attempts every
   * persisted 'requested' entry.
   */
  private async requestActionCancel(actionId: string, taskId: string,
    opts: {explicit?: boolean} = {}): Promise<void> {
    if (this.cancelInFlight.has(actionId)) return; // an attempt is running right now
    const session = this.store.getSession(this.sessionId);
    if (!session) return;
    const intent = this.store.findIntentByAction(this.sessionId, actionId);
    if (intent) {
      if (intent.cancel_state === 'confirmed') return; // idempotent success
      if (!opts.explicit && intent.cancel_attempts >= CANCEL_RETRY_MAX_ATTEMPTS) {
        return; // automatic attempts exhausted; an explicit cancel retries again
      }
      this.store.markIntentCancelRequested(this.sessionId, intent.key, {reset: opts.explicit === true});
      if (opts.explicit) this.cancelExhaustedReported.delete(intent.key);
    }
    this.cancelInFlight.add(actionId);
    try {
      const action = await this.client.action(session.experiment_id, actionId);
      if (isTerminal(action.status)) {
        // already terminal (incl. already cancelled by an earlier attempt
        // whose response was lost): confirmed without another POST
        if (intent) this.store.markIntentCancelConfirmed(this.sessionId, intent.key);
        return;
      }
      await this.client.cancel(session.experiment_id, actionId);
      if (intent) this.store.markIntentCancelConfirmed(this.sessionId, intent.key);
      this.emit('action.cancel_requested', {task_id: taskId, action_id: actionId});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 'requested' stays durable; a response lost AFTER acceptance is
      // indistinguishable here — the retry's GET will see the cancelled
      // action and confirm it without a second POST
      if (intent) this.store.markIntentCancelFailed(this.sessionId, intent.key, message);
      this.emit('error', {where: 'cancel', code: e instanceof DeviceError ? e.code : 'network',
        message: `${actionId}: ${message}`});
      this.scheduleCancelRetry();
    } finally {
      this.cancelInFlight.delete(actionId);
    }
  }

  /**
   * N05: bounded backoff retry for cancel intents that never reached the
   * device. One unref'd timer at a time, cleared on stop; the delay doubles
   * (1 s → 30 s) per failure and resets once nothing is 'requested' anymore.
   */
  private scheduleCancelRetry(): void {
    if (this.stopped || this.cancelRetryTimer) return;
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    if (session.owner_generation !== this.generation) return; // superseded owner stays silent
    if (this.store.intentsCancelRequested(this.sessionId).length === 0) return;
    this.cancelRetryDelayMs = this.cancelRetryDelayMs ? Math.min(this.cancelRetryDelayMs * 2, 30_000) : 1_000;
    this.cancelRetryTimer = setTimeout(() => {
      this.cancelRetryTimer = null;
      if (this.stopped) return;
      this.deps.log(`[scheduler ${this.sessionId}] retrying requested device cancels`);
      void this.retryRequestedCancels();
    }, this.cancelRetryDelayMs);
    this.cancelRetryTimer.unref?.();
  }

  /** N05: re-attempt every persisted 'requested' cancel (backoff + restart recovery). */
  private async retryRequestedCancels(): Promise<void> {
    const session = this.store.getSession(this.sessionId);
    if (!session || session.lifecycle !== 'active' || this.stopped) return;
    const pending = this.store.intentsCancelRequested(this.sessionId);
    if (pending.length === 0) {
      this.cancelRetryDelayMs = 0; // nothing left: the backoff chain ends clean
      return;
    }
    for (const intent of pending) {
      if (!intent.action_id) continue;
      if (intent.cancel_attempts >= CANCEL_RETRY_MAX_ATTEMPTS) {
        // one visible error per exhaustion; an explicit cancel re-arms
        if (!this.cancelExhaustedReported.has(intent.key)) {
          this.cancelExhaustedReported.add(intent.key);
          this.emit('error', {where: 'cancel', code: 'cancel_retry_exhausted',
            message: `cancel of ${intent.action_id} (${intent.capability}) failed ${intent.cancel_attempts} times: `
              + `${intent.cancel_last_error ?? 'unknown error'}; an explicit task cancel retries it`});
        }
        continue;
      }
      await this.requestActionCancel(intent.action_id, intent.task_id);
    }
    if (this.store.intentsCancelRequested(this.sessionId).length === 0) this.cancelRetryDelayMs = 0;
  }
}

/** F02: armWake refusals return a non-persisted cancelled row (nothing armed). */
function refusedWakeRow(sessionId: string, taskId: string, w: {kind: 'sim_time' | 'condition' | 'action_terminal';
  at_sim_s?: number | null; predicate?: Record<string, unknown> | null; dedupe_key?: string | null}): WakeRow {
  return {wake_id: '', session_id: sessionId, task_id: taskId, kind: w.kind, predicate: w.predicate ?? null,
    target_sim_s: w.at_sim_s ?? null, source_watermark: null, status: 'cancelled',
    dedupe_key: w.dedupe_key ?? null, goal_revision: null, step_id: null,
    created_at_wall: new Date().toISOString(), fired_at_wall: null};
}

function summarizeResultEvent(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'action.submitted': return `${String(payload.capability ?? '')} accepted as ${String(payload.action_id ?? '')} (${String(payload.status ?? '')})`;
    case 'action.result': return `action ${String(payload.action_id ?? '')} (${String(payload.capability ?? '?')}) ${String(payload.status ?? '')}${payload.error ? ` error=${JSON.stringify(payload.error)}` : ''}`;
    case 'observation.recorded': return `observation ${String(payload.observation_id ?? '')} plate ${String(payload.plate_id ?? '')} quality ${String(payload.quality ?? '')}`;
    case 'wake.fired': return `wake ${String(payload.wake_id ?? '')} (${String(payload.kind ?? '')}) fired`;
    case 'model.unavailable': return `model unavailable: ${String(payload.reason ?? '')}`;
    case 'error': return `${String(payload.where ?? '')}/${String(payload.code ?? '')}: ${String(payload.message ?? '')}`;
    default: return type;
  }
}

function compactPayload(payload: Record<string, unknown>): unknown {
  const json = JSON.stringify(payload);
  // observation digests with per-well estimates are ~1 kB; truncating them
  // would make the evidence unparseable for the model. 4 kB keeps the turn
  // brief bounded while preserving full structured evidence.
  if (json.length <= 4000) return payload;
  return {truncated: json.slice(0, 4000)};
}
