import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineState } from '../../src/engine/workflow';

for (const { scheduled, signedIn, notice, expired = false, maintenance = false, dashboardMaintenance = false } of [{ scheduled: true, signedIn: false, notice: false }, { scheduled: false, signedIn: false, notice: false }, { scheduled: false, signedIn: true, notice: false }, { scheduled: false, signedIn: false, notice: true }, { scheduled: false, signedIn: false, notice: true, expired: true }, { scheduled: false, signedIn: false, notice: false, maintenance: true }, { scheduled: false, signedIn: false, notice: false, dashboardMaintenance: true }]) {
test(dashboardMaintenance ? 'packaged login retries two dashboard 503s through browser GETs with no page-navigation replies' : maintenance ? 'packaged login quietly waits through a 503 maintenance page and recovers with one submission' : signedIn ? 'packaged paid Start binds an unscheduled single applicant with a fresh dashboard read' : `packaged automatic login submits once and binds the ${scheduled ? 'scheduled roster' : 'unscheduled single applicant card'}${notice ? (expired ? ' after dismissing the session-expired notice' : ' after dismissing the sign-in notice') : ''}`, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-login-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  let loginSubmits = 0;
  let loginReads = 0;
  let dashboardReads = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    if (maintenance || dashboardMaintenance) await worker.evaluate(() => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      (globalThis as unknown as { legacyRetryInjections: number }).legacyRetryInjections = 0;
      // Model the real Chromium behavior: a departing document may return
      // null after its navigation instead of delivering its function result.
      chrome.scripting.executeScript = (async (details: Parameters<typeof chrome.scripting.executeScript>[0]) => {
        const results = await original(details);
        if (details.func && /location\.replace\(/.test(details.func.toString())) {
          (globalThis as unknown as { legacyRetryInjections: number }).legacyRetryInjections++;
          return results.map(result => ({ ...result, result: null }));
        }
        return results;
      }) as typeof chrome.scripting.executeScript;
    });
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === '/en-ca/niv/users/sign_in' && request.method() === 'POST') {
        loginSubmits++;
        await route.fulfill({ contentType: 'application/json', body: '{"accepted":true}' });
      } else if (url.pathname === '/en-ca/niv/users/sign_in') {
        loginReads++;
        if (maintenance && loginReads === 1) {
          await route.fulfill({ status: 503, contentType: 'text/html', body: '<title>Under construction (503)</title><div class="construction-background"><h1>Doing Maintenance</h1><h2>No need to worry.</h2><p>Our website is down for planned maintenance. We should be back up momentarily. Check back soon.</p></div>' });
          return;
        }
        const noticeCopy = expired ? 'Your session has expired. Please log back in to continue.' : 'You need to sign in or sign up before continuing.';
        const popup = notice ? '<div class="ui-widget-overlay" style="position:fixed;inset:0;background:#0008"></div><div class="notice-modal" role="dialog" style="position:fixed;inset:30%;background:white"><div id="flash_messages"><div class="flash notice">' + noticeCopy + '</div></div><div><div><button id="notice-ok" type="button">OK</button></div></div></div><script>document.querySelector("#notice-ok").onclick = () => { const form = document.querySelector("form"); form.dataset.dismissedBeforeCredentials = String(!document.querySelector("#user_email").value && !document.querySelector("#user_password").value && !document.querySelector("#policy_confirmed").checked); setTimeout(() => { document.querySelector("[role=dialog]").style.display = "none"; document.querySelector(".ui-widget-overlay").remove(); }, 100); };</script>' : '';
        await route.fulfill({ contentType: 'text/html', body: '<form id="sign_in_form" method="post" action="/en-ca/niv/users/sign_in"><input id="user_email" type="email" name="user[email]"><input id="user_password" type="password" name="user[password]"><input id="policy_confirmed" type="checkbox"><input type="submit" name="commit" value="Sign In"></form><div class="captcha_container"><img alt="Captcha logo"></div>' + popup + '<script>document.querySelector("form").onsubmit = event => { event.preventDefault(); fetch("/en-ca/niv/users/sign_in", { method: "POST", body: new FormData(event.currentTarget) }).then(() => { location.href = "/en-ca/niv/groups"; }); };</script>' });
      } else if (url.pathname === '/en-ca/niv/groups') {
        dashboardReads++;
        if (dashboardMaintenance && dashboardReads <= 2) {
          await route.fulfill({ status: 503, contentType: 'text/html', body: '<title>Under construction (503)</title><h1>Doing Maintenance</h1><p>Our website is down for planned maintenance.</p>' });
          return;
        }
        const roster = '<table><tbody><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/77777777">Details</a></td></tr>' +
          (scheduled ? '<tr><td><a href="/en-ca/niv/schedule/11111111/applicants/88888888">Details</a></td></tr>' : '') + '</tbody></table>';
        const selected = scheduled
          ? '<section><strong>22222222</strong><p class="consular-appt">January 1, 2027 <a href="/en-ca/niv/schedule/11111111/appointment">Appointment</a></p>' + roster + '</section>'
          : '<section class="alert application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul><p class="delivery"><a href="/en-ca/niv/schedule/11111111/addresses/delivery">Delivery</a></p>' + roster + '</section>';
        const historical = scheduled ? '' : '<section><strong>44444444</strong><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul><p class="consular-appt">September 22, 2025</p><table><tbody><tr><td><a href="/en-ca/niv/schedule/33333333/applicants/99999999">Details</a></td></tr></tbody></table></section>';
        await route.fulfill({ contentType: 'text/html', body: '<div>' + selected + historical + '</div>' });
      } else await route.abort();
    });
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const login = await context.newPage(); await login.goto(`https://ais.usvisa-info.com/en-ca/niv/${signedIn ? 'groups' : 'users/sign_in'}`);
    await panel.evaluate(async () => {
      await chrome.storage.local.set({ uiPreferencesV1: { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' } });
      const result = await chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'booking' });
      if (!result.ok) throw new Error(result.error);
    });
    const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    if (maintenance) {
      await expect.poll(async () => (await read()).authentication?.phase, { timeout: 10_000 }).toBe('retry');
      const waiting = await read();
      expect(waiting).toMatchObject({ status: 'running', loginFailed: false, authenticationError: null, consecutiveFailures: 1 });
      expect(Date.parse(waiting.nextPollAt!) - Date.parse(waiting.updatedAt)).toBeGreaterThanOrEqual(60_000);
      expect(await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_STATE' }))).toMatchObject({ ok: true, snapshot: { status: 'running', reviewRequired: false } });
      // Even a user reload reaching a healthy form cannot accelerate the retry.
      await login.reload();
      await expect(login.locator('#user_email')).toHaveValue('');
      await expect(login.locator('#user_password')).toHaveValue('');
      expect((await read()).nextPollAt).toBe(waiting.nextPollAt);
      expect(loginSubmits).toBe(0);
      // Advance only the synthetic deadline instead of waiting a real minute.
      await panel.evaluate(async () => {
        const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        await chrome.storage.local.set({ engineStateV1: { ...state, nextPollAt: new Date().toISOString() } });
        await chrome.alarms.create('enginePoll', { when: Date.now() });
      });
    }
    if (!signedIn) {
      await expect(login.locator('#user_email')).toHaveValue('fixture@example.invalid', { timeout: 10_000 });
      await expect(login.locator('#user_password')).toHaveValue('synthetic-password');
      await expect(login.locator('#policy_confirmed')).toBeChecked(); expect(loginSubmits).toBe(0);
      if (notice) {
        await expect(login.locator('[role="dialog"]')).toBeHidden();
        await expect(login.locator('#sign_in_form')).toHaveAttribute('data-dismissed-before-credentials', 'true');
      }
      await login.waitForURL('https://ais.usvisa-info.com/en-ca/niv/groups', { timeout: 10_000 });
    }
    if (dashboardMaintenance) {
      for (const failures of [1, 2]) {
        await expect.poll(async () => {
          const state = await read();
          return { status: state.status, phase: state.authentication?.phase, failures: state.consecutiveFailures };
        }, { timeout: 10_000 }).toEqual({ status: 'running', phase: 'retry', failures });
        const waiting = await read();
        expect(waiting).toMatchObject({ group: null, loginFailed: false, authenticationError: null, authentication: { pending: false } });
        expect(Date.parse(waiting.nextPollAt!) - Date.parse(waiting.updatedAt)).toBeGreaterThanOrEqual(60_000);
        expect(loginSubmits).toBe(1);
        await panel.evaluate(async () => {
          const state = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
          await chrome.storage.local.set({ engineStateV1: { ...state, nextPollAt: new Date().toISOString() } });
          await chrome.alarms.create('enginePoll', { when: Date.now() });
        });
      }
    }
    await expect.poll(async () => (await read()).authentication, { timeout: 10_000 }).toBeNull();
    const state = await read();
    expect(loginSubmits).toBe(signedIn ? 0 : 1);
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationError: null, authentication: null, group: { scheduleId: '11111111', currentDate: scheduled ? '2027-01-01' : null, applicantIds: scheduled ? ['77777777', '88888888'] : ['77777777'] } });
    if (maintenance) { expect(state.consecutiveFailures).toBe(0); expect(loginReads).toBe(3); }
    if (dashboardMaintenance) { expect(state.consecutiveFailures).toBe(0); expect(dashboardReads).toBe(3); }
    if (maintenance || dashboardMaintenance) expect(await worker.evaluate(() => (globalThis as unknown as { legacyRetryInjections: number }).legacyRetryInjections)).toBe(0);
    expect(JSON.stringify(state)).not.toContain('synthetic-password'); expect(JSON.stringify(state)).not.toContain('fixture@example.invalid');
    await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STOP' }); });
    expect(await read()).toMatchObject({ status: 'stopped', authentication: null });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
}
