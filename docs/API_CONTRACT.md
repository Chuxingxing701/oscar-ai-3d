# OSCAR Runtime API 契约（oscar-mhs-demo/0.1，/api/v1）

实现依据：[工程设计 v0.4](OSCAR_VIRTUAL_CULTURE_DESIGN.md) §5–§7 与 2026-09-30 排枪补充。类型定义以 `packages/device-contract/src/types.ts` 为准，能力与参数 schema 以 `packages/device-contract/src/manifest.ts` 为唯一来源。本文件记录实现时确定的细节；与设计冲突时以用户最新要求（整排排枪）为准，并在此注明。

## 1. 进程与端口

| 进程 | 默认监听 | 数据 |
| --- | --- | --- |
| Runtime `services/runtime/src/main.ts` | `127.0.0.1:${OSCAR_RUNTIME_PORT:-8780}` | `${OSCAR_DATA_DIR:-data}/runtime/`：`runtime.sqlite`、`operator.token`(0600) |
| Agent `services/culture-agent/src/main.ts` | 仅 `127.0.0.1:${OSCAR_AGENT_PORT:-8781}` | `${OSCAR_DATA_DIR}/agent/agent.sqlite` |
| 共享秘钥 | — | `${OSCAR_DATA_DIR}/secrets/service.token`(0600)，Runtime 首次启动生成，Agent 读取 |

Runtime 参数：`--port`、`--data-dir`、`--agent-url`、`--lan`、`--allow-host <host[:port]>`（可多次）、`--access-code-file`（或 `OSCAR_ACCESS_CODE`）、`--scenario`、`--seed`、`--clock-mode`。`--lan` 且访问码缺失或短于 16 字符时以非零码退出。【C1 细化】`--port 0` 允许（测试用）：实际端口从就绪行读取；启动时向 stdout 打印一行机器可读的 `OSCAR_RUNTIME_READY {"port":N,"pair_url":...,"data_dir":...}` 与一行人类可读的配对链接；`--data-dir` 支持绝对路径。墙钟 TTL 可用环境变量覆盖（见 §6）。

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
| `POST /api/v1/runs/{run_id}/agent-status` | run token；`{status:'paused', reason}` Agent 自报暂停（如 `agent_restarted`、`model_unavailable`） |
| `GET /api/v1/runs/{run_id}` | run token 或 operator：`RunRecord` |
| `/api/v1/agent/*` | 网关：operator 会话校验后代理到 Agent（附 `X-Service-Token`），SSE 透传 `Last-Event-ID`；Agent 不在时 `503 agent_unavailable` |
| `GET /api/v1/experiments/{id}/debug/truth` | 【C1 细化】仅 operator：暴露 `simulator_truth`（环境真值、逐孔 culture/蒸发、head 载液），用于测试校验与 `oracle_demo` 标注；不进入普通快照 |

### 4.1 run 创建与控制（经网关）

- `POST /api/v1/agent/runs {experiment_id?, scenario_id?, mode:'scripted'|'llm', goal?, plates?, budget?}`，可带 `Idempotency-Key`。Runtime 先在自身事务中：校验 Experiment active、无活跃 run（否则 `409 run_already_active`）、签发 run token、写 run 记录；lockstep 时同事务建立首个屏障（trigger `run_started`）并写 `decision.granted`。之后把 `{run_id, run_token, experiment_id, clock_mode, lease, ...原请求}` 转发给 Agent `POST /runs`。Agent 不可用则 Runtime 回滚：run `ended(reason=agent_unavailable)` 并撤销屏障，返回 503。
- `POST /api/v1/agent/runs/{id}/control {action:'pause'|'resume'|'cancel'}`：Runtime 先执行自身语义（pause：run→paused，撤销屏障；resume：run→active，新屏障 `run_resumed`；cancel：run→ended，撤销 token 与屏障，请求取消其未终结动作），再转发给 Agent。
- hold：`POST /experiments/{id}/control {hold:{run_id, on}}`。on：run→on_hold，撤销屏障，run 新写入 `403 run_on_hold`；off：run→active 并建新屏障。
- 其余 `GET /api/v1/agent/runs[/{id}[/events]]` 直接代理（Agent 会话流，自有 seq）。

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
