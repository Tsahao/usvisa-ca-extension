import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, reconcileStartup, startRun, type EngineState } from '../../src/engine/workflow';
import { beginAuthentication } from '../../src/engine/authentication';
import { policyKey } from '../../src/engine/lifecycle';

for (const scenario of ['get', 'submit', 'lost-submit', 'wake-submit'] as const) {
  test(`packaged ${scenario} passes account/index redirect chain without replay`, async () => {
    test.setTimeout(45_000);
    const profile = await mkdtemp(path.join(tmpdir(), 'visa-intermediary-fixture-'));
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${path.resolve('dist-test')}`, `--load-extension=${path.resolve('dist-test')}`,
        '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    const site = 'https://ais.usvisa-info.com', base = '/en-ca/niv/schedule/11111111';
    const login = `${site}/en-ca/niv/users/sign_in`, dashboardPath = '/en-ca/niv/groups/55555555';
    let accountRequests = 0, indexRequests = 0, loginPosts = 0, bookingPosts = 0;
    let releaseAccount!: () => void, releaseIndex!: () => void;
    const accountGate = new Promise<void>(r => { releaseAccount = r; });
    const indexGate = new Promise<void>(r => { releaseIndex = r; });
    try {
      await context.route(`${site}/**`, async route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== 'GET') {
          if (url.href === login) { loginPosts++; await route.fulfill({ status: 302, headers: { location: '/en-ca/niv/account' }, body: '' }); }
          else { bookingPosts++; await route.abort(); }
        } else if (url.pathname === '/en-ca/niv/') {
          await route.fulfill({ status: 302, headers: { location: '/en-ca/niv/account' }, body: '' });
        } else if (url.pathname === '/en-ca/niv/account') {
          accountRequests++; await accountGate;
          await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('/en-ca/niv/groups')</script>` });
        } else if (url.pathname === '/en-ca/niv/groups') {
          indexRequests++; await indexGate;
          await route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${dashboardPath}')</script>` });
        } else if (url.href === login) {
          await route.fulfill({ contentType: 'text/html', body: '<form id="sign_in_form" method="post" action="/en-ca/niv/users/sign_in"><input id="user_email" name="user[email]" type="email"><input id="user_password" name="user[password]" type="password"><input id="policy_confirmed" type="checkbox"><input type="submit" value="Sign In"></form>' });
        } else if (url.pathname === dashboardPath) {
          await route.fulfill({ contentType: 'text/html', body: `<section class="application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><table><tr><td><a href="${base}/applicants/77777777">Details</a></td></tr></table></section>` });
        } else await route.fulfill({ contentType: 'text/html', body: '<title>Synthetic original workflow</title>' });
      });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const id = new URL(worker.url()).host;
      const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html`);
      const flow = await context.newPage(); await flow.goto(`${site}${base}/appointment`);
      const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)!.id!, flow.url());
      await worker.evaluate(({ tabId, scenario, login }) => {
        const f = { pending: '', source: '', injections: 0, loginActions: 0, lost: false, errors: [] as string[] };
        (globalThis as unknown as { transitFixture: typeof f }).transitFixture = f;
        const get = chrome.tabs.get.bind(chrome.tabs), execute = chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.tabs.get = (async (id: number) => {
          const tab = await get(id);
          return id === tabId && f.pending ? { ...tab, url: f.source, pendingUrl: f.pending, status: 'complete' } : tab;
        }) as typeof chrome.tabs.get;
        chrome.scripting.executeScript = (async (raw: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
          const action = (('args' in raw ? raw.args?.[0] : undefined) as { action?: string } | undefined)?.action;
          if (raw.target.tabId === tabId && f.pending) { f.injections++; throw Error('No pending DOM access'); }
          if (action === 'submit') {
            f.loginActions++;
            const result = await execute(raw);
            if (scenario === 'lost-submit' && !f.lost) { f.lost = true; f.source = login; f.pending = login.replace('/users/sign_in', '/account'); throw Error('Synthetic lost acknowledgement after actual login POST'); }
            return result;
          }
          try { return await execute(raw); } catch (error) { f.errors.push(String(error)); throw error; }
        }) as typeof chrome.scripting.executeScript;
        chrome.notifications.create = async () => 'synthetic-notification';
      }, { tabId, scenario, login });
      const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, autoMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
      const now = new Date().toISOString(), args = { now, owner: 'transit-owner-01', runId: 'transit-run-0001' };
      const baseState: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, dashboardPath, applicantIds: ['77777777'] } }),
        policyKey: policyKey(prefs), executor: { tabId, applicantIds: ['77777777'], actionPending: false, targetTime: null, skippedDates: [] } };
      const state = beginAuthentication(baseState, 'renew', now, () => 0, scenario === 'get');
      await panel.evaluate(async ({ prefs, state }) => {
        await chrome.storage.local.set({ uiPreferencesV1: prefs }); await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
        await chrome.storage.local.set({ engineStateV1: state }); await chrome.alarms.create('enginePoll', { when: Date.now() });
      }, { prefs, state });
      const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      await expect.poll(() => accountRequests, { timeout: 15_000 }).toBe(1);
      await expect.poll(async () => (await read()).authentication?.pending).toBe(false);
      const kick = async () => panel.evaluate(async () => {
        const s = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        s.nextPollAt = new Date().toISOString(); await chrome.storage.local.set({ engineStateV1: s }); await chrome.alarms.create('enginePoll', { when: Date.now() });
      });
      for (const hop of ['account', 'groups']) {
        await worker.evaluate(({ pending, source }) => {
          const f = (globalThis as unknown as { transitFixture: { source: string; pending: string } }).transitFixture;
          f.source = source; f.pending = pending;
        }, { pending: `${site}/en-ca/niv/${hop}`, source: scenario === 'get' ? `${site}${base}/appointment` : login });
        const before = (await read()).updatedAt;
        await kick(); await expect.poll(async () => (await read()).updatedAt).not.toBe(before);
        expect(await read()).toMatchObject({ status: 'running', intent: null, authentication: { navigation: { kind: scenario === 'get' ? 'get' : 'login-action' } } });
        if (hop === 'account') { releaseAccount(); await expect.poll(() => indexRequests).toBe(1); }
      }
      if (scenario === 'wake-submit') {
        // Simulate suspension at the actual pre-dispatch action checkpoint,
        // without restarting a profile or replaying the synthetic POST.
        const s = await read();
        const resumed = reconcileStartup({ ...s, authentication: { ...s.authentication!, pending: true, checkpoint: 'action' } }, new Date().toISOString());
        expect(resumed.authentication).toMatchObject({ submittedInCycle: true, phase: 'wait' });
        await panel.evaluate(async resumed => chrome.storage.local.set({ engineStateV1: resumed }), resumed);
      }
      await worker.evaluate(() => { (globalThis as unknown as { transitFixture: { pending: string } }).transitFixture.pending = ''; });
      releaseIndex();
      try { await expect.poll(async () => (await read()).authentication, { timeout: 10_000 }).toBeNull(); }
      catch (error) { const s = await read(); console.log('Synthetic transit debug', JSON.stringify({ status: s.status, authentication: s.authentication, failure: s.failureContext, url: flow.url(), accountRequests, indexRequests, loginPosts, fixture: await worker.evaluate(() => (globalThis as unknown as { transitFixture: unknown }).transitFixture), diagnostics: await panel.evaluate(async () => (await chrome.storage.local.get('engineDiagnosticsV1')).engineDiagnosticsV1) })); throw error; }
      expect(await read()).toMatchObject({ status: 'running', sessionRenewals: 0, group: { dashboardPath, applicantIds: ['77777777'] } });
      expect(loginPosts).toBe(scenario === 'get' ? 0 : 1); expect(bookingPosts).toBe(0);
      expect(await worker.evaluate(() => (globalThis as unknown as { transitFixture: { injections: number } }).transitFixture.injections)).toBe(0);
      expect(context.pages().filter(p => p.url().startsWith(site))).toEqual([flow]);
      await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PANEL_STOP' }));
    } finally { releaseAccount(); releaseIndex(); await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}
