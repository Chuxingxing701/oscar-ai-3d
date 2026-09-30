// AgentBackend (design §8): the session scheduler talks to a model backend,
// never to a provider directly. PiAgentBackend runs ONE bounded decision
// process per turn via pi-agent-core + pi-ai (OpenAI-compatible wire) with
// real tool calls — never free-text action parsing. Model config comes from
// the server side; no credentials enter tool parameters or session logs.
//
// Within a turn the model may chain read→write→read tools (pi loop). Every
// wait is REGISTERED (persisted wake) and the turn ends; device terminal
// states arrive as new events on later turns. A turn is bounded by
// shouldStopAfterTurn + an internal step cap.
import {Agent} from '@earendil-works/pi-agent-core';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import type {Model} from '@earendil-works/pi-ai';
import type {StateSnapshot} from '@oscar/device-contract';
import {buildTools} from '@oscar/device-contract';
import {loadModelConfig, type ModelConfig} from './model-config.ts';
import type {GoalSpec} from './goal.ts';
import type {PlanStepRow, SessionRow, TaskRow, WakeRow} from './session-store.ts';

export interface DeviceResultDigest {
  source: string;               // e.g. action.succeeded | observation.created
  summary: string;
  data?: unknown;
}

export interface TurnInput {
  session: SessionRow;
  task: TaskRow | null;
  spec: GoalSpec | null;
  wake: {kind: string; reason: string; data?: Record<string, unknown>} | null;
  state: StateSnapshot;         // fresh projection, read at turn start
  history: Array<{role: 'user' | 'assistant'; content: string}>;
  checkpointSummary: string | null;
  plan: PlanStepRow[];
  deviceResults: DeviceResultDigest[];   // events digested since the last turn
  budget: {actions_used: number; max_actions: number; model_turns_used: number; max_model_turns: number};
}

/** Effects accumulated by tool handlers during the turn (scheduler applies them). */
export interface TurnEffects {
  wakes: WakeRow[];
  taskCompleted: {summary: string; evidence_refs: string[]} | null;
  taskFailed: {reason: string; summary: string} | null;
  inputRequested: string[] | null;
  goalUpdated: {revision: number} | null;
  planUpdated: boolean;
  stopRequested: boolean;
}

export interface TurnOutput {
  ok: boolean;
  code?: string;                 // provider_error | aborted | ...
  error?: string;
  assistantText: string;
  toolLog: Array<{name: string; args: Record<string, unknown>; ok: boolean; summary: string; error?: string}>;
  effects: TurnEffects;
  usage: {requests: number; inputTokens: number; outputTokens: number};
}

/** What the scheduler host provides to the backend's tools. */
export interface ToolHost {
  generation: number;
  submitWrite(capability: string, args: Record<string, unknown>, opts:
    {reason?: string; evidence_refs?: string[]}): Promise<{ok: boolean; action?: {action_id: string; status: string};
    error?: {code: string; message: string; retryable: boolean}; recovered?: string}>;
  armWake(input: {kind: 'sim_time' | 'condition' | 'action_terminal'; at_sim_s?: number | null;
    predicate?: Record<string, unknown> | null; dedupe_key?: string | null; reason: string}): WakeRow;
  updateTaskGoal(patch: {goal_text?: string; goal_spec?: Record<string, unknown>; expected_revision: number}):
    {ok: true; revision: number} | {ok: false; conflict: {actual: number}};
  replacePlan(steps: Array<{skill: string; skill_version?: string; inputs?: Record<string, unknown> | null}>): PlanStepRow[];
  updateStep(index: number, fields: {status: 'done' | 'failed' | 'skipped' | 'running'; action_ids?: string[];
    evidence_refs?: string[]}): boolean;
}

export interface AgentBackend {
  readonly id: string;
  capabilities(): {tools: boolean; images: boolean; streaming: boolean; compaction: boolean};
  available(): {ok: boolean; reason?: string; missing?: string[]};
  runTurn(input: TurnInput, host: ToolHost, signal: AbortSignal): Promise<TurnOutput>;
  /** Deterministic compaction of a finished stretch of conversation (no provider call). */
  compact(input: {history: Array<{role: 'user' | 'assistant'; content: string}>; task: TaskRow | null;
    facts: string[]; evidenceRefs: string[]}): {summary: string; facts: string[]; open_questions: string[]};
  close(): Promise<void>;
}

// -- pi backend -----------------------------------------------------------------

const MAX_LOOP_STEPS = 12;      // hard bound on provider requests per turn

interface PiTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<{content: Array<{type: 'text'; text: string}>;
    details: Record<string, unknown>; isError?: boolean; terminate?: boolean}>;
}

export class PiAgentBackend implements AgentBackend {
  readonly id = 'pi-0.84.0';
  private readonly config: ModelConfig | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = loadModelConfig(env).config;
  }

  capabilities() {
    return {tools: true, images: false, streaming: true, compaction: true};
  }

  available() {
    if (!this.config) {
      const {missing} = loadModelConfig();
      return {ok: false, reason: 'model_not_configured', missing};
    }
    return {ok: true};
  }

  async runTurn(input: TurnInput, host: ToolHost, signal: AbortSignal): Promise<TurnOutput> {
    if (!this.config) {
      return {ok: false, code: 'model_not_configured',
        error: `no model configured: ${loadModelConfig().missing.join(', ')}`,
        assistantText: '', toolLog: [], effects: emptyEffects(), usage: {requests: 0, inputTokens: 0, outputTokens: 0}};
    }
    const effects = emptyEffects();
    const toolLog: TurnOutput['toolLog'] = [];
    const usage = {requests: 0, inputTokens: 0, outputTokens: 0};
    const turnGoalRevision = input.task?.goal_revision ?? 0;
    const turnTaskId = input.task?.task_id ?? null;

    const okResult = (text: string, extra: Record<string, unknown> = {}): {content: Array<{type: 'text'; text: string}>;
      details: Record<string, unknown>} => ({content: [{type: 'text', text}], details: extra});
    const errResult = (text: string): {content: Array<{type: 'text'; text: string}>; details: Record<string, unknown>;
      isError: boolean} => ({content: [{type: 'text', text}], details: {}, isError: true});

    const logAnd = (name: string, args: Record<string, unknown>, outcome: {ok: boolean; summary: string; error?: string}) => {
      toolLog.push({name, args, ok: outcome.ok, summary: outcome.summary, error: outcome.error});
    };

    // -- device write tools (serialized, checked, intent-persisted) -----------
    const manifestTools = buildTools(undefined, input.spec?.allowed_operations);
    const writeTools: PiTool[] = manifestTools
      .filter(t => t.capability && t.access === 'write' && input.spec?.allowed_operations.includes(t.capability))
      .map(t => ({
        name: t.name, label: t.name, description: t.description, parameters: t.input_schema,
        execute: async (_id, params) => {
          if (!input.task || !input.spec) return errResult('No active task: cannot operate the device.');
          const r = await host.submitWrite(t.capability!, params as Record<string, unknown>,
            {reason: `model tool ${t.name}`});
          if (!r.ok) {
            logAnd(t.name, params, {ok: false, summary: `${r.error?.code}: ${r.error?.message}`, error: r.error?.code});
            return errResult(`REFUSED ${r.error?.code}: ${r.error?.message}${r.error?.retryable
              ? ' (retryable)' : ' — re-read the state and adjust the plan; do not repeat the same request.'}`);
          }
          const action = r.action!;
          logAnd(t.name, params, {ok: true, summary: `accepted ${action.action_id} (${action.status})`});
          // terminate hint: end this decision process right after the write;
          // the persisted wake (auto for async actions) schedules the next one
          return {...okResult(JSON.stringify({accepted: true, action_id: action.action_id, status: action.status,
            note: 'The action runs on the device. Its terminal state will arrive as a device event on a later turn; register a wake instead of waiting here.'}), {action_id: action.action_id}), terminate: true};
        },
      }));

    const readTools: PiTool[] = [
      {
        name: 'device_read_state', label: 'device_read_state',
        description: 'Fresh observable device state for this experiment: experiment info/sim_time/event_seq, chamber readings, plate wells and revisions, reservoirs, tips, busy resources and active actions. Re-read before deciding after any wait.',
        parameters: {type: 'object', additionalProperties: false, properties: {}},
        execute: async () => {
          const digest = stateDigest(input.session.experiment_id, input.state, input.spec);
          logAnd('device_read_state', {}, {ok: true, summary: 'state snapshot'});
          return okResult(JSON.stringify(digest));
        },
      },
    ];

    const agentTools: PiTool[] = [
      {
        name: 'register_wake', label: 'register_wake',
        description: 'End this turn and persist when to wake the task next. Either at_sim_s (absolute simulated seconds) or a threshold condition {metric: temperature_c|co2_pct|humidity_pct, op: below|above, value, debounce_sim_s, hysteresis, cooldown_sim_s}. Action terminals for submitted actions wake the task automatically.',
        parameters: {type: 'object', additionalProperties: false, required: ['reason'],
          properties: {reason: {type: 'string', maxLength: 300}, at_sim_s: {type: 'number', minimum: 0},
            condition: {type: 'object', additionalProperties: false, required: ['metric', 'op', 'value'],
              properties: {metric: {enum: ['temperature_c', 'co2_pct', 'humidity_pct']}, op: {enum: ['below', 'above']},
                value: {type: 'number'}, debounce_sim_s: {type: 'number', minimum: 0},
                hysteresis: {type: 'number', minimum: 0}, cooldown_sim_s: {type: 'number', minimum: 0}}}}},
        execute: async (_id, params) => {
          if (!turnTaskId) return errResult('No active task to register a wake for.');
          const cond = params.condition as {metric: string; op: string; value: number; debounce_sim_s?: number;
            hysteresis?: number; cooldown_sim_s?: number} | undefined;
          if (!cond && typeof params.at_sim_s !== 'number') {
            return errResult('Provide at_sim_s or condition.');
          }
          const wake = host.armWake({kind: cond ? 'condition' : 'sim_time',
            at_sim_s: typeof params.at_sim_s === 'number' ? params.at_sim_s : null,
            predicate: cond ? {...cond, debounce_sim_s: cond.debounce_sim_s ?? 60,
              hysteresis: cond.hysteresis ?? Math.abs(cond.value) * 0.05, cooldown_sim_s: cond.cooldown_sim_s ?? 1800} : null,
            reason: String(params.reason ?? '')});
          effects.wakes.push(wake);
          effects.stopRequested = true;
          logAnd('register_wake', params, {ok: true, summary: `wake ${wake.wake_id} (${wake.kind})`});
          return {...okResult(JSON.stringify({registered: true, wake_id: wake.wake_id, kind: wake.kind,
            target_sim_s: wake.target_sim_s, condition: wake.predicate})), terminate: true};
        },
      },
      {
        name: 'update_plan', label: 'update_plan',
        description: 'Replace the task plan with an ordered list of skill steps (scan_and_assess, exchange_row_and_verify, mix_and_rescan, monitor_until, …). The plan is persisted and shown to the user.',
        parameters: {type: 'object', additionalProperties: false, required: ['steps'],
          properties: {steps: {type: 'array', minItems: 1, maxItems: 24, items: {type: 'object',
            additionalProperties: false, required: ['skill'], properties: {skill: {type: 'string', maxLength: 60},
              skill_version: {type: 'string', maxLength: 20}, inputs: {type: 'object'}}}}}},
        execute: async (_id, params) => {
          if (!turnTaskId) return errResult('No active task.');
          const steps = (params.steps as Array<{skill: string; skill_version?: string;
            inputs?: Record<string, unknown>}>).map(s => ({skill: s.skill, skill_version: s.skill_version,
            inputs: s.inputs ?? null}));
          const rows = host.replacePlan(steps);
          effects.planUpdated = true;
          logAnd('update_plan', params, {ok: true, summary: `${rows.length} steps`});
          return okResult(JSON.stringify({plan: rows.map(r => ({index: r.index_in_plan, skill: r.skill, status: r.status}))}));
        },
      },
      {
        name: 'record_step_result', label: 'record_step_result',
        description: 'Mark a plan step done/failed/skipped and attach the action ids and evidence (observation ids) it produced.',
        parameters: {type: 'object', additionalProperties: false, required: ['index', 'status'],
          properties: {index: {type: 'integer', minimum: 0}, status: {enum: ['done', 'failed', 'skipped']},
            action_ids: {type: 'array', items: {type: 'string'}}, evidence_refs: {type: 'array', items: {type: 'string'}}}},
        execute: async (_id, params) => {
          if (!turnTaskId) return errResult('No active task.');
          const okFlag = host.updateStep(Number(params.index), {status: params.status as 'done' | 'failed' | 'skipped',
            action_ids: params.action_ids as string[] | undefined, evidence_refs: params.evidence_refs as string[] | undefined});
          if (!okFlag) return errResult(`No plan step at index ${params.index}.`);
          logAnd('record_step_result', params, {ok: true, summary: `step ${params.index} ${String(params.status)}`});
          return okResult(JSON.stringify({updated: true}));
        },
      },
      {
        name: 'update_goal', label: 'update_goal',
        description: 'Update the structured goal after a user instruction (narrow scope, adjust thresholds, change operations). Pass the expected_revision you decided under; a conflict means someone else edited it first.',
        parameters: {type: 'object', additionalProperties: false, required: ['expected_revision', 'goal_text'],
          properties: {expected_revision: {type: 'integer', minimum: 1}, goal_text: {type: 'string', maxLength: 2000},
            goal_spec: {type: 'object', description: 'Full replacement GoalSpec JSON (description, scope, metrics, allowed_operations, monitoring, success, stop)'}}},
        execute: async (_id, params) => {
          const r = host.updateTaskGoal({goal_text: String(params.goal_text),
            goal_spec: params.goal_spec as Record<string, unknown> | undefined,
            expected_revision: Number(params.expected_revision)});
          if (!r.ok) {
            logAnd('update_goal', params, {ok: false, summary: `conflict: revision is ${r.conflict.actual}`, error: 'goal_revision_conflict'});
            return errResult(`Goal revision conflict: current is ${r.conflict.actual}. Stop editing; the next turn will use the newer goal.`);
          }
          effects.goalUpdated = {revision: r.revision};
          logAnd('update_goal', params, {ok: true, summary: `goal revision ${r.revision}`});
          return okResult(JSON.stringify({updated: true, goal_revision: r.revision}));
        },
      },
      {
        name: 'request_input', label: 'request_input',
        description: 'Ask the user for missing critical parameters or a decision. The task pauses as needs_input until they answer.',
        parameters: {type: 'object', additionalProperties: false, required: ['questions'],
          properties: {questions: {type: 'array', minItems: 1, maxItems: 6, items: {type: 'string', maxLength: 300}}}},
        execute: async (_id, params) => {
          effects.inputRequested = (params.questions as string[]).map(String);
          effects.stopRequested = true;
          logAnd('request_input', params, {ok: true, summary: `${effects.inputRequested.length} questions`});
          return {...okResult(JSON.stringify({task_status: 'needs_input'})), terminate: true};
        },
      },
      {
        name: 'complete_task', label: 'complete_task',
        description: 'End the task as completed: success conditions verified with evidence. The session continues for new tasks.',
        parameters: {type: 'object', additionalProperties: false, required: ['summary'],
          properties: {summary: {type: 'string', maxLength: 2000}, evidence_refs: {type: 'array', items: {type: 'string'}}}},
        execute: async (_id, params) => {
          effects.taskCompleted = {summary: String(params.summary), evidence_refs: (params.evidence_refs as string[]) ?? []};
          effects.stopRequested = true;
          logAnd('complete_task', params, {ok: true, summary: 'completed'});
          return {...okResult(JSON.stringify({task_status: 'completed'})), terminate: true};
        },
      },
      {
        name: 'fail_task', label: 'fail_task',
        description: 'End the task as failed with an explicit reason (budget, unreachable target, repeated errors).',
        parameters: {type: 'object', additionalProperties: false, required: ['reason', 'summary'],
          properties: {reason: {type: 'string', maxLength: 100}, summary: {type: 'string', maxLength: 2000}}},
        execute: async (_id, params) => {
          effects.taskFailed = {reason: String(params.reason), summary: String(params.summary)};
          effects.stopRequested = true;
          logAnd('fail_task', params, {ok: true, summary: `failed: ${String(params.reason)}`});
          return {...okResult(JSON.stringify({task_status: 'failed'})), terminate: true};
        },
      },
    ];

    const tools = [...readTools, ...writeTools, ...agentTools].map(t => ({
      name: t.name, label: t.label, description: t.description, parameters: t.parameters as never,
      execute: (id: string, params: unknown) => t.execute(id, (params ?? {}) as Record<string, unknown>),
    }));

    const model: Model<'openai-completions'> = {
      id: this.config.model, name: this.config.model, api: 'openai-completions',
      provider: this.config.provider, baseUrl: this.config.baseUrl, reasoning: false, input: ['text'],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 64_000, maxTokens: 4096,
      compat: {supportsStore: false, supportsDeveloperRole: false},
    };

    let steps = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(input, this.config.model),
        model, thinkingLevel: 'off' as const, tools,
      },
      streamFn: (m, c, o) => {
        usage.requests += 1;
        steps += 1;
        return streamSimple(m as Model<'openai-completions'>, c, {...o, apiKey: this.config!.apiKey});
      },
      toolExecution: 'sequential',
      // One bounded decision process per wake: the turn ends when the model
      // produced a plain-text conclusion (no tool calls), asked to stop
      // (wake registered / task ended / input requested) or hit the cap.
      shouldStopAfterTurn: ctx => effects.stopRequested || steps >= MAX_LOOP_STEPS
        || !ctx.message.content.some(c => c.type === 'toolCall'),
    });
    // pi's context estimator reads usage off assistant messages; stored
    // conversation rows carry no provider usage, so inject a zero usage.
    const zeroUsage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
    const promptMessages = [
      ...input.history.map(m => ({
        role: m.role,
        // pi expects assistant content as content blocks (a bare string would
        // be iterated block-wise and crash the context estimator)
        content: m.role === 'assistant' ? [{type: 'text' as const, text: m.content}] : m.content,
        timestamp: new Date(),
        ...(m.role === 'assistant' ? {usage: zeroUsage} : {}),
      })),
      {role: 'user' as const, content: currentTurnBrief(input), timestamp: new Date()},
    ];
    try {
      await agent.prompt(promptMessages as never);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, code: 'provider_error', error: message, assistantText: '', toolLog, effects,
        usage};
    } finally {
      try { agent.abort(); } catch { /* already idle */ }
    }
    for (const m of agent.state.messages) {
      const u = (m as {usage?: {input?: {tokens?: number}; output?: {tokens?: number}}}).usage;
      if (u) {
        usage.inputTokens += u.input?.tokens ?? 0;
        usage.outputTokens += u.output?.tokens ?? 0;
      }
    }
    const lastAssistant = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
    const assistantText = assistantTextOf(lastAssistant);
    const errorMessage = (agent.state as {errorMessage?: string}).errorMessage;
    if (errorMessage) {
      return {ok: false, code: 'provider_error', error: errorMessage, assistantText, toolLog, effects, usage};
    }
    return {ok: true, assistantText, toolLog, effects, usage};
  }

  compact(input: {history: Array<{role: 'user' | 'assistant'; content: string}>; task: TaskRow | null;
    facts: string[]; evidenceRefs: string[]}): {summary: string; facts: string[]; open_questions: string[]} {
    // Deterministic compaction: keeps goals, open items and evidence pointers.
    // It replaces only the MODEL CONTEXT; raw messages/events stay in SQLite.
    const userLines = input.history.filter(m => m.role === 'user').map(m => m.content);
    const openQuestions: string[] = [];
    for (const line of userLines.slice(-8)) {
      if (line.trim().endsWith('?')) openQuestions.push(line.slice(0, 200));
    }
    const summary = [
      input.task ? `Task goal (revision ${input.task.goal_revision}, status ${input.task.status}): ${input.task.goal_text}`
        : 'No task was created yet.',
      `Conversation compressed: ${input.history.length} messages (raw messages remain stored).`,
      input.facts.length ? `Established facts: ${input.facts.slice(-12).join(' | ')}` : '',
    ].filter(Boolean).join('\n');
    return {summary, facts: input.facts.slice(-24), open_questions: [...new Set(openQuestions)].slice(0, 6)};
  }

  async close(): Promise<void> { /* no persistent resources */ }
}

function emptyEffects(): TurnEffects {
  return {wakes: [], taskCompleted: null, taskFailed: null, inputRequested: null, goalUpdated: null,
    planUpdated: false, stopRequested: false};
}

// -- prompt assembly ---------------------------------------------------------------

export function buildSystemPrompt(input: TurnInput, modelName: string): string {
  const lines: string[] = [];
  lines.push('You are the OSCAR culture agent for one long-lived experiment session. '
    + 'You operate a virtual cell-culture device (6-channel row pipette, camera, incubator chamber, shaker) through tools only. '
    + 'Never invent observations or volumes: every liquid claim must come from the device state or an observation you received.');
  lines.push('Rules:');
  lines.push('- Device actions are row-parallel and asynchronous: a submitted action returns action_id immediately; its terminal state arrives as a device event on a later turn. After submitting, register a wake instead of waiting.');
  lines.push('- Liquid decisions (media.add / media.exchange) must be supported by a fresh observation or device state read in this turn, and you must pass its observation_id in evidence_refs when you have one.');
  lines.push('- Re-read the device state at the start of acting after any wait; the world moved while you were away.');
  lines.push('- Stay strictly within the goal scope (plates/rows/reservoirs) and allowed_operations; refusals are final for that request.');
  lines.push('- Monitor without acting when the metrics are satisfied: a wake with a short report is a valid, expected outcome.');
  lines.push('- Complete the task only when the success conditions hold with evidence; use fail_task for explicit dead ends.');
  if (input.task) {
    lines.push(`ACTIVE TASK ${input.task.task_id} (goal_revision ${input.task.goal_revision}, status ${input.task.status})`);
    lines.push(`Goal: ${input.task.goal_text}`);
    lines.push(`GoalSpec: ${JSON.stringify(input.spec)}`);
    lines.push(`Budget: actions ${input.budget.actions_used}/${input.budget.max_actions}, model turns ${input.budget.model_turns_used}/${input.budget.max_model_turns}.`);
    if (input.plan.length) {
      lines.push(`Plan: ${JSON.stringify(input.plan.map(p => ({index: p.index_in_plan, skill: p.skill, status: p.status,
        action_ids: p.action_ids, evidence_refs: p.evidence_refs})))}`);
    }
  } else {
    lines.push('No task exists yet. If the user is asking for device work, you still have no task tools: answer conversationally and explain what is needed to create a task (use the session task API).');
  }
  if (input.checkpointSummary) lines.push(`Memory checkpoint (older conversation compressed):\n${input.checkpointSummary}`);
  lines.push(`Current model backend: pi/openai-completions via ${modelName} (server-configured).`);
  return lines.join('\n');
}

export function currentTurnBrief(input: TurnInput): string {
  const parts: string[] = [];
  parts.push(`WAKE: ${input.wake ? JSON.stringify({kind: input.wake.kind, reason: input.wake.reason,
    ...input.wake.data}) : 'conversation (user message)'}`);
  if (input.deviceResults.length) {
    parts.push(`DEVICE RESULTS SINCE LAST TURN:\n${input.deviceResults.map(d =>
    `- ${d.source}: ${d.summary}${d.data !== undefined ? ` ${JSON.stringify(d.data).slice(0, 600)}` : ''}`).join('\n')}`);
  }
  parts.push(`CURRENT DEVICE STATE (fresh, sampled at sim_time_s=${input.state.experiment.sim_time_s}, event_seq=${input.state.event_seq}):\n${JSON.stringify(stateDigest(input.session.experiment_id, input.state, input.spec))}`);
  parts.push('Decide the next step for the task. Use tools; end the turn by registering a wake, requesting input, or completing/failing the task.');
  return parts.join('\n\n');
}

/** Scoped, size-bounded projection: only goal-relevant resources, never the full world. */
export function stateDigest(experimentId: string, state: StateSnapshot, spec: GoalSpec | null): Record<string, unknown> {
  const plates = spec?.scope.plates?.length ? state.plates.filter(p => spec.scope.plates.includes(p.plate_id)) : state.plates;
  return {
    experiment: {experiment_id: experimentId, sim_time_s: state.experiment.sim_time_s,
      clock_mode: state.experiment.clock_mode, paused: state.experiment.paused, speed: state.experiment.speed},
    chamber: {temperature_c: state.chamber.temperature_c, co2_pct: state.chamber.co2_pct,
      humidity_pct: state.chamber.humidity_pct, stable: state.chamber.stable},
    plates: plates.map(p => ({plate_id: p.plate_id, revision: p.revision, shake: p.shake.active ? p.shake : null,
      wells: p.wells.filter(w => !spec?.scope.rows?.length || spec.scope.rows.some(row => w.well_id.startsWith(row)))
        .map(w => ({well_id: w.well_id, volume_ul: w.volume_ul, medium_id: w.medium_id}))})),
    reservoirs: state.reservoirs.map(r => ({id: r.id, medium_id: r.medium_id, remaining_ul: r.remaining_ul})),
    waste: state.wastes.map(w => ({id: w.id, used_ul: w.used_ul, capacity_ul: w.capacity_ul})),
    tips: state.tips.map(t => ({id: t.id, remaining: t.remaining})),
    busy_resources: state.busy_resources,
    active_actions: state.active_actions.map(a => ({action_id: a.action_id, capability: a.capability,
      status: a.status, stage: a.stages[a.current_stage_index ?? 0]?.stage ?? null})),
    event_seq: state.event_seq,
  };
}

function assistantTextOf(m: unknown): string {
  if (!m || typeof m !== 'object') return '';
  const content = (m as {content?: unknown}).content;
  if (!Array.isArray(content)) return '';
  return content.filter((c): c is {type: 'text'; text: string} =>
    typeof c === 'object' && c !== null && (c as {type?: string}).type === 'text')
    .map(c => c.text).join('\n').trim();
}
