import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';

for (const testMode of [true, false]) {
  test(`packaged guarded submission and separate verification (Test Mode ${testMode})`, async () => {
    test.setTimeout(60_000);
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-booking-fixture-'));
    const extensionPath = path.resolve('dist-test');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    let confirmed = 0;
    let dashboardReads = 0;
    let genericDashboardReads = 0;
    const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
    const dashboardPath = '/en-ca/niv/groups/55555555';
    const dashboardUrl = `https://ais.usvisa-info.com${dashboardPath}`;
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 5000 });
      const extensionId = new URL(worker.url()).host;
      await context.route('https://ais.usvisa-info.com/**', async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.pathname === '/en-ca/niv/groups') {
          genericDashboardReads++;
          await route.fulfill({ status: 302, headers: { location: dashboardPath } });
        } else if (url.pathname === dashboardPath) {
          dashboardReads++;
          await route.fulfill({ contentType: 'text/html', body: `<section><strong>22222222</strong><p class="consular-appt">${confirmed ? 'November 19, 2026' : 'January 1, 2027'}<a href="${base}/appointment">Appointment</a></p><table><tbody>${['77777777', '88888888'].map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>` });
        } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment' && request.method() === 'POST') {
          confirmed++;
          await route.fulfill({ contentType: 'text/plain', body: 'synthetic acceptance' });
        } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment') {
          await route.fulfill({ contentType: 'text/html', body: `<form id="appointment-form" method="post" action="${base}/appointment">
            <select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select>
            <input id="appointments_consulate_appointment_date" value="2026-11-19" readonly data-usvisa-calendar-slot="95|2026-11-19">
            <select id="appointments_consulate_appointment_time"><option value="08:00">08:00</option></select>
            <input type="submit" name="commit" value="Reschedule" id="appointments_submit" data-confirm="{&quot;title&quot;:&quot;Are you sure you want to reschedule the appointment?&quot;,&quot;ok&quot;:&quot;Confirm&quot;,&quot;cancel&quot;:&quot;Cancel&quot;}" data-disable-with="Please wait..." class="button primary"></form>
            <script>const button = document.querySelector('#appointments_submit'); button.dataset.fixtureClicks = '0'; button.addEventListener('click', () => { button.dataset.fixtureClicks = String(Number(button.dataset.fixtureClicks) + 1); }); document.querySelector('form').onsubmit = event => { event.preventDefault(); document.body.insertAdjacentHTML('beforeend', '<div class="reveal-overlay"><div data-reveal><h4>Are you sure you want to reschedule the appointment?</h4><a class="button alert" href="#">Confirm</a></div></div>'); document.querySelector('a').onclick = event => { event.preventDefault(); fetch('${base}/appointment', { method: 'POST' }); }; };</script>` });
        } else await route.abort();
      });
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      const host = await context.newPage();
      await host.goto(`${base}/appointment?applicants[]=77777777&applicants[]=88888888`);
      const dashboard = await context.newPage();
      await dashboard.goto(dashboardUrl);
      const dashboardTabId = await panel.evaluate(async dashboardUrl => (await chrome.tabs.query({})).find(tab => tab.url === dashboardUrl)!.id!, dashboardUrl);
      await worker.evaluate(tabId => {
        chrome.tabs.create = async options => {
          if (options.url !== 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in') throw new Error('Unexpected fixture navigation.');
          return chrome.tabs.get(tabId);
        };
      }, dashboardTabId);
      const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
        onlyEarlier: true, testMode, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
      await panel.evaluate(async prefs => { await chrome.storage.local.set({ uiPreferencesV1: prefs }); }, prefs);
      const started = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'booking' }));
      expect(started).toMatchObject({ ok: true, snapshot: { status: 'running', currentDate: '2027-01-01' } });
      expect(await panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState))
        .toMatchObject({ group: { dashboardPath, applicantIds: ['77777777', '88888888'] } });
      await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
      const tabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('applicants[]=77777777'))!.id!);
      const now = new Date().toISOString();
      const args = { owner: 'browser-owner-01', runId: 'browser-run-0001', now };
      const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', dashboardPath, applicantIds: ['77777777', '88888888'] } }),
        stage: 'form', lastCandidate: { date: '2026-11-19', consulate: 'Vancouver' }, policyKey: policyKey(prefs), nextPollAt: now,
        executor: { tabId, applicantIds: ['77777777', '88888888'], targetTime: '08:00', skippedDates: [], actionPending: false } };
      await panel.evaluate(async state => { await chrome.storage.local.set({ engineStateV1: state }); }, state);
      const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      const advance = async () => {
        await panel.evaluate(async () => {
          const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
          const now = new Date(Date.now() - 1000).toISOString();
          state.nextPollAt = now;
          if (state.verification) state.verification.nextReadAt = now;
          await chrome.storage.local.set({ engineStateV1: state });
          await chrome.alarms.create('enginePoll', { when: Date.now() });
        });
        await expect.poll(async () => {
          const state = await read();
          return state.status === 'stopped' || (!state.authentication?.pending && !state.executor?.actionPending &&
            Date.parse(state.authentication ? state.nextPollAt! : state.status === 'verifying' ? state.verification?.nextReadAt ?? '' : state.nextPollAt!) > Date.now());
        }).toBe(true);
      };
      if (testMode) {
        // Legacy Test Mode ON is Auto Mode OFF: it never submits a candidate
        // and continues monitoring without intent or verification reads.
        await panel.evaluate(async () => {
          const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
          state.nextPollAt = new Date(Date.now() - 1000).toISOString();
          await chrome.storage.local.set({ engineStateV1: state });
          await chrome.alarms.create('enginePoll', { when: Date.now() });
        });
        await expect.poll(async () => {
          const state = await read();
          return state.status === 'running' && state.stage === null && !state.executor?.actionPending;
        }).toBe(true);
        expect(await read()).toMatchObject({ status: 'running', stage: null, intent: null, verification: null });
        await expect(host.locator('#appointments_submit')).toHaveAttribute('data-fixture-clicks', '0');
        expect(await host.locator('.reveal-overlay .button.alert').count()).toBe(0);
        expect(confirmed).toBe(0);
        return;
      }
      await advance();
      await expect(host.locator('#appointments_submit')).toHaveAttribute('data-fixture-clicks', '1');
      await expect(host.locator('.reveal-overlay .button.alert')).toBeVisible();
      await expect.poll(() => confirmed).toBe(1);
      expect(await read()).toMatchObject({ status: 'verifying', intent: { phase: 'confirming' } });
      for (let cycle = 0; cycle < 8 && (await read()).status !== 'stopped'; cycle++) {
        await advance();
        if ((await read()).authentication?.tabId !== null && (await read()).authentication) {
          await expect.poll(() => context.pages().some(page => page.url() === dashboardUrl)).toBe(true);
          await context.pages().find(page => page.url() === dashboardUrl)!.waitForLoadState('load');
        }
      }
      expect(await read()).toMatchObject({ status: 'stopped', intent: null });
      await expect.poll(() => dashboard.isClosed()).toBe(true);
      expect(host.isClosed()).toBe(false);
      expect(confirmed).toBe(1);
      expect(dashboardReads).toBeGreaterThanOrEqual(6);
      expect(genericDashboardReads).toBe(0);
      const success = await panel.evaluate(async () => (await chrome.storage.local.get('engineSuccessV1')).engineSuccessV1);
      expect(success).toMatchObject({ runId: args.runId, date: '2026-11-19' });
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}
