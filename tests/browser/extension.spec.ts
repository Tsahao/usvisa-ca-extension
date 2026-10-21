import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mountPanel } from '../../src/mount-panel';
import type { EngineState } from '../../src/engine/workflow';

test('packaged extension local preferences, isolated frame and browser restart', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-ui-test-'));
  const extensionPath = path.resolve('dist-test');
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'],
  });
  let context = await launch();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/panel.html?preview=1`);
    await page.getByRole('button', { name: 'Fill synthetic preferences' }).click();
    await page.getByRole('button', { name: 'Open configuration' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Alerts', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Terms & conditions' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start preview' }).click();
    await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Terms & Conditions' }).click();
    await expect(page.getByRole('heading', { name: 'Terms & conditions' })).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Alerts', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
    await context.route('https://ais.usvisa-info.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic visa page</title><h1>Synthetic offline fixture</h1><div class="alert application card needs_payment"><div class="row"><div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div><div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div><div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>' }));
    const host = await context.newPage();
    host.on('pageerror', error => errors.push(error.message));
    await host.goto('https://ais.usvisa-info.com/en-ca/niv/groups');
    expect(await host.evaluate(mountPanel, `chrome-extension://${extensionId}/panel.html?embedded=1`)).toBe(true);
    await expect(host.locator('#usvisa-ca-extension-preview-panel')).toBeVisible();
    const frame = host.frameLocator('#usvisa-ca-extension-preview-panel');
    await expect(frame.getByRole('button', { name: 'Alerts', exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Alerts', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    await expect(frame.getByText('Nov 19, 2026', { exact: true })).toHaveCount(0);
    const dashboardTabId = await page.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url === 'https://ais.usvisa-info.com/en-ca/niv/groups')!.id);
    await frame.getByRole('button', { name: 'Start', exact: true }).click();
    await host.waitForURL('https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment');
    expect(await page.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url === 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment')!.id)).toBe(dashboardTabId);
    expect(context.pages().filter(tab => tab.url().startsWith('https://ais.usvisa-info.com'))).toEqual([host]);
    expect(await host.evaluate(mountPanel, `chrome-extension://${extensionId}/panel.html?embedded=1`)).toBe(true);
    await expect(frame.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
      await chrome.storage.local.set({ engineObservationV1: {
        runId: state.runId, mode: 'alerts', checkedAt: new Date().toISOString(), dates: [],
        rows: ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec', 'Toronto', 'Vancouver'].map(city => ({ city, date: city === 'Vancouver' ? '2026-11-20' : null })),
      } });
    });
    await expect(frame.getByRole('heading', { name: 'Vancouver', exact: true }).locator('..').locator('p')).toHaveText('Nov 20, 2026');
    await expect(frame.getByRole('list', { name: 'Consulate dates', exact: true }).getByRole('listitem').filter({ hasText: 'Vancouver' })).toHaveText('VancouverNov 20, 2026');
    await host.evaluate(mountPanel, `chrome-extension://${extensionId}/panel.html?embedded=1`);
    await expect(host.locator('iframe')).toBeHidden();
    await host.evaluate(mountPanel, `chrome-extension://${extensionId}/panel.html?embedded=1`);
    await expect(frame.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    expect(await page.evaluate(async () => ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).status)).toBe('stopped');
    expect(errors).toEqual([]);
    // Seed an engine run with a distant deadline. This uses synthetic group
    // identities and never reaches website reads, actions, or notifications.
    const runId = 'browser-run-0001';
    await page.evaluate(async ({ runId }) => {
      const now = new Date().toISOString();
      await chrome.runtime.sendMessage({
        type: 'ENGINE_START', mode: 'alerts', owner: 'browser-owner-01', runId, now,
        nextPollAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      await chrome.runtime.sendMessage({
        type: 'ENGINE_RESOLVE', mode: 'alerts', owner: 'browser-owner-01', runId, now,
        snapshot: { groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] },
        paidIvr: '22222222', unpaidIvr: '44444444',
      });
    }, { runId });
    expect(await page.evaluate(async () => ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).status)).toBe('running');
    await context.close();
    context = await launch();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${extensionId}/panel.html?preview=1`);
    await expect.poll(() => reopened.evaluate(async () =>
      ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).status,
    )).toBe('verifying');
    expect(await reopened.evaluate(async () => {
      const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
      return { runId: state.runId, nextPollAt: state.nextPollAt, alarm: await chrome.alarms.get('enginePoll') ?? null };
    })).toEqual({ runId, nextPollAt: null, alarm: null });
    await reopened.getByRole('button', { name: 'Open configuration' }).click();
    await expect(reopened.getByLabel('Email', { exact: true })).toHaveValue('preview@example.invalid');
    await expect(reopened.getByLabel('Password', { exact: true })).toHaveValue('synthetic-preview-password');
    await reopened.getByRole('button', { name: 'Cancel' }).click();
    await reopened.getByRole('button', { name: 'Alerts', exact: true }).click();
    await expect(reopened.getByRole('button', { name: 'Start preview' })).toBeVisible();
    await reopened.getByRole('button', { name: 'Settings' }).click();
    await reopened.getByLabel('Password', { exact: true }).fill('updated-synthetic-password');
    await reopened.getByRole('button', { name: 'Save', exact: true }).click();
    await reopened.reload();
    await reopened.getByRole('button', { name: 'Open configuration' }).click();
    await expect(reopened.getByLabel('Password', { exact: true })).toHaveValue('updated-synthetic-password');
    await context.route('https://ais.usvisa-info.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic dashboard</title><div class="alert application card needs_payment"><div class="row"><div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div><div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div><div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>' }));
    for (const tab of context.pages()) {
      if (tab.url() === 'https://ais.usvisa-info.com/en-ca/niv/groups') await tab.close();
    }
    const dashboard = await context.newPage();
    await dashboard.goto('https://ais.usvisa-info.com/en-ca/niv/groups');
    await reopened.goto(`chrome-extension://${extensionId}/panel.html`);

    await reopened.getByRole('button', { name: 'Alerts', exact: true }).click();
    await expect(reopened.getByRole('alert')).toHaveCount(0);
    await expect(reopened.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    await reopened.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(reopened.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(reopened.getByRole('alert')).toHaveCount(0);
    const restarted = await reopened.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    expect(restarted.status).toBe('running');
    expect(restarted.runId).not.toBe(runId);
    expect(restarted.group?.scheduleId).toBe('33333333');
    await reopened.getByRole('button', { name: 'Stop', exact: true }).click();
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
