# F01–F15 修复后的独立复验

日期：2026-10-01，Asia/Shanghai。基线为 `feat/b-framework` 的 `22c3a97`，审查对象是当前未提交修复（10 个已跟踪文件，另有新增正式回归与审查文件）。

**结论：不通过整体验收。** 实现方的三个修复回归脚本和 177 个单测通过，但独立补充验证发现 6 类剩余缺陷；任务排队与技能前置/后置校验两项原设计要求仍未实现。用户已明确要求“保留原设计要求，补齐后验收”，不能将这两项降为可选功能。

本轮只新增审查报告、隔离验证脚本与结果，未修改产品代码、未提交或推送。进程、SQLite 和演示输出使用隔离临时目录，不读取或重置用户当前实验。真实提供商和图片上下文的验证状态不变；本报告不把模型桩验收当成真实 LLM 验证。

## 1. 实际执行结果

| 检查 | 本轮结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | 通过，0 错误 | 当前工作区；本轮没有另做新克隆/npm ci |
| `npm test` | 177/177，无失败、取消或跳过 | 164 个并行测试 + 13 个串行测试 |
| `node reports/review/long-lived-reproduce.mjs` | 通过 | 实现方提供的正确行为断言 |
| `node reports/review/long-lived-http-reproduce.mjs` | 通过 | 包括真实 pi wire 下的慢响应拒绝与 HTTP 生命周期保护 |
| `node reports/review/long-lived-ui-reproduce.mjs` | 通过 | 跨会话迟到响应不覆盖当前选择 |
| `npm run test:e2e` | 首轮 16/17 | `motion-boundaries.spec.ts:49` 归位坐标精确相等断言失败 |
| `npm run test:e2e -- tests/e2e/motion-boundaries.spec.ts` | 定向重跑 1/1 | 保留首轮失败；不将结果表述为首轮 17/17 |
| `npm run demo:all -- --out-dir /tmp/oscar-fix-reaccept-demo` | 5/5 | 长期演示：5 次唤醒、2 次维护、5 次无需操作、模型桩 23 次请求、逐孔/储液守恒通过 |
| `node reports/review/long-lived-reacceptance-reproduce.mjs` | 退出 1，12 个正确行为断言不满足 | 7 种撤权竞态 + 不确定意图 + 补参续行 + 连续聊天 + 两个压缩用例；对应下文 R01–R05 |
| `node reports/review/long-lived-reacceptance-ui-reproduce.mjs` | 退出 1 | 同一会话响应乱序，对应 R06 |

新增脚本的通过约定也是 **退出 0 = 正确行为**，没有通过断言“缺陷存在”来伪造绿色。它们目前失败是验收结论的依据。真实 Runtime 经 HTTP 受理动作；并发窗口由可控 gate 制造，不能靠改延迟或等待采样让断言通过。

验证结果：[Runtime/调度/记忆结果](long-lived-reacceptance-reproductions.json)、[浏览器结果](long-lived-reacceptance-ui-reproductions.json)、[本轮演示汇总](long-lived-reacceptance-demo-summary.json)、[长期监测完整证据](long-lived-reacceptance-session-monitor.json)。完整命令日志位于 `/tmp/oscar-fix-reaccept-{unit,e2e,e2e-retry,extra,ui,demo}.log`；首轮失败 trace 保存在 `/tmp/oscar-fix-reaccept-e2e-failure/`。演示完整输出在 `/tmp/oscar-fix-reaccept-demo/`。

## 2. 必须修复的问题

### R01 · P1：异步读取期间撤权，执行器仍提交设备动作（F01/F02 未闭合）

位置：[executor.ts:117](../../services/culture-agent/src/executor.ts#L117)、[executor.ts:137](../../services/culture-agent/src/executor.ts#L137)。

`closed`、session lifecycle/owner、task status/goal_revision、agent pause 只在异步对账和状态读取之前检查。`await client.state()` 返回后直接沿用旧对象创建 intent、提交。新修复只拦住了“在进入 submitWrite 之前已经撤权”的情形。

独立验证先让合法扫描进入执行器，挂起真实状态读的返回，再分别进行 Agent pause、executor close、任务取消、任务暂停、目标修订、ownership generation 更新、会话归档。**七种情况均 `ok:true`，各新增一个 Runtime service 动作**（`act-001-02` 至 `act-001-08`），预期全部拒绝且零新动作。脚本先执行同参数的正常扫描作为正向对照，排除参数错误造成的假通过。

修复需在最后一个异步前置操作完成后、创建 intent/发起 submit 前重新校验所有撤权条件与修订，并使取消/关闭与写入的交接有明确顺序。`cancelTask()` 目前也在等待设备查询/取消后才标记任务取消（scheduler.ts:1228），取消开始时应先撤销旧回合写权，再处理已受理动作的结果。不要通过删掉中途暂停/取消测试规避窗口。

验收：上述七个 gate 用例拒绝；在读取和取消 HTTP 等待期间注入旧模型工具也零新动作；已受理动作照常对账，不把既有事实回滚或藏掉。

### R02 · P1：旧任务意图无法对账，却放行新任务写入（F06 部分修复）

位置：[executor.ts:117](../../services/culture-agent/src/executor.ts#L117)、[executor.ts:230](../../services/culture-agent/src/executor.ts#L230)。

发现其他任务 pending intent 后调用 `reconcileIntents()`，但无论 lookup 成功、无结果或失败都继续写；调用方不检查是否仍有不确定效果。

独立验证让真实 Runtime 接受扫描，丢弃受理响应，并持续让 by-key 查询抛网络错误。旧任务取消后，新任务仍成功提交了另一动作；此时旧任务 **1 个已受理但未绑定的 intent 仍 pending**。这证明“跨任务先对账再执行”的屏障不存在；此测试使用扫描，并不声称已经复现重复加液。

修复需明确区分“Runtime 确认未受理”和“无法知道是否受理”。后者应保留恢复状态并阻止新的副作用；恢复查询成功后按旧 intent 所属 task 绑定、记账，再继续。不能仅尝试一次 lookup 并打印错误。

验收：受理响应丢失 + lookup 连续失败 + 新任务创建的组合不会产生第二个写；lookup 恢复后正确归属且恰好一次记账；确认未受理的旧意图有明确、安全的终结/重试路径。

### R03 · P1：needs_input 补齐后没有下一回合（F07 未闭合）

位置：[scheduler.ts:1138](../../services/culture-agent/src/scheduler.ts#L1138)。

补参数回合中写和 wake 被拒绝，这是正确的保护；但回合结束把任务转为 `running` 后只刷新已有定时器，没有安排可执行回合。

独立验证通过真实 scheduler 的 `host.updateTaskGoal` 补齐参数：结果 **模型回合 1 次、任务 running、设备提交 0、armed wakes 0**。没有第二条消息或进程重启就不会继续工作。传感器采样不唤醒模型是既定要求，不能用采样补这个缺口。

验收：首次不完整任务零设备动作；用户补齐授权参数后恰好安排一次后续决策并执行/等待，无需再发“继续”或重启；不得在补参旧回合中绕过状态保护直接操作设备。

### R04 · P1：思考期间到达的聊天消息被丢失调度

位置：[scheduler.ts:749](../../services/culture-agent/src/scheduler.ts#L749)、[scheduler.ts:714](../../services/culture-agent/src/scheduler.ts#L714)。

无任务的对话回合中，第二条消息仅将 `turnQueued` 设为 true；回合结束调用的是任务专用 `scheduleTurn('queued')`，该函数在没有 active task 时直接返回。needs_input 场景也会因 queued 丢失原始 message 触发类型被 allow-list 拦住。

独立验证第一条消息模型读取历史后挂起、第二条消息入库并发起 message wake：结果 **2 条用户消息已持久化，但仅 1 次模型回合，模型没有见到第二条**。第二条消息不会自行触发后续处理。

验收：保留待处理消息的触发类型/水位，无任务聊天和 needs_input 两种状态都在当前回合结束后消费新消息；重启也不丢；已经处理的消息不重复触发设备副作用。

### R05 · P1：压缩仍会丢约束和上一 checkpoint 事实（F09 部分修复）

位置：[backend.ts:471](../../services/culture-agent/src/backend.ts#L471)、[backend.ts:482](../../services/culture-agent/src/backend.ts#L482)。

现在只保留含六个中文/四个英文 marker 的用户句子。明确约束 **“储液限定为 media-01，作用范围限定为 B 排。”** 不含这些词，压缩后 summary/facts 均无这两个限制。后续压缩也只承接 `constraint:` 前缀 facts，旧 summary 和普通事实没有被承接；上一 checkpoint 的 **“media-02 是本实验的保留对照液。”** 同样消失。

此外，`slice(-24)` 和每句 300 字截断不能默默删除仍有效的授权约束。原文保存在 SQLite 并不能解决模型上下文已经忘记约束的问题，当前也没有自动查询这些旧原文的工具路径。

验收：至少覆盖不同措辞、超过 marker 限制的约束、多轮 checkpoint 的稳定事实、长约束和约束数量边界。保留可追溯结构化约束与事实，只有显式修订/失效才能删除；强制压缩后真实工具请求仍遵守范围与储液约束。

### R06 · P2：同一会话旧响应覆盖新响应（F13 部分修复）

位置：[agent.js:192](../../web/panels/agent.js#L192)。

`selectionGen` 解决跨会话响应串扰，但同一选择下并发的 refresh 共享 generation。SSE 与轮询都会启动刷新，较旧请求晚返回仍能覆盖较新结果。

独立 Chromium 验证实际 panel 模块：先启动 version 1 的延迟刷新，再让 version 2 刷新显示，最后释放旧响应。**聊天与状态从 version 2 回退到了 version 1 / sim 1 s / seq 1。** 这会让新消息和最新任务状态短暂消失，用户可能误以为任务未执行。

验收：增加每次请求的顺序保护或按服务器水位接受结果，同时保留现有 selection generation。跨会话与同会话逆序响应两种测试均通过；status 和 detail 的一致性规则需明确。

## 3. 不能缩小的原设计要求

### R07 · P1：任务排队尚未实现

依据：[长期设计 §4.1](../../docs/LONG_LIVED_AGENT_DESIGN.md#L106)、[执行 prompt D1](../../docs/LONG_LIVED_AGENT_IMPLEMENTATION_PROMPT.md#L60)。

HTTP createTask 仍在已有任务时拒绝（[sessions-api.ts:271](../../services/culture-agent/src/sessions-api.ts#L271)、[supervisor-api.ts:224](../../services/culture-agent/src/supervisor-api.ts#L224)）；模型 `propose_task` 同样拒绝。数据库的 queue_index 与页面 queued_tasks 计数不构成可用队列，“queue via messages”也没有生成排队任务的逻辑。

补齐要求：UI/聊天/用户 HTTP/总助手复用持久队列与幂等入口；明确当前任务、排队顺序、取消队列项和晋升行为；终态后自动晋升；重启保持顺序且任一时刻只有一个任务有执行权。暂停、改目标、旧回合、reset/归档和未决意图不能让两个任务同时写。验收至少包含三任务连续完成、取消队首/中间项、暂停/恢复、进程重启、总助手委托幂等和旧回合隔离。

### R08 · P1：技能仍是文本计划，缺前置/后置校验

依据：[长期设计 §2.4](../../docs/LONG_LIVED_AGENT_DESIGN.md#L64)、[执行 prompt D3](../../docs/LONG_LIVED_AGENT_IMPLEMENTATION_PROMPT.md#L82)。

`update_plan` 接受任意 skill/version 字符串；`record_step_result` 可不提供设备动作或观测就把步骤标 done（[backend.ts:290](../../services/culture-agent/src/backend.ts#L290)、[scheduler.ts:1027](../../services/culture-agent/src/scheduler.ts#L1027)）。没有受审查的四项技能定义、参数校验、前置条件、后置观测/目标判定或失败分支。设备 action succeeded 不能等同培养目标达成。

补齐要求：给 scan_and_assess、exchange_row_and_verify、mix_and_rescan、monitor_until 建立显式版本及可验证状态。设备写继续走统一权限/预算/修订/intent 执行器；步骤终态由可核对的 action 与 observation 支持；未知技能/版本、缺参数、旧/错板证据、失败/取消动作不能被模型一句 done 绕过。支持正常链路、复查不达标、错误证据、取消与重启续行验收。

## 4. 对 F01–F15 修复声明的判断

| 原项 | 本轮判断 |
| --- | --- |
| F01/F02 | 部分修复；进入执行器前/模型输出后的围栏通过，R01 的异步前置窗口仍破防 |
| F03 | 实现方持久状态重建回归通过；毫秒定向 SIGKILL 窗口未新增独立证明，不扩张证据范围 |
| F04 | ready 恢复用例通过；持续运行还有 R03/R04 的调度缺口 |
| F05 | 权威读、板 revision 冲突和液体无证据拒绝已有回归通过；本轮未宣称所有证据/资源类型全覆盖 |
| F06 | task/revision/operation_id 归属与记账回归通过；R02 的失败对账屏障仍缺 |
| F07 | 缺参时零动作通过；R03 的补参续行失败 |
| F08 | HTTP/supervisor 改目标撤旧等待并唤醒回归通过 |
| F09 | marker 句与前缀约束跨轮通过；R05 的普通措辞约束/旧事实丢失 |
| F10 | idle reset 归档和总助手归档写入拒绝回归通过 |
| F11 | 真实 pi 协议 + 实际 scheduler 聊天建腔室目标、B 排目标回归通过；这证明建任务入口，不代表真实提供商或完整技能闭环验证 |
| F12 | 模型调用前持久预算预留回归通过 |
| F13 | 跨选择回归通过；R06 同会话响应乱序失败 |
| F14 | request_id 原任务重放和异体冲突回归通过 |
| F15 | 扫描 wells/well_id 越排范围拒绝回归通过 |

## 5. 下一次复验门槛

R01–R08 都必须完成；保持原 177 个单测、17 个 e2e、5 个演示和三个修复回归，不减少断言或依赖额外人工点击/重启使流程继续。新增两份独立脚本变为退出 0，并把关键并发/聊天/压缩用例纳入正式回归；任务队列与版本化技能新增真实 Runtime/Agent HTTP 下的端到端验收。E2E 归位失败需查明等待/场景状态原因并给稳定证据，单次重跑不能替代原失败记录。所有验收证据明确区分模型桩、真实提供商和视觉能力。
