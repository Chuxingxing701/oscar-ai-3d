// Agent tab: long-lived culture SESSIONS (realtime product path) plus the
// legacy scripted/lockstep run lifecycle. The session area is a continuous
// conversation with the device-aware agent: task/goal with plan progress,
// wait reason + next wake, evidence refs, memory checkpoint and clearly
// separated controls — pause Agent ≠ cancel task ≠ pause Runtime.
// Closing the browser stops nothing; switching sessions closes the old SSE
// first so late events never leak across sessions (no message cross-stream).
// 503 agent_unavailable only disables this tab; manual operation stays usable.
import {h, fmtSimTime, capabilityLabel} from './ui.js';

const SSE_EVENT_NAMES = ['session', 'message', 'decision', 'observation', 'action', 'report', 'error', 'status', 'finish', 'run', 'log', 'agent'];
const BASIS_SET = new Set(['scripted', 'llm', 'oracle_demo', 'device_estimate', 'simulated', 'scheduled_policy', 'operator']);
const LOOP_LABELS = {idle: '空闲', thinking: '思考中', executing: '执行动作', waiting_device: '等待设备',
  waiting_condition: '等待条件', needs_input: '需要输入', paused: '已暂停', recovering: '恢复中',
  unavailable: '模型不可用', unsupported_clock_mode: '时钟模式不支持'};
const TASK_LABELS = {queued: '排队中', draft: '草稿', ready: '就绪', running: '运行中', waiting_device: '等待设备',
  waiting_condition: '等待条件', needs_input: '需要输入', paused: '已暂停', completed: '已完成',
  failed: '失败', cancelled: '已取消'};

/** Default structured goal offered for one-click task creation (explicit demo protocol). */
function defaultGoalSpec() {
  return {
    description: '维持 plate-01 A 排各孔培养液 ≥ 330 µL：定期扫描评估，低于阈值整排补液并复查',
    scope: {plates: ['plate-01'], rows: ['A']},
    metrics: [{metric: 'medium_volume_ul', op: '>=', value: 330, source: 'observation', row_id: 'A'}],
    allowed_operations: ['imaging.scan', 'media.add', 'media.exchange'],
    monitoring: {interval_sim_s: 21_600},
    deadline_sim_s: 93_600,
    success: {description: '监测窗口结束且每次检查不低于阈值（维护后复查通过）'},
    stop: {description: '预算耗尽或用户取消', max_corrections: 8},
  };
}

export function mountAgent(root, ctx) {
  // ---- state ----
  let sessions = [];
  let activeSession = null;          // session row
  let sessionDetail = null;          // messages/tasks/plan/wakes
  let sessionStatus = null;          // aggregated status
  let entries = [];                  // session event log (independent seq)
  let source = null;                 // session SSE
  let agentUnavailable = false;
  let logRevision = 0, renderedLogRevision = -1;
  let statusRevision = 0, renderedStatusRevision = -1;
  let lastReport = null;
  let selectionGen = 0;              // monotonic selection generation (stale HTTP guard)
  // R06 same-session ordering: every refreshSessionDetail() call takes the
  // next number; appliedRefresh records the last refresh actually painted.
  let refreshSeq = 0;
  let appliedRefresh = {sessionId: null, seq: 0, messageSeq: -1};

  // legacy run area state
  let runEntries = [];
  let runSource = null;
  let activeRunId = null;

  const $ = sel => root.querySelector(sel);

  // ---- skeleton (stable: inputs never lose focus on stream updates) ----
  const sessionListBox = h('div', {class: 'row', style: {'flex-wrap': 'wrap'}});
  const newSessionBtn = h('button', {type: 'button', class: 'primary'}, '为当前实验建立会话');
  const statusBox = h('div', {class: 'agent-status'});
  const sessionControls = h('div', {class: 'row'});
  const chatList = h('div', {class: 'chat-log', style: {height: '180px', 'overflow-y': 'auto'},
    'aria-live': 'polite', 'aria-label': '会话消息'});
  const chatInput = h('input', {type: 'text', id: 'session-chat-input', style: {flex: '1'},
    placeholder: '继续对话：追问、补充参数、调整范围…'});
  const chatForm = h('form', {}, h('div', {class: 'row'}, chatInput, h('button', {type: 'submit'}, '发送')));
  const taskBox = h('div', {});
  const memoryBox = h('details', {}, h('summary', {}, '记忆检查点（压缩摘要）'));
  const logList = h('ul', {class: 'session-log', 'aria-live': 'polite', 'aria-label': '会话事件日志'});
  const hintEl = h('p', {class: 'muted', style: {'font-size': '10px'}}, '');
  const unavailableBox = h('div', {class: 'card', hidden: true, style: {borderColor: '#d9a02b'}});

  // legacy run section
  const runStatusBox = h('div', {class: 'agent-status'});
  const runControlsRow = h('div', {class: 'row'});
  const modeSel = h('select', {id: 'agent-mode'},
    h('option', {value: 'scripted'}, 'scripted（确定性剧本）'),
    h('option', {value: 'llm'}, 'llm（自然语言目标）'));
  const goalInput = h('input', {type: 'text', id: 'agent-goal', style: {width: '200px'}, placeholder: '如：维持 A 排培养液'});
  const startSubmit = h('button', {type: 'submit', class: 'primary'}, '启动 Agent run');
  const startHint = h('span', {class: 'muted'});
  const policyHint = h('p', {class: 'muted', id: 'agent-policy-hint'});
  const startForm = h('form', {}, h('div', {class: 'row'},
    h('label', {}, '模式', modeSel), h('label', {}, '任务目标（goal）', goalInput)), policyHint, startSubmit, ' ', startHint);
  const runLogList = h('ul', {class: 'decision-log', 'aria-live': 'polite', 'aria-label': '决策日志'});
  const runHintEl = h('p', {class: 'muted', style: {'font-size': '10px'}}, '');
  const reportBox = h('div', {class: 'card', hidden: true});

  root.replaceChildren(
    h('fieldset', {}, h('legend', {}, '长期培养会话（realtime · 事件驱动）'),
      h('p', {class: 'muted', style: {'font-size': '11px'}},
        '一个实验一个长期会话；浏览器关闭后任务继续，恢复后回到同一会话。'),
      sessionListBox, ' ', newSessionBtn,
      statusBox, sessionControls,
      taskBox,
      h('fieldset', {style: {'margin-top': '6px'}}, h('legend', {}, '持续对话'), chatList, chatForm),
      memoryBox,
      h('div', {style: {'margin-top': '6px'}},
        h('p', {class: 'muted', style: {'font-size': '10px'}}, '会话事件流（独立 seq，断线以 Last-Event-ID 续传）'), hintEl, logList)),
    unavailableBox,
    h('fieldset', {style: {'margin-top': '10px'}}, h('legend', {}, 'Scripted run（lockstep 确定性回归路径）'),
      runStatusBox, runControlsRow, startForm, runHintEl, runLogList, reportBox),
  );

  newSessionBtn.onclick = async () => {
    try {
      await ctx.api.agentCreateSession({});
      await refreshSessions();
      ctx.setStatus('已为当前实验建立长期会话');
    } catch (error) {
      ctx.showError(`建立会话失败：${error.message}`);
    }
  };

  chatForm.onsubmit = async event => {
    event.preventDefault();
    const content = chatInput.value.trim();
    if (!content || !activeSession) return;
    chatInput.value = '';
    try {
      await ctx.api.agentSessionMessage(activeSession.session_id, content,
        `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      // message.appended arrives via SSE
    } catch (error) {
      ctx.showError(`发送失败：${error.message}`);
    }
  };

  function connectSessionEvents(session) {
    if (source) {try {source.close();} catch { /* noop */ }}
    source = null;
    entries = []; logRevision++; renderedLogRevision = -1;
    if (!session || typeof EventSource === 'undefined') return;
    source = new EventSource(ctx.api.agentSessionEventsUrl(session.session_id, 0));
    for (const name of SSE_EVENT_NAMES) {
      source.addEventListener(name, event => {
        if (typeof event.data !== 'string') return;
        let entry;
        try {entry = JSON.parse(event.data);} catch {entry = {type: name, text: event.data};}
        if (entry && entry.seq != null && entries.some(e => e.seq === entry.seq)) return;
        entries.push({...entry, type: entry?.type || name});
        if (entries.length > 400) entries = entries.slice(-400);
        logRevision++;
        if (['message.appended', 'task.created', 'task.status', 'task.promoted', 'task.queue_cancelled',
          'task.goal_updated', 'plan.updated',
          'plan.step', 'checkpoint.created', 'session.archived', 'turn.completed', 'loop.state'].includes(entry?.type)) {
          void refreshSessionDetail();
        }
        renderLog();
      });
    }
    source.onopen = () => {hintEl.textContent = '会话事件流已连接';};
    source.onerror = () => {hintEl.textContent = '会话事件流断开，EventSource 正以 Last-Event-ID 自动重连…';};
  }

  async function refreshSessions() {
    const gen = selectionGen;
    try {
      agentUnavailable = false;
      const {sessions: list} = await ctx.api.agentSessions();
      sessions = list;
      // a selection made while the list was in flight owns the panel now
      if (gen === selectionGen) {
        if (!activeSession && list.length) selectSession(list.find(s => s.lifecycle === 'active') ?? list[0]);
        else if (activeSession) {
          const fresh = list.find(s => s.session_id === activeSession.session_id);
          if (!fresh) {
            // active session vanished: bump generation so its in-flight
            // detail/status responses cannot paint over the empty state
            selectionGen++;
            activeSession = null; sessionDetail = null; sessionStatus = null;
            appliedRefresh = {sessionId: null, seq: 0, messageSeq: -1};
            connectSessionEvents(null);
            void refreshSessionDetail();
          } else activeSession = fresh;
        }
      }
      renderSessionList();
      if (gen === selectionGen) await refreshSessionDetail();
    } catch (error) {
      if (error.code === 'agent_unavailable' || error.status === 503) agentUnavailable = true;
      renderSessionList();
    }
  }

  function selectSession(session) {
    if (activeSession?.session_id === session.session_id) return;
    selectionGen++;
    activeSession = session;
    sessionDetail = null; sessionStatus = null;
    appliedRefresh = {sessionId: null, seq: 0, messageSeq: -1};
    connectSessionEvents(session);
    renderSessionList();
    void refreshSessionDetail();
  }

  async function refreshSessionDetail() {
    if (!activeSession) {sessionDetail = null; sessionStatus = null; statusRevision++; renderSession(); return;}
    const gen = selectionGen;
    const sessionId = activeSession.session_id;
    const seq = ++refreshSeq;
    try {
      const [detail, status] = await Promise.all([
        ctx.api.agentSession(sessionId),
        ctx.api.agentSessionStatus(sessionId),
      ]);
      // Ordering rule (status and detail are applied strictly as one pair):
      // 1. cross-session — selectionGen + session id (unchanged guard); a
      //    response for another selection must never paint this panel;
      // 2. same-session request order — a refresh issued BEFORE the last
      //    applied one is stale, however late it returns (SSE and the 5 s
      //    poll start overlapping refreshes of the SAME session);
      // 3. server watermark — the pair's authoritative version is
      //    status.watermarks.last_message_seq, corroborated by the detail
      //    messages' own seq when present. A pair older than what is
      //    displayed is dropped WHOLE (status AND chat together), so the
      //    chat log and the status chips can never regress to an older
      //    revision; an equal watermark stays admissible so a later refresh
      //    can still repaint non-message status fields.
      if (gen !== selectionGen || activeSession?.session_id !== sessionId) return;
      if (appliedRefresh.sessionId === sessionId && seq < appliedRefresh.seq) return;
      const watermarkCandidates = [status?.watermarks?.last_message_seq,
        ...((detail?.messages ?? []).map(m => m?.seq))].filter(v => Number.isFinite(v));
      const watermark = watermarkCandidates.length ? Math.max(...watermarkCandidates) : null;
      if (appliedRefresh.sessionId === sessionId && watermark != null
        && appliedRefresh.messageSeq >= 0 && watermark < appliedRefresh.messageSeq) return;
      sessionDetail = detail;
      sessionStatus = status;
      appliedRefresh = {sessionId, seq, messageSeq: watermark ?? appliedRefresh.messageSeq};
      statusRevision++;
      renderSession();
    } catch { /* status may lag during restarts; SSE keeps the log fresh */ }
  }

  // ---- rendering ---------------------------------------------------------------

  function renderSessionList() {
    const buttons = sessions.map(s => h('button', {
      type: 'button',
      class: s.session_id === activeSession?.session_id ? 'primary' : '',
      onclick: () => selectSession(s),
      style: {'font-size': '11px'},
    }, `${s.lifecycle === 'archived' ? '📓 ' : '🧬 '}${s.experiment_id}`
      + (s.active_task ? ` · ${TASK_LABELS[s.active_task.status] ?? s.active_task.status}` : '')
      + (s.lifecycle === 'archived' ? '（归档只读）' : '')));
    sessionListBox.replaceChildren(...buttons);
    newSessionBtn.disabled = ctx.isReplay() || sessions.some(s => s.lifecycle === 'active'
      && s.experiment_id === ctx.getState().experimentId);
  }

  let lastSessionKey = '';
  function renderSession() {
    if (renderedStatusRevision === statusRevision) return;
    renderedStatusRevision = statusRevision;
    const s = sessionStatus;
    // stable DOM: skip identical renders (the 5 s poll must not mutate)
    const key = JSON.stringify([activeSession?.session_id, s && {
      loop: [s.loop.state, s.loop.detail, s.loop.agent_paused], device: [s.device.reachable,
        s.device.sim_time_s, s.device.paused, s.device.in_flight_actions, s.device.clock_mode],
      next: s.next_wake && [s.next_wake.kind, s.next_wake.target_sim_s],
      task: s.task && [s.task.task_id, s.task.status, s.task.reason, s.task.goal_revision,
        s.task.budget.actions_used, s.task.budget.model_turns_used, JSON.stringify(s.task.plan)],
      queue: (s.queue ?? []).map(q => [q.task_id, q.status, q.position]),
      msgs: (sessionDetail?.messages ?? []).length, cp: sessionDetail?.checkpoint?.generation ?? 0,
      nSessions: sessions.length}]);
    if (key === lastSessionKey) return;
    lastSessionKey = key;
    if (!s || !activeSession) {
      statusBox.replaceChildren(h('p', {class: 'muted'}, sessions.length
        ? '选择一个会话查看。'
        : '当前实验还没有长期会话。点击「为当前实验建立会话」开始（需要 realtime 时钟）。'));
      sessionControls.replaceChildren();
      taskBox.replaceChildren();
      chatList.replaceChildren(h('p', {class: 'muted'}, '—'));
      memoryBox.replaceChildren(h('summary', {}, '记忆检查点（压缩摘要）'));
      return;
    }
    const loop = LOOP_LABELS[s.loop.state] ?? s.loop.state;
    const device = s.device;
    statusBox.replaceChildren(
      h('div', {class: 'row'},
        h('b', {}, activeSession.experiment_id),
        h('span', {class: `chip ${s.loop.state === 'unavailable' ? 'bad' : s.loop.state === 'idle' ? '' : 'ok'}`}, `Agent：${loop}`),
        device.reachable ? h('span', {class: 'chip ok'},
          `设备在线 · ${device.clock_mode ?? '?'} · sim ${fmtSimTime(device.sim_time_s ?? 0)}${device.paused ? ' · 已暂停' : ''}`)
          : h('span', {class: 'chip bad'}, `设备不可达${device.error ? `（${device.error}）` : ''}`),
        s.model.configured ? h('span', {class: 'muted'}, `模型 ${s.model.backend}`)
          : h('span', {class: 'chip bad'}, '模型未配置（model_unavailable，不会回退 scripted）'),
      ),
      h('p', {class: 'muted', style: {'font-size': '11px'}},
        `${s.loop.detail ? `等待原因：${s.loop.detail} · ` : ''}`
        + (s.next_wake ? `下次唤醒：${s.next_wake.kind}${s.next_wake.target_sim_s != null ? ` @ sim ${fmtSimTime(s.next_wake.target_sim_s)}` : ''} · ` : '')
        + `在途动作 ${device.in_flight_actions ?? 0} · 消息 seq ${s.watermarks.last_message_seq} · 事件 seq ${s.watermarks.last_event_seq} · inbox ${s.watermarks.inbox_cursor}`),
    );

    // separate controls: pause AGENT / cancel TASK (Runtime pause stays in the top bar)
    const task = s.task;
    const canPause = activeSession.lifecycle === 'active';
    sessionControls.replaceChildren(
      h('button', {type: 'button', disabled: !canPause || s.loop.state === 'paused',
        onclick: () => ctx.api.agentSessionControl(activeSession.session_id, 'pause_agent')
          .then(refreshSessionDetail).catch(e => ctx.showError(`暂停 Agent 失败：${e.message}`))}, '暂停 Agent（停决策）'),
      h('button', {type: 'button', disabled: !canPause || s.loop.state !== 'paused',
        onclick: () => ctx.api.agentSessionControl(activeSession.session_id, 'resume_agent')
          .then(refreshSessionDetail).catch(e => ctx.showError(`恢复 Agent 失败：${e.message}`))}, '恢复 Agent'),
      task && !['completed', 'failed', 'cancelled'].includes(task.status)
        ? h('button', {type: 'button',
          onclick: () => ctx.api.agentTaskControl(task.task_id, 'cancel')
            .then(refreshSessionDetail).catch(e => ctx.showError(`取消任务失败：${e.message}`))}, '取消任务（对账在途动作）')
        : null,
      task ? h('span', {class: 'muted'}, `预算：动作 ${task.budget.actions_used}/${task.budget.max_actions} · 模型回合 ${task.budget.model_turns_used}/${task.budget.max_model_turns}`) : null,
    );

    // task + plan + queue (R07: queued tasks wait in FIFO order behind the current one)
    const plan = task?.plan ?? [];
    const queue = s.queue ?? [];
    taskBox.replaceChildren(
      task ? h('div', {class: 'card'},
        h('div', {class: 'row'},
          h('b', {}, `任务 ${task.task_id.slice(0, 12)}…`),
          h('span', {class: `chip ${task.status === 'completed' ? 'ok' : ['failed', 'cancelled'].includes(task.status) ? 'bad' : 'warn'}`,
            title: task.status}, `${TASK_LABELS[task.status] ?? task.status}`),
          h('span', {class: 'muted'}, `goal r${task.goal_revision}`),
        ),
        h('div', {style: {'font-size': '12px'}}, task.goal_text),
        task.reason ? h('div', {class: 'muted', style: {'font-size': '11px'}}, `原因：${task.reason}`) : null,
        plan.length ? h('ol', {style: {'font-size': '11px', margin: '4px 0 0 16px'}},
          plan.map(p => h('li', {},
            `${p.skill} — ${p.status === 'done' ? '✓' : p.status === 'failed' ? '✗' : p.status}`,
            p.evidence_refs?.length ? h('span', {class: 'muted'}, ` · 证据 ${p.evidence_refs.join(', ')}`) : null))) : null)
        : h('p', {class: 'muted'}, s.session.lifecycle === 'active'
          ? '当前会话没有任务。发送消息描述目标，或用下方按钮创建结构化监测任务。' : '归档会话：只读。'),
      queue.length ? h('div', {class: 'card', style: {'margin-top': '4px'}},
        h('div', {class: 'row'},
          h('b', {}, '任务队列（FIFO）'),
          h('span', {class: 'muted', style: {'font-size': '11px'}},
            `${queue.length} 个排队任务 · 当前任务结束后自动晋升`)),
        ...queue.map((q, i) => h('div', {class: 'row', style: {'font-size': '11px', 'margin-top': '2px'}},
          h('span', {class: 'chip'}, `#${q.position ?? i + 1} ${TASK_LABELS[q.status] ?? q.status}`),
          h('span', {style: {flex: '1'}}, `${q.task_id.slice(0, 12)}… ${q.goal_text ?? ''}`),
          h('button', {type: 'button', style: {'font-size': '11px'},
            onclick: () => ctx.api.agentTaskControl(q.task_id, 'cancel')
              .then(refreshSessionDetail)
              .catch(e => ctx.showError(`取消排队任务失败：${e.message}`))}, '取消排队'))))
        : null,
      s.session.lifecycle === 'active'
        ? h('button', {type: 'button', style: {'margin-top': '4px'},
        onclick: () => ctx.api.agentSessionTask(activeSession.session_id, {
          goal_text: '照看 plate-01 A 排：定期扫描，液位低于 330 µL 时整排补液并复查（演示协议）',
          goal_spec: defaultGoalSpec(),
        }).then(refreshSessionDetail).catch(e => ctx.showError(`创建任务失败：${e.message}`))},
        task && !['completed', 'failed', 'cancelled'].includes(task.status)
          ? '追加监测任务（进入队列，当前任务结束后自动开始）'
          : '创建监测任务（演示协议：A 排 ≥ 330 µL · 每 6 模拟小时检查 · 期限 26 模拟小时）') : null,
    );

    // conversation
    const messages = sessionDetail?.messages ?? [];
    chatList.replaceChildren(...messages.slice(-60).map(m => h('div', {
      style: {'text-align': m.role === 'user' ? 'right' : 'left', margin: '2px 0'},
    }, h('span', {
      class: m.role === 'user' ? 'chip' : m.role === 'system' ? 'chip bad' : '',
      style: {'max-width': '88%', display: 'inline-block', 'white-space': 'pre-wrap', 'font-size': '12px'},
      title: m.created_at_wall,
    }, m.content))));
    chatList.scrollTop = chatList.scrollHeight;

    // memory checkpoint
    const cp = sessionDetail?.checkpoint;
    memoryBox.replaceChildren(h('summary', {},
      `记忆检查点（压缩摘要）${cp ? ` · 代 ${cp.generation} · 覆盖消息 ≤ ${cp.covered_message_seq}` : ' · 无'}`),
      cp ? h('div', {class: 'muted', style: {'font-size': '11px', 'white-space': 'pre-wrap'}}, cp.summary) : h('span', {class: 'muted'}, '—'));
  }

  function entryNode(entry) {
    const payload = entry.payload ?? {};
    // legacy run events flatten their payload onto the entry itself
    const basis = BASIS_SET.has(entry.basis) ? entry.basis : BASIS_SET.has(payload.basis) ? payload.basis : null;
    const meta = [];
    if (Number.isFinite(entry.seq)) meta.push(`seq ${entry.seq}`);
    if (payload.sim_time_s != null) meta.push(fmtSimTime(payload.sim_time_s));
    if (payload.action_id) meta.push(payload.action_id);
    if (payload.observation_id) meta.push(payload.observation_id);
    const refs = []
      .concat(entry.evidence_refs ?? [], entry.observation_ids ?? [], entry.evidence?.observation_ids ?? [],
        payload.evidence_refs ?? [], payload.observation_ids ?? [])
      .filter(ref => typeof ref === 'string');
    const text = String(payload.message?.content ?? entry.summary ?? payload.summary ?? entry.reason
      ?? payload.reason ?? entry.detail ?? payload.detail ?? entry.description ?? payload.description
      ?? entry.code ?? payload.code ?? entry.text ?? payload.message ?? '');
    const statusChip = payload.status ? ` ${TASK_LABELS[payload.status] ?? payload.status}` : '';
    return h('li', {class: ['error', 'model.error', 'model.unavailable'].includes(entry.type) ? 'err' : ''},
      h('div', {class: 'meta'},
        h('b', {}, `${entry.type}${statusChip}`),
        basis ? h('span', {class: `basis ${basis}`}, basis) : null,
        ...meta.map(m => h('span', {}, m)),
      ),
      text ? h('div', {}, text.slice(0, 200)) : null,
      payload.capability ? h('div', {class: 'muted'}, `动作：${capabilityLabel(payload.capability)}`) : null,
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

  // ---- legacy run section (unchanged behavior) ----------------------------------

  startForm.onsubmit = async event => {
    event.preventDefault();
    agentUnavailable = false;
    try {
      const state = ctx.getState();
      if (state.clock?.clock_mode !== 'lockstep' || state.clock?.paused) {
        ctx.showError('Scripted run 需要 lockstep；自然语言/realtime 请使用上方的长期会话。');
        return;
      }
      const response = await ctx.api.startAgentRun({experiment_id: state.experimentId,
        mode: modeSel.value, goal: modeSel.value === 'llm' ? goalInput.value || undefined : undefined});
      runEntries = [];
      const runId = response?.run?.run_id || response?.run_id || null;
      if (runId) {activeRunId = runId; connectRunEvents(runId);}
      ctx.setStatus(`Agent run 已启动：${runId || '（未知 id）'}`);
      ctx.refreshNow();
    } catch (error) {
      if (error.code === 'agent_unavailable' || error.status === 503) {
        agentUnavailable = true;
        ctx.setStatus('Agent 不可用（503），人工操作不受影响');
      } else {
        ctx.showError(`启动 Agent run 失败：${error.message}`);
      }
    }
  };

  function connectRunEvents(runId) {
    if (runSource) {try {runSource.close();} catch { /* noop */ } runSource = null;}
    if (!runId || typeof EventSource === 'undefined') return;
    runSource = new EventSource(ctx.api.agentEventsUrl(runId));
    runSource.onopen = () => {runHintEl.textContent = 'Agent 事件流已连接';};
    runSource.onerror = () => {runHintEl.textContent = 'Agent 事件流断开，EventSource 正以 Last-Event-ID 自动重连…';};
    for (const name of SSE_EVENT_NAMES) {
      runSource.addEventListener(name, event => {
        if (typeof event.data !== 'string') return;
        let entry;
        try {entry = JSON.parse(event.data);} catch {entry = {type: name, text: event.data};}
        if (entry && entry.payload && typeof entry.payload === 'object') entry = {...entry.payload, ...entry, payload: undefined};
        if (entry && entry.seq != null && runEntries.some(e => e.seq === entry.seq)) return;
        runEntries.push({...entry, type: entry?.type || name});
        if (runEntries.length > 300) runEntries = runEntries.slice(-300);
        renderRunLog();
        renderReport();
      });
    }
  }

  let renderedRunLogRevision = -1;
  function renderRunLog() {
    if (renderedRunLogRevision === runEntries.length) return;
    renderedRunLogRevision = runEntries.length;
    runLogList.replaceChildren(...runEntries.slice(-80).reverse().map(e => entryNode(e.payload ? {...e, payload: e.payload} : e)));
  }

  function renderReport() {
    const report = [...runEntries].reverse().find(e => /report|finish/.test(String(e.type || '')));
    if (report === lastReport) return;
    lastReport = report;
    if (!report) {reportBox.hidden = true; return;}
    reportBox.hidden = false;
    reportBox.replaceChildren(h('h3', {}, '报告'),
      h('div', {}, report.summary || report.message || report.text || h('pre', {style: {'white-space': 'pre-wrap', 'font-size': '11px'}},
        JSON.stringify(report, null, 2))));
  }

  let lastRunStatusKey = '';
  function renderRunStatus(state) {
    const run = state.run;
    const key = JSON.stringify([run, ctx.isReplay()]);
    if (key === lastRunStatusKey) return;
    lastRunStatusKey = key;
    if (!run) {
      runStatusBox.replaceChildren(h('p', {class: 'muted'}, '当前实验没有活跃 run（人工操作模式）。'));
      runControlsRow.replaceChildren();
      return;
    }
    const statusLabels = {active: '运行中', paused: '已暂停', on_hold: '人工挂起', ended: '已结束'};
    runStatusBox.replaceChildren(h('div', {},
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
    const disabled = ctx.isReplay() || !run || run.status === 'ended';
    const control = (action, label) => h('button', {type: 'button', disabled,
      onclick: () => ctx.api.agentRunControl(run.run_id, action)
        .then(() => ctx.refreshNow())
        .catch(error => ctx.showError(`Agent 控制（${label}）失败：${error.message}`))}, label);
    const holdLabel = run?.status === 'on_hold' ? '解除人工挂起（unhold）' : '人工挂起（hold）';
    runControlsRow.replaceChildren(
      control('pause', '暂停'), control('resume', '恢复'), control('cancel', '取消'),
      h('button', {type: 'button', disabled, onclick: () =>
          ctx.api.control(state.experimentId, {hold: {run_id: run.run_id, on: run.status !== 'on_hold'}})
            .then(() => ctx.refreshNow())
            .catch(error => ctx.showError(`hold 切换失败：${error.message}`))}, holdLabel));
  }

  function render(state) {
    unavailableBox.hidden = !agentUnavailable;
    if (agentUnavailable) {
      unavailableBox.replaceChildren(h('p', {},
        h('b', {}, 'Agent 不可用'), '（网关返回 503 agent_unavailable）。人工操作不受影响，可继续在「操作」页使用设备。'));
    }
    renderSessionList();
    renderSession();
    renderLog();
    renderRunStatus(state);
    const runId = state.run?.run_id;
    if (runId && runId !== activeRunId) {activeRunId = runId; runEntries = []; connectRunEvents(runId);}
    else if (runId && !runSource) connectRunEvents(runId);
    else if (!runId && activeRunId) {
      if (runSource) {try {runSource.close();} catch { /* noop */ }}
      runSource = null; activeRunId = null; runEntries = [];
    }
    renderRunLog();
    renderReport();
    policyHint.textContent = modeSel.value === 'scripted'
      ? `按当前场景 ${state.experiment?.scenario_id || '—'} 执行已实现的确定性策略；不解析自由文本目标。`
      : 'LLM 在 run 路径会暂停为 model_unavailable；自然语言目标请使用上方的长期会话。';
    const active = Boolean(state.run && state.run.status !== 'ended');
    startSubmit.disabled = ctx.isReplay() || active || state.clock?.clock_mode !== 'lockstep' || Boolean(state.clock?.paused);
    startHint.textContent = ctx.isReplay() ? '只读回放' : active ? '（已有活跃 run；先取消或结束）'
      : state.clock?.clock_mode !== 'lockstep' ? '请先在顶栏切换到 lockstep；当前 Agent run 不支持 realtime（长期会话支持）。'
      : state.clock?.paused ? '请先恢复 Runtime。' : '';
    goalInput.disabled = ctx.isReplay() || modeSel.value === 'scripted';
  }

  refreshSessions();
  const poll = setInterval(() => {void refreshSessions();}, 5000);

  render(ctx.getState());

  return {
    render,
    dispose() {
      clearInterval(poll);
      selectionGen++;  // in-flight detail/status must not render after dispose
      if (source) {try {source.close();} catch { /* noop */ } source = null;}
      if (runSource) {try {runSource.close();} catch { /* noop */ } runSource = null;}
    },
  };
}
