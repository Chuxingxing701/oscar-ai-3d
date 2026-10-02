// The manifest's JSON Schemas are the single source of argument definitions:
// Runtime validates HTTP arguments with them and the Agent builds tool
// definitions from them (tool name = capability name with '.' -> '_').
import {DEMO_PROFILE as P} from './profile.ts';
import {CHAMBER_ID, DEVICE_ID, PROFILE_ID, RESOURCE_ID_PATTERN, ROW_ID_PATTERN, WELL_ID_PATTERN} from './ids.ts';

export type Access = 'read' | 'write' | 'control';
export type JsonSchema = Record<string, unknown>;

export interface Capability {
  name: string;
  version: string;
  access: Access;
  description: string;
  execution: 'sync' | 'async' | 'immediate';
  http: {method: 'GET' | 'POST'; path: string};
  resources: string[];
  input_schema: JsonSchema;
  limits_ref?: string;
  constraints?: string[];
  result_type: string;
  cancellation?: 'between_committed_steps' | 'not_applicable';
  /** Stage sequence for scheduled liquid/imaging actions (deterministic executor). */
  stages?: string[];
}

export interface Manifest {
  profile: string;
  device_id: string;
  driver: 'simulator';
  manifest_version: string;
  api_version: 'v1';
  units: Record<string, string>;
  limits: Record<string, unknown>;
  capabilities: Capability[];
  notes: string[];
}

/**
 * Deterministic stage plans (§6.3 primitives). `at` names the stage target:
 * home | tips | reservoir | waste | row (the complete target row) | well (scan).
 * `commit` names the effect committed atomically in the transaction of the
 * step in which the stage ends. Stages without `commit` change no inventory.
 */
export interface StagePlan { stage: string; primitive: string; at: 'home' | 'tips' | 'reservoir' | 'waste' | 'row' | 'well' | 'plate';
  commit?: 'tips_pick' | 'row_aspirate' | 'row_dispense' | 'reservoir_aspirate' | 'waste_dispense' | 'tips_drop' | 'scan_capture' }
const mv = (at: StagePlan['at']): StagePlan => ({stage: 'moving', primitive: 'motion.move_to_station', at});
const lo = (at: StagePlan['at']): StagePlan => ({stage: 'lowering', primitive: 'motion.lower', at});
const ra = (at: StagePlan['at']): StagePlan => ({stage: 'raising', primitive: 'motion.raise', at});
export const MEDIA_ADD_STAGES: StagePlan[] = [
  mv('tips'), {stage: 'picking_tip', primitive: 'pipette.pick_tip', at: 'tips', commit: 'tips_pick'},
  mv('reservoir'), lo('reservoir'), {stage: 'aspirating', primitive: 'pipette.aspirate', at: 'reservoir', commit: 'reservoir_aspirate'}, ra('reservoir'),
  mv('row'), lo('row'), {stage: 'dispensing', primitive: 'pipette.dispense', at: 'row', commit: 'row_dispense'}, ra('row'),
  mv('waste'), {stage: 'dropping_tip', primitive: 'pipette.drop_tip', at: 'waste', commit: 'tips_drop'},
  {stage: 'moving', primitive: 'motion.park', at: 'home'},
];
export const MEDIA_EXCHANGE_STAGES: StagePlan[] = [
  mv('tips'), {stage: 'picking_tip', primitive: 'pipette.pick_tip', at: 'tips', commit: 'tips_pick'},
  mv('row'), lo('row'), {stage: 'aspirating', primitive: 'pipette.aspirate', at: 'row', commit: 'row_aspirate'}, ra('row'),
  mv('waste'), lo('waste'), {stage: 'dispensing', primitive: 'pipette.dispense', at: 'waste', commit: 'waste_dispense'}, ra('waste'),
  {stage: 'dropping_tip', primitive: 'pipette.drop_tip', at: 'waste', commit: 'tips_drop'},
  mv('tips'), {stage: 'picking_tip', primitive: 'pipette.pick_tip', at: 'tips', commit: 'tips_pick'},
  mv('reservoir'), lo('reservoir'), {stage: 'aspirating', primitive: 'pipette.aspirate', at: 'reservoir', commit: 'reservoir_aspirate'}, ra('reservoir'),
  mv('row'), lo('row'), {stage: 'dispensing', primitive: 'pipette.dispense', at: 'row', commit: 'row_dispense'}, ra('row'),
  mv('waste'), {stage: 'dropping_tip', primitive: 'pipette.drop_tip', at: 'waste', commit: 'tips_drop'},
  {stage: 'moving', primitive: 'motion.park', at: 'home'},
];
export const IMAGING_SCAN_STAGES: StagePlan[] = [
  {stage: 'moving', primitive: 'motion.move_to_station', at: 'well'},
  {stage: 'scanning', primitive: 'camera.capture', at: 'plate', commit: 'scan_capture'},
  {stage: 'moving', primitive: 'motion.park', at: 'home'},
];

const id = (description: string): JsonSchema => ({type: 'string', pattern: RESOURCE_ID_PATTERN, description});
const rowScope = {
  plate_id: id('Target plate, e.g. plate-01'),
  row_id: {type: 'string', pattern: ROW_ID_PATTERN,
    description: 'Complete plate row. The row pipette aligns every channel with every well of the row (e.g. A -> A1–A6) and aspirates/dispenses them simultaneously.'},
  wells: {type: 'array', minItems: 1, uniqueItems: true, items: {type: 'string', pattern: WELL_ID_PATTERN},
    description: 'Optional scope confirmation. If given it MUST list exactly the complete row; a partial row is rejected (never silently expanded).'},
};
const actionRef = 'ActionRef';

export const CAPABILITIES: Capability[] = [
  {
    name: 'device.describe', version: '1.0.0', access: 'read', execution: 'sync',
    description: 'Device description, capabilities, ranges and units.',
    http: {method: 'GET', path: '/api/v1/devices/{device_id}/manifest'}, resources: [],
    input_schema: {type: 'object', additionalProperties: false, properties: {device_id: id('Device id')}},
    result_type: 'Manifest',
  },
  {
    name: 'device.read_state', version: '1.0.0', access: 'read', execution: 'sync',
    description: 'Current observable state: wells, inventory, busy resources, revisions, active actions and event_seq. Contains no simulator truth.',
    http: {method: 'GET', path: '/api/v1/experiments/{experiment_id}/state'}, resources: [],
    input_schema: {type: 'object', additionalProperties: false, properties: {plate_id: id('Optional plate filter')}},
    result_type: 'StateSnapshot',
  },
  {
    name: 'media.add', version: '1.0.0', access: 'write', execution: 'async',
    description: 'Add fresh medium to one complete plate row with the row pipette. volume_ul_per_well is added to every well of the row simultaneously. Total reservoir use = volume × channels; tips used = channels.',
    http: {method: 'POST', path: '/api/v1/experiments/{experiment_id}/actions'},
    resources: ['head', 'plate', 'reservoir', 'tips'],
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['plate_id', 'row_id', 'reservoir_id', 'volume_ul_per_well'],
      properties: {...rowScope, reservoir_id: id('Medium reservoir, e.g. media-01'),
        volume_ul_per_well: {type: 'number', exclusiveMinimum: 0, maximum: P.liquid.max_add_ul_per_well,
          description: 'µL added to EACH well of the row'}},
    },
    limits_ref: `profile://${DEVICE_ID}/liquid`,
    constraints: ['complete_row', 'well_capacity', 'reservoir_available', 'tips_available', 'plate_not_shaking', 'channel_volume'],
    result_type: actionRef, cancellation: 'between_committed_steps',
    stages: MEDIA_ADD_STAGES.map(s => `${s.stage}@${s.at}`),
  },
  {
    name: 'media.exchange', version: '1.0.0', access: 'write', execution: 'async',
    description: 'Exchange a fraction of medium in one complete row: each channel removes fraction×V_well of its own well to waste, then adds the same volume of fresh medium. Requires fraction ≤ 1 − V_min/V for every well of the row, otherwise the whole request is rejected. Uses two tip sets (removal + fresh).',
    http: {method: 'POST', path: '/api/v1/experiments/{experiment_id}/actions'},
    resources: ['head', 'plate', 'reservoir', 'waste', 'tips'],
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['plate_id', 'row_id', 'reservoir_id', 'fraction'],
      properties: {...rowScope, reservoir_id: id('Medium reservoir'), waste_id: id('Waste container (default waste-01)'),
        fraction: {type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Per-well fraction 0–1 (not a whole-plate fraction)'}},
    },
    limits_ref: `profile://${DEVICE_ID}/liquid`,
    constraints: ['complete_row', 'min_residual', 'reservoir_available', 'waste_capacity', 'tips_available', 'plate_not_shaking', 'channel_volume'],
    result_type: actionRef, cancellation: 'between_committed_steps',
    stages: MEDIA_EXCHANGE_STAGES.map(s => `${s.stage}@${s.at}`),
  },
  {
    name: 'imaging.scan', version: '1.0.0', access: 'write', execution: 'async',
    description: 'Scan wells with the head-mounted virtual camera. mono → one PNG; stereo → left/right PNGs from the same frozen sim instant. Produces an observation with device_estimate values (simulated_onboard_analysis). Occupies the head and the plate.',
    http: {method: 'POST', path: '/api/v1/experiments/{experiment_id}/actions'},
    resources: ['head', 'plate'],
    input_schema: {
      type: 'object', additionalProperties: false, required: ['plate_id', 'wells'],
      properties: {plate_id: id('Target plate'),
        wells: {type: 'array', minItems: 1, maxItems: P.imaging.max_wells_per_scan, uniqueItems: true,
          items: {type: 'string', pattern: WELL_ID_PATTERN}, description: 'Individual wells to image'},
        mode: {enum: ['mono', 'stereo'], default: 'mono'},
        view: {enum: ['medium_overview', 'culture_detail'], default: 'medium_overview'}},
    },
    constraints: ['plate_not_shaking', 'camera_available'],
    result_type: actionRef, cancellation: 'between_committed_steps',
    stages: IMAGING_SCAN_STAGES.map(s => `${s.stage}@${s.at}`),
  },
  {
    name: 'environment.set_targets', version: '1.0.0', access: 'write', execution: 'immediate',
    description: 'Set chamber targets. Commits immediately (succeeded in the accepting response); the observed values then follow first-order inertia. At least one field.',
    http: {method: 'POST', path: '/api/v1/experiments/{experiment_id}/actions'},
    resources: ['chamber'],
    input_schema: {
      type: 'object', additionalProperties: false, required: ['chamber_id'], minProperties: 2,
      properties: {chamber_id: id(`Chamber, e.g. ${CHAMBER_ID}`),
        temperature_c: {type: 'number', minimum: P.environment.temperature_c.min, maximum: P.environment.temperature_c.max, description: '°C'},
        co2_pct: {type: 'number', minimum: P.environment.co2_pct.min, maximum: P.environment.co2_pct.max, description: 'Percent 0–100 (not a 0–1 ratio)'},
        humidity_pct: {type: 'number', minimum: P.environment.humidity_pct.min, maximum: P.environment.humidity_pct.max, description: 'Percent RH 0–100'}},
    },
    limits_ref: `profile://${DEVICE_ID}/environment`,
    result_type: actionRef, cancellation: 'not_applicable',
  },
  {
    name: 'environment.read', version: '1.0.0', access: 'read', execution: 'sync',
    description: 'Per parameter target, observed (synthetic_sensor), error, quality and sampled_at_sim_s.',
    http: {method: 'GET', path: '/api/v1/experiments/{experiment_id}/chambers/{chamber_id}'}, resources: [],
    input_schema: {type: 'object', additionalProperties: false, required: ['chamber_id'], properties: {chamber_id: id('Chamber')}},
    result_type: 'ChamberReading',
  },
  {
    name: 'environment.await_stable', version: '1.0.0', access: 'write', execution: 'async',
    description: `Wait until every target stays within profile tolerance for ${P.environment.stable_hold_s} sim s. Ends with target_changed if the targets change meanwhile, or timeout.`,
    http: {method: 'POST', path: '/api/v1/experiments/{experiment_id}/actions'}, resources: [],
    input_schema: {
      type: 'object', additionalProperties: false, required: ['chamber_id', 'timeout_sim_s'],
      properties: {chamber_id: id('Chamber'), profile_id: {type: 'string', description: 'Tolerance profile (default demo)'},
        timeout_sim_s: {type: 'number', exclusiveMinimum: 0, maximum: P.environment.max_await_s}},
    },
    result_type: actionRef, cancellation: 'between_committed_steps',
  },
  {
    name: 'plate.shake', version: '1.0.0', access: 'write', execution: 'async',
    description: `Orbital shake of the plate on its station carrier (schematic, ${P.shake.orbit_mm} mm orbit). Occupies only the plate; liquid actions and scans on that plate are rejected while shaking. Images are blurred until ${P.shake.settle_s} s after the end.`,
    http: {method: 'POST', path: '/api/v1/experiments/{experiment_id}/actions'}, resources: ['plate'],
    input_schema: {
      type: 'object', additionalProperties: false, required: ['plate_id', 'speed_rpm', 'duration_sim_s'],
      properties: {plate_id: id('Target plate'), pattern: {enum: ['orbital'], default: 'orbital'},
        speed_rpm: {type: 'number', minimum: P.shake.speed_rpm.min, maximum: P.shake.speed_rpm.max},
        duration_sim_s: {type: 'number', minimum: P.shake.duration_s.min, maximum: P.shake.duration_s.max}},
    },
    limits_ref: `profile://${DEVICE_ID}/shake`,
    result_type: actionRef, cancellation: 'between_committed_steps', stages: ['shaking'],
  },
  {
    name: 'action.get', version: '1.0.0', access: 'read', execution: 'sync',
    description: 'Action status, stages, committed effects and result. After a network failure query this (or by idempotency key) before retrying.',
    http: {method: 'GET', path: '/api/v1/experiments/{experiment_id}/actions/{action_id}'}, resources: [],
    input_schema: {type: 'object', additionalProperties: false, required: ['action_id'], properties: {action_id: {type: 'string'}}},
    result_type: 'Action',
  },
  {
    name: 'action.cancel', version: '1.0.0', access: 'write', execution: 'immediate',
    description: 'Stop at the next committed step boundary. Committed effects are kept (partial=true); nothing is re-executed.',
    http: {method: 'POST', path: '/api/v1/experiments/{experiment_id}/actions/{action_id}/cancel'}, resources: [],
    input_schema: {type: 'object', additionalProperties: false, required: ['action_id'], properties: {action_id: {type: 'string'}}},
    result_type: 'Action',
  },
  {
    name: 'observation.get', version: '1.0.0', access: 'read', execution: 'sync',
    description: 'Immutable scan result: provenance, quality, device_estimate per well, image asset refs with sha256.',
    http: {method: 'GET', path: '/api/v1/experiments/{experiment_id}/observations/{observation_id}'}, resources: [],
    input_schema: {type: 'object', additionalProperties: false, required: ['observation_id'], properties: {observation_id: {type: 'string'}}},
    result_type: 'Observation',
  },
];

export const WRITE_CAPABILITIES = CAPABILITIES.filter(c => c.access === 'write' && c.http.path.endsWith('/actions')).map(c => c.name);

export function getCapability(name: string): Capability | undefined {
  return CAPABILITIES.find(c => c.name === name);
}

export function buildManifest(): Manifest {
  return {
    profile: PROFILE_ID, device_id: DEVICE_ID, driver: 'simulator', manifest_version: '0.1.0', api_version: 'v1',
    units: {volume: 'µL', time: 'simulated seconds (sim_s)', temperature: '°C', co2: '% (0–100)', humidity: '% RH (0–100)',
      fraction: '0–1', speed: 'rpm', pitch: 'mm'},
    limits: {
      [`profile://${DEVICE_ID}/liquid`]: {...P.liquid, head: P.head},
      [`profile://${DEVICE_ID}/environment`]: P.environment,
      [`profile://${DEVICE_ID}/shake`]: P.shake,
      [`profile://${DEVICE_ID}/imaging`]: P.imaging,
      [`profile://${DEVICE_ID}/observation`]: P.observation,
      [`profile://${DEVICE_ID}/clock`]: {sim_step_s: P.sim_step_s, lease: P.lease, wait: P.wait},
    },
    capabilities: CAPABILITIES,
    notes: [
      P.note,
      'Liquid handling is row-parallel: one head of 6 channels, 21.6 mm pitch, one complete 6-well row per action (demo configuration, not hardware calibration).',
      'Tip pickup geometry between the 96-position rack and the 6-channel head is schematic; tips are tracked as logical inventory.',
      'Images are deterministic synthetic PNGs; estimates are simulated onboard analysis, not biological measurements.',
    ],
  };
}

/** Tool name rule (§7.1): '.' -> '_'. */
export const toolName = (capability: string): string => capability.replaceAll('.', '_');
export const capabilityFromTool = (tool: string): string | undefined =>
  CAPABILITIES.find(c => toolName(c.name) === tool)?.name;
