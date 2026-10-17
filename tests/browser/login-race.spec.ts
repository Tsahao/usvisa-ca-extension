import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';

// Focused packaged regression for the October 15 probable live pause: the
// owned tab automatically navigates from the exact official sign-in page to
// the exact canonical dashboard while the login submission is in flight, so
// the submit reply is lost. A worker transport hook makes that redirect
// deterministic: on the first submit-action injection it performs the real
// browser navigation to the dashboard, waits for the commit, then lets the
// real page script run (which observes the dashboard and returns a
// reasonless refusal). Recovery must pace read-only with zero POSTs and bind
// group/baseline/complete roster on the next pass. Without the fix the run
// stops at an unrecognized reading instead of binding. Synthetic fixtures
// only; no live portal, login, booking, notifications or analytics ingestion.
test('packaged renew survives a lost submit reply with zero submits and binds', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-login-race-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  const base = '/en-ca/niv/schedule/11111111';
  const dashboardPath = '/en-ca/niv/groups/55555555';
  const signIn = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
  const dashboardUrl = `https://ais.usvisa-info.com${dashboardPath}`;
  let signInGets = 0; let posts = 0;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => { chrome.notifications.create = async () => 'synthetic-notification'; });
    await context.route('https://ais.usvisa-info.com/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() !== 'GET') { posts++; await route.abort(); return; }
      if (url.pathname === '/en-ca/niv/users/sign_in') {
        signInGets++;
        await route.fulfill({ contentType: 'text/html', body:
          '<form id="sign_in_form" method="post" action="/en-ca/niv/users/sign_in">' +
          '<input id="user_email" type="email" name="user[email]">' +
          '<input id="user_password" type="password" name="user[password]">' +
          '<input id="policy_confirmed" type="checkbox"><input type="submit" name="commit" value="Sign In"></form>' +
          '<div class="captcha_container"><img alt="Captcha logo"></div>' });
      } else if (url.pathname === dashboardPath) {
        await route.fulfill({ contentType: 'text/html', body:
          `<section class="application card ready_to_schedule"><strong>22222222</strong>` +
          `<ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul>` +
          `<table><tbody><tr><td><a href="${base}/applicants/77777777">Details</a></td></tr></tbody></table></section>` });
      } else if (url.pathname === `${base}/continue_actions`) {
        await route.fulfill({ contentType: 'text/html', body: `<a class="accordion-title">Schedule</a>` });
      } else if (url.pathname === `${base}/appointment`) {
        await route.fulfill({ contentType: 'text/html', body: `<p>Synthetic appointment</p>` });
      } else await route.abort();
    });
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const flow = await context.newPage(); await flow.goto(`https://ais.usvisa-info.com${base}/appointment`);
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, flow.url());
    // Deterministic redirect race: the first submit-action injection navigates
    // the real owned tab to the dashboard (no manual action, no credential
    // POST) and waits for the commit, so the injected submit observes the
    // dashboard and its reply is reasonless. Later injections pass through.
    await worker.evaluate(async ({ tabId, dashboardUrl }: { tabId: number; dashboardUrl: string }) => {
      const g = globalThis as unknown as { raceHookFires: number };
      g.raceHookFires = 0;
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = (async (raw: Parameters<typeof chrome.scripting.executeScript>[0]) => {
        const details = raw as unknown as { target: { tabId: number }; args?: Array<{ action?: unknown }> };
        const action = details.args?.[0]?.action;
        const tab = (await chrome.tabs.get(details.target.tabId)) as unknown as { url?: string };
        if (g.raceHookFires === 0 && action === 'submit' && tab.url?.endsWith('/users/sign_in')) {
          g.raceHookFires++;
          await chrome.tabs.update(details.target.tabId, { url: dashboardUrl });
          for (let i = 0; i < 100; i++) {
            const live = (await chrome.tabs.get(details.target.tabId)) as unknown as { url?: string };
            if (live.url === dashboardUrl) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        return original(raw);
      }) as typeof chrome.scripting.executeScript;
    }, { tabId, dashboardUrl });
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    const now = new Date().toISOString(); const args = { now, owner: 'race-owner-01', runId: 'race-run-0001' };
    const state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, dashboardPath, applicantIds: ['77777777'] } }),
      policyKey: policyKey(prefs), executor: { tabId, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
      startedAt: new Date(Date.now() - 3600_001).toISOString(), nextPollAt: new Date(Date.now() - 1000).toISOString() };
    await panel.evaluate(async ({ prefs, state }) => {
      await chrome.storage.local.set({ uiPreferencesV1: prefs });
      // Drain startup and the configuration-change handler before seeding
      // the run; that handler deliberately parks any active workflow.
      await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
      await chrome.storage.local.set({ engineStateV1: state });
      await chrome.alarms.create('enginePoll', { when: Date.now() });
    }, { prefs, state });
    const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
    // The seeded pre-renewal state also has authentication=null. Wait for
    // the forced race AND the renewed dashboard handoff to complete.
    await expect.poll(async () => {
      const current = await read();
      const raceHookFires = await worker.evaluate(() =>
        (globalThis as unknown as { raceHookFires: number }).raceHookFires);
      return { authentication: current.authentication, stage: current.stage, raceHookFires };
    }, { timeout: 20_000 }).toEqual({ authentication: null, stage: 'actions', raceHookFires: 1 });
    const renewed = await read();
    expect(renewed).toMatchObject({ status: 'running', loginFailed: false, sessionRenewals: 0, consecutiveFailures: 0,
      group: { scheduleId: '11111111', applicantIds: ['77777777'], dashboardPath }, stage: 'actions',
      executor: { tabId, actionPending: false } });
    expect(renewed.authenticationError ?? null).toBeNull();
    expect(renewed.authenticationFailureReason ?? null).toBeNull();
    // The changed recovery path ran exactly once: without it the run stops
    // at an unrecognized reading instead of binding.
    expect(await worker.evaluate(() => (globalThis as unknown as { raceHookFires: number }).raceHookFires)).toBe(1);
    expect(signInGets).toBe(1);
    expect(posts).toBe(0);
    expect(flow.url() === dashboardUrl || flow.url().startsWith(`https://ais.usvisa-info.com${base}/continue`)).toBe(true);
    expect(context.pages().filter(page => page.url().startsWith('https://ais.usvisa-info.com'))).toEqual([flow]);
    const diagnostics = await panel.evaluate(async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'ENGINE_DIAGNOSTICS' });
      return reply.diagnostics as { extensionVersion: string; entries: { code: string; extensionVersion?: string }[] };
    });
    expect(diagnostics.entries.some(entry => entry.code === 'auth-redirect-progress')).toBe(true);
    expect(diagnostics.entries.every(entry => entry.extensionVersion === diagnostics.extensionVersion)).toBe(true);
    const diagnosticJson = JSON.stringify(diagnostics);
    for (const privateValue of ['fixture@example.invalid', 'synthetic-password', '11111111', '77777777', 'ais.usvisa-info.com']) {
      expect(diagnosticJson).not.toContain(privateValue);
    }
    await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'PANEL_STOP' }); });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
