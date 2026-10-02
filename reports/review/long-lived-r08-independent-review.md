# R01–R08 整改后的独立复验（2026-10-02）

> **后续复验：** 本报告七个正确行为用例经 N01–N05 整改后已全部通过。新的独立复验仍有四个功能边界失败，完整单测首轮 245/246；详见 [N01–N05 整改后的独立复验](long-lived-n05-independent-review.md)。下文是本轮整改前的历史审查，不应据此认为七个旧用例仍然失败。

审查对象：`feat/b-framework`，HEAD `22c3a97`，包括上一轮修复和本轮尚未提交的队列/技能等改动。本轮未改产品代码、未提交/推送；新增的只有审查材料。所有进程和 SQLite 都使用隔离临时目录，未操作用户实验。

**结论：仍不能通过整体验收。** 原复验报告的 12 个后端用例和 1 个界面用例现在通过；任务队列、版本化技能也已有实质实现。但新增路径仍有下述 5 类 P1 缺陷，对应 7 个独立正确行为断言失败。不能由原用例全绿推导出“R01–R08 全部闭合”。

真实模型提供商、视觉能力仍未验证；没有将它们加入本轮已通过项。本报告所用可控 backend 是显式测试后端，通过实际 scheduler 的 ToolHost 调用同一实现，设备状态/动作/观测通过真实 Runtime HTTP 获得；FIFO 用例直接调用各 API 共同使用的 store 入口。它们不冒充真实 LLM 决策验证。

## 1. 独立执行记录

所有重测试顺序执行，没有相互并发。

| 检查 | 本轮结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `node reports/review/long-lived-reacceptance-reproduce.mjs` | 退出 0，12/12 |
| `node reports/review/long-lived-reacceptance-ui-reproduce.mjs` | 退出 0 |
| 上一轮三个修复回归脚本 | 全部退出 0 |
| `npm test` | 230/230（193 + 37），0 失败/取消/跳过 |
| `node reports/review/long-lived-r08-review-reproduce.mjs` | 退出 1，7 个正确行为断言失败；下文逐项说明 |
| `npm run test:e2e` | 首轮 17/17，4.8 分钟，无重跑 |
| `npm run demo:all -- --out-dir /tmp/oscar-r08-independent-demo` | 5/5，储液和逐孔守恒通过 |

日志为 `/tmp/oscar-r08-review-*.log`。新增复现脚本：[long-lived-r08-review-reproduce.mjs](long-lived-r08-review-reproduce.mjs)，结果：[long-lived-r08-review-reproductions.json](long-lived-r08-review-reproductions.json)。退出 0 要求所有正确行为断言通过，目前退出 1；没有以“缺陷存在”为通过条件。未修改此前交给实现方的两个脚本。演示证据：[本轮汇总](long-lived-r08-review-demo-summary.json)、[长期会话完整结果](long-lived-r08-review-session-monitor.json)；其余原始输出在 `/tmp/oscar-r08-independent-demo/`。

## 2. 未闭合的问题

### N01 · P1：异步计划/步骤工具仍能提交旧回合效果

位置：[scheduler.ts:1198](../../services/culture-agent/src/scheduler.ts#L1198)、[scheduler.ts:1255](../../services/culture-agent/src/scheduler.ts#L1255)。

执行器的设备提交现在已重新检查撤权，这是原 R01 的有效修复。但新增 `replacePlan` / `updateStep` 在异步读状态或证据之前检查 `turnStale()`，之后不复查，使用先前的 TaskRow 写库。回合结束时的 stale 检查无法撤销已经发生的计划变更。

两个 gate 验证：

- 旧回合正在等待 Runtime 状态读取，用户将目标修订到 r2 并保存 r2 的新计划；旧请求返回后工具仍 `ok:true`，把新计划替换成 **plan_revision=1、until=1000**，覆盖用户的 **r2、until=2000**。
- 步骤后置验证读取期间目标改成 r2；旧回合仍 `ok:true`，将 **r1 步骤写为 done、verification.pass=true**。

修复/验收：在最后一次 await 后、计划/步骤写库前重新核对 session lifecycle/owner、pause/cancel、task/goal revision、plan/step 身份；同步写入还需 CAS，避免新计划替换了旧 step 后写错对象。分别覆盖目标修改、任务取消、暂停、归档、ownership 变化和并发换计划。不能只给设备动作执行器加围栏。

### N02 · P1：复查明确未达标，任务仍可成功完成

位置：[skills.ts:801](../../services/culture-agent/src/skills.ts#L801)、[scheduler.ts:1372](../../services/culture-agent/src/scheduler.ts#L1372)。

`planCompletionGate` 只拦 pending/running 和 done-without-pass；`failed`、`skipped` 直接被当成可完成终态。`complete_task` 与 scheduler 又没有独立验证 GoalSpec 的成功条件。因此模型可以把步骤标失败/跳过后宣布任务成功。

独立验证走了真实动作与观测：目标 **A 排 ≥1500 µL**；扫描、少量加液、复查后，实际最小体积约 **389.79 µL**。通过真实 `host.updateStep(done)` 得到 **`verify_below_target`、步骤 failed**；此时 `host.planGate()` 却返回 true，回合的完成效果把任务标为 **completed**。这不是制造一个非法 failed 设备动作：设备动作均成功，失败的是培养目标的后置复查。

修复/验收：任务成功必须有当前 goal revision 的可核对成功证据。失败/跳过的必需步骤不能单靠“已到终态”解除成功门槛。若失败后另一路补救已成功，可基于补救证据完成；不得因历史失败永久卡住，也不得未验证就成功。增加真实低液位复查失败 → complete_task 拒绝 → 后续补救达标 → 成功的完整用例。

### N03 · P1：技能证据没有绑定到步骤的实际目标和等待条件

位置：[skills.ts:505](../../services/culture-agent/src/skills.ts#L505)、[skills.ts:695](../../services/culture-agent/src/skills.ts#L695)。

动作的 task/revision 归属已验证，但维护/摇床动作的参数并未与本步骤 plate/row/reservoir 等匹配。监测步骤则只按 metric 查 fired wake，忽略 op/value 和本步骤的条件身份。

两项验证：

- 同一个合法任务允许 A/B 排操作。真实维护 **B 排**，随后真实扫描 **A 排**；将 B 排维护 action_id 和 A 排 observation_id 交给 A 排的 `exchange_row_and_verify`，校验返回 **`ok:true`**。A 排新鲜观测达标不证明执行过 A 排维护。
- 有一条已触发的 **temperature_c below 38** wake（实际腔室约 37°C），步骤要求 **temperature_c above 45**；验证器仍返回 **`ok:true`**。同 metric 不能代替同一个等待条件。

修复/验收：验证动作实际 arguments 和步骤输入，绑定同板、同排、储液及技能所要求的其他参数；观测关联步骤自己的验证扫描。Wake 应绑定当前 goal/plan/step 及完整 predicate/期限，不能拿旧步骤或另一阈值触发顶替。增加同任务错排/错板/错储液动作、同 metric 不同 op/value、改目标后的旧 fired wake 回归。

### N04 · P1：当前任务终结与队首晋升之间，新任务可插队

位置：[session-store.ts:525](../../services/culture-agent/src/session-store.ts#L525)。

创建任务仅判断 `activeTask()`。在当前任务刚终结、已有队列还在等待异步对账/动作终态/晋升的合法窗口，activeTask 为空，后来任务就直接创建为 ready，占住执行槽。既有队首被阻塞，FIFO 顺序和晋升前屏障都可被新入口绕过。

独立调用同一个 store 入口：A 当前、B 排队 → A 终结 → C 到达，结果 **B=queued、C=ready、current=C**。`maybePromoteNext` 会等待旧 intent 对应动作的真实 HTTP 查询；这个窗口尤其可能在 lookup 失败、在途动作未终结或进程恢复时持续，不能视为不可见的同步瞬间。原 R02 的执行器未知意图保护仍在，不能据此声称已经复现重复加液；本用例证明的是准入插队及绕过队列晋升路径。

修复/验收：存在队列或上一任务尚需交接时，新请求继续入队；准入与晋升共享一个调度规则。验证 A 终结后、晋升等待中从聊天/HTTP/总助手新建 C，B 仍先于 C，且未知意图与在途动作屏障无法通过“新建 ready 任务”绕过。

### N05 · P1：取消查询遇到一次网络错误后，后续取消被永久去重

位置：[scheduler.ts:1646](../../services/culture-agent/src/scheduler.ts#L1646)。

`requestActionCancel` 在读 action、发送 cancel 之前就把 ID 加进 `cancelRequested`。catch 只记录错误，没有清除标记或安排重试。即使查询恢复、用户再次取消任务，仍直接 return，设备没有收到取消。

真实 Runtime 摇床动作持续 120 模拟秒。首次取消时注入一次 action GET 网络错误；随后恢复查询，再显式调用一次取消。结果 **任务 cancelled，设备动作仍 queued，cancel POST 总数为 0**。脚本最后用 operator 显式取消清理设备动作，不依赖 Agent 自己恢复。

修复/验收：区分取消正在发送、确认已受理和需要重试；失败时解除临时去重并用有界退避重试，成功的取消仍保证幂等。任务取消意图需能在重启后继续，不能只存进程内 set。覆盖读失败、POST 失败、受理后响应丢失和用户重试，不让已取消任务的设备操作继续无人处理。

## 3. 对本轮有效修复的认可与边界

- 原七种“状态读取期间撤权”设备提交用例全部拒绝且零新动作；R02 不确定旧意图阻塞新写入、R03 补参后续行、R04 连续消息消费、R05 原措辞约束及旧事实保留、R06 同会话旧响应丢弃均通过原独立脚本。
- R07 队列有实际持久化状态、幂等入口、终态晋升、暂停占位、重启和 watchdog 重试；不是上一轮的空接口。但 N04 仍是准入/晋升漏洞。
- R08 有四项显式版本技能、输入验证、后置校验与真实模型桩闭环测试；不是上一轮的自由文本计划。但 N01/N02/N03 仍会造成错误计划或错误成功结论。
- 记忆不自动识别指令覆盖、真实提供商未验证、图片上下文未验证是已披露边界。本轮没有把它们重新包装成新增已复现缺陷。

## 4. E2E 断言调整的审查

固定 1500 ms 改为等待场景 `presentingMotion=false`，同时保留归位坐标精确相等和逐帧位移限制，这个方向可接受。两段运动仍各要求至少一个中间位姿，弱化了采样数量要求，但仍能拒绝完全没有中间位姿的跳变。本轮没有独立复跑实现方所称“负载 20/20”，不将该数计作独立证据。

`presentingMotion` 表示场景当前呈现的运动，不等同设备执行终态；测试仍先从 Runtime 查询 succeeded，再等待场景呈现结束，两者分工合理。

## 5. 下次复验门槛

保持当前 230 个标准测试、17 个 E2E、5 个演示与五份既有修复脚本；上述新脚本退出 0，并将关键 gate/真实目标复查/错排证据/FIFO 交接/取消重试用例纳入正式回归。不得通过删掉条件、更改脚本期望或让未验证目标也算成功来取得绿色。本次未提交产品改动；应先修复 N01–N05 再确认整体完成。
