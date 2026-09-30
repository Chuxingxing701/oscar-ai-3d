// Real HTTP/process review reproductions. No production data touched.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {spawnRuntime,currentExperimentId,opFetch,waitUntil} from '../../services/runtime/test/helpers.ts';
import {DeviceClient} from '../../packages/device-contract/src/client.ts';
const results={};
const add={capability:'media.add',arguments:{plate_id:'plate-01',row_id:'A',reservoir_id:'media-01',volume_ul_per_well:100}};
const truth=async(h,e)=>JSON.parse((await opFetch(h,'GET',`/api/v1/experiments/${e}/debug/truth`)).text);
async function loaded(h,e){for(let i=0;i<60;i++){await h.client.control(e,{step:{steps:1}});if((await truth(h,e)).head.load_ul.some(v=>v>0))return;}throw Error('never loaded');}
{
 const h=await spawnRuntime();try{
 const e=await currentExperimentId(h);
 await h.client.submit(e,{capability:'environment.set_targets',arguments:{chamber_id:'chamber-01',temperature_c:40}});
 const wait=await h.client.submit(e,{capability:'environment.await_stable',arguments:{chamber_id:'chamber-01',timeout_sim_s:600}});
 const a=await h.client.submit(e,add);await loaded(h,e);
 const before=(await truth(h,e)).head;
 const cancelled=await h.client.cancel(e,wait.action.action_id);
 const after=(await truth(h,e)).head;
 await h.client.control(e,{step:{until_idle:true}});
 const end=await h.client.action(e,a.action.action_id);
 const final=(await truth(h,e)).head;
 assert.equal(cancelled.summary.waste_delta_ul,600);
 results.cancel_unrelated={before,after,final,wait_waste:cancelled.summary.waste_delta_ul,add_status:end.status,add_summary:end.summary};
 }finally{await h.stop();}
}
{
 const h=await spawnRuntime();try{
 const e=await currentExperimentId(h);const a=await h.client.submit(e,add);await loaded(h,e);
 await h.client.control(e,{reset:{}});
 const old=await h.client.state(e), action=await h.client.action(e,a.action.action_id), head=(await truth(h,e)).head;
 assert.equal(action.summary.waste_delta_ul,600);assert.equal(old.wastes[0].used_ul,0);
 results.reset_archive={status:old.experiment.status,action_status:action.status,claimed_waste:action.summary.waste_delta_ul,stored_waste:old.wastes[0].used_ul,head};
 }finally{await h.stop();}
}
{
 const h=await spawnRuntime();let child;try{
 const e=await currentExperimentId(h);const a=await h.client.submit(e,{capability:'plate.shake',arguments:{plate_id:'plate-01',speed_rpm:300,duration_sim_s:60}});
 await h.client.control(e,{step:{steps:10}});assert.equal((await h.client.state(e)).plates[0].shake.active,true);
 const exit=new Promise(r=>h.child.once('exit',r));h.child.kill('SIGKILL');await exit;
 child=spawn(process.execPath,['services/runtime/src/main.ts','--port','0','--data-dir',h.dataDir],{stdio:['ignore','pipe','pipe']});
 let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',()=>{});
 await waitUntil(async()=>out.includes('OSCAR_RUNTIME_READY'));
 const ready=JSON.parse(out.split('\n').find(l=>l.startsWith('OSCAR_RUNTIME_READY')).slice('OSCAR_RUNTIME_READY '.length));
 const c=new DeviceClient({baseUrl:`http://127.0.0.1:${ready.port}`,token:h.operatorToken});
 await c.control(e,{resume:true});let error;try{await c.submit(e,add);}catch(err){error={code:err.code,message:err.message};}
 const snap=await c.state(e), action=await c.action(e,a.action.action_id);
 assert.equal(error?.code,'resource_busy');assert.equal(snap.active_actions.length,0);
 results.restart_shake={action_status:action.status,action_error:action.error,active_actions:snap.active_actions.length,shake:snap.plates[0].shake,add_error:error};
 }finally{if(child){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;}await h.stop();}
}
writeFileSync(new URL('./reproductions.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
