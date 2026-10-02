# C0–C3 主要框架闭环检查点

日期：2026-09-30 · 分支 `feat/b-framework` · 验收提交 `a063d6c`（及其后仅文档提交）

**结论：已达到 C0–C3 主要框架检查点。** 下列结果都来自本轮在**新克隆的干净工作区**（`git clone` → `npm ci`，隔离临时数据目录）里的实际运行，不是 A 的旧报告。未完成的可选 P2 功能见 §6。

## 1. 统一命令与实际结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm ci` | 退出 0，0 vulnerabilities | 根锁文件，精确版本（ajv 8.20.0、typescript 5.9.3、@playwright/test 1.63.0、three 0.180.0、@types/node 24.19.0） |
| `npm run typecheck` | 退出 0 | `tsc --noEmit`，`erasableSyntaxOnly` |
| `npm test` | **139/139 通过**，0 失败/跳过（约 67 s） | 含 vendor 字节校验、A 的资产校验与场景测试 9 项；Runtime 测试全部经真实子进程 + HTTP |
| `npm run test:e2e` | **8/8 通过**（约 2.2 min，干净克隆连续 2 次） | Playwright 1.63.0 + Chromium 1243，真实 Runtime + Agent 进程，隔离数据目录 |
| `npm run demo:all` | **4/4 通过**，退出 0 | 三条演示 + 异常恢复，无遗留进程 |
| `npm run dev` | 两进程就绪，打印入口与一次性配对链接；Ctrl-C/超时后无孤儿进程 | 端口 `--runtime-port`/`--agent-port` 或 `OSCAR_RUNTIME_PORT`/`OSCAR_AGENT_PORT` |

## 2. 目标状态逐项

| # | 目标（B_IMPLEMENTATION_PROMPT §2） | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | Runtime 与独立 Agent 进程；无 LLM 凭证可用；同源配对登录 | 达成 | `npm run dev`；e2e「pairing issues an HttpOnly cookie…」经真实 `/pair#code=` 静态页换取 HttpOnly/SameSite=Strict cookie |
| 2 | manifest 能力 → 同一 DeviceClient/API 手工或 scripted 调用扫描、整排加液/换液、shake、环境 | 达成 | 契约测试（manifest/schema 唯一来源、工具名机械生成）；e2e 手工流程；demo 由 Agent 经 DeviceClient 调用 |
| 3 | 扫描 → 整排换液 → shake → 复查 → 报告，action/event/observation/库存可核对 | 达成 | `exchange_and_mix` 演示 12 条判据全部通过（§3） |
| 4 | 3D 由 Runtime 权威状态驱动，刷新/重连恢复活动阶段 | 达成 | e2e「3D scene mirrors the running row stage and refresh resumes…」；场景适配单测；e2e 断言场景从未拒绝快照 |
| 5 | 关闭浏览器继续运行；Agent 停止后人工可操作；旧 Experiment 只读；reset 隔离 | 达成 | e2e「closing the browser…replay…never writes」「with the Agent process stopped…」；reset 测试 6 项 |
| 6 | 干净目录统一类型检查、测试、三条演示可复现通过 | 达成 | §1 |

## 3. 演示与库存对账（`npm run demo:all`，seed 42，lockstep，speed 600）

报告：`reports/demo/{routine_maintenance,exchange_and_mix,environment_drift,anomaly_recovery}.json`、`summary.json`、`summary.md`。所有判据都经 operator API（动作 summary、快照差量、事件、观测、Runtime 侧报告）核对，不采信 Agent 自述。

| 演示 | 关键 ID | 对账 |
| --- | --- | --- |
| 例行维护 | run-001-1；act-001-01 扫描 → act-001-02 `media.add`（plate-01 A 排）→ act-001-03 复查；obs-001-001 / obs-001-002 | A1–A6 由 380–420 µL 升至 750.9–790.9 µL（目标带 600–900）；储液 50000 → 47774 µL（−2226 = Σ逐孔加入）；吸头 tips-01 96 → 90（6 通道一次取头）；其他排/板在蒸发容差内不变；加液引用新鲜观测 obs-001-001 |
| 换液与混匀 | act-001-02 `media.exchange`（fraction 0.5）→ act-001-03 `plate.shake` → act-001-04 双目复查；obs-001-001 / obs-001-002 | 废液 +2399.913 µL = Σ移除；储液 −2399.913 µL = Σ加入；逐孔体积恢复（810→809.8 等，差值为蒸发）；吸头 −12（两次取头）；shake started/stopped 事件齐全；静置后（126 s 之后，137 s）复查，前后图 hash 不同 |
| 环境偏移与观察失败 | act-001-01 `set_targets`（受理即 succeeded）→ act-001-02 扫描（模糊）→ act-001-03 `await_stable` → act-001-04 复查 | obs-001-001 quality=blurred，估计值全为 null，决策日志写明「no visual conclusion drawn」；最终观测 36.88 °C / 4.88 % / 93.47 %，在目标 37/5/95 的 ±0.3/±0.2/±3 内；液体库存无变化 |
| 异常恢复 | `media.add` 运行中 `kill -9` Agent → 重启 | run `paused(agent_restarted)`，暂停期间动作数 2 → 2；resume 后对账不重做，全程只有 act-001-02 一个带效果的液体动作（6 孔）；run completed，`determinism_broken=false` |

## 4. 必须覆盖的验收行为（prompt §6）与对应测试

| 验收项 | 测试（均在 `npm test` 或 `test:e2e` 中实际通过） |
| --- | --- |
| 1 整排与守恒 | `media.add on a complete row…reservoir -6V, tips -6`；`media.exchange: waste +Σremoved…tips -12`；`capacity / channel / residual / partial-row rejections reject the whole request`；`cancel mid-exchange: committed effects kept, head discard conserved, cancel twice same terminal`；`events show stage progress with shared row timing`；契约 `partial rows are rejected, never expanded` |
| 2 幂等与资源锁 | `same key + same request: 200 with the ORIGINAL response body, exactly one effect`；`same key + different request: 409`；`idempotency scope is (experiment, principal)`；`resource locks: shake vs scan vs liquid…` |
| 3 观测证据 | PNG IHDR/zlib/CRC 解码；`stereo: left/right roles, same sampled_at and pair id`；`scan reproducible across two fresh runtimes`；`asset replay returns the archived bytes`；`observation_stale`；图像仅由服务端合成（`synthetic_image`），场景截图不进入证据 |
| 4 确定性 | `two fresh runtimes…bit-identical`；`scripted routine_maintenance: speed 1 vs speed 600 with random decision delays -> identical traces`（动作序列、sim 时刻、逐孔体积、图片 sha256 一致，`determinism_broken=false`） |
| 5 屏障 | `set_targets immediate, scan queued, no second decision.granted`；`release(on_actions=[scan])…terminal and next barrier share sim_time`；`release(on_actions=[already terminal]) returns next_lease immediately`；`other run lease is 403`；`lease timeout: expired, run paused(lease_timeout), determinism_broken` |
| 6 执行中 reset | `reset during exchange half-way` / `during shake` / `during scan`；`reset with a run active: run ended(experiment_reset), token revoked` |
| 7 恢复（真实进程） | `response loss: resend with the same idempotency key`；`kill -9 mid-exchange, restart on the same data dir: failed(runtime_restarted)…no re-execution`；`agent SIGKILL mid-action…no duplicate media action`；`SSE reconnect with Last-Event-ID yields no gaps and no duplicates`；异常恢复演示 |
| 8 访问控制 | cookie GET/HEAD 无 Origin（state、SSE、asset）；cookie POST 缺 Origin 拒绝；Bearer 无 Origin；跨源/非法 Host；匿名 401；run token 不能 control/reset/create；一次性与过期配对码；LAN 无/短访问码退出非零、限流；静态页无令牌；数据目录不可经静态路径访问 |
| 9 端到端 | e2e 8 项：配对、手工整排加液（逐孔与库存核对）、3D 阶段与刷新恢复、关闭浏览器继续运行、只读回放零写请求、Agent 面板 scripted 全流程（决策日志/证据跳转/报告）、Agent 停止后人工操作、390×844 窄屏主要流程、提交/推进循环收敛 |
| 10 A 回归 | `web/scene/tests/scene.test.mjs` 9 项（含整排针尖对齐）；`prepare_scene_assets.py --check`；vendor 字节校验 |

## 5. 截图

- `previews/workbench_agent_run.png`：桌面 1440×900，scripted run 完成后的操作台（3D 场景、决策日志、事件时间线）。
- `previews/workbench_mobile.png`：390×844 窄屏操作页。
- A 的场景截图（`previews/scene_*.png`）保持不变，仍属场景验收页。

## 6. 已知限制与未实现的可选 P2

- **LLM 适配器为占位**：工具表已由 manifest 装配并传入；选择 `llm` 时 run 明确 `paused(model_unavailable)`，不静默回退 scripted。真实模型调用、有限视觉工作集与会话压缩未实现。
- **Agent 仅支持 lockstep**：realtime 下 run 以 `aborted` 收尾并在报告中说明。人工操作支持 realtime。
- **物理与参数**：6 通道 / 21.6 mm 为展示配置；取头为示意阶段加逻辑吸头库存，未完成 96 位吸头盒与排枪的物理对位标定。逐通道独立体积（按孔 fraction）是演示假设。所有数值为明确记录的演示参数。
- 图像为确定性示意合成，双目 `depth_status=not_computed`；不做像素级 CV。
- 回放逐孔体积由事件中的提交后体积重建；未被任何动作触及的孔以「终值 − Σdelta」作基线，蒸发会带来显示层的微小偏差。
- LAN 模式为明文 HTTP 下的演示级保护，不是生产鉴权。
- 本轮在验收中修复的集成缺陷（均已补回归测试）：扫描行进阶段按针排校验导致场景拒绝快照；SSE 快照与订阅重叠时旧快照后到；快照后残留旧的未终态动作；resync 后相机列表未刷新；Agent 面板未识别 Agent SSE 事件名；子进程就绪行同块到达时漏检。

## 7. 入口

- 启动与配对：README「受控操作台（Runtime + Agent）」一节。
- 实施状态与接续：`docs/IMPLEMENTATION_STATUS.md`；API 契约：`docs/API_CONTRACT.md`。
- 核心代码：`packages/device-contract`、`packages/simulator`、`packages/culture-policy`、`services/runtime`、`services/culture-agent`、`web/workbench.*`、`web/api`、`web/panels`、`scenarios/`、`scripts/`、`tests/`。
