// Tool definitions derived mechanically from the manifest (no second hand-written table).
import {CAPABILITIES, toolName, type JsonSchema, type Manifest} from './manifest.ts';

export interface ToolDefinition { name: string; capability: string | null; description: string; input_schema: JsonSchema;
  access: 'read' | 'write' | 'agent' }

/** Agent-only scheduling / bookkeeping tools (§7.1). */
export const AGENT_TOOLS: ToolDefinition[] = [
  {name: 'record_observation', capability: null, access: 'agent',
    description: 'Record a structured observation with source, quality, sim time, target wells and plate_revision.',
    input_schema: {type: 'object', additionalProperties: false, required: ['observation_id', 'summary'],
      properties: {observation_id: {type: 'string'}, summary: {type: 'string', maxLength: 500}}}},
  {name: 'wait_until', capability: null, access: 'agent',
    description: 'Release the decision lease and register a wake condition (lockstep). Returns next_lease immediately when already satisfied.',
    input_schema: {type: 'object', additionalProperties: false, minProperties: 1,
      properties: {on_actions: {type: 'array', items: {type: 'string'}, minItems: 1}, at_sim_s: {type: 'number', minimum: 0}}}},
  {name: 'finish', capability: null, access: 'agent',
    description: 'End the run with a final report referencing evidence and actions.',
    input_schema: {type: 'object', additionalProperties: false, required: ['summary'],
      properties: {summary: {type: 'string', maxLength: 2000}, outcome: {enum: ['completed', 'failed', 'aborted']}}}},
];

/** Tools for a run scope. Read capabilities that need no args beyond the experiment are included. */
export function buildTools(manifest: Pick<Manifest, 'capabilities'> = {capabilities: CAPABILITIES},
  allowed?: readonly string[]): ToolDefinition[] {
  const device = manifest.capabilities
    .filter(c => c.access !== 'control' && (!allowed || allowed.includes(c.name) || c.access === 'read'))
    .map(c => ({name: toolName(c.name), capability: c.name, description: c.description, input_schema: c.input_schema,
      access: c.access as 'read' | 'write'}));
  return [...device, ...AGENT_TOOLS];
}
