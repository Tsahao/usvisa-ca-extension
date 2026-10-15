import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';
import { installPortalCalendar } from '../fixtures/portal-calendar';

// Measure only eligible days response -> booking POST, on natural worker
// timing. All portal traffic is synthetic and the real origin is DNS-blocked.
for (const scenario of ['gated', 'direct', 'test-gated', 'test-direct', 'stop-dialog', 'settings-dialog',
  'gated-switch', 'direct-switch', 'slow-switch', 'stop-switch'] as const) {
  test(`matched candidate advances without fixed field/confirmation waits (${scenario})`, async ({}, testInfo) => {
    test.setTimeout(25_000);
    const gated = !scenario.includes('direct');
    const testMode = scenario.startsWith('test-');
    const interruption = scenario.endsWith('-dialog');
    const switchConsulate = scenario.endsWith('-switch');
    const facilityDelay = scenario === 'slow-switch' ? 3200 : scenario === 'stop-switch' ? 1800 : 250;
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-booking-speed-'));
    const extensionPath = path.resolve('dist-test');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
    const dashboardPath = '/en-ca/niv/groups/55555555';
    let matchedAt = 0;
    let postedAt = 0;
    let posts = 0;
    let daysReads = 0;
    let timesReads = 0;
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await context.route('https://ais.usvisa-info.com/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'POST') {
          posts++; postedAt = Date.now();
          await route.fulfill({ contentType: 'text/plain', body: 'synthetic acceptance' });
        } else if (url.pathname === dashboardPath) {
          await route.fulfill({ contentType: 'text/html', body: `<section><strong>22222222</strong><p class="consular-appt">January 1, 2027<a href="${base}/appointment">Appointment</a></p><table><tbody>${['77777777', '88888888'].map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>` });
        } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment/days/95.json') {
          daysReads++; matchedAt = Date.now();
          await route.fulfill({ contentType: 'application/json', body: '[{"date":"2026-11-19"}]' });
        } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment/times/95.json') {
          timesReads++;
          await route.fulfill({ contentType: 'application/json', body: '{"available_times":["09:15"],"business_times":["09:15"]}' });
        } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment') {
          await route.fulfill({ contentType: 'text/html', body: `<form id="appointment-form" method="post" action="${base}/appointment">
            <select id="appointments_consulate_appointment_facility_id">${switchConsulate ? '<option value="94">Toronto</option>' : ''}<option value="95">Vancouver</option></select>
            <input id="appointments_consulate_appointment_date" readonly>
            <select id="appointments_consulate_appointment_time"><option value=""></option></select>
            <input id="confirmed_limit_message" name="confirmed_limit_message" type="checkbox" value="1">
            <span id="non-consulate-business-day-message" hidden>Non-business day</span>
            <input id="appointments_submit" type="submit" value="Reschedule"></form>
            <script>
            const button = document.querySelector('#appointments_submit');
            button.dataset.clicks = '0';
            ${gated ? `button.setAttribute('data-confirm', JSON.stringify({title:'Confirm this appointment?',ok:'Confirm',cancel:'Cancel'}));` : ''}
            document.querySelector('form').onsubmit = event => {
              event.preventDefault(); button.dataset.clicks = String(Number(button.dataset.clicks) + 1);
              if (${gated}) {
                button.dataset.opening = 'true';
                setTimeout(() => {
                  document.body.insertAdjacentHTML('beforeend', '<div class="reveal-overlay"><div data-reveal><h4>Confirm this appointment?</h4><a class="button alert" href="#" aria-disabled="true">Confirm</a></div></div>');
                  const confirm = document.querySelector('.button.alert');
                  confirm.onclick = event => { event.preventDefault(); fetch('${base}/appointment', {method:'POST'}); };
                  setTimeout(() => confirm.removeAttribute('aria-disabled'), 200);
                }, ${interruption ? 1800 : 300});
              } else fetch('${base}/appointment', {method:'POST'});
            };
            </script>` });
        } else await route.abort();
      });
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      const host = await context.newPage();
      await host.goto(`${base}/appointment?applicants[]=77777777&applicants[]=88888888`);
      await host.evaluate(installPortalCalendar, { times: ['09:15'], delay: 300, facilityDelay });
      const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
        onlyEarlier: true, testMode, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
      await panel.evaluate(async prefs => {
        await chrome.storage.local.set({ uiPreferencesV1: prefs });
        await chrome.runtime.sendMessage({ type: 'PANEL_STOP' });
      }, prefs);
      const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, host.url());
      const now = new Date().toISOString();
      const args = { owner: 'speed-owner-01', runId: 'speed-run-0001', now };
      const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', dashboardPath, applicantIds: ['77777777', '88888888'] } }),
        policyKey: policyKey(prefs), nextPollAt: now,
        executor: { tabId, applicantIds: ['77777777', '88888888'], targetTime: null, skippedDates: [], actionPending: false } };
      await panel.evaluate(async state => {
        await chrome.storage.local.set({ engineStateV1: state });
        await chrome.alarms.create('enginePoll', { when: Date.now() });
      }, state);
      const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      if (scenario === 'stop-switch') {
        await expect(host.locator('#appointments_consulate_appointment_facility_id')).toHaveValue('95');
        expect((await read()).executor?.actionPending).toBe(true);
        await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
        expect(await read()).toMatchObject({ status: 'stopped', intent: null });
        expect(posts).toBe(0);
        expect(timesReads).toBe(0);
        await expect(host.locator('#appointments_consulate_appointment_time')).toHaveValue('');
      } else if (interruption) {
        await expect(host.locator('#appointments_submit')).toHaveAttribute('data-opening', 'true');
        if (scenario === 'stop-dialog') {
          await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
        } else {
          await panel.evaluate(async () => {
            const { uiPreferencesV1: prefs } = await chrome.storage.local.get('uiPreferencesV1');
            await chrome.storage.local.set({ uiPreferencesV1: { ...(prefs as Record<string, unknown>), testMode: true } });
          });
        }
        await expect(host.locator('.button.alert')).not.toHaveAttribute('aria-disabled', 'true');
        await expect.poll(async () => (await read()).status).toBe('verifying');
        expect(posts).toBe(0);
        expect((await read()).intent?.phase).toBe('submitted');
      } else if (testMode) {
        await expect.poll(async () => (await read()).stage).toBe('done');
        expect(await read()).toMatchObject({ intent: null, verification: null });
        await expect(host.locator('#appointments_submit')).toHaveAttribute('data-clicks', '0');
        expect(posts).toBe(0);
        await expect(host.locator('.reveal-overlay')).toHaveCount(0);
      } else {
        await expect.poll(() => posts, { timeout: 7000 }).toBe(1);
        const elapsedMs = postedAt - matchedAt;
        expect(elapsedMs).toBeGreaterThanOrEqual((gated ? 800 : 300) + (switchConsulate ? facilityDelay : 0));
        // Even the old direct path has 8s of fixed waits in this warning
        // fixture. This threshold catches their return without precision timing.
        expect(elapsedMs).toBeLessThan(scenario === 'slow-switch' ? 5500 : switchConsulate ? 2200 : 3000);
        console.log(`synthetic ${scenario}: matched-date response -> booking POST ${elapsedMs}ms`);
        await testInfo.attach('synthetic-timing.json', { body: JSON.stringify({ scenario, elapsedMs }), contentType: 'application/json' });
        await expect.poll(async () => (await read()).status).toBe('verifying');
        const verified = await read();
        expect(Date.parse(verified.verification!.nextReadAt!) - postedAt).toBeGreaterThanOrEqual(29_000);
      }
      expect(daysReads).toBe(1);
      if (scenario !== 'stop-switch') {
        expect(timesReads).toBe(1);
        await expect(host.locator('#appointments_consulate_appointment_time')).toHaveValue('09:15');
      }
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}
