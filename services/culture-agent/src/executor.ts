// Session tool executor (design §8): every device access from a model turn
// goes through here. Checks, in order: session lifecycle → scheduler
// ownership (fencing generation) → task status/goal_revision (late model
// responses lose write rights) → goal write scope → task budget →
// persist intent → submit with idempotency key → resolve uncertain outcomes
// by key. Writes are serialized per session; reads are not.
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

export class SessionExecutor {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) { this.deps = deps; }

  /** Serialize writes: one device-mutating submit at a time per session. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async readState(session: SessionRow): Promise<StateSnapshot> {
    return this.deps.client.state(session.experiment_id);
  }

  /**
   * Submit a device action for a task turn. `turnGoalRevision` is the
   * goal_revision the model decided under; a concurrent user edit bumps the
   * revision and the submission is refused (no out-of-date write).
   */
  submitWrite(input: {session: SessionRow; task: TaskRow; spec: GoalSpec; capability: string;
    args: Record<string, unknown>; reason?: string; evidence_refs?: string[];
    turnGoalRevision: number; generation: number}): Promise<SubmitOutcome> {
    return this.serialize(() => this.submitWriteLocked(input));
  }

  private async submitWriteLocked(input: {session: SessionRow; task: TaskRow; spec: GoalSpec;
    capability: string; args: Record<string, unknown>; reason?: string; evidence_refs?: string[];
    turnGoalRevision: number; generation: number}): Promise<SubmitOutcome> {
    const {session, task, spec, capability} = input;
    // 1. lifecycle: archived sessions (reset experiment) lost write capability
    const fresh = this.deps.store.getSession(session.session_id);
    if (!fresh || fresh.lifecycle !== 'active') {
      return {ok: false, error: {code: 'session_archived', message: 'session is archived and read-only', retryable: false}};
    }
    // 2. fencing: an older scheduler owner must never write
    if (fresh.owner_generation !== input.generation) {
      return {ok: false, error: {code: 'stale_owner', message: `scheduler generation ${input.generation} is superseded by ${fresh.owner_generation}`, retryable: false}};
    }
    // 3. task must be live and the model response must not predate a goal edit
    const freshTask = this.deps.store.getTask(task.task_id);
    if (!freshTask || ['completed', 'failed', 'cancelled'].includes(freshTask.status)) {
      return {ok: false, error: {code: 'task_not_active', message: `task ${task.task_id} is ${freshTask?.status ?? 'gone'}`, retryable: false}};
    }
    if (freshTask.goal_revision !== input.turnGoalRevision) {
      return {ok: false, error: {code: 'goal_revision_stale',
        message: `goal was updated to revision ${freshTask.goal_revision} while the model was deciding (decision used ${input.turnGoalRevision}); re-read the task and re-decide`,
        retryable: false}};
    }
    if (['paused', 'needs_input'].includes(freshTask.status)) {
      return {ok: false, error: {code: 'task_paused', message: `task is ${freshTask.status}`, retryable: false}};
    }
    // 4. goal write scope
    const scope = scopeAllowsWrite(spec, capability, input.args);
    if (!scope.ok) return {ok: false, error: {code: 'out_of_scope', message: scope.reason, retryable: false}};
    // 5. budget (persisted, survives restarts; cannot be reset by new turns)
    if (freshTask.budget.actions_used >= freshTask.budget.max_actions) {
      return {ok: false, error: {code: 'budget_exhausted',
        message: `action budget ${freshTask.budget.max_actions} is exhausted`, retryable: false}};
    }

    const canonical = canonicalJson({capability, arguments: input.args,
      evidence_refs: input.evidence_refs ?? [], reason: input.reason ?? null});
    const pending = this.deps.store.findPendingSessionIntentByCanonical(session.session_id, canonical);
    let key: string;
    if (pending) {
      // uncertain-failure recovery: SAME key, never a redo
      key = pending.key;
    } else {
      key = `${session.session_id}:${task.task_id}:r${input.turnGoalRevision}:a${freshTask.budget.actions_used + 1}`;
      this.deps.store.insertSessionIntent({session_id: session.session_id, task_id: task.task_id, key,
        capability, canonical, goal_revision: input.turnGoalRevision}); // BEFORE the HTTP call
    }
    try {
      const result = await this.deps.client.submit(session.experiment_id,
        {capability, arguments: input.args, evidence_refs: input.evidence_refs ?? [],
          reason: input.reason ?? `session task ${task.task_id} (goal r${input.turnGoalRevision})`, basis: 'llm'},
        {idempotencyKey: key});
      this.deps.store.setSessionIntentAction(session.session_id, key, result.action.action_id);
      this.deps.store.incrementTaskBudget(task.task_id, {actions: 1});
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
        this.deps.emit({kind: 'error', where: 'submit', code: e.code, message: e.message, key});
        return {ok: false, error: {code: e.code, message: e.message, retryable: e.status >= 500}};
      }
      const message = e instanceof Error ? e.message : String(e);
      this.deps.emit({kind: 'error', where: 'submit', code: 'network', message, key});
      return {ok: false, error: {code: 'network', message, retryable: true}};
    }
  }

  /** After an uncertain failure (timeout/5xx/network): the key may already have produced an action. */
  private async resolveUncertain(experimentId: string, sessionId: string, key: string, e: unknown): Promise<SubmitOutcome | null> {
    const uncertain = !(e instanceof DeviceError) || UNCERTAIN_CODES.has(e.code);
    if (!uncertain) return null;
    try {
      const found = await this.deps.client.actionByKey(experimentId, key);
      if (found) {
        this.deps.store.setSessionIntentAction(sessionId, key, found.action_id);
        this.deps.store.incrementTaskBudgetByIntent(sessionId, key);
        this.deps.emit({kind: 'action.submitted', key, action_id: found.action_id, capability: found.capability,
          status: found.status, recovered: 'by_key'});
        if (isTerminal(found.status)) {
          this.deps.emit({kind: 'action.result', action_id: found.action_id, capability: found.capability,
            status: found.status, summary: found.summary, error: found.error, partial: found.partial,
            ended_at_sim_s: found.ended_at_sim_s});
        }
        return {ok: true, action: found, recovered: 'by_key'};
      }
    } catch { /* lookup itself failed; fall through */ }
    return null;
  }

  /** Startup/restart reconciliation: resolve intents without action_id. */
  async reconcileIntents(session: SessionRow, task: TaskRow): Promise<number> {
    let resolved = 0;
    for (const intent of this.deps.store.pendingSessionIntents(session.session_id)) {
      if (intent.task_id !== task.task_id) continue;
      try {
        const action = await this.deps.client.actionByKey(session.experiment_id, intent.key);
        if (action) {
          this.deps.store.setSessionIntentAction(session.session_id, intent.key, action.action_id);
          this.deps.store.incrementTaskBudgetByIntent(session.session_id, intent.key);
          this.deps.emit({kind: 'action.submitted', key: intent.key, action_id: action.action_id,
            capability: intent.capability, status: action.status, recovered: 'by_key_on_restart'});
          resolved += 1;
        } else {
          this.deps.emit({kind: 'error', where: 'reconcile', code: 'intent_unresolved',
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
