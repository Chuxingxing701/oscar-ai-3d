// Types for the scripted Culture Agent policy. The policy is a PURE
// deterministic function: (task profile, observed state, observations, action
// results, memory) -> next decision. It never reads simulator truth and never
// uses wall time or unseeded randomness, so the same inputs always produce the
// same decision (design §5.3 reproducibility).
import type {ActionStatus, ActionSummaryEffects, ApiErrorInfo, StateSnapshot, WakeCondition,
  WellEstimate} from '@oscar/device-contract';
import type {Scenario} from '@oscar/simulator';

export interface PolicyRunInfo {
  run_id: string;
  experiment_id: string;
  mode: 'scripted' | 'llm';
  scenario_id: string;
  seed: number;
  plates: string[];
  capabilities: string[];
  budget: {max_actions: number; actions_used: number};
}

/** A scan observation as seen by the Agent (provenance device_estimate). */
export interface ObservationRecord {
  observation_id: string;
  plate_id: string;
  wells: string[];
  mode: 'mono' | 'stereo';
  sampled_at_sim_s: number;
  plate_revision: number;
  quality: 'ok' | 'blurred' | 'degraded';
  estimates: WellEstimate[];
  image_sha256: string[];
}

export interface ActionRecord {
  action_id: string;
  capability: string;
  status: ActionStatus;
  arguments: Record<string, unknown>;
  submitted_at_sim_s: number;
  ended_at_sim_s: number | null;
  summary: ActionSummaryEffects;
  error: ApiErrorInfo | null;
  result: Record<string, unknown> | null;
  partial?: boolean;
}

export interface SubmitErrorRecord {
  /** decision index the error belongs to */
  decision_index: number;
  capability: string;
  code: string;
  message: string;
}

/** Persistent policy memory (JSON in the agent DB). Deterministic content only. */
export interface PolicyMemory {
  phase: string;
  /** counters for bounded retries */
  blurred_scans: number;
  busy_retries: number;
  stale_retries: number;
  net_retries: number;
  corrections: number;
  /** cooldown bookkeeping: last liquid op per row key "plate:row" -> sim time */
  last_liquid_at: Record<string, number>;
  /** first usable observation of the focus row (baseline for before/after) */
  baseline_observation_id: string | null;
  /** observation id that provided evidence for the executed liquid op */
  liquid_evidence_observation_id: string | null;
  focus_row_wells: string[];
}

export function emptyMemory(phase = 'init'): PolicyMemory {
  return {
    phase, blurred_scans: 0, busy_retries: 0, stale_retries: 0, net_retries: 0, corrections: 0,
    last_liquid_at: {}, baseline_observation_id: null, liquid_evidence_observation_id: null,
    focus_row_wells: [],
  };
}

export type PolicyDecision =
  | {
    kind: 'act';
    capability: string;
    arguments: Record<string, unknown>;
    reason: string;
    basis: 'scripted';
    evidence_refs: string[];
  }
  | {kind: 'wait'; wake: WakeCondition; reason: string; basis: 'scripted'}
  | {kind: 'finish'; outcome: 'completed' | 'failed' | 'aborted'; summary: string; basis: 'scripted';
    reason?: string};

export interface PolicyContext {
  run: PolicyRunInfo;
  task: Scenario['task'];
  state: StateSnapshot;
  /** recorded observations, oldest first */
  observations: ObservationRecord[];
  /** all actions known to the agent (resolved intents), submission order */
  actions: ActionRecord[];
  /** submit errors from the last control-loop pass (empty when all went through) */
  lastErrors: SubmitErrorRecord[];
  memory: PolicyMemory;
  /** next decision ordinal (persisted by the loop) */
  decisionIndex: number;
  /** tool definitions assembled from the manifest for this run scope (§7.1) */
  tools: Array<{name: string; capability: string | null}>;
}

/** Bounded retry / cooldown limits (explicit demo constants). */
export const POLICY_LIMITS = {
  max_blurred_scans: 3,
  max_busy_retries: 5,
  max_stale_retries: 2,
  max_corrections: 1,
  /** min sim seconds between two liquid ops on the same row */
  liquid_cooldown_s: 60,
} as const;
