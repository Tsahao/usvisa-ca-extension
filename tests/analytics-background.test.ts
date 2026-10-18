import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsRecord } from '../src/analytics/store';
import { ANALYTICS_KEY } from '../src/analytics/store';

// Only the synthetic token can reach our mocked transport; .env.local is never used.
vi.mock('../src/analytics/config', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/analytics/config')>();
  return { ...actual, buildTimeAnalyticsConfig: () => actual.resolveAnalyticsConfig({
    token: 'phc_synthetic000000000000000000', host: 'https://us.i.posthog.com',
  }) };
});

describe('product worker telemetry integration (mocked network only)', () => {
  let stored: Record<string, any>;
  let chromeMock: any;
  let message: (value: any, sender: any, respond: (value: any) => void) => unknown;
  let alarmed: (alarm: { name: string }) => void;
  let changed: (changes: Record<string, unknown>, area: string) => void;
  let fetchFn: ReturnType<typeof vi.fn>;
  const sender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/panel.html?detached=1' };
  const dashboard = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
  const payment = 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment';
  const preferences = { email: 'fixture@example.invalid', password: 'private-synthetic-password', consulate: 'Vancouver',
    earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: true, interval: 120, paidIvr: '', unpaidIvr: '' };
  const snapshot = { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
    { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] };
  const summary = { headingFound: true, rows: ['Calgary', 'Halifax', 'Montreal', 'Ottawa', 'Quebec City', 'Toronto', 'Vancouver']
    .map(city => ({ city, text: 'No Appointments Available' })) };
  const record = () => stored[ANALYTICS_KEY] as AnalyticsRecord;
  const events = () => fetchFn.mock.calls.map(call => JSON.parse(call[1].body as string));
  async function send(value: unknown, from = sender) {
    const respond = vi.fn(); message(value, from, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    return respond.mock.calls[0][0];
  }
  async function flush() {
    // Production sends on its independent alarm. Advance only its durable
    // deadline in fixtures so no engine poll/timer is accelerated accidentally.
    await vi.waitFor(() => expect(record()).toBeDefined());
    alarmed({ name: 'analyticsFlush' });
    await vi.waitFor(() => expect(record().outbox).toHaveLength(0));
  }
  beforeEach(async () => {
    vi.useFakeTimers(); vi.resetModules();
    stored = { uiPreferencesV1: structuredClone(preferences) };
    fetchFn = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchFn);
    chromeMock = {
      storage: {
        onChanged: { addListener: vi.fn(fn => { changed = fn; }) },
        session: { get: vi.fn(async () => ({ engineSessionV1: true })), set: vi.fn(async () => undefined), setAccessLevel: vi.fn(async () => undefined) },
        local: {
          get: vi.fn(async () => structuredClone(stored)),
          set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(stored, structuredClone(update)); }),
          setAccessLevel: vi.fn(async () => undefined),
        },
      },
      runtime: { id: sender.id, getURL: (path: string) => `chrome-extension://${sender.id}/${path}`,
        getManifest: () => ({ version: '0.1.0' }), onMessage: { addListener: vi.fn(fn => { message = fn; }) } },
      action: { onClicked: { addListener: vi.fn() } },
      tabs: { query: vi.fn(async () => [{ id: 7, url: dashboard }]), get: vi.fn(async () => ({ id: 7, url: dashboard, status: 'complete' })),
        update: vi.fn(async () => ({ id: 7 })), create: vi.fn(async () => ({ id: 7 })), remove: vi.fn(async () => undefined), reload: vi.fn(async () => undefined),
        onUpdated: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn(async () => [{ result: structuredClone(snapshot) }]) },
      notifications: { create: vi.fn(async () => 'synthetic-note') },
      alarms: { create: vi.fn(async () => undefined), clear: vi.fn(async () => true), onAlarm: { addListener: vi.fn(fn => { alarmed = fn; }) } },
    };
    vi.stubGlobal('chrome', chromeMock);
    await import('../src/background');
    await vi.waitFor(() => expect(record()).toBeDefined());
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('counts only first successful unpaid summary, even if no dates are available; duplicate Start/polls do not inflate it', async () => {
    expect(await send({ type: 'PANEL_START', mode: 'alerts' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(record().session?.runId).toBe(stored.engineStateV1.runId));
    expect(record().session!.activated).toBe(false);
    const analyticsId = record().session!.id;
    await send({ type: 'PANEL_START', mode: 'alerts' });
    expect(record().session!.id).toBe(analyticsId);
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: payment }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: summary }]);
    stored.engineStateV1.nextPollAt = new Date().toISOString(); alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(record().session!.activated).toBe(true));
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
    stored.engineStateV1.nextPollAt = new Date().toISOString(); alarmed({ name: 'enginePoll' });
    await send({ type: 'PANEL_STATE' }); await flush();
    expect(events().filter(event => event.event === 'workflow_started')).toHaveLength(1);
    expect(events().filter(event => event.event === 'alerts_monitoring_established')).toHaveLength(1);
    expect(JSON.stringify(events())).not.toMatch(/fixture@example|private-synthetic|33333333|44444444|Vancouver|2026-11-01|schedule\//);
  });
  it('counts a curious paid-only Alerts click as a failed start, never successful activation', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [snapshot.groups[0]] } }]);
    expect(await send({ type: 'PANEL_START', mode: 'alerts' })).toMatchObject({ ok: false, failureKind: 'unpaid-ivr-not-found' });
    await flush();
    expect(events().map(event => event.event)).toEqual(['installation_seen', 'workflow_started', 'workflow_failed']);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });
  it('provides read-only sanitized problem-report context only to the trusted product panel', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [snapshot.groups[0]] } }]);
    await send({ type: 'PANEL_START', mode: 'alerts' });
    const before = structuredClone(stored.engineStateV1);
    const report = await send({ type: 'ENGINE_PROBLEM_REPORT' });
    expect(report).toMatchObject({ ok: true, diagnostics: { version: 1 }, context: { status: expect.any(String), stage: expect.any(String) } });
    expect(Object.keys(report.context).sort()).toEqual(['stage', 'status']);
    expect(JSON.stringify(report)).not.toMatch(/fixture@example|private-synthetic|11111111|22222222|Vancouver|2026-11-01|schedule\//);
    expect(stored.engineStateV1).toEqual(before);
    const respond = vi.fn();
    expect(message({ type: 'ENGINE_PROBLEM_REPORT' }, { id: sender.id, url: dashboard }, respond)).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
  });
  it('does not count invalid local configuration or developer/preview Starts', async () => {
    stored.uiPreferencesV1.password = '';
    await send({ type: 'PANEL_START', mode: 'alerts' });
    stored.uiPreferencesV1 = structuredClone(preferences);
    await send({ type: 'PANEL_START', mode: 'alerts' }, { ...sender, url: 'chrome-extension://synthetic-extension/panel.html?embedded=1' });
    await flush();
    expect(events().map(event => event.event)).toEqual(['installation_seen']);
    expect(record().session).toBeNull();
  });
  it('counts a post-login paid-group rejection as a failed tracked session', async () => {
    chromeMock.tabs.query.mockResolvedValue([]);
    await send({ type: 'PANEL_START', mode: 'alerts' });
    await vi.waitFor(() => expect(record().session?.runId).toBe(stored.engineStateV1.runId));
    const original = record().session!.id;
    await send({ type: 'PANEL_STATE' }); // Drain the initial fresh-tab auth step.
    stored.engineStateV1.authentication.tabId = 7;
    stored.engineStateV1.nextPollAt = new Date().toISOString();
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: dashboard, status: 'complete' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { groups: [snapshot.groups[0]] } }]);
    alarmed({ name: 'enginePoll' });
    await send({ type: 'PANEL_STATE' });
    expect(chromeMock.scripting.executeScript.mock.calls.map((call: any) => call[0].func.name)).toContain('readDashboardGroups');
    expect(stored.engineStateV1).toMatchObject({ status: 'stopped' });
    await vi.waitFor(() => expect(record().session!.failed).toBe(true)); await flush();
    expect(record().session!.id).toBe(original);
    expect(events().filter(event => event.event === 'workflow_failed')).toHaveLength(1);
    expect(events().filter(event => event.event === 'alerts_monitoring_established')).toHaveLength(0);
  });
  it('does not count maintenance reads/cooldowns, Stop or configuration changes as failures', async () => {
    await send({ type: 'PANEL_START', mode: 'alerts' });
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: payment }]);
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { maintenance: true } }]);
    stored.engineStateV1.nextPollAt = new Date().toISOString(); alarmed({ name: 'enginePoll' });
    await vi.waitFor(() => expect(stored.engineStateV1.consecutiveFailures).toBe(1));
    await send({ type: 'PANEL_STOP' });
    changed({ uiPreferencesV1: { oldValue: preferences, newValue: { ...preferences, interval: 180 } } }, 'local');
    await flush();
    expect(events().filter(event => event.event === 'workflow_failed')).toHaveLength(0);
    expect(events().filter(event => event.event === 'alerts_monitoring_established')).toHaveLength(0);
  });
  it('unavailable analytics storage cannot block accepted product Start or Stop', async () => {
    chromeMock.storage.local.get.mockImplementation(async (keys: string[]) => {
      if (keys.includes(ANALYTICS_KEY)) throw new Error('analytics-only storage unavailable');
      return structuredClone(stored);
    });
    expect(await send({ type: 'PANEL_START', mode: 'alerts' })).toMatchObject({ ok: true });
    expect(await send({ type: 'PANEL_STOP' })).toMatchObject({ ok: true });
    expect(stored.engineStateV1.status).toBe('stopped');
  });
  it('a hung analytics HTTP request cannot delay product Start/Stop or its checkpoints', async () => {
    fetchFn.mockImplementation(() => new Promise(() => undefined));
    await send({ type: 'PANEL_START', mode: 'alerts' });
    alarmed({ name: 'analyticsFlush' });
    expect(await send({ type: 'PANEL_STOP' })).toMatchObject({ ok: true });
    expect(stored.engineStateV1.status).toBe('stopped');
  });
  it('a failed safety checkpoint still fails Start rather than being swallowed by analytics', async () => {
    chromeMock.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      if ('engineStateV1' in values) throw new Error('checkpoint unavailable');
      Object.assign(stored, structuredClone(values));
    });
    expect(await send({ type: 'PANEL_START', mode: 'alerts' })).toMatchObject({ ok: false });
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });
});
