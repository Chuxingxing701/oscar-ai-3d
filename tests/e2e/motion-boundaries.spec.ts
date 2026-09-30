import {test, expect} from '@playwright/test';
import {operatorClient, pairAndOpen, sceneUpdateErrors} from './helpers.ts';

test('real scans travel from home and finish parking without boundary teleports', async ({page}) => {
  const c = operatorClient();
  await c.control(await c.currentExperimentId(), {reset: {scenario_id: 'routine_maintenance', seed: 42, clock_mode: 'realtime'}});
  const exp = await c.currentExperimentId();
  await c.control(exp, {speed: 1});
  await pairAndOpen(page);
  await page.waitForFunction(() => (window as any).oscarScene?.getStatus().ready);
  await page.waitForFunction(() => !(window as any).oscarScene.getStatus().transitioning);
  for (const [plate_id, well_id] of [['plate-02', 'D6'], ['plate-01', 'A1']]) {
    await page.evaluate(() => {
      (window as any).motionFrames = [];
      (window as any).recordMotion = true;
      const sample = (now: number) => {
        const s = (window as any).oscarScene.getStatus();
        (window as any).motionFrames.push({now, pose: [s.motion[0][0], s.motion[2][1], s.motion[1][2]]});
        if ((window as any).recordMotion) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const accepted = await c.submit(exp, {capability: 'imaging.scan', arguments: {plate_id, wells: [well_id], mode: 'mono'}});
    await expect.poll(async () => (await c.actions(exp)).actions.find(a => a.action_id === accepted.action.action_id)?.status,
      {timeout: 30_000}).toBe('succeeded');
    await page.waitForTimeout(1500); // drain the final confirmed park interval
    const frames = await page.evaluate(() => {
      (window as any).recordMotion = false;
      return (window as any).motionFrames as {now: number; pose: number[]}[];
    });
    let maxStep = 0;
    for (let i = 1; i < frames.length; i++) {
      const distance = Math.hypot(...frames[i].pose.map((v, j) => v - frames[i - 1].pose[j]));
      maxStep = Math.max(maxStep, distance);
      // Account for slow CI frames, while rejecting a discontinuity at a
      // normal frame boundary (3 s travel has a peak speed below 1 m/s).
      expect(distance).toBeLessThanOrEqual((frames[i].now - frames[i - 1].now) / 1000 + .03);
    }
    const distances = frames.map(f => Math.hypot(...f.pose.map((v, j) => v - frames[0].pose[j])));
    const peak = Math.max(...distances);
    const firstAtTarget = distances.findIndex(d => d >= peak * .99);
    const lastAtTarget = distances.findLastIndex(d => d >= peak * .99);
    const intermediate = (d: number) => d > peak * .1 && d < peak * .9;
    // Check both actual travel legs rather than a hardware-dependent frame
    // count. A snap at either boundary has no intermediate poses on that leg.
    expect(peak).toBeGreaterThan(.2);
    expect(distances.slice(0, firstAtTarget).filter(intermediate).length).toBeGreaterThan(1);
    expect(distances.slice(lastAtTarget + 1).filter(intermediate).length).toBeGreaterThan(1);
    expect(frames.at(-1)!.pose).toEqual(frames[0].pose);
    await test.info().attach(`${plate_id}-${well_id}-motion`, {body: JSON.stringify({frames: frames.length, maxStep}), contentType: 'application/json'});
  }
  expect(await sceneUpdateErrors(page)).toEqual([]);
});
