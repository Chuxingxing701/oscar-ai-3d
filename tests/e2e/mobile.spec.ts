// Narrow screen (390×844): the primary manual flow is reachable through the pane switcher.
import {test, expect} from '@playwright/test';
import {acceptedThenStep, operatorClient, pairAndOpen, trackErrors} from './helpers.ts';

test('narrow screen: switch panes and run a row add', async ({page}) => {
  const errors = trackErrors(page);
  const client = operatorClient();
  const exp = await client.currentExperimentId();
  await pairAndOpen(page);
  const tabs = page.locator('#mobile-tabs');
  await expect(tabs).toBeVisible();
  for (const pane of ['resources', 'camera', 'env', 'agent', 'timeline', 'scene']) {
    await tabs.locator(`[data-pane="${pane}"]`).click();
  }
  await tabs.locator('[data-pane="ops"]').click();
  await expect(page.locator('#form-add')).toBeVisible();
  const scope = page.locator('#form-add .scope');
  await expect(scope).toContainText('1–');
  await expect(scope).toContainText('6');
  const before = await client.state(exp);
  await page.locator('#form-add #add-volume').fill('30');
  const n0 = (await client.actions(exp)).actions.length;
  await page.locator('#form-add button[type=submit]').click();
  await acceptedThenStep(page, client, exp, n0 + 1);
  await expect.poll(async () => {
    const s = await client.state(exp);
    return s.active_actions.length === 0 && s.tips.reduce((n, t) => n + t.remaining, 0)
      === before.tips.reduce((n, t) => n + t.remaining, 0) - 6;
  }, {timeout: 30_000}).toBe(true);
  // no horizontal overflow on the main layout
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({path: 'reports/e2e/mobile.png'});
  expect(errors).toEqual([]);
});
