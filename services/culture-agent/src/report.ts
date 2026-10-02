// Final run report: structured, evidence-linked, computed from Runtime state
// and Action summaries (never simulator truth). Stored in the agent DB and
// POSTed to the Runtime so the run ends with the report on record.
import type {DeviceClient, StateSnapshot} from '@oscar/device-contract';
import type {Scenario} from '@oscar/simulator';
import type {AgentStore} from './store.ts';

export interface ReportStep {
  index: number;
  kind: string;
  capability?: string;
  basis?: string;
  reason?: string;
  evidence_refs?: string[];
  wake?: unknown;
  action_id?: string;
  action_status?: string;
  effects?: {wells: Record<string, {removed_ul: number; added_ul: number}>;
    reservoir_delta_ul: number; waste_delta_ul: number; tips_used: number};
}

export interface AgentReport {
  run_id: string;
  experiment_id: string;
  scenario: string;
  mode: string;
  outcome: 'completed' | 'failed' | 'aborted';
  summary: string;
  steps: ReportStep[];
  observations: Array<{observation_id: string; quality: string; sampled_at_sim_s: number; plate_id: string;
    wells: string[]; images: string[]}>;
  inventory: {
    reservoirs: Array<{id: string; start_ul: number; end_ul: number; delta_ul: number}>;
    wastes: Array<{id: string; start_used_ul: number; end_used_ul: number; delta_ul: number}>;
    tips: Array<{id: string; start_remaining: number; end_remaining: number; used: number}>;
    focus_row: {plate_id: string; row_id: string; wells: Array<{well_id: string; start_ul: number; end_ul: number; delta_ul: number}>};
  };
  environment: {before: unknown; after: unknown; tolerances: unknown};
  counts: {decisions: number; actions_submitted: number; observations_recorded: number};
  determinism_broken: boolean;
  generated_at_wall: string;
}

interface BuildDeps {
  store: AgentStore;
  client: DeviceClient;
  runId: string;
  experimentId: string;
  scenarioId: string;
  mode: string;
  outcome: 'completed' | 'failed' | 'aborted';
  summary: string;
  task: Scenario['task'];
}

export async function buildReport(deps: BuildDeps): Promise<AgentReport> {
  const {store, client, runId} = deps;
  const run = store.getRun(runId)!;
  const events = store.eventsAfter(runId, 0, 100_000);

  // steps from the agent decision/action event stream
  const steps: ReportStep[] = [];
  const actionsById = new Map<string, ReportStep>();
  for (const ev of events) {
    if (ev.type === 'decision') {
      const p = ev.payload as Record<string, unknown>;
      const step: ReportStep = {index: Number(p.index ?? steps.length + 1), kind: String(p.kind ?? ''),
        capability: p.capability as string | undefined, basis: p.basis as string | undefined,
        reason: p.reason as string | undefined, evidence_refs: p.evidence_refs as string[] | undefined,
        wake: p.wake};
      steps.push(step);
    } else if (ev.type === 'action.submitted') {
      const p = ev.payload as Record<string, unknown>;
      let step = [...steps].reverse().find(s => s.kind === 'act' && s.capability === p.capability && !s.action_id);
      if (!step) {
        step = {index: steps.length + 1, kind: 'act', capability: p.capability as string, basis: 'scripted'};
        steps.push(step);
      }
      step.action_id = String(p.action_id ?? '');
      actionsById.set(step.action_id, step);
    } else if (ev.type === 'action.result') {
      const p = ev.payload as Record<string, unknown>;
      const step = actionsById.get(String(p.action_id ?? ''));
      if (step) {
        step.action_status = String(p.status ?? '');
        step.effects = p.summary as ReportStep['effects'];
      }
    }
  }

  const observations = events.filter(e => e.type === 'observation.recorded').map(e => {
    const p = e.payload as Record<string, unknown>;
    return {observation_id: String(p.observation_id), quality: String(p.quality),
      sampled_at_sim_s: Number(p.sampled_at_sim_s), plate_id: String(p.plate_id),
      wells: (p.wells as string[]) ?? [], images: (p.image_sha256 as string[]) ?? []};
  });

  const counts = {
    decisions: events.filter(e => e.type === 'decision').length,
    actions_submitted: events.filter(e => e.type === 'action.submitted').length,
    observations_recorded: observations.length,
  };

  // final state (best-effort; the run may already be archived/token-revoked)
  let finalState: StateSnapshot | null = null;
  try {
    finalState = await client.state(deps.experimentId);
  } catch {
    finalState = null;
  }
  const initial = (run.initial_state ?? null) as {
    reservoirs?: Array<{id: string; remaining_ul: number}>;
    wastes?: Array<{id: string; used_ul: number}>;
    tips?: Array<{id: string; remaining: number}>;
    chamber?: unknown;
    plates?: Array<{plate_id: string; wells: Array<{well_id: string; volume_ul: number}>}>;
  } | null;
  const focus = (deps.task.policy_hints.focus ?? {}) as {plate_id?: string; row_id?: string};
  const plateId = focus.plate_id ?? run.plates[0] ?? 'plate-01';
  const rowId = focus.row_id ?? 'A';

  const reservoirs = (finalState?.reservoirs ?? []).map(r => {
    const start = initial?.reservoirs?.find(s => s.id === r.id)?.remaining_ul ?? r.remaining_ul;
    return {id: r.id, start_ul: start, end_ul: r.remaining_ul, delta_ul: round3(r.remaining_ul - start)};
  });
  const wastes = (finalState?.wastes ?? []).map(w => {
    const start = initial?.wastes?.find(s => s.id === w.id)?.used_ul ?? w.used_ul;
    return {id: w.id, start_used_ul: start, end_used_ul: w.used_ul, delta_ul: round3(w.used_ul - start)};
  });
  const tips = (finalState?.tips ?? []).map(t => {
    const start = initial?.tips?.find(s => s.id === t.id)?.remaining ?? t.remaining;
    return {id: t.id, start_remaining: start, end_remaining: t.remaining, used: start - t.remaining};
  });
  const finalPlate = finalState?.plates.find(p => p.plate_id === plateId);
  const startPlate = initial?.plates?.find(p => p.plate_id === plateId);
  const rowWells = finalPlate?.wells.filter(w => w.well_id.startsWith(rowId))
    ?? startPlate?.wells.filter(w => w.well_id.startsWith(rowId)) ?? [];
  const focusRow = rowWells.map(w => {
    const start = startPlate?.wells.find(x => x.well_id === w.well_id)?.volume_ul ?? w.volume_ul;
    return {well_id: w.well_id, start_ul: start, end_ul: w.volume_ul, delta_ul: round3(w.volume_ul - start)};
  });

  return {
    run_id: runId,
    experiment_id: deps.experimentId,
    scenario: deps.scenarioId,
    mode: deps.mode,
    outcome: deps.outcome,
    summary: deps.summary,
    steps,
    observations,
    inventory: {reservoirs, wastes, tips, focus_row: {plate_id: plateId, row_id: rowId, wells: focusRow}},
    environment: {before: initial?.chamber ?? null, after: finalState?.chamber ?? null,
      tolerances: deps.task.tolerances},
    counts,
    determinism_broken: Boolean(finalState
      ? (finalState.run?.determinism_broken || finalState.experiment.determinism_broken)
      : false),
    generated_at_wall: new Date().toISOString(),
  };
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }
