// DeviceClient: the single HTTP client used by the Agent, CLI, demos and tests.
// It sends Bearer tokens and never an Origin header (Node fetch sends none).
import {DeviceError, isErrorCode, type ApiErrorBody} from './errors.ts';
import type {Action, ChamberReading, ControlRequest, DeviceEvent, ExperimentInfo, Lease, Observation,
  StateSnapshot, SubmitActionRequest, WakeCondition} from './types.ts';
import type {Manifest} from './manifest.ts';

export interface DeviceClientOptions {
  baseUrl: string;
  token?: string | (() => string | undefined);
  /** Extra headers, e.g. a browser-side client adds nothing; tests may add Origin. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface SubmitOptions { idempotencyKey?: string; leaseId?: number | null; signal?: AbortSignal }
export interface SubmitResult { status: number; action: Action }
export interface ReleaseResult { lease: Lease; next_lease: Lease | null }

export class DeviceClient {
  readonly baseUrl: string;
  private readonly opts: DeviceClientOptions;
  constructor(opts: DeviceClientOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
  }

  private token(): string | undefined {
    return typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token;
  }

  async request<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {},
    signal?: AbortSignal): Promise<{status: number; body: T; headers: Headers}> {
    const headers: Record<string, string> = {...(this.opts.headers ?? {}), ...extra};
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    const response = await (this.opts.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = {code: 'internal', message: text.slice(0, 200)}; }
    }
    if (!response.ok) {
      const err = parsed as Partial<ApiErrorBody> | null;
      const code = isErrorCode(err?.code) ? err.code : 'internal';
      throw new DeviceError(code, err?.message ?? `HTTP ${response.status}`,
        {...(err?.details ?? {}), http_status: response.status}, err?.action_id);
    }
    return {status: response.status, body: parsed as T, headers: response.headers};
  }

  private async get<T>(path: string): Promise<T> { return (await this.request<T>('GET', path)).body; }
  private exp(id: string): string { return `/api/v1/experiments/${encodeURIComponent(id)}`; }

  health() { return this.get<{ok: boolean; service: string; version: string}>('/api/v1/health'); }
  devices() { return this.get<{devices: {device_id: string; profile: string; manifest_version: string}[]}>('/api/v1/devices'); }
  manifest(deviceId = 'oscar-01') { return this.get<Manifest>(`/api/v1/devices/${deviceId}/manifest`); }
  experiments() { return this.get<{current_id: string | null; experiments: ExperimentInfo[]}>('/api/v1/experiments'); }
  async currentExperimentId(): Promise<string> {
    const list = await this.experiments();
    if (!list.current_id) throw new DeviceError('not_found', 'No active experiment');
    return list.current_id;
  }
  async createExperiment(body: {scenario_id?: string; seed?: number; clock_mode?: 'lockstep' | 'realtime'}) {
    return (await this.request<ExperimentInfo>('POST', '/api/v1/experiments', body)).body;
  }
  state(experimentId: string, plateId?: string) {
    return this.get<StateSnapshot>(`${this.exp(experimentId)}/state${plateId ? `?plate_id=${encodeURIComponent(plateId)}` : ''}`);
  }
  chamber(experimentId: string, chamberId = 'chamber-01') {
    return this.get<ChamberReading>(`${this.exp(experimentId)}/chambers/${chamberId}`);
  }
  async submit(experimentId: string, req: SubmitActionRequest, opts: SubmitOptions = {}): Promise<SubmitResult> {
    const extra: Record<string, string> = {};
    if (opts.idempotencyKey) extra['idempotency-key'] = opts.idempotencyKey;
    if (opts.leaseId != null) extra['lease-id'] = String(opts.leaseId);
    const r = await this.request<Action>('POST', `${this.exp(experimentId)}/actions`, {device_id: 'oscar-01', ...req}, extra, opts.signal);
    return {status: r.status, action: r.body};
  }
  action(experimentId: string, actionId: string) { return this.get<Action>(`${this.exp(experimentId)}/actions/${actionId}`); }
  async actionByKey(experimentId: string, key: string): Promise<Action | null> {
    try { return await this.get<Action>(`${this.exp(experimentId)}/actions/by-key/${encodeURIComponent(key)}`); }
    catch (e) { if (e instanceof DeviceError && e.code === 'not_found') return null; throw e; }
  }
  actions(experimentId: string) { return this.get<{actions: Action[]}>(`${this.exp(experimentId)}/actions`); }
  async cancel(experimentId: string, actionId: string, leaseId?: number | null) {
    const extra: Record<string, string> = leaseId != null ? {'lease-id': String(leaseId)} : {};
    return (await this.request<Action>('POST', `${this.exp(experimentId)}/actions/${actionId}/cancel`, {}, extra)).body;
  }
  observations(experimentId: string) {
    return this.get<{observations: Observation[]}>(`${this.exp(experimentId)}/observations`).then(r => r.observations);
  }
  observation(experimentId: string, id: string) { return this.get<Observation>(`${this.exp(experimentId)}/observations/${id}`); }
  async asset(experimentId: string, assetId: string): Promise<Uint8Array> {
    const headers: Record<string, string> = {...(this.opts.headers ?? {})};
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await (this.opts.fetch ?? fetch)(`${this.baseUrl}${this.exp(experimentId)}/assets/${assetId}`, {headers});
    if (!r.ok) throw new DeviceError(r.status === 404 ? 'not_found' : r.status === 401 ? 'unauthenticated' : 'forbidden', `asset HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  events(experimentId: string, afterSeq = 0, limit = 1000) {
    return this.get<{events: DeviceEvent[]; last_seq: number; archived: boolean; successor_id: string | null}>(
      `${this.exp(experimentId)}/events?after_seq=${afterSeq}&limit=${limit}&format=json`);
  }
  async control(experimentId: string, body: ControlRequest) {
    return (await this.request<Record<string, unknown>>('POST', `${this.exp(experimentId)}/control`, body)).body;
  }
  async currentLease(experimentId: string): Promise<Lease | null> {
    return (await this.get<{lease: Lease | null}>(`${this.exp(experimentId)}/leases/current`)).lease;
  }
  async renewLease(experimentId: string, leaseId: number) {
    return (await this.request<Lease>('POST', `${this.exp(experimentId)}/leases/${leaseId}/renew`, {})).body;
  }
  async releaseLease(experimentId: string, leaseId: number, wake: WakeCondition) {
    return (await this.request<ReleaseResult>('POST', `${this.exp(experimentId)}/leases/${leaseId}/release`, {wake})).body;
  }

  /**
   * Stream device events over SSE (fetch-based, supports Bearer + Last-Event-ID).
   * Yields events in seq order; stops when signal aborts or the server closes.
   */
  async *stream(experimentId: string, afterSeq: number, signal: AbortSignal): AsyncGenerator<DeviceEvent> {
    const headers: Record<string, string> = {accept: 'text/event-stream', ...(this.opts.headers ?? {})};
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (afterSeq > 0) headers['last-event-id'] = String(afterSeq);
    const r = await (this.opts.fetch ?? fetch)(`${this.baseUrl}${this.exp(experimentId)}/events?after_seq=${afterSeq}`, {headers, signal});
    if (!r.ok || !r.body) throw new DeviceError(r.status === 401 ? 'unauthenticated' : 'internal', `SSE HTTP ${r.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, {stream: true});
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const parsed = JSON.parse(data) as DeviceEvent;
        if (typeof parsed.seq === 'number') yield parsed;
      }
    }
  }
}
