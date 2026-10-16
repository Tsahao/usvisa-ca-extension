import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';

test('Figma View Logs layout, empty state and retained Settings draft/scroll', async ({ page }) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'US Visa Scheduler for Canada' });
  await page.getByRole('button', { name: 'Fill synthetic preferences' }).click();
  await page.getByRole('button', { name: 'Open configuration' }).click();
  await panel.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByLabel('Checking interval (s)').fill('120');
  await panel.getByRole('button', { name: 'View Logs' }).scrollIntoViewIfNeeded();
  const configScroll = panel.locator('form > div');
  const retainedScroll = await configScroll.evaluate(element => element.scrollTop);
  const viewLogsBox = (await panel.getByRole('button', { name: 'View Logs' }).boundingBox())!;
  const resetBox = (await panel.getByRole('button', { name: 'Reset Advanced' }).boundingBox())!;
  expect(viewLogsBox.y).toBe(resetBox.y);
  expect(viewLogsBox.width).toBe(96);
  expect(resetBox.x - viewLogsBox.x - viewLogsBox.width).toBe(20);
  await panel.getByRole('button', { name: 'View Logs' }).click();
  await expect(panel.getByText('No available dates are recorded')).toBeVisible();
  await expect(panel.getByRole('navigation').getByRole('button')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('table')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await panel.screenshot({ path: 'test-results/view-logs-empty.png' });
  await page.getByLabel('Preview date history').selectOption('history');
  const table = panel.getByRole('table', { name: 'Date change history' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Checked', 'Earliest Date', 'Booked']);
  await expect(table.getByRole('row')).toHaveCount(15);
  const tableBox = (await table.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(tableBox.width).toBe(276);
  expect(tableBox.y - panelBox.y).toBe(77); // one panel border + 52px toolbar + 24px inset
  expect(Math.abs(tableBox.x + tableBox.width / 2 - panelBox.x - panelBox.width / 2)).toBeLessThan(1);
  await expect(table.getByRole('row').first()).toHaveCSS('height', '44px');
  await expect(table.getByRole('cell').first()).toHaveCSS('font-size', '12px');
  expect(await panel.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const separator = panel.locator('img[src="assets/toolbar-line.svg"]:visible');
  await expect(separator).toHaveJSProperty('naturalWidth', 389);
  expect((await separator.boundingBox())!.width).toBe(389);
  await panel.screenshot({ path: 'test-results/view-logs-history.png' });
  const scroll = panel.getByRole('region', { name: 'Date change history', exact: true });
  expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(table.getByRole('row').last()).toBeInViewport();
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Advanced', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Checking interval (s)')).toHaveValue('120');
  expect(await configScroll.evaluate(element => element.scrollTop)).toBe(retainedScroll);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Start preview' })).toBeVisible();
});

test('packaged unpaid history updates while open, ignores other consulates, and survives browser restart', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-history-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  let context = await launch();
  let posts = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => { chrome.notifications.create = async () => 'synthetic-notification'; });
    const payment = 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment';
    await context.route('https://ais.usvisa-info.com/**', async route => {
      if (route.request().method() !== 'GET') { posts++; await route.abort(); return; }
      if (route.request().url() !== payment) { await route.abort(); return; }
      await route.fulfill({ contentType: 'text/html', body: `<h2>First Available Appointments</h2><table>${['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver'].map(city => `<tr><td>${city}</td><td>${city === 'Vancouver' ? 'November 19, 2026' : 'No Appointments Available'}</td></tr>`).join('')}</table>` });
    });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '', unpaidIvr: '44444444' };
    await panel.evaluate(async prefs => {
      await chrome.storage.local.set({ uiPreferencesV1: prefs, uiLastModeV1: 'alerts' });
      await chrome.runtime.sendMessage({ type: 'PANEL_STOP' });
    }, prefs);
    await panel.reload();
    const host = await context.newPage(); await host.goto(payment);
    const tabId = await panel.evaluate(async payment => (await chrome.tabs.query({})).find(tab => tab.url === payment)!.id!, payment);
    const now = new Date().toISOString();
    const args = { owner: 'history-owner-01', runId: 'history-run-0001', now };
    const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'alerts' }), { ...args,
      binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null } }),
      monitorTabId: tabId, policyKey: policyKey(prefs), nextPollAt: now };
    await panel.evaluate(async state => {
      await chrome.storage.local.set({ engineStateV1: state });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    }, state);
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await panel.getByRole('button', { name: 'Advanced', exact: true }).click();
    await panel.getByRole('button', { name: 'View Logs' }).click();
    const table = panel.getByRole('table', { name: 'Date change history' });
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('cell').nth(1)).toHaveText('Nov 19, 2026');
    const change = async (city: string, text: string, rows: number) => {
      await host.evaluate(({ city, text }) => {
        const row = Array.from(document.querySelectorAll('tr')).find(row => row.cells[0].textContent === city)!;
        row.cells[1].textContent = text;
      }, { city, text });
      const previous = await panel.evaluate(async () => ((await chrome.storage.local.get('engineObservationV1')).engineObservationV1 as { checkedAt: string }).checkedAt);
      await panel.evaluate(async () => {
        const { engineStateV1: state } = await chrome.storage.local.get('engineStateV1');
        await chrome.storage.local.set({ engineStateV1: { ...state as EngineState, nextPollAt: new Date(Date.now() - 1000).toISOString() } });
        await chrome.alarms.create('enginePoll', { when: Date.now() });
      });
      await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('engineObservationV1')).engineObservationV1 as { checkedAt: string }).checkedAt)).not.toBe(previous);
      const history = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_HISTORY' }));
      expect(history.rows).toHaveLength(rows);
      await expect(table.getByRole('row')).toHaveCount(rows + 1);
    };
    await change('Vancouver', 'January 20, 2027', 2); // outside policy still records
    await expect(table.getByRole('cell').nth(1)).toHaveText('Jan 20, 2027');
    await change('Toronto', 'October 17, 2026', 2);
    await change('Vancouver', 'No Appointments Available', 2);
    await change('Vancouver', 'January 20, 2027', 3);
    await expect(table.getByRole('cell').filter({ hasText: /^No$/ })).toHaveCount(3);
    expect(posts).toBe(0);
    await panel.getByRole('button', { name: 'Back', exact: true }).click();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await context.close();
    context = await launch();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${extensionId}/panel.html`);
    await reopened.getByRole('button', { name: 'Settings', exact: true }).click();
    await reopened.getByRole('button', { name: 'Advanced', exact: true }).click();
    await reopened.getByRole('button', { name: 'View Logs' }).click();
    await expect(reopened.getByRole('table').getByRole('row')).toHaveCount(4);
    const restored = await reopened.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    expect(restored.status).toBe('verifying');
    expect(restored.authentication).toBeNull();
    expect(posts).toBe(0);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
