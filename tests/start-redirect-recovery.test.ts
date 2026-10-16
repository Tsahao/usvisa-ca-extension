// Synthetic-only regression for stale-dashboard Retry recovery (October 2026
// live read-only evidence, no live portal/login/retry/navigation).
//
// A stopped run with a generic failure sits behind a visibly cached paid
// dashboard whose fresh baseline GET is denied/redirected (expired session).
// Explicit paid Start/Retry must distinguish that denied/redirect signal from
// malformed/changed/ordinary-transport failures, then recover auth-only on
// the exact validated tab with a checkpointed fixed sign-in GET. Cached DOM
// never binds a baseline/roster; prior intent stays verification-only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineState } from '../src/engine/workflow';

describe('stale-dashboard Retry recovery', () => {
  let stored: Record<string, unknown>;
  let message: (value: unknown, sender: unknown, respond: (value: unknown) => void) => unknown;
  let chromeMock: any;

  const prefs = { email: 'synthetic@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
    earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false,
    interval: 60, paidIvr: '22222222', unpaidIvr: '' };
  const dashboardUrl = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
  const dashboardPath = '/en-ca/niv/groups/55555555';
  const signInUrl = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
  const sender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' };

  function oldStoppedSave() {
    // Mirrors the owner evidence shape without private IDs: stopped booking,
    // generic login failure, no intent/auth/deadline/candidate, bound single
    // applicant. No diagnostic field is expected in this old save.
    const now = '2026-10-15T21:00:13.409Z';
    return { version: 1, runId: 'old-run-0001', owner: 'product-panel-owner', generation: 2,
      mode: 'booking', status: 'stopped', intent: null,
      group: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null,
        dashboardPath, applicantIds: ['77777777'] },
      consecutiveFailures: 1, cooldownUntil: null, lastCandidate: null, stage: null,
      executor: { tabId: 7, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false },
      monitorTabId: null, verification: null, nextPollAt: null,
      alert: { observed: null, delivered: null, pending: false },
      updatedAt: now, startedAt: '2026-10-15T20:00:00.000Z', policyKey: null, pollIntervalS: 60,
      authentication: null, sessionRenewals: 0, loginFailed: true, authenticationError: null,
      manualAuthentication: false, verificationTabId: null, queuedStart: null,
      verificationError: null, restartPending: false, restartFailed: false };
  }

  function mockDashboardOk() {
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: dashboardUrl }]);
    chromeMock.tabs.get.mockImplementation(async (tabId: number) => {
      if (tabId !== 7) throw new Error('Synthetic missing tab');
      return { id: 7, url: dashboardUrl, status: 'complete' };
    });
  }

  function mockBaseline(result: unknown) {
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      if (input.func.name === 'readDashboardGroups')
        return [{ result: { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] } }];
      return [{ result }];
    });
  }

  async function sendStart(mode = 'booking') {
    const respond = vi.fn();
    message({ type: 'PANEL_START', mode }, sender, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    return respond.mock.calls[0][0] as { ok: boolean; snapshot?: any; error?: string };
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    stored = {};
    chromeMock = {
      storage: {
        onChanged: { addListener: vi.fn() },
        session: {
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue({ engineSessionV1: true }),
          set: vi.fn().mockResolvedValue(undefined),
        },
        local: {
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
          get: vi.fn(async () => ({ ...stored })),
          set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }),
        },
      },
      action: { onClicked: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: true }]) },
      notifications: { create: vi.fn(async () => 'note-1') },
      tabs: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn(async (tabId: number) => ({ id: tabId })),
        reload: vi.fn(async () => undefined),
        query: vi.fn().mockResolvedValue([]),
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: dashboardUrl })),
        onUpdated: { addListener: vi.fn() },
      },
      windows: {
        create: vi.fn().mockResolvedValue({ id: 80, tabs: [{ id: 81 }] }),
        get: vi.fn().mockResolvedValue({ id: 80, type: 'popup', state: 'normal' }),
        update: vi.fn().mockResolvedValue({ id: 80 }),
      },
      alarms: {
        create: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(true),
        onAlarm: { addListener: vi.fn() },
      },
      runtime: {
        id: 'synthetic-extension', getURL: (path: string) => `chrome-extension://synthetic-extension/${path}`,
        onMessage: { addListener: vi.fn(listener => { message = listener; }) },
      },
    };
    vi.stubGlobal('chrome', chromeMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'fresh-run-0002' });
    await import('../src/background');
    stored.uiPreferencesV1 = { ...prefs };
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([
    ['opaqueredirect', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true }],
    ['401', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 401 }],
    ['403', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 403 }],
  ])('recovers a stale dashboard %s into auth-only running on the same tab with a fixed sign-in GET', async (_label, baseline) => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline(baseline);
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(true);
    expect(reply.snapshot.status).toBe('running');
    const next = stored.engineStateV1 as any;
    // Success transition from failure, not error persisted: new running run,
    // auth-only (no cached baseline/roster binds Continue/booking).
    expect(next.status).toBe('running');
    expect(next.loginFailed).toBe(false);
    expect(next.group).toBeNull();
    expect(next.stage).toBeNull();
    expect(next.executor).toBeNull();
    expect(next.authentication).toMatchObject({ tabId: 7, purpose: 'start', pending: false });
    // Same owned tab, fixed official sign-in only, no replacement tab.
    expect(chromeMock.tabs.update).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(7, { url: signInUrl });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    // No booking POST: only group + baseline reads injected.
    const injected = chromeMock.scripting.executeScript.mock.calls.map((call: any) => call[0].func.name);
    expect(injected).toEqual(['readDashboardGroups', 'readCurrentAppointment']);
    expect(JSON.stringify([reply, next])).not.toContain('synthetic-password');
    expect(JSON.stringify([reply, next])).not.toContain('11111111');
  });

  it('preserves TestMode ON through the same denied recovery without binding', async () => {
    stored.uiPreferencesV1 = { ...prefs, testMode: true };
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(true);
    expect(stored.engineStateV1).toMatchObject({ status: 'running', group: null, stage: null, executor: null,
      authentication: { tabId: 7, purpose: 'start' } });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(7, { url: signInUrl });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('treats a repeated denial as idempotent once running instead of opening another tab', async () => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    const first = await sendStart('booking');
    expect(first.ok).toBe(true);
    expect(chromeMock.tabs.update).toHaveBeenCalledTimes(1);
    chromeMock.tabs.update.mockClear();
    // Second explicit Retry while the auth-only run is active preserves it.
    const second = await sendStart('booking');
    expect(second.ok).toBe(true);
    expect(second.snapshot.status).toBe('running');
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect((stored.engineStateV1 as any).authentication).toMatchObject({ tabId: 7, purpose: 'start' });
  });

  it.each([
    ['502', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 502 }],
    ['plain-zero', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0 }],
    ['lost-reply', null],
    ['wrong-ids', { scheduleId: '99999999', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true }],
    ['malformed-flag', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: 'yes' }],
    ['malformed-status', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: '401' }],
  ])('keeps ordinary/malformed %s generic with the paused state untouched', async (_label, baseline) => {
    const paused = oldStoppedSave();
    stored.engineStateV1 = JSON.parse(JSON.stringify(paused));
    mockDashboardOk();
    mockBaseline(baseline);
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('The extension could not refresh the selected group’s appointment and applicant details. Refresh the dashboard; if this repeats, report this message.');
    expect(stored.engineStateV1).toEqual(paused);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it.each([
    ['ambiguous', { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: '' }],
    ['no-roster', { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: '6 November, 2026' }],
  ])('keeps invalid %s generic with the paused state untouched', async (_label, baseline) => {
    const paused = oldStoppedSave();
    stored.engineStateV1 = JSON.parse(JSON.stringify(paused));
    mockDashboardOk();
    mockBaseline(baseline);
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(false);
    expect(stored.engineStateV1).toEqual(paused);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('keeps a missing paid group generic without a sign-in navigation', async () => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [] } }]);
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(false);
    expect(stored.engineStateV1).toEqual(oldStoppedSave());
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it.each(['moved-tab', 'settings-changed'])('parks without navigating when %s before the fixed GET', async issue => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    if (issue === 'moved-tab') chromeMock.tabs.get.mockResolvedValue({ id: 7, url: signInUrl, status: 'complete' });
    else {
      // Simulate settings changing after the initial Start prefs load but
      // before the fixed-GET recheck: mutate stored on the live-tab read so
      // the fresh prefs comparison observes the change.
      chromeMock.tabs.get.mockImplementation(async (tabId: number) => {
        stored.uiPreferencesV1 = { ...prefs, consulate: 'Toronto' };
        return { id: tabId, url: dashboardUrl, status: 'complete' };
      });
    }
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(true);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    // No cached binding authorizes booking: parked for review, auth cleared.
    expect(stored.engineStateV1).toMatchObject({ status: 'verifying', group: null, authentication: null });
  });

  it('routes a denied baseline with unresolved intent to verification-only with no new auth attempt', async () => {
    const { emptyEngineState, startRun, bindGroup, recordIntent, parkForReview } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const bound = bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, dashboardPath, applicantIds: ['77777777'] } });
    const intent = { runId: args.runId, mode: 'booking' as const, groupId: '11111111', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: now };
    stored.engineStateV1 = parkForReview(recordIntent(bound, { ...args, intent }), now);
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(true);
    const next = stored.engineStateV1 as unknown as EngineState;
    expect(next.intent).toEqual(intent);
    expect(next.queuedStart).toMatchObject({ mode: 'booking' });
    // Early intent gate: no fresh baseline read or new fixed sign-in for a
    // fresh run; verification owns the tab.
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(next.authentication?.purpose === 'start' && next.group === null).toBe(false);
  });

  it.each([
    ['query', `${dashboardUrl}?changed=1`],
    ['fragment', `${dashboardUrl}#changed`],
    ['changed-path', 'https://ais.usvisa-info.com/en-ca/niv/groups/66666666'],
    ['pending-about-blank', dashboardUrl],
    ['pending-dirty', dashboardUrl],
    ['loading', dashboardUrl],
  ])('parks without navigating when post-read live tab is %s', async (label, liveUrl) => {
    stored.engineStateV1 = oldStoppedSave();
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: dashboardUrl }]);
    chromeMock.tabs.get.mockImplementation(async () => {
      if (label === 'pending-about-blank') return { id: 7, url: dashboardUrl, status: 'complete', pendingUrl: 'about:blank' };
      if (label === 'pending-dirty') return { id: 7, url: dashboardUrl, status: 'complete', pendingUrl: signInUrl };
      if (label === 'loading') return { id: 7, url: dashboardUrl, status: 'loading' };
      return { id: 7, url: liveUrl, status: 'complete' };
    });
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(true);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    const next = stored.engineStateV1 as unknown as EngineState;
    expect(next.status).toBe('verifying');
    expect(next.group).toBeNull();
    expect(next.authentication).toBeNull();
  });

  it.each([
    ['redirect-with-401', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 401, redirected: true }],
    ['redirect-with-text', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: 'garbage', status: 0, redirected: true }],
    ['redirect-with-roster', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true, applicantIds: ['77777777'] }],
    ['false-flag-with-zero', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: false }],
    ['false-flag-with-502', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 502, redirected: false }],
    ['text-with-401', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: 'denied', status: 401 }],
    ['roster-with-401', { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 401, applicantIds: ['77777777'] }],
  ])('keeps contradictory %s generic with the paused state untouched', async (_label, baseline) => {
    const paused = oldStoppedSave();
    stored.engineStateV1 = JSON.parse(JSON.stringify(paused));
    mockDashboardOk();
    mockBaseline(baseline);
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(false);
    expect(stored.engineStateV1).toEqual(paused);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('cancels without navigation when Stop arrives during the baseline read', async () => {
    const paused = oldStoppedSave();
    stored.engineStateV1 = JSON.parse(JSON.stringify(paused));
    mockDashboardOk();
    const stopRespond = vi.fn();
    let stopped = false;
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      if (input.func.name === 'readDashboardGroups')
        return [{ result: { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] } }];
      if (!stopped) {
        stopped = true;
        message({ type: 'PANEL_STOP' }, sender, stopRespond);
      }
      return [{ result: { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true } }];
    });
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(false);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stopRespond).toHaveBeenCalled());
    const next = stored.engineStateV1 as unknown as EngineState;
    expect(next.status).not.toBe('running');
    expect(next.authentication).toBeNull();
  });

  it('cancels a queued Retry when Stop arrives before its callback starts', async () => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    const startRespond = vi.fn();
    const stopRespond = vi.fn();
    // Both arrive in the same turn: the serialized Start callback has not
    // run when Stop invalidates the request captured on message receipt.
    message({ type: 'PANEL_START', mode: 'booking' }, sender, startRespond);
    message({ type: 'PANEL_STOP' }, sender, stopRespond);
    await vi.waitFor(() => expect(stopRespond).toHaveBeenCalled());
    expect(startRespond).toHaveBeenCalled();
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect((stored.engineStateV1 as EngineState).status).not.toBe('running');
  });

  it('cancels when settings change during the final live-tab read', async () => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    let gets = 0;
    chromeMock.tabs.get.mockImplementation(async (tabId: number) => {
      if (++gets === 2) {
        const previous = stored.uiPreferencesV1;
        stored.uiPreferencesV1 = { ...prefs, consulate: 'Toronto' };
        const changed = chromeMock.storage.onChanged.addListener.mock.calls[0][0];
        changed({ uiPreferencesV1: { oldValue: previous, newValue: stored.uiPreferencesV1 } }, 'local');
      }
      return { id: tabId, url: dashboardUrl, status: 'complete' };
    });
    await sendStart('booking');
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect((stored.engineStateV1 as EngineState).status).not.toBe('running');
  });

  it('parks without navigating when Stop arrives during the pending checkpoint save', async () => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    const stopRespond = vi.fn();
    let injected = false;
    chromeMock.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      if (!injected && values.engineStateV1) {
        injected = true;
        message({ type: 'PANEL_STOP' }, sender, stopRespond);
      }
      Object.assign(stored, values);
    });
    const reply = await sendStart('booking');
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stopRespond).toHaveBeenCalled());
    expect(reply.ok).toBe(true);
    const next = stored.engineStateV1 as unknown as EngineState;
    expect(next.status).not.toBe('running');
  });

  it('parks without navigating when Stop arrives during the fresh prefs reread', async () => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    const stopRespond = vi.fn();
    let savedPending = false;
    let injected = false;
    chromeMock.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      Object.assign(stored, values);
      if (values.engineStateV1) savedPending = true;
    });
    chromeMock.storage.local.get.mockImplementation(async () => {
      const snapshot = { ...stored };
      if (savedPending && !injected) {
        injected = true;
        message({ type: 'PANEL_STOP' }, sender, stopRespond);
      }
      return snapshot;
    });
    const reply = await sendStart('booking');
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stopRespond).toHaveBeenCalled());
    expect(reply.ok).toBe(true);
  });

  it('parks without navigating when Stop arrives during the final tab validation', async () => {
    stored.engineStateV1 = oldStoppedSave();
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: dashboardUrl }]);
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    const stopRespond = vi.fn();
    let gets = 0;
    chromeMock.tabs.get.mockImplementation(async (tabId: number) => {
      gets += 1;
      // First post-checkpoint live read succeeds; the final fresh snapshot
      // observes the queued Stop.
      if (gets >= 2) message({ type: 'PANEL_STOP' }, sender, stopRespond);
      return { id: tabId, url: dashboardUrl, status: 'complete' };
    });
    const reply = await sendStart('booking');
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stopRespond).toHaveBeenCalled());
    expect(reply.ok).toBe(true);
  });

  it('stays generic without navigation when the pending checkpoint save fails', async () => {
    const paused = oldStoppedSave();
    stored.engineStateV1 = JSON.parse(JSON.stringify(paused));
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    chromeMock.storage.local.set.mockRejectedValueOnce(new Error('synthetic storage failure'));
    const reply = await sendStart('booking');
    expect(reply.ok).toBe(false);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('never leaves a cleared checkpoint without the fixed GET when the clear save fails', async () => {
    stored.engineStateV1 = oldStoppedSave();
    mockDashboardOk();
    mockBaseline({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    let saves = 0;
    const realSet = async (values: Record<string, unknown>) => { Object.assign(stored, values); };
    chromeMock.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      saves += 1;
      // First save commits pending:true; second save clears it after the GET.
      if (saves === 2) throw new Error('synthetic clear failure');
      return realSet(values);
    });
    const reply = await sendStart('booking');
    expect(chromeMock.tabs.update).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(7, { url: signInUrl });
    // The durable checkpoint still requires parking on wake; no cleared
    // running binding is exposed.
    const next = stored.engineStateV1 as unknown as EngineState;
    expect(next.authentication).toMatchObject({ tabId: 7, pending: true });
    expect(next.group).toBeNull();
    expect(reply.ok).toBe(false);
  });
});
