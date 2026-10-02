# 运行中场景闪动、缩小的录屏跟进（2026-09-30）

用户的 70.54 秒录屏显示，Agent 运行时底部事件时间线增高，设备画面随之缩小。上一轮同帧 resize/redraw 修复只处理清空画布后的闪白，没有解决布局随日志内容变化的问题。

## 复现与修复

在隔离临时数据目录启动真实 Runtime 和 Agent，以 `exchange_and_mix`、lockstep、speed 40 运行扫描、整排换液、shake 和复查。每个 RAF 记录场景与时间线尺寸：修改前，要求尺寸变化不超过 1 px 的回归测试失败，场景高度变化 **183 px**。

原因是桌面 Grid 的底部行使用 `auto`，时间线内容增多会占用更高的行，压缩第一行场景；有固定像素尺寸的 canvas 还参与父布局的尺寸计算。修复只修改 `web/workbench.css`：

- 底部行固定为随视口变化的 `clamp(130px, 26vh, 260px)`，内部日志滚动。
- 第一行使用 `minmax(0, 1fr)`；canvas 绝对定位并填满场景区域，不再参与布局尺寸计算。
- 移动端继续使用原来的面板切换与独立场景高度。

## 实际验证

- `npm run typecheck`：通过。
- `npm run test:e2e -- tests/e2e/layout.spec.ts tests/e2e/mobile.spec.ts tests/e2e/agent-stream.spec.ts --grep 'viewport stable|desktop resizing|narrow screen|canvas resize'`：**4/4 通过**。
- 1440×900 下完整 scripted 演示：场景始终 **718×488 px**、时间线始终 **234 px**，最小值与最大值相同；四个动作完成且场景投影无错误。
- 1100×700 与 1440×900 窗口尺寸、右侧四个页签、时间线筛选：canvas 与场景边界一致，切换内容不改变场景尺寸。
- 390×844 移动端面板切换及真实整排加液通过，无页面横向溢出；之前的同帧 resize/redraw 回归仍通过。

此轮只验证了相关布局、浏览器行为与类型检查，未重跑全量系统测试。未修改用户当前实验或设备状态；刷新现有操作台页面即可加载新 CSS。
