# 3D 场景交付（A）

2026-09-30，依据工程设计 v0.4 §8.2、R8–R10。本轮用户已启动 A，并明确纠正为「排枪整排对齐样本孔，同时加液」，取代原单逻辑通道示意。

## 交付范围

- `web/scene/index.js`：可挂载、更新、选择、聚焦、销毁的 Three.js 场景；`web/app.js` 仅保留旧展示页控件适配。
- `web/scene/model.js`：材质、受控工位、原位 shake 载台、随头相机、液位 InstancedMesh、整排并行光效、板孔标注和拾取。
- `web/scene/scene-map.json`：原始 GLB 的节点、坐标、资源 ID、板孔编号与文件 SHA256；7 个工位、48 个培养孔、288 个吸头位。
- `web/scene/preview.html`：独立验收页。加液、吸排、扫描、shake、待机模式；滑动模拟时刻、暂停、回看和板孔聚焦。数据明确标记为本地合成夹具，不是 Runtime 实现。
- `textures/`：从已有 GLB 无损恢复 4 张嵌入 PNG；原始 GLB 与 `.blend` 未重导出。新增几何和材质通过场景代码复现，符合 §8.2 附加几何方案。
- `web/vendor/`：为让交付立即可看，补齐已锁定在现有 web/package.json 的 Three.js 0.180.0 及 MIT 许可。未建立或更改 B 的根 workspace/锁文件。

## 本地查看与验证

```bash
node server.mjs
# 原展示页：http://127.0.0.1:8765/web/
# 场景验收：http://127.0.0.1:8765/web/scene/preview.html

# Node 24；测试直接解析真实 GLB 并使用随仓库附带的 Three.js，无需 npm install
node --test web/scene/tests/scene.test.mjs
python3 source/prepare_scene_assets.py --check
```

资产复现：`python3 source/prepare_scene_assets.py` 从现有 GLB 生成映射、恢复原始贴图。变更 GLB 后必须运行此命令再跑契约测试；不会改业务 ID。发现旋转、缩放或矩阵祖先时脚本主动失败，需扩展坐标转换，避免输出错误位置。`source/make_textures.py` 另支持跨平台字体和 `OSCAR_FONT` / `OSCAR_BOLD_FONT` 环境变量，用于重新绘制替代贴图；不是原始 PNG 的字节复现方式。

如需重建 vendor：`npm --prefix web install --ignore-scripts --no-package-lock`，再 `node source/prepare_scene.mjs`。B 建立根锁文件后可接管此步骤。浏览器验证脚本在 `web/scene/tests/browser.mjs`，需外部 Playwright 环境；不向仓库增加测试工具依赖。

## B 接入方式

这是一份**场景显示投影**，不是新设备 API。B 将已确认的设备快照/阶段事件投影到以下字段；HTTP、SSE 去重、授权、重试、回放装配仍在 B 的适配层。设备 API 确定后，仅需调整适配层，不要求 Runtime 使用本显示数据结构。

```js
import {mountScene} from './scene/index.js';
const scene = mountScene(container, {
  onSelect: selection => workbench.select(selection),
  onViewChange: status => updateViewControls(status),
  onError: error => showSceneError(error),
});
await scene.ready;
scene.setView('interior');
scene.update({
  experiment_id: 'exp-01', sim_time_s: 12, paused: false,
  plates: [{plate_id: 'plate-01', wells: Array.from({length: 6}, (_, i) => (
    {well_id: `A${i + 1}`, volume_ul: 800, capacity_ul: 2000}
  )), shake: {active: false, started_at_sim_s: 0, duration_sim_s: 0}}],
  actions: [{stage: 'dispensing', target: {plate_id: 'plate-01', row_id: 'A'},
    stage_started_at_sim_s: 10, stage_duration_sim_s: 6}],
});
scene.focus({plate_id: 'plate-01', well_id: 'A1'});
// 离开页面 / 组件卸载
scene.dispose();
```

- `update` 每次是完整的显示快照；省略的板/孔清空液位覆盖，省略 shake 停止振荡，`actions: []` 清除光效并归待命位。先校验再替换，非法 ID、体积或阶段不会部分修改场景。`capacity_ul` 必须由 B 提供，不在场景中推断设备容量。
- 受控模式以 `sim_time_s` 为权威时间，默认精确投影。实时操作台调用 `update(snapshot, {interpolate: true, speed})`，在已确认时间之间逐帧插值机械位置和振荡；展示时间不超过最新服务器时刻，断线后最多补完当前确认区间即停下。液量始终直接取最新已提交快照，逐帧插值不修改库存/液量。暂停、重连初次快照、Experiment 切换和倒放精确定位；回放不启用平滑。`paused` 是 Runtime 暂停标识；暂停时的显式 step/seek 仍可通过新快照显示。
- `actions` 表示当前占用移液头的阶段（最多一个），不是 Runtime 的全部活动动作；shake 放在板上，可有多板。支持 `moving/lowering/aspirating/dispensing/raising/scanning/picking_tip/dropping_tip`。
- 操作台投影同时携带 `action_id`。开启平滑时，场景按显示时刻采样同一动作已接收的阶段，保留尚未显示完的一秒升降，不能在下一阶段到达时直接把显示时间夹到新阶段起点。阶段缺失、动作替换、取消、暂停/回放或切换实验立即以已知快照定位，避免播放旧动作。取头/弃头阶段内以平滑的下降—抬升示意衔接两端高位；不改变 Runtime 原语时长和库存提交点。
- 移液 `target` / `from_target` 对培养板使用显式 `{plate_id, row_id}`（如 A，作用于 A1–A6）；整排共用一次移液头阶段。单孔 `well_id` 输入会被拒绝，防止把单孔授权静默扩展成整排动作。扫描与选孔仍用 `{plate_id, well_id?}`。储液/废液支持 `{resource_id}`。吸头工位保留映射；原 96 位吸头盒与 6 通道排枪的取头布局仍需 B/A 后续联合确定，不能将示意动作当成取头可达性证明。
- `moving` 从 `from_target` 到 `target`；缺省源为 home。`tool: 'camera'` 按镜头偏移定位，其他按整排中心和针排深度定位。先升后移应由 Runtime 阶段体现；场景横移固定在高位。
- `from_pose_m?: [motionX, motionZ, motionY]` 是阶段起始处的 glTF 平移量（等价世界 x、竖直 y、深度 z），用于直接恢复未落在标准端点的阶段。Z 下探限制为 0 至 −0.12 m。不会根据前一次绘制的坐标猜测起点。
- `shake` 使用 `active/started_at_sim_s/duration_sim_s`，可选 `frequency_hz/amplitude_m`。只做展示，频率上限 4 Hz、半径上限 1.5 mm，结束/取消归零。板、载台、液体和高亮一起移动。
- Runtime 的 `plate.shake_started/stopped` 事件投影振荡参数；随后到达的 `action.effect_committed` 只记录效果，不能用其中缺失的参数覆盖振荡时长/速度，也不能重复增加 revision。否则实时视图会收到 0 秒振荡，即使刷新后的完整快照是正常的。
- `setDisplayPaused(true)` 仅冻结当前显示，仍接受并保存后续快照；恢复后立即显示最新状态，不发送 Runtime 暂停命令。切换 Experiment 会清除选择与冻结，避免旧世界残留。只读回放同样调用 `update`，无写接口。
- `setAnimationMode('idle')` 清空受控覆盖、恢复原 18 秒循环；`setPlaying` 控制待机播放。进入受控模式停止 clip，避免两个动画源写同一节点。
- `focus({device_id:'oscar-01'})` 聚焦整机，`focus({plate_id, well_id?})` 聚焦板孔；`select(null)` 清除高亮。拾取返回 `{device_id, resource_id, plate_id?, well_id?}`。拖动和多指手势不触发选孔。相机控制不改变设备状态。
- `setView('exterior'|'interior')`、`resetView(front?)`、`setAutoRotate(boolean)`、`getStatus()` 为视图控制和只读诊断。容器尺寸由 ResizeObserver 处理。`dispose()` 停止 RAF、移除事件、释放原始/合并/附加几何、材质、贴图及 WebGL。
- `mountScene` 可指定 `mapUrl/modelUrl`；默认路径相对场景模块，适用于子路径托管。场景只请求静态模型/映射，不持有服务端凭证。

## 坐标、视觉与证据边界

Blender `(x,y,z)` → glTF `(x,z,-y)`。A 行在远端（较小 glTF z）；列沿 +x。`Station_{c}_{r}` 是前缀，不是实际父节点；原 GLB 的工位部件直接位于 Interior。加载时恢复 GLTFLoader 改写的原始节点名，按前缀保护受控工位，再合并其余静态网格。培养板部件另重挂到 shake 组，保持原始变换。

当前 24 孔板沿 x 每排 6 孔，展示排枪配置为 6 通道、21.6 mm 针距。场景在保留原 GLB 的情况下重新排列前 6 根针轴、连接件和上部管线，隐藏原多出的两组，不再显示与孔位不匹配的八针阵列。`scene-map.motion.row_head` 记录通道数、间距、高度及原始节点。针排以目标整排中心定位；6 路针尖光效和液柱同时出现。针尖仍维持约 0.993 m 最低高度，与孔位面约 43.5 mm、板面约 44 mm 间隙。

预览选择 A1–A6 中任一孔，加液/换液示例都作用于 A 排全部 6 孔，并在「加液排」明确列出范围；扫描仍可选单孔。夹具同步提供整排逐孔液量，其他排/板不变；场景本身仍逐孔读取 Runtime 液量，不自行加液或复制某孔的液量。6 通道是匹配当前 24 孔展示板的配置，不作为实机通道数标定。液体柱为孔面上方 0.5–5.5 mm 的覆盖示意，颜色不编码生物学结论；没有液量数据时不显示液体。

相机几何挂在 Motion_Z，扫描光锥与其镜头定位一致，仅供观看。服务端扫描 PNG 和 Agent 观测证据仍属 B（§8.3）。当前扩大到所有孔的头部移动是示意轨迹，排枪/侧框/舱壁未完成整套受控轨迹碰撞认证，不宣称实机可达性。

本机无 Blender，因此本轮未执行 Blender 验证；原 GLB 和母模型均未改变。验证覆盖真实 GLB 的节点/坐标、静态合并、整排针尖间隙、状态投影和浏览器显示；不能替代制造 CAD、标定或机械安全验证。

## 本轮验证结果

- `node --test web/scene/tests/scene.test.mjs`：9/9 通过，使用真实 GLB 与已附带的 Three.js 0.180.0。
- `python3 source/prepare_scene_assets.py --check`：7 工位、48 培养孔、288 吸头孔及 4 张原始贴图一致；`git diff --check` 通过。
- Chromium 153.0.8010.12：11 项浏览器检查通过；页面错误和资源错误均为 0。包括原展示页、待机暂停、拖动与点击区分、实际射线选 A1、受控暂停/恢复、扫描、shake 归位、Experiment 切换、390×844 布局及销毁。
- 记录：`reports/scene_browser_checks.json`；截图：`previews/scene_exterior.png`、`scene_interior.png`、`scene_plate_numbering.png`、`scene_dispensing.png`、`scene_scanning.png`、`scene_shake.png`、`scene_mobile.png`。
- 已查看截图核对 A 行远端、列号左至右、6 根针尖与 A1–A6 整排对齐、液位和光效。测试使用桌面 Chromium 的 SwiftShader 软件渲染；手机尺寸为桌面模拟。旧 headless shell 在近景出现截图超时，最终用完整 Chromium 无头模式完成验证，并等待镜头过渡结束后拾取。


## B 侧需要同步的排枪语义

以本轮用户的整排同时加液要求为准，B 实现时需将液体动作展开为排级阶段，逐孔记录效果与吸头消耗；整排同时开始/结束，库存按全部目标孔实际体积求和。行选择与容量校验必须在 Runtime 确认后再传给场景，不能靠场景动画补齐业务效果。A 此次只更新场景、合成预览及交接，不代为实现 Runtime。

## 扫描几何修正（2026-09-30）

针对用户截图中的左壁穿模，随头相机移至头部左下侧；位姿与可见几何共用 `state.js` 的 `CAMERA_POSITION`，六通道侧框/安装螺栓各向内收 28 mm。扫描锥缩为单孔足迹，并从真实镜头端面生成中心线和目标孔光斑。新增基于原 GLB 的运动网格对舱壁/立柱碰撞采样及光效端点测试，详见 [扫描几何修复记录](../reports/scan_geometry_fix.md)。原 GLB、针轴间距、板孔坐标和 Runtime 参数未改变。

本轮操作台复核、库存/环境时间线补修、实际验证与真实 Runtime 演示见 [改动审查记录](../reports/runtime_changes_review.md)。`action.effect_committed` 的库存增量有符号，实时显示和历史回放均遵循同一语义；从事件补载历史仅用于显示，不重复执行效果。
