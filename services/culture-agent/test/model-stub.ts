// EXPLICIT TEST FIXTURE — an HTTP model stub on the real OpenAI wire
// (POST /v1/chat/completions, SSE chunks, tool_calls protocol). It goes
// through the SAME provider path as a real model (PiAgentBackend → pi-ai →
// streamSimple → HTTP), so end-to-end tests exercise the real tool loop.
// It is deterministic and goal-directed: every decision is derived from the
// SAME context a real model receives (GoalSpec JSON, wake kind, device state
// JSON, plan JSON with per-step verification, observation digests) — never
// from side channels into the scheduler.
//
// R08: the stub drives the VERSIONED SKILL REGISTRY like a real model must:
// update_plan publishes scan_and_assess@1 → exchange_row_and_verify@1 →
// monitor_until@1, device writes go through the executor tools, and a step is
// only recorded done with the action ids + observation ids it produced, so
// the server-side postcondition verification actually runs and can refuse.
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
  /** EXACT producing action, carried by the observation.recorded digest. */
  action_id?: string;
  sampled_at_sim_s?: number;
  estimates?: Array<{well_id: string; liquid_level_ul: number | null}>;
}

interface PlanStepShape {
  index: number;
  skill: string;                       // "scan_and_assess@1"
  status: string;                      // pending|running|done|failed|skipped
  verification?: {pass: boolean | null; code?: string | null; next_skill?: string | null} | null;
  action_ids?: string[];
  evidence_refs?: string[];
  inputs?: Record<string, unknown>;
}

export interface BriefDigest {
  /** index of the user message this brief came from */
  messageIndex: number;
  text: string;
  simTime: number | null;
  maintenance: Array<{action_id: string; capability: string}>;   // succeeded media.* results
  scans: Array<{action_id: string; capability: string}>;         // succeeded imaging.scan results
  terminals: Array<{action_id: string; capability: string; status: string}>;
  observation: (EstimateShape & {messageIndex: number}) | null;
}

/** Parse the structured context the backend puts in every request. */
export function parseContext(messages: WireMessage[]): {goal: GoalSpecShape | null; taskId: string | null;
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
  const capMatch = /- action\.result: action (\S+) \(([\w.]+)\) (\w+)/.exec(lastUser);
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

/** Chronological digests of every turn brief (user message) in the history. */
export function parseBriefs(messages: WireMessage[]): BriefDigest[] {
  const briefs: BriefDigest[] = [];
  messages.forEach((m, messageIndex) => {
    if (m.role !== 'user') return;
    const text = textOf(m);
    if (!text.includes('WAKE:')) return;                    // only turn briefs
    const simTime = /sim_time_s=([0-9.]+)/.exec(text)?.[1];
    const terminals: BriefDigest['terminals'] = [];
    for (const match of text.matchAll(/- action\.result: action (\S+) \(([\w.]+)\) (\w+)/g)) {
      terminals.push({action_id: match[1], capability: match[2], status: match[3]});
    }
    let observation: BriefDigest['observation'] = null;
    const obsMatch = /- observation\.recorded: ([^\n]*)/.exec(text);
    if (obsMatch) {
      const json = /\{.*\}/.exec(obsMatch[1]);
      if (json) {
        try {
          observation = {messageIndex, ...(JSON.parse(json[0]) as EstimateShape)};
        } catch { /* ignore */ }
      }
    }
    briefs.push({
      messageIndex,
      text,
      simTime: simTime != null ? Number(simTime) : null,
      maintenance: terminals.filter(t => (t.capability === 'media.add' || t.capability === 'media.exchange')
        && t.status === 'succeeded'),
      scans: terminals.filter(t => t.capability === 'imaging.scan' && t.status === 'succeeded'),
      terminals,
      observation,
    });
  });
  return briefs;
}

export function parsePlan(messages: WireMessage[]): PlanStepShape[] {
  const system = messages.find(m => m.role === 'system');
  const text = system ? textOf(system) : '';
  const line = text.split('\n').find(l => l.startsWith('Plan: ['));
  if (!line) return [];
  try {
    return JSON.parse(line.slice('Plan: '.length)) as PlanStepShape[];
  } catch {
    return [];
  }
}

/** Newest accepted write from the tool results in the conversation, if any. */
export function lastAcceptedWrite(messages: WireMessage[]): {action_id: string} | null {
  const toolResults = [...messages].reverse().filter(m => m.role === 'tool');
  for (const m of toolResults) {
    try {
      const parsed = JSON.parse(textOf(m)) as {accepted?: boolean; action_id?: string};
      if (parsed.accepted === true && typeof parsed.action_id === 'string') {
        return {action_id: parsed.action_id};
      }
    } catch { /* not JSON */ }
  }
  return null;
}

/** Raw text of the newest tool result in the conversation, if any. */
export function lastToolResult(messages: WireMessage[]): string | null {
  for (const m of [...messages].reverse()) {
    if (m.role === 'tool') return textOf(m);
  }
  return null;
}

interface Decision {
  text?: string;
  toolCalls?: Array<{name: string; args: Record<string, unknown>}>;
}

export function rowWells(row: string, columns = 6): string[] {
  return Array.from({length: columns}, (_, i) => `${row}${i + 1}`);
}

/** e2e perturbations (deliberate model mistakes the verification must catch). */
export interface StubPerturbations {
  /** The first `times` maintenance writes dose only `factor` of the needed volume. */
  maintenanceVolumeFactor?: {factor: number; times: number};
  /** The first `times` step-1 done records cite wrong evidence on purpose:
   * 'stale-observation' re-cites an observation older than the maintenance
   * (its producing scan STAYS cited, so only freshness is broken →
   * observation_stale); 'uncited-producer-observation' cites a valid current
   * observation but drops its producing scan from action_ids (→
   * observation_not_from_step_action); 'foreign-observation' cites
   * `foreignRef` (e.g. another plate's scan). */
  evidenceRefsOverride?: {kind: 'stale-observation' | 'uncited-producer-observation' | 'foreign-observation';
    times: number; foreignRef?: string};
}

interface StubCounters {
  factorUses: number;
  overrideUses: number;
}

/**
 * Per-stub-instance memory of the actions and observations this stub has
 * seen (from turn briefs and its own tool results). The wire request only
 * carries the CURRENT turn brief plus stored chat history — a real model
 * with full conversation memory would know its own past actions; this
 * memory is exactly that, derived only from device facts the agent sent.
 */
export interface StubMemory {
  /** memory is scoped to the active task: a promoted/queued switch resets it */
  taskId: string | null;
  counter: number;
  actions: Map<string, {capability: string; status: string; seen: number}>;
  obs: {id: string; seen: number; estimates: Array<{well_id: string; liquid_level_ul: number | null}>} | null;
  /** observation history (newest last) so perturbations can cite stale
   * evidence; `producerActionId` is the EXACT action that produced the
   * observation, taken from the observation.recorded digest's action_id —
   * an explicit observation→action id association, never inferred from
   * scan/event ordering (a brief can carry several succeeded scans). */
  obsList: Array<{id: string; seen: number; producerActionId: string | null}>;
}

function freshMemory(): StubMemory {
  return {taskId: null, counter: 0, actions: new Map(), obs: null, obsList: []};
}

/** Deterministic goal-directed policy over the parsed context (R08 skills). */
export interface StubStats {
  turns: number; scans: number; liquidOps: number; waits: number; completes: number; texts: number;
}

export function stubDecide(messages: WireMessage[], stats: StubStats,
  env?: {perturb?: StubPerturbations; counters?: StubCounters; memory?: StubMemory}): Decision {
  stats.turns += 1;
  const ctx = parseContext(messages);
  const {goal, taskId, state} = ctx;
  if (!taskId || !goal) {
    stats.texts += 1;
    return {text: 'No active task in this session. Create a task (POST /sessions/:id/tasks) and I will drive it.'};
  }
  const metric = goal.metrics.find(m => m.metric === 'medium_volume_ul' || m.metric === 'liquid_level_ul');
  if (!metric || !goal.allowed_operations.includes('imaging.scan')) {
    stats.texts += 1;
    return {text: 'This stub only drives medium-maintenance goals with imaging.scan; acknowledging instead.'};
  }
  const row = goal.scope.rows?.[0] ?? 'A';
  const plate = goal.scope.plates[0] ?? 'plate-01';
  const wells = rowWells(row);
  const interval = goal.monitoring?.interval_sim_s ?? 14_400;
  const memory = env?.memory ?? freshMemory();
  // NEVER cite another task's actions: a task switch (queue promotion,
  // restart on a different active task) resets the instance memory so every
  // cited id belongs to the task that is currently deciding.
  if (memory.taskId !== ctx.taskId) {
    memory.taskId = ctx.taskId;
    memory.actions.clear();
    memory.obs = null;
    memory.obsList = [];
  }
  const counters = env?.counters;
  const canAdd = goal.allowed_operations.includes('media.add');
  const target = metric.value;
  const simNow = state?.experiment.sim_time_s ?? 0;

  // -- update instance memory from the CURRENT brief and tool results -----
  memory.counter += 1;
  const briefs = parseBriefs(messages);
  const brief = briefs.at(-1) ?? null;
  if (brief) {
    for (const t of brief.terminals) {
      memory.actions.set(t.action_id, {capability: t.capability, status: t.status, seen: memory.counter});
    }
    for (const m of brief.text.matchAll(/- action\.submitted: ([\w.]+) accepted as (\S+) \((\w+)\)/g)) {
      if (!memory.actions.has(m[2])) {
        memory.actions.set(m[2], {capability: m[1], status: 'submitted', seen: memory.counter});
      }
    }
    if (brief.observation?.observation_id && brief.observation.estimates?.length) {
      memory.obs = {id: brief.observation.observation_id, seen: memory.counter,
        estimates: brief.observation.estimates};
      // EXACT attribution: the observation.recorded digest names the action
      // that produced it. No order inference over the brief's scans — one
      // brief can carry several succeeded scans and the last one need not be
      // the producer (this is the N03 observation_not_from_step_action link).
      const producer = typeof brief.observation.action_id === 'string' && brief.observation.action_id
        ? brief.observation.action_id : null;
      memory.obsList.push({id: brief.observation.observation_id, seen: memory.counter,
        producerActionId: producer});
      if (memory.obsList.length > 12) memory.obsList.shift();
    }
  }
  const acceptedWrite = lastAcceptedWrite(messages);
  if (acceptedWrite && !memory.actions.has(acceptedWrite.action_id)) {
    memory.actions.set(acceptedWrite.action_id,
      {capability: ctx.lastToolName?.replace(/_/g, '.') ?? 'unknown', status: 'accepted', seen: memory.counter});
  }
  const maintenanceSeen = [...memory.actions.entries()]
    .filter(([, a]) => a.capability === 'media.add' || a.capability === 'media.exchange');
  const maintenanceDone = maintenanceSeen.filter(([, a]) => a.status === 'succeeded');
  const scansDone = [...memory.actions.entries()]
    .filter(([, a]) => a.capability === 'imaging.scan' && a.status === 'succeeded');

  // A) a liquid write is in flight (accepted, terminal not seen) → end the
  // turn with text; its auto-armed action_terminal wake schedules the follow-up
  if (maintenanceSeen.some(([, a]) => a.status === 'submitted' || a.status === 'accepted')) {
    stats.texts += 1;
    return {text: 'Maintenance accepted; waiting for its device terminal state before continuing.'};
  }

  // A tool call was REFUSED (stale decision revision, verification refusal,
  // gate refusal...): never hammer the same request inside this turn — end it
  // with a SHORT persisted wake so the next decision re-reads fresh state.
  // (Plain text could leave the task with no armed wake and no in-flight
  // action; the wake guarantees continuation.)
  const lastResult = lastToolResult(messages);
  if (lastResult != null && lastResult.startsWith('REFUSED')) {
    // A cited action the Runtime no longer knows (e.g. its durable state was
    // restored from before that action by a runtime SIGKILL+restart) can
    // never be evidence again: evict it from memory so the retry cites only
    // actions that exist. Without this, every later record re-cites the dead
    // id and the refusal loops forever. (The server's unknown_action refusal
    // is the authority here — the stub just stops citing what it rejects.)
    const unknown = /REFUSED unknown_action: action (\S+) does not exist/.exec(lastResult);
    if (unknown) memory.actions.delete(unknown[1]);
    stats.waits += 1;
    return {toolCalls: [{name: 'register_wake', args: {at_sim_s: simNow + 30,
      reason: `refusal received (${lastResult.slice(0, 80)}); re-read state on the next turn`}}],
      text: `Refused: ${lastResult.slice(0, 160)}. Ending the turn; the next decision re-reads the state.`};
  }

  // First turn of a task: publish the versioned-skill plan (validated by the
  // server; unknown skills/versions/inputs would be refused). The plan JSON in
  // the system prompt lags one request behind, so do not re-publish within the
  // same turn — the persisted plan carries the turn forward.
  const plan = parsePlan(messages);
  if (plan.length === 0 && ctx.lastToolName !== 'update_plan') {
    return {toolCalls: [{name: 'update_plan', args: {steps: [
      {skill: 'scan_and_assess', skill_version: '1', inputs: {plate_id: plate, row_id: row, wells, mode: 'mono'}},
      {skill: 'exchange_row_and_verify', skill_version: '1',
        inputs: {plate_id: plate, row_id: row, reservoir_id: reservoirIdOf(state), wells}},
      {skill: 'monitor_until', skill_version: '1',
        inputs: {until_sim_s: goal.deadline_sim_s ?? simNow + interval, interval_sim_s: interval}},
    ]}}]};
  }
  if (plan.length === 0) {
    // update_plan just ran inside this turn (or was refused): proceed with the
    // first scan; the next turn's prompt carries the persisted plan
    stats.scans += 1;
    return {toolCalls: [{name: 'imaging_scan', args: {plate_id: plate, wells, mode: 'mono'}}]};
  }
  const step0 = plan.find(s => s.index === 0 && s.skill.startsWith('scan_and_assess'));
  const step1 = plan.find(s => s.index === 1 && s.skill.startsWith('exchange_row_and_verify'));
  const step2 = plan.find(s => s.index === 2 && s.skill.startsWith('monitor_until'));
  const until = Number(step2?.inputs?.until_sim_s ?? goal.deadline_sim_s ?? NaN);

  // B) a maintenance action reached its terminal in THIS brief → link it to
  // step 1 (running) and submit the verify rescan
  const justMaintained = maintenanceDone.some(([, a]) => a.seen === memory.counter);
  if (justMaintained && step1) {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    if (step1.status !== 'running') {
      calls.push({name: 'record_step_result', args: {index: 1, status: 'running',
        action_ids: maintenanceDone.map(([id]) => id)}});
    }
    stats.scans += 1;
    calls.push({name: 'imaging_scan', args: {plate_id: plate, wells, mode: 'mono'}});
    return {toolCalls: calls};
  }

  // C) THIS brief carries a fresh observation (postdating every completed
  // maintenance). Wake-only briefs fall through to D/E and rescan: a remembered
  // observation is never fresh evidence for a later decision.
  const obs = memory.obs && brief?.observation?.observation_id === memory.obs.id ? memory.obs : null;
  const lastMaintenanceSeen = maintenanceDone.length ? Math.max(...maintenanceDone.map(([, a]) => a.seen)) : -1;
  const obsFresh = obs != null && memory.counter > lastMaintenanceSeen;
  // EXACT producers of cited observations, by observation_id, from the
  // observation.recorded digests (StubMemory.obsList). A brief may deliver
  // the observation digest and its producer's terminal in DIFFERENT turns
  // (the digest rides the scan_capture stage, the terminal comes later), so
  // turn-order heuristics over seen scans cannot be relied on for citation.
  const producersOf = (ids: string[]): string[] => memory.obsList
    .filter(o => ids.includes(o.id) && o.producerActionId).map(o => o.producerActionId!);
  // An observation is citable step evidence only once its EXACT producer has
  // SUCCEEDED: citing a still-running producer is refused action_not_terminal
  // and citing the observation without its producer is refused
  // observation_not_from_step_action. When the digest gives no producer
  // (pre-attribution briefs), keep the legacy scanIds-based behavior.
  const obsCitable = (id: string): boolean => {
    const hits = memory.obsList.filter(o => o.id === id && o.producerActionId);
    if (!hits.length) return true;
    return hits.some(o => memory.actions.get(o.producerActionId!)?.status === 'succeeded');
  };
  if (obs && obsFresh) {
    const levels = obs.estimates.map(e => e.liquid_level_ul).filter((v): v is number => v != null);
    const min = levels.length ? Math.min(...levels) : null;
    const scanIds = scansDone.filter(([, a]) => a.seen <= obs.seen).map(([id]) => id);
    // step 0: record done with the scan + observation evidence (skip right
    // after a record call: the plan JSON lags one request behind)
    if (step0 && step0.verification?.pass !== true && ctx.lastToolName !== 'record_step_result'
      && obsCitable(obs.id)) {
      return {toolCalls: [{name: 'record_step_result', args: {index: 0, status: 'done',
        action_ids: [...new Set([...scanIds, ...producersOf([obs.id])])], evidence_refs: [obs.id]}}]};
    }
    // step 1: verify the maintenance with the post-write rescan evidence. A
    // failed (verify_below_target) step is NOT re-verified until a NEW
    // maintenance ran (phase B flips it back to running); a refused attempt
    // (stale/wrong evidence) retries with corrected refs.
    if (step1 && maintenanceDone.length > 0 && step1.verification?.pass !== true
      && step1.status !== 'failed' && ctx.lastToolName !== 'record_step_result'
      && obsCitable(obs.id)) {
      let evidenceRefs = [obs.id];
      // perturbation-driven citation adjustments: the mistake must break
      // EXACTLY one verification dimension (§3 of the N05 review)
      const includeActions: string[] = [];        // extra cited action ids
      const excludeActions = new Set<string>();   // deliberately uncited ids
      const overrideCfg = env?.perturb?.evidenceRefsOverride;
      if (overrideCfg && counters && counters.overrideUses < overrideCfg.times) {
        let refs: string[] | null = null;
        if (overrideCfg.kind === 'stale-observation') {
          // The stale ref must break ONLY freshness: the observation's EXACT
          // producing scan (observation.recorded action_id) STAYS cited →
          // observation_stale. An observation without a known exact producer
          // is not used: skipping keeps the deliberate mistake precise
          // instead of also breaking the attribution (which would surface as
          // observation_not_from_step_action).
          const stale = memory.obsList.find(o => o.seen < lastMaintenanceSeen && o.producerActionId);
          if (stale) {
            refs = [stale.id];
            includeActions.push(stale.producerActionId!);
          }
        } else if (overrideCfg.kind === 'uncited-producer-observation') {
          // cite a valid, current observation but leave the scan that
          // PRODUCED it out of action_ids: the refusal must be
          // observation_not_from_step_action
          const current = memory.obsList.at(-1);
          if (current && current.id === obs.id && current.producerActionId) {
            refs = [current.id];
            excludeActions.add(current.producerActionId);
          }
        } else if (overrideCfg.kind === 'foreign-observation' && overrideCfg.foreignRef) {
          refs = [overrideCfg.foreignRef];
        }
        if (refs) {
          counters.overrideUses += 1;
          evidenceRefs = refs;
        }
      }
      // The exact producer of EVERY cited observation stays in action_ids
      // (uncited-producer-observation deliberately excludes it via
      // excludeActions — that perturbation must keep its meaning).
      const citedProducers = producersOf(evidenceRefs).filter(id => !excludeActions.has(id));
      return {toolCalls: [{name: 'record_step_result', args: {index: 1, status: 'done',
        action_ids: [...new Set([...maintenanceDone.map(([id]) => id), ...includeActions,
          ...scanIds.filter(id => !excludeActions.has(id)), ...citedProducers])],
        evidence_refs: evidenceRefs}}]};
    }
    // maintenance needed: top the row up to target + margin, per well. The
    // liquid write requires a fresh observation in THIS turn (the write tool
    // attaches the newest observation of the turn as evidence), so when the
    // current brief carries none, scan first and dose on the next turn.
    if (min != null && min < target) {
      if (!canAdd) {
        stats.texts += 1;
        return {text: `Minimum ${min.toFixed(1)} µL is below ${target} µL but this stub only tops up with media.add; waiting.`};
      }
      if (!brief?.observation) {
        stats.scans += 1;
        return {toolCalls: [{name: 'imaging_scan', args: {plate_id: plate, wells, mode: 'mono'}}]};
      }
      let volume = Math.round(((target + Math.max(20, target * 0.03)) - min) * 10) / 10;
      const factorCfg = env?.perturb?.maintenanceVolumeFactor;
      if (factorCfg && counters && counters.factorUses < factorCfg.times) {
        counters.factorUses += 1;
        volume = Math.round(volume * factorCfg.factor * 10) / 10;
      }
      stats.liquidOps += 1;
      const calls: Array<{name: string; args: Record<string, unknown>}> = [];
      if (step1 && ['pending', 'failed', 'skipped'].includes(step1.status ?? 'pending')) {
        calls.push({name: 'record_step_result', args: {index: 1, status: 'running'}});
      }
      calls.push({name: 'media_add', args: {plate_id: plate, row_id: row,
        reservoir_id: reservoirIdOf(state), volume_ul_per_well: volume}});
      return {toolCalls: calls};
    }
    // levels are fine at/above target
    if (step1 && step1.status === 'pending' && ctx.lastToolName !== 'record_step_result') {
      return {toolCalls: [{name: 'record_step_result', args: {index: 1, status: 'skipped',
        reason: `levels ok (min ${min ?? '?'} µL ≥ target ${target} µL); no maintenance needed this cycle`}}]};
    }
    if (step2) {
      if (Number.isFinite(until) && simNow >= until) {
        if (step2.verification?.pass !== true && ctx.lastToolName !== 'record_step_result') {
          return {toolCalls: [{name: 'record_step_result', args: {index: 2, status: 'done'}}]};
        }
        stats.completes += 1;
        return {toolCalls: [{name: 'complete_task', args: {
          summary: `Monitoring window finished at sim ${simNow}s; minimum level ${min ?? '?'} µL stays ≥ ${target} µL target.`,
          evidence_refs: [obs.id]}}]};
      }
      stats.waits += 1;
      // never sleep past the deadline: the final check must land on it.
      // step_index binds the wake to the monitor_until step (N03): only that
      // bound wake may later verify the step's wait condition.
      const nextAt = Number.isFinite(until)
        ? Math.min(simNow + interval, Math.max(simNow + 60, until)) : simNow + interval;
      return {toolCalls: [{name: 'register_wake', args: {at_sim_s: nextAt,
        step_index: step2?.index ?? 2,
        reason: `levels ok (min ${min ?? '?'} µL); next check at ${nextAt}s`}}],
        text: `No operation needed: minimum ${min ?? '?'} µL ≥ target ${target} µL.`};
    }
    stats.texts += 1;
    return {text: `Levels at/above target (${min ?? '?'} µL); no further plan steps.`};
  }

  // D/E) no fresh observation in this brief (wake-only turn, or the newest
  // observation predates the last maintenance) → scan: the monitoring check or
  // the post-maintenance verify rescan
  stats.scans += 1;
  return {toolCalls: [{name: 'imaging_scan', args: {plate_id: plate, wells, mode: 'mono'}}]};
}

function reservoirIdOf(state: StateShape | null): string {
  return state?.reservoirs[0]?.id ?? 'media-01';
}

export async function startModelStub(opts: {host?: string; decide?: (messages: WireMessage[],
  stats: StubStats, env?: {perturb?: StubPerturbations; counters?: StubCounters; memory?: StubMemory}) => Decision;
  perturb?: StubPerturbations} = {}): Promise<ModelStubHandle> {
  const stats = {turns: 0, scans: 0, liquidOps: 0, waits: 0, completes: 0, texts: 0};
  const counters: StubCounters = {factorUses: 0, overrideUses: 0};
  const memory = freshMemory();
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
        const decision = decide(messages, stats, {perturb: opts.perturb, counters, memory});
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
