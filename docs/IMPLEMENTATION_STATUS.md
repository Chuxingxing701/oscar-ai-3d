# B 实施状态（C0–C3 主要框架检查点）

上下文切换后先读本文件。契约细节见 [API_CONTRACT.md](API_CONTRACT.md)，执行要求见 [B_IMPLEMENTATION_PROMPT.md](B_IMPLEMENTATION_PROMPT.md)。

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

## C2：操作台 — 未开始
## C3：Agent 与演示 — 未开始
