import {test, expect} from '@playwright/test';
import {operatorClient, pairAndOpen} from './helpers.ts';

test('plate rows keep six wells together and reservoir options follow committed inventory', async ({page}) => {
  const c = operatorClient();
  await c.control(await c.currentExperimentId(), {reset: {scenario_id: 'routine_maintenance', seed: 42, clock_mode: 'lockstep'}});
  const exp = await c.currentExperimentId();
  await pairAndOpen(page);
  const rowY: number[] = [];
  for (const row of 'ABCD') {
    const bounds = await page.locator(`.well[aria-label^="plate-01 ${row}"]`).evaluateAll(elements =>
      elements.map(el => {const r = el.getBoundingClientRect(); return {x: r.x, y: r.y};}));
    expect(bounds).toHaveLength(6);
    expect(new Set(bounds.map(b => b.y)).size).toBe(1);
    expect(new Set(bounds.map(b => b.x)).size).toBe(6);
    rowY.push(bounds[0].y);
  }
  expect(new Set(rowY).size).toBe(4);
  const reservoir = page.locator('#form-add').getByLabel('储液', {exact: true});
  const selected = await reservoir.inputValue();
  await c.submit(exp, {capability: 'media.add', arguments: {
    plate_id: 'plate-01', row_id: 'B', reservoir_id: selected, volume_ul_per_well: 50,
  }});
  await c.control(exp, {step: {until_idle: true}});
  const current = (await c.state(exp)).reservoirs.find(r => r.id === selected)!;
  await expect(reservoir).toHaveValue(selected);
  await expect(reservoir.locator('option:checked')).toContainText(`余 ${Math.round(current.remaining_ul)} µL`);
  await c.submit(exp, {capability: 'media.exchange', arguments: {
    plate_id: 'plate-01', row_id: 'B', reservoir_id: selected, fraction: 0.5,
  }});
  await c.control(exp, {step: {until_idle: true}});
  const final = await c.state(exp);
  await expect(reservoir.locator('option:checked')).toContainText(`余 ${Math.round(final.reservoirs[0].remaining_ul)} µL`);
  await expect(page.locator('#inventory-card')).toContainText(`${Math.round(final.wastes[0].used_ul)} µL / 100000 µL`);
  await expect(page.locator('#inventory-card')).toContainText(`${final.tips[0].remaining} / 96`);
});
