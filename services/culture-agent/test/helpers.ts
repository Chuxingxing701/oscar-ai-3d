// In-process test helpers for the culture-agent: a minimal FakeRuntime
// implementing just the API surface the loop touches, plus snapshot fixtures.
import {createServer, type Server} from 'node:http';
import {buildManifest, type Action, type ActionStatus, type Lease, type StateSnapshot} from '@oscar/device-contract';

export const SERVICE_TOKEN = 'test-service-token';

export function wellVolumes(row: number[]): Array<{well_id: string; volume_ul: number; capacity_ul: number; medium_id: string | null}> {
  return row.map((v, i) => ({well_id: `A${i + 1}`, volume_ul: v, capacity_ul: 2000, medium_id: 'medium-a'}));
}

export function makeSnapshot(scenarioId: string, simTime: number, rowA: number[], overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  const wellsA = wellVolumes(rowA);
  const other = ['B', 'C', 'D'].flatMap(r => Array.from({length: 6}, (_, i) => ({well_id: `${r}${i + 1}`, volume_ul: 800,
    capacity_ul: 2000, medium_id: 'medium-a'})));
  return {
    experiment: {experiment_id: 'exp-001', scenario_id: scenarioId, scenario_version: '1.0.0',
      simulator_version: '0.1.0', seed: 42, status: 'active', sim_time_s: simTime, clock_mode: 'lockstep',
      paused: false, speed: 600, reset_from: null, successor_id: null, determinism_broken: false,
      created_at_wall: '2026-09-30T00:00:00Z'},
    event_seq: 10,
    device: {device_id: 'oscar-01', mode: 'simulation', manifest_version: '0.1.0', health: 'ok'},
    chamber: {chamber_id: 'chamber-01', target_revision: 1, provenance: 'synthetic_sensor',
      temperature_c: {target: 37, observed: 37, error: 0, quality: 'ok', sampled_at_sim_s: simTime},
      co2_pct: {target: 5, observed: 5, error: 0, quality: 'ok', sampled_at_sim_s: simTime},
      humidity_pct: {target: 95, observed: 95, error: 0, quality: 'ok', sampled_at_sim_s: simTime},
      stable: true},
    plates: [{plate_id: 'plate-01', station_id: 'Station_1_2', format: '24', rows: ['A', 'B', 'C', 'D'], columns: 6,
      revision: 0, shake: {active: false, started_at_sim_s: 0, duration_sim_s: 0},
      wells: [...wellsA, ...other]}],
    reservoirs: [{id: 'media-01', station_id: 'Station_3_3', medium_id: 'medium-a', remaining_ul: 50000, capacity_ul: 50000}],
    wastes: [{id: 'waste-01', station_id: 'Station_3_4', used_ul: 0, capacity_ul: 100000}],
    tips: [{id: 'tips-01', station_id: 'Station_4_1', remaining: 96, capacity: 96}],
    busy_resources: {},
    active_actions: [],
    head: null,
    lease: null,
    run: null,
    revisions: {'chamber:chamber-01': 1, 'plate:plate-01': 0},
    ...overrides,
  };
}

export function fakeLease(leaseId: number, runId: string, simTime: number): Lease {
  return {lease_id: leaseId, experiment_id: 'exp-001', run_id: runId, state: 'active', frozen_at_sim_s: simTime,
    event_seq: 9, triggers: [{kind: 'run_started'}], expires_at_wall: new Date(Date.now() + 30_000).toISOString(),
    granted_at_wall: new Date().toISOString(), wake: null};
}

export function fakeAction(actionId: string, capability: string, status: ActionStatus, args: Record<string, unknown>,
  opts: {result?: Record<string, unknown>; ended?: number; submitted?: number; runId?: string} = {}): Action {
  return {
    action_id: actionId, experiment_id: 'exp-001', device_id: 'oscar-01', capability, arguments: args,
    status, principal: {kind: 'run', id: `run:${opts.runId ?? 'run-001-1'}`, run_id: opts.runId ?? 'run-001-1'},
    run_id: opts.runId ?? 'run-001-1', basis: 'scripted', reason: 'test', evidence_refs: [],
    idempotency_key: null, resources: [], accept_seq: 1, submitted_at_sim_s: opts.submitted ?? 0,
    started_at_sim_s: status === 'queued' ? null : opts.submitted ?? 0,
    ended_at_sim_s: opts.ended ?? (status === 'queued' ? null : 10),
    stages: [], current_stage_index: null, effects: [], summary: {wells: {}, reservoir_delta_ul: 0, waste_delta_ul: 0, tips_used: 0},
    partial: false, cancel_reason: null, error: null, result: opts.result ?? null,
  };
}

/**
 * Minimal Runtime double for the endpoints the loop touches. Requests are
 * logged; actions can be planted for by-key lookups.
 */
export class FakeRuntime {
  readonly requests: Array<{method: string; path: string}> = [];
  private readonly server: Server;
  private sseClose: Array<() => void> = [];
  lease: Lease | null = null;
  snapshot: StateSnapshot;
  actionsByKey = new Map<string, Action>();

  constructor(snapshot: StateSnapshot) {
    this.snapshot = snapshot;
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => res.destroy());
    });
  }

  async start(): Promise<string> {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const close of this.sseClose) close();
    await new Promise<void>(r => this.server.close(() => r()));
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    this.requests.push({method: req.method ?? 'GET', path});
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && path === '/api/v1/devices/oscar-01/manifest') return json(200, buildManifest());
    if (req.method === 'GET' && path === '/api/v1/experiments/exp-001/state') return json(200, this.snapshot);
    if (req.method === 'GET' && path === '/api/v1/experiments/exp-001/leases/current') return json(200, {lease: this.lease});
    if (req.method === 'GET' && path === '/api/v1/experiments/exp-001/events') {
      if (url.searchParams.get('format') === 'json') return json(200, {events: [], last_seq: 0});
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write(': connected\n\n');
      const onClose = (): void => { res.end(); };
      req.on('close', onClose);
      this.sseClose.push(() => res.end());
      return;
    }
    const byKey = /^\/api\/v1\/experiments\/exp-001\/actions\/by-key\/(.+)$/.exec(path);
    if (req.method === 'GET' && byKey) {
      const action = this.actionsByKey.get(decodeURIComponent(byKey[1]));
      if (!action) return json(404, {code: 'not_found', message: 'unknown key'});
      return json(200, action);
    }
    const actionGet = /^\/api\/v1\/experiments\/exp-001\/actions\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && actionGet) {
      for (const a of this.actionsByKey.values()) {
        if (a.action_id === actionGet[1]) return json(200, a);
      }
      return json(404, {code: 'not_found', message: 'unknown action'});
    }
    if (req.method === 'POST' && path === '/api/v1/runs/run-001-1/agent-status') return json(200, {ok: true});
    if (req.method === 'GET' && path === '/api/v1/runs/run-001-1') {
      return json(200, {run_id: 'run-001-1', status: 'active', reason: null});
    }
    if (req.method === 'POST' && path === '/api/v1/experiments/exp-001/actions') {
      return json(500, {code: 'internal', message: 'fake runtime rejects submits'});
    }
    json(404, {code: 'not_found', message: `fake runtime has no ${req.method} ${path}`});
  }
}

/** fetch wrapper that makes every action submission "crash" (network death). */
export function crashingSubmitFetch(inner: typeof fetch): typeof fetch {
  let crashed = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && /\/api\/v1\/experiments\/[^/]+\/actions$/.test(url) && crashed < 3) {
      crashed += 1;
      throw new TypeError('fetch failed: connection reset by peer (injected)');
    }
    return inner(input, init);
  }) as typeof fetch;
}
