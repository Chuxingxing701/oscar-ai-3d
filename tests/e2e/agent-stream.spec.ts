import {test, expect} from '@playwright/test';
import {operatorClient, pairAndOpen, stack} from './helpers.ts';
import {killPid, alive, spawnAgent, writeStackPid} from './stack.ts';

test('Agent explains realtime restriction, retains stable DOM, and streams past 30 seconds without fake errors', async ({page}) => {
  const c = operatorClient();
  await c.control(await c.currentExperimentId(), {reset: {scenario_id: 'exchange_and_mix', seed: 42, clock_mode: 'realtime'}});
  const exp = await c.currentExperimentId();
  const info = stack();
  const restartAgent = async () => {
    const agent = spawnAgent(info.dataDir, info.baseUrl, info.agentPort);
    await agent.ready;
    agent.child.stdout!.resume(); agent.child.stderr!.resume(); agent.child.unref();
    info.agentPid = agent.child.pid!; writeStackPid('agentPid', info.agentPid);
  };
  try {
    // Existing unsupported runs still have their diagnostic report displayed.
    await c.request('POST', '/api/v1/agent/runs', {experiment_id: exp, mode: 'scripted'});
    await expect.poll(async () => (await c.state(exp)).run?.reason).toBe('aborted');
    await pairAndOpen(page);
    await page.locator('#tab-agent').click();
    await expect(page.getByRole('button', {name: '启动 Agent run'})).toBeDisabled();
    await expect(page.locator('#agent-policy-hint')).toContainText('exchange_and_mix');
    await expect(page.locator('#agent-goal')).toBeDisabled();
    await expect(page.locator('#tab-agent-panel')).toContainText('请先在顶栏切换到 lockstep');
    await expect(page.locator('.decision-log li')).toHaveCount(2);
    await expect(page.locator('.decision-log')).toContainText('clock_mode=realtime');
    await expect(page.locator('#tab-agent-panel')).toContainText('Agent 事件流已连接');
    let streamEnded = 0;
    page.on('requestfinished', r => {if (/\/agent\/runs\/.*\/events/.test(r.url())) streamEnded++;});
    page.on('requestfailed', r => {if (/\/agent\/runs\/.*\/events/.test(r.url())) streamEnded++;});
    await page.evaluate(() => {
      (window as any).agentMutations = 0;
      const observer = new MutationObserver(records => {(window as any).agentMutations += records.length;});
      for (const selector of ['.agent-status', '.decision-log']) observer.observe(document.querySelector(selector)!, {childList: true, subtree: true});
    });
    // The former gateway deadline ended an otherwise healthy SSE at 30 s.
    await page.waitForTimeout(32_000);
    expect(streamEnded).toBe(0);
    await expect(page.locator('.decision-log li.err')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).agentMutations)).toBe(0);
    // Stop the actual upstream process: browser offline emulation can leave
    // existing SSE sockets intact and does not reliably exercise onerror.
    killPid(info.agentPid);
    await expect.poll(() => alive(info.agentPid)).toBe(false);
    await expect(page.locator('#tab-agent-panel')).toContainText('Agent 事件流断开');
    await expect(page.locator('.decision-log li.err')).toHaveCount(0);
    await restartAgent();
    await expect(page.locator('#tab-agent-panel')).toContainText('Agent 事件流已连接');
    await expect(page.locator('.decision-log li')).toHaveCount(2);
    await page.locator('#clock-mode').selectOption('lockstep');
    await expect(page.getByRole('button', {name: '启动 Agent run'})).toBeEnabled();
  } finally {
    if (!alive(info.agentPid)) await restartAgent();
    await c.control(exp, {reset: {clock_mode: 'lockstep'}});
  }
});

test('canvas resize and its redraw occur together before paint', async ({page}) => {
  await pairAndOpen(page);
  await page.waitForFunction(() => (window as any).oscarScene?.getStatus().ready);
  await page.waitForFunction(() => !(window as any).oscarScene.getStatus().transitioning);
  for (const delta of [30, -20, 40]) {
    const result = await page.evaluate(async delta => {
      const stage = document.querySelector('#scene-stage') as HTMLElement;
      const canvas = stage.querySelector('canvas')!;
      const initial = (window as any).oscarScene.getStatus();
      const mutation = new Promise<any>(resolve => {
        const observer = new MutationObserver(() => {
          observer.disconnect(); resolve((window as any).oscarScene.getStatus());
        });
        observer.observe(canvas, {attributes: true, attributeFilter: ['width', 'height']});
      });
      stage.style.width = `${stage.clientWidth - delta}px`;
      return {initial, resized: await mutation};
    }, delta);
    expect(result.resized.resizeCount).toBeGreaterThan(result.initial.resizeCount);
    expect(result.resized.frameCount).toBeGreaterThan(result.initial.frameCount);
  }
});
