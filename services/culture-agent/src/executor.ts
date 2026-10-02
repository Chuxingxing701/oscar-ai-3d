// Session tool executor (design §8): every device access from a model turn
// goes through here. Checks, in order: session lifecycle → scheduler
// ownership (fencing generation) → task status/goal_revision (late model
// responses lose write rights) → operator pause / scheduler stop → goal
// write scope → task budget → persist intent → fresh-state revision fence →
// re-run every revocation check → submit with idempotency key → resolve
// uncertain outcomes by key. Writes are serialized per session; reads are
// not. Intents carry an outcome state: unknown (pending) effects of ANY task
// block new keys until a by-key lookup settles them.
import {DeviceClient, DeviceError, canonicalJson, isTerminal} from '@oscar/device-contract';
import type {Action, StateSnapshot} from '@oscar/device-contract';
import {scopeAllowsWrite, type GoalSpec} from './goal.ts';
import type {SessionStore, SessionRow, TaskRow} from './session-store.ts';

export type ExecutorEvent =
  | {kind: 'action.submitted'; key: string; action_id: string; capability: string; status: string; recovered?: string}
  | {kind: 'action.result'; action_id: string; capability: string; status: string; summary?: unknown;
    error?: unknown; partial?: boolean; ended_at_sim_s?: number | null}
  | {kind: 'error'; where: string; code: string; message: string; key?: string};

export interface SubmitOutcome {
  ok: boolean;
  action?: Action;
  error?: {code: string; message: string; retryable: boolean};
  /** Set when an uncertain failure was resolved by idempotency key. */
  recovered?: 'by_key';
}

export interface ExecutorDeps {
  store: SessionStore;
  client: DeviceClient;
  emit: (event: ExecutorEvent) => void;
  log: (message: string) => void;
}

/** Thrown for every refusal that must abort the tool result, not the turn. */
export class ToolRefusal extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

const UNCERTAIN_CODES = new Set(['internal']);
/** Liquid capabilities require fresh observation evidence (design §8). */
const LIQUID_CAPABILITIES = new Set(['media.add', 'media.exchange']);

export class SessionExecutor {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deps: ExecutorDeps;
  private closed = false;

  constructor(deps: ExecutorDeps) { this.deps = deps; }

  /** F01: process shutdown revokes in-flight writes; idempotent. */
  close(): void { this.closed = true; }

  /** Serialize writes: one device-mutating submit at a time per session. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Resolves once every already-queued submitWrite has finished (the write
   * chain is idle). cancelTask marks the task cancelled FIRST, then awaits
   * this: submits still in flight bind to the cancelled task before its
   * intent sweep runs, so their actions get cancel requests.
   */
  settled(): Promise<void> {
    return this.chain.then(() => undefined, () => undefined);
  }

  async readState(session: SessionRow): Promise<StateSnapshot> {
    return this.deps.client.state(session.experiment_id);
  }

  /**
   * Submit a device action for a task turn. `turnGoalRevision` is the
   * goal_revision the model decided under; a concurrent user edit bumps the
   * revision and the submission is refused (no out-of-date write).
   * `decision_revisions` are the plate/chamber revisions captured from the
   * state snapshot read at the START of the turn; they are compared against
   * a fresh read inside the write lock right before the HTTP submit, and
   * every revocation condition is re-run after that read — the last await
   * before the intent insert.
   */
  submitWrite(input: {session: SessionRow; task: TaskRow; spec: GoalSpec; capability: string;
    args: Record<string, unknown>; reason?: string; evidence_refs?: string[];
    expected_revisions?: Record<string, number>; decision_revisions?: Record<string, number>;
    turnGoalRevision: number; generation: number}): Promise<SubmitOutcome> {
    return this.serialize(() => this.submitWriteLocked(input));
  }

  private async submitWriteLocked(input: {session: SessionRow; task: TaskRow; spec: GoalSpec;
    capability: string; args: Record<string, unknown>; reason?: string; evidence_refs?: string[];
    expected_revisions?: Record<string, number>; decision_revisions?: Record<string, number>;
    turnGoalRevision: number; generation: number}): Promise<SubmitOutcome> {
    const {session, task, spec, capability} = input;
    // 0-5. every revocation condition, re-read from the store synchronously.
    // Runs before the async preflight AND again after the LAST await: a
    // pause/close/cancel/goal-edit/ownership-change/archive that lands while
    // the state read is in flight must refuse here, not submit on stale checks.
    const refused = this.writeRefusal(input);
    if (refused) return refused;
    // 3c. uncertain effects (own or another task's) must be reconciled before
    // anything new is written; a lookup that itself fails keeps them unknown.
    if (this.deps.store.unresolvedSessionIntents(session.session_id).length > 0) {
      await this.reconcileIntents(this.deps.store.getSession(session.session_id)!);
    }
    // 4. goal write scope
    const scope = scopeAllowsWrite(spec, capability, input.args);
    if (!scope.ok) return {ok: false, error: {code: 'out_of_scope', message: scope.reason, retryable: false}};
    // 6. F05: liquid actions need fresh observation evidence attached
    if (LIQUID_CAPABILITIES.has(capability) && (!input.evidence_refs || input.evidence_refs.length === 0)) {
      return {ok: false, error: {code: 'observation_stale',
        message: 'liquid actions require fresh observation evidence', retryable: false}};
    }

    // 7. F05: fresh state INSIDE the write lock, immediately before the HTTP
    // submit. Decision revisions (turn-start snapshot) vs the live plate
    // revision: a moved plate means the decision is stale — re-plan, no submit.
    const live: StateSnapshot = await this.deps.client.state(session.experiment_id);
    const plateId = typeof input.args.plate_id === 'string' ? input.args.plate_id : null;
    const expected: Record<string, number> = {...(input.expected_revisions ?? {})};
    if (plateId) {
      const plateKey = `plate:${plateId}`;
      const decisionRevision = input.decision_revisions?.[plateKey];
      const livePlate = live.plates.find(p => p.plate_id === plateId);
      if (livePlate && typeof decisionRevision === 'number' && decisionRevision !== livePlate.revision) {
        return {ok: false, error: {code: 'revision_conflict',
          message: `plate ${plateId} moved from revision ${decisionRevision} (decision) to ${livePlate.revision} while the model was deciding; re-read the state and re-plan`,
          retryable: false}};
      }
      // the fresh revision wins: Runtime's atomic check covers the gap
      // between this read and the action insert on the device
      if (livePlate) expected[plateKey] = livePlate.revision;
    }
    // 7b. last async gap closed: re-run every revocation check (lifecycle,
    // fencing, task status/revision, pauses, budget). Everything from here to
    // insertSessionIntent is synchronous, so no revocation can slip between
    // the check and the intent insert.
    const refusedLate = this.writeRefusal(input);
    if (refusedLate) return refusedLate;

    // 8. intent identity — reuse the SAME key only for the same task, same
    // goal revision and same canonical request with a still-safely-retryable
    // outcome; otherwise a fresh operation id (never actions_used+1, which
    // recycles keys when an earlier action was refused or recovered).
    const canonical = canonicalJson({capability, arguments: input.args,
      evidence_refs: input.evidence_refs ?? [], reason: input.reason ?? null});
    const pending = this.deps.store.findReusableIntent(session.session_id, task.task_id, canonical, input.turnGoalRevision);
    let key: string;
    if (pending) {
      // uncertain-failure recovery: SAME key, never a redo. The retry's own
      // outcome is unknown again until it resolves.
      key = pending.key;
      this.deps.store.setSessionIntentState(session.session_id, key, 'pending');
    } else {
      // an unresolved intent of ANY task means the session may already hold
      // an accepted-but-unbound effect: no NEW key may be created until every
      // lookup settles (bound / not_accepted / rejected)
      if (this.deps.store.unresolvedSessionIntents(session.session_id).length > 0) {
        return {ok: false, error: {code: 'reconcile_pending',
          message: `${this.deps.store.unresolvedSessionIntents(session.session_id).length} session intent(s) still have an unknown device outcome; retry after they are reconciled`,
          retryable: true}};
      }
      const operationId = this.deps.store.nextOperationId(session.session_id);
      key = `${session.session_id}:${task.task_id}:r${input.turnGoalRevision}:${operationId}`;
      this.deps.store.insertSessionIntent({session_id: session.session_id, task_id: task.task_id, key,
        capability, canonical, goal_revision: input.turnGoalRevision, operation_id: operationId}); // BEFORE the HTTP call
    }
    try {
      const result = await this.deps.client.submit(session.experiment_id,
        {capability, arguments: input.args,
          expected_revisions: Object.keys(expected).length ? expected : undefined,
          evidence_refs: input.evidence_refs ?? [],
          reason: input.reason ?? `session task ${task.task_id} (goal r${input.turnGoalRevision})`, basis: 'llm'},
        {idempotencyKey: key});
      // F06: ONE accounting path — action_id + action budget together
      this.deps.store.accountIntent(session.session_id, key, result.action.action_id);
      this.deps.emit({kind: 'action.submitted', key, action_id: result.action.action_id, capability,
        status: result.action.status});
      if (isTerminal(result.action.status)) {
        this.deps.emit({kind: 'action.result', action_id: result.action.action_id, capability,
          status: result.action.status, summary: result.action.summary, error: result.action.error,
          partial: result.action.partial, ended_at_sim_s: result.action.ended_at_sim_s});
      }
      return {ok: true, action: result.action};
    } catch (e) {
      const resolved = await this.resolveUncertain(session.experiment_id, session.session_id, key, e);
      if (resolved) return resolved;
      if (e instanceof DeviceError) {
        if (!UNCERTAIN_CODES.has(e.code)) {
          // definitive Runtime refusal: no action exists for this key — the
          // intent is terminal, not forever-"pending"
          this.deps.store.setSessionIntentState(session.session_id, key, 'rejected');
        }
        this.deps.emit({kind: 'error', where: 'submit', code: e.code, message: e.message, key});
        return {ok: false, error: {code: e.code, message: e.message, retryable: e.status >= 500}};
      }
      const message = e instanceof Error ? e.message : String(e);
      this.deps.emit({kind: 'error', where: 'submit', code: 'network', message, key});
      return {ok: false, error: {code: 'network', message, retryable: true}};
    }
  }

  /**
   * Synchronous revocation re-check over fresh store rows: executor closed,
   * session lifecycle, scheduler fencing generation, task status (terminal /
   * paused / needs_input) and goal_revision, operator pause, action budget.
   * Returns the refusal outcome, or null when the write may proceed.
   */
  private writeRefusal(input: {session: SessionRow; task: TaskRow;
    turnGoalRevision: number; generation: number}): SubmitOutcome | null {
    // 0. F01: a stopped scheduler must never submit, even mid-shutdown races
    if (this.closed) {
      return {ok: false, error: {code: 'scheduler_stopped', message: 'scheduler is stopped', retryable: false}};
    }
    // 1. lifecycle: archived sessions (reset experiment) lost write capability
    const fresh = this.deps.store.getSession(input.session.session_id);
    if (!fresh || fresh.lifecycle !== 'active') {
      return {ok: false, error: {code: 'session_archived', message: 'session is archived and read-only', retryable: false}};
    }
    // 2. fencing: an older scheduler owner must never write
    if (fresh.owner_generation !== input.generation) {
      return {ok: false, error: {code: 'stale_owner', message: `scheduler generation ${input.generation} is superseded by ${fresh.owner_generation}`, retryable: false}};
    }
    // 3. task must be live and the model response must not predate a goal edit
    const freshTask = this.deps.store.getTask(input.task.task_id);
    if (!freshTask || ['completed', 'failed', 'cancelled'].includes(freshTask.status)) {
      return {ok: false, error: {code: 'task_not_active', message: `task ${input.task.task_id} is ${freshTask?.status ?? 'gone'}`, retryable: false}};
    }
    if (freshTask.goal_revision !== input.turnGoalRevision) {
      return {ok: false, error: {code: 'goal_revision_stale',
        message: `goal was updated to revision ${freshTask.goal_revision} while the model was deciding (decision used ${input.turnGoalRevision}); re-read the task and re-decide`,
        retryable: false}};
    }
    if (['paused', 'needs_input'].includes(freshTask.status)) {
      return {ok: false, error: {code: 'task_paused', message: `task is ${freshTask.status}`, retryable: false}};
    }
    // N04: a queued task holds NO execution rights — the queue head is
    // promoted (after the handoff barriers) before anything may be written.
    if (freshTask.status === 'queued') {
      return {ok: false, error: {code: 'task_queued',
        message: `task ${input.task.task_id} is queued; only the promoted current task may operate the device`,
        retryable: false}};
    }
    // 3b. F01: operator pause revokes in-flight writes (no intent, no submit)
    if (fresh.agent_paused) {
      return {ok: false, error: {code: 'agent_paused', message: 'agent is paused', retryable: false}};
    }
    // 5. budget (persisted, survives restarts; cannot be reset by new turns)
    if (freshTask.budget.actions_used >= freshTask.budget.max_actions) {
      return {ok: false, error: {code: 'budget_exhausted',
        message: `action budget ${freshTask.budget.max_actions} is exhausted`, retryable: false}};
    }
    return null;
  }

  /** After an uncertain failure (timeout/5xx/network): the key may already have produced an action. */
  private async resolveUncertain(experimentId: string, sessionId: string, key: string, e: unknown): Promise<SubmitOutcome | null> {
    const uncertain = !(e instanceof DeviceError) || UNCERTAIN_CODES.has(e.code);
    if (!uncertain) return null;
    try {
      const found = await this.deps.client.actionByKey(experimentId, key);
      if (found) {
        this.deps.store.accountIntent(sessionId, key, found.action_id);
        this.deps.emit({kind: 'action.submitted', key, action_id: found.action_id, capability: found.capability,
          status: found.status, recovered: 'by_key'});
        if (isTerminal(found.status)) {
          this.deps.emit({kind: 'action.result', action_id: found.action_id, capability: found.capability,
            status: found.status, summary: found.summary, error: found.error, partial: found.partial,
            ended_at_sim_s: found.ended_at_sim_s});
        }
        return {ok: true, action: found, recovered: 'by_key'};
      }
      // the Runtime definitively holds no action for this key: terminal, and
      // the same-key retry for an identical re-plan stays available
      this.deps.store.setSessionIntentState(sessionId, key, 'not_accepted');
    } catch { /* lookup itself failed: the outcome stays unknown (pending) */ }
    return null;
  }

  /**
   * Startup/uncertainty reconciliation: resolve every UNKNOWN intent of the
   * session (F06) — budget is attributed via `accountIntent` to the intent's
   * OWN task. A definitive "no action for this key" marks the intent
   * not_accepted (safe terminal; the task may still retry the SAME key).
   * Lookups that throw leave the intent pending: it blocks new session keys
   * and retries with the same key if the task re-plans the identical request;
   * a new action is never submitted for it here.
   */
  async reconcileIntents(session: SessionRow): Promise<number> {
    let resolved = 0;
    for (const intent of this.deps.store.unresolvedSessionIntents(session.session_id)) {
      try {
        const action = await this.deps.client.actionByKey(session.experiment_id, intent.key);
        if (action) {
          this.deps.store.accountIntent(session.session_id, intent.key, action.action_id);
          this.deps.emit({kind: 'action.submitted', key: intent.key, action_id: action.action_id,
            capability: intent.capability, status: action.status, recovered: 'by_key_on_restart'});
          resolved += 1;
        } else {
          this.deps.store.setSessionIntentState(session.session_id, intent.key, 'not_accepted');
          this.deps.emit({kind: 'error', where: 'reconcile', code: 'intent_not_accepted',
            message: `intent ${intent.key} (${intent.capability}) has no action on the Runtime; it will only be retried with the SAME key if the task re-plans it`});
        }
      } catch (e) {
        if (e instanceof DeviceError && (e.code === 'experiment_archived' || e.code === 'unauthenticated')) return resolved;
        this.deps.emit({kind: 'error', where: 'reconcile', code: e instanceof DeviceError ? e.code : 'network',
          message: `by-key lookup for ${intent.key} failed: ${e instanceof Error ? e.message : String(e)}`});
      }
    }
    return resolved;
  }
}
