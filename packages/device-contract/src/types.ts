// Wire types for /api/v1. Runtime produces them, DeviceClient / Workbench /
// Agent consume them. Volumes µL, times simulated seconds unless *_wall.

export type ClockMode = 'lockstep' | 'realtime';
export type ExperimentStatus = 'active' | 'archiving' | 'archived';
export type ActionStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
export const TERMINAL_STATUSES: readonly ActionStatus[] = ['succeeded', 'failed', 'cancelled'];
export const isTerminal = (s: ActionStatus): boolean => TERMINAL_STATUSES.includes(s);

export type Provenance = 'simulator_truth' | 'synthetic_sensor' | 'synthetic_image' | 'device_estimate' | 'oracle_demo';
/** Who decided: a human operator, the scripted policy, or an LLM. */
export type DecisionBasis = 'operator' | 'scripted' | 'llm' | 'scheduled_policy';

export type PrincipalKind = 'operator' | 'run' | 'service';
export interface Principal { kind: PrincipalKind; id: string; run_id?: string }

export type SceneStage = 'moving' | 'lowering' | 'aspirating' | 'dispensing' | 'raising' | 'scanning'
  | 'picking_tip' | 'dropping_tip';
export type Stage = SceneStage | 'shaking' | 'waiting';

/** Stage target. Liquid stages on plates use an explicit full row. */
export type StageTarget =
  | {plate_id: string; row_id: string}
  | {plate_id: string; well_id: string}
  | {resource_id: string}
  | null; // null = head home / park position

export interface ActionStage {
  index: number;
  stage: Stage;
  /** Primitive for the dev panel, e.g. pipette.aspirate. */
  primitive: string;
  tool?: 'pipette' | 'camera';
  target: StageTarget;
  from_target?: StageTarget;
  duration_sim_s: number;
  started_at_sim_s: number | null;
  committed: boolean;
}

export interface WellDelta { well_id: string; delta_ul: number }
/** Effects of one committed step, written in the same transaction as the step. */
export interface StepEffect {
  step_index: number;
  stage: Stage;
  committed_at_sim_s: number;
  wells?: WellDelta[];
  reservoir?: {id: string; delta_ul: number};
  waste?: {id: string; delta_ul: number};
  tips?: {id: string; delta: number};
  head_load_ul?: number[];
  shake?: 'started' | 'stopped';
  chamber_targets?: Record<string, number>;
}

export interface ActionSummaryEffects {
  wells: Record<string, {removed_ul: number; added_ul: number}>;
  reservoir_delta_ul: number;
  waste_delta_ul: number;
  tips_used: number;
}

export interface ApiErrorInfo { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> }

export interface Action {
  action_id: string;
  experiment_id: string;
  device_id: string;
  capability: string;
  arguments: Record<string, unknown>;
  /** Normalized scope, e.g. {plate_id, row_id, wells:[A1..A6]} */
  scope?: {plate_id?: string; row_id?: string; wells?: string[]; label?: string};
  status: ActionStatus;
  principal: Principal;
  run_id: string | null;
  basis: DecisionBasis;
  reason: string | null;
  evidence_refs: string[];
  idempotency_key: string | null;
  resources: string[];
  accept_seq: number;
  submitted_at_sim_s: number;
  started_at_sim_s: number | null;
  ended_at_sim_s: number | null;
  stages: ActionStage[];
  current_stage_index: number | null;
  effects: StepEffect[];
  summary: ActionSummaryEffects;
  partial: boolean;
  cancel_reason: string | null;
  error: ApiErrorInfo | null;
  result: Record<string, unknown> | null;
}

export interface DeviceEvent {
  seq: number;
  experiment_id: string;
  sim_time_s: number;
  type: string;
  action_id?: string | null;
  run_id?: string | null;
  observation_id?: string | null;
  payload: Record<string, unknown>;
}

export interface WellState { well_id: string; volume_ul: number; capacity_ul: number; medium_id: string | null }
export interface ShakeState { active: boolean; started_at_sim_s: number; duration_sim_s: number; speed_rpm?: number;
  ended_at_sim_s?: number | null; action_id?: string | null }
export interface PlateState { plate_id: string; station_id: string; format: string; rows: string[]; columns: number;
  revision: number; shake: ShakeState; wells: WellState[] }
export interface EnvChannel { target: number; observed: number; error: number; quality: 'ok' | 'settling' | 'degraded';
  sampled_at_sim_s: number }
export interface ChamberReading { chamber_id: string; target_revision: number; provenance: 'synthetic_sensor';
  temperature_c: EnvChannel; co2_pct: EnvChannel; humidity_pct: EnvChannel; stable: boolean }

export interface Lease {
  lease_id: number;
  experiment_id: string;
  run_id: string;
  state: 'active' | 'released' | 'expired' | 'revoked';
  frozen_at_sim_s: number;
  event_seq: number;
  triggers: {kind: 'run_started' | 'run_resumed' | 'action_terminal' | 'wake_time' | 'appended'; action_id?: string; at_sim_s?: number}[];
  expires_at_wall: string;
  granted_at_wall: string;
  wake?: WakeCondition | null;
}
export interface WakeCondition { on_actions?: string[]; at_sim_s?: number }

export interface RunRecord {
  run_id: string;
  experiment_id: string;
  mode: 'scripted' | 'llm';
  status: 'active' | 'paused' | 'on_hold' | 'ended';
  reason: string | null;
  clock_mode: ClockMode;
  plates: string[];
  capabilities: string[];
  budget: {max_actions: number; actions_used: number};
  determinism_broken: boolean;
  created_at_sim_s: number;
}

export interface ExperimentInfo {
  experiment_id: string;
  scenario_id: string;
  scenario_version: string;
  simulator_version: string;
  seed: number;
  status: ExperimentStatus;
  sim_time_s: number;
  clock_mode: ClockMode;
  paused: boolean;
  speed: number;
  reset_from: string | null;
  successor_id: string | null;
  determinism_broken: boolean;
  created_at_wall: string;
}

export interface StateSnapshot {
  experiment: ExperimentInfo;
  event_seq: number;
  device: {device_id: string; mode: 'simulation'; manifest_version: string; health: 'ok'};
  chamber: ChamberReading;
  plates: PlateState[];
  reservoirs: {id: string; station_id: string; medium_id: string; remaining_ul: number; capacity_ul: number}[];
  wastes: {id: string; station_id: string; used_ul: number; capacity_ul: number}[];
  tips: {id: string; station_id: string; remaining: number; capacity: number}[];
  busy_resources: Record<string, string>;
  active_actions: Action[];
  /** Stage currently occupying the shared head (at most one). */
  head: {action_id: string; stage: ActionStage} | null;
  lease: Lease | null;
  run: RunRecord | null;
  revisions: Record<string, number>;
}

export interface ImageRef { asset_id: string; role: 'mono' | 'left' | 'right'; sha256: string; width: number; height: number;
  media_type: 'image/png'; provenance: 'synthetic_image' }
/** Values are null when the image quality does not support an estimate (never invented). */
export interface WellEstimate { well_id: string; liquid_level_ul: number | null; color_index: number | null; turbidity: number | null;
  quality: number; provenance: 'device_estimate'; method: 'simulated_onboard_analysis'; uncertainty_ul: number }
export interface Observation {
  observation_id: string;
  experiment_id: string;
  action_id: string;
  plate_id: string;
  wells: string[];
  mode: 'mono' | 'stereo';
  view: 'medium_overview' | 'culture_detail';
  sampled_at_sim_s: number;
  plate_revision: number;
  quality: 'ok' | 'blurred' | 'degraded';
  stereo_pair_id: string | null;
  depth_status: 'not_computed' | null;
  camera: Record<string, unknown>;
  images: ImageRef[];
  estimates: WellEstimate[];
  source: 'synthetic_image';
}

export interface SubmitActionRequest {
  device_id?: string;
  capability: string;
  arguments: Record<string, unknown>;
  expected_revisions?: Record<string, number>;
  evidence_refs?: string[];
  reason?: string;
  basis?: DecisionBasis;
}

export type ControlRequest =
  | {pause: true} | {resume: true} | {speed: number} | {clock_mode: ClockMode}
  | {step: {until_sim_s?: number; until_idle?: boolean; steps?: number}}
  | {reset: {scenario_id?: string; seed?: number; clock_mode?: ClockMode}}
  | {hold: {run_id: string; on: boolean}};
