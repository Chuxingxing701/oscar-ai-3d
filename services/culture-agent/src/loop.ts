// Per-run control loop (design §7.2). Lockstep: driven by decision.granted
// (device SSE with the run token, or leases/current on reconnect). Under a
// lease: gather state → policy decide → submit with the persisted
// idempotency key → release(wake) → continue on next_lease or wait for the
// next grant. Renew every ttl/3 while deciding. The loop never reads the
// Runtime database and never uses simulator truth.
import {DeviceClient, DeviceError, buildTools, canonicalJson, isTerminal, type Action, type Lease,
  type Observation, type StateSnapshot} from '@oscar/device-contract';
import {loadScenario, type Scenario} from '@oscar/simulator';
import {adapterForRun, emptyMemory, type ActionRecord, type ModelAdapter, type ObservationRecord,
  type PolicyContext, type PolicyDecision, type SubmitErrorRecord} from '@oscar/culture-policy';
import type {AgentConfig} from './config.ts';
import type {AgentEvent, AgentStore, RunRow} from './store.ts';
import {buildReport} from './report.ts';

export interface LoopDeps {
  store: AgentStore;
  config: AgentConfig;
  runtimeUrl: string;
  fetchImpl?: typeof fetch;
  emit: (runId: string, type: string, payload: Record<string, unknown>) => AgentEvent;
  log: (message: string) => void;
}

type Wakeup = {kind: 'grant'; leaseId: number} | {kind: 'control'} | {kind: 'stop'}
  | {kind: 'runEnded'; reason: string};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolvePromise => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolvePromise(); }, ms);
    const onAbort = (): void => { clearTimeout(t); resolvePromise(); };
    signal?.addEventListener('abort', onAbort, {once: true});
  });

/** Outcomes where the request may still have been accepted (must re-check by key). */
const UNCERTAIN_CODES = new Set(['internal']);

export class RunLoop {
  private readonly store: AgentStore;
  private readonly deps: LoopDeps;
  readonly runId: string;
  private experimentId: string;
  private client: DeviceClient;
  private task: Scenario['task'];
  private tools: Array<{name: string; capability: string | null}> = [];
  private adapter: ModelAdapter | null = null;
  private stopped = false;
  private mainDone = false;
  private localStatus: RunRow['status'] = 'active';
  private pauseReason: string | null = null;
  private lastHandledLeaseId = 0;
  private renewTimer: NodeJS.Timeout | null = null;
  private watcherAbort: AbortController | null = null;
  private readonly wakeups: Wakeup[] = [];
  private readonly waiters: Array<(w: Wakeup) => void> = [];
  private readonly actionCache = new Map<string, Action>();

  constructor(deps: LoopDeps, run: RunRow, initialLease: Lease | null) {
    this.deps = deps;
    this.store = deps.store;
    this.runId = run.run_id;
    this.experimentId = run.experiment_id;
    this.client = new DeviceClient({baseUrl: deps.runtimeUrl, token: run.run_token, timeoutMs: 15_000,
      fetch: deps.fetchImpl});
    this.task = loadScenario(run.scenario_id).task;
    if (initialLease && initialLease.state === 'active') {
      // seeded below the initial lease so the queued grant is not deduped
      this.lastHandledLeaseId = initialLease.lease_id - 1;
      this.wakeups.push({kind: 'grant', leaseId: initialLease.lease_id});
    }
  }

  // -- lifecycle --------------------------------------------------------------

  start(): void {
    void this.main().catch(e => {
      this.deps.log(`[agent] run ${this.runId} loop crashed: ${e instanceof Error ? e.message : String(e)}`);
      void this.finalizeLocalEnded('aborted', `agent loop crashed: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => {
      this.mainDone = true;
    });
  }

  /** True when the loop's main() has exited (restart needed to resume). */
  get dead(): boolean { return this.mainDone; }

  stop(): void {
    this.stopped = true;
    this.stopRenew();
    this.watcherAbort?.abort();
    this.push({kind: 'stop'});
  }

  control(action: 'pause' | 'resume' | 'cancel'): void {
    if (action === 'pause') {
      this.setLocalPaused('operator_pause', false);
      this.stopRenew();
      this.push({kind: 'control'});
    } else if (action === 'resume') {
      if (this.localStatus === 'ended') return;
      this.localStatus = 'active';
      this.pauseReason = null;
      this.store.updateRun(this.runId, {status: 'active', pause_reason: null});
      this.emit('resumed', {by: 'operator'});
      this.push({kind: 'control'});
    } else {
      // cancel: Runtime already ended the run and revoked the token
      void this.finalizeLocalEnded('aborted', 'cancelled by operator');
      this.push({kind: 'control'});
    }
  }

  private get localEnded(): boolean { return this.stopped || this.localStatus === 'ended'; }

  private push(w: Wakeup): void {
    const fn = this.waiters.shift();
    if (fn) fn(w); else this.wakeups.push(w);
  }

  private next(): Promise<Wakeup> {
    const w = this.wakeups.shift();
    if (w) return Promise.resolve(w);
    return new Promise(resolvePromise => this.waiters.push(resolvePromise));
  }

  private emit(type: string, payload: Record<string, unknown>): AgentEvent {
    return this.deps.emit(this.runId, type, payload);
  }

  // -- main -------------------------------------------------------------------

  private async main(): Promise<void> {
    const row = this.store.getRun(this.runId)!;
    if (row.clock_mode === 'realtime') {
      await this.finalize('aborted', 'clock_mode=realtime is not supported by this demo Agent: decision barriers exist only in lockstep (contract §6)');
      return;
    }
    this.adapter = adapterForRun(row.mode, process.env);
    if (!(await this.adapter.available())) {
      this.emit('error', {where: 'adapter', code: 'model_unavailable',
        message: `mode '${row.mode}' selected but no usable model is configured (OSCAR_LLM_* incomplete); not falling back to scripted`});
      await this.pauseRemote('model_unavailable');
      return;
    }
    try {
      const manifest = await this.client.manifest();
      this.tools = buildTools(manifest, row.capabilities).map(t => ({name: t.name, capability: t.capability}));
    } catch {
      this.tools = [];
    }
    this.watchEvents();
    // Pick up a lease granted BEFORE this loop existed (operator resume
    // forwarded before the loop started, or a loop restarted after an agent
    // crash): its decision.granted event already predates our SSE cursor.
    const startupLease = await this.currentOwnLease();
    if (startupLease && startupLease.lease_id > this.lastHandledLeaseId) {
      this.push({kind: 'grant', leaseId: startupLease.lease_id});
    }
    for (;;) {
      const w = await this.next();
      if (w.kind === 'stop' || this.localEnded) break;
      if (w.kind === 'runEnded') {
        await this.finalizeLocalEnded('aborted', `run ended by Runtime (reason: ${w.reason})`);
        break;
      }
      if (w.kind === 'control') {
        if (this.localEnded || this.stopped) break;
        if (this.localStatus === 'paused') {
          // resume path: reconcile against the current Runtime state/lease
          const lease = await this.currentOwnLease();
          if (lease) {
            this.lastHandledLeaseId = lease.lease_id;
            await this.decideLoop(lease.lease_id);
          }
        }
        continue;
      }
      // grant
      if (this.localEnded || this.stopped) break;
      if (w.leaseId <= this.lastHandledLeaseId) continue; // dedupe
      if (this.localStatus === 'paused') {
        // A fresh barrier means the Runtime considers this run active again
        // (operator resume / hold release). model_unavailable never auto-resumes.
        if (this.pauseReason === 'model_unavailable') continue;
        this.localStatus = 'active';
        this.pauseReason = null;
        this.store.updateRun(this.runId, {status: 'active', pause_reason: null});
        this.emit('resumed', {by: 'fresh_lease', lease_id: w.leaseId});
      }
      this.lastHandledLeaseId = w.leaseId;
      await this.decideLoop(w.leaseId);
      if (this.localEnded || this.stopped) break;
    }
    this.stopRenew();
    this.watcherAbort?.abort();
  }

  // -- decision loop under one lease --------------------------------------------

  private async decideLoop(leaseId: number): Promise<void> {
    this.emit('lease.granted', {lease_id: leaseId});
    let ttlMs = 30_000;
    try {
      const lease = await this.client.currentLease(this.experimentId);
      if (lease && lease.state === 'active') {
        ttlMs = Math.max(1000, Date.parse(lease.expires_at_wall) - Date.now());
      }
    } catch { /* default ttl */ }
    this.startRenew(leaseId, ttlMs);
    let lastErrors: SubmitErrorRecord[] = [];
    let netBackoff = 250;
    try {
      for (;;) {
        if (this.stopped || this.localStatus !== 'active') return;
        let ctx;
        try {
          ctx = await this.gather(lastErrors);
        } catch (e) {
          const end = this.classifyReadError(e);
          if (end) { await this.finalizeLocalEnded('aborted', end); return; }
          await sleep(netBackoff);
          netBackoff = Math.min(netBackoff * 2, 5000);
          continue;
        }
        netBackoff = 250;
        let decision: PolicyDecision;
        try {
          await this.maybeDelay();
          decision = await this.adapter!.decide(ctx);
          this.store.updateRun(this.runId, {memory: ctx.memory});
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.emit('error', {where: 'decide', code: 'model_unavailable', message});
          await this.pauseRemote('model_unavailable');
          return;
        }
        this.emit('decision', {
          index: ctx.decisionIndex, kind: decision.kind, basis: decision.basis, reason: decision.reason,
          ...(decision.kind === 'act' ? {capability: decision.capability, arguments: decision.arguments,
            evidence_refs: decision.evidence_refs} : {}),
          ...(decision.kind === 'wait' ? {wake: decision.wake, lease_id: leaseId} : {}),
          ...(decision.kind === 'finish' ? {outcome: decision.outcome} : {}),
        });
        if (decision.kind === 'finish') {
          await this.finalize(decision.outcome, decision.summary);
          return;
        }
        if (decision.kind === 'wait') {
          this.emit('wait', {wake: decision.wake, lease_id: leaseId});
          this.stopRenew();
          let release: {lease: Lease; next_lease: Lease | null};
          try {
            release = await this.client.releaseLease(this.experimentId, leaseId, decision.wake);
          } catch (e) {
            if (e instanceof DeviceError && (e.code === 'lease_not_active' || e.code === 'lease_forbidden')) {
              const lease = await this.currentOwnLease();
              if (lease) {
                leaseId = lease.lease_id;
                this.lastHandledLeaseId = leaseId;
                this.emit('lease.granted', {lease_id: leaseId, by: 'replan'});
                this.startRenew(leaseId, ttlMs);
                continue;
              }
              await this.syncPauseFromRuntime();
              return;
            }
            throw e;
          }
          if (release.next_lease && release.next_lease.state === 'active') {
            leaseId = release.next_lease.lease_id;
            this.lastHandledLeaseId = leaseId;
            this.emit('lease.granted', {lease_id: leaseId, by: 'immediate_handoff'});
            this.startRenew(leaseId, ttlMs);
            continue;
          }
          return; // suspended: wait for the next decision.granted
        }
        // act
        const submitted = await this.submit(decision);
        lastErrors = submitted.errors;
        if (submitted.stop) return;
      }
    } finally {
      this.stopRenew();
    }
  }

  // -- gather -------------------------------------------------------------------

  private async gather(lastErrors: SubmitErrorRecord[]): Promise<PolicyContext> {
    const row = this.store.getRun(this.runId)!;
    const state: StateSnapshot = await this.client.state(this.experimentId);
    const actions: ActionRecord[] = [];
    for (const intent of this.store.listIntents(this.runId)) {
      if (!intent.action_id) continue;
      const action = await this.client.action(this.experimentId, intent.action_id);
      this.actionCache.set(action.action_id, action);
      if (this.store.markSeen(this.runId, `act:${action.action_id}`, action.status) && isTerminal(action.status)) {
        this.emit('action.result', {action_id: action.action_id, capability: action.capability,
          status: action.status, summary: action.summary, error: action.error, partial: action.partial,
          ended_at_sim_s: action.ended_at_sim_s});
      }
      actions.push({action_id: action.action_id, capability: action.capability, status: action.status,
        arguments: action.arguments, submitted_at_sim_s: action.submitted_at_sim_s,
        ended_at_sim_s: action.ended_at_sim_s, summary: action.summary, error: action.error, result: action.result});
    }
    const observations: ObservationRecord[] = [];
    for (const action of actions) {
      if (action.capability !== 'imaging.scan' || action.status !== 'succeeded') continue;
      const obsId = action.result?.observation_id;
      if (typeof obsId !== 'string') continue;
      const obs: Observation = await this.client.observation(this.experimentId, obsId);
      if (this.store.markSeen(this.runId, `obs:${obsId}`, '1')) {
        this.emit('observation.recorded', {observation_id: obs.observation_id, quality: obs.quality,
          sampled_at_sim_s: obs.sampled_at_sim_s, plate_id: obs.plate_id, wells: obs.wells, mode: obs.mode,
          plate_revision: obs.plate_revision, image_sha256: obs.images.map(i => i.sha256)});
      }
      observations.push({observation_id: obs.observation_id, plate_id: obs.plate_id, wells: obs.wells,
        mode: obs.mode, sampled_at_sim_s: obs.sampled_at_sim_s, plate_revision: obs.plate_revision,
        quality: obs.quality, estimates: obs.estimates, image_sha256: obs.images.map(i => i.sha256)});
    }
    const decisions = this.store.stmt("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='decision'")
      .get(this.runId) as {n: number};
    return {
      run: {run_id: row.run_id, experiment_id: row.experiment_id, mode: row.mode, scenario_id: row.scenario_id,
        seed: row.seed, plates: row.plates, capabilities: row.capabilities,
        budget: state.run?.budget ?? row.budget},
      task: this.task,
      state,
      observations,
      actions,
      lastErrors,
      memory: row.memory ?? emptyMemory(),
      decisionIndex: Number(decisions.n) + 1,
      tools: this.tools,
    };
  }

  // -- submit (intent persisted BEFORE the HTTP call, §6.4) ----------------------

  private async submit(decision: Extract<PolicyDecision, {kind: 'act'}>): Promise<{errors: SubmitErrorRecord[]; stop: boolean}> {
    const canonical = canonicalJson({capability: decision.capability, arguments: decision.arguments,
      evidence_refs: decision.evidence_refs, reason: decision.reason, basis: decision.basis});
    const pending = this.store.findPendingIntentByCanonical(this.runId, canonical);
    let key: string;
    if (pending) {
      key = pending.key; // uncertain-failure recovery: same key, never a redo
    } else {
      const row = this.store.getRun(this.runId)!;
      key = `${this.runId}-d${row.decision_counter + 1}`;
      this.store.updateRun(this.runId, {decision_counter: row.decision_counter + 1});
      this.store.insertIntent(this.runId, key, decision.capability, canonical); // BEFORE the HTTP call
    }
    try {
      const result = await this.client.submit(this.experimentId,
        {capability: decision.capability, arguments: decision.arguments, evidence_refs: decision.evidence_refs,
          reason: decision.reason, basis: decision.basis},
        {idempotencyKey: key, leaseId: this.lastHandledLeaseId});
      this.store.setIntentAction(this.runId, key, result.action.action_id);
      this.actionCache.set(result.action.action_id, result.action);
      this.emit('action.submitted', {key, action_id: result.action.action_id, capability: decision.capability,
        status: result.action.status, http_status: result.status});
      if (isTerminal(result.action.status)) {
        this.store.markSeen(this.runId, `act:${result.action.action_id}`, result.action.status);
        this.emit('action.result', {action_id: result.action.action_id, capability: result.action.capability,
          status: result.action.status, summary: result.action.summary, error: result.action.error,
          partial: result.action.partial, ended_at_sim_s: result.action.ended_at_sim_s});
      }
      return {errors: [], stop: false};
    } catch (e) {
      const resolved = await this.resolveUncertain(key, e);
      if (resolved) return {errors: [], stop: false};
      if (e instanceof DeviceError) {
        if (e.code === 'unauthenticated') {
          await this.finalizeLocalEnded('aborted', 'run token rejected while submitting (run ended or revoked)');
          return {errors: [], stop: true};
        }
        if (e.code === 'run_on_hold') {
          this.setLocalPaused('run_on_hold', true);
          this.emit('paused', {reason: 'run_on_hold', detail: 'operator set a hold; waiting for release'});
          return {errors: [], stop: true};
        }
        if (e.code === 'lease_not_active' || e.code === 'lease_forbidden') {
          const lease = await this.currentOwnLease();
          if (lease) {
            this.lastHandledLeaseId = lease.lease_id;
            this.emit('lease.granted', {lease_id: lease.lease_id, by: 'replan'});
            return {errors: [], stop: false};
          }
          await this.syncPauseFromRuntime();
          return {errors: [], stop: true};
        }
        if (e.code === 'experiment_archived') {
          await this.finalizeLocalEnded('aborted', `${e.code}: ${e.message}`);
          return {errors: [], stop: true};
        }
        this.emit('error', {where: 'submit', code: e.code, message: e.message, key, capability: decision.capability});
        return {errors: [{decision_index: this.store.getRun(this.runId)!.decision_counter,
          capability: decision.capability, code: e.code, message: e.message}], stop: false};
      }
      this.emit('error', {where: 'submit', code: 'network', message: e instanceof Error ? e.message : String(e), key});
      await sleep(300); // runtime unreachable: back off, then re-decide (same canonical → same key)
      return {errors: [], stop: false};
    }
  }

  /** After an uncertain failure, check whether the key already produced an action. */
  private async resolveUncertain(key: string, e: unknown): Promise<boolean> {
    const uncertain = !(e instanceof DeviceError) || UNCERTAIN_CODES.has(e.code);
    if (!uncertain) return false;
    try {
      const found = await this.client.actionByKey(this.experimentId, key);
      if (found) {
        this.store.setIntentAction(this.runId, key, found.action_id);
        this.emit('action.submitted', {key, action_id: found.action_id, capability: found.capability,
          status: found.status, recovered: 'by_key'});
        if (isTerminal(found.status)) {
          this.store.markSeen(this.runId, `act:${found.action_id}`, found.status);
          this.emit('action.result', {action_id: found.action_id, capability: found.capability, status: found.status,
            summary: found.summary, error: found.error, partial: found.partial, ended_at_sim_s: found.ended_at_sim_s});
        }
        return true;
      }
    } catch { /* lookup itself failed */ }
    return false;
  }

  // -- lease helpers --------------------------------------------------------------

  private startRenew(leaseId: number, ttlMs: number): void {
    this.stopRenew();
    const every = Math.max(500, Math.floor(ttlMs / 3));
    this.renewTimer = setInterval(() => {
      void (async () => {
        try {
          await this.client.renewLease(this.experimentId, leaseId);
        } catch (e) {
          this.stopRenew();
          if (e instanceof DeviceError && (e.code === 'lease_not_active' || e.code === 'lease_forbidden')) {
            this.push({kind: 'control'}); // re-sync with the Runtime state
          }
        }
      })();
    }, every);
    this.renewTimer.unref?.();
  }

  private stopRenew(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  private async currentOwnLease(): Promise<Lease | null> {
    try {
      const lease = await this.client.currentLease(this.experimentId);
      return lease && lease.state === 'active' && lease.run_id === this.runId ? lease : null;
    } catch {
      return null;
    }
  }

  // -- device SSE watcher -----------------------------------------------------------

  private watchEvents(): void {
    if (this.watcherAbort) return;
    const ac = new AbortController();
    this.watcherAbort = ac;
    let afterSeq = 0;
    void (async () => {
      try {
        const state = await this.client.state(this.experimentId);
        afterSeq = state.event_seq;
      } catch { /* replay from 0 is harmless (old grants are deduped) */ }
      let attempt = 0;
      while (!ac.signal.aborted && !this.localEnded) {
        try {
          for await (const ev of this.client.stream(this.experimentId, afterSeq, ac.signal)) {
            afterSeq = ev.seq;
            attempt = 0;
            if (ev.run_id !== this.runId) continue;
            if (ev.type === 'decision.granted') {
              const leaseId = Number((ev.payload as {lease_id?: number}).lease_id ?? 0);
              if (leaseId > 0) this.push({kind: 'grant', leaseId});
            } else if (ev.type === 'run.ended') {
              this.push({kind: 'runEnded', reason: String((ev.payload as {reason?: string}).reason ?? 'ended')});
            } else if (ev.type === 'run.paused'
              && ['runtime_restarted', 'lease_timeout', 'operator_pause'].includes(String((ev.payload as {reason?: string}).reason ?? ''))) {
              this.push({kind: 'control'});
            }
          }
        } catch { /* connection dropped */ }
        if (ac.signal.aborted || this.localEnded) break;
        attempt += 1;
        await sleep(Math.min(5000, 200 * 2 ** Math.min(attempt, 5)), ac.signal);
        // recover anything granted/ended while disconnected
        try {
          const lease = await this.currentOwnLease();
          if (lease && lease.lease_id > this.lastHandledLeaseId) this.push({kind: 'grant', leaseId: lease.lease_id});
          const run = await this.client.request<{status: string; reason: string | null}>('GET', `/api/v1/runs/${this.runId}`);
          if (run.body.status === 'ended') this.push({kind: 'runEnded', reason: run.body.reason ?? 'ended'});
        } catch (e) {
          if (e instanceof DeviceError && e.code === 'unauthenticated') {
            this.push({kind: 'runEnded', reason: 'run token revoked'});
            break;
          }
          /* runtime down; loop again */
        }
      }
    })();
  }

  // -- pause / finish ------------------------------------------------------------------

  private setLocalPaused(reason: string, persist: boolean): void {
    this.localStatus = 'paused';
    this.pauseReason = reason;
    if (persist) this.store.updateRun(this.runId, {status: 'paused', pause_reason: reason});
  }

  /** Self-pause reported to the Runtime (revokes the lease). */
  private async pauseRemote(reason: string): Promise<void> {
    this.setLocalPaused(reason, true);
    this.emit('paused', {reason});
    this.stopRenew();
    try {
      await this.client.request('POST', `/api/v1/runs/${this.runId}/agent-status`, {status: 'paused', reason});
    } catch (e) {
      this.emit('error', {where: 'agent-status', code: e instanceof DeviceError ? e.code : 'network',
        message: e instanceof Error ? e.message : String(e)});
    }
  }

  /** Mirror the Runtime run status into the local state (pause/ended). */
  private async syncPauseFromRuntime(): Promise<void> {
    try {
      const r = await this.client.request<{status: string; reason: string | null}>('GET', `/api/v1/runs/${this.runId}`);
      if (r.body.status === 'ended') {
        await this.finalizeLocalEnded('aborted', `run ended by Runtime (reason: ${r.body.reason ?? 'unknown'})`);
        return;
      }
      if (r.body.status === 'paused') {
        this.setLocalPaused(r.body.reason ?? 'runtime_paused', true);
        this.emit('paused', {reason: r.body.reason ?? 'runtime_paused', by: 'runtime'});
      }
    } catch { /* leave state as-is */ }
  }

  private classifyReadError(e: unknown): string | null {
    if (e instanceof DeviceError) {
      if (e.code === 'unauthenticated') return 'run token rejected (run ended or revoked)';
      if (e.code === 'experiment_archived') return 'experiment archived (reset)';
      return null;
    }
    return null;
  }

  /** Normal finish: write the report, POST agent-status ended to end the run. */
  private async finalize(outcome: 'completed' | 'failed' | 'aborted', summary: string): Promise<void> {
    this.stopRenew();
    this.watcherAbort?.abort();
    let report: object;
    try {
      report = await buildReport({store: this.store, client: this.client, runId: this.runId,
        experimentId: this.experimentId, scenarioId: this.store.getRun(this.runId)!.scenario_id,
        mode: this.store.getRun(this.runId)!.mode, outcome, summary, task: this.task});
    } catch (e) {
      report = {run_id: this.runId, outcome, summary, error: `report build failed: ${e instanceof Error ? e.message : String(e)}`};
    }
    this.store.updateRun(this.runId, {status: 'ended', pause_reason: null, report});
    this.stopped = true;
    this.emit('report', {outcome, summary, report_present: true});
    try {
      await this.client.request('POST', `/api/v1/runs/${this.runId}/agent-status`,
        {status: 'ended', reason: outcome, report});
    } catch (e) {
      if (e instanceof DeviceError && e.code === 'unauthenticated') {
        // run already ended/revoked (e.g. operator cancel raced) — nothing to report
      } else {
        this.emit('error', {where: 'agent-status', code: e instanceof DeviceError ? e.code : 'network',
          message: `could not deliver the final report: ${e instanceof Error ? e.message : String(e)}`});
      }
    }
    this.push({kind: 'stop'});
  }

  /** The Runtime ended the run itself (token revoked): local report only. */
  private async finalizeLocalEnded(outcome: 'completed' | 'failed' | 'aborted', summary: string): Promise<void> {
    this.stopRenew();
    this.watcherAbort?.abort();
    const row = this.store.getRun(this.runId)!;
    let report: object;
    try {
      report = await buildReport({store: this.store, client: this.client, runId: this.runId,
        experimentId: this.experimentId, scenarioId: row.scenario_id, mode: row.mode, outcome, summary, task: this.task});
    } catch {
      report = {run_id: this.runId, outcome, summary};
    }
    this.store.updateRun(this.runId, {status: 'ended', pause_reason: null, report});
    this.stopped = true;
    this.emit('report', {outcome, summary, report_present: true, delivered: false});
    this.push({kind: 'stop'});
  }

  /** Artificial wall-time decision delay for the determinism check. Never part of the decision. */
  private async maybeDelay(): Promise<void> {
    const range = this.deps.config.decisionDelayMs;
    if (!range) return;
    const ms = range.min + Math.floor(Math.random() * (range.max - range.min + 1));
    if (ms > 0) await sleep(ms);
  }
}
