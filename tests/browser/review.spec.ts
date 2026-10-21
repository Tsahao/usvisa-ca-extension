import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';
import type { MonitorSlot } from '../../src/domain/monitor';
import type { Preferences } from '../../src/ui/model';

const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01',
  latest: '2026-12-31', testMode: true, onlyEarlier: true, interval: 120, paidIvr: '22222222', unpaidIvr: '44444444' };
const dashboardUrl = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';

for (const scenario of ['gateway', 'settling', 'restart', 'alert-scope'] as const) {
  test(`packaged review regression: ${scenario}`, async () => {
    const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-review-fixture-'));
    const extensionPath = path.resolve('dist-test');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
    let posts = 0;
    let signIns = 0;
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await context.route('https://ais.usvisa-info.com/**', async route => {
        if (route.request().method() !== 'GET') { posts++; await route.abort(); return; }
        const url = new URL(route.request().url());
        if (url.pathname.includes('sign_in')) { signIns++; await route.abort(); return; }
        let body = '<p>Synthetic refused document</p>';
        if (url.href === dashboardUrl) body = '<section class="application card needs_payment"><strong>44444444</strong><h4 class="status">Pay Visa Fee</h4><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></section>';
        if (url.href === `${base}/continue_actions`) body = `<button type="button" aria-expanded="true">Reschedule Appointment</button><form method="post" action="${base}/appointment"><input type="submit" value="Reschedule Appointment"></form>`;
        if (url.pathname === '/en-ca/niv/schedule/33333333/payment') body = `<h2>First Available Appointments</h2><table>${['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver'].map(city => `<tr><td>${city}</td><td>No Appointments Available</td></tr>`).join('')}</table>`;
        await route.fulfill({ contentType: 'text/html', body });
      });
      const host = await context.newPage();
      await host.goto(scenario === 'gateway' ? `${base}/continue_actions` : dashboardUrl);
      const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await panel.evaluate(async saved => {
        await chrome.storage.local.set({ uiPreferencesV1: saved, uiLastModeV1: 'booking' });
        await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
      }, prefs);
      const now = new Date().toISOString();
      const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
      let state: EngineState = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-06-21',
          applicantIds: ['77777777'], dashboardPath: '/en-ca/niv/groups/55555555' } }), policyKey: policyKey(prefs), pollIntervalS: 120 };

      if (scenario === 'gateway') {
        const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, host.url());
        state = { ...state, stage: 'actions', nextPollAt: now, executor: { tabId, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false } };
        await panel.evaluate(async saved => { await chrome.storage.local.set({ engineStateV1: saved }); await chrome.alarms.create('enginePoll', { when: Date.now() }); }, state);
        await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).status)).toBe('verifying');
        expect(posts).toBe(0);
        expect(host.url()).toBe(`${base}/continue_actions`);
      }
      if (scenario === 'settling') {
        const deadline = new Date(Date.now() + 30_000).toISOString();
        state = { ...state, status: 'verifying', intent: { runId: state.runId!, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: now },
          verification: { reads: [], nextReadAt: deadline } };
        await panel.evaluate(async saved => { await chrome.storage.local.set({ engineStateV1: saved });
          await chrome.runtime.sendMessage({ type: 'ENGINE_VERIFY', owner: saved.owner, runId: saved.runId, now: new Date().toISOString() });
        }, state);
        const result = await panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
        expect(result.verification!.nextReadAt).toBe(deadline);
        expect(result.authentication).toBeNull();
        expect(signIns).toBe(0);
      }
      if (scenario === 'restart') {
        state = { ...state, status: 'stopped', nextPollAt: null };
        await panel.evaluate(async saved => { await chrome.storage.local.set({ engineStateV1: saved, engineSuccessV1: { runId: saved.runId, date: '2026-11-19' } }); }, state);
        await panel.reload();
        await panel.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).consecutiveFailures)).toBe(1);
        await expect(panel.getByRole('heading', { name: 'That didn’t work', exact: true })).toHaveCount(0);
        await expect(panel.getByRole('heading', { name: 'Appointment booked', exact: true })).toHaveCount(0);
        const delay = await panel.evaluate(async () => Date.parse(((await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState).nextPollAt!) - Date.now());
        expect(delay).toBeGreaterThan(115_000);
        // Accelerate the synthetic final budget boundary; normal pacing was
        // asserted above and all ten cycles are exercised by offline tests.
        await panel.evaluate(async () => { const saved = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
          await chrome.storage.local.set({ engineStateV1: { ...saved, consecutiveFailures: 9, nextPollAt: new Date().toISOString() } });
          await chrome.alarms.create('enginePoll', { when: Date.now() });
        });
        await expect(panel.getByRole('heading', { name: 'That didn’t work', exact: true })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Check configurations', exact: true })).toBeVisible();
        expect(posts).toBe(0);
      }
      if (scenario === 'alert-scope') {
        await panel.evaluate(async () => {
          const oldScope = 'alerts:33333333:Vancouver:any:2026-11-01:2026-12-31';
          await chrome.storage.local.set({ uiPreferencesV1: { ...(await chrome.storage.local.get('uiPreferencesV1')).uiPreferencesV1 as Preferences, consulate: 'Toronto' }, uiLastModeV1: 'alerts',
            unpaidMonitorV1: { scopeKey: oldScope, monitor: { scopeKey: oldScope, baseline: '2026-11-19', lastHealthyAt: new Date().toISOString(), alert: { observed: '2026-11-19', delivered: '2026-11-19', pending: false } } } });
          await chrome.runtime.sendMessage({ type: 'PANEL_STATE' });
        });
        await panel.reload();
        await panel.getByRole('button', { name: 'Start', exact: true }).click();
        await expect(host).toHaveURL('https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment');
        await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('engineObservationV1')).engineObservationV1 as { mode?: string } | undefined)?.mode)).toBe('alerts');
        const slot = await panel.evaluate(async () => (await chrome.storage.local.get('unpaidMonitorV1')).unpaidMonitorV1 as MonitorSlot);
        expect(slot.scopeKey).toContain(':Toronto:');
        expect(Object.keys(slot.monitors)).toEqual(['Toronto']);
        expect(slot.monitors.Toronto).toMatchObject({ scopeKey: `${slot.scopeKey}:Toronto`, baseline: null });
        await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        expect(posts).toBe(0);
      }
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}
