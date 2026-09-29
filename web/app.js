import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

const $=id=>document.getElementById(id),stage=$('stage');
let renderer;
try {renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});}catch(e){$('webgl-error').hidden=false;$('load-status').hidden=true;throw e;}
renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));renderer.setSize(innerWidth,innerHeight);renderer.setClearColor(0xe9edf1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;stage.appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0xe9edf1);
const camera=new THREE.PerspectiveCamera(35,innerWidth/innerHeight,.01,100);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.075;controls.minDistance=.65;controls.maxDistance=12;controls.maxPolarAngle=Math.PI*.88;controls.target.set(0,.92,0);controls.autoRotateSpeed=.7;
const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();const environment=pmrem.fromScene(room,.035);scene.environment=environment.texture;room.dispose();pmrem.dispose();
scene.environmentIntensity=.6;scene.add(new THREE.HemisphereLight(0xffffff,0x778593,1.1));
const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(-3,5,4);light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.shadow.camera.left=-2;light.shadow.camera.right=2;light.shadow.camera.top=3;light.shadow.camera.bottom=-2;light.shadow.normalBias=.014;scene.add(light);
const fill=new THREE.DirectionalLight(0xc4d9fb,.8);fill.position.set(4,2,-2);scene.add(fill);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({opacity:.16}));floor.rotation.x=-Math.PI/2;floor.position.y=-.005;floor.receiveShadow=true;scene.add(floor);
let model,exterior,mixer,actions=[],mode='exterior',playing=true,transition=null,ready=false,frameCount=0;
const clock=new THREE.Clock();
function pose(interior=mode==='interior',front=false){
 const mobile=innerWidth<700;
 return interior?{pos:new THREE.Vector3(front?-.43:.60,mobile?2.25:2.12,mobile?4.6:2.35),target:new THREE.Vector3(mobile?-.43:-.55,1.23,0)}:{pos:new THREE.Vector3(front?0:2.7,front?.95:2.18,mobile?9.1:4.35),target:new THREE.Vector3(0,.90,0)};
}
function fly(front=false,immediate=false){const p=pose(mode==='interior',front);if(immediate){camera.position.copy(p.pos);controls.target.copy(p.target);controls.update();return;}transition={start:performance.now(),from:camera.position.clone(),to:p.pos,a:controls.target.clone(),b:p.target};}
fly(false,true);
function updateLabels(){document.body.dataset.mode=mode;$('mode-label').textContent=mode==='interior'?'02 ／ WORK CHAMBER':'01 ／ EXTERIOR';$('mode-title').textContent=mode==='interior'?'台面布局与移液运动。':'从外观，走进工作舱。';$('hint').innerHTML=mode==='interior'?'拖动旋转 · 缩放查看细节<br>18 秒演示循环 · 非实际工艺速度':'拖动旋转 · 滚轮缩放<br>点击设备，查看内部工作平台';$('toggle').innerHTML=mode==='interior'?'返回外观 <span>↙</span>':'进入工作舱 <span>↗</span>';$('foot-state').textContent=mode==='interior'?'主工作舱 · 展示动作':'外观模型';}
function toggleMode(){if(!ready)return;mode=mode==='exterior'?'interior':'exterior';exterior.visible=mode==='exterior';floor.visible=mode==='exterior';controls.autoRotate=false;$('rotate').setAttribute('aria-pressed','false');if(mode==='interior'&&mixer&&playing)mixer.timeScale=1;else if(mixer)mixer.timeScale=0;updateLabels();fly();}
$('toggle').onclick=toggleMode;
$('play').onclick=()=>{playing=!playing;mixer.timeScale=playing?1:0;$('play').textContent=playing?'暂停演示':'播放演示';$('play').setAttribute('aria-pressed',String(!playing));};
$('reset').onclick=()=>{controls.autoRotate=false;$('rotate').setAttribute('aria-pressed','false');fly();};
$('front').onclick=()=>fly(true);
$('rotate').onclick=()=>{controls.autoRotate=!controls.autoRotate;$('rotate').setAttribute('aria-pressed',String(controls.autoRotate));};
controls.addEventListener('start',()=>transition=null);
const pointers=new Set();let down=null,gesture=false;
renderer.domElement.addEventListener('pointerdown',e=>{pointers.add(e.pointerId);if(pointers.size>1)gesture=true;if(pointers.size===1){down={x:e.clientX,y:e.clientY,t:performance.now(),id:e.pointerId,max:0};gesture=false;}});
renderer.domElement.addEventListener('pointermove',e=>{if(down)down.max=Math.max(down.max,Math.hypot(e.clientX-down.x,e.clientY-down.y));});
const raycaster=new THREE.Raycaster();
renderer.domElement.addEventListener('pointerup',e=>{pointers.delete(e.pointerId);if(!down||gesture||e.pointerId!==down.id||mode!=='exterior'||!ready)return;const click=down.max<7&&performance.now()-down.t<650;down=null;if(!click)return;const rect=renderer.domElement.getBoundingClientRect();raycaster.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);if(raycaster.intersectObject(exterior,true).length)toggleMode();});
renderer.domElement.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);down=null;gesture=false;});
const loader=new GLTFLoader();
function batchStatic(group){
 group.updateWorldMatrix(true,true);const inverse=group.matrixWorld.clone().invert(),batches=new Map();
 group.traverse(o=>{if(!o.isMesh||Array.isArray(o.material))return;const key=o.material.uuid+Object.keys(o.geometry.attributes).sort().join(',');if(!batches.has(key))batches.set(key,[]);batches.get(key).push(o);});
 for(const meshes of batches.values()){
  if(meshes.length<2)continue;
  const geometries=meshes.map(mesh=>{const g=mesh.geometry.clone();g.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));return g;});
  const merged=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());if(!merged)continue;
  const result=new THREE.Mesh(merged,meshes[0].material);result.name='DisplayBatch_'+meshes[0].material.name;group.add(result);for(const mesh of meshes)mesh.removeFromParent();
 }
}
loader.load('../models/OSCAR_full.glb',gltf=>{
 model=gltf.scene;scene.add(model);exterior=model.getObjectByName('Exterior');if(!exterior)throw new Error('Exterior group missing');
 batchStatic(exterior);batchStatic(model.getObjectByName('Interior'));
 model.traverse(o=>{if(o.isMesh){o.castShadow=!o.material.transparent;o.receiveShadow=true;if(o.material.transparent){o.material.depthWrite=false;o.renderOrder=2;}}});
 mixer=new THREE.AnimationMixer(model);actions=gltf.animations.map(clip=>mixer.clipAction(clip));actions.forEach(action=>action.play());mixer.timeScale=0;
 ready=true;document.body.dataset.ready='true';$('load-status').hidden=true;document.querySelectorAll('nav button').forEach(b=>b.disabled=false);updateLabels();
},e=>{if(e.total)$('load-status').textContent=`正在加载三维模型 ${Math.round(100*e.loaded/e.total)}%`;},error=>{console.error(error);$('load-status').textContent='模型加载失败。请使用启动脚本打开，勿直接双击 HTML。';});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);fly(false,true);});
function tick(){requestAnimationFrame(tick);const dt=Math.min(clock.getDelta(),.08);if(mixer)mixer.update(dt);if(transition){let t=Math.min((performance.now()-transition.start)/1050,1);t=t*t*(3-2*t);camera.position.lerpVectors(transition.from,transition.to,t);controls.target.lerpVectors(transition.a,transition.b,t);if(t>=1)transition=null;}controls.update();renderer.render(scene,camera);frameCount++;}
tick();
// Read-only diagnostics for handoff and browser verification.
window.oscarStatus=()=>({ready,mode,playing,time:mixer?.time||0,animationCount:actions.length,exteriorVisible:exterior?.visible,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,frameCount,renderer:renderer.info.memory});
