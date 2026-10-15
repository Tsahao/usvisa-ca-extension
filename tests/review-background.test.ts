import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindGroup, emptyEngineState, parkForVerification, recordIntent, startRun, type EngineState } from '../src/engine/workflow';
import { policyKey } from '../src/engine/lifecycle';
import { beginAuthentication } from '../src/engine/authentication';

const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
  earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: true,
  interval: 120, paidIvr: '22222222', unpaidIvr: '44444444' };
const dashboard = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
const summary = { headingFound: true, rows: ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec', 'Toronto', 'Vancouver']
  .map(city => ({ city, text: 'No Appointments Available' })) };
const sender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' };

describe('cross-component review regressions', () => {
  let stored: Record<string, any>;
  let tabs: { id: number; url: string; status?: string }[];
  let message: (value: unknown, sender: unknown, reply: (value: any) => void) => void;
  let alarm: (value: { name: string }) => void;
  let changed: (changes: Record<string, unknown>, area: string) => void;
  let mock: any;
  const send = (value: object) => new Promise<any>(resolve => message(value, sender, resolve));
  const flush = () => send({ type: 'PANEL_STATE' });
  const fire = async () => { alarm({ name: 'enginePoll' }); return flush(); };
  const state = () => stored.engineStateV1 as EngineState;
  function seed(mode: 'booking' | 'alerts' = 'booking') {
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const bound = bindGroup(startRun(emptyEngineState(now), { ...args, mode }), { ...args,
      binding: { scheduleId: mode === 'booking' ? '11111111' : '33333333', ivr: mode === 'booking' ? '22222222' : '44444444',
        kind: mode === 'booking' ? 'paid' : 'unpaid', currentDate: mode === 'booking' ? '2027-06-21' : null,
        dashboardPath: '/en-ca/niv/groups/55555555', ...(mode === 'booking' ? { applicantIds: ['77777777'] } : {}) } });
    return { ...bound, policyKey: policyKey(prefs), pollIntervalS: prefs.interval, nextPollAt: now };
  }
  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T12:00:00Z')); vi.resetModules();
    stored = { uiPreferencesV1: { ...prefs } }; tabs = [];
    mock = {
      runtime: { id: sender.id, getURL: (path: string) => `chrome-extension://synthetic-extension/${path}`,
        onMessage: { addListener: (fn: typeof message) => { message = fn; } } },
      storage: { session: { setAccessLevel: vi.fn(async () => {}), get: vi.fn(async () => ({ engineSessionV1: true })), set: vi.fn(async () => {}) },
        local: { setAccessLevel: vi.fn(async () => {}), get: vi.fn(async () => structuredClone(stored)),
          set: vi.fn(async (value: object) => Object.assign(stored, structuredClone(value))) },
        onChanged: { addListener: (fn: typeof changed) => { changed = fn; } } },
      action: { onClicked: { addListener: vi.fn() } },
      alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => true), onAlarm: { addListener: (fn: typeof alarm) => { alarm = fn; } } },
      tabs: { query: vi.fn(async () => tabs), get: vi.fn(async (id: number) => {
        const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Synthetic closed tab'); return { ...tab };
      }), update: vi.fn(async (id: number, value: object) => Object.assign(tabs.find(tab => tab.id === id)!, value)),
        create: vi.fn(async ({ url }: { url: string }) => { const tab = { id: 88, url }; tabs.push(tab); return tab; }),
        remove: vi.fn(async () => {}), onUpdated: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn(async ({ func }: { func: { name: string } }) => [{ result: func.name === 'readDashboardGroups'
        ? { groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] } : summary }]) },
      notifications: { create: vi.fn(async () => 'synthetic-note') },
    };
    vi.stubGlobal('chrome', mock);
    await import('../src/background'); await flush();
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([null, 7])('holds the full verification deadline before tab resolution (%s)', async tabId => {
    const initial = seed();
    const now = new Date().toISOString();
    stored.engineStateV1 = { ...parkForVerification(recordIntent(initial, { owner: initial.owner!, runId: initial.runId!, now,
      intent: { runId: initial.runId!, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: now } }), now),
      verificationTabId: tabId };
    // A stale verifier must not trigger authentication before the settling wait.
    const deadline = state().verification!.nextReadAt;
    await fire(); await fire();
    expect(state().verification?.nextReadAt).toBe(deadline);
    expect(state().authentication).toBeNull();
    expect(mock.tabs.get).not.toHaveBeenCalled();
    expect(mock.scripting.executeScript).not.toHaveBeenCalled();
    expect(mock.alarms.create).toHaveBeenLastCalledWith('enginePoll', { when: Date.parse(deadline!) });
    vi.setSystemTime(new Date(deadline!)); await fire();
    expect(state().authentication?.purpose).toBe('verify');
  });

  it.each(['consulate', 'window', 'group'])('starts a fresh alert scope after changing %s', async change => {
    tabs = [{ id: 7, url: dashboard }];
    await send({ type: 'PANEL_START', mode: 'alerts' });
    vi.setSystemTime(new Date(state().nextPollAt!)); await fire();
    expect(state().status).toBe('running');
    const oldScope = stored.unpaidMonitorV1.scopeKey;
    await send({ type: 'PANEL_STOP' });
    if (change === 'consulate') stored.uiPreferencesV1.consulate = 'Toronto';
    if (change === 'window') stored.uiPreferencesV1.latest = '2027-01-31';
    if (change === 'group') {
      stored.uiPreferencesV1.unpaidIvr = '66666666';
      mock.scripting.executeScript.mockImplementation(async ({ func }: { func: { name: string } }) => [{ result: func.name === 'readDashboardGroups'
        ? { groups: [{ scheduleId: '99999999', ivr: '66666666', paymentStatus: 'unpaid' }] } : summary }]);
    }
    changed({ uiPreferencesV1: {} }, 'local'); await flush();
    tabs[0].url = dashboard;
    const restarted = await send({ type: 'PANEL_START', mode: 'alerts' });
    expect(restarted.ok).toBe(true);
    vi.setSystemTime(new Date(state().nextPollAt!)); await fire();
    expect(state().status).toBe('running');
    expect(stored.unpaidMonitorV1.scopeKey).not.toBe(oldScope);
    expect(stored.unpaidMonitorV1.monitor.baseline).toBeNull();
    expect(stored.engineObservationV1.runId).toBe(state().runId);
  });

  it('establishes the new alert scope after fresh Start authentication', async () => {
    const key = 'alerts:33333333:Toronto:any:2026-11-01:2026-12-31';
    stored.unpaidMonitorV1 = { scopeKey: key, monitor: { scopeKey: key, baseline: '2026-11-19', lastHealthyAt: new Date().toISOString(),
      alert: { observed: '2026-11-19', delivered: '2026-11-19', pending: false } } };
    const starting = beginAuthentication({ ...seed('alerts'), group: null }, 'start', new Date().toISOString());
    stored.engineStateV1 = { ...starting, authentication: { ...starting.authentication!, tabId: 7 } };
    tabs = [{ id: 7, url: dashboard }];
    await fire();
    expect(state().authentication).toBeNull();
    expect(state().status).toBe('running');
    expect(stored.unpaidMonitorV1.scopeKey).toContain(':Vancouver:');
    expect(stored.unpaidMonitorV1.monitor.baseline).toBeNull();
  });

  it('reschedules a due poll after a transient preferences-storage exception', async () => {
    stored.engineStateV1 = { ...seed('alerts'), monitorTabId: 7 };
    tabs = [{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' }];
    const get = mock.storage.local.get.getMockImplementation();
    let fail = true;
    mock.storage.local.get.mockImplementation(async (keys: string[]) => {
      if (fail && keys.includes('uiPreferencesV1')) { fail = false; throw new Error('Synthetic storage failure'); }
      return get(keys);
    });
    mock.alarms.create.mockClear();
    await fire();
    expect(state().status).toBe('running');
    expect(state().consecutiveFailures).toBe(1);
    expect(Date.parse(state().nextPollAt!) - Date.now()).toBeGreaterThanOrEqual(120_000);
    expect(mock.alarms.create).toHaveBeenCalledWith('enginePoll', { when: Date.parse(state().nextPollAt!) });
    expect(mock.scripting.executeScript).not.toHaveBeenCalled();
    await fire();
    expect(state().consecutiveFailures).toBe(1);
    vi.setSystemTime(new Date(state().nextPollAt!)); await fire();
    expect(stored.engineObservationV1.runId).toBe(state().runId);
    expect(state().consecutiveFailures).toBe(0);
  });

  it('uses the persisted checkpoint instead of replaying a mutation after an exception', async () => {
    const initial = seed();
    stored.engineStateV1 = { ...recordIntent(initial, { owner: initial.owner!, runId: initial.runId!, now: new Date().toISOString(),
      intent: { runId: initial.runId!, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false,
        phase: 'confirming', createdAt: new Date().toISOString() } }), stage: 'confirm',
      executor: { tabId: 7, applicantIds: ['77777777'], targetTime: '09:00', skippedDates: [], actionPending: true } };
    mock.storage.local.get.mockRejectedValueOnce(new Error('Synthetic state-read interruption'));
    await fire();
    expect(state().status).toBe('verifying');
    expect(state().intent).not.toBeNull();
    expect(Date.parse(state().verification!.nextReadAt!) - Date.now()).toBe(30_000);
    expect(mock.scripting.executeScript).not.toHaveBeenCalled();
  });

  function seedSuccess() {
    stored.engineStateV1 = { ...seed(), status: 'stopped', nextPollAt: null };
    stored.engineSuccessV1 = { runId: state().runId, date: '2026-11-19' };
    tabs = [{ id: 7, url: dashboard }];
  }

  it('keeps failed restarts quiet and paced, then exposes only the generic error at ten failures', async () => {
    seedSuccess();
    const oldRun = state().runId;
    const accepted = await send({ type: 'PANEL_START', mode: 'booking' });
    expect(accepted.snapshot.status).toBe('running');
    expect(state().runId).not.toBe(oldRun);
    for (let failures = 1; failures <= 10; failures++) {
      vi.setSystemTime(new Date(state().nextPollAt!));
      const reply = await fire();
      expect(state().consecutiveFailures).toBe(failures);
      if (failures < 10) {
        expect(reply.snapshot.status).toBe('running');
        expect(reply.snapshot.failureKind).toBeUndefined();
        expect(reply.snapshot.reviewMessage).toBeUndefined();
        expect(Date.parse(state().nextPollAt!) - Date.now()).toBeGreaterThanOrEqual(120_000);
        const calls = mock.scripting.executeScript.mock.calls.length;
        await fire();
        expect(mock.scripting.executeScript.mock.calls.length).toBe(calls);
      } else {
        expect(reply.snapshot).toMatchObject({ status: 'failure', failureKind: 'generic', restartFailed: true });
        expect(state().nextPollAt).toBeNull();
        expect(state().cooldownUntil).toBeNull();
      }
    }
    expect(stored.engineSuccessV1.runId).toBe(oldRun);
    expect(mock.scripting.executeScript.mock.calls.every(([input]: any[]) => input.func.name === 'readDashboardGroups')).toBe(true);
    const retried = await send({ type: 'PANEL_START', mode: 'booking' });
    expect(retried.snapshot.status).toBe('running');
    expect(state().consecutiveFailures).toBe(0);
  });

  it('freshly binds baseline and complete roster when a paced restart recovers', async () => {
    seedSuccess();
    await send({ type: 'PANEL_START', mode: 'booking' }); await fire();
    expect(state().consecutiveFailures).toBe(1);
    mock.scripting.executeScript.mockImplementation(async ({ func }: { func: { name: string } }) => [{ result: func.name === 'readDashboardGroups'
      ? { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] }
      : { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'November 19, 2026', applicantIds: ['77777777', '88888888'] } }]);
    vi.setSystemTime(new Date(state().nextPollAt!)); await fire();
    expect(state()).toMatchObject({ status: 'running', restartPending: false, consecutiveFailures: 0, stage: 'actions',
      group: { currentDate: '2026-11-19', applicantIds: ['77777777', '88888888'] }, executor: { tabId: 7, applicantIds: ['77777777', '88888888'] } });
  });

  it('applies the restart exhaustion boundary to authentication maintenance without credential actions', async () => {
    seedSuccess();
    tabs[0].url = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
    await send({ type: 'PANEL_START', mode: 'booking' }); await fire();
    expect(state().authentication?.purpose).toBe('start');
    stored.engineStateV1.consecutiveFailures = 9;
    mock.scripting.executeScript.mockResolvedValue([{ result: { maintenance: true } }]);
    vi.setSystemTime(new Date(state().nextPollAt!));
    const reply = await fire();
    expect(reply.snapshot).toMatchObject({ status: 'failure', failureKind: 'generic', restartFailed: true });
    expect(state().consecutiveFailures).toBe(10);
    expect(state().cooldownUntil).toBeNull();
    expect(mock.scripting.executeScript.mock.calls.every(([input]: any[]) => input.func.name === 'readSiteMaintenance')).toBe(true);
  });

  it('preserves retry permission and the exact deadline across worker suspension', async () => {
    seedSuccess();
    await send({ type: 'PANEL_START', mode: 'booking' }); await fire();
    const { reconcileStartup, validateEngineState } = await import('../src/engine/workflow');
    const saved = validateEngineState(JSON.parse(JSON.stringify(state())));
    const woken = reconcileStartup(saved, new Date().toISOString(), false);
    expect(woken.restartPending).toBe(true);
    expect(woken.nextPollAt).toBe(saved.nextPollAt);
    expect(woken.consecutiveFailures).toBe(1);
  });

  it.each(['Stop', 'settings', 'browser-restart'])('never continues restart setup after %s', async interruption => {
    seedSuccess();
    await send({ type: 'PANEL_START', mode: 'booking' }); await fire();
    if (interruption === 'Stop') await send({ type: 'PANEL_STOP' });
    if (interruption === 'settings') { stored.uiPreferencesV1.consulate = 'Toronto'; changed({ uiPreferencesV1: {} }, 'local'); await flush(); }
    if (interruption === 'browser-restart') {
      const { reconcileStartup } = await import('../src/engine/workflow');
      stored.engineStateV1 = reconcileStartup(state(), new Date().toISOString(), true);
    }
    const calls = mock.scripting.executeScript.mock.calls.length;
    vi.setSystemTime(new Date(Date.now() + 3600_000)); await fire();
    expect(state().restartPending).toBe(false);
    expect(mock.scripting.executeScript.mock.calls.length).toBe(calls);
  });

  it('keeps a storage-only wake-up when state cannot be read, without page actions or duplicate retries', async () => {
    stored.engineStateV1 = seed('alerts');
    const get = mock.storage.local.get.getMockImplementation();
    mock.storage.local.get.mockImplementation(async (keys: string[]) => {
      if (keys.includes('engineStateV1')) throw new Error('Synthetic unavailable storage');
      return get(keys);
    });
    // PANEL_STATE cannot read this state either; use a probe operation as the
    // queue barrier, whose response does not require the unavailable key.
    const barrier = () => new Promise(resolve => message({ type: 'PROBE_WAKE' }, { ...sender, url: 'chrome-extension://synthetic-extension/probe.html' }, resolve));
    alarm({ name: 'enginePoll' });
    await barrier();
    const scheduled = mock.alarms.create.mock.calls.find(([name]: [string]) => name === 'enginePoll');
    expect(scheduled[1].when - Date.now()).toBeGreaterThanOrEqual(60_000);
    expect(mock.scripting.executeScript).not.toHaveBeenCalled();
    const reads = mock.storage.local.get.mock.calls.length;
    alarm({ name: 'enginePoll' }); await barrier();
    expect(mock.storage.local.get.mock.calls.length).toBe(reads);
    mock.storage.local.get.mockImplementation(get);
    tabs = [{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' }];
    vi.setSystemTime(new Date(scheduled[1].when)); await fire();
    expect(stored.engineObservationV1.runId).toBe(state().runId);
  });
});
