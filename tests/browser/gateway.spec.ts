import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineState } from '../../src/engine/workflow';

for (const { initial, single, bare, lost = false } of [{ initial: false, single: false, bare: false }, { initial: true, single: true, bare: true }, { initial: false, single: true, bare: true }, { initial: false, single: false, bare: false, lost: true }]) {
test(lost ? 'paid Start rebuilds after a lost dashboard Continue reply and resumes polling in the same tab' : initial ? 'paid unscheduled single-applicant Start follows the continue entry into the owned appointment form' : bare ? 'paid scheduled single-applicant Start keeps the warning and polls the bare appointment form' : 'paid Start advances the existing dashboard tab and promptly displays raw availability', async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-gateway-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  const base = '/en-ca/niv/schedule/11111111';
  const dashboardPath = '/en-ca/niv/groups/55555555';
  const ids = single ? ['77777777'] : ['77777777', '88888888'];
  let dayReads = 0;
  let bookingPosts = 0;
  let cancellationRequests = 0;
  let rosterChanged = false;
  let dashboardUnavailable = false;
  let warningCompleted = initial;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    if (lost) await worker.evaluate(() => {
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      let dropped = false;
      chrome.scripting.executeScript = (async (input: any) => {
        const request = input.args?.[0];
        if (!dropped && request && typeof request === 'object' && request.dashboardPath && Array.isArray(request.applicantIds) && !request.action) {
          dropped = true;
          try { await execute(input); } finally { throw new Error('Synthetic lost preliminary GET reply'); }
        }
        return execute(input);
      }) as typeof chrome.scripting.executeScript;
    });
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() === 'DELETE') { cancellationRequests++; await route.abort(); return; }
      if (request.method() === 'POST') { bookingPosts++; await route.abort(); return; }
      let body: string;
      if (url.pathname === '/en-ca/niv/') {
        await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${dashboardPath}');</script>` }); return;
      }
      if (url.pathname === dashboardPath) {
        if (dashboardUnavailable) {
          await route.fulfill({ status: 503, contentType: 'text/html', body: '<p>Synthetic temporary outage</p>' });
          return;
        }
        const baseline = initial ? `<p class="delivery"><a href="${base}/addresses/delivery">Delivery</a></p>` : `<p class="consular-appt">6 November, 2026 <a href="${base}/appointment">Appointment</a></p>`;
        const dashboardIds = rosterChanged ? [...ids, '88888888'] : ids;
        const siblings = !initial && !single ? `<section class="alert application card needs_payment"><h4 class="status">Pay Visa Fee</h4><ul class="actions"><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></ul><strong>44444444</strong></section>
          <section class="application card needs_courier_in success"><ul class="actions"><a href="/en-ca/niv/schedule/55555555/continue_actions">Continue</a></ul><strong>66666666</strong></section>
          <section class="application archived card"><table><tr><td><a href="/en-ca/niv/schedule/99999999/applicants/12345678">Details</a></td></tr></table><strong>87654321</strong></section>
          <section class="application card"><h4>Unreadable older application</h4></section>` : '';
        body = `<section class="application card ${initial ? 'ready_to_schedule' : 'attend_appointment success'}"><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><strong>22222222</strong>${baseline}<table><tbody>${dashboardIds.map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>${siblings}`;
      } else if (url.pathname === `${base}/continue_actions`) {
        const label = initial ? 'Schedule Appointment' : 'Reschedule Appointment';
        const cancellation = initial ? '' : `<a class="accordion-title" role="tab" aria-expanded="false" aria-controls="cancel">Cancel Appointment</a><div id="cancel" hidden><a class="button small primary small-only-expanded" data-method="delete" href="${base}/appointment">Cancel Appointment</a></div>`;
        body = `<a class="accordion-title" role="tab" aria-expanded="false" aria-controls="entry"><h5>${label}</h5></a><div id="entry" hidden><a class="button small primary small-only-expanded" href="${base}/${initial ? 'continue' : 'appointment'}">${label}</a></div>${cancellation}<script>document.querySelector('.accordion-title').onclick = () => { document.querySelector('.accordion-title').setAttribute('aria-expanded','true'); document.querySelector('#entry').hidden = false; }; const cancel = document.querySelector('#cancel a'); if (cancel) cancel.onclick = event => { event.preventDefault(); fetch('${base}/appointment', { method: 'DELETE' }); };</script>`;
      } else if (url.pathname === `${base}/continue` && initial) {
        // Synthetic client redirect keeps both navigations intercepted under
        // DNS isolation; following a mocked HTTP 302 escapes that interception.
        // User execution established a bare initial appointment landing;
        // this client redirect is only the synthetic transport simulation.
        await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${base}/appointment');</script>` });
        return;
      } else if (url.pathname === `${base}/appointment/days/95.json`) {
        dayReads++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ date: '2026-12-25' }, { date: '2026-11-19' }, { date: '2026-11-24' }]) });
        return;
      } else if (url.pathname === `${base}/appointment` && (url.searchParams.has('applicants[]') || (bare && !url.search && warningCompleted))) {
        body = `${bare ? `<form id="appointment-form" action="${base}/appointment" method="post"><input id="confirmed_limit_message" name="confirmed_limit_message" type="hidden" value="1">` : ''}<select id="appointments_consulate_appointment_facility_id"><option value="89">Calgary</option><option value="95">Vancouver</option></select><input id="appointments_consulate_appointment_date" readonly><select id="appointments_consulate_appointment_time"><option value=""></option></select>${bare ? '<input id="appointments_submit" type="submit" name="commit" value="Schedule Appointment" disabled></form>' : ''}`;
      } else if (url.pathname === `${base}/appointment` && url.searchParams.get('confirmed_limit_message') === '1') {
        warningCompleted = true;
        body = bare ? `<script>location.replace('${base}/appointment');</script>` : `<form method="get" action="${base}/appointment">${ids.map(id => `<input type="checkbox" name="applicants[]" value="${id}" checked>`).join('')}<input type="submit" name="commit" value="Continue"></form>`;
      } else if (url.pathname === `${base}/appointment`) {
        body = `<form method="get" action="${base}/appointment"><input type="checkbox" id="confirmed_limit_message" name="confirmed_limit_message" value="1"><input type="submit" name="commit" value="Continue"></form>`;
      } else { await route.abort(); return; }
      await route.fulfill({ contentType: 'text/html', body });
    });
    const dashboard = await context.newPage(); await dashboard.goto(`https://ais.usvisa-info.com${dashboardPath}`);
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.evaluate(async ({ initial, single }) => chrome.storage.local.set({ uiPreferencesV1: { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: initial ? '2027-01-01' : '2026-12-01', latest: initial ? '2027-01-31' : '2026-12-31', onlyEarlier: true, testMode: true, interval: 60, paidIvr: !initial && !single ? '' : '22222222', unpaidIvr: '' } }), { initial, single });
    await panel.reload();
    await panel.getByRole('button', { name: 'Booking', exact: true }).click();
    const ownedTabId = await panel.evaluate(async dashboardPath => (await chrome.tabs.query({})).find(tab => tab.url === `https://ais.usvisa-info.com${dashboardPath}`)!.id, dashboardPath);
    await panel.getByRole('button', { name: 'Start', exact: true }).click();
    if (lost) {
      await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState | undefined)?.entryRecoveryFailures)).toBe(1);
      const recovering = await panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      expect(recovering).toMatchObject({ status: 'running', intent: null, authentication: { dashboardFirst: true, phase: 'retry' }, executor: { actionPending: false } });
      expect(Date.parse(recovering.nextPollAt!)).toBeGreaterThan(Date.now());
      expect(bookingPosts).toBe(0); expect(cancellationRequests).toBe(0);
      await panel.evaluate(async () => {
        const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        await chrome.storage.local.set({ engineStateV1: { ...state, nextPollAt: new Date().toISOString() } });
        await chrome.alarms.create('enginePoll', { when: Date.now() });
      });
    }
    await expect.poll(async () => {
      const state = await panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      return { dayReads, url: dashboard.url(), status: state?.status, stage: state?.stage };
    }, { timeout: 15_000 }).toEqual({ dayReads: 1, url: bare ? `https://ais.usvisa-info.com${base}/appointment` : expect.stringContaining('/appointment?'), status: 'running', stage: null });
    if (!bare) await expect(dashboard).toHaveURL(/applicants/);
    expect(warningCompleted).toBe(true);
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([dashboard]);
    const state = await panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    expect(state).toMatchObject({ status: 'running', stage: null, lastCandidate: null, executor: { tabId: ownedTabId, applicantIds: ids }, group: { currentDate: initial ? null : '2026-11-06' } });
    await expect(panel.locator('h2', { hasText: 'Earliest Available' }).locator('..').locator('p')).toHaveText('Nov 19, 2026');
    await expect(panel.locator('[aria-label="2026-11-19, available"]')).toBeVisible();
    expect(bookingPosts).toBe(0);
    expect(cancellationRequests).toBe(0);
    if (bare) {
      const pollAgain = () => panel.evaluate(async () => {
        const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        await chrome.storage.local.set({ engineStateV1: { ...state, nextPollAt: new Date(Date.now() - 1_000).toISOString() } });
        await chrome.alarms.create('enginePoll', { when: Date.now() });
      });
      const checkedAt = await panel.evaluate(async () => ((await chrome.storage.local.get('engineObservationV1')).engineObservationV1 as { checkedAt: string }).checkedAt);
      dashboardUnavailable = true;
      await pollAgain();
      await expect.poll(() => panel.evaluate(async () => {
        const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        return { status: state.status, failures: state.consecutiveFailures };
      }), { timeout: 10_000 }).toEqual({ status: 'running', failures: 1 });
      const retry = await panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      expect(retry).toMatchObject({ stage: null, lastCandidate: null, intent: null,
        executor: { tabId: ownedTabId, applicantIds: ids, actionPending: false }, nextPollAt: expect.any(String) });
      const retryDelay = Date.parse(retry.nextPollAt!) - Date.parse(retry.updatedAt);
      expect(retryDelay).toBeGreaterThanOrEqual(60_000);
      expect(retryDelay).toBeLessThanOrEqual(90_000);
      expect(dayReads).toBe(1);
      expect(await panel.evaluate(async () => ((await chrome.storage.local.get('engineObservationV1')).engineObservationV1 as { checkedAt: string }).checkedAt)).toBe(checkedAt);
      await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      expect(bookingPosts).toBe(0);
      dashboardUnavailable = false;
      await pollAgain();
    await expect.poll(() => dayReads, { timeout: 10_000 }).toBe(2);
      await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).consecutiveFailures)).toBe(0);
      rosterChanged = true;
      await pollAgain();
      await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).status), { timeout: 10_000 }).toBe('verifying');
      expect(dayReads).toBe(2); expect(bookingPosts).toBe(0);
      await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
    } else await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
}
