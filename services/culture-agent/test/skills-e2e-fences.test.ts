// N01 regressions (reports/review/long-lived-r08-independent-review.md): the
// async plan/step tools must re-run the FULL revocation check after their LAST
// await (Runtime /state read, evidence reads) and immediately before the store
// write, and the writes themselves must be CAS (plan: task goal_revision; step:
// step_id + plan_revision + prior status). Each scenario holds the Runtime
// /state fetch exactly like the independent-review oracle does, mutates the
// revocation fact while the old turn is parked inside the tool, then asserts
// the tool REFUSED and the DATABASE IS UNCHANGED.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '@oscar/device-contract';
import {AgentStore} from '../src/store.ts';
import {SessionStore} from '../src/session-store.ts';
import {SessionManager} from '../src/session-manager.ts';
import {normalizeGoalSpec} from '../src/goal.ts';
import type {SessionScheduler} from '../src/scheduler.ts';
import type {AgentBackend, TurnOutput} from '../src/backend.ts';
import {spawnRuntimeProc, waitFor} from './procs.ts';

const spec = normalizeGoalSpec({
  description: 'N01 fence row A',
  scope: {plates: ['plate-01'], rows: ['A']},
  metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'}],
  allowed_operations: ['imaging.scan', 'media.add', 'plate.shake'],
  monitoring: {interval_sim_s: 21_600},
});

const gate = (): {promise: Promise<void>; resolve: () => void} => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(r => {resolve = r;});
  return {promise, resolve};
};

const output = (effects: Partial<TurnOutput['effects']> = {}): TurnOutput => ({ok: true, assistantText: 'ack',
  toolLog: [], usage: {requests: 1, inputTokens: 0, outputTokens: 0},
  effects: {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null,
    goalUpdated: null, planUpdated: false, stopRequested: false, ...effects}});

const backend = (fn: AgentBackend['runTurn']): AgentBackend => ({id: 'explicit-n01-fence-backend',
  available: () => ({ok: true}),
  capabilities: () => ({tools: true, images: false, streaming: false, compaction: true}),
  runTurn: fn, compact: () => ({summary: '', facts: [], open_questions: []}), close: async () => undefined});

/** Fetch wrapper that parks the FIRST /state read after arm() (oracle pattern). */
function holdableFetch(): {fetchImpl: typeof fetch; entered: Promise<void>; release: () => void; arm: () => void} {
  const entered = gate();
  const releaseGate = gate();
  let hold = false;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const shouldHold = hold && new URL(String(url)).pathname.endsWith('/state');
    if (shouldHold) hold = false;
    const response = await fetch(url, init);
    if (shouldHold) {entered.resolve(); await releaseGate.promise;}
    return response;
  };
  return {fetchImpl, entered: entered.promise, release: releaseGate.resolve, arm: () => {hold = true;}};
}

interface Ctx {
  dir: string;
  agentStore: AgentStore;
  store: SessionStore;
  session: {session_id: string};
  task: {task_id: string; goal_revision: number};
  manager: SessionManager | null;
}

test('N01 fences: replacePlan re-checks revocation after its state read (goal edit, cancel, agent pause, ownership, archive)', {timeout: 180_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 20_000});
  const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken, timeoutMs: 20_000});
  const exp = await operator.currentExperimentId();
  await operator.control(exp, {speed: 600});
  const health = await client.health() as {instance_id?: string};
  const contexts: Ctx[] = [];
  const context = (): Ctx => {
    const dir = mkdtempSync(join(tmpdir(), 'oscar-n01-fence-'));
    const agentStore = new AgentStore(dir);
    const store = new SessionStore(agentStore.db);
    const session = store.createSession({runtime_instance_id: health.instance_id ?? 'rt-n01', experiment_id: exp});
    const task = store.createTask(session.session_id, {goal_text: 'N01 fence', goal_spec: spec as unknown as Record<string, unknown>});
    const c: Ctx = {dir, agentStore, store, session, task, manager: null};
    contexts.push(c);
    return c;
  };
  const manage = (c: Ctx, fn: AgentBackend['runTurn'], fetchImpl: typeof fetch) => {
    c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
      getServiceToken: () => runtime.serviceToken, backend: backend(fn), fetchImpl, log: () => undefined});
    return c.manager.ensureScheduler(c.store.getSession(c.session.session_id)!);
  };
  /** Runs one replacePlan-under-hold scenario; `mutate` runs while parked. */
  const scenario = async (label: string, mutate: (c: Ctx) => void, check: (c: Ctx) => void): Promise<void> => {
    const c = context();
    const h = holdableFetch();
    let result: {ok: boolean; code?: string} | null = null;
    manage(c, async (_input, host) => {
      if (!result) {
        h.arm();
        result = await host.replacePlan([{skill: 'monitor_until', skill_version: '1', inputs: {until_sim_s: 1000}}]);
      }
      return output();
    }, h.fetchImpl);
    await h.entered;
    mutate(c);
    h.release();
    await waitFor(() => result ?? null, {timeoutMs: 15_000, label: `${label}: tool returned`});
    assert.equal(result!.ok, false, `${label}: the late tool must refuse`);
    assert.equal(result!.code, 'stale_turn', `${label}: refused as a stale turn (got ${result!.code})`);
    check(c);
    await c.manager!.stopAll();
  };

  try {
    // goal edit: the user already saved a NEW plan for goal revision 2 — the
    // old turn's plan (revision 1) must not clobber it
    await scenario('goal edit', c => {
      c.store.updateTaskGoal(c.task.task_id, {expected_revision: 1, goal_text: 'r2 goal'});
      c.store.replacePlan(c.task.task_id, 2,
        [{skill: 'monitor_until', skill_version: '1', inputs: {until_sim_s: 2000}}]);
    }, c => {
      const plan = c.store.listPlanSteps(c.task.task_id);
      assert.equal(plan[0].plan_revision, 2, 'the newer goal revision 2 plan survives');
      assert.equal((plan[0].inputs as {until_sim_s: number}).until_sim_s, 2000);
    });

    // task cancel: nothing may be written for a cancelled task
    await scenario('task cancel', c => {
      c.store.updateTaskStatus(c.task.task_id, 'cancelled', 'operator');
    }, c => {
      assert.equal(c.store.listPlanSteps(c.task.task_id).length, 0, 'no plan rows were persisted');
    });

    // agent pause (operator): persisted first, re-read by the in-flight tool
    await scenario('agent pause', c => {
      c.store.updateSession(c.session.session_id, {agent_paused: true});
    }, c => {
      assert.equal(c.store.listPlanSteps(c.task.task_id).length, 0, 'no plan rows were persisted');
    });

    // ownership change: a newer scheduler generation owns the session now
    await scenario('ownership change', c => {
      const generation = c.store.claimOwnership(c.session.session_id);
      assert.ok(generation >= 2, 'the generation moved past the running scheduler');
    }, c => {
      assert.equal(c.store.listPlanSteps(c.task.task_id).length, 0, 'no plan rows were persisted');
    });

    // archive: an archived session accepts no plan writes
    await scenario('archive', c => {
      c.store.archiveSession(c.session.session_id, 'explicit test archive');
    }, c => {
      assert.equal(c.store.listPlanSteps(c.task.task_id).length, 0, 'no plan rows were persisted');
    });
  } finally {
    for (const c of contexts) {
      if (c.manager) await c.manager.stopAll();
      c.agentStore.close();
      rmSync(c.dir, {recursive: true, force: true});
    }
    await runtime.stop();
  }
});

test('N01 fences: updateStep re-checks revocation after evidence verification (goal edit, task pause, concurrent plan replacement)', {timeout: 180_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 20_000});
  const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken, timeoutMs: 20_000});
  const exp = await operator.currentExperimentId();
  await operator.control(exp, {speed: 600});
  const health = await client.health() as {instance_id?: string};
  const contexts: Ctx[] = [];
  const context = (): Ctx => {
    const dir = mkdtempSync(join(tmpdir(), 'oscar-n01-step-fence-'));
    const agentStore = new AgentStore(dir);
    const store = new SessionStore(agentStore.db);
    const session = store.createSession({runtime_instance_id: health.instance_id ?? 'rt-n01b', experiment_id: exp});
    const task = store.createTask(session.session_id, {goal_text: 'N01 step fence', goal_spec: spec as unknown as Record<string, unknown>});
    // a monitor step whose verification WILL pass (deadline 0, wake fired and
    // bound to the step at the current goal revision) — only the revocation
    // re-check can stop the write
    const rows = store.replacePlan(task.task_id, 1,
      [{skill: 'monitor_until', skill_version: '1', inputs: {until_sim_s: 0}}])!;
    const wake = store.armWake({session_id: session.session_id, task_id: task.task_id,
      kind: 'sim_time', target_sim_s: 0, goal_revision: 1, step_id: rows[0].step_id});
    store.fireWake(wake.wake_id);
    const c: Ctx = {dir, agentStore, store, session, task, manager: null};
    contexts.push(c);
    return c;
  };
  const manage = (c: Ctx, fn: AgentBackend['runTurn'], fetchImpl: typeof fetch) => {
    c.manager = new SessionManager({store: c.store, runtimeUrl: runtime.baseUrl,
      getServiceToken: () => runtime.serviceToken, backend: backend(fn), fetchImpl, log: () => undefined});
    return c.manager.ensureScheduler(c.store.getSession(c.session.session_id)!);
  };
  const scenario = async (label: string, mutate: (c: Ctx) => void, check: (c: Ctx) => void): Promise<void> => {
    const c = context();
    const h = holdableFetch();
    let result: {ok: boolean; code?: string} | null = null;
    manage(c, async (_input, host) => {
      if (!result) {
        h.arm();
        result = await host.updateStep(0, {status: 'done'});
      }
      return output();
    }, h.fetchImpl);
    await h.entered;
    mutate(c);
    h.release();
    await waitFor(() => result ?? null, {timeoutMs: 15_000, label: `${label}: tool returned`});
    assert.equal(result!.ok, false, `${label}: the late tool must refuse`);
    assert.equal(result!.code, 'stale_turn', `${label}: refused as a stale turn (got ${result!.code})`);
    check(c);
    await c.manager!.stopAll();
  };

  try {
    // goal edit during postcondition verification: the r1 step stays pending
    await scenario('goal edit', c => {
      c.store.updateTaskGoal(c.task.task_id, {expected_revision: 1, goal_text: 'r2 deadline'});
    }, c => {
      const step = c.store.listPlanSteps(c.task.task_id)[0];
      assert.equal(step.status, 'pending', 'the old-revision step was not written');
      assert.equal(step.verification, null, 'no verification was persisted');
    });

    // task pause during postcondition verification
    await scenario('task pause', c => {
      c.store.updateTaskStatus(c.task.task_id, 'paused', 'operator');
    }, c => {
      const step = c.store.listPlanSteps(c.task.task_id)[0];
      assert.equal(step.status, 'pending');
      assert.equal(step.verification, null);
    });

    // concurrent plan replacement: the step the tool decided against was
    // deleted and re-created by a NEWER plan; the CAS write must miss
    await scenario('concurrent plan replacement', c => {
      const rows = c.store.replacePlan(c.task.task_id, 1,
        [{skill: 'scan_and_assess', skill_version: '1', inputs: {plate_id: 'plate-01', row_id: 'A'}}])!;
      assert.ok(rows, 'the concurrent replacement itself succeeded (same goal revision)');
    }, c => {
      const plan = c.store.listPlanSteps(c.task.task_id);
      assert.equal(plan.length, 1);
      assert.equal(plan[0].skill, 'scan_and_assess', 'the newer plan is intact');
      assert.equal(plan[0].status, 'pending', 'the new step was untouched');
      assert.equal(plan[0].verification, null, 'no verification leaked onto the new step');
    });
  } finally {
    for (const c of contexts) {
      if (c.manager) await c.manager.stopAll();
      c.agentStore.close();
      rmSync(c.dir, {recursive: true, force: true});
    }
    await runtime.stop();
  }
});

// -- S02/S03: completion-gate evidence versioning and target validity -----------------------
//
// S02 (reports/review/long-lived-q04-independent-review.md §2): a monitor_until
// step verified under goal revision r1 must NOT complete the task once the
// goal is edited to r2 — the old proof is history until a wait is re-armed and
// re-verified under r2. The complete_task TOOL and the runTurn EFFECT path
// enforce the same decision; both are asserted here, plus the positive control
// (r1 evidence still completes r1) and the recovered r2 lifecycle.
test('S02 completion gate: old-revision monitor evidence cannot complete the revised goal; a re-verified r2 wait can', {timeout: 240_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 20_000});
  const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken, timeoutMs: 20_000});
  const exp = await operator.currentExperimentId();
  // speed 1 keeps the scheduler's refused-completion re-decide wake (sim+60)
  // 60 wall seconds away, so phases advance only on the explicit triggers
  await operator.control(exp, {speed: 1});
  const health = await client.health() as {instance_id?: string};
  const dir = mkdtempSync(join(tmpdir(), 'oscar-s02-gate-'));
  const agentStore = new AgentStore(dir);
  const store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: health.instance_id ?? 'rt-s02', experiment_id: exp});
  const condition = {metric: 'temperature_c', op: 'below', value: 38,
    debounce_sim_s: 0, hysteresis: 0, cooldown_sim_s: 0};
  const r1Spec = normalizeGoalSpec({description: 'wait for temperature <38 (r1)',
    scope: {plates: ['plate-01']}, metrics: [], allowed_operations: ['imaging.scan'],
    monitoring: {conditions: [condition]}});
  const r2Spec = normalizeGoalSpec({description: 'wait again, now debounce 600 sim seconds (r2)',
    scope: {plates: ['plate-01']}, metrics: [], allowed_operations: ['imaging.scan'],
    monitoring: {conditions: [{...condition, debounce_sim_s: 600}]}});
  const task = store.createTask(session.session_id,
    {goal_text: r1Spec.description, goal_spec: r1Spec as unknown as Record<string, unknown>});
  let phase = 0;
  const seen: {before?: {ok: boolean}; after?: {ok: boolean; code?: string; reasons?: string[]};
    gate?: {ok: boolean}} = {};
  const wakeIds: string[] = [];
  const monitorStep = [{skill: 'monitor_until', skill_version: '1',
    inputs: {condition: {metric: condition.metric, op: condition.op, value: condition.value}}}];
  const manager = new SessionManager({store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken,
    backend: backend(async (_input, host) => {
      if (phase === 0) {
        phase = 1;
        const plan = await host.replacePlan(monitorStep);
        assert.equal(plan.ok, true, JSON.stringify(plan));
        const wake = host.armWake({kind: 'condition', predicate: condition,
          reason: 'r1 wait for temperature', step_index: 0});
        assert.equal(wake.status, 'armed');
        wakeIds.push(wake.wake_id);
        return output();
      }
      if (phase === 1) {
        phase = 2;
        // the r1 wake fired: the step verifies under goal revision 1
        const done = await host.updateStep(0, {status: 'done'});
        assert.equal(done.ok, true, JSON.stringify(done));
        seen.before = await host.completeGate([]);
        assert.equal(seen.before.ok, true, 'POSITIVE CONTROL: r1 monitor evidence must complete the r1 goal');
        // the model revises the goal (same threshold, 600 s debounce) via the
        // production tool; NO r2 wake/verification exists yet
        const upd = host.updateTaskGoal({expected_revision: 1, goal_text: r2Spec.description,
          goal_spec: r2Spec as unknown as Record<string, unknown>});
        assert.equal(upd.ok, true);
        seen.after = await host.completeGate([]);
        // claim completion anyway: the EFFECT path must refuse the same way
        return output({taskCompleted: {summary: 'claimed complete on stale r1 evidence', evidence_refs: []}});
      }
      if (phase === 2) {
        phase = 3;
        const plan = await host.replacePlan(monitorStep);
        assert.equal(plan.ok, true, JSON.stringify(plan));
        // r2's goal requires a 600s hold; re-arming the r1 debounce of 0 is not
        // success evidence (T01) — the recovered wait must carry the new debounce
        const wake = host.armWake({kind: 'condition', predicate: {...condition, debounce_sim_s: 600},
          reason: 'r2 wait for temperature', step_index: 0});
        assert.equal(wake.status, 'armed');
        wakeIds.push(wake.wake_id);
        return output();
      }
      phase = 4;
      const done = await host.updateStep(0, {status: 'done'});
      assert.equal(done.ok, true, JSON.stringify(done));
      seen.gate = await host.completeGate([]);
      return output({taskCompleted: {summary: 'r2 wait verified under the current revision', evidence_refs: []}});
    }), log: () => undefined});
  const scheduler = manager.ensureScheduler(store.getSession(session.session_id)!)!;
  const turns = (): number => store.sessionEventsAfter(session.session_id, 0, 1_000)
    .filter(e => e.type === 'turn.completed').length;
  try {
    // phase 0: plan + armed r1 wake
    await waitFor(() => turns() >= 1 ? true : null, {timeoutMs: 30_000, label: 'phase 0: r1 plan + wake'});
    // fire the r1 condition wake (the same store primitive the condition
    // evaluator calls) and run the verifying turn
    store.fireWake(wakeIds[0]!);
    scheduler.onUserMessage();
    await waitFor(() => turns() >= 2 ? true : null, {timeoutMs: 30_000, label: 'phase 1: r1 verified, goal edited to r2'});
    // TOOL refusal: no r2 proof exists — the r1 evidence is history
    assert.equal(seen.after!.ok, false, 'old-revision monitor evidence must not complete the revised goal');
    assert.equal(seen.after!.code, 'goal_unverified', `got ${seen.after!.code}`);
    assert.match(seen.after!.reasons!.join(' '), /revision 1/,
      'the refusal names the stale evidence revision');
    assert.match(seen.after!.reasons!.join(' '), /re-register and verify the wait under revision 2/,
      'the refusal demands re-registering/verifying the wait under the current revision');
    // EFFECT refusal: the task stays open despite taskCompleted in the output
    assert.notEqual(store.getTask(task.task_id)!.status, 'completed',
      'the turn effect must not complete the task on stale r1 evidence');
    // phase 2: re-plan under r2 and arm a NEW wait bound to the new step
    scheduler.onUserMessage();
    await waitFor(() => turns() >= 3 ? true : null, {timeoutMs: 30_000, label: 'phase 2: r2 plan + wake'});
    assert.equal(store.getTask(task.task_id)!.goal_revision, 2);
    assert.equal(store.listPlanSteps(task.task_id)[0]!.plan_revision, 2,
      'the re-planned step carries the current goal revision');
    // phase 3: fire the r2 wake, verify, complete — the recovered lifecycle
    store.fireWake(wakeIds[1]!);
    scheduler.onUserMessage();
    await waitFor(() => turns() >= 4 ? true : null, {timeoutMs: 30_000, label: 'phase 3: r2 verified'});
    assert.equal(seen.gate!.ok, true, 'a wait verified under the CURRENT revision completes the goal');
    await waitFor(() => store.getTask(task.task_id)?.status === 'completed' ? true : null,
      {timeoutMs: 30_000, label: 'task completed on verified r2 evidence'});
    const plan = store.listPlanSteps(task.task_id);
    assert.equal(plan[0]!.plan_revision, 2);
    assert.equal(plan[0]!.verification!.pass, true);
    assert.equal((plan[0]!.verification!.evidence as {wake_goal_revision?: number}).wake_goal_revision, 2,
      'the persisted proof names the r2 wake revision');
  } finally {
    await manager.stopAll();
    agentStore.close();
    rmSync(dir, {recursive: true, force: true});
    await runtime.stop();
  }
});

// S03: a metric whose target row/plate/well does not exist in the AUTHORITATIVE
// layout must refuse completion (goal_unverified, naming the invalid target)
// instead of filtering the target into an empty list and "verifying" zero
// wells. Tool and turn effect both refuse; the task never completes.
test('S03 completion gate: a nonexistent metric target cannot complete with zero checked wells', {timeout: 180_000}, async () => {
  const runtime = await spawnRuntimeProc({clockMode: 'realtime'});
  const operator = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.operatorToken, timeoutMs: 20_000});
  const client = new DeviceClient({baseUrl: runtime.baseUrl, token: runtime.serviceToken, timeoutMs: 20_000});
  const exp = await operator.currentExperimentId();
  await operator.control(exp, {speed: 1});
  const health = await client.health() as {instance_id?: string};
  const liveRows = (await client.state(exp)).plates.find(p => p.plate_id === 'plate-01')!.rows;
  assert.ok(!liveRows.includes('Z'), 'control: the scenario really has no row Z');
  const dir = mkdtempSync(join(tmpdir(), 'oscar-s03-gate-'));
  const agentStore = new AgentStore(dir);
  const store = new SessionStore(agentStore.db);
  const session = store.createSession({runtime_instance_id: health.instance_id ?? 'rt-s03', experiment_id: exp});
  const goal = normalizeGoalSpec({description: 'row Z >=1000 µL',
    scope: {plates: ['plate-01'], rows: ['Z']},
    metrics: [{metric: 'medium_volume_ul', op: '>=', value: 1000, source: 'observation', row_id: 'Z'}],
    allowed_operations: ['imaging.scan']});
  const task = store.createTask(session.session_id,
    {goal_text: goal.description, goal_spec: goal as unknown as Record<string, unknown>});
  let verdict: {ok: boolean; code?: string; reasons?: string[]} | null = null;
  const manager = new SessionManager({store, runtimeUrl: runtime.baseUrl,
    getServiceToken: () => runtime.serviceToken,
    backend: backend(async (_input, host) => {
      if (!verdict) verdict = await host.completeGate([]);
      return output({taskCompleted: {summary: 'claimed row Z complete with zero checks', evidence_refs: []}});
    }), log: () => undefined});
  manager.ensureScheduler(store.getSession(session.session_id)!)!;
  try {
    await waitFor(() => (verdict !== null
      && store.sessionEventsAfter(session.session_id, 0, 1_000)
        .some(e => e.type === 'turn.completed')) ? true : null,
      {timeoutMs: 30_000, label: 'completion attempt on the row-Z goal'});
    assert.equal(verdict!.ok, false, 'a nonexistent target row must not complete the goal');
    assert.equal(verdict!.code, 'goal_unverified', `got ${verdict!.code}`);
    assert.match(verdict!.reasons!.join(' '), /row 'Z' does not exist/,
      'the refusal names the invalid target');
    assert.match(verdict!.reasons!.join(' '), /no verifiable well range/,
      'the refusal says the metric has nothing checkable');
    assert.notEqual(store.getTask(task.task_id)!.status, 'completed',
      'the turn effect must not complete the task either');
  } finally {
    await manager.stopAll();
    agentStore.close();
    rmSync(dir, {recursive: true, force: true});
    await runtime.stop();
  }
});
