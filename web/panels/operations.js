// 操作 tab: manual scan / row add / row exchange / shake / environment set,
// with the explicit full-row scope shown BEFORE submit (rowWellIds derived),
// live action status + stage progress + partial effects + cancel.
// Form inputs are created once and only updated in place — live SSE renders
// must never clobber what the operator is typing.
import {h, fmtNum, capabilityLabel, stageLabel, ACTION_STATUS_LABELS, ACTION_STATUS_CLASS, TERMINAL_STATUSES} from './ui.js';
import {rowWellIds, rowScopeLabel, rowOfWell, PLATE_LAYOUT_24} from '../api/ids.js';
import {stageProgress} from '../api/scene-adapter.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function mountOperations(root, ctx) {
  const tracked = new Set();       // action_ids submitted from this panel
  let msg = {text: '', bad: false};

  root.replaceChildren();

  // ----- scan form (persistent skeleton) -----------------------------------
  const scanPlateSel = h('select', {'aria-label': '扫描板'});
  const scanModeSel = h('select', {},
    h('option', {value: 'mono'}, '单目'), h('option', {value: 'stereo'}, '双目（左右）'));
  const scanViewSel = h('select', {},
    h('option', {value: 'medium_overview'}, '培养液概览'), h('option', {value: 'culture_detail'}, '培养细节'));
  const scanGrid = h('div', {class: 'scan-wells', role: 'group', 'aria-label': '扫描孔位多选'});
  const scanCount = h('span', {class: 'muted'});
  const scanSubmit = h('button', {type: 'submit', class: 'primary'}, '提交扫描');
  const scanForm = h('form', {id: 'form-scan'},
    h('div', {class: 'row'},
      h('label', {}, '板', scanPlateSel), h('label', {}, '模式', scanModeSel), h('label', {}, '视图', scanViewSel)),
    scanGrid, h('p', {class: 'muted', style: {'font-size': '10px'}}, scanCount, '（单孔/多孔扫描；液体操作永远作用于整排）'), scanSubmit);
  const scanWells = new Set();
  let scanPlateBuiltFor = null;
  let scanSelectionKey = '';

  scanPlateSel.addEventListener('change', () => {
    scanWells.clear(); scanPlateBuiltFor = null; syncScanForm(ctx.getState());
  });
  scanForm.onsubmit = event => {
    event.preventDefault();
    if (!scanWells.size) return;
    submit('imaging.scan', {plate_id: scanPlateSel.value, wells: [...scanWells],
      mode: scanModeSel.value, view: scanViewSel.value});
  };

  // ----- row forms (persistent skeleton) ------------------------------------
  const makeRowForm = formId => {
    const plateSel = h('select', {'aria-label': '板'});
    const rowSel = h('select', {'aria-label': '排'});
    const scope = h('p', {class: 'scope'}, '作用范围：—');
    return {formId, plateSel, rowSel, scope,
      wrap: h('div', {class: 'row'}, h('label', {}, '板', plateSel), h('label', {}, '排', rowSel))};
  };
  const addParts = makeRowForm('add');
  const addReservoir = h('select', {'aria-label': '储液'});
  const addVolume = h('input', {type: 'number', id: 'add-volume', min: 10, max: 1000, step: 10, value: 200});
  const addForm = h('form', {id: 'form-add'}, addParts.wrap, addParts.scope,
    h('div', {class: 'row'},
      h('label', {}, '储液', addReservoir),
      h('label', {}, '每孔加液量 µL', addVolume)),
    h('p', {class: 'muted', style: {'font-size': '10px'}}, '储液消耗 = 每孔体积 × 6；取头消耗 6 支（示意）。'),
    h('button', {type: 'submit', class: 'primary'}, '提交整排加液'));
  const exchangeParts = makeRowForm('exchange');
  const exchangeReservoir = h('select', {'aria-label': '储液'});
  const exchangeFraction = h('input', {type: 'number', id: 'exchange-fraction', min: 0.05, max: 0.9, step: 0.05, value: 0.5});
  const exchangeForm = h('form', {id: 'form-exchange'}, exchangeParts.wrap, exchangeParts.scope,
    h('div', {class: 'row'},
      h('label', {}, '储液', exchangeReservoir),
      h('label', {}, '换液比例（每孔）', exchangeFraction)),
    h('p', {class: 'muted', style: {'font-size': '10px'}}, '每通道先吸走 比例×该孔液量 至废液，再补入等量新液；取头 2 次（12 支，示意）。'),
    h('button', {type: 'submit', class: 'primary'}, '提交整排换液'));

  addForm.onsubmit = event => {
    event.preventDefault();
    if (!addParts.plateSel.value || !addParts.rowSel.value) return;
    submit('media.add', {plate_id: addParts.plateSel.value, row_id: addParts.rowSel.value,
      wells: rowWellIds(PLATE_LAYOUT_24, addParts.rowSel.value),
      reservoir_id: addReservoir.value, volume_ul_per_well: Number(addVolume.value)});
  };
  exchangeForm.onsubmit = event => {
    event.preventDefault();
    if (!exchangeParts.plateSel.value || !exchangeParts.rowSel.value) return;
    submit('media.exchange', {plate_id: exchangeParts.plateSel.value, row_id: exchangeParts.rowSel.value,
      wells: rowWellIds(PLATE_LAYOUT_24, exchangeParts.rowSel.value),
      reservoir_id: exchangeReservoir.value, fraction: Number(exchangeFraction.value)});
  };

  // ----- shake + environment (persistent skeleton) ---------------------------
  const shakePlateSel = h('select', {'aria-label': '摇床板'});
  const shakeRpm = h('input', {type: 'number', id: 'shake-rpm', min: 100, max: 1200, step: 10, value: 300});
  const shakeDuration = h('input', {type: 'number', id: 'shake-duration', min: 5, max: 600, step: 5, value: 60});
  const shakeForm = h('form', {id: 'form-shake'},
    h('div', {class: 'row'},
      h('label', {}, '板', shakePlateSel),
      h('label', {}, '转速 rpm（100–1200）', shakeRpm),
      h('label', {}, '时长 s（5–600）', shakeDuration)),
    h('p', {class: 'muted', style: {'font-size': '10px'}}, '原位示意振荡；期间该板的液体操作与扫描会被拒绝。'),
    h('button', {type: 'submit', class: 'primary'}, '提交摇床'));
  shakeForm.onsubmit = event => {
    event.preventDefault();
    if (!shakePlateSel.value) return;
    submit('plate.shake', {plate_id: shakePlateSel.value,
      speed_rpm: Number(shakeRpm.value), duration_sim_s: Number(shakeDuration.value)});
  };

  const envTemp = h('input', {type: 'number', id: 'env-temp', min: 20, max: 40, step: 0.1, placeholder: '目标值'});
  const envCo2 = h('input', {type: 'number', id: 'env-co2', min: 0, max: 10, step: 0.1, placeholder: '目标值'});
  const envHumidity = h('input', {type: 'number', id: 'env-humidity', min: 30, max: 99, step: 1, placeholder: '目标值'});
  const envForm = h('form', {id: 'form-env'},
    h('div', {class: 'row'},
      h('label', {}, '温度 °C（20–40）', envTemp),
      h('label', {}, 'CO₂ %（0–10）', envCo2),
      h('label', {}, '湿度 %RH（30–99）', envHumidity)),
    h('p', {class: 'muted', style: {'font-size': '10px'}}, '立即提交目标（受理即成功）；观测值按一阶惯性逐步趋近。'),
    h('button', {type: 'submit', class: 'primary'}, '提交环境目标'));
  envForm.onsubmit = event => {
    event.preventDefault();
    const args = {chamber_id: 'chamber-01'};
    for (const [input, key] of [[envTemp, 'temperature_c'], [envCo2, 'co2_pct'], [envHumidity, 'humidity_pct']]) {
      if (input.value !== '') args[key] = Number(input.value);
    }
    if (Object.keys(args).length < 2) { message('环境设定至少填写一项', true); return; }
    submit('environment.set_targets', args);
  };

  const messageEl = h('p', {role: 'status', 'aria-live': 'polite', style: {margin: '6px 0'}});
  const clockHint = h('p', {class: 'muted'});
  const actionsList = h('div', {class: 'action-list', 'aria-label': '动作状态'});
  root.append(
    clockHint,
    h('fieldset', {}, h('legend', {}, '扫描成像（合成图像）'), scanForm),
    h('fieldset', {}, h('legend', {}, '整排加液（排枪 6 通道，演示配置）'), addForm),
    h('fieldset', {}, h('legend', {}, '整排换液'), exchangeForm),
    h('fieldset', {}, h('legend', {}, '摇床'), shakeForm),
    h('fieldset', {}, h('legend', {}, '腔室环境'), envForm),
    messageEl, actionsList,
  );
  const forms = [scanForm, addForm, exchangeForm, shakeForm, envForm];

  const message = (text, bad = false) => { msg = {text, bad}; paintMessage(); };
  const paintMessage = () => {
    messageEl.textContent = msg.text;
    messageEl.style.color = msg.bad ? '#a33' : '';
  };

  function submit(capability, args) {
    return ctx.api.submitAction(ctx.getState().experimentId, capability, args, {idempotencyKey: uid()})
      .then(response => {
        const actionId = response?.action_id || response?.id || null;
        if (actionId) tracked.add(actionId);
        message(`已提交：${capabilityLabel(capability)}${actionId ? `（${actionId}）` : ''}`);
      })
      .catch(error => {
        message(`提交失败：${error.code} ${error.message}`, true);
        ctx.showError(`${capabilityLabel(capability)}：${error.message}`);
      });
  }

  // ----- option list helpers (update in place, keep the operator's pick) -----
  function syncOptions(select, options, {keepSelection = true} = {}) {
    const previous = keepSelection ? select.value : null;
    const values = options.map(o => o.value);
    if (select.dataset.values === values.join('|')) {
      options.forEach((option, index) => {
        if (select.options[index].textContent !== option.label) select.options[index].textContent = option.label;
      });
      ensureValue(select, previous, values); return;
    }
    select.replaceChildren(...options.map(o => h('option', {value: o.value}, o.label)));
    select.dataset.values = values.join('|');
    ensureValue(select, previous, values);
  }
  function ensureValue(select, preferred, values) {
    if (preferred && values.includes(preferred)) { select.value = preferred; return; }
    if (!values.includes(select.value) && values.length) select.value = values[0];
  }

  function syncRowForm(parts, state) {
    const plates = state.plates || [];
    const selection = ctx.getSelection();
    syncOptions(parts.plateSel, plates.map(p => ({value: p.plate_id, label: p.plate_id})));
    let plateId = parts.plateSel.value;
    if (selection?.plate_id && plates.some(p => p.plate_id === selection.plate_id)) {
      plateId = selection.plate_id;
      parts.plateSel.value = plateId;
    }
    const plate = plates.find(p => p.plate_id === plateId);
    const rows = plate ? [...new Set(plate.wells.map(w => rowOfWell(w.well_id)))].sort() : [];
    syncOptions(parts.rowSel, rows.map(r => ({value: r, label: `${r} 排`})));
    if (selection?.well_id && selection.plate_id === plateId && rows.includes(rowOfWell(selection.well_id))) {
      parts.rowSel.value = rowOfWell(selection.well_id);
    }
    const rowId = parts.rowSel.value;
    parts.scope.textContent = plateId && rowId
      ? `作用范围：${rowScopeLabel(plateId, PLATE_LAYOUT_24, rowId)}（整排 6 通道同时吸排）`
      : '作用范围：—（请选择板与排）';
    const submitBtn = parts.wrap.closest('form')?.querySelector('button[type=submit]');
    if (submitBtn) submitBtn.disabled = ctx.isReplay() || !plateId || !rowId || Boolean(plate?.shake?.active);
  }

  function syncScanForm(state) {
    const plates = state.plates || [];
    syncOptions(scanPlateSel, plates.map(p => ({value: p.plate_id, label: p.plate_id})));
    const selection = ctx.getSelection();
    const selectionKey = JSON.stringify(selection);
    const selectionChanged = selectionKey !== scanSelectionKey;
    scanSelectionKey = selectionKey;
    if (selectionChanged && plates.some(p => p.plate_id === selection?.plate_id)) {
      scanPlateSel.value = selection.plate_id;
      scanPlateBuiltFor = null;
    }
    const plateId = scanPlateSel.value;
    const plate = plates.find(p => p.plate_id === plateId);
    if (!plate) { scanGrid.replaceChildren(); scanSubmit.disabled = true; return; }
    // Rebuild the checkbox grid only when the plate changes; per-well state
    // lives in scanWells so updates never reset the operator's ticks.
    if (scanPlateBuiltFor !== plateId) {
      scanPlateBuiltFor = plateId;
      scanWells.clear();
      scanGrid.replaceChildren(...plate.wells.map(well => {
        const selectedWell = selectionChanged && selection?.plate_id === plateId && selection?.well_id === well.well_id;
        if (selectedWell) scanWells.add(well.well_id);
        const box = h('input', {type: 'checkbox', checked: selectedWell, onchange: e => {
          if (e.target.checked) scanWells.add(well.well_id); else scanWells.delete(well.well_id);
          scanCount.textContent = `扫描目标：${plateId} · ${[...scanWells].join('、') || '未选孔'}（${scanWells.size} 孔）`;
          scanSubmit.disabled = ctx.isReplay() || !scanWells.size || Boolean(plate.shake?.active);
        }});
        return h('label', {class: 'inline'}, box, well.well_id);
      }));
    }
    scanCount.textContent = `扫描目标：${plateId} · ${[...scanWells].join('、') || '未选孔'}（${scanWells.size} 孔）`;
    scanSubmit.disabled = ctx.isReplay() || !scanWells.size || Boolean(plate.shake?.active);
  }

  function syncInventoryInputs(state) {
    syncOptions(addReservoir, (state.reservoirs || []).map(r =>
      ({value: r.id, label: `${r.id}（余 ${Math.round(r.remaining_ul)} µL）`})));
    syncOptions(exchangeReservoir, (state.reservoirs || []).map(r =>
      ({value: r.id, label: `${r.id}（余 ${Math.round(r.remaining_ul)} µL）`})));
    syncOptions(shakePlateSel, (state.plates || []).map(p => ({value: p.plate_id, label: p.plate_id})));
  }

  function renderActions(state) {
    const now = state.clock?.sim_time_s ?? state.experiment?.sim_time_s ?? 0;
    const allActions = state.actions?.values ? [...state.actions.values()] : [];
    const ordered = allActions
      .filter(a => tracked.has(a.action_id) || (!TERMINAL_STATUSES.has(a.status) && a.status))
      .sort((a, b) => (b.accept_seq ?? 0) - (a.accept_seq ?? 0))
      .slice(0, 8);
    const items = ordered.map(action => {
      const stage = state.head?.action_id === action.action_id ? state.head.stage : null;
      const chips = h('div', {class: 'stagechips'}, (action.stages || []).map((s, i) =>
        h('span', {class: i < (stage?.index ?? action.current_stage_index ?? -1) ? 'done'
          : i === (stage?.index ?? action.current_stage_index ?? -1) ? 'now' : ''}, stageLabel(s.stage))));
      const summary = action.summary;
      const effects = [];
      if (summary) {
        const wells = Object.entries(summary.wells || {});
        if (wells.length) effects.push(`逐孔：${wells.map(([w, d]) =>
          `${w} ${d.removed_ul ? '−' + Math.round(d.removed_ul) : ''}${d.added_ul ? '+' + Math.round(d.added_ul) : ''}µL`).join('，')}`);
        if (summary.reservoir_delta_ul) effects.push(`储液 ${fmtNum(summary.reservoir_delta_ul, 0)} µL`);
        if (summary.waste_delta_ul) effects.push(`废液 +${fmtNum(summary.waste_delta_ul, 0)} µL`);
        if (summary.tips_used) effects.push(`吸头 −${summary.tips_used}`);
      }
      return h('div', {class: 'action-item'},
        h('div', {class: 'head'},
          h('b', {}, capabilityLabel(action.capability)),
          h('span', {class: `chip ${ACTION_STATUS_CLASS[action.status] || ''}`}, ACTION_STATUS_LABELS[action.status] || action.status),
          action.partial ? h('span', {class: 'chip warn'}, '部分效果') : null,
          action.reason && TERMINAL_STATUSES.has(action.status) ? h('span', {class: 'muted'}, action.reason) : null,
          h('span', {class: 'muted', style: {'margin-left': 'auto', 'font-size': '10px'}}, action.action_id),
          !TERMINAL_STATUSES.has(action.status) && !ctx.isReplay()
            ? h('button', {type: 'button', onclick: () => ctx.api.cancelAction(state.experimentId, action.action_id)
                .then(() => message(`已请求取消 ${action.action_id}`))
                .catch(error => message(`取消失败：${error.message}`, true))}, '取消')
            : null,
        ),
        stage ? h('div', {},
          `${stageLabel(stage.stage)}（${fmtNum(stage.started_at_sim_s, 0)} s 起，${fmtNum(stage.duration_sim_s, 0)} s）`,
          h('div', {class: 'progress'}, h('i', {style: {width: `${(stageProgress(stage, now) * 100).toFixed(0)}%`}}))) : null,
        (action.stages || []).length ? chips : null,
        effects.length ? h('div', {class: 'effects'}, effects.join(' · ')) : null,
      );
    });
    actionsList.replaceChildren(...(items.length ? items : [h('p', {class: 'muted'}, '暂无已提交动作')]));
  }

  function render(state) {
    clockHint.hidden = ctx.isReplay() || state.clock?.clock_mode !== 'lockstep' || state.run?.status === 'active';
    clockHint.textContent = '当前为步进模式：提交后需单步推进；切换 realtime 可连续执行并观看动画。“推进至空闲”会直接完成动作。';
    syncScanForm(state);
    syncRowForm(addParts, state);
    syncRowForm(exchangeParts, state);
    syncInventoryInputs(state);
    renderActions(state);
    for (const form of forms) {
      if (ctx.isReplay()) {
        for (const input of form.querySelectorAll('input,select,button')) input.disabled = true;
        form.setAttribute('aria-disabled', 'true');
      } else {
        form.removeAttribute('aria-disabled');
        for (const input of form.querySelectorAll('input,select')) input.disabled = false;
      }
    }
  }

  return {render};
}
