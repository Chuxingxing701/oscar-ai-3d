// Culture Agent service: HTTP API for the Runtime gateway (service token),
// run bookkeeping, per-run control loops and startup reconciliation.
// Listens ONLY on 127.0.0.1. Every request must carry X-Service-Token.
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import {DeviceClient, DeviceError, type Lease} from '@oscar/device-contract';
import {emptyMemory} from '@oscar/culture-policy';
import type {AgentConfig} from './config.ts';
import {AgentStore, type AgentEvent, type RunRow} from './store.ts';
import {RunLoop, type LoopDeps} from './loop.ts';

export interface RunAcceptPayload {
  run_id: string;
  run_token: string;
  experiment_id: string;
  clock_mode: 'lockstep' | 'realtime';
  lease: Lease | null;
  mode: 'scripted' | 'llm';
  goal?: string;
  plates?: string[];
  capabilities?: string[];
  budget?: {max_actions: number; actions_used?: number};
  scenario_id: string;
  seed: number;
}

export interface AgentOptions {
  config: AgentConfig;
  /** Service token provider; null while the token file has not appeared yet. */
  getServiceToken: () => string | null;
  store: AgentStore;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

const MAX_BODY = 2 * 1024 * 1024;

export class CultureAgent {
  readonly store: AgentStore;
  readonly server: Server;
  private readonly opts: AgentOptions;
  private readonly loops = new Map<string, RunLoop>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private port = 0;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        if (e instanceof DeviceError && !res.headersSent) {
          res.writeHead(e.status, {'content-type': 'application/json'});
          res.end(JSON.stringify(e.toBody()));
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        this.log(`[agent] internal error ${req.method} ${req.url}: ${message}`);
        if (!res.headersSent) {
          res.writeHead(500, {'content-type': 'application/json'});
          res.end(JSON.stringify({error: 'internal', message}));
        } else {
          res.end();
        }
      });
    });
  }

  private log(message: string): void { (this.opts.log ?? console.log)(message); }

  async listen(port: number, host = '127.0.0.1'): Promise<number> {
    await new Promise<void>(resolvePromise => this.server.listen(port, host, resolvePromise));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : port;
    return this.port;
  }

  /**
   * Stop every loop, abort their in-flight Runtime requests and wait until
   * each main() has exited, so no late response can submit or write after
   * close() resolves. Open SSE connections are closed too.
   */
  async close(): Promise<void> {
    const loops = [...this.loops.values()];
    for (const loop of loops) loop.stop();
    this.loops.clear();
    await Promise.race([Promise.all(loops.map(l => l.done)), new Promise(r => setTimeout(r, 5000).unref())]);
    await new Promise<void>(resolvePromise => {
      this.server.close(() => resolvePromise());
      this.server.closeAllConnections();
    });
  }

  get boundPort(): number { return this.port; }

  // -- event fan-out for SSE subscribers ---------------------------------------

  onEvents(runId: string, fn: () => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) this.listeners.set(runId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private notify(runId: string): void {
    const set = this.listeners.get(runId);
    if (set) for (const fn of set) fn();
  }

  emitEvent(runId: string, type: string, payload: Record<string, unknown>): AgentEvent {
    const event = this.store.appendEvent(runId, type, payload);
    this.notify(runId);
    return event;
  }

  // -- HTTP -------------------------------------------------------------------

  private authorized(req: IncomingMessage): boolean {
    const serviceToken = this.opts.getServiceToken();
    if (!serviceToken) return false;
    const header = req.headers['x-service-token'];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== 'string' || value.length === 0) return false;
    // constant-time compare over sha digests (equal length buffers)
    return timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(serviceToken).digest());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.opts.getServiceToken()) {
      res.writeHead(503, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: 'service_unavailable', message: 'service token not loaded yet (Runtime not started?)'}));
      return;
    }
    if (!this.authorized(req)) {
      res.writeHead(401, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: 'unauthenticated', message: 'X-Service-Token is required'}));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (path === '/health' && method === 'GET') {
      return this.sendJson(res, 200, {ok: true, service: 'oscar-culture-agent', version: '0.1.0'});
    }
    let body: Record<string, unknown> | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      body = await this.readJsonBody(req);
      if (body === null) {
        res.writeHead(415, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: 'unsupported_media_type', message: 'Content-Type must be application/json'}));
        return;
      }
    }
    if (path === '/runs' && method === 'POST') {
      return this.handleAccept(res, body ?? {});
    }
    if (path === '/runs' && method === 'GET') {
      return this.sendJson(res, 200, {runs: this.store.listRuns().map(r => this.runSummary(r))});
    }
    const runMatch = /^\/runs\/([^/]+)(\/[^/]*)?$/.exec(path);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      const rest = runMatch[2] ?? '';
      const run = this.store.getRun(runId);
      if (!run) throw new DeviceError('not_found', `No run ${runId}`);
      if (rest === '' && method === 'GET') {
        return this.sendJson(res, 200, this.runSummary(run, true));
      }
      if (rest === '/events' && method === 'GET') {
        return this.handleEvents(req, res, runId, url);
      }
      if (rest === '/control' && method === 'POST') {
        return this.handleControl(res, run, body ?? {});
      }
      throw new DeviceError('not_found', `No route ${method} ${path}`);
    }
    throw new DeviceError('not_found', `No route ${method} ${path}`);
  }

  private runSummary(run: RunRow, withReport = false): Record<string, unknown> {
    const events = this.store.eventsAfter(run.run_id, 0, 100_000);
    const counts = {
      decisions: events.filter(e => e.type === 'decision').length,
      actions: events.filter(e => e.type === 'action.submitted').length,
      observations: events.filter(e => e.type === 'observation.recorded').length,
    };
    return {
      run_id: run.run_id, experiment_id: run.experiment_id, scenario: run.scenario_id, mode: run.mode,
      goal: run.goal, clock_mode: run.clock_mode, status: run.status, pause_reason: run.pause_reason,
      counts, report_present: run.report != null, created_at_wall: run.created_at_wall,
      updated_at_wall: run.updated_at_wall,
      ...(withReport ? {report: run.report} : {}),
    };
  }

  // -- run acceptance -----------------------------------------------------------

  private handleAccept(res: ServerResponse, body: Record<string, unknown>): void {
    const p = body as unknown as RunAcceptPayload;
    if (typeof p.run_id !== 'string' || typeof p.run_token !== 'string' || typeof p.experiment_id !== 'string'
      || typeof p.scenario_id !== 'string' || (p.clock_mode !== 'lockstep' && p.clock_mode !== 'realtime')) {
      throw new DeviceError('invalid_argument', 'run payload requires run_id, run_token, experiment_id, scenario_id, clock_mode');
    }
    const existing = this.store.getRun(p.run_id);
    if (existing) {
      // duplicate forward (Runtime retry): never start a second loop
      return this.sendJson(res, 202, {run_id: p.run_id, accepted: true, duplicate: true});
    }
    const row: RunRow = {
      run_id: p.run_id, experiment_id: p.experiment_id, scenario_id: p.scenario_id, seed: Number(p.seed ?? 0),
      mode: p.mode === 'llm' ? 'llm' : 'scripted', goal: p.goal ?? null,
      clock_mode: p.clock_mode === 'realtime' ? 'realtime' : 'lockstep', status: 'active', pause_reason: null,
      plates: p.plates ?? [], capabilities: p.capabilities ?? [],
      budget: {max_actions: p.budget?.max_actions ?? 40, actions_used: 0},
      memory: emptyMemory(), initial_state: null, run_token: p.run_token, decision_counter: 0, report: null,
      created_at_wall: new Date().toISOString(), updated_at_wall: new Date().toISOString(),
    };
    this.store.insertRun(row);
    this.emitEvent(row.run_id, 'run.accepted', {run_id: row.run_id, experiment_id: row.experiment_id,
      mode: row.mode, scenario: row.scenario_id, clock_mode: row.clock_mode, goal: row.goal,
      lease: p.lease ? {lease_id: p.lease.lease_id, frozen_at_sim_s: p.lease.frozen_at_sim_s} : null});
    this.startLoop(row, p.lease ?? null);
    // best-effort initial snapshot for the inventory reconciliation in the report
    void this.captureInitialState(row);
    this.log(`[agent] run ${row.run_id} accepted (${row.mode}/${row.scenario_id}, experiment ${row.experiment_id})`);
    this.sendJson(res, 202, {run_id: row.run_id, accepted: true});
  }

  private startLoop(row: RunRow, lease: Lease | null): void {
    const deps: LoopDeps = {store: this.store, config: this.opts.config, runtimeUrl: this.opts.config.runtimeUrl,
      fetchImpl: this.opts.fetchImpl, emit: (runId, type, payload) => this.emitEvent(runId, type, payload),
      log: message => this.log(message)};
    const loop = new RunLoop(deps, row, lease);
    this.loops.set(row.run_id, loop);
    loop.start();
  }

  private async captureInitialState(row: RunRow): Promise<void> {
    try {
      const client = new DeviceClient({baseUrl: this.opts.config.runtimeUrl, token: row.run_token,
        timeoutMs: 10_000, fetch: this.opts.fetchImpl});
      const state = await client.state(row.experiment_id);
      const initial = {
        captured_at_sim_s: state.experiment.sim_time_s,
        chamber: state.chamber,
        reservoirs: state.reservoirs.map(r => ({id: r.id, remaining_ul: r.remaining_ul})),
        wastes: state.wastes.map(w => ({id: w.id, used_ul: w.used_ul})),
        tips: state.tips.map(t => ({id: t.id, remaining: t.remaining})),
        plates: state.plates.map(p => ({plate_id: p.plate_id,
          wells: p.wells.map(w => ({well_id: w.well_id, volume_ul: w.volume_ul}))})),
      };
      const current = this.store.getRun(row.run_id);
      if (current && current.initial_state == null) {
        this.store.stmt('UPDATE runs SET initial_state=? WHERE run_id=? AND initial_state IS NULL')
          .run(JSON.stringify(initial), row.run_id);
      }
    } catch { /* snapshot unavailable; the report falls back to final-state-only */ }
  }

  // -- control --------------------------------------------------------------------

  private handleControl(res: ServerResponse, run: RunRow, body: Record<string, unknown>): void {
    const action = String(body.action ?? '');
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      throw new DeviceError('invalid_argument', "action must be 'pause' | 'resume' | 'cancel'");
    }
    const loop = this.loops.get(run.run_id);
    if (action === 'pause') {
      loop?.control('pause');
      this.log(`[agent] run ${run.run_id} pause (local: stop issuing new actions)`);
      return this.sendJson(res, 200, {run_id: run.run_id, action: 'pause', status: 'paused'});
    }
    if (action === 'cancel') {
      loop?.control('cancel');
      this.log(`[agent] run ${run.run_id} cancel (Runtime already ended it; writing local report)`);
      return this.sendJson(res, 200, {run_id: run.run_id, action: 'cancel', status: 'ended'});
    }
    // resume: reconcile + continue when the new lease arrives
    if (run.status === 'ended') {
      return this.sendJson(res, 200, {run_id: run.run_id, action: 'resume', status: 'ended'});
    }
    if (!loop || loop.dead) {
      const fresh = this.store.getRun(run.run_id)!;
      // the Runtime created a new barrier (run_resumed) before forwarding;
      // the loop picks it up from leases/current
      void this.reconcileRun(fresh).then(() => {
        const current = this.store.getRun(run.run_id)!;
        if (current.status !== 'ended') this.startLoop(current, null);
      });
      this.log(`[agent] run ${run.run_id} resume (restarted loop after reconcile)`);
      return this.sendJson(res, 200, {run_id: run.run_id, action: 'resume', status: 'active'});
    }
    loop.control('resume');
    this.log(`[agent] run ${run.run_id} resume (reconcile, then continue on the new lease)`);
    return this.sendJson(res, 200, {run_id: run.run_id, action: 'resume', status: 'active'});
  }

  // -- SSE / JSON event listing ------------------------------------------------------

  private handleEvents(req: IncomingMessage, res: ServerResponse, runId: string, url: URL): void {
    const lastEventId = Number(req.headers['last-event-id'] ?? url.searchParams.get('after_seq') ?? 0) || 0;
    if (url.searchParams.get('format') === 'json') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000) || 1000, 10_000);
      const events = this.store.eventsAfter(runId, lastEventId, limit);
      return this.sendJson(res, 200, {events, last_seq: events.at(-1)?.seq ?? lastEventId});
    }
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
    res.write(': connected\n\n');
    let sent = lastEventId;
    const writeEvent = (e: AgentEvent): void => {
      res.write(`id: ${e.seq}\nevent: agent\ndata: ${JSON.stringify(e)}\n\n`);
      sent = e.seq;
    };
    for (const e of this.store.eventsAfter(runId, sent, 10_000)) writeEvent(e);
    const unsubscribe = this.onEvents(runId, () => {
      for (const e of this.store.eventsAfter(runId, sent, 10_000)) writeEvent(e);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref?.();
    req.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  }

  // -- startup reconciliation (design §6.5) ------------------------------------------

  /**
   * On process start: every run that was locally active becomes paused
   * (agent_restarted) and is reported to the Runtime (which revokes its
   * lease). Pending intents are resolved by idempotency key via
   * GET /actions/by-key; NOTHING is resubmitted automatically. Resuming is an
   * explicit operator action (gateway run control resume).
   */
  async reconcileOnStartup(): Promise<void> {
    for (const run of this.store.listRuns()) {
      if (run.status === 'ended') continue;
      if (run.status === 'active') {
        this.store.updateRun(run.run_id, {status: 'paused', pause_reason: 'agent_restarted'});
        this.emitEvent(run.run_id, 'paused', {reason: 'agent_restarted', by: 'agent_restart'});
        await this.postAgentStatus(run, {status: 'paused', reason: 'agent_restarted'});
        this.log(`[agent] startup: run ${run.run_id} paused (agent_restarted), reported to Runtime`);
      }
      await this.reconcileRun(this.store.getRun(run.run_id)!);
    }
  }

  /** Resolve persisted intents without action_id by key; never resubmits. */
  async reconcileRun(run: RunRow): Promise<number> {
    const client = new DeviceClient({baseUrl: this.opts.config.runtimeUrl, token: run.run_token,
      timeoutMs: 10_000, fetch: this.opts.fetchImpl});
    let resolved = 0;
    for (const intent of this.store.pendingIntents(run.run_id)) {
      try {
        const action = await client.actionByKey(run.experiment_id, intent.key);
        if (action) {
          this.store.setIntentAction(run.run_id, intent.key, action.action_id);
          this.emitEvent(run.run_id, 'action.submitted', {key: intent.key, action_id: action.action_id,
            capability: action.capability, status: action.status, recovered: 'by_key_on_restart'});
          resolved += 1;
        } else {
          this.emitEvent(run.run_id, 'error', {where: 'reconcile', code: 'intent_unresolved',
            message: `intent ${intent.key} (${intent.capability}) has no action on the Runtime; it will only be retried with the SAME key if the policy re-plans it after an explicit resume`});
        }
      } catch (e) {
        if (e instanceof DeviceError && e.code === 'unauthenticated') {
          this.markRemoteEnded(run, 'run token rejected during reconciliation (run ended or revoked)');
          return resolved;
        }
        this.emitEvent(run.run_id, 'error', {where: 'reconcile', code: e instanceof DeviceError ? e.code : 'network',
          message: `by-key lookup for ${intent.key} failed: ${e instanceof Error ? e.message : String(e)}`});
      }
    }
    return resolved;
  }

  markRemoteEnded(run: RunRow, why: string): void {
    const current = this.store.getRun(run.run_id);
    if (!current || current.status === 'ended') return;
    this.store.updateRun(run.run_id, {status: 'ended', pause_reason: null,
      report: current.report ?? {run_id: run.run_id, experiment_id: run.experiment_id,
        scenario: run.scenario_id, mode: run.mode, outcome: 'aborted', summary: why}});
    this.emitEvent(run.run_id, 'report', {outcome: 'aborted', summary: why, report_present: true, delivered: false});
    this.loops.get(run.run_id)?.stop();
  }

  private async postAgentStatus(run: RunRow, body: Record<string, unknown>): Promise<void> {
    try {
      const client = new DeviceClient({baseUrl: this.opts.config.runtimeUrl, token: run.run_token,
        timeoutMs: 10_000, fetch: this.opts.fetchImpl});
      await client.request('POST', `/api/v1/runs/${run.run_id}/agent-status`, body);
    } catch (e) {
      const code = e instanceof DeviceError ? e.code : 'network';
      this.emitEvent(run.run_id, 'error', {where: 'agent-status', code,
        message: `${JSON.stringify(body)} could not be delivered: ${e instanceof Error ? e.message : String(e)}`});
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end(JSON.stringify(body));
  }

  private readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolvePromise, reject) => {
      const contentType = String(req.headers['content-type'] ?? '');
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new DeviceError('invalid_request', 'Body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolvePromise({});
        if (!contentType.startsWith('application/json')) return resolvePromise(null);
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch {
          reject(new DeviceError('invalid_request', 'Body is not valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }
}
