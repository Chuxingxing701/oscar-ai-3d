export const ERROR_STATUS = {
  invalid_argument: 422,
  invalid_request: 400,
  not_found: 404,
  experiment_archived: 409,
  revision_conflict: 409,
  resource_busy: 409,
  observation_stale: 409,
  insufficient_media: 409,
  insufficient_tips: 409,
  waste_full: 409,
  capacity_exceeded: 422,
  camera_unavailable: 409,
  simulation_paused: 409,
  run_on_hold: 403,
  run_not_active: 409,
  run_already_active: 409,
  hold_required: 409,
  budget_exhausted: 403,
  experiment_active: 409,
  channel_volume_exceeded: 422,
  lease_required: 409,
  lease_not_active: 409,
  lease_forbidden: 403,
  clock_mode_locked: 409,
  clock_mode_mismatch: 409,
  idempotency_conflict: 409,
  unauthenticated: 401,
  forbidden: 403,
  origin_mismatch: 403,
  host_not_allowed: 403,
  unsupported_media_type: 415,
  rate_limited: 429,
  agent_unavailable: 503,
  model_unavailable: 503,
  internal: 500,
  // C1 additions (action terminal errors / recovery), backwards compatible:
  runtime_restarted: 503,
  target_changed: 409,
  timeout: 409,
  // long-lived culture sessions (D1+): archived sessions are read-only, one
  // active task per session; R07 task queue — a queued task holds no
  // execution slot, so only cancel applies to it (pause/resume → task_queued)
  session_archived: 409,
  task_already_active: 409,
  task_queued: 409,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['resource_busy', 'simulation_paused',
  'agent_unavailable', 'rate_limited', 'internal']);

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  action_id?: string;
  details?: Record<string, unknown>;
}

export class DeviceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly action_id?: string;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, actionId?: string) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.retryable = RETRYABLE.has(code);
    this.details = details;
    this.action_id = actionId;
  }
  toBody(): ApiErrorBody {
    return {code: this.code, message: this.message, retryable: this.retryable,
      ...(this.action_id ? {action_id: this.action_id} : {}), ...(this.details ? {details: this.details} : {})};
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_STATUS;
}
