# OSCAR–AI · 3D Showcase

**类器官系统培养鉴定智能工作岛｜外观、主工作舱与移液运动展示**

用于商业路演、产品结构展示和动画制作交接的三维项目。包含可编辑的 Blender 母模型、通用 GLB 模型、18 秒运动循环，以及无需 CDN 的本地 Three.js 网页预览。

> 当前为依据照片、五视图和视频重建的 V1 展示模型。尺寸采用估算值；隐藏机构、运动轨迹和屏幕界面包含简化，并非制造 CAD 或经过标定的数字孪生。

![OSCAR–AI 外观与主工作舱](previews/OSCAR_overview.jpg)

## 功能

- **外观**：柜体、蓝色前面板、观察窗、显示屏、柜门、把手、分缝和通风区域。
- **内部**：金属工作舱、台面、20 个布局工位，以及孔板、枪头盒、管架、托盘和培养皿。
- **运动**：独立的 X / Y / Z 层级，18 秒“移动—定位—下降—停留—抬升”循环。
- **网页交互**：点击设备进入内部，返回外观，旋转、缩放、暂停/继续、正面视角及视角复位。
- **可编辑交接**：保留部件名称和层级，提供生成脚本、贴图、多角度预览和验证记录。

## 快速开始

下载或克隆完整仓库，在项目根目录选择一种方式运行：

```bash
# Python：仅使用标准库，启动后尝试打开浏览器
python server.py

# 或 Node.js：无需安装额外包
node server.mjs
```

浏览器访问：

```text
http://127.0.0.1:8765/web/
```

依赖已放在 `web/vendor/`，无需 `npm install` 或联网加载。**请通过 HTTP 服务预览，不要直接双击 HTML。** 原制作电脑也可双击 `打开预览.cmd`；其他电脑建议使用上述标准命令。

### 手机和平板

电脑与移动设备连接同一个可信局域网，在电脑上运行：

```bash
python server.py --lan --port 8765
# 或
node server.mjs --lan
```

移动设备访问 `http://电脑的局域网IPv4:8765/web/`。连接取决于防火墙和网络隔离设置；默认启动仅监听本机。

> 上传 GitHub 仓库不等于部署网页。本项目没有预先声明的公网演示地址。

## 模型文件

| 文件 | 内容 | 动画 |
|---|---|---|
| [`OSCAR_master.blend`](OSCAR_master.blend) | 可编辑母模型、材质、打包贴图、运动层级与摄影棚 | 有 |
| [`models/OSCAR_full.glb`](models/OSCAR_full.glb) | 网页使用的完整内外模型 | 有 |
| [`models/OSCAR_exterior.glb`](models/OSCAR_exterior.glb) | 独立外观 | 无 |
| [`models/OSCAR_interior.glb`](models/OSCAR_interior.glb) | 主工作舱与可动移液头 | 有 |

GLB 已嵌入贴图。点击交互、镜头切换和部件显隐逻辑位于 `web/app.js`，不属于 GLB 文件本身。

## 目录

```text
.
├── OSCAR_master.blend       # 可编辑母模型
├── models/                 # 三个 GLB
├── source/                 # 建模、贴图、渲染和验证脚本
├── textures/               # 可替换 PNG 贴图
├── web/                    # Three.js 网页与本地依赖
├── previews/               # 多角度渲染图和网页截图
├── references/             # 建模参考拼图
├── reports/                # 模型清单与验证记录
├── docs/HANDOFF.md          # 详细交接及简化说明
├── server.py               # Python 服务
├── server.mjs              # Node.js 服务
└── SHA256SUMS.txt           # 文件校验清单
```

## 尺寸与运动层级

| 项目 | 约定 |
|---|---|
| 名义柜体尺寸 | 宽 2.1 m × 深 0.6 m × 高 1.8 m，用户估算 |
| 含小凸出部件的外观包围盒 | 约 2.106 × 0.628 × 1.800 m |
| Blender 坐标 | 米；X 左右、Y 前后、Z 高度，正面朝负 Y |
| GLB 坐标 | 导出器转换为 Y 向上，正面朝正 Z |
| 根节点 | `Exterior`、`Interior`、`Motion` |
| 可动层级 | `Motion → Motion_X → Motion_Y → Motion_Z` |
| 动画 | `OSCAR_Demo_18s`，30 fps，1–541 帧 |

同事可以直接编辑 `.blend`。重导出 GLB 时保留上述节点名称，网页依赖名称切换内外。摄影棚集合 `90_Studio` 不参与导出。

`source/parameters.json` 记录估算基准和部分参数，并不是所有几何的自动缩放开关。修改整机尺寸、台面或工位后，需要同步调整局部几何并检查运动轨迹。

## 脚本复现

以下命令在项目根目录运行，假定 `blender` 已加入命令路径；否则替换为本机可执行文件路径：

```bash
blender --background --python source/build_model.py -- --skip-render
blender --background --python source/validate_model.py
blender --background --python source/render_views.py
```

重建使用包内现成 PNG，无需重新生成贴图。若需重新生成品牌、装饰线与屏幕示意贴图，使用带 Pillow 的 Python：

```bash
python source/make_textures.py
```

原生成环境为 Blender 5.2.2 LTS。较旧版本的原生文件兼容性未验证，可优先导入通用 GLB。

## 已完成的验证

- 三个 GLB 的文件结构、嵌入资源及所需动画均已检查，并重新导入 Blender。
- 台面容纳检查通过；对已建模移液头与耗材每 3 帧抽样进行 AABB 检查，未发现穿插，循环起止位置一致。
- Edge 测试覆盖 1440 × 1080 和 390 × 844 视窗，以及模拟触控；验证加载、点击进入、返回、拖动不误触、暂停和继续。
- 网页按材质合并静态显示几何以减少绘制调用，原 GLB 和 Blender 文件保留可编辑分件。

详见 [`reports/model_validation.json`](reports/model_validation.json) 和 [`reports/browser_checks.json`](reports/browser_checks.json)。手机尺寸和触控测试属于桌面模拟，尚未在实体手机、平板、Safari 或 Android 浏览器实测。

## 已知简化

1. 正面外观以新增实拍为优先依据；内部相对位置参考实物全景，局部结构参考特写。
2. 后部导轨、隐藏驱动和部分连接为展示简化，真实行程尚未标定。
3. 八根可见针轴不代表已确认的实际通道数；18 秒循环不代表真实处理速度，也不包含真实吸排液。
4. 屏幕为标记了 `INTERFACE PLACEHOLDER` 的示意界面；品牌和装饰线为可替换的近似重绘。
5. 当前未展开右侧培养箱内部取放板机构、液体或软管仿真，也未模拟完整生物实验流程。
6. 仓库保留参考拼图，不声称包含全部原始照片或视频。

详细素材依据、估算项与动画修改说明见 [`docs/HANDOFF.md`](docs/HANDOFF.md)。

## 第三方依赖与权利说明

网页使用 **Three.js 0.180.0**，核心模块与所需扩展已本地打包。MIT 许可证位于 [`web/vendor/THREE-LICENSE.txt`](web/vendor/THREE-LICENSE.txt)，依赖哈希见 [`reports/vendor_manifest.json`](reports/vendor_manifest.json)。

Three.js 许可证仅适用于对应第三方代码。本仓库未为设备品牌、参考素材与重建模型另行指定开源许可；对外分发时应依据项目所有者实际持有的权利处理。

---

版本：V1 · 制作日期：2026-09-29

## 2026-09-30 场景升级

在原展示页基础上新增受控动画、板孔拾取与聚焦、随头相机、原位 shake 和液位覆盖。运行 `node server.mjs` 后打开 [场景验收页](http://127.0.0.1:8765/web/scene/preview.html)，可播放或拖动合成状态示例。运行时数据接入接口、复现与验证命令见 [场景交接](docs/SCENE_HANDOFF.md)。此页面只验证 A 的 3D 显示，设备 Runtime / Agent 仍由 B 实现。

排枪展示已按用户补充修正：当前 24 孔板每排 6 孔，6 根针以 21.6 mm 间距整排对齐、同时吸排液，示例整排液位同步变化。原 GLB 八针参考保留，网页用场景几何调整为该排枪配置。
