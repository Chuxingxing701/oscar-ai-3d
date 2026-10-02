// SSE (contract §9): replay persisted events after `after_seq` (query or
// Last-Event-ID), then live push. Non-persisted clock frames ≤10/s, heartbeat
// comments every 15 s, `event: archived` + close for archived experiments.
// `?format=json` gives paged JSON instead.
import type {DeviceEvent} from '@oscar/device-contract';
import type {Runtime} from './runtime.ts';
import type {Auth} from './auth.ts';
import type {IncomingMessage, ServerResponse} from 'node:http';

export function handleEvents(runtime: Runtime, auth: Auth, req: IncomingMessage, res: ServerResponse,
  experimentId: string, url: URL): void {
  const exp = runtime.loadExp(experimentId);
  if (!exp) {
    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({code: 'not_found', message: `No experiment ${experimentId}`, retryable: false}));
    return;
  }
  const lastEventId = Number(req.headers['last-event-id'] ?? url.searchParams.get('after_seq') ?? 0) || 0;

  if (url.searchParams.get('format') === 'json') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000) || 1000, 5000);
    const events = runtime.eventsAfter(experimentId, lastEventId, limit);
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({events, last_seq: exp.event_seq, archived: exp.status === 'archived',
      successor_id: exp.successor_id}));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  let sent = lastEventId;
  const writeEvent = (e: DeviceEvent): void => {
    res.write(`id: ${e.seq}\nevent: device\ndata: ${JSON.stringify(e)}\n\n`);
    sent = e.seq;
  };

  // 1. replay
  for (const e of runtime.eventsAfter(experimentId, sent, 10000)) writeEvent(e);

  if (exp.status !== 'active') {
    res.write(`event: archived\ndata: ${JSON.stringify({experiment_id: experimentId,
      successor_id: exp.successor_id})}\n\n`);
    res.end();
    return;
  }

  // 2. live
  let lastClockFrame = 0;
  const sendClockFrame = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastClockFrame < 100) return; // ≤10/s
    lastClockFrame = now;
    const e2 = runtime.loadExp(experimentId);
    if (!e2) return;
    res.write(`event: clock\ndata: ${JSON.stringify({experiment_id: experimentId, sim_time_s: e2.sim_time_s,
      paused: e2.paused === 1, speed: e2.speed, clock_mode: e2.clock_mode})}\n\n`);
  };
  sendClockFrame(true);
  const unsubscribe = runtime.onEvents(experimentId, () => {
    for (const e of runtime.eventsAfter(experimentId, sent, 10000)) writeEvent(e);
    sendClockFrame();
    const e2 = runtime.loadExp(experimentId);
    if (e2 && e2.status !== 'active') {
      res.write(`event: archived\ndata: ${JSON.stringify({experiment_id: experimentId,
        successor_id: e2.successor_id})}\n\n`);
      cleanup();
      res.end();
    }
  });
  const heartbeat = setInterval(() => {
    const e2 = runtime.loadExp(experimentId);
    if (e2 && e2.status !== 'active') {
      res.write(`event: archived\ndata: ${JSON.stringify({experiment_id: experimentId,
        successor_id: e2.successor_id})}\n\n`);
      cleanup();
      res.end();
      return;
    }
    res.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref?.();
  const onClose = (): void => cleanup();
  req.on('close', onClose);
  const cleanup = (): void => {
    unsubscribe();
    clearInterval(heartbeat);
    req.removeListener('close', onClose);
  };
  void auth;
}
