import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineState } from '../../src/engine/workflow';

test('detached panel dimensions, workflow tabs, pinpointing and independent monitoring', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-detached-test-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND, MAP buy.stripe.com ~NOTFOUND'] });
  try {
    await context.route('https://ais.usvisa-info.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic Visa fixture</title><h1>Offline fixture</h1>' }));
    await context.route('https://example.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic browsing fixture</title><h1>Another website</h1>' }));
    // Guard only: Chrome starts the extension's own checkout tab before Playwright
    // can attach, so this route cannot intercept that navigation. The checkout
    // assertion below stubs the tab creation instead and asserts the exact URL.
    await context.route('https://buy.stripe.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic checkout</title><h1>Offline Stripe fixture</h1>' }));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/panel.html?preview=1`);
    await control.getByRole('button', { name: 'Fill synthetic preferences' }).click();
    await control.getByRole('button', { name: 'Open configuration' }).click();
    await control.getByRole('button', { name: 'Save', exact: true }).click();
    const url = 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment';
    const source = await context.newPage();
    await source.goto(url);
    const sourceTabId = await control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, url);
    const duplicate = await context.newPage();
    await duplicate.goto(url);
    // A far-future synthetic run never polls, submits, or creates a notification.
    await control.evaluate(async sourceTabId => {
      const now = new Date().toISOString();
      await chrome.runtime.sendMessage({ type: 'ENGINE_START', mode: 'alerts', owner: 'detached-owner-01', runId: 'detached-run-0001', now, nextPollAt: new Date(Date.now() + 3600_000).toISOString() });
      await chrome.runtime.sendMessage({ type: 'ENGINE_RESOLVE', mode: 'alerts', owner: 'detached-owner-01', runId: 'detached-run-0001', now,
        snapshot: { groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] }, paidIvr: '22222222', unpaidIvr: '44444444' });
      const saved = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
      await chrome.storage.local.set({ uiLastModeV1: 'alerts', engineStateV1: { ...saved, monitorTabId: sourceTabId }, engineObservationV1: {
        runId: saved.runId, mode: 'alerts', checkedAt: now, rows: ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec', 'Toronto', 'Vancouver'].map(city => ({ city, date: null })),
      } });
    }, sourceTabId);
    const popupPage = context.waitForEvent('page');
    // Real Chrome popup hosting exercises the product page and its native-frame
    // fit; toolbar-click dispatch itself is covered by the worker unit fixture.
    const popupWindow = await control.evaluate(async extensionId => chrome.windows.create({
      url: `chrome-extension://${extensionId}/panel.html?detached=1`, type: 'popup', focused: true, width: 356, height: 618,
    }), extensionId);
    const panel = await popupPage;
    const errors: string[] = [];
    panel.on('pageerror', error => errors.push(error.message));
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect.poll(() => panel.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 356, height: 586 });
    const region = panel.getByRole('region', { name: 'US Visa Scheduler for Canada' });
    await expect(region).toHaveCSS('width', '356px');
    await expect(region).toHaveCSS('height', '586px');
    // The detached product window is the floating Chrome popup itself: no
    // outer card treatment, and the scheduler starts at the client origin.
    await expect(region).toHaveCSS('border-radius', '0px');
    await expect(region).toHaveCSS('border-top-width', '0px');
    await expect(region).toHaveCSS('box-shadow', 'none');
    expect(await region.evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y }; })).toEqual({ x: 0, y: 0 });
    await panel.getByRole('button', { name: 'Booking', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    await expect(panel.getByRole('navigation', { name: 'Scheduler navigation' }).getByRole('button')).toHaveCount(5);
    await expect(panel.getByRole('button', { name: 'Show Visa tab' })).toBeEnabled();
    expect(await region.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await panel.mouse.move(0, 0);
    await panel.screenshot({ path: 'test-results/detached-booking.png' });
    await panel.getByRole('button', { name: 'Coffee', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Coffee', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(panel.getByRole('textbox', { name: 'Amount in USD' })).toHaveValue('5');
    await panel.getByRole('button', { name: 'Increase amount' }).click();
    // Chrome opens the extension's checkout tab before Playwright can attach, so no
    // route can intercept that navigation. Record the requested destination and send
    // the tab to an inert local page instead, keeping the assertion exact and offline.
    await panel.evaluate(() => {
      const requested: string[] = [];
      (window as any).__checkoutRequests = requested;
      const create = chrome.tabs.create.bind(chrome.tabs);
      (chrome.tabs as any).create = (options: chrome.tabs.CreateProperties) => {
        requested.push(String(options.url));
        return create({ ...options, url: 'about:blank' });
      };
    });
    const checkoutRequests = () => panel.evaluate(() => (window as any).__checkoutRequests as string[]);
    const checkoutPage = context.waitForEvent('page');
    await panel.getByRole('button', { name: 'Continue to Stripe' }).click();
    const checkout = await checkoutPage;
    expect(await checkoutRequests()).toEqual(['https://buy.stripe.com/fZu8wIfiZbhs8PU41r8EM00?prefilled_amount=600']);
    expect(checkout.url()).toBe('about:blank');
    await expect(panel.getByRole('heading', { name: 'Buy me a coffee?' })).toBeVisible();
    expect(await region.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await panel.screenshot({ path: 'test-results/detached-coffee.png' });
    expect(await control.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1)).toMatchObject({ status: 'running', runId: 'detached-run-0001', monitorTabId: sourceTabId, intent: null });
    await checkout.close();
    await panel.getByRole('button', { name: 'CAD', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: 'Amount in CAD' })).toHaveValue('6');
    const cadCheckoutPage = context.waitForEvent('page');
    await panel.getByRole('button', { name: 'Continue to Stripe' }).click();
    const cadCheckout = await cadCheckoutPage;
    expect(await checkoutRequests()).toEqual([
      'https://buy.stripe.com/fZu8wIfiZbhs8PU41r8EM00?prefilled_amount=600',
      'https://buy.stripe.com/4gM5kw2wdado3vA9lL8EM01?prefilled_amount=600',
    ]);
    expect(cadCheckout.url()).toBe('about:blank');
    expect(context.pages().filter(page => page.url().includes('buy.stripe.com'))).toHaveLength(0);
    await expect(panel.getByRole('heading', { name: 'Buy me a coffee?' })).toBeVisible();
    await cadCheckout.close();
    await panel.getByRole('button', { name: 'Booking', exact: true }).click();
    await panel.getByRole('button', { name: 'Show Visa tab' }).click();
    await expect.poll(() => control.evaluate(async id => (await chrome.tabs.get(id)).active, sourceTabId)).toBe(true);
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toHaveLength(2);
    await source.goto(`${url}?fixture=reload`);
    await duplicate.goto('https://example.invalid/browsing');
    await expect(panel.getByRole('heading', { name: 'Earliest Available' })).toBeVisible();
    expect(await control.evaluate(async () => ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).status)).toBe('running');
    await panel.getByRole('button', { name: 'Show Visa tab' }).click();
    await expect.poll(() => control.evaluate(async id => (await chrome.tabs.get(id)).active, sourceTabId)).toBe(true);
    await source.close();
    const loginPage = context.waitForEvent('page');
    await panel.getByRole('button', { name: 'Show Visa tab' }).click();
    const login = await loginPage;
    await login.waitForURL('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    await panel.getByRole('button', { name: 'Show Visa tab' }).click();
    expect(context.pages().filter(page => page.url() === 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in')).toHaveLength(1);
    const layout = () => region.evaluate(node => {
      const box = node.getBoundingClientRect();
      const button = node.querySelector('button[aria-label="Start"]')!.getBoundingClientRect();
      const footer = Array.from(node.querySelectorAll('p')).find(p => /^(Current|No current) appointment/.test(p.textContent ?? ''))!.getBoundingClientRect();
      const stats = node.querySelector('h2')!.getBoundingClientRect();
      return { buttonBottom: box.bottom - button.bottom, footerBottom: box.bottom - footer.bottom, statsTop: stats.top - box.top };
    });
    const initialLayout = await layout();
    await control.evaluate(async windowId => { await chrome.windows.update(windowId!, { width: 520, height: 720 }); }, popupWindow!.id);
    await expect.poll(() => panel.evaluate(() => innerWidth)).toBeGreaterThan(356);
    await expect(region).toHaveCSS('width', '356px');
    await expect.poll(layout).toEqual(initialLayout);
    expect(await region.evaluate(node => node.clientHeight === innerHeight)).toBe(true);
    await panel.close();
    const finalState = await control.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    expect(finalState).toMatchObject({ status: 'running', runId: 'detached-run-0001', monitorTabId: sourceTabId, intent: null });
    expect(errors).toEqual([]);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
