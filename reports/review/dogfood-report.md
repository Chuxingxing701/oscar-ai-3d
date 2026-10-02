# OSCAR 虚拟培养系统 — 内部试用（dog food）报告

- **日期**：2026-10-02
- **试用者**：内部试用用户（第一次使用本系统，熟练工程师）
- **分支**：`feat/b-framework`（含未提交改动，试用即当前工作树）
- **方式**：像真实用户一样把系统用一遍，不跑测试套件。真实 Runtime + 真实 Culture Agent 双进程 + HTTP 模型桩（`services/culture-agent/test/model-stub.ts`，真实 OpenAI wire/工具协议），全部数据与进程隔离在 `/tmp/oscar-dogfood`（已清理）。
- **起栈方式**：参照 `docs/IMPLEMENTATION_STATUS.md`、`docs/API_CONTRACT.md` §10 与 `reports/review/live-demo.mjs`：先探明空闲端口 → 起 Runtime（`--clock-mode realtime --scenario routine_maintenance --seed 42 --agent-url …`）→ 起 Agent（`OSCAR_MODEL_BASE_URL` 指向模型桩）→ 等待 `OSCAR_RUNTIME_READY` / `OSCAR_AGENT_READY`。浏览器旅程用 Playwright Chromium（`channel:'chromium'`，参照 `tests/e2e/agent.spec.ts` 的配对进入方式）。
- **证据**：截图与结构化结果已归档在 [reports/review/dogfood/](dogfood/)（`j1`~`j6` 结果 JSON、`j2-agent-panel.png`、`j4-queue.png`、`j4c-paused.png`、`j4c-after-cancel.png`、`stack.json`、`launch.log`）。临时目录与全部子进程已清理（`pgrep` 确认无 `main.ts` 残留进程）。
- **未执行**：完整 `npm test` / `test:e2e` / `demo:all`（按本次任务要求留给工作流统一执行）。产品代码零修改。

---

## 旅程 1：supervisor 契约客户端委托培养任务（直至完成）

**做了什么**：仿照 `tests/supervisor-contract.test.ts` 的客户端形态，用纯 fetch 走 `/api/v1/agent/supervisor/v1/*`：`GET /overview` → `POST /sessions`（建会话，重复调用验证幂等）→ operator 把时钟调到 speed 600 → `POST /sessions/:id/tasks` 委托「A 排 ≥ 330 µL、每 600 sim s 检查、期限 2400」→ 边轮询 `/status` 边开一条真实 SSE 订阅（`/api/v1/agent/sessions/:id/events`，走 Runtime 网关 + operator Bearer）直到任务完成 → 完成后回放全部事件、查任务详情、再发一条聊天消息。

**看到什么**：
- 契约版本 `1.1.0`；会话创建幂等（重复 create 返回 `created:false` 且同一 `session_id`）。
- 委托**立即**返回 `task_id`（202），没有等待——长任务体验符合契约承诺。
- 任务 ~13 墙秒完成：5 次 `imaging.scan`、10 个模型回合、预算 5/40 动作，液位判定「No operation needed: minimum 378.85 µL ≥ 330」逐轮出现在会话消息里。
- SSE 全程直播：103 帧（`task.created`、`wake.armed/fired`、`action.submitted/result`、`observation.recorded`、`message.appended`、`turn.completed`、`loop.state`、`plan.updated/step`、`task.handoff_cleared`…），完成后再订阅 `after_seq=0` 能完整回放 103 条，`last_seq` 一致。
- `/status` 的 loop 状态流转清晰：thinking → waiting_device → waiting_condition →（唤醒）→ … → idle；下次唤醒目标（`sim_time@1614`）与预算都可见。

**别扭/出错**：
- 完成后聊天「请总结一下这轮维护」，回复是固定话术 `"No active task in this session. Create a task (POST /sessions/:id/tasks) and I will drive it."`——把内部 REST 路径直接抛给最终用户（模型桩话术，见缺陷 6）。
- **缺陷 2**：supervisor `GET /tasks/:id` 返回的是裸任务行，`task.plan` 为空数组；同一任务走会话 API `GET /tasks/:id` 却有完整 3 步计划与 `evidence_refs`（`scan_and_assess done · obs-001-001` 等）。总助手视角看不到任何执行证据，且这个 GET 也没列入契约自描述 `operations`。

## 旅程 2：Playwright Chromium 打开 workbench / Agent 面板，观察 + 聊天

**做了什么**：operator token 申请一次性配对码 → 浏览器打开配对链接 → 进入 workbench → 点「Agent」标签 → 观察会话列表/状态/对话/任务卡/事件流 → 在持续对话输入框发一条「帮我看一下当前 A 排液位怎么样？」。

**看到什么**：
- 会话列表按实验列出（🧬 exp-001）；状态行 chips 齐全：`Agent：空闲`、`设备在线 · realtime · sim 18时16分`、`模型 pi-0.84.0`，下一行是等待原因/下次唤醒/在途动作/消息 seq/事件 seq/inbox 游标。
- 任务卡显示 `task-84699c4… 已完成 goal r1`，计划三步 `scan_and_assess ✓ · 证据 obs-001-001`、`exchange_row_and_verify skipped`、`monitor_until ✓`；预算 chips `动作 5/40 · 模型回合 10/200`。
- 对话气泡完整回放了旅程 1 的全部决策消息；事件流日志 80 条在滚动。
- 聊天：输入框回车即发送，用户气泡 + 助手回复（2 个新气泡）都出现了；无页面 JS 错误、无场景投影错误（`oscarScene.updateErrors()` 为空）。
- 「暂停 Agent（停决策）」「恢复 Agent」「取消任务」三个控制分离清楚；记忆检查点显示「无」（未发生压缩，正常）。

**别扭/出错**：
- **缺陷 1**：面板里出现两处字面量 `null` 文本——「恢复 Agent」按钮与「预算」chip 之间一个、「创建监测任务」按钮前一个（截图 `j2-agent-panel.png`；DOM 证据 `<button ...>恢复 Agent</button>null<span class="muted">预算：…`）。任务处于终态时必现。
- 会话聊天回复同样是把内部 API 路径甩给用户的桩话术。

## 旅程 3：连建两个任务，验证排队与晋升展示

**做了什么**：趁无当前任务时连建 T1（A 排 ≥ 420，会真实补液）与 T2（B 排 ≥ 100，仅 imaging.scan）；验证排队任务的 pause 被拒；开浏览器看队列卡片；等 T1 完成，观察 T2 自动晋升；事后受控复测 UI 队列渲染。

**看到什么**：
- T1 返回 `status:'ready'`（立即执行），T2 返回 `status:'queued', queue_position:1`——完全符合契约 §10.1.1。
- 对排队 T2 执行 pause：409 `task_queued`（「排队任务未持有执行槽」），语义正确。
- 晋升链路事件完整：T1 `task.status completed` → `task.handoff_cleared {reason:"turn finished"}` → `task.promoted {queue_position_before:1}` → T2 `ready → running(task_promoted) → waiting_condition`，`/status` 的 `queue` 变空。
- 受控复测（speed 20、T3 当前 + T4 排队等了 7 s）UI 队列卡片正常：`任务队列（FIFO）· 1 个排队任务 · #1 排队中 task-da68767… + 「取消排队」按钮`（截图 `j4-queue.png`）。

**别扭/出错**：
- **缺陷 5（疑似竞态，未复现）**：J3 第一次查看时，API 侧 T2 明确还在排队（晋升发生在 ~0.8 s 之后），但 UI 面板没有渲染队列卡片；J4 受控复测正常。未定位，低置信度记录。
- **缺陷 3**：T2（`allowed_operations` 只有 `imaging.scan` 的合法监测任务）被模型的标准三步计划卡死：`step 1 exchange_row_and_verify` 需要 media.add/media.exchange，整计划被 `invalid_plan` 拒绝，模型每 30 sim s 原样重试，会话消息连刷 `"Refused: REFUSED invalid_plan: step 1 (exchange_row_and_verify@1): none of media.add, media.exchange is in the goal's allowed_operations."`，任务永远停在 `waiting_condition`，直到我手动取消。系统侧没有任何「重复拒绝」护栏（`max_corrections` 只在 `goal.ts:33,110` 被解析，全仓库无执行点）。

## 旅程 4：暂停 → 恢复 → 取消任务，观察状态与设备动作

**做了什么**：speed 1（让 media.add 占 ~20 墙秒、可被人眼/脚本追上）→ 建「A 排 ≥ 540」任务 → 捕获在途 `media.add` 的瞬间 pause → 观察任务/loop/设备三者 → 等 设备动作自行跑完 → 验证暂停期间模型回合冻结 → resume → 在下一个在途扫描上 cancel。

**看到什么**：
- pause 落在 `media.add`（act-001-42）running 时：任务 `paused`、loop 停决策、**设备在途动作 1 个继续跑**，UI「已暂停」chip 出现（截图 `j4c-paused.png`）——「暂停任务 ≠ 急停设备」的语义如实呈现。
- 暂停期间该 media.add ~29 墙秒后 `succeeded`（补液完整提交）；模型回合数 2 → 2 冻结，无泄漏。
- resume 后，被扣住的 action_terminal 唤醒立即补跑，提交了复查扫描 act-001-43。
- cancel 压在 act-001-43（queued）上：任务 `cancelled`、设备动作转 `cancelled`（`partial:false`，扫描无液体效果）、loop 回 `idle`、Runtime 时钟不受影响继续走。
- 暂停期间还出现一次 `turn.completed {ok:false, code:"stale_turn"}`（暂停落在回合中途）——被正确丢弃，没有半写。

**别扭/出错**：
- 可用性观察（非缺陷）：演示常用速度（600）下 media.add 只占 ~1 墙秒，真实用户几乎不可能在动作进行中点中「暂停/取消」；想做「过程干预」演示必须先把倍率降到个位数，而 UI 里没有任何提示。
- J4 第一次尝试在 speed 20 下用 150 ms 轮询追 media.add 两次都没追上（动作仅 ~1.5 墙秒）——同上，窗口太窄。

## 旅程 5：登记温度阈值条件（S01 修复的真实事件路径）

**做了什么**：建一个监测型任务（goal 描述含「温度」，让桩在首轮通过 `register_wake` 布防 `temperature_c below 35.5, debounce 0`）→ 先观察带内窗口（241 sim s、8 个真实 `environment.sampled`）确认采样本身不唤醒模型 → operator 提交 `environment.set_targets {temperature_c:32}` 让世界物理真实降温跨越 → 盯会话事件等 `wake.fired` 与条件触发的回合。

**看到什么**：
- 首轮布防成功：`wake.armed {kind:'condition', predicate:{metric:'temperature_c',op:'below',value:35.5,debounce_sim_s:0,…}}`（seq 1630）。
- 带内 241 sim s：模型回合 1 → 1，真实采样流**没有**引起任何唤醒（S01 修复的核心保证成立）。
- 降温跨越后：`wake.fired {kind:'condition', metric:'temperature_c', value:35.163067, threshold:35.5, quality:'settling', sim_time_s:181800}`（seq 1635）→ `turn.completed {trigger:'condition'}`（seq 1640）→ 确认消息「温度阈值已触发并确认（wake: condition）」落进对话。fire 时刻腔室观测 32.03 °C，事件携带的是**第一个越界采样**的读数——证据链真实。
- fire 后 `armed_wakes` 清空：latch 生效（cooldown 100000 内不重布防）。我的桩没有再布防，任务只能等 100000 sim s 的 interval 兜底——真实模型需要在确认回合重新 `register_wake` 才能持续守护，这是模型侧责任，系统行为正确但值得在文档里写明白。

**别扭/出错**：
- 自踩坑一枚（记录给后来的试用者）：会话事件接口 `format=json` 默认 `limit=1000`，长会话里 fire 事件在 seq 1635，第一版脚本没翻页导致「以为没触发」。分页本身工作正常，但长会话场景下这个默认值很容易踩。

## 旅程 6：重启 Agent 进程验证续行

**做了什么**：speed 1 建「A 排 ≥ 582」任务（当时 A 排 min 551.8，强制补液）→ 捕获在途 `media.add`（act-001-47）的瞬间 `SIGKILL` Agent（pid 561041）→ 等设备把动作跑完再冷启动 Agent（同端口/同数据目录/同模型桩）→ 验证会话、任务、预算、幂等键、续行决策、聊天。

**看到什么**：
- Agent 死透期间设备照常：media.add `succeeded`（补液效果完整落库），Runtime 时钟不停。
- 重启后 <1 墙秒恢复服务（HTTP 200）；会话历史分毫未动（50 messages → 50）。
- 任务自动恢复：状态 `waiting_device`，错过的 action_terminal 被补消费，重启后恰好提交一次复查扫描 act-001-48；预算连续（actions 0 → 3、turns 1 → 4）。
- 全量 46 个 service 动作幂等键**全唯一**——重启对账没有双发。
- 重启后聊天、取消任务一切正常。
- 期间 launcher 日志出现一行 `AGENT_EXITED unexpectedly`（我的 SIGKILL 所致，符合预期）。

**别扭/出错**：无明显问题；这条旅程体验最好。

---

## 缺陷清单

| # | 区域 | 现象 | 严重度 | 复现步骤 / 证据 |
| --- | --- | --- | --- | --- |
| 1 | UI（web/panels/agent.js） | Agent 面板渲染字面量 `null` 文本（两处） | low | 完成任一任务（或任务进入 completed/failed/cancelled）后打开 workbench → Agent 标签：「恢复 Agent」按钮与「预算」chip 之间、以及「创建监测任务」按钮前各出现一个 `null` 文本。DOM：`<button ...>恢复 Agent</button>null<span class="muted">预算：…`。根因：`agent.js:301`、`agent.js:319` 的 `replaceChildren(..., 条件?节点:null, ...)` 会把 null 字符串化为文本节点（`h()` 内部有 null 过滤，`replaceChildren` 没有）。截图 `dogfood/j2-agent-panel.png` |
| 2 | supervisor API | `GET /tasks/:id` 返回裸任务行，无 plan/证据，与会话 API 不一致，且未列入契约自描述 | medium | supervisor `GET /api/v1/agent/supervisor/v1/tasks/{id}` → `task.plan == []`；同 id 走会话 API `GET /api/v1/agent/tasks/{id}` → plan 3 步含 `evidence_refs`。代码：`supervisor-api.ts:75-77`（直接 `{contract_version, task}`）vs `sessions-api.ts:330`（含 plan）；自描述 operations 列表 `supervisor-api.ts:47` 无 GET tasks。总助手委托方完全看不到执行证据 |
| 3 | scheduler/执行器护栏 | 计划被模型反复提交又被反复拒绝时无上限：任务无限循环「拒绝→30 sim s 后重试」，永不 needs_input/failed，持续消耗模型回合（兜底只有 200 回合预算） | medium | 建任务 goal_spec：`allowed_operations:['imaging.scan']`（合法）+ 常规 metrics/monitoring。模型（桩）发布标准三步计划 → `invalid_plan: step 1 (exchange_row_and_verify@1)` 拒绝 → 会话消息连刷 `Refused: REFUSED invalid_plan …`（J3/T2 实测，任务卡 waiting_condition 直到手动取消）。`max_corrections` 仅在 `goal.ts:33,110` 解析，全仓库无执行点 |
| 4 | GoalSpec 语义/UX | `deadline_sim_s` 是**绝对**仿真秒（`goal.ts:31`「sim clock domain by definition」），而 UI 一键模板写死 `deadline_sim_s:93600`（26 模拟小时，`agent.js:28`）：sim 时钟跑过 26 h 后再点「创建监测任务（…期限 26 模拟小时）」，任务**出生即过期**，监测窗口为零 | low | 绝对语义已实测（J1：deadline 2400 于 sim 355 创建，窗口到 2400 为止）。过期即完成路径未直接观测（我的 T2 样例先撞上缺陷 3），为代码+桩行为推断：`model-stub.ts` `until = goal.deadline_sim_s`。用户直觉是相对时长，建议 UI 提供相对输入或显示绝对时刻 |
| 5 | UI（疑似竞态，未复现） | 一次 API 确认存在排队任务（queue_position:1、晋升 0.8 s 后才发生）但 Agent 面板未渲染队列卡片；受控复测（speed 20、等待超过 5 s 轮询周期）正常 | low | J3 一次性观测（`j3-result.json` `queueCardShown:false`），J4 复测 `queueCardShown:true`。未定位到代码路径，低置信度记录 |
| 6 | 模型桩话术 | 无任务会话的聊天回复把内部 REST 路径暴露给最终用户（"Create a task (POST /sessions/:id/tasks)"） | low | J1/J2 各观测一次；`model-stub.ts:279` 固定文案。属显式测试夹具行为，但该文案会原样出现在产品 UI 的用户对话里，对外演示时观感差 |

**非缺陷观察**（不列入 defects）：
- 演示速度（600×）下设备动作仅占 ~1 墙秒，「在动作进行中暂停/取消」的演示必须先降倍率；建议演示脚本或 UI 提示。
- 低速（1–20×）下每个监测周期会扫两次（action_terminal 与 observation.recorded 分属两个 brief，桩的策略会补扫一次），多耗动作预算——桩策略与事件时序叠加，非产品错误。
- 长会话事件流 `format=json` 默认 `limit=1000`，翻页是调用方责任（我踩过）。
- 条件唤醒 fire 后 latch+cooldown 生效、armed_wakes 清空；持续守护需要模型在确认回合重新布防——系统行为正确，建议在用户文档说明。

## 总体印象

六条旅程全部走通，没有出现数据丢失、双发、死锁或崩溃；最亮眼的是旅程 6（SIGKILL 续行：设备不停、历史不动、幂等键全唯一）和旅程 5（真实采样→条件唤醒→回合，S01 修复在产品路径上成立）。排队/晋升/暂停/恢复/取消的任务状态机与文档一致，UI 的三控制分离（暂停 Agent ≠ 取消任务 ≠ 暂停 Runtime）清楚。短板集中在「收尾体验」：任务终态后 UI 的 null 文本、supervisor 看不到证据、以及模型反复犯错时系统缺少兜底护栏。
