// Demo runner: `npm run demo:all`.
//
// For each of the three scripted scenarios plus one anomaly-recovery demo it
// spawns a FRESH Runtime + Culture Agent on an isolated temp data dir, starts
// a scripted run through the gateway (operator token), waits for the run to
// end, then verifies explicit pass criteria THROUGH THE API (never by trusting
// the agent's own claims). Writes reports/demo/<demo>.json, summary.json and
// summary.md. Exit code is non-zero when any criterion fails. Child processes
// are always killed (also on failure/timeout); temp dirs removed unless --keep.
//
// The speed-1 vs speed-600 determinism check lives in
// tests/system/agent-determinism.test.ts (real processes, asserted in CI).
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer as netServer, type AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {DeviceClient, isTerminal, type Action, type DeviceEvent, type Observation, type StateSnapshot} from '@oscar/device-contract';
import {loadScenario} from '@oscar/simulator';
import {waitLine} from './proc-lines.ts';

const repoRoot = join(import.meta.dirname, '..');

const {values} = parseArgs({
  args: process.argv.slice(2),
  options: {
    'out-dir': {type: 'string'},
    keep: {type: 'boolean', default: false},
    only: {type: 'string'},
  },
  strict: false,
});
const outDir = isAbsolute(String(values['out-dir'] ?? '')) ? String(values['out-dir'])
  : resolve(repoRoot, String(values['out-dir'] ?? 'reports/demo'));
const keep = Boolean(values.keep);
const only = values.only ? String(values.only) : null;
const SPEED = 600; // wall pacing for lockstep runs (display only; sim results are speed-independent)
const RUN_TIMEOUT_MS = 120_000;

interface Criterion {name: string; pass: boolean; detail: string}
interface DemoResult {
  demo: string;
  scenario: string;
  seed: number;
  outcome: 'pass' | 'fail';
  run_id: string | null;
  experiment_id: string | null;
  criteria: Criterion[];
  commands: string[];
  actions: Array<{action_id: string; capability: string; status: string}>;
  observations: string[];
  agent_report: Record<string, unknown> | null;
  inventory?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise(resolvePromise => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolvePromise(port));
    });
  });
}


/** One isolated Runtime+Agent pair. */
class Stack {
  readonly name: string;
  readonly dataDir: string;
  private runtimeUrlValue = '';
  get runtimeUrl(): string { return this.runtimeUrlValue; }
  operator: DeviceClient | null = null;
  private agentProc: ChildProcess | null = null;
  private runtimeProc: ChildProcess | null = null;
  private agentPort = 0;
  private runtimePort = 0;

  readonly env: Record<string, string>;
  constructor(name: string, env: Record<string, string> = {}) {
    this.name = name;
    this.env = env;
    this.dataDir = mkdtempSync(join(tmpdir(), `oscar-demo-${name}-`));
  }

  async start(scenario: string, seed: number, clockMode: 'lockstep' | 'realtime' = 'lockstep'): Promise<void> {
    const rtPort = await freePort();
    this.runtimePort = rtPort;
    this.runtimeUrlValue = `http://127.0.0.1:${rtPort}`;
    // The agent binds immediately (OSCAR_AGENT_LISTENING) and waits for the
    // service token; its READY line appears once the Runtime is up.
    this.agentProc = spawn(process.execPath, ['services/culture-agent/src/main.ts', '--port', '0',
      '--data-dir', this.dataDir, '--runtime-url', this.runtimeUrl], {cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...this.env}});
    const listening = await waitLine(this.agentProc, 'OSCAR_AGENT_LISTENING ');
    this.agentPort = (JSON.parse(listening.slice('OSCAR_AGENT_LISTENING '.length)) as {port: number}).port;
    this.runtimeProc = spawn(process.execPath, ['services/runtime/src/main.ts', '--port', String(rtPort),
      '--data-dir', this.dataDir, '--scenario', scenario, '--seed', String(seed), '--clock-mode', clockMode,
      '--agent-url', `http://127.0.0.1:${this.agentPort}`], {cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ...this.env}});
    await waitLine(this.runtimeProc, 'OSCAR_RUNTIME_READY ');
    await waitLine(this.agentProc, 'OSCAR_AGENT_READY ');
    const operatorToken = readFileSync(join(this.dataDir, 'runtime', 'operator.token'), 'utf8').trim();
    this.operator = new DeviceClient({baseUrl: this.runtimeUrl, token: operatorToken, timeoutMs: 15_000});
  }

  /** Restart the agent on the SAME data dir and port (anomaly demo). */
  async restartAgent(): Promise<void> {
    this.agentProc = spawn(process.execPath, ['services/culture-agent/src/main.ts',
      '--port', String(this.agentPort), '--data-dir', this.dataDir, '--runtime-url', this.runtimeUrl],
      {cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...this.env}});
    await waitLine(this.agentProc, 'OSCAR_AGENT_READY ');
  }

  killAgent9(): void {
    this.agentProc?.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    for (const p of [this.agentProc, this.runtimeProc]) {
      if (p && p.exitCode == null && !p.killed) {
        p.kill('SIGTERM');
        await new Promise<void>(r => {
          const t = setTimeout(() => { p.kill('SIGKILL'); r(); }, 3000);
          p.on('exit', () => { clearTimeout(t); r(); });
        });
      }
    }
    if (!keep) {
      try { rmSync(this.dataDir, {recursive: true, force: true}); } catch { /* ignore */ }
    }
  }
}

// -- helpers over the operator API -------------------------------------------

async function createRun(stack: Stack, mode: 'scripted' | 'llm' = 'scripted'):
  Promise<{run_id: string; experiment_id: string}> {
  const client = stack.operator!;
  const exp = await client.currentExperimentId();
  const r = await client.request<{run: {run_id: string}}>('POST', '/api/v1/agent/runs',
    {experiment_id: exp, mode});
  return {run_id: r.body.run.run_id, experiment_id: exp};
}

async function agentRunDetail(stack: Stack, runId: string): Promise<Record<string, unknown>> {
  const r = await stack.operator!.request<Record<string, unknown>>('GET', `/api/v1/agent/runs/${runId}`);
  return r.body;
}

async function waitRunEnded(stack: Stack, runId: string, timeoutMs = RUN_TIMEOUT_MS):
  Promise<{status: string; report?: unknown}> {
  const start = Date.now();
  for (;;) {
    const detail = await agentRunDetail(stack, runId);
    if (detail.status === 'ended') return detail as {status: string};
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} did not end within ${timeoutMs} ms (status ${String(detail.status)})`);
    await sleep(150);
  }
}

async function runtimeRunRecord(stack: Stack, runId: string): Promise<{status: string; reason: string | null;
  determinism_broken: boolean}> {
  return (await stack.operator!.request<{status: string; reason: string | null; determinism_broken: boolean}>(
    'GET', `/api/v1/runs/${runId}`)).body;
}

async function agentEvents(stack: Stack, runId: string): Promise<Array<{type: string; payload: Record<string, unknown>}>> {
  const r = await stack.operator!.request<{events: Array<{type: string; payload: Record<string, unknown>}>}>(
    'GET', `/api/v1/agent/runs/${runId}/events?format=json&limit=5000`);
  return r.body.events;
}

async function allEvents(stack: Stack, exp: string): Promise<DeviceEvent[]> {
  const out: DeviceEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await stack.operator!.events(exp, after, 5000);
    out.push(...page.events);
    if (page.events.length < 5000) return out;
    after = page.events.at(-1)!.seq;
  }
}

function rowVolumes(state: StateSnapshot, plateId: string, row: string): Record<string, number> {
  const plate = state.plates.find(p => p.plate_id === plateId);
  const out: Record<string, number> = {};
  for (const w of plate?.wells ?? []) if (w.well_id.startsWith(row)) out[w.well_id] = w.volume_ul;
  return out;
}

const evapTol = 0.5; // µL drift tolerated for untouched wells (evaporation over the demo run)

function check(criteria: Criterion[], name: string, pass: boolean, detail: string): void {
  criteria.push({name, pass, detail});
}

// -- per-demo verifiers --------------------------------------------------------

async function verifyRoutine(stack: Stack, runId: string, exp: string): Promise<Criterion[]> {
  const criteria: Criterion[] = [];
  const client = stack.operator!;
  const scenario = loadScenario('routine_maintenance');
  const band = (scenario.task.policy_hints.target_band_ul ?? [600, 900]) as [number, number];
  const lo = band[0];
  const hi = band[1];
  const focus = scenario.task.policy_hints.focus as {plate_id: string; row_id: string};
  const actions = (await client.actions(exp)).actions;
  const observations: Observation[] = (await client.request<{observations: Observation[]}>('GET',
    `/api/v1/experiments/${exp}/observations`)).body.observations;
  const state = await client.state(exp);
  const adds = actions.filter(a => a.capability === 'media.add');
  const rowVols = rowVolumes(state, focus.plate_id, focus.row_id);
  const values = Object.values(rowVols);
  check(criteria, 'focus row within target band after run',
    values.length === 6 && values.every(v => v >= lo && v <= hi),
    `row ${focus.row_id} volumes ${values.map(v => v.toFixed(1)).join(', ')} µL vs band ${lo}–${hi}`);
  const expectedReservoir = adds.reduce((acc, a) => acc + Math.abs(a.summary.reservoir_delta_ul), 0);
  const reservoirDelta = reservoirDeltaOf(state);
  check(criteria, 'reservoir decreased by exactly Σ added',
    Math.abs(expectedReservoir - reservoirDelta) < 1e-6,
    `Σ|reservoir_delta_ul|=${expectedReservoir.toFixed(3)} vs snapshot delta=${reservoirDelta.toFixed(3)} µL`);
  const tipsUsed = tipsUsedOf(state);
  check(criteria, 'tips decreased by 6 per pickup (6 per media.add)',
    adds.length === 1 && tipsUsed === 6 * adds.length,
    `tips used ${tipsUsed} for ${adds.length} media.add action(s)`);
  const otherChanged = otherWellDeltas(state, focus.plate_id, focus.row_id);
  check(criteria, 'other rows / other plate unchanged (± evaporation)',
    otherChanged.every(d => Math.abs(d.delta) <= evapTol),
    otherChanged.filter(d => Math.abs(d.delta) > evapTol).map(d => `${d.well}:${d.delta.toFixed(3)}`).join(', ') || 'all within tolerance');
  const add = adds[0];
  const rescan = observations.find(o => o.plate_id === focus.plate_id && coversRow(o, focus.row_id)
    && add && o.sampled_at_sim_s > (add.ended_at_sim_s ?? Infinity));
  check(criteria, 'rescan observation after the add cites the row wells',
    Boolean(rescan) && coversRow(rescan!, focus.row_id) === true,
    rescan ? `${rescan!.observation_id} at sim ${rescan!.sampled_at_sim_s} s covers ${rescan!.wells.join(',')}` : 'no rescan found');
  const evidenceOk = adds.every(a => {
    if (a.evidence_refs.length === 0) return false;
    return a.evidence_refs.every(ref => observations.some(o => o.observation_id === ref && coversRow(o, focus.row_id)));
  });
  check(criteria, 'every liquid action cites a fresh observation covering the row',
    adds.length > 0 && evidenceOk,
    adds.map(a => `${a.action_id} -> [${a.evidence_refs.join(', ')}]`).join('; '));
  const report = await client.request<{report: unknown}>('GET', `/api/v1/runs/${runId}/report`).catch(() => null);
  check(criteria, 'final report present on the Runtime', report != null && report.status === 200,
    report ? 'GET /api/v1/runs/{id}/report 200' : 'report endpoint failed');
  return criteria;
}

function coversRow(o: Observation, row: string): boolean {
  return o.wells.length === 6 && o.wells.every(w => w.startsWith(row));
}

function reservoirDeltaOf(state: StateSnapshot): number {
  // initial reservoirs are full in every scenario (50000/50000)
  return state.reservoirs.reduce((acc, r) => acc + (r.capacity_ul - r.remaining_ul), 0);
}

function tipsUsedOf(state: StateSnapshot): number {
  return state.tips.reduce((acc, t) => acc + (t.capacity - t.remaining), 0);
}

function otherWellDeltas(state: StateSnapshot, focusPlate: string, focusRow: string): Array<{well: string; delta: number}> {
  const scenarioInitial = loadScenario('routine_maintenance');
  const out: Array<{well: string; delta: number}> = [];
  for (const plateInit of scenarioInitial.initial.plates) {
    const plate = state.plates.find(p => p.plate_id === plateInit.id);
    if (!plate) continue;
    for (const [row, vols] of Object.entries(plateInit.wells_volume_ul)) {
      vols.forEach((v0, i) => {
        const wellId = `${row}${i + 1}`;
        if (plateInit.id === focusPlate && row === focusRow) return;
        const now = plate.wells.find(w => w.well_id === wellId)?.volume_ul;
        if (now != null) out.push({well: `${plateInit.id}/${wellId}`, delta: now - v0});
      });
    }
  }
  return out;
}

async function verifyExchange(stack: Stack, runId: string, exp: string): Promise<Criterion[]> {
  const criteria: Criterion[] = [];
  const client = stack.operator!;
  const scenario = loadScenario('exchange_and_mix');
  const focus = scenario.task.policy_hints.focus as {plate_id: string; row_id: string};
  const fraction = scenario.task.policy_hints.exchange_fraction as number;
  const settle = scenario.task.policy_hints.settle_after_shake_s as number;
  const actions = (await client.actions(exp)).actions;
  const observations: Observation[] = (await client.request<{observations: Observation[]}>('GET',
    `/api/v1/experiments/${exp}/observations`)).body.observations;
  const state = await client.state(exp);
  const events = await allEvents(stack, exp);
  const exchanges = actions.filter(a => a.capability === 'media.exchange');
  const shakes = actions.filter(a => a.capability === 'plate.shake');
  const exchange = exchanges[0];
  check(criteria, 'exchange action succeeded', exchange?.status === 'succeeded',
    exchange ? `${exchange.action_id} ${exchange.status}` : 'no media.exchange action');
  if (exchange) {
    const removed = Object.values(exchange.summary.wells).reduce((a, w) => a + w.removed_ul, 0);
    const added = Object.values(exchange.summary.wells).reduce((a, w) => a + w.added_ul, 0);
    check(criteria, 'waste +Σremoved',
      Math.abs(wasteUsedOf(state) - removed) < 1e-3,
      `waste used ${wasteUsedOf(state).toFixed(3)} vs Σremoved ${removed.toFixed(3)} µL`);
    check(criteria, 'reservoir −Σadded (= Σremoved under fraction exchange)',
      Math.abs(reservoirDeltaOf(state) - added) < 1e-3 && Math.abs(removed - added) < 1e-6,
      `reservoir delta ${reservoirDeltaOf(state).toFixed(3)} vs Σadded ${added.toFixed(3)} µL`);
    const now = rowVolumes(state, focus.plate_id, focus.row_id);
    const before = exchangeRowBefore(scenario, focus.row_id);
    const restored = Object.keys(before).every(w => Math.abs(now[w] - before[w]) <= 2.0);
    check(criteria, 'row volumes restored (± evaporation tolerance)',
      restored, Object.keys(before).map(w => `${w}: ${before[w]}→${now[w].toFixed(1)}`).join(', '));
    check(criteria, `tips −12 (two pickups)`, tipsUsedOf(state) === 12, `tips used ${tipsUsedOf(state)}`);
  }
  const shake = shakes[0];
  check(criteria, 'shake succeeded', shake?.status === 'succeeded',
    shake ? `${shake.action_id} ${shake.status}` : 'no plate.shake action');
  if (shake) {
    const started = events.some(e => e.type === 'plate.shake_started' && e.action_id === shake.action_id);
    const stopped = events.some(e => e.type === 'plate.shake_stopped' && e.action_id === shake.action_id);
    check(criteria, 'shake started/stopped events present', started && stopped,
      `shake_started=${started} shake_stopped=${stopped}`);
    const settleEnd = (shake.ended_at_sim_s ?? 0) + settle;
    const post = observations.find(o => o.plate_id === focus.plate_id && coversRow(o, focus.row_id)
      && o.sampled_at_sim_s >= settleEnd);
    check(criteria, 'post-settle rescan exists', Boolean(post),
      post ? `${post.observation_id} at ${post.sampled_at_sim_s} s (settle until ${settleEnd} s)` : 'none found');
    const before = observations.filter(o => coversRow(o, focus.row_id) && o.sampled_at_sim_s < (exchange?.submitted_at_sim_s ?? 0)).at(0);
    const after = observations.filter(o => coversRow(o, focus.row_id) && o.sampled_at_sim_s >= settleEnd).at(-1);
    const comparable = before && after && before.wells.join(',') === after.wells.join(',');
    const hashesDiffer = before && after
      && before.images.map(i => i.sha256).join(',') !== after.images.map(i => i.sha256).join(',');
    check(criteria, 'before/after observations comparable with different image hashes',
      Boolean(comparable && hashesDiffer),
      comparable ? `${before!.observation_id} vs ${after!.observation_id} (same wells, hashes ${hashesDiffer ? 'differ' : 'SAME'})`
        : 'missing pair');
  }
  const evidenceOk = exchanges.every(a => a.evidence_refs.length > 0
    && a.evidence_refs.every(ref => observations.some(o => o.observation_id === ref)));
  check(criteria, 'exchange cites fresh scan evidence', exchanges.length > 0 && evidenceOk,
    exchanges.map(a => `${a.action_id} -> [${a.evidence_refs.join(', ')}]`).join('; '));
  const report = await client.request<{report: unknown}>('GET', `/api/v1/runs/${runId}/report`).catch(() => null);
  check(criteria, 'final report present on the Runtime', report != null && report.status === 200,
    report ? 'GET /api/v1/runs/{id}/report 200' : 'report endpoint failed');
  void fraction;
  return criteria;
}

function wasteUsedOf(state: StateSnapshot): number {
  return state.wastes.reduce((a, w) => a + w.used_ul, 0);
}

function exchangeRowBefore(scenario: ReturnType<typeof loadScenario>, row: string): Record<string, number> {
  const plate = scenario.initial.plates[0];
  const out: Record<string, number> = {};
  (plate.wells_volume_ul[row] as number[]).forEach((v, i) => { out[`${row}${i + 1}`] = v; });
  return out;
}

async function verifyDrift(stack: Stack, runId: string, exp: string): Promise<Criterion[]> {
  const criteria: Criterion[] = [];
  const client = stack.operator!;
  const scenario = loadScenario('environment_drift');
  const focus = scenario.task.policy_hints.focus as {plate_id: string; row_id: string};
  const actions = (await client.actions(exp)).actions;
  const observations: Observation[] = (await client.request<{observations: Observation[]}>('GET',
    `/api/v1/experiments/${exp}/observations`)).body.observations;
  const state = await client.state(exp);
  const rowObs = observations.filter(o => o.plate_id === focus.plate_id && coversRow(o, focus.row_id))
    .sort((a, b) => a.sampled_at_sim_s - b.sampled_at_sim_s);
  const setT = actions.filter(a => a.capability === 'environment.set_targets')[0];
  check(criteria, 'set_targets succeeded (immediate)', setT?.status === 'succeeded',
    setT ? `${setT.action_id} ${setT.status}` : 'no set_targets action');
  const first = rowObs[0];
  const firstBlurred = first?.quality === 'blurred' && first.estimates.every(e => e.liquid_level_ul == null);
  check(criteria, 'first scan blurred with null estimates', firstBlurred,
    first ? `${first.observation_id} quality=${first.quality}, estimates ${first.estimates.every(e => e.liquid_level_ul == null) ? 'all null' : 'NOT null'}` : 'no scan');
  const decisions = (await agentEvents(stack, runId)).filter(e => e.type === 'decision');
  const noConclusion = decisions.some(d => String(d.payload.reason ?? '').includes('no visual conclusion'));
  check(criteria, "agent decision log records that no visual conclusion was drawn", noConclusion,
    decisions.map(d => String(d.payload.reason ?? '')).find(r => r.includes('no visual conclusion'))?.slice(0, 160) ?? 'not found');
  const awaitStable = actions.filter(a => a.capability === 'environment.await_stable')[0];
  check(criteria, 'await_stable succeeded', awaitStable?.status === 'succeeded',
    awaitStable ? `${awaitStable.action_id} ${awaitStable.status}` : 'no await_stable action');
  const later = rowObs.filter(o => o !== first && o.quality === 'ok' && o.estimates.every(e => e.liquid_level_ul != null));
  check(criteria, 'a later non-blurred scan exists', later.length > 0,
    later.map(o => `${o.observation_id}@${o.sampled_at_sim_s}s`).join(', ') || 'none');
  const chamber = state.chamber;
  const tol = scenario.task.tolerances;
  const within = Math.abs(chamber.temperature_c.observed - scenario.task.env_targets.temperature_c) <= tol.temperature_c
    && Math.abs(chamber.co2_pct.observed - scenario.task.env_targets.co2_pct) <= tol.co2_pct
    && Math.abs(chamber.humidity_pct.observed - scenario.task.env_targets.humidity_pct) <= tol.humidity_pct;
  check(criteria, 'final chamber observed within tolerance',
    within,
    `observed ${chamber.temperature_c.observed.toFixed(2)} °C / ${chamber.co2_pct.observed.toFixed(2)} % / ${chamber.humidity_pct.observed.toFixed(2)} % vs targets ±${tol.temperature_c}/±${tol.co2_pct}/±${tol.humidity_pct}`);
  const report = await client.request<{report: unknown}>('GET', `/api/v1/runs/${runId}/report`).catch(() => null);
  check(criteria, 'final report present on the Runtime', report != null && report.status === 200,
    report ? 'GET /api/v1/runs/{id}/report 200' : 'report endpoint failed');
  return criteria;
}

// -- anomaly recovery demo --------------------------------------------------------

async function runAnomalyDemo(): Promise<DemoResult> {
  const name = 'anomaly_recovery';
  const stack = new Stack(name, {OSCAR_LEASE_TTL_MS: String(120_000), OSCAR_LEASE_MAX_HOLD_MS: String(300_000)});
  const criteria: Criterion[] = [];
  const commands = [
    'node services/runtime/src/main.ts --port <p> --scenario routine_maintenance --seed 42 --clock-mode lockstep',
    'node services/culture-agent/src/main.ts --port 0 --runtime-url http://127.0.0.1:<p>',
    'POST /api/v1/agent/runs (operator, scripted) -> kill -9 agent during media.add -> restart agent ->',
    'POST /api/v1/agent/runs/{id}/control {action:"resume"}',
  ];
  let runId: string | null = null;
  let exp: string | null = null;
  let actions: Array<{action_id: string; capability: string; status: string}> = [];
  let observations: string[] = [];
  let agentReport: Record<string, unknown> | null = null;
  try {
    await stack.start('routine_maintenance', 42);
    const client = stack.operator!;
    exp = await client.currentExperimentId();
    await client.control(exp, {speed: SPEED});
    const created = await createRun(stack);
    runId = created.run_id;
    // wait until the media.add is running, then kill -9 the agent
    let addRunning = false;
    let addAction: Action | undefined;
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const list = (await client.actions(exp)).actions;
      addAction = list.find(a => a.capability === 'media.add');
      if (addAction && (addAction.status === 'running' || isTerminal(addAction.status))) {
        addRunning = addAction.status === 'running';
        break;
      }
      await sleep(20);
    }
    check(criteria, 'media.add was running when the agent was killed', addRunning,
      addAction ? `${addAction.action_id} status=${addAction.status}` : 'media.add never appeared');
    stack.killAgent9();
    // run must become paused(agent_restarted) after the agent restarts
    await stack.restartAgent();
    let pausedReason = '';
    const pauseDeadline = Date.now() + 30_000;
    while (Date.now() < pauseDeadline) {
      const record = await runtimeRunRecord(stack, runId);
      if (record.status === 'paused') { pausedReason = record.reason ?? ''; break; }
      await sleep(100);
    }
    check(criteria, 'run paused(agent_restarted) after agent restart',
      pausedReason === 'agent_restarted', `status reason '${pausedReason}'`);
    // no new actions while paused
    const countAtPause = (await client.actions(exp)).actions.length;
    await sleep(1500);
    const countLater = (await client.actions(exp)).actions.length;
    check(criteria, 'no new actions while the agent is paused', countAtPause === countLater,
      `actions ${countAtPause} -> ${countLater}`);
    // operator resume: the agent reconciles and completes
    const resume = await client.request('POST', `/api/v1/agent/runs/${runId}/control`, {action: 'resume'});
    if (resume.status !== 200) throw new Error(`resume failed: ${resume.status}`);
    const ended = await waitRunEnded(stack, runId);
    const finalActions = (await client.actions(exp)).actions;
    actions = finalActions.map(a => ({action_id: a.action_id, capability: a.capability, status: a.status}));
    observations = ((await client.request<{observations: Observation[]}>('GET',
      `/api/v1/experiments/${exp}/observations`)).body.observations).map(o => o.observation_id);
    const liquidOps = finalActions.filter(a => a.capability === 'media.add' || a.capability === 'media.exchange');
    const withEffects = liquidOps.filter(a => a.status === 'succeeded' && Object.keys(a.summary.wells).length > 0);
    check(criteria, 'exactly one media.* action with effects (no repeat after reconcile)',
      liquidOps.length === 1 && withEffects.length === 1,
      liquidOps.map(a => `${a.action_id}:${a.status}:wells=${Object.keys(a.summary.wells).length}`).join(', '));
    const record = await runtimeRunRecord(stack, runId);
    check(criteria, 'run ended and completed', record.status === 'ended' && record.reason === 'completed',
      `status=${record.status} reason=${record.reason}`);
    check(criteria, 'determinism not broken', record.determinism_broken === false,
      `determinism_broken=${record.determinism_broken}`);
    const report = await client.request<{report: Record<string, unknown>}>('GET', `/api/v1/runs/${runId}/report`).catch(() => null);
    check(criteria, 'final report present on the Runtime', report != null && report.status === 200,
      report ? 'GET /api/v1/runs/{id}/report 200' : 'report endpoint failed');
    agentReport = report?.body.report ?? null;
    void ended;
  } catch (e) {
    check(criteria, 'demo completed without error', false, e instanceof Error ? e.message : String(e));
  } finally {
    await stack.stop();
  }
  return {demo: name, scenario: 'routine_maintenance', seed: 42,
    outcome: criteria.every(c => c.pass) ? 'pass' : 'fail', run_id: runId, experiment_id: exp,
    criteria, commands, actions, observations, agent_report: agentReport};
}

// -- scripted scenario demos --------------------------------------------------------

async function runScenarioDemo(scenarioId: string): Promise<DemoResult> {
  const stack = new Stack(scenarioId);
  const criteria: Criterion[] = [];
  const commands = [
    `node services/runtime/src/main.ts --port <p> --scenario ${scenarioId} --seed 42 --clock-mode lockstep`,
    'node services/culture-agent/src/main.ts --port 0 --runtime-url http://127.0.0.1:<p>',
    `POST /api/v1/agent/runs {experiment_id, mode:"scripted"} (operator token, speed ${SPEED})`,
  ];
  let runId: string | null = null;
  let exp: string | null = null;
  let actions: Array<{action_id: string; capability: string; status: string}> = [];
  let observations: string[] = [];
  let agentReport: Record<string, unknown> | null = null;
  try {
    await stack.start(scenarioId, 42);
    const client = stack.operator!;
    exp = await client.currentExperimentId();
    await client.control(exp, {speed: SPEED});
    const created = await createRun(stack);
    runId = created.run_id;
    await waitRunEnded(stack, runId);
    actions = (await client.actions(exp)).actions.map(a => ({action_id: a.action_id,
      capability: a.capability, status: a.status}));
    observations = ((await client.request<{observations: Observation[]}>('GET',
      `/api/v1/experiments/${exp}/observations`)).body.observations).map(o => o.observation_id);
    const record = await runtimeRunRecord(stack, runId);
    check(criteria, 'run ended with reason "completed"', record.status === 'ended' && record.reason === 'completed',
      `status=${record.status} reason=${record.reason}`);
    check(criteria, 'determinism not broken', record.determinism_broken === false,
      `determinism_broken=${record.determinism_broken}`);
    let scenarioCriteria: Criterion[] = [];
    if (scenarioId === 'routine_maintenance') scenarioCriteria = await verifyRoutine(stack, runId, exp);
    else if (scenarioId === 'exchange_and_mix') scenarioCriteria = await verifyExchange(stack, runId, exp);
    else scenarioCriteria = await verifyDrift(stack, runId, exp);
    criteria.push(...scenarioCriteria);
    const report = await client.request<{report: Record<string, unknown>}>('GET', `/api/v1/runs/${runId}/report`).catch(() => null);
    agentReport = report?.body.report ?? null;
  } catch (e) {
    check(criteria, 'demo completed without error', false, e instanceof Error ? e.message : String(e));
  } finally {
    await stack.stop();
  }
  return {demo: scenarioId, scenario: scenarioId, seed: 42,
    outcome: criteria.every(c => c.pass) ? 'pass' : 'fail', run_id: runId, experiment_id: exp,
    criteria, commands, actions, observations, agent_report: agentReport,
    inventory: (agentReport as {inventory?: unknown} | null)?.inventory};
}

// -- long-lived session demo (D5): realtime + HTTP model stub + supervisor ------

async function runSessionDemo(): Promise<DemoResult> {
  const criteria: Criterion[] = [];
  const stack = new Stack('session-monitor');
  const {startModelStub} = await import('../services/culture-agent/test/model-stub.ts');
  const stub = await startModelStub();
  const commands = [
    'node services/runtime/src/main.ts --scenario routine_maintenance --clock-mode realtime (speed 1200)',
    'node services/culture-agent/src/main.ts (OSCAR_MODEL_* -> local HTTP model stub on the OpenAI wire)',
    'POST /api/v1/agent/supervisor/v1/sessions + /tasks (delegated_principal, task_id returned at once)',
    'simulated 26 h: monitor wake every 6 h, media.add below 330 µL, verify scan, complete at deadline',
  ];
  let runId: string | null = null;
  let exp: string | null = null;
  let actions: Array<{action_id: string; capability: string; status: string}> = [];
  let observations: string[] = [];
  const goal = {
    description: '维持 plate-01 A 排各孔培养液 ≥ 330 µL：定期扫描评估，低于阈值整排补液并复查',
    scope: {plates: ['plate-01'], rows: ['A']},
    metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'}],
    allowed_operations: ['imaging.scan', 'media.add'],
    monitoring: {interval_sim_s: 21_600},
    deadline_sim_s: 93_600,
    success: {description: '监测窗口结束且不低于阈值'},
    stop: {description: '预算或取消', max_corrections: 8},
  };
  try {
    await stack.start('routine_maintenance', 42, 'realtime');
    // NOTE: env must exist before the agent process starts; restart with env
    await stack.stop();
    const withModel = new Stack('session-monitor', {OSCAR_MODEL_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
      OSCAR_MODEL_API_KEY: 'stub-key', OSCAR_MODEL_NAME: 'oscar-stub'});
    await withModel.start('routine_maintenance', 42, 'realtime');
    try {
      const client = withModel.operator!;
      exp = await client.currentExperimentId();
      await client.control(exp, {speed: 1200});
      const serviceToken = readFileSync(join(withModel.dataDir, 'secrets', 'service.token'), 'utf8').trim();
      const agentPort = (withModel as unknown as {agentPort: number}).agentPort;
      const sup = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const r = await fetch(`http://127.0.0.1:${agentPort}${path}`, {method,
          headers: {'content-type': 'application/json', 'x-service-token': serviceToken},
          body: body === undefined ? undefined : JSON.stringify(body)});
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`${String((json as {code?: string}).code ?? r.status)}: ${JSON.stringify(json).slice(0, 200)}`);
        return json as T;
      };
      const created = await sup<{session_id: string}>('POST', '/supervisor/v1/sessions',
        {experiment_id: exp, delegated_principal: 'demo'});
      const task = await sup<{task_id: string; status: string}>('POST',
        `/supervisor/v1/sessions/${created.session_id}/tasks`,
        {goal_text: '照看 plate-01 A 排（演示协议 ≥ 330 µL）', goal_spec: goal, delegated_principal: 'demo'});
      check(criteria, 'supervisor delegation returned task_id immediately', Boolean(task.task_id),
        `task_id=${task.task_id}`);
      // wait for completion (26 sim h at speed 1200 ≈ 78 s + turns)
      const start = Date.now();
      let final: {task: {status: string}} | null = null;
      for (;;) {
        const st = await sup<{task: {status: string}}>('GET', `/supervisor/v1/tasks/${task.task_id}`);
        if (st.task.status === 'completed') {final = st; break;}
        if (st.task.status === 'failed' || Date.now() - start > 170_000) {
          throw new Error(`task ended as ${st.task.status}`);
        }
        await sleep(1000);
      }
      void final;
      actions = (await client.actions(exp)).actions.filter(a => a.principal.kind === 'service')
        .map(a => ({action_id: a.action_id, capability: a.capability, status: a.status}));
      observations = ((await client.request<{observations: Observation[]}>('GET',
        `/api/v1/experiments/${exp}/observations`)).body.observations).map(o => o.observation_id);
      const events = (await sup<{events: Array<{type: string; payload: Record<string, unknown>}>}>('GET',
        `/supervisor/v1/sessions/${created.session_id}/events?after_seq=0&format=json&limit=10000`)).events;
      const wakes = events.filter(e => e.type === 'wake.fired' && e.payload.kind === 'sim_time');
      const noOps = events.filter(e => e.type === 'message.appended'
        && String((e.payload as {message?: {content?: string}}).message?.content ?? '').includes('No operation needed'));
      check(criteria, 'task completed through the supervisor contract', true, `task_id=${task.task_id}`);
      check(criteria, '≥3 monitor wakes in 26 simulated hours', wakes.length >= 3, `wakes=${wakes.length}`);
      check(criteria, '≥1 maintenance (media.add) executed', actions.filter(a => a.capability === 'media.add').length >= 1,
        `media.add=${actions.filter(a => a.capability === 'media.add').length}`);
      check(criteria, '≥1 no-operation decision recorded', noOps.length >= 1, `noOps=${noOps.length}`);
      check(criteria, 'model calls bounded (stub requests)', stub.requests().length <= 80,
        `requests=${stub.requests().length}`);
      // conservation: reservoir used == Σ media.add draws; row A deltas match effects - evaporation
      const finalState = await client.state(exp);
      let reservoirUsed = 0;
      const wellEffects = new Map<string, number>();
      for (const a of (await client.actions(exp)).actions.filter(x => x.principal.kind === 'service')) {
        reservoirUsed += Math.abs(a.summary.reservoir_delta_ul);
        for (const [well, d] of Object.entries(a.summary.wells)) wellEffects.set(well, (wellEffects.get(well) ?? 0) + d.added_ul - d.removed_ul);
      }
      const remaining = finalState.reservoirs.find(r => r.id === 'media-01')!.remaining_ul;
      check(criteria, 'reservoir conservation', Math.abs(50_000 - reservoirUsed - remaining) <= 1,
        `used=${reservoirUsed} remaining=${remaining}`);
      const initial = loadScenario('routine_maintenance').initial.plates
        .find(pl => pl.id === 'plate-01')!.wells_volume_ul.A as number[];
      const hours = finalState.experiment.sim_time_s / 3600;
      let wellsOk = true;
      const plate = finalState.plates.find(pl => pl.plate_id === 'plate-01')!;
      initial.forEach((v0, i) => {
        const well = `A${i + 1}`;
        const got = plate.wells.find(w => w.well_id === well)!.volume_ul;
        const expected = v0 + (wellEffects.get(well) ?? 0) - 4 * hours;
        if (Math.abs(got - expected) > 2) wellsOk = false;
      });
      check(criteria, 'per-well conservation (effects − evaporation)', wellsOk,
        `checked ${initial.length} wells over ${hours.toFixed(1)} sim h`);
    } finally {
      await withModel.stop();
    }
  } catch (e) {
    check(criteria, 'session demo completed without error', false, e instanceof Error ? e.message : String(e));
  } finally {
    await stub.close();
    await stack.stop();
  }
  return {demo: 'session_monitor', scenario: 'routine_maintenance (realtime session)', seed: 42,
    outcome: criteria.every(c => c.pass) ? 'pass' : 'fail', run_id: runId, experiment_id: exp,
    criteria, commands, actions, observations, agent_report: null};
}

// -- main ----------------------------------------------------------------------------

const demoNames = only ? [only] : ['routine_maintenance', 'exchange_and_mix', 'environment_drift', 'anomaly_recovery', 'session_monitor'];
const results: DemoResult[] = [];
for (const name of demoNames) {
  process.stdout.write(`\n=== demo: ${name} ===\n`);
  const result = name === 'anomaly_recovery' ? await runAnomalyDemo()
    : name === 'session_monitor' ? await runSessionDemo() : await runScenarioDemo(name);
  results.push(result);
  for (const c of result.criteria) {
    process.stdout.write(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}\n`);
  }
  process.stdout.write(`  -> ${result.outcome}\n`);
}

mkdirSync(outDir, {recursive: true});
for (const r of results) {
  writeFileSync(join(outDir, `${r.demo}.json`), `${JSON.stringify(r, null, 2)}\n`);
}
const summary = {
  generated_at_wall: new Date().toISOString(),
  total: results.length,
  passed: results.filter(r => r.outcome === 'pass').length,
  failed: results.filter(r => r.outcome === 'fail').length,
  speed: SPEED,
  demos: results.map(r => ({demo: r.demo, outcome: r.outcome, run_id: r.run_id,
    experiment_id: r.experiment_id,
    failed_criteria: r.criteria.filter(c => !c.pass).map(c => c.name)})),
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const md: string[] = ['# OSCAR demo results (npm run demo:all)', '',
  `Generated: ${summary.generated_at_wall}`, '',
  '| demo | outcome | run | failed criteria |', '| --- | --- | --- | --- |'];
for (const r of results) {
  md.push(`| ${r.demo} | ${r.outcome.toUpperCase()} | ${r.run_id ?? '—'} | ${r.criteria.filter(c => !c.pass).map(c => c.name).join('; ') || '—'} |`);
}
md.push('', '## Criteria detail', '');
for (const r of results) {
  md.push(`### ${r.demo} (${r.outcome})`, '', `- run: ${r.run_id} / experiment: ${r.experiment_id}`,
    `- actions: ${r.actions.map(a => `${a.action_id} ${a.capability} ${a.status}`).join(', ') || '—'}`,
    `- observations: ${r.observations.join(', ') || '—'}`, '');
  for (const c of r.criteria) md.push(`- [${c.pass ? 'x' : ' '}] ${c.name} — ${c.detail}`);
  md.push('');
}
writeFileSync(join(outDir, 'summary.md'), `${md.join('\n')}\n`);

process.stdout.write(`\n=== summary: ${summary.passed}/${summary.total} demos passed ===\n`);
process.stdout.write(`reports: ${outDir}/{${results.map(r => `${r.demo}.json`).join(', ')}}, summary.json, summary.md\n`);
process.exit(summary.failed > 0 ? 1 : 0);
