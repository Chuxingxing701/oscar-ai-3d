// 环境 tab: current target vs observed for temperature / CO₂ / humidity
// plus a small inline-SVG trend chart built from environment.sampled events
// (target step line + observed line) — makes clear that setting a target does
// not change the observed value instantly.
import {h, fmtNum} from './ui.js';

const CHANNELS = [
  {key: 'temperature_c', label: '温度', unit: '°C', digits: 1},
  {key: 'co2_pct', label: 'CO₂', unit: '%', digits: 2},
  {key: 'humidity_pct', label: '湿度', unit: '%RH', digits: 1},
];

function trendSvg(samples, channel, currentTarget) {
  const width = 220, height = 80, pad = 4;
  const points = samples.filter(s => Number.isFinite(s.channels?.[channel.key]?.observed));
  if (!points.length) return h('p', {class: 'muted'}, '暂无采样');
  const observed = points.map(s => s.channels[channel.key].observed);
  const targetAt = s => s.channels[channel.key]?.target ?? currentTarget;
  const targets = points.map(targetAt);
  const values = [...observed, ...targets, currentTarget].filter(Number.isFinite);
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max - min) || 1;
  const x = i => pad + (points.length === 1 ? 0 : i * (width - 2 * pad) / (points.length - 1));
  const y = v => height - pad - ((v - min) / span) * (height - 2 * pad);
  const line = get => points.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(get(s, i)).toFixed(1)}`).join('');
  return h('svg', {viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${channel.label}趋势图`},
    h('line', {x1: pad, y1: y(currentTarget), x2: width - pad, y2: y(currentTarget),
      stroke: '#b98a2b', 'stroke-width': 1, 'stroke-dasharray': '3 3'}),
    h('path', {d: line((s, i) => targets[i]), fill: 'none', stroke: '#d9b25a', 'stroke-width': 1.5}),
    h('path', {d: line(s => s.channels[channel.key].observed), fill: 'none', stroke: '#174993', 'stroke-width': 1.8}),
  );
}

export function mountEnvironment(root, ctx) {
  function render(state) {
    const chamber = state.chamber;
    const samples = state.envSamples || [];
    if (!chamber) {
      root.replaceChildren(h('p', {class: 'muted'}, '暂无腔室读数（快照尚未到达）'));
      return;
    }
    const cards = CHANNELS.map(channel => {
      const c = chamber[channel.key] || {};
      const quality = c.quality === 'ok' ? '正常' : c.quality === 'settling' ? '趋近中' : c.quality === 'degraded' ? '偏差大' : (c.quality || '—');
      return h('div', {class: 'envcard'},
        h('h3', {}, `${channel.label}（${channel.unit}）`),
        h('dl', {},
          h('dt', {}, '目标'), h('dd', {}, fmtNum(c.target, channel.digits)),
          h('dt', {}, '观测'), h('dd', {}, `${fmtNum(c.observed, channel.digits)} ±${fmtNum(c.error, 2)}`),
          h('dt', {}, '状态'), h('dd', {}, quality),
          h('dt', {}, '采样'), h('dd', {}, `${fmtNum(c.sampled_at_sim_s, 0)} s`),
        ),
        trendSvg(samples, channel, c.target),
      );
    });
    root.replaceChildren(
      h('div', {class: 'envgrid'}, cards),
      h('p', {class: 'legend'},
        h('i', {style: {background: '#174993'}}), '观测值',
        h('i', {style: {background: '#d9b25a'}}), '目标',
        h('i', {style: {background: '#b98a2b'}}), '当前目标线',
        ` · 来源 synthetic_sensor（合成传感器，示意）· 近 ${samples.length} 次采样`),
    );
  }
  return {render};
}
