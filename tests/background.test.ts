import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('read-only probe boundaries', () => {
  let stored: Record<string, unknown>;
  let clicked: (tab: { id: number; url: string }) => void;
  let message: (value: unknown, sender: unknown, respond: (value: unknown) => void) => unknown;
  let alarmed: (alarm: { name: string }) => void;
  let chromeMock: any;
  let preferencesChanged: (changes: Record<string, unknown>, area: string) => void;
  let tabsUpdated: (tabId: number, changeInfo: unknown, tab: unknown) => void;

  function preparePaidPoll() {
    const state = stored.engineStateV1 as Record<string, unknown>;
    state.executor = { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false };
  }

  function mockPaidPoll(response: unknown) {
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => [{
      result: input.func.name === 'readPaidPage'
        ? { scheduleId: '11111111', kind: 'form', applicantIds: ['77777777'] }
        : response,
    }]);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    stored = {};
    chromeMock = {
      storage: {
        onChanged: { addListener: vi.fn(listener => { preferencesChanged = listener; }) },
        session: {
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue({ engineSessionV1: true }),
          set: vi.fn().mockResolvedValue(undefined),
        }, local: {
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async () => ({ ...stored })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }),
      } },
      action: { onClicked: { addListener: vi.fn(listener => { clicked = listener; }) } },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: true }]) },
      notifications: { create: vi.fn(async () => 'note-1') },
      tabs: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn(async (tabId: number) => ({ id: tabId })),
        reload: vi.fn(async () => undefined),
        query: vi.fn().mockResolvedValue([]),
        // Keep live snapshots consistent with query results unless a test
        // explicitly models a navigation race or stale tab.
        get: vi.fn(async (tabId: number) => (await chromeMock.tabs.query({})).find((tab: { id: number }) => tab.id === tabId)
          ?? { id: tabId, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }),
        onUpdated: { addListener: vi.fn(listener => { tabsUpdated = listener; }) },
      },
      windows: {
        create: vi.fn().mockResolvedValue({ id: 80, tabs: [{ id: 81 }] }),
        get: vi.fn().mockResolvedValue({ id: 80, type: 'popup', state: 'normal' }),
        update: vi.fn().mockResolvedValue({ id: 80 }),
      },
      alarms: {
        create: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(true),
        onAlarm: {
          addListener: vi.fn(listener => {
            alarmed = listener;
          }),
        },
      },
      runtime: {
        id: 'synthetic-extension', getURL: (path: string) => `chrome-extension://synthetic-extension/${path}`,
        onMessage: { addListener: vi.fn(listener => { message = listener; }) },
      },
    };
    vi.stubGlobal('chrome', chromeMock);
    await import('../src/background');
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('starts the product from worker-read dashboard identity and stops without simulated state', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 120, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => [{ result: input.func.name === 'readDashboardGroups'
      ? { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] }
      : { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'June 21, 2027', applicantIds: ['77777777', '88888888'] } }]);
    const sender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html?embedded=1' };
    const started = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking', snapshot: { groups: [] }, url: 'https://example.invalid' }, sender, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledWith(expect.objectContaining({ ok: true, snapshot: expect.objectContaining({ status: 'running', dates: [] }) })));
    expect(stored.engineStateV1).toMatchObject({ group: { scheduleId: '11111111', currentDate: '2027-06-21' }, pollIntervalS: 120 });
    expect(stored.uiSimulatedRunV1).toBeUndefined();
    expect(JSON.stringify(started.mock.calls)).not.toContain('synthetic-password');
    const duplicate = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, sender, duplicate);
    await vi.waitFor(() => expect(duplicate).toHaveBeenCalled());
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(2);
    const stopped = vi.fn();
    message({ type: 'PANEL_STOP' }, sender, stopped);
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'stopped', nextPollAt: null }));
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it.each(['restart', 'interrupted-action', 'orphan'])('allows product Start to freshly bind a paused run without booking intent (%s)', async reason => {
    const { emptyEngineState, startRun, reconcileStartup } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const previous = startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now });
    previous.stage = 'form';
    previous.lastCandidate = { date: '2026-11-19', consulate: 'Vancouver' };
    previous.executor = { tabId: 9, applicantIds: ['77777777'], targetTime: '08:00', skippedDates: [], actionPending: reason === 'interrupted-action' };
    stored.engineStateV1 = reconcileStartup(previous, now, reason === 'restart');
    if (reason === 'orphan') stored.engineStateV1 = { ...stored.engineStateV1 as object, status: 'verifying', owner: null, runId: null };
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 120, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => [{ result: input.func.name === 'readDashboardGroups'
      ? { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] }
      : { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'June 21, 2027', applicantIds: ['77777777', '88888888'] } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, snapshot: expect.objectContaining({ status: 'running', reviewRequired: false }) })));
    expect(stored.engineStateV1).toMatchObject({ status: 'running', intent: null, stage: 'actions', lastCandidate: null, executor: { tabId: 7, targetTime: null, actionPending: false },
      group: { scheduleId: '11111111', currentDate: '2027-06-21', applicantIds: ['77777777', '88888888'] } });
    expect((stored.engineStateV1 as { runId: string }).runId).not.toBe(previous.runId);
    expect(chromeMock.scripting.executeScript.mock.calls.map((call: [{ func: { name: string } }]) => call[0].func.name)).toEqual(['readDashboardGroups', 'readCurrentAppointment']);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('retains the dashboard tab for unpaid alerts instead of opening a payment tab', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
      groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts',
      group: { scheduleId: '33333333', kind: 'unpaid', dashboardPath: '/en-ca/niv/groups' } });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(7, {
      url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment',
    });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(JSON.stringify(respond.mock.calls)).not.toContain('33333333');
  });

  it('replaces a legacy single-monitor slot with fresh per-consulate monitors on Start', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulates: ['Vancouver', 'Halifax'], earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    const scopeKey = 'alerts:33333333:Halifax,Vancouver:any:2026-11-01:2026-12-31';
    stored.unpaidMonitorV1 = { scopeKey, monitor: { scopeKey, alert: { observed: '2026-11-19', delivered: '2026-11-19', pending: false }, baseline: '2026-11-19', lastHealthyAt: new Date().toISOString() } };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
      groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts', group: { scheduleId: '33333333', kind: 'unpaid' } });
    const fresh = (consulate: string) => ({ scopeKey: `${scopeKey}:${consulate}`, alert: { delivered: null, pending: false }, baseline: null, lastHealthyAt: null });
    expect(stored.unpaidMonitorV1).toEqual({ scopeKey, monitors: { Halifax: fresh('Halifax'), Vancouver: fresh('Vancouver') } });
  });

  it('schedules a fast first alerts read instead of waiting a full cycle', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
      groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    } }]);
    const respond = vi.fn();
    const before = Date.now();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    const deadline = Date.parse((stored.engineStateV1 as { nextPollAt: string }).nextPollAt);
    expect(deadline - before).toBeGreaterThanOrEqual(0);
    expect(deadline - before).toBeLessThan(30_000);
  });

  it('reads on payment landing by pulling a pending alerts deadline forward', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
      groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    const runId = (stored.engineStateV1 as { runId: string }).runId;
    expect(runId).toBeTruthy();
    (stored.engineStateV1 as { nextPollAt: string }).nextPollAt = new Date(Date.now() + 60_000).toISOString();
    const deadline = (stored.engineStateV1 as { nextPollAt: string }).nextPollAt;
    tabsUpdated(9, { status: 'complete' }, { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' });
    const check = vi.fn();
    message({ type: 'PANEL_STATE' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, check);
    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).toBe(deadline);
    tabsUpdated(7, { status: 'complete' }, { id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' });
    await vi.waitFor(() => expect(Date.parse((stored.engineStateV1 as { nextPollAt: string }).nextPollAt) - Date.now()).toBeLessThan(5_000));
  });

  it.each(['start', 'verify'] as const)('advances %s authentication when its owned tab finishes loading', async purpose => {
    const { beginAuthentication } = await import('../src/engine/authentication');
    const { emptyEngineState, startRun, bindGroup } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    let initial = startRun(emptyEngineState(now), { ...args, mode: 'booking' });
    if (purpose === 'verify') initial = { ...bindGroup(initial, { ...args, binding: {
      scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', applicantIds: ['77777777'],
    } }), status: 'verifying', intent: { runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: true, createdAt: now } };
    const state = beginAuthentication(initial, purpose, now);
    stored.engineStateV1 = { ...state, authentication: { ...state.authentication!, tabId: 7 }, nextPollAt: new Date(Date.now() + 30_000).toISOString() };
    const url = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url, status: 'complete' });
    tabsUpdated(7, { status: 'complete' }, { id: 7, url });
    await vi.waitFor(() => expect(chromeMock.storage.local.set).toHaveBeenCalledWith({ engineStateV1: expect.objectContaining({
      authentication: expect.objectContaining({ tabId: 7, purpose, pending: false }), nextPollAt: expect.any(String),
    }) }));
    const accelerated = chromeMock.storage.local.set.mock.calls.find(([values]: [any]) => values.engineStateV1?.authentication?.tabId === 7)[0].engineStateV1;
    expect(Date.parse(accelerated.nextPollAt) - Date.parse(now)).toBeLessThan(2_000);
    expect(accelerated.intent).toEqual(initial.intent);
  });

  it.each(['unrelated', 'offsite', 'stale-url', 'loading', 'pending', 'stopped', 'maintenance-retry', 'cooldown'])('does not accelerate authentication on an invalid landing (%s)', async issue => {
    const { beginAuthentication } = await import('../src/engine/authentication');
    const { emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const state = beginAuthentication(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), 'start', now);
    const deadline = new Date(Date.now() + 30_000).toISOString();
    stored.engineStateV1 = { ...state, status: issue === 'stopped' ? 'stopped' : 'running',
      authentication: { ...state.authentication!, tabId: 7, pending: issue === 'pending', phase: issue === 'maintenance-retry' ? 'retry' : 'prepare' },
      cooldownUntil: issue === 'cooldown' ? deadline : null, nextPollAt: issue === 'stopped' ? null : deadline };
    const url = issue === 'offsite' ? 'https://example.invalid' : 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: issue === 'stale-url' ? 'https://example.invalid' : url, status: issue === 'loading' ? 'loading' : 'complete' });
    tabsUpdated(issue === 'unrelated' ? 9 : 7, { status: 'complete' }, { id: 7, url });
    await vi.advanceTimersByTimeAsync(0);
    expect((stored.engineStateV1 as { nextPollAt: string | null }).nextPollAt).toBe(issue === 'stopped' ? null : deadline);
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it.each(['gateway', 'monitoring', 'confirm', 'retry', 'cooldown'])('only accelerates routine paid navigation (%s)', async phase => {
    const { emptyEngineState, startRun, bindGroup } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const state = bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args, binding: {
      scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', applicantIds: ['77777777'],
    } });
    const deadline = new Date(Date.now() + 30_000).toISOString();
    stored.engineStateV1 = { ...state, stage: phase === 'monitoring' ? null : phase === 'confirm' ? 'confirm' : 'applicants',
      executor: { tabId: 7, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
      nextPollAt: deadline, consecutiveFailures: phase === 'retry' ? 1 : 0, cooldownUntil: phase === 'cooldown' ? deadline : null,
      intent: phase === 'confirm' ? { runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19',
        consulate: 'Vancouver', testMode: true, createdAt: now, phase: 'submitted' } : null };
    const url = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url, status: 'complete' });
    tabsUpdated(7, { status: 'complete' }, { id: 7, url });
    if (phase === 'gateway') {
      await vi.waitFor(() => expect(chromeMock.storage.local.set).toHaveBeenCalledWith({ engineStateV1: expect.objectContaining({ stage: 'applicants', nextPollAt: expect.any(String) }) }));
      const accelerated = chromeMock.storage.local.set.mock.calls.find(([values]: [any]) => values.engineStateV1?.stage === 'applicants')[0].engineStateV1;
      expect(Date.parse(accelerated.nextPollAt) - Date.parse(now)).toBeLessThan(2_000);
    } else {
      await vi.advanceTimersByTimeAsync(0);
      expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).toBe(deadline);
      expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    }
  });

  it('ignores landing fast-paths for other groups, loading tabs, or observed runs', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
      groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    const future = new Date(Date.now() + 60_000).toISOString();
    (stored.engineStateV1 as { nextPollAt: string }).nextPollAt = future;
    tabsUpdated(9, { status: 'loading' }, { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' });
    tabsUpdated(9, { status: 'complete' }, { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/99999999/payment' });
    await vi.advanceTimersByTimeAsync(0);
    expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).toBe(future);
    stored.engineObservationV1 = { runId: (stored.engineStateV1 as { runId: string }).runId, mode: 'alerts', checkedAt: new Date().toISOString(), dates: [], rows: [] };
    tabsUpdated(9, { status: 'complete' }, { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' });
    await vi.advanceTimersByTimeAsync(0);
    expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).toBe(future);
  });

  it('reuses the current payment tab for alerts Start instead of opening a login tab', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    const payment = 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment';
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 9, url: payment, active: true }] : [{ id: 9, url: payment }]);
    const respond = vi.fn();
    const before = Date.now();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(9, { url: 'https://ais.usvisa-info.com/en-ca/niv/' });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts', authentication: { tabId: 9, purpose: 'start' } });
    const deadline = Date.parse((stored.engineStateV1 as { nextPollAt: string }).nextPollAt);
    expect(deadline - before).toBeGreaterThanOrEqual(0);
    expect(deadline - before).toBeLessThan(5_000);
  });

  it('reuses a sole payment tab without touching an unrelated active tab', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    const payment = 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment';
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 1, url: 'https://mail.example.invalid/', active: true }]
        : [{ id: 1, url: 'https://mail.example.invalid/' }, { id: 9, url: payment }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(9, { url: 'https://ais.usvisa-info.com/en-ca/niv/' });
    expect(chromeMock.tabs.update).not.toHaveBeenCalledWith(1, expect.anything());
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts', authentication: { tabId: 9 } });
  });

  it('leaves a fresh root entry when no site tab can host alerts Start', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts', authentication: { tabId: null, purpose: 'start' } });
  });

  it('reuses a landing tab already at the site root without navigating', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    const landing = 'https://ais.usvisa-info.com/en-ca/niv/';
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 9, url: landing, active: true }] : [{ id: 9, url: landing }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 9, url: landing });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts', authentication: { tabId: 9, purpose: 'start' } });
  });

  it('prefers the toolbar-selected site tab when the panel lives in its own tab', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    const landing = 'https://ais.usvisa-info.com/en-ca/niv/';
    const panel = 'chrome-extension://synthetic-extension/panel.html';
    clicked({ id: 9, url: landing });
    await vi.waitFor(() => expect(chromeMock.scripting.executeScript).toHaveBeenCalled());
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 3, url: panel, active: true }] : [{ id: 3, url: panel }, { id: 9, url: landing }]);
    chromeMock.tabs.get.mockImplementation(async (tabId: number) => tabId === 9 ? { id: 9, url: landing } : { id: tabId, url: panel });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: panel }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts', authentication: { tabId: 9, purpose: 'start' } });
  });

  it('ignores a stale toolbar selection that left the site', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    const panel = 'chrome-extension://synthetic-extension/panel.html';
    clicked({ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/' });
    await vi.waitFor(() => expect(chromeMock.scripting.executeScript).toHaveBeenCalled());
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 3, url: panel, active: true }] : [{ id: 3, url: panel }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 9, url: 'https://mail.example.invalid/' });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: panel }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts', authentication: { tabId: null, purpose: 'start' } });
  });

  it.each([
    'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment',
    'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment',
  ])('reuses the current site tab for booking Start instead of opening a login tab (%s)', async url => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 9, url, active: true }] : [{ id: 9, url }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 9, url });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(9, { url: 'https://ais.usvisa-info.com/en-ca/niv/' });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'booking', authentication: { tabId: 9, purpose: 'start' } });
  });

  it('keeps a login tab as-is for booking Start without navigating', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    const login = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 9, url: login, active: true }] : [{ id: 9, url: login }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 9, url: login });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'booking', authentication: { tabId: 9, purpose: 'start' } });
  });

  it('leaves a fresh root entry for booking Start on an unrelated tab', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 1, url: 'https://mail.example.invalid/', active: true }] : [{ id: 1, url: 'https://mail.example.invalid/' }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'booking', authentication: { tabId: null, purpose: 'start' } });
  });

  it('navigates an unsupported same-origin page to the site root for booking Start', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    const unsupported = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/unknown-page';
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) =>
      query && query.active ? [{ id: 9, url: unsupported, active: true }] : [{ id: 9, url: unsupported }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 9, url: unsupported });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    // Dashboard-first destination: the site root reuses a valid session
    // (redirecting to the dashboard), and a signed-out landing advances
    // promptly to sign-in. Never an unrelated tab.
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(9, { url: 'https://ais.usvisa-info.com/en-ca/niv/' });
    expect(chromeMock.tabs.update).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'booking', authentication: { tabId: 9, purpose: 'start' } });
  });

  it('keeps an existing same-group payment tab and parks when the dashboard moves', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
      groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    } }]);
    chromeMock.tabs.query.mockResolvedValue([
      { id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' },
      { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' },
    ]);
    const kept = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, kept);
    await vi.waitFor(() => expect(kept).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', mode: 'alerts' });
  });

  it('parks unpaid alerts when the dashboard tab moves before reuse', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
      groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(stored.engineStateV1).toMatchObject({ status: 'verifying' });
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it.each(['moved', 'stopped'])('refuses unpaid authentication-tab navigation when its context is %s', async issue => {
    const { emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now });
    stored.engineStateV1 = { ...started, authentication: { tabId: 7, phase: 'wait', pending: false, purpose: 'start', startedAt: now } };
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    let liveUrl = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
    chromeMock.tabs.get.mockImplementation(async () => ({ id: 7, url: liveUrl }));
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] } }]);
    const stopped = vi.fn();
    chromeMock.tabs.query.mockImplementation(async () => {
      if (issue === 'moved') liveUrl = 'https://ais.usvisa-info.com/en-ca/niv/groups/66666666';
      else message({ type: 'PANEL_STOP' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, stopped);
      return [];
    });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: issue === 'stopped' ? 'stopped' : 'verifying', authentication: null }));
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('keeps the paused durable state when fresh dashboard validation fails', async () => {
    const { emptyEngineState, startRun, parkForReview } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const paused = parkForReview(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), now);
    stored.engineStateV1 = paused;
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [] } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false, error: 'The extension found no visa groups on this dashboard. Refresh the dashboard; if this repeats, report this message.', failureKind: 'generic' }));
    // The paused save is otherwise untouched; only the exact fixed selection
    // cause is retained for a Report a problem draft (no freshness bump).
    expect(stored.engineStateV1).toEqual({ ...paused, authenticationFailureReason: 'no-dashboard-group' });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('routes paused product Start to verification when a booking attempt is unresolved', async () => {
    const { emptyEngineState, startRun, bindGroup, recordIntent, parkForReview } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const bound = bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-06-21', applicantIds: ['77777777'] } });
    const intent = { runId: args.runId, groupId: '11111111', mode: 'booking' as const, targetDate: '2026-11-19', consulate: 'Vancouver', testMode: true, createdAt: now };
    stored.engineStateV1 = parkForReview(recordIntent(bound, { ...args, intent }), now);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(stored.engineStateV1).toMatchObject({ status: 'verifying', runId: args.runId, mode: 'booking', intent,
      authentication: { purpose: 'verify' }, group: bound.group });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it.each([true, false])('binds the account dashboard and fresh paid baseline with or without an appointment (%s)', async booked => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' }]);
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string }; args?: unknown[] }) => {
      if (input.func.name === 'readDashboardGroups') return [{ result: { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] } }];
      expect(input.args).toEqual(['11111111', '22222222', true, true, '/en-ca/niv/groups/55555555', true]);
      return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: booked ? 'booked' : 'unbooked', text: booked ? '6 November, 2026' : null, applicantIds: ['77777777', '88888888'] } }];
    });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(stored.engineStateV1).toMatchObject({ status: 'running', stage: 'actions', group: { kind: 'paid', dashboardPath: '/en-ca/niv/groups/55555555', currentDate: booked ? '2026-11-06' : null,
      applicantIds: ['77777777', '88888888'] }, executor: { tabId: 7 } });
  });

  it.each(['groups', 'selection', 'appointment', 'applicants'])('reports the specific failed Start step without copying private details (%s)', async step => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      if (input.func.name === 'readDashboardGroups') {
        if (step === 'groups') throw new Error('synthetic-private-exception');
        return [{ result: { groups: [{ scheduleId: '11111111', ivr: step === 'selection' ? '44444444' : '22222222',
          paymentStatus: step === 'selection' ? 'unpaid' : 'paid' }] } }];
      }
      if (step === 'appointment') throw new Error('synthetic-private-exception');
      return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: '6 November, 2026' } }];
    });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    const expected: Record<string, string> = {
      groups: 'The extension could not read group identities from this dashboard. Refresh the dashboard; if this repeats, report this message.',
      selection: 'No eligible paid group was found on this dashboard. Check the Paid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.',
      appointment: 'The extension could not refresh the selected group’s appointment and applicant details. Refresh the dashboard; if this repeats, report this message.',
      applicants: 'The extension could not read the complete applicant list for the selected group. If all applicants are visible, report this message.',
    };
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false, error: expected[step],
      failureKind: step === 'selection' ? 'paid-ivr-not-found' : 'generic' }));
    expect(stored.engineStateV1).toBeUndefined();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(JSON.stringify(respond.mock.calls)).not.toContain('synthetic-private-exception');
  });

  it.each([
    { mode: 'booking', dashboard: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }], kind: 'paid-ivr-not-found',
      error: 'No eligible paid group was found on this dashboard. Check the Paid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.' },
    { mode: 'alerts', dashboard: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }], kind: 'unpaid-ivr-not-found',
      error: 'No eligible unpaid group was found on this dashboard. Check the Unpaid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.' },
  ] as const)('classifies a wrong $kind IVR after a complete signed-in dashboard read', async ({ mode, dashboard, kind, error }) => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: dashboard } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false, error, failureKind: kind }));
    expect(stored.engineStateV1).toBeUndefined();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(JSON.stringify(respond.mock.calls)).not.toContain('22222222');
    expect(JSON.stringify(respond.mock.calls)).not.toContain('44444444');
  });

  it('schedules verification when the executor tab closes with a booking intent', async () => {
    const { emptyEngineState, startRun, bindGroup, recordIntent } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const bound = bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-06-21', applicantIds: ['77777777'] } });
    const intent = { runId: args.runId, mode: 'booking' as const, groupId: '11111111', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: now, phase: 'submitted' as const };
    // A polling posture (no executor stage) with an intent and a vanished
    // executor tab: the closed tab must schedule the read-only verification
    // pass with the settling delay instead of a bare park with no deadline.
    stored.engineStateV1 = { ...recordIntent(bound, { ...args, intent }),
      stage: null, executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
      nextPollAt: new Date(Date.now() - 1000).toISOString(), startedAt: now };
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying',
      verification: { reads: [] }, intent }));
    const scheduled = (stored.engineStateV1 as { verification: { nextReadAt: string } }).verification.nextReadAt;
    expect(Date.parse(scheduled) - Date.now()).toBeGreaterThan(0);
    expect(Date.parse(scheduled) - Date.now()).toBeLessThanOrEqual(30_000);
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('enginePoll', { when: Date.parse(scheduled) });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('parks bare when the executor tab closes without a booking intent', async () => {
    const { emptyEngineState, startRun, bindGroup } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const bound = bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-06-21', applicantIds: ['77777777'] } });
    stored.engineStateV1 = { ...bound,
      stage: null, executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
      nextPollAt: new Date(Date.now() - 1000).toISOString(), startedAt: now };
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying', verification: null, intent: null }));
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('parks a paid-only alerts Start on the dashboard without payment navigation', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
    ] } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false,
      error: 'No eligible unpaid group was found on this dashboard. Check the Unpaid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.',
      failureKind: 'unpaid-ivr-not-found' }));
    expect(stored.engineStateV1).toBeUndefined();
    // No booking workflow, no payment navigation, no new tabs.
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript.mock.calls.map((call: [{ func: { name: string } }]) => call[0].func.name))
      .toEqual(['readDashboardGroups']);
  });

  it('rejects an explicitly selected paid group for alerts without navigating', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '', unpaidIvr: '22222222' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
      { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' },
    ] } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false,
      error: 'The selected alert group is not eligible for date alerts. Check both Visa Group IVRs and payment status in Settings.',
      failureKind: 'unpaid-ivr-not-found' }));
    expect(stored.engineStateV1).toBeUndefined();
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('rejects a positively unpaid group for paid booking before any baseline read', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      if (input.func.name === 'readDashboardGroups') return [{ result: { groups: [
        { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' },
      ] } }];
      throw new Error('Baseline must not run after a wrong-status rejection.');
    });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false,
      error: 'The selected booking group is not eligible for paid booking. Check both Visa Group IVRs and payment status in Settings.',
      failureKind: 'paid-ivr-not-found' }));
    expect(stored.engineStateV1).toBeUndefined();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('uses the catch-all for blank unpaid Start on an unknown dashboard', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'unknown' },
    ] } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false,
      error: 'The extension could not read the selected group’s schedule or IVR Account Number. Refresh the dashboard; if this repeats, report this message.',
      failureKind: 'generic' }));
    expect(stored.engineStateV1).toBeUndefined();
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('reports an ambiguous dashboard as a generic failure without identifiers', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '11111111', ivr: '99999999', paymentStatus: 'paid' },
    ] } }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false,
      error: 'The extension found conflicting dashboard group identities. Refresh the dashboard; if this repeats, report this message.',
      failureKind: 'generic' }));
    expect(stored.engineStateV1).toBeUndefined();
    expect(JSON.stringify(respond.mock.calls)).not.toContain('99999999');
    const report = vi.fn();
    message({ type: 'ENGINE_PROBLEM_REPORT' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, report);
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({
      ok: true, context: expect.objectContaining({ failureCode: 'dashboard-groups-ambiguous' }),
    })));
  });

  it('uses a fast wake for same-tab Continue and cancels the next stage on Stop', async () => {
    const dashboard = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
    let ownedUrl = dashboard;
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: dashboard }]);
    chromeMock.tabs.get.mockImplementation(async () => ({ id: 7, url: ownedUrl, status: 'complete' }));
    const actions: string[] = [];
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      if (input.func.name === 'readDashboardGroups') return [{ result: { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] } }];
      if (input.func.name === 'readCurrentAppointment') return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: '6 November, 2026', applicantIds: ['77777777'] } }];
      if (input.func.name === 'performDashboardContinue') { actions.push(input.func.name); ownedUrl = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/continue_actions'; return [{ result: { ok: true } }]; }
      throw new Error('Unexpected stage after Stop');
    });
    const sender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' };
    const started = vi.fn(); message({ type: 'PANEL_START', mode: 'booking' }, sender, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(actions).toEqual(['performDashboardContinue']));
    expect(stored.engineStateV1).toMatchObject({ executor: { tabId: 7, actionPending: false }, stage: 'actions' });
    alarmed({ name: 'enginePoll' });
    const stopped = vi.fn(); message({ type: 'PANEL_STOP' }, sender, stopped);
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(actions).toHaveLength(1);
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped', nextPollAt: null });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('binds and continues a blank-setting null-IVR dashboard card end to end', async () => {
    const dashboard = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
    let ownedUrl = dashboard;
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: dashboard }]);
    chromeMock.tabs.get.mockImplementation(async () => ({ id: 7, url: ownedUrl, status: 'complete' }));
    const continues: unknown[] = [];
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string }, args?: unknown[] }) => {
      if (input.func.name === 'readDashboardGroups') return [{ result: { groups: [
        { scheduleId: '11111111', ivr: null, continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentStatus: 'paid' },
      ] } }];
      if (input.func.name === 'readCurrentAppointment') return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: '6 November, 2026', applicantIds: ['77777777'] } }];
      if (input.func.name === 'performDashboardContinue') {
        continues.push(input.args?.[0]);
        ownedUrl = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/continue_actions';
        return [{ result: { ok: true } }];
      }
      throw new Error('Unexpected stage after binding');
    });
    const sender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' };
    const started = vi.fn(); message({ type: 'PANEL_START', mode: 'booking' }, sender, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    expect(stored.engineStateV1).toMatchObject({ group: { scheduleId: '11111111', ivr: null, kind: 'paid', currentDate: '2026-11-06', applicantIds: ['77777777'] },
      stage: 'actions', executor: { tabId: 7, actionPending: false } });
    // The stable schedule is bound with a null IVR; the value is never invented.
    expect((stored.engineStateV1 as { group: { ivr: unknown } }).group.ivr).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(continues).toEqual([{ scheduleId: '11111111', ivr: null, dashboardPath: '/en-ca/niv/groups/55555555', applicantIds: ['77777777'] }]));
    await vi.waitFor(() => {
      const entries = (stored.engineDiagnosticsV1 as { entries?: Array<{ code: string }> } | undefined)?.entries ?? [];
      expect(entries.map(entry => entry.code)).toContain('ivr-unreadable-proceeded');
    });
    expect(stored.engineStateV1).toMatchObject({ stage: 'actions', executor: { tabId: 7, actionPending: false } });
  });

  it('binds a blank-setting unknown-payment dashboard card as a pending inspection', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '', unpaidIvr: '' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }]);
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      if (input.func.name === 'readDashboardGroups') return [{ result: { groups: [
        { scheduleId: '11111111', ivr: '22222222', continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentStatus: 'unknown' },
      ] } }];
      if (input.func.name === 'readCurrentAppointment') return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: ['77777777'] } }];
      throw new Error('Unexpected stage after binding');
    });
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(stored.engineStateV1).toMatchObject({ group: { scheduleId: '11111111', ivr: '22222222', kind: 'paid',
      currentDate: null, pendingInspection: true, applicantIds: ['77777777'] }, stage: 'actions' });
    expect((stored.engineStateV1 as { group: { pendingInspection: unknown } }).group.pendingInspection).toBe(true);
    await vi.waitFor(() => {
      const entries = (stored.engineDiagnosticsV1 as { entries?: Array<{ code: string }> } | undefined)?.entries ?? [];
      expect(entries.map(entry => entry.code)).toContain('payment-unknown-proceeded');
    });
  });

  it('refuses website commands and starts trusted signed-out runs with automatic login in live mode', async () => {
    expect(message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }, vi.fn())).toBeUndefined();
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '', unpaidIvr: '' };
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'booking' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toMatchObject({ status: 'running', authentication: { purpose: 'start', tabId: null } });
    expect(JSON.stringify(stored.engineStateV1)).not.toContain('synthetic-password');
  });

  it.each([false, true])('retires a stopped failure on changed settings only without unresolved intent (%s)', async unresolved => {
    const { emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const state = startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now });
    const intent = { runId: state.runId!, mode: 'booking' as const, groupId: '11111111', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: true, createdAt: now };
    stored.engineStateV1 = { ...state, status: 'stopped', loginFailed: true,
      authenticationError: 'No eligible paid group was found on this dashboard. Check the Paid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.',
      intent: unresolved ? intent : null };
    preferencesChanged({ uiPreferencesV1: { newValue: { paidIvr: '22222222' } } }, 'local');
    await vi.advanceTimersByTimeAsync(0);
    if (unresolved) expect(stored.engineStateV1).toMatchObject({ status: 'stopped', loginFailed: true, intent, authenticationError: expect.any(String) });
    else expect(stored.engineStateV1).toMatchObject({ status: 'stopped', loginFailed: false, authenticationError: null, intent: null });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('parks a run on credential/settings changes without copying changed credentials to engine state', async () => {
    const { emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now });
    preferencesChanged({ uiPreferencesV1: { newValue: { password: 'synthetic-changed-password' } } }, 'local');
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying', nextPollAt: null }));
    expect(JSON.stringify(stored.engineStateV1)).not.toContain('synthetic-changed-password');
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('restricts local storage and probes only the explicitly selected trusted tab', async () => {
    clicked({ id: 42, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/00123/payment' });
    await vi.waitFor(() => expect(chromeMock.windows.create).toHaveBeenCalledTimes(1));
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeMock.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'chrome-extension://synthetic-extension/panel.html?detached=1', type: 'popup' }));
    expect(chromeMock.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(chromeMock.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 42 });
    expect(stored.developmentProbe).toMatchObject({ route: 'payment', documentReachable: true });
    expect(JSON.stringify(stored)).not.toContain('00123');
    expect(JSON.stringify(stored)).not.toContain('https://');
  });

  it('does not inject into an off-site tab', async () => {
    clicked({ id: 42, url: 'https://example.invalid/' });
    await vi.waitFor(() => expect(chromeMock.windows.create).toHaveBeenCalledTimes(1));
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(stored.developmentProbe).toMatchObject({ route: 'untrusted', documentReachable: false });
  });

  it('does not persist private error text when a page disappears', async () => {
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('private-url-or-secret'));
    clicked({ id: 42, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in' });
    await vi.waitFor(() => expect(chromeMock.windows.create).toHaveBeenCalledTimes(1));
    expect(stored.developmentProbe).toMatchObject({ route: 'login', documentReachable: false });
    expect(JSON.stringify(stored)).not.toContain('private-url-or-secret');
  });

  it('rejects wake-up requests from website contexts', () => {
    const respond = vi.fn();
    message({ type: 'PROBE_WAKE' }, { id: 'synthetic-extension', url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }, respond);
    expect(chromeMock.alarms.create).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('pinpoints through a trusted panel request while ignoring message-supplied URLs and tab IDs', async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, windowId: 80, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in' }]);
    chromeMock.tabs.get.mockResolvedValue({ id: 7, windowId: 80, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in' });
    const respond = vi.fn();
    message({ type: 'PANEL_FOCUS_TAB', tabId: 999, url: 'https://example.invalid/' },
      { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html?detached=1' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true }));
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(stored.engineStateV1).toBeUndefined();
  });

  it('rejects pinpoint requests from the website and other extension pages', () => {
    for (const url of ['https://ais.usvisa-info.com/en-ca/niv/groups', 'chrome-extension://synthetic-extension/probe.html']) {
      const respond = vi.fn();
      message({ type: 'PANEL_FOCUS_TAB' }, { id: 'synthetic-extension', url }, respond);
      expect(respond).not.toHaveBeenCalled();
    }
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it('keeps unpaid polling on its retained tab and parks if it closes despite a duplicate', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = { ...bindGroup(startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
      owner: 'owner-token-01', runId: 'run-id-0001', now, binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
    }), monitorTabId: 8 };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', interval: 60 };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' }]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying', monitorTabId: 8 }));
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('allows a bounded wake-up request from the bundled report page', async () => {
    const respond = vi.fn();
    expect(message({ type: 'PROBE_WAKE' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/probe.html' }, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true }));
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('developmentProbeWake', { delayInMinutes: 1 });
  });

  it('refuses live reads from website contexts and wrong routes', async () => {
    const website = vi.fn();
    message({ type: 'PROBE_READ', kind: 'dashboard' }, { id: 'synthetic-extension', url: 'https://ais.usvisa-info.com/en-ca/niv/groups' }, website);
    expect(website).not.toHaveBeenCalled();
    clicked({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    await vi.waitFor(() => expect(chromeMock.scripting.executeScript).toHaveBeenCalled());
    const callsBefore = chromeMock.scripting.executeScript.mock.calls.length;
    const refused = vi.fn();
    message({ type: 'PROBE_READ', kind: 'summary' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/probe.html' }, refused);
    await vi.waitFor(() => expect(refused).toHaveBeenCalledWith({ ok: false, route: 'dashboard' }));
    expect(chromeMock.scripting.executeScript.mock.calls.length).toBe(callsBefore);
  });

  it('reads dashboard links on the toolbar-selected tab and reports counts only', async () => {
    clicked({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    await vi.waitFor(() => expect(chromeMock.scripting.executeScript).toHaveBeenCalled());
    chromeMock.scripting.executeScript.mockResolvedValue([
      { result: { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: null }] } },
    ]);
    const respond = vi.fn();
    message({ type: 'PROBE_READ', kind: 'dashboard' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/probe.html' }, respond);
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ ok: true, route: 'dashboard', count: 2, identified: 1 }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain('11111111');
    expect(JSON.stringify(respond.mock.calls)).not.toContain('22222222');
  });

  it('refuses reads before any toolbar selection', async () => {
    const respond = vi.fn();
    message({ type: 'PROBE_READ', kind: 'dashboard' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/probe.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false, route: 'untrusted' }));
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('resolves IVRs against the live snapshot and durably binds the run', async () => {
    stored.uiPreferencesV1 = { paidIvr: '22222222', unpaidIvr: '44444444' };
    clicked({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    await vi.waitFor(() => expect(chromeMock.scripting.executeScript).toHaveBeenCalled());
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => [{ result: input.func.name === 'readCurrentAppointment'
      ? { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'June 21, 2027', applicantIds: ['77777777', '88888888'] }
      : { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] } }]);
    const probe = 'chrome-extension://synthetic-extension/probe.html';
    const bound = vi.fn();
    message({ type: 'PROBE_RESOLVE', mode: 'booking' }, { id: 'synthetic-extension', url: probe }, bound);
    await vi.waitFor(() =>
      expect(bound).toHaveBeenCalledWith({ ok: true, mode: 'booking', status: 'running', bound: true, groupKind: 'paid' }),
    );
    expect(stored.engineStateV1).toMatchObject({
      group: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-06-21' },
    });
    expect(JSON.stringify(bound.mock.calls)).not.toContain('11111111');
    expect(JSON.stringify(bound.mock.calls)).not.toContain('22222222');
    const stopped = vi.fn();
    message({ type: 'PROBE_STOP' }, { id: 'synthetic-extension', url: probe }, stopped);
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledWith({ ok: true, status: 'stopped' }));
  });

  it('leaves zero trace when live resolution fails', async () => {
    stored.uiPreferencesV1 = { paidIvr: '22222222', unpaidIvr: '99999999' };
    clicked({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    await vi.waitFor(() => expect(chromeMock.scripting.executeScript).toHaveBeenCalled());
    chromeMock.scripting.executeScript.mockResolvedValue([
      { result: { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] } },
    ]);
    const refused = vi.fn();
    message({ type: 'PROBE_RESOLVE', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/probe.html' }, refused);
    await vi.waitFor(() => expect(refused).toHaveBeenCalledWith({ ok: false }));
    expect(stored.engineStateV1).toBeUndefined();
  });

  it('kicks one poll cycle for a bound run and refuses idle runs', async () => {
    const probe = 'chrome-extension://synthetic-extension/probe.html';
    const refused = vi.fn();
    message({ type: 'PROBE_POLL' }, { id: 'synthetic-extension', url: probe }, refused);
    await vi.waitFor(() => expect(refused).toHaveBeenCalledWith({ ok: false }));
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'alerts', owner: 'probe-owner-dev', runId: 'run-id-0001', now });
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(started, {
          owner: 'probe-owner-dev',
          runId: 'run-id-0001',
          binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
          now,
        }),
      ),
    );
    const kicked = vi.fn();
    message({ type: 'PROBE_POLL' }, { id: 'synthetic-extension', url: probe }, kicked);
    await vi.waitFor(() => expect(kicked).toHaveBeenCalledWith({ ok: true, status: 'running' }));
    expect(kicked).toHaveBeenCalledTimes(1);
    expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).not.toBeNull();
    const website = vi.fn();
    message({ type: 'PROBE_POLL' }, { id: 'synthetic-extension', url: 'https://example.invalid/' }, website);
    expect(website).not.toHaveBeenCalled();
  });

  it('resets the monitor baseline without touching engine runs', async () => {
    const probe = 'chrome-extension://synthetic-extension/probe.html';
    const empty = vi.fn();
    message({ type: 'PROBE_RESET' }, { id: 'synthetic-extension', url: probe }, empty);
    await vi.waitFor(() => expect(empty).toHaveBeenCalledWith({ ok: false }));
    const now = new Date().toISOString();
    stored.unpaidMonitorV1 = {
      scopeKey: 'scope-1',
      monitors: {
        Toronto: {
          scopeKey: 'scope-1:Toronto',
          alert: { observed: '2026-11-19', delivered: '2026-11-19', pending: false },
          baseline: '2026-11-19',
          lastHealthyAt: now,
        },
        Vancouver: {
          scopeKey: 'scope-1:Vancouver',
          alert: { observed: '2026-11-25', delivered: null, pending: true },
          baseline: '2026-11-25',
          lastHealthyAt: now,
        },
      },
    };
    const reset = vi.fn();
    message({ type: 'PROBE_RESET' }, { id: 'synthetic-extension', url: probe }, reset);
    await vi.waitFor(() => expect(reset).toHaveBeenCalledWith({ ok: true }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(stored.unpaidMonitorV1).toEqual({
      scopeKey: 'scope-1',
      monitors: {
        Toronto: { scopeKey: 'scope-1:Toronto', alert: { delivered: null, pending: false }, baseline: null, lastHealthyAt: now },
        Vancouver: { scopeKey: 'scope-1:Vancouver', alert: { delivered: null, pending: false }, baseline: null, lastHealthyAt: now },
      },
    });
    expect(stored.engineStateV1).toBeUndefined();
    const website = vi.fn();
    message({ type: 'PROBE_RESET' }, { id: 'synthetic-extension', url: 'https://example.invalid/' }, website);
    expect(website).not.toHaveBeenCalled();
  });

  it('reports engine posture without identifiers', async () => {
    const probe = 'chrome-extension://synthetic-extension/probe.html';
    const idle = vi.fn();
    message({ type: 'PROBE_STATUS' }, { id: 'synthetic-extension', url: probe }, idle);
    await vi.waitFor(() => expect(idle).toHaveBeenCalledWith(expect.objectContaining({ ok: true, status: 'idle' })));
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'alerts', owner: 'probe-owner-dev', runId: 'run-id-0001', now });
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(started, {
          owner: 'probe-owner-dev',
          runId: 'run-id-0001',
          binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
          now,
        }),
      ),
    );
    stored.uiPreferencesV1 = { consulates: ['Vancouver', 'Toronto'], earliest: '2026-11-01', latest: '2026-12-31' };
    stored.unpaidMonitorV1 = {
      scopeKey: 'alerts:33333333:Toronto,Vancouver:any:2026-11-01:2026-12-31',
      monitors: {
        Toronto: { scopeKey: 'alerts:33333333:Toronto,Vancouver:any:2026-11-01:2026-12-31:Toronto', alert: { observed: '2026-11-19', delivered: null, pending: true }, baseline: null, lastHealthyAt: now },
        Vancouver: { scopeKey: 'alerts:33333333:Toronto,Vancouver:any:2026-11-01:2026-12-31:Vancouver', alert: { observed: '2026-11-21', delivered: '2026-11-21', pending: false }, baseline: '2026-11-21', lastHealthyAt: now },
      },
    };
    const status = vi.fn();
    message({ type: 'PROBE_STATUS' }, { id: 'synthetic-extension', url: probe }, status);
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, status: 'running', mode: 'alerts', groupKind: 'unpaid', monitorPending: true,
          monitorDelivered: null, monitorBaseline: null, lastHealthyAt: now }),
      ),
    );
    expect(JSON.stringify(status.mock.calls)).not.toContain('33333333');
    expect(JSON.stringify(status.mock.calls)).not.toContain('44444444');
    const website = vi.fn();
    message({ type: 'PROBE_STATUS' }, { id: 'synthetic-extension', url: 'https://example.invalid/' }, website);
    expect(website).not.toHaveBeenCalled();
  });

  it('exposes counts-only poll footprints without dates', async () => {
    const probe = 'chrome-extension://synthetic-extension/probe.html';
    stored.lastPollV1 = { status: 200, dayCount: 4, at: new Date().toISOString() };
    const status = vi.fn();
    message({ type: 'PROBE_STATUS' }, { id: 'synthetic-extension', url: probe }, status);
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith(expect.objectContaining({ ok: true, lastPollStatus: 200, lastPollDays: 4 })),
    );
  });

  it('runs the paid poll loop on the bound appointment tab', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now });
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(started, {
          owner: 'owner-token-01',
          runId: 'run-id-0001',
          binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null },
          now,
        }),
      ),
    );
    stored.uiPreferencesV1 = {
      consulate: 'Vancouver',
      earliest: '2026-11-01',
      latest: '2026-12-31',
      onlyEarlier: false,
      testMode: true,
    };
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' },
    ]);
    preparePaidPoll();
    mockPaidPoll({ status: 200, body: [{ date: '2026-11-19' }] });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() =>
      expect((stored.engineStateV1 as { lastCandidate: unknown }).lastCandidate).toEqual({ date: '2026-11-19', consulate: 'Vancouver' }),
    );
    expect((stored.engineStateV1 as { consecutiveFailures: number }).consecutiveFailures).toBe(0);
    expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).not.toBeNull();
    expect(chromeMock.scripting.executeScript.mock.calls[1][0].args).toEqual([
      '/en-ca/niv/schedule/11111111/appointment',
      95,
    ]);
    const history = vi.fn();
    message({ type: 'PANEL_HISTORY' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, history);
    await vi.waitFor(() => expect(history).toHaveBeenCalledWith({ ok: true, rows: [expect.objectContaining({ earliestDate: '2026-11-19', booked: 'No' })] }));
    expect(JSON.stringify(history.mock.calls)).not.toContain('11111111');
  });

  it.each(['booking', 'alerts'] as const)('paces %s cooldown expiry and ignores duplicate alarms', async mode => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = {
      ...bindGroup(startRun(emptyEngineState(now), { mode, owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: mode === 'booking' ? 'paid' : 'unpaid', currentDate: null },
      }),
      consecutiveFailures: mode === 'booking' ? 3 : 9,
    };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([{
      id: 9, url: `https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/${mode === 'booking' ? 'appointment' : 'payment'}`,
    }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{
      result: mode === 'booking' ? { status: 200, body: [] } : { headingFound: false, rows: [] },
    }]);
    if (mode === 'booking') {
      preparePaidPoll();
      mockPaidPoll({ status: 200, body: [] });
    }
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ cooldownUntil: expect.any(String), nextPollAt: null }));
    const state = stored.engineStateV1 as { cooldownUntil: string; nextPollAt: string | null };
    expect(chromeMock.alarms.create.mock.calls.filter((call: unknown[]) => call[0] === 'enginePoll').at(-1)).toEqual(['enginePoll', { when: Date.parse(state.cooldownUntil) }]);
    alarmed({ name: 'enginePoll' });
    // A queued status response is a barrier after the alarm handler.
    const status = vi.fn();
    message({ type: 'PROBE_STATUS' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/probe.html' }, status);
    await vi.waitFor(() => expect(status).toHaveBeenCalled());
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(mode === 'booking' ? 2 : 1);
    state.cooldownUntil = new Date(Date.now() - 1000).toISOString();
    alarmed({ name: 'enginePoll' });
    alarmed({ name: 'enginePoll' });
    status.mockClear();
    message({ type: 'PROBE_STATUS' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/probe.html' }, status);
    await vi.waitFor(() => expect(status).toHaveBeenCalled());
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(mode === 'booking' ? 4 : 2);
    expect(stored.engineStateV1).toMatchObject({ consecutiveFailures: 1, cooldownUntil: null, nextPollAt: expect.any(String) });
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('stops on access-denied and parks on tab loss or bad configuration', async () => {    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const seed = () => {
      const now = new Date().toISOString();
      const started = startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now });
      stored.engineStateV1 = JSON.parse(
        JSON.stringify(
          bindGroup(started, {
            owner: 'owner-token-01',
            runId: 'run-id-0001',
            binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null },
            now,
          }),
        ),
      );
      stored.uiPreferencesV1 = {
        consulate: 'Vancouver',
        earliest: '2026-11-01',
        latest: '2026-12-31',
        onlyEarlier: false,
        testMode: true,
      };
      chromeMock.tabs.query.mockResolvedValue([
        { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' },
      ]);
    };
    seed();
    preparePaidPoll();
    mockPaidPoll({ status: 403, body: null });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', authentication: { purpose: 'renew' }, sessionRenewals: 1 }));
    seed();
    preparePaidPoll();
    chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://example.invalid/' }]);
    chromeMock.scripting.executeScript.mockClear();
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect((stored.engineStateV1 as { status: string }).status).toBe('verifying'));
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    seed();
    preparePaidPoll();
    stored.uiPreferencesV1 = { consulate: 'Atlantis', earliest: '2026-11-01', latest: '2026-12-31' };
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect((stored.engineStateV1 as { status: string }).status).toBe('verifying'));
  });

  it.each(['supported', 'missing-heading', 'missing-city', 'redirected'])(
    'inspects provisional Alerts capability without accepting an unsupported summary (%s)', async issue => {
      const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
      const now = new Date().toISOString();
      stored.engineStateV1 = bindGroup(startRun(emptyEngineState(now), {
        mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now,
      }), { owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '33333333', ivr: null, kind: 'unpaid', currentDate: null, pendingInspection: true } });
      stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31' };
      const url = 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment';
      chromeMock.tabs.query.mockResolvedValue([{ id: 5, url }]);
      chromeMock.tabs.get.mockResolvedValue({ id: 5, url: issue === 'redirected' ? 'https://example.invalid/' : url });
      const cities = ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver'];
      chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
        headingFound: issue !== 'missing-heading',
        rows: (issue === 'missing-city' ? cities.slice(1) : cities).map(city => ({ city, text: 'No Appointments Available' })),
      } }]);
      alarmed({ name: 'enginePoll' });
      if (issue === 'supported') {
        await vi.waitFor(() => expect(stored.engineObservationV1).toBeDefined());
        expect(stored.engineStateV1).toMatchObject({ group: { scheduleId: '33333333' }, consecutiveFailures: 0 });
        expect((stored.engineStateV1 as any).group.pendingInspection).toBeUndefined();
      } else {
        await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ consecutiveFailures: 1 }));
        expect((stored.engineStateV1 as any).group.pendingInspection).toBe(true);
        expect(stored.engineObservationV1).toBeUndefined();
      }
      expect(chromeMock.notifications.create).not.toHaveBeenCalled();
      expect(chromeMock.scripting.executeScript.mock.calls[0][0]).toMatchObject({ target: { tabId: 5 }, args: ['33333333'] });
    });

  it('notifies selected-consulate changes from the payment summary loop', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now });
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(started, {
          owner: 'owner-token-01',
          runId: 'run-id-0001',
          binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
          now,
        }),
      ),
    );
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31' };
    chromeMock.tabs.query.mockResolvedValue([
      { id: 5, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' },
    ]);
    const cities = ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver'];
    chromeMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          headingFound: true,
          rows: cities.map(city => ({ city, text: city === 'Vancouver' ? 'November 19, 2026' : 'No Appointments Available' })),
        },
      },
    ]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(chromeMock.notifications.create).toHaveBeenCalled());
    expect(chromeMock.notifications.create.mock.calls[0][0]).toMatchObject({ type: 'basic', title: 'US Visa Scheduler for Canada' });
    expect(chromeMock.notifications.create.mock.calls[0][0].message).toBe('New date available: 2026-11-19 (Vancouver)');
    expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).not.toBeNull();
    const saved = stored.unpaidMonitorV1 as { scopeKey: string; monitors: { Vancouver: { alert: { delivered: string } } } };
    expect(saved.scopeKey).toBe('alerts:33333333:Vancouver:any:2026-11-01:2026-12-31');
    expect(Object.keys(saved.monitors)).toEqual(['Vancouver']);
    expect(saved.monitors.Vancouver.alert.delivered).toBe('2026-11-19');
    const history = vi.fn();
    message({ type: 'PANEL_HISTORY' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, history);
    await vi.waitFor(() => expect(history).toHaveBeenCalledWith({ ok: true, rows: [expect.objectContaining({ earliestDate: '2026-11-19', booked: 'No' })] }));
  });

  describe('multi-consulate alerts', () => {
    const CITIES = ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver'];
    const SCOPE = 'alerts:33333333:Halifax,Toronto:any:2026-11-01:2026-12-31';
    async function bindAlerts(consulates: unknown) {
      const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
      const now = new Date().toISOString();
      stored.engineStateV1 = JSON.parse(JSON.stringify(bindGroup(
        startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now }),
        { owner: 'owner-token-01', runId: 'run-id-0001', now, binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null } },
      )));
      stored.uiPreferencesV1 = { consulates, earliest: '2026-11-01', latest: '2026-12-31' };
      chromeMock.tabs.query.mockResolvedValue([{ id: 5, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' }]);
      return now;
    }
    function summary(dates: Record<string, string>, cities = CITIES) {
      chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
        headingFound: true, rows: cities.map(city => ({ city, text: dates[city] ?? 'No Appointments Available' })),
      } }]);
    }

    it('notifies per consulate whose summary date changed', async () => {
      const now = await bindAlerts(['Toronto', 'Halifax']);
      stored.unpaidMonitorV1 = { scopeKey: SCOPE, monitors: {
        Halifax: { scopeKey: `${SCOPE}:Halifax`, alert: { observed: '2026-11-20', delivered: '2026-11-20', pending: false }, baseline: '2026-11-20', lastHealthyAt: now },
        Toronto: { scopeKey: `${SCOPE}:Toronto`, alert: { observed: null, delivered: null, pending: false }, baseline: null, lastHealthyAt: now },
      } };
      summary({ Halifax: 'November 18, 2026' });
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect((stored.unpaidMonitorV1 as any).monitors.Halifax.alert.delivered).toBe('2026-11-18'));
      expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
      expect(chromeMock.notifications.create.mock.calls.map((call: unknown[]) => (call[0] as { message: string }).message)).toEqual(['New date available: 2026-11-18 (Halifax)']);
      expect((stored.unpaidMonitorV1 as any).monitors.Halifax.alert.delivered).toBe('2026-11-18');
      expect((stored.unpaidMonitorV1 as any).monitors.Toronto.alert.delivered).toBeNull();
      expect((stored.unpaidMonitorV1 as any).scopeKey).toBe(SCOPE);
    });

    it('notifies every changed consulate in order from one summary read and creates missing monitors fresh', async () => {
      await bindAlerts(['Toronto', 'Halifax']);
      stored.unpaidMonitorV1 = { scopeKey: SCOPE, monitors: {} };
      summary({ Halifax: 'November 18, 2026', Toronto: 'December 2, 2026', Vancouver: 'November 5, 2026' });
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(chromeMock.notifications.create).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect((stored.unpaidMonitorV1 as any).monitors.Toronto.alert.delivered).toBe('2026-12-02'));
      expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
      expect(chromeMock.notifications.create.mock.calls.map((call: unknown[]) => (call[0] as { message: string }).message)).toEqual([
        'New date available: 2026-11-18 (Halifax)', 'New date available: 2026-12-02 (Toronto)']);
      const slot = stored.unpaidMonitorV1 as any;
      expect(Object.keys(slot.monitors).sort()).toEqual(['Halifax', 'Toronto']);
      expect(slot.monitors.Halifax).toMatchObject({ scopeKey: `${SCOPE}:Halifax`, baseline: '2026-11-18', alert: { delivered: '2026-11-18', pending: false } });
      expect(slot.monitors.Toronto).toMatchObject({ scopeKey: `${SCOPE}:Toronto`, baseline: '2026-12-02', alert: { delivered: '2026-12-02', pending: false } });
      expect(JSON.stringify(stored.engineDiagnosticsV1 ?? null)).not.toMatch(/Halifax|Toronto|2026-11-18|2026-12-02/);
    });

    it('keeps notifying later consulates when an earlier notification fails', async () => {
      await bindAlerts(['Toronto', 'Halifax']);
      stored.unpaidMonitorV1 = { scopeKey: SCOPE, monitors: {} };
      summary({ Halifax: 'November 18, 2026', Toronto: 'December 2, 2026' });
      chromeMock.notifications.create.mockRejectedValueOnce(new Error('synthetic notification failure'));
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ consecutiveFailures: 1 }));
      expect(chromeMock.notifications.create.mock.calls.map((call: unknown[]) => (call[0] as { message: string }).message)).toEqual([
        'New date available: 2026-11-18 (Halifax)', 'New date available: 2026-12-02 (Toronto)']);
      const slot = stored.unpaidMonitorV1 as any;
      expect(slot.monitors.Halifax.alert).toMatchObject({ observed: '2026-11-18', delivered: null, pending: true });
      expect(slot.monitors.Toronto.alert).toMatchObject({ observed: '2026-12-02', delivered: '2026-12-02', pending: false });
    });

    it.each([[[]], [['Atlantis']], [null]])('parks an empty or invalid selection (%j) without reading', async consulates => {
      await bindAlerts(consulates);
      summary({ Halifax: 'November 18, 2026' });
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying', nextPollAt: null }));
      expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
      expect(chromeMock.notifications.create).not.toHaveBeenCalled();
    });

    it('parks on a legacy single-monitor slot outside Start and leaves it untouched', async () => {
      const now = await bindAlerts(['Halifax', 'Toronto']);
      const legacy = { scopeKey: SCOPE, monitor: { scopeKey: SCOPE, alert: { observed: null, delivered: null, pending: false }, baseline: null, lastHealthyAt: now } };
      stored.unpaidMonitorV1 = legacy;
      summary({ Halifax: 'November 18, 2026' });
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying', consecutiveFailures: 0, nextPollAt: null }));
      expect(chromeMock.notifications.create).not.toHaveBeenCalled();
      expect(stored.unpaidMonitorV1).toEqual(legacy);
    });

    it('parks when the stored slot belongs to a different consulate selection', async () => {
      const now = await bindAlerts(['Halifax', 'Toronto']);
      const other = { scopeKey: 'alerts:33333333:Halifax:any:2026-11-01:2026-12-31', monitors: {
        Halifax: { scopeKey: 'alerts:33333333:Halifax:any:2026-11-01:2026-12-31:Halifax', alert: { observed: null, delivered: null, pending: false }, baseline: null, lastHealthyAt: now } } };
      stored.unpaidMonitorV1 = other;
      summary({ Halifax: 'November 18, 2026' });
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying', nextPollAt: null }));
      expect(chromeMock.notifications.create).not.toHaveBeenCalled();
      expect(stored.unpaidMonitorV1).toEqual(other);
    });

    it('treats a summary missing a selected row as a malformed read', async () => {
      await bindAlerts(['Calgary', 'Toronto']);
      summary({ Toronto: 'November 18, 2026' }, CITIES.filter(city => city !== 'Calgary'));
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ consecutiveFailures: 1 }));
      expect(chromeMock.notifications.create).not.toHaveBeenCalled();
      expect(stored.unpaidMonitorV1).toBeUndefined();
    });
  });

  it('restricts history reads to the product panel and ignores supplied observations/outcomes', async () => {
    const denied = vi.fn();
    for (const sender of [
      { id: 'other-extension', url: 'chrome-extension://synthetic-extension/panel.html' },
      { id: 'synthetic-extension', url: 'https://ais.usvisa-info.com/en-ca/niv/groups' },
      { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/probe.html' },
    ]) message({ type: 'PANEL_HISTORY' }, sender, denied);
    expect(denied).not.toHaveBeenCalled();
    const accepted = vi.fn();
    message({ type: 'PANEL_HISTORY', rows: [{ earliestDate: '2026-11-19', booked: 'Yes' }], url: 'https://example.invalid' },
      { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, accepted);
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith({ ok: true, rows: [] }));
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('retries malformed summaries and parks without a payment tab', async () => {    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const seed = (prefs: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const started = startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now });
      stored.engineStateV1 = JSON.parse(
        JSON.stringify(
          bindGroup(started, {
            owner: 'owner-token-01',
            runId: 'run-id-0001',
            binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
            now,
          }),
        ),
      );
      stored.uiPreferencesV1 = prefs;
      chromeMock.tabs.query.mockResolvedValue([
        { id: 5, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' },
      ]);
    };
    seed({ consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { headingFound: false, rows: [] } }]);
    chromeMock.notifications.create.mockClear();
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() =>
      expect((stored.engineStateV1 as { consecutiveFailures: number }).consecutiveFailures).toBe(1),
    );
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
    seed({ consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31' });
    chromeMock.tabs.query.mockResolvedValue([{ id: 5, url: 'https://example.invalid/' }]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect((stored.engineStateV1 as { status: string }).status).toBe('verifying'));
  });

  it('reloads a maintenance payment page and retries on budget instead of freezing', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
          owner: 'owner-token-01',
          runId: 'run-id-0001',
          binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
          now,
        }),
      ),
    );
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31' };
    chromeMock.tabs.query.mockResolvedValue([
      { id: 5, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' },
    ]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { headingFound: false, rows: [], maintenance: true } }]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() =>
      expect((stored.engineStateV1 as { consecutiveFailures: number }).consecutiveFailures).toBe(1),
    );
    expect(chromeMock.tabs.reload).toHaveBeenCalledWith(5, { bypassCache: true });
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
    expect(stored.engineObservationV1).toBeUndefined();
    expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).not.toBeNull();
  });

  it('rereads immediately when a maintenance reload finishes loading', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
          owner: 'owner-token-01',
          runId: 'run-id-0001',
          binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
          now,
        }),
      ),
    );
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31' };
    chromeMock.tabs.query.mockResolvedValue([
      { id: 5, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' },
    ]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { headingFound: false, rows: [], maintenance: true } }]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() =>
      expect((stored.engineStateV1 as { consecutiveFailures: number }).consecutiveFailures).toBe(1),
    );
    expect(Date.parse((stored.engineStateV1 as { nextPollAt: string }).nextPollAt) - Date.now()).toBeGreaterThan(5_000);
    tabsUpdated(5, { status: 'complete' }, { id: 5, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' });
    await vi.waitFor(() => expect(Date.parse((stored.engineStateV1 as { nextPollAt: string }).nextPollAt) - Date.now()).toBeLessThan(5_000));
  });

  it('reloads an unreadable paid form on maintenance instead of parking', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
          owner: 'owner-token-01',
          runId: 'run-id-0001',
          binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null },
          now,
        }),
      ),
    );
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' },
    ]);
    preparePaidPoll();
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => [{
      result: input.func.name === 'readSiteMaintenance' ? { maintenance: true } : { scheduleId: '11111111' },
    }]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() =>
      expect((stored.engineStateV1 as { consecutiveFailures: number }).consecutiveFailures).toBe(1),
    );
    expect(chromeMock.tabs.reload).toHaveBeenCalledWith(9, { bypassCache: true });
    expect(stored.engineStateV1).toMatchObject({ status: 'running', nextPollAt: expect.any(String) });
  });

  it('quietly retries site maintenance when Start finds an empty dashboard', async () => {
    stored.uiPreferencesV1 = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' }]);
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => [{
      result: input.func.name === 'readSiteMaintenance' ? { maintenance: true } : { groups: [] },
    }]);
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode: 'alerts' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(respond.mock.calls[0][0]).toMatchObject({ snapshot: { status: 'running', reviewRequired: false } });
    expect(stored.engineStateV1).toMatchObject({ status: 'running', group: null, consecutiveFailures: 1,
      loginFailed: false, authenticationError: null, authentication: { tabId: 7, phase: 'retry' } });
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it.each([null, { scopeKey: 'foreign-scope', monitor: {} }, { scopeKey: 'foreign-scope', monitors: {} },
    { scopeKey: 'alerts:33333333:Vancouver:any:2026-11-01:2026-12-31', monitors: { Vancouver: { scopeKey: 'wrong', alert: {}, baseline: null, lastHealthyAt: null } } }])('parks corrupt unpaid monitor state without notification or retry (%s)', async monitor => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = bindGroup(startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
      owner: 'owner-token-01', runId: 'run-id-0001', now,
      binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
    });
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31' };
    stored.unpaidMonitorV1 = monitor;
    chromeMock.tabs.query.mockResolvedValue([{ id: 5, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment' }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { headingFound: true, rows: ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec', 'Toronto', 'Vancouver'].map(city => ({ city, text: 'November 19, 2026' })) } }]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying', consecutiveFailures: 0, nextPollAt: null }));
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
    expect(stored.unpaidMonitorV1).toEqual(monitor);
  });

  it('bootstraps gateways and the independent roster before the first days poll', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now });
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(started, {
          owner: 'owner-token-01',
          runId: 'run-id-0001',
          binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, applicantIds: ['77777777'] },
          now,
        }),
      ),
    );
    stored.uiPreferencesV1 = {
      consulate: 'Vancouver',
      earliest: '2026-11-01',
      latest: '2026-12-31',
      onlyEarlier: false,
      autoMode: true,
    };
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' },
      { id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/continue_actions' },
    ]);
    let kind = 'actions';
    chromeMock.scripting.executeScript.mockImplementation((input: { func?: { name?: string }; args?: unknown[] }) => {
      const name = input.func?.name ?? '';
      if (name.includes('fetchDays')) return Promise.resolve([{ result: { status: 200, body: [{ date: '2026-11-19' }] } }]);
      if (name === 'readPaidPage') return Promise.resolve([{ result: {
        scheduleId: '11111111', kind, applicantIds: ['77777777'],
        applicants: [{ id: '77777777', checked: true, disabled: false }],
      } }]);
      expect(stored.engineStateV1).toMatchObject({ executor: { tabId: 7, actionPending: true } });
      if (kind === 'applicants') expect(stored.engineStateV1).toMatchObject({ executor: { applicantIds: ['77777777'] } });
      return Promise.resolve([{ result: { ok: true, advanced: true } }]);
    });
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/continue_actions' });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect((stored.engineStateV1 as { stage: string }).stage).toBe('warning'));
    const wake = async (pageKind: string, expectedStage: string | null) => {
      kind = pageKind;
      chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' });
      (stored.engineStateV1 as { nextPollAt: string }).nextPollAt = new Date(Date.now() - 1000).toISOString();
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', stage: expectedStage }));
    };
    await wake('warning', 'applicants');
    await wake('applicants', 'form');
    await wake('form', null);
    expect(stored.engineStateV1).toMatchObject({ lastCandidate: null, executor: { tabId: 7, applicantIds: ['77777777'] } });
    expect(chromeMock.scripting.executeScript.mock.calls.some((call: any[]) => call[0].func.name === 'fetchDaysJson')).toBe(false);
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment?applicants[]=77777777' }]);
    await wake('form', 'form');
    expect(stored.engineStateV1).toMatchObject({ lastCandidate: { date: '2026-11-19', consulate: 'Vancouver' }, executor: { tabId: 7 } });
    const injected = chromeMock.scripting.executeScript.mock.calls.map((call: { 0: { func?: { name?: string } } }) => call[0].func?.name ?? '');
    expect(injected.some((name: string) => name.includes('fetchDays'))).toBe(true);
    expect(injected.some((name: string) => name.includes('performPaidAction'))).toBe(true);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(JSON.stringify(stored)).not.toContain('Test Mode');
  });

  it('opens the constructed gateway and waits for load when no gateway is open', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now });
    stored.engineStateV1 = JSON.parse(
      JSON.stringify(
        bindGroup(started, {
          owner: 'owner-token-01',
          runId: 'run-id-0001',
          binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, applicantIds: ['77777777'] },
          now,
        }),
      ),
    );
    stored.uiPreferencesV1 = {
      consulate: 'Vancouver',
      earliest: '2026-11-01',
      latest: '2026-12-31',
      onlyEarlier: false,
      testMode: true,
    };
    chromeMock.tabs.query.mockResolvedValue([]);
    chromeMock.tabs.create.mockResolvedValue({ id: 7 });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/continue_actions',
    }));
    expect((stored.engineStateV1 as { status: string }).status).toBe('running');
    expect((stored.engineStateV1 as { nextPollAt: string }).nextPollAt).not.toBeNull();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it.each(['warning', 'changed-roster'])('parks a prepared poll before GET when context changes (%s)', async change => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
      owner: 'owner-token-01', runId: 'run-id-0001', now,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null },
    });
    preparePaidPoll();
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: {
      scheduleId: '11111111', kind: change === 'warning' ? 'warning' : 'form',
      applicantIds: change === 'changed-roster' ? ['88888888'] : ['77777777'],
    } }]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject(change === 'warning'
      ? { status: 'running', lastCandidate: null, consecutiveFailures: 1, authentication: { purpose: 'renew' } }
      : { status: 'verifying', lastCandidate: null }));
    // An unexpected page restarts through auth-only fresh validation;
    // a readable form with a changed roster still parks without a GET.
    const reads = chromeMock.scripting.executeScript.mock.calls.map((call: { [index: number]: { func: { name: string } } }) => call[0].func.name as string);
    expect(reads).toEqual(change === 'warning' ? ['readPaidPage', 'readSiteMaintenance'] : ['readPaidPage']);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it.each(['injection-rejection', 'transport-result'] as const)('retries a transient bare-form roster re-read on budget (%s)', async failure => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = {
      ...bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null,
          applicantIds: ['77777777'], dashboardPath: '/en-ca/niv/groups/99999999' },
      }),
      executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
    };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-12-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }]);
    const baselineOk = { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: ['77777777'] };
    let baselineCalls = 0;
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      const name = input.func?.name ?? '';
      if (name === 'readCurrentAppointment') {
        baselineCalls += 1;
        if (baselineCalls === 1) {
          if (failure === 'injection-rejection') throw new Error('synthetic transport failure');
          return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', status: 503, text: null } }];
        }
        return [{ result: baselineOk }];
      }
      if (name === 'readPaidPage') return [{ result: { scheduleId: '11111111', kind: 'form', applicantIds: ['77777777'] } }];
      if (name === 'fetchDaysJson') return [{ result: { status: 200, body: [{ date: '2026-11-19' }] } }];
      if (name === 'readSiteMaintenance') return [{ result: { maintenance: false } }];
      throw new Error(`unexpected injection: ${name}`);
    });
    alarmed({ name: 'enginePoll' });
    // One unreadable roster re-read budgets a retry and keeps monitoring: no
    // bare park, no lost executor custody, no days fetch on this cycle.
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', consecutiveFailures: 1 }));
    expect(stored.engineStateV1).toMatchObject({ lastCandidate: null, stage: null, nextPollAt: expect.any(String), executor: { tabId: 9 } });
    expect((stored as Record<string, unknown>).lastPollV1).toBeUndefined();
    const injected = chromeMock.scripting.executeScript.mock.calls.map((call: { [index: number]: { func: { name: string } } }) => call[0].func.name as string);
    expect(injected).toEqual(['readCurrentAppointment']);
    // The next paced poll revalidates and records the healthy days read.
    (stored.engineStateV1 as { nextPollAt: string }).nextPollAt = new Date(Date.now() - 1000).toISOString();
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', consecutiveFailures: 0 }));
    expect(stored.engineStateV1).toMatchObject({ lastCandidate: null, stage: null, executor: { tabId: 9, applicantIds: ['77777777'] } });
    expect(stored.lastPollV1).toMatchObject({ status: 200, dayCount: 1 });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it.each([
    ['changed-date', { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'December 15, 2026', applicantIds: ['77777777'] }],
    ['changed-roster', { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: ['88888888'] }],
    ['wrong-group', { scheduleId: '33333333', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: ['77777777'] }],
    ['wrong-ivr', { scheduleId: '11111111', ivr: '44444444', kind: 'unbooked', text: null, applicantIds: ['77777777'] }],
    ['missing-roster', { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null }],
    ['malformed-result', null],
    ['foreign-failure-result', { scheduleId: '33333333', ivr: '22222222', kind: 'read-failure', status: 503, text: null }],
    ['invalid-failure-result', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', status: '503', text: null }],
  ])('parks a bare-form poll when the roster re-read proves a %s', async (_case, baseline) => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = {
      ...bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null,
          applicantIds: ['77777777'], dashboardPath: '/en-ca/niv/groups/99999999' },
      }),
      executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
    };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-12-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }]);
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      const name = input.func?.name ?? '';
      if (name === 'readCurrentAppointment') return [{ result: baseline }];
      if (name === 'readPaidPage') return [{ result: { scheduleId: '11111111', kind: 'form', applicantIds: ['77777777'] } }];
      if (name === 'fetchDaysJson') return [{ result: { status: 200, body: [{ date: '2026-11-19' }] } }];
      if (name === 'readSiteMaintenance') return [{ result: { maintenance: false } }];
      throw new Error(`unexpected injection: ${name}`);
    });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject(_case === 'malformed-result'
      ? { status: 'running', consecutiveFailures: 1, nextPollAt: expect.any(String) }
      : { status: 'verifying', consecutiveFailures: 0, nextPollAt: null }));
    const injected = chromeMock.scripting.executeScript.mock.calls.map((call: { [index: number]: { func: { name: string } } }) => call[0].func.name as string);
    expect(injected).toEqual(['readCurrentAppointment']);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it.each([401, 403])('starts bounded renewal for a denied bare-form dashboard GET (%s) without a days request', async status => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = {
      ...bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null,
          applicantIds: ['77777777'], dashboardPath: '/en-ca/niv/groups/99999999' },
      }),
      executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
    };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-12-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', status, text: null } }]);
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', sessionRenewals: 1, authentication: { purpose: 'renew' } }));
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('retries a transient bare-form page read on budget instead of stopping the monitor', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = {
      ...bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null,
          applicantIds: ['77777777'], dashboardPath: '/en-ca/niv/groups/99999999' },
      }),
      executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
    };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-12-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }]);
    let pageCalls = 0;
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      const name = input.func?.name ?? '';
      if (name === 'readCurrentAppointment') return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: ['77777777'] } }];
      if (name === 'readPaidPage') {
        pageCalls += 1;
        if (pageCalls === 1) throw new Error('synthetic transport failure');
        return [{ result: { scheduleId: '11111111', kind: 'form', applicantIds: ['77777777'] } }];
      }
      if (name === 'fetchDaysJson') return [{ result: { status: 200, body: [{ date: '2026-11-19' }] } }];
      if (name === 'readSiteMaintenance') return [{ result: { maintenance: false } }];
      throw new Error(`unexpected injection: ${name}`);
    });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', consecutiveFailures: 1 }));
    expect(stored.engineStateV1).toMatchObject({ lastCandidate: null, stage: null, executor: { tabId: 9 } });
    (stored.engineStateV1 as { nextPollAt: string }).nextPollAt = new Date(Date.now() - 1000).toISOString();
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', consecutiveFailures: 0 }));
    expect(stored.lastPollV1).toMatchObject({ status: 200, dayCount: 1 });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  describe('booking poll cycle across consulates', () => {
    type DaysReply = { status: number; body?: unknown } | Error;
    async function runCycle(replies: Record<number, DaysReply>, prefs: Record<string, unknown> = {}) {
      const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
      const now = new Date().toISOString();
      stored.engineStateV1 = bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null },
      });
      preparePaidPoll();
      stored.uiPreferencesV1 = { consulates: ['Halifax', 'Toronto'], earliest: '2026-11-01', latest: '2026-12-31',
        onlyEarlier: false, testMode: true, ...prefs };
      chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }]);
      chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string }; args?: unknown[] }) => {
        const name = input.func?.name ?? '';
        if (name === 'readPaidPage') return [{ result: { scheduleId: '11111111', kind: 'form', applicantIds: ['77777777'] } }];
        if (name === 'fetchDaysJson') {
          const reply = replies[input.args![1] as number];
          if (reply instanceof Error) throw reply;
          if (!reply) throw new Error(`unexpected facility: ${String(input.args![1])}`);
          return [{ result: reply }];
        }
        if (name === 'readSiteMaintenance') return [{ result: { maintenance: false } }];
        throw new Error(`unexpected injection: ${name}`);
      });
      const before = JSON.stringify(stored.engineStateV1);
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(JSON.stringify(stored.engineStateV1)).not.toBe(before));
      const daysCalls = chromeMock.scripting.executeScript.mock.calls
        .filter((call: { [index: number]: { func: { name: string } } }) => call[0].func.name === 'fetchDaysJson') as { 0: { args: unknown[]; target: { tabId: number } } }[];
      return { daysCalls, engine: stored.engineStateV1 as Record<string, any> };
    }

    it('polls every selected consulate and books the earliest across them', async () => {
      const { daysCalls, engine } = await runCycle({
        90: { status: 200, body: [{ date: '2026-11-20' }] },
        94: { status: 200, body: [{ date: '2026-12-03' }] },
      });
      expect(daysCalls.map(call => call[0].args[1])).toEqual([90, 94]);
      expect(daysCalls.every(call => call[0].target.tabId === 9)).toBe(true);
      expect(stored.engineObservationV1).toMatchObject({ runId: 'run-id-0001', mode: 'booking', rows: [],
        dates: ['2026-11-20', '2026-12-03'],
        byConsulate: [{ consulate: 'Halifax', dates: ['2026-11-20'] }, { consulate: 'Toronto', dates: ['2026-12-03'] }] });
      expect(stored.lastPollV1).toMatchObject({ status: 200, dayCount: 2 });
      expect(engine).toMatchObject({ consecutiveFailures: 0, lastCandidate: { date: '2026-11-20', consulate: 'Halifax' } });
      await vi.waitFor(() => expect(chromeMock.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
        message: 'New date available: 2026-11-20 (Halifax)' })));
      const log = JSON.stringify(stored.engineDiagnosticsV1 ?? {});
      expect(log).not.toContain('Halifax');
      expect(log).not.toContain('Toronto');
      expect(log).not.toContain('2026-11-20');
    });

    it('skips a consulate\'s skipped date without hiding the same date elsewhere', async () => {
      const replies = {
        90: { status: 200, body: [{ date: '2026-11-20' }] },
        94: { status: 200, body: [{ date: '2026-11-20' }, { date: '2026-12-03' }] },
      };
      // Seed a skipped Halifax date through a first cycle's state.
      await runCycle(replies);
      const seeded = stored.engineStateV1 as Record<string, any>;
      seeded.executor.skippedDates = [{ consulate: 'Halifax', date: '2026-11-20' }];
      seeded.nextPollAt = new Date(Date.now() - 1000).toISOString();
      seeded.lastCandidate = null;
      const before = JSON.stringify(seeded);
      alarmed({ name: 'enginePoll' });
      await vi.waitFor(() => expect(JSON.stringify(stored.engineStateV1)).not.toBe(before));
      expect((stored.engineStateV1 as Record<string, any>).lastCandidate).toEqual({ date: '2026-11-20', consulate: 'Toronto' });
    });

    it('proceeds on answering consulates when one times out', async () => {
      const { engine } = await runCycle({
        90: { status: 0 },
        94: { status: 200, body: [{ date: '2026-12-03' }] },
      });
      expect(engine).toMatchObject({ consecutiveFailures: 0, lastCandidate: { date: '2026-12-03', consulate: 'Toronto' } });
      expect((stored.engineObservationV1 as { byConsulate: unknown }).byConsulate).toEqual([{ consulate: 'Toronto', dates: ['2026-12-03'] }]);
      expect(stored.lastPollV1).toMatchObject({ status: 200, dayCount: 1 });
    });

    it('counts one failure when every consulate fails', async () => {
      const { daysCalls, engine } = await runCycle({ 90: { status: 0 }, 94: new Error('synthetic transport failure') });
      expect(daysCalls).toHaveLength(2);
      expect(engine.consecutiveFailures).toBe(1);
      expect(engine.lastCandidate).toBeNull();
      expect(stored.engineObservationV1).toBeUndefined();
      expect(stored.lastPollV1).toBeUndefined();
    });

    it('stops at the first denied consulate and re-authenticates', async () => {
      const { daysCalls, engine } = await runCycle({ 90: { status: 401 }, 94: { status: 200, body: [{ date: '2026-12-03' }] } });
      expect(daysCalls).toHaveLength(1);
      expect(engine.authentication).toMatchObject({ purpose: 'renew' });
      expect(stored.engineObservationV1).toBeUndefined();
    });

    it('re-authenticates on a later denied consulate without recording the earlier answer', async () => {
      const { daysCalls, engine } = await runCycle({ 90: { status: 200, body: [{ date: '2026-11-20' }] }, 94: { status: 403 } });
      expect(daysCalls).toHaveLength(2);
      expect(engine).toMatchObject({ lastCandidate: null, authentication: { purpose: 'renew' } });
      expect(stored.engineObservationV1).toBeUndefined();
    });

    it('treats a cycle as empty only when no consulate has dates', async () => {
      const { engine } = await runCycle({ 90: { status: 200, body: [] }, 94: { status: 200, body: [] } });
      expect(engine.consecutiveFailures).toBe(1); // poll-empty counts toward PAID_EMPTY_COOLDOWN_AFTER
      expect(engine.lastCandidate).toBeNull();
      expect(stored.engineObservationV1).toMatchObject({ dates: [], byConsulate: [{ consulate: 'Halifax', dates: [] }, { consulate: 'Toronto', dates: [] }] });
    });

    it('is healthy, not empty, when dates exist but none is eligible', async () => {
      const { engine } = await runCycle({ 90: { status: 200, body: [{ date: '2027-02-01' }] }, 94: { status: 200, body: [] } });
      expect(engine).toMatchObject({ consecutiveFailures: 0, lastCandidate: null });
    });

    it('treats a not-modified consulate as answering with no dates', async () => {
      const { engine } = await runCycle({ 90: { status: 304 }, 94: { status: 200, body: [{ date: '2026-12-03' }] } });
      expect(engine).toMatchObject({ consecutiveFailures: 0, lastCandidate: { date: '2026-12-03', consulate: 'Toronto' } });
      expect((stored.engineObservationV1 as { byConsulate: unknown }).byConsulate).toEqual([
        { consulate: 'Halifax', dates: [] }, { consulate: 'Toronto', dates: ['2026-12-03'] }]);
    });

    it('drops a consulate with a malformed days body and proceeds on the others', async () => {
      const { engine } = await runCycle({ 90: { status: 200, body: { nope: true } }, 94: { status: 200, body: [{ date: '2026-12-03' }] } });
      expect(engine).toMatchObject({ consecutiveFailures: 0, lastCandidate: { date: '2026-12-03', consulate: 'Toronto' } });
      expect((stored.engineObservationV1 as { byConsulate: unknown }).byConsulate).toEqual([{ consulate: 'Toronto', dates: ['2026-12-03'] }]);
      expect(stored.lastPollV1).toMatchObject({ status: 200, dayCount: 1 });
    });

    it('drops a consulate with a null days body', async () => {
      const { engine } = await runCycle({ 90: { status: 200, body: [{ date: '2026-11-20' }] }, 94: { status: 200, body: null } });
      expect(engine).toMatchObject({ consecutiveFailures: 0, lastCandidate: { date: '2026-11-20', consulate: 'Halifax' } });
      expect((stored.engineObservationV1 as { byConsulate: unknown }).byConsulate).toEqual([{ consulate: 'Halifax', dates: ['2026-11-20'] }]);
    });

    it('retries the cycle once when every consulate returns a malformed days body', async () => {
      const { engine } = await runCycle({ 90: { status: 200, body: { nope: true } }, 94: { status: 200, body: null } });
      expect(engine).toMatchObject({ consecutiveFailures: 1, lastCandidate: null });
      expect(stored.engineObservationV1).toBeUndefined();
      expect(stored.lastPollV1).toBeUndefined();
      const log = stored.engineDiagnosticsV1 as { entries: { code: string; detail?: string }[] } | undefined;
      expect(log?.entries.filter(entry => entry.code === 'poll-retry').at(-1)).toMatchObject({ detail: 'reply-malformed' });
    });

    it('treats a mix of transport failures and malformed bodies as one malformed retry', async () => {
      const { engine } = await runCycle({ 90: { status: 0 }, 94: { status: 200, body: { nope: true } } });
      expect(engine).toMatchObject({ consecutiveFailures: 1, lastCandidate: null });
      expect(stored.engineObservationV1).toBeUndefined();
    });
  });

  it('persists bounded fixed-code diagnostics for a recovered poll failure without private values', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = {
      ...bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null,
          applicantIds: ['77777777'], dashboardPath: '/en-ca/niv/groups/99999999' },
      }),
      executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
    };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-12-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }]);
    let pageCalls = 0;
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      const name = input.func?.name ?? '';
      if (name === 'readCurrentAppointment') return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: ['77777777'] } }];
      if (name === 'readPaidPage') {
        pageCalls += 1;
        if (pageCalls === 1) throw new Error('synthetic transport failure');
        return [{ result: { scheduleId: '11111111', kind: 'form', applicantIds: ['77777777'] } }];
      }
      if (name === 'fetchDaysJson') return [{ result: { status: 200, body: [{ date: '2026-11-19' }] } }];
      if (name === 'readSiteMaintenance') return [{ result: { maintenance: false } }];
      throw new Error(`unexpected injection: ${name}`);
    });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', consecutiveFailures: 1 }));
    (stored.engineStateV1 as { nextPollAt: string }).nextPollAt = new Date(Date.now() - 1000).toISOString();
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', consecutiveFailures: 0 }));
    await vi.waitFor(() => expect((stored.engineDiagnosticsV1 as { entries?: unknown[] } | undefined)?.entries?.length ?? 0).toBeGreaterThan(0));
    const log = stored.engineDiagnosticsV1 as { version: number; entries: { code: string; detail?: string; outcome?: string; mode?: string }[] };
    const codes = log.entries.map(entry => entry.code);
    expect(codes).toContain('poll-retry');
    // The successful recovery keeps the earlier retry entry and records the reset.
    expect(codes).toContain('poll-recovered');
    expect(log.entries.filter(entry => entry.code === 'poll-retry').at(-1)).toMatchObject({ mode: 'booking', outcome: 'retryable', detail: 'script-interrupted' });
    expect(JSON.stringify(log)).not.toContain('synthetic transport failure');
    expect(JSON.stringify(log)).not.toContain('11111111');
    expect(JSON.stringify(log)).not.toContain('77777777');
  });

  it('exports the bounded diagnostics log only to the bundled report page', async () => {
    const probe = 'chrome-extension://synthetic-extension/probe.html';
    stored.engineDiagnosticsV1 = {
      version: 1,
      entries: [
        { at: new Date().toISOString(), code: 'auth-retry-scheduled', detail: 'reply-malformed', purpose: 'start', mode: 'booking', failures: 3, count: 2 },
        { at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), code: 'auth-started', purpose: 'start', mode: 'booking' },
      ],
    };
    const respond = vi.fn();
    expect(message({ type: 'PROBE_DIAGNOSTICS' }, { id: 'synthetic-extension', url: probe }, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    const reply = respond.mock.calls[0][0] as { diagnostics: { retention: { ttlMs: number; limit: number }; entries: { code: string }[] } };
    expect(reply.diagnostics.retention).toEqual({ ttlMs: 7 * 24 * 60 * 60 * 1000, limit: 1500 });
    // The expired entry is pruned; the retained entry keeps its bounded repeat count.
    expect(reply.diagnostics.entries).toEqual([
      expect.objectContaining({ code: 'auth-retry-scheduled', detail: 'reply-malformed', failures: 3, count: 2 }),
    ]);
    const website = vi.fn();
    message({ type: 'PROBE_DIAGNOSTICS' }, { id: 'synthetic-extension', url: 'https://example.invalid/' }, website);
    expect(website).not.toHaveBeenCalled();
    const panel = vi.fn();
    message({ type: 'PROBE_DIAGNOSTICS' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' }, panel);
    expect(panel).not.toHaveBeenCalled();
  });
  it('exports only sanitized diagnostics to the production panel console', async () => {
    stored.uiPreferencesV1 = { password: 'synthetic-private-value' };
    stored.engineDiagnosticsV1 = { version: 1, entries: [{ at: new Date().toISOString(), code: 'auth-recovered',
      password: 'synthetic-private-value', url: 'https://example.invalid/private' }] };
    const response = vi.fn();
    expect(message({ type: 'ENGINE_DIAGNOSTICS' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html?detached=1' }, response)).toBe(true);
    await vi.waitFor(() => expect(response).toHaveBeenCalled());
    expect(response.mock.calls[0][0]).toMatchObject({ ok: true, diagnostics: { entries: [{ code: 'auth-recovered' }] } });
    expect(JSON.stringify(response.mock.calls)).not.toContain('synthetic-private-value');
    expect(JSON.stringify(response.mock.calls)).not.toContain('example.invalid');
    for (const url of ['https://ais.usvisa-info.com/en-ca/niv/users/sign_in', 'chrome-extension://other-extension/panel.html']) {
      const blocked = vi.fn();
      expect(message({ type: 'ENGINE_DIAGNOSTICS' }, { id: 'synthetic-extension', url }, blocked)).toBeUndefined();
      expect(blocked).not.toHaveBeenCalled();
    }
  });

  it('holds the durable cooldown after repeated bare-form preflight failures without polling or mutation', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = {
      ...bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null,
          applicantIds: ['77777777'], dashboardPath: '/en-ca/niv/groups/99999999' },
      }),
      consecutiveFailures: 9,
      executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
    };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-12-01', latest: '2026-12-31', onlyEarlier: false, testMode: true };
    chromeMock.tabs.query.mockResolvedValue([{ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }]);
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('synthetic transport failure'));
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'running', consecutiveFailures: 10, nextPollAt: null, cooldownUntil: expect.any(String) }));
    const state = stored.engineStateV1 as { cooldownUntil: string };
    expect(Date.parse(state.cooldownUntil) - Date.parse(now)).toBeGreaterThanOrEqual(1_799_000);
    expect(chromeMock.alarms.create.mock.calls.filter((call: unknown[]) => call[0] === 'enginePoll').at(-1)).toEqual(['enginePoll', { when: Date.parse(state.cooldownUntil) }]);
    const calls = chromeMock.alarms.create.mock.calls.length;
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(chromeMock.alarms.create.mock.calls.length).toBeGreaterThan(calls));
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(stored.engineStateV1).toMatchObject({ status: 'running', consecutiveFailures: 10, cooldownUntil: state.cooldownUntil });
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('skips dates whose times were empty while keeping custody of the executor tab', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored.engineStateV1 = {
      ...bindGroup(startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }), {
        owner: 'owner-token-01', runId: 'run-id-0001', now,
        binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, applicantIds: ['77777777'] },
      }),
      executor: { tabId: 9, applicantIds: ['77777777'], targetTime: null, skippedDates: [{ consulate: 'Vancouver', date: '2026-11-19' }], actionPending: false },
    };
    stored.uiPreferencesV1 = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: false, autoMode: true };
    const url = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment?applicants[]=77777777';
    chromeMock.tabs.query.mockResolvedValue([{ id: 8, url }, { id: 9, url }]);
    mockPaidPoll({ status: 200, body: [{ date: '2026-11-19' }, { date: '2026-11-20' }] });
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ lastCandidate: { date: '2026-11-20', consulate: 'Vancouver' }, stage: 'form' }));
    expect(chromeMock.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 9 });
    const state = stored.engineStateV1 as { stage: string | null; nextPollAt: string; lastCandidate: string | null };
    state.stage = null;
    state.lastCandidate = null;
    state.nextPollAt = now;
    chromeMock.tabs.query.mockResolvedValue([{ id: 8, url }]);
    chromeMock.tabs.get.mockRejectedValue(new Error('Synthetic owned tab closed'));
    alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1).toMatchObject({ status: 'verifying',
      failureContext: { category: 'workflow-blocked', code: 'tab-unavailable', step: 'tab-check' } }));
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });
});
