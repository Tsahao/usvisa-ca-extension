import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindGroup, emptyEngineState, parkForReview, recordIntent, startRun, type EngineState } from '../../src/engine/workflow';
import { policyKey } from '../../src/engine/lifecycle';

const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
const dashboardPath = '/en-ca/niv/groups/55555555';
const dashboardUrl = `https://ais.usvisa-info.com${dashboardPath}`;
const dashboardBody = (dateText: string) =>
  `<section><div class="application card"><strong>22222222</strong>` +
  `<p class="consular-appt">${dateText}<a href="${base}/appointment">Appointment</a></p>` +
  `<table><tbody>${['77777777', '88888888'].map(id => `<tr><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table>` +
  `</div></section>`;

async function launchWithDashboard(dateText: string) {
  const profile = await mkdtemp(path.join(tmpdir(), 'usvisa-recovery-fixture-'));
  const extensionPath = path.resolve('dist-test');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP ais.usvisa-info.com ~NOTFOUND'] });
  let posts = 0;
  await context.route('https://ais.usvisa-info.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') { posts++; await route.fulfill({ contentType: 'text/plain', body: 'synthetic' }); return; }
    if (url.pathname === dashboardPath || url.pathname === '/en-ca/niv/') {
      await route.fulfill({ contentType: 'text/html', body: dashboardBody(dateText) }); return;
    }
    await route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 5000 });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl);
  await dashboard.waitForLoadState('load');
  const read = () => panel.evaluate(async () => (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState);
  const postsCount = () => posts;
  return { context, profile, panel, dashboard, read, postsCount };
}

function seededVerifying(now: string, dashboardTabId: number, prefs: Record<string, unknown>, extra: Partial<EngineState> = {}): EngineState {
  const args = { owner: 'browser-owner-01', runId: 'browser-run-0001', now };
  let state = bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
    binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', dashboardPath, applicantIds: ['77777777', '88888888'] } });
  state = recordIntent(state, { ...args, intent: { runId: args.runId, mode: 'booking', groupId: '11111111',
    targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: now, phase: 'submitted' } });
  state = parkForReview(state, now);
  return { ...state, stage: 'done', executor: null, lastCandidate: null,
    verification: { reads: [], nextReadAt: new Date(Date.parse(now) + 30_000).toISOString() },
    verificationTabId: dashboardTabId, verificationError: null, queuedStart: null,
    policyKey: policyKey(prefs), pollIntervalS: 60,
    startedAt: '2026-10-11T00:00:00.000Z', consecutiveFailures: 4, sessionRenewals: 2, ...extra };
}

test('packaged recovery queues Start then restarts fresh after target success without replay', async () => {
  test.setTimeout(90_000);
  const { context, profile, panel, dashboard, read, postsCount } = await launchWithDashboard('November 19, 2026');
  try {
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    await panel.evaluate(async prefs => { await chrome.storage.local.set({ uiPreferencesV1: prefs }); }, prefs);
    const dashboardTabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, dashboardUrl);
    const now = new Date().toISOString();
    await panel.evaluate(async state => { await chrome.storage.local.set({ engineStateV1: state }); },
      seededVerifying(now, dashboardTabId, prefs));
    // Explicit Start during unresolved intent queues a restart without resetting progress.
    const first = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'booking' }));
    expect(first.ok).toBe(true);
    const queued = await read();
    expect(queued.queuedStart).toMatchObject({ mode: 'booking' });
    expect(queued.verificationTabId).toBe(dashboardTabId);
    expect(queued.verification?.reads).toEqual([]);
    const second = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'booking' }));
    expect(second.ok).toBe(true);
    const idempotent = await read();
    expect(idempotent.queuedStart).toEqual(queued.queuedStart);
    expect(idempotent.verificationTabId).toBe(dashboardTabId);
    // Accelerate the three paced reads; verification is read-only (no POST, no clicks).
    for (let cycle = 0; cycle < 10; cycle++) {
      const state = await read();
      if (state.intent === null) break;
      await panel.evaluate(async () => {
        const stored = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        if (stored.verification) stored.verification.nextReadAt = new Date(Date.now() - 1000).toISOString();
        await chrome.storage.local.set({ engineStateV1: stored });
        await chrome.alarms.create('enginePoll', { when: Date.now() });
      });
      await expect.poll(async () => ((await read()).verification?.reads.length ?? -1), { timeout: 15_000 }).not.toBe(state.verification?.reads.length ?? -2);
    }
    const restarted = await read();
    expect(restarted.intent).toBeNull();
    expect(restarted.queuedStart).toBeNull();
    expect(restarted.status).toBe('running');
    expect(restarted.mode).toBe('booking');
    expect(restarted.group).toMatchObject({ scheduleId: '11111111', kind: 'paid', currentDate: '2026-11-19', applicantIds: ['77777777', '88888888'] });
    expect(restarted.runId).not.toBe('browser-run-0001');
    expect(restarted.consecutiveFailures).toBe(0);
    expect(restarted.sessionRenewals).toBe(0);
    expect(Date.parse(restarted.startedAt!) - Date.parse(now)).toBeGreaterThanOrEqual(0);
    expect(restarted.policyKey).toBe(policyKey(prefs));
    expect(restarted.pollIntervalS).toBe(60);
    expect(postsCount()).toBe(0);
    const success = await panel.evaluate(async () => (await chrome.storage.local.get('engineSuccessV1')).engineSuccessV1);
    expect(success).toMatchObject({ date: '2026-11-19' });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('packaged recovery verifies on natural pacing without manual acceleration', async () => {
  test.setTimeout(90_000);
  const { context, profile, panel, dashboard, read, postsCount } = await launchWithDashboard('November 19, 2026');
  try {
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    await panel.evaluate(async prefs => { await chrome.storage.local.set({ uiPreferencesV1: prefs }); }, prefs);
    const dashboardTabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, dashboardUrl);
    const now = new Date().toISOString();
    await panel.evaluate(async state => { await chrome.storage.local.set({ engineStateV1: state }); },
      seededVerifying(now, dashboardTabId, prefs));
    const queued = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'booking' }));
    expect(queued.ok).toBe(true);
    // No deadline manipulation and no manual alarms: the short inter-read
    // pacing must drive all three fresh reads to resolution on its own. The
    // 30s-spaced predecessor needed over a minute here; the 2s gaps with the
    // short-timer fast wake must finish well under a minute.
    await expect.poll(async () => (await read()).intent, { timeout: 45_000 }).toBeNull();
    const restarted = await read();
    expect(restarted.queuedStart).toBeNull();
    expect(restarted.status).toBe('running');
    expect(restarted.group).toMatchObject({ scheduleId: '11111111', kind: 'paid', currentDate: '2026-11-19' });
    expect(postsCount()).toBe(0);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('packaged recovery rejects a cross-mode queue without an inconsistent binding', async () => {
  test.setTimeout(90_000);
  const { context, profile, panel, dashboard, read } = await launchWithDashboard('November 19, 2026');
  try {
    const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    await panel.evaluate(async prefs => { await chrome.storage.local.set({ uiPreferencesV1: prefs }); }, prefs);
    const dashboardTabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, dashboardUrl);
    await panel.evaluate(async state => { await chrome.storage.local.set({ engineStateV1: state }); },
      seededVerifying(new Date().toISOString(), dashboardTabId, prefs));
    const queued = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PANEL_START', mode: 'alerts' }));
    expect(queued.ok).toBe(true);
    expect((await read()).queuedStart).toMatchObject({ mode: 'alerts' });
    for (let cycle = 0; cycle < 10; cycle++) {
      const state = await read();
      if (state.intent === null) break;
      await panel.evaluate(async () => {
        const stored = (await chrome.storage.local.get('engineStateV1')).engineStateV1 as EngineState;
        if (stored.verification) stored.verification.nextReadAt = new Date(Date.now() - 1000).toISOString();
        await chrome.storage.local.set({ engineStateV1: stored });
        await chrome.alarms.create('enginePoll', { when: Date.now() });
      });
      await panel.waitForTimeout(500);
    }
    const resolved = await read();
    expect(resolved.intent).toBeNull();
    expect(resolved.queuedStart).toBeNull();
    expect(resolved.mode).toBe('booking');
    expect(resolved.group?.kind).toBe('paid');
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
