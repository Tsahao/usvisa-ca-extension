import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';
import { installPortalCalendar } from '../fixtures/portal-calendar';

test('packaged worker refreshes stale calendar state in MAIN before choosing a time', async () => {
  test.setTimeout(40_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-calendar-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
  const dashboardPath = '/en-ca/niv/groups/55555555';
  let bookingPosts = 0;
  let timesReads = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() === 'POST') { bookingPosts++; await route.abort(); return; }
      if (url.pathname === dashboardPath) {
        await route.fulfill({ contentType: 'text/html', body: `<section><strong>22222222</strong><p class="consular-appt">January 1, 2027<a href="${base}/appointment">Appointment</a></p><table><tbody>${['77777777', '88888888'].map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>` });
      } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment/times/95.json') {
        timesReads++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available_times: ['10:45'], business_times: ['10:45'] }) });
      } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment') {
        await route.fulfill({ contentType: 'text/html', body: `<form id="appointment-form" method="post" action="${base}/appointment">
          <select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select>
          <input id="appointments_consulate_appointment_date" value="2026-11-19" readonly>
          <select id="appointments_consulate_appointment_time"><option value=""></option><option value="10:45">10:45</option></select>
          <input id="appointments_submit" type="submit" value="Reschedule" data-confirm="malformed-fixture-gate">
          <span id="non-consulate-business-time-message" hidden>Non-business time</span></form>` });
      } else await route.abort();
    });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const host = await context.newPage();
    await host.goto(`${base}/appointment?applicants[]=77777777&applicants[]=88888888`);
    await host.evaluate(installPortalCalendar, { times: ['10:45'], delay: 4_000 });
    await host.selectOption('#appointments_consulate_appointment_time', '10:45');
    await expect(host.locator('#non-consulate-business-time-message')).toBeVisible();
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, host.url());
    // Candidate preparation belongs to Auto Mode ON. The intentionally
    // malformed final gate keeps this calendar-only fixture from submitting.
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, autoMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    // Let the configuration-change handler finish before installing a run;
    // changing preferences on an active run correctly parks it for review.
    await panel.evaluate(async prefs => {
      await chrome.storage.local.set({ uiPreferencesV1: prefs });
      await chrome.runtime.sendMessage({ type: 'PANEL_STOP' });
    }, prefs);
    const now = new Date().toISOString();
    const args = { owner: 'browser-owner-01', runId: 'browser-run-0001', now };
    const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', dashboardPath, applicantIds: ['77777777', '88888888'] } }),
      stage: 'form', lastCandidate: '2026-11-19', policyKey: policyKey(prefs), nextPollAt: now,
      executor: { tabId, applicantIds: ['77777777', '88888888'], targetTime: null, skippedDates: [], actionPending: false } };
    await panel.evaluate(async state => {
      await chrome.storage.local.set({ engineStateV1: state });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    }, state);
    const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    await expect.poll(async () => {
      const current = await read();
      return { status: current.status, stage: current.stage, pending: current.executor?.actionPending };
    }).toEqual({ status: 'running', stage: 'form', pending: true });
    expect(timesReads).toBe(0);
    await expect(host.locator('#appointments_consulate_appointment_date')).not.toHaveAttribute('data-usvisa-calendar-slot');
    await expect.poll(async () => (await read()).status, { timeout: 15_000 }).toBe('verifying');
    expect(await read()).toMatchObject({ intent: { phase: 'prepared', testMode: false }, stage: 'done', executor: { actionPending: true, targetTime: '10:45' } });
    await expect(host.locator('#appointments_consulate_appointment_date')).toHaveAttribute('data-usvisa-calendar-slot', '95|2026-11-19');
    await expect(host.locator('#appointments_consulate_appointment_time')).toHaveValue('10:45');
    await expect(host.locator('#non-consulate-business-time-message')).toBeHidden();
    expect(timesReads).toBe(1);
    expect(bookingPosts).toBe(0);
    await expect(host.locator('.reveal-overlay')).toHaveCount(0);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
