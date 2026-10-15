import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';

// User-authorized direct submission (October 15, 2026, for the no-gate case
// only): Test Mode OFF clicks the validated initial Schedule submit with a
// fully absent gate. The direct POST proceeds with no recognized dialog, so
// the confirm stage finds nothing to confirm and routes into fresh
// dashboard verification without replaying the click. A present-but-malformed
// gate refuses without clicking (unit + executor regressions).
for (const testMode of [true, false]) {
  test(`packaged direct initial submission without a gate (Test Mode ${testMode})`, async () => {
    test.setTimeout(60_000);
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-booking-direct-fixture-'));
    const extensionPath = path.resolve('dist-test');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    let posts = 0;
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
          await route.fulfill({ contentType: 'text/html', body: posts
            ? `<section><strong>22222222</strong><p class="consular-appt">November 19, 2026<a href="${base}/appointment">Appointment</a></p><table><tbody>${['77777777', '88888888'].map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>`
            : `<section class="alert application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><p class="delivery"><a href="${base}/addresses/delivery">Delivery</a></p><table><tbody>${['77777777', '88888888'].map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>` });
        } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment' && request.method() === 'POST') {
          posts++;
          await route.fulfill({ contentType: 'text/plain', body: 'synthetic acceptance' });
        } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment') {
          // Gateless initial Schedule submit: no data-confirm anywhere. The
          // portal posts directly with no confirmation dialog.
          await route.fulfill({ contentType: 'text/html', body: `<form id="appointment-form" method="post" action="${base}/appointment">
            <select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select>
            <input id="appointments_consulate_appointment_date" value="2026-11-19" readonly data-usvisa-calendar-slot="95|2026-11-19">
            <select id="appointments_consulate_appointment_time"><option value="08:00">08:00</option></select>
            <input type="submit" name="commit" value="Schedule" id="appointments_submit" data-disable-with="Please wait..." class="button primary"></form>
            <script>const button = document.querySelector('#appointments_submit'); button.dataset.fixtureClicks = '0'; button.addEventListener('click', () => { button.dataset.fixtureClicks = String(Number(button.dataset.fixtureClicks) + 1); }); document.querySelector('form').onsubmit = event => { event.preventDefault(); fetch('${base}/appointment', { method: 'POST' }); };</script>` });
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
      expect(started).toMatchObject({ ok: true, snapshot: { status: 'running', currentDate: null } });
      expect(await panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState))
        .toMatchObject({ group: { dashboardPath, applicantIds: ['77777777', '88888888'] } });
      await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
      const tabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('applicants[]=77777777'))!.id!);
      const now = new Date().toISOString();
      const args = { owner: 'browser-owner-02', runId: 'browser-run-0002', now };
      const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, dashboardPath, applicantIds: ['77777777', '88888888'] } }),
        stage: 'form', lastCandidate: '2026-11-19', policyKey: policyKey(prefs), nextPollAt: now,
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
        // Test Mode never clicks the gateless submit and never opens a
        // dialog either: the dry run parks at readiness with no intent,
        // no verification reads and zero POSTs.
        await panel.evaluate(async () => {
          const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
          state.nextPollAt = new Date(Date.now() - 1000).toISOString();
          await chrome.storage.local.set({ engineStateV1: state });
          await chrome.alarms.create('enginePoll', { when: Date.now() });
        });
        await expect.poll(async () => {
          const state = await read();
          return state.status === 'verifying' && state.stage === 'done' && !state.executor?.actionPending;
        }).toBe(true);
        expect(await read()).toMatchObject({ status: 'verifying', stage: 'done', intent: null, verification: null });
        await expect(host.locator('#appointments_submit')).toHaveAttribute('data-fixture-clicks', '0');
        expect(await host.locator('.reveal-overlay .button.alert').count()).toBe(0);
        expect(posts).toBe(0);
        return;
      }
      await advance();
      // The validated gateless submit is clicked once and posts directly;
      // no recognized confirmation dialog opens.
      expect(await read()).toMatchObject({ status: 'verifying', intent: { phase: 'submitted' } });
      await expect(host.locator('#appointments_submit')).toHaveAttribute('data-fixture-clicks', '1');
      expect(await host.locator('.reveal-overlay').count()).toBe(0);
      expect(posts).toBe(1);
      await advance();
      // The confirm stage finds no dialog to validate, clicks nothing and
      // routes into verification without replaying the direct submit.
      await expect(host.locator('#appointments_submit')).toHaveAttribute('data-fixture-clicks', '1');
      expect(posts).toBe(1);
      for (let cycle = 0; cycle < 8 && (await read()).status !== 'stopped'; cycle++) {
        await advance();
        if ((await read()).authentication?.tabId !== null && (await read()).authentication) {
          await expect.poll(() => context.pages().some(page => page.url() === dashboardUrl)).toBe(true);
          await context.pages().find(page => page.url() === dashboardUrl)!.waitForLoadState('load');
        }
      }
      expect(await read()).toMatchObject({ status: 'stopped', intent: null });
      expect(host.isClosed()).toBe(false);
      expect(posts).toBe(1);
      expect(await host.locator('.reveal-overlay').count()).toBe(0);
      expect(dashboardReads).toBeGreaterThanOrEqual(3);
      expect(genericDashboardReads).toBe(0);
      const success = await panel.evaluate(async () => (await chrome.storage.local.get('engineSuccessV1')).engineSuccessV1);
      expect(success).toMatchObject({ runId: args.runId, date: '2026-11-19' });
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}

test('packaged null baseline transport drops null keys but preserves the explicit tag', async () => {
  // Measured root cause for the baseline check: the real
  // chrome.scripting.executeScript object-arg transport drops null-valued
  // keys ({currentDate: null} arrives without the key), so the submission
  // carries an explicit transport-safe currentDateTag alongside currentDate.
  // Missing alone never authorizes unbooked; only 'unbooked' with
  // null/missing does.
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-booking-direct-probe-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 5000 });
    const extensionId = new URL(worker.url()).host;
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/en-ca/niv/schedule/11111111/appointment') {
        await route.fulfill({ contentType: 'text/html', body: '<html><body>probe</body></html>' });
      } else await route.abort();
    });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const host = await context.newPage();
    await host.goto(`${base}/appointment?applicants[]=77777777&applicants[]=88888888`);
    const tabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('applicants[]=77777777'))!.id!);
    const probe = await worker.evaluate(async tabId => {
      const inner = (req: { currentDate?: string | null; currentDateTag: string; marker: string }) => ({
        hasKey: 'currentDate' in req,
        isNull: (req as { currentDate?: unknown }).currentDate === null,
        isUndefined: (req as { currentDate?: unknown }).currentDate === undefined,
        tag: (req as { currentDateTag: unknown }).currentDateTag,
        marker: (req as { marker: unknown }).marker,
      });
      const results = await chrome.scripting.executeScript({ target: { tabId: tabId as number }, func: inner as never,
        args: [{ currentDate: null, currentDateTag: 'unbooked', marker: 'probe-marker' }] as never[] });
      return results[0]?.result as { hasKey: boolean; isNull: boolean; isUndefined: boolean; tag: string; marker: string };
    }, tabId);
    // The null key is dropped in transport, but the explicit tag survives.
    expect(probe).toMatchObject({ hasKey: false, tag: 'unbooked', marker: 'probe-marker' });
    expect(probe.isNull).toBe(false);
    expect(probe.isUndefined).toBe(true);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('packaged direct initial submission with native POST navigation (Test Mode false)', async () => {
  // Real native form POST variant: the gateless form has no preventDefault,
  // so the validated click performs a true navigation POST. The POST is
  // intercepted with a 302 to the dashboard document; the run verifies to
  // success with exactly one POST and no second click, even across the
  // navigation (which may also lose the click reply).
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-booking-direct-native-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  let posts = 0;
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
        await route.fulfill({ contentType: 'text/html', body: posts
          ? `<section><strong>22222222</strong><p class="consular-appt">November 19, 2026<a href="${base}/appointment">Appointment</a></p><table><tbody>${['77777777', '88888888'].map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>`
          : `<section class="alert application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><p class="delivery"><a href="${base}/addresses/delivery">Delivery</a></p><table><tbody>${['77777777', '88888888'].map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>` });
      } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment' && request.method() === 'POST') {
        posts++;
        // Native navigation POST: redirect the booking tab to the dashboard
        // document (which now reads back the booked date).
        await route.fulfill({ status: 302, headers: { location: dashboardPath } });
      } else if (url.pathname === '/en-ca/niv/schedule/11111111/appointment') {
        // Gateless nativePOST form: no onsubmit override, so the click
        // performs a real navigation POST with no confirmation dialog.
        await route.fulfill({ contentType: 'text/html', body: `<form id="appointment-form" method="post" action="${base}/appointment">
          <select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select>
          <input id="appointments_consulate_appointment_date" value="2026-11-19" readonly data-usvisa-calendar-slot="95|2026-11-19">
          <select id="appointments_consulate_appointment_time"><option value="08:00">08:00</option></select>
          <input type="submit" name="commit" value="Schedule" id="appointments_submit" data-disable-with="Please wait..." class="button primary"></form>` });
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
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    await panel.evaluate(async prefs => { await chrome.storage.local.set({ uiPreferencesV1: prefs }); }, prefs);
    const started = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'booking' }));
    expect(started).toMatchObject({ ok: true, snapshot: { status: 'running', currentDate: null } });
    await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
    const tabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('applicants[]=77777777'))!.id!);
    const now = new Date().toISOString();
    const args = { owner: 'browser-owner-03', runId: 'browser-run-0003', now };
    const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, dashboardPath, applicantIds: ['77777777', '88888888'] } }),
      stage: 'form', lastCandidate: '2026-11-19', policyKey: policyKey(prefs), nextPollAt: now,
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
    await advance();
    // Either the click reply arrived (confirm stage, submitted) or the
    // navigation lost it (verifying with prepared intent). Both are valid
    // no-replay outcomes after a possibly final native POST.
    const afterSubmit = await read();
    expect(['confirm', 'done'].includes(afterSubmit.stage ?? '') || afterSubmit.status === 'verifying').toBe(true);
    expect(posts).toBe(1);
    if (afterSubmit.stage === 'confirm') {
      expect(afterSubmit).toMatchObject({ intent: { phase: 'submitted' } });
      await advance();
    }
    expect(posts).toBe(1);
    for (let cycle = 0; cycle < 8 && (await read()).status !== 'stopped'; cycle++) {
      await advance();
      expect(posts).toBe(1);
      if ((await read()).authentication?.tabId !== null && (await read()).authentication) {
        await expect.poll(() => context.pages().some(page => page.url() === dashboardUrl)).toBe(true);
        await context.pages().find(page => page.url() === dashboardUrl)!.waitForLoadState('load');
      }
    }
    expect(await read()).toMatchObject({ status: 'stopped', intent: null });
    expect(posts).toBe(1);
    expect(dashboardReads).toBeGreaterThanOrEqual(3);
    expect(genericDashboardReads).toBe(0);
    const success = await panel.evaluate(async () => (await chrome.storage.local.get('engineSuccessV1')).engineSuccessV1);
    expect(success).toMatchObject({ runId: args.runId, date: '2026-11-19' });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
