# 仓库简要说明

## 项目用途

OSCAR–AI 三维展示项目，用于展示类器官培养鉴定工作岛的设备外观、内部工作舱和移液运动。包含 Blender 母模型、GLB 模型及 Three.js 网页，支持内外视角切换、旋转缩放、动画暂停和视角复位。尺寸与运动为展示估算，不是制造 CAD 或经过标定的数字孪生。

后续虚拟培养设备与培养 Agent 的设计见 [工程设计文档](docs/OSCAR_VIRTUAL_CULTURE_DESIGN.md)，v0.4 为已确认的 P0 基线。B 侧 Runtime、scripted Agent 与操作台已实现到 C0–C3 检查点，见 [实施状态](docs/IMPLEMENTATION_STATUS.md) 与 [检查点报告](reports/framework_checkpoint.md)。

实现职责见 [实施分工与交接](docs/WORK_ALLOCATION.md)：本聊天助手负责 A（3D 模型与场景升级），已于 2026-09-30 按用户要求启动并交付，见 [场景交接](docs/SCENE_HANDOFF.md)；用户另行安排的执行代理负责 B（其余系统实现）。B 可基于现有 GLB 独立推进 P0，暂不修改模型或重写场景渲染逻辑；P0 初始 scene-map 和契约测试原计划由 B 建立；本轮在 B 尚未提供初稿时由 A 按 v0.4 建立，后续由 A 维护模型侧映射、B 接入统一测试。

## 主要结构

| 路径 | 用途 |
| --- | --- |
| `OSCAR_master.blend` | 可编辑的 Blender 母模型 |
| `models/` | 完整、外观、内部三个 GLB；网页加载 `OSCAR_full.glb` |
| `web/index.html` | 页面入口、控件及 Three.js import map |
| `web/app.js` | 原展示页控件适配 |
| `web/scene/` | 模型加载、静态合并、受控动画、板孔拾取、附加几何及独立验收页 |
| `web/style.css` | 页面样式与移动端布局 |
| `web/package.json` | ES Module 配置，声明 Three.js `0.180.0`；没有 npm scripts |
| `source/build_model.py` | Blender 建模、动画、GLB 导出及母模型保存 |
| `source/parameters.json` | 估算尺寸、台面高度、帧率与动画周期参数 |
| `source/make_textures.py` | 使用 Pillow 生成品牌、装饰与屏幕贴图 |
| `source/render_views.py` | 使用 Blender 渲染多角度预览 |
| `source/validate_model.py` | 检查外包络、台面容纳、运动碰撞抽样、循环及 GLB 重新导入 |
| `textures/`、`previews/`、`references/`、`reports/` | 分别用于贴图、预览图、参考素材及验证报告 |
| `server.py` / `server.mjs` | 无额外依赖的 Python / Node.js 静态服务器 |
| `打开预览.cmd` | Windows 预览启动脚本 |
| `README.md`、`docs/HANDOFF.md` | 使用说明、模型约定及详细交接文档 |

## 本地运行

在仓库根目录任选一种方式启动，访问 `http://127.0.0.1:8765/web/`：

```bash
python server.py --no-open
# 或
node server.mjs
```

默认只监听本机；添加 `--lan` 可供可信局域网访问。网页需要 HTTP 服务，不应直接双击 HTML。

**当前场景交付：** `web/vendor/` 已补齐 Three.js 0.180.0；原 GLB 的 4 张贴图已恢复到 `textures/`。模型与场景逻辑已提取至 `web/scene/`，场景验收页为 `/web/scene/preview.html`。`web/app.js` 仅适配原页面控件。该验收页使用合成状态，不是 Runtime 或设备 API；受控操作台为 Runtime 提供的 `/web/workbench.html`（`npm run dev`）。

场景测试：`node --test web/scene/tests/scene.test.mjs`（Node 24，无需 npm install）。资产校验：`python3 source/prepare_scene_assets.py --check`。B 后续可将其并入统一测试命令。

## 后续修改要点

- 网页场景从 `web/scene/index.js` 与 `model.js` 入手；页面控件从 `web/app.js` 入手，模型生成从 `source/build_model.py` 入手。
- 保留 `Exterior`、`Interior` 和 `Motion → Motion_X → Motion_Y → Motion_Z` 节点名称与层级；网页显隐和动画依赖这些约定。摄影棚集合 `90_Studio` 不参与 GLB 导出。
- Blender 使用米制、Z 向上；GLB 导出转换为 Y 向上。默认动画为 18 秒、30 fps、1–541 帧。
- `parameters.json` 不是完整参数化模型的缩放开关，部分几何和动画数值仍写在脚本中。
- 重建需要 Blender 和外部贴图；贴图脚本还依赖 Pillow，字体支持 Windows/Linux/macOS 候选及 OSCAR_FONT / OSCAR_BOLD_FONT 环境变量。重建会覆盖母模型和导出文件。
- 补齐贴图及运行环境后，可在根目录使用以下命令重建和验证：

```bash
blender --background --python source/build_model.py -- --skip-render
blender --background --python source/validate_model.py
blender --background --python source/render_views.py
```

根目录统一命令：`npm ci`、`npm run typecheck`、`npm test`（含场景测试与资产校验）、`npm run test:e2e`、`npm run demo:all`、`npm run dev`；尚无 CI。网页修改后应检查模型加载、内外切换、动画控制、拖动/点击区分和移动端布局；模型修改后应重新运行验证脚本。本轮验证记录见 `docs/SCENE_HANDOFF.md` 与 `reports/scene_browser_checks.json`；未修改 GLB / 母模型，本机无 Blender。

**排枪补充（2026-09-30）：** 用户已纠正加液站为整排同时加液，覆盖 v0.4 原单逻辑通道简化。当前 24 孔板对应 6 通道、21.6 mm 针距的展示排枪；场景重新排列针轴/连接件/管线，并同步显示整排光效。移液显示目标必须显式使用 `{plate_id, row_id}`；扫描/选孔仍使用 `well_id`。预览整排逐孔液量由合成夹具提供，Runtime 的排级动作与逐孔记账由 B 接入。
