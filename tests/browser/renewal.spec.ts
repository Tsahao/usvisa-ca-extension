import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';

test('packaged unpaid renewal keeps its owned tab instead of adopting a duplicate summary', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-unpaid-renewal-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  const base = '/en-ca/niv/schedule/11111111'; const dashboardPath = '/en-ca/niv/groups/55555555';
  let signInGets = 0; let posts = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    // No fixture can create an external notification.
    await worker.evaluate(() => { chrome.notifications.create = async () => 'synthetic-notification'; });
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() !== 'GET') { posts++; await route.abort(); return; }
      let body: string;
      if (url.pathname === '/en-ca/niv/users/sign_in') {
        signInGets++; body = `<script>location.replace('${dashboardPath}');</script>`;
      } else if (url.pathname === dashboardPath) {
        body = `<section class="application card needs_payment"><strong>22222222</strong><h4 class="status">Pay Visa Fee</h4><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul></section>`;
      } else if (url.pathname === `${base}/payment`) body = '<p>Synthetic summary pending</p>';
      else { await route.abort(); return; }
      await route.fulfill({ contentType: 'text/html', body });
    });
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const flow = await context.newPage(); await flow.goto(`https://ais.usvisa-info.com${base}/payment`);
    const duplicate = await context.newPage(); await duplicate.goto(flow.url());
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, flow.url());
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false, interval: 60, paidIvr: '', unpaidIvr: '22222222' };
    const now = new Date().toISOString(); const args = { now, owner: 'renewal-owner-02', runId: 'renewal-run-0002' };
    const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'alerts' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'unpaid', currentDate: null, dashboardPath } }),
      policyKey: policyKey(prefs), monitorTabId: tabId, startedAt: new Date(Date.now() - 3600_001).toISOString(), nextPollAt: now,
      alert: { observed: '2027-04-16', delivered: '2027-04-16', pending: false } };
    await panel.evaluate(async ({ prefs, state }) => {
      await chrome.storage.local.set({ uiPreferencesV1: prefs });
      await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
      await chrome.storage.local.set({ engineStateV1: state });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    }, { prefs, state });
    const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    await expect.poll(async () => ({ signInGets, authentication: (await read()).authentication }), { timeout: 12_000 })
      .toEqual({ signInGets: 1, authentication: null });
    await expect(flow).toHaveURL(`https://ais.usvisa-info.com${base}/payment`);
    expect(await read()).toMatchObject({ status: 'running', sessionRenewals: 0, monitorTabId: tabId, alert: state.alert });
    expect(duplicate.isClosed()).toBe(false);
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([flow, duplicate]);
    expect(posts).toBe(0);
    await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STOP' }); });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

for (const dashboardHandoff of [false, true]) {
test(`packaged hourly renewals retain one tab and recover a ${dashboardHandoff ? 'dashboard handoff 502 through Continue and gateways' : 'bare-form re-entry 503'}`, async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-renewal-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  const base = '/en-ca/niv/schedule/11111111';
  const dashboardPath = '/en-ca/niv/groups/55555555';
  let signInGets = 0; let posts = 0; let dayReads = 0; let reentryFailures = 0; let continues = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() !== 'GET') { posts++; await route.abort(); return; }
      if (url.pathname === '/en-ca/niv/users/sign_in') {
        signInGets++;
        await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${dashboardPath}');</script>` });
      } else if (url.pathname === dashboardPath) {
        if (request.resourceType() === 'fetch' && reentryFailures > 0) {
          reentryFailures--;
          await route.fulfill({ status: dashboardHandoff ? 502 : 503, contentType: 'text/plain', body: 'Synthetic temporary outage' }); return;
        }
        await route.fulfill({ contentType: 'text/html', body: `<section class="application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><table><tbody><tr><td><a href="${base}/applicants/77777777">Details</a></td></tr></tbody></table></section>` });
      } else if (url.pathname === `${base}/continue_actions`) {
        continues++;
        await route.fulfill({ contentType: 'text/html', body: `<a class="accordion-title" role="tab" aria-expanded="false" aria-controls="entry"><h5>Schedule Appointment</h5></a><div id="entry" hidden><a class="button small primary small-only-expanded" href="${base}/continue">Schedule Appointment</a></div><script>document.querySelector('.accordion-title').onclick = () => { document.querySelector('.accordion-title').setAttribute('aria-expanded','true'); document.querySelector('#entry').hidden = false; };</script>` });
      } else if (url.pathname === `${base}/continue`) {
        await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${base}/appointment');</script>` });
      } else if (url.pathname === `${base}/appointment`) {
        await route.fulfill({ contentType: 'text/html', body: `<form id="appointment-form" method="post" action="${base}/appointment"><select id="appointments_consulate_appointment_facility_id"><option value="">Select</option><option value="95">Vancouver</option></select><input id="appointments_consulate_appointment_date" readonly><select id="appointments_consulate_appointment_time"><option value=""></option></select><input type="submit" id="appointments_submit" value="Schedule Appointment" disabled></form>` });
      } else if (url.pathname === `${base}/appointment/days/95.json`) {
        dayReads++;
        await route.fulfill({ contentType: 'application/json', body: '[{"date":"2027-04-16"}]' });
      } else await route.abort();
    });
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const flow = await context.newPage(); await flow.goto(`https://ais.usvisa-info.com${base}/appointment`);
    const unrelated = await context.newPage(); await unrelated.goto('about:blank');
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, flow.url());
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    const now = new Date().toISOString(); const args = { now, owner: 'renewal-owner-01', runId: 'renewal-run-0001' };
    let state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, dashboardPath, applicantIds: ['77777777'] } }),
      policyKey: policyKey(prefs), executor: { tabId, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false } };
    await panel.evaluate(async prefs => { await chrome.storage.local.set({ uiPreferencesV1: prefs }); }, prefs);
    const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    const saveAndWake = (state: EngineState) => panel.evaluate(async state => {
      await chrome.storage.local.set({ engineStateV1: state });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    }, state);
    for (let cycle = 0; cycle < 6; cycle++) {
      state = { ...state, startedAt: new Date(Date.now() - 3600_001).toISOString(), nextPollAt: new Date(Date.now() - 1_000).toISOString() };
      await saveAndWake(state);
      await expect.poll(async () => ({ signInGets, authentication: (await read()).authentication }), { timeout: 12_000 })
        .toEqual({ signInGets: cycle + 1, authentication: null });
      state = await read();
      expect(state).toMatchObject({ status: 'running', sessionRenewals: 0, stage: 'actions', intent: null, executor: { tabId, actionPending: false } });
      expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([flow]);
      expect(unrelated.url()).toBe('about:blank'); expect(posts).toBe(0);
    }
    // The dashboard variant continues the actual renewed run through the
    // formerly uncovered fresh-baseline read, Continue and the full gateway.
    // The bare-form variant independently retains the previous regression.
    if (!dashboardHandoff) {
      await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STOP' }); });
      await flow.goto(`https://ais.usvisa-info.com${base}/appointment`);
      state = { ...state, owner: 'reentry-owner-01', runId: 'reentry-run-0001', generation: state.generation + 1 };
    }
    reentryFailures = 1;
    await saveAndWake({ ...state, stage: dashboardHandoff ? 'actions' : 'warning', nextPollAt: new Date(Date.now() - 1000).toISOString() });
    await expect.poll(async () => (await read()).consecutiveFailures).toBe(1);
    state = await read();
    expect(state).toMatchObject({ status: 'running', stage: dashboardHandoff ? 'actions' : 'warning', intent: null, executor: { tabId, actionPending: false } });
    if (dashboardHandoff) await expect(flow).toHaveURL(`https://ais.usvisa-info.com${dashboardPath}`);
    expect(continues).toBe(0);
    expect(Date.parse(state.nextPollAt!) - Date.parse(state.updatedAt)).toBeGreaterThanOrEqual(60_000);
    expect(dayReads).toBe(0); expect(posts).toBe(0);
    await saveAndWake({ ...state, nextPollAt: new Date(Date.now() - 1000).toISOString() });
    await expect.poll(async () => ({ stage: (await read()).stage, dayReads }), { timeout: 15_000 }).toEqual({ stage: null, dayReads: 1 });
    expect(await read()).toMatchObject({ status: 'running', consecutiveFailures: 0, sessionRenewals: 0, lastCandidate: null, intent: null, executor: { tabId } });
    expect(posts).toBe(0); expect(continues).toBe(dashboardHandoff ? 1 : 0);
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([flow]);
    await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STOP' }); });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
}
