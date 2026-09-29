// Synthetic display snapshots, never a Runtime simulator or evidence generator.
export const DURATION = 24;
export function previewSnapshot(map, kind, time, plateId = 'plate-01', wellId = 'A1', paused = true) {
  const rowId = wellId.replace(/\d+$/, '');
  const target = kind === 'scan' ? {plate_id: plateId, well_id: wellId} : {plate_id: plateId, row_id: rowId};
  const state = {experiment_id: 'scene-preview-only', sim_time_s: time, paused, actions: [],
    plates: map.stations.filter(s => s.kind === 'plate').map(station => ({plate_id: station.id,
      wells: station.wells.map((w, i) => ({well_id: w.well_id, volume_ul: 300 + (i % 6) * 150, capacity_ul: 2000}))}))};
  const plate = state.plates.find(p => p.plate_id === plateId);
  const well = plate.wells.find(w => w.well_id === wellId);
  const rowWells = plate.wells.filter(w => w.well_id.replace(/\d+$/, '') === rowId);
  const action = (stage, start, duration, extra = {}) => ({stage, stage_started_at_sim_s: start,
    stage_duration_sim_s: duration, target, ...extra});
  let phase = '待命';
  if (kind === 'shake') {
    plate.shake = {active: time >= 2 && time < 22, started_at_sim_s: 2, duration_sim_s: 20, frequency_hz: 2, amplitude_m: .0012};
    phase = plate.shake.active ? '原工位载台振荡 · 2 Hz 示意' : '载台归位';
  } else if (time < 4) {
    state.actions = [action('moving', 0, 4, {tool: kind === 'scan' ? 'camera' : 'pipette'})]; phase = '高位定位';
  } else if (kind === 'scan') {
    if (time < 20) {state.actions = [action('scanning', 4, 16)]; phase = '虚拟相机扫描光锥 · 非观测证据';}
    else phase = '扫描示意结束';
  } else if (time < 7) {
    state.actions = [action('lowering', 4, 3)]; phase = '下降至展示间隙';
  } else if (time < 19) {
    const aspirating = kind === 'exchange' && time < 13;
    state.actions = [action(aspirating ? 'aspirating' : 'dispensing', kind === 'exchange' && !aspirating ? 13 : 7,
      kind === 'exchange' ? 6 : 12)];
    phase = `排枪 ${rowId} 排 ${rowWells.length} 孔同步${aspirating ? '吸液 · 橙色光效' : '加液 · 绿色光效'}`;
  } else if (time < 22) {
    state.actions = [action('raising', 19, 3)]; phase = '抬升';
  } else phase = '示例结束 · 液量由夹具给定';
  for (const rowWell of rowWells) {
    if (kind === 'dispense') rowWell.volume_ul = 300 + Math.max(0, Math.min(1, (time - 7) / 12)) * 1400;
    if (kind === 'exchange') rowWell.volume_ul = time < 13
      ? 1400 - Math.max(0, Math.min(1, (time - 7) / 6)) * 1000
      : 400 + Math.max(0, Math.min(1, (time - 13) / 6)) * 1000;
  }
  return {state, phase, volume: well.volume_ul, rowId, wellIds: rowWells.map(w => w.well_id)};
}
