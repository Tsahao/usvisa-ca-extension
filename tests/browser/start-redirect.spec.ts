// Packaged regression for stale-dashboard Retry recovery: a stopped generic
// failure behind a visibly cached paid dashboard whose fresh baseline GET is
// an expired-session redirect must recover auth-only on the same tab.
// Synthetic fixtures only; DNS-blocked, no live portal/login/booking,
// no external notifications, no real analytics. Credentials are synthetic.
import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineState } from '../../src/engine/workflow';

// Old stopped save shape (no private IDs): stopped booking, generic login
// failure, bound single applicant, no intent/auth/deadline/candidate.
function oldStoppedSave(ownedTabId: number): EngineState {
  return { version: 1, runId: 'old-run-0001', owner: 'product-panel-owner', generation: 2,
    mode: 'booking', status: 'stopped', intent: null,
    group: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null,
      dashboardPath: '/en-ca/niv/groups/55555555', applicantIds: ['77777777'] },
    consecutiveFailures: 1, cooldownUntil: null, lastCandidate: null, stage: null,
    executor: { tabId: ownedTabId, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
    monitorTabId: null, verification: null, nextPollAt: null,
    alert: { observed: null, delivered: null, pending: false },
    updatedAt: '2026-10-15T21:00:13.409Z', startedAt: '2026-10-15T20:00:00.000Z',
    policyKey: null, pollIntervalS: 60, authentication: null, sessionRenewals: 0,
    loginFailed: true, authenticationError: null, manualAuthentication: false,
    verificationTabId: null, queuedStart: null, verificationError: null,
    restartPending: false, restartFailed: false } as unknown as EngineState;
}

test('packaged Retry recovers a stale redirect into same-tab sign-in then fresh binding with zero POSTs', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-start-redirect-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  const base = '/en-ca/niv/schedule/11111111';
  const dashboardPath = '/en-ca/niv/groups/55555555';
  const dashboardUrl = `https://ais.usvisa-info.com${dashboardPath}`;
  const signIn = '/en-ca/niv/users/sign_in';
  let signInGets = 0; let signInFetches = 0; let posts = 0; let fetchAttempts = 0;
  let releaseSignIn!: () => void;
  let signInHeld = new Promise<void>(resolve => { releaseSignIn = resolve; });
  const dashboardBody =
    `<section class="application card ready_to_schedule"><strong>22222222</strong>` +
    `<ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul>` +
    `<table><tbody><tr><td><a href="${base}/applicants/77777777">Details</a></td></tr></tbody></table></section>`;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => { chrome.notifications.create = async () => 'synthetic-notification'; });
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() !== 'GET') { posts++; await route.abort(); return; }
      if (url.pathname === dashboardPath) {
        // Cached DOM stays readable; only the fresh baseline fetch observes
        // the expired session. First fetch redirects toward sign-in (page sees
        // opaqueredirect with manual, never followed); later fetches succeed.
        if (request.resourceType() === 'fetch') {
          fetchAttempts++;
          if (fetchAttempts === 1) {
            await route.fulfill({ status: 302, headers: { location: `https://ais.usvisa-info.com${signIn}` }, contentType: 'text/plain', body: '' });
            return;
          }
        }
        await route.fulfill({ contentType: 'text/html', body: dashboardBody });
        return;
      }
      if (url.pathname === signIn) {
        if (request.resourceType() === 'fetch') { signInFetches++; await route.abort(); return; }
        signInGets++;
        // Hold the document GET so auth-only running is observable before the
        // same-tab redirect lands back on the dashboard. No credentials/POST.
        await signInHeld;
        await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${dashboardPath}');</script>` });
        return;
      }
      await route.abort();
    });
    const dashboard = await context.newPage();
    await dashboard.goto(dashboardUrl);
    await dashboard.waitForLoadState('load');
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
      earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false,
      interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    await panel.evaluate(async prefsValue => { await chrome.storage.local.set({ uiPreferencesV1: prefsValue }); }, prefs);
    await panel.reload();
    // Drain startup and the config-change handler before seeding the old
    // stopped save (no auto-restart on reload).
    await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STATE' }); });
    const ownedTabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id ?? -1, dashboardUrl);
    expect(ownedTabId).toBeGreaterThanOrEqual(0);
    await panel.evaluate(async state => { await chrome.storage.local.set({ engineStateV1: state }); }, oldStoppedSave(ownedTabId));
    await panel.getByRole('button', { name: 'Booking', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({ timeout: 10_000 });
    // Explicit Retry click (not a direct message): must leave the failure
    // screen for the existing running panel once the worker accepts recovery.
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    // Same owned tab checkpoints a fixed sign-in GET (no replacement tab).
    await expect.poll(async () => signInGets, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(fetchAttempts).toBeGreaterThanOrEqual(1);
    // Deterministic auth-only: running, exact start auth on the owned tab,
    // no cached group/stage/executor binding Continue/booking. The held
    // sign-in document keeps this state observable without sleeps.
    await expect.poll(async () => (await read()).status, { timeout: 15_000 }).toBe('running');
    const authOnly = await read();
    expect(authOnly.group).toBeNull();
    expect(authOnly.stage).toBeNull();
    expect(authOnly.executor).toBeNull();
    expect(authOnly.authentication).toMatchObject({ tabId: ownedTabId, purpose: 'start', pending: false });
    expect(signInFetches).toBe(0);
    expect(posts).toBe(0);
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([dashboard]);
    // Release the sign-in document, then await fresh binding after the
    // redirect lands on the dashboard.
    releaseSignIn();
    await expect.poll(async () => {
      const current = await read();
      return { authentication: current.authentication, group: current.group, stage: current.stage };
    }, { timeout: 20_000 }).toEqual({ authentication: null,
      group: expect.objectContaining({ scheduleId: '11111111', kind: 'paid', dashboardPath, applicantIds: ['77777777'] }),
      stage: 'actions' });
    const bound = await read();
    expect(bound).toMatchObject({ status: 'running', loginFailed: false, consecutiveFailures: 0,
      group: { scheduleId: '11111111', applicantIds: ['77777777'] }, stage: 'actions' });
    expect(bound.executor).toMatchObject({ tabId: ownedTabId, actionPending: false });
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([dashboard]);
    expect(dashboard.url()).toBe(dashboardUrl);
    expect(posts).toBe(0);
    expect(signInFetches).toBe(0);
    expect(await panel.getByRole('button', { name: 'Stop', exact: true }).count()).toBe(1);
    await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STOP' }); });
  } finally {
    try { releaseSignIn(); } catch { /* Already released on failure paths. */ }
    await context.close(); await rm(profile, { recursive: true, force: true });
  }
});
