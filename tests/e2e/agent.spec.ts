// Agent loop through the browser: Runtime → SSE → 3D/panels while the real
// scripted Agent process drives the device; Agent stopped → manual ops work.
import {test, expect} from '@playwright/test';
import {sceneUpdateErrors, operatorClient, pairAndOpen, stack, trackErrors} from './helpers.ts';
import {killPid, alive, spawnAgent, writeStackPid} from './stack.ts';

test.describe.configure({mode: 'serial'});

test('scripted run from the Agent tab completes; decision log, evidence and report are shown', async ({page}) => {
  const errors = trackErrors(page);
  const client = operatorClient();
  // Fresh world for this scenario (earlier specs changed volumes).
  const current = await client.currentExperimentId();
  await client.control(current, {reset: {scenario_id: 'routine_maintenance', seed: 42}});
  const exp = await client.currentExperimentId();
  await pairAndOpen(page);
  await expect(page.locator('#exp-id')).toContainText(exp);
  await page.locator('#tab-agent').click();
  await page.locator('#agent-mode').selectOption('scripted');
  await page.locator('button:has-text("启动 Agent run")').click();
  // Run is driven by the Agent process (lockstep barrier), not by the browser.
  await expect.poll(async () => (await client.state(exp)).run?.status ?? 'none', {timeout: 60_000}).toBe('ended');
  const run = (await client.state(exp)).run!;
  expect(run.reason).toBe('completed');
  expect(run.determinism_broken).toBe(false);
  const actions = (await client.actions(exp)).actions;
  expect(actions.map(a => a.capability)).toEqual(['imaging.scan', 'media.add', 'imaging.scan']);
  const add = actions[1];
  expect(add.basis).toBe('scripted');
  expect(add.evidence_refs.length).toBeGreaterThan(0);
  expect(Object.keys(add.summary.wells).sort()).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
  // decision log shows scripted basis and clickable evidence
  await expect(page.locator('.decision-log li').first()).toBeVisible({timeout: 20_000});
  await expect(page.locator('.decision-log .basis.scripted').first()).toBeVisible();
  await expect(page.locator('.decision-log .obsref').first()).toBeVisible();
  await page.locator('.decision-log .obsref').first().click();
  await expect(page.locator('#tab-camera')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#tab-agent').click();
  await expect(page.locator('#tab-agent-panel')).toContainText('报告', {timeout: 20_000});
  // timeline shows device events from the run
  expect(await page.locator('#timeline-list li').count()).toBeGreaterThan(5);
  await page.screenshot({path: 'reports/e2e/agent-run-desktop.png'});
  const report = await (await fetch(`${stack().baseUrl}/api/v1/runs/${run.run_id}/report`, {
    headers: {authorization: `Bearer ${(await import('./stack.ts')).operatorToken(stack())}`}})).json() as {outcome?: string; report?: {outcome?: string}};
  expect(report.outcome ?? report.report?.outcome).toBe('completed');
  expect(errors).toEqual([]);
  expect(await sceneUpdateErrors(page)).toEqual([]);
});

test('with the Agent process stopped the gateway reports unavailable and manual operation still works', async ({page}) => {
  const info = stack();
  const client = operatorClient();
  const exp = await client.currentExperimentId();
  killPid(info.agentPid);
  await expect.poll(() => alive(info.agentPid), {timeout: 10_000}).toBe(false);
  await pairAndOpen(page);
  await page.locator('#tab-agent').click();
  await page.locator('button:has-text("启动 Agent run")').click();
  await expect(page.locator('#tab-agent-panel')).toContainText('Agent 不可用', {timeout: 20_000});
  // manual row add still works
  await page.locator('#tab-ops').click();
  const n0 = (await client.actions(exp)).actions.length;
  const tips0 = (await client.state(exp)).tips.reduce((n, t) => n + t.remaining, 0);
  await page.locator('#form-add #add-volume').fill('20');
  await page.locator('#form-add button[type=submit]').click();
  await expect.poll(async () => (await client.actions(exp)).actions.length, {timeout: 20_000}).toBe(n0 + 1);
  await page.locator('#btn-step-idle').click();
  await expect.poll(async () => (await client.state(exp)).tips.reduce((n, t) => n + t.remaining, 0), {timeout: 30_000}).toBe(tips0 - 6);
  // restart the Agent for later specs
  const agent = spawnAgent(info.dataDir, info.baseUrl, info.agentPort);
  await agent.ready;
  agent.child.stdout!.resume(); agent.child.stderr!.resume(); agent.child.unref();
  writeStackPid('agentPid', agent.child.pid!);
});
