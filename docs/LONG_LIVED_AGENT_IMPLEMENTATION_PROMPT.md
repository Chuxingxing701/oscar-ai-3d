# 下一位 Agent 的实施 Prompt：长期培养会话 MVP

把下面正文交给在本仓库工作的编码 Agent。目标是实现 D0–D5；不是继续写方案，也不是只给模型调用占位符。

---

你正在 `/home/solarise-am/oscar-MHS` 实现下一阶段 OSCAR 长期培养 Agent。

用户已确认：**一个培养实验一个长期会话作为 MVP，预留更高层总助手了解和调用每个 Agent–设备–loop 的接口。** Agent 由动作结果、观测、用户消息和明确监测条件驱动，不逐秒调用模型，不按动画时间猜测任务完成。

## 一、先读上下文并确认基线

按顺序阅读：

1. `agent.md`、`docs/WORK_ALLOCATION.md`、`docs/OSCAR_VIRTUAL_CULTURE_DESIGN.md`。
2. `docs/API_CONTRACT.md`、`docs/IMPLEMENTATION_STATUS.md`。
3. `docs/NEXT_IMPLEMENTATION_HANDOFF.md` 与其引用的 `reports/review/README.md`、`reports/review/reproduce.mjs`。
4. **`docs/LONG_LIVED_AGENT_DESIGN.md`**：本阶段产品边界、选型、状态模型、恢复语义、API 和验收依据。
5. 最近布局与动作边界跟进报告及测试，保留已有 3D 动画修复。

工作基线为 `feat/b-framework`，长期会话设计前的代码提交为 `d3a5525`。开始先看实际 git 状态与后续提交，不覆盖用户或其他 Agent 的新成果。上一阶段的“全部通过”是历史记录；当前已知异常恢复缺陷仍需你修复。

这次用户已授权实现本 prompt 范围。一般实现选择自行推进；只对阻止正确执行的缺失目标参数、凭证或外部约束提问。未经额外要求不推送、合并或改动正在使用的演示实验。测试/故障注入/长时演示使用独立进程和临时数据目录。

## 二、选型已定

- 培养 Agent：`pi-agent-core` + `pi-ai` 的嵌入式 SDK，领域工具由本服务注册。
- 默认与 HistoPilot 对齐锁定 `@earendil-works/pi-agent-core@0.84.0`、`@earendil-works/pi-ai@0.84.0`。先验证所需接口和 Node 24 兼容性；若有具体理由升级，记录 ADR、锁定成对精确版本、完成 adapter 契约测试后再使用。不要混用旧 `shouldStopAfterTurn` 与新 `finishTurn` 的示例。
- 服务、数据库、DeviceClient 仍沿用本项目 Node/TypeScript/SQLite/HTTP+SSE。OSCAR 自己持有任务、状态和恢复账本，不迁移到实验性的 pi-durable。
- DSH 预留为上层总助手或可替换适配方向，本轮不实现完整 DSH 主控；也不让一个 DSH loop 和一个 pi loop 同时控制设备。
- 首个真实模型默认优先 DeepSeek，通过服务端显式 provider/model/凭证配置；模型品牌与 harness 分开。不要复制或打印 HistoPilot/本机 DSH 的密钥，不自动读取用户其他应用的凭证。
- 没有凭证时先完成真实后端实现和可控 HTTP 模型桩的端到端验收；明确报告真实模型尚未验证。禁止用 scripted 冒充 LLM 或静默 fallback。

参考仓库固定提交：

- HistoPilot：`https://github.com/solarise94/HistoPilot`，`7c618ebdaf6ca90e677d6ded4ba93ec0b393b51e`。
- HistoPilot-DSH：`https://github.com/solarise94/HistoPilot-DSH`，`798954954cdf8e5455e4f0b228bf0ec77b58ec12`。

可参考其 SessionStore、事件恢复、checkpoint、视觉工作集、会话切换防串流和薄 DSH 插件；不复制病理坐标、只读 extra-tools 契约或整个大型 runner。设计里的本地 `/tmp` 调研副本不是稳定依赖，必要时自行只读获取固定源码。

## 三、连续完成 D0–D5

### D0：先修复恢复与账目问题

根据现有复现修复：

1. 取消不占共享头的环境等待不得清空别的移液动作载液。
2. 摇床运行中 Runtime SIGKILL 后恢复，必须终结残留 shake 状态，允许后续操作。
3. reset 必须把旧世界动作收尾、头内液体、废液和归档状态一致保存。
4. Agent close/restart 必须结束旧循环，在途响应不能继续提交；失败测试也要清理进程和数据库。

用真实进程 + HTTP 回归、逐孔和库存对账验证。现有复现脚本断言“缺陷存在”，修复后更新为正确行为或明确历史用途，不能留下错误断言却宣称通过。

### D1：长期会话与任务持久化

- 一个 `(runtime_instance_id, experiment_id)` 绑定唯一 CultureSession。
- 增量 schema migration，保存 messages、tasks、plan revisions/steps、wake conditions、inbox、intent、memory checkpoints 与独立 session_seq。
- 保留现有 Runtime run/action ID 及历史查询；session 不随一次 run/模型 turn 完成而结束。
- 当前 Runtime 一次只有一个当前实验。MVP 会话列表支持当前实验和归档回看，不伪造同设备多个同时活动实验。
- Task 至少有 running、waiting_device、waiting_condition、needs_input、paused 和各终态；同一会话一个主动任务，其余排队。
- reset 后新实验有新会话，旧会话写能力失效。迁移老数据幂等、可重启，记录 schema 版本。

### D2：事件驱动的单写者调度

- Runtime 终态/观测事件、用户消息、明确条件与定时唤醒驱动 loop。
- **实现 realtime Agent**：模型思考期间设备继续运行；写前重新读取权威状态、检查目标版本、证据与资源版本。
- 保留 lockstep 的 lease 协作；等待动作前持久保存 wake 并释放 lease，收到反馈才继续。不得在持有 lease 时 await 尚未执行完的设备动作。
- 模型 turn 结束、task 结束、run 结束、session 归档分别处理。
- 事件投递可重复，去重与游标落盘要一致。快照/SSE 衔接不能漏事件；缺口先重取状态再恢复。
- 单会话调度 owner/fencing generation 或等价机制；旧进程和旧 goal_revision 的迟到结果没有设备写权限。
- 持久化 intent 后提交，保存 action_id；受理后响应丢失或进程重启时先查原操作，不盲目再加液。跨 run 恢复要处理原授权/幂等作用域。
- sim_time 用于培养和监测；wall_time 用于网络/模型/进程超时。时钟域显式记录。
- 正常传感器采样/clock/RAF 不触发模型。阈值监听具备去抖、滞回、冷却与去重；模型调用量有可测上界。

### D3：真实模型、可调整目标与记忆

- 实现 AgentBackend 和 pi adapter，用实际工具调用而不是解析模型自由文本中的动作命令。
- 设备参数 schema 来自 manifest；模型只拿到当前授权的 OSCAR 领域工具，不能直接读写 Runtime DB 或操作 3D 几何。
- 形成 GoalSpec：资源范围、目标/约束、协议/profile 及版本、监测条件、期限、成功/停止条件和预算。
- 用户可以通过多轮对话继续任务、追问原因、补参数、调整范围。缺关键执行参数进入 needs_input；已有授权和参数充分时自动执行，不逐动作要求确认。
- scenario 提供初始世界，不决定用户所有目标；真实模型模式必须能处理预设剧本以外的已支持目标组合。
- 提供明确版本的 scan/assess、exchange/verify、mix/rescan、monitor/wait 技能组合，动作完成后按目标要求复查。
- 待执行计划、在途动作与已有副作用严格区分。修改目标不会撤销已经提交的液体效果。
- 持久对话 + 结构化任务记忆 + 过程证据 + 新鲜设备投影分开保存。压缩只影响模型上下文，不删除原始动作事实；保留未完成动作、待办、约束、证据引用和水位。
- 视觉上下文按需物化 asset 引用，限制图片数/预算；处理失效图片与板 revision，不能从旧摘要推断当前状态。
- 写工具串行，模型重试不重复设备副作用。明确按所选 pi 版本终止/挂起有限模型循环，等待由持久调度器处理。
- 任务累计预算跨多轮/多 run 保留。provider 错误、预算耗尽、无凭证都有真实可见状态，不转 scripted。

### D4：持续会话 UI 与总助接口

- Agent 页升级为实验会话列表、持续对话、任务/计划进度、等待原因/下次唤醒、证据与记忆摘要。
- 显示设备运行状态与 Agent loop 状态各自的新鲜度、时钟模式、sim_time、在途动作。
- 暂停 Agent、取消任务、暂停 Runtime 清楚区分；关闭浏览器不停止任务。
- 切换会话/归档实验时无消息串流和迟到 UI 写入，当前任务继续。
- 沿用同源配对、Host/Origin 与服务授权；不破坏 SSE、布局固定、动画首尾插值和整排移液。
- 提供版本化的总助委托/状态/订阅/调整/暂停/恢复/取消契约。长任务立即返回 task_id；连接断开不能隐式取消设备任务。
- 一个独立 HTTP 契约客户端能够完成委托和查询，证明 DSH 以后无需 DOM 或数据库访问。总助调用复用同一队列、权限、预算和 revision 校验。

### D5：验收并交付

至少完成这些真实路径：

1. 当前实验唯一长期会话，多轮修改目标、一次维护后继续监测、用户返回后继续同一会话。
2. 24 个模拟小时以上，3 次以上监测唤醒，至少一次维护与一次“不需要操作”，完成条件与演示参数明确记录。
3. 中途改变目标范围，旧模型响应不可提交越界动作。
4. 浏览器关闭、Agent SIGKILL、Runtime SIGKILL、受理后 HTTP 响应丢失、SSE 重复/断线/缺口；恢复不重复加液、逐孔及库存守恒。
5. 强制上下文压缩后未完成计划、证据、用户限制与等待条件仍可恢复。
6. realtime 下模型延迟/失败不阻塞设备，恢复后刷新状态；lockstep 原确定性回归保持。
7. 独立会话/归档数据隔离；会话恢复不读错实验，旧会话不能写新实验。
8. 正常 clock/传感器事件下模型调用次数不增长；有意义事件触发量有上界。
9. 显式 scripted 回归、真实 pi + HTTP 模型桩闭环、配置可用时真实 provider 演示分别标注，不混为同一种测试。
10. UI 无空白 error 日志、尺寸闪动和正常动作开始/归位瞬移的回归。

执行 `npm run typecheck`、`npm test`、相关/全量 e2e 与 `npm run demo:all`，按实际变化补充长期场景命令。一次检查通过后不无理由反复跑；失败要找原因，不能删关键断言或盲目延长等待掩盖问题。

没有模型凭证或外部服务时，继续完成不依赖它的全部实现和测试，在最终报告中准确列出真实模型未验证；不要把缺凭证作为只留下占位代码的理由。

## 四、工作纪律与交付物

- 每个阶段产出可核对代码、测试与小提交；先实现现有接口上的完整闭环，再扩大范围。
- 持续更新 `docs/IMPLEMENTATION_STATUS.md`、`docs/API_CONTRACT.md`、`docs/NEXT_IMPLEMENTATION_HANDOFF.md`，新增最终 schema/API/后端版本说明。
- 报告写到 `reports/long_lived_agent_checkpoint.md`：完成状态、具体命令结果、模型真实/桩区别、会话/任务/动作/观测 ID、恢复测试与账目、截图/演示入口、已知限制。
- 最终提交本地 commit；未经用户要求不 push/merge。没有 git 身份时不要改全局配置，沿用仓库既有作者信息并在报告中说明。
- 如果为演示启动服务，保留用户正在用的数据目录与实验。远程入口提供服务器原始 URL，让 Codex 转发；不能把已转发的 localhost 随机端口再当服务器链接转发。Host 只放行实际需要的值。
- 可暂缓完整总助手、真实 DSH 插件、多设备并行、在线学习任意代码技能、向量库和实机标定；不得把它们记作完成。
- 完成判断：用户能在一个长期培养会话中持续对话、修改目标、看到设备反馈，后台按事件执行并可靠恢复；不是仅仅“出现了聊天框”或“模型能回答一句话”。
