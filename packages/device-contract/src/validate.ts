import {Ajv, type ErrorObject, type ValidateFunction} from 'ajv';
import {CAPABILITIES} from './manifest.ts';
import {DeviceError} from './errors.ts';
import {rowWellIds, rowScopeLabel, type PlateLayout} from './ids.ts';

const ajv = new Ajv({allErrors: true, strict: true, useDefaults: true});
const validators = new Map<string, ValidateFunction>(CAPABILITIES.map(c => [c.name, ajv.compile(c.input_schema)]));

function describe(errors: ErrorObject[] | null | undefined): {path: string; message: string}[] {
  return (errors ?? []).map(e => ({path: e.instancePath || '/', message: `${e.message ?? 'invalid'}${
    e.keyword === 'additionalProperties' ? ` (${String((e.params as {additionalProperty?: string}).additionalProperty)})` : ''}`}));
}

function assertFinite(value: unknown, path: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new DeviceError('invalid_argument', `${path} must be finite`);
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertFinite(v, `${path}/${k}`);
}

/** Validate against the manifest input_schema. Returns a defaulted deep copy; input is not mutated. */
export function validateArguments(capability: string, args: unknown): Record<string, unknown> {
  const validate = validators.get(capability);
  if (!validate) throw new DeviceError('invalid_argument', `Unknown capability ${capability}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new DeviceError('invalid_argument', 'arguments must be an object');
  assertFinite(args, '');
  const copy = structuredClone(args) as Record<string, unknown>;
  if (!validate(copy)) throw new DeviceError('invalid_argument', `Invalid arguments for ${capability}`, {errors: describe(validate.errors)});
  return copy;
}

export interface RowScope { plate_id: string; row_id: string; wells: string[]; label: string }

/**
 * Row pipette scope. `wells`, if present, must be exactly the complete row
 * (any order); a single well or partial row is rejected, never expanded.
 */
export function normalizeRowScope(layout: PlateLayout, args: {plate_id: string; row_id: string; wells?: string[]},
  channels: number): RowScope {
  const wells = rowWellIds(layout, args.row_id);
  if (!wells.length) throw new DeviceError('invalid_argument', `Row ${args.row_id} does not exist on ${args.plate_id}`,
    {row_id: args.row_id});
  if (wells.length !== channels) throw new DeviceError('invalid_argument',
    `Row ${args.row_id} has ${wells.length} wells but the head has ${channels} channels`, {channels});
  if (args.wells) {
    const given = [...args.wells].sort();
    const want = [...wells].sort();
    if (given.length !== want.length || given.some((w, i) => w !== want[i])) {
      throw new DeviceError('invalid_argument',
        `wells must list the complete row ${args.row_id} (${wells.join(',')}); the row pipette cannot address a subset`,
        {expected: wells, received: args.wells});
    }
  }
  return {plate_id: args.plate_id, row_id: args.row_id, wells, label: rowScopeLabel(args.plate_id, layout, args.row_id)};
}

/** Canonical JSON with sorted object keys (idempotency comparison). */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
