import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineState } from '../../src/engine/workflow';

for (const { feature, signedOut } of [{ feature: 'booking', signedOut: false }, { feature: 'alerts', signedOut: false }, { feature: 'both', signedOut: false }, { feature: 'both', signedOut: true }] as const) {
  test(`first sign-in discovers ${feature} features${signedOut ? " through automatic login" : ""}, preserves drafts and reopens without starting`, async () => {
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-onboarding-fixture-'));
    const extensionPath = path.resolve('dist-test');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    const requests: { path: string; method: string }[] = [];
    try {
      await context.route('https://ais.usvisa-info.com/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        requests.push({ path: pathname, method: route.request().method() });
        if (pathname === '/en-ca/niv/users/sign_in') {
          if (route.request().method() === 'POST') await route.fulfill({ contentType: 'application/json', body: '{}' });
          else await route.fulfill({ contentType: 'text/html', body: '<form id="sign_in_form" method="post" action="/en-ca/niv/users/sign_in"><input id="user_email" name="user[email]" type="email"><input id="user_password" name="user[password]" type="password"><input id="policy_confirmed" name="policy_confirmed" type="checkbox"><input type="submit" name="commit" value="Sign In"></form><script>document.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); await fetch("/en-ca/niv/users/sign_in", {method:"POST",body:new FormData(event.target)}); location.replace("/en-ca/niv/groups"); });</script>' });
        } else if (pathname === '/en-ca/niv/groups') {
          const paid = '<section class="application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></ul><table><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/77777777">Details</a></td></tr><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/88888888">Details</a></td></tr></table></section>';
          const unpaid = '<section class="application card needs_payment"><strong>44444444</strong><h4 class="status"><small>Current Status</small> Pay Visa Fee</h4><ul class="actions"><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></ul></section>';
          await route.fulfill({ contentType: 'text/html', body: (feature !== 'booking' ? unpaid : '') + (feature !== 'alerts' ? paid : '') });
        } else if (pathname === '/en-ca/niv/schedule/33333333/payment') {
          await route.fulfill({ contentType: 'text/html', body: '<h2>First Available Appointments</h2><table>' + ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver'].map(city => `<tr><td>${city}</td><td>No appointments available</td></tr>`).join('') + '</table>' });
        } else await route.abort();
      });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await worker.evaluate(() => { chrome.notifications.create = (async () => 'synthetic-notification') as typeof chrome.notifications.create; });
      const portal = await context.newPage(); await portal.goto(`https://ais.usvisa-info.com/en-ca/niv/${signedOut ? 'users/sign_in' : 'groups'}`);
      let panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      const region = panel.getByRole('region', { name: 'US Visa Scheduler for Canada' });
      await expect(panel.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled();
      await expect(region.getByRole('navigation')).toHaveCount(0);
      expect(await region.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      for (const [asset, width] of [['welcome-reflection.svg', 14.7692], ['welcome-reflection-bottom.svg', 19.2], ['welcome-maple.svg', 25.8462]] as const) {
        const img = region.locator(`img[src="assets/${asset}"]`);
        expect(await img.evaluate(image => image.getBoundingClientRect().width)).toBeCloseTo(width, 1);
      }
      const form = region.locator('fieldset'); const box = (await form.boundingBox())!; const panelBox = (await region.boundingBox())!;
      expect(box.width).toBeCloseTo(308, 0); expect(box.y - panelBox.y).toBeCloseTo(175, 0);
      if (feature === 'both') await region.screenshot({ path: 'test-results/onboarding-empty.png' });
      await panel.getByLabel('Email', { exact: true }).fill('synthetic@example.invalid');
      await panel.getByLabel('Password', { exact: true }).fill('synthetic-password');
      await panel.getByLabel('Consulate', { exact: true }).selectOption('Vancouver');
      await panel.getByLabel('Earliest Acceptable').fill('2026-11-01');
      await panel.getByLabel('Latest Acceptable').fill('2026-12-31');
      await panel.getByRole('switch', { name: 'Auto Book' }).uncheck();
      await panel.getByRole('link', { name: 'Terms & Conditions' }).click();
      await expect(region.getByRole('navigation').getByRole('button')).toHaveCount(1);
      await panel.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(panel.getByLabel('Email', { exact: true })).toHaveValue('synthetic@example.invalid');
      await expect(panel.getByRole('switch', { name: 'Auto Book' })).not.toBeChecked();
      if (feature === 'both') await region.screenshot({ path: 'test-results/onboarding-filled.png' });
      await panel.getByRole('button', { name: 'Sign in', exact: true }).click();
      const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      if (feature === 'both') {
        await expect(panel.getByRole('heading', { name: 'Select a mode to start' })).toBeVisible();
        await expect(region.getByRole('navigation').getByRole('button')).toHaveCount(5);
        expect(await read()).toMatchObject({ status: 'stopped', group: null, intent: null, nextPollAt: null, discovery: { choosing: true } });
        expect(requests.every(request => ['/en-ca/niv/groups', '/en-ca/niv/users/sign_in'].includes(request.path))).toBe(true);
        await region.screenshot({ path: 'test-results/onboarding-choice.png' });
        // Toolbar and tiles have equivalent behavior; unit coverage exercises both.
        await panel.getByRole('button', { name: 'Scheduling Visa fee paid' }).click();
      }
      await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Stop', exact: true }).click();
      const stopped = await read();
      expect(stopped).toMatchObject({ status: 'stopped', mode: feature === 'alerts' ? 'alerts' : 'booking', intent: null, discovery: { features: feature, choosing: false } });
      if (feature !== 'alerts') expect(stopped.group).toMatchObject({ scheduleId: '11111111', applicantIds: ['77777777', '88888888'] });
      else expect(stopped.group).toMatchObject({ scheduleId: '33333333', kind: 'unpaid' });
      await expect(region.getByRole('navigation').getByRole('button')).toHaveCount(feature === 'both' ? 5 : 4);
      const runId = stopped.runId;
      await panel.close(); panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await expect(panel.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
      await expect(panel.getByRole('heading', { name: 'Select a mode to start' })).toHaveCount(0);
      await expect(panel.getByRole('navigation').getByRole('button')).toHaveCount(feature === 'both' ? 5 : 4);
      expect(await read()).toMatchObject({ status: 'stopped', runId, intent: null });
      expect(requests.filter(request => request.method !== 'GET')).toEqual(signedOut ? [{ path: '/en-ca/niv/users/sign_in', method: 'POST' }] : []);
      if (feature === 'alerts') expect(requests.some(request => /appointment|continue_actions/.test(request.path))).toBe(false);
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}
