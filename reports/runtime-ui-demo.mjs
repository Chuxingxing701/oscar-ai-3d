// Record a real Runtime/API demonstration in a disposable isolated workspace.
// Run from repository root: node reports/runtime-ui-demo.mjs
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {spawnRuntime, currentExperimentId, waitUntil} from '../services/runtime/test/helpers.ts';

const out = resolve('reports/runtime-ui-demo');
mkdirSync(out, {recursive: true});
const h = await spawnRuntime({scenario: 'exchange_and_mix', seed: 42});
let browser, context, video;
try {
  const exp = await currentExperimentId(h);
  const before = await h.client.state(exp);
  const pair = (await h.client.request('POST', '/api/v1/pairing-codes', {})).body;
  browser = await chromium.launch({channel: 'chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  context = await browser.newContext({viewport: {width: 1600, height: 1000},
    recordVideo: {dir: out, size: {width: 1600, height: 1000}}});
  const page = await context.newPage();
  video = page.video();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.goto(pair.url);
  await page.waitForURL('**/web/workbench.html');
  await page.waitForFunction(() => window.oscarScene?.getStatus().ready);
  await page.locator('#scene-stage canvas').evaluate(canvas => canvas.addEventListener('webglcontextlost', () => {
    window.demoContextLost = true;
  }));
  await page.locator('#view-deck').click();
  await page.waitForFunction(() => !window.oscarScene.getStatus().transitioning);
  const rect = await page.locator('#scene-stage').boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(600);
  await h.client.control(exp, {speed: 2});
  await h.client.control(exp, {clock_mode: 'realtime'});
  const captures = [];
  const requests = [
    {capability: 'imaging.scan', arguments: {plate_id: 'plate-02', wells: ['D6'], mode: 'mono'}},
    {capability: 'media.exchange', arguments: {plate_id: 'plate-01', row_id: 'B', reservoir_id: 'media-01', fraction: 0.5}},
    {capability: 'plate.shake', arguments: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 20}},
    {capability: 'imaging.scan', arguments: {plate_id: 'plate-01', wells: ['B1'], mode: 'mono'}},
  ];
  for (const request of requests) {
    if (request.capability === 'imaging.scan') {
      await page.getByLabel('扫描板', {exact: true}).selectOption(request.arguments.plate_id);
      await page.locator('.scan-wells label').filter({hasText: new RegExp(`^${request.arguments.wells[0]}$`)}).locator('input').check();
    } else if (request.capability === 'media.exchange') {
      await page.locator('#form-exchange').getByLabel('排', {exact: true}).selectOption(request.arguments.row_id);
    }
    const {action} = await h.client.submit(exp, request);
    let captured = false;
    await waitUntil(async () => {
      const state = await h.client.state(exp);
      const active = state.active_actions.find(a => a.action_id === action.action_id);
      const stage = active?.stages[active.current_stage_index]?.stage;
      const capture = request.capability === 'imaging.scan' ? stage === 'scanning'
        : request.capability === 'media.exchange' ? stage === 'dispensing' && state.head?.stage.target?.plate_id === 'plate-01'
        : stage === 'shaking';
      if (capture && !captured) {
        captured = true;
        await h.client.control(exp, {pause: true});
        await page.waitForFunction(({capability, plate}) => {
          const scene = window.oscarScene.getStatus();
          return scene.paused && (capability === 'plate.shake' ||
            scene.headTarget?.plate_id === plate && scene.effects[capability === 'imaging.scan' ? 'scan' : 'flow']);
        }, {capability: request.capability, plate: request.arguments.plate_id}, {timeout: 20_000});
        const file = `${request.capability.replace('.', '-')}-${request.arguments.plate_id}.png`;
        await page.screenshot({path: resolve(out, file)});
        captures.push({file, action_id: action.action_id, capability: request.capability,
          scene: await page.evaluate(() => window.oscarScene.getStatus())});
        await h.client.control(exp, {resume: true});
      }
      const current = await h.client.action(exp, action.action_id);
      if (['failed', 'cancelled'].includes(current.status)) throw new Error(`${action.action_id}: ${current.status}`);
      return current.status === 'succeeded';
    }, 60_000, 100);
    assert.ok(captured, `missing visual stage for ${request.capability}`);
  }
  await h.client.control(exp, {pause: true});
  const frame = await page.evaluate(() => window.oscarScene.getStatus().frameCount);
  await page.locator('#timeline-filter').selectOption('environment');
  await page.locator('#tab-ops-panel').evaluate(panel => {panel.scrollLeft = 0;});
  await page.waitForFunction(frame => window.oscarScene.getStatus().frameCount > frame, frame, {timeout: 20_000});
  const timeline = await page.locator('#timeline-list').innerText();
  assert.match(timeline, /温度 \d+\.\d°C · CO₂ \d+\.\d% · 湿度 \d+\.\d%RH/);
  await page.screenshot({path: resolve(out, 'completed.png')});
  const sceneErrors = await page.evaluate(() => window.oscarScene.updateErrors());
  assert.deepEqual(errors, []);
  assert.deepEqual(sceneErrors, []);
  assert.equal(await page.evaluate(() => Boolean(window.demoContextLost)), false);
  const actions = (await h.client.actions(exp)).actions;
  const final = await h.client.state(exp);
  const observations = await h.client.observations(exp);
  const events = (await h.client.events(exp)).events;
  const reconciliation = {
    reservoir_used_ul: before.reservoirs[0].remaining_ul - final.reservoirs[0].remaining_ul,
    waste_added_ul: final.wastes[0].used_ul - before.wastes[0].used_ul,
    tips_used: before.tips.reduce((sum, t) => sum + t.remaining, 0) - final.tips.reduce((sum, t) => sum + t.remaining, 0),
  };
  assert.ok(Math.abs(reconciliation.reservoir_used_ul - reconciliation.waste_added_ul) < 1e-8);
  assert.equal(reconciliation.tips_used, 12);
  assert.ok(reconciliation.reservoir_used_ul > 2390 && reconciliation.reservoir_used_ul <= 2400);
  assert.equal(actions.length, 4);
  assert.ok(actions.every(a => a.status === 'succeeded'));
  assert.equal(observations.length, 2);
  writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({experiment_id: exp, before, final,
    actions, observations, events, captures, timeline, reconciliation, errors, sceneErrors}, null, 2) + '\n');
  await context.close(); context = null;
  await video.saveAs(resolve(out, 'runtime-demo.webm'));
  const original = await video.path();
  if (original !== resolve(out, 'runtime-demo.webm')) {
    const {unlinkSync} = await import('node:fs');
    unlinkSync(original);
  }
  console.log(JSON.stringify({out, actions: actions.map(a => ({capability: a.capability, status: a.status})),
    observations: observations.length, reconciliation, errors, sceneErrors}));
} finally {
  await context?.close();
  await browser?.close();
  await h.stop();
}
