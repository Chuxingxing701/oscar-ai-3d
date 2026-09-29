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

## C1：Runtime 与设备闭环 — 未开始
## C2：操作台 — 未开始
## C3：Agent 与演示 — 未开始
