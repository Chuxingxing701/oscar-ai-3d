import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {buildSceneModel} from './model.js';
import {validateSnapshot} from './state.js';
import {PresentationClock} from './presentation.js';

const DEFAULT_MAP = new URL('./scene-map.json', import.meta.url);

/** Credential-free view. Await ready; update(snapshot) enters controlled mode.
 * Controlled time comes only from snapshot.sim_time_s, including pause/replay.
 */
export function mountScene(container, options = {}) {
  if (!container) throw new Error('Scene container required');
  const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-label', 'OSCAR 3D 场景；拖动旋转，点击选择板孔');
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe9edf1);
  const camera = new THREE.PerspectiveCamera(35, 1, .01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = .075;
  controls.minDistance = .09; controls.maxDistance = 12; controls.maxPolarAngle = Math.PI * .88;
  controls.autoRotateSpeed = .7;
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .035);
  scene.environment = environment.texture; scene.environmentIntensity = .6;
  room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x778593, 1.1));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(-3, 5, 4); light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  Object.assign(light.shadow.camera, {left: -2, right: 2, top: 3, bottom: -2});
  light.shadow.normalBias = .014; scene.add(light);
  const fill = new THREE.DirectionalLight(0xc4d9fb, .8); fill.position.set(4, 2, -2); scene.add(fill);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({opacity: .16}));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.005; floor.receiveShadow = true; scene.add(floor);
  let map, model, rig, exterior, mixer, actions = [], snapshot = null;
  let ready = false, disposed = false, mode = 'exterior', animationMode = 'idle';
  let playing = true, displayPaused = false, frameCount = 0, raf = 0, transition = null, dirty = true;
  let previousFrame = performance.now();
  const presentation = new PresentationClock();
  let renderedTime = null;
  const ownedGeometries = new Set(), ownedMaterials = new Set(), ownedTextures = new Set();
  function collect(root) {
    root.traverse(o => {
      if (o.geometry) ownedGeometries.add(o.geometry);
      for (const material of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
        ownedMaterials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) ownedTextures.add(value);
      }
    });
  }
  function release() {
    ownedGeometries.forEach(g => g.dispose()); ownedMaterials.forEach(m => m.dispose());
    ownedTextures.forEach(t => {t.dispose(); t.source?.data?.close?.();});
    ownedGeometries.clear(); ownedMaterials.clear(); ownedTextures.clear();
  }
  function notify() {options.onViewChange?.(getStatus());}
  function fly(position, target, immediate = false) {
    dirty = true;
    if (immediate) {camera.position.copy(position); controls.target.copy(target); controls.update(); return;}
    transition = {start: performance.now(), from: camera.position.clone(), to: position,
      a: controls.target.clone(), b: target};
  }
  function resetView(front = false, immediate = false) {
    const mobile = container.clientWidth < 700;
    const position = mode === 'interior'
      ? new THREE.Vector3(front ? -.43 : .6, mobile ? 2.25 : 2.12, mobile ? 4.6 : 2.35)
      : new THREE.Vector3(front ? 0 : 2.7, front ? .95 : 2.18, mobile ? 9.1 : 4.35);
    const target = mode === 'interior' ? new THREE.Vector3(mobile ? -.43 : -.55, 1.23, 0) : new THREE.Vector3(0, .9, 0);
    controls.autoRotate = false; fly(position, target, immediate); notify();
  }
  let renderWidth = 0, renderHeight = 0, pendingSize = null, resizeCount = 0;
  function resize() {
    if (disposed) return;
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    pendingSize = width !== renderWidth || height !== renderHeight ? {width, height} : null;
    if (pendingSize) dirty = true;
  }
  const observer = new ResizeObserver(resize); observer.observe(container); resize(); resetView(false, true);
  const events = new AbortController();
  controls.addEventListener('start', () => {transition = null;});
  controls.addEventListener('change', () => {dirty = true;});
  const pointers = new Set(); let down = null, gesture = false;
  const canvas = renderer.domElement;
  const listen = (type, fn) => canvas.addEventListener(type, fn, {signal: events.signal});
  listen('pointerdown', e => {
    pointers.add(e.pointerId);
    if (pointers.size > 1) gesture = true;
    if (pointers.size === 1) {down = {x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, max: 0}; gesture = false;}
  });
  listen('pointermove', e => {if (down) down.max = Math.max(down.max, Math.hypot(e.clientX - down.x, e.clientY - down.y));});
  const raycaster = new THREE.Raycaster();
  listen('pointerup', e => {
    pointers.delete(e.pointerId);
    if (!down || gesture || e.pointerId !== down.id || !ready) return;
    const click = e.button === 0 && down.max < 7 && performance.now() - down.t < 650; down = null;
    if (!click) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1,
      -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    if (mode === 'exterior') {
      if (raycaster.intersectObject(exterior, true).length) setView('interior');
      return;
    }
    // Include occluders: a well behind the head must not be picked through it.
    const hit = raycaster.intersectObject(model, true).find(h => {
      for (let o = h.object; o; o = o.parent) if (!o.visible) return false;
      return !h.object.userData.pickThrough && h.object.name !== 'Selection_ring' && !h.object.name.startsWith('Virtual_scan');
    });
    const selection = hit?.object.userData.instanceSelections?.[hit.instanceId] ?? hit?.object.userData.selection;
    select(selection ?? null);
  });
  listen('pointercancel', e => {pointers.delete(e.pointerId); down = null; gesture = false;});
  function setView(next) {
    if (!['interior', 'exterior'].includes(next)) throw new Error('Invalid view');
    mode = next; if (exterior) exterior.visible = mode === 'exterior';
    floor.visible = mode === 'exterior'; resetView(); notify();
  }
  function select(target) {
    if (!ready) return;
    if (target) rig.selectionPosition(target);
    rig.select(target); dirty = true; options.onSelect?.(target ? {...target} : null);
  }
  function focus(target) {
    if (!ready) return;
    if (!target || (target.device_id && !target.plate_id && !target.resource_id)) {setView('exterior'); return;}
    const {position, well} = rig.selectionPosition(target);
    setView('interior'); select(target);
    const distance = well ? .19 : .34;
    fly(position.clone().add(new THREE.Vector3(.04, distance, distance * .8)), position);
  }
  function setAnimationMode(next) {
    if (!['idle', 'controlled'].includes(next)) throw new Error('Invalid animation mode');
    if (next === animationMode) return;
    animationMode = next;
    dirty = true;
    mixer?.stopAllAction();
    if (next === 'idle') {
      snapshot = null; displayPaused = false; rig?.update(null);
      actions.forEach(action => action.reset().play());
    } else rig?.update(snapshot ?? {sim_time_s: 0, plates: [], actions: []});
    notify();
  }
  function update(state, presentationOptions = {}) {
    if (disposed || !ready) throw new Error('Await scene.ready before update');
    validateSnapshot(map, state);
    const changedExperiment = snapshot && snapshot.experiment_id !== state.experiment_id;
    snapshot = structuredClone(state);
    if (changedExperiment) {displayPaused = false; select(null);}
    // The snapshot may have released the head while the presentation still
    // needs to finish the confirmed final park interval.
    const now = performance.now(), last = presentation.stages.at(-1);
    const finishingPark = last?.stage === 'moving' && last.target == null &&
      presentation.sample(now) < last.stage_started_at_sim_s + last.stage_duration_sim_s;
    const animated = snapshot.actions.length || snapshot.plates.some(plate => plate.shake?.active) || finishingPark;
    presentation.update(snapshot, now, displayPaused || !animated ? {} : presentationOptions);
    setAnimationMode('controlled');
    if (!displayPaused) {
      const frame = presentation.frame(snapshot, performance.now());
      renderedTime = frame.sim_time_s;
      rig.update(frame); dirty = true;
    }
    notify();
  }
  function setDisplayPaused(value) {
    displayPaused = Boolean(value);
    if (!displayPaused && snapshot) {
      presentation.update(snapshot, performance.now());
      renderedTime = snapshot.sim_time_s; rig.update(snapshot); dirty = true;
    }
    notify();
  }
  function setPlaying(value) {playing = Boolean(value); notify();}
  function getStatus() {
    return {ready, disposed, mode, playing, displayPaused, animationMode,
      experimentId: snapshot?.experiment_id ?? null, simTime: snapshot?.sim_time_s ?? null,
      renderedSimTime: renderedTime,
      paused: snapshot?.paused ?? false, time: mixer?.time ?? 0, animationCount: actions.length,
      exteriorVisible: exterior?.visible, autoRotate: controls.autoRotate, transitioning: !!transition, frameCount, resizeCount,
      drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      renderer: {...renderer.info.memory}, selection: rig?.selection() ?? null,
      motion: rig?.axes.map(axis => axis.position.toArray()),
      rowHead: rig?.rowHeadStatus() ?? null,
      headTarget: snapshot?.actions[0]?.target ?? null,
      cameraLens: rig?.virtualCamera.getObjectByName('Camera_lens').getWorldPosition(new THREE.Vector3()).toArray() ?? null,
      shakes: rig ? Object.fromEntries([...rig.plates].map(([id, group]) => [id, group.position.toArray()])) : {},
      effects: rig ? Object.fromEntries(Object.entries(rig.effects).map(([id, mesh]) => [id, mesh.visible])) : {}};
  }
  function tick(now) {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - previousFrame) / 1000, .08); previousFrame = now;
    if (mixer && animationMode === 'idle' && playing && !displayPaused && mode === 'interior') {mixer.update(dt); dirty = true;}
    if (rig && snapshot && animationMode === 'controlled' && !displayPaused) {
      const time = presentation.sample(now);
      if (time !== renderedTime) {
        renderedTime = time;
        rig.update(presentation.frame(snapshot, now), {motionOnly: true}); dirty = true;
      }
    }
    if (transition) {
      let t = Math.min((now - transition.start) / 850, 1); t = t * t * (3 - 2 * t);
      camera.position.lerpVectors(transition.from, transition.to, t);
      controls.target.lerpVectors(transition.a, transition.b, t);
      if (t >= 1) transition = null;
    }
    controls.update();
    // Paused/lockstep views need no redraw until state, camera or size changes.
    if (dirty) {
      // Resize clears WebGL's drawing buffer. Resize and redraw together,
      // before paint, so ResizeObserver never leaves a blank intermediate frame.
      if (pendingSize) {
        const {width, height} = pendingSize; pendingSize = null;
        if (width !== renderWidth || height !== renderHeight) {
          renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
          renderWidth = width; renderHeight = height; resizeCount++;
        }
      }
      renderer.render(scene, camera); frameCount++; dirty = false;
    }
  }
  raf = requestAnimationFrame(tick);
  const readyPromise = (async () => {
    try {
      const mapUrl = new URL(options.mapUrl ?? DEFAULT_MAP, globalThis.location?.href ?? DEFAULT_MAP);
      const response = await fetch(mapUrl, {signal: events.signal});
      if (!response.ok) throw new Error(`Scene map HTTP ${response.status}`);
      map = await response.json();
      const modelUrl = options.modelUrl ?? new URL(map.model, mapUrl).href;
      const gltf = await new GLTFLoader().loadAsync(modelUrl, options.onProgress);
      collect(gltf.scene);
      if (disposed) {release(); return;}
      model = gltf.scene; scene.add(model);
      rig = buildSceneModel(model, map);
      exterior = model.getObjectByName('Exterior'); exterior.visible = mode === 'exterior';
      model.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = !o.material.transparent; o.receiveShadow = true;
        if (o.material.transparent) o.material.depthWrite = false;
      });
      mixer = new THREE.AnimationMixer(model);
      const clip = gltf.animations.find(a => a.name === map.motion.idle_clip);
      if (!clip) throw new Error(`Missing idle clip ${map.motion.idle_clip}`);
      actions = [mixer.clipAction(clip)];
      if (animationMode === 'idle') actions.forEach(action => action.play());
      else rig.update({sim_time_s: 0, plates: [], actions: []});
      ready = true; dirty = true; notify(); return api;
    } catch (error) {
      if (disposed) return;
      options.onError?.(error); dispose(); throw error;
    }
  })();
  function dispose() {
    if (disposed) return;
    disposed = true; ready = false; cancelAnimationFrame(raf); observer.disconnect(); events.abort();
    controls.dispose(); mixer?.stopAllAction(); if (mixer && model) mixer.uncacheRoot(model);
    collect(scene); release(); environment.dispose(); light.shadow.dispose();
    renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
  }
  const api = {ready: readyPromise, update, setView, focus, select, resetView, setPlaying,
    setDisplayPaused, setAnimationMode, getStatus, dispose,
    setAutoRotate(value) {controls.autoRotate = Boolean(value); notify();}};
  return api;
}
