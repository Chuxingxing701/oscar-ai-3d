// Real Runtime/HTTP screenshots in isolated data; does not touch the live demo.
import {chromium} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {spawnRuntime,currentExperimentId} from '../services/runtime/test/helpers.ts';
const h=await spawnRuntime();let browser;
try{
 const e=await currentExperimentId(h);
 const pair=(await h.client.request('POST','/api/v1/pairing-codes',{})).body;
 browser=await chromium.launch({channel:'chromium',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const p=await browser.newPage({viewport:{width:1920,height:1080}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(pair.url);await p.waitForURL('**/web/workbench.html');
 await p.waitForFunction(()=>window.oscarScene?.getStatus().ready);
 await p.locator('#view-deck').click();await p.waitForFunction(()=>!window.oscarScene.getStatus().transitioning);
 const rect=await p.locator('#scene-stage').boundingBox();await p.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await p.mouse.wheel(0,-250);await p.waitForTimeout(600);
 const results=[];
 for(const [plate,well]of[['plate-01','B1'],['plate-02','A1']]){
  await h.client.submit(e,{capability:'imaging.scan',arguments:{plate_id:plate,wells:[well],mode:'mono'}});
  await h.client.control(e,{step:{steps:4}});
  await p.waitForFunction(({plate,well})=>{const s=window.oscarScene?.getStatus();return s?.effects.scan&&s.headTarget?.plate_id===plate&&s.headTarget?.well_id===well;},{plate,well});
  await p.waitForTimeout(1200);
  results.push(await p.evaluate(()=>window.oscarScene.getStatus()));
  await p.locator('#scene-stage').screenshot({path:`previews/scan-clearance-${plate}-${well}.png`});
  await h.client.control(e,{step:{until_idle:true}});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(await p.evaluate(()=>window.oscarScene.updateErrors()),[]);
 writeFileSync('reports/scan_geometry_check.json',JSON.stringify({errors,results},null,2)+'\n');
 console.log('PASS: real Runtime plate-01/B1 and plate-02/A1 scan screenshots; no page or scene errors');
}finally{await browser?.close();await h.stop();}
