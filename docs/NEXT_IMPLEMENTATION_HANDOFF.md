# 下一阶段实施交接（2026-09-30）

**新一轮目标（设计已整理，代码尚未实施）：** 用户确认一个培养实验一个长期会话，预留上层总助手接口。技术选型、状态/记忆与事件驱动设计见 [长期会话设计](LONG_LIVED_AGENT_DESIGN.md)，可直接交给下一位编码 Agent 的任务见 [实施 Prompt](LONG_LIVED_AGENT_IMPLEMENTATION_PROMPT.md)。该阶段将真实模型与 realtime 调度纳入 MVP；下文“可选功能”是此前检查点的历史范围。

先读 `agent.md`、`docs/WORK_ALLOCATION.md`、v0.4 主设计、`docs/API_CONTRACT.md`，再读 [最近改动审查](../reports/runtime_changes_review.md) 和 [异常复现](../reports/review/README.md)。C0–C3 是主要框架基线；不要将正常演示通过理解为所有异常恢复路径通过。

最近的 Agent 入口、SSE 和画布闪白修复及针对性验证见 [跟进记录](../reports/agent_ui_followup.md)。

录屏中运行时设备画面反复缩小的布局问题也已修复：固定桌面时间线行高，canvas 不再参与父布局尺寸计算；真实 scripted 演示逐帧尺寸验证见 [布局跟进](../reports/scene_layout_followup.md)。

扫描出发和正常归位结束时的跳变已补齐：首次动作保留首个确认区间，释放 head 后完成最后一段已确认归位；见 [移动边界跟进](../reports/motion_boundary_followup.md)。

## 已实现及当前使用方式

- Runtime 和独立 scripted Agent 可通过真实 API 完成扫描、整排移液、混匀、复查和报告。scripted 根据当前实验的 `scenario_id` 和对应 `scenarios/*.json` 任务运行确定性策略，不解释自由文本 goal。
- 三个场景：`routine_maintenance`（扫描、补液、复查）、`exchange_and_mix`（扫描、整排 50% 换液、振荡、静置、复查）、`environment_drift`（环境恢复与证据复查）。更换场景应创建/重置实验，而不是只修改目标输入框。
- Agent 目前只支持 lockstep。人工实时操作可用 realtime；启动 Agent 前切换 lockstep 并恢复 Runtime，随后 Agent 自行推进屏障，无需逐步点击。speed 只改变墙钟播放速度。
- LLM 模式是明确的占位入口，暂停为 `model_unavailable`；即使配置凭证也没有实现模型调用。工具表和 Agent 循环接口已有。
- 3D 动画、排枪、扫描几何、液位、环境事件、实时库存和回放已接权威数据；吸头几何及所有物理参数仍是展示估算。
- 最近修正：Agent 网关的 30 秒超时仅限制 SSE 建连，不再截断已连接的事件流；浏览器网络错误不会产生空白 error 日志。Agent 状态/日志避免每个时钟帧重建 DOM。画布 resize 与绘制在同一 RAF 内完成，避免清空画布后等待下一帧的闪白。

## 优先完成：异常恢复与账目一致性

| 优先级 | 问题及落点 | 必须验证的行为 |
| --- | --- | --- |
| P1 | `services/runtime/src/runtime.ts` 的 `discardUncommitted`，取消不占用头的动作误清理别人的载液 | 并行环境等待 + 加液吸取 6×100 µL，取消等待不会改变头、吸头、废液或加液账目；加液完成后载液非负、守恒 |
| P1 | `recoverOnStartup`，振荡中重启遗留 `plate.shake.active` | 真实进程 SIGKILL、同数据目录重启；未完成动作失败，振荡终结并保存，后续移液可用；头内载液中断也守恒且不重放已提交效果 |
| P2 | `reset` 未保存旧世界收尾 | 移液有载液时 reset，归档快照、效果、废液、头内状态一致，旧动作永远不能写入新实验；振荡收尾同样验证 |
| P2 | Agent 重启意图测试偶发失败及失败后不退出 | 检查 `CultureAgent.close()` 与在途 loop 的停止/完成顺序；真实进程终止与同库重启验证幂等恢复，不盲目重发；测试失败也清理服务与 DB |

现有 `node reports/review/reproduce.mjs` 的断言是“缺陷存在”。修复时将复现场景转成验证正确行为的正式回归测试，并更新复现脚本/报告，不能保留旧的缺陷断言再宣称测试全绿。不要只为通过测试修改错误码或删除断言。

## 随后推进：可选功能，尚未实施

1. **真实 LLM 适配器：** 接入明确配置的 provider/model，通过已有工具表和真实 API 运行。无配置、调用失败、非法工具参数必须显式暂停/失败，不能退回 scripted。以本地可控 HTTP 模型桩验证完整工具调用闭环；有真实凭证时再做实际模型验收，报告注明是否执行。
2. **Agent realtime：** 当前明确不支持。设计独立的决策调度/并发与新鲜度规则，不能在无屏障的时钟上声称保留 lockstep 确定性。
3. **有限视觉工作集与会话压缩：** 压缩时保留观测 ID、来源、时间、板 revision 及动作账目；不可用压缩摘要代替需要的最新证据。
4. **取头几何与实机标定：** 96 位吸头盒与六通道排枪几何需确认；尺寸、液体参数和传感器参数尚未标定。与模型侧协作，不改稳定节点层级或用动画补库存。

## 下一位 Agent 的执行要求

先完成上述异常恢复清单，再推进经用户指定的可选功能。沿用本地 `feat/b-framework`，检查工作区和最新提交，保留用户改动；不要重写已完成的前端或改动用户正在运行的实验。所有破坏性复现/演示使用独立临时数据目录和进程。

完成时提供：

- 修复后的真实 HTTP / 进程重启回归，包括逐孔体积、储液/废液/吸头/头内载液、事件/归档状态对账。
- `npm run typecheck`、`npm test`、相关浏览器验收、`npm run demo:all` 的实际结果；任何失败、偶发失败或未跑的真实模型测试如实记录。
- 可运行的真实 Runtime 演示及报告，注明限制和仍未做的功能。
- 更新 `docs/IMPLEMENTATION_STATUS.md`、本交接清单和 review 结果；完成本地 commit，未经用户要求不推送或合并。

## 远程浏览器入口

Codex 自动转发时，提供服务器原始地址（例如 `http://127.0.0.1:8790/pair#code=…`），不要把浏览器已经转换的 `localhost:随机端口` 再作为服务器链接打开，否则可能再次转发到不存在的端口。

如报 `host_not_allowed`，将错误中的准确 Host 加到启动参数 `--allow-host localhost:该端口`。更新配置前检查是否有在执行的动作，避免重启导致动作失败。保留原数据目录；在当前标签页刷新，必要时只替换 URL fragment 中的配对码。配对码有效 5 分钟、单次使用。
