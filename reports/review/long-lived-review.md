# D0–D5 独立代码审查与验收

> **最新独立复验（2026-10-03，T01 修复后）：T01 可关闭，本轮未发现新的阻塞问题。** 原 T01 脚本 2/2、技能相关 41/41、九份既有审查脚本和 typecheck 全部通过。短去抖证据被拒，合法 600 秒等待后完成。此次为定向复验，没有重跑完整单测、E2E 和演示；上一轮完整独立结果与执行方本次全量结果在 [最新复验报告](long-lived-t01-independent-review.md) 中分别列出。真实模型/视觉及低级遗留仍保留，下文为历史记录。

> **修复状态（2026-09-30 后续轮）：** F01–F15 已全部修复。三个复现脚本已按要求改为**断言正确行为**的回归（退出 0 = 行为正确）：`long-lived-reproduce.mjs`（12 场景）、`long-lived-http-reproduce.mjs`（4 场景，真实 pi 工具协议）、`long-lived-ui-reproduce.mjs`（UI 竞态）。正式回归测试为 `services/culture-agent/test/review-fences.test.ts`。复跑结果：typecheck 0 错误、单测 177/177（原 174 + 新增回归）、e2e 17/17、演示 5/5。逐项修复明细与证据见 [long-lived-fixes.md](long-lived-fixes.md)。下文为 `22c3a97` 时的历史审查记录。

日期：2026-09-30（Asia/Shanghai）。审查提交范围：`055e9ce..22c3a97`，6 个本地提交；审查开始时工作区干净。

**结论：现有自动化检查全部通过，但不接受“D0–D5 全部完成”的验收结论。** D0 的四项原始恢复修复可以通过；长期会话正常演示已跑通，D1–D5 仍有控制、恢复、记忆和对话入口缺陷。下列问题应修复后重新验收。真实提供商、视觉上下文仍未验证/实现，原交付报告对此已有明确披露。

本轮未修改产品代码、未重置正在使用的演示数据、未推送或合并。新增的是审查报告、隔离诊断脚本及其输出。诊断脚本目前断言缺陷可复现，**不是正式通过的验收测试**；后续修复时应把它们改为预期行为回归。

## 1. 独立执行结果

| 命令 | 本轮结果 | 范围与限制 |
| --- | --- | --- |
| `npm run typecheck` | 0 错误 | 当前工作区依赖；未另做新克隆 `npm ci` |
| `npm test` | 174/174，无失败/跳过 | 并行相 164，串行进程相 10；包含 D0、长期演示、SIGKILL 恢复等已有测试 |
| `npm run test:e2e` | 17/17，4.9 分钟 | 现有 Chromium 测试；重点仍是 scripted run、场景、布局、原有 SSE；没有真实长期对话与切换会话竞态验收 |
| `npm run demo:all -- --out-dir /tmp/oscar-d0-d5-review-demo` | 5/5 | 重新运行所有演示；长期演示使用显式 HTTP 模型桩；输出隔离，未覆盖原提交演示报告 |

本轮演示摘要：[demo-summary.json](demo-summary.json)，长期演示完整数据：[session-monitor-demo.json](session-monitor-demo.json)。长时演示再次通过逐孔守恒和 26.4 模拟小时窗口。

补充诊断：

```bash
node reports/review/long-lived-reproduce.mjs
node reports/review/long-lived-http-reproduce.mjs
node reports/review/long-lived-ui-reproduce.mjs
```

- 第一项使用真实 Runtime 子进程/HTTP、真实 SessionStore/SessionManager/Executor，加显式可控 AgentBackend。重启窗口用持久数据库状态重建，**未在该精确窗口额外执行 SIGKILL**。
- 第二项使用真实 Runtime、真实 CultureAgent、真实 pi 后端，HTTP OpenAI wire 模型桩刻意延迟响应；证明问题经过实际工具协议。模型桩不代表真实提供商验证。
- 第三项使用 Chromium 加真实 `web/panels/agent.js`，显式延迟 API 夹具，隔离复现 UI 响应顺序竞态。
- 输出：[核心诊断](long-lived-reproductions.json)、[HTTP/pi 诊断](long-lived-http-reproductions.json)、[UI 诊断](long-lived-ui-reproductions.json)。总计 17 项现象记录，有些共同指向同一缺陷；下面按修复边界归为 15 项。

## 2. 需要先修复的 P1

### F01：暂停/关闭没有封住在途模型工具写入

位置：`services/culture-agent/src/executor.ts:74`、`scheduler.ts:96`、`session-manager.ts:90`、`backend.ts:119`。

Executor 校验 lifecycle、generation 和 task，却不校验 `agent_paused` 或 scheduler 是否已停止。`pause()` 只设置 flag；`stopAll()` 等待的 `done` 只覆盖主事件循环，没有等待 `turnInFlight`。pi 接收的外部 `signal` 未接到 `agent.abort()`，没有可中断的提供商等待。

实际结果：暂停状态下 `media.add` 被接受；`stopAll()` 返回后释放迟到回合，Runtime 动作数量从 1 变为 2。真实 pi 慢响应在 UI 对应的 `pause_agent` HTTP 请求成功后，仍产生 `act-001-02` 加液。

修复验收：暂停/关闭立即撤销旧回合写能力；取消实际模型请求；退出等待所有在途工具和回合；恢复创建有效的新回合信号。分别验证 session pause、task pause、close 以及暂停期间迟到响应，均零新增动作。

### F02：迟到回合效果可以覆盖取消状态和新目标

位置：`services/culture-agent/src/scheduler.ts:757`、`:789`。

`runTurn()` 返回后只判断 `stopped`，未重新验证 session lifecycle、owner generation、目标 revision 和任务终态，就写消息、更新计划/任务状态并取消 wakes。设备写工具的 revision 检查不能保护这些本地效果。

实际结果：任务已 `cancelled`，旧响应的 `complete_task` 将其改为 `completed`；用户已把 goal 从 r1 改为 r2，r1 响应仍把 r2 标为完成。

修复验收：所有回合效果及模型侧 plan/goal/wake 修改都受同一围栏保护；任务终态不可被旧回合恢复；旧回合不得完成新目标或移除新目标等待。

### F03：inbox 入库后、分发前的崩溃会丢失终态唤醒

位置：`services/culture-agent/src/session-store.ts:589`、`scheduler.ts:337`。

`recordInbox()` 插入 `received` 同时推进 cursor，随后才处理动作终态/观测。重复事件直接返回；启动没有排空 `received` 的路径，`markInboxProcessed()` 未被调度器调用。游标与“收到”原子不等于与“已完成分发”原子。

实际结果：重建“动作 succeeded 事件已入库，但尚未分发”的可达故障窗口，重启后模型调用为 0，任务一直 `waiting_device`，终态 wake 仍 armed，inbox 行一直 `received`。

修复验收：持久化输入后可幂等排空未处理行；分发/任务 wake 与已处理标记具备恢复语义；在 observation fetch 前后、终态分发前后实际杀进程，不能丢结果或重复液体效果。

### F04：恢复后 ready/running 且没有 wake 的任务不再推进

位置：`services/culture-agent/src/scheduler.ts:180`、`:188`、`:268`。

启动执行 state/intents/event catch-up 后直接等待新事件；没有检查待处理用户消息、未完成模型回合或 ready/running 任务并持久化恢复触发器。主队列、`turnQueued` 都只在内存。

实际结果：保存 ready task 后重新创建调度器，模型调用为 0，任务仍 ready。进程在任务受理后/首个回合前或思考中退出，且没有新设备终态/定时器时也会进入此窗口。

修复验收：恢复顺序完成后，对未处理消息和未完成任务注册一次可恢复唤醒；不得通过所有采样唤醒模型。覆盖首回合前、思考中、终态已消费后这三个重启位置。

### F05：realtime 写前状态/证据验证没有落实

位置：`services/culture-agent/src/backend.ts:148`、`:169`，`executor.ts:117`，`services/runtime/src/runtime.ts:371`。

`device_read_state` 返回 `input.state`，它是回合开始时的快照。写前不重新读取设备状态，不提交 `expected_revisions`；写工具没有把扫描 observation refs 传到 host。service principal 的液体动作也不要求 evidence，而原 run principal 要求。

实际结果：真实 pi 请求发送后，人工加液使板 revision 改变；迟到模型仍成功加液，`evidence_refs=[]`。这里还同时复现 F01；提交前没有状态/证据围栏是独立缺陷。

修复验收：读取工具真正读取权威状态；写前确认版本和证据，使用 Runtime 原子 revision/freshness 检查封住读写间竞态。人工维护发生在模型思考期间时，旧决定应拒绝并重规划。

### F06：pending intent 跨任务复用，破坏动作归属和恢复账目

位置：`services/culture-agent/src/executor.ts:106`，`session-store.ts:651`。

pending lookup 只按 session 和 canonical 匹配，没有 task/revision/operation identity。旧任务取消后，新任务发出同样参数会拿到旧任务的 key；写后预算计到新任务，intent 仍指向旧任务。key 还依赖 `actions_used+1`，而 insert 使用 `OR IGNORE`，不能作为可靠操作编号。

实际结果：task-464f7df2-2e5 的加液被记在已取消 task-a1e25e1e-7ca 的 intent 下，动作 `act-001-04`。新任务的在途查询/取消按 task_id 过滤，无法正确拥有这个动作。

修复验收：使用持久 operation_id 区分逻辑操作；精确按 task/step/revision 恢复同一请求；旧任务不确定效果先对账再开始新任务；action 关联和预算记账幂等、原子。覆盖失败请求后改参数以及旧任务取消后新任务同参数。

### F07：needs_input 在没有用户补参时被创建通知解除

位置：`services/culture-agent/src/sessions-api.ts:237`、`:244`，`scheduler.ts:590`。

创建不完整任务先设 `needs_input`，却立即调用 `onUserMessage()`。调度器把所有 message 类通知当“input received”，直接将任务改为 running，没有验证是否有新用户消息或必需参数已补齐。

实际结果：没有 metrics/monitoring 的任务、用户消息数为 0，仍接受 `media.add`，产生 `act-001-07`。

修复验收：区分 task_created、goal_updated 和真实用户补参；补参完成前始终禁止设备写；模型可以询问并生成候选 GoalSpec，但必须经参数检查才能执行。

### F08：HTTP 修改目标不会重新调度，旧等待条件不失效

位置：`services/culture-agent/src/sessions-api.ts:303`、`supervisor-api.ts:270`。

修改 API 只更新 revision、写 session event。该事件通知浏览器，不进入 scheduler 唤醒队列；“旧等待失效”的注释没有对应操作。

实际结果：r1 任务等待 `sim=1e9`，HTTP 更新到 r2 后模型调用仍为 1，旧定时器仍 armed。紧急缩短期限/调整阈值可能长期没有效果。

修复验收：目标修改必须持久入队、撤销旧 goal 等待、保留已提交动作对账；在安全边界及时按新目标重规划；用户和 supervisor 使用相同路径。

### F09：压缩会遗忘用户约束，旧 checkpoint 也不持续继承

位置：`services/culture-agent/src/backend.ts:366`，`scheduler.ts:839`，`sessions-api.ts:398`。

压缩仅保存 task.goal_text、消息数量和少数动作事实；用户陈述式限制没有进入 summary，open_questions 只取以 ASCII `?` 结尾的最近问题。下一次压缩也没有输入旧 checkpoint 内容；组装模型上下文只使用 summary，不读取 checkpoint 其余事实/开放问题。

实际结果：“任何时候不要使用 media-02，只准 media-01。”经压缩完全消失。原始消息虽保留，但 covered watermark 之后模型不再收到它，查询能力也没有补上。

修复验收：保留有来源的稳定约束、未解决问题、前一 checkpoint、等待条件和未完成计划。至少两轮压缩后验证模型实际上下文仍含用户限制并且工具执行受限制；不能只断言 summary 含 `Task goal`。

### F10：归档检测及 supervisor 写边界不完整

位置：`services/culture-agent/src/scheduler.ts:221`，`supervisor-api.ts:252`、`:278`。

watchdog 对无 armed wake、无在途回合的 session 直接跳过；恢复也没有全面验证实验 status。空闲会话在 reset 后可能一直 active。另一方面 supervisor task update/control 没有检查 session.lifecycle，resume 也不检查 task 是否终态。

实际结果：任务取消、无待办时 reset，经过完整 watchdog 周期旧 session 仍 active；独立将夹具 session 标为 archived 后，经真实 supervisor HTTP 仍能把 goal 改为 r2、把已取消 task 改成 waiting_condition。后一个测试为隔离授权边界使用显式归档，不冒称自动归档成功。

修复验收：所有 session 都能获知 reset/archive；各写入口统一生命周期/终态检查，归档读可用、写拒绝；completed/failed/cancelled 不可由普通 resume 复活。

### F11：自然语言无法在空会话中建立任务

位置：`services/culture-agent/src/backend.ts:143`、`:415`，`web/panels/agent.js:278`。

这是源码确认的产品路径缺失，尚未另做真实提供商试验。没有任务时设备 tools 被过滤，agent tools 没有 create_task；system prompt 明确要求让用户调用 session task API。浏览器只提供固定 A 排演示按钮；持续聊天不会从用户目标形成新 Task。第一项任务完成后，UI 仍有 terminal task，也不再显示 `!task` 才显示的创建按钮。

因此“新会话描述一个非预设目标 → 补参 → 建立任务”和“上一任务结束 → 继续对话建立下一任务”均没有完整产品入口，不能把它归为仅需要真实模型验证。

修复验收：增加受范围/参数/授权检查的目标草稿/任务创建工具或服务流程；从聊天建立任务、补参数、结束后追加下一任务。至少两个预设演示以外的已支持目标组合通过同一真实工具协议验收。

## 3. P2

### F12：累计模型预算没有执行门槛

位置：`services/culture-agent/src/scheduler.ts:544`、`:760`。

预算仅进入 prompt 并在回合后累计，没有调用前限额判断。设置 max_model_turns=1，实际执行 3 回合，计数 3/1。应在模型调用前持久预留/拒绝预算，恢复不能绕过；校验 API 预算值，并定义 requests 与 turns 的计量边界。

### F13：切换会话后旧 HTTP 响应覆盖新会话

位置：`web/panels/agent.js:180`。

刷新捕获的请求没有 selection generation/id 检查。Chromium 复现：先请求归档 A 并延迟响应，切回 B，再释放 A；选中按钮是 exp-B，聊天显示 `MESSAGE FROM session-A`，B 的设备在线状态也被 A 的归档状态覆盖成不可达。截图：[long-lived-ui-race.png](long-lived-ui-race.png)。关闭旧 SSE 不会取消在途 HTTP。

修复验收：selection generation 和 request generation 同时保护 detail/status；dispose 后禁止迟到写；测试反向响应、轮询重叠、归档切换。

### F14：任务创建 request_id 在 HTTP 层不幂等

位置：`services/culture-agent/src/sessions-api.ts:229`，`supervisor-api.ts:169`。

active-task 检查先于 Store 的 request_id 去重。相同请求重发得到 409 task_already_active，而不是原 task_id。响应丢失的上层客户端无法使用承诺的幂等重试。应先查 request_id、核对原请求内容，再处理新任务的排队/单任务限制；覆盖两套 API 的重复创建与完成后重试。

### F15：扫描孔位绕过 row scope

位置：`services/culture-agent/src/goal.ts:141`。

scope 只检查 args.row_id，imaging.scan 使用 wells 数组。授权 A 排的任务能扫描 B1；真实 Runtime 受理。应按能力语义检查扫描孔位属于授权 rows，并验证同一作用范围规则用于读取、证据和写动作。

## 4. 交付范围与尚缺验收

| 阶段 | 本轮判断 |
| --- | --- |
| D0 | 四项原始修复通过；新 session/pi 关闭问题见 F01，不与旧 RunLoop 回归混淆 |
| D1 | schema/唯一绑定实现；inbox 消费恢复、intent 归属、HTTP 创建幂等未通过 |
| D2 | realtime 正常事件闭环跑通；暂停/关闭、精确崩溃窗口、首回合恢复和目标变更未通过 |
| D3 | pi 真实工具协议实现；完整自然语言建立任务、缺参保护、稳定记忆、写前 freshness 未通过；真实提供商/图片上下文仍未验证或实现 |
| D4 | 会话面板和 supervisor 基础接口实现；会话迟到响应与归档写边界未通过 |
| D5 | 原检查命令全绿；这些补充边界未覆盖，因此不能代表完整 D0–D5 产品验收 |

另有范围缺口：设计要求同会话额外任务排队，HTTP 目前直接拒绝第二项 active task；技能仅保存自由字符串步骤，没有设计要求的明确前置/后置校验实现。这些应在下一轮说明是否实现或与用户明确缩小 MVP，不能因有表字段就算完成。

优先顺序建议：F01/F02/F07 写围栏与缺参保护 → F03/F04/F06 持久恢复 → F05/F08 新鲜度与目标修改 → F09/F10/F11 长期产品路径 → P2 与全量回归。先加入相应预期行为测试，再修复；保留原来 174、17、5 的检查覆盖。
