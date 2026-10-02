import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {DeviceClient} from '../../packages/device-contract/src/client.ts';
const base='http://127.0.0.1:8790';
const c=new DeviceClient({baseUrl:base,token:readFileSync('/tmp/oscar-review-live-20260930/runtime/operator.token','utf8').trim()});
await c.control(await c.currentExperimentId(),{reset:{scenario_id:'exchange_and_mix',seed:42}});
const exp=await c.currentExperimentId();
await c.control(exp,{speed:4});
const before=await c.state(exp);
const pair=(await c.request('POST','/api/v1/pairing-codes',{})).body;
const browser=await chromium.launch({channel:'chromium',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
try {
 const page=await browser.newPage({viewport:{width:1600,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pair.url);await page.waitForURL('**/web/workbench.html');
 await page.waitForFunction(()=>window.oscarScene && !window.oscarScene.getStatus().transitioning);
 const box=await page.locator('#scene-stage').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-400);await page.waitForTimeout(500);
 await page.locator('#tab-agent').click();await page.locator('#agent-mode').selectOption('scripted');
 await page.locator('button:has-text("启动 Agent run")').click();
 const captured=new Set();const seen=[];let final;
 const deadline=Date.now()+180000;
 while(Date.now()<deadline){
   const s=await c.state(exp);if(s.run?.status==='ended'){final=s;break;}
   for(const a of s.active_actions){
    const stage=a.stages[a.current_stage_index]?.stage;
    const key=a.capability==='media.exchange'&&stage==='dispensing'&&a.stages[a.current_stage_index]?.target?.row_id==='A'?'dispensing':a.capability==='plate.shake'?'shaking':null;
    if(key&&!captured.has(key)){
      captured.add(key);await c.control(exp,{pause:true});
      await page.waitForTimeout(1200);
      await page.screenshot({path:`reports/review/demo-${key}.png`});
      seen.push({key,sim_time_s:s.experiment.sim_time_s,action_id:a.action_id,stage});
      await c.control(exp,{resume:true});
    }
   }
   await new Promise(r=>setTimeout(r,100));
 }
 if(!final)throw Error('demo timed out');
 await page.waitForTimeout(2000);await page.screenshot({path:'reports/review/demo-completed.png'});
 const actions=(await c.actions(exp)).actions;
 const observations=await c.observations(exp);
 await page.locator('#tab-camera').click();await page.waitForTimeout(1000);
 await page.screenshot({path:'reports/review/demo-camera.png'});
 const report=(await c.request('GET',`/api/v1/runs/${final.run.run_id}/report`)).body;
 writeFileSync('reports/review/live-demo.json',JSON.stringify({experiment_id:exp,run:final.run,seen,errors,sceneErrors:await page.evaluate(()=>window.oscarScene.updateErrors()),before,final,actions,observations,report},null,2)+'\n');
 console.log(JSON.stringify({experiment_id:exp,run_id:final.run.run_id,outcome:final.run.reason,actions:actions.map(a=>({capability:a.capability,status:a.status})),seen,errors}));
}finally{await browser.close();}
