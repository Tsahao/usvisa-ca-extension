// Synthetic background regressions for the false-success fix and fresh restart
// validation. Drives ENGINE_VERIFY through the real background module with
// mocked chrome APIs. No real accounts, tabs, or notifications.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_KEY } from '../src/engine/workflow';

type Listener = (message: unknown, sender: unknown, respond: (value: unknown) => void) => unknown;

describe('background verification success discrimination', () => {
  let stored: Record<string, unknown>;
  let onMessage: Listener;
  let chromeMock: any;

  const dashboardPath = '/en-ca/niv/groups/55555555';
  const dashboardUrl = `https://ais.usvisa-info.com${dashboardPath}`;
  const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
    earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false,
    interval: 60, paidIvr: '22222222', unpaidIvr: '' };

  beforeEach(async () => {
    vi.resetModules();
    stored = {};
    chromeMock = {
      storage: {
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
        onChanged: { addListener: vi.fn() },
      },
      action: { onClicked: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn() },
      tabs: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn(async (tabId: number) => ({ id: tabId })),
        remove: vi.fn().mockResolvedValue(undefined),
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
      notifications: { create: vi.fn(async () => 'note-1') },
      runtime: {
        id: 'synthetic-extension',
        getURL: (path: string) => `chrome-extension://synthetic-extension/${path}`,
        onMessage: { addListener: vi.fn(listener => { onMessage = listener; }) },
      },
    };
    vi.stubGlobal('chrome', chromeMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'fresh-run-uuid-0001' });
    await import('../src/background');
  });

  const panelSender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' };
  const send = (message: unknown) =>
    new Promise<unknown>(resolve => { expect(onMessage({ ...(message as object), now: new Date().toISOString() }, panelSender, resolve)).toBe(true); });

  async function seedVerifying(opts: {
    reads: (string | null)[];
    queuedMode?: 'booking' | 'alerts' | null;
    queuedPolicyKey?: string | null;
    prefsOverride?: Record<string, unknown>;
    currentDate?: string | null;
  }) {
    const { bindGroup, emptyEngineState, parkForReview, recordIntent, startRun } =
      await import('../src/engine/workflow');
    const { policyKey } = await import('../src/engine/lifecycle');
    const now = new Date().toISOString();
    const runArgs = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const currentPrefs = { ...prefs, ...(opts.prefsOverride ?? {}) };
    const runPolicy = policyKey(prefs as unknown as Record<string, unknown>);
    let state = bindGroup(startRun(emptyEngineState(now), { ...runArgs, mode: 'booking' }), { ...runArgs,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid',
        currentDate: opts.currentDate ?? '2027-06-21', dashboardPath, applicantIds: ['77777777', '88888888'] } });
    state = recordIntent(state, { ...runArgs, intent: { runId: runArgs.runId, mode: 'booking', groupId: '11111111',
      targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: now, phase: 'submitted' } });
    state = parkForReview(state, now);
    const past = new Date(Date.now() - 1000).toISOString();
    stored.engineStateV1 = { ...state, verification: { reads: opts.reads, nextReadAt: past },
      verificationTabId: 7, verificationError: null, policyKey: runPolicy, pollIntervalS: 60,
      ...(opts.queuedMode ? { queuedStart: { owner: runArgs.owner, runId: runArgs.runId, mode: opts.queuedMode,
        requestedAt: now, policyKey: opts.queuedPolicyKey ?? policyKey(currentPrefs as unknown as Record<string, unknown>) } } : { queuedStart: null }) };
    stored.uiPreferencesV1 = currentPrefs;
    return { runArgs, runPolicy };
  }

  function mockReads(raws: unknown[], groups = [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }]) {
    // Serves successive readCurrentAppointment injections in order; repeats last.
    let calls = 0;
    chromeMock.scripting.executeScript.mockImplementation(async (input: { func: { name: string } }) => {
      if (input.func.name === 'readDashboardGroups') return [{ result: { groups } }];
      const raw = raws[Math.min(calls, raws.length - 1)];
      calls += 1;
      if (raw instanceof Error) throw raw;
      return [{ result: raw }];
    });
  }

  const bookedPrev = { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'June 21, 2027', applicantIds: ['77777777', '88888888'] };
  const bookedPrevRosterChanged = { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'June 21, 2027', applicantIds: ['77777777'] };
  const bookedTarget = { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'November 19, 2026', applicantIds: ['77777777', '88888888'] };
  const bookedTargetRosterChanged = { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'November 19, 2026', applicantIds: ['77777777'] };
  const unbookedOk = { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: ['77777777', '88888888'] };
  const unbookedRosterChanged = { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: ['77777777'] };

  it('does not record success for a failed old-date outcome blocked by roster', async () => {
    await seedVerifying({ reads: ['2027-06-21', '2027-06-21'] });
    mockReads([bookedPrevRosterChanged, bookedPrevRosterChanged]);
    await send({ type: 'ENGINE_VERIFY', owner: 'owner-token-01', runId: 'run-id-0001' });
    await vi.waitFor(() => expect((stored.engineStateV1 as any).intent).toBeNull());
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped',
      verificationError: 'The applicant list changed since the booking attempt. Automatic booking is paused. Press Start to verify the attempt before continuing.' });
    expect(stored.engineSuccessV1).toBeUndefined();
  });

  it('does not record success for an unbooked outcome blocked by config', async () => {
    await seedVerifying({ reads: [null, null], currentDate: null });
    stored.uiPreferencesV1 = { ...prefs, consulate: 'Invalid-Consulate' };
    mockReads([unbookedOk, unbookedOk]);
    await send({ type: 'ENGINE_VERIFY', owner: 'owner-token-01', runId: 'run-id-0001' });
    await vi.waitFor(() => expect((stored.engineStateV1 as any).intent).toBeNull());
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped' });
    expect((stored.engineStateV1 as any).verificationError).toContain('Settings changed');
    expect(stored.engineSuccessV1).toBeUndefined();
  });

  it('still records success for target date despite changed roster', async () => {
    await seedVerifying({ reads: ['2026-11-19', '2026-11-19'] });
    mockReads([bookedTargetRosterChanged, bookedTargetRosterChanged]);
    await send({ type: 'ENGINE_VERIFY', owner: 'owner-token-01', runId: 'run-id-0001' });
    await vi.waitFor(() => expect((stored.engineStateV1 as any).intent).toBeNull());
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped', verificationError: null });
    expect(stored.engineSuccessV1).toMatchObject({ date: '2026-11-19' });
  });

  it('preserves a blocked failure through a queued request without restarting as success', async () => {
    const { policyKey } = await import('../src/engine/lifecycle');
    const queuedKey = policyKey(prefs as unknown as Record<string, unknown>);
    await seedVerifying({ reads: ['2027-06-21', '2027-06-21'], queuedMode: 'booking', queuedPolicyKey: queuedKey });
    // Third verification read (date+roster) blocked by roster, then no restart.
    mockReads([bookedPrevRosterChanged, bookedPrevRosterChanged]);
    await send({ type: 'ENGINE_VERIFY', owner: 'owner-token-01', runId: 'run-id-0001' });
    await vi.waitFor(() => expect((stored.engineStateV1 as any).queuedStart).toBeNull());
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped', intent: null,
      verificationError: 'The applicant list changed since the booking attempt. Automatic booking is paused. Press Start to verify the attempt before continuing.' });
    expect((stored.engineStateV1 as any).runId).toBe('run-id-0001');
    expect(stored.engineSuccessV1).toBeUndefined();
  });

  it('blocks a queued success restart when prefs select another paid IVR', async () => {
    const { policyKey } = await import('../src/engine/lifecycle');
    const newPrefs = { ...prefs, paidIvr: '99999999' };
    const queuedKey = policyKey(newPrefs as unknown as Record<string, unknown>);
    await seedVerifying({ reads: ['2026-11-19', '2026-11-19'],
      queuedMode: 'booking', queuedPolicyKey: queuedKey, prefsOverride: { paidIvr: '99999999' } });
    mockReads([bookedTarget, bookedTarget, bookedTarget]);
    await send({ type: 'ENGINE_VERIFY', owner: 'owner-token-01', runId: 'run-id-0001' });
    await vi.waitFor(() => expect((stored.engineStateV1 as any).queuedStart).toBeNull());
    // Success is still recorded, but no fresh run binds the wrong group.
    expect(stored.engineSuccessV1).toMatchObject({ date: '2026-11-19' });
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped', intent: null });
    expect((stored.engineStateV1 as any).verificationError).toContain('Settings changed');
    expect((stored.engineStateV1 as any).runId).toBe('run-id-0001');
  });

  it('blocks a queued failure continuation when the fresh baseline no longer matches', async () => {
    const { policyKey } = await import('../src/engine/lifecycle');
    const queuedKey = policyKey(prefs as unknown as Record<string, unknown>);
    await seedVerifying({ reads: ['2027-06-21', '2027-06-21'], queuedMode: 'booking', queuedPolicyKey: queuedKey });
    // Verification third read confirms previous date with matching roster
    // (eligible continuation), but the queued fresh recheck observes the
    // target date instead of the classified previous baseline.
    mockReads([bookedPrev, bookedPrev, bookedTarget]);
    await send({ type: 'ENGINE_VERIFY', owner: 'owner-token-01', runId: 'run-id-0001' });
    await vi.waitFor(() => expect((stored.engineStateV1 as any).queuedStart).toBeNull());
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped', intent: null });
    expect((stored.engineStateV1 as any).verificationError).toContain('could not be verified');
    expect((stored.engineStateV1 as any).runId).toBe('run-id-0001');
    expect(stored.engineSuccessV1).toBeUndefined();
  });

  it('rechecks the dashboard first-group selection for a queued blank-IVR request', async () => {
    await seedVerifying({ reads: ['2026-11-19', '2026-11-19'], queuedMode: 'booking', prefsOverride: { paidIvr: '' } });
    mockReads([bookedTarget], [
      { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'paid' },
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
    ]);
    await send({ type: 'ENGINE_VERIFY', owner: 'owner-token-01', runId: 'run-id-0001' });
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped', intent: null, queuedStart: null, runId: 'run-id-0001' });
    expect((stored.engineStateV1 as any).verificationError).toContain('Settings changed');
    expect(stored.engineSuccessV1).toMatchObject({ date: '2026-11-19' });
  });

  it('restarts a queued failed attempt with the freshly selected group and reset budgets', async () => {
    await seedVerifying({ reads: ['2027-06-21', '2027-06-21'], queuedMode: 'booking' });
    Object.assign(stored.engineStateV1 as object, { consecutiveFailures: 4, sessionRenewals: 2 });
    mockReads([bookedPrev]);
    await send({ type: 'ENGINE_VERIFY', owner: 'owner-token-01', runId: 'run-id-0001' });
    expect(stored.engineStateV1).toMatchObject({ status: 'running', intent: null, queuedStart: null,
      runId: 'fresh-run-uuid-0001', consecutiveFailures: 0, sessionRenewals: 0,
      group: { scheduleId: '11111111', ivr: '22222222', currentDate: '2027-06-21', applicantIds: ['77777777', '88888888'] } });
    expect(stored.engineSuccessV1).toBeUndefined();
  });
});
