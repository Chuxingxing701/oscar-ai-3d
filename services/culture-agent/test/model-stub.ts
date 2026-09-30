// EXPLICIT TEST FIXTURE — an HTTP model stub on the real OpenAI wire
// (POST /v1/chat/completions, SSE chunks, tool_calls protocol). It goes
// through the SAME provider path as a real model (PiAgentBackend → pi-ai →
// streamSimple → HTTP), so end-to-end tests exercise the real tool loop.
// It is deterministic and goal-directed: every decision is derived from the
// SAME context a real model receives (GoalSpec JSON, wake kind, device state
// JSON, observation digests) — never from side channels into the scheduler.
//
// This is NOT a scripted fallback: without OSCAR_MODEL_* pointing here, the
// agent reports model_unavailable and never uses this file.
import {createServer, type Server} from 'node:http';

export interface StubRequestLog {
  url: string;
  model: string;
  nMessages: number;
  roles: string[];
  tools: string[];
  lastUserExcerpt: string;
}

export interface ModelStubHandle {
  port: number;
  close(): Promise<void>;
  requests(): StubRequestLog[];
  /** Stats for assertions: decisions by kind. */
  stats(): {turns: number; scans: number; liquidOps: number; waits: number; completes: number; texts: number};
}

interface WireMessage {
  role: string;
  content?: string | Array<{type?: string; text?: string}>;
  tool_calls?: Array<{id: string; type: string; function: {name: string; arguments: string}}>;
}

const textOf = (m: WireMessage): string => {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(c => c.text ?? '').join('');
  return '';
};

function parseJsonLine<T>(haystack: string, prefix: string): T | null {
  const idx = haystack.indexOf(prefix);
  if (idx < 0) return null;
  const rest = haystack.slice(idx + prefix.length);
  // single-line JSON in our prompts
  const line = rest.split('\n')[0];
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

interface GoalSpecShape {
  description: string;
  scope: {plates: string[]; rows?: string[]};
  metrics: Array<{metric: string; op: string; value: number; source: string; row_id?: string}>;
  allowed_operations: string[];
  monitoring?: {interval_sim_s?: number; conditions?: unknown[]};
  deadline_sim_s?: number | null;
}

interface StateShape {
  experiment: {sim_time_s: number};
  plates: Array<{plate_id: string; wells: Array<{well_id: string; volume_ul: number}>}>;
  reservoirs: Array<{id: string; remaining_ul: number}>;
}

interface EstimateShape {
  observation_id?: string;
  sampled_at_sim_s?: number;
  estimates?: Array<{well_id: string; liquid_level_ul: number | null}>;
}

/** Parse the structured context the backend puts in every request. */
function parseContext(messages: WireMessage[]): {goal: GoalSpecShape | null; taskId: string | null;
  wake: {kind: string} | null; state: StateShape | null; observation: EstimateShape | null;
  lastActionCapability: string | null; lastToolName: string | null; lastUser: string;
  planExists: boolean; maintenanceSeen: boolean} {
  const system = messages.find(m => m.role === 'system');
  const systemText = system ? textOf(system) : '';
  const goal = parseJsonLine<GoalSpecShape>(systemText, 'GoalSpec: ');
  const taskId = /ACTIVE TASK (task-[a-z0-9]+)/.exec(systemText)?.[1] ?? null;
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const lastUser = lastUserMsg ? textOf(lastUserMsg) : '';
  const wake = parseJsonLine<{kind: string}>(lastUser, 'WAKE: ');
  const stateIdx = lastUser.indexOf('CURRENT DEVICE STATE');
  let state: StateShape | null = null;
  if (stateIdx >= 0) {
    const line = lastUser.slice(stateIdx).split('\n').find(l => l.startsWith('{'));
    if (line) { try { state = JSON.parse(line) as StateShape; } catch { /* ignore */ } }
  }
  // newest observation digest anywhere in the brief (device results section)
  const obsMatch = /- observation\.recorded: ([^\n]*)/.exec(lastUser);
  let observation: EstimateShape | null = null;
  if (obsMatch) {
    const json = /\{.*\}/.exec(obsMatch[1]);
    if (json) { try { observation = JSON.parse(json[0]) as EstimateShape; } catch { /* ignore */ } }
  }
  const capMatch = /- action\.(?:succeeded|failed|cancelled): action (\S+) \((\w[\w.]*)\)/.exec(lastUser);
  const lastActionCapability = capMatch?.[2] ?? null;
  // last tool call in the conversation (assistant message with tool_calls)
  const lastToolAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.tool_calls?.length);
  const lastToolName = lastToolAssistant?.tool_calls?.[0]?.function.name ?? null;
  const planExists = /(?:^|\n)Plan: \[/.test(systemText);
  const conversationText = messages.map(textOf).join('\n');
  const maintenanceSeen = /media_(?:add|exchange):/.test(conversationText);
  return {goal, taskId, wake, state, observation, lastActionCapability, lastToolName, lastUser,
    planExists, maintenanceSeen};
}

interface Decision {
  text?: string;
  toolCalls?: Array<{name: string; args: Record<string, unknown>}>;
}

function rowWells(row: string, columns = 6): string[] {
  return Array.from({length: columns}, (_, i) => `${row}${i + 1}`);
}

/**
 * Deterministic goal-directed policy over the parsed context.
 * scan → assess → (maintain → verify) → wait; complete on deadline.
 */
export interface StubStats {
  turns: number; scans: number; liquidOps: number; waits: number; completes: number; texts: number;
}

export function stubDecide(messages: WireMessage[], stats: StubStats): Decision {
  stats.turns += 1;
  const ctx = parseContext(messages);
  const {goal, taskId, wake, state, observation} = ctx;
  if (!taskId || !goal) {
    stats.texts += 1;
    return {text: 'No active task in this session. Create a task (POST /sessions/:id/tasks) and I will drive it.'};
  }
  const row = goal.scope.rows?.[0] ?? 'A';
  const plate = goal.scope.plates[0] ?? 'plate-01';
  const wells = rowWells(row);
  const metric = goal.metrics.find(m => m.metric === 'medium_volume_ul' || m.metric === 'liquid_level_ul');
  const interval = goal.monitoring?.interval_sim_s ?? 14_400;
  const simNow = state?.experiment.sim_time_s ?? 0;

  // A write was accepted but its terminal has NOT arrived → end the turn; the
  // auto-armed action_terminal wake schedules the follow-up.
  const writeNames = ['media_add', 'media_exchange', 'imaging_scan', 'plate_shake',
    'environment_set_targets', 'environment_await_stable'];
  const lastIsWrite = writeNames.includes(ctx.lastToolName ?? '');
  const terminalArrived = ctx.lastActionCapability != null && ctx.lastActionCapability === ctx.lastToolName;
  if (lastIsWrite && !terminalArrived) {
    stats.texts += 1;
    return {text: `Action accepted; waiting for its device terminal state before continuing.`};
  }
  // Assessment needs an observation NEWER than any liquid maintenance: after
  // a liquid terminal, always verify with a fresh scan first.
  const liquidDone = ['media_add', 'media_exchange'].includes(ctx.lastToolName ?? '') && terminalArrived;
  // Assessment phase: an observation digest is available (a very recent one
  // from a duplicate/queued wake is still valid evidence: assess, don't rescan)
  if (observation?.estimates?.length && !liquidDone) {
    const levels = observation.estimates.map(e => e.liquid_level_ul).filter((v): v is number => v != null);
    const min = levels.length ? Math.min(...levels) : null;
    if (min != null && metric && metric.op === '>=' && min < metric.value) {
      const target = metric.value + Math.max(20, metric.value * 0.03);
      const volume = Math.round((target - min) * 10) / 10;
      stats.liquidOps += 1;
      return {toolCalls: [{name: 'media_add', args: {plate_id: plate, row_id: row,
        reservoir_id: state?.reservoirs[0]?.id ?? 'media-01', volume_ul_per_well: volume}}]};
    }
    if (goal.deadline_sim_s != null && simNow >= goal.deadline_sim_s) {
      stats.completes += 1;
      return {toolCalls: [{name: 'complete_task', args: {
        summary: `Monitoring window finished at sim ${simNow}s; minimum level ${min ?? '?'} µL stays ≥ ${metric?.value ?? '?'} µL target.`,
        evidence_refs: observation.observation_id ? [observation.observation_id] : []}}]};
    }
    stats.waits += 1;
    // never sleep past the deadline: the final check must land on it
    const nextAt = goal.deadline_sim_s != null
      ? Math.min(simNow + interval, Math.max(simNow + 60, goal.deadline_sim_s)) : simNow + interval;
    // record plan progress first (own turn), then register the wait
    if (ctx.lastToolName !== 'record_step_result') {
      return {toolCalls: [{name: 'record_step_result', args: {index: ctx.maintenanceSeen ? 1 : 0,
        status: 'done', evidence_refs: observation.observation_id ? [observation.observation_id] : []}}]};
    }
    return {toolCalls: [{name: 'register_wake', args: {at_sim_s: nextAt,
      reason: `levels ok (min ${min ?? '?'} µL); next check at ${nextAt}s`}}],
      text: `No operation needed: minimum ${min ?? '?'} µL ≥ target ${metric?.value ?? '?'} µL.`};
  }
  if (ctx.lastToolName === 'update_plan') {
    stats.scans += 1;
    return {toolCalls: [{name: 'imaging_scan', args: {plate_id: plate, wells, mode: 'mono'}}]};
  }
  // first turn of a task: publish the plan, then the loop re-enters and scans
  if (!ctx.planExists) {
    return {toolCalls: [{name: 'update_plan', args: {steps: [
      {skill: 'scan_and_assess', skill_version: '1.0.0', inputs: {plate_id: plate, row_id: row, wells}},
      {skill: 'maintain_if_needed', skill_version: '1.0.0', inputs: {metric: metric?.metric ?? 'medium_volume_ul', threshold: metric?.value}},
      {skill: 'monitor_until', skill_version: '1.0.0', inputs: {interval_sim_s: interval, deadline_sim_s: goal.deadline_sim_s ?? null}},
    ]}}]};
  }
  // no observation yet → scan (initial assessment or post-maintenance verify)
  stats.scans += 1;
  return {toolCalls: [{name: 'imaging_scan', args: {plate_id: plate, wells, mode: 'mono'}}]};
}

export async function startModelStub(opts: {host?: string; decide?: (messages: WireMessage[], stats: StubStats) => Decision} = {}): Promise<ModelStubHandle> {
  const stats = {turns: 0, scans: 0, liquidOps: 0, waits: 0, completes: 0, texts: 0};
  const requests: StubRequestLog[] = [];
  const decide = opts.decide ?? stubDecide;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {body += c.toString('utf8');});
    req.on('end', () => {
      try {
      let parsed: {model?: string; messages?: WireMessage[]; tools?: Array<{function?: {name?: string}}>} = {};
      try {parsed = JSON.parse(body);} catch { /* ignore */ }
      const messages = parsed.messages ?? [];
      if (process.env.OSCAR_STUB_DUMP) {
        (globalThis as {__stubDumps?: unknown[]}).__stubDumps ??= [];
        (globalThis as unknown as {__stubDumps: unknown[]}).__stubDumps.push(parsed);
      }
      requests.push({url: req.url ?? '/', model: parsed.model ?? '?', nMessages: messages.length,
        roles: messages.map(m => m.role), tools: (parsed.tools ?? []).map(t => t.function?.name ?? '?'),
        lastUserExcerpt: ([...messages].reverse().find(m => m.role === 'user')?.content ?? '')
          .toString().slice(0, 200)});
      const decision = decide(messages, stats);
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
      const chunk = (o: unknown): void => {res.write(`data: ${JSON.stringify(o)}\n\n`);};
      const base = {id: `stub-${stats.turns}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model ?? 'oscar-stub'};
      if (decision.toolCalls?.length) {
        if (decision.text) {
          chunk({...base, choices: [{index: 0, delta: {role: 'assistant', content: decision.text}}]});
        }
        decision.toolCalls.forEach((call, i) => {
          chunk({...base, choices: [{index: 0, delta: {role: 'assistant',
            tool_calls: [{index: i, id: `call_${stats.turns}_${i}`, type: 'function',
              function: {name: call.name, arguments: JSON.stringify(call.args)}}]}}]});
        });
        chunk({...base, choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]});
        chunk({...base, choices: [], usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}});
      } else {
        if (decision.text) chunk({...base, choices: [{index: 0, delta: {role: 'assistant', content: decision.text}}]});
        chunk({...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
        chunk({...base, choices: [], usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}});
      }
      res.write('data: [DONE]\n\n');
      res.end();
      } catch (e) {
        console.error('[model-stub] handler error:', e instanceof Error ? e.stack : e);
        try {res.writeHead(500, {'content-type': 'application/json'}); res.end(JSON.stringify({error: String(e)}));} catch { /* ignore */ }
      }
    });
  });
  await new Promise<void>(resolvePromise => server.listen(0, opts.host ?? '127.0.0.1', resolvePromise));
  const port = (server.address() as {port: number}).port;
  return {
    port,
    async close() {await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));},
    requests: () => [...requests],
    stats: () => ({...stats}),
  };
}
