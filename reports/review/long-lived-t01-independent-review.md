# T01 定向独立复验（2026-10-03）

**结论：T01 可关闭，本轮未发现新的阻塞问题。** 在上一轮完整独立验收基础上，本次针对修改的技能验证及 scheduler 完成路径做源码审查、实际 Runtime 工具入口复验和相关回归。先前审查列出的必修阻塞项现已关闭；这不是对真实大模型或视觉能力的验收结论。

范围：`feat/b-framework`，HEAD `22c3a97` 与当前未提交修改。使用现有工作区依赖和隔离的 Runtime/Agent/SQLite 数据，没有改动用户实验、产品实现、测试断言或九份审查脚本；未提交/推送。日期按 Asia/Shanghai，原始证据时间保持 UTC。

## 独立执行结果

| 检查 | 本轮实际结果 |
| --- | --- |
| `npm run typecheck` | 退出 0，0 错误 |
| `node reports/review/long-lived-s03-review-reproduce.mjs` | 2/2，退出 0，未修改原断言 |
| `npm test -- skills` | 13/13 实际进程/HTTP 集成用例，退出 0 |
| `node --test services/culture-agent/test/skills.test.ts` | 28/28 技能单测，退出 0；与集成用例合计 41/41，失败/取消/跳过均 0 |
| 其余八份既有审查脚本 | 全部退出 0，与 s03 合计九份通过 |

本轮没有再跑完整 `npm test`、E2E 或 demo。上一轮独立完整结果为 262/262、首轮 E2E 17/17、演示 5/5；执行方本次报告的 263/263、17/17、5/5 是执行方的验收记录，不冒充本轮独立执行结果。当前改动的相关验证已通过，因此本轮未扩大或重复运行场景检查。

## 修复行为核对

- **实际短去抖仍可唤醒，但不能验证成功。** 原脚本创建目标 debounce=600，在同版本、同步骤、同阈值下注册 debounce=0。真实采样触发后，updateStep 返回 `debounce_shortened`；completeGate 拒绝，任务保持 waiting_condition。本轮注册后 48 仿真秒核对到该状态。
- **合法等待仍然成功。** 同脚本的 debounce=600 对照，在 627 仿真秒后步骤验证、完成 gate 和任务终态均正确通过。
- **步骤门槛读取真实 predicate。** `effectiveDebounce` 保留显式 0，缺省为调度器的 60 秒；实际 wake 要求的去抖不得短于当前 GoalSpec 中匹配条件的要求。通过证据保存实际及所需去抖。
- **任务完成再次核对。** scheduler 现在传入本任务 firedWakes，包含 predicate、goal_revision 与 step_id。完成 gate 会核对版本、步骤归属及账本中的实际去抖；completeGate 与回合完成效果共用 evaluateTaskCompletion。已标 done 的弱化证据也不能绕过该门槛。
- **回归没有放宽原要求。** 新 T01 单测包含 0 拒绝、600/900 通过以及弱化账本不能完成；S02 的 r2 正向夹具改为遵守新目标要求的 600 秒，原旧版本证据拒绝仍保留。技能集成用例中的错误证据、复查不达标、补救、取消和重启均通过。

## 证据与限制

本轮 T01 原始结果快照：`long-lived-t01-reproductions.json`；执行状态与文件 SHA-256：`long-lived-t01-acceptance-results.json`。临时日志在 `/tmp/oscar-t01-*.log`，既有审查脚本的结果仍由各脚本写入同目录对应 JSON。

四项低级试用遗留及既有边界提示继续保留，没有被本次关闭 T01 等同为已修复。真实模型提供商与图片/视觉上下文仍未验证；本轮模型行为来自显式测试 backend 或 HTTP 模型桩，设备数据来自真实 Runtime 进程的仿真数据。

附带测试入口提示（不阻塞 T01）：统一 runner 用 `args.length === 4` 判断空阶段，实际会跳过仅含一个文件的阶段。本轮过滤 `skills` 时因此只跑了 13 个集成用例；已直接运行技能单测文件补齐 28 个用例，未把未执行的测试计作通过。建议后续改用文件列表是否为空判断。完整无过滤 suite 含多个文件，不受这一单文件过滤问题影响。
