# 长期培养会话检查点报告（D0–D5）

日期：2026-10-01。分支 `feat/b-framework`。设计依据 `docs/LONG_LIVED_AGENT_DESIGN.md`，任务 `docs/LONG_LIVED_AGENT_IMPLEMENTATION_PROMPT.md`，契约 `docs/API_CONTRACT.md` §10，状态总览 `docs/IMPLEMENTATION_STATUS.md` D 阶段一节。

提交（本地，未推送）：`95d49ae`（D0 异常恢复）、`b403010`（pi 0.84.0 锁定）、`e04478d`（会话核心：store/调度器/pi 后端/supervisor 契约）、`2cc3524`（事件闭环修复 + 故障验收）、以及后续稳定性/文档提交（`git log --oneline -8` 查看）。

## 1. 完成状态

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| D0 异常恢复修复 | ✅ | 4 项缺陷修复 + 真实进程回归（下 §5.1） |
| D1 长期会话与任务持久化 | ✅ | schema v2 幂等迁移；唯一会话绑定；request_id/revision CAS；归档只读 |
| D2 事件驱动单写者调度 | ✅ | realtime 产品路径 + lockstep 回归并存；fencing + goal_revision 写防护；采样不唤醒模型 |
| D3 真实模型、目标与记忆 | ✅（真实提供商未验证） | pi 0.84.0 真实工具调用后端；GoalSpec；记忆 checkpoint + 压缩；显式模型桩闭环 |
| D4 会话 UI 与总助接口 | ✅ | 会话面板（对话/任务/计划/等待原因/证据/记忆/分离控制）；supervisor v1 + 独立客户端 |
| D5 验收 | ✅（桩路径） | 命令结果见 §4；故障矩阵见 §5 |

## 2. 模型真实/桩区别（如实标注）

- **真实模型（pi → OpenAI 兼容 wire）**：适配完成（`PiAgentBackend`，`services/culture-agent/src/backend.ts`；模型配置 `OSCAR_MODEL_BASE_URL/API_KEY(_FILE)/NAME[/PROVIDER]`，DeepSeek 形态就绪）。**本机无凭证，真实提供商调用未验证。**配置缺失时 loop `unavailable` + `model.unavailable` 事件，绝不回退 scripted（有专项测试）。
- **HTTP 模型桩（全部端到端验收使用的后端）**：`services/culture-agent/test/model-stub.ts`。它是一个**显式测试夹具**：监听 OpenAI `/v1/chat/completions`，按真实 SSE chunk + `tool_calls` 协议应答；决策从**模型同一上下文**（system prompt 内 GoalSpec JSON、WAKE 行、CURRENT DEVICE STATE JSON、观测摘要）确定性推导，不旁路 AgentBackend/调度器，也不读取 Agent 数据库。它验证的是调度、账目与恢复机制，不是自然语言理解。
- **scripted 回归路径**：原 lockstep RunLoop/policy 保持不变，确定性测试继续通过。

## 3. 端到端演示（`npm run demo:all -- --only session_monitor`）

显式演示参数：场景 `routine_maintenance`、realtime、speed 1200（1 模拟小时 = 3 墙钟秒）；目标 = plate-01 A 排各孔 ≥ 330 µL、每 21,600 模拟秒检查、期限 93,600 模拟秒；允许 imaging.scan + media.add；蒸发 4 µL/h（profile）。

最近一次运行的标识（`reports/demo/session_monitor.json`）：

- 会话/任务：实验 `exp-001`（会话 ID 见 JSON/事件），supervisor 委托任务 `task-a52e35d5-1e6`（立即返回 task_id）。
- 动作（service principal，全部 `succeeded`）：`act-001-01…04`（扫描/评估）、`act-001-05`（media.add 维护①）、`act-001-06/07`（复查）、`act-001-08`（media.add 维护②）、`act-001-09/10`（复查）。
- 观测证据：`obs-001-001…008`。
- 判据全 PASS：5 次监测唤醒、2 次维护、5 次"无需操作"决策、模型桩 22 次请求（有界）、储液守恒（用 393.6 µL，余 49,606.4，误差 ≤1 µL）、逐孔守恒（初值+动作效果−蒸发，6 孔 ±2 µL，26.4 模拟小时）。
- 其余 4 个演示（routine/exchange/drift/anomaly，scripted lockstep 路径）同样通过：`=== summary: 5/5 demos passed ===`。

UI 入口：`npm run dev` → 顶栏切 realtime（可设 speed）→ Agent 页建立会话/创建监测任务（按钮即上述演示协议）。远程入口提供服务器原始 URL（如 `http://127.0.0.1:87xx/pair#code=…`），勿二次转发 localhost 随机端口。

## 4. 实际命令结果（2026-10-01）

- `npm run typecheck` → 0 错误。
- `npm test` → **174/174**（`scripts/run-tests.mjs` 两相：并行 164 + 串行重进程 10：`long-session` 2、`session-faults` 7、`supervisor-contract` 1；进程密集验收串行以免互抢墙钟预算）。
- `npm run test:e2e` → **17/17**（含 Agent 面板新 UI：DOM 稳定性、无空白 error、SSE 30 s+ 不断流、scripted run 报告/证据断言保持）。
- `npm run demo:all` → **5/5**（新增 `session_monitor`）。
- 全部长会话/故障演示与测试均使用独立临时数据目录（`mkdtemp`），未触碰用户 `data/`。

## 5. 恢复测试与账目（全部真实进程）

1. **D0 回归**（`services/runtime/test/d0-recovery.test.ts`）：取消不占头的环境等待不清空他人在途载液；摇床中 SIGKILL→同库重启终结 shake；reset 一致归档（头内液体/废液/旧动作不可写新实验）；Agent close 后在途响应零写入。逐孔+库存对账。
2. **Agent SIGKILL + 重启**：首维护后 kill -9 → 同库重启 → 同一会话/对话/预算延续至完成；幂等键无重复；储液守恒（used 与 remaining 差 ≤1 µL）。
3. **Runtime SIGKILL + 重启**：设备不可达状态可见；同端口同库重启后 Agent 重连、补齐错过事件、完成窗口；无重复提交。
4. **受理后响应丢失**（进程内注入：请求到达 Runtime 后连接"死亡"）：by-key 对账恢复动作与预算；**恰好一次** media.add；观测经 `replayAttributedObservations` 迟到归属回放。
5. **写围栏（确定性）**：goal_revision 过期→`goal_revision_stale`；旧 ownership generation→`stale_owner`；范围外 plate→`out_of_scope`；归档会话→`session_archived`。
6. **归档隔离**：reset 后旧会话只读（消息 409 `session_archived`、历史可读）；新实验新会话零串扰。
7. **强制压缩**：checkpoint 生成、原始消息不删；下一回合上下文含 checkpoint 摘要且工具仍在。
8. **无模型配置**：`model_unavailable` 可见、零设备写入、无 scripted 回退。
9. **采样不唤醒模型**：任务等待期 12 墙钟秒（≈4 模拟小时的 clock/`environment.sampled` 事件）模型调用数为 0；唤醒保持 armed。

## 6. 会话/任务/动作/观测 ID 一览（最近演示）

见 §3（会话内完整事件流可从 `GET /api/v1/agent/sessions/:id/events?format=json` 或演示 JSON 获取；每事件带独立 session_seq）。

## 7. 已知限制

1. **真实 LLM 提供商未验证**（无凭证）——最重要的未验证项；§2。
2. 模型桩是确定性 FSM：覆盖机制不覆盖自然语言理解；needs_input 的多轮自然语言补参未在桩上走通（API/状态机已测）。
3. 视觉上下文未物化（后端 `images:false`）：观测以结构化 estimates+证据引用进入模型上下文；图片证据在 camera 面板。
4. 总助手为契约+独立客户端验证；完整 DSH 插件、多设备并行、在线技能学习、向量库、实机标定按 prompt 明确暂缓，未记作完成。
5. `npm test` 的重进程相在极端机器负载下仍可能接近超时上限（已串行化并留 300 s 上限）；如遇失败先看是否资源饥饿而非逻辑回归。
6. 仓库无全局 git 身份：按 prompt 要求以仓库既有作者 `Chuxingxing701 <1811940433@qq.com>` 做了 **repo-local** 配置（未改全局）。

## 8. 真实模型演示（待凭证）

```bash
export OSCAR_MODEL_BASE_URL=https://api.deepseek.com/v1   # 或其他 OpenAI 兼容端点
export OSCAR_MODEL_API_KEY_FILE=/secure/path/deepseek.key # 或 OSCAR_MODEL_API_KEY
export OSCAR_MODEL_NAME=deepseek-chat
npm run dev   # realtime + speed 调整后经 UI 会话下达自然语言目标
```

预期：真实 provider 走与桩完全相同的 `PiAgentBackend`/wire/工具协议；如失败按 `model.error`/`unavailable` 状态呈现。**该路径尚未执行，结果未记录。**
