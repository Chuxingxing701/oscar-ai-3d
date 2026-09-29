// 相机 tab: observation list, mono / stereo pairs, before/after comparison,
// provenance labels. Blurred observations never show numeric estimates.
import {h, fmtNum, fmtSimTime, PROVENANCE_LABELS} from './ui.js';

export function mountCamera(root, ctx) {
  let observations = [];          // Observation[], newest first
  let selected = null;
  let compareA = null;
  let compareB = null;
  let loading = false;

  let reloadAgain = false;
  async function reload() {
    // A reload requested while one is in flight must not be lost.
    if (loading) { reloadAgain = true; return; }
    const state = ctx.getState();
    if (!state.experimentId) return;   // no experiment selected yet
    loading = true;
    try {
      const body = await ctx.api.observations(state.experimentId);
      const list = Array.isArray(body) ? body : (body?.observations || body?.items || []);
      observations = list
        .filter(o => o && o.observation_id)
        .sort((a, b) => (b.sampled_at_sim_s ?? 0) - (a.sampled_at_sim_s ?? 0));
      render();
    } catch (error) {
      if (error.code !== 'unauthenticated') ctx.showError(`观测列表加载失败：${error.message}`);
    } finally {
      loading = false;
      if (reloadAgain) { reloadAgain = false; reload(); }
    }
  }

  const image = (experimentId, ref, alt) => h('img', {
    src: ctx.api.assetUrl(experimentId, ref.asset_id),
    alt, width: 160, height: 120, loading: 'lazy',
  });

  function imagesOf(obs) {
    const experimentId = ctx.getState().experimentId;
    const imgs = obs.images || [];
    const mono = imgs.find(i => i.role === 'mono');
    const left = imgs.find(i => i.role === 'left');
    const right = imgs.find(i => i.role === 'right');
    const pair = h('div', {class: 'imgpair'});
    if (mono) pair.append(h('figure', {}, image(experimentId, mono, `${obs.observation_id} 单目图像`), h('figcaption', {}, '单目 mono')));
    if (left) pair.append(h('figure', {}, image(experimentId, left, `${obs.observation_id} 左目图像`), h('figcaption', {}, '左目 left')));
    if (right) pair.append(h('figure', {}, image(experimentId, right, `${obs.observation_id} 右目图像`), h('figcaption', {}, '右目 right')));
    if (!pair.children.length) pair.append(h('span', {class: 'muted'}, '（图像资产缺失时不会用新图替代旧证据）'));
    return pair;
  }

  function estimatesTable(obs) {
    if (obs.quality === 'blurred') {
      return h('p', {class: 'prov'}, '图像模糊：无有效估计（不以任何数值代替）');
    }
    const rows = (obs.estimates || []).filter(e => e && e.well_id);
    if (!rows.length) return h('p', {class: 'prov'}, '无逐孔估计');
    const table = h('table', {class: 'est-table'},
      h('tr', {}, h('th', {}, '孔'), h('th', {}, '液位 µL'), h('th', {}, '颜色指数'), h('th', {}, '浊度'), h('th', {}, '质量')),
      rows.map(e => h('tr', {},
        h('td', {}, e.well_id),
        h('td', {}, e.liquid_level_ul == null ? '—' : fmtNum(e.liquid_level_ul, 0)),
        h('td', {}, e.color_index == null ? '—' : fmtNum(e.color_index, 2)),
        h('td', {}, e.turbidity == null ? '—' : fmtNum(e.turbidity, 2)),
        h('td', {}, fmtNum(e.quality, 2)),
      )));
    return h('div', {}, table,
      h('p', {class: 'prov'}, `${PROVENANCE_LABELS.device_estimate} · 方法 ${obs.estimates?.[0]?.method || 'simulated_onboard_analysis'} · 图像 ${PROVENANCE_LABELS[obs.source] || obs.source || ''}（示意，非生物测量）`));
  }

  function obsCard(obs) {
    const isSelected = selected === obs.observation_id;
    const wells = (obs.wells || []).join('、');
    const samePlateAsA = !compareA || observations.find(o => o.observation_id === compareA)?.plate_id === obs.plate_id;
    return h('div', {class: 'obs-item', style: isSelected ? {borderColor: '#174993'} : {}},
      h('div', {},
        h('b', {}, obs.observation_id),
        ' ', h('span', {class: 'chip'}, obs.mode === 'stereo' ? '双目' : '单目'),
        ' ', h('span', {class: `chip ${obs.quality === 'ok' ? 'ok' : 'warn'}`},
          obs.quality === 'ok' ? '质量正常' : obs.quality === 'blurred' ? '模糊' : obs.quality),
        ' ', h('span', {class: 'muted'}, `${obs.plate_id || ''} ${wells} · ${fmtSimTime(obs.sampled_at_sim_s)} · plate rev ${obs.plate_revision ?? '—'}`),
      ),
      h('div', {class: 'obs-controls'},
        h('button', {type: 'button', class: 'button', onclick: () => {selected = obs.observation_id; render();}},
          isSelected ? '收起' : '查看'),
        h('button', {type: 'button', class: 'button', onclick: () => {compareA = obs.observation_id; render();},
          disabled: !samePlateAsA && Boolean(compareA) && compareB === obs.observation_id},
          compareA === obs.observation_id ? '✓ 对比 A' : '设为对比 A'),
        h('button', {type: 'button', class: 'button', onclick: () => {
          if (compareA && observations.find(o => o.observation_id === compareA)?.plate_id !== obs.plate_id) {
            ctx.showError('前后对比需选择同一块板的观测');
            return;
          }
          compareB = obs.observation_id; render();
        }}, compareB === obs.observation_id ? '✓ 对比 B' : '设为对比 B'),
      ),
      isSelected ? h('div', {style: {width: '100%'}}, imagesOf(obs), estimatesTable(obs)) : null,
    );
  }

  function compareSection() {
    if (!compareA || !compareB || compareA === compareB) return null;
    const a = observations.find(o => o.observation_id === compareA);
    const b = observations.find(o => o.observation_id === compareB);
    if (!a || !b) return null;
    const level = obs => Object.fromEntries((obs.estimates || [])
      .filter(e => e.well_id && e.liquid_level_ul != null).map(e => [e.well_id, e.liquid_level_ul]));
    const la = level(a), lb = level(b);
    const shared = Object.keys(la).filter(w => w in lb);
    return h('div', {class: 'card', style: {margin: '8px 0'}},
      h('h3', {}, '前后对比（同一板）'),
      h('div', {class: 'row'},
        h('div', {}, h('b', {}, a.observation_id), h('p', {class: 'muted'}, `${fmtSimTime(a.sampled_at_sim_s)} · ${(a.wells || []).join('、')}`), imagesOf(a)),
        h('div', {}, h('b', {}, b.observation_id), h('p', {class: 'muted'}, `${fmtSimTime(b.sampled_at_sim_s)} · ${(b.wells || []).join('、')}`), imagesOf(b)),
      ),
      shared.length && a.quality !== 'blurred' && b.quality !== 'blurred' ? h('p', {class: 'prov'},
        `液位估计差（B−A）：${shared.map(w => `${w} ${fmtNum(lb[w] - la[w], 0)} µL`).join('，')}`) : null,
      h('button', {type: 'button', onclick: () => {compareA = null; compareB = null; render();}}, '清除对比'),
    );
  }

  function render() {
    const header = h('div', {class: 'row'},
      h('button', {type: 'button', onclick: reload}, '刷新列表'),
      h('span', {class: 'muted'}, `共 ${observations.length} 条 · 图像为服务端合成 PNG（来源 synthetic_image）`));
    root.replaceChildren(...[header, compareSection(),
      h('div', {class: 'obs-list'}, observations.length ? observations.map(obsCard)
        : h('p', {class: 'muted'}, '暂无观测；在「操作」提交扫描后生成。'))].filter(Boolean));
  }

  render();
  reload();
  const reloadSoon = () => { clearTimeout(reload._t); reload._t = setTimeout(reload, 400); };
  ctx.bus.on('observation.created', reloadSoon);
  ctx.bus.on('snapshot', reloadSoon);
  ctx.bus.on('experiment', reload);

  return {
    // The observation list is data-driven (reload()), not per-frame: renders
    // from the store would rebuild <img> elements and interrupt loading.
    render() {},
    open(observationId) {
      selected = observationId;
      if (!observations.some(o => o.observation_id === observationId)) reload();
      render();
    },
  };
}
