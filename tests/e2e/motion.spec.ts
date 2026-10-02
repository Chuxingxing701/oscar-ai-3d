import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {operatorClient,pairAndOpen,sceneUpdateErrors} from './helpers.ts';

test('continuous confirmed-time motion: shake, pause, liquid travel and selected scan plate',async({page})=>{
 const c=operatorClient();
 await c.control(await c.currentExperimentId(),{reset:{scenario_id:'routine_maintenance',seed:42,clock_mode:'lockstep'}});
 const exp=await c.currentExperimentId();
 try {
 await pairAndOpen(page);
 await page.waitForFunction(()=>Boolean((window as any).oscarScene?.getStatus().ready));
 await page.waitForFunction(()=>!(window as any).oscarScene?.getStatus().transitioning);
 const sample=async(ms:number)=>page.evaluate(async duration=>{
   const frames:any[]=[];const end=performance.now()+duration;
   while(performance.now()<end){
     await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
     const s=(window as any).oscarScene.getStatus();
     frames.push({time:s.renderedSimTime,authority:s.simTime,shake:s.shakes['plate-02'],motion:s.motion,frame:s.frameCount});
   }
   return frames;
 },ms);
 // Runtime events, not a scene fixture; don't refresh to hide reducer defects.
 await c.submit(exp,{capability:'plate.shake',arguments:{plate_id:'plate-02',speed_rpm:300,duration_sim_s:30}});
 await c.control(exp,{speed:1});await c.control(exp,{clock_mode:'realtime'});
 const shaking=await sample(4000);
 // Integer 4 Hz samples alias to ~zero. Require visible displacement and
 // fractional confirmed time, independent of software GPU throughput.
 expect(shaking.some(f=>Math.hypot(f.shake[0],f.shake[2])>.0003)).toBe(true);
 expect(shaking.some(f=>f.time%1>.01&&f.time%1<.99)).toBe(true);
 expect(shaking.every(f=>f.time<=f.authority)).toBe(true);
 await c.control(exp,{pause:true});
 await expect.poll(()=>page.evaluate(()=>(window as any).oscarScene.getStatus().paused)).toBe(true);
 const paused=await sample(450);
 expect(new Set(paused.map(f=>JSON.stringify(f.shake))).size).toBe(1);
 const shake=(await c.actions(exp)).actions.find(a=>a.capability==='plate.shake')!;
 await c.cancel(exp,shake.action_id);
 await expect.poll(()=>page.evaluate(()=>(window as any).oscarScene.getStatus().shakes['plate-02'])).toEqual([0,0,0]);
 await c.control(exp,{clock_mode:'lockstep'});await c.control(exp,{resume:true});
 await c.submit(exp,{capability:'media.add',arguments:{plate_id:'plate-01',row_id:'B',reservoir_id:'media-01',volume_ul_per_well:50}});
 await c.control(exp,{clock_mode:'realtime'});
 const moving=await sample(3200);
 expect(new Set(moving.map(f=>JSON.stringify(f.motion))).size).toBeGreaterThan(2);
 expect(moving.some(f=>f.time%1>.01&&f.time%1<.99)).toBe(true);
 expect(moving.every(f=>f.time<=f.authority)).toBe(true);
 await c.control(exp,{clock_mode:'lockstep'});await c.control(exp,{step:{until_idle:true}});
 // Scene/list selection must bind the actual request, not only the viewing camera.
 await page.locator('.well[aria-label^="plate-02 D6，"]').click();
 await expect(page.getByLabel('扫描板',{exact:true})).toHaveValue('plate-02');
 const box=page.locator('.scan-wells label').filter({hasText:/^D6$/}).locator('input');
 await expect(box).toBeChecked();
 await page.locator('#form-scan button[type=submit]').click();
 await expect.poll(async()=>(await c.actions(exp)).actions.filter(a=>a.capability==='imaging.scan').length).toBe(1);
 const scan=(await c.actions(exp)).actions.find(a=>a.capability==='imaging.scan')!;
 expect(scan.arguments.plate_id).toBe('plate-02');expect(scan.arguments.wells).toEqual(['D6']);
 await c.control(exp,{step:{steps:4}});
 await expect.poll(()=>page.evaluate(()=>(window as any).oscarScene.getStatus().headTarget)).toEqual({plate_id:'plate-02',well_id:'D6'});
 const map=JSON.parse(readFileSync('web/scene/scene-map.json','utf8'));
 const target=map.stations.find((s:any)=>s.id==='plate-02').wells.find((w:any)=>w.well_id==='D6').center_m;
 await expect.poll(async()=>{
   const s=await page.evaluate(()=>(window as any).oscarScene.getStatus());
   return Math.abs(s.cameraLens[0]-target[0])+Math.abs(s.cameraLens[2]-target[2]);
 }).toBeLessThan(1e-6);
 // An explicit dropdown choice persists across further SSE renders.
 await page.getByLabel('扫描板',{exact:true}).selectOption('plate-01');
 await c.control(exp,{step:{until_idle:true}});
 await expect(page.getByLabel('扫描板',{exact:true})).toHaveValue('plate-01');
 expect(await sceneUpdateErrors(page)).toEqual([]);
 await page.screenshot({path:'reports/e2e/motion-scan-target.png'});
 } finally {
   // A failed assertion must not leave realtime/actions running in the shared stack.
   await c.control(exp,{reset:{clock_mode:'lockstep'}});
 }
});
