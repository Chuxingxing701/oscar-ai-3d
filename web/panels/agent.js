// Agent tab: run lifecycle (start scripted/llm, pause/resume/cancel, manual
// hold/unhold), run status, decision log streamed from the Agent session
// (gateway SSE, its own seq — never compared with device seq), evidence refs
// clickable into the camera tab, and the final report.
// 503 agent_unavailable only disables this tab; manual operation stays usable.
import {h, fmtSimTime, capabilityLabel} from './ui.js';

const SSE_EVENT_NAMES = ['agent', 'message', 'decision', 'observation', 'action', 'report', 'error', 'status', 'finish', 'run', 'log'];
const BASIS_SET = new Set(['scripted', 'llm', 'oracle_demo', 'device_estimate', 'simulated', 'scheduled_policy', 'operator']);

export function mountAgent(root, ctx) {
  let entries = [];
  let agentUnavailable = false;
  let source = null;
  let activeRunId = null;
  let logRevision = 0, renderedLogRevision = -1, lastReport = null, lastStatusKey = '';

  // Persistent skeleton: live renders update contents in place so the goal
  // input never loses focus while the store streams.
  const statusBox = h('div', {class: 'agent-status'});
  const controlsRow = h('div', {class: 'row'});
  const modeSel = h('select', {id: 'agent-mode'},
    h('option', {value: 'scripted'}, 'scripted（确定性剧本）'),
    h('option', {value: 'llm'}, 'llm（自然语言目标）'));
  const goalInput = h('input', {type: 'text', id: 'agent-goal', style: {width: '200px'}, placeholder: '如：维持 A 排培养液'});
  const startSubmit = h('button', {type: 'submit', class: 'primary'}, '启动 Agent run');
  const startHint = h('span', {class: 'muted'});
  const policyHint = h('p', {class: 'muted', id: 'agent-policy-hint'});
  const startForm = h('form', {}, h('div', {class: 'row'},
    h('label', {}, '模式', modeSel), h('label', {}, '任务目标（goal）', goalInput)), policyHint, startSubmit, ' ', startHint);
  modeSel.addEventListener('change', () => render(ctx.getState()));
  const unavailableBox = h('div', {class: 'card', hidden: true, style: {borderColor: '#d9a02b'}});
  const hintEl = h('p', {class: 'muted', style: {'font-size': '10px'}}, '');
  const logList = h('ul', {class: 'decision-log', 'aria-live': 'polite', 'aria-label': '决策日志'});
  const reportBox = h('div', {class: 'card', hidden: true});
  root.replaceChildren(
    statusBox, controlsRow,
    h('fieldset', {}, h('legend', {}, '启动'), startForm),
    unavailableBox,
    h('fieldset', {}, h('legend', {}, '决策日志（Agent 会话流，独立 seq）'), hintEl, logList),
    reportBox,
  );

  startForm.onsubmit = async event => {
    event.preventDefault();
    agentUnavailable = false;
    try {
      const state = ctx.getState();
      if (state.clock?.clock_mode !== 'lockstep' || state.clock?.paused) {
        ctx.showError('Agent 目前只支持已恢复的 lockstep 时钟；请先在顶栏切换并恢复 Runtime。');
        return;
      }
      const response = await ctx.api.startAgentRun({experiment_id: state.experimentId,
        mode: modeSel.value, goal: modeSel.value === 'llm' ? goalInput.value || undefined : undefined});
      entries = []; logRevision++;
      const runId = response?.run?.run_id || response?.run_id || null;
      if (runId) {activeRunId = runId; connectEvents(runId);}
      ctx.setStatus(`Agent run 已启动：${runId || '（未知 id）'}`);
      ctx.refreshNow();
    } catch (error) {
      if (error.code === 'agent_unavailable' || error.status === 503) {
        agentUnavailable = true;
        ctx.setStatus('Agent 不可用（503），人工操作不受影响');
      } else {
        ctx.showError(`启动 Agent run 失败：${error.message}`);
      }
      render(ctx.getState());
    }
  };

  const logHint = text => { hintEl.textContent = text; };

  function connectEvents(runId) {
    if (source) { try { source.close(); } catch { /* noop */ } source = null; }
    if (!runId || typeof EventSource === 'undefined') return;
    source = new EventSource(ctx.api.agentEventsUrl(runId));
    for (const name of SSE_EVENT_NAMES) {
      source.addEventListener(name, event => {
        // Native transport errors have no data; they are not Agent log entries.
        if (typeof event.data !== 'string') return;
        let entry;
        try { entry = JSON.parse(event.data); } catch { entry = {type: name, text: event.data}; }
        // Agent session events are {seq, run_id, type, payload}; flatten the payload for display.
        if (entry && entry.payload && typeof entry.payload === 'object') entry = {...entry.payload, ...entry, payload: undefined};
        if (entry && entry.seq != null && entries.some(e => e.seq === entry.seq)) return;
        entries.push({...entry, type: entry?.type || name});
        logRevision++;
        if (entries.length > 300) entries = entries.slice(-300);
        renderLog();
        renderReport();
      });
    }
    source.onopen = () => logHint('Agent 事件流已连接');
    source.onerror = () => logHint('Agent 事件流断开，EventSource 正以 Last-Event-ID 自动重连…');
  }

  function entryNode(entry) {
    const basis = BASIS_SET.has(entry.basis) ? entry.basis
      : BASIS_SET.has(entry.decision_basis) ? entry.decision_basis : null;
    const meta = [];
    if (Number.isFinite(entry.seq)) meta.push(`seq ${entry.seq}`);
    if (Number.isFinite(entry.sim_time_s)) meta.push(fmtSimTime(entry.sim_time_s));
    if (entry.action_id) meta.push(entry.action_id);
    if (entry.observation_id) meta.push(entry.observation_id);
    const refs = []
      .concat(entry.evidence_refs || [], entry.observation_ids || [],
        entry.evidence?.observation_ids || [])
      .filter(ref => typeof ref === 'string');
    const str = v => (typeof v === 'string' ? v : '');
    const statusText = entry.status ? `状态 ${entry.status}${entry.partial ? '（部分效果）' : ''}${entry.error?.code ? ` · ${entry.error.code}` : ''}` : '';
    const text = str(entry.summary) || str(entry.message) || str(entry.reason) || str(entry.description) || str(entry.code) || statusText
      || entry.text || (entry.tool_call ? `${entry.tool_call.name || ''} ${JSON.stringify(entry.tool_call.arguments || {})}` : '')
      || (entry.type ? '' : JSON.stringify(entry).slice(0, 140));
    return h('li', {class: entry.level === 'error' || entry.type === 'error' ? 'err' : ''},
      h('div', {class: 'meta'},
        h('b', {}, entry.type || 'entry'),
        basis ? h('span', {class: `basis ${basis}`}, basis) : null,
        ...meta.map(m => h('span', {}, m)),
      ),
      text ? h('div', {}, text) : null,
      entry.capability ? h('div', {class: 'muted'}, `动作：${capabilityLabel(entry.capability)}`) : null,
      refs.length ? h('div', {class: 'muted'}, '证据：',
        refs.map((ref, i) => [i ? ' ' : null, h('a', {class: 'obsref', role: 'button', tabindex: 0,
          onclick: () => ctx.openObservation(ref),
          onkeydown: e => {if (e.key === 'Enter' || e.key === ' ') {e.preventDefault(); ctx.openObservation(ref);}}}, ref)])) : null,
    );
  }

  function renderLog() {
    if (renderedLogRevision === logRevision) return;
    renderedLogRevision = logRevision;
    logList.replaceChildren(...entries.slice(-80).reverse().map(entryNode));
  }

  function renderReport() {
    const report = [...entries].reverse().find(e => /report|finish/.test(String(e.type || '')));
    if (report === lastReport) return;
    lastReport = report;
    if (!report) { reportBox.hidden = true; return; }
    reportBox.hidden = false;
    reportBox.replaceChildren(h('h3', {}, '报告'),
      h('div', {}, report.summary || report.message || report.text || h('pre', {style: {'white-space': 'pre-wrap', 'font-size': '11px'}},
        JSON.stringify(report, null, 2))));
  }

  function renderStatus(state) {
    const run = state.run;
    if (!run) {
      statusBox.replaceChildren(h('p', {class: 'muted'}, '当前实验没有活跃 run（人工操作模式）。'));
      return;
    }
    const statusLabels = {active: '运行中', paused: '已暂停', on_hold: '人工挂起', ended: '已结束'};
    statusBox.replaceChildren(h('div', {},
      h('div', {class: 'row'},
        h('b', {}, run.run_id),
        h('span', {class: `chip ${run.status === 'active' ? 'ok' : run.status === 'ended' ? '' : 'warn'}`}, statusLabels[run.status] || run.status),
        h('span', {class: 'muted'}, `模式 ${run.mode}`),
        run.reason ? h('span', {class: 'muted'}, `原因 ${run.reason}`) : null,
        run.determinism_broken ? h('span', {class: 'chip bad'}, '确定性已破坏') : null,
      ),
      h('p', {class: 'muted', style: {'font-size': '11px'}},
        `动作预算 ${run.budget?.actions_used ?? '?'}/${run.budget?.max_actions ?? '?'} · 创建于 ${fmtSimTime(run.created_at_sim_s)} · ${run.clock_mode}`),
    ));
  }

  function renderControls(state) {
    const run = state.run;
    const disabled = ctx.isReplay() || !run || run.status === 'ended';
    const control = (action, label) => h('button', {type: 'button', disabled,
      onclick: () => ctx.api.agentRunControl(run.run_id, action)
        .then(() => ctx.refreshNow())
        .catch(error => ctx.showError(`Agent 控制（${label}）失败：${error.message}`))}, label);
    const holdLabel = run?.status === 'on_hold' ? '解除人工挂起（unhold）' : '人工挂起（hold）';
    controlsRow.replaceChildren(
      control('pause', '暂停'), control('resume', '恢复'), control('cancel', '取消'),
      h('button', {type: 'button', disabled, onclick: () =>
          ctx.api.control(state.experimentId, {hold: {run_id: run.run_id, on: run.status !== 'on_hold'}})
            .then(() => ctx.refreshNow())
            .catch(error => ctx.showError(`hold 切换失败：${error.message}`))}, holdLabel));
  }

  function render(state) {
    const statusKey = JSON.stringify([state.run, ctx.isReplay()]);
    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey; renderStatus(state); renderControls(state);
    }
    unavailableBox.hidden = !agentUnavailable;
    if (agentUnavailable) {
      unavailableBox.replaceChildren(h('p', {},
        h('b', {}, 'Agent 不可用'), '（网关返回 503 agent_unavailable）。人工操作不受影响，可继续在「操作」页使用设备。'));
    }
    const unsupportedClock = state.clock?.clock_mode !== 'lockstep';
    const active = Boolean(state.run && state.run.status !== 'ended');
    startSubmit.disabled = ctx.isReplay() || active || unsupportedClock || Boolean(state.clock?.paused);
    startHint.textContent = ctx.isReplay() ? '只读回放' : active ? '（已有活跃 run；先取消或结束）'
      : unsupportedClock ? '请先在顶栏切换到 lockstep；当前 Agent 不支持 realtime。'
      : state.clock?.paused ? '请先恢复 Runtime。' : '';
    goalInput.disabled = ctx.isReplay() || modeSel.value === 'scripted';
    policyHint.textContent = modeSel.value === 'scripted'
      ? `按当前场景 ${state.experiment?.scenario_id || '—'} 执行已实现的确定性策略；不解析自由文本目标。`
      : 'LLM 适配器尚未接入；此模式会暂停为 model_unavailable，不会自动改用确定性策略。';
    const runId = state.run?.run_id;
    if (runId && runId !== activeRunId) { activeRunId = runId; entries = []; logRevision++; connectEvents(runId); }
    else if (runId && !source) connectEvents(runId);
    else if (!runId && activeRunId) {
      if (source) {try { source.close(); } catch { /* noop */ }}
      source = null; activeRunId = null; entries = []; logRevision++;
    }
    renderLog();
    renderReport();
  }

  render(ctx.getState());

  return {
    render,
    dispose() { if (source) { try { source.close(); } catch { /* noop */ } source = null; } },
  };
}
