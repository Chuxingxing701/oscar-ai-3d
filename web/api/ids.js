// Browser-side mirror of the stable identifier helpers in
// packages/device-contract/src/ids.ts. The packages/ tree is NOT served by the
// Runtime (static whitelist is /web/** only), so the workbench carries this
// small pure copy. tests/web/scene-adapter.test.mjs cross-checks it against
// the TypeScript source of truth.

export const DEVICE_ID = 'oscar-01';
export const CHAMBER_ID = 'chamber-01';

/** Current demo display plates are 24-well: 4 rows A–D × 6 columns. */
export const PLATE_LAYOUT_24 = {format: '24', rows: 4, columns: 6};

export function rowIds(layout = PLATE_LAYOUT_24) {
  return Array.from({length: layout.rows}, (_, i) => String.fromCharCode(65 + i));
}

/** Complete row in column order, e.g. 'A' -> ['A1'..'A6']. */
export function rowWellIds(layout, rowId) {
  if (!rowIds(layout).includes(rowId)) return [];
  return Array.from({length: layout.columns}, (_, i) => `${rowId}${i + 1}`);
}

export function wellIds(layout = PLATE_LAYOUT_24) {
  return rowIds(layout).flatMap(row => rowWellIds(layout, row));
}

export function rowOfWell(wellId) { return String(wellId || '').replace(/\d+$/, ''); }

/** Human readable scope label for the pre-submit confirmation, e.g. "plate-01 A1–A6". */
export function rowScopeLabel(plateId, layout, rowId) {
  const wells = rowWellIds(layout, rowId);
  return wells.length ? `${plateId} ${wells[0]}–${wells[wells.length - 1]}` : `${plateId} ${rowId}?`;
}
