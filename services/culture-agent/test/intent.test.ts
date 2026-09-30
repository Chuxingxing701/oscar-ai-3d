// Idempotency-intent persistence (design §6.4): the intent (key + canonical
// request) is written to the agent DB BEFORE the HTTP submit. When the
// network dies right after the persist, a restarted agent resolves the intent
// by idempotency key via GET /actions/by-key — it never resubmits blindly.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/store.ts';
import {CultureAgent} from '../src/agent.ts';
import {parseAgentConfig} from '../src/config.ts';
import {crashingSubmitFetch, FakeRuntime, fakeAction, fakeLease, makeSnapshot, SERVICE_TOKEN} from './helpers.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'oscar-agent-intent-'));

async function startAgent(runtimeUrl: string, fetchImpl?: typeof fetch): Promise<CultureAgent> {
  const config = parseAgentConfig(['--port', '0', '--data-dir', dataDir, '--runtime-url', runtimeUrl]);
  const store = new AgentStore(dataDir);
  const agent = new CultureAgent({config, getServiceToken: () => SERVICE_TOKEN, store, fetchImpl,
    log: () => undefined});
  await agent.listen(0);
  return agent;
}

const RUN = {run_id: 'run-001-1', run_token: 'rt_intent', experiment_id: 'exp-001', clock_mode: 'lockstep',
  mode: 'scripted', scenario_id: 'routine_maintenance', seed: 42, plates: ['plate-01'],
  capabilities: ['imaging.scan'], budget: {max_actions: 10}} as const;

test.after(() => {
  try { rmSync(dataDir, {recursive: true, force: true}); } catch { /* ignore */ }
});

test('intent persisted before the HTTP call survives a crashing submit and is reconciled by key on restart', async () => {
  const runtime = new FakeRuntime(makeSnapshot('routine_maintenance', 0, [400, 380, 410, 420, 395, 405]));
  runtime.lease = fakeLease(5, RUN.run_id, 0);
  const runtimeUrl = await runtime.start();
  let agent1: CultureAgent | null = null;
  let agent2: CultureAgent | null = null;
  let store1: AgentStore | null = null;
  try {
  // 1. first agent life: submits crash (network death AFTER the intent persist)
  agent1 = await startAgent(runtimeUrl, crashingSubmitFetch(globalThis.fetch) as typeof fetch);
  const accept = await fetch(`http://127.0.0.1:${(agent1.server.address() as {port: number}).port}/runs`,
    {method: 'POST', headers: {'x-service-token': SERVICE_TOKEN, 'content-type': 'application/json'},
      body: JSON.stringify({...RUN, lease: runtime.lease})});
  assert.equal(accept.status, 202);

  // wait until the intent row exists with no action_id
  store1 = new AgentStore(dataDir);
  const deadline = Date.now() + 15_000;
  let intent = null as null | {key: string; action_id: string | null};
  while (Date.now() < deadline) {
    const pending = store1.pendingIntents(RUN.run_id);
    if (pending.length > 0) { intent = pending[0]; break; }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(intent, 'the intent must be persisted before/independently of the HTTP outcome');
  assert.equal(intent.action_id, null);
  assert.match(intent.key, /^run-001-1-d1$/);
  const submitAttempts = runtime.requests.filter(r => r.method === 'POST' && r.path.endsWith('/actions')).length;
  assert.equal(submitAttempts, 0, 'the crashing fetch never reached the runtime');
  await agent1.close();
  // close() waited for the loop: nothing may be written afterwards
  const eventsAtClose = store1.eventsAfter(RUN.run_id, 0, 10_000).length;
  const intentsAtClose = store1.listIntents(RUN.run_id).length;
  await new Promise(r => setTimeout(r, 800));
  assert.equal(store1.eventsAfter(RUN.run_id, 0, 10_000).length, eventsAtClose, 'no late events after close()');
  assert.equal(store1.listIntents(RUN.run_id).length, intentsAtClose, 'no late intents after close()');
  assert.equal(store1.getRun(RUN.run_id)!.status, 'active', 'shutdown is not a crash: the run is not ended');
  agent1.store.close();
  agent1 = null;
  store1.close();
  store1 = null;

  // 2. the runtime actually HAS the action (the request was lost after acceptance)
  runtime.actionsByKey.set(intent.key, fakeAction('act-001-01', 'imaging.scan', 'succeeded',
    {plate_id: 'plate-01', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], mode: 'mono'},
    {result: {observation_id: 'obs-001-001'}, ended: 12}));

  // 3. second agent life on the SAME data dir: reconcile by key, no resubmit
  agent2 = await startAgent(runtimeUrl);
  await agent2.reconcileOnStartup();
  const store2 = agent2.store;
  const row = store2.getRun(RUN.run_id)!;
  assert.equal(row.status, 'paused');
  assert.equal(row.pause_reason, 'agent_restarted');
  const resolved = store2.listIntents(RUN.run_id).find(i => i.key === intent!.key)!;
  assert.equal(resolved.action_id, 'act-001-01', 'reconciliation found the action by idempotency key');
  const byKeyLookups = runtime.requests.filter(r => r.method === 'GET'
    && r.path.includes(`/actions/by-key/${encodeURIComponent(intent.key)}`)).length;
  assert.ok(byKeyLookups >= 1, 'the restarted agent queried the key');
  const submits = runtime.requests.filter(r => r.method === 'POST' && r.path.endsWith('/actions')).length;
  assert.equal(submits, 0, 'nothing was resubmitted automatically');
  const events = store2.eventsAfter(RUN.run_id, 0, 1000);
  assert.ok(events.some(e => e.type === 'paused' && (e.payload as {reason?: string}).reason === 'agent_restarted'));
  assert.ok(events.some(e => e.type === 'action.submitted'
    && (e.payload as {recovered?: string}).recovered === 'by_key_on_restart'));
  const agentStatusPosts = runtime.requests.filter(r => r.method === 'POST' && r.path.endsWith('/agent-status'));
  assert.ok(agentStatusPosts.length >= 1, 'the restart pause was reported to the Runtime');
  } finally {
    await agent1?.close().catch(() => undefined);
    await agent2?.close().catch(() => undefined);
    try { agent1?.store.close(); } catch { /* already closed */ }
    try { agent2?.store.close(); } catch { /* already closed */ }
    try { store1?.close(); } catch { /* already closed */ }
    await runtime.close();
  }
});
