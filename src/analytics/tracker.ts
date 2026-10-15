import type { AnalyticsConfig } from './config';
import { buildAlertsEstablished, buildInstallationSeen, buildWorkflowFailed, buildWorkflowStarted,
  type AnalyticsMode, type FailureReason, type QueuedAnalyticsEvent } from './events';
import { ANALYTICS_KEY, MAX_ATTEMPTS, appendEvent, validateAnalyticsRecord,
  type AnalyticsRecord, type StorageArea } from './store';
import { sendOneEvent, type FetchFn } from './transport';
import type { EngineState } from '../engine/workflow';

export const ANALYTICS_ALARM = 'analyticsFlush';
export type TrackerDeps = {
  area: StorageArea;
  config: AnalyticsConfig;
  fetchFn: FetchFn;
  nowIso: () => string;
  uuid: () => string;
  extensionVersion: string;
  scheduleFlush: (delayMs: number) => void | Promise<void>;
};

export function isProductPanelSender(senderUrl: unknown): boolean {
  try {
    const url = new URL(typeof senderUrl === 'string' ? senderUrl : '');
    // The embedded iframe is a developer fixture, not the detached product.
    return url.protocol === 'chrome-extension:' && url.pathname === '/panel.html' &&
      [...url.searchParams.keys()].every(key => key === 'detached') && !url.hash;
  } catch { return false; }
}

// All public commands return immediately. Storage has its OWN serial queue;
// network delivery runs outside both that queue and the engine operation lock.
// A hung/offline analytics endpoint cannot hold Start/Stop or a booking step.
export function createAnalyticsTracker(deps: TrackerDeps) {
  let writes: Promise<unknown> = Promise.resolve();
  let flushing = false;
  const version = /^[A-Za-z0-9._-]{1,32}$/.test(deps.extensionVersion) ? deps.extensionVersion : '0.1.0';
  const base = () => ({ eventUuid: deps.uuid(), timestamp: deps.nowIso(), extensionVersion: version });
  async function read(): Promise<AnalyticsRecord> {
    const value = (await deps.area.get([ANALYTICS_KEY]))[ANALYTICS_KEY];
    if (value !== undefined) return validateAnalyticsRecord(value);
    const distinctId = deps.uuid();
    const initial: AnalyticsRecord = { version: 1, distinctId, session: null, queued: null, outbox: [], nextFlushAt: null };
    appendEvent(initial, buildInstallationSeen({ ...base(), distinctId }));
    return initial;
  }
  function arm(record: AnalyticsRecord): void {
    if (!record.outbox.length || !record.nextFlushAt) return;
    try {
      void Promise.resolve(deps.scheduleFlush(Math.max(1000, Date.parse(record.nextFlushAt) - Date.parse(deps.nowIso())))).catch(() => undefined);
    } catch { /* Analytics only. */ }
  }
  function change<T>(fn: (record: AnalyticsRecord) => T): Promise<T | undefined> {
    if (!deps.config.enabled) return Promise.resolve(undefined);
    const result = writes.then(async () => {
      const record = await read();
      const result = fn(record);
      validateAnalyticsRecord(record);
      await deps.area.set({ [ANALYTICS_KEY]: record });
      arm(record);
      return result;
    });
    writes = result.catch(() => undefined);
    return result.catch(() => undefined);
  }
  function startIn(record: AnalyticsRecord, id: string, mode: AnalyticsMode, testMode: boolean, runId: string | null): void {
    record.session = { id, mode, testMode, runId, failed: false, activated: false, closed: false };
    record.queued = null;
    appendEvent(record, buildWorkflowStarted({ ...base(), distinctId: record.distinctId,
      analyticsSessionId: id, mode, testMode }));
  }
  function failIn(record: AnalyticsRecord, reason: FailureReason): void {
    const session = record.session;
    if (!session || session.closed || session.failed) return;
    session.failed = true;
    appendEvent(record, buildWorkflowFailed({ ...base(), distinctId: record.distinctId,
      analyticsSessionId: session.id, mode: session.mode, testMode: session.testMode, failureReason: reason }));
  }
  async function flush(): Promise<void> {
    if (!deps.config.enabled || flushing) return;
    flushing = true;
    try {
      for (let count = 0; count < 100; count++) {
        const event = await change<QueuedAnalyticsEvent | null>(record => {
          if (!record.outbox.length) { record.nextFlushAt = null; return null; }
          if (record.nextFlushAt && Date.parse(record.nextFlushAt) > Date.parse(deps.nowIso())) return null;
          // A durable fallback remains armed while the HTTP request is in flight.
          record.nextFlushAt = new Date(Date.parse(deps.nowIso()) + 60_000).toISOString();
          return structuredClone(record.outbox[0]);
        });
        if (!event) return;
        let accepted = false;
        try { await sendOneEvent({ event, config: deps.config, fetchFn: deps.fetchFn }); accepted = true; }
        catch { /* Keep the same UUID and original timestamp for retries. */ }
        await change(record => {
          const current = record.outbox.find(entry => entry.uuid === event.uuid);
          if (!current) return;
          if (accepted) record.outbox = record.outbox.filter(entry => entry.uuid !== event.uuid);
          else if (++current.attempts >= MAX_ATTEMPTS) record.outbox = record.outbox.filter(entry => entry.uuid !== event.uuid);
          const delay = accepted ? 0 : Math.min(60_000 * 2 ** Math.min(current.attempts - 1, 5), 30 * 60_000);
          record.nextFlushAt = record.outbox.length ? new Date(Date.parse(deps.nowIso()) + delay).toISOString() : null;
        });
        if (!accepted) return;
      }
    } catch { /* Best-effort only; never throws into the engine. */ }
    finally { flushing = false; }
  }
  return {
    wake(): void { void change(() => undefined).then(() => flush()); },
    flush,
    start(mode: AnalyticsMode, testMode: boolean): string | null {
      if (!deps.config.enabled) return null;
      try {
        const id = deps.uuid();
        void change(record => startIn(record, id, mode, testMode, null));
        return id;
      } catch { return null; }
    },
    link(id: string | null, state: EngineState): void {
      if (!id || state.owner !== 'product-panel-owner' || !state.runId) return;
      void change(record => {
        if (record.session?.id === id && !record.session.closed && record.session.mode === state.mode)
          record.session.runId = state.runId;
      });
    },
    startFailed(id: string | null): void {
      if (id) void change(record => { if (record.session?.id === id && record.session.runId === null) failIn(record, 'start-failed'); });
    },
    queueRestart(state: EngineState, mode: AnalyticsMode, testMode: boolean): void {
      if (state.runId) void change(record => { record.queued = { runId: state.runId!, mode, testMode }; });
    },
    observe(state: EngineState, previousRunId?: string | null): void {
      if (state.owner !== 'product-panel-owner' || !state.runId) return;
      void change(record => {
        // Only an explicitly queued product request can create a session when
        // recovery replaces the engine run ID. Ordinary retries retain it.
        if (record.queued && record.queued.runId === previousRunId && record.queued.runId !== state.runId && state.status === 'running' &&
            record.queued.mode === state.mode && !state.intent) {
          startIn(record, deps.uuid(), state.mode, record.queued.testMode, state.runId);
        }
        if (record.queued?.runId === state.runId && !state.queuedStart && !state.intent) record.queued = null;
        const session = record.session;
        if (!session || session.runId !== state.runId || session.mode !== state.mode) return;
        if (state.intent || state.manualAuthentication || state.verificationError) return;
        if (state.status === 'stopped' && (state.loginFailed || state.restartFailed || state.authenticationError))
          failIn(record, state.restartFailed ? 'setup-exhausted' : 'authentication-failed');
        else if (state.status === 'verifying' && state.stage !== 'done') failIn(record, 'workflow-blocked');
      });
    },
    activated(state: EngineState, rowCount: number): void {
      if (state.owner !== 'product-panel-owner' || state.mode !== 'alerts' || state.group?.kind !== 'unpaid' ||
          state.status !== 'running' || state.intent || rowCount !== 7) return;
      void change(record => {
        const session = record.session;
        if (!session || session.runId !== state.runId || session.mode !== 'alerts' || session.closed || session.failed || session.activated) return;
        session.activated = true;
        appendEvent(record, buildAlertsEstablished({ ...base(), distinctId: record.distinctId,
          analyticsSessionId: session.id, testMode: session.testMode }));
      });
    },
    end(): void {
      void change(record => { if (record.session) record.session.closed = true; record.queued = null; });
    },
    // Used only by synthetic tests to wait for local telemetry writes, not HTTP.
    settled: () => writes,
  };
}
