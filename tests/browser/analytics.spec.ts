import { chromium, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AnalyticsRecord } from '../../src/analytics/store';
import type { EngineState } from '../../src/engine/workflow';

const exec = promisify(execFile);
const dashboard = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
const syntheticToken = 'phc_synthetic000000000000000000';

test.beforeAll(async () => {
  // Never build a telemetry-enabled fixture using the owner's actual project.
  await exec(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'build', '--mode', 'analytics-fixture', '--outDir', 'dist-analytics-test'], {
    env: { ...process.env, VITE_POSTHOG_PROJECT_TOKEN: syntheticToken, VITE_POSTHOG_HOST: 'https://us.i.posthog.com', VITE_POSTHOG_ENABLED: 'true' },
  });
});

test('normal packaged fixtures have no analytics permission or enabled ingestion token', async () => {
  const manifest = JSON.parse(await readFile('dist-test/manifest.json', 'utf8'));
  expect(manifest.host_permissions).toEqual(['https://ais.usvisa-info.com/*']);
  const background = await readFile('dist-test/background.js', 'utf8');
  expect(background).not.toMatch(/phc_[A-Za-z0-9]{10,128}/);
});

test('packaged explicit telemetry distinguishes paid curiosity from healthy unpaid monitoring (mocked PostHog)', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-analytics-fixture-'));
  const extensionPath = path.resolve('dist-analytics-test');
  const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toEqual(['https://ais.usvisa-info.com/*']);
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND, MAP us.i.posthog.com ~NOTFOUND, MAP eu.i.posthog.com ~NOTFOUND'] });
  let unpaid = false;
  let portalPosts = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      const fixture = globalThis as typeof globalThis & { __telemetry: { url: string; body: any; credentials?: string; redirect?: string; referrerPolicy?: string }[]; __offline: boolean };
      fixture.__telemetry = []; fixture.__offline = true;
      globalThis.fetch = async (input, options) => {
        if (fixture.__offline) throw new Error('Synthetic offline');
        fixture.__telemetry.push({ url: String(input), body: JSON.parse(options!.body as string),
          credentials: options!.credentials, redirect: options!.redirect, referrerPolicy: options!.referrerPolicy });
        return new Response('{}', { status: 200 });
      };
    });
    await context.route('https://ais.usvisa-info.com/**', async route => {
      if (route.request().method() !== 'GET') { portalPosts++; await route.abort(); return; }
      const url = new URL(route.request().url());
      let body = '<p>Unsupported synthetic document</p>';
      if (url.href === dashboard) body = unpaid
        ? '<section class="application card needs_payment"><strong>44444444</strong><h4 class="status">Pay Visa Fee</h4><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></section>'
        : '<section class="application card ready_to_schedule"><strong>22222222</strong><h4 class="status">Schedule Appointment</h4><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul></section>';
      if (url.pathname === '/en-ca/niv/schedule/33333333/payment') body = `<h2>First Available Appointments</h2><table>${['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver'].map(city => `<tr><td>${city}</td><td>No Appointments Available</td></tr>`).join('')}</table>`;
      await route.fulfill({ contentType: 'text/html', body });
    });
    const host = await context.newPage(); await host.goto(dashboard);
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.evaluate(async () => {
      await chrome.storage.local.set({ uiPreferencesV1: { email: 'fixture@example.invalid', password: 'synthetic-private-password', consulate: 'Vancouver',
        earliest: '2026-11-01', latest: '2026-12-31', testMode: true, onlyEarlier: true, interval: 120, paidIvr: '', unpaidIvr: '' } });
      await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
    });
    const failed = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'alerts' }));
    expect(failed).toMatchObject({ ok: false, failureKind: 'unpaid-ivr-not-found' });
    await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord)?.session?.failed)).toBe(true);
    unpaid = true; await host.reload();
    const started = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'alerts' }));
    expect(started.ok).toBe(true);
    await expect(host).toHaveURL('https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment');
    await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord)?.session?.activated)).toBe(true);
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'alerts' }));
    // A real tab closure in the synthetic portal produces a bounded reason
    // from the background transition, retained through outbox delivery.
    await host.close();
    await panel.evaluate(async () => {
      const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
      await chrome.storage.local.set({ engineStateV1: { ...state, nextPollAt: new Date().toISOString() } });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    });
    await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord)?.session?.failed)).toBe(true);
    // Simulate lost connectivity, then retry with exactly the same event IDs.
    await worker.evaluate(() => { (globalThis as any).__offline = true; });
    const trigger = () => panel.evaluate(async () => {
      const record = (await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord;
      await chrome.storage.local.set({ analyticsV1: { ...record, nextFlushAt: new Date().toISOString() } });
      await chrome.alarms.create('analyticsFlush', { when: Date.now() });
    });
    await trigger();
    await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).outbox.some(event => event.attempts > 0))).toBe(true);
    const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_STOP' })); expect(stopped.ok).toBe(true);
    await worker.evaluate(() => { (globalThis as any).__offline = false; });
    await trigger();
    await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).outbox.length)).toBe(0);
    const deliveries: any[] = await worker.evaluate(() => (globalThis as any).__telemetry);
    const bodies = deliveries.map(entry => entry.body);
    expect(bodies.filter(body => body.event === 'workflow_started')).toHaveLength(2);
    expect(bodies.filter(body => body.event === 'workflow_failed')).toHaveLength(2);
    const blocked = bodies.find(body => body.properties.failure_reason === 'workflow-blocked');
    expect(blocked.properties).toMatchObject({ failure_code: 'tab-unavailable', failure_step: 'tab-check' });
    expect(blocked.properties).not.toHaveProperty('auth_purpose');
    const early = bodies.find(body => body.properties.failure_reason === 'start-failed');
    expect(early.properties).toMatchObject({ failure_code: 'unknown', failure_step: 'unknown' });
    expect(bodies.filter(body => body.event === 'alerts_monitoring_established')).toHaveLength(1);
    expect(new Set(bodies.map(body => body.distinct_id)).size).toBe(1);
    for (const delivery of deliveries) {
      expect(delivery).toMatchObject({ url: 'https://us.i.posthog.com/i/v0/e/', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      expect(delivery.body.api_key).toBe(syntheticToken);
    }
    expect(JSON.stringify(bodies)).not.toMatch(/fixture@example|synthetic-private|22222222|44444444|Vancouver|2026-11-01|schedule\//);
    expect(portalPosts).toBe(0);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
