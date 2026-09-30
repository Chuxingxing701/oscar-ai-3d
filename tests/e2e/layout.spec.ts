import {test, expect} from '@playwright/test';
import {operatorClient, pairAndOpen, sceneUpdateErrors} from './helpers.ts';

test('scripted scan, exchange and shake keep the scene viewport stable as logs grow', async ({page}) => {
  const c = operatorClient();
  await c.control(await c.currentExperimentId(), {reset: {scenario_id: 'exchange_and_mix', seed: 42, clock_mode: 'lockstep'}});
  const exp = await c.currentExperimentId();
  await c.control(exp, {speed: 40});
  await pairAndOpen(page);
  await page.locator('#tab-agent').click();
  await page.waitForFunction(() => (window as any).oscarScene?.getStatus().ready);
  await page.waitForFunction(() => !(window as any).oscarScene.getStatus().transitioning);
  await page.evaluate(() => {
    const samples: number[][] = [];
    (window as any).layoutSamples = samples;
    (window as any).sampleLayout = true;
    const sample = () => {
      const stage = document.querySelector('#scene-stage')!.getBoundingClientRect();
      const timeline = document.querySelector('#pane-timeline')!.getBoundingClientRect();
      samples.push([stage.width, stage.height, timeline.height]);
      if ((window as any).sampleLayout) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', {name: '启动 Agent run'}).click();
  await expect.poll(async () => (await c.state(exp)).run?.reason, {timeout: 90_000}).toBe('completed');
  await expect(page.locator('#timeline-list li')).not.toHaveCount(1);
  await page.waitForTimeout(500);
  const samples = await page.evaluate(() => {
    (window as any).sampleLayout = false;
    return (window as any).layoutSamples as number[][];
  });
  const ranges = [0, 1, 2].map(i => {
    const values = samples.map(s => s[i]);
    return {min: Math.min(...values), max: Math.max(...values)};
  });
  await test.info().attach('layout-ranges', {body: JSON.stringify(ranges), contentType: 'application/json'});
  expect(samples.length).toBeGreaterThan(20);
  for (const range of ranges) expect(range.max - range.min).toBeLessThanOrEqual(1);
  expect((await c.actions(exp)).actions.map(a => a.capability)).toEqual([
    'imaging.scan', 'media.exchange', 'plate.shake', 'imaging.scan',
  ]);
  expect(await sceneUpdateErrors(page)).toEqual([]);
});

test('desktop resizing still fits the canvas; tabs and timeline filtering do not resize the scene', async ({page}) => {
  await pairAndOpen(page);
  await page.waitForFunction(() => (window as any).oscarScene?.getStatus().ready);
  const bounds = () => page.evaluate(() => {
    const stage = document.querySelector('#scene-stage')!.getBoundingClientRect();
    const canvas = document.querySelector('#scene-stage canvas')!.getBoundingClientRect();
    return {width: stage.width, height: stage.height, canvasWidth: canvas.width, canvasHeight: canvas.height};
  });
  for (const size of [{width: 1100, height: 700}, {width: 1440, height: 900}]) {
    await page.setViewportSize(size);
    await expect.poll(async () => (await bounds()).width).toBe(size.width - (size.width < 1200 ? 260 + 330 : 300 + 380) - 42);
    const initial = await bounds();
    expect(initial.height).toBeGreaterThan(200);
    expect(initial.canvasWidth).toBe(initial.width);
    expect(initial.canvasHeight).toBe(initial.height);
    for (const tab of ['agent', 'env', 'camera', 'ops']) {
      await page.locator(`#tab-${tab}`).click();
      await page.locator('#timeline-filter').selectOption(tab === 'agent' ? 'all' : 'observation');
      expect(await bounds()).toEqual(initial);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
});
