# N01–N05 整改后的独立复验（2026-10-02）

> **后续复验：** Q01–Q04 的原四个正确行为用例经整改后已全部通过；本报告是整改前的历史记录。最新复验的正式单测首轮 254/255，旧观测夹具仍有时序依赖，另有三个补充诊断失败，见 [Q01–Q04 整改后的独立复验](long-lived-q04-independent-review.md)。

审查对象：`feat/b-framework`，HEAD `22c3a97` 加当前未提交修改。使用现有工作区依赖，未另做干净克隆。本轮未修改产品实现或正式测试，未提交/推送；新增的只有审查材料。所有诊断、测试与演示使用隔离 Runtime/Agent/SQLite，未操作用户实验。各重测试顺序执行。

**结论：仍未通过整体验收。** 六份既有复现脚本现在全部退出 0，上一轮七个用例全部通过，N01–N05 有实质修复。但完整单测首轮为 **245/246**，不是交付声明的全部通过；补充正确行为断言有四项失败，对应下列三类 P1 和一类 P2 功能问题。

本报告使用实际 SessionStore/SessionManager/Executor 与真实 Runtime HTTP；模型侧使用显式可控测试 backend，通过同一 ToolHost/完成判定接口注入延迟和响应。它验证控制、状态和证据契约，不代表真实提供商或视觉能力验收。

## 1. 执行结果

| 检查 | 独立执行结果 |
| --- | --- |
| `npm run typecheck` | 退出 0，0 错误 |
| 既有六份复现脚本 | 全部退出 0；r08 脚本 7/7 |
| `npm test` | **退出 1；204/204 + 41/42 = 245/246**，无取消/跳过；唯一失败见 §3 |
| 新补充复现脚本 | 退出 1；四个正确行为断言失败，详见 §2 |
| `npm run test:e2e` | 首轮退出 0，17/17，4.8 分钟，无重跑 |
| `npm run demo:all -- --out-dir /tmp/oscar-n05-independent-demo` | 首轮退出 0，5/5；长期会话 26.4 模拟小时，逐孔/储液守恒通过 |

六份既有脚本为 `long-lived-reacceptance-reproduce.mjs`、`long-lived-reacceptance-ui-reproduce.mjs`、`long-lived-reproduce.mjs`、`long-lived-http-reproduce.mjs`、`long-lived-ui-reproduce.mjs`、`long-lived-r08-review-reproduce.mjs`，均在 `reports/review/` 下。本轮未修改它们。前两份 SHA-256 仍为：

```text
9d12c2bd721d719f3e67245f6084eec559575d14e406ac10bf492e2312d060a2
f6e535c9ae324e7e42f90fec412a58cdefb8f667bacac8fe7dd613a32fba1b7c
```

新脚本：[long-lived-n05-review-reproduce.mjs](long-lived-n05-review-reproduce.mjs)，结果：[long-lived-n05-review-reproductions.json](long-lived-n05-review-reproductions.json)。脚本退出 0 的条件是正确行为全部通过，没有以缺陷存在作为通过条件。另有恢复后旧动作取消成功，以及全目标扫描能验证同一多排目标的对照断言。

日志在 `/tmp/oscar-n05-review-*.log`，依次为 typecheck、六份脚本、unit、new、e2e、demo。完整单测首轮总耗时约 7.9 分钟。演示原始结果在 `/tmp/oscar-n05-independent-demo/`；持久副本：[演示汇总](long-lived-n05-review-demo-summary.json)、[长期会话结果](long-lived-n05-review-session-monitor.json)。

## 2. 尚未闭合的功能问题

### Q01 · P1：动作查询失败时，交接屏障仍被清除

位置：`services/culture-agent/src/scheduler.ts:1859`，调用方 `:1830`。

`hasSessionInFlightActions()` 对 GET 动作失败执行 `catch { /* unknown → treat as not blocking */ }`，继而返回 false；`maybePromoteNext()` 据此清除 `handoff_pending` 并晋升队首。`unresolvedSessionIntents()` 只阻止尚未绑定的 pending 意图，无法补上已绑定动作状态查询失败的检查。

复现：A 绑定真实 120 秒摇床动作，B 在队列；只故障注入该动作 GET，状态、事件等 API 保持正常。取消 A 时查询失败，取消意图正确保留为 `requested`，但交接同时被错误放行。实际：旧动作仍 `queued`（非终态），B 已 `running` 且模型被调用一次，`handoff_pending=false`。解除故障并再次取消后，旧动作才变为 `cancelled`。

N05 的重试确实修好了，但不能因此让 N04 在状态未知时先放行下一任务。

修复要求：动作终态未经确认时保持交接等待并重试，查询失败不能等同于无在途动作。补充“已绑定动作查询不可用 + 待取消 + 有队列”的用例，断言确认终态前队首不晋升、不产生设备写入。当前仅检查最后十个绑定意图，也不应作为完整交接证明。

### Q02 · P1：首个状态读取期间的任务暂停会被自动撤销

位置：`services/culture-agent/src/scheduler.ts:1089`；暂停入口 `services/culture-agent/src/sessions-api.ts:431`。

`runTurn()` 在读 Runtime 状态前捕获 `task.status='ready'`，读取后仍用该旧对象无条件写 `running`。这个转换既未重检撤权条件，也未要求库中当前状态仍是 ready。Task pause API 只写 paused，没有 abort 该回合，因此 paused 会先被覆盖；后面的 ToolHost/executor 重检见到的是被覆盖后的 running，就允许设备操作。

复现：仅延迟回合开始的真实 `/state` 响应，期间通过与暂停 API 相同的 store 入口将任务设为 paused，然后释放响应。实际：任务变为 `waiting_device`，模型调用一次，`imaging.scan` 工具返回成功，Runtime 受理 `act-001-02`。预期暂停状态保留且零设备写入。

N01 的计划/步骤工具最后等待点围栏通过了，但更早的回合启动转换仍能擦除暂停事实。

修复要求：状态读完后、首次本地状态写入及模型调用前重检完整围栏；ready→running 使用当前状态条件更新，不能根据读之前的 TaskRow 清除暂停。覆盖用户/总助手暂停在这个等待窗口内到达的情形。

### Q03 · P1：无指标、无计划证据的长期监测任务可直接完成

位置：`services/culture-agent/src/skills.ts:1072`，以及 `planCompletionGate()` 的空列表通过行为（`:984`）；完成工具使用此门槛见 `services/culture-agent/src/backend.ts:401`。

`verifyGoalSatisfied()` 在 metrics 为空时无条件返回 `ok:true, mode:'plan_only'`。与此同时空计划的 plan gate 也返回 true，两道门槛都没有任何成功证据，却允许工具和回合效果把任务设为 completed。

复现：合法监测目标含 `monitoring.interval_sim_s=3600`，声明监测到 sim 100000，并以到达该时刻为成功条件；不生成任何计划步骤、不登记/触发成功 wake，直接请求完成。实际：`completeGate([]).ok=true`，回合效果将任务标为 `completed`，steps=0，Runtime sim_time_s=0。

这违反设计 §4.1/§5 中“达到长期任务终止条件才结束 Task”“目标成功需验证”的要求，也与新增函数注释所说的“纯 monitor 任务需要 monitor_until done+pass”不符。修复已阻止失败步骤冒充成功，但没有阻止完全没有步骤的冒充成功。

修复要求：无可核对指标时，至少要有能够证明成功条件的已验证计划/监测证据；不存在结构化可验证成功条件时应补参或拒绝完成，不能把空计划当作成功。保留“指标已满足时可不再做无意义维护”的合法路径。

### Q04 · P2：同板分排扫描互相覆盖，合法多排目标无法验证

位置：`services/culture-agent/src/skills.ts:1122`。

候选观测按 plate_id 只保留一份最新观测；对不同 row 的各个指标再复用该同一份观测。扫描 B 后，即使 A 的观测仍为当前板 revision、属于当前任务/目标版本、质量正常并达标，A 的证据也被丢弃。

复现：同任务依次扫描 A、B，指标均为每孔 ≥100 µL。两份真实观测的 plate_revision 都是 1，A 最小估计 378.76 µL，B 最小估计 796.72 µL；却返回 `goal_unverified`，理由是没有 A 的可用观测。相同目标改为一次覆盖 A+B 的扫描，对照断言通过。

修复要求：按指标所需孔范围选择最新合格观测，或按孔聚合最新证据；保持任务/目标版本、板 revision、质量和维护之后采样等限制。补充两份分排观测共同验证多排目标，并验证更晚的不达标同孔观测不能被较早达标证据掩盖。

## 3. 完整单测的实际失败项

位置：`services/culture-agent/test/skills-e2e.test.ts:355`。

```text
skills e2e: an OLD observation is refused for done; the corrected evidence then verifies
actual:   observation_not_from_step_action
expected: observation_stale
```

这是正式测试唯一失败项。任务最终完成的断言已经通过，失败发生在检查拒绝原因；不应把它描述成旧观测已被接受。新 N03 验证先检查生产扫描是否在步骤引用中（`skills.ts:339`），当前夹具替换了观测引用，但没确保该旧观测的扫描也被正确引用，所以先落到扫描归属拒绝分支。

完整检查结束后，单独运行 `node --test --test-concurrency=1 --test-name-pattern='an OLD observation' services/culture-agent/test/skills-e2e.test.ts`，约 3.4 秒再次退出 1，错误码完全相同（日志 `/tmp/oscar-n05-review-unit-focused.log`）。没有通过重跑覆盖首轮结果，也未修改断言。

建议修正夹具使其只破坏新鲜度，同时满足生产扫描引用要求，再保留 `observation_stale` 的精确断言；另留一个生产扫描不匹配的独立用例。直接接受两个错误码会失去旧观测检查路径的覆盖。是否放宽错误分类是契约选择，不能由“最终没有完成错误步骤”替代对新鲜度分支的测试。

## 4. 可以确认的整改进展与限制

- 旧计划/步骤的最后等待点围栏与 CAS 实质有效，相关旧复现和新增正式用例通过。
- 真实低液位复查→拒绝完成→补救→验证完成用例通过；原 r08 复现如今因缺生产扫描引用而提前拒绝，本轮没有将其误称为 verify_below_target 的覆盖。
- 技能目标参数与扫描归属、监测 wake 的目标版本/步骤/完整谓词绑定已有实现，旧错误证据复现通过。
- 终态与新任务准入的持久交接标记封住了原 FIFO 插队窗口，六份既有脚本保持通过。
- 取消 requested/confirmed 持久化、显式重试、自动退避、接受后丢响应以及重启继续取消的正式测试通过。
- 真实模型提供商、图片/视觉上下文仍未验证；没有把它们纳入已通过范围。

当前不能接受“全检查绿且 N01–N05 整体验收完成”的结论。修复 §2 的四项问题及 §3 的正式测试覆盖后，可在同一工作区顺序重跑已有与新增脚本、完整单测、浏览器检查及演示；不需要改写已有审查脚本来适配错误行为。
