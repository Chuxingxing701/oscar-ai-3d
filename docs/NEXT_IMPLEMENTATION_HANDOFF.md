# 下一阶段实施交接（2026-10-01，D0–D5 完成）

**D0–D5 长期培养会话 MVP 已完成**（设计 [LONG_LIVED_AGENT_DESIGN.md](LONG_LIVED_AGENT_DESIGN.md)、任务 [LONG_LIVED_AGENT_IMPLEMENTATION_PROMPT.md](LONG_LIVED_AGENT_IMPLEMENTATION_PROMPT.md)、结果 [检查点报告](../reports/long_lived_agent_checkpoint.md)）：一个实验一个长期会话、事件驱动 realtime 调度、pi 0.84.0 真实模型后端（OpenAI 兼容 wire + 真实工具调用）、任务记忆与压缩、总助手契约 v1 与独立客户端、Agent 面板会话 UI。原 P1/P2 异常恢复问题已在 D0 修复并以真实进程回归覆盖。

先读 `agent.md`、`docs/WORK_ALLOCATION.md`、v0.4 主设计、`docs/API_CONTRACT.md`（§10 会话/总助手契约）、[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) 的 D 阶段一节。历史跟进（布局/动画/网关）见各报告链接（保留有效）。

## 当前使用方式

- **长期会话（产品路径，realtime）**：`npm run dev` 起服务 → 顶栏切 realtime 并设 speed → Agent 页「为当前实验建立会话」→「创建监测任务」（演示协议：A 排 ≥ 330 µL、每 6 模拟小时检查、期限 26 模拟小时）或在对话框直接输入。会话跨浏览器关闭/进程重启延续；归档实验的会话只读。
- **模型后端**：`OSCAR_MODEL_BASE_URL/API_KEY(_FILE)/NAME[/PROVIDER]`（OpenAI 兼容，DeepSeek 就绪）。无配置 → loop `unavailable` + `model.unavailable`（可见，绝不回退 scripted）。测试/演示用显式 HTTP 模型桩 `services/culture-agent/test/model-stub.ts`（真实 wire/工具协议）。
- **总助手契约**：`/api/v1/agent/supervisor/v1/*`（overview/delegate/observe/adjust/control，delegated_principal + request_id + expected_revision；长任务立即返回 task_id；订阅断开不取消）。客户端样例 `tests/supervisor-contract.test.ts`。
- **scripted run（lockstep 确定性回归）**：Agent 页下方原区域保持不变；e2e/确定性测试继续覆盖。
- 3D 动画、排枪、扫描几何、液位、环境事件、实时库存和回放继续接权威数据；吸头几何及物理参数仍是展示估算。

## 关键机制（实现位置）

- 写防护链：会话 lifecycle → ownership generation（`claimOwnership` fencing）→ task 状态/goal_revision（迟到的模型响应按旧 revision 拒绝 `goal_revision_stale`）→ goal 写范围（`out_of_scope`）→ 预算（跨重启累计）→ 意图先落库 → 提交带幂等键。`services/culture-agent/src/executor.ts`。
- 唤醒：用户消息/自有意图动作终态（自动登记）/观测就绪/阈值条件（去抖+滞回+冷却，`environment.sampled` 仅调度器内评估不调模型）/sim 定时/恢复补齐。`scheduler.ts`。
- 事件账目：inbox (source,seq) 去重且与游标同事务；SSE 断线 JSON 补齐；观测在意图迟到归属后回放（`replayAttributedObservations`）；回合简报游标在采集时推进（回合期间发出的事件必达下一回合）。
- 记忆：checkpoint generation CAS；压缩只影响模型上下文，原始消息/事件/动作事实永不删除；`POST /sessions/:id/compact` 可强制。

## 优先下一步（建议顺序）

1. **真实模型验收**：拿到凭证后设置 `OSCAR_MODEL_*` 指向 DeepSeek，用 `npm run demo:all -- --only session_monitor` 或 UI 会话跑一轮自然语言目标，记录真实调用结果（当前明确：真实提供商未验证）。
2. **needs_input 自然语言闭环**：桩未覆盖“用户补参→模型继续”的对话路径（API/状态机已测）；真实模型下验证 `request_input` → 用户答复 → `needs_input→running`。
3. **视觉上下文**：把观测图片物化进模型上下文（pi 后端 `images:false` 现状；受限于 max images/预算、失效图片与板 revision 规则）。
4. **DSH 薄插件**：按 HistoPilot-DSH 模式把 supervisor v1 包成插件（契约已就绪，勿并行车轮）。
5. 取头几何与实机标定（历史遗留）。

## 执行要求

沿用本地 `feat/b-framework`，先检查工作区与最新提交；保留用户正在运行的实验（演示/故障注入一律用独立临时数据目录与进程）。破坏性验证后清理进程与数据库。完成时更新 `docs/IMPLEMENTATION_STATUS.md`、本文件与报告，做本地 commit，不推送不合并。

## 远程浏览器入口

Codex 自动转发时，提供服务器原始地址（例如 `http://127.0.0.1:8790/pair#code=…`），不要把浏览器已经转换的 `localhost:随机端口` 再作为服务器链接打开。如报 `host_not_allowed`，把错误中的准确 Host 加到 `--allow-host`。更新配置前检查是否有在执行的动作。配对码 5 分钟单次有效。
