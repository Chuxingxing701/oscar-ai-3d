// Left column: device, chamber summary, plates with 4×6 well grids
// (volumes) and inventory. Well clicks focus the 3D scene; 3D picks
// (onSelect → {plate_id, well_id}) highlight here via ctx selection.
import {h, fmtNum, fmtVolume, invBar} from './ui.js';
import {rowOfWell, rowWellIds, PLATE_LAYOUT_24} from '../api/ids.js';

export function mountResources(root, ctx) {
  const deviceBody = root.querySelector('#device-card .card-body');
  const chamberBody = root.querySelector('#chamber-mini .card-body');
  const platesBody = root.querySelector('#plates-card .card-body');
  const inventoryBody = root.querySelector('#inventory-card .card-body');

  function renderDevice(state) {
    const d = state.device || {};
    deviceBody.replaceChildren(h('dl', {},
      h('dt', {}, '设备'), h('dd', {}, `${d.device_id || '—'} · ${d.mode === 'simulation' ? '仿真模式' : d.mode || '—'}`),
      h('dt', {}, '健康'), h('dd', {}, d.health === 'ok' ? '正常' : d.health || '—'),
      h('dt', {}, '共享头'), h('dd', {}, state.head ? `占用中（${state.head.action_id}）` : '空闲'),
      h('dt', {}, '实验'), h('dd', {}, state.experiment?.experiment_id || '—'),
    ));
  }

  function renderChamber(state) {
    const c = state.chamber;
    if (!c) { chamberBody.replaceChildren(h('p', {class: 'muted'}, '暂无腔室读数')); return; }
    chamberBody.replaceChildren(h('dl', {},
      h('dt', {}, '温度'), h('dd', {}, `${fmtNum(c.temperature_c?.observed)} / ${fmtNum(c.temperature_c?.target)} °C`),
      h('dt', {}, 'CO₂'), h('dd', {}, `${fmtNum(c.co2_pct?.observed)} / ${fmtNum(c.co2_pct?.target)} %`),
      h('dt', {}, '湿度'), h('dd', {}, `${fmtNum(c.humidity_pct?.observed)} / ${fmtNum(c.humidity_pct?.target)} %`),
      h('dt', {}, '状态'), h('dd', {}, c.stable ? '已稳定' : '趋近中'),
    ));
  }

  function renderPlates(state) {
    const selection = ctx.getSelection();
    const nodes = [];
    for (const plate of state.plates || []) {
      const wells = plate.wells || [];
      const rows = [...new Set(wells.map(w => rowOfWell(w.well_id)))].sort();
      const selectedRow = selection?.plate_id === plate.plate_id && selection.well_id ? rowOfWell(selection.well_id) : null;
      const grid = h('div', {class: 'wellgrid', role: 'group', 'aria-label': `${plate.plate_id} 孔位`});
      for (const rowId of rows) {
        grid.append(h('span', {class: 'rowlabel'}, rowId));
        for (const well of wells.filter(w => rowOfWell(w.well_id) === rowId)) {
          const ratio = well.capacity_ul > 0 ? Math.min(1, well.volume_ul / well.capacity_ul) : 0;
          const busy = (state.busyResources?.[`plate:${plate.plate_id}`] != null);
          grid.append(h('button', {
            type: 'button',
            class: 'well' + (selection?.plate_id === plate.plate_id && selection?.well_id === well.well_id ? ' sel' : '')
              + (selectedRow === rowId ? ' inrow' : '') + (busy ? ' busy' : ''),
            title: `${plate.plate_id} ${well.well_id} · ${fmtVolume(well.volume_ul)} / ${fmtVolume(well.capacity_ul)}${well.medium_id ? ' · ' + well.medium_id : ''}`,
            'aria-label': `${plate.plate_id} ${well.well_id}，液量 ${fmtVolume(well.volume_ul)}`,
            onclick: () => ctx.select({plate_id: plate.plate_id, well_id: well.well_id}),
          },
          h('span', {class: 'fill', style: {height: `${(ratio * 100).toFixed(0)}%`}}),
          h('span', {class: 'txt'}, `${well.well_id.replace(rowId, '')}`, h('br'), `${Math.round(well.volume_ul)}`),
          ));
        }
      }
      nodes.push(h('div', {class: 'plate-block'},
        h('div', {class: 'plate-head'},
          h('button', {type: 'button', class: 'plate-head', onclick: () => ctx.focusScene({plate_id: plate.plate_id})},
            `${plate.plate_id}（${plate.format} 孔）`),
          plate.shake?.active ? h('span', {class: 'shake-tag'},
            `振荡 ${plate.shake.speed_rpm ?? '?'} rpm`) : null,
          h('span', {class: 'muted'}, `rev ${plate.revision ?? '—'}`),
        ),
        grid,
        selectedRow ? h('p', {class: 'muted', style: {margin: '2px 0 0', 'font-size': '10px'}},
          `选中排 ${selectedRow} → ${rowWellIds(PLATE_LAYOUT_24, selectedRow).join('、')}`) : null,
      ));
    }
    platesBody.replaceChildren(...(nodes.length ? nodes : [h('p', {class: 'muted'}, '暂无板数据')]));
  }

  function renderInventory(state) {
    const rows = [];
    for (const r of state.reservoirs || []) {
      rows.push(h('div', {}, h('div', {class: 'row'},
        h('b', {}, r.id), h('span', {class: 'muted'}, r.medium_id || '培养基'),
        h('span', {style: {'margin-left': 'auto'}}, `${fmtVolume(r.remaining_ul)} / ${fmtVolume(r.capacity_ul)}`)),
        invBar('', r.capacity_ul - r.remaining_ul, r.capacity_ul)));
    }
    for (const w of state.wastes || []) {
      rows.push(h('div', {}, h('div', {class: 'row'},
        h('b', {}, w.id), h('span', {class: 'muted'}, '废液'),
        h('span', {style: {'margin-left': 'auto'}}, `${fmtVolume(w.used_ul)} / ${fmtVolume(w.capacity_ul)}`)),
        invBar('waste', w.used_ul, w.capacity_ul)));
    }
    let tipsTotal = 0, tipsCapacity = 0;
    for (const t of state.tips || []) {
      tipsTotal += t.remaining; tipsCapacity += t.capacity;
      rows.push(h('div', {}, h('div', {class: 'row'},
        h('b', {}, t.id), h('span', {class: 'muted'}, '吸头（逻辑库存，取头为示意）'),
        h('span', {style: {'margin-left': 'auto'}}, `${t.remaining} / ${t.capacity}`)),
        invBar('tips', t.capacity - t.remaining, t.capacity)));
    }
    if (tipsCapacity) rows.unshift(h('p', {class: 'muted', style: {margin: '0 0 4px', 'font-size': '10px'}},
      `每次取头消耗 6 支（演示配置）· 剩余合计 ${tipsTotal}`));
    inventoryBody.replaceChildren(...(rows.length ? rows : [h('p', {class: 'muted'}, '暂无库存数据')]));
  }

  let lastKey = '';
  return {
    render(state) {
      // Rebuild only when the displayed data actually changes (volumes, shake,
      // inventory, selection) — never on clock-only frames.
      const key = JSON.stringify([
        state.device, state.head?.action_id, state.experiment?.experiment_id, ctx.getSelection(),
        (state.plates || []).map(p => [p.plate_id, p.revision, p.shake?.active, p.shake?.speed_rpm,
          (p.wells || []).map(w => w.volume_ul), state.busyResources?.[`plate:${p.plate_id}`]]),
        state.reservoirs, state.wastes, state.tips,
        state.chamber?.temperature_c?.observed, state.chamber?.co2_pct?.observed, state.chamber?.humidity_pct?.observed,
      ]);
      if (key === lastKey) return;
      lastKey = key;
      renderDevice(state);
      renderChamber(state);
      renderPlates(state);
      renderInventory(state);
    },
  };
}
