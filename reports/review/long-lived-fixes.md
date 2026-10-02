# F01–F15 修复报告（对应 long-lived-review.md）

日期：2026-09-30（Asia/Shanghai）。基线：审查报告 `22c3a97`。本报告描述针对 15 项问题的修复、回归证据与复跑结果。

**结论：F01–F15 全部修复。** 三个原复现脚本已按审查要求从“断言缺陷可复现”改为“断言正确行为”的回归脚本（退出 0 = 行为正确）。正式回归进入测试套件：`services/culture-agent/test/review-fences.test.ts`。

复跑结果（全绿）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npm test` | 177/177（并行相 164 + 串行相 13；原 174 基线保留，新增 review-fences 回归） |
| `npm run test:e2e` | 17/17（4.8 分钟） |
| `npm run demo:all -- --out-dir /tmp/oscar-f01-f15-fix-demo` | 5/5，隔离输出，逐孔守恒与 26.4 模拟小时窗口保持 |
| `node reports/review/long-lived-reproduce.mjs` | 12/12 场景按正确行为通过 |
| `node reports/review/long-lived-http-reproduce.mjs` | 4/4 场景按正确行为通过（真实 pi 工具协议 + 慢响应线缆桩） |
| `node reports/review/long-lived-ui-reproduce.mjs` | 通过（Chromium 真实 `web/panels/agent.js`） |

## 逐项修复

### F01 暂停/关闭封住在途模型工具写入

- [executor.ts](../../services/culture-agent/src/executor.ts)：新增 `close()`（进程关闭撤销在途写）；提交序列最前置 `scheduler_stopped` 检查；步骤 3b 在持久化 intent 之前检查 `agent_paused`（无 intent、无 submit）。
- [scheduler.ts](../../services/culture-agent/src/scheduler.ts)：`stop()` 先关闭 executor 再 abort；`pause()` 先持久化 paused 标志再 `turnAbort.abort()`；新增 `drain()`——等待主循环**和**在途回合，`turnAbort` 在恢复时换新控制器（resume 后同调度器可跑后续回合）。
- [session-manager.ts](../../services/culture-agent/src/session-manager.ts)：`stopAll()` 改等 `drain()`（5s race 仅兜底挂起）。
- [backend.ts](../../services/culture-agent/src/backend.ts)：外部 `signal` 接到 `agent.abort()`，取消真实提供商等待。
- 证据：review-fences「pause, stale turns…」中 session pause / task pause / stop 三个场景均为零新增动作；HTTP 回归「真实 pi 慢响应在 pause 后」零 service 动作（model_requests=1、agent_paused=true、plate revision 已变）。

### F02 迟到回合效果围栏

- [scheduler.ts](../../services/culture-agent/src/scheduler.ts)：新增 `turnStale()`（stopped/aborted、session 缺失/归档/paused、owner generation 被超越、任务缺失/终态/paused、goal_revision 移动）。`runTurn()` 返回后先过围栏再落任何效果；`submitWrite`、`armWake`、`updateTaskGoal`、`replacePlan`、`updateStep` 全部同围栏保护（needs_input 例外：模型补参必须能写 goal）。
- [session-store.ts](../../services/culture-agent/src/session-store.ts)：`updateTaskStatus` 拒绝终态→他态转移（终态不可被旧回合恢复）。
- 证据：取消任务在旧响应 `complete_task` 后保持 cancelled；goal 改到 r2 后 r1 响应不再完成任务（revision=2、status 非 completed）。

### F03 inbox 终态唤醒丢失

- [scheduler.ts](../../services/culture-agent/src/scheduler.ts)：`recordInbox`（插行+游标）与处理拆分——`processDeviceEvent` 处理成功才 `markInboxProcessed`，observation 拉取失败保持 `received` 待重试；启动 `recover()` 顺序调整：intent 对账**先**绑定 action_id（否则 received 终态事件无法归属），再 `drainReceivedInbox()` 幂等排空 `received` 行，再 catch-up，再一次恢复回合。排空只重放处理逻辑（fireWake 只碰 armed 行），不从该路径提交任何设备动作。
- 证据：review-fences 与核心回归的「received 行重启排空」：模型调用≥1、行变 `processed`、action_terminal wake 全部消费。

### F04 恢复后无 wake 任务停滞

- [scheduler.ts](../../services/culture-agent/src/scheduler.ts)：`recover()` 末尾 `scheduleRecoveryTurn()`——恰一次恢复回合：ready/running 直接排；waiting_device 仅无在途动作时排（否则终态事件自会唤醒）；waiting_condition 无任何 armed wake（如目标编辑取消 planning wake 后崩溃）也排；needs_input 不动；无任务时会话仅在用户最后发言时续。采样永不唤醒模型。
- 证据：三个重启位置——首回合前（ready 重启，review-fences）、思考中（agent SIGKILL 中途监控，session-faults）、终态已消费后（inbox 排空续跑 + 无 wake waiting_condition）。

### F05 写前状态/证据围栏

- [backend.ts](../../services/culture-agent/src/backend.ts)：`device_read_state` 改读 `host.readState()` 权威状态（非回合快照）；写工具提交前重读 live 状态取 `expected_revisions`；液体动作（media.add/exchange）必须有本回合新鲜 observation 证据（模型引用或本回合 deviceResults 的 observation_id），否则 `observation_stale` 拒绝。
- [executor.ts](../../services/culture-agent/src/executor.ts)：写锁内、HTTP 提交前重读 live 状态：决策 revision（回合开始快照）≠ live plate revision → `revision_conflict` 拒绝重规划；fresh revision 作为 `expected_revisions` 交给 Runtime 原子检查封住读写间竞态。
- 证据：review-fences「freshness」——模型思考期间操作员加液提交后，旧决定 `revision_conflict` 拒绝、零新增 service 动作；read 工具真实回调 `host.readState`。

### F06 pending intent 跨任务复用

- [session-store.ts](../../services/culture-agent/src/session-store.ts)：schema v3 增 `session_intents.operation_id`（`nextOperationId()` 持久单调计数，弃用 `actions_used+1`）与 `budget_counted`；`findReusableIntent()` 按 task+canonical+goal_revision+无 action 精确匹配；`accountIntent()` 原子绑定 action_id 并一次性计预算。
- [executor.ts](../../services/culture-agent/src/executor.ts)：他任务存在 pending intent 时先 `reconcileIntents()` 对账再写；`reconcileIntents()` 覆盖会话全部 pending（预算记到 intent 自己的 task）。
- 证据：取消任务后新任务同参数获得新 key、action 归属新任务；改参数产生新 operation key；旧失败 key 保持 pending 不被回收。

### F07 needs_input 被创建通知解除

- [scheduler.ts](../../services/culture-agent/src/scheduler.ts)：`onTaskCreated()` 只对可执行任务排回合，`needs_input` 从不清除；`scheduleTurn` 仅 `message` 触发允许 needs_input 回合（模型可询问），状态翻转永不发生；回合后置块用 `missingExecutionParameters` 复核——缺参保持/设为 needs_input，补齐才恢复可执行且不从该块提交动作。
- [sessions-api.ts](../../services/culture-agent/src/sessions-api.ts) / [supervisor-api.ts](../../services/culture-agent/src/supervisor-api.ts)：创建路由改 `onTaskCreated()`（不再 `onUserMessage()`）；resume 改 `onTaskResumed()`。
- 证据：缺参任务创建后 0 模型调用、0 动作、状态保持 needs_input、用户消息数 0。

### F08 HTTP 目标修改不重调度

- [sessions-api.ts](../../services/culture-agent/src/sessions-api.ts) / [supervisor-api.ts](../../services/culture-agent/src/supervisor-api.ts)：目标修改先 `cancelPlanningWakes()`（只撤 sim_time/condition，不动 action_terminal），再 `onGoalUpdated()` 排新回合；操作员与 supervisor 同路径，均不冒充用户消息。
- 证据：HTTP 改 goal 后旧 `sim=1e9` 等待取消、模型再排 ≥1 回合、revision 推进。

### F09 压缩遗忘约束

- [backend.ts](../../services/culture-agent/src/backend.ts)：`compact()` 识别中英文约束语句（不要/只准/必须/never/only…）入 `constraint:` facts 并写入 summary；承接 `previous` checkpoint 的约束与开放问题（问句含全角 `？`）；携带 plan/wakes 概要。`buildSystemPrompt` 除 summary 外逐条打印 checkpointFacts/checkpointQuestions。
- [scheduler.ts](../../services/culture-agent/src/scheduler.ts) / [sessions-api.ts](../../services/culture-agent/src/sessions-api.ts)：自动/强制压缩都传入 previous+plan+wakes。
- 证据：review-fences 两轮压缩后 summary/facts/prompt 均含「不要使用 media-02」约束；session-faults 强制压缩回归保持。

### F10 归档检测与写边界

- [scheduler.ts](../../services/culture-agent/src/scheduler.ts)：watchdog 对每个 active tick 都检查（删除了无 wake/无回合即跳过的分支）；`recover()` 读态即归档非 active 实验。
- [supervisor-api.ts](../../services/culture-agent/src/supervisor-api.ts)：task update/control 统一 `session_archived` 检查；resume 拒绝终态任务（`invalid_argument`），cancel/pause 对终态任务为幂等 no-op。
- 证据：HTTP 回归——reset 后空闲会话（无 armed wake）一个 watchdog 周期内 `archived`；supervisor 对归档会话写/续均为 409 `session_archived`；review-fences 终态任务 resume 拒绝。

### F11 自然语言建任务入口

- [backend.ts](../../services/culture-agent/src/backend.ts)：新增 `propose_task` 工具（无任务时可用）：goal_text + 完整 goal_spec，服务端 `normalizeGoalSpec` 校验；needs_input 时终止回合并说明缺参；无任务时 system prompt 指引调用它（不再要求用户去调 HTTP API）。
- [scheduler.ts](../../services/culture-agent/src/scheduler.ts)：ToolHost 增 `createTask`（围栏内校验：stale/paused/已有任务/非法 spec 拒绝；缺参建为 needs_input 并通知）。
- [web/panels/agent.js](../../web/panels/agent.js)：终端任务后重新显示创建按钮。
- 证据：review-fences 经真实 pi 工具协议用两个预设演示之外的目标（腔室温度 environment.set_targets、B 排液位 media.add）从聊天建任务，建任务本身零设备动作。

### F12 预算无门槛

- [scheduler.ts](../../services/culture-agent/src/scheduler.ts)：`tryReserveModelTurn()`（[session-store.ts](../../services/culture-agent/src/session-store.ts)，持久、原子）在提供商调用**前**预留；预留失败 → 任务 `failed(budget_exhausted)`；回合后不再累计（预留即唯一增量，重启无免费额度）。
- [sessions-api.ts](../../services/culture-agent/src/sessions-api.ts) / [supervisor-api.ts](../../services/culture-agent/src/supervisor-api.ts) / [session-store.ts](../../services/culture-agent/src/session-store.ts)：API 校验预算值为 0..100000 整数。
- 证据：max_model_turns=1 时第 2 回合被拒（calls=1、1/1、failed/budget_exhausted）；SIGKILL 回归中预算跨重启守恒。

### F13 UI 迟到响应串扰

- [web/panels/agent.js](../../web/panels/agent.js)：`selectionGen` 单调代际——切换/会话消失/dispose 都递增；`refreshSessions`/`refreshSessionDetail` 写状态前校验代际与会话 id；旧 SSE 在切换时先关闭。
- 证据：Chromium 回归（真实面板 + 延迟 API 夹具）：A 归档响应迟到不再污染 B 的聊天/在线状态；e2e 17/17。

### F14 request_id 不幂等

- [sessions-api.ts](../../services/culture-agent/src/sessions-api.ts) / [supervisor-api.ts](../../services/culture-agent/src/supervisor-api.ts)：request_id 查重先于 active-task 检查；同体重放返回原 task（200），异体 `idempotency_conflict`；新请求才受单任务限制。
- [session-store.ts](../../services/culture-agent/src/session-store.ts)：`tasks.create_request_id/create_canonical`（schema v3，兼容 legacy goal_spec 查询），canonical 覆盖 goal+spec+已解析预算，目标后续修改不破坏幂等。
- 证据：review-fences（含 supervisor 双路径）与 HTTP 回归重放场景。

### F15 扫描孔位绕过 row scope

- [goal.ts](../../services/culture-agent/src/goal.ts)：`scopeAllowsWrite` 检查 `wells[]` 与 `well_id` 的行前缀属于授权 rows；读取/证据/写动作同规则（单一入口）。
- 证据：B1 扫描 `out_of_scope` 拒绝且零动作；A 排全扫接受。

## 与验收条件的对照说明

- **F03「实际杀进程」窗口**：inbox 排空回归通过在持久库上精确重建崩溃窗口状态（received 行+游标+armed wake）后重启调度器验证，与真实 SIGKILL 留下的持久状态一致；进程级 SIGKILL 恢复另由 session-faults 的 agent/runtime SIGKILL 回归覆盖（无重复 submit、预算与库存对账）。未在 observation fetch 的毫秒级窗口内做定向 SIGKILL（时序不可靠，等价状态已覆盖）。
- **F09「工具执行受限制」**：约束以 `constraint:` facts + summary + prompt 三层保持在模型上下文中指导工具选择；硬性执行边界仍由 GoalSpec scope/allowed_operations/预算强制（自由文本约束不解析为硬约束，属设计边界）。
- **范围缺口（审查 §4 末段）**：同会话第二任务排队、技能前置/后置校验仍为 MVP 边界（HTTP 拒绝第二 active task 并提示经消息排队；技能步骤为自由文本），未在本轮实现，需与用户确认是否缩小 MVP。

## 变更清单

产品代码：`services/culture-agent/src/{scheduler,executor,backend,session-store,session-manager,sessions-api,supervisor-api,goal}.ts`、`web/panels/agent.js`（schema v2→v3， additive 迁移，兼容旧库）。
测试：新增 `services/culture-agent/test/review-fences.test.ts`；`scripts/run-tests.mjs` 将其纳入串行相。
回归脚本：`reports/review/long-lived-{,http-,ui-}reproduce.mjs` 全部翻转为断言正确行为；输出 JSON 同步更新（`long-lived-reproductions.json`、`long-lived-http-reproductions.json`、`long-lived-ui-after-fix.json`）。
