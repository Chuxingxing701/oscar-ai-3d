// Same-origin gateway /api/v1/agent/* -> Agent (operator only; run tokens are
// forbidden). Attaches X-Service-Token, streams responses including SSE with
// Last-Event-ID passthrough, 503 agent_unavailable when the Agent is down.
import type {IncomingMessage, ServerResponse} from 'node:http';
import {DeviceError} from '@oscar/device-contract';
import type {RuntimeConfig} from './config.ts';

export async function proxyToAgent(config: RuntimeConfig, serviceToken: string, req: IncomingMessage,
  res: ServerResponse, subPath: string, body: Buffer | null): Promise<void> {
  const target = `${config.agentUrl}${subPath}${new URL(req.url ?? '/', 'http://x').search}`;
  const headers: Record<string, string> = {
    'x-service-token': serviceToken,
    accept: String(req.headers.accept ?? '*/*'),
  };
  if (body) headers['content-type'] = 'application/json';
  if (typeof req.headers['last-event-id'] === 'string') headers['last-event-id'] = req.headers['last-event-id'];

  let response: Response;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 30_000);
  const disconnected = (): void => {controller.abort();};
  res.once('close', disconnected);
  const cleanup = (): void => {clearTimeout(deadline); res.off('close', disconnected);};
  try {
    response = await fetch(target, {method: req.method, headers,
      body: body ? new Uint8Array(body) : undefined, signal: controller.signal});
  } catch (e) {
    cleanup();
    if (res.destroyed) return;
    const err = new DeviceError('agent_unavailable', `Agent at ${config.agentUrl} is not reachable`,
      {target: subPath});
    res.writeHead(err.status, {'content-type': 'application/json'});
    res.end(JSON.stringify(err.toBody()));
    void e;
    return;
  }
  const outHeaders: Record<string, string> = {};
  const contentType = response.headers.get('content-type');
  // Bound connection setup, not the lifetime of a healthy SSE subscription.
  // Downstream disconnect still aborts the upstream reader via controller.
  if (contentType?.includes('text/event-stream')) clearTimeout(deadline);
  if (contentType) outHeaders['content-type'] = contentType;
  const cache = response.headers.get('cache-control');
  if (cache) outHeaders['cache-control'] = cache;
  res.writeHead(response.status, outHeaders);
  if (!response.body) {
    cleanup();
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
        if (contentType?.includes('text/event-stream')) (res as {flush?: () => void}).flush?.();
      }
    }
  } catch {
    // client went away or stream error: just end
  }
  cleanup();
  res.end();
}
