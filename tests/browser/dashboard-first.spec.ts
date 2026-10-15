import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineState } from '../../src/engine/workflow';

for (const { signedIn, title } of [
  { signedIn: true, title: 'packaged dashboard-first Start reuses a valid session from a flow tab with zero logins' },
  { signedIn: false, title: 'packaged dashboard-first Start falls back to sign-in from a signed-out landing with one submission' },
]) {
test(title, async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-dashboard-first-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  let loginSubmits = 0;
  let rootReads = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === '/en-ca/niv/users/sign_in' && request.method() === 'POST') {
        loginSubmits++;
        await route.fulfill({ contentType: 'application/json', body: '{"accepted":true}' });
      } else if (url.pathname === '/en-ca/niv/users/sign_in') {
        await route.fulfill({ contentType: 'text/html', body: '<form id="sign_in_form" method="post" action="/en-ca/niv/users/sign_in"><input id="user_email" type="email" name="user[email]"><input id="user_password" type="password" name="user[password]"><input id="policy_confirmed" type="checkbox"><input type="submit" name="commit" value="Sign In"></form><div class="captcha_container"><img alt="Captcha logo"></div><script>document.querySelector("form").onsubmit = event => { event.preventDefault(); fetch("/en-ca/niv/users/sign_in", { method: "POST", body: new FormData(event.currentTarget) }).then(() => { location.href = "/en-ca/niv/groups"; }); };</script>' });
      } else if (url.pathname === '/en-ca/niv' || url.pathname === '/en-ca/niv/') {
        rootReads++;
        if (signedIn) {
          // Valid profile session: the site root redirects to the dashboard.
          // Synthetic client redirect keeps the navigation intercepted under
          // DNS isolation; a mocked HTTP 302 would escape interception.
          await route.fulfill({ contentType: 'text/html', body: '<script>location.replace("/en-ca/niv/groups");</script>' });
        } else {
          // Signed-out clean welcome landing: no maintenance markers, no
          // sign-in form, just Continue. The worker advances promptly via
          // checkpointed browser navigation, never a manual click.
          await route.fulfill({ contentType: 'text/html', body: '<html><body><a href="/en-ca/niv/users/sign_in">Continue</a></body></html>' });
        }
      } else if (url.pathname === '/en-ca/niv/groups') {
        const roster = '<table><tbody><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/77777777">Details</a></td></tr></tbody></table>';
        const selected = '<section class="alert application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul><p class="delivery"><a href="/en-ca/niv/schedule/11111111/addresses/delivery">Delivery</a></p>' + roster + '</section>';
        await route.fulfill({ contentType: 'text/html', body: '<div>' + selected + '</div>' });
      } else if (url.pathname.startsWith('/en-ca/niv/schedule/')) {
        await route.fulfill({ contentType: 'text/html', body: '<html><body>flow</body></html>' });
      } else await route.abort();
    });
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const flow = await context.newPage();
    await flow.goto('https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment');
    const unrelated = await context.newPage(); await unrelated.goto('about:blank');
    const unrelatedUrl = unrelated.url();
    await panel.evaluate(async () => {
      await chrome.storage.local.set({ uiPreferencesV1: { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' } });
      const result = await chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'booking' });
      if (!result.ok) throw new Error(result.error);
    });
    const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    if (!signedIn) {
      // Signed-out landing advances promptly to the login page without a
      // manual click, then signs in once with the saved credentials.
      await expect.poll(async () => flow.url(), { timeout: 10_000 }).toContain('/users/sign_in');
      await expect(flow.locator('#user_email')).toHaveValue('fixture@example.invalid', { timeout: 10_000 });
    }
    await expect.poll(async () => (await read()).authentication, { timeout: 15_000 }).toBeNull();
    const state = await read();
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationError: null, authentication: null,
      group: { scheduleId: '11111111', currentDate: null, applicantIds: ['77777777'] } });
    // Dashboard-first proof: the reused flow tab went through the site root,
    // and a valid session bound with zero login POSTs while a signed-out run
    // submitted exactly once.
    expect(rootReads).toBeGreaterThanOrEqual(1);
    expect(loginSubmits).toBe(signedIn ? 0 : 1);
    expect(flow.url()).toBe('https://ais.usvisa-info.com/en-ca/niv/groups');
    expect(unrelated.url()).toBe(unrelatedUrl);
    expect(JSON.stringify(state)).not.toContain('synthetic-password');
    await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STOP' }); });
    expect(await read()).toMatchObject({ status: 'stopped', authentication: null });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
}
