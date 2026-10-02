# Q01–Q04 整改后的独立复验（2026-10-02）

> **后续独立复验：** 本报告原 S01–S03 用例现已通过，旧观测用例在完整单测首轮通过；新增同版本去抖证据漏洞仍阻塞整体验收。见 [S01–S03 最新独立复验](long-lived-s03-independent-review.md)。以下为本轮当时的历史结果。

审查范围：`feat/b-framework`，HEAD `22c3a97` 加当前未提交修改。使用现有工作区依赖，未另做干净克隆。各重测试顺序执行，进程、Runtime 和 SQLite 都在隔离临时目录；未操作用户实验、未改产品实现或原测试断言、未提交/推送。本轮新增审查脚本和报告。

**结论：仍未通过整体验收。** 七份既有审查脚本已全部退出 0，Q01–Q04 的原四个用例现在通过，六个新增交接/暂停回归也通过。但完整单测首轮是 **254/255**，旧观测测试仍失败；补充诊断有三个正确行为断言失败，涉及真实阈值事件契约、监测成功证据的目标版本，以及空目标范围被判成功。下列 S01/S02 为 P1，S03 与正式测试失败为 P2。

真实模型提供商与视觉能力仍未验证。本报告的模型侧使用显式可控测试 backend，通过实际 scheduler ToolHost；设备状态、事件、观测通过真实 Runtime HTTP 取得，不冒充真实 LLM 验证。

## 1. 独立执行结果

| 检查 | 本轮结果 |
| --- | --- |
| `npm run typecheck` | 退出 0，0 错误 |
| 既有七份审查脚本 | 全部退出 0，包括 r08 的七个用例和 n05 的四个用例 |
| `npm test` | **退出 1；206/206 + 48/49 = 254/255**，无取消/跳过，首轮约 8.4 分钟 |
| 新补充诊断 | 退出 1；三个正确行为断言失败，详见 §2；有一个明确标注的采样归一化组件对照 |
| `npm run test:e2e` | 首轮退出 0，17/17，4.9 分钟，无重跑 |
| `npm run demo:all -- --out-dir /tmp/oscar-q04-independent-demo` | 首轮退出 0，5/5；长期会话 26.4 模拟小时，储液/逐孔守恒通过 |

七份既有脚本位于 `reports/review/`：`long-lived-reacceptance-reproduce.mjs`、`long-lived-reacceptance-ui-reproduce.mjs`、`long-lived-reproduce.mjs`、`long-lived-http-reproduce.mjs`、`long-lived-ui-reproduce.mjs`、`long-lived-r08-review-reproduce.mjs`、`long-lived-n05-review-reproduce.mjs`。本轮没有修改它们。

新诊断：[long-lived-q04-review-reproduce.mjs](long-lived-q04-review-reproduce.mjs)，结果：[long-lived-q04-review-reproductions.json](long-lived-q04-review-reproductions.json)。退出 0 要求正确行为断言全部通过；目前退出 1，没有把缺陷存在当作通过条件。日志在 `/tmp/oscar-q04-review-*.log`。演示原始输出在 `/tmp/oscar-q04-independent-demo/`；持久副本：[演示汇总](long-lived-q04-review-demo-summary.json)、[长期会话结果](long-lived-q04-review-session-monitor.json)。

## 2. 功能问题

### S01 · P1：实际环境采样不会触发已登记的阈值 wake

位置：`services/culture-agent/src/scheduler.ts:736`，对应 Runtime 的生产方 `services/runtime/src/runtime.ts:1253`。

Runtime 的 `environment.sampled` 事件形状为 `{chamber_id, sample:{temperature_c, co2_pct, humidity_pct, sampled_at_sim_s, ...}, targets, quality}`。`handleDeviceEvent()` 原样交给 `evaluateConditions()`，但后者只读 `payload.chamber.*.observed` 或顶层 `payload.temperature_c/co2_pct/humidity_pct`，没有读 `payload.sample`。实际三通道 reading 都是 undefined，在 `if (value === undefined) continue` 中跳过，因此真实环境阈值无法唤醒模型。

复现经过真实 HTTP 事件订阅和 inbox：登记 temperature_c below 38，去抖/冷却均为 0；Runtime 已恢复 realtime，speed=100。三次真实采样已经 processed，sim=90 的温度为 **37.013815 °C**、质量 ok，predicate 满足，却 fired_wakes=0，任务仍等待。这里没有把普通采样当作模型触发器：测试登记了明确的阈值条件，满足条件时应触发一次。

修复验收：消费正式 Runtime 事件契约中的 sample 字段，保留质量、去抖、滞回、冷却语义；通过真实 Runtime HTTP 测温度/CO₂/湿度阈值跨越，以及不满足条件时零模型唤醒，不能只给 evaluator 传合成的顶层读数。现有长期演示是 sim-time 监测路径，不证明真实阈值事件路径正确。

### S02 · P1：旧版本监测成功证据可以完成新版本目标

位置：`services/culture-agent/src/skills.ts:1067` 与 `:1119`；目标修改保留旧计划见 `services/culture-agent/src/session-store.ts:766`。

新 `monitorStepMatchesSuccessCondition()` 只检查 monitor_until、done、verification.pass 和输入谓词/期限；完全没有核对 `step.plan_revision` 与 `ctx.goal_revision`。注释中“passing verification 已证明当前版本”只在当时验证步骤时成立，目标修改后旧验证仍留在计划表中，不能继续当作新版本证据。

复现：r1 为 temperature below 38，去抖 0，实际监测步骤验证通过，r1 的 completeGate 返回 true（合法正对照）；模型通过正式 `host.updateTaskGoal` 改为 r2，要求同一阈值持续 **600 模拟秒**。新版本没有触发任何 wake，所有 fired wake 的 goal_revision 都为 1；plan_revision 仍为 1。r2 的 completeGate 却返回 true，随后真实 scheduler 回合效果将 r2 任务设为 completed。修改目标时 sim=105，完成后 sim=129，不能证明新要求已保持 600 秒。

**诊断边界：** S01 会遮住正常条件触发，因此脚本先记录 S01 的真实失败，再把同一份实际 Runtime `payload.sample` 展开为 evaluator 当前支持的顶层格式，调用现有 evaluator 作组件对照。读数、谓词、Runtime 状态均未改写，也没有伪造 wake 或 verification 行；步骤仍由正式 `host.updateStep` 验证，目标修改与完成走正式 ToolHost。这个组件对照使有效 r1 证据可用于验证独立的版本缺陷，不能描述为“未归一化的完整条件事件路径已成功”。S01 修好后，同一版本问题仍需阻止。

修复验收：完成核对必须要求监测证明属于当前目标版本，校验对应计划/步骤与 wake 来源；编辑目标后旧版本成功证明保留为历史，重新登记/验证当前版本的等待。补充“已经验证 r1 → 修改去抖/目标到 r2 → r2 尚无新证明”的用例，工具和回合效果都拒绝完成。

### S03 · P2：不存在的目标排会通过零孔核对被判达标

位置：`services/culture-agent/src/skills.ts:1053`、`:1221`，输入入口 `services/culture-agent/src/goal.ts:68`。

GoalSpec 规范化接受 row_id/scope.rows 的未知排值。`metricWells()` 将不存在的目标排过滤成空列表，目标验证循环执行零次，最后仍返回 `ok:true, mode:'metrics_verified'`。结果不是“参数错误/目标无法验证”，而是静默成功。

复现：scope 为真实 plate-01 的 Z 排，medium_volume_ul 指标要求 Z 排每孔 ≥1000 µL。Runtime 明确只有 A/B/C/D 四排，未扫描任何孔、未获得任何观测，completeGate 却返回 `metrics_verified` 且 metrics=[]；真实 scheduler 回合效果将任务标为 completed。

修复验收：按权威布局验证目标 plate/row/well；不存在或超出目标范围的指标应拒绝/补参，完成时每个指标必须有非空可核对范围，不能通过过滤丢掉不合法指标。补充未知板、未知排、未知孔与混合有效/无效指标；不要以空计划合法路径为理由接受零指标检查。

## 3. 正式单测仍未闭合

唯一失败：`services/culture-agent/test/skills-e2e.test.ts:355`。

```text
skills e2e: an OLD observation is refused for done; the corrected evidence then verifies
actual:   observation_not_from_step_action
expected: observation_stale
```

最终完成与拒绝步骤存在的断言已通过，失败仍是错误分支断言；不代表产品接受了旧观测。新增夹具逻辑确实尝试补充生产扫描，但 `model-stub.ts:321` 仍靠“同一 brief 的最后一个 succeeded scan”猜 producer，`:433` 仅在 producer 非 null 时追加它。因此代码修改不能保证旧观测的实际生产扫描总被引用。

不能确认“255/255、唯一失败已修好”的交付声明。应使用观测与生产动作的明确 ID 关联，保留精确的新鲜度断言及单独的生产扫描不匹配用例；不要通过改变错误码断言来掩盖关联未建立的情形。

随后以 `OSCAR_STUB_DUMP=1 node --test --test-concurrency=1 --test-name-pattern='an OLD observation' reports/review/long-lived-q04-stale-fixture-inspect.mjs` 单独复核，**1/1 通过，约 3.4 秒**；这不覆盖完整检查首轮的失败，表明夹具尚有时序依赖。本轮没有循环重跑完整测试直到全绿。

[诊断包装脚本](long-lived-q04-stale-fixture-inspect.mjs) 只导入原测试并保存有限的引用/brief 字段，未改断言；[引用记录](long-lived-q04-stale-fixture-citations.json) 显示同一 brief 包含 `act-001-01`、`act-001-02` 两个扫描终态，却取第一条观测 `obs-001-001`，producer 推断仍取最后一个扫描。此轮 record_step_result 恰好同时引用两个扫描，所以精确断言通过。该顺序推断不是可靠的观测—动作归属证据。

## 4. 可确认的整改进展与本轮边界

- Q01 的所有绑定意图检查与查询未知阻止晋升，原复现和三条正式回归通过。
- Q02 的状态读后围栏、ready→running CAS，原复现和三条正式回归通过；暂停窗口内零模型调用/零设备写入。
- Q03 原“空计划无指标提前完成”复现已拒绝，未来期限、监测输入匹配测试通过；S02 是新增监测证据分支的版本问题。
- Q04 的分排观测共存与按孔最新估计，原复现与正式用例通过。
- 真实模型提供商、视觉上下文依旧未验证；没有将其算作已通过。
- 本轮没有修改产品代码、原测试或七份既有审查脚本，所有失败保持正确行为断言。

需补齐 §2 的契约/完成判定和 §3 的可靠证据夹具，再顺序复跑完整检查与新增诊断。
