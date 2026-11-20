import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { beginAuthentication } from '../../src/engine/authentication';
import { policyKey } from '../../src/engine/lifecycle';

for (const target of ['root', 'sign-in'] as const) {
for (const status of ['loading', 'complete'] as const) {
  test(`packaged ${target} renewal holds redirected pending destinations on the old ${status} document`, async () => {
    test.setTimeout(35_000);
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-renewal-navigation-fixture-'));
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${path.resolve('dist-test')}`, `--load-extension=${path.resolve('dist-test')}`,
        '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    const site = 'https://ais.usvisa-info.com';
    const source = `${site}/en-ca/niv/schedule/11111111/appointment?applicants[]=77777777&applicants[]=88888888`;
    const dashboardPath = '/en-ca/niv/groups/55555555';
    const login = `${site}/en-ca/niv/users/sign_in`;
    const root = `${site}/en-ca/niv/`;
    let portalPosts = 0;
    try {
      await context.route(`${site}/**`, async route => {
        if (route.request().method() !== 'GET') { portalPosts++; await route.abort(); return; }
        const url = new URL(route.request().url());
        if (url.pathname === dashboardPath) {
          await route.fulfill({ contentType: 'text/html', body: `<section class="application card ready_to_schedule"><strong>22222222</strong>
            <ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul>
            <table><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/77777777">Details</a></td></tr>
            <tr><td><a href="/en-ca/niv/schedule/11111111/applicants/88888888">Details</a></td></tr></table></section>` });
        } else if (url.pathname.endsWith('/appointment')) {
          await route.fulfill({ contentType: 'text/html', body: '<title>Synthetic original booking document</title>' });
        } else await route.abort();
      });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      const flow = await context.newPage(); await flow.goto(source);
      const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)!.id!, flow.url());
      const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01',
        latest: '2026-12-31', onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
      const now = new Date().toISOString(); const args = { now, owner: 'renewal-owner-01', runId: 'renewal-run-0001' };
      const base: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args, binding: {
        scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, dashboardPath, applicantIds: ['77777777', '88888888'],
      } }), policyKey: policyKey(prefs), executor: { tabId, applicantIds: ['77777777', '88888888'], targetTime: null, skippedDates: [], actionPending: false } };
      const state = beginAuthentication(base, 'renew', now, () => 0, target === 'root');
      // Simulate the documented Chrome tabs.update early acknowledgement and
      // retained old URL in the isolated test worker. All portal requests are
      // synthetic/DNS-blocked; no owner profile or real notification is used.
      await worker.evaluate(({ tabId, source, status, login, root, target }) => {
        const fixture = { pending: true, gets: 0, injections: 0, destination: target === 'root' ? root : login, source, observations: 0 };
        (globalThis as unknown as { renewalFixture: typeof fixture }).renewalFixture = fixture;
        const get = chrome.tabs.get.bind(chrome.tabs);
        const update = chrome.tabs.update.bind(chrome.tabs);
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.tabs.get = (async (id: number) => {
          const tab = await get(id);
          if (id === tabId && fixture.pending) { fixture.observations++; return { ...tab, url: fixture.source, pendingUrl: fixture.destination || undefined, status }; }
          return tab;
        }) as typeof chrome.tabs.get;
        chrome.tabs.update = (async (id: number, changes: chrome.tabs.UpdateProperties) => {
          if (id === tabId && fixture.pending) {
            if (changes.url !== (target === 'root' && fixture.gets === 0 ? root : login)) throw new Error('Unexpected synthetic recovery URL');
            fixture.gets++;
            return get(id);
          }
          return update(id, changes);
        }) as typeof chrome.tabs.update;
        chrome.scripting.executeScript = (async (request: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
          if (request.target.tabId === tabId && fixture.pending) {
            fixture.injections++; throw new Error('DOM access while synthetic sign-in is pending');
          }
          return execute(request);
        }) as typeof chrome.scripting.executeScript;
        chrome.notifications.create = async () => 'synthetic-notification';
      }, { tabId, source, status, login, root, target });
      await panel.evaluate(async ({ prefs, state }) => {
        await chrome.storage.local.set({ uiPreferencesV1: prefs }); await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
        await chrome.storage.local.set({ engineStateV1: state }); await chrome.alarms.create('enginePoll', { when: Date.now() });
      }, { prefs, state });
      const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
      await expect.poll(async () => (await read()).authentication?.navigation?.target, { timeout: 10_000 }).toBe(target);
      const waiting = await read();
      expect(waiting).toMatchObject({ status: 'running', loginFailed: false, intent: null,
        authentication: { tabId, phase: 'prepare', pending: false }, group: state.group });
      expect(await worker.evaluate(() => {
        const f = (globalThis as unknown as { renewalFixture: { gets: number; injections: number } }).renewalFixture;
        return { gets: f.gets, injections: f.injections };
      })).toEqual({ gets: 1, injections: 0 });
      // Explicit intermediate pending metadata: the old tests jumped directly
      // from pending sign-in to a committed dashboard and missed this failure.
      for (const destination of [root, login, `${site}/en-ca/niv/account`, `${site}/en-ca/niv/groups`, site + dashboardPath, '']) {
        const before = await worker.evaluate(destination => {
          const f = (globalThis as unknown as { renewalFixture: { destination: string; observations: number } }).renewalFixture;
          f.destination = destination; return f.observations;
        }, destination);
        const updatedBefore = (await read()).updatedAt;
        await panel.evaluate(async () => {
          const s = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
          s.nextPollAt = new Date().toISOString(); await chrome.storage.local.set({ engineStateV1: s });
          await chrome.alarms.create('enginePoll', { when: Date.now() });
        });
        await expect.poll(() => worker.evaluate(() => (globalThis as unknown as { renewalFixture: { observations: number } }).renewalFixture.observations)).toBeGreaterThan(before);
        await expect.poll(async () => (await read()).updatedAt).not.toBe(updatedBefore);
        expect(await read()).toMatchObject({ status: 'running', authentication: { navigation: { target } }, consecutiveFailures: 0, intent: null });
        expect(await worker.evaluate(() => (globalThis as unknown as { renewalFixture: { injections: number } }).renewalFixture.injections)).toBe(0);
      }
      await worker.evaluate(() => { (globalThis as unknown as { renewalFixture: { pending: boolean } }).renewalFixture.pending = false; });
      await flow.goto(site + dashboardPath);
      await expect.poll(async () => (await read()).authentication, { timeout: 10_000 }).toBeNull();
      expect(await read()).toMatchObject({ status: 'running', sessionRenewals: 0, consecutiveFailures: 0, group: state.group,
        executor: { tabId, applicantIds: ['77777777', '88888888'], actionPending: false } });
      // The same retained dashboard must not be mistaken for navigation drift
      // after an acknowledged preliminary handoff advanced to warning.
      await worker.evaluate(({ source, destination }) => {
        const f = (globalThis as unknown as { renewalFixture: { pending: boolean; source: string; destination: string } }).renewalFixture;
        f.pending = true; f.source = source; f.destination = destination;
      }, { source: site + dashboardPath, destination: `${site}/en-ca/niv/schedule/11111111/appointment` });
      const updatedBefore = (await read()).updatedAt;
      await panel.evaluate(async source => {
        const s = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        s.stage = 'warning'; s.nextPollAt = new Date().toISOString();
        s.executor!.handoff = { source, deadline: new Date(Date.now() + 15_000).toISOString(),
          stage: 'warning', runId: s.runId!, policyKey: s.policyKey };
        await chrome.storage.local.set({ engineStateV1: s }); await chrome.alarms.create('enginePoll', { when: Date.now() });
      }, site + dashboardPath);
      await expect.poll(async () => (await read()).updatedAt).not.toBe(updatedBefore);
      expect(await read()).toMatchObject({ status: 'running', authentication: null, stage: 'warning',
        executor: { handoff: { source: site + dashboardPath } } });
      expect(await worker.evaluate(() => {
        const f = (globalThis as unknown as { renewalFixture: { gets: number; injections: number } }).renewalFixture;
        return { gets: f.gets, injections: f.injections };
      })).toEqual({ gets: 1, injections: 0 });
      expect(portalPosts).toBe(0);
      expect(context.pages().filter(p => p.url().startsWith(site))).toEqual([flow]);
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}

}
