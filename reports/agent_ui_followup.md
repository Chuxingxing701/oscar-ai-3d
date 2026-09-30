# Agent 入口、事件流与闪白跟进（2026-09-30）

用户截图的 `run-004-1` 为 `scripted` / `realtime`，动作预算使用 0，报告明确为 `aborted`：当前 Agent 只有 lockstep 决策屏障实现。scripted 主流程已完成，其动作来自当前场景的确定性策略；不是待实现的文档操作。自由文本 goal 不参与此策略，真实 LLM 适配器仍是占位。

## 本次修复

1. Agent 入口显式说明当前场景、scripted 的行为与 LLM 未接入状态。realtime、暂停或回放时禁用启动，并提供切换/恢复提示。scripted 禁用 goal 输入，提交时不再传送不会被解释的自由文本。
2. `services/runtime/src/gateway.ts` 原来使用覆盖整个 fetch/body 生命周期的 30 秒 AbortSignal，导致健康 Agent SSE 也定期中断。改为连接/普通响应仍有超时，SSE 响应头到达后解除总时长限制；下游关闭时 abort 上游，完成/异常时清理计时器和监听器。
3. `web/panels/agent.js` 不把无 `data` 的原生 EventSource 网络错误当成 Agent 事件；重连提示在连接恢复后清除。日志/报告仅在事件变化时重建，状态/控制按钮仅在 run/replay 变化时重建。避免重复建立刚启动 run 的事件订阅。
4. `web/scene/index.js` 的 ResizeObserver 仅记录最新尺寸；setSize（清空 WebGL 缓冲）和实际绘制在同一 RAF 内完成，尺寸相同时不重复清空画布，避免布局变化后出现空白中间帧。

这些是针对已找到原因的修复，不宣称穷尽所有浏览器/驱动相关的闪烁问题。

## 验证

- `npm run typecheck`：通过。
- `node --test tests/web/*.test.mjs web/scene/tests/scene.test.mjs`：最后一次 50/50。
- `npm test agent-report`：4/4，真实 Runtime HTTP 网关/报告路径。
- 现有 `tests/e2e/agent.spec.ts`：scripted 实际完成扫描→整排补液→复查，Agent 停止后人工操作仍可用，两项均通过。
- 新增 `tests/e2e/agent-stream.spec.ts`：最终 2/2。真实 SSE 持续 32 秒不结束、无伪错误日志、时钟更新不重建状态/日志；真实 Agent 进程停止/重启后正确重连及去重；操作台切换 lockstep 后启动可用。三次画布尺寸变化都验证属性更新时已完成重绘。
- `git diff --check`：通过。本轮未重跑完整系统套件/全部浏览器项目，以上为针对变更的实际验证。

测试编写中有两次失败也记录在此：浏览器 offline 模拟未关闭已有 SSE socket，因此改用真实 Agent 进程终止；通过外部 API 切换到静止 lockstep 不触发操作台主动刷新，因此改为通过实际顶栏控件执行用户操作。最终回归使用真实故障和真实操作台入口，没有删除对应行为断言。

## 运行实例与下一步

在确认没有活动动作/run 后更新当前测试服务，保留 `/tmp/oscar-review-live-20260930` 和 `exp-005`，恢复其原先未暂停状态。允许当前转发 Host `localhost:65511`，探测返回 200。没有 reset 用户实验或消费其配对码。

未完成项与下一位 Agent 的执行要求已集中到 [下一阶段交接](../docs/NEXT_IMPLEMENTATION_HANDOFF.md)。三个 Runtime 异常恢复缺陷及 Agent 重启测试竞争问题本轮仍未处理。
