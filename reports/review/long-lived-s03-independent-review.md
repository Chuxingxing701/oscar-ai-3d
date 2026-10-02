# S01–S03 与第四轮试用修复的独立复验（2026-10-02）

> **后续独立复验（2026-10-03）：T01 已关闭。** 原脚本 2/2、技能相关 41/41、九份审查脚本和 typecheck 全部通过；见 [T01 定向独立复验](long-lived-t01-independent-review.md)。以下保留修复前的历史结果。

审查范围：`feat/b-framework`，HEAD `22c3a97` 加当前未提交修改；现有工作区依赖，未另做干净克隆。使用隔离 Runtime / Agent / SQLite 数据目录；未操作用户实验，未修改产品代码、既有测试或八份既有审查脚本，未提交或推送。

**结论：仍未通过整体验收。** 原 S01–S03 的三个独立用例已关闭（q04 脚本退出 0，S02 不再需要采样格式转换对照）；新增 T01 是 P1：同一目标版本内，模型可缩短条件唤醒的去抖时间，用较弱的成功证据提前完成任务。下方正常等待对照同时通过，因此不是模型不可用或设备未启动造成的结果。

## 1. 独立执行结果

| 检查 | 本轮结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npm test` | **首轮 262/262**（并行阶段 208 + 串行阶段 54），退出 0；失败/取消/跳过均 0，约 9 分钟 |
| q04 三个既有用例 | 3/3，退出 0，真实采样自然触发，不需要组件格式对照 |
| 其余七份既有审查脚本 | 全部退出 0；与 q04 合计八份既有脚本全部通过 |
| 浏览器 E2E | **首轮 17/17**，退出 0，约 4.8 分钟，未重跑 |
| `npm run demo:all` | **5/5**，退出 0，约 88 秒；输出隔离在 `/tmp/oscar-s03-independent-demo` |
| 新增同版本去抖证据检查 | **1/2**，退出 1；错误提前完成的拒绝断言失败，合法等待对照通过 |

本轮未重跑完整单测，旧观测夹具用例在首轮完整 suite 内通过。新增两项 medium 的实际 HTTP 回归也包含在这轮通过的串行阶段内。

## 2. T01 / P1：同版本监测证据未核对目标要求的去抖时间

位置：`services/culture-agent/src/skills.ts:1128`（目标条件匹配）、`:746`（步骤与 wake 匹配）、`:835`（持久化验证证据）。

`monitorInputsMatchSuccessCondition` 和 `conditionMatches` 都仅比较 metric / op / value。monitor 输入规范化也只保留这三个字段；步骤证据仅保存该简化 condition 与 wake 的版本/步骤身份，未保存被核对的实际去抖要求。模型通过正式 `armWake` 入口自行传入 `debounce_sim_s: 0` 时，当前 revision + 正确 step_id + 同阈值已经足以通过验证和完成判定，即使 GoalSpec 的去抖为 600 秒。生产是否额外传 `firedWakes` 不是本问题的唯一根因：即使核对账本存在性和版本，仍需比较条件语义。

独立脚本 `long-lived-s03-review-reproduce.mjs` 使用真实 Runtime HTTP、实际 scheduler ToolHost 与显式测试 backend：创建 metrics=[]、temperature_c below 38、debounce=600 的监测任务；创建合法 monitor_until 步骤；模型注册同阈值但 debounce=0 的 wake；真实采样触发后调用 updateStep(done) 和 completeGate，并提交完成效果。没有伪造 wake、观测或 verification，没有修改目标版本，也没有直接写入完成状态。

结果：短去抖用例在注册后 **48 仿真秒** 已变为 completed（步骤验证与完成 gate 均返回成功）；有效对照保留 debounce=600，等待 **625 仿真秒** 后正常完成。输出在 `long-lived-s03-review-reproductions.json`；脚本断言正确行为，因此当前退出 **1**（两个用例中一个失败、一个通过）。

影响：真实模型即使保持目标版本、板/排范围和阈值正确，也可能将持续条件降为一次采样后声明完成，现有证据围栏不能拦住这类计划偏差。

建议：由服务端按当前目标规范化可作为成功证据的条件，或在技能验证与任务完成时读取实际 fired wake predicate 并检查目标所要求的完整条件语义，至少不得缩短 debounce。任意辅助 wake 可以唤醒模型，但不应自动成为较强目标的成功证据。补充同版本弱化条件拒绝、合法完整条件通过的端到端回归；同时覆盖 ToolHost 与回合 effects 的入口。

## 3. 两项 medium 修复与边界

- **总助手 GET task：源码复核符合修复目标。** GET 路由调用 taskView，返回持久计划的 skill/status/action_ids/evidence_refs，与会话 API 的字段一致；自描述新增 GET tasks/:id。真实进程回归包含 Runtime 网关、委托创建、计划出现、动作证据出现，以及两个 API 的计划字段对账。本轮该回归首轮通过，最终执行结果见上表。
- **连续 invalid_plan 护栏：源码及真实进程回归符合试用缺陷的修复目标。** 默认连续三次确定性拒绝后进入 needs_input、撤销 planning wakes、写入可见原因；有效计划和改目标会重置计数。回归验证停止后 2.5 秒高速仿真不再增加模型回合。计数仅在内存，重启会给予新的拒绝额度（源码已有明确注释），并非跨进程持久的 max_corrections 配额；模型总预算仍持久。此边界不作为本轮新增阻塞项。

## 4. 保留的限制

原四项 low 试用遗留仍未处理：终态 UI 字面量 null、绝对期限模板在仿真时间超过 93600 后过期、一次性队列显示疑似竞态、模型桩向用户暴露内部 REST 路径。队列显示项仍未独立复现，期限出生过期仍是依据绝对时间语义的推断，不能写成此次实测结论。

评审员关于 optional wake ledger、整样本 settling 质量、零板退化布局及未引用 scope.rows 的提示保留；当前正常 Runtime 布局和 S01–S03 原用例通过不等于这些边界已新增覆盖。

真实模型提供商、图片及视觉上下文仍未验证。本轮设备数据是真实 Runtime 的仿真数据；显式测试 backend 和 HTTP 模型桩不代表真实大模型能力验收。

## 5. 可复核材料

- 执行结果与四个关键源文件 SHA-256：`long-lived-s03-acceptance-results.json`。检查结束时与审查中记录的源文件哈希一致。
- 新增正确行为断言：`node reports/review/long-lived-s03-review-reproduce.mjs`，当前退出 1。
- 既有八份脚本名称：`long-lived-{reproduce,http-reproduce,ui-reproduce,reacceptance-reproduce,reacceptance-ui-reproduce,r08-review-reproduce,n05-review-reproduce,q04-review-reproduce}.mjs`，各自退出 0，详细结果为同目录对应 reproductions JSON。
- 演示命令：`npm run demo:all -- --out-dir /tmp/oscar-s03-independent-demo`。本轮摘要与长期会话报告已复制到 `long-lived-s03-review-demo-summary.json`、`long-lived-s03-review-session-monitor.json`。
- 本轮长期会话实际结果：26.4 仿真小时，14 次监测唤醒、2 次 media.add、12 次无需操作，HTTP 模型桩 41 次请求；储液消耗 425.4 µL、余量 49574.6 µL，6 孔体积守恒核对通过。这些是本轮实测，不沿用先前演示的调用计数。
- 命令日志保留于 `/tmp/oscar-s03-*.log`；完整单测、E2E 与演示顺序执行，各自独立数据和进程。
