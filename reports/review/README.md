# C0–C3 独立审查与演示（2026-09-30）

审查对象：本地 `feat/b-framework`，HEAD `9bb67ab`。结论：主流程可演示；发现两个 P1 和一个 P2，异常恢复与归档一致性暂不通过完整验收。本轮未修改业务代码、未提交、未推送、未合并。

依据：`agent.md`、`docs/WORK_ALLOCATION.md`、`docs/OSCAR_VIRTUAL_CULTURE_DESIGN.md`、`docs/API_CONTRACT.md` 和实际实现。重点审查整排移液、动作取消、重启恢复、reset、状态同步与访问控制；不代表穷尽审计。

## 独立复跑

在当前工作区已有依赖上运行；本次没有重做 `git clone` / `npm ci`，不将上游的“干净克隆”陈述当成本轮证据。Runtime 测试及 CLI 演示使用隔离临时数据。浏览器演示另用 `/tmp/oscar-review-live-20260930`，不读写日常 `data/`。

| 命令 | 本次结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 139/139；失败 0、跳过 0（包括资产校验） |
| `npm run test:e2e` | 8/8；本次运行一次 |
| `npm run demo:all -- --out-dir reports/review-demo` | 4/4；含 Agent kill -9 恢复 |
| `node reports/review/reproduce.mjs` | 3 个缺陷均通过真实 HTTP / 进程复现 |

CLI 演示明细：[summary.md](../review-demo/summary.md)。补充复现脚本的断言验证的是**当前缺陷确实存在**，退出 0 不代表业务行为正确；修复后应转成验证正确行为的回归测试。

## 必须修复的问题

### [P1] 取消不占用头的动作会清空另一个动作的排枪

定位：`services/runtime/src/runtime.ts:706–716`（`discardUncommitted`）。

`environment.await_stable` 不占用 `head`，可与 `media.add` 并行。加液已从储液槽吸取每通道 100 µL、尚未排入样本时，取消环境等待也会进入公共清理逻辑，倒掉全部 600 µL 并丢弃吸头。等待动作被错误记入 600 µL 废液；原加液动作仍成功、向 A1–A6 各记入 100 µL，头内载液最终变为每通道 **−100 µL**。

修复方向：只允许拥有头资源及其载液的动作清理该头；保留无头动作与移液并行。补充并发取消测试，并为液体原语添加有意义的库存/载液不变量检查。

### [P1] Runtime 在振荡中重启后遗留活动振荡状态

定位：`services/runtime/src/runtime.ts:1720–1730`（`recoverOnStartup`）。

执行 `plate.shake(60 s)`，推进 10 s 后 SIGKILL Runtime，同目录重启并 resume。动作变成 `failed(runtime_restarted)`、活动动作数为 0，但 `plate.shake.active` 仍为 true。此时再次提交整排加液返回 `resource_busy: Plate plate-01 is shaking`；对已失败动作取消也不会停止遗留振荡。恢复只更新动作状态，没有终结并持久化动作拥有的物理状态。

修复方向：在恢复事务内收尾失败动作拥有的振荡/头内载液，保存世界状态和相应效果/事件；保留已提交效果，禁止重放已完成移液。回归应覆盖振荡中断，也应扩展到头内有液体的中断点。

### [P2] reset 记录了清理效果，却未保存旧世界的清理结果

定位：`services/runtime/src/runtime.ts:1661–1671`（`reset`）。

加液吸取 600 µL 后、排液前 reset：旧动作已取消，摘要宣称 `waste_delta_ul=600`，但归档快照的废液仍为 0，debug truth 中头内仍为 6×100 µL、吸头仍在。循环调用清理并保存 action，却没有将修改后的旧 `world` 保存。因此归档回看与事件/库存账目不一致；振荡收尾同样会受影响。

修复方向：在同一 reset 事务里持久化旧世界的最终状态后再归档。测试应对照归档状态、效果、废液及头内库存，而不仅仅验证归档后不再发生写入。

完整数值证据：[reproductions.json](reproductions.json)。可从仓库根目录重复运行 `node reports/review/reproduce.mjs`；脚本会创建并清理独立 Runtime 数据和进程。

## 浏览器演示

以真实 Runtime + 独立 scripted Agent 运行 `exchange_and_mix`，通过浏览器 Agent 页启动，操作台经 Runtime 配对登录。场景读取权威状态，未使用 preview 合成夹具。

顺序：扫描 A1–A6 → A 排 50% 换液 → 300 rpm 振荡 30 s → 静置 → 复查 → 报告。为了截图，仅在整排加液和振荡阶段暂停/恢复模拟时钟；没有手工改液量或跳过动作。

- 启动：`npm run dev -- --runtime-port 8790 --agent-port 8791 --data-dir /tmp/oscar-review-live-20260930`
- 操作台：<http://127.0.0.1:8790/web/workbench.html>（未登录需一次性配对）
- 演示脚本：[live-demo.mjs](live-demo.mjs)（针对上述专用临时实例；会 reset 该实例）
- 动作、前后快照、观测、报告、场景错误记录：[live-demo.json](live-demo.json)
- [整排加液](demo-dispensing.png) · [振荡](demo-shaking.png) · [完成](demo-completed.png) · [复查相机](demo-camera.png)

正常换液演示中，储液槽减少约 2399.913 µL，废液增加相同数量，使用 12 个吸头（两次各 6 个）；A1–A6 恢复至约 809.8 / 799.8 / 794.8 / 804.8 / 789.8 / 799.8 µL，微小变化来自演示蒸发模型。扫描前后观测各一份。所有参数及图像为仿真，未连接实机，真实 LLM 适配器不在本次演示范围。

本次保留的浏览器演示：`exp-003` / `run-003-1`，`completed`，4 个动作全部 succeeded，`determinism_broken=false`，浏览器异常 0，场景更新错误 0。

配对链接过期后：

```bash
npm run pair -- --url http://127.0.0.1:8790 --data-dir /tmp/oscar-review-live-20260930
```
