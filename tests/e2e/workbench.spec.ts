// Operator console acceptance against the real Runtime (no Agent needed for
// these flows): pairing, row-scoped manual operations driven by authoritative
// state, 3D projection, refresh recovery, browser close, read-only replay.
import {test, expect} from '@playwright/test';
import {acceptedThenStep, hasSessionCookie, operatorClient, pairAndOpen, stack, stepIdle, trackErrors, wellVolume} from './helpers.ts';

test.describe.configure({mode: 'serial'});

test('pairing issues an HttpOnly cookie; pages and scripts carry no token', async ({page, context, request}) => {
  const info = stack();
  const errors = trackErrors(page);
  await pairAndOpen(page, info);
  expect(await hasSessionCookie(context)).toBe(true);
  expect(page.url()).not.toContain('code=');
  const token = (await import('node:fs')).readFileSync(`${info.dataDir}/runtime/operator.token`, 'utf8').trim();
  for (const path of ['/web/workbench.html', '/web/workbench.js', '/web/api/http.js', '/pair', '/login']) {
    const body = await (await request.get(`${info.baseUrl}${path}`)).text();
    expect(body).not.toContain(token);
  }
  expect(await page.evaluate(() => JSON.stringify(localStorage) + document.cookie)).not.toContain('oscar_session');
  expect(errors).toEqual([]);
});

test('manual scan → row add shows explicit A1–A6 scope and updates only row A from Runtime state', async ({page}) => {
  const errors = trackErrors(page);
  const client = operatorClient();
  const exp = await client.currentExperimentId();
  await pairAndOpen(page);
  await expect(page.locator('#form-add .scope')).toContainText('A1–A6');

  // scan A1 (single well scan is allowed)
  await page.locator('#tab-ops').click();
  await page.locator('#form-scan input[type=checkbox]').first().check();
  const n0 = (await client.actions(exp)).actions.length;
  await page.locator('#form-scan button[type=submit]').click();
  await acceptedThenStep(page, client, exp, n0 + 1);
  await expect.poll(async () => (await client.observations(exp)).length, {timeout: 20_000}).toBeGreaterThan(0);
  await page.locator('#tab-camera').click();
  await expect(page.locator('.obs-item').first()).toBeVisible();

  const before = await client.state(exp);
  const a = (s: typeof before) => s.plates[0].wells.filter(w => w.well_id.startsWith('A')).map(w => w.volume_ul);
  const b1 = (s: typeof before) => s.plates[0].wells.find(w => w.well_id === 'B1')!.volume_ul;
  await page.locator('#tab-ops').click();
  await page.locator('#form-add #add-volume').fill('200');
  await page.locator('#form-add button[type=submit]').click();
  await acceptedThenStep(page, client, exp, n0 + 2);
  await expect.poll(async () => {
    const s = await client.state(exp);
    return s.active_actions.length === 0 && a(s).every((v, i) => Math.abs(v - a(before)[i] - 200) < 1);
  }, {timeout: 30_000}).toBe(true);
  const after = await client.state(exp);
  expect(Math.abs(b1(after) - b1(before))).toBeLessThan(1);
  expect(before.reservoirs[0].remaining_ul - after.reservoirs[0].remaining_ul).toBeCloseTo(1200, 0);
  expect(before.tips.reduce((n, t) => n + t.remaining, 0) - after.tips.reduce((n, t) => n + t.remaining, 0)).toBe(6);
  // UI reflects the authoritative volumes
  await expect.poll(async () => Math.round(await wellVolume(page, 'plate-01', 'A3')), {timeout: 15_000})
    .toBe(Math.round(after.plates[0].wells.find(w => w.well_id === 'A3')!.volume_ul));
  // the add action carries per-well effects in the action list
  const actions = (await client.actions(exp)).actions;
  const add = actions.find(x => x.capability === 'media.add')!;
  expect(add.status).toBe('succeeded');
  expect(Object.keys(add.summary.wells).sort()).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
  expect(errors).toEqual([]);
});

test('3D scene mirrors the running row stage and refresh resumes the active stage', async ({page}) => {
  const client = operatorClient();
  const exp = await client.currentExperimentId();
  await pairAndOpen(page);
  // Submit via API, advance a few steps so the head sits mid-action, then check the scene projection.
  const r = await client.submit(exp, {capability: 'media.add', arguments: {plate_id: 'plate-01', row_id: 'B',
    reservoir_id: 'media-01', volume_ul_per_well: 50}});
  await client.control(exp, {step: {steps: 12}});
  const snap = await client.state(exp);
  expect(snap.head?.action_id).toBe(r.action.action_id);
  const sceneStatus = async () => page.evaluate(() => (window as unknown as {oscarScene?: {getStatus(): Record<string, unknown>}})
    .oscarScene?.getStatus());
  await expect.poll(async () => (await sceneStatus())?.simTime, {timeout: 20_000}).toBe(snap.experiment.sim_time_s);
  const st = await sceneStatus();
  expect(st?.animationMode).toBe('controlled');
  await page.reload();
  await expect(page.locator('#conn-text')).toContainText('已连接', {timeout: 30_000});
  await expect.poll(async () => (await sceneStatus())?.simTime, {timeout: 20_000}).toBe(snap.experiment.sim_time_s);
  // action bar shows the stage of the running action after reload
  await expect(page.locator('#action-bar')).toContainText(r.action.action_id, {timeout: 15_000});
  await client.control(exp, {step: {until_idle: true}});
  await expect(page.locator('#action-bar')).not.toContainText('运行中', {timeout: 20_000});
});

test('closing the browser does not stop the Runtime; replay of an archived experiment never writes', async ({browser}) => {
  const client = operatorClient();
  const exp = await client.currentExperimentId();
  const ctx1 = await browser.newContext();
  const p1 = await ctx1.newPage();
  await pairAndOpen(p1);
  await client.control(exp, {clock_mode: 'realtime'});
  await client.control(exp, {speed: 50});
  const t0 = (await client.state(exp)).experiment.sim_time_s;
  await ctx1.close(); // browser gone
  await new Promise(r => setTimeout(r, 1500));
  const t1 = (await client.state(exp)).experiment.sim_time_s;
  expect(t1).toBeGreaterThan(t0);
  await client.control(exp, {clock_mode: 'lockstep'});

  // reset → old experiment archived
  const reset = await client.control(exp, {reset: {}}) as {archived: string; experiment: {experiment_id: string}};
  expect(reset.archived).toBe(exp);
  const ctx2 = await browser.newContext();
  const page = await ctx2.newPage();
  const writes: string[] = [];
  page.on('request', req => { if (req.method() !== 'GET' && req.method() !== 'HEAD' && req.url().includes('/api/')) writes.push(`${req.method()} ${req.url()}`); });
  await pairAndOpen(page);
  writes.length = 0; // ignore the pairing POST
  await page.locator('#history-select').selectOption(exp);
  await page.locator('#history-enter').click();
  await expect(page.locator('#replay-banner')).toBeVisible();
  await expect(page.locator('#form-add button[type=submit]')).toBeDisabled();
  await expect(page.locator('#btn-reset')).toBeDisabled();
  const oldSeq = (await client.state(exp)).event_seq;
  await page.locator('#replay-seq').fill('5');
  await page.locator('#replay-seq').fill(String(oldSeq));
  await page.waitForTimeout(800);
  expect(writes).toEqual([]);
  // the archived world did not change
  expect((await client.state(exp)).event_seq).toBe(oldSeq);
  await page.locator('#exit-replay').click();
  await expect(page.locator('#exp-id')).toContainText(reset.experiment.experiment_id, {timeout: 20_000});
  await ctx2.close();
});
