# 操作台改动复核与 Runtime 演示（2026-09-30）

审查对象：`feat/b-framework` 上自 `9bb67ab` 以来的本轮场景、操作台、启动参数和测试改动。复核字段契约、SSE / 快照边界、已确认时间插值、升降阶段衔接、真实 GLB 几何及库存显示。未发现本轮改动中尚未解决的阻塞问题；下面列出的既有异常恢复问题仍然存在，正常流程演示不构成这些异常路径已通过验收的证据。

## 本轮行为与审查补修

- 启动脚本透传准确的 `--allow-host 主机:端口`，支持远程端口转发。
- 摇床仅由专用开始/结束事件更新状态，避免随后审计效果清零时长或重复增加 revision。
- 机械位置和振荡在服务器已确认的时间区间内逐帧插值；保留同一动作尚未显示完的升降阶段，暂停、取消、切换动作及回放正确定位。液量直接来自权威快照。
- 相机位姿共用可见镜头偏移；侧框收窄避免舱壁穿模；扫描中心线、锥顶和单孔光斑从真实镜头端面指向目标孔。
- 扫描选板/选孔与实际提交目标同步，手动选板可保留。
- 环境事件按 `sample` / `targets` 解析，时间线显示采样时刻的温度、CO₂ 和湿度；刷新/重连读取最近 400 个事件，历史效果不重新施加到库存。
- **review 补修：** Runtime 库存效果是有符号增量，储液/吸头消耗为负、废液增加为正。原前端实时归约与储液/吸头回放把符号读反，且测试夹具使用了相反符号。统一按真实契约修正，实时加液/换液通过 HTTP 对照库存，回放验证提交前后余额。
- **review 补修：** 储液下拉选项 ID 不变时也更新余量文字并保留选择；培养板为行标加六孔的七列布局，修复第六孔换到下一行。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 最后一次全套 152/152，含 GLB、资产及 vendor 校验 |
| `node --test tests/web/*.test.mjs` | 最后回放符号及夹具修正后 38/38 |
| `npm run test:e2e` | 最终全套 12/12，真实 Runtime + Agent，桌面及移动布局 |
| `npm run demo:all -- --out-dir reports/runtime-review-demo` | 4/4，含 scripted Agent 进程异常恢复演示 |
| `node reports/review/reproduce.mjs` | 既有三个 Runtime 缺陷仍可复现；此脚本验证缺陷存在，不是正确性验收 |
| `git diff --check` | 通过 |

**首次验收失败也保留在结论中：** 首轮并行全套单元测试为 151/152，既有 `services/culture-agent/test/intent.test.ts` 缺少 `recovered: by_key_on_restart` 事件的断言偶发失败，失败后未清理服务器导致进程不退出，手动终止了该测试进程。随后该测试单独运行通过，额外连续 5 次均通过，全套复跑两次均为 152/152。本轮没有修改该测试或 Agent 生产代码，也没有用复跑结果宣称其竞争条件已修复。建议 B 后续检查 `CultureAgent.close()` 是否等待在途循环结束，以及测试中的“关闭实例”是否足以模拟真实进程崩溃。

## 真实 Runtime 浏览器演示

独立 Runtime、新建隔离临时目录、seed 42，通过一次性配对获得会话，API 驱动实时钟。未使用 `/web/scene/preview.html` 的合成场景夹具，未改动用户正在访问的 Runtime / 实验。场景阶段截图短暂停钟，待权威显示到位后恢复。

演示顺序：`plate-02 D6` 单孔扫描 → `plate-01 B1–B6` 整排 50% 换液 → 300 rpm 振荡 20 模拟秒 → `plate-01 B1` 复查 → 环境采样时间线。四个动作均成功、生成两份观测；换液储液扣减与废液增加相等，取头两次共消耗 12 支。具体数量、动作、事件及前后快照见证据 JSON。

- [演示视频](runtime-ui-demo/runtime-demo.webm)
- [完成与环境时间线](runtime-ui-demo/completed.png)
- [整排换液](runtime-ui-demo/media-exchange-plate-01.png)
- [摇床](runtime-ui-demo/plate-shake-plate-01.png)
- [跨板扫描](runtime-ui-demo/imaging-scan-plate-02.png)
- [观测、事件与库存对账](runtime-ui-demo/evidence.json)
- [可重运行录制脚本](runtime-ui-demo.mjs)：`node reports/runtime-ui-demo.mjs`
- [scripted Agent 四条演示结果](runtime-review-demo/summary.md)

## 尚未修复的既有 Runtime 问题

详见 [C0–C3 独立审查](review/README.md) 与 [复现数据](review/reproductions.json)：

1. **P1：** 取消不占用头的环境等待，会清空另一个移液动作的载液，后续产生负载液量。
2. **P1：** 振荡中 Runtime 重启后，动作失败但板仍保留 `shake.active`，阻塞后续操作。
3. **P2：** 执行中 reset 清理效果有记录，旧世界最终清理状态未持久化，归档库存不一致。

本轮提交包含上述诊断材料和界面修复，没有把这些 Runtime 业务问题标为完成。没有推送或合并分支。
