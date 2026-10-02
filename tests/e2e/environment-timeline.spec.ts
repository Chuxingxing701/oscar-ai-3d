import {test, expect} from '@playwright/test';
import {operatorClient, pairAndOpen, trackErrors} from './helpers.ts';

test('environment timeline shows actual sampled channels live and after reload', async ({page}) => {
  const c = operatorClient();
  await c.control(await c.currentExperimentId(), {reset: {scenario_id: 'routine_maintenance', seed: 42, clock_mode: 'lockstep'}});
  const exp = await c.currentExperimentId();
  const errors = trackErrors(page);
  await pairAndOpen(page);
  await page.locator('#timeline-filter').selectOption('environment');
  await c.control(exp, {step: {until_sim_s: 30}});
  const {events} = await c.events(exp);
  const event = events.find(e => e.type === 'environment.sampled')!;
  expect(event).toBeDefined();
  const sample = event.payload.sample as {temperature_c: number; co2_pct: number; humidity_pct: number};
  for (const v of [sample.temperature_c, sample.co2_pct, sample.humidity_pct]) expect(Number.isFinite(v)).toBe(true);
  const expected = `温度 ${sample.temperature_c.toFixed(1)}°C · CO₂ ${sample.co2_pct.toFixed(1)}% · 湿度 ${sample.humidity_pct.toFixed(1)}%RH`;
  const row = page.locator('#timeline-list li').filter({has: page.locator('.seq', {hasText: new RegExp(`^#${event.seq}$`)})});
  await expect(row.locator('.detail')).toHaveText(expected);
  // Later chamber readings must not replace the sample captured in this event.
  await c.control(exp, {step: {until_sim_s: 120}});
  await expect(row.locator('.detail')).toHaveText(expected);
  await page.reload();
  await expect(page.locator('#conn-text')).toContainText('已连接');
  await page.locator('#timeline-filter').selectOption('environment');
  await expect(row.locator('.detail')).toHaveText(expected);
  expect(errors).toEqual([]);
});
