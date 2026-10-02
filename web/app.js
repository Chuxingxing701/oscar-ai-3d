// Presentation-page adapter. B can mount the same module inside the workbench.
import {mountScene} from './scene/index.js';
const $ = id => document.getElementById(id);
function labels(s) {
  document.body.dataset.mode = s.mode; document.body.dataset.ready = String(s.ready);
  const inside = s.mode === 'interior', controlled = s.animationMode === 'controlled';
  $('mode-label').textContent = inside ? '02 ／ WORK CHAMBER' : '01 ／ EXTERIOR';
  $('mode-title').textContent = inside ? '台面布局与移液运动。' : '从外观，走进工作舱。';
  $('hint').innerHTML = inside ? '拖动旋转 · 点击板孔选择<br>虚拟相机 / 原位振荡 / 排枪整排加液示意' : '拖动旋转 · 滚轮缩放<br>点击设备，查看内部工作平台';
  $('toggle').innerHTML = inside ? '返回外观 <span>↙</span>' : '进入工作舱 <span>↗</span>';
  $('play').textContent = controlled ? (s.displayPaused ? '恢复显示' : '暂停显示') : (s.playing ? '暂停演示' : '播放演示');
  $('play').setAttribute('aria-pressed', String(controlled ? s.displayPaused : !s.playing));
  $('rotate').setAttribute('aria-pressed', String(s.autoRotate));
  $('foot-state').textContent = inside ? (controlled ? '主工作舱 · 受控状态' : '主工作舱 · 18 秒待机示意') : '外观模型';
}
try {
  const viewer = mountScene($('stage'), {onViewChange: labels,
    onSelect(selection) {$('foot-state').textContent = selection ? `${selection.resource_id ?? selection.plate_id} ${selection.well_id ?? ''} · 已选中` : '主工作舱';},
    onProgress(e) {if (e.total) $('load-status').textContent = `正在加载三维模型 ${Math.round(100 * e.loaded / e.total)}%`;}});
  window.oscarScene = viewer;
  window.oscarStatus = viewer.getStatus;
  $('toggle').onclick = () => viewer.setView(viewer.getStatus().mode === 'interior' ? 'exterior' : 'interior');
  $('play').onclick = () => {
    const s = viewer.getStatus();
    if (s.animationMode === 'controlled') viewer.setDisplayPaused(!s.displayPaused);
    else viewer.setPlaying(!s.playing);
  };
  $('reset').onclick = () => viewer.resetView();
  $('front').onclick = () => viewer.resetView(true);
  $('rotate').onclick = () => viewer.setAutoRotate(!viewer.getStatus().autoRotate);
  await viewer.ready;
  $('load-status').hidden = true;
  document.querySelectorAll('nav button').forEach(button => {button.disabled = false;});
  window.addEventListener('pagehide', () => viewer.dispose(), {once: true});
} catch (error) {
  console.error(error);
  $('load-status').textContent = `场景加载失败：${error.message}。请通过本地 HTTP 服务打开。`;
  $('webgl-error').hidden = false;
}
