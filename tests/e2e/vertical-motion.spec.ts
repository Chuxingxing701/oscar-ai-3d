import {test,expect} from '@playwright/test';
import {operatorClient,pairAndOpen,sceneUpdateErrors} from './helpers.ts';

test('one-second lower and raise interpolate across Runtime stage boundaries',async({page})=>{
  const c=operatorClient();
  await c.control(await c.currentExperimentId(),{reset:{scenario_id:'routine_maintenance',clock_mode:'lockstep'}});
  const exp=await c.currentExperimentId();
  try {
    await c.control(exp,{speed:1});
    await pairAndOpen(page);
    await page.waitForFunction(()=>Boolean((window as any).oscarScene?.getStatus().ready));
    const result=await c.submit(exp,{capability:'media.add',arguments:{plate_id:'plate-01',row_id:'A',reservoir_id:'media-01',volume_ul_per_well:50}});
    const stages=result.action.stages;
    const strokeStarts=['lowering','raising'].map(stage=>{
      const i=stages.findIndex(s=>s.stage===stage);
      return {stage,start:stages.slice(0,i).reduce((t,s)=>t+s.duration_sim_s,0)};
    });
    for(const {stage,start} of strokeStarts){
      await c.control(exp,{step:{until_sim_s:start}});
      await expect.poll(()=>page.evaluate(()=>(window as any).oscarScene.getStatus().simTime)).toBe(start);
      await expect.poll(()=>page.evaluate(()=>(window as any).oscarScene.getStatus().renderedSimTime)).toBe(start);
      const initial=await page.evaluate(()=>(window as any).oscarScene.getStatus().motion);
      expect(initial[2][1]).toBeCloseTo(stage==='lowering'?0:-.12,6);
      // The very next authoritative tick already belongs to the next stage.
      await c.control(exp,{step:{steps:1}});
      const frames=await page.evaluate(async()=>{
        const frames:any[]=[];const end=performance.now()+1500;
        while(performance.now()<end){
          await new Promise<void>(r=>requestAnimationFrame(()=>r()));
          const s=(window as any).oscarScene.getStatus();
          frames.push({time:s.renderedSimTime,authority:s.simTime,motion:s.motion});
        }
        return frames;
      });
      const middle=frames.filter(f=>f.motion[2][1]<-.001&&f.motion[2][1]>-.119);
      expect(middle.length,`${stage} must have visible intermediate Z positions`).toBeGreaterThan(0);
      for(const f of middle){
        expect(f.motion[0][0]).toBeCloseTo(initial[0][0],6);
        expect(f.motion[1][2]).toBeCloseTo(initial[1][2],6);
      }
      expect(frames.every(f=>f.time<=f.authority)).toBe(true);
      await expect.poll(()=>page.evaluate(()=>(window as any).oscarScene.getStatus().motion[2][1]))
        .toBeCloseTo(stage==='lowering'?-.12:0,6);
    }
    expect(await sceneUpdateErrors(page)).toEqual([]);
  } finally {
    await c.control(exp,{reset:{clock_mode:'lockstep'}});
  }
});
