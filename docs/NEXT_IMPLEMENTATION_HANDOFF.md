# 下一阶段实施交接（2026-10-03，复验 R01–T01 已关闭）

**D0–D5 长期培养会话已完成，独立复验没有未关闭的阻塞项。** 设计 [LONG_LIVED_AGENT_DESIGN.md](LONG_LIVED_AGENT_DESIGN.md)，检查点 [报告](../reports/long_lived_agent_checkpoint.md)，复验修复 [long-lived-reacceptance-fixes.md](../reports/review/long-lived-reacceptance-fixes.md)，T01 关闭 [long-lived-t01-independent-review.md](../reports/review/long-lived-t01-independent-review.md)。一个实验一个长期会话、事件驱动 realtime 调度、pi 0.84.0、任务队列、四项版本化技能、总助手契约 1.1.0、Agent 面板。

先读 `agent.md`、[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) 的 D 阶段与「复验关闭」、`docs/API_CONTRACT.md` §10。审查脚本是验收基准，不要改它们的期望。

## 当前使用方式

- **长期会话（产品路径，realtime）**：`npm run dev` 起服务 → 顶栏切 realtime 并设 speed → Agent 页「为当前实验建立会话」→「创建监测任务」（演示协议：A 排 ≥ 330 µL、每 6 模拟小时检查、期限 26 模拟小时）或在对话框直接输入。会话跨浏览器关闭/进程重启延续；归档实验的会话只读。
- **模型后端**：`OSCAR_MODEL_BASE_URL/API_KEY(_FILE)/NAME[/PROVIDER]`（OpenAI 兼容，DeepSeek 就绪）。无配置 → loop `unavailable` + `model.unavailable`（可见，绝不回退 scripted）。测试/演示用显式 HTTP 模型桩 `services/culture-agent/test/model-stub.ts`（真实 wire/工具协议）。
- **总助手契约**：`/api/v1/agent/supervisor/v1/*`（overview/delegate/observe/adjust/control，delegated_principal + request_id + expected_revision；长任务立即返回 task_id；订阅断开不取消）。客户端样例 `tests/supervisor-contract.test.ts`。
- **scripted run（lockstep 确定性回归）**：Agent 页下方原区域保持不变；e2e/确定性测试继续覆盖。
- 3D 动画、排枪、扫描几何、液位、环境事件、实时库存和回放继续接权威数据；吸头几何及物理参数仍是展示估算。

## 关键机制（实现位置）

- 写防护链：会话 lifecycle → ownership generation → task 状态/goal_revision → 范围 → 预算 → 意图先落库 → 最后一次 await 之后再查撤权 → 提交带幂等键。`executor.ts`。计划/步骤写入同样在最后一次 await 后重查，并用 CAS。
- 队列：当前任务占槽（含 paused / needs_input）。新任务只在无当前任务、无队列、且 `handoff_pending` 已清除时才是 `ready`，否则 `queued`。动作状态查不到时不晋升。
- 唤醒：用户消息、自有动作终态、观测就绪、阈值（去抖+滞回+冷却；读 Runtime `environment.sampled` 的 `sample` 字段，普通采样不调模型）、sim 定时、恢复。成功证据的去抖不得短于目标 `debounce_sim_s`（`debounce_shortened`）。`scheduler.ts`、`skills.ts`。
- 事件账目：inbox (source,seq) 去重且与游标同事务；SSE 断线 JSON 补齐；观测在意图迟到归属后回放（`replayAttributedObservations`）；回合简报游标在采集时推进（回合期间发出的事件必达下一回合）。
- 记忆：checkpoint generation CAS；压缩只影响模型上下文，原始消息/事件/动作事实永不删除；`POST /sessions/:id/compact` 可强制。

## 优先下一步（建议顺序）

复验阻塞项已关闭。剩下的都不是当前验收门槛：

1. **真实模型验收**：设置 `OSCAR_MODEL_*` 后跑一轮自然语言目标。现在明确未验证。
2. **视觉上下文**：pi 后端仍是 `images: false`。
3. **低级遗留**（见实施状态）：面板字面量 `null`、监测模板绝对期限 93600、未复现的队列卡片、桩把 REST 路径写进对话。
4. **测试入口**：`scripts/run-tests.mjs` 用 `args.length === 4` 判断空阶段，过滤后只剩一个文件时会跳过该阶段。单文件用 `node --test`。
5. **DSH 薄插件**、取头几何标定：仍按原计划暂缓。
6. 滞回/冷却尚未做成与去抖相同的“不得弱于目标”成功门槛。T01 只约束去抖。

## 执行要求

沿用本地 `feat/b-framework`，先检查工作区与最新提交；保留用户正在运行的实验（演示/故障注入一律用独立临时数据目录与进程）。破坏性验证后清理进程与数据库。完成时更新 `docs/IMPLEMENTATION_STATUS.md`、本文件与报告，做本地 commit，不推送不合并。

## 远程浏览器入口

Codex 自动转发时，提供服务器原始地址（例如 `http://127.0.0.1:8790/pair#code=…`），不要把浏览器已经转换的 `localhost:随机端口` 再作为服务器链接打开。如报 `host_not_allowed`，把错误中的准确 Host 加到 `--allow-host`。更新配置前检查是否有在执行的动作。配对码 5 分钟单次有效。
