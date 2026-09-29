import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {findTarget, pipetteLayout, sampleMotion, sampleShake} from './state.js';

export function batchStatic(group, protectedPrefixes = []) {
  group.updateWorldMatrix(true, true);
  const inverse = group.matrixWorld.clone().invert(), batches = new Map();
  group.traverse(o => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    for (let parent = o; parent && parent !== group; parent = parent.parent) {
      if (parent.userData.controlled || protectedPrefixes.some(p => parent.name === p || parent.name.startsWith(p + '_'))) return;
    }
    const key = o.material.uuid + Object.keys(o.geometry.attributes).sort().join(',');
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(o);
  });
  for (const meshes of batches.values()) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map(mesh => mesh.geometry.clone().applyMatrix4(inverse.clone().multiply(mesh.matrixWorld)));
    const merged = mergeGeometries(geometries, false);
    geometries.forEach(g => g.dispose());
    if (!merged) continue;
    const result = new THREE.Mesh(merged, meshes[0].material);
    result.name = 'DisplayBatch_' + meshes[0].material.name;
    group.add(result);
    meshes.forEach(mesh => mesh.removeFromParent());
  }
}

export function buildSceneModel(model, map) {
  // GLTFLoader sanitizes dots for animation bindings. Our controlled GLB names
  // are the contract; preserve their exact spelling (motion names are unchanged).
  model.traverse(o => {if (o.userData.name) o.name = o.userData.name;});
  const required = ['Exterior', 'Interior', ...['root', 'x', 'y', 'z'].map(k => map.motion[k]),
    ...map.motion.row_head.source_needle_nodes,
    ...map.stations.flatMap(s => s.nodes)];
  for (const name of required) if (!model.getObjectByName(name)) throw new Error(`GLB node missing: ${name}`);
  const interior = model.getObjectByName('Interior');
  const axes = ['x', 'y', 'z'].map(k => model.getObjectByName(map.motion[k]));
  const plates = new Map(), pickables = [], instances = new Map();
  const overlay = new THREE.Group(); overlay.name = 'Virtual_overlays'; overlay.userData.controlled = true;
  interior.add(overlay);
  const material = (name, color, options = {}) => new THREE.MeshStandardMaterial({name, color, roughness: .36, ...options});
  const metal = material('Virtual satin aluminium', 0x567686, {metalness: .65});
  const teal = material('Virtual camera housing', 0x176b7b, {metalness: .3});
  const lens = material('Virtual optical lens', 0x062237, {metalness: .5, roughness: .12});
  const liquidMat = material('Simulated medium overlay', 0x4bc7b2, {roughness: .2, transparent: true, opacity: .86, depthWrite: false});
  const plateMat = material('Controlled lab polymer', 0xe3e9de, {roughness: .29});
  const glowMat = new THREE.MeshBasicMaterial({color: 0x48edd1, transparent: true, opacity: .75, depthWrite: false});
  function mesh(name, geometry, mat, parent, position = [0, 0, 0]) {
    const o = new THREE.Mesh(geometry, mat); o.name = name; o.position.fromArray(position); parent.add(o); return o;
  }
  for (const station of map.stations) {
    const identity = {device_id: map.device_id, resource_id: station.id};
    if (station.kind === 'plate') identity.plate_id = station.id;
    for (const name of station.nodes) {
      const o = model.getObjectByName(name);
      const well = station.wells?.find(w => w.node === name);
      o.userData.selection = {...identity, ...(well ? {well_id: well.well_id} : {})};
      if (o.isMesh) pickables.push(o);
    }
    if (station.kind !== 'plate') continue;
    const group = new THREE.Group(); group.name = `Shake_${station.id}`; group.userData.controlled = true;
    interior.add(group); plates.set(station.id, group);
    // Keep the original names/world transforms when putting each plate on its own shaker.
    for (const name of station.nodes) group.attach(model.getObjectByName(name));
    model.getObjectByName(station.anchor_node).material = plateMat;
    const c = station.center_m;
    const platform = mesh(`Virtual_shake_platform_${station.id}`, new THREE.BoxGeometry(.151, .005, .104), metal, group, [c[0], .918, c[2]]);
    platform.userData.selection = identity; pickables.push(platform);
    const liquid = new THREE.InstancedMesh(new THREE.CylinderGeometry(.0054, .0054, 1, 24), liquidMat, station.wells.length);
    liquid.name = `Liquid_${station.id}`; liquid.userData.controlled = true;
    liquid.userData.instanceSelections = station.wells.map(w => ({...identity, well_id: w.well_id}));
    liquid.renderOrder = 3; liquid.instanceMatrix.setUsage(THREE.DynamicDrawUsage); liquid.frustumCulled = false;
    group.add(liquid); instances.set(station.id, liquid); pickables.push(liquid);
    const rims = new THREE.InstancedMesh(new THREE.TorusGeometry(.0062, .00055, 6, 24), metal, station.wells.length);
    rims.name = `Well_rims_${station.id}`; rims.userData.instanceSelections = liquid.userData.instanceSelections; group.add(rims);
    const dummy = new THREE.Object3D();
    station.wells.forEach((w, i) => {
      dummy.position.fromArray(w.center_m); dummy.position.y += .001;
      dummy.rotation.x = -Math.PI / 2; dummy.updateMatrix(); rims.setMatrixAt(i, dummy.matrix);
      dummy.scale.setScalar(0); dummy.updateMatrix(); liquid.setMatrixAt(i, dummy.matrix); dummy.scale.setScalar(1);
    });
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const width = .143, depth = .101;
      ctx.fillStyle = '#285878'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 30px sans-serif';
      const px = x => (x - c[0] + width / 2) / width * canvas.width;
      const py = z => (z - c[2] + depth / 2) / depth * canvas.height;
      for (const w of station.wells) {
        if (w.well_id.startsWith('A')) ctx.fillText(w.well_id.slice(1), px(w.center_m[0]), 38);
        if (w.well_id.endsWith('1')) ctx.fillText(w.well_id[0], 32, py(w.center_m[2]));
      }
      ctx.font = '24px sans-serif'; ctx.fillText(`${station.id} · SIMULATED`, 512, 690);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const labels = mesh(`Well_labels_${station.id}`, new THREE.PlaneGeometry(width, depth),
        new THREE.MeshBasicMaterial({map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide}),
        group, [c[0], .951, c[2]]);
      labels.rotation.x = -Math.PI / 2; labels.renderOrder = 4; labels.userData.pickThrough = true;
    }
  }
  const virtualCamera = new THREE.Group(); virtualCamera.name = 'Virtual_head_camera'; axes[2].add(virtualCamera);
  mesh('Camera_mount', new THREE.BoxGeometry(.012, .014, .06), metal, virtualCamera, [.058, 1.34, .055]);
  mesh('Camera_body', new THREE.BoxGeometry(.037, .027, .032), teal, virtualCamera, [.058, 1.34, .083]);
  mesh('Camera_lens', new THREE.CylinderGeometry(.009, .009, .008, 24), lens, virtualCamera, [.058, 1.322, .083]);
  const head = map.motion.row_head;
  // Re-space the actual shafts, connectors and tubes, not just their glow effects.
  // The shipped eight-needle reference is retained in GLB; this six-channel
  // display configuration matches the current 24-well plate row exactly.
  const needles = head.source_needle_nodes.map((name, i) => {
    const suffix = String(i).padStart(2, '0');
    const parts = [model.getObjectByName(name), model.getObjectByName(`Needle_connector_${suffix}`),
      model.getObjectByName(`Pipette_upper_tube_${suffix}`)].filter(Boolean);
    return {parts, originalX: parts.map(p => p.position.x), shaftX: parts[0].position.x};
  });
  const tipLight = new THREE.Group(); tipLight.name = 'Row_tip_lights'; axes[2].add(tipLight);
  const flow = new THREE.Group(); flow.name = 'Row_parallel_flows'; overlay.add(flow);
  const tipGeometry = new THREE.SphereGeometry(.003, 12, 8);
  const flowGeometry = new THREE.CylinderGeometry(.0013, .0013, 1, 12);
  for (let i = 0; i < head.channels; i++) {
    mesh(`Row_tip_${i + 1}`, tipGeometry, glowMat, tipLight);
    mesh(`Row_flow_${i + 1}`, flowGeometry, glowMat, flow);
  }
  let currentLayout;
  function configureHead(target) {
    currentLayout = pipetteLayout(map, target);
    needles.forEach(({parts, originalX, shaftX}, i) => parts.forEach((part, j) => {
      part.visible = i < head.channels;
      if (part.visible) part.position.x = originalX[j] + currentLayout.tips[i][0] - shaftX;
    }));
    currentLayout.tips.forEach((tip, i) => tipLight.children[i].position.fromArray(tip));
  }
  const scan = mesh('Virtual_scan_cone', new THREE.ConeGeometry(.035, 1, 32, 1, true),
    new THREE.MeshBasicMaterial({color: 0x63c9f0, transparent: true, opacity: .12, depthWrite: false, side: THREE.DoubleSide}), overlay);
  const highlight = mesh('Selection_ring', new THREE.TorusGeometry(.009, .0008, 8, 40),
    new THREE.MeshBasicMaterial({color: 0xffbf47, depthTest: false}), overlay);
  highlight.rotation.x = -Math.PI / 2; highlight.renderOrder = 10;
  const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-.071, 0, -.049), new THREE.Vector3(.071, 0, -.049),
    new THREE.Vector3(.071, 0, .049), new THREE.Vector3(-.071, 0, .049),
  ]), new THREE.LineBasicMaterial({color: 0xffbf47, depthTest: false}));
  outline.name = 'Selection_outline'; outline.userData.pickThrough = true; outline.renderOrder = 10; overlay.add(outline);
  flow.visible = scan.visible = tipLight.visible = highlight.visible = false;
  let selected = null;
  const dummy = new THREE.Object3D();
  configureHead(null);
  function selectionPosition(target) {
    const result = findTarget(map, target);
    const position = new THREE.Vector3().fromArray(result.center);
    position.add(plates.get(result.station.id)?.position ?? new THREE.Vector3());
    return {position, ...result};
  }
  function select(target) {
    selected = target ? {...target} : null; refreshSelection();
  }
  function refreshSelection() {
    highlight.visible = outline.visible = false;
    if (!selected) return;
    const {position, well} = selectionPosition(selected);
    const marker = well ? highlight : outline;
    marker.visible = true; marker.position.copy(position); marker.position.y += well ? .009 : .015;
  }
  function update(state) {
    const time = state?.sim_time_s ?? 0;
    for (const station of map.stations.filter(s => s.kind === 'plate')) {
      const plate = state?.plates.find(p => p.plate_id === station.id);
      plates.get(station.id).position.fromArray(sampleShake(plate?.shake, time));
      const liquid = instances.get(station.id);
      station.wells.forEach((w, i) => {
        const value = plate?.wells.find(v => v.well_id === w.well_id);
        const fraction = value ? value.volume_ul / value.capacity_ul : 0;
        const height = .0005 + fraction * .005;
        dummy.position.fromArray(w.center_m); dummy.position.y += .001 + height / 2;
        dummy.rotation.set(0, 0, 0); dummy.scale.set(fraction > 0 ? 1 : 0, height, fraction > 0 ? 1 : 0);
        dummy.updateMatrix(); liquid.setMatrixAt(i, dummy.matrix);
      });
      liquid.instanceMatrix.needsUpdate = true;
    }
    flow.visible = scan.visible = tipLight.visible = false;
    const action = state?.actions[0];
    configureHead(action && action.stage !== 'scanning' && action.tool !== 'camera' ? action.target : null);
    if (state) {
      const sample = sampleMotion(map, action, time), [x, y, z] = sample.pose;
      axes[0].position.set(x, 0, 0); axes[1].position.set(0, 0, z); axes[2].position.set(0, y, 0);
      if (sample.effect) {
        const scanning = sample.effect === 'scanning';
        function beam(effect, local, target) {
          const start = new THREE.Vector3(x + local[0], y + local[1], z + local[2]);
          target.y += .007;
          effect.position.copy(start).add(target).multiplyScalar(.5);
          effect.scale.y = start.distanceTo(target);
          effect.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), start.clone().sub(target).normalize());
        }
        if (scanning) {
          beam(scan, [.058, 1.318, .083], selectionPosition(action.target).position);
          scan.visible = true;
        } else {
          currentLayout.tips.forEach((local, i) => {
            const well = currentLayout.wells[i];
            const target = well ? selectionPosition({plate_id: action.target.plate_id ?? action.target.resource_id, well_id: well.well_id}).position
              : selectionPosition(action.target).position.add(new THREE.Vector3(local[0], 0, 0));
            beam(flow.children[i], local, target);
          });
          flow.visible = tipLight.visible = true;
        }
        glowMat.color.set(sample.effect === 'aspirating' ? 0xeeb26b : 0x48edd1);
        glowMat.opacity = .55 + .25 * Math.sin(time * Math.PI * 3);
      }
    }
    refreshSelection();
  }
  batchStatic(model.getObjectByName('Exterior'));
  batchStatic(interior, map.stations.map(s => s.prefix));
  update(null);
  return {axes, plates, instances, pickables, update, select, selectionPosition,
    rowHeadStatus: () => ({channels: head.channels, wellIds: currentLayout.wells.map(w => w.well_id),
      tipsLocal: currentLayout.tips.map(t => [...t]), activeFlows: flow.visible ? flow.children.length : 0}),
    selection: () => selected ? {...selected} : null, effects: {flow, scan, tipLight}, virtualCamera};
}
