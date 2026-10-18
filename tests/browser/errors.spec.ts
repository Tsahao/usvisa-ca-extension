import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const scenario of [
  { mode: 'booking', kind: 'paid-ivr-not-found', title: 'Couldn’t find paid group' },
  { mode: 'alerts', kind: 'unpaid-ivr-not-found', title: 'Couldn’t find unpaid group' },
  { mode: 'booking', kind: 'generic', title: 'That didn’t work' },
] as const) {
  test(`packaged ${scenario.kind} error renders and keeps configuration/retry actions`, async () => {
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-error-fixture-'));
    const extensionPath = path.resolve('dist-test');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    let mutations = 0;
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await context.route('https://ais.usvisa-info.com/**', async route => {
        if (route.request().method() !== 'GET') { mutations++; await route.abort(); return; }
        const url = new URL(route.request().url());
        if (url.pathname !== '/en-ca/niv/groups') { await route.abort(); return; }
        const body = scenario.kind === 'generic' ? '<p>Synthetic unreadable dashboard</p>'
          : '<section class="application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul><table><tbody><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/77777777">Details</a></td></tr></tbody></table></section>';
        await route.fulfill({ contentType: 'text/html', body });
      });
      await worker.evaluate(async mode => {
        await chrome.storage.local.set({
          uiLastModeV1: mode,
          uiPreferencesV1: { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
            onlyEarlier: true, testMode: true, interval: 60, paidIvr: '99999999', unpaidIvr: '88888888' },
        });
      }, scenario.mode);
      const dashboard = await context.newPage(); await dashboard.goto('https://ais.usvisa-info.com/en-ca/niv/groups');
      const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      const region = panel.getByRole('region', { name: 'US Visa Scheduler for Canada' });
      await region.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(region.getByRole('heading', { name: scenario.title, exact: true })).toBeVisible();
      // The redesigned failure screen shows its category; worker diagnostics
      // are available through Report a problem rather than duplicated here.
      if (scenario.kind === 'generic') await expect(region.getByText('The extension found no visa groups on this dashboard. Refresh the dashboard; if this repeats, report this message.', { exact: true })).toHaveCount(0);
      await expect(region.getByRole('button', { name: 'Report a problem', exact: true })).toBeVisible();
      await expect(region.getByRole('button', { name: 'Check configurations', exact: true })).toBeVisible();
      await expect(region.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
      await expect(region).toContainText('Tap to retry');
      await expect(region.getByRole('heading', { name: 'Login Failed', exact: true })).toHaveCount(0);
      expect(await region.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      const titleBox = (await region.getByRole('heading', { name: scenario.title, exact: true }).boundingBox())!;
      const retryBox = (await region.getByRole('button', { name: 'Retry', exact: true }).boundingBox())!;
      const configureBox = (await region.getByRole('button', { name: 'Check configurations', exact: true }).boundingBox())!;
      expect(configureBox.y).toBeGreaterThan(titleBox.y + titleBox.height);
      expect(retryBox.y).toBeGreaterThan(configureBox.y + configureBox.height);
      await region.screenshot({ path: `test-results/error-${scenario.kind}.png`, animations: 'disabled' });
      await region.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(region.getByRole('heading', { name: scenario.title, exact: true })).toBeVisible();
      await region.getByRole('button', { name: 'Check configurations', exact: true }).click();
      await expect(region.getByLabel('Email', { exact: true })).toHaveValue('fixture@example.invalid');
      await expect(region.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      expect(mutations).toBe(0);
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}

test('packaged paid-only alerts stays on the dashboard and never requests payment or appointment', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-paid-only-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  let mutations = 0;
  let payments = 0;
  let appointments = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await context.route('https://ais.usvisa-info.com/**', async route => {
      if (route.request().method() !== 'GET') { mutations++; await route.abort(); return; }
      const url = new URL(route.request().url());
      if (url.pathname === '/en-ca/niv/groups') {
        await route.fulfill({ contentType: 'text/html', body:
          '<div class="alert application card ready_to_schedule"><div class="row"><div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Schedule Appointment<br></h4></div><div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul></div></div><div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>22222222</strong></div></div></div>' });
        return;
      }
      if (/\/schedule\/[0-9]+\/payment$/.test(url.pathname)) { payments++; await route.abort(); return; }
      if (/\/schedule\/[0-9]+\/appointment/.test(url.pathname)) { appointments++; await route.abort(); return; }
      await route.abort();
    });
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        uiLastModeV1: 'alerts',
        uiPreferencesV1: { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
          onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' },
      });
    });
    const dashboard = await context.newPage(); await dashboard.goto('https://ais.usvisa-info.com/en-ca/niv/groups');
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const region = panel.getByRole('region', { name: 'US Visa Scheduler for Canada' });
    await region.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(region.getByRole('heading', { name: 'Couldn’t find unpaid group', exact: true })).toBeVisible();
    await expect(region.getByRole('button', { name: 'Check configurations', exact: true })).toBeVisible();
    await expect(region.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    // Dashboard validation happens before any binding or navigation: the tab
    // stays on the dashboard and no payment/appointment request ever runs.
    await expect.poll(() => dashboard.url()).toBe('https://ais.usvisa-info.com/en-ca/niv/groups');
    expect(context.pages().filter(page => page.url().includes('/payment'))).toHaveLength(0);
    expect(payments).toBe(0);
    expect(appointments).toBe(0);
    expect(mutations).toBe(0);
    // Retry keeps the same safe failure without navigating.
    await region.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(region.getByRole('heading', { name: 'Couldn’t find unpaid group', exact: true })).toBeVisible();
    await expect.poll(() => dashboard.url()).toBe('https://ais.usvisa-info.com/en-ca/niv/groups');
    expect(payments).toBe(0);
    expect(appointments).toBe(0);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
