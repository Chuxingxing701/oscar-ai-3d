import {mountScene} from './index.js';
import {previewSnapshot, DURATION} from './fixtures.js';
const $ = id => document.getElementById(id);
for (const row of 'ABCD') for (let column = 1; column <= 6; column++) $('well').add(new Option(row + column));
let time = 0, running = false, last = performance.now(), frame;
const map = await (await fetch('./scene-map.json')).json();
const viewer = mountScene($('stage'), {onSelect(selection) {
  if (!selection?.plate_id) return;
  $('plate').value = selection.plate_id;
  if (selection.well_id) $('well').value = selection.well_id;
  $('selection').textContent = `${selection.plate_id} / ${selection.well_id ?? '整板'}`;
  draw();
}});
window.scenePreview = viewer;
function draw() {
  $('time').textContent = `${time.toFixed(1)} s`; $('timeline').value = time;
  if ($('action').value === 'idle') {viewer.setAnimationMode('idle'); viewer.setPlaying(running); $('phase').textContent = '原始 18 秒待机循环 · 非设备动作'; $('volume').textContent = '—'; $('active-row').textContent = '—'; return;}
  const frame = previewSnapshot(map, $('action').value, time, $('plate').value, $('well').value, !running);
  viewer.update(frame.state); $('phase').textContent = frame.phase;
  $('volume').textContent = `${frame.volume.toFixed(0)} / 2000 µL`;
  $('active-row').textContent = ['dispense', 'exchange'].includes($('action').value) ? `${frame.wellIds[0]}–${frame.wellIds.at(-1)} · ${frame.wellIds.length} 孔同步` : '—';
}
function setRunning(value) {running = value; $('play').textContent = running ? '暂停示意' : '播放示意'; $('play').setAttribute('aria-pressed', String(running)); draw();}
function tick(now) {const dt = Math.min((now - last) / 1000, .1); last = now;
  if (running && $('action').value !== 'idle') {time = Math.min(DURATION, time + dt); if (time === DURATION) setRunning(false); draw();}
  frame = requestAnimationFrame(tick);
}
try {
  await viewer.ready; viewer.setView('interior'); draw();
  $('focus').onclick = () => viewer.focus({plate_id: $('plate').value, well_id: $('well').value});
  $('deck').onclick = () => {viewer.setView('interior'); viewer.focus({plate_id: $('plate').value});};
  $('exterior').onclick = () => viewer.setView('exterior');
  $('play').onclick = () => {if (time === DURATION) time = 0; setRunning(!running);};
  $('reset').onclick = () => {time = 0; setRunning(false);};
  $('timeline').oninput = () => {time = Number($('timeline').value); setRunning(false);};
  $('action').onchange = () => {time = 0; setRunning(false);};
  for (const id of ['plate', 'well']) $(id).onchange = () => {draw(); viewer.select({plate_id: $('plate').value, well_id: $('well').value}); $('selection').textContent = `${$('plate').value} / ${$('well').value}`;};
  frame = requestAnimationFrame(tick);
  addEventListener('pagehide', () => {cancelAnimationFrame(frame); viewer.dispose();}, {once: true});
} catch (error) {$('phase').textContent = `场景加载失败：${error.message}`; console.error(error);}
