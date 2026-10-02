# OSCAR Runtime API 契约（oscar-mhs-demo/0.1，/api/v1）

实现依据：[工程设计 v0.4](OSCAR_VIRTUAL_CULTURE_DESIGN.md) §5–§7 与 2026-09-30 排枪补充。类型定义以 `packages/device-contract/src/types.ts` 为准，能力与参数 schema 以 `packages/device-contract/src/manifest.ts` 为唯一来源。本文件记录实现时确定的细节；与设计冲突时以用户最新要求（整排排枪）为准，并在此注明。

## 1. 进程与端口

| 进程 | 默认监听 | 数据 |
| --- | --- | --- |
| Runtime `services/runtime/src/main.ts` | `127.0.0.1:${OSCAR_RUNTIME_PORT:-8780}` | `${OSCAR_DATA_DIR:-data}/runtime/`：`runtime.sqlite`、`operator.token`(0600) |
| Agent `services/culture-agent/src/main.ts` | 仅 `127.0.0.1:${OSCAR_AGENT_PORT:-8781}` | `${OSCAR_DATA_DIR}/agent/agent.sqlite` |
| 共享秘钥 | — | `${OSCAR_DATA_DIR}/secrets/service.token`(0600)，Runtime 首次启动生成，Agent 读取 |

Runtime 参数：`--port`、`--data-dir`、`--agent-url`、`--lan`、`--allow-host <host[:port]>`（可多次）、`--access-code-file`（或 `OSCAR_ACCESS_CODE`）、`--scenario`、`--seed`、`--clock-mode`。`--lan` 且访问码缺失或短于 16 字符时以非零码退出。【C1 细化】`--port 0` 允许（测试用）：实际端口从就绪行读取；启动时向 stdout 打印一行机器可读的 `OSCAR_RUNTIME_READY {"port":N,"pair_url":...,"data_dir":...}` 与一行人类可读的配对链接；`--data-dir` 支持绝对路径。墙钟 TTL 可用环境变量覆盖（见 §6）。

【C3 细化】Agent 参数：`--port`（`OSCAR_AGENT_PORT`，默认 8781，`--port 0` 支持）、`--data-dir`（`OSCAR_DATA_DIR`，默认 `data`，与 Runtime 共享）、`--runtime-url`（`OSCAR_RUNTIME_URL`，默认 `http://127.0.0.1:8780`）。启动顺序解耦：Agent 先绑定端口并打印 `OSCAR_AGENT_LISTENING {"port":N}`（此时服务 token 未加载，请求得 503），等 `<data>/secrets/service.token` 出现（Runtime 创建）并完成重启恢复（§6.5）后打印 `OSCAR_AGENT_READY {"port":N,...}`。`OSCAR_AGENT_DECISION_DELAY_MS=min-max` 注入随机 wall 延迟（仅确定性测试用；决策内容不依赖它）。SIGTERM/SIGINT 优雅退出。

### 【C1 细化】ID 唯一性

`runs.id`/`actions.id`/`observations.id`/`assets.id` 是全局主键，因此 ID 带实验序号：`act-001-01`（实验 001 的第 1 个动作）、`obs-001-001`、`ast-001-001`、`run-001-1`；实验 ID `exp-001`；`lease_id` 是全局单调整数。

## 2. 访问控制（§6.6）

请求处理顺序：Host → Origin → 认证/scope → Experiment active → 幂等键 → lease → schema → expected_revisions → 证据新鲜度 → 资源占用 → 受理。

- Host 必须在允许列表：loopback 模式 `127.0.0.1:P`、`localhost:P`、`[::1]:P`；LAN 另加 `--allow-host`。否则 `403 host_not_allowed`。
- 带 `Origin` 时必须等于 `http://` + 允许 Host，否则 `403 origin_mismatch`（任何方法、任何凭证）。
- 凭证：`Authorization: Bearer <operator|run token>`；会话 cookie `oscar_session`（`HttpOnly; SameSite=Strict; Path=/`）。
  - GET/HEAD：cookie 或 Bearer 皆可，无需 Origin。
  - 其他方法：带同源 Origin 时 cookie 或 Bearer 可用；**不带 Origin 时忽略 cookie，只认 Bearer**。
- 匿名可访问：`GET /api/v1/health`、`POST /api/v1/session`、白名单静态文件（§8）。其余 `/api/v1/*`（含状态、SSE、图片）缺凭证 `401 unauthenticated`。
- 带请求体的请求要求 `Content-Type: application/json`，否则 `415 unsupported_media_type`。不返回任何 CORS 头。
- Scope：operator（cookie/CLI token）全部接口；run token 绑定 `experiment_id + run_id + capabilities + plates + 预算`，只能 GET 读、提交范围内动作、取消自己的动作、操作自己的 lease、`POST /api/v1/runs/{run_id}/agent-status`；调用 control/reset/创建 Experiment/创建 run 返回 `403 forbidden`。service token 只被 Agent 接受，Runtime 用它调用 Agent。
- 配对：启动打印 `http://127.0.0.1:P/pair#code=<code>`；码 5 分钟有效，一次性。`POST /api/v1/session {pairing_code}` 或 `{access_code}`（LAN，常量时间比较，同 IP 连续失败 5 次后指数退避 `429 rate_limited`）。会话 12 小时，`DELETE /api/v1/session` 注销。`POST /api/v1/pairing-codes`（operator Bearer）重新生成配对码，CLI：`npm run pair`。
- 页面、静态资源和 HTML 中不出现任何令牌或配对码。

## 3. 资源、ID 与整排语义

- 设备 `oscar-01`，腔室 `chamber-01`，板 `plate-01`/`plate-02`（24 孔，4 行 A–D × 6 列），储液 `media-01`，废液 `waste-01`，吸头盒 `tips-01..03`（各 96 个逻辑吸头）。
- 排枪 6 通道、21.6 mm 针距（演示参数）。`media.add` / `media.exchange` 目标为 `plate_id + row_id`；可选 `wells` 必须恰为完整整排，否则 `422 invalid_argument`；单孔请求不会被扩大为整排。
- 整排各孔共享同一阶段的开始时间、时长与进度；逐孔体积分别记录与校验。储液/废液按全排实际总量记账；每次取头扣 6 个吸头（加液 1 次取头，换液 2 次）。
- 受理时检查全部孔：加液后任一孔 > 容量 → `422 capacity_exceeded`；换液 `fraction > 1 − V_min/V` 对任一孔成立 → `422 invalid_argument`；单通道体积 > `channel_max_ul` → `422 channel_volume_exceeded`；储液不足 `insufficient_media`；废液不足 `waste_full`；吸头不足 `insufficient_tips`。任一不满足则整项拒绝，不做部分孔。
- 每个阶段结束的那个仿真步内，一次整排体积转移与库存更新在同一 SQLite 事务提交（6 孔同时）。
- 取头几何为示意；吸头按逻辑库存扣减，不宣称物理对位标定。

阶段序列（`at` 为目标）见 `MEDIA_ADD_STAGES`、`MEDIA_EXCHANGE_STAGES`、`IMAGING_SCAN_STAGES`；时长来自 `DEMO_PROFILE.stage_s`，对齐 `sim_step_s = 1`。

## 4. 端点

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/health` | `{ok, service:'oscar-runtime', version}`，匿名 |
| `POST/DELETE /api/v1/session` | 配对/访问码换 cookie；注销 |
| `GET /api/v1/session` | `{authenticated, principal}` |
| `GET /api/v1/devices` | 设备列表 |
| `GET /api/v1/devices/oscar-01/manifest` | `buildManifest()` |
| `GET /api/v1/experiments` | `{current_id, experiments: ExperimentInfo[]}`（含归档） |
| `POST /api/v1/experiments` | operator；`{scenario_id?, seed?, clock_mode?}` 当前无 active 时创建；已有 active 返回 `409 experiment_active`（换世界用 reset） |
| `GET /api/v1/experiments/{id}/state` | `StateSnapshot`（含 `event_seq`、`revisions`、活动动作阶段、`head`、`lease`、`run`）。不含 `simulator_truth` |
| `GET /api/v1/experiments/{id}/chambers/chamber-01` | `ChamberReading` |
| `POST /api/v1/experiments/{id}/actions` | 头：`Idempotency-Key`（可选但 Agent 必须带）、`Lease-Id`（lockstep run 必须）。体：`SubmitActionRequest`。新动作 `202`，同键同请求 `200`（原响应体），同键不同请求 `409 idempotency_conflict` |
| `GET /api/v1/experiments/{id}/actions` | 全部动作（按 accept_seq） |
| `GET /api/v1/experiments/{id}/actions/{action_id}` | `Action` |
| `GET /api/v1/experiments/{id}/actions/by-key/{key}` | 同 principal 的幂等键查询；run 的 principal 为 `run:{run_id}`，operator 为 `operator` |
| `POST /api/v1/experiments/{id}/actions/{action_id}/cancel` | operator 或所属 run；立即终态（见 §5） |
| `GET /api/v1/experiments/{id}/observations[/{obs_id}]` | `Observation` |
| `GET /api/v1/experiments/{id}/assets/{asset_id}` | PNG 字节，`ETag: "sha256"`，`X-Content-SHA256` |
| `GET /api/v1/experiments/{id}/events?after_seq=N` | SSE；`?format=json&limit=` 返回 JSON 分页 |
| `GET /api/v1/experiments/{id}/leases/current` | `{lease}` |
| `POST /api/v1/experiments/{id}/leases/{lease_id}/renew` | 所属 run |
| `POST /api/v1/experiments/{id}/leases/{lease_id}/release` | 体 `{wake:{on_actions?, at_sim_s?}}` → `{lease, next_lease}` |
| `POST /api/v1/experiments/{id}/control` | operator：`ControlRequest` 之一 |
| `GET /api/v1/experiments/{id}/runs` / `runs/current` | Runtime 侧 run 记录 |
| `POST /api/v1/runs/{run_id}/agent-status` | run token；`{status:'paused', reason}` Agent 自报暂停（如 `agent_restarted`、`model_unavailable`）。【C3 细化】或 `{status:'ended', reason:'completed'\|'failed'\|'aborted', report?}`：经既有 endRun 路径结束 run（吊销 run token 与屏障、请求取消其未终结动作），report JSON 存入 `agent_reports` 表，`run.ended` 事件携带 `outcome` 与 `by:'agent'`；其余 reason 值 422。run 已结束后 token 已吊销，重复投送得 401（Agent 将其视为“已结束”而非错误） |
| `GET /api/v1/runs/{run_id}/report` | 【C3 细化】operator 或该 run 的（未吊销）run token：`{run_id, reason, report, created_at_wall}`；无报告 404。报告含 steps（决策/动作/效果摘要）、observations（id+图片 sha256）、库存对账（储液/废液/吸头/焦点排逐孔 start/end/delta）、环境前后、`determinism_broken` |
| `GET /api/v1/runs/{run_id}` | run token 或 operator：`RunRecord` |
| `/api/v1/agent/*` | 网关：operator 会话校验后代理到 Agent（附 `X-Service-Token`），SSE 透传 `Last-Event-ID`；Agent 不在时 `503 agent_unavailable` |
| `GET /api/v1/experiments/{id}/debug/truth` | 【C1 细化】仅 operator：暴露 `simulator_truth`（环境真值、逐孔 culture/蒸发、head 载液），用于测试校验与 `oracle_demo` 标注；不进入普通快照 |

### 4.1 run 创建与控制（经网关）

- `POST /api/v1/agent/runs {experiment_id?, scenario_id?, mode:'scripted'|'llm', goal?, plates?, budget?}`，可带 `Idempotency-Key`。Runtime 先在自身事务中：校验 Experiment active、无活跃 run（否则 `409 run_already_active`）、签发 run token、写 run 记录；lockstep 时同事务建立首个屏障（trigger `run_started`）并写 `decision.granted`。之后把 `{run_id, run_token, experiment_id, clock_mode, lease, ...原请求}` 转发给 Agent `POST /runs`。Agent 不可用则 Runtime 回滚：run `ended(reason=agent_unavailable)` 并撤销屏障，返回 503。
- `POST /api/v1/agent/runs/{id}/control {action:'pause'|'resume'|'cancel'}`：Runtime 先执行自身语义（pause：run→paused，撤销屏障；resume：run→active，新屏障 `run_resumed`；cancel：run→ended，撤销 token 与屏障，请求取消其未终结动作），再转发给 Agent。
- hold：`POST /experiments/{id}/control {hold:{run_id, on}}`。on：run→on_hold，撤销屏障，run 新写入 `403 run_on_hold`；off：run→active 并建新屏障。
- 其余 `GET /api/v1/agent/runs[/{id}[/events]]` 直接代理（Agent 会话流，自有 seq）。

### 4.2 Culture Agent 服务端 API【C3 细化】

Agent 是独立进程，仅监听 `127.0.0.1:port`，所有请求要求 `X-Service-Token` 与共享秘钥匹配（sha256 摘要常量时间比较；缺失/错误一律 401）。未加载服务 token 时 503。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /runs` | Runtime 网关转发（§4.1 的 payload：`run_id, run_token, experiment_id, clock_mode, lease, mode, goal, plates, capabilities, budget, scenario_id, seed`）。持久化 run 行（含 run token，仅存于 `<data>/agent/agent.sqlite`，该目录 0700，绝不写日志/接口/事件）→ 写 `run.accepted` 事件 → 启动控制循环 → `202 {run_id, accepted:true}`。同 `run_id` 重复转发返回 `202 {duplicate:true}`，不启动第二个循环 |
| `GET /runs` | `{runs:[{run_id, experiment_id, scenario, mode, status, pause_reason, counts:{decisions,actions,observations}, report_present, ...}]}` |
| `GET /runs/{id}` | 上述字段 + `report`（完成后） |
| `GET /runs/{id}/events` | Agent 会话流 SSE（`Last-Event-ID`/`after_seq`，帧 `id:<seq>` `event:agent`，15 s 心跳）；`?format=json&limit=` 分页 JSON。事件类型：`run.accepted`、`decision`（含 basis/reason/evidence_refs/capability/arguments）、`action.submitted`、`action.result`、`observation.recorded`、`wait`、`lease.granted`、`paused`、`resumed`、`error`、`report` |
| `POST /runs/{id}/control` | `{action:'pause'\|'resume'\|'cancel'}`，Runtime 已先行应用自身语义。pause：本地停止发起新动作；resume：按幂等键对账后在新屏障到达时继续；cancel：停止循环并写本地 `aborted` 报告（token 已被 Runtime 吊销，无法再投送） |

控制循环（lockstep）：以 run token 经 DeviceClient 订阅设备 SSE 的 `decision.granted`（断线退避重连并以 `GET leases/current` 补拾）；每次持约有 lease.granted 事件 → 读状态/动作结果/观测 → 纯函数 scripted 策略决策 → act：先持久化幂等键 `${run_id}-d${n}` 与规范化请求**再发 HTTP**（同一 canonical 复用未决键，绝不换新键重做液体操作）→ release(wake)，`next_lease` 非空则同刻继续 → finish：生成结构化报告（库存对账、观测 sha256、环境前后、`determinism_broken`）入库并 `POST agent-status {status:'ended', reason, report}`。决策期间每 `ttl/3` 续期。错误处理：`resource_busy`/`observation_stale` 交给策略有界重试；`run_on_hold` → 本地暂停（解除 hold 的新屏障到达即继续）；`lease_not_active` → 重取当前屏障再规划；`experiment_archived`/401 → 结束循环。

重启恢复（§6.5）：进程启动时把本地 `active` 的 run 置为 `paused(agent_restarted)` 并上报 Runtime（Runtime 吊销屏障）；对每个无 `action_id` 的持久化意图按 `GET actions/by-key/{key}` 对账，**不自动重发**；恢复必须由操作者经网关 resume 显式触发（新屏障 `run_resumed`），Agent 重新观察后从观测状态再规划（已成功的换液不会重复）。Runtime 重启时 Agent 的 SSE 断开重连，看到 run `paused(runtime_restarted)` 即保持暂停等待 resume。`mode:'llm'` 且 `OSCAR_LLM_*` 不完整 → run 置 `paused(model_unavailable)`（上报 Runtime 并写入会话流），绝不静默回退 scripted。`clock_mode:'realtime'` 不受支持：run 以 `ended(aborted)` 收尾并在报告中注明（演示 Agent 仅 lockstep）。

## 5. 动作状态机与执行

- 受理：一次性锁定全部资源（`head`、`plate:X`、`reservoir:X`、`waste:X`、`tips`、`chamber:X`）；冲突 `409 resource_busy`（retryable）。`queued` 在下一时钟步开始时转 `running`，阶段 0 从该步开始时刻起算。
- `environment.set_targets` 在受理事务内提交目标、`target_revision+1` 并直接 `succeeded`（202 响应体即终态）。
- `action.cancel`：queued/running 立即 `cancelled`，丢弃未提交的当前阶段；已提交阶段保留；头内已吸液量按 `head_discard` 记入废液（守恒）；`partial=true` 当且仅当已提交液量/库存效果。对终态动作取消返回当前终态。
- 结果 `summary`：逐孔 `removed_ul/added_ul`、`reservoir_delta_ul`、`waste_delta_ul`、`tips_used`。
- 证据新鲜度：带 `evidence_refs` 的液体动作（或 run 提交液体动作时必须带）要求 observation 属同 Experiment、同板、覆盖目标整排、`plate_revision == 当前`、时龄 ≤ `observation.max_age_s`，否则 `409 observation_stale`。【C1 细化】受理顺序中的逐孔语义校验（容量/通道/残留/库存）先于资源占用检查；幂等查找仍先于两者。
- `plate.revision` 在液量提交、shake 开始/结束时递增；蒸发与传感器采样不递增（蒸发单独记账 `evaporated_ul`）。
- Runtime 重启：running/queued/cancelling → `failed(runtime_restarted)`（附已提交效果），释放锁；屏障 `revoked`；run→paused(`runtime_restarted`)；Experiment 模拟 `paused=true`。

## 6. 时钟与屏障（§5.3）

- 固定步长 1 s。每一步是一个事务：queued→running → 各 running 动作按 `accept_seq` 推进阶段并提交到期效果 → 环境一阶响应与采样 → 培养演进 → 唤醒检查/建立屏障。事件在同一事务写入。【C1 细化】同一仿真步事务内写入的全部事件（含 queued→running 的 `action.started`）统一携带该步结束时刻 `sim_time_s`；阶段 `started_at_sim_s` 指向该步开始时刻。
- realtime：未暂停时按 `speed`（0.1–3600）的 wall 节奏执行整步。
- lockstep：存在 active 屏障时不推进；否则当存在未结束且非 on_hold 的 run 时按 `speed` 节奏推进（run paused 时仅在仍有未终结动作时推进）；无 run 时只响应 `control.step {until_sim_s|until_idle|steps}`（同步执行、立即返回新 sim_time）。【C1 细化】`control.step` 仅在 lockstep 且无 active run、无 active lease 时可用，否则 `400 invalid_request`。
- 屏障建立时机（仅在无 active 屏障时）：run 启动/恢复；该 run 已登记的唤醒条件在本步满足（`on_actions` 全部终态，或 `sim_time ≥ at_sim_s`）；该 run 的动作在本步以 failed/cancelled 异常终态（系统引发）。同一步多个触发合并为一个屏障，`triggers[]` 列出全部。【C1 细化】时钟步提交的该 run 动作终态（含正常 succeeded）同样构成 `action_terminal` 触发：需要时钟的动作其终态与下一次 `decision.granted` 同一 `sim_time` 且事件相邻。
- 持有期立即终态（`set_targets`、`cancel`）只把 `{kind:'appended', action_id}` 追加到当前屏障 `triggers[]`，不发新 `decision.granted`，`lease_id` 不变。【C1 细化】仅当活跃屏障属于该动作的 run 时追加。
- release：同事务登记唤醒；若已满足，当前屏障 `released` 后立即建立下一屏障并在响应 `next_lease` 返回（中间不推进）。相同请求体重复 release 返回原结果；不同体 `409 lease_not_active`。
- 续期 `ttl_wall_s=30`，累计持有上限 `max_hold_wall_s=300`。超时：屏障 `expired`，run→paused(`lease_timeout`)，run 与 Experiment `determinism_broken=true`。【C1 细化】TTL/持有上限/配对码时效/限流退避可用环境变量覆盖以便测试：`OSCAR_LEASE_TTL_MS`、`OSCAR_LEASE_MAX_HOLD_MS`、`OSCAR_PAIRING_TTL_MS`、`OSCAR_RATE_LIMIT_BLOCK_MS`、`OSCAR_SESSION_TTL_MS`。
- 写请求：lockstep run 缺 `Lease-Id` → `409 lease_required`；lease 非 active → `409 lease_not_active`；lease 属于他人 run → `403 lease_forbidden`（先校验归属再校验状态）。operator 写不需要 lease；但 run 活跃（非 hold）时 operator 的设备写动作返回 `409 hold_required`（先 hold，§6.6 人工介入）。【C1 细化】`action.cancel` 属安全操作，不要求 Lease-Id；已吊销的 run token 一律 `401 unauthenticated`；run 处于 on_hold 时其写请求 `403 run_on_hold`（优先于 lease 校验）。
- run 活跃期间改 `clock_mode` → `409 clock_mode_locked`；realtime 下 `/leases`（含 renew/release）→ `409 clock_mode_mismatch`。模拟暂停时新设备动作 `409 simulation_paused`（读取、取消、控制仍可用）。

## 7. Reset（§5.1）

单事务：旧 Experiment `archiving` → 撤销屏障与唤醒、run `ended(experiment_reset)`、run token 失效 → 未终态动作 `cancelled(cancel_reason=experiment_reset)` 并给出部分效果 → 释放锁，写终态事件与 `experiment.archived {successor_id}` → `archived` → 按场景与 seed 建新 Experiment（沿用 clock_mode），**不建屏障**，无 run。提交后 `AbortController` 中止旧世界内存任务。所有状态写入检查 `status='active'`，失败只记 `stale_commit_dropped` 诊断日志。发往旧 Experiment 的写、lease 请求与再次 reset → `409 experiment_archived`。

## 8. 静态资源白名单

Runtime 只提供：`/web/**`（排除 `web/node_modules`、`web/scene/tests`、`*.md`、`package.json`）、`/models/*.glb`、`/pair`（`web/pair.html`）、`/login`（`web/login.html`）、`/` → 重定向 `/web/workbench.html`。数据目录、SQLite、token、仓库其他内容一律 404。纯展示仍用 `server.mjs` / `server.py`。

## 9. SSE

- `GET /events?after_seq=N`（或 `Last-Event-ID`）：先回放持久化事件 `seq > N`，再推送新事件。帧：`id: <seq>\nevent: device\ndata: <DeviceEvent JSON>\n\n`。
- 非持久化时钟帧：`event: clock\ndata: {"experiment_id","sim_time_s","paused","speed","clock_mode"}`，最多 10 次/秒，无 id。每 15 s 注释心跳。
- 已归档 Experiment：回放历史后推送 `event: archived` 并关闭。
- 主要事件类型：`experiment.created`、`experiment.archived`、`action.accepted`、`action.started`、`action.stage_changed`（payload 含 `stage, primitive, target, from_target, tool, stage_started_at_sim_s, stage_duration_sim_s, step_index`）、`action.effect_committed`（payload 含 `StepEffect` 与提交后逐孔体积）、`action.succeeded|failed|cancelled`、`observation.created`、`environment.targets_set`、`environment.sampled`、`plate.shake_started|shake_stopped`、`decision.granted`、`lease.released|expired|revoked`、`run.created|paused|resumed|on_hold|ended`、`clock.paused|resumed|speed_changed|stepped`、`scenario.fault_injected`。【C1 细化】`clock.stepped` 每次 `control.step` 调用写一条（操作者节奏遥测，不属于世界因果，确定性比对时可排除）；`environment.sampled` 每 30 s 采样时写一条。错误码表新增 `runtime_restarted`(503)、`target_changed`(409)、`timeout`(409)（动作终态原因/重启恢复使用，向后兼容）。

## 10. 场景显示投影（B 的适配层 `web/api/scene-adapter.js`）

`StateSnapshot` → `scene.update()`：板/孔 `volume_ul/capacity_ul`；`plate.shake`；`actions` 只放 `snapshot.head`（当前占用共享头的阶段，最多一个），并发 shake 只进入板字段。阶段目标：整排 `{plate_id,row_id}`、扫描 `{plate_id,well_id}` + `tool:'camera'`、工位 `{resource_id}`、归位 `null`（场景做了最小兼容：`moving` 允许 `target:null` 表示回待命位）。显示时刻取服务端确认的 `sim_time_s`，不超前到未确认阶段或体积。

## 10. 长期培养会话与总助手契约（D 阶段，2026-10-01）

长期会话挂在 Culture Agent 上（网关同源代理 `/api/v1/agent/*`，operator 凭证；Agent 侧统一 X-Service-Token）。设计依据 [LONG_LIVED_AGENT_DESIGN.md](LONG_LIVED_AGENT_DESIGN.md)；本节记录实现时确定的细节。

### 10.1 会话与任务 API（`/api/v1/agent/...`）

| 操作 | 端点 | 语义 |
| --- | --- | --- |
| 列出会话 | `GET /sessions` | 当前实验 + 归档回看；每项含 loop_state、active_task、last_message_seq/last_event_seq |
| 建立/获取唯一会话 | `POST /sessions` `{experiment_id?}` | 对 `(runtime_instance_id, experiment_id)` 幂等 get-or-create；归档实验 409 `experiment_archived`；默认取 Runtime 当前实验 |
| 会话详情 | `GET /sessions/:id` | messages（尾 50）、tasks、plan、armed wakes、checkpoint、last_seq |
| 继续对话 | `POST /sessions/:id/messages` `{content, request_id?}` | request_id 幂等（重发返回原 message）；202 返回 message_id；唤醒调度器 |
| 会话事件 | `GET /sessions/:id/events?after_seq=&format=json\|sse` | 独立 session_seq 单调；SSE 支持 Last-Event-ID 断点续传 |
| 创建任务 | `POST /sessions/:id/tasks` `{goal_text, goal_spec, request_id?, budget?}` | goal_spec 校验（GoalSpec）；request_id 幂等（重放返回原任务——**包括仍在排队时**；异体 409 `idempotency_conflict`）。**R07 任务队列**：无当前任务→`ready`（缺关键执行参数→`needs_input`）；已有当前任务（任何非终态：paused/needs_input 也算）→不再拒绝，持久化为 `queued`，按 queue_index FIFO 排队，响应 `task.status='queued'` + `task.queue_position`（1 起）。四个入口（Web UI、用户 HTTP、总助手委托、模型 `propose_task`）共用同一 store 级幂等入口 |
| 任务详情/更新 | `GET/POST /tasks/:id` | 更新带 `expected_revision`（CAS，冲突 409 `revision_conflict`），goal_revision 单调递增；详情含 `queued`、`queue_position`（排队中才有值） |
| 任务控制 | `POST /tasks/:id/control` `{pause\|resume\|cancel}` | cancel=取消在途设备动作并对账+撤销 wakes；与 Runtime 控制语义分离。**排队任务**：cancel 直接置 `cancelled`（无设备副作用，队列剩余顺序不变）；pause/resume 对 `queued` 任务拒绝 409 `task_queued`（排队任务未持有执行槽，晋升后才可暂停/恢复） |
| 聚合状态 | `GET /sessions/:id/status` | 设备新鲜度（可达/时钟/sim_time/在途动作）、loop 状态与等待原因、下次唤醒、预算、水位（消息/事件/inbox/checkpoint）、模型可用性；**R07**：`task`=当前任务（永不返回排队任务）、`queue`=[{task_id, goal_text, status, position}]（FIFO 有序）、`queued_tasks`=queue 长度 |
| 会话控制 | `POST /sessions/:id/control` `{pause_agent\|resume_agent}` | 暂停 Agent=停止新决策/新动作（任务与设备不受影响） |
| 强制压缩 | `POST /sessions/:id/compact` | 测试/演示钩子：生成 checkpoint（generation 递增），原始消息不删 |
| 记忆 | `GET /sessions/:id/memory` | 最新 memory checkpoint（summary/facts/open_questions/evidence_refs/versions） |

写拒绝：归档会话一律 409 `session_archived`（messages/tasks/control/compact）。

### 10.1.1 任务队列状态机与自动晋升（R07）

- 状态新增 `queued`。**当前任务（current）= 唯一的非终态、非 queued 任务**（paused 与 needs_input 属于当前任务：它们占住执行槽、阻塞队列，但不是终态）。`activeTask()` 永不返回 queued 任务。
- **准入与晋升共享同一规则（N04）**：执行槽只有在「无当前任务、无排队任务、且无待清交接（`sessions.handoff_pending=0`）」时才视为空闲。当前任务进入终态（completed/failed/cancelled）的同一事务写入 `handoff_pending=1`；晋升例程在屏障通过后清除它（无论其后是否晋升了任务）。因此任何入口的新任务只有在槽真正空闲时才诞生为 `ready`，否则一律 `queued`（queue_index = MAX+1，FIFO）——**终结→晋升之间的窗口（上一任务意图未对账、在途动作未终态、进程恢复中）不再能被后来者插队**。request_id 重放返回原任务（含排队中），异体冲突。
- 晋升（单一 SQLite 事务，CAS）：仅当不存在当前任务且 `handoff_pending=0` 时，把 queue_index 最小的 queued 任务置为 `ready`（缺执行参数则 `needs_input`）。发 `task.status` 与 `task.promoted` 会话事件，然后调度器为晋升任务启动一个回合（onTaskCreated 式 kick）。晋升等待（= 交接屏障，由 `maybePromoteNext` 独占负责并在通过后清除 `handoff_pending`，发 `task.handoff_cleared` 事件）：上一任务的未决意图（session_intents `pending`）先对账（by-key reconcile，查询本身失败则留待下一个终态事件/watchdog/重启重试），非终态在途设备动作先到终态（其终态事件重入触发晋升）；任一时刻只有一个任务持有执行权。排队中的任务不持有任何执行权：执行器对 `queued` 任务的写请求直接拒绝（`task_queued`）。
- 触发晋升的时机：当前任务经模型 complete/fail、预算耗尽、操作者/总助手 cancel 或归档进入终态后的回合结束；设备动作终态事件；进程重启恢复（补偿"终态后、晋升前"崩溃窗口）；以及**新建 queued 任务时**（用户/总助手/模型入口在入队后立刻 kick 晋升路径，使立即可晋升的队首尽快 ready；watchdog 周期也会清除已过屏障的残留 handoff 标记）。
- 旧回合隔离：回合绑定 task_id；已取消/终态任务的回合在 turnStale/writeRefusal 处拒绝写入，无任务回合不能为新晋升任务写（host.submitWrite 对 null 任务返回 `task_gone`）。
- 归档/reset：会话归档时 queued 任务全部置 `cancelled`（reason `session archived`），永不晋升。
- 暂停/恢复：`paused` 的当前任务继续占槽（队列不前进）；期间用户聊天仍以无任务会话回合回答。queued 任务的 pause/resume 拒绝 409 `task_queued`，仅允许 cancel。
- 重启：队列顺序与单写者不变；启动恢复在 reconcile 后、恢复回合前尝试晋升。
- **设备取消状态机（N05）**：取消意图按动作持久化（session_intents `cancel_state`: `none|requested|confirmed`，另有 `cancel_attempts`、`cancel_last_error`）。`requested` 在尝试发出前落库；成功（POST 被受理，或动作已是终态——Runtime 对终态动作的取消返回其当前状态，"已取消"即确认）→ `confirmed`（幂等终点，不再重复 POST）。任何失败（读/写网络错误、5xx、受理后响应丢失）保持 `requested` 并安排有界退避重试（1 s→30 s，unref 定时器，stop 清除，自动尝试封顶并发出可见错误事件）；用户/总助手再次显式取消总是重新尝试所有 `requested` 项并重置计数；进程内去重只针对并发的在途尝试，绝不抑制重试；调度器重启恢复时重新尝试所有持久化 `requested` 项。

### 10.2 GoalSpec（goal_spec 字段）

`{description, scope:{plates, rows?, reservoirs?}, metrics:[{metric, op, value, source, row_id?}], allowed_operations, monitoring:{interval_sim_s?, conditions?}, deadline_sim_s?, success:{description}, stop:{description, max_corrections?}, budget?, missing_parameters?}`。metric ∈ medium_volume_ul|liquid_level_ul|temperature_c|co2_pct|humidity_pct；allowed_operations ⊆ manifest 写能力。写工具执行前校验 scope（plate/row/reservoir 越界→`out_of_scope`）。

### 10.3 总助手契约 v1.1（`/api/v1/agent/supervisor/v1/*`）

`GET /supervisor`（契约自描述）、`GET /overview`、`POST /sessions`、`POST /sessions/:id/messages|/tasks`、`GET /sessions/:id/status|/events`、`GET/POST /tasks/:id`、`POST /tasks/:id/control`。与 10.1 同一核心（同队列/预算/revision 校验）；写操作要求 `delegated_principal`（服务端审计记录，权限不信任调用方自述）；长任务立即返回 `task_id`；订阅（SSE/JSON 轮询）只观察——断开不取消设备任务。响应带 `contract_version: "1.1.0"`。外部客户端示例：`tests/supervisor-contract.test.ts`（纯 HTTP，无 DOM/DB）。

**v1.1.0（R07，向后兼容新增）**：委托时若已有当前任务，不再 409 `task_already_active`，而是入队并返回 `status:'queued'` + `queue_position`（同 request_id 重放返回原任务，异体 409 `idempotency_conflict`）；`overview` 每会话新增 `queue`（有序 [{task_id, goal_text, status, position}]）与 `queued_tasks`；`/status` 同样带 `queue`；排队任务的 control 仅接受 cancel（pause/resume → 409 `task_queued`）。

### 10.4 Runtime 侧最小扩展

- `GET /api/v1/health` 增返 `instance_id`（首次启动生成存 meta 表；会话绑定用它区分数据目录身份）。
- Bearer service token（`<data>/secrets/service.token`）认证为 principal `service`：可读全部 operator 可读端点、可在 **realtime** 实验提交/取消动作（lockstep 实验写拒绝 409 `clock_mode_mismatch`，lease 纪律不变）。
- `GET /actions/by-key/:key` 的 principal 作用域含 `service`（会话意图 by-key 恢复）。
- 新错误码：`session_archived`(409)、`task_already_active`(409，保留给旧调用方兼容；R07 后创建不再触发)、`task_queued`(409，排队任务只接受 cancel)。

### 10.5 模型后端配置（服务端显式，无静默回退）

`OSCAR_MODEL_BASE_URL`（OpenAI 兼容，如 DeepSeek `https://api.deepseek.com/v1`）、`OSCAR_MODEL_API_KEY` 或 `OSCAR_MODEL_API_KEY_FILE`、`OSCAR_MODEL_NAME`、可选 `OSCAR_MODEL_PROVIDER`（默认 `custom-openai`）。缺失→会话 loop `unavailable` + `model.unavailable` 事件（UI/状态可见），不回退 scripted。pi 版本成对锁定 `@earendil-works/pi-agent-core@0.84.0` + `@earendil-works/pi-ai@0.84.0`。测试用 HTTP 模型桩：`services/culture-agent/test/model-stub.ts`（显式夹具，走真实 wire/工具协议）。
