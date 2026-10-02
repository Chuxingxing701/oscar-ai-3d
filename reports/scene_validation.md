# A 场景验收记录

日期：2026-09-30（Asia/Shanghai）。范围：v0.4 §8.2，A 侧模型素材、映射、受控显示和交互。

| 检查 | 结果 |
| --- | --- |
| GLB SHA256、工位存在、孔数、坐标、A–D/1–6 编号 | 通过 |
| 两块板共 8 排、48 培养孔的 6 针整排对位、约 44 mm 展示间隙 | 通过 |
| 阶段插值、时间钳制、高位横移与直接回放 | 通过 |
| shake 依模拟时刻展示、取消与结束归零 | 通过 |
| 非法快照拒绝、液量不随动画进度擅自变化 | 通过 |
| 真实 GLB 合并后保留受控节点、液位拾取和相机挂载 | 通过 |
| 实际针轴/连接件与六束光对位，选 C4 驱动 C1–C6 整排，其他排/板不变 | 通过 |
| 4 张恢复贴图与原 GLB 嵌入字节一致 | 通过 |
| Chromium 浏览器 11 项检查 | 通过，详见 scene_browser_checks.json |
| 桌面及手机尺寸截图查看 | 已核对 |
| Blender 重导出/碰撞验证 | 未运行；本机无 Blender；GLB/母模型未改写 |
| Runtime、SSE、Agent 端到端 | 本轮 A 范围外，待 B 接入 |

复验：`node --test web/scene/tests/scene.test.mjs`；`python3 source/prepare_scene_assets.py --check`。
浏览器：先运行 `node server.mjs`，再将 `PLAYWRIGHT_MODULE` 指向外部 Playwright 的 ESM 入口，执行 `node web/scene/tests/browser.mjs`。

原模型尺度为示意；本轮展示排枪为匹配 24 孔板的 6 通道配置。附加几何不改变模型原始行程；受控遍历所有孔的整个移液头/舱壁碰撞及实机可达性未认证。截图、扫描光锥和本地合成液量不作为 Agent 观测证据。
