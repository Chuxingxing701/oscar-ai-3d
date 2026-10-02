// Stable business identifiers. These are independent from GLB node names;
// web/scene/scene-map.json maps them to scene nodes.
export const PROFILE_ID = 'oscar-mhs-demo/0.1';
export const API_VERSION = 'v1';
export const DEVICE_ID = 'oscar-01';
export const CHAMBER_ID = 'chamber-01';
export const HEAD_RESOURCE = 'head';

export type PlateFormat = '24' | '96';
export interface PlateLayout { format: PlateFormat; rows: number; columns: number }
export const PLATE_LAYOUTS: Record<PlateFormat, PlateLayout> = {
  '24': {format: '24', rows: 4, columns: 6},
  '96': {format: '96', rows: 8, columns: 12},
};

export const WELL_ID_PATTERN = '^[A-H](1[0-2]|[1-9])$';
export const ROW_ID_PATTERN = '^[A-H]$';
export const RESOURCE_ID_PATTERN = '^[a-z][a-z0-9-]{1,40}$';

export function rowIds(layout: PlateLayout): string[] {
  return Array.from({length: layout.rows}, (_, i) => String.fromCharCode(65 + i));
}

export function wellIds(layout: PlateLayout): string[] {
  return rowIds(layout).flatMap(row => rowWellIds(layout, row));
}

/** Complete row in column order, e.g. A -> A1..A6 for a 24-well plate. */
export function rowWellIds(layout: PlateLayout, rowId: string): string[] {
  if (!rowIds(layout).includes(rowId)) return [];
  return Array.from({length: layout.columns}, (_, i) => `${rowId}${i + 1}`);
}

export function rowOfWell(wellId: string): string {
  return wellId.replace(/\d+$/, '');
}

/** Human readable scope label for UI confirmation, e.g. "plate-01 A1–A6". */
export function rowScopeLabel(plateId: string, layout: PlateLayout, rowId: string): string {
  const wells = rowWellIds(layout, rowId);
  return wells.length ? `${plateId} ${wells[0]}–${wells[wells.length - 1]}` : `${plateId} ${rowId}?`;
}

/** Resource lock keys, e.g. "plate:plate-01". The head is a single shared resource. */
export const resourceKey = {
  head: () => HEAD_RESOURCE,
  plate: (id: string) => `plate:${id}`,
  reservoir: (id: string) => `reservoir:${id}`,
  waste: (id: string) => `waste:${id}`,
  tips: () => 'tips',
  chamber: (id: string) => `chamber:${id}`,
};
