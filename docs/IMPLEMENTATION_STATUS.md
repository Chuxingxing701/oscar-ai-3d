# B 实施状态（C0–C3 主要框架检查点）

**下一阶段设计，尚未实施：** [长期培养会话与选型](LONG_LIVED_AGENT_DESIGN.md)及[实施 Prompt](LONG_LIVED_AGENT_IMPLEMENTATION_PROMPT.md)。MVP 为一个实验一个长期会话，pi 领域 Agent、事件驱动 realtime、持久任务/记忆，以及未来总助手契约；下文已实现状态不因此改变。

上下文切换后先读本文件。契约细节见 [API_CONTRACT.md](API_CONTRACT.md)，执行要求见 [B_IMPLEMENTATION_PROMPT.md](B_IMPLEMENTATION_PROMPT.md)。

**最新接续入口（2026-09-30）：** [下一阶段实施交接](NEXT_IMPLEMENTATION_HANDOFF.md) 列出实际尚未修复的 Runtime 异常恢复问题、Agent 测试竞争问题及可选功能。本文各检查点的原验收结果是历史记录；最近复核与限制见 [改动审查](../reports/runtime_changes_review.md)。scripted 已实现，但只支持 lockstep、按当前场景运行；LLM 适配器尚未接入。

分支：`feat/b-framework`（基于 main `1a956f9`；A 的未提交/untracked 交付已先拆分为 6 个提交保留）。

## 环境基线（2026-09-30）

- Node v24.21.0、npm 11.19.0、Python 3.14.4；本机无 Blender。
- npm registry 可用；Playwright 1.63.0 对应的 Chromium 1243 已在 `~/.cache/ms-playwright`。
- 接手时基线：`node --test web/scene/tests/scene.test.mjs` 9/9 通过；`python3 source/prepare_scene_assets.py --check` 通过。

## C0：工程与契约 — 完成

已实现：
- 根 `package.json`（npm workspaces `packages/*`、`services/*`，`engines.node >=24.15 <25`，精确版本）与 `package-lock.json`；`tsconfig.json`（`erasableSyntaxOnly`、`--noEmit`）。
- `packages/device-contract`：业务 ID/行列换算、演示 profile（6 通道 21.6 mm 排枪等明确标注的演示参数）、错误码与 HTTP 状态、manifest（JSON Schema 为参数唯一来源，阶段计划）、ajv 校验、整排范围规范化（部分排拒绝）、规范化 JSON、wire 类型、`DeviceClient`（Bearer、无 Origin、SSE）、由 manifest 机械生成的工具定义。
- `scripts/vendor-three.mjs`：从根锁定的 three@0.180.0 复制/校验 `web/vendor`（`npm run vendor:check` 字节一致）。
- `scripts/run-tests.mjs`：统一测试入口，含 A 的场景测试与资产校验。
- 场景最小兼容修复：`web/scene/state.js` 允许 `moving` 阶段 `target:null`（回待命位），其他阶段仍拒绝；补回归断言。

实际通过：`npm run typecheck`；`npm test`（vendor 校验 + 资产校验 + 16 项测试）。

约定：见 API_CONTRACT.md。整排 `plate_id + row_id`；每次取头扣 6 个逻辑吸头（加液 1 次、换液 2 次）；取头几何为示意。

## C1：Runtime 与设备闭环 — 完成（2026-09-30）

### 已实现

- `scenarios/`：`routine_maintenance`、`exchange_and_mix`、`environment_drift`（v1.0.0，显式演示参数；含任务 profile、容差、预算与 scripted 策略提示；环境偏移场景带 `camera_blur` 前置故障）。
- `packages/simulator`（`@oscar/simulator` 0.1.0，纯函数、无 DB/墙钟/可变 RNG）：
  - 无状态噪声：splitmix64/xmur3 哈希 `(seed, channel, sim_time, index)` → uniform/normal，重启精确复现（`src/rand.ts`）。
  - 世界 = JSON 值（chamber targets/actual/sample、板/孔/培养指数、储液/废液/吸头、排枪头载液、故障、计数器）；`stepWorld`（环境一阶响应 + 30 s 采样噪声 + 60 s 培养演进 + 蒸发单独记账不递增 plate.revision）。
  - 整排液体原语 `rowAspirate/rowDispense/reservoirAspirate/wasteDispense/tipsPick/tipsDrop/headDiscard`（逐通道独立体积为演示假设；营养/代谢按体积加权混合）。
  - 确定性成像：RGBA 渲染（孔圆+液位/颜色/浑浊；`culture_detail` 画按 well+形态 seeded 的类器官示意斑）+ 最小 PNG 编码器（filter 0、zlib 固定参数）；绘制前量化（体积 1 µL、颜色 1/255）；单目 1 张、双目同一冻结世界左右视差；shake/静置窗口/故障时 box blur，quality=blurred 且估计值全 null；`device_estimate` = 真值 + seeded 噪声（`simulated_onboard_analysis`，含 uncertainty_ul）。
- `services/runtime`（`@oscar/runtime`）：
  - SQLite（WAL/NORMAL/外键）表：experiments、worlds、actions（幂等索引列+canonical 请求）、events、observations、assets（BLOB+sha256）、runs、run_tokens、leases、wakes、sessions、pairing_codes、auth_failures、diagnostics、meta；单写者，每步一事务，提交守卫 `status='active'` 否则回滚并记 `stale_commit_dropped`。
  - 动作受理顺序严格按契约 §2；幂等（experiment+principal 作用域，canonical 比较 `device_id+capability+arguments+expected_revisions`，同键同请求 200 原响应体、异请求 409）；整排全孔预检（capacity/channel/min residual/储液/废液/吸头=6 或 12），任一失败整单拒绝并列出 wells；阶段时长来自 `DEMO_PROFILE.stage_s`，每阶段效果在其结束的那个仿真步事务内 6 孔+库存原子提交；取消立即终态（头内液体 `head_discard` 入废液守恒，`partial` 仅计液量/库存效果）；`picking_tip` 取第一个 ≥6 的吸头盒（逻辑库存，示意几何）。
  - 时钟：lockstep（active lease 冻结；有 run 按_speed_ 推进，run paused 仅在仍有未终结动作时推进；无 run 只响应同步 `control.step`）/ realtime（speed 0.1–3600）；屏障建立/同刻合并/立即终态 appended 触发/release 即时交接（next_lease 同事务）/重复 release 幂等/renew/TTL+max hold → expired + run paused(lease_timeout) + determinism_broken。
  - Runs：仅经网关创建（Runtime 事务先行：run+token+lockstep 首个屏障，转发 Agent 失败则 run ended(agent_unavailable) 并撤销屏障 → 503）；run token 绑定 experiment/run/capabilities/plates/max_actions 预算（403 budget_exhausted）；pause/resume/cancel/hold 语义；`POST /api/v1/runs/{id}/agent-status` 自报暂停。
  - Reset 单事务（archiving→撤屏障/唤醒→run ended(experiment_reset)+token 吊销→动作 cancelled 附部分效果→archived(successor_id)→同场景/seed 新实验不建屏障），旧实验只读冻结；重启恢复（未终态动作 failed(runtime_restarted) 保留已提交效果、屏障 revoked、run paused(runtime_restarted)、实验 paused）。
  - 鉴权按 §2/§6.6：Host 白名单（含 raw-Host 测试）、Origin 按方法/凭证区分、cookie `oscar_session` HttpOnly/SameSite=Strict/Path=/、operator.token 与 service.token 0600、一次性 5 分钟配对码（`OSCAR_RUNTIME_READY` 行 + `npm run pair`）、LAN 访问码 ≥16 字符否则退出非零、常量时间比较、5 次/IP 指数退避 429、会话 12 h、415 JSON 强制、无任何 CORS 头。
  - SSE（Last-Event-ID/after_seq 回放+live、clock 帧 ≤10/s、15 s 心跳、archived 帧后关闭、`?format=json` 分页）；静态白名单（/web/** 排除 node_modules/scene-tests/md/package.json、/models/*.glb、/pair、/login、/ → 302 workbench；正确 MIME；遍历防护；数据目录不可达）；网关 `/api/v1/agent/*`（operator-only，X-Service-Token，SSE 透传，Agent 掉线 503）。
  - `main.ts` CLI（§1 全部旗标，--port 0 支持），首个空库自动建默认实验（routine_maintenance/seed 42/lockstep），SIGTERM/SIGINT 优雅关闭。
- `web/pair.html`、`web/login.html`（纯静态，无任何令牌）；`scripts/pair.ts`（`npm run pair`）。

### 实际通过的命令（2026-09-30）

- `npx tsc -p tsconfig.json --noEmit`：0 错误。
- `npm test`：**107 项全部通过，0 失败**（C0 基线 + A 侧/操作台侧场景与适配 34 项、simulator 11 项、runtime 55 项、sqlite 冒烟 1 项，另含本文件未列的其余测试；vendor/资产校验通过）。`node --test services/runtime/test/*.test.ts packages/simulator/test/*.test.ts` 单独验证：66/66 通过。runtime 测试全部经真实子进程 + DeviceClient：row/守恒 6、幂等与资源锁 5、观测证据 6、确定性 4、屏障（含 hold/预算/Agent 掉线回滚）10、reset 6、恢复（含 kill -9 重启、SSE 断线重连）5、访问控制 12、端到端 1。
- `npm run pair`（对临时 Runtime 实测）：打印一次性配对链接。

### 约定与实现取舍（已同步标注到 API_CONTRACT.md【C1 细化】）

- 同一仿真步事务内事件统一携带步末 `sim_time_s`；`action.started` 在动作转 running 的步写入，阶段 0 `started_at_sim_s` 为该步开始时刻。
- `action.cancel` 不要求 Lease-Id（安全操作）；已吊销 run token → 401；on_hold 的 run 写请求 → 403 `run_on_hold`（先于 lease 校验）；lease 归属校验先于状态校验（他人 run 的 lease → 403）。
- `control.step` 仅在 lockstep 且无 run/lease 时可用（否则 400 invalid_request）；`clock.stepped` 为操作者节奏遥测，确定性比对排除。
- ID 全局唯一带实验序号：`act-001-01`、`obs-001-001`、`ast-001-001`、`run-001-1`；lease_id 全局单调。
- 逐孔语义校验（容量等）先于资源占用检查；幂等查找仍最先。
- operator 设备写在 run 状态为 active/paused（非 on_hold/ended）时 → `hold_required`。
- 错误码新增 `runtime_restarted`(503)、`target_changed`(409)、`timeout`(409)（device-contract 向后兼容追加）。
- TTL 环境变量：`OSCAR_LEASE_TTL_MS`、`OSCAR_LEASE_MAX_HOLD_MS`、`OSCAR_PAIRING_TTL_MS`、`OSCAR_RATE_LIMIT_BLOCK_MS`、`OSCAR_SESSION_TTL_MS`。
- 守恒断言使用 1e-6～5e-3 容差（浮点+蒸发跨快照记账）；`exchange` 移除量在提交时按当时孔体积计算（蒸发使其略小于受理时估计）。

### 已知限制

- Agent 服务本身（C3）未实现：网关测试使用测试内 HTTP 桩（仅接受 POST /runs），`/api/v1/agent/*` 纯代理路径在真实 Agent 就位前返回 503。
- 图像为示意合成（无字体/文字），双目深度 `depth_status='not_computed'`；取头几何为逻辑库存示意。
- `speed` 仅影响推进节奏；realtime 模式下无屏障（run 直接随钟运行）。
- SSE 在进程内单写者模型下推送（无跨进程广播）；大数据量分页 limit≤5000。
- 幂等响应体保留受理时的原 body（状态为 queued）；查询终态用 `GET /actions/{id}`。

### 下一步（C2 前置）

- C2 操作台接入：workbench 页面消费 state/SSE（`head` 投影已按 §10 供 shake/头动作分列）；`web/api/scene-adapter.js` 由 B 侧接手。
- C3：真实 Culture Agent（复用本屏障协议与 run token 流程）、三条演示、`npm run demo:all`。

## C2：操作台 — 完成（2026-09-30）

### 已实现

- `web/workbench.html|css|js`：Runtime 同源受控页面。顶栏（实验、时钟模式/倍率、模拟时刻、「暂停 Runtime」、单步/推进至空闲、重置、「冻结画面（仅显示）」、SSE 状态）；左侧设备/腔室/板孔网格/库存与实验历史；中央 3D（A 的 `mountScene`，默认内部视角，列表与 3D 拾取互相定位）；右侧「操作 / 相机 / 环境 / Agent」；底部动作阶段条与事件时间线；≤760 px 分区切换。
- `web/api/`：`http.js`（同源 cookie、统一错误、401 引导配对、只读模式在 fetch 之前拒绝写请求）、`stream.js`（先快照后订阅、seq 去重、缺口重建、仅最新一代 resync 生效）、`store.js`（纯 reducer + `replayAt` 只读回放重建；快照附带全部动作列表为权威）、`scene-adapter.js`（§10 投影：整排/单孔+camera/工位/归位，shake 只进板字段，显示时刻取服务端确认值）、`ids.js`。
- `web/panels/`：资源、操作（提交前显示「作用范围：plate-01 A1–A6（整排 6 通道同时吸排）」，请求只用 `plate_id+row_id`）、相机（单目/左右对照、前后对比、模糊时不显示数值）、环境（目标线/观测线趋势）、Agent（启动 scripted/llm、暂停/恢复/取消、hold、决策日志带 basis 与可点击证据、报告；503 时提示 Agent 不可用而人工操作可用）、时间线、历史（只读回放 banner，写控件全部禁用）。
- 场景只读诊断句柄 `window.oscarScene.getStatus()/updateErrors()`（无写接口），供浏览器验收断言场景从未拒绝投影。
- `tests/e2e/`：Playwright 1.63.0 配置、真实 Runtime+Agent 栈（global setup/teardown，隔离临时目录），8 项浏览器验收。

### 实际通过的命令

- `node --test tests/web/*.test.mjs`：28/28（适配器、流/存储、只读守卫、两项并发 resync/残留动作回归）。
- `npm run test:e2e`：干净克隆中 8/8，连续两次。

### 验收中修复的问题

- 扫描行进阶段在 Runtime 中没有 `tool:'camera'`，适配器按针排校验导致场景拒绝快照 → Runtime 扫描所有阶段标注 camera，适配器兜底推断；补单测与 e2e 断言。
- 手动 refresh 与 gap/error resync 重叠时旧快照后到，造成事件停滞 → generation 守卫；快照时丢弃未列出的非终态旧副本，并附全部动作列表。
- resync 覆盖了 `observation.created`，相机列表不刷新 → 快照后相机列表重载；相机重载在飞行中请求不再丢失。
- Agent 面板未监听 Agent SSE 的 `event: agent` 与 `{type,payload}` 结构 → 已对齐。


## C3：Agent 与演示 — 完成（2026-09-30）

### 已实现

- `packages/culture-policy`（`@oscar/culture-policy`，纯函数、无 IO/wall 钟/可变 RNG）：
  - `scriptedDecide(ctx)`：按场景的确定性演示策略，输入 = 任务 profile（scenario JSON）+ StateSnapshot + 已记录观测 + 已知动作结果 + 提交错误 + 策略记忆 → `{kind:'act'|'wait'|'finish'}`；决策理由短且引用证据（observation id、device_estimate 数值、scheduled_policy）。规则：routine（扫描→低于带下沿则整排 media.add 至带中点（钳位）→复查→finish）、exchange（扫描→fraction 换液→shake→静置 wait(at_sim_s)→双目复查→前后对比 finish）、drift（set_targets（同 lease 立即终态）→首扫模糊**不伪造视觉结论**→await_stable→复查→容差内 finish）。限度：预算/仿真期限、同行液体冷却 60 s、模糊扫描与 resource_busy/observation_stale 有界重试后 finish(failed)；只读 device_estimate，从不读真值（如需 oracle 标签必须显式 `oracle_demo`，本版未使用）。
  - `ModelAdapter {id; available(); decide(ctx)}`：`ScriptedAdapter`（用策略）与 `LlmAdapter` 占位（`OSCAR_LLM_PROVIDER/API_KEY/MODEL` 三者齐才 available；配置了也显式抛 llm_adapter_not_implemented，绝不静默回退）。工具表由 manifest 机械生成（`buildTools(manifest, run.capabilities)`，§7.1），已接入 ctx.tools 供未来 LLM 适配器。
- `services/culture-agent`（`@oscar/culture-agent`，独立进程）：
  - `main.ts`：仅绑 `127.0.0.1`（`--port`/`OSCAR_AGENT_PORT` 默认 8781，`--port 0` 支持）；先打印 `OSCAR_AGENT_LISTENING` 再等服务 token 文件（Runtime 创建，120 s 超时），完成重启恢复后打印 `OSCAR_AGENT_READY {"port":N}`；SIGTERM 优雅退出。
  - 自有 SQLite `<data>/agent/agent.sqlite`（目录 0700）：runs（**run token 仅存于此文件**，绝不写日志/接口/事件/报告）、intents（幂等键+规范化请求，**HTTP 前持久化**）、events（每 run 独立单调 seq）、seen（重启安全的事件去重）。
  - HTTP（仅网关调用，X-Service-Token 常量时间比较，缺失/错误 401，token 未加载 503）：`POST /runs`（202）、`GET /runs`、`GET /runs/{id}`（含报告）、`GET /runs/{id}/events`（SSE Last-Event-ID/after_seq + `?format=json`）、`POST /runs/{id}/control`。
  - 控制循环（lockstep）：设备 SSE `decision.granted`（run token）驱动 + 断线退避重连时 `leases/current` 补拾 + 启动期补拾（覆盖“resume 先于循环存在”）；每持约 `lease.granted`→gather→decide→act（键 `${run_id}-d${n}` 先落库，同 canonical 复用未决键）→release(wake)，`next_lease` 同刻继续；决策期每 ttl/3 续期；`OSCAR_AGENT_DECISION_DELAY_MS=min-max` 注入随机 wall 延迟（决策内容不依赖）。错误：busy/stale 交策略有界重试、`run_on_hold`→本地暂停（新屏障即续）、`lease_not_active`→重取屏障再规划、401/experiment_archived→结束；不确定失败（网络/5xx）先 `by-key` 对账。realtime：不受支持，run `ended(aborted)` 并在报告注明。
  - 报告：steps（决策/动作/效果摘要）、observations（id+图片 sha256）、库存对账（焦点排逐孔 start/end/delta、储液/废液/吸头）、环境前后、counts、`determinism_broken`；存 agent DB 并 `POST agent-status {status:'ended', reason, report}` 结束 run。
  - 重启恢复（§6.5/§6.6）：启动把本地 active 的 run 置 `paused(agent_restarted)` 上报 Runtime（吊销屏障）；无 action_id 的意图按 `by-key` 对账、**不自动重发**；恢复仅由操作者网关 resume 触发（新屏障 run_resumed），Agent 重新观察再规划（已成功的液体操作不重复）。Runtime 重启→SSE 断开重连→见 `paused(runtime_restarted)` 保持暂停。
- Runtime 最小扩展（【C3 细化】，已同步 API_CONTRACT.md §4/§4.2）：
  - `POST /api/v1/runs/{id}/agent-status` 增收 `{status:'ended', reason:'completed'|'failed'|'aborted', report?}`：走既有 endRun（吊销 token/屏障、取消未终结动作），report 存 `agent_reports` 表，`run.ended` 带 outcome；非法 reason 422。
  - 新增 `GET /api/v1/runs/{id}/report`（operator 或该 run token；无报告 404）。
  - store 增加 `agent_reports` 表；endRun 支持附加事件载荷。其余未动。
- 脚本：`scripts/dev.ts`（`npm run dev`：先起 Agent 再起 Runtime，等两行 READY，打印 workbench URL、一次性配对链接、`npm run pair` 提示、纯展示说明 `node server.mjs → http://127.0.0.1:8765/web/`；信号转发，任一退出即杀另一个；`--runtime-port/--agent-port/--data-dir`）。`scripts/demo-all.ts`（`npm run demo:all`：三场景+异常恢复各用独立临时数据目录起新进程，经网关以 operator 起 scripted run，结束后**经 API** 校验显式判据，写 `reports/demo/<demo>.json`+`summary.json`+`summary.md`，任一失败退出非零；`--only/--out-dir/--keep`；子进程必杀、临时目录默认清理）。根 package.json 增 `npm run runtime` / `npm run agent`。

### 实际通过的命令（2026-09-30）

- `npm run typecheck`：0 错误。
- `npm test`：**136 项全部通过，0 失败**（C0/C1 基线 107 + C3 新增 29：culture-policy/agent 单测 21（策略 13、HTTP 7、意图持久化与按键对账 1）、runtime agent-report 4、tests/system agent-e2e 3；另含 A 侧场景 34——与 C1 时相同，其中 3 项 e2e 为 C3 前已有）。另：`node --test services/runtime/test/*.test.ts` 59/59。
- `npm run demo:all`：**4/4 通过**（routine_maintenance 9 判据、exchange_and_mix 12、environment_drift 9、anomaly_recovery 7；全部 PASS，约 6 s wall，speed 600）。输出摘要：`=== summary: 4/4 demos passed ===`，报告在 `reports/demo/`。
- `npm run dev`（15 s 冒烟）：两进程就绪、工作台/配对链接/纯展示提示打印正常，退出无孤儿进程。
- `tests/system/agent-determinism.test.ts`：speed 1（含 50–350 ms 随机决策延迟）vs speed 600（10–500 ms）→ 规范化动作序列（capability/arguments/submitted_at_sim_s/status/ended_at_sim_s）、逐孔终体积、观测图片 sha256 列表**完全一致**，`determinism_broken=false`（单测约 61 s，speed 1 是真实墙钟）。

### 约定与实现取舍（已同步标注到 API_CONTRACT.md【C3 细化】）

- Agent 启动顺序解耦：先 `OSCAR_AGENT_LISTENING`（可接 `--port 0`）再等服务 token → 重启恢复 → `OSCAR_AGENT_READY`；token 未加载时请求 503。demo/e2e 依赖 LISTENING 行先起 Agent、再以实际端口起 Runtime。
- 异常恢复 demo/测试用 `OSCAR_LEASE_TTL_MS=120000/300000` 防止 kill -9 期间屏障过期（否则 Runtime 会 paused(lease_timeout)+determinism_broken）。
- `agent-status ended` 只能成功一次（endRun 吊销 run token）；Agent 对 401 视为“已结束”，本地仍留报告。
- 意图键 `${run_id}-d${n}`（n 为 act 决策序号，持久化计数器）；同 canonical（capability+arguments+evidence+reason+basis 规范化 JSON）复用未决键 → 不确定失败后重发同键，Runtime 幂等保证至多一次效果。
- 演示校验全部经 operator API（动作 summary/快照差量/事件/观测/报告），不信任 Agent 自述；未选孔比较用 0.5 µL 蒸发容差、换液体积恢复 2 µL。
- LLM 模式：无凭证/凭证不全 → run `paused(model_unavailable)`（上报+会话流 error 事件，无任何 decision 事件）；有凭证但未接线 → 决策抛错同样暂停，绝不静默回退 scripted。

### 已知限制

- LLM 适配器为占位（工具表已装配并传入 ctx）；realtime 时钟模式不支持（run 以 aborted 收尾并注明），屏障协议仅 lockstep。
- Agent 会话流 SSE 在进程内推送（与 Runtime SSE 相同的单写者模型）；Agent 不镜像设备事件，只记 Agent 侧事件。
- `reports/demo/` 为运行产物（含 run/action/obs id 与种子），不入库版本管理由评审决定。
- 策略的 observation_stale 恢复路径与“同行冷却”在当前三条演示中未被真实触发（运行时侧新鲜度校验先行），由单测覆盖。

### 下一步

- C2 操作台接入：Agent 面板消费 `/api/v1/agent/runs[/{id}[/events]]`（decision 事件已含 basis/reason/evidence_refs/capability/arguments；report 含库存对账与前后对比素材）。
- 演示页/CLI 对 `model_unavailable`、`agent_restarted` 暂停态的呈现与 resume 入口。

## 检查点汇总（2026-09-30）

C0–C3 主要框架检查点已达成，记录见 [reports/framework_checkpoint.md](../reports/framework_checkpoint.md)。干净克隆中：`npm ci` ✓、`npm run typecheck` ✓、`npm test` 139/139、`npm run test:e2e` 8/8、`npm run demo:all` 4/4、`npm run dev` 就绪且无孤儿进程。

后续可选 P2（未开始）：真实 LLM 适配器（工具表已装配）、有限视觉工作集与会话压缩、Agent realtime 支持、取头几何与实机参数确认。
