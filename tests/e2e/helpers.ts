import {expect, type Page, type BrowserContext} from '@playwright/test';
import {DeviceClient} from '@oscar/device-contract';
import {pairingUrl, readStack, operatorToken, type StackInfo} from './stack.ts';

export function stack(): StackInfo { return readStack(); }
export function operatorClient(info = stack()): DeviceClient {
  return new DeviceClient({baseUrl: info.baseUrl, token: operatorToken(info)});
}

/** Pair through the real static /pair page (fragment code → HttpOnly cookie → workbench). */
export async function pairAndOpen(page: Page, info = stack()): Promise<void> {
  const url = await pairingUrl(info);
  await page.goto(url);
  await page.waitForURL(/\/web\/workbench\.html/, {timeout: 20_000});
  await expect(page.locator('#conn-text')).toContainText('已连接', {timeout: 30_000});
}

export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // expected HTTP errors surfaced by deliberate negative checks
    if (/\b(401|409|503)\b|Failed to load resource/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return errors;
}

export async function hasSessionCookie(context: BrowserContext): Promise<boolean> {
  return (await context.cookies()).some(c => c.name === 'oscar_session' && c.httpOnly && c.sameSite === 'Strict');
}

export async function wellVolume(page: Page, plate: string, well: string): Promise<number> {
  const label = await page.locator(`.well[aria-label^="${plate} ${well}，"]`).first().getAttribute('aria-label');
  const m = /([\d.]+)\s*µL/.exec(label ?? '');
  if (!m) throw new Error(`no volume in label: ${label}`);
  return Number(m[1]);
}

export async function stepIdle(page: Page): Promise<void> {
  await page.locator('#btn-step-idle').click();
}

/** Wait until the Runtime has accepted `count` actions, then step the lockstep clock to idle from the UI. */
export async function acceptedThenStep(page: Page, client: DeviceClient, exp: string, count: number): Promise<void> {
  await expect.poll(async () => (await client.actions(exp)).actions.length, {timeout: 20_000}).toBeGreaterThanOrEqual(count);
  await stepIdle(page);
  await expect.poll(async () => (await client.state(exp)).active_actions.length, {timeout: 30_000}).toBe(0);
}

/** Display projection must never be rejected by the scene (fails loudly instead of a toast). */
export async function sceneUpdateErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as {oscarScene?: {updateErrors(): string[]}}).oscarScene?.updateErrors() ?? []);
}
