// Small shared DOM/format helpers for workbench panels (no framework).
import {parseEnvSample, parseEnvTargets} from '../api/store.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const fmtNum = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
export const fmtVolume = ul => Number.isFinite(Number(ul)) ? `${Math.round(Number(ul))} µL` : '—';
export const fmtSimTime = s => {
  if (!Number.isFinite(Number(s))) return '—';
  const t = Math.floor(Number(s));
  if (t < 60) return `${t} s`;
  const m = Math.floor(t / 60), sec = t % 60;
  if (m < 60) return `${m}分${String(sec).padStart(2, '0')}秒`;
  return `${Math.floor(m / 60)}时${String(m % 60).padStart(2, '0')}分`;
};

export const ACTION_STATUS_LABELS = {
  queued: '已受理', running: '执行中', cancelling: '取消中',
  succeeded: '成功', failed: '失败', cancelled: '已取消',
};
export const ACTION_STATUS_CLASS = {queued: 'warn', running: 'ok', cancelling: 'warn',
  succeeded: 'ok', failed: 'bad', cancelled: 'warn'};
export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export const CAPABILITY_LABELS = {
  'media.add': '整排加液', 'media.exchange': '整排换液', 'imaging.scan': '扫描成像',
  'plate.shake': '摇床振荡', 'environment.set_targets': '环境设定', 'environment.await_stable': '等待环境稳定',
};
export const capabilityLabel = capability => CAPABILITY_LABELS[capability] || capability || '—';

export const STAGE_LABELS = {
  moving: '移动', lowering: '下降', aspirating: '吸液', dispensing: '排液', raising: '抬升',
  scanning: '扫描', picking_tip: '取头', dropping_tip: '弃头', shaking: '振荡', waiting: '等待',
};
export const stageLabel = stage => STAGE_LABELS[stage] || stage || '—';

export const PROVENANCE_LABELS = {
  synthetic_image: '合成图像', device_estimate: '设备估计', synthetic_sensor: '合成传感器',
  simulator_truth: '仿真真值', oracle_demo: '演示预言',
};

const EVENT_LABELS = {
  'experiment.created': '实验创建', 'experiment.archived': '实验归档',
  'action.accepted': '动作受理', 'action.started': '动作开始', 'action.stage_changed': '阶段变化',
  'action.effect_committed': '效果提交', 'action.succeeded': '动作成功', 'action.failed': '动作失败',
  'action.cancelled': '动作取消', 'observation.created': '观测生成', 'environment.targets_set': '环境目标设定',
  'environment.sampled': '环境采样', 'plate.shake_started': '摇床开始', 'plate.shake_stopped': '摇床结束',
  'decision.granted': '决策屏障授予', 'lease.released': '屏障释放', 'lease.expired': '屏障过期',
  'lease.revoked': '屏障撤销', 'run.created': '运行创建', 'run.paused': '运行暂停', 'run.resumed': '运行恢复',
  'run.on_hold': '运行挂起', 'run.ended': '运行结束', 'clock.paused': '模拟暂停', 'clock.resumed': '模拟继续',
  'clock.speed_changed': '倍率调整', 'clock.stepped': '时钟步进', 'scenario.fault_injected': '故障注入',
};
export const eventLabel = type => EVENT_LABELS[type] || type;

/** One-line human summary of a device event for the timeline. */
export function eventDetail(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'action.accepted': {
      const args = p.arguments || {};
      const cap = capabilityLabel(p.capability);
      if (args.plate_id && args.row_id) return `${cap} · ${args.plate_id} ${args.row_id}排`;
      if (args.plate_id && Array.isArray(args.wells)) return `${cap} · ${args.plate_id} ${args.wells.length} 孔`;
      if (args.chamber_id) return `${cap} · ${Object.keys(p.arguments || {}).filter(k => k !== 'chamber_id').join('/') || '腔室'}`;
      return cap;
    }
    case 'action.stage_changed': return stageLabel(p.stage);
    case 'action.effect_committed': {
      const wells = p.effect?.wells || p.wells || [];
      return wells.length ? `${wells.length} 孔液量更新` : '效果提交';
    }
    case 'action.succeeded': return p.partial ? '部分效果' : '完成';
    case 'action.failed': return p.reason || p.error?.code || '失败';
    case 'action.cancelled': return p.cancel_reason || p.reason || '取消';
    case 'observation.created': return `${p.plate_id || ''} ${Array.isArray(p.wells) ? p.wells.join('、') : ''} ${p.mode === 'stereo' ? '双目' : '单目'}`.trim();
    case 'environment.targets_set': {
      const targets = parseEnvTargets(p) || {};
      return Object.entries(targets).filter(([k]) => ['temperature_c', 'co2_pct', 'humidity_pct'].includes(k))
        .map(([k, v]) => ({temperature_c: '温度', co2_pct: 'CO₂', humidity_pct: '湿度'}[k] + '=' + v)).join(' ');
    }
    case 'environment.sampled': {
      const channels = parseEnvSample(p) || {};
      // Summarize this event's observations, never current values or targets.
      const reading = key => Number.isFinite(channels[key]?.observed) ? fmtNum(channels[key].observed) : '—';
      return `温度 ${reading('temperature_c')}°C · CO₂ ${reading('co2_pct')}% · 湿度 ${reading('humidity_pct')}%RH`;
    }
    case 'plate.shake_started': return `${p.plate_id} ${p.speed_rpm ?? '?'} rpm ${p.duration_sim_s ?? '?'} s`;
    case 'plate.shake_stopped': return p.plate_id || '';
    case 'decision.granted': return `lease#${p.lease?.lease_id ?? '?'} ${(p.lease?.triggers || []).map(t => t.kind).join(',')}`;
    case 'run.ended': return p.reason || '';
    case 'clock.speed_changed': return `${p.speed}×`;
    case 'clock.stepped': return `${p.sim_time_s ?? ''} s`;
    default: return '';
  }
}

export function eventFilterOf(type) {
  if (type.startsWith('action.')) return 'action';
  if (type.startsWith('observation.')) return 'observation';
  if (type.startsWith('environment.')) return 'environment';
  if (type.startsWith('clock.')) return 'clock';
  if (type.startsWith('run.') || type.startsWith('lease.') || type.startsWith('decision.')) return 'run';
  if (type.startsWith('plate.shake')) return 'shake';
  return 'all';
}

/** Fill ratio bar for inventory rows. */
export function invBar(kind, used, capacity) {
  const ratio = capacity > 0 ? Math.max(0, Math.min(1, used / capacity)) : 0;
  return h('div', {class: `invbar ${kind}`}, h('i', {style: {width: `${(ratio * 100).toFixed(1)}%`}}));
}
