// OSCAR Runtime core: the single writer over the SQLite store. Owns the
// world (simulator state), the action stage machine, the lockstep/realtime
// clock, decision leases, runs, reset and recovery. HTTP concerns live in
// http.ts; this file must stay free of node:http.
import {createHash, randomBytes} from 'node:crypto';
import {
  CHAMBER_ID, DEMO_PROFILE, DEVICE_ID, DeviceError, ERROR_STATUS, IMAGING_SCAN_STAGES, MEDIA_ADD_STAGES,
  MEDIA_EXCHANGE_STAGES, TERMINAL_STATUSES, alignToStep, buildManifest, canonicalJson, getCapability,
  isTerminal, normalizeRowScope, PLATE_LAYOUTS, rowWellIds, validateArguments,
  type Action, type ActionStage, type ActionStatus, type ApiErrorInfo, type ChamberReading, type ClockMode,
  type DecisionBasis, type DeviceEvent, type EnvChannel, type ExperimentInfo, type ImageRef, type Lease,
  type Observation, type PlateState, type Principal, type RunRecord, type Stage, type StageTarget,
  type StateSnapshot, type StepEffect, type SubmitActionRequest, type WakeCondition, type WellEstimate,
} from '@oscar/device-contract';
import {
  createWorld, environmentStableFor, findPlate, headDiscard as liquidHeadDiscard, loadScenario,
  performScan, reservoirAspirate as liquidReservoirAspirate, rowAspirate as liquidRowAspirate,
  rowDispense as liquidRowDispense, setChamberTargets, stepWorld, tipsDrop as liquidTipsDrop,
  tipsPick as liquidTipsPick, wasteDispense as liquidWasteDispense, SIMULATOR_VERSION,
  type EnvValues, type ScanMode, type ScanView, type World,
} from '@oscar/simulator';
import type {RuntimeConfig} from './config.ts';
import {Store} from './store.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface ExpRow {
  id: string; scenario_id: string; scenario_version: string; simulator_version: string; seed: number;
  status: 'active' | 'archiving' | 'archived'; sim_time_s: number; clock_mode: ClockMode; paused: 0 | 1;
  speed: number; reset_from: string | null; successor_id: string | null; determinism_broken: 0 | 1;
  created_at_wall: string; is_current: 0 | 1; event_seq: number; act_counter: number; obs_counter: number;
  asset_counter: number; run_counter: number;
}

export interface ActionRow {id: string; experiment_id: string; status: ActionStatus; principal: string;
  idempotency_key: string | null; canonical_request: string | null; accept_seq: number;
  action: Action; plan: Plan | null; response: unknown}

/** Executor-side stage/commit plan (never sent to clients). */
export interface PlanStage {
  stage: Stage; primitive: string; tool?: 'pipette' | 'camera'; target: StageTarget; from_target: StageTarget;
  duration: number; commit?: string;
}
export interface Plan {
  stages: PlanStage[];
  plateId?: string; rowId?: string; wells?: string[]; reservoirId?: string; wasteId?: string;
  volumePerWell?: number; fraction?: number;
  scan?: {mode: ScanMode; view: ScanView};
  shake?: {speed_rpm: number; duration: number};
  await?: {timeout_sim_s: number; target_revision: number; stable_since: number | null};
  // Filled during execution: per-channel volumes removed by row_aspirate (exchange).
  removedVols?: number[];
}

export interface RunRow {id: string; experiment_id: string; status: RunRecord['status']; run: RunRecord;
  idempotency_key?: string | null}

export interface LeaseRow {lease_id: number; experiment_id: string; run_id: string;
  state: Lease['state']; frozen_at_sim_s: number; event_seq: number; triggers: Lease['triggers'];
  wake: WakeCondition | null; granted_at_wall: string; expires_at_wall: string;
  release_request: string | null; release_response: {lease: Lease; next_lease: Lease | null} | null}

const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class Runtime {
  readonly store: Store;
  readonly config: RuntimeConfig;
  readonly operatorToken: string;
  readonly serviceToken: string;
  /** experimentId -> listeners called with the last committed event seq. */
  private readonly listeners = new Map<string, Set<(lastSeq: number) => void>>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(config: RuntimeConfig, store: Store, operatorToken: string, serviceToken: string) {
    this.config = config;
    this.store = store;
    this.operatorToken = operatorToken;
    this.serviceToken = serviceToken;
  }

  // -- events ---------------------------------------------------------------

  onEvents(experimentId: string, fn: (lastSeq: number) => void): () => void {
    let set = this.listeners.get(experimentId);
    if (!set) this.listeners.set(experimentId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private notify(experimentId: string, lastSeq: number): void {
    const set = this.listeners.get(experimentId);
    if (set) for (const fn of set) fn(lastSeq);
  }

  private emit(exp: ExpRow, type: string, payload: Record<string, unknown>, opts: {sim_time_s?: number; action_id?: string | null;
    run_id?: string | null; observation_id?: string | null} = {}): void {
    const seq = exp.event_seq + 1;
    exp.event_seq = seq;
    this.store.stmt('INSERT INTO events (experiment_id, seq, sim_time_s, type, action_id, run_id, observation_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(exp.id, seq, opts.sim_time_s ?? exp.sim_time_s, type, opts.action_id ?? null, opts.run_id ?? null,
        opts.observation_id ?? null, JSON.stringify(payload));
  }

  // -- experiments / world --------------------------------------------------

  loadExp(id: string): ExpRow | undefined {
    const row = this.store.stmt('SELECT * FROM experiments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toExpRow(row) : undefined;
  }

  currentExperiment(): ExpRow | undefined {
    const row = this.store.stmt('SELECT * FROM experiments WHERE is_current = 1 ORDER BY created_at_wall DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return row ? this.toExpRow(row) : undefined;
  }

  listExperiments(): {current_id: string | null; experiments: ExperimentInfo[]} {
    const rows = this.store.stmt('SELECT * FROM experiments ORDER BY created_at_wall ASC').all() as Record<string, unknown>[];
    const exps = rows.map(r => this.toExpRow(r));
    const active = exps.find(e => e.status === 'active');
    const current = active ?? exps[exps.length - 1];
    return {current_id: current?.id ?? null, experiments: exps.map(e => this.toExperimentInfo(e))};
  }

  private toExpRow(r: Record<string, unknown>): ExpRow {
    return {
      id: String(r.id), scenario_id: String(r.scenario_id), scenario_version: String(r.scenario_version),
      simulator_version: String(r.simulator_version), seed: Number(r.seed),
      status: r.status as ExpRow['status'], sim_time_s: Number(r.sim_time_s), clock_mode: r.clock_mode as ClockMode,
      paused: Number(r.paused) === 1 ? 1 : 0, speed: Number(r.speed), reset_from: r.reset_from ? String(r.reset_from) : null,
      successor_id: r.successor_id ? String(r.successor_id) : null, determinism_broken: Number(r.determinism_broken) === 1 ? 1 : 0,
      created_at_wall: String(r.created_at_wall), is_current: Number(r.is_current) === 1 ? 1 : 0,
      event_seq: Number(r.event_seq), act_counter: Number(r.act_counter), obs_counter: Number(r.obs_counter),
      asset_counter: Number(r.asset_counter), run_counter: Number(r.run_counter),
    };
  }

  private saveExp(e: ExpRow): void {
    this.store.stmt(`UPDATE experiments SET status=?, sim_time_s=?, clock_mode=?, paused=?, speed=?, successor_id=?,
      determinism_broken=?, is_current=?, event_seq=?, act_counter=?, obs_counter=?, asset_counter=?, run_counter=? WHERE id=?`)
      .run(e.status, e.sim_time_s, e.clock_mode, e.paused, e.speed, e.successor_id, e.determinism_broken, e.is_current,
        e.event_seq, e.act_counter, e.obs_counter, e.asset_counter, e.run_counter, e.id);
  }

  toExperimentInfo(e: ExpRow): ExperimentInfo {
    return {
      experiment_id: e.id, scenario_id: e.scenario_id, scenario_version: e.scenario_version,
      simulator_version: e.simulator_version, seed: e.seed, status: e.status, sim_time_s: e.sim_time_s,
      clock_mode: e.clock_mode, paused: e.paused === 1, speed: e.speed, reset_from: e.reset_from,
      successor_id: e.successor_id, determinism_broken: e.determinism_broken === 1, created_at_wall: e.created_at_wall,
    };
  }

  loadWorld(experimentId: string): World {
    const row = this.store.stmt('SELECT world_json FROM worlds WHERE experiment_id = ?').get(experimentId) as {world_json: string} | undefined;
    if (!row) throw new DeviceError('not_found', `No world for ${experimentId}`);
    return JSON.parse(row.world_json) as World;
  }

  private saveWorld(experimentId: string, world: World): void {
    this.store.stmt(`INSERT INTO worlds (experiment_id, version, world_json) VALUES (?, 1, ?)
      ON CONFLICT(experiment_id) DO UPDATE SET version = version + 1, world_json = excluded.world_json`)
      .run(experimentId, JSON.stringify(world));
  }

  createExperiment(opts: {scenario_id?: string; seed?: number; clock_mode?: ClockMode}): ExpRow {
    const scenarioId = opts.scenario_id ?? this.config.scenario;
    const scenario = loadScenario(scenarioId);
    const seed = opts.seed ?? scenario.seed ?? this.config.seed;
    const clockMode: ClockMode = opts.clock_mode ?? this.config.clockMode;
    const created = this.store.tx(() => {
      const existing = this.currentExperiment();
      if (existing && existing.status === 'active') throw new DeviceError('experiment_active',
        `Experiment ${existing.id} is active; use reset to move to a new world`);
      const id = `exp-${String(this.store.nextId('exp_counter')).padStart(3, '0')}`;
      const exp: ExpRow = {
        id, scenario_id: scenario.id, scenario_version: scenario.version, simulator_version: SIMULATOR_VERSION,
        seed, status: 'active', sim_time_s: 0, clock_mode: clockMode, paused: 0, speed: 1, reset_from: null,
        successor_id: null, determinism_broken: 0, created_at_wall: nowIso(), is_current: 1, event_seq: 0,
        act_counter: 0, obs_counter: 0, asset_counter: 0, run_counter: 0,
      };
      this.store.stmt(`INSERT INTO experiments (id, scenario_id, scenario_version, simulator_version, seed, status,
        sim_time_s, clock_mode, paused, speed, reset_from, successor_id, determinism_broken, created_at_wall, is_current,
        event_seq, act_counter, obs_counter, asset_counter, run_counter)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, exp.scenario_id, exp.scenario_version, exp.simulator_version, exp.seed, exp.status, exp.sim_time_s,
          exp.clock_mode, 0, 1, null, null, 0, exp.created_at_wall, 1, 0, 0, 0, 0, 0);
      this.saveWorld(id, createWorld(scenario, seed));
      this.emit(exp, 'experiment.created', {experiment_id: id, scenario_id: scenario.id, scenario_version: scenario.version,
        seed, clock_mode: clockMode, simulator_version: SIMULATOR_VERSION}, {sim_time_s: 0});
      this.saveExp(exp);
      this.aborts.set(id, new AbortController());
      return {id, exp};
    });
    this.notify(created.id, this.loadExp(created.id)?.event_seq ?? 0);
    return created.exp;
  }

  // -- actions: lookup ------------------------------------------------------

  private loadActionRow(id: string): ActionRow | undefined {
    const row = this.store.stmt('SELECT * FROM actions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toActionRow(row) : undefined;
  }

  private toActionRow(r: Record<string, unknown>): ActionRow {
    return {
      id: String(r.id), experiment_id: String(r.experiment_id), status: r.status as ActionStatus,
      principal: String(r.principal), idempotency_key: r.idempotency_key ? String(r.idempotency_key) : null,
      canonical_request: r.canonical_request ? String(r.canonical_request) : null, accept_seq: Number(r.accept_seq),
      action: JSON.parse(String(r.action_json)) as Action,
      plan: r.plan_json ? JSON.parse(String(r.plan_json)) as Plan : null,
      response: r.response_json ? JSON.parse(String(r.response_json)) : null,
    };
  }

  private saveAction(row: ActionRow, response?: unknown): void {
    // The status COLUMN is the source of truth for nonTerminalActions();
    // always derive it from the authoritative action object.
    row.status = row.action.status;
    this.store.stmt('UPDATE actions SET status=?, action_json=?, plan_json=?, response_json=? WHERE id=?')
      .run(row.status, JSON.stringify(row.action), row.plan ? JSON.stringify(row.plan) : null,
        JSON.stringify(response ?? row.response ?? row.action), row.id);
  }

  listActions(experimentId: string): Action[] {
    const rows = this.store.stmt('SELECT action_json FROM actions WHERE experiment_id = ? ORDER BY accept_seq ASC')
      .all(experimentId) as {action_json: string}[];
    return rows.map(r => JSON.parse(r.action_json) as Action);
  }

  nonTerminalActions(experimentId: string): ActionRow[] {
    const rows = this.store.stmt(`SELECT * FROM actions WHERE experiment_id = ? AND status IN ('queued','running','cancelling')
      ORDER BY accept_seq ASC`).all(experimentId) as Record<string, unknown>[];
    return rows.map(r => this.toActionRow(r));
  }

  busyResources(experimentId: string): Record<string, string> {
    const busy: Record<string, string> = {};
    for (const row of this.nonTerminalActions(experimentId)) {
      for (const r of row.action.resources) if (!busy[r]) busy[r] = row.id;
    }
    return busy;
  }

  // -- actions: acceptance --------------------------------------------------

  /**
   * Contract §2 acceptance order: idempotency → lease → schema →
   * expected_revisions → evidence freshness → resource occupancy. (Host,
   * Origin, auth/scope and experiment-active are handled by the caller.)
   */
  acceptAction(experimentId: string, principal: Principal, req: SubmitActionRequest, opts:
      {idempotencyKey?: string | null; leaseId?: number | null}): {status: number; action: Action} {
    const result = this.store.tx(() => {
      const exp = this.loadExp(experimentId);
      if (!exp) throw new DeviceError('not_found', `No experiment ${experimentId}`);
      if (exp.status !== 'active') throw new DeviceError('experiment_archived', `Experiment ${experimentId} is ${exp.status}`);

      // 1. idempotency (scope experiment + principal), before lease/revision checks.
      const canonical = canonicalJson({device_id: req.device_id ?? DEVICE_ID, capability: req.capability,
        arguments: req.arguments, expected_revisions: req.expected_revisions ?? null});
      if (opts.idempotencyKey) {
        const hit = this.store.stmt('SELECT * FROM actions WHERE experiment_id=? AND principal=? AND idempotency_key=?')
          .get(experimentId, principalString(principal), opts.idempotencyKey) as Record<string, unknown> | undefined;
        if (hit) {
          const row = this.toActionRow(hit);
          if (row.canonical_request === canonical) {
            return {status: 200, action: row.response as Action};
          }
          throw new DeviceError('idempotency_conflict',
            `Idempotency key ${opts.idempotencyKey} was already used with a different request`, {key: opts.idempotencyKey});
        }
      }

      if (exp.paused === 1) throw new DeviceError('simulation_paused', 'Simulation is paused; reads, cancel and control remain available');

      // run scope: capabilities / plates / budget
      if (principal.kind === 'run') {
        const runRow = this.runById(principal.run_id!);
        if (!runRow || runRow.experiment_id !== experimentId) throw new DeviceError('forbidden', 'Run token is scoped to another experiment');
        if (runRow.status === 'ended') throw new DeviceError('forbidden', 'Run has ended');
        if (runRow.status === 'on_hold') {
          throw new DeviceError('run_on_hold', `Run ${runRow.id} is on hold; the operator must release the hold`,
            {run_id: runRow.id});
        }
        if (!runRow.run.capabilities.includes(req.capability)) {
          throw new DeviceError('forbidden', `Capability ${req.capability} is outside this run's scope`,
            {allowed: runRow.run.capabilities});
        }
        if (runRow.run.budget.actions_used >= runRow.run.budget.max_actions) {
          throw new DeviceError('budget_exhausted', `Action budget of ${runRow.run.budget.max_actions} is exhausted`);
        }
      }

      // 2. lease (lockstep run writes need an active lease owned by the run)
      this.checkLeaseForWrite(exp, principal, req.capability, opts.leaseId ?? null);

      // operator device-write while a run is active (not on hold) → hold first
      if (principal.kind === 'operator' && isDeviceWrite(req.capability)) {
        const run = this.nonEndedRun(experimentId);
        if (run && run.status !== 'on_hold') throw new DeviceError('hold_required',
          `Run ${run.id} is ${run.status}; set hold before manual device writes (§6.6)`, {run_id: run.id});
      }

      // 3. schema
      const args = validateArguments(req.capability, req.arguments);
      const cap = getCapability(req.capability);
      if (!cap) throw new DeviceError('invalid_argument', `Unknown capability ${req.capability}`);

      const world = this.loadWorld(experimentId);
      let plan: Plan;
      let resources: string[];
      let scope: Action['scope'];
      switch (req.capability) {
        case 'media.add':
          ({plan, resources, scope} = this.planMediaAdd(exp, world, args));
          break;
        case 'media.exchange':
          ({plan, resources, scope} = this.planMediaExchange(exp, world, args));
          break;
        case 'imaging.scan':
          ({plan, resources, scope} = this.planScan(exp, world, args));
          break;
        case 'plate.shake':
          ({plan, resources, scope} = this.planShake(exp, world, args));
          break;
        case 'environment.set_targets':
          ({plan, resources, scope} = this.planSetTargets(exp, world, args));
          break;
        case 'environment.await_stable':
          ({plan, resources, scope} = this.planAwaitStable(exp, world, args));
          break;
        default:
          throw new DeviceError('invalid_argument', `Capability ${req.capability} is not submittable via /actions`);
      }

      // run plate scope
      if (principal.kind === 'run' && plan.plateId) {
        const runRow = this.runById(principal.run_id!)!;
        if (!runRow.run.plates.includes(plan.plateId)) {
          throw new DeviceError('forbidden', `Plate ${plan.plateId} is outside this run's scope`, {allowed: runRow.run.plates});
        }
      }

      // 4. expected_revisions
      if (req.expected_revisions) {
        for (const [key, wanted] of Object.entries(req.expected_revisions)) {
          const actual = this.revisionOf(world, key);
          if (actual !== wanted) throw new DeviceError('revision_conflict',
            `Resource ${key} is at revision ${actual}, expected ${wanted}`, {resource: key, actual, expected: wanted});
        }
      }

      // 5. evidence freshness
      const liquid = req.capability === 'media.add' || req.capability === 'media.exchange';
      if (liquid && principal.kind === 'run' && (!req.evidence_refs || req.evidence_refs.length === 0)) {
        throw new DeviceError('observation_stale', 'Run-submitted liquid actions must cite fresh scan evidence (evidence_refs)');
      }
      if (liquid && req.evidence_refs && req.evidence_refs.length > 0) {
        this.checkEvidence(world, experimentId, plan.plateId!, plan.wells ?? [], req.evidence_refs);
      }

      // 6. resource occupancy
      const busy = this.busyResources(experimentId);
      for (const r of resources) {
        if (busy[r]) throw new DeviceError('resource_busy', `Resource ${r} is busy with action ${busy[r]}`,
          {resource: r, held_by: busy[r]});
      }

      // accept
      // ids are globally unique across experiments (global primary keys)
      const id = `act-${exp.id.replace(/^exp-/, '')}-${String(++exp.act_counter).padStart(2, '0')}`;
      const action: Action = {
        action_id: id, experiment_id: experimentId, device_id: DEVICE_ID, capability: req.capability, arguments: args,
        scope, status: 'queued', principal, run_id: principal.kind === 'run' ? principal.run_id! : null,
        basis: req.basis ?? (principal.kind === 'operator' ? 'operator' : 'scripted'),
        reason: req.reason ?? null, evidence_refs: req.evidence_refs ?? [], idempotency_key: opts.idempotencyKey ?? null,
        resources, accept_seq: exp.act_counter, submitted_at_sim_s: world.sim_time_s, started_at_sim_s: null,
        ended_at_sim_s: null, stages: plan.stages.map((s, i) => ({index: i, stage: s.stage, primitive: s.primitive,
          tool: s.tool, target: s.target, from_target: s.from_target, duration_sim_s: s.duration,
          started_at_sim_s: null, committed: false})),
        current_stage_index: null, effects: [], summary: {wells: {}, reservoir_delta_ul: 0, waste_delta_ul: 0, tips_used: 0},
        partial: false, cancel_reason: null, error: null, result: null,
      };
      this.store.stmt(`INSERT INTO actions (id, experiment_id, status, principal, idempotency_key, canonical_request,
        accept_seq, action_json, plan_json, response_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, experimentId, action.status, principalString(principal), opts.idempotencyKey ?? null, canonical,
          action.accept_seq, JSON.stringify(action), JSON.stringify(plan), JSON.stringify(action));
      this.emit(exp, 'action.accepted', {action_id: id, capability: req.capability, principal: principalString(principal),
        scope, resources, idempotency_key: opts.idempotencyKey ?? null}, {action_id: id});

      // immediate terminal: environment.set_targets
      if (req.capability === 'environment.set_targets') {
        this.commitSetTargets(exp, world, action, plan, args);
      }

      if (principal.kind === 'run') {
        const runRow = this.runById(principal.run_id!)!;
        runRow.run.budget.actions_used += 1;
        this.saveRun(runRow);
      }
      this.saveWorld(experimentId, world);
      this.saveExp(exp);
      const row: ActionRow = {id, experiment_id: experimentId, status: action.status, principal: principalString(principal),
        idempotency_key: opts.idempotencyKey ?? null, canonical_request: canonical, accept_seq: action.accept_seq,
        action, plan, response: action};
      this.saveAction(row, action);
      return {status: 202, action};
    });
    this.notify(experimentId, this.loadExp(experimentId)?.event_seq ?? 0);
    return result;
  }

  private revisionOf(world: World, key: string): number | undefined {
    if (key === `chamber:${CHAMBER_ID}`) return world.chamber.target_revision;
    if (key.startsWith('plate:')) return findPlate(world, key.slice(6))?.revision;
    return undefined;
  }

  private checkEvidence(world: World, experimentId: string, plateId: string, wells: string[], refs: string[]): void {
    for (const ref of refs) {
      const obsRow = this.store.stmt('SELECT experiment_id, obs_json FROM observations WHERE id = ?')
        .get(ref) as {experiment_id: string; obs_json: string} | undefined;
      if (!obsRow || obsRow.experiment_id !== experimentId) {
        throw new DeviceError('observation_stale', `Observation ${ref} does not belong to experiment ${experimentId}`, {observation_id: ref});
      }
      const obs = JSON.parse(obsRow.obs_json) as Observation;
      if (obs.plate_id !== plateId) {
        throw new DeviceError('observation_stale', `Observation ${ref} covers plate ${obs.plate_id}, not ${plateId}`, {observation_id: ref});
      }
      const missing = wells.filter(w => !obs.wells.includes(w));
      if (missing.length) {
        throw new DeviceError('observation_stale', `Observation ${ref} does not cover wells ${missing.join(',')}`, {observation_id: ref, missing});
      }
      const plate = findPlate(world, plateId);
      if (!plate || obs.plate_revision !== plate.revision) {
        throw new DeviceError('observation_stale',
          `Observation ${ref} was taken at plate revision ${obs.plate_revision}, current is ${plate?.revision ?? '?'}`, {observation_id: ref});
      }
      const age = world.sim_time_s - obs.sampled_at_sim_s;
      if (age > DEMO_PROFILE.observation.max_age_s) {
        throw new DeviceError('observation_stale', `Observation ${ref} is ${age} s old (max ${DEMO_PROFILE.observation.max_age_s})`, {observation_id: ref});
      }
    }
  }

  private checkLeaseForWrite(exp: ExpRow, principal: Principal, capability: string, leaseId: number | null): void {
    if (capability === 'action.cancel') return; // reads/cancel always available
    if (exp.clock_mode !== 'lockstep' || principal.kind !== 'run') return;
    if (leaseId == null) throw new DeviceError('lease_required', 'lockstep run writes require the Lease-Id header');
    const lease = this.leaseById(leaseId);
    if (!lease) throw new DeviceError('lease_not_active', `Lease ${leaseId} does not exist`);
    if (lease.run_id !== principal.run_id) throw new DeviceError('lease_forbidden', `Lease ${leaseId} belongs to another run`, {lease_id: leaseId});
    if (lease.state !== 'active') throw new DeviceError('lease_not_active', `Lease ${leaseId} is ${lease.state}`);
    if (lease.experiment_id !== exp.id) throw new DeviceError('lease_forbidden', `Lease ${leaseId} belongs to another experiment`, {lease_id: leaseId});
    if (Date.parse(lease.expires_at_wall) <= Date.now()) {
      this.expireLease(exp, lease, 'ttl');
      throw new DeviceError('lease_not_active', `Lease ${leaseId} expired`);
    }
  }

  // -- action planning / validation -----------------------------------------

  private requirePlate(world: World, plateId: string): NonNullable<ReturnType<typeof findPlate>> {
    const plate = findPlate(world, plateId);
    if (!plate) throw new DeviceError('invalid_argument', `Unknown plate ${plateId}`, {plate_id: plateId});
    return plate;
  }

  private stageTargets(world: World, args: {plateId?: string; rowId?: string; wells?: string[]; reservoirId?: string;
    wasteId?: string}, at: string): StageTarget {
    switch (at) {
      case 'home': return null;
      case 'tips': return {resource_id: world.tip_racks[0]?.id ?? 'tips-01'};
      case 'reservoir': return {resource_id: args.reservoirId!};
      case 'waste': return {resource_id: args.wasteId ?? world.wastes[0]?.id ?? 'waste-01'};
      case 'row': return {plate_id: args.plateId!, row_id: args.rowId!};
      case 'well': return {plate_id: args.plateId!, well_id: args.wells![0]};
      case 'plate': return {plate_id: args.plateId!, well_id: args.wells?.[0] ?? 'A1'};
      default: return {resource_id: at};
    }
  }

  private buildStages(world: World, plans: readonly {stage: string; primitive: string; at: string; commit?: string}[],
      args: {plateId?: string; rowId?: string; wells?: string[]; reservoirId?: string; wasteId?: string},
      durationOf: (stage: string) => number, toolOf?: (commit?: string) => 'pipette' | 'camera' | undefined): PlanStage[] {
    const stages: PlanStage[] = [];
    let prev: StageTarget = null;
    for (const p of plans) {
      const target = this.stageTargets(world, args, p.at);
      stages.push({stage: p.stage as Stage, primitive: p.primitive, target, from_target: prev,
        duration: durationOf(p.stage), commit: p.commit, ...(toolOf ? {tool: toolOf(p.commit)} : {})});
      prev = target;
    }
    return stages;
  }

  private planMediaAdd(exp: ExpRow, world: World, args: Record<string, unknown>):
      {plan: Plan; resources: string[]; scope: Action['scope']} {
    const plateId = String(args.plate_id);
    const rowId = String(args.row_id);
    const reservoirId = String(args.reservoir_id);
    const volume = Number(args.volume_ul_per_well);
    const plate = this.requirePlate(world, plateId);
    const scope = normalizeRowScope(PLATE_LAYOUTS[plate.format], {plate_id: plateId, row_id: rowId,
      wells: args.wells as string[] | undefined}, DEMO_PROFILE.head.channels);
    if (plate.shake.active) throw new DeviceError('resource_busy', `Plate ${plateId} is shaking`);
    const reservoir = world.reservoirs.find(r => r.id === reservoirId);
    if (!reservoir) throw new DeviceError('invalid_argument', `Unknown reservoir ${reservoirId}`, {reservoir_id: reservoirId});
    const wells = rowWellIds(PLATE_LAYOUTS[plate.format], rowId);
    const over = wells.filter(w => (plate.wells.find(x => x.well_id === w)?.volume_ul ?? 0) + volume > plate.wells[0].capacity_ul);
    if (over.length) throw new DeviceError('capacity_exceeded', `Adding ${volume} µL would exceed capacity in wells ${over.join(',')}`, {wells: over});
    if (volume > DEMO_PROFILE.head.channel_max_ul) throw new DeviceError('channel_volume_exceeded',
      `Per-well volume ${volume} µL exceeds channel max ${DEMO_PROFILE.head.channel_max_ul} µL`);
    if (reservoir.remaining_ul < volume * wells.length) throw new DeviceError('insufficient_media',
      `Reservoir ${reservoirId} has ${reservoir.remaining_ul} µL, need ${volume * wells.length} µL`);
    const rack = world.tip_racks.find(r => r.remaining >= DEMO_PROFILE.head.channels);
    if (!rack) throw new DeviceError('insufficient_tips', 'No tip rack has enough tips for one head pickup');
    const plan: Plan = {
      stages: this.buildStages(world, MEDIA_ADD_STAGES, {plateId, rowId, wells, reservoirId}, stageDuration,
        c => (c ? 'pipette' : undefined)),
      plateId, rowId, wells, reservoirId, volumePerWell: volume,
    };
    return {plan, resources: ['head', `plate:${plateId}`, `reservoir:${reservoirId}`, 'tips'], scope};
  }

  private planMediaExchange(exp: ExpRow, world: World, args: Record<string, unknown>):
      {plan: Plan; resources: string[]; scope: Action['scope']} {
    const plateId = String(args.plate_id);
    const rowId = String(args.row_id);
    const reservoirId = String(args.reservoir_id);
    const wasteId = String(args.waste_id ?? world.wastes[0]?.id ?? 'waste-01');
    const fraction = Number(args.fraction);
    const plate = this.requirePlate(world, plateId);
    const scope = normalizeRowScope(PLATE_LAYOUTS[plate.format], {plate_id: plateId, row_id: rowId,
      wells: args.wells as string[] | undefined}, DEMO_PROFILE.head.channels);
    if (plate.shake.active) throw new DeviceError('resource_busy', `Plate ${plateId} is shaking`);
    const reservoir = world.reservoirs.find(r => r.id === reservoirId);
    if (!reservoir) throw new DeviceError('invalid_argument', `Unknown reservoir ${reservoirId}`);
    const waste = world.wastes.find(w => w.id === wasteId);
    if (!waste) throw new DeviceError('invalid_argument', `Unknown waste container ${wasteId}`);
    const wells = rowWellIds(PLATE_LAYOUTS[plate.format], rowId);
    const removed = wells.map(w => (plate.wells.find(x => x.well_id === w)?.volume_ul ?? 0) * fraction);
    const vmin = DEMO_PROFILE.liquid.min_residual_ul;
    const violating = wells.filter((w, i) => fraction > 1 - vmin / Math.max(plate.wells.find(x => x.well_id === w)!.volume_ul, 1e-9));
    if (violating.length) throw new DeviceError('invalid_argument',
      `fraction ${fraction} leaves less than the minimum residual ${vmin} µL in wells ${violating.join(',')}`,
      {wells: violating, min_residual_ul: vmin});
    if (removed.some(v => v > DEMO_PROFILE.head.channel_max_ul)) throw new DeviceError('channel_volume_exceeded',
      `Per-channel volume exceeds ${DEMO_PROFILE.head.channel_max_ul} µL`);
    const total = removed.reduce((a, b) => a + b, 0);
    if (reservoir.remaining_ul < total) throw new DeviceError('insufficient_media',
      `Reservoir ${reservoirId} has ${reservoir.remaining_ul} µL, need ${total.toFixed(3)} µL`);
    if (waste.capacity_ul - waste.used_ul < total) throw new DeviceError('waste_full',
      `Waste ${wasteId} has room for ${waste.capacity_ul - waste.used_ul} µL, need ${total.toFixed(3)} µL`);
    let tips = 0;
    for (const r of world.tip_racks) tips += Math.floor(r.remaining / DEMO_PROFILE.head.channels);
    if (tips < 2) throw new DeviceError('insufficient_tips', 'Exchange needs two head pickups (12 tips)');
    const plan: Plan = {
      stages: this.buildStages(world, MEDIA_EXCHANGE_STAGES, {plateId, rowId, wells, reservoirId, wasteId},
        stageDuration, c => (c ? 'pipette' : undefined)),
      plateId, rowId, wells, reservoirId, wasteId, fraction,
    };
    return {plan, resources: ['head', `plate:${plateId}`, `reservoir:${reservoirId}`, `waste:${wasteId}`, 'tips'], scope};
  }

  private planScan(exp: ExpRow, world: World, args: Record<string, unknown>):
      {plan: Plan; resources: string[]; scope: Action['scope']} {
    const plateId = String(args.plate_id);
    const wells = [...(args.wells as string[])];
    const mode = (args.mode ?? 'mono') as ScanMode;
    const view = (args.view ?? 'medium_overview') as ScanView;
    const plate = this.requirePlate(world, plateId);
    if (plate.shake.active) throw new DeviceError('resource_busy', `Plate ${plateId} is shaking`);
    const unknown = wells.filter(w => !plate.wells.some(x => x.well_id === w));
    if (unknown.length) throw new DeviceError('invalid_argument', `Unknown wells on ${plateId}: ${unknown.join(',')}`, {wells: unknown});
    if (wells.length > DEMO_PROFILE.imaging.max_wells_per_scan) throw new DeviceError('invalid_argument', 'Too many wells for one scan');
    const scanDuration = alignToStep(DEMO_PROFILE.stage_s.scanning_base + DEMO_PROFILE.stage_s.scanning_per_well * wells.length);
    const stages: PlanStage[] = [];
    let prev: StageTarget = null;
    for (const p of IMAGING_SCAN_STAGES) {
      const target: StageTarget = p.at === 'well' || p.at === 'plate'
        ? {plate_id: plateId, well_id: wells[0]}
        : null;
      stages.push({stage: p.stage as Stage, primitive: p.primitive, tool: 'camera',
        target, from_target: prev, duration: p.stage === 'scanning' ? scanDuration : stageDuration(p.stage),
        commit: p.commit});
      prev = target;
    }
    const plan: Plan = {stages, plateId, wells, scan: {mode, view}};
    return {plan, resources: ['head', `plate:${plateId}`], scope: {plate_id: plateId, wells, label: `${plateId} ${wells.join(',')}`}};
  }

  private planShake(exp: ExpRow, world: World, args: Record<string, unknown>):
      {plan: Plan; resources: string[]; scope: Action['scope']} {
    const plateId = String(args.plate_id);
    const speed = Number(args.speed_rpm);
    const duration = alignToStep(Number(args.duration_sim_s));
    const plate = this.requirePlate(world, plateId);
    if (plate.shake.active) throw new DeviceError('resource_busy', `Plate ${plateId} is already shaking`);
    const plan: Plan = {stages: [{stage: 'shaking', primitive: 'plate.shake_orbital', target: {resource_id: plateId},
      from_target: null, duration}], plateId, shake: {speed_rpm: speed, duration}};
    return {plan, resources: [`plate:${plateId}`], scope: {plate_id: plateId, label: plateId}};
  }

  private planSetTargets(exp: ExpRow, world: World, args: Record<string, unknown>):
      {plan: Plan; resources: string[]; scope: Action['scope']} {
    const chamberId = String(args.chamber_id);
    if (chamberId !== CHAMBER_ID) throw new DeviceError('invalid_argument', `Unknown chamber ${chamberId}`);
    const plan: Plan = {stages: [], reservoirId: undefined};
    return {plan, resources: [`chamber:${chamberId}`], scope: {label: chamberId}};
  }

  private planAwaitStable(exp: ExpRow, world: World, args: Record<string, unknown>):
      {plan: Plan; resources: string[]; scope: Action['scope']} {
    const chamberId = String(args.chamber_id);
    if (chamberId !== CHAMBER_ID) throw new DeviceError('invalid_argument', `Unknown chamber ${chamberId}`);
    const timeout = alignToStep(Number(args.timeout_sim_s));
    const plan: Plan = {stages: [{stage: 'waiting', primitive: 'environment.await_stable', target: {resource_id: chamberId},
      from_target: null, duration: timeout}], await: {timeout_sim_s: timeout, target_revision: world.chamber.target_revision,
      stable_since: null}};
    return {plan, resources: [], scope: {label: chamberId}};
  }

  private commitSetTargets(exp: ExpRow, world: World, action: Action, plan: Plan, args: Record<string, unknown>): void {
    const targets: Partial<EnvValues> = {};
    if (args.temperature_c !== undefined) targets.temperature_c = Number(args.temperature_c);
    if (args.co2_pct !== undefined) targets.co2_pct = Number(args.co2_pct);
    if (args.humidity_pct !== undefined) targets.humidity_pct = Number(args.humidity_pct);
    setChamberTargets(world, targets);
    world.chamber.target_revision += 1;
    action.status = 'succeeded';
    action.started_at_sim_s = world.sim_time_s;
    action.ended_at_sim_s = world.sim_time_s;
    action.current_stage_index = 0;
    action.stages = [{index: 0, stage: 'waiting', primitive: 'environment.set_targets', target: {resource_id: CHAMBER_ID},
      from_target: null, duration_sim_s: 0, started_at_sim_s: world.sim_time_s, committed: true}];
    const effect: StepEffect = {step_index: 0, stage: 'waiting', committed_at_sim_s: world.sim_time_s,
      chamber_targets: targets as Record<string, number>};
    action.effects.push(effect);
    action.result = {summary: 'targets committed', target_revision: world.chamber.target_revision, targets: effect.chamber_targets};
    this.emit(exp, 'environment.targets_set', {action_id: action.action_id, targets: effect.chamber_targets,
      target_revision: world.chamber.target_revision}, {action_id: action.action_id});
    this.emit(exp, 'action.effect_committed', {action_id: action.action_id, effect, wells: {}}, {action_id: action.action_id});
    this.emit(exp, 'action.succeeded', {action_id: action.action_id, summary: action.summary},
      {action_id: action.action_id});
    // Append to the active barrier (no new decision.granted, lease unchanged).
    const lease = this.activeLease(exp.id);
    if (lease && lease.run_id === action.run_id) this.appendTrigger(exp, lease, {kind: 'appended', action_id: action.action_id});
  }

  // -- cancel ---------------------------------------------------------------

  cancelAction(experimentId: string, actionId: string, principal: Principal): {status: number; action: Action} {
    const result = this.store.tx(() => {
      const exp = this.loadExp(experimentId);
      if (!exp) throw new DeviceError('not_found', `No experiment ${experimentId}`);
      if (exp.status !== 'active') throw new DeviceError('experiment_archived', `Experiment ${experimentId} is ${exp.status}`);
      const row = this.loadActionRow(actionId);
      if (!row || row.experiment_id !== experimentId) throw new DeviceError('not_found', `No action ${actionId}`);
      if (principal.kind === 'run' && row.action.run_id !== principal.run_id) {
        throw new DeviceError('forbidden', 'Runs may only cancel their own actions');
      }
      // Cancel of an already-terminal action returns its current terminal state
      // (NOT the stored original accept response, which stays queued for
      // idempotent replays of the original submission).
      if (isTerminal(row.action.status)) return {status: 200, action: row.action};
      const world = this.loadWorld(experimentId);
      this.discardUncommitted(row, world, 'request', exp);
      row.action.status = 'cancelled';
      row.action.cancel_reason = 'request';
      row.action.ended_at_sim_s = world.sim_time_s;
      row.action.partial = hasCommittedLiquidEffects(row.action);
      this.emit(exp, 'action.cancelled', {action_id: actionId, partial: row.action.partial,
        cancel_reason: 'request', summary: row.action.summary}, {action_id: actionId});
      const lease = this.activeLease(experimentId);
      if (lease && lease.run_id === row.action.run_id) {
        this.appendTrigger(exp, lease, {kind: 'appended', action_id: actionId});
      }
      this.saveWorld(experimentId, world);
      this.saveAction(row);
      this.saveExp(exp);
      return {status: 200, action: row.action};
    });
    this.notify(experimentId, this.loadExp(experimentId)?.event_seq ?? 0);
    return result;
  }

  /** Drop the uncommitted current stage: head contents to waste (conservation), stop shake. */
  private discardUncommitted(row: ActionRow, world: World, reason: string, exp: ExpRow): void {
    const action = row.action;
    if (action.capability === 'plate.shake') {
      const plate = findPlate(world, action.arguments.plate_id as string);
      if (plate && plate.shake.active && plate.shake.action_id === action.action_id) {
        this.stopShake(world, plate, action, exp, world.sim_time_s);
      }
      return;
    }
    // Only the action holding the shared head owns its tips and carried liquid;
    // head-free actions (environment waits, set_targets) run in parallel with
    // pipetting and must never touch another action's load.
    if (!action.resources.includes('head')) return;
    const load = world.head.load_ul.reduce((a, b) => a + b, 0);
    if (load > 0) {
      const {effect} = liquidHeadDiscard(world);
      effect.step_index = action.current_stage_index ?? action.effects.length;
      effect.committed_at_sim_s = world.sim_time_s;
      action.effects.push(effect);
      action.summary.waste_delta_ul += effect.waste?.delta_ul ?? 0;
      this.emit(exp, 'action.effect_committed', {action_id: action.action_id, effect,
        reason: `head_discard_on_${reason}`}, {action_id: action.action_id});
    }
    if (world.head.has_tips) liquidTipsDrop(world);
  }

  // -- leases ---------------------------------------------------------------

  leaseById(leaseId: number): LeaseRow | undefined {
    const r = this.store.stmt('SELECT * FROM leases WHERE lease_id = ?').get(leaseId) as Record<string, unknown> | undefined;
    return r ? this.toLeaseRow(r) : undefined;
  }

  private toLeaseRow(r: Record<string, unknown>): LeaseRow {
    return {
      lease_id: Number(r.lease_id), experiment_id: String(r.experiment_id), run_id: String(r.run_id),
      state: r.state as LeaseRow['state'], frozen_at_sim_s: Number(r.frozen_at_sim_s), event_seq: Number(r.event_seq),
      triggers: JSON.parse(String(r.triggers)) as Lease['triggers'], wake: r.wake ? JSON.parse(String(r.wake)) as WakeCondition : null,
      granted_at_wall: String(r.granted_at_wall), expires_at_wall: String(r.expires_at_wall),
      release_request: r.release_request ? String(r.release_request) : null,
      release_response: r.release_response ? JSON.parse(String(r.release_response)) : null,
    };
  }

  private saveLease(l: LeaseRow): void {
    this.store.stmt(`UPDATE leases SET state=?, wake=?, expires_at_wall=?, release_request=?, release_response=?, triggers=? WHERE lease_id=?`)
      .run(l.state, l.wake ? JSON.stringify(l.wake) : null, l.expires_at_wall, l.release_request,
        l.release_response ? JSON.stringify(l.release_response) : null, JSON.stringify(l.triggers), l.lease_id);
  }

  activeLease(experimentId: string): LeaseRow | undefined {
    const r = this.store.stmt("SELECT * FROM leases WHERE experiment_id = ? AND state = 'active' ORDER BY lease_id DESC LIMIT 1")
      .get(experimentId) as Record<string, unknown> | undefined;
    return r ? this.toLeaseRow(r) : undefined;
  }

  private leaseWire(l: LeaseRow): Lease {
    return {lease_id: l.lease_id, experiment_id: l.experiment_id, run_id: l.run_id, state: l.state,
      frozen_at_sim_s: l.frozen_at_sim_s, event_seq: l.event_seq, triggers: l.triggers, wake: l.wake ?? null,
      expires_at_wall: l.expires_at_wall, granted_at_wall: l.granted_at_wall};
  }

  /** Create a barrier (only when none is active) + decision.granted, inside the caller's tx. */
  private createLease(exp: ExpRow, runId: string, triggers: Lease['triggers']): LeaseRow {
    const existing = this.activeLease(exp.id);
    if (existing) return existing;
    const world = this.loadWorld(exp.id);
    const lease: LeaseRow = {
      lease_id: this.store.nextId('lease_counter'), experiment_id: exp.id, run_id: runId, state: 'active',
      frozen_at_sim_s: world.sim_time_s, event_seq: 0, triggers,
      wake: null, granted_at_wall: nowIso(), expires_at_wall: new Date(Date.now() + this.config.lease.ttlWallMs).toISOString(),
      release_request: null, release_response: null,
    };
    this.emit(exp, 'decision.granted', {lease_id: lease.lease_id, run_id: runId, triggers,
      frozen_at_sim_s: lease.frozen_at_sim_s}, {run_id: runId});
    lease.event_seq = exp.event_seq;
    this.store.stmt(`INSERT INTO leases (lease_id, experiment_id, run_id, state, frozen_at_sim_s, event_seq, triggers,
      granted_at_wall, expires_at_wall) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(lease.lease_id, lease.experiment_id, lease.run_id, lease.state, lease.frozen_at_sim_s, lease.event_seq,
        JSON.stringify(lease.triggers), lease.granted_at_wall, lease.expires_at_wall);
    return lease;
  }

  private appendTrigger(exp: ExpRow, lease: LeaseRow, trigger: Lease['triggers'][number]): void {
    lease.triggers = [...lease.triggers, trigger];
    this.saveLease(lease);
  }

  renewLease(experimentId: string, leaseId: number, principal: Principal): Lease {
    return this.store.tx(() => {
      const exp = this.requireActiveExp(experimentId);
      if (exp.clock_mode !== 'lockstep') throw new DeviceError('clock_mode_mismatch', 'leases exist only in lockstep');
      const lease = this.requireOwnLease(exp, leaseId, principal);
      if (lease.state !== 'active') throw new DeviceError('lease_not_active', `Lease ${leaseId} is ${lease.state}`);
      if (Date.parse(lease.expires_at_wall) <= Date.now()) {
        this.expireLease(exp, lease, 'ttl');
        throw new DeviceError('lease_not_active', `Lease ${leaseId} expired`);
      }
      if (Date.now() - Date.parse(lease.granted_at_wall) > this.config.lease.maxHoldWallMs) {
        this.expireLease(exp, lease, 'max_hold');
        throw new DeviceError('lease_not_active', `Lease ${leaseId} exceeded the max hold time`);
      }
      lease.expires_at_wall = new Date(Date.now() + this.config.lease.ttlWallMs).toISOString();
      this.saveLease(lease);
      return this.leaseWire(lease);
    });
  }

  releaseLease(experimentId: string, leaseId: number, wake: WakeCondition, principal: Principal):
      {lease: Lease; next_lease: Lease | null} {
    const result = this.store.tx(() => {
      const exp = this.requireActiveExp(experimentId);
      if (exp.clock_mode !== 'lockstep') throw new DeviceError('clock_mode_mismatch', 'leases exist only in lockstep');
      if (!wake || ((!wake.on_actions || wake.on_actions.length === 0) && wake.at_sim_s == null)) {
        throw new DeviceError('invalid_argument', 'release body must carry wake:{on_actions:[...]} or wake:{at_sim_s}');
      }
      if (wake.at_sim_s != null) {
        const world = this.loadWorld(experimentId);
        if (wake.at_sim_s - world.sim_time_s > DEMO_PROFILE.wait.max_wait_s) {
          throw new DeviceError('invalid_argument', `at_sim_s is farther than the max wait ${DEMO_PROFILE.wait.max_wait_s} s`);
        }
      }
      const lease = this.requireOwnLease(exp, leaseId, principal);
      const request = canonicalJson(wake);
      if (lease.state === 'released') {
        if (lease.release_request === request && lease.release_response) return lease.release_response;
        throw new DeviceError('lease_not_active', `Lease ${leaseId} is released`);
      }
      if (lease.state !== 'active') throw new DeviceError('lease_not_active', `Lease ${leaseId} is ${lease.state}`);
      lease.state = 'released';
      lease.wake = wake;
      lease.release_request = request;
      this.saveLease(lease);
      this.emit(exp, 'lease.released', {lease_id: lease.lease_id, run_id: lease.run_id, wake},
        {run_id: lease.run_id});
      // Register the wake; if already satisfied, hand off the next lease in the SAME transaction.
      this.store.stmt('INSERT OR REPLACE INTO wakes (experiment_id, run_id, lease_id, wake) VALUES (?,?,?,?)')
        .run(experimentId, lease.run_id, lease.lease_id, JSON.stringify(wake));
      const world = this.loadWorld(experimentId);
      const {satisfied, triggers} = this.wakeSatisfied(experimentId, wake, world.sim_time_s);
      let nextLease: LeaseRow | null = null;
      const run = this.runById(lease.run_id);
      if (satisfied && run && run.status === 'active' && exp.clock_mode === 'lockstep' && !this.activeLease(experimentId)) {
        this.store.stmt('DELETE FROM wakes WHERE experiment_id=? AND run_id=? AND lease_id=?')
          .run(experimentId, lease.run_id, lease.lease_id);
        nextLease = this.createLease(exp, lease.run_id, triggers);
      }
      const response = {lease: this.leaseWire(lease), next_lease: nextLease ? this.leaseWire(nextLease) : null};
      lease.release_response = response;
      this.saveLease(lease);
      this.saveExp(exp);
      return response;
    });
    this.notify(experimentId, this.loadExp(experimentId)?.event_seq ?? 0);
    return result;
  }

  private wakeSatisfied(experimentId: string, wake: WakeCondition, simTime: number):
      {satisfied: boolean; triggers: Lease['triggers']} {
    const triggers: Lease['triggers'] = [];
    let satisfied = false;
    if (wake.on_actions && wake.on_actions.length > 0) {
      const rows = wake.on_actions.map(id => this.loadActionRow(id)).filter(r => r && r.experiment_id === experimentId);
      const allTerminal = rows.length === wake.on_actions.length && rows.every(r => isTerminal(r!.action.status));
      if (allTerminal) {
        satisfied = true;
        for (const r of rows) triggers.push({kind: 'action_terminal', action_id: r!.id});
      }
    } else if (wake.at_sim_s != null && simTime >= wake.at_sim_s) {
      satisfied = true;
      triggers.push({kind: 'wake_time', at_sim_s: wake.at_sim_s});
    }
    return {satisfied, triggers};
  }

  private expireLease(exp: ExpRow, lease: LeaseRow, reason: 'ttl' | 'max_hold'): void {
    lease.state = 'expired';
    this.saveLease(lease);
    this.emit(exp, 'lease.expired', {lease_id: lease.lease_id, run_id: lease.run_id, reason},
      {run_id: lease.run_id});
    this.store.stmt('DELETE FROM wakes WHERE experiment_id=? AND run_id=?').run(exp.id, lease.run_id);
    const run = this.runById(lease.run_id);
    if (run && run.status !== 'ended') {
      run.status = 'paused';
      run.run.status = 'paused';
      run.run.reason = 'lease_timeout';
      run.run.determinism_broken = true;
      this.saveRun(run);
      this.emit(exp, 'run.paused', {run_id: run.id, reason: 'lease_timeout', determinism_broken: true}, {run_id: run.id});
    }
    exp.determinism_broken = 1;
    this.saveExp(exp);
  }

  /** Wall-clock sweep: expire leases whose TTL passed. */
  sweepExpiredLeases(): void {
    const rows = this.store.stmt("SELECT lease_id FROM leases WHERE state = 'active'").all() as {lease_id: number}[];
    for (const {lease_id} of rows) {
      const lease = this.leaseById(lease_id);
      if (!lease) continue;
      const overTtl = Date.parse(lease.expires_at_wall) <= Date.now();
      const overHold = Date.now() - Date.parse(lease.granted_at_wall) > this.config.lease.maxHoldWallMs;
      if (overTtl || overHold) {
        this.store.tx(() => {
          const exp = this.loadExp(lease.experiment_id);
          if (!exp || exp.status !== 'active') return;
          const current = this.leaseById(lease_id);
          if (!current || current.state !== 'active') return;
          this.expireLease(exp, current, overHold ? 'max_hold' : 'ttl');
        });
        this.notify(lease.experiment_id, this.loadExp(lease.experiment_id)?.event_seq ?? 0);
      }
    }
  }

  private requireOwnLease(exp: ExpRow, leaseId: number, principal: Principal): LeaseRow {
    const lease = this.leaseById(leaseId);
    if (!lease) throw new DeviceError('lease_not_active', `Lease ${leaseId} does not exist`);
    if (principal.kind === 'run' && lease.run_id !== principal.run_id) {
      throw new DeviceError('lease_forbidden', `Lease ${leaseId} belongs to another run`);
    }
    if (lease.experiment_id !== exp.id) throw new DeviceError('lease_forbidden', `Lease ${leaseId} belongs to another experiment`);
    return lease;
  }

  private requireActiveExp(experimentId: string): ExpRow {
    const exp = this.loadExp(experimentId);
    if (!exp) throw new DeviceError('not_found', `No experiment ${experimentId}`);
    if (exp.status !== 'active') throw new DeviceError('experiment_archived', `Experiment ${experimentId} is ${exp.status}`);
    return exp;
  }

  // -- runs -----------------------------------------------------------------

  runById(runId: string): RunRow | undefined {
    const r = this.store.stmt('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {id: String(r.id), experiment_id: String(r.experiment_id), status: r.status as RunRow['status'],
      run: JSON.parse(String(r.run_json)) as RunRecord};
  }

  private saveRun(row: RunRow): void {
    this.store.stmt('UPDATE runs SET status=?, run_json=? WHERE id=?').run(row.run.status, JSON.stringify(row.run), row.id);
  }

  nonEndedRun(experimentId: string): RunRow | undefined {
    const r = this.store.stmt("SELECT * FROM runs WHERE experiment_id = ? AND status != 'ended' ORDER BY rowid DESC LIMIT 1")
      .get(experimentId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {id: String(r.id), experiment_id: experimentId, status: r.status as RunRow['status'],
      run: JSON.parse(String(r.run_json)) as RunRecord};
  }

  listRuns(experimentId: string): RunRecord[] {
    const rows = this.store.stmt('SELECT run_json FROM runs WHERE experiment_id = ? ORDER BY rowid ASC').all(experimentId) as {run_json: string}[];
    return rows.map(r => JSON.parse(r.run_json) as RunRecord);
  }

  resolveRunToken(token: string): {run_id: string; experiment_id: string} | null {
    const sha = sha256hex(token);
    const row = this.store.stmt('SELECT run_id, experiment_id, revoked FROM run_tokens WHERE token_sha256 = ?')
      .get(sha) as {run_id: string; experiment_id: string; revoked: number} | undefined;
    if (!row || row.revoked === 1) return null;
    return {run_id: row.run_id, experiment_id: row.experiment_id};
  }

  /**
   * Create a run (gateway flow §4.1): Runtime transaction first (run + token +
   * first lease in lockstep), then forward to the Agent; on Agent failure the
   * run is ended (agent_unavailable) and the lease revoked. `forward` performs
   * the network call OUTSIDE the Runtime transaction.
   */
  async createRun(body: {experiment_id?: string; scenario_id?: string; mode?: 'scripted' | 'llm'; goal?: string;
    plates?: string[]; capabilities?: string[]; budget?: {max_actions?: number}}, idempotencyKey: string | null,
    forward: (payload: Record<string, unknown>) => Promise<void>): Promise<{run: RunRecord; lease: Lease | null; run_token: string}> {
    const prepared = this.store.tx(() => {
      const exp = body.experiment_id ? this.loadExp(body.experiment_id) : this.currentExperiment();
      if (!exp) throw new DeviceError('not_found', 'No experiment for this run');
      if (exp.status !== 'active') throw new DeviceError('experiment_archived', `Experiment ${exp.id} is ${exp.status}`);
      if (idempotencyKey) {
        const rows = this.store.stmt('SELECT run_json FROM runs').all() as {run_json: string}[];
        for (const r of rows) {
          const run = JSON.parse(r.run_json) as RunRecord & {idempotency_key?: string | null};
          if (run.idempotency_key === idempotencyKey) return {existing: run};
        }
      }
      const existingRun = this.nonEndedRun(exp.id);
      if (existingRun) throw new DeviceError('run_already_active', `Run ${existingRun.id} is ${existingRun.status}`);
      const scenario = loadScenario(exp.scenario_id);
      // run ids are globally unique (runs.id is the primary key)
      const runId = `run-${exp.id.replace(/^exp-/, '')}-${exp.run_counter + 1}`;
      exp.run_counter += 1;
      const run: RunRecord & {idempotency_key?: string | null} = {
        run_id: runId, experiment_id: exp.id, mode: body.mode ?? 'scripted', status: 'active', reason: null,
        clock_mode: exp.clock_mode,
        plates: body.plates ?? scenario.task.plates,
        capabilities: body.capabilities ?? scenario.task.allowed_capabilities,
        budget: {max_actions: body.budget?.max_actions ?? scenario.task.budgets.max_actions, actions_used: 0},
        determinism_broken: false, created_at_sim_s: exp.sim_time_s, idempotency_key: idempotencyKey ?? null,
      };
      const token = `rt_${randomBytes(24).toString('hex')}`;
      this.store.stmt('INSERT INTO runs (id, experiment_id, status, run_json) VALUES (?,?,?,?)')
        .run(runId, exp.id, run.status, JSON.stringify(run));
      this.store.stmt('INSERT INTO run_tokens (token_sha256, run_id, experiment_id) VALUES (?,?,?)')
        .run(sha256hex(token), runId, exp.id);
      this.emit(exp, 'run.created', {run_id: runId, mode: run.mode, plates: run.plates,
        capabilities: run.capabilities, budget: run.budget}, {run_id: runId});
      let lease: LeaseRow | null = null;
      if (exp.clock_mode === 'lockstep') lease = this.createLease(exp, runId, [{kind: 'run_started'}]);
      this.saveExp(exp);
      return {exp, run, lease, token};
    });
    if ('existing' in prepared && prepared.existing) {
      const existing: RunRecord = prepared.existing;
      const row = this.runById(existing.run_id);
      const lease = row ? this.activeLease(row.experiment_id) : undefined;
      return {run: existing, lease: lease ? this.leaseWire(lease) : null, run_token: ''};
    }
    const {exp, run, lease, token} = prepared;
    const payload = {run_id: run.run_id, run_token: token, experiment_id: exp.id, clock_mode: exp.clock_mode,
      lease: lease ? this.leaseWire(lease) : null, mode: run.mode, goal: body.goal ?? scenarioGoal(exp.scenario_id),
      plates: run.plates, capabilities: run.capabilities, budget: run.budget, scenario_id: exp.scenario_id, seed: exp.seed};
    this.notify(exp.id, this.loadExp(exp.id)?.event_seq ?? 0);
    try {
      await forward(payload);
    } catch {
      this.store.tx(() => {
        const e2 = this.loadExp(exp.id)!;
        this.endRun(e2, run.run_id, 'agent_unavailable');
        this.saveExp(e2);
      });
      this.notify(exp.id, this.loadExp(exp.id)?.event_seq ?? 0);
      throw new DeviceError('agent_unavailable', 'Agent did not accept the run; the run was rolled back');
    }
    return {run, lease: lease ? this.leaseWire(lease) : null, run_token: token};
  }

  /** End a run inside a tx: revoke token + lease, cancel its non-terminal actions. */
  private endRun(exp: ExpRow, runId: string, reason: string, extraPayload: Record<string, unknown> = {}): RunRow {
    const run = this.runById(runId)!;
    run.status = 'ended';
    run.run.status = 'ended';
    run.run.reason = reason;
    this.saveRun(run);
    this.store.stmt('UPDATE run_tokens SET revoked = 1 WHERE run_id = ?').run(runId);
    const lease = this.activeLease(exp.id);
    if (lease && lease.run_id === runId) {
      lease.state = 'revoked';
      this.saveLease(lease);
      this.emit(exp, 'lease.revoked', {lease_id: lease.lease_id, run_id: runId, reason}, {run_id: runId});
    }
    this.store.stmt('DELETE FROM wakes WHERE experiment_id=? AND run_id=?').run(exp.id, runId);
    // Cancel the run's non-terminal actions with their committed effects.
    const world = this.loadWorld(exp.id);
    for (const row of this.nonTerminalActions(exp.id)) {
      if (row.action.run_id !== runId) continue;
      this.discardUncommitted(row, world, 'run_ended', exp);
      row.action.status = 'cancelled';
      row.action.cancel_reason = 'run_cancelled';
      row.action.ended_at_sim_s = world.sim_time_s;
      row.action.partial = hasCommittedLiquidEffects(row.action);
      this.emit(exp, 'action.cancelled', {action_id: row.id, cancel_reason: 'run_cancelled',
        partial: row.action.partial, summary: row.action.summary}, {action_id: row.id});
      this.saveAction(row);
    }
    this.saveWorld(exp.id, world);
    this.emit(exp, 'run.ended', {run_id: runId, reason, ...extraPayload}, {run_id: runId});
    return run;
  }

  controlRun(experimentId: string, runId: string, action: 'pause' | 'resume' | 'cancel'): RunRecord {
    const result = this.store.tx(() => {
      const exp = this.requireActiveExp(experimentId);
      const run = this.runById(runId);
      if (!run || run.experiment_id !== experimentId) throw new DeviceError('not_found', `No run ${runId}`);
      if (action === 'pause') {
        if (run.status === 'ended') throw new DeviceError('run_not_active', 'Run has ended');
        run.status = 'paused';
        run.run.status = 'paused';
        run.run.reason = 'operator_pause';
        this.saveRun(run);
        const lease = this.activeLease(exp.id);
        if (lease && lease.run_id === runId) {
          lease.state = 'revoked';
          this.saveLease(lease);
          this.emit(exp, 'lease.revoked', {lease_id: lease.lease_id, run_id: runId, reason: 'run_paused'}, {run_id: runId});
        }
        this.store.stmt('DELETE FROM wakes WHERE experiment_id=? AND run_id=?').run(exp.id, runId);
        this.emit(exp, 'run.paused', {run_id: runId, reason: 'operator_pause'}, {run_id: runId});
      } else if (action === 'resume') {
        if (run.status === 'ended') throw new DeviceError('run_not_active', 'Run has ended');
        run.status = 'active';
        run.run.status = 'active';
        run.run.reason = null;
        this.saveRun(run);
        this.emit(exp, 'run.resumed', {run_id: runId}, {run_id: runId});
        if (exp.clock_mode === 'lockstep') this.createLease(exp, runId, [{kind: 'run_resumed'}]);
      } else {
        if (run.status !== 'ended') this.endRun(exp, runId, 'cancelled');
      }
      this.saveExp(exp);
      return this.runById(runId)!.run;
    });
    this.notify(experimentId, this.loadExp(experimentId)?.event_seq ?? 0);
    return result;
  }

  setHold(experimentId: string, runId: string, on: boolean): RunRecord {
    const result = this.store.tx(() => {
      const exp = this.requireActiveExp(experimentId);
      const run = this.runById(runId);
      if (!run || run.experiment_id !== experimentId) throw new DeviceError('not_found', `No run ${runId}`);
      if (run.status === 'ended') throw new DeviceError('run_not_active', 'Run has ended');
      if (on) {
        run.status = 'on_hold';
        run.run.status = 'on_hold';
        this.saveRun(run);
        const lease = this.activeLease(exp.id);
        if (lease && lease.run_id === runId) {
          lease.state = 'revoked';
          this.saveLease(lease);
          this.emit(exp, 'lease.revoked', {lease_id: lease.lease_id, run_id: runId, reason: 'run_on_hold'}, {run_id: runId});
        }
        this.emit(exp, 'run.on_hold', {run_id: runId, on: true}, {run_id: runId});
      } else {
        run.status = 'active';
        run.run.status = 'active';
        this.saveRun(run);
        this.emit(exp, 'run.resumed', {run_id: runId, from_hold: true}, {run_id: runId});
        if (exp.clock_mode === 'lockstep') this.createLease(exp, runId, [{kind: 'run_resumed'}]);
      }
      this.saveExp(exp);
      return this.runById(runId)!.run;
    });
    this.notify(experimentId, this.loadExp(experimentId)?.event_seq ?? 0);
    return result;
  }

  agentStatus(runId: string, status: string, reason: string | null): RunRecord {
    const result = this.store.tx(() => {
      const run = this.runById(runId);
      if (!run) throw new DeviceError('not_found', `No run ${runId}`);
      const exp = this.loadExp(run.experiment_id)!;
      if (status === 'paused' && run.status !== 'ended') {
        run.status = 'paused';
        run.run.status = 'paused';
        run.run.reason = reason ?? 'agent_paused';
        this.saveRun(run);
        const lease = this.activeLease(exp.id);
        if (lease && lease.run_id === runId) {
          lease.state = 'revoked';
          this.saveLease(lease);
          this.emit(exp, 'lease.revoked', {lease_id: lease.lease_id, run_id: runId, reason: 'agent_paused'}, {run_id: runId});
        }
        this.store.stmt('DELETE FROM wakes WHERE experiment_id=? AND run_id=?').run(exp.id, runId);
        this.emit(exp, 'run.paused', {run_id: runId, reason: reason ?? 'agent_paused', by: 'agent'}, {run_id: runId});
      }
      this.saveExp(exp);
      return run.run;
    });
    this.notify(result.experiment_id, this.loadExp(result.experiment_id)?.event_seq ?? 0);
    return result;
  }

  /**
   * 【C3 细化】Agent final report: {status:'ended', reason:'completed'|'failed'|'aborted',
   * report?} from the run token. Ends the run through the existing endRun path
   * (revoking the token + lease, cancelling its non-terminal actions), stores
   * the report JSON in agent_reports and emits run.ended with the outcome.
   */
  agentEnded(runId: string, reason: 'completed' | 'failed' | 'aborted', report: unknown): RunRecord {
    const result = this.store.tx(() => {
      const run = this.runById(runId);
      if (!run) throw new DeviceError('not_found', `No run ${runId}`);
      const exp = this.loadExp(run.experiment_id)!;
      if (report !== null && report !== undefined) {
        this.store.stmt(`INSERT INTO agent_reports (run_id, experiment_id, reason, report_json, created_at_wall)
          VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET reason=excluded.reason,
          report_json=excluded.report_json, created_at_wall=excluded.created_at_wall`)
          .run(runId, run.experiment_id, reason, JSON.stringify(report), nowIso());
      }
      if (run.status !== 'ended') {
        this.endRun(exp, runId, reason, {outcome: reason, by: 'agent', report_present: report != null});
      } else {
        this.emit(exp, 'run.ended', {run_id: runId, reason, outcome: reason, by: 'agent_report',
          report_present: report != null, note: 'run was already ended; report stored only'}, {run_id: runId});
      }
      this.saveExp(exp);
      return this.runById(runId)!.run;
    });
    this.notify(result.experiment_id, this.loadExp(result.experiment_id)?.event_seq ?? 0);
    return result;
  }

  /** 【C3 细化】Stored agent report for a run (operator or that run token). */
  agentReport(runId: string): {run_id: string; reason: string; report: unknown; created_at_wall: string} | undefined {
    const row = this.store.stmt('SELECT * FROM agent_reports WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {run_id: runId, reason: String(row.reason), report: JSON.parse(String(row.report_json)),
      created_at_wall: String(row.created_at_wall)};
  }

  // -- clock ----------------------------------------------------------------

  /** One fixed 1 s step. Returns false when the clock must not advance (lease/paused/archived). */
  stepOnce(experimentId: string): boolean {
    let advanced = false;
    let dropped = false;
    let lastSeq = 0;
    this.store.tx(() => {
      const exp = this.loadExp(experimentId);
      if (!exp || exp.status !== 'active') {
        dropped = exp != null;
        return;
      }
      if (exp.paused === 1) return;
      if (exp.clock_mode === 'lockstep' && this.activeLease(experimentId)) return;
      const world = this.loadWorld(experimentId);
      const t0 = world.sim_time_s;
      const t1 = t0 + DEMO_PROFILE.sim_step_s;
      // All events of this step carry the step-end sim time.
      exp.sim_time_s = t1;

      // 1. queued -> running; stage 0 starts at the step's start time.
      for (const row of this.nonTerminalActions(experimentId)) {
        if (row.action.status !== 'queued') continue;
        row.action.status = 'running';
        row.action.started_at_sim_s = t0;
        row.action.current_stage_index = 0;
        if (row.action.stages.length > 0) row.action.stages[0].started_at_sim_s = t0;
        this.emit(exp, 'action.started', {action_id: row.id, capability: row.action.capability,
          stage_started_at_sim_s: t0}, {action_id: row.id});
        if (row.action.stages.length > 0) {
          this.emitStageChanged(exp, row.action, 0);
        }
        if (row.action.capability === 'plate.shake') this.startShake(world, row, exp, t0);
        this.saveAction(row);
      }

      // 2. world physics (environment, culture, evaporation).
      const report = stepWorld(world, DEMO_PROFILE.sim_step_s);
      if (report.sampled) {
        this.emit(exp, 'environment.sampled', {chamber_id: CHAMBER_ID, sample: world.chamber.sample,
          targets: world.chamber.targets, quality: world.chamber.sample.quality});
      }

      // 3. stage machine for running actions (accept_seq order).
      const terminals: {action_id: string; run_id: string | null; status: ActionStatus}[] = [];
      for (const row of this.nonTerminalActions(experimentId)) {
        if (row.action.status !== 'running') continue;
        const terminal = this.advanceAction(exp, world, row, t1, terminals);
        if (terminal) this.saveAction(row);
        else if (row.action.status === 'running') this.saveAction(row);
      }

      // 4. barrier evaluation (lockstep): merge same-instant triggers.
      if (exp.clock_mode === 'lockstep' && !this.activeLease(experimentId)) {
        const triggers: Lease['triggers'] = [];
        const run = this.nonEndedRun(experimentId);
        if (run && run.status === 'active') {
          for (const t of terminals) {
            if (t.run_id === run.id) triggers.push({kind: 'action_terminal', action_id: t.action_id});
          }
          // Registered wake conditions satisfied at t1.
          const wakeRows = this.store.stmt('SELECT lease_id, wake FROM wakes WHERE experiment_id=? AND run_id=?')
            .all(experimentId, run.id) as {lease_id: number; wake: string}[];
          for (const w of wakeRows) {
            const wake = JSON.parse(w.wake) as WakeCondition;
            const {satisfied, triggers: wt} = this.wakeSatisfied(experimentId, wake, t1);
            if (satisfied) {
              triggers.push(...wt);
              this.store.stmt('DELETE FROM wakes WHERE experiment_id=? AND run_id=? AND lease_id=?')
                .run(experimentId, run.id, w.lease_id);
            }
          }
          if (triggers.length > 0) this.createLease(exp, run.id, triggers);
        }
      }

      this.saveWorld(experimentId, world);
      this.saveExp(exp);
      advanced = true;
      lastSeq = exp.event_seq;
    });
    if (dropped) {
      this.store.diagnostic(experimentId, 'stale_commit_dropped', 'step skipped: experiment not active');
    }
    if (advanced || lastSeq > 0) this.notify(experimentId, lastSeq || this.loadExp(experimentId)?.event_seq || 0);
    return advanced;
  }

  private emitStageChanged(exp: ExpRow, action: Action, index: number): void {
    const st = action.stages[index];
    if (!st) return;
    this.emit(exp, 'action.stage_changed', {action_id: action.action_id, stage: st.stage, primitive: st.primitive,
      tool: st.tool ?? null, target: st.target, from_target: st.from_target ?? null,
      stage_started_at_sim_s: st.started_at_sim_s, stage_duration_sim_s: st.duration_sim_s, step_index: st.index},
      {action_id: action.action_id});
  }

  /** Advance one running action through every stage that ends at or before t1. */
  private advanceAction(exp: ExpRow, world: World, row: ActionRow, t1: number,
      terminals: {action_id: string; run_id: string | null; status: ActionStatus}[]): boolean {
    const action = row.action;
    const plan = row.plan;
    if (action.capability === 'plate.shake') {
      const plate = findPlate(world, action.arguments.plate_id as string)!;
      const startedAt = action.started_at_sim_s ?? t1;
      if (startedAt + (plan?.shake?.duration ?? 0) <= t1 && action.status === 'running') {
        this.stopShake(world, plate, action, exp, startedAt + (plan?.shake?.duration ?? 0));
        action.status = 'succeeded';
        action.ended_at_sim_s = startedAt + (plan?.shake?.duration ?? 0);
        action.current_stage_index = 0;
        if (action.stages[0]) action.stages[0].committed = true;
        action.result = {summary: 'shake completed', speed_rpm: plan?.shake?.speed_rpm,
          duration_sim_s: plan?.shake?.duration};
        this.emit(exp, 'action.succeeded', {action_id: action.action_id, summary: action.summary},
          {action_id: action.action_id});
        terminals.push({action_id: action.action_id, run_id: action.run_id, status: 'succeeded'});
        return true;
      }
      return false;
    }
    if (action.capability === 'environment.await_stable') {
      const aw = plan!.await!;
      if (world.chamber.target_revision !== aw.target_revision) {
        action.status = 'failed';
        action.ended_at_sim_s = t1;
        action.error = {code: 'target_changed', message: 'Chamber targets changed while waiting for stability',
          retryable: false};
        this.emit(exp, 'action.failed', {action_id: action.action_id, error: action.error}, {action_id: action.action_id});
        terminals.push({action_id: action.action_id, run_id: action.run_id, status: 'failed'});
        return true;
      }
      if (environmentStableFor(world, DEMO_PROFILE.environment.stable_hold_s)) {
        action.status = 'succeeded';
        action.ended_at_sim_s = t1;
        action.result = {summary: 'environment stable', held_for_sim_s: DEMO_PROFILE.environment.stable_hold_s};
        this.emit(exp, 'action.succeeded', {action_id: action.action_id, summary: action.summary},
          {action_id: action.action_id});
        terminals.push({action_id: action.action_id, run_id: action.run_id, status: 'succeeded'});
        return true;
      }
      if (t1 - (action.started_at_sim_s ?? t1) >= aw.timeout_sim_s) {
        action.status = 'failed';
        action.ended_at_sim_s = t1;
        action.error = {code: 'timeout', message: `Environment did not stabilize within ${aw.timeout_sim_s} s`,
          retryable: true};
        this.emit(exp, 'action.failed', {action_id: action.action_id, error: action.error}, {action_id: action.action_id});
        terminals.push({action_id: action.action_id, run_id: action.run_id, status: 'failed'});
        return true;
      }
      return false;
    }
    // Generic stage machine (liquid + scan).
    let finished = false;
    while (!finished && action.current_stage_index != null && action.current_stage_index < action.stages.length) {
      const idx = action.current_stage_index;
      const stage = action.stages[idx];
      const planStage = plan!.stages[idx];
      const stageEnd = (stage.started_at_sim_s ?? t1) + stage.duration_sim_s;
      if (stageEnd > t1) break;
      // Commit the stage effect atomically (all 6 wells + inventory) in THIS transaction.
      this.commitStage(exp, world, row, idx, stageEnd);
      stage.committed = true;
      if (idx + 1 < action.stages.length) {
        action.current_stage_index = idx + 1;
        const next = action.stages[idx + 1];
        next.started_at_sim_s = stageEnd;
        this.emitStageChanged(exp, action, idx + 1);
      } else {
        action.current_stage_index = idx;
        finished = true;
      }
    }
    if (finished && action.status === 'running') {
      action.status = 'succeeded';
      action.ended_at_sim_s = t1;
      if (action.capability === 'imaging.scan') {
        action.result = action.result ?? {summary: 'scan completed'};
      } else {
        action.result = {summary: `${action.capability} completed`, wells: action.summary.wells,
          reservoir_delta_ul: action.summary.reservoir_delta_ul, waste_delta_ul: action.summary.waste_delta_ul,
          tips_used: action.summary.tips_used};
      }
      this.emit(exp, 'action.succeeded', {action_id: action.action_id, summary: action.summary},
        {action_id: action.action_id});
      terminals.push({action_id: action.action_id, run_id: action.run_id, status: 'succeeded'});
    }
    return finished;
  }

  private commitStage(exp: ExpRow, world: World, row: ActionRow, idx: number, at: number): void {
    const action = row.action;
    const plan = row.plan!;
    const planStage = plan.stages[idx];
    const stage = action.stages[idx];
    let effect: StepEffect | null = null;
    switch (planStage.commit) {
      case 'tips_pick': {
        const {rack, effect: e} = liquidTipsPick(world);
        e.step_index = idx; e.committed_at_sim_s = at; e.stage = stage.stage;
        effect = e;
        action.summary.tips_used += DEMO_PROFILE.head.channels;
        break;
      }
      case 'reservoir_aspirate': {
        const vols = plan.volumePerWell != null
          ? Array.from({length: DEMO_PROFILE.head.channels}, () => plan.volumePerWell!)
          : plan.removedVols!;
        const {effect: e} = liquidReservoirAspirate(world, plan.reservoirId!, vols);
        e.step_index = idx; e.committed_at_sim_s = at; e.stage = stage.stage;
        effect = e;
        action.summary.reservoir_delta_ul += e.reservoir?.delta_ul ?? 0;
        break;
      }
      case 'row_aspirate': {
        const wells = rowWellsSim(world, plan.plateId!, plan.rowId!);
        const vols = wells.map(w => w.volume_ul * (plan.fraction ?? 1));
        plan.removedVols = vols;
        const {effect: e} = liquidRowAspirate(world, plan.plateId!, plan.rowId!, vols);
        e.step_index = idx; e.committed_at_sim_s = at; e.stage = stage.stage;
        effect = e;
        this.addWellDeltas(action, e, -1);
        break;
      }
      case 'waste_dispense': {
        const {effect: e} = liquidWasteDispense(world, plan.wasteId);
        e.step_index = idx; e.committed_at_sim_s = at; e.stage = stage.stage;
        effect = e;
        action.summary.waste_delta_ul += e.waste?.delta_ul ?? 0;
        break;
      }
      case 'row_dispense': {
        const vols = plan.volumePerWell != null
          ? Array.from({length: DEMO_PROFILE.head.channels}, () => plan.volumePerWell!)
          : plan.removedVols!;
        const {effect: e} = liquidRowDispense(world, plan.plateId!, plan.rowId!, vols);
        e.step_index = idx; e.committed_at_sim_s = at; e.stage = stage.stage;
        effect = e;
        this.addWellDeltas(action, e, +1);
        break;
      }
      case 'tips_drop': {
        const {effect: e} = liquidTipsDrop(world);
        e.step_index = idx; e.committed_at_sim_s = at; e.stage = stage.stage;
        effect = e;
        break;
      }
      case 'scan_capture': {
        const scan = performScan(world, {plate_id: plan.plateId!, wells: plan.wells!, mode: plan.scan!.mode,
          view: plan.scan!.view});
        const obsId = `obs-${exp.id.replace(/^exp-/, '')}-${String(++exp.obs_counter).padStart(3, '0')}`;
        const images: ImageRef[] = scan.images.map(img => {
          const assetId = `ast-${exp.id.replace(/^exp-/, '')}-${String(++exp.asset_counter).padStart(3, '0')}`;
          this.store.stmt('INSERT INTO assets (id, experiment_id, sha256, bytes) VALUES (?,?,?,?)')
            .run(assetId, exp.id, img.sha256, Buffer.from(img.bytes));
          return {asset_id: assetId, role: img.role, sha256: img.sha256, width: img.width, height: img.height,
            media_type: 'image/png' as const, provenance: 'synthetic_image' as const};
        });
        const observation: Observation = {
          observation_id: obsId, experiment_id: exp.id, action_id: action.action_id, plate_id: plan.plateId!,
          wells: plan.wells!, mode: plan.scan!.mode, view: plan.scan!.view, sampled_at_sim_s: scan.sampled_at_sim_s,
          plate_revision: scan.plate_revision, quality: scan.quality, stereo_pair_id: scan.stereo_pair_id,
          depth_status: 'not_computed', camera: scan.camera, images, estimates: scan.estimates,
          source: 'synthetic_image',
        };
        this.store.stmt('INSERT INTO observations (id, experiment_id, action_id, obs_json) VALUES (?,?,?,?)')
          .run(obsId, exp.id, action.action_id, JSON.stringify(observation));
        action.result = {observation_id: obsId, images: images.map(i => i.asset_id), quality: scan.quality};
        this.emit(exp, 'observation.created', {observation_id: obsId, action_id: action.action_id,
          plate_id: plan.plateId!, quality: scan.quality, images: images.map(i => ({asset_id: i.asset_id, sha256: i.sha256}))},
          {action_id: action.action_id, observation_id: obsId});
        return; // scan capture writes the observation, not a StepEffect
      }
      default:
        return; // moving/lowering/raising: no inventory effect
    }
    if (!effect) return;
    action.effects.push(effect);
    const plate = plan.plateId ? findPlate(world, plan.plateId) : undefined;
    const wellsAfter: Record<string, number> = {};
    if (plate && plan.wells) {
      for (const w of plan.wells) wellsAfter[w] = plate.wells.find(x => x.well_id === w)?.volume_ul ?? 0;
    }
    this.emit(exp, 'action.effect_committed', {action_id: action.action_id, effect, wells: wellsAfter},
      {action_id: action.action_id});
  }

  private addWellDeltas(action: Action, effect: StepEffect, sign: 1 | -1): void {
    for (const d of effect.wells ?? []) {
      const entry = action.summary.wells[d.well_id] ?? (action.summary.wells[d.well_id] = {removed_ul: 0, added_ul: 0});
      if (sign < 0) entry.removed_ul += -d.delta_ul;
      else entry.added_ul += d.delta_ul;
    }
  }

  private startShake(world: World, row: ActionRow, exp: ExpRow, at: number): void {
    const plate = findPlate(world, row.action.arguments.plate_id as string)!;
    const speed = Number(row.action.arguments.speed_rpm);
    const duration = row.plan?.shake?.duration ?? 0;
    plate.shake = {active: true, started_at_sim_s: at, duration_sim_s: duration, speed_rpm: speed,
      action_id: row.action.action_id, ended_at_sim_s: null, settle_until_sim_s: 0};
    plate.revision += 1;
    world.counters.shake_count += 1;
    const effect: StepEffect = {step_index: 0, stage: 'shaking', committed_at_sim_s: at, shake: 'started'};
    row.action.effects.push(effect);
    this.emit(exp, 'plate.shake_started', {action_id: row.action.action_id, plate_id: plate.plate_id,
      speed_rpm: speed, duration_sim_s: duration, revision: plate.revision}, {action_id: row.action.action_id});
    this.emit(exp, 'action.effect_committed', {action_id: row.action.action_id, effect, wells: {}},
      {action_id: row.action.action_id});
  }

  private stopShake(world: World, plate: import('@oscar/simulator').PlateSim, action: Action, exp: ExpRow, at: number): void {
    plate.shake.active = false;
    plate.shake.ended_at_sim_s = at;
    plate.shake.settle_until_sim_s = at + DEMO_PROFILE.shake.settle_s;
    plate.revision += 1;
    const effect: StepEffect = {step_index: 0, stage: 'shaking', committed_at_sim_s: at, shake: 'stopped'};
    action.effects.push(effect);
    this.emit(exp, 'plate.shake_stopped', {action_id: action.action_id, plate_id: plate.plate_id,
      ended_at_sim_s: at, settle_until_sim_s: plate.shake.settle_until_sim_s, revision: plate.revision},
      {action_id: action.action_id});
    this.emit(exp, 'action.effect_committed', {action_id: action.action_id, effect, wells: {}},
      {action_id: action.action_id});
  }

  // -- control --------------------------------------------------------------

  control(experimentId: string, body: Record<string, unknown>): Record<string, unknown> {
    const exp0 = this.loadExp(experimentId);
    if (!exp0) throw new DeviceError('not_found', `No experiment ${experimentId}`);
    if (exp0.status !== 'active') throw new DeviceError('experiment_archived', `Experiment ${experimentId} is ${exp0.status}`);
    if ('pause' in body) {
      this.store.tx(() => {
        const exp = this.loadExp(experimentId)!;
        if (exp.paused === 0) {
          exp.paused = 1;
          this.emit(exp, 'clock.paused', {sim_time_s: exp.sim_time_s});
          this.saveExp(exp);
        }
      });
      this.notify(experimentId, this.loadExp(experimentId)!.event_seq);
      return {paused: true, sim_time_s: this.loadExp(experimentId)!.sim_time_s};
    }
    if ('resume' in body) {
      this.store.tx(() => {
        const exp = this.loadExp(experimentId)!;
        if (exp.paused === 1) {
          exp.paused = 0;
          this.emit(exp, 'clock.resumed', {sim_time_s: exp.sim_time_s});
          this.saveExp(exp);
        }
      });
      this.notify(experimentId, this.loadExp(experimentId)!.event_seq);
      return {paused: false, sim_time_s: this.loadExp(experimentId)!.sim_time_s};
    }
    if ('speed' in body) {
      const speed = Number(body.speed);
      if (!(speed >= 0.1 && speed <= 3600)) throw new DeviceError('invalid_argument', 'speed must be within 0.1–3600');
      this.store.tx(() => {
        const exp = this.loadExp(experimentId)!;
        exp.speed = speed;
        this.emit(exp, 'clock.speed_changed', {speed});
        this.saveExp(exp);
      });
      this.notify(experimentId, this.loadExp(experimentId)!.event_seq);
      return {speed};
    }
    if ('clock_mode' in body) {
      const mode = body.clock_mode as ClockMode;
      if (mode !== 'lockstep' && mode !== 'realtime') throw new DeviceError('invalid_argument', 'clock_mode must be lockstep|realtime');
      return this.store.tx(() => {
        const exp = this.loadExp(experimentId)!;
        const run = this.nonEndedRun(experimentId);
        if (run) throw new DeviceError('clock_mode_locked', `Run ${run.id} is ${run.status}; clock_mode is locked while it exists`);
        exp.clock_mode = mode;
        this.saveExp(exp);
        return {clock_mode: mode};
      });
    }
    if ('step' in body) {
      return this.controlStep(experimentId, body.step as {until_sim_s?: number; until_idle?: boolean; steps?: number});
    }
    if ('reset' in body) {
      const resetBody = body.reset as {scenario_id?: string; seed?: number; clock_mode?: ClockMode};
      const created = this.reset(experimentId, resetBody);
      return {archived: created.old.experiment_id, experiment: created.fresh};
    }
    if ('hold' in body) {
      const hold = body.hold as {run_id: string; on: boolean};
      return {run: this.setHold(experimentId, hold.run_id, hold.on)};
    }
    throw new DeviceError('invalid_argument', 'Unknown control request');
  }

  /** Synchronous stepping (lockstep without an active run). */
  private controlStep(experimentId: string, step: {until_sim_s?: number; until_idle?: boolean; steps?: number}):
      Record<string, unknown> {
    const exp = this.loadExp(experimentId)!;
    if (exp.clock_mode !== 'lockstep') throw new DeviceError('clock_mode_mismatch', 'step is a lockstep control');
    if (exp.paused === 1) throw new DeviceError('simulation_paused', 'Resume the simulation before stepping');
    if (this.activeLease(experimentId)) throw new DeviceError('invalid_request', 'An active lease freezes the clock; step is unavailable');
    const run = this.nonEndedRun(experimentId);
    if (run) throw new DeviceError('invalid_request', 'step is only available without an active run (use release/leases)');
    const maxSteps = 200_000;
    let n = 0;
    if (step.until_idle) {
      while (this.nonTerminalActions(experimentId).length > 0 && n < maxSteps) {
        if (!this.stepOnce(experimentId)) break;
        n++;
      }
    } else if (step.until_sim_s != null) {
      const target = Number(step.until_sim_s);
      while (this.loadExp(experimentId)!.sim_time_s < target && n < maxSteps) {
        if (!this.stepOnce(experimentId)) break;
        n++;
      }
    } else if (step.steps != null) {
      const count = Math.min(Number(step.steps), maxSteps);
      while (n < count) {
        if (!this.stepOnce(experimentId)) break;
        n++;
      }
    } else {
      throw new DeviceError('invalid_argument', 'step requires until_sim_s, until_idle or steps');
    }
    const e2 = this.loadExp(experimentId)!;
    this.store.tx(() => {
      const e3 = this.loadExp(experimentId)!;
      this.emit(e3, 'clock.stepped', {steps: n, sim_time_s: e3.sim_time_s});
      this.saveExp(e3);
    });
    this.notify(experimentId, this.loadExp(experimentId)!.event_seq);
    return {sim_time_s: e2.sim_time_s, steps_executed: n};
  }

  // -- reset ----------------------------------------------------------------

  reset(experimentId: string, opts: {scenario_id?: string; seed?: number; clock_mode?: ClockMode}):
      {old: ExperimentInfo; fresh: ExperimentInfo} {
    const result = this.store.tx(() => {
      const old = this.loadExp(experimentId);
      if (!old) throw new DeviceError('not_found', `No experiment ${experimentId}`);
      if (old.status !== 'active') throw new DeviceError('experiment_archived', `Experiment ${experimentId} is ${old.status}`);
      old.status = 'archiving';
      this.saveExp(old);
      // Revoke lease + wakes.
      const lease = this.activeLease(experimentId);
      if (lease) {
        lease.state = 'revoked';
        this.saveLease(lease);
        this.emit(old, 'lease.revoked', {lease_id: lease.lease_id, run_id: lease.run_id, reason: 'experiment_reset'},
          {run_id: lease.run_id});
      }
      this.store.stmt('DELETE FROM wakes WHERE experiment_id=?').run(experimentId);
      // End the run.
      const run = this.nonEndedRun(experimentId);
      if (run) {
        this.store.stmt('UPDATE run_tokens SET revoked = 1 WHERE run_id = ?').run(run.id);
        run.status = 'ended';
        run.run.status = 'ended';
        run.run.reason = 'experiment_reset';
        this.saveRun(run);
        this.emit(old, 'run.ended', {run_id: run.id, reason: 'experiment_reset'}, {run_id: run.id});
      }
      // Cancel non-terminal actions with committed effects.
      const world = this.loadWorld(experimentId);
      for (const row of this.nonTerminalActions(experimentId)) {
        this.discardUncommitted(row, world, 'experiment_reset', old);
        row.action.status = 'cancelled';
        row.action.cancel_reason = 'experiment_reset';
        row.action.ended_at_sim_s = world.sim_time_s;
        row.action.partial = hasCommittedLiquidEffects(row.action);
        this.emit(old, 'action.cancelled', {action_id: row.id, cancel_reason: 'experiment_reset',
          partial: row.action.partial, summary: row.action.summary}, {action_id: row.id});
        this.saveAction(row);
      }
      // The archived snapshot must reflect the wind-down effects just recorded
      // (head discarded to waste, tips dropped, shake stopped).
      this.saveWorld(experimentId, world);
      // Archive and create the successor (same scenario/seed unless overridden).
      const scenarioId = opts.scenario_id ?? old.scenario_id;
      const seed = opts.seed ?? old.seed;
      const clockMode = opts.clock_mode ?? old.clock_mode;
      const successorId = `exp-${String(this.store.nextId('exp_counter')).padStart(3, '0')}`;
      this.emit(old, 'experiment.archived', {successor_id: successorId});
      old.status = 'archived';
      old.successor_id = successorId;
      old.is_current = 0;
      this.saveExp(old);
      const scenario = loadScenario(scenarioId);
      const fresh: ExpRow = {
        id: successorId, scenario_id: scenario.id, scenario_version: scenario.version,
        simulator_version: SIMULATOR_VERSION, seed, status: 'active', sim_time_s: 0, clock_mode: clockMode, paused: 0,
        speed: old.speed, reset_from: old.id, successor_id: null, determinism_broken: 0,
        created_at_wall: nowIso(), is_current: 1, event_seq: 0, act_counter: 0, obs_counter: 0, asset_counter: 0,
        run_counter: 0,
      };
      this.store.stmt(`INSERT INTO experiments (id, scenario_id, scenario_version, simulator_version, seed, status,
        sim_time_s, clock_mode, paused, speed, reset_from, successor_id, determinism_broken, created_at_wall, is_current,
        event_seq, act_counter, obs_counter, asset_counter, run_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(fresh.id, fresh.scenario_id, fresh.scenario_version, fresh.simulator_version, fresh.seed, fresh.status,
          fresh.sim_time_s, fresh.clock_mode, 0, fresh.speed, fresh.reset_from, null, 0, fresh.created_at_wall, 1, 0, 0, 0, 0, 0);
      this.saveWorld(fresh.id, createWorld(scenario, seed));
      this.emit(fresh, 'experiment.created', {experiment_id: fresh.id, scenario_id: scenario.id,
        scenario_version: scenario.version, seed, clock_mode: clockMode, reset_from: old.id,
        simulator_version: SIMULATOR_VERSION}, {sim_time_s: 0});
      this.saveExp(fresh);
      return {old: this.toExperimentInfo(old), fresh: this.toExperimentInfo(fresh)};
    });
    // Abort old in-memory tasks and notify both experiments' subscribers.
    const oldAbort = this.aborts.get(experimentId);
    oldAbort?.abort();
    this.aborts.delete(experimentId);
    this.aborts.set(result.fresh.experiment_id, new AbortController());
    this.notify(experimentId, this.loadExp(experimentId)?.event_seq ?? 0);
    this.notify(result.fresh.experiment_id, this.loadExp(result.fresh.experiment_id)?.event_seq ?? 0);
    return result;
  }

  // -- recovery -------------------------------------------------------------

  /** Startup recovery for a Runtime restart (§5). One transaction. */
  recoverOnStartup(): void {
    const rows = this.store.stmt("SELECT id FROM experiments WHERE status = 'active'").all() as {id: string}[];
    for (const {id} of rows) {
      this.store.tx(() => {
        const exp = this.loadExp(id)!;
        if (exp.status !== 'active') return;
        const world = this.loadWorld(id);
        for (const row of this.nonTerminalActions(id)) {
          // Keep committed effects; wind down the physical state the action
          // owned (shake, head load, tips) exactly like a cancel, then mark
          // failed(runtime_restarted). Locks are derived from status.
          this.discardUncommitted(row, world, 'runtime_restarted', exp);
          row.action.status = 'failed';
          row.action.ended_at_sim_s = world.sim_time_s;
          row.action.error = {code: 'runtime_restarted',
            message: 'Runtime restarted before the action reached a terminal state', retryable: false};
          row.action.partial = hasCommittedLiquidEffects(row.action);
          this.emit(exp, 'action.failed', {action_id: row.id, error: row.action.error,
            committed_effects: row.action.effects.length}, {action_id: row.id});
          this.saveAction(row);
        }
        this.saveWorld(id, world);
        const lease = this.activeLease(id);
        if (lease) {
          lease.state = 'revoked';
          this.saveLease(lease);
          this.emit(exp, 'lease.revoked', {lease_id: lease.lease_id, run_id: lease.run_id,
            reason: 'runtime_restarted'}, {run_id: lease.run_id});
        }
        this.store.stmt('DELETE FROM wakes WHERE experiment_id=?').run(id);
        for (const run of this.listRuns(id)) {
          if (run.status === 'ended') continue;
          const row = this.runById(run.run_id)!;
          row.status = 'paused';
          row.run.status = 'paused';
          row.run.reason = 'runtime_restarted';
          this.saveRun(row);
          this.emit(exp, 'run.paused', {run_id: run.run_id, reason: 'runtime_restarted'}, {run_id: run.run_id});
        }
        exp.paused = 1;
        this.emit(exp, 'clock.paused', {reason: 'runtime_restarted', sim_time_s: exp.sim_time_s});
        this.saveExp(exp);
      });
      this.store.diagnostic(id, 'runtime_restarted', 'startup recovery applied');
      this.notify(id, this.loadExp(id)?.event_seq ?? 0);
    }
  }

  // -- observations / assets / events ---------------------------------------

  getObservation(experimentId: string, obsId: string): Observation | undefined {
    const row = this.store.stmt('SELECT experiment_id, obs_json FROM observations WHERE id = ?')
      .get(obsId) as {experiment_id: string; obs_json: string} | undefined;
    if (!row || row.experiment_id !== experimentId) return undefined;
    return JSON.parse(row.obs_json) as Observation;
  }

  listObservations(experimentId: string): Observation[] {
    const rows = this.store.stmt('SELECT obs_json FROM observations WHERE experiment_id = ? ORDER BY rowid')
      .all(experimentId) as {obs_json: string}[];
    return rows.map(r => JSON.parse(r.obs_json) as Observation);
  }

  getAsset(experimentId: string, assetId: string): {bytes: Uint8Array; sha256: string} | undefined {
    const row = this.store.stmt('SELECT experiment_id, sha256, bytes FROM assets WHERE id = ?')
      .get(assetId) as {experiment_id: string; sha256: string; bytes: Uint8Array} | undefined;
    if (!row || row.experiment_id !== experimentId) return undefined;
    return {bytes: new Uint8Array(row.bytes), sha256: row.sha256};
  }

  eventsAfter(experimentId: string, afterSeq: number, limit: number): DeviceEvent[] {
    const rows = this.store.stmt('SELECT seq, sim_time_s, type, action_id, run_id, observation_id, payload FROM events WHERE experiment_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(experimentId, afterSeq, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      seq: Number(r.seq), experiment_id: experimentId, sim_time_s: Number(r.sim_time_s), type: String(r.type),
      action_id: r.action_id ? String(r.action_id) : null, run_id: r.run_id ? String(r.run_id) : null,
      observation_id: r.observation_id ? String(r.observation_id) : null,
      payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
    }));
  }

  lastEventSeq(experimentId: string): number {
    return this.loadExp(experimentId)?.event_seq ?? 0;
  }

  // -- snapshot -------------------------------------------------------------

  chamberReading(world: World): ChamberReading {
    const mk = (name: 'temperature_c' | 'co2_pct' | 'humidity_pct'): EnvChannel => {
      const target = world.chamber.targets[name];
      const observed = world.chamber.sample[name];
      return {target, observed, error: Math.round((observed - target) * 1e6) / 1e6,
        quality: world.chamber.sample.quality === 'ok' ? 'ok' : 'settling',
        sampled_at_sim_s: world.chamber.sample.sampled_at_sim_s};
    };
    return {
      chamber_id: CHAMBER_ID, target_revision: world.chamber.target_revision, provenance: 'synthetic_sensor',
      temperature_c: mk('temperature_c'), co2_pct: mk('co2_pct'), humidity_pct: mk('humidity_pct'),
      stable: environmentStableFor(world, DEMO_PROFILE.environment.stable_hold_s),
    };
  }

  snapshot(experimentId: string): StateSnapshot {
    const exp = this.loadExp(experimentId);
    if (!exp) throw new DeviceError('not_found', `No experiment ${experimentId}`);
    const world = this.loadWorld(experimentId);
    const plates: PlateState[] = world.plates.map(p => ({
      plate_id: p.plate_id, station_id: p.station_id, format: p.format, rows: p.rows, columns: p.columns,
      revision: p.revision,
      shake: {active: p.shake.active, started_at_sim_s: p.shake.started_at_sim_s, duration_sim_s: p.shake.duration_sim_s,
        speed_rpm: p.shake.speed_rpm, ended_at_sim_s: p.shake.ended_at_sim_s, action_id: p.shake.action_id},
      wells: p.wells.map(w => ({well_id: w.well_id, volume_ul: w.volume_ul, capacity_ul: w.capacity_ul, medium_id: w.medium_id})),
    }));
    const active = this.nonTerminalActions(experimentId).map(r => r.action);
    const busy = this.busyResources(experimentId);
    let head: StateSnapshot['head'] = null;
    for (const a of active) {
      if (!a.resources.includes('head')) continue;
      const idx = a.current_stage_index;
      const stage = idx != null ? a.stages[idx] : undefined;
      if (stage && stage.started_at_sim_s != null) head = {action_id: a.action_id, stage};
    }
    const lease = this.activeLease(experimentId);
    const run = this.nonEndedRun(experimentId) ?? this.latestRun(experimentId);
    const revisions: Record<string, number> = {[`chamber:${CHAMBER_ID}`]: world.chamber.target_revision};
    for (const p of world.plates) revisions[`plate:${p.plate_id}`] = p.revision;
    return {
      experiment: this.toExperimentInfo(exp), event_seq: exp.event_seq,
      device: {device_id: DEVICE_ID, mode: 'simulation', manifest_version: buildManifest().manifest_version, health: 'ok'},
      chamber: this.chamberReading(world), plates, reservoirs: world.reservoirs, wastes: world.wastes,
      tips: world.tip_racks.map(t => ({id: t.id, station_id: t.station_id, remaining: t.remaining, capacity: t.capacity})),
      busy_resources: busy, active_actions: active, head, lease: lease ? this.leaseWire(lease) : null,
      run: run?.run ?? null, revisions,
    };
  }

  latestRun(experimentId: string): RunRow | undefined {
    const r = this.store.stmt('SELECT * FROM runs WHERE experiment_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(experimentId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {id: String(r.id), experiment_id: experimentId, status: r.status as RunRow['status'],
      run: JSON.parse(String(r.run_json)) as RunRecord};
  }

  /** Operator-only debug view of the simulator truth (never in normal snapshots). */
  debugTruth(experimentId: string): Record<string, unknown> {
    const exp = this.requireExp(experimentId);
    const world = this.loadWorld(experimentId);
    return {experiment_id: exp.id, provenance: 'simulator_truth', sim_time_s: world.sim_time_s,
      chamber_actual: world.chamber.actual, wells: world.plates.map(p => ({
        plate_id: p.plate_id, revision: p.revision,
        wells: p.wells.map(w => ({well_id: w.well_id, volume_ul: w.volume_ul, evaporated_ul: w.evaporated_ul,
          culture: w.culture})),
      })), head: world.head, faults: world.faults, counters: world.counters};
  }

  requireExp(experimentId: string): ExpRow {
    const exp = this.loadExp(experimentId);
    if (!exp) throw new DeviceError('not_found', `No experiment ${experimentId}`);
    return exp;
  }

  close(): void {
    this.store.close();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function principalString(p: Principal): string {
  return p.kind === 'operator' ? 'operator' : p.kind === 'run' ? `run:${p.run_id}` : 'service';
}

export function isDeviceWrite(capability: string): boolean {
  return ['media.add', 'media.exchange', 'imaging.scan', 'plate.shake', 'environment.set_targets',
    'environment.await_stable'].includes(capability);
}

export function hasCommittedLiquidEffects(action: Action): boolean {
  return action.effects.some(e => e.wells?.length || e.reservoir || e.waste || e.tips || e.chamber_targets);
}

export function stageDuration(stage: string): number {
  const d = (DEMO_PROFILE.stage_s as Record<string, number>)[stage];
  return d ?? 1;
}

function rowWellsSim(world: World, plateId: string, rowId: string): import('@oscar/simulator').WellSim[] {
  const plate = findPlate(world, plateId);
  if (!plate) throw new DeviceError('internal', `plate ${plateId} vanished`);
  return plate.wells.filter(w => w.well_id.startsWith(rowId));
}

export function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scenarioGoal(scenarioId: string): string {
  try {
    return loadScenario(scenarioId).task.goal;
  } catch {
    return '';
  }
}
