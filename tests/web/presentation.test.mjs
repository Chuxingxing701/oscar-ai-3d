import test from 'node:test';
import assert from 'node:assert/strict';
import {PresentationClock} from '../../web/scene/presentation.js';
import {sampleShake} from '../../web/scene/state.js';
const state = t => ({experiment_id:'e',sim_time_s:t,paused:false,actions:[]});
test('scan start and successful park completion retain the final confirmed motion interval',()=>{
 const c=new PresentationClock(),options={interpolate:true,speed:1};
 const stage=(start,target,from)=>({action_id:'scan',stage:'moving',tool:'camera',target,from_target:from,
  stage_started_at_sim_s:start,stage_duration_sim_s:3});
 const well={plate_id:'plate-02',well_id:'D6'};
 c.update(state(0),0,options);
 const start={...state(1),actions:[stage(0,well,null)]};
 c.update(start,1000,options);
 assert.equal(c.frame(start,1000).sim_time_s,0,'first action must not skip its first second');
 assert.equal(c.frame(start,1500).sim_time_s,.5);
 const park={...state(10),actions:[stage(8,null,well)]};
 c.update(park,10000,options);
 const complete=state(11);
 c.update(complete,11000,options);
 const halfway=c.frame(complete,11500);
 assert.equal(halfway.sim_time_s,10.5);
 assert.equal(halfway.actions[0].stage,'moving','finish the confirmed park interval after head is released');
 assert.deepEqual(c.frame(complete,12000).actions,[]);
 c.update(state(20),20000,options);
 const next={...state(21),actions:[{...stage(20,well,null),action_id:'scan-2'}]};
 c.update(next,21000,options);
 assert.equal(c.frame(next,21500).sim_time_s,20.5,'a new scan after idle also retains its approach');
});
test('integer server ticks yield moving shake frames, bounded by the last confirmed time',()=>{
 const c=new PresentationClock(), options={interpolate:true,speed:1};
 c.update(state(1),0,options);c.update(state(2),1000,options);
 const points=new Set();
 for(let ms=1000;ms<2000;ms+=16){
   const t=c.sample(ms);assert.ok(t>=1&&t<=2);
   points.add(JSON.stringify(sampleShake({active:true,started_at_sim_s:0,duration_sim_s:30,frequency_hz:4},t)));
 }
 assert.ok(points.size>30);
 const t=c.sample(1500);c.update(state(2),1500,options);assert.equal(c.sample(1500),t);
 assert.equal(c.sample(100000),2,'disconnect/idle cannot advance beyond authority');
});
test('pause, replay, reset and backward seek snap exactly; speed changes pacing only',()=>{
 const c=new PresentationClock(), options={interpolate:true,speed:4};
 c.update(state(1),0,options);c.update(state(2),1000,options);
 assert.equal(c.sample(1125),1.5);
 c.update({...state(2),paused:true},1125,options);assert.equal(c.sample(1125),2);
 c.update(state(8),1200);assert.equal(c.sample(1200),8);
 c.update(state(3),1300,options);assert.equal(c.sample(1300),3);
 c.update({...state(0),experiment_id:'new'},1400,options);assert.equal(c.sample(1400),0);
});
test('slow motion interpolates across the full confirmed step instead of stopping after one wall second',()=>{
 const c=new PresentationClock(), options={interpolate:true,speed:.1};
 c.update(state(1),0,options);c.update(state(2),10000,options);
 assert.equal(c.sample(15000),1.5);assert.equal(c.sample(20000),2);
 assert.equal(c.sample(100000),2);
});

test('one-second lower/raise stages survive a transition to the next authoritative stage',async()=>{
 const {readFileSync}=await import('node:fs');
 const {sampleMotion}=await import('../../web/scene/state.js');
 const map=JSON.parse(readFileSync(new URL('../../web/scene/scene-map.json',import.meta.url)));
 const c=new PresentationClock(),options={interpolate:true,speed:1};
 const target={plate_id:'plate-01',row_id:'A'};
 const stage=(name,start,duration,extra={})=>({action_id:'add-1',stage:name,target,
   stage_started_at_sim_s:start,stage_duration_sim_s:duration,...extra});
 const lower={...state(10),actions:[stage('lowering',10,1)]};
 c.update(lower,0,options);
 const aspirate={...state(11),actions:[stage('aspirating',11,3)]};
 c.update(aspirate,1000,options);
 let frame=c.frame(aspirate,1500);
 assert.equal(frame.actions[0].stage,'lowering');
 assert.equal(frame.sim_time_s,10.5);
 assert.equal(sampleMotion(map,frame.actions[0],frame.sim_time_s).pose[1],-.06);
 c.update(aspirate,1500,options);
 assert.equal(c.frame(aspirate,1600).actions[0].stage,'lowering','duplicate frames preserve transition');
 assert.equal(c.frame(aspirate,2000).actions[0].stage,'aspirating');
 c.update({...aspirate,sim_time_s:14,actions:[stage('raising',14,1)]},4000,options);
 const move={...state(15),actions:[stage('moving',15,3,{from_target:target,target:{resource_id:'waste-01'}})]};
 c.update(move,5000,options);
 frame=c.frame(move,5500);
 assert.equal(frame.actions[0].stage,'raising');
 const halfway=sampleMotion(map,frame.actions[0],frame.sim_time_s).pose;
 assert.equal(halfway[1],-.06);
 assert.equal(halfway[0],map.stations.find(s=>s.id==='plate-01').center_m[0],'no lateral motion before raised');
 assert.equal(c.frame(move,6000).actions[0].stage,'moving');
 // Cancellation, pause, a different action and replay must never drain stale stages.
 c.update({...move,actions:[]},5550,options);assert.deepEqual(c.frame({...move,actions:[]},5600).actions,[]);
 c.update(lower,6000,options);c.update({...aspirate,paused:true},6100,options);
 assert.equal(c.frame(aspirate,6100).actions[0].stage,'aspirating');
 c.update({...move,actions:[stage('moving',15,3,{action_id:'other'})]},6200,options);
 assert.equal(c.frame(move,6200).actions[0].action_id,'other');
});

test('tip pick/drop approach and retract without a vertical jump at either boundary',async()=>{
 const {readFileSync}=await import('node:fs');
 const {sampleMotion}=await import('../../web/scene/state.js');
 const map=JSON.parse(readFileSync(new URL('../../web/scene/scene-map.json',import.meta.url)));
 for(const stage of ['picking_tip','dropping_tip']){
  const a={stage,target:{resource_id:'tips-01'},stage_started_at_sim_s:0,stage_duration_sim_s:2};
  const y=t=>sampleMotion(map,a,t).pose[1];
  assert.equal(y(0),0);assert.equal(y(.5),-.06);assert.equal(y(1),-.12);assert.equal(y(1.5),-.06);assert.equal(y(2),0);
 }
});
