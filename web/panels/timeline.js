// Bottom pane: action stage bar (current head stage + progress + cancel) and
// the filterable device event timeline. Clicking an observation.created event
// opens that observation in the camera tab; in replay, any event click scrubs
// to its seq.
import {h, fmtNum, capabilityLabel, stageLabel, eventLabel, eventDetail, eventFilterOf,
  ACTION_STATUS_LABELS, ACTION_STATUS_CLASS, TERMINAL_STATUSES} from './ui.js';
import {stageProgress} from '../api/scene-adapter.js';

export function mountTimeline(root, ctx) {
  const actionBar = root.querySelector('#action-bar');
  const listEl = root.querySelector('#timeline-list');
  const filterEl = root.querySelector('#timeline-filter');
  let filter = 'all';
  filterEl.addEventListener('change', () => { filter = filterEl.value; render(ctx.getState()); });

  function renderActionBar(state) {
    const nodes = [];
    const now = state.clock?.sim_time_s ?? state.experiment?.sim_time_s ?? 0;
    const head = state.head;
    if (head) {
      const action = state.actions?.get ? state.actions.get(head.action_id) : null;
      const progress = stageProgress(head.stage, now);
      nodes.push(h('div', {class: 'card'},
        h('div', {class: 'row'},
          h('b', {}, action ? capabilityLabel(action.capability) : head.action_id),
          h('span', {class: 'chip ok'}, '执行中'),
          h('span', {}, `${stageLabel(head.stage.stage)} · ${fmtNum(head.stage.started_at_sim_s, 0)} s + ${fmtNum(head.stage.duration_sim_s, 0)} s`),
          h('span', {class: 'muted'}, head.action_id),
          !ctx.isReplay() ? h('button', {type: 'button', style: {'margin-left': 'auto'},
            onclick: () => ctx.api.cancelAction(state.experimentId, head.action_id)
              .then(() => ctx.setStatus(`已请求取消 ${head.action_id}`))
              .catch(error => ctx.showError(`取消失败：${error.message}`))}, '取消') : null,
        ),
        h('div', {class: 'progress'}, h('i', {style: {width: `${(progress * 100).toFixed(0)}%`}})),
      ));
    } else {
      nodes.push(h('div', {class: 'card'}, h('span', {class: 'muted'}, '共享头空闲')));
    }
    const others = (state.actions?.values ? [...state.actions.values()] : [])
      .filter(a => a.action_id !== head?.action_id && !TERMINAL_STATUSES.has(a.status)).slice(0, 6);
    for (const action of others) {
      nodes.push(h('div', {class: 'card', style: {marginTop: '6px'}},
        h('div', {class: 'row'},
          h('b', {}, capabilityLabel(action.capability)),
          h('span', {class: `chip ${ACTION_STATUS_CLASS[action.status] || ''}`}, ACTION_STATUS_LABELS[action.status] || action.status),
          h('span', {class: 'muted'}, action.action_id),
          action.capability === 'plate.shake' ? h('span', {class: 'muted'}, `${fmtNum(action.arguments?.speed_rpm, 0)} rpm`) : null,
          !ctx.isReplay() ? h('button', {type: 'button', style: {'margin-left': 'auto'},
            onclick: () => ctx.api.cancelAction(state.experimentId, action.action_id)
              .catch(error => ctx.showError(`取消失败：${error.message}`))}, '取消') : null,
        )));
    }
    const shaking = (state.plates || []).filter(p => p.shake?.active)
      .map(p => h('div', {class: 'card', style: {marginTop: '6px'}},
        h('span', {}, `${p.plate_id} 振荡中 · ${fmtNum(p.shake.speed_rpm, 0)} rpm · ${fmtNum(p.shake.duration_sim_s, 0)} s`)));
    actionBar.replaceChildren(...nodes, ...shaking);
  }

  function renderList(state) {
    const events = [...(state.events || [])].reverse();
    const rows = [];
    for (const ev of events) {
      if (filter !== 'all' && eventFilterOf(ev.type) !== filter) continue;
      const isObservation = ev.type === 'observation.created';
      rows.push(h('li', {
        role: isObservation ? 'button' : null, tabindex: isObservation ? 0 : null,
        onclick: () => {
          const observationId = ev.observation_id || ev.payload?.observation_id;
          if (isObservation && observationId) ctx.openObservation(observationId);
          else if (ctx.isReplay()) ctx.scrubTo(ev.seq);
        },
        onkeydown: isObservation ? e => {if (e.key === 'Enter' || e.key === ' ') {e.preventDefault();
          const observationId = ev.observation_id || ev.payload?.observation_id;
          if (observationId) ctx.openObservation(observationId);}} : null,
      },
      h('span', {class: 'seq'}, `#${ev.seq}`),
      h('span', {class: 't'}, `${fmtNum(ev.sim_time_s, 0)} s`),
      h('span', {class: 'type'}, eventLabel(ev.type)),
      h('span', {class: 'detail'}, eventDetail(ev)),
      ));
      if (rows.length >= 200) break;
    }
    listEl.replaceChildren(...(rows.length ? rows : [h('li', {}, h('span', {class: 'muted'}, '（无事件）'))]));
  }

  let lastKey = '';
  function render(state) {
    const now = state.clock?.sim_time_s ?? 0;
    const key = JSON.stringify([
      filter, state.head?.action_id, state.head?.stage?.stage, Math.round(stageProgress(state.head?.stage, now) * 20),
      (state.actions?.values ? [...state.actions.values()] : []).map(a => [a.action_id, a.status]).sort(),
      state.experimentId, state.events?.at(-1)?.seq, (state.events || []).length, Math.round(now),
      (state.plates || []).filter(p => p.shake?.active).map(p => p.plate_id), ctx.isReplay(), replaySeqOf(state),
    ]);
    if (key === lastKey) return;
    lastKey = key;
    renderActionBar(state);
    renderList(state);
  }

  return {render};
}

function replaySeqOf(state) {
  return state.event_seq ?? null;
}
