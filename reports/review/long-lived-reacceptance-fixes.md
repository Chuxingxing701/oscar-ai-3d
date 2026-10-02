# R01–R08 修复记录（复验报告 long-lived-reacceptance.md 的整改）

日期：2026-10-02。基线 `22c3a97` + 上一轮未提交修复。本轮仍未 commit。所有模型决策验证均为 HTTP 模型桩（真实 OpenAI wire + PiAgentBackend），**未接真实提供商，未验证视觉能力**。

## 最终验收（同一工作区，顺序执行，非并行）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npm test` | 193/193 并行 + 37/37 串行，0 失败/取消/跳过（原 177 → 230） |
| `npm run test:e2e` | **首轮 17/17**（4.9 min） |
| `npm run demo:all -- --out-dir /tmp/oscar-final-demo` | 5/5 |
| `long-lived-reacceptance-reproduce.mjs` | 退出 0，12/12 |
| `long-lived-reacceptance-ui-reproduce.mjs` | 退出 0 |
| `long-lived-reproduce.mjs` / `long-lived-http-reproduce.mjs` / `long-lived-ui-reproduce.mjs` | 均退出 0 |

审查方脚本未改动。

## 各项修复

- **R01** `executor.ts`：撤权条件（关闭、生命周期、owner generation、任务终态/暂停/needs_input、goal_revision、Agent 暂停、预算）合并为同步 `writeRefusal()`，在最后一次 await（状态读）之后、写 intent 之前再跑一遍，中间无 await。`cancelTask` 先标记取消并撤 wake，再等待执行器写链 `settled()`，然后取消已受理动作；迟到绑定到已取消任务的动作会自动发 cancel。
- **R02** `session_intents.state`：`pending`（未知，阻塞）/`bound`/`not_accepted`（by-key 确认无动作）/`rejected`（Runtime 明确拒绝）。存在 pending 时禁止创建新 key（`reconcile_pending`，可重试），只允许同 key 重试；恢复后按 intent 自身 task 绑定、预算恰好记一次。
- **R03** 补参回合结束、参数齐全时置 running 并排一个 `parameters_complete` 回合；补参回合内写仍拒绝。
- **R04** `pendingTriggers` 保留触发类型；持久化 `sessions.consumed_user_seq` 水位，重启后未消费消息恰好处理一次。附带修复：设备不可达时退避重试（2→30 s），不形成热循环；旧 owner 不发起回合。扫描的 observation 先于终态到达时推迟评估回合，避免 `resource_busy`。
- **R05** `compact()`：`constraint:`/`user:`/`fact:` 跨 checkpoint 原文保留、去重、无截断无数量上限；`op:` 每次重新生成替换。旧版无前缀事实按 `fact:` 承接。system prompt 全量渲染。未实现自动失效检测（只能显式修订）。
- **R06** `agent.js`：每次刷新取单调序号 + 服务器水位，status/detail 成对接受，旧序号或更低水位整体丢弃；保留 selectionGen。
- **R07** 任务队列：新状态 `queued`；UI/聊天/用户 HTTP/总助手共用 store 级幂等 `createTask`；当前任务 = 唯一非终态非排队任务（paused/needs_input 占位）；晋升为单事务 CAS，需无 pending intent 且无在途动作，watchdog 每 5 s 重试；归档取消整个队列；排队项只允许 cancel（pause/resume 返回 409 `task_queued`）。总助手契约 1.1.0，见 API_CONTRACT §10.1.1。
- **R08** `skills.ts`：`scan_and_assess@1`、`exchange_row_and_verify@1`、`mix_and_rescan@1`、`monitor_until@1`，含输入校验、计划时/步骤开始前置条件、后置证据判定和失败分支（如 `verify_below_target` → 推荐下一技能）。`done` 只在引用动作属于本任务当前 goal_revision、终态 succeeded、观测新鲜且同板同 revision 覆盖目标孔并达标时接受；未知技能/版本、错板/旧证据、失败/取消动作被拒。`complete_task` 在存在未验证步骤时拒绝。
- **E2E 归位失败**：根因是测试固定等待 1500 ms，而场景展示时钟在 succeeded 后仍可能用最多 1 s 平滑最后一段停靠，加上页面滞后即超过窗口（失败坐标与缓动残差 t≈0.957 精确吻合）。改为等待场景新增的 `getStatus().presentingMotion === false`，保留精确相等断言；中间帧数量断言由 >1 改为 >0（帧密度依赖负载，不是场景属性）。负载下修复前 7/10，修复后 20/20。

## 新增正式回归

`test/reacceptance.test.ts`（9）、`test/compaction.test.ts`（10）、`test/task-queue.test.ts`（8，真实 Runtime + Agent HTTP）、`test/skills.test.ts`（16）、`test/skills-e2e.test.ts`（7，含 SIGKILL 重启续行）、`tests/web/agent-refresh-order.test.mjs`（Chromium，同会话 + 跨会话）。

## 第二轮：N01–N05（long-lived-r08-independent-review.md）

整改前 `long-lived-r08-review-reproduce.mjs` 复现 7 个失败；整改后退出 0。

- **N01** `replacePlan`/`updateStep` 在最后一次 await 后、写库前重跑完整撤权检查；写库改为 CAS（计划按 goal_revision，步骤按 step_id + plan_revision + 原状态，0 行即拒绝）。覆盖改目标、取消、任务/Agent 暂停、归档、ownership 变化、并发换计划（`skills-e2e-fences.test.ts`）。
- **N02** 完成门槛两层：计划层 failed/skipped 必须被后续同技能同目标的 done+pass 步骤取代；目标层独立按 GoalSpec 指标核对本任务当前 revision 的最新合格观测（`goal_unmet`/`goal_unverified`）。complete_task 工具与回合效果都执行同一判定。完成被拒后若无 wake，自动挂 60 模拟秒复判 wake，避免任务悬停。新增真实低液位复查失败 → 拒绝完成 → 补救达标 → 完成的 e2e。
- **N03** 动作证据读取 Runtime 实际 arguments，要求同板/同排/同储液（`action_target_mismatch`）；验证观测须来自本步骤引用的扫描。wake 持久化 goal_revision 与 step_id，monitor_until 只接受本任务、当前 revision、本步骤、谓词完全一致的已触发 wake。
- **N04** 准入与晋升共用规则：无当前任务、无排队任务且无待交接（`sessions.handoff_pending`，当前任务终结时同事务置位，晋升屏障通过后清除）才直接 ready，否则排队。创建接口有界等待一次晋升尝试（≤3 s），屏障立即可过时直接返回晋升后的状态。
- **N05** 取消状态持久化在 `session_intents.cancel_state`（requested/confirmed）；失败保留 requested 并有界退避重试，显式再次取消必定重发，重启后继续；成功取消保持幂等。

第二轮最终顺序验收：typecheck 0 错误；`npm test` 204/204 + 42/42；六份审查脚本（含 r08）全部退出 0；demo 5/5；E2E 首轮 17/17（4.8 min）。

## 第三轮：Q01–Q04（long-lived-n05-independent-review.md）

整改前 `long-lived-n05-review-reproduce.mjs` 复现 4 个失败、完整单测 245/246；整改后脚本退出 0、单测全绿。

- **Q01** `maybePromoteNext` 的手动在途检查改为遍历会话**全部**已绑定 intent；查询失败不再当作无在途动作，`handoff_pending` 保持、watchdog/终态事件/显式取消继续重试。仅查最后 10 条的窗口一并去掉。恢复后照旧清除交接、交付待取消并晋升队首。
- **Q02** `runTurn` 在状态读完后、首次本地写入与模型调用前重跑完整撤权检查；ready→running 改为条件更新（`startTaskTurn`，WHERE status='ready' AND goal_revision=?），状态读取期间到达的任务暂停不再被覆盖，零设备写入。
- **Q03** 无指标的监测目标完成需成功证据：`deadline_sim_s` 到达，或一个 done+验证通过且输入与目标期限/监测条件一致的 `monitor_until` 步骤；没有结构化可验证成功条件时拒绝完成（goal_unverified，提示补参/请求输入）。空计划 + 无证据不再视为成功。
- **Q04** 目标验证按**孔**聚合：每个指标孔用覆盖它的最新合格观测判定（任务/目标版本、板 revision、质量、维护后采样等过滤不变），分排扫描不再互相覆盖；较新的不达标同孔观测也不能被较早达标证据掩盖。
- **§3 测试修复** 旧观测回归的夹具改为显式引用生产扫描动作，只破坏新鲜度，恢复 `observation_stale` 的精确断言；另增 `observation_not_from_step_action` 独立用例。未改任何验证代码。

第三轮最终顺序验收：typecheck 0 错误；`npm test` 206/206 + 49/49；七份审查脚本（含 n05、r08）全部退出 0；demo 5/5；E2E 首轮 17/17（4.8 min）。

## 已知限制

- 真实 failed（非 cancelled）设备动作在 e2e 中无法通过合法路径产生，只在单测覆盖。
- 中间整轮测试曾出现负载导致的 session-faults / long-session 超时（多个子代理并发跑重测），最终独立整轮通过。
- 压缩不自动识别"后一条指令推翻前一条"，旧指令同样保留，由模型通过 update_goal 修订。

## 第四轮：S01–S03 与 §3（long-lived-q04-independent-review.md）

本轮整改 q04 审查的 S01（阈值唤醒未消费正式环境事件契约）、S02（monitor_until 证明证据跨目标版本复用）、S03（无效观测指标被静默过滤成空列表）与 §3 夹具（旧观测回归的顺序脆弱性），随后进行 dog food 内部试用与最终验收。整改前 q04 审查报告记录 S01 真实采样谓词满足但 fired_wakes=0；整改后 `long-lived-q04-review-reproduce.mjs` 退出 0。

- **S01** `scheduler.ts` + 新增 `test/threshold-wake-long-session.test.ts`：`evaluateConditions`（scheduler.ts:741-786）优先读正式事件契约的 `payload.sample.{temperature_c,co2_pct,humidity_pct}`（runtime.ts:1253 的 environment.sampled 生产形状），再回退旧 `chamber.*.observed` 与顶层扁平形状——审查脚本的扁平组件对照入口保持可用。quality 语义明确并注释：sample 只有一个整样本标志（ok|settling），settling 仅表示某通道仍在向新目标收敛；逐通道读数与 /state 腔室读数、skills.ts 目标验证消费的是同一批传感器事实（后者本无质量门），用整样本标志门控会让无关通道的 settling 压制稳定通道的真实跨越，故非 ok 采样仍参与评估，去抖/滞回/冷却继续充当瞬态过滤器；quality 随 wake.fired 透出。去抖、滞回、tripped 闩锁、冷却逻辑本身未改动。新测试走真实 Runtime 子进程 HTTP/SSE、operator 真实 `environment.set_targets` 驱动跨越、无合成读数：温度（去抖 0：首个越界采样触发、恰好一次、闩锁不重复、经滞回回带后冷却窗口内第二次真实跨越被抑制）、CO₂（去抖 60：触发时刻 − 首个越界采样 ≥60，恰好一次）、湿度（去抖 30，恰好一次）；不满足条件对照：3 个真实采样 processed 后 runTurn 恰好 1 次（仅登记回合）、0 触发。验证：typecheck 0 错误；新测试 1/1（12.1s）；q04 脚本 `actual_environment_contract_fires_threshold_wake` pass（fired_wakes:1，normalized_sample_control_needed:false，即真实事件路径直接触发、未走组件对照兜底）；`long-session.test.ts` 2/2 无回归；新测试文件名匹配 scripts/run-tests.mjs:26 串行正则，故未改 run-tests.mjs。未对自己的新测试做变异杀死对照（避免与并行子代理在 scheduler.ts 上竞态），失败/通过对照以审查脚本本身为准（修复前 fired_wakes=0 → 本次 1）。
- **S02+S03** `skills.ts` + `skills.test.ts` + `skills-e2e-fences.test.ts`：S02 —— monitor_until 的 verify 把证明 wake 的 goal_revision/step_id 持久化到步骤 `verification.evidence`；完成判定 `monitorStepMatchesSuccessCondition` 拆成输入匹配 + 版本归属两层：版本归属要求 `step.plan_revision ===` 当前 goal_revision（replacePlan 写入的就是任务 goal_revision）、evidence 记录的证明 wake revision 等于当前值且绑定本步骤，并提供可选 fired-wake 账本交叉核对（ctx.firedWakes，提供时 fail closed）。目标修改后旧验证只是历史：完成拒绝并在 reasons 点名旧版本证据、要求在新版本下重新登记/验证等待；r1 证据完成 r1 目标的正对照保持通过。S03 —— `metricWells` 改为对权威布局解析，未知板/排/孔作为 problems 返回而非过滤成空列表；`verifyGoalSatisfied` 的观测指标循环遇无效目标即以 goal_unverified 拒绝（reasons 点名无效项并提示修目标或补参），混合有效/无效同样拒绝；goal.ts 输入校验保持布局无关未动。验证：typecheck 0 错误；`skills.test.ts` 27/27（新增 S02 单测：r1 正对照通过、r2 无新证明拒绝、r2 重新验证通过、伪造 wake 版本/外任务 wake/无记录版本均拒绝；S03 单测：未知排/未知板/未知孔/scope 排、混合指标拒绝并点名、有效对照仍通过）；`skills.test.ts` + `skills-e2e-fences.test.ts` 31/31（fences 新增两个真实 Runtime 调度器级用例：S02 r1→r2 completeGate 工具与 runTurn 回合效果都拒绝、r2 重新验证后完成；S03 零孔核对拒绝，工具与效果都不 completed）；q04 脚本 `old_revision_monitor_evidence_cannot_complete_new_goal` pass（before_gate_ok:true 正对照保持，after_gate ok:false goal_unverified、reasons 明确 revision 1→2 需重新登记/验证、task_status 非 completed、fired_wake_revisions:[1]）、`nonexistent_metric_row_cannot_complete_with_zero_checks` pass（goal_unverified，reasons 点名 row 'Z'，任务未完成）。已知边界：调度器调用 verifyGoalSatisfied 时未传 firedWakes（scheduler.ts 属并行工程师领域），生产路径的 wake 账本交叉核对目前只由单测驱动，生产防线由 plan_revision 一致 + 服务端经 verifySkillStep 写入的 evidence 版本/步骤绑定承担。
- **§3 夹具** `scheduler.ts` + `model-stub.ts`：`handleDeviceEvent` 与 `replayAttributedObservations` 两处 observation.recorded 事件 payload 补上确切生产动作 action_id（置于首位以保证落在回合简报 600 字符 JSON 切片内），实现观测→动作的显式 ID 关联；StubMemory 从 observation.recorded 摘要按 observation_id 记录确切 producerActionId（删除 `brief.scans.at(-1)` 顺序猜测）；stale-observation 扰动仅在确切生产者已知时发动，替换 evidence_refs 时把该生产者加入 action_ids，只破坏新鲜度。诊断还暴露第二个顺序隐患：重试路径靠 scanIds（按回合内已见成功扫描推断）引用观测，但观测摘要与其生产扫描终态可能分属不同回合简报（failing dump：obs-001-004 摘要在 req13 简报而 act-001-05 终态在 req14）——step-0/step-1 的 done 记录统一改为引用每个被引观测的确切生产者（producersOf），且仅在生产者已 succeeded 时才把观测当作可引用证据（否则引用运行中动作被 gatherCitedActions 以 action_not_terminal 拒绝、缺生产者以 observation_not_from_step_action 拒绝）；uncited-producer 扰动通过 excludeActions 继续排除确切生产者，保持 observation_not_from_step_action 语义。skills-e2e.test.ts 断言零改动（git diff 对 HEAD 无差异），skills.ts/goal.ts/evaluateConditions 未动。验证：typecheck 0 错误（期间 2 个 TS2532 位于并行子代理新建的未跟踪文件 skills-e2e-fences.test.ts:375/:432，稍后重跑即消失）；审查点名的 "an OLD observation" 用例连续 5 次全部退出 0（另加 5 次加固 + 整文件 1 次共 11/11；修复前同循环 11 次中失败 2 次 observation_not_from_step_action）；整文件 9/9（32.1s）；observation_not_from_step_action 独立用例（PRODUCING SCAN is not cited）5 次隔离 + 整文件 1 次全部通过；用 /tmp 下 1:1 复刻审查诊断包装（同 parseBriefs 字段，不改 reports/**）验证每个 observation.recorded 摘要携带确切 action_id（obs-001-001→act-001-001，审查脚本记录的 observation_action_id 由 null 变为确切值，且在 600 字符切片内可解析）；失败 dump 复盘确认扰动回合拒码为 observation_stale（生产者已引用），此前失败由重试回合误拒引起。说明：修复中途一次整文件后台运行中 uncited 用例曾 120s 超时（当时为未加 obsCitable 门控的中间版本、且后台与其他代理并发），最终代码下该用例 6/6 通过；审查脚本 q04-review-reproduce 运行会按其 finally 块重写 `long-lived-q04-review-reproductions.json`（脚本固有行为），stale-fixture-inspect.mjs 会覆写 reports/ 下 citations JSON，故未重跑、以 /tmp 复刻取得等价字段。

复审结论：approved，残留 4 项 low——① scheduler.ts:1726 生产完成路径 `evaluateTaskCompletion` 调 verifyGoalSatisfied 未传 firedWakes，S02 的 wake 账本交叉核对（skills.ts:1174-1180）只在单测里生效（防御纵深缺口而非验收破坏，已核实 evidence 无模型可写入口）；② scheduler.ts:772 settling 整样本仍参与条件评估（修复前评估器本就无质量门，"保留质量语义"实现为在 wake.fired 透出 quality 而非门控；契约只有整样本单标志、已注释论证，契约提供逐通道质量后需重审）；③ skills.ts:1107 退化状态下零孔静默通过理论可达（观测指标无 row_id/well_id、scope.plates 为空且设备无任何板时零 entries 零 problems；演示 Runtime 恒有 plate-01，正常路径不可达）；④ skills.ts:1092 指标自带 row_id/well_id 时不再校验 scope.rows 中声明但未被引用的未知排（无 row_id 指标与混合无效指标路径已正确拒绝）。

### dog food 内部试用

报告：`reports/review/dogfood-report.md`（截图与原始记录 `reports/review/dogfood/`）。六条旅程全部走真实链路：

- 旅程1：supervisor 契约客户端建会话/委托 A 排维护任务，轮询 status + 真实 SSE 订阅直至任务完成（5 扫描/10 回合/103 事件），完成后回放事件并发聊天消息。
- 旅程2：Playwright Chromium 配对打开 workbench → Agent 面板，观察会话列表/状态 chips/任务计划与证据/对话/事件流，发送聊天消息并收到助手回复。
- 旅程3：连建两个任务验证 FIFO 排队（T2 queued position 1、排队 pause 被拒 task_queued）与 T1 终态后自动晋升（task.handoff_cleared → task.promoted），并受控复测 UI 队列卡片渲染。
- 旅程4：speed 1 捕获在途 media.add 后 pause（设备动作继续跑完、模型回合冻结、UI 已暂停 chip）→ resume（补跑复查扫描）→ 在途扫描上 cancel（任务 cancelled、设备动作 cancelled、Runtime 不受影响）。
- 旅程5：模型经 register_wake 布防温度阈值条件，带内 8 个真实采样不唤醒，operator set_targets 32°C 真实物理跨越后 wake.fired（35.163 / quality settling）→ condition 触发回合并落确认消息。
- 旅程6：media.add 在途时 SIGKILL Agent（设备照常完成动作），同端口/数据目录重启后 <1s 恢复：会话历史不变、任务与预算续行、46 个幂等键全唯一、复查扫描恰好一次、聊天可用。

试用发现缺陷（本轮仅记录，未修复）：

- **supervisor API（medium）**：GET /tasks/:id 返回裸任务行，task.plan 恒为空（supervisor-api.ts:75-77，对比 sessions-api.ts:330 含 plan 与 evidence_refs），且该 GET 未列入契约自描述 operations（supervisor-api.ts:47）。
- **scheduler（medium）**：计划被模型反复提交又被反复拒绝时无上限护栏，任务无限循环「invalid_plan 拒绝→30 sim s 重试」，永不 needs_input/failed，烧模型回合直至 200 回合预算兜底（J3/T2 实测卡 waiting_condition 直到手动取消）；max_corrections 仅在 goal.ts:33,110 解析，全仓库无执行点。
- **UI（low）**：任务终态时 Agent 面板渲染字面量 null 文本两处（恢复 Agent 按钮与预算 chip 之间、创建监测任务按钮前）；根因 web/panels/agent.js:301,319 的 `replaceChildren(..., null, ...)`（h() 有 null 过滤而 replaceChildren 没有）；截图 `reports/review/dogfood/j2-agent-panel.png`。
- **GoalSpec/UX（low）**：deadline_sim_s 是绝对仿真秒而 UI 一键模板写死 93600（26 模拟小时）：sim 时钟超 26 h 后点「创建监测任务」任务出生即过期、监测窗口为零（绝对语义实测于 J1；出生即过期为代码+桩行为推断，样例先撞上 invalid_plan 循环）。
- **UI（low，疑似竞态未复现）**：J3 一次性观测 API 侧确认 T2 queued（晋升发生在 0.8 s 后）但 Agent 面板未渲染队列卡片；J4 受控复测（speed 20、等待 >5s 轮询周期）正常，未定位代码路径，低置信度记录。
- **stub（low）**：无任务会话的聊天回复把内部 REST 路径暴露给最终用户（model-stub.ts:279 固定文案原样出现在产品 UI 对话里，J1/J2 各观测一次；属显式测试夹具行为）。

第四轮最终顺序验收：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（退出码 0） |
| `npm test`（完整单测） | 通过（退出码 0） |
| 审查脚本 `long-lived-q04-review-reproduce.mjs` | 通过（退出码 0） |
| 审查脚本 `long-lived-n05-review-reproduce.mjs` | 通过（退出码 0） |
| 审查脚本 `long-lived-r08-review-reproduce.mjs` | 通过（退出码 0） |
| 审查脚本 `long-lived-reacceptance-reproduce.mjs` | 通过（退出码 0） |
| 审查脚本 `long-lived-reacceptance-ui-reproduce.mjs` | 通过（退出码 0） |
| 审查脚本 `long-lived-reproduce.mjs` | 通过（退出码 0） |
| 审查脚本 `long-lived-http-reproduce.mjs` | 通过（退出码 0） |
| 审查脚本 `long-lived-ui-reproduce.mjs` | 通过（退出码 0） |
| `npm run demo:all` | 通过（退出码 0） |
| 浏览器 E2E（首轮计数） | 通过（退出码 0） |

## 第五轮：T01（long-lived-s03-independent-review.md）

同版本内把监测去抖改成 0，600 秒持续条件在约 48 仿真秒就被判完成。`monitor_until` 的步骤验证和完成判定原先只比 metric/op/value。

- 步骤验证读取已触发 wake 的真实 predicate：匹配到目标监测条件时，wake 实际要求的保持时间（显式 `debounce_sim_s`，缺省按调度器的 60 秒）不得短于目标的 `debounce_sim_s`，否则拒绝 `debounce_shortened`。更短的去抖仍可唤醒模型，但不是成功证据。通过的证据记下实际去抖。
- 完成判定再核对一遍：证据上的去抖，以及调度器现在传入的 fired wake 账本里的 predicate。旧版本证据仍按 S02 拒绝。
- 合法对照：去抖 600 的 wake 经真实采样等待 626 仿真秒后验证通过并完成。单测覆盖 0 拒绝、600/900 通过、以及“步骤已被标 done 但账本去抖为 0”时完成仍拒绝。
- S02 的 r2 恢复用例改为按新目标的 600 秒去抖重新登记（原先复用去抖 0，正是本缺陷）。

审查脚本 `long-lived-s03-review-reproduce.mjs` 修复后退出 0（短去抖拒绝且任务未完成；完整去抖在 626 仿真秒后完成）。顺序验收：typecheck 0 错误；`npm test` 209+54 = 263/263；九份审查脚本（含 s03 与此前八份）全部退出 0；demo 5/5；E2E 首轮 17/17。
