import { chromium, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AnalyticsRecord } from '../../src/analytics/store';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';

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
    expect(early.properties).toMatchObject({ failure_code: 'unpaid-group-not-found', failure_step: 'start-selection' });
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

test('packaged manual appointment change resumes polling without recovery telemetry and cannot book a worse date', async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-baseline-fixture-'));
  const extensionPath = path.resolve('dist-analytics-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND, MAP us.i.posthog.com ~NOTFOUND, MAP eu.i.posthog.com ~NOTFOUND'] });
  const base = '/en-ca/niv/schedule/11111111';
  const dashboardPath = '/en-ca/niv/groups/55555555';
  let posts = 0; let dayReads = 0; let enteredGateway = false;
  const form = `<form id="appointment-form" method="post" action="${base}/appointment"><input id="confirmed_limit_message" name="confirmed_limit_message" type="hidden" value="1"><select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select><input id="appointments_consulate_appointment_date" readonly><select id="appointments_consulate_appointment_time"><option value=""></option></select><input type="submit" id="appointments_submit" value="Reschedule Appointment" disabled></form>`;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      const fixture = globalThis as typeof globalThis & { __recoveries: any[] };
      fixture.__recoveries = [];
      globalThis.fetch = async (_input, options) => {
        fixture.__recoveries.push(JSON.parse(options!.body as string));
        return new Response('{}', { status: 200 });
      };
      chrome.notifications.create = async () => 'synthetic-notification';
    });
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') { posts++; await route.abort(); return; }
      let body: string;
      if (url.pathname === '/en-ca/niv/') body = `<script>location.replace('${dashboardPath}');</script>`;
      else if (url.pathname === dashboardPath) body = `<section class="application card attend_appointment success"><strong>22222222</strong><p class="consular-appt">15 September, 2026 <a href="${base}/appointment">Appointment</a></p><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><table><tr><td><a href="${base}/applicants/77777777">Details</a></td></tr></table></section>`;
      else if (url.pathname === `${base}/continue_actions`) {
        enteredGateway = true;
        body = `<a class="accordion-title" role="tab" aria-expanded="false" aria-controls="entry"><h5>Reschedule Appointment</h5></a><div id="entry" hidden><a class="button small primary small-only-expanded" href="${base}/appointment">Reschedule Appointment</a></div><script>document.querySelector('.accordion-title').onclick = () => { document.querySelector('.accordion-title').setAttribute('aria-expanded','true'); document.querySelector('#entry').hidden = false; };</script>`;
      } else if (url.pathname === `${base}/appointment/days/95.json`) {
        dayReads++;
        // Earlier than the stale January baseline, worse than the new September booking.
        await route.fulfill({ contentType: 'application/json', body: '[{"date":"2026-11-19"}]' }); return;
      } else if (url.pathname === `${base}/appointment`) body = !enteredGateway || url.searchParams.get('confirmed_limit_message') === '1'
        ? form
        : `<form method="get" action="${base}/appointment"><input type="checkbox" id="confirmed_limit_message" name="confirmed_limit_message" value="1"><input type="submit" name="commit" value="Continue"></form>`;
      else { await route.abort(); return; }
      await route.fulfill({ contentType: 'text/html', body });
    });
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const flow = await context.newPage(); await flow.goto(`https://ais.usvisa-info.com${base}/appointment`);
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, flow.url());
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-private-password', consulate: 'Vancouver',
      earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    const now = new Date().toISOString(); const args = { now, owner: 'product-panel-owner', runId: 'baseline-run-0001' };
    const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', dashboardPath, applicantIds: ['77777777'] } }),
      policyKey: policyKey(prefs), nextPollAt: now,
      executor: { tabId, applicantIds: ['77777777'], targetTime: '09:15', skippedDates: [], actionPending: false } };
    await panel.evaluate(async ({ prefs, state }) => {
      await chrome.storage.local.set({ uiPreferencesV1: prefs });
      await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
      const record: AnalyticsRecord = { version: 1, distinctId: '10000000-0000-4000-8000-000000000001',
        session: { id: '10000000-0000-4000-8000-000000000002', runId: state.runId, mode: 'booking', testMode: false, failed: false, activated: false, closed: false },
        queued: null, outbox: [], nextFlushAt: null };
      await chrome.storage.local.set({ analyticsV1: record, engineStateV1: state });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    }, { prefs, state });
    const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    await expect.poll(async () => ({ dayReads, status: (await read()).status }), { timeout: 25_000 }).toEqual({ dayReads: 1, status: 'running' });
    expect(await read()).toMatchObject({ authentication: null, stage: null, lastCandidate: null, intent: null,
      group: { currentDate: '2026-09-15' }, executor: { tabId, targetTime: null, actionPending: false } });
    await panel.evaluate(async () => {
      const current = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
      await chrome.storage.local.set({ engineStateV1: { ...current, nextPollAt: new Date().toISOString() } });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
      const analytics = (await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord;
      await chrome.storage.local.set({ analyticsV1: { ...analytics, nextFlushAt: new Date().toISOString() } });
      await chrome.alarms.create('analyticsFlush', { when: Date.now() });
    });
    await expect.poll(() => dayReads).toBe(2);
    await expect.poll(async () => Date.parse((await read()).nextPollAt ?? '') > Date.now()).toBe(true);
    await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).outbox.length)).toBe(0);
    const events: any[] = await worker.evaluate(() => (globalThis as any).__recoveries);
    // Installation can be recorded before the synthetic workflow is seeded.
    // Baseline recovery itself must produce no event.
    expect(events.filter(event => event.event !== 'installation_seen')).toEqual([]);
    expect(JSON.stringify(events)).not.toMatch(/2027-01-01|2026-09-15|2026-11-19|11111111|22222222|77777777|synthetic-private|baselineRevision/);
    expect(posts).toBe(0);
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([flow]);
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

for (const classesAvailable of [true, false]) {
  test(`packaged verified booking sends exact date and dashboard visa classes (readable ${classesAvailable})`, async () => {
    test.setTimeout(60_000);
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-booked-analytics-fixture-'));
    const extensionPath = path.resolve('dist-analytics-test');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND, MAP us.i.posthog.com ~NOTFOUND, MAP eu.i.posthog.com ~NOTFOUND'] });
    const base = '/en-ca/niv/schedule/11111111';
    let verifying = false; let posts = 0; let verificationReads = 0;
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await worker.evaluate(() => {
        (globalThis as any).__bookings = [];
        globalThis.fetch = async (_input, options) => {
          (globalThis as any).__bookings.push(JSON.parse(options!.body as string));
          return new Response('{}', { status: 200 });
        };
      });
      await context.route('https://ais.usvisa-info.com/**', async route => {
        if (route.request().method() !== 'GET') { posts++; await route.abort(); return; }
        if (route.request().url() !== dashboard) { await route.abort(); return; }
        if (verifying) verificationReads++;
        const showClass = !verifying || classesAvailable;
        // The optional Petition column changes position between Start and
        // verification; the sibling group's B1/B2 class must not leak in.
        const body = `<section class="application card attend_appointment"><strong>22222222</strong>
          <h4 class="status">Attend Appointment</h4><p class="consular-appt">${verifying ? 'November 19, 2026 at 09:15' : 'January 1, 2027'} <a href="${base}/appointment">Appointment</a></p>
          <ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul>
          <table><thead><tr><th>Applicant Name</th>${!verifying ? '<th>Petition</th>' : ''}<th>${showClass ? 'Visa Class' : 'Unavailable'}</th><th></th></tr></thead>
          <tbody>${['77777777', '88888888'].map((id, i) => `<tr><td>Private synthetic name</td>${!verifying ? '<td>Private synthetic petition</td>' : ''}<td>${i ? 'L2 Spouse or Child of an L1' : 'L1 Intra-company Transferee'}</td><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>
          <section class="application card ready_to_schedule"><strong>44444444</strong><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul>
          <table><tr><th>Visa Class</th><th></th></tr><tr><td>B1/B2 Business &amp; Tourism</td><td><a href="/en-ca/niv/schedule/33333333/applicants/99999999">Details</a></td></tr></table></section>`;
        await route.fulfill({ contentType: 'text/html', body });
      });
      const host = await context.newPage(); await host.goto(dashboard);
      const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await panel.evaluate(async () => {
        await chrome.storage.local.set({ uiPreferencesV1: { email: 'fixture@example.invalid', password: 'private-synthetic-password',
          consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false,
          interval: 60, paidIvr: '22222222', unpaidIvr: '' } });
        await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
      });
      expect(await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'booking' }))).toMatchObject({ ok: true });
      const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      expect((await read()).group).toMatchObject({ applicantIds: ['77777777', '88888888'], visaClasses: ['L1', 'L2'] });
      await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).session?.runId)).toBe((await read()).runId);
      // Seed an already-submitted synthetic intent: no real or fixture booking
      // POST is necessary to exercise the existing three-read success gate.
      await panel.evaluate(async dashboard => {
        const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        const tabId = (await chrome.tabs.query({})).find(tab => tab.url === dashboard)!.id!;
        const now = new Date().toISOString();
        await chrome.storage.local.set({ engineStateV1: { ...state, status: 'verifying', nextPollAt: null, executor: null, stage: null,
          intent: { runId: state.runId!, groupId: state.group!.scheduleId, mode: 'booking', targetDate: '2026-11-19',
            consulate: 'Vancouver', testMode: false, createdAt: now, phase: 'submitted' },
          verificationTabId: tabId, verification: { reads: [], nextReadAt: now }, verificationError: null } satisfies EngineState });
      }, dashboard);
      verifying = true;
      for (let index = 1; index <= 3; index++) {
        await panel.evaluate(async () => {
          const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
          await chrome.storage.local.set({ engineStateV1: { ...state, verification: { ...state.verification!, nextReadAt: new Date().toISOString() } } });
          await chrome.alarms.create('enginePoll', { when: Date.now() });
        });
        if (index < 3) {
          await expect.poll(async () => (await read()).verification?.reads.length).toBe(index);
          expect(await panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).session?.bookingSucceeded)).not.toBe(true);
        } else await expect.poll(async () => ({ status: (await read()).status, intent: (await read()).intent })).toEqual({ status: 'stopped', intent: null });
      }
      await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).session?.bookingSucceeded)).toBe(true);
      await panel.evaluate(async () => {
        const analytics = (await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord;
        await chrome.storage.local.set({ analyticsV1: { ...analytics, nextFlushAt: new Date().toISOString() } });
        await chrome.alarms.create('analyticsFlush', { when: Date.now() });
      });
      await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).outbox.length)).toBe(0);
      const events: any[] = await worker.evaluate(() => (globalThis as any).__bookings);
      const bookings = events.filter(event => event.event === 'appointment_booked');
      expect(bookings).toHaveLength(1);
      expect(bookings[0].properties).toMatchObject({ appointment_date: '2026-11-19', visa_classes: classesAvailable ? ['L1', 'L2'] : ['unknown'] });
      for (const event of events.filter(event => event.event !== 'appointment_booked')) {
        expect(event.properties).not.toHaveProperty('appointment_date'); expect(event.properties).not.toHaveProperty('visa_classes');
      }
      expect(JSON.stringify(events)).not.toMatch(/fixture@example|private-synthetic|Private synthetic|11111111|22222222|77777777|88888888|99999999|Vancouver|2027-01-01|09:15|Intra-company|Spouse|B1\/B2|schedule\//);
      expect(verificationReads).toBe(3); expect(posts).toBe(0);
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}

for (const scenario of ['timeout', 'server', 'denied'] as const) test(`packaged date-selection ${scenario} rebuilds through the dashboard without a failure event`, async () => {
  test.setTimeout(45_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-failure-cause-'));
  const extensionPath = path.resolve('dist-analytics-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND, MAP us.i.posthog.com ~NOTFOUND, MAP eu.i.posthog.com ~NOTFOUND'] });
  const base = '/en-ca/niv/schedule/11111111'; const ids = ['77777777', '88888888'];
  let posts = 0; let dashboardReads = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      const fixture = globalThis as typeof globalThis & { __failureEvents: any[] };
      fixture.__failureEvents = [];
      globalThis.fetch = async (_input, options) => {
        fixture.__failureEvents.push(JSON.parse(options!.body as string));
        return new Response('{}', { status: 200 });
      };
    });
    await context.route('https://ais.usvisa-info.com/**', async route => {
      if (route.request().method() !== 'GET') { posts++; await route.abort(); return; }
      const url = new URL(route.request().url());
      if (url.pathname === '/en-ca/niv/') {
        await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('/en-ca/niv/groups/55555555');</script>` }); return;
      }
      if (url.pathname === '/en-ca/niv/groups/55555555') {
        dashboardReads++;
        await route.fulfill({ contentType: 'text/html', body: `<section class="application card attend_appointment success"><strong>22222222</strong><p class="consular-appt">1 January, 2027 <a href="${base}/appointment">Appointment</a></p><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><table>${ids.map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</table></section>` }); return;
      }
      await route.fulfill({ contentType: 'text/html', body: `<form id="appointment-form" method="post" action="${base}/appointment"><select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select><input id="appointments_consulate_appointment_date" readonly><select id="appointments_consulate_appointment_time"><option value=""></option></select><input type="submit" id="appointments_submit" disabled></form><script>
        const date = document.querySelector('#appointments_consulate_appointment_date');
        const listeners = new Map();
        window.jQuery = node => node === date ? {
          datepicker: (command, value) => {
            if (command === 'option') return function () {
              if ('${scenario}' === 'timeout') return;
              const xhr = { status: '${scenario}' === 'server' ? 503 : 403 };
              const settings = { url: '${base}/appointment/times/95.json?date=2026-11-19&appointments[expedite]=false', type: 'GET' };
              for (const [key, handler] of listeners) if (key.startsWith('ajaxSend.')) handler({}, xhr, settings);
              for (const [key, handler] of listeners) if (key.startsWith('ajaxComplete.')) handler({}, xhr, settings);
            };
            if (command === 'setDate') date.value = value;
          }, data: () => ({})
        } : { on: (key, handler) => listeners.set(key, handler), off: key => listeners.delete(key) };
      </script>` });
    });
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const flow = await context.newPage(); await flow.goto(`https://ais.usvisa-info.com${base}/appointment?applicants[]=77777777&applicants[]=88888888`);
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, flow.url());
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-private-password', consulate: 'Vancouver',
      earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, autoMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    const now = new Date().toISOString(); const args = { now, owner: 'product-panel-owner', runId: 'failure-run-0001' };
    const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', applicantIds: ids } }),
      stage: 'form', lastCandidate: { date: '2026-11-19', consulate: 'Vancouver' }, policyKey: policyKey(prefs), nextPollAt: now,
      executor: { tabId, applicantIds: ids, targetTime: null, skippedDates: [], actionPending: false } };
    await panel.evaluate(async ({ prefs, state }) => {
      await chrome.storage.local.set({ uiPreferencesV1: prefs });
      await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
      const record: AnalyticsRecord = { version: 1, distinctId: '20000000-0000-4000-8000-000000000001',
        session: { id: '20000000-0000-4000-8000-000000000002', runId: state.runId, mode: 'booking', testMode: false, failed: false, activated: false, closed: false },
        queued: null, outbox: [], nextFlushAt: null };
      await chrome.storage.local.set({ analyticsV1: record, engineStateV1: state });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    }, { prefs, state });
    const readState = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    await expect.poll(async () => (await readState()).formLoadFailures, { timeout: 25_000 }).toBe(1);
    const recovering = await readState();
    expect(recovering).toMatchObject({ status: 'running', intent: null, lastCandidate: null, stage: null,
      executor: { actionPending: false }, authentication: { purpose: 'renew', phase: 'retry', dashboardFirst: true } });
    expect(Date.parse(recovering.nextPollAt!)).toBeGreaterThan(Date.now());
    expect(dashboardReads).toBe(0);
    expect(await panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).session!.failed)).toBe(false);
    // Advance only the synthetic retry deadline to exercise the real owned-tab
    // browser GET and independent fresh group/baseline/full-roster validation.
    await panel.evaluate(async () => {
      const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
      await chrome.storage.local.set({ engineStateV1: { ...state, nextPollAt: new Date().toISOString() } });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    });
    await expect.poll(async () => {
      const current = await readState();
      return current.status === 'running' && current.authentication === null && current.stage === 'actions';
    }).toBe(true);
    expect(dashboardReads).toBeGreaterThanOrEqual(2);
    const rebuilt = await readState();
    expect(rebuilt).toMatchObject({ formLoadFailures: 1, lastCandidate: null, group: { currentDate: '2027-01-01', applicantIds: ids },
      executor: { tabId, actionPending: false } });
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([flow]);
    expect((await worker.evaluate(() => (globalThis as any).__failureEvents)).filter((e: any) => e.event === 'workflow_failed')).toEqual([]);
    expect(await panel.evaluate(async () => ((await chrome.storage.local.get('analyticsV1')).analyticsV1 as AnalyticsRecord).session!.failed)).toBe(false);
    expect(posts).toBe(0);
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
