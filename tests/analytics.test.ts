import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTimeAnalyticsConfig, resolveAnalyticsConfig } from '../src/analytics/config';
import { buildInstallationSeen, toCapturePayload, validateQueuedEvent } from '../src/analytics/events';
import { ANALYTICS_KEY, OUTBOX_MAX, validateAnalyticsRecord, type AnalyticsRecord } from '../src/analytics/store';
import { createAnalyticsTracker, isProductPanelSender } from '../src/analytics/tracker';
import { sendOneEvent } from '../src/analytics/transport';
import { emptyEngineState, type EngineState } from '../src/engine/workflow';

const token = 'phc_synthetic000000000000000000';
const config = resolveAnalyticsConfig({ token, host: 'https://us.i.posthog.com' });
const now = '2026-10-14T12:00:00.000Z';
const runId = 'run-id-0001';

function fixture(enabled = true) {
  const values: Record<string, unknown> = {};
  let at = now;
  let identity = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`;
  const area = {
    get: vi.fn(async () => structuredClone(values)),
    set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(values, structuredClone(update)); }),
  };
  const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
  const scheduleFlush = vi.fn();
  const deps = { area, config: enabled ? config : { enabled: false as const }, fetchFn, nowIso: () => at,
    uuid, extensionVersion: '0.1.0', scheduleFlush };
  const tracker = createAnalyticsTracker(deps);
  const state: EngineState = { ...emptyEngineState(now), owner: 'product-panel-owner', runId, mode: 'alerts', status: 'running',
    group: { kind: 'unpaid', scheduleId: '11111111', ivr: '22222222', currentDate: null } };
  const record = () => values[ANALYTICS_KEY] as AnalyticsRecord;
  const start = async () => { const id = tracker.start('alerts', true); tracker.link(id, state); await tracker.settled(); return id; };
  return { values, tracker, area, fetchFn, deps, state, record, start, setTime: (time: string) => { at = time; }, scheduleFlush };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('PostHog configuration and allowlisted delivery', () => {
  it.each(['https://evil.invalid', 'http://us.i.posthog.com', 'https://us.i.posthog.com/',
    'https://us.i.posthog.com:443', 'https://us.i.posthog.com?x=1', 'https://user@us.i.posthog.com'])('rejects host %s', host => {
    expect(resolveAnalyticsConfig({ token, host })).toEqual({ enabled: false });
  });
  it.each(['', 'personal_secret', 'phx_private00000000', 'your_project_ingestion_token'])('rejects token/placeholder %s', value => {
    expect(resolveAnalyticsConfig({ token: value, host: 'https://us.i.posthog.com' })).toEqual({ enabled: false });
  });
  it('accepts only a valid project token and US/EU ingestion host, and respects disabled builds', () => {
    expect(resolveAnalyticsConfig({ token, host: 'https://eu.i.posthog.com' })).toMatchObject({ enabled: true, endpoint: 'https://eu.i.posthog.com/i/v0/e/' });
    expect(resolveAnalyticsConfig({ token, host: 'https://us.i.posthog.com', enabledFlag: 'false' })).toEqual({ enabled: false });
    expect(resolveAnalyticsConfig({ token, host: 'https://us.i.posthog.com', enabledFlag: 'unknown' })).toEqual({ enabled: false });
    expect(buildTimeAnalyticsConfig()).toEqual({ enabled: false }); // Vitest never uses .env.local for delivery.
  });
  it.each(['panel.html?preview=1', 'panel.html?embedded=1', 'panel.html?probe=1', 'probe.html'])('does not track developer sender %s', path => {
    expect(isProductPanelSender(`chrome-extension://synthetic/${path}`)).toBe(false);
  });
  it('accepts ordinary/detached panels, never a website', () => {
    expect(isProductPanelSender('chrome-extension://synthetic/panel.html')).toBe(true);
    expect(isProductPanelSender('chrome-extension://synthetic/panel.html?detached=1')).toBe(true);
    expect(isProductPanelSender('https://evil.invalid/panel.html')).toBe(false);
  });
  it('uses a minimal fixed payload, no cookies/referrer/redirects, and disables person/GeoIP enrichment', async () => {
    const f = fixture(); await f.start(); await f.tracker.flush();
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
    for (const [url, init] of f.fetchFn.mock.calls) {
      expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
      expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      const body = JSON.parse(init.body as string);
      expect(Object.keys(body).sort()).toEqual(['api_key', 'distinct_id', 'event', 'properties', 'timestamp', 'uuid']);
      expect(body.properties).toMatchObject({ $process_person_profile: false, $geoip_disable: true, $ip: null, environment: 'production' });
      expect(JSON.stringify(body)).not.toMatch(/11111111|22222222|run-id|email|password|consulate|targetDate/);
    }
  });
  it('refuses corrupted outbox properties or an overridden endpoint before fetching', async () => {
    const f = fixture(); await f.start();
    const event = structuredClone(f.record().outbox[0]);
    Object.assign(event.properties, { email: 'private@example.invalid' });
    expect(() => validateQueuedEvent(event)).toThrow();
    expect(() => toCapturePayload(event, token)).toThrow();
    const safe = f.record().outbox[0];
    await expect(sendOneEvent({ event: safe, config: { ...config, enabled: true, host: 'https://us.i.posthog.com', projectToken: token,
      endpoint: 'https://evil.invalid' }, fetchFn: f.fetchFn })).rejects.toThrow('Invalid analytics endpoint');
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('aborts a stalled network request at its timeout', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start();
    const fetchFn = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('synthetic abort')));
    }));
    const promise = sendOneEvent({ event: f.record().outbox[0], config, fetchFn, timeoutMs: 100 });
    const assertion = expect(promise).rejects.toThrow('synthetic abort');
    await vi.advanceTimersByTimeAsync(100); await assertion;
  });
});

describe('durable milestones and sessions', () => {
  it('records resolved discovery once across duplicate reads and worker wake', async () => {
    const f = fixture();
    f.tracker.resolvedStart(f.state, false); f.tracker.resolvedStart(f.state, false); await f.tracker.settled();
    const session = f.record().session!.id;
    const worker = createAnalyticsTracker(f.deps); worker.resolvedStart(f.state, false); await worker.settled();
    expect(f.record().session!.id).toBe(session);
    expect(f.record().outbox.filter(event => event.event === 'workflow_started')).toHaveLength(1);
    const paid: EngineState = { ...f.state, mode: 'booking', discovery: { features: 'booking', requested: false, choosing: false },
      group: { ...f.state.group!, kind: 'paid' } };
    worker.observe(paid); await worker.settled();
    expect(f.record().session!.mode).toBe('booking');
    expect(f.record().session!.id).toBe(session);
    expect(f.record().outbox.filter(event => event.event === 'workflow_started')).toHaveLength(1);
  });

  async function bookingFixture(testMode = false) {
    const f = fixture();
    const state: EngineState = { ...f.state, mode: 'booking', status: 'verifying',
      intent: { runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19',
        consulate: 'Vancouver', testMode, createdAt: now, phase: 'submitted' } };
    const id = f.tracker.start('booking', testMode);
    f.tracker.link(id, state); await f.tracker.settled();
    return { ...f, state };
  }
  it('queues one verified booking, retains deduplication across worker wakes and sends no appointment details', async () => {
    const f = await bookingFixture();
    f.tracker.booked(f.state); f.tracker.booked(f.state); await f.tracker.settled();
    const worker = createAnalyticsTracker(f.deps);
    worker.booked(f.state); await worker.settled();
    expect(f.record().outbox.filter(event => event.event === 'appointment_booked')).toHaveLength(1);
    await worker.flush();
    const event = f.fetchFn.mock.calls.map(call => JSON.parse(call[1].body as string)).find(event => event.event === 'appointment_booked');
    expect(event.properties).toEqual({ analytics_session_id: f.record().session!.id, mode: 'booking', test_mode: false,
      extension_version: '0.1.0', environment: 'production', $process_person_profile: false, $geoip_disable: true, $ip: null });
    expect(JSON.stringify(event)).not.toMatch(/11111111|22222222|run-id|Vancouver|2026-11-19/);
  });
  it.each(['test-mode', 'foreign', 'wrong-run', 'no-intent', 'alerts', 'untracked'])('does not count an unqualified booking (%s)', async issue => {
    const f = await bookingFixture(issue === 'test-mode');
    if (issue === 'foreign') f.state.owner = 'probe-owner-dev';
    if (issue === 'wrong-run') f.state.runId = 'another-run-01';
    if (issue === 'no-intent') f.state.intent = null;
    if (issue === 'alerts') f.state.mode = 'alerts';
    if (issue === 'untracked') f.values[ANALYTICS_KEY] = { ...f.record(), session: null };
    f.tracker.booked(f.state); await f.tracker.settled();
    expect(f.record().outbox.filter(event => event.event === 'appointment_booked')).toHaveLength(0);
  });
  it('counts a later verified booking even if Stop closed its session while verification was pending', async () => {
    const f = await bookingFixture();
    f.tracker.end(); f.tracker.booked(f.state); await f.tracker.settled();
    expect(f.record().outbox.filter(event => event.event === 'appointment_booked')).toHaveLength(1);
  });
  it('counts another booking after an explicit new workflow Start', async () => {
    const f = await bookingFixture();
    f.tracker.booked(f.state); await f.tracker.settled();
    const next = { ...f.state, runId: 'run-id-0002' };
    const id = f.tracker.start('booking', false); f.tracker.link(id, next);
    f.tracker.booked(next); await f.tracker.settled();
    expect(f.record().outbox.filter(event => event.event === 'appointment_booked')).toHaveLength(2);
  });
  it('rejects malformed success events and appointment data in the allowlist validator', async () => {
    const f = await bookingFixture(); f.tracker.booked(f.state); await f.tracker.settled();
    const event = f.record().outbox.find(event => event.event === 'appointment_booked')!;
    for (const properties of [{ test_mode: true }, { mode: 'alerts' }, { analytics_session_id: undefined },
      { failure_reason: 'start-failed' }, { targetDate: '2026-11-19' }]) {
      expect(() => validateQueuedEvent({ ...event, properties: { ...event.properties, ...properties } })).toThrow();
    }
  });
  it('commits installation and Start together, links locally, and activates only once', async () => {
    const f = fixture(); await f.start();
    f.tracker.activated(f.state, 7); f.tracker.activated(f.state, 7); await f.tracker.settled();
    expect(f.record().outbox.map(entry => entry.event)).toEqual(['installation_seen', 'workflow_started', 'alerts_monitoring_established']);
    expect(f.record().outbox.every(entry => entry.distinct_id === f.record().distinctId)).toBe(true);
    expect(validateAnalyticsRecord(f.record())).toEqual(f.record());
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it.each(['paid', 'unknown', 'unlinked', 'wrong-run', 'incomplete', 'probe'])('refuses unqualified activation (%s)', async issue => {
    const f = fixture();
    if (issue === 'unlinked') { f.tracker.start('alerts', true); await f.tracker.settled(); }
    else await f.start();
    const state = structuredClone(f.state);
    if (issue === 'paid') state.group!.kind = 'paid';
    if (issue === 'unknown') state.group = null;
    if (issue === 'wrong-run') state.runId = 'another-run-01';
    if (issue === 'probe') state.owner = 'probe-owner-dev';
    f.tracker.activated(state, issue === 'incomplete' ? 6 : 7); await f.tracker.settled();
    expect(f.record().session!.activated).toBe(false);
  });
  it('counts an early Start failure once, without needing an engine run', async () => {
    const f = fixture(); const id = f.tracker.start('alerts', true);
    f.tracker.startFailed(id); f.tracker.startFailed(id); await f.tracker.settled();
    expect(f.record().outbox.map(entry => entry.event)).toEqual(['installation_seen', 'workflow_started', 'workflow_failed']);
    expect(f.record().outbox.at(-1)!.properties.failure_reason).toBe('start-failed');
  });
  it.each(['login', 'setup', 'blocked', 'post-login-group'])('counts a terminal %s failure once', async issue => {
    const f = fixture(); await f.start();
    const state = { ...f.state, status: issue === 'blocked' ? 'verifying' as const : 'stopped' as const,
      loginFailed: issue === 'login', restartFailed: issue === 'setup', authenticationError: issue === 'post-login-group' ? 'A fixed diagnostic' : null };
    f.tracker.observe(state); f.tracker.observe(state); await f.tracker.settled();
    expect(f.record().outbox.filter(entry => entry.event === 'workflow_failed')).toHaveLength(1);
  });
  it.each(['retry', 'cooldown', 'manual-auth', 'test-mode', 'intent', 'success', 'user-stop', 'legacy', 'foreign'])('does not call %s a failed workflow', async issue => {
    const f = fixture(); if (issue !== 'legacy') await f.start();
    const state = { ...f.state };
    if (issue === 'retry') state.consecutiveFailures = 9;
    if (issue === 'cooldown') state.cooldownUntil = '2026-10-14T13:00:00Z';
    if (issue === 'manual-auth') { state.manualAuthentication = true; state.status = 'verifying'; }
    if (issue === 'test-mode') { state.status = 'verifying'; state.stage = 'done'; }
    if (issue === 'intent') { state.status = 'verifying'; state.intent = { runId, mode: 'booking', groupId: '11111111',
      targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: now }; }
    if (issue === 'success') state.status = 'stopped';
    if (issue === 'user-stop') { f.tracker.end(); state.status = 'stopped'; state.loginFailed = true; }
    if (issue === 'legacy') { state.status = 'stopped'; state.loginFailed = true; }
    if (issue === 'foreign') { state.owner = 'probe-owner-dev'; state.status = 'stopped'; state.loginFailed = true; }
    f.tracker.observe(state); await f.tracker.settled();
    expect(f.record()?.outbox.filter(entry => entry.event === 'workflow_failed') ?? []).toHaveLength(0);
  });
  it('does not count a lost response as a failure after linking an accepted run', async () => {
    const f = fixture(); const id = await f.start(); f.tracker.startFailed(id); await f.tracker.settled();
    expect(f.record().session!.failed).toBe(false);
  });
  it('retains identity and milestones on worker wake; explicit fresh Start makes a new session', async () => {
    const f = fixture(); await f.start();
    const firstId = f.record().session!.id; const install = f.record().distinctId;
    const nextWorker = createAnalyticsTracker(f.deps);
    nextWorker.observe({ ...f.state, sessionRenewals: 2 }); await nextWorker.settled();
    expect(f.record().session!.id).toBe(firstId);
    const nextId = nextWorker.start('alerts', true); nextWorker.link(nextId, { ...f.state, runId: 'run-id-0002' }); await nextWorker.settled();
    expect(f.record().session!.id).not.toBe(firstId);
    expect(f.record().distinctId).toBe(install);
    expect(f.record().outbox.filter(entry => entry.event === 'installation_seen')).toHaveLength(1);
    expect(f.record().outbox.filter(entry => entry.event === 'workflow_started')).toHaveLength(2);
  });
  it('queues a restart without counting it until the matching validated run replacement', async () => {
    const f = fixture(); await f.start();
    f.tracker.queueRestart(f.state, 'alerts', true); await f.tracker.settled();
    const previousId = f.record().session!.id;
    f.tracker.observe({ ...f.state, runId: 'unrelated-run-01' }); await f.tracker.settled();
    expect(f.record().session!.id).toBe(previousId);
    f.tracker.observe({ ...f.state, runId: 'run-id-0002' }, runId); await f.tracker.settled();
    expect(f.record().session!.id).not.toBe(previousId);
    expect(f.record().outbox.filter(entry => entry.event === 'workflow_started')).toHaveLength(2);
  });
  it('Stop/config/restart cancels queued analytics restart permission', async () => {
    const f = fixture(); await f.start();
    f.tracker.queueRestart(f.state, 'alerts', true); f.tracker.end();
    f.tracker.observe({ ...f.state, runId: 'run-id-0002' }, runId); await f.tracker.settled();
    expect(f.record().outbox.filter(entry => entry.event === 'workflow_started')).toHaveLength(1);
  });
});

describe('best-effort delivery and storage', () => {
  it('preserves event UUID and timestamp, honors durable backoff, and resumes on worker wake', async () => {
    const f = fixture(); await f.start(); const original = structuredClone(f.record().outbox[0]);
    f.fetchFn.mockRejectedValueOnce(new Error('offline'));
    await f.tracker.flush();
    expect(f.record().outbox[0]).toMatchObject({ uuid: original.uuid, timestamp: original.timestamp, attempts: 1 });
    const deadline = f.record().nextFlushAt!;
    await f.tracker.flush(); expect(f.fetchFn).toHaveBeenCalledTimes(1);
    const worker = createAnalyticsTracker(f.deps); worker.wake(); await worker.settled();
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
    f.setTime(deadline); await worker.flush();
    expect(f.record().outbox).toHaveLength(0);
    const first = JSON.parse(f.fetchFn.mock.calls[0][1].body as string);
    const retried = JSON.parse(f.fetchFn.mock.calls[1][1].body as string);
    expect(retried).toEqual(first);
  });
  it('serializes concurrent local writes without blocking them on a hung network', async () => {
    const f = fixture(); await f.start();
    let finish!: (response: Response) => void;
    f.fetchFn.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const flush = f.tracker.flush();
    await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(1));
    f.tracker.activated(f.state, 7); await f.tracker.settled();
    expect(f.record().session!.activated).toBe(true);
    await f.tracker.flush(); expect(f.fetchFn).toHaveBeenCalledTimes(1);
    finish(new Response('{}')); await flush;
    expect(f.fetchFn).toHaveBeenCalledTimes(3);
    expect(f.record().outbox).toHaveLength(0);
  });
  it('does nothing when disabled, including no installation storage', async () => {
    const f = fixture(false); await f.start(); f.tracker.wake(); await f.tracker.flush(); await f.tracker.settled();
    expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.area.get).not.toHaveBeenCalled(); expect(f.area.set).not.toHaveBeenCalled();
  });
  it('refuses corrupt saves instead of replacing identities or sending unknown data', async () => {
    const f = fixture(); f.values[ANALYTICS_KEY] = { distinctId: 'private-invalid-value' };
    await f.start(); f.tracker.wake(); await f.tracker.settled(); await f.tracker.flush();
    expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.area.set).not.toHaveBeenCalled();
  });
  it('swallows analytics-only storage failures, never generating another install identity', async () => {
    const f = fixture(); await f.start(); const distinctId = f.record().distinctId;
    f.area.get.mockRejectedValueOnce(new Error('storage unavailable'));
    f.tracker.activated(f.state, 7); await f.tracker.settled();
    expect(f.record().distinctId).toBe(distinctId); expect(f.record().session!.activated).toBe(false);
    f.area.set.mockRejectedValueOnce(new Error('write unavailable'));
    f.tracker.activated(f.state, 7); await f.tracker.settled();
    expect(f.record().session!.activated).toBe(false);
  });
  it('bounds queued events and drops permanently undeliverable events after ten attempts', async () => {
    const f = fixture();
    for (let i = 0; i < OUTBOX_MAX + 5; i++) f.tracker.start('alerts', true);
    await f.tracker.settled(); expect(f.record().outbox).toHaveLength(OUTBOX_MAX);
    expect(f.record().outbox[0].event).toBe('installation_seen');
    f.values[ANALYTICS_KEY] = { ...f.record(), outbox: [{ ...f.record().outbox[0], attempts: 9 }] };
    f.fetchFn.mockRejectedValue(new Error('offline')); await f.tracker.flush();
    expect(f.record().outbox).toHaveLength(0); expect(f.record().nextFlushAt).toBeNull();
  });
});
