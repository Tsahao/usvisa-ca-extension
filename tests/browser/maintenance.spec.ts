import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';

for (const scenario of ['renewal', 'booking-form', 'alerts', 'verification'] as const) {
  test(`packaged maintenance recovery preserves ${scenario} custody and verification`, async () => {
    test.setTimeout(45_000);
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-maintenance-fixture-'));
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${path.resolve('dist-test')}`, `--load-extension=${path.resolve('dist-test')}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    const site = 'https://ais.usvisa-info.com'; const base = '/en-ca/niv/schedule/11111111'; const dashboardPath = '/en-ca/niv/groups/55555555';
    let healthy = false; let loginPosts = 0; let bookingPosts = 0; let signInGets = 0; let dashboardReads = 0; let dayReads = 0;
    const outage = '<title>Under construction (503)</title><div class="construction-background"><h1>Doing Maintenance</h1><p>Our website is down for planned maintenance.</p></div>';
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const id = new URL(worker.url()).host;
      await worker.evaluate(() => { chrome.notifications.create = async () => 'synthetic-notification'; });
      await context.route(`${site}/**`, async route => {
        const req = route.request(); const url = new URL(req.url());
        if (req.method() !== 'GET') {
          if (url.pathname === '/en-ca/niv/users/sign_in' && scenario === 'renewal') {
            loginPosts++; await route.fulfill({ status: 302, headers: { location: '/en-ca/niv/account' }, body: '' });
          } else { bookingPosts++; await route.abort(); }
          return;
        }
        if (url.pathname === '/en-ca/niv/users/sign_in') {
          signInGets++;
          await route.fulfill({ contentType: 'text/html', body: healthy ? `<script>location.replace('${dashboardPath}')</script>` :
            '<form id="sign_in_form" method="post" action="/en-ca/niv/users/sign_in"><input id="user_email" name="user[email]" type="email"><input id="user_password" name="user[password]" type="password"><input id="policy_confirmed" type="checkbox"><input type="submit" value="Sign In"></form>' });
        } else if (url.pathname === '/en-ca/niv/account') {
          await route.fulfill({ status: 503, contentType: 'text/html', body: outage });
        } else if (url.pathname === dashboardPath) {
          dashboardReads++;
          const status = scenario === 'alerts' ? 'needs_payment' : 'ready_to_schedule';
          await route.fulfill({ contentType: 'text/html', body: `<section class="application card ${status}"><strong>22222222</strong>${scenario === 'alerts' ? '<h4 class="status">Pay Visa Fee</h4>' : ''}<ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><table><tr><td><a href="${base}/applicants/77777777">Details</a></td></tr></table></section>` });
        } else if (url.pathname === `${base}/continue_actions`) {
          await route.fulfill({ contentType: 'text/html', body: `<a class="accordion-title" role="tab" aria-expanded="false" aria-controls="entry"><h5>Schedule Appointment</h5></a><div id="entry" hidden><a class="button small primary small-only-expanded" href="${base}/continue">Schedule Appointment</a></div><script>document.querySelector('.accordion-title').onclick=()=>{document.querySelector('.accordion-title').setAttribute('aria-expanded','true');document.querySelector('#entry').hidden=false}</script>` });
        } else if (url.pathname === `${base}/continue`) {
          await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${base}/appointment')</script>` });
        } else if (url.pathname === `${base}/appointment`) {
          await route.fulfill({ status: !healthy && scenario === 'booking-form' ? 503 : 200, contentType: 'text/html', body: !healthy && scenario === 'booking-form' ? outage :
            `<form id="appointment-form" method="post" action="${base}/appointment"><select id="appointments_consulate_appointment_facility_id"><option value="">Select</option><option value="95">Vancouver</option></select><input id="appointments_consulate_appointment_date" readonly><select id="appointments_consulate_appointment_time"><option value=""></option></select><input type="submit" id="appointments_submit" value="Schedule Appointment" disabled></form>` });
        } else if (url.pathname === `${base}/appointment/days/95.json`) {
          dayReads++; await route.fulfill({ contentType: 'application/json', body: '[{"date":"2027-04-16"}]' });
        } else if (url.pathname === `${base}/payment`) {
          await route.fulfill({ status: healthy ? 200 : 503, contentType: 'text/html', body: !healthy ? outage :
            '<section><h2>First Available Appointments</h2><table>' + ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver'].map(city => `<tr><td>${city}</td><td>April 16, 2027</td></tr>`).join('') + '</table></section>' });
        } else await route.abort();
      });
      const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html`);
      const flow = await context.newPage();
      await flow.goto(site + (scenario === 'alerts' ? `${base}/payment` : scenario === 'verification' ? '/en-ca/niv/account' : `${base}/appointment`));
      const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)!.id!, flow.url());
      const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false, interval: 60, paidIvr: scenario === 'alerts' ? '' : '22222222', unpaidIvr: scenario === 'alerts' ? '22222222' : '' };
      const now = new Date().toISOString(); const args = { now, owner: 'outage-owner-01', runId: 'outage-run-0001' };
      let state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: scenario === 'alerts' ? 'alerts' : 'booking' }), { ...args,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: scenario === 'alerts' ? 'unpaid' : 'paid', currentDate: null, dashboardPath, ...(scenario === 'alerts' ? {} : { applicantIds: ['77777777'] }) } }),
        policyKey: policyKey(prefs), nextPollAt: now, monitorTabId: scenario === 'alerts' ? tabId : null,
        executor: scenario === 'alerts' ? null : { tabId, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false } };
      if (scenario === 'renewal') state = { ...state, startedAt: new Date(Date.now() - 3600_001).toISOString() };
      if (scenario === 'booking-form') state = { ...state, stage: 'form', lastCandidate: { date: '2026-11-19', consulate: 'Vancouver' } };
      if (scenario === 'verification') state = { ...state, status: 'verifying', stage: 'done', nextPollAt: null,
        verificationTabId: tabId, verification: { reads: [], nextReadAt: now }, intent: { runId: args.runId, mode: 'booking', groupId: '11111111',
          targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: new Date(Date.now() - 31_000).toISOString() } };
      await panel.evaluate(async ({ prefs, state }) => {
        await chrome.storage.local.set({ uiPreferencesV1: prefs }); await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
        await chrome.storage.local.set({ engineStateV1: state }); await chrome.alarms.create('enginePoll', { when: Date.now() });
      }, { prefs, state });
      const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      await expect.poll(async () => (await read()).authentication?.phase, { timeout: 15_000 }).toBe('retry');
      const waiting = await read();
      expect(waiting).toMatchObject({ status: scenario === 'verification' ? 'verifying' : 'running', consecutiveFailures: 1, loginFailed: false,
        authentication: { maintenanceRecovery: true, tabId, purpose: scenario === 'verification' ? 'verify' : 'renew' } });
      expect(waiting.intent).toEqual(state.intent); expect(waiting.lastCandidate).toBeNull();
      expect(Date.parse(waiting.nextPollAt!) - Date.parse(waiting.updatedAt)).toBeGreaterThanOrEqual(60_000);
      expect(dashboardReads).toBe(0); expect(bookingPosts).toBe(0); expect(loginPosts).toBe(scenario === 'renewal' ? 1 : 0);
      healthy = true;
      // Advance only the synthetic durable wait, never the real owner's run.
      await panel.evaluate(async () => {
        const s = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        await chrome.storage.local.set({ engineStateV1: { ...s, nextPollAt: new Date().toISOString() } });
        await chrome.alarms.create('enginePoll', { when: Date.now() });
      });
      await expect.poll(async () => (await read()).authentication, { timeout: 12_000 }).toBeNull();
      const recovered = await read(); expect(recovered.group).toMatchObject(state.group!);
      expect(recovered.status, JSON.stringify(await panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'ENGINE_DIAGNOSTICS' })).diagnostics.entries.slice(0, 8)))).toBe(scenario === 'verification' ? 'verifying' : 'running');
      if (scenario === 'verification') {
        expect(recovered.intent).toEqual(state.intent); expect(recovered.verificationTabId).toBe(tabId);
      } else if (scenario === 'alerts') {
        await expect(flow).toHaveURL(site + `${base}/payment`); expect(recovered.monitorTabId).toBe(tabId);
      } else {
        await expect.poll(async () => dayReads, { timeout: 15_000 }).toBeGreaterThan(0);
        expect(await read()).toMatchObject({ status: 'running', stage: null, intent: null, executor: { tabId, applicantIds: ['77777777'] } });
      }
      expect(dashboardReads).toBeGreaterThan(0); expect(signInGets).toBe(scenario === 'renewal' ? 2 : 1);
      expect(bookingPosts).toBe(0); expect(context.pages().filter(p => p.url().startsWith(site))).toEqual([flow]);
      const logs = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'ENGINE_DIAGNOSTICS' })).diagnostics.entries);
      expect(logs.some((e: { code: string }) => e.code === 'auth-terminal')).toBe(false);
      await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STOP' }); });
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}
