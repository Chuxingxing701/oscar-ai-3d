// Workbench entry: wires the Runtime API, the SSE feed + store, the 3D scene
// and the panels. Plain ES modules, no framework, no build step.
import {createApi, ApiError} from './api/http.js';
import {createEventFeed, loadAllEvents} from './api/stream.js';
import {initialState, replayAt} from './api/store.js';
import {projectDisplay} from './api/scene-adapter.js';
import {mountScene} from './scene/index.js';
import {mountResources} from './panels/resources.js';
import {mountOperations} from './panels/operations.js';
import {mountCamera} from './panels/camera.js';
import {mountEnvironment} from './panels/environment.js';
import {mountAgent} from './panels/agent.js';
import {mountTimeline} from './panels/timeline.js';
import {mountHistory} from './panels/history.js';
import {h, fmtSimTime} from './panels/ui.js';
import {rowWellIds, PLATE_LAYOUT_24, rowOfWell} from './api/ids.js';

const $ = selector => document.querySelector(selector);
const STATUS = {active: '进行中', archiving: '归档中', archived: '已归档'};

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------
const bus = {
  map: new Map(),
  on(topic, fn) { if (!this.map.has(topic)) this.map.set(topic, []); this.map.get(topic).push(fn); },
  emit(topic, data) { for (const fn of this.map.get(topic) || []) fn(data); },
};

const api = createApi({
  onUnauthorized: () => { $('#auth-overlay').hidden = false; },
});

let liveState = initialState();
let selection = null;              // {plate_id, well_id?} | null
let scene = null;
let sceneReady = false;
const sceneUpdateErrors = [];
let displayFrozen = false;
let currentExperimentId = null;
let feed = null;
let panels = null;
let replay = null;                 // {snapshot, events, seq, experimentId} | null
let experimentsInfo = {current_id: null, experiments: []};

let statusTimer = 0;
let errorTimer = 0;

function setStatus(text) {
  $('#status-live').textContent = text;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { $('#status-live').textContent = ''; }, 5000);
}
function showError(text) {
  $('#error-live').textContent = text;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { $('#error-live').textContent = ''; }, 7000);
}

const getState = () => (replay ? replayState() : liveState);
const isReplay = () => Boolean(replay);

function replayState() {
  const projection = replayAt(replay.snapshot, replay.events, replay.seq);
  return {
    ...projection,
    experimentId: replay.experimentId,
    clock: {sim_time_s: projection.experiment.sim_time_s, paused: projection.experiment.paused,
      speed: replay.snapshot.experiment?.speed ?? 1, clock_mode: replay.snapshot.experiment?.clock_mode ?? 'lockstep'},
    events: replay.events.filter(e => e.seq <= replay.seq).slice(-400),
    actions: new Map(),
    observations: new Map((projection.replayObservations || []).map(o => [o.observation_id, {observation_id: o.observation_id}])),
    envSamples: projection.envSamples || [],
    envTargets: [],
    archived: null,
  };
}

let selecting = false;   // guard: scene.focus fires onSelect → ctx.select
const ctx = {
  api, bus, getState, isReplay, setStatus, showError,
  getSelection: () => selection,
  select(target) {
    selection = target && target.plate_id ? {plate_id: target.plate_id, well_id: target.well_id || null} : null;
    if (selection && sceneReady && !selecting) {
      selecting = true;
      try { scene.focus(selection); } finally { selecting = false; }
    }
    renderSceneSelection();
    scheduleRender();
  },
  focusScene(target) {
    if (sceneReady && target) scene.focus(target.plate_id ? target : {device_id: 'oscar-01'});
  },
  openTab,
  openObservation(observationId) {
    openTab('camera');
    setMobilePane('camera');
    panels.camera.open(observationId);
  },
  refreshNow() { if (!replay && feed) feed.refresh(); },
  refreshExperiments() { return loadExperiments().then(info => { scheduleRender(); return info; }); },
  scrubTo(seq) { if (replay) { replay.seq = Math.max(0, Math.min(replay.maxSeq, seq)); scheduleRender(); } },
  switchExperiment(id) { return switchExperiment(id); },
  enterReplay(id) { return enterReplay(id); },
  experimentsList: () => experimentsInfo,
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

// Scene and top bar follow every server frame; panel DOM is throttled to
// ~4 renders/s so form typing and clicks are never clobbered by rebuilds.
let panelsDirty = false;
let lastPanelRender = 0;
let panelTimer = 0;
function renderAll() {
  const state = getState();
  updateScene(state);
  renderTopbar(state);
  renderSceneSelection();
  panelsDirty = true;
  flushPanels(state);
}
function flushPanels(state) {
  const now = performance.now();
  if (!panelsDirty) return;
  const elapsed = now - lastPanelRender;
  if (elapsed >= 240) {
    panelsDirty = false;
    lastPanelRender = now;
    for (const panel of Object.values(panels)) panel.render && panel.render(state);
  } else if (!panelTimer) {
    panelTimer = setTimeout(() => { panelTimer = 0; flushPanels(getState()); }, 250 - elapsed);
  }
}

function renderTopbar(state) {
  const experiment = state.experiment;
  $('#exp-id').textContent = state.experimentId || '—';
  const statusEl = $('#exp-status');
  statusEl.textContent = replay ? '只读回放' : (STATUS[experiment?.status] || experiment?.status || '…');
  statusEl.className = `chip ${replay || experiment?.status !== 'active' ? 'warn' : 'ok'}`;
  $('#exp-scenario').textContent = experiment?.scenario_id ? `场景 ${experiment.scenario_id}` : '';
  $('#sim-time').textContent = `${fmtSimTime(state.clock?.sim_time_s)}${state.clock?.paused ? ' ⏸' : ''}`;
  const paused = Boolean(state.clock?.paused);
  $('#btn-pause-runtime').textContent = paused ? '继续 Runtime' : '暂停 Runtime';
  $('#clock-mode').value = state.clock?.clock_mode || 'lockstep';
  $('#clock-speed').value = String(state.clock?.speed ?? 1) || '1';
  const lockstep = (state.clock?.clock_mode || 'lockstep') === 'lockstep';
  $('#btn-step').disabled = replay || !lockstep;
  $('#btn-step-idle').disabled = replay || !lockstep;
  $('#btn-pause-runtime').disabled = replay;
  $('#btn-reset').disabled = replay;
  $('#clock-mode').disabled = replay;
  $('#clock-speed').disabled = replay;
}

function renderSceneSelection() {
  const el = $('#scene-selection');
  if (!selection) { el.textContent = '未选择（点击列表孔位或 3D 板孔）'; return; }
  const row = selection.well_id ? rowOfWell(selection.well_id) : null;
  const wells = row ? rowWellIds(PLATE_LAYOUT_24, row) : [];
  el.textContent = `选中 ${selection.plate_id}${selection.well_id ? ' ' + selection.well_id : ''}` +
    (row ? ` · ${row} 排 → ${wells[0]}–${wells[wells.length - 1]}（整排作用）` : '（整板）');
}

let lastSceneKey = '';
let lastSceneAt = 0;
function updateScene(state) {
  if (!sceneReady || !scene) return;
  const display = projectDisplay(state, state.clock?.sim_time_s);
  // Push a new display snapshot only when something observable changed.
  // Head motion depends on sim time only, so quantise it to 4 Hz: paused or
  // lockstep-idle worlds stop re-rendering entirely (the scene never
  // extrapolates on its own), realtime still moves smoothly.
  const key = JSON.stringify([display.experiment_id, display.paused,
    Math.floor(display.sim_time_s / 0.25), display.plates, display.actions]);
  const now = performance.now();
  if (key === lastSceneKey && now - lastSceneAt < 1000) return; // 1 Hz keep-alive
  lastSceneKey = key;
  lastSceneAt = now;
  try {
    scene.update(display);
  } catch (error) {
    sceneUpdateErrors.push(error.message);
    showError(`场景更新失败：${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Tabs / mobile panes
// ---------------------------------------------------------------------------
const TABS = ['ops', 'camera', 'env', 'agent'];
function openTab(tab) {
  for (const name of TABS) {
    $(`#tab-${name}`).setAttribute('aria-selected', String(name === tab));
    $(`#tab-${name}-panel`).hidden = name !== tab;
  }
}
function setMobilePane(pane) {
  const mapping = {ops: 'right', camera: 'right', env: 'right', agent: 'right'};
  const target = mapping[pane] || pane;
  for (const button of document.querySelectorAll('#mobile-tabs button')) {
    button.classList.toggle('on', button.dataset.pane === pane);
  }
  for (const element of document.querySelectorAll('.pane')) {
    element.classList.toggle('show', element.id === `pane-${target}` || (target === 'right' && element.id === 'right-col'));
  }
  if (target === 'right') openTab(pane);
}

// ---------------------------------------------------------------------------
// Live feed / experiment switching
// ---------------------------------------------------------------------------
function startFeed(experimentId) {
  if (feed) feed.stop();
  currentExperimentId = experimentId;
  feed = createEventFeed({
    fetchSnapshot: () => api.state(experimentId),
    subscribe: afterSeq => new EventSource(`/api/v1/experiments/${experimentId}/events?after_seq=${afterSeq}`),
    onState(state, meta) {
      liveState = state;
      if (meta.kind === 'event' && meta.event?.type === 'observation.created') bus.emit('observation.created', meta.event);
      scheduleRender();
    },
    onStatus(status) {
      const dot = $('#conn-dot');
      const text = $('#conn-text');
      dot.className = `dot ${status}`;
      text.textContent = {connected: 'SSE 已连接', reconnecting: '重连中…', offline: '离线'}[status] || status;
    },
    onArchived(info) {
      $('#archived-text').textContent =
        `实验 ${info.experiment_id || currentExperimentId} 已归档${info.successor_id ? `，新实验 ${info.successor_id}` : ''}。`;
      $('#archived-toast').hidden = false;
      loadExperiments();
    },
  });
  feed.start();
}

async function switchExperiment(experimentId) {
  exitReplay();
  liveState = initialState();
  $('#archived-toast').hidden = true;
  startFeed(experimentId);
  bus.emit('experiment', experimentId);
  setStatus(`已切换到实验 ${experimentId}`);
}

async function loadExperiments() {
  try {
    experimentsInfo = await api.experiments();
    return experimentsInfo;
  } catch (error) {
    if (error.code !== 'unauthenticated') showError(`实验列表加载失败：${error.message}`);
    return experimentsInfo;
  }
}

// ---------------------------------------------------------------------------
// Replay (read-only): archived experiment + events; every write guarded in
// the api layer (readOnly throws before fetch) and disabled in the panels.
// ---------------------------------------------------------------------------
async function enterReplay(experimentId) {
  try {
    setStatus(`加载回放 ${experimentId} …`);
    if (feed) feed.stop();
    const [snapshot, events] = await Promise.all([
      api.state(experimentId),
      loadAllEvents(after => api.eventsPage(experimentId, {afterSeq: after})),
    ]);
    api.setReadOnly(true);
    replay = {snapshot, events, seq: events.length ? events[events.length - 1].seq : snapshot.event_seq || 0,
      maxSeq: events.length ? events[events.length - 1].seq : snapshot.event_seq || 0, experimentId};
    $('#replay-banner').hidden = false;
    const scrubber = $('#replay-seq');
    scrubber.max = String(replay.maxSeq);
    scrubber.value = String(replay.seq);
    $('#replay-controls').hidden = false;
    if (sceneReady && scene) { displayFrozen = false; scene.setDisplayPaused(false); scene.select(null); }
    scheduleRender();
    setStatus(`只读回放 ${experimentId}（${events.length} 个事件）`);
  } catch (error) {
    showError(`进入回放失败：${error.message}`);
    if (currentExperimentId) startFeed(currentExperimentId);
  }
}

function exitReplay() {
  if (!replay) return;
  replay = null;
  api.setReadOnly(false);
  $('#replay-banner').hidden = true;
  $('#replay-controls').hidden = true;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
async function mountSceneModule() {
  const container = $('#scene-stage');
  scene = mountScene(container, {
    onSelect: pick => {
      if (!pick) { selection = null; renderSceneSelection(); scheduleRender(); return; }
      if (pick.plate_id) ctx.select({plate_id: pick.plate_id, well_id: pick.well_id || null});
      else if (pick.resource_id) { setStatus(`3D 拾取：工位 ${pick.resource_id}`); ctx.focusScene({device_id: 'oscar-01'}); }
    },
    onError: error => {
      $('#scene-error').hidden = false;
      $('#scene-error').textContent = `3D 场景加载失败：${error.message}（模型/映射为静态白名单资源）`;
    },
  });
  try {
    await scene.ready;
    sceneReady = true;
    // Read-only diagnostics for browser acceptance; no write path is exposed.
    Object.defineProperty(window, 'oscarScene', {value: Object.freeze({getStatus: () => scene.getStatus(),
      updateErrors: () => [...sceneUpdateErrors]})});
    scene.setView('interior');
    updateScene(getState());
  } catch { /* onError already surfaced */ }
}

// ---------------------------------------------------------------------------
// Top bar wiring
// ---------------------------------------------------------------------------
function control(body, label) {
  if (replay || !currentExperimentId) return Promise.resolve();
  return api.control(currentExperimentId, body)
    .then(response => { feed.refresh(); return response; })
    .catch(error => { showError(`${label}：${error.code} ${error.message}`); throw error; });
}

function wireTopbar() {
  $('#btn-pause-runtime').addEventListener('click', () => {
    const paused = Boolean(getState().clock?.paused);
    control(paused ? {resume: true} : {pause: true}, paused ? '继续' : '暂停');
  });
  $('#btn-step').addEventListener('click', () => control({step: {steps: 1}}, '单步'));
  $('#btn-step-idle').addEventListener('click', () => control({step: {until_idle: true}}, '推进至空闲'));
  $('#btn-reset').addEventListener('click', async () => {
    if (replay || !currentExperimentId) return;
    if (!window.confirm('重置：当前实验将被归档（保留只读历史），未完成动作会以 experiment_reset 终结，并按当前场景与 seed 创建新实验。确定继续？')) return;
    try {
      const oldId = currentExperimentId;
      await control({reset: {}}, '重置');
      let nextId = null;
      for (let i = 0; i < 20 && !nextId; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
        const info = await loadExperiments();
        if (info.current_id && info.current_id !== oldId) nextId = info.current_id;
      }
      if (nextId) await switchExperiment(nextId);
      else feed.refresh();
    } catch { /* surfaced by control() */ }
  });
  $('#btn-freeze').addEventListener('click', () => {
    displayFrozen = !displayFrozen;
    $('#btn-freeze').setAttribute('aria-pressed', String(displayFrozen));
    $('#btn-freeze').classList.toggle('on', displayFrozen);
    if (sceneReady) scene.setDisplayPaused(displayFrozen);
    setStatus(displayFrozen
      ? '画面已冻结（仅显示；Runtime 继续运行，数据继续更新）'
      : '画面解冻：显示最新状态');
  });
  $('#clock-mode').addEventListener('change', e => control({clock_mode: e.target.value}, '时钟模式'));
  $('#clock-speed').addEventListener('change', e => control({speed: Number(e.target.value)}, '倍率'));
  $('#exit-replay').addEventListener('click', async () => {
    exitReplay();
    const info = await loadExperiments();
    if (info.current_id) await switchExperiment(info.current_id);
    else if (currentExperimentId) startFeed(currentExperimentId);
    scheduleRender();
  });
  $('#archived-switch').addEventListener('click', async () => {
    const info = await loadExperiments();
    if (info.current_id) await switchExperiment(info.current_id);
    $('#archived-toast').hidden = true;
  });
  $('#auth-retry').addEventListener('click', () => location.reload());
  $('#replay-seq').addEventListener('input', e => { if (replay) { replay.seq = Number(e.target.value); scheduleRender(); } });
}

function wireTabs() {
  for (const name of TABS) $(`#tab-${name}`).addEventListener('click', () => openTab(name));
  for (const button of document.querySelectorAll('#mobile-tabs button')) {
    button.addEventListener('click', () => setMobilePane(button.dataset.pane));
  }
  for (const button of ['#view-interior', '#view-exterior', '#view-deck']) {
    $(button).addEventListener('click', () => {
      if (!sceneReady) return;
      const id = button.slice(1);
      if (id === 'view-interior') scene.setView('interior');
      if (id === 'view-exterior') scene.setView('exterior');
      if (id === 'view-deck') { scene.setView('interior'); scene.resetView(true); }
      for (const other of ['#view-interior', '#view-exterior', '#view-deck']) {
        $(other).classList.toggle('on', other === button);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  panels = {
    resources: mountResources(document, ctx),
    operations: mountOperations($('#tab-ops-panel'), ctx),
    camera: mountCamera($('#tab-camera-panel'), ctx),
    environment: mountEnvironment($('#tab-env-panel'), ctx),
    agent: mountAgent($('#tab-agent-panel'), ctx),
    timeline: mountTimeline($('#pane-timeline'), ctx),
    history: mountHistory(ctx),
  };
  wireTopbar();
  wireTabs();
  openTab('ops');
  setMobilePane('scene');   // default pane; desktop layout ignores the class

  try {
    await api.session();
  } catch { /* overlay shown by the 401 handler */ }

  const info = await loadExperiments();
  if (!info.current_id) {
    setStatus('当前没有活跃实验；可通过「重置」按场景创建新实验。');
    renderAll();
  } else {
    startFeed(info.current_id);
  }
  mountSceneModule();
}

boot();
