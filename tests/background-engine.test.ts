import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_KEY } from '../src/engine/workflow';

type Listener = (message: unknown, sender: unknown, respond: (value: unknown) => void) => unknown;

describe('background engine startup reconciliation', () => {
  let stored: Record<string, unknown>;
  let onMessage: Listener;
  let onAlarm: (alarm: { name: string }) => void;
  let alarmsMock: {
    create: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    stored = {};
    alarmsMock = {
      create: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(true),
    };
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue({ engineSessionV1: true }),
          set: vi.fn().mockResolvedValue(undefined),
        },
        local: {
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
          get: vi.fn(async () => ({ ...stored })),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(stored, values);
          }),
        },
      },
      action: { onClicked: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: true }]) },
      tabs: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn(async (tabId: number) => ({ id: tabId })),
        query: vi.fn().mockResolvedValue([]),
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://ais.usvisa-info.com/en-ca/niv/groups' })),
      },
      alarms: {
        ...alarmsMock,
        onAlarm: {
          addListener: vi.fn(listener => {
            onAlarm = listener;
          }),
        },
      },
      runtime: {
        id: 'synthetic-extension',
        getURL: (path: string) => `chrome-extension://synthetic-extension/${path}`,
        onMessage: {
          addListener: vi.fn(listener => {
            onMessage = listener;
          }),
        },
      },
    });
  });

  const panelSender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html' };
  const siteSender = { id: 'synthetic-extension', url: 'https://ais.usvisa-info.com/en-ca/niv/groups' };
  const send = (message: unknown, sender: unknown) =>
    new Promise<unknown>(resolve => {
      expect(onMessage(message, sender, resolve)).toBe(true);
    });

  it('moves an interrupted confirmation to verification without losing intent', async () => {
    const { emptyEngineState, recordIntent, startRun } = await import('../src/engine/workflow');
    const now = '2026-10-12T00:00:00.000Z';
    const running = recordIntent(
      startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now }),
      {
        owner: 'owner-token-01',
        runId: 'run-id-0001',
        intent: {
          runId: 'run-id-0001',
          mode: 'booking',
          groupId: 'group-1234',
          targetDate: '2026-12-01',
          consulate: 'Vancouver',
          testMode: true,
          createdAt: now,
        },
        now,
      },
    );
    stored[ENGINE_KEY] = JSON.parse(JSON.stringify(running));
    await import('../src/background');
    await vi.waitFor(() => {
      const state = stored[ENGINE_KEY] as { status?: string };
      expect(state?.status).toBe('verifying');
    });
    const state = stored[ENGINE_KEY] as { intent: unknown; nextPollAt: null; runId: string };
    expect(state.intent).toEqual(running.intent);
    expect(state.nextPollAt).toBeNull();
    expect(state.runId).toBe('run-id-0001');
  });

  it('re-arms a deadline-less bound run once for revalidation instead of stalling', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now });
    stored[ENGINE_KEY] = JSON.parse(
      JSON.stringify(
        bindGroup(started, {
          owner: 'owner-token-01',
          runId: 'run-id-0001',
          binding: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null },
          now,
        }),
      ),
    );
    await import('../src/background');
    await vi.waitFor(() => {
      expect((stored[ENGINE_KEY] as { nextPollAt: string }).nextPollAt).not.toBeNull();
    });
    const deadline = Date.parse((stored[ENGINE_KEY] as { nextPollAt: string }).nextPollAt);
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline).toBeLessThanOrEqual(Date.now() + 61_000);
    expect((stored[ENGINE_KEY] as { status: string }).status).toBe('running');
    expect(alarmsMock.create).toHaveBeenCalledWith('enginePoll', { when: expect.any(Number) });
  });

  it('leaves probe behavior unchanged when no engine run exists', async () => {
    await import('../src/background');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stored[ENGINE_KEY]).toBeUndefined();
  });

  it('starts once from a trusted page and keeps duplicate Start idempotent', async () => {
    await import('../src/background');
    const first = (await send(
      { type: 'ENGINE_START', mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now: new Date().toISOString() },
      panelSender,
    )) as { ok: boolean; runId: string; generation: number };
    expect(first.ok).toBe(true);
    const second = (await send(
      { type: 'ENGINE_START', mode: 'alerts', owner: 'other-owner-02', runId: 'run-id-0002', now: new Date().toISOString() },
      panelSender,
    )) as { ok: boolean; runId: string };
    expect(second.ok).toBe(true);
    expect(second.runId).toBe('run-id-0001');
    expect((stored[ENGINE_KEY] as { owner: string }).owner).toBe('owner-token-01');
  });

  it('rejects engine control from website senders and malformed messages', async () => {
    await import('../src/background');
    expect(
      onMessage(
        { type: 'ENGINE_START', mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now: new Date().toISOString() },
        siteSender,
        vi.fn(),
      ),
    ).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stored[ENGINE_KEY]).toBeUndefined();
    const bad = (await send({ type: 'ENGINE_START', mode: 'booking' }, panelSender)) as { ok: boolean };
    expect(bad.ok).toBe(false);
    expect(stored[ENGINE_KEY]).toBeUndefined();
  });

  it('enforces ownership on stop and resolves verification for the owning run', async () => {
    await import('../src/background');
    await send(
      { type: 'ENGINE_START', mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now: new Date().toISOString() },
      panelSender,
    );
    await send(
      {
        type: 'ENGINE_INTENT',
        owner: 'owner-token-01',
        runId: 'run-id-0001',
        intent: {
          runId: 'run-id-0001',
          mode: 'booking',
          groupId: 'group-1234',
          targetDate: '2026-12-01',
          consulate: 'Vancouver',
          testMode: true,
          createdAt: new Date().toISOString(),
        },
        now: new Date().toISOString(),
      },
      panelSender,
    );
    await send({ type: 'ENGINE_STOP', owner: 'other-owner-02', runId: 'run-id-0001', now: new Date().toISOString() }, panelSender);
    expect((stored[ENGINE_KEY] as { status: string }).status).toBe('running');
    await send({ type: 'ENGINE_STOP', owner: 'owner-token-01', runId: 'run-id-0001', now: new Date().toISOString() }, panelSender);
    expect((stored[ENGINE_KEY] as { status: string }).status).toBe('verifying');
  });

  it('does not accept a claimed verification outcome without a fresh bound dashboard read', async () => {
    const { bindGroup, emptyEngineState, startRun, recordIntent, parkForReview } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const bound = bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), {
      ...args, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-06-21' },
    });
    const state = parkForReview(recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: '11111111', mode: 'booking', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: true, createdAt: now,
    } }), now);
    stored[ENGINE_KEY] = state;
    await import('../src/background');
    await send({ type: 'ENGINE_VERIFY', ...args, outcome: 'target-confirmed' }, panelSender);
    expect(stored[ENGINE_KEY]).toMatchObject({ status: 'verifying', intent: state.intent });
    expect((await chrome.storage.local.get('engineSuccessV1')).engineSuccessV1).toBeUndefined();
  });

  it('schedules an alarm for the poll deadline and clears it on stop', async () => {
    await import('../src/background');
    const deadline = new Date(Date.now() + 60_000).toISOString();
    await send(
      { type: 'ENGINE_START', mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now: new Date().toISOString(), nextPollAt: deadline },
      panelSender,
    );
    expect(alarmsMock.create).toHaveBeenCalledWith('enginePoll', { when: Date.parse(deadline) });
    await send({ type: 'ENGINE_STOP', owner: 'owner-token-01', runId: 'run-id-0001', now: new Date().toISOString() }, panelSender);
    expect(alarmsMock.clear).toHaveBeenCalledWith('enginePoll');
  });

  it('preserves an overdue deadline on worker wake and revalidates only once', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now, nextPollAt: past });
    stored[ENGINE_KEY] = bindGroup(started, {
      owner: 'owner-token-01', runId: 'run-id-0001',
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'unpaid', currentDate: null }, now,
    });
    await import('../src/background');
    await vi.waitFor(() => expect(alarmsMock.create).toHaveBeenCalled());
    expect((stored[ENGINE_KEY] as { nextPollAt: string }).nextPollAt).toBe(past);
    onAlarm({ name: 'enginePoll' });
    await vi.waitFor(() => expect((stored[ENGINE_KEY] as { status: string }).status).toBe('verifying'));
    expect((stored[ENGINE_KEY] as { runId: string }).runId).toBe('run-id-0001');
    const writes = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.length;
    onAlarm({ name: 'enginePoll' });
    await send({ type: 'ENGINE_STOP', owner: 'other-owner-02', runId: 'run-id-0001', now }, panelSender);
    expect((chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writes);
  });

  it.each(['booking', 'alerts'] as const)('preserves %s backoff and cooldown across worker wake', async mode => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const retry = new Date(Date.now() + 180_000).toISOString();
    const cooldown = new Date(Date.now() + 1800_000).toISOString();
    const started = startRun(emptyEngineState(now), { mode, owner: 'owner-token-01', runId: 'run-id-0001', now, nextPollAt: retry });
    stored[ENGINE_KEY] = {
      ...bindGroup(started, {
        owner: 'owner-token-01', runId: 'run-id-0001',
        binding: { scheduleId: '11111111', ivr: '22222222', kind: mode === 'booking' ? 'paid' : 'unpaid', currentDate: null }, now,
      }),
      consecutiveFailures: 10, cooldownUntil: cooldown,
    };
    await import('../src/background');
    await vi.waitFor(() => expect(alarmsMock.create).toHaveBeenCalledWith('enginePoll', { when: Date.parse(cooldown) }));
    expect(stored[ENGINE_KEY]).toMatchObject({ nextPollAt: retry, cooldownUntil: cooldown, consecutiveFailures: 10 });
    onAlarm({ name: 'enginePoll' });
    await send({ type: 'ENGINE_STOP', owner: 'other-owner-02', runId: 'run-id-0001', now }, panelSender);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(stored[ENGINE_KEY]).toMatchObject({ status: 'running', nextPollAt: retry });
  });

  it('parks a persisted run on browser restart before handling an alarm', async () => {
    const { bindGroup, emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    const started = startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now, nextPollAt: now });
    stored[ENGINE_KEY] = bindGroup(started, {
      owner: 'owner-token-01', runId: 'run-id-0001',
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null }, now,
    });
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await import('../src/background');
    onAlarm({ name: 'enginePoll' });
    await send({ type: 'ENGINE_START', mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0002', now }, panelSender);
    expect(stored[ENGINE_KEY]).toMatchObject({ status: 'verifying', runId: 'run-id-0001', nextPollAt: null });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(alarmsMock.create).not.toHaveBeenCalled();
  });

  it('blocks queued work on a reconciliation write failure and retries next wake', async () => {
    const { emptyEngineState, startRun } = await import('../src/engine/workflow');
    const now = new Date().toISOString();
    stored[ENGINE_KEY] = startRun(emptyEngineState(now), {
      mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now, nextPollAt: now,
    });
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const write = chrome.storage.local.set as ReturnType<typeof vi.fn>;
    write.mockRejectedValue(new Error('synthetic storage failure'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await import('../src/background');
      onAlarm({ name: 'enginePoll' });
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
      expect(chrome.storage.session.set).not.toHaveBeenCalled();
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
      expect(alarmsMock.create).not.toHaveBeenCalled();
      write.mockImplementation(async (values: Record<string, unknown>) => { Object.assign(stored, values); });
      vi.resetModules();
      await import('../src/background');
      await vi.waitFor(() => expect(stored[ENGINE_KEY]).toMatchObject({ status: 'verifying', nextPollAt: null }));
      expect(chrome.storage.session.set).toHaveBeenCalledWith({ engineSessionV1: true });
    } finally {
      log.mockRestore();
    }
  });

  it('binds the IVR-resolved group and refuses paid fallback for unpaid runs', async () => {
    await import('../src/background');
    const snapshot = { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }, { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] };
    await send(
      { type: 'ENGINE_START', mode: 'alerts', owner: 'owner-token-01', runId: 'run-id-0001', now: new Date().toISOString() },
      panelSender,
    );
    const bound = (await send(
      {
        type: 'ENGINE_RESOLVE',
        owner: 'owner-token-01',
        runId: 'run-id-0001',
        mode: 'alerts',
        snapshot,
        paidIvr: '22222222',
        unpaidIvr: '44444444',
        now: new Date().toISOString(),
      },
      panelSender,
    )) as { ok: boolean };
    expect(bound.ok).toBe(true);
    expect((stored[ENGINE_KEY] as { group: unknown }).group).toEqual({
      scheduleId: '33333333',
      ivr: '44444444',
      kind: 'unpaid',
      currentDate: null,
    });
    const fallback = (await send(
      {
        type: 'ENGINE_RESOLVE',
        owner: 'owner-token-01',
        runId: 'run-id-0001',
        mode: 'alerts',
        snapshot: { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] },
        paidIvr: '22222222',
        unpaidIvr: '99999999',
        now: new Date().toISOString(),
      },
      panelSender,
    )) as { ok: boolean };
    expect(fallback.ok).toBe(false);
    expect((stored[ENGINE_KEY] as { group: unknown }).group).toEqual({
      scheduleId: '33333333',
      ivr: '44444444',
      kind: 'unpaid',
      currentDate: null,
    });
  });
});
