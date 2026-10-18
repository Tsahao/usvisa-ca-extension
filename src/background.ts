import { platform, type InjectionResult, type Tab } from './platform';
import { classifyRoute, SITE_ORIGIN, type RouteKind } from './domain/routes';
import { resolveGroup } from './domain/groups';
import { CONSULATES, earliestCandidate, validatePreferences } from './domain/dates';
import { parseDaysPayload } from './domain/availability';
import { normalizeSummaryRaw } from './domain/summary';
import { acceptNotification, monitorForScope, observeSummary, resetBaseline, validateMonitorState } from './domain/monitor';
import { mapHttpStatus, pollDelaySeconds } from './domain/timing';
import { isSameGroupUrl } from './domain/trust';
import { readAppointmentForm, readCurrentAppointment, readDashboardGroups, readSiteMaintenance, readSummaryRaw } from './adapter/reads';
import { fetchDaysJson } from './adapter/poll';
import { readPaidPage, type PaidPage } from './adapter/paid';
import { performPaidAction, type PaidAction } from './adapter/acts';
import { sameApplicants } from './domain/applicants';
import { appointmentApplicants, appointmentDate, appointmentDateRelaxed } from './domain/appointment';
import { runVerificationRead } from './engine/verification';
import { reviewLifecycle } from './engine/lifecycle';
import { panelSnapshot } from './engine/panel';
import { panelCommandError, type PanelReadStep } from './engine/start-errors';
import { panelFailureKind } from './engine/panel-errors';
import { preferencesError, type Preferences } from './ui/model';
import { validateEngineMessage } from './engine/messages';
import { applyPollResult, engineAlarmAt, planPollStep, recordCandidate, setStage } from './engine/poll';
import { ENGINE_KEY, loadEngineState, saveEngineState as persistEngineState } from './engine/storage';
import {
  bindGroup,
  emptyEngineState,
  parkForReview,
  parkForVerification,
  queueVerificationStart,
  recordIntent,
  reconcileStartup,
  setNextPoll,
  startRun,
  stopRun,
  VERIFICATION_CONFIG_CHANGED,
  VERIFICATION_ROSTER_CHANGED,
  VERIFICATION_UNREADABLE,
} from './engine/workflow';
import { runBookingStage } from './engine/executor';
import { beginAuthentication, deferAuthenticationForMaintenance, runAuthentication } from './engine/authentication';
import { policyKey } from './engine/lifecycle';
import { SESSION_AGE_MINUTES } from './domain/timing';
import { openPanelWindow } from './panel-window';
import { pinpointVisaTab } from './panel-tabs';
import { restartExhausted, retryRestart } from './engine/restart';
import { SETUP_FAILURE_COOLDOWN_AFTER } from './domain/timing';
import { buildTimeAnalyticsConfig } from './analytics/config';
import { ANALYTICS_ALARM, createAnalyticsTracker, isProductPanelSender, type TrackerDeps } from './analytics/tracker';
import { HISTORY_ALARM } from './domain/history';
import { createDateHistory } from './engine/history';
import { DIAGNOSTICS_ALARM, type DiagnosticCode, type DiagnosticDetail, type DiagnosticEvent } from './domain/diagnostics';
import { createEngineDiagnostics } from './engine/diagnostics';
import { problemContext } from './domain/problem-report';

const dateHistory = createDateHistory({
  area: { get: keys => platform.storage.local.get(keys), set: values => platform.storage.local.set(values) },
  now: () => new Date().toISOString(),
  schedule: async expiry => {
    if (expiry === null) await platform.alarms.clear(HISTORY_ALARM);
    else await platform.alarms.create(HISTORY_ALARM, { when: Date.parse(expiry) });
  },
});

// Bounded local developer diagnostics: separate storage key, own queue, own
// retention alarm. Recording is best effort and never enters the workflow
// queue, so it can neither block nor alter a booking/engine transition, and
// the log is never cleared by success, Stop/Start or worker suspension.
const engineDiagnostics = createEngineDiagnostics({
  area: { get: keys => platform.storage.local.get(keys), set: values => platform.storage.local.set(values) },
  now: () => new Date().toISOString(),
  extensionVersion: () => platform.runtime.getManifest?.().version,
  schedule: async expiry => {
    if (expiry === null) await platform.alarms.clear(DIAGNOSTICS_ALARM);
    else await platform.alarms.create(DIAGNOSTICS_ALARM, { when: Date.parse(expiry) });
  },
});

// Fixed-code recording helper for the engine loop: callers pass only
// allowlisted fields — never credentials, URLs, identifiers or page content.
function noteDiagnostic(code: DiagnosticCode, rest: Omit<DiagnosticEvent, 'code'> = {}): void {
  try { void engineDiagnostics.record({ code, ...rest }); } catch { /* Diagnostics never gate engine work. */ }
}

// Shared poll-loop retry transition: records the retry or the cooldown entry
// it crossed, then returns the counted state. Never rewrites fields.
function pollRetry(state: import('./engine/workflow').EngineState, detail?: DiagnosticDetail): import('./engine/workflow').EngineState {
  const next = applyPollResult(state, { outcome: 'retryable', now: new Date().toISOString(), random: Math.random });
  const entered = next.cooldownUntil !== null && next.cooldownUntil !== state.cooldownUntil;
  noteDiagnostic(entered ? 'poll-cooldown-entered' : 'poll-retry', { mode: state.mode, outcome: 'retryable', failures: next.consecutiveFailures, ...(detail === undefined ? {} : { detail }) });
  return next;
}

function notePollRecovered(state: import('./engine/workflow').EngineState, outcome: 'healthy' | 'not-modified' | 'empty'): void {
  if (state.consecutiveFailures > 0) noteDiagnostic('poll-recovered', { mode: state.mode, outcome, failures: 0 });
}

// An exception mid-cycle is recovered by the existing counted retry with a
// fresh reload; record the fixed recovery transition only.
function noteExceptionRecovery(state: import('./engine/workflow').EngineState): void {
  noteDiagnostic('engine-exception-recovered', { mode: state.mode, outcome: 'retryable', failures: state.consecutiveFailures });
}

// Tracked begin: records the fixed auth-started transition with the run
// purpose/mode only. A refused begin (context/status guard) changes nothing
// and records nothing.
function beginTrackedAuthentication(state: import('./engine/workflow').EngineState, purpose: 'start' | 'renew' | 'verify', now: string, random: () => number): import('./engine/workflow').EngineState {
  const next = beginAuthentication(state, purpose, now, random);
  if (next !== state && next.authentication) noteDiagnostic('auth-started', { purpose, mode: next.mode });
  return next;
}

function analyticsDeps(area: { get: (keys: string[]) => Promise<Record<string, unknown>>; set: (values: Record<string, unknown>) => Promise<void> }): TrackerDeps | null {
  try {
    const config = buildTimeAnalyticsConfig();
    if (!config.enabled) return null;
    const fetchFn = (globalThis as { fetch?: unknown }).fetch as TrackerDeps['fetchFn'] | undefined;
    if (typeof fetchFn !== 'function') return null;
    let version = '0.1.0';
    try {
      const manifest = (platform.runtime as unknown as { getManifest?: () => { version?: unknown } }).getManifest?.();
      if (typeof manifest?.version === 'string' && manifest.version.length > 0) version = manifest.version;
    } catch { /* Fallback version above. */ }
    return {
      area, config, fetchFn: (url, init) => globalThis.fetch(url, init),
      nowIso: () => new Date().toISOString(),
      uuid: () => crypto.randomUUID(),
      extensionVersion: version,
      scheduleFlush: (delayMs: number) => {
        platform.alarms.create(ANALYTICS_ALARM, { when: Date.now() + delayMs }).catch(() => undefined);
      },
    };
  } catch { return null; }
}

const analyticsConfig = analyticsDeps({
  get: keys => platform.storage.local.get(keys),
  set: values => platform.storage.local.set(values),
});
const analytics = analyticsConfig ? createAnalyticsTracker(analyticsConfig) : null;

// The workflow checkpoint must succeed independently. Analytics never holds
// the engine queue, awaits HTTP, or masks a failed safety checkpoint.
async function saveEngineState(area: import('./engine/storage').StorageArea, state: import('./engine/workflow').EngineState, previousRunId?: string | null): Promise<void> {
  await persistEngineState(area, state);
  analytics?.observe(state, previousRunId);
  // A completed submit reply also recovers a missed best-effort attempt write.
  if (state.intent?.phase === 'submitted' || state.intent?.phase === 'confirming') void dateHistory.attempted(state);
}

export type ProbeState = {
  version: 1;
  checkedAt: string;
  route: RouteKind;
  documentReachable: boolean;
  workerStarts: number;
};
const KEY = 'developmentProbe';
const cancelledRuns = new Set<string>();
let executingRun: { owner: string; runId: string } | null = null;
// Narrowly scoped Start cancellation: Stop and settings changes increment
// synchronously on receipt, so an explicit Start awaiting baseline/save/prefs
// reads can still observe it before any fixed sign-in navigation. No other
// Start/Stop/intent semantics change.
let explicitStartEpoch = 0;
const ALARM = 'developmentProbeWake';
const ENGINE_ALARM = 'enginePoll';
let fastWake: ReturnType<typeof setTimeout> | null = null;
// A maintenance reload awaiting its landing re-read (one-shot per reload).
let maintenanceReload: { runId: string; tabId: number } | null = null;
// If storage itself is unavailable, Chrome's durable alarm is the only place
// we can retain a retry. Do not let duplicate events busy-loop in this worker.
let storageRetryAt: string | null = null;

// Most recent toolbar-clicked reachable tab. Reads target it only after
// re-validating its live URL, so clicking the probe button (which focuses
// the probe tab) can never redirect a read at the wrong page.
let lastTrustedTab: { tabId: number } | null = null;

// Session storage survives worker suspension but is cleared on browser restart
// or extension reload. Establish this before processing any queued event.
const ready = Promise.all([
  platform.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  platform.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]).then(async () => {
  await initializeEngineSession();
  analytics?.wake();
  void dateHistory.prune();
  void engineDiagnostics.prune();
});
let operations = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  operations = operations.then(async () => { await ready; await task(); }).catch(() => {
    // Fixed diagnostic only: raw browser errors may contain private URLs.
    console.error('Background operation failed.');
  });
}

enqueue(async () => {
  const saved = (await platform.storage.local.get(KEY))[KEY] as ProbeState | undefined;
  if (saved) await platform.storage.local.set({ [KEY]: { ...saved, workerStarts: saved.workerStarts + 1 } });
});

// The alarm is a wake-up signal; durable state controls whether a cycle is due.
async function syncEngineAlarm(nextPollAt: string | null): Promise<void> {
  if (fastWake !== null) { clearTimeout(fastWake); fastWake = null; }
  try {
    if (nextPollAt === null) {
      storageRetryAt = null;
      await platform.alarms.clear(ENGINE_ALARM);
      return;
    }
    const when = Date.parse(nextPollAt);
    if (!Number.isFinite(when)) {
      await platform.alarms.clear(ENGINE_ALARM);
      return;
    }
    await platform.alarms.create(ENGINE_ALARM, { when: Math.max(when, Date.now()) });
    const remaining = Math.max(0, when - Date.now());
    if (remaining <= 5_000) fastWake = setTimeout(() => { fastWake = null; queueEnginePoll(); }, remaining);
  } catch {
    // Fixed diagnostic only.
    console.error('Engine alarm sync failed.');
  }
}

async function verifyFromDashboard(state: import('./engine/workflow').EngineState, freshContext = false) {
  // Check before resolving stale/missing custody: authentication replaces the
  // verification progress, so entering it early would erase the settling wait.
  if (state.verification?.nextReadAt && Date.parse(state.verification.nextReadAt) > Date.now()) return state;
  if (freshContext) state = { ...state, verificationTabId: null, verification: null };
  // Stale verifier recovery: a closed tab or a tab that left the dashboard
  // discards custody and starts fresh verify authentication instead of
  // parking forever on the stale id. A clean login/landing tab is reused as
  // the auth tab to avoid leaking duplicates; other routes release custody
  // without navigating an untrusted tab. Active good verifiers keep progress.
  if (state.verificationTabId !== null) {
    let live: { id?: number; url?: string } | null = null;
    try { live = await platform.tabs.get(state.verificationTabId); } catch { live = null; }
    if (!live) {
      const cleared = { ...state, verificationTabId: null, verification: null };
      return beginTrackedAuthentication(cleared, 'verify', new Date().toISOString(), Math.random);
    }
    if (classifyRoute(live.url ?? '') !== 'dashboard') {
      const cleanAuthRoute = (() => {
        try {
          const parsed = new URL(live.url ?? '');
          return parsed.origin === SITE_ORIGIN && !parsed.username && !parsed.password && !parsed.port &&
            !parsed.search && !parsed.hash &&
            (parsed.pathname === '/en-ca/niv/users/sign_in' || parsed.pathname === '/en-ca/niv' || parsed.pathname === '/en-ca/niv/');
        } catch { return false; }
      })();
      if (cleanAuthRoute && live.id !== undefined) {
        const cleared = { ...state, verificationTabId: null, verification: null };
        const auth = beginTrackedAuthentication(cleared, 'verify', new Date().toISOString(), Math.random);
        if (auth.authentication) return { ...auth, authentication: { ...auth.authentication, tabId: live.id } };
        return auth;
      }
      try {
        const parsed = new URL(live.url ?? '');
        if (parsed.origin === SITE_ORIGIN && live.id !== undefined) await platform.tabs.remove(live.id).catch(() => undefined);
      } catch { /* Non-URL tab; custody released without navigation. */ }
      const cleared = { ...state, verificationTabId: null, verification: null };
      return beginTrackedAuthentication(cleared, 'verify', new Date().toISOString(), Math.random);
    }
  }
  if (state.verificationTabId === null) return beginTrackedAuthentication(state, 'verify', new Date().toISOString(), Math.random);
  // Current prefs for the continuation guard. Missing/invalid prefs read as
  // null (blocks auto-continue, still allows original-group verification);
  // storage failure also reads as null and fails closed, never skipping.
  let currentPolicy: string | null = null;
  let currentInterval = 60;
  let currentPreferences: Preferences | undefined;
  try {
    const prefs = (await platform.storage.local.get(['uiPreferencesV1'])).uiPreferencesV1 as Preferences | undefined;
    if (prefs && !preferencesError(prefs)) {
      currentPolicy = policyKey(prefs as unknown as Record<string, unknown>);
      if (Number.isInteger(prefs.interval)) currentInterval = prefs.interval;
      currentPreferences = prefs;
    } else currentPolicy = null;
  } catch { currentPolicy = null; }
  const prevIntent = state.intent;
  const prevQueued = state.queuedStart;
  const group = state.group;
  const verifierTabId = state.verificationTabId;
  let verificationDenied = false;
  const readVerification = async (includeApplicants: boolean): Promise<unknown> => {
    if (!group) throw new Error('Missing verification identity.');
    const failedRead = () => ({ scheduleId: group.scheduleId, ivr: group.ivr, kind: 'read-failure', text: null, status: 0 });
    const trusted = (tab: Tab) => {
      if (!tab.url || tab.id !== verifierTabId) return false;
      const url = new URL(tab.url);
      return classifyRoute(tab.url) === 'dashboard' && !url.search && !url.hash &&
        (!group.dashboardPath || url.pathname === group.dashboardPath) &&
        (!tab.pendingUrl || tab.pendingUrl === 'about:blank' || tab.pendingUrl === tab.url);
    };
    const tab = await platform.tabs.get(verifierTabId!);
    if (!trusted(tab)) throw new Error('Verification context changed.');
    if (tab.status === 'loading' || (tab.pendingUrl && tab.pendingUrl !== 'about:blank')) return failedRead();
    let raw: unknown;
    try {
      const result = await platform.scripting.executeScript({ target: { tabId: tab.id! }, func: readCurrentAppointment,
        args: [group.scheduleId, group.ivr, true, includeApplicants, group.dashboardPath ?? new URL(tab.url!).pathname, true] });
      raw = result[0]?.result;
    } catch {
      const live = await platform.tabs.get(verifierTabId!);
      if (!trusted(live) || live.url !== tab.url) throw new Error('Verification context changed.');
      raw = failedRead();
    }
    const reading = raw as { kind?: unknown; status?: unknown; redirected?: unknown } | null;
    if (reading?.kind === 'read-failure' && (reading.redirected === true || reading.status === 401 || reading.status === 403)) verificationDenied = true;
    return raw;
  };
  const next = await runVerificationRead(state, { now: () => new Date().toISOString(),
    currentPolicyKey: currentPolicy,
    isCancelled: () => cancelledRuns.has(`${state.owner}:${state.runId}`),
    recordDiagnostic: event => { noteDiagnostic(event.code, event); },
    read: () => readVerification(false),
    readRoster: () => readVerification(true) });
  if (verificationDenied && next.intent && next.verification?.nextReadAt && !cancelledRuns.has(`${state.owner}:${state.runId}`)) {
    if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
    // A fresh verifier login is read/verification-only; the booking intent
    // remains intact and cannot authorize a second booking submission.
    return beginTrackedAuthentication({ ...next, verificationTabId: null, verification: null }, 'verify', new Date().toISOString(), Math.random);
  }
  // Verified success is explicit, never inferred from continuation status: a
  // stopped run with cleared intent AND no blocking diagnostic. Blocked known
  // failures (roster/config) also stop with cleared intent but carry a fixed
  // error and must never record success. Unknown/malformed readings preserve
  // intent, so they never reach this branch.
  const verifiedSuccess = prevIntent && !prevIntent.testMode && next.intent === null &&
    next.status === 'stopped' && next.verificationError === null;
  if (verifiedSuccess) {
    await platform.storage.local.set({ engineSuccessV1: { runId: state.runId, date: prevIntent!.targetDate } });
    void dateHistory.confirmed(state);
    analytics?.booked(state);
  }
  if (prevIntent && !prevIntent.testMode && prevQueued && next.intent === null) {
    const now = new Date().toISOString();
    // Cross-mode requests never bind an inconsistent paid/alerts state:
    // consume the request and keep the resolved original outcome.
    if (prevQueued.mode !== state.mode) {
      if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
      return { ...next, queuedStart: null, updatedAt: now };
    }
    // Blocked known failures already resolved with a fixed roster/config
    // reason: preserve that error, clear the queue, stay stopped and never
    // restart as success.
    if (next.status === 'stopped' && next.verificationError !== null) {
      if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
      return { ...next, queuedStart: null, updatedAt: now };
    }
    const policyOk = currentPolicy !== null && currentPolicy === prevQueued.policyKey &&
      prevQueued.owner === state.owner && prevQueued.runId === state.runId;
    // Resolve the current dashboard selection just as a fresh Start does.
    // A blank IVR can now select another first group; it must not silently
    // authorize continued booking for the saved group. The independent fresh
    // appointment read below revalidates its baseline and complete roster.
    let selectionOk = false;
    if (policyOk && currentPreferences && group && verifierTabId !== null) {
      try {
        const latest = (await platform.storage.local.get(['uiPreferencesV1'])).uiPreferencesV1;
        if (JSON.stringify(latest) !== JSON.stringify(currentPreferences)) throw new Error('Configuration changed.');
        const tab = await platform.tabs.get(verifierTabId);
        if (tab.id === undefined || classifyRoute(tab.url ?? '') !== 'dashboard' ||
            (group.dashboardPath && new URL(tab.url!).pathname !== group.dashboardPath)) throw new Error('Dashboard changed.');
        const snapshot = await platform.scripting.executeScript({ target: { tabId: tab.id }, func: readDashboardGroups });
        const selected = resolveGroup(snapshot[0]?.result, { mode: 'booking',
          paidIvr: currentPreferences.paidIvr, unpaidIvr: currentPreferences.unpaidIvr });
        selectionOk = selected.scheduleId === group.scheduleId && selected.ivr === group.ivr;
      } catch { selectionOk = false; }
    }
    if (next.status === 'stopped') {
      if (!policyOk || !selectionOk) {
        if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
        return { ...next, queuedStart: null, verificationError: VERIFICATION_CONFIG_CHANGED, updatedAt: now };
      }
      if (!group?.applicantIds) {
        if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
        return { ...next, queuedStart: null, verificationError: VERIFICATION_ROSTER_CHANGED, updatedAt: now };
      }
      // Fresh baseline/roster recheck before restarting after success: the
      // recheck date must still equal the classified target date and the
      // original roster must be unchanged. A date mismatch pauses with the
      // existing unreadable guidance; a roster mismatch pauses with the
      // existing roster guidance. The restart retains the original roster.
      let freshDateOk = false;
      let freshRosterOk = false;
      try {
        if (verifierTabId !== null) {
          const tab = await platform.tabs.get(verifierTabId).catch(() => null);
          if (tab?.id !== undefined && classifyRoute(tab.url ?? '') === 'dashboard' && group) {
            const fresh = await platform.scripting.executeScript({ target: { tabId: tab.id }, func: readCurrentAppointment,
              args: [group.scheduleId, group.ivr, true, true, group.dashboardPath ?? new URL(tab.url!).pathname] });
            const raw = fresh[0]?.result;
            freshDateOk = appointmentDateRelaxed(raw, group) === prevIntent.targetDate;
            if (freshDateOk) freshRosterOk = sameApplicants(appointmentApplicants(raw), group.applicantIds);
          }
        }
      } catch { freshDateOk = false; freshRosterOk = false; }
      if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
      if (!freshDateOk) return { ...next, queuedStart: null, verificationError: VERIFICATION_UNREADABLE, updatedAt: now };
      if (!freshRosterOk) return { ...next, queuedStart: null, verificationError: VERIFICATION_ROSTER_CHANGED, updatedAt: now };
      if (!group) return { ...next, queuedStart: null, verificationError: VERIFICATION_ROSTER_CHANGED, updatedAt: now };
      const runId = crypto.randomUUID();
      let restarted = startRun({ ...next, queuedStart: null }, { mode: prevQueued.mode, owner: prevQueued.owner, runId, now,
        nextPollAt: new Date(Date.parse(now) + 2_000).toISOString() });
      restarted = bindGroup(restarted, { owner: prevQueued.owner, runId, now,
        binding: { scheduleId: group.scheduleId, ivr: group.ivr, kind: prevQueued.mode === 'booking' ? 'paid' : 'unpaid',
          currentDate: prevIntent.targetDate, dashboardPath: group.dashboardPath,
          ...(group.applicantIds ? { applicantIds: group.applicantIds } : {}) } });
      restarted = { ...restarted, policyKey: currentPolicy as string, pollIntervalS: currentInterval,
        stage: 'actions', executor: null, queuedStart: null, verificationError: null };
      return restarted;
    }
    if (next.status === 'running') {
      if (!policyOk || !selectionOk) {
        if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
        return { ...next, status: 'stopped' as const, nextPollAt: null, queuedStart: null,
          verificationError: VERIFICATION_CONFIG_CHANGED, updatedAt: now };
      }
      if (!group?.applicantIds) {
        if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
        return { ...next, status: 'stopped' as const, nextPollAt: null, queuedStart: null,
          verificationError: VERIFICATION_ROSTER_CHANGED, updatedAt: now };
      }
      // Fresh baseline/roster recheck before continuing after a classified
      // failure: the recheck date must still equal the classified baseline
      // (previous date, or unbooked null) and the original roster must be
      // unchanged. A date mismatch pauses with the existing unreadable
      // guidance; a roster mismatch pauses with the existing roster guidance.
      // The restart retains the original roster, never the fresh reading.
      const baseline = next.group?.currentDate ?? null;
      let freshDateOk = false;
      let freshRosterOk = false;
      try {
        if (verifierTabId !== null) {
          const tab = await platform.tabs.get(verifierTabId).catch(() => null);
          if (tab?.id !== undefined && classifyRoute(tab.url ?? '') === 'dashboard' && group) {
            const fresh = await platform.scripting.executeScript({ target: { tabId: tab.id }, func: readCurrentAppointment,
              args: [group.scheduleId, group.ivr, true, true, group.dashboardPath ?? new URL(tab.url!).pathname] });
            const raw = fresh[0]?.result;
            freshDateOk = appointmentDateRelaxed(raw, group) === baseline;
            if (freshDateOk) freshRosterOk = sameApplicants(appointmentApplicants(raw), group.applicantIds);
          }
        }
      } catch { freshDateOk = false; freshRosterOk = false; }
      if (verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
      if (!freshDateOk) return { ...next, status: 'stopped' as const, nextPollAt: null, queuedStart: null,
        verificationError: VERIFICATION_UNREADABLE, updatedAt: now };
      if (!freshRosterOk) return { ...next, status: 'stopped' as const, nextPollAt: null, queuedStart: null,
        verificationError: VERIFICATION_ROSTER_CHANGED, updatedAt: now };
      if (!group) return { ...next, status: 'stopped' as const, nextPollAt: null, queuedStart: null,
        verificationError: VERIFICATION_ROSTER_CHANGED, updatedAt: now };
      const runId = crypto.randomUUID();
      let restarted = startRun({ ...next, status: 'stopped' as const, intent: null }, { mode: prevQueued.mode, owner: prevQueued.owner, runId, now,
        nextPollAt: new Date(Date.parse(now) + 2_000).toISOString() });
      restarted = bindGroup(restarted, { owner: prevQueued.owner, runId, now,
        binding: { scheduleId: group.scheduleId, ivr: group.ivr, kind: prevQueued.mode === 'booking' ? 'paid' : 'unpaid',
          currentDate: baseline, dashboardPath: group.dashboardPath,
          ...(group.applicantIds ? { applicantIds: group.applicantIds } : {}) } });
      restarted = { ...restarted, policyKey: currentPolicy as string, pollIntervalS: currentInterval,
        stage: null, executor: null, queuedStart: null, verificationError: null };
      return restarted;
    }
    return { ...next, queuedStart: null, updatedAt: now };
  }
  if (state.intent && next.intent === null && verifierTabId !== null) await closeOwnedDashboard(verifierTabId);
  return next;
}

async function closeOwnedDashboard(tabId: number): Promise<void> {
  try {
    const tab = await platform.tabs.get(tabId);
    if (classifyRoute(tab.url ?? '') === 'dashboard') await platform.tabs.remove(tabId);
  } catch { return; }
}

async function dashboardTab() {
  const tabs = (await platform.tabs.query({})).filter(tab => classifyRoute(tab.url ?? '') === 'dashboard');
  if (tabs.length > 1) throw new Error('Open one trusted dashboard.');
  if (tabs.length !== 1 || tabs[0].id === undefined) throw new Error('Dashboard unavailable.');
  return tabs[0];
}

// Strictly validates a fresh-baseline denied/redirect signal for explicit paid
// Start/Retry recovery. Only a plain read-failure with matching IDs, null
// text, no roster, integer status and a consistent redirect flag qualifies: an
// expired-session redirect is status 0 with redirected:true, while 401/403
// authorizes with redirected absent or explicitly false. Contradictory
// flag/status/text/roster, malformed fields, ordinary 502/network (status 0
// without redirect) and valid booked/unbooked readings never qualify here.
function isFreshBaselineAuthDenied(raw: unknown, expected: { scheduleId: string; ivr: string }): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const reading = raw as Record<string, unknown>;
  if (reading.scheduleId !== expected.scheduleId || reading.ivr !== expected.ivr) return false;
  if (reading.kind !== 'read-failure') return false;
  if (reading.text !== null) return false;
  if ('applicantIds' in reading) return false;
  if (typeof reading.status !== 'number' || !Number.isInteger(reading.status) ||
      (reading.status as number) < 0 || (reading.status as number) > 599) return false;
  const redirected = (reading as { redirected?: unknown }).redirected;
  if (redirected !== undefined && typeof redirected !== 'boolean') return false;
  if (redirected === true) return reading.status === 0;
  return reading.status === 401 || reading.status === 403;
}

// Exact trusted-dashboard URL for post-read recovery: origin, authority and
// pathname must match with no query/fragment. classifyRoute alone ignores
// query/fragment, so it cannot authorize navigation here.
function isExactDashboardUrl(value: unknown, dashboardPath: string): boolean {
  if (typeof value !== 'string' || value === '') return false;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.origin !== SITE_ORIGIN || parsed.username || parsed.password || parsed.port) return false;
  if (parsed.search || parsed.hash) return false;
  if (parsed.pathname !== dashboardPath) return false;
  return classifyRoute(value) === 'dashboard';
}

async function prepareAlertScope(area: import('./engine/storage').StorageArea, state: import('./engine/workflow').EngineState): Promise<void> {
  if (state.mode !== 'alerts' || !state.group || state.intent) throw new Error('Invalid alert scope.');
  const prefs = (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as Preferences | undefined;
  if (!prefs || preferencesError(prefs) || policyKey(prefs as unknown as Record<string, unknown>) !== state.policyKey)
    throw new Error('Configuration changed.');
  const scopeKey = `alerts:${state.group.scheduleId}:${prefs.consulate}:any:${prefs.earliest}:${prefs.latest}`;
  const saved = (await area.get(['unpaidMonitorV1'])).unpaidMonitorV1;
  const monitor = monitorForScope(saved, scopeKey, true);
  await area.set({ unpaidMonitorV1: { scopeKey, monitor } });
}

async function attemptRestart(area: import('./engine/storage').StorageArea, state: import('./engine/workflow').EngineState) {
  const now = new Date().toISOString();
  const cancelled = () => cancelledRuns.has(`${state.owner}:${state.runId}`);
  const prefs = (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as Preferences | undefined;
  if (cancelled() || !prefs || preferencesError(prefs) || state.policyKey !== policyKey(prefs as unknown as Record<string, unknown>))
    return parkForReview(state, now);
  const unchanged = async () => !cancelled() && JSON.stringify((await area.get(['uiPreferencesV1'])).uiPreferencesV1) === JSON.stringify(prefs);
  const dashboards = (await platform.tabs.query({})).filter(tab => classifyRoute(tab.url ?? '') === 'dashboard');
  if (dashboards.length === 0) {
    let next = beginTrackedAuthentication(state, 'start', now, Math.random);
    const entry = await startEntryTab();
    if (!await unchanged()) return parkForReview(state, now);
    if (entry !== null && next.authentication) {
      const live = await platform.tabs.get(entry);
      const parsed = new URL(live.url ?? '');
      const blank = live.url === 'about:blank' || live.url?.startsWith('chrome://newtab');
      if (!blank && (parsed.origin !== SITE_ORIGIN || parsed.username || parsed.password || parsed.port)) return parkForReview(state, now);
      next = { ...next, authentication: { ...next.authentication, tabId: entry, pending: true } };
      await saveEngineState(area, next);
      if (!await unchanged() || (await platform.tabs.get(entry)).url !== live.url) return parkForReview(state, now);
      if (!['/en-ca/niv', '/en-ca/niv/', '/en-ca/niv/users/sign_in'].includes(parsed.pathname))
        await platform.tabs.update(entry, { url: `${SITE_ORIGIN}/en-ca/niv/` });
      next = { ...next, authentication: { ...next.authentication!, pending: false }, nextPollAt: new Date(Date.now() + 2_000).toISOString() };
    }
    return next;
  }
  if (dashboards.length !== 1 || dashboards[0].id === undefined) throw new Error('Dashboard unavailable.');
  const tab = dashboards[0];
  const dashboardPath = new URL(tab.url!).pathname;
  const result = await platform.scripting.executeScript({ target: { tabId: tab.id! }, func: readDashboardGroups });
  const match = resolveGroup(result[0]?.result as never, { mode: state.mode, paidIvr: prefs.paidIvr, unpaidIvr: prefs.unpaidIvr });
  let currentDate: string | null = null;
  let applicantIds: string[] | undefined;
  if (state.mode === 'booking') {
    const baseline = await platform.scripting.executeScript({ target: { tabId: tab.id! }, func: readCurrentAppointment,
      args: [match.scheduleId, match.ivr, true, true, dashboardPath] });
    currentDate = appointmentDate(baseline[0]?.result, match);
    applicantIds = appointmentApplicants(baseline[0]?.result);
  }
  const live = await platform.tabs.get(tab.id!);
  if (live.url !== tab.url || live.status === 'loading' || !await unchanged()) return parkForReview(state, now);
  let next = bindGroup(state, { owner: state.owner!, runId: state.runId!, now,
    binding: { ...match, kind: state.mode === 'booking' ? 'paid' : 'unpaid', currentDate, dashboardPath, ...(applicantIds ? { applicantIds } : {}) } });
  next = { ...next, restartPending: false, consecutiveFailures: 0, cooldownUntil: null, startedAt: now,
    nextPollAt: new Date(Date.now() + 2_000).toISOString(), updatedAt: now };
  if (state.mode === 'booking') return { ...next, stage: 'actions',
    executor: { tabId: tab.id!, applicantIds: applicantIds!, targetTime: null, skippedDates: [], actionPending: false } };
  await prepareAlertScope(area, next);
  const payments = (await platform.tabs.query({})).filter(entry => entry.id !== undefined && classifyRoute(entry.url ?? '') === 'payment' && isSameGroupUrl(entry.url!, match.scheduleId));
  next = { ...next, monitorTabId: payments[0]?.id ?? tab.id! };
  await saveEngineState(area, next);
  if (!payments.length) {
    const current = await platform.tabs.get(tab.id!);
    if (current.url !== tab.url || !await unchanged()) return parkForReview(next, now);
    await platform.tabs.update(tab.id!, { url: `${SITE_ORIGIN}/en-ca/niv/schedule/${match.scheduleId}/payment` });
  }
  return next;
}

async function preferredVisaTabId(): Promise<number | null> {
  const saved = (await platform.storage.session.get('lastTrustedVisaTabV1')).lastTrustedVisaTabV1;
  return lastTrustedTab?.tabId ?? (typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 0 ? saved : null);
}

// Start entry without an open dashboard, shared by both modes: prefer the
// user's current same-origin visa-site tab (any flow page, including generic
// pages like /account that can serve a maintenance document), then the
// toolbar-selected site tab (the panel can live in its own tab, leaving the
// panel itself focused), then a sole visa-site tab, then a blank current tab.
// Returns the tab to navigate to the site root for identity resolution, or
// null to fall back to a fresh login tab. Never selects an unrelated tab; a
// stale toolbar selection is revalidated live. Entry only runs when no
// workflow is live, so no owned tab is ever taken.
async function startEntryTab(): Promise<number | null> {
  const tabs = await platform.tabs.query({});
  const focused = await platform.tabs.query({ active: true, lastFocusedWindow: true });
  const active = focused[0] ?? tabs.find(tab => tab.active);
  const isEntry = (tab: { url?: string } | undefined) =>
    tab?.url !== undefined && ['appointment', 'payment', 'landing', 'login', 'actions'].includes(classifyRoute(tab.url));
  const isSiteTab = (tab: { url?: string } | undefined) => {
    if (tab?.url === undefined) return false;
    try {
      const url = new URL(tab.url);
      return url.origin === SITE_ORIGIN && !url.username && !url.password && !url.port;
    } catch { return false; }
  };
  if (active?.id !== undefined && isEntry(active)) return active.id;
  if (active?.id !== undefined && isSiteTab(active)) return active.id;
  const preferred = await preferredVisaTabId();
  if (preferred !== null) {
    try {
      const trusted = await platform.tabs.get(preferred);
      if (trusted.id !== undefined && (isEntry(trusted) || isSiteTab(trusted))) return trusted.id;
    } catch { /* Closed since selection; fall through to heuristics. */ }
  }
  const entries = tabs.filter(tab => tab.id !== undefined && isEntry(tab));
  if (entries.length === 1) return entries[0].id!;
  const sites = tabs.filter(tab => tab.id !== undefined && isSiteTab(tab));
  if (sites.length === 1) return sites[0].id!;
  const activeUrl = typeof active?.url === 'string' ? active.url : '';
  if (active?.id !== undefined && (activeUrl === '' || activeUrl === 'about:blank' || activeUrl.startsWith('chrome://newtab'))) return active.id;
  return null;
}

function executionDependencies(area: { get: (keys: string[]) => Promise<Record<string, unknown>>; set: (values: Record<string, unknown>) => Promise<void> }, state: import('./engine/workflow').EngineState) {
  return {
    nowIso: () => new Date().toISOString(), random: Math.random,
    queryTabs: () => platform.tabs.query({}), getTab: (tabId: number) => platform.tabs.get(tabId),
    createTab: (url: string) => platform.tabs.create({ url }),
    inject: (tabId: number, func: (...args: never[]) => unknown, args?: unknown[]) => platform.scripting
      .executeScript({ target: { tabId }, func: func as never, args: args as never[],
        ...(func === performPaidAction && ['date', 'facility'].includes((args?.[0] as PaidAction | undefined)?.action ?? '') ? { world: 'MAIN' as const } : {}),
      }).then(results => results[0]?.result),
    // Browser-side navigation for stalled-load recovery: fixed approved
    // targets only, never DOM injection into a loading tab.
    navigateTab: (tabId: number, url: string) => platform.tabs.update(tabId, { url }).then(() => undefined),
    loadPrefs: async () => (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as Record<string, unknown> | undefined,
    saveState: (checkpoint: import('./engine/workflow').EngineState) => saveEngineState(area, checkpoint),
    onBookingAttempt: (checkpoint: import('./engine/workflow').EngineState) => { void dateHistory.attempted(checkpoint); },
    recordDiagnostic: (event: DiagnosticEvent) => { noteDiagnostic(event.code, event); },
    isCancelled: () => cancelledRuns.has(`${state.owner}:${state.runId}`),
  };
}

// Recreate the alarm after worker suspension without shortening backoff or
// cooldowns. A fresh browser session surfaces existing work for review.
async function initializeEngineSession(): Promise<void> {
  const session = await platform.storage.session.get('engineSessionV1');
  if (session.engineSessionV1 !== true) analytics?.end();
  const area = {
    get: (keys: string[]) => platform.storage.local.get(keys),
    set: (values: Record<string, unknown>) => platform.storage.local.set(values),
  };
  const state = await loadEngineState(area);
  if (!state) {
    await platform.storage.session.set({ engineSessionV1: true });
    return;
  }
  const now = new Date().toISOString();
  const reconciled = reconcileStartup(state, now, session.engineSessionV1 !== true);
  // An interrupted pending submit may already have clicked before suspension.
  // Preserve that uncertainty in history; it never authorizes another action.
  if (state.executor?.actionPending && state.intent) void dateHistory.attempted(state);
  let next = reconciled;
  if (
    reconciled.status === 'running' &&
    (reconciled.group || reconciled.authentication) &&
    engineAlarmAt(reconciled) === null &&
    typeof reconciled.owner === 'string' &&
    typeof reconciled.runId === 'string'
  ) {
    next = setNextPoll(reconciled, {
      owner: reconciled.owner,
      runId: reconciled.runId,
      nextPollAt: new Date(Date.now() + 60_000).toISOString(),
      now,
    });
  }
  if (next !== state) await persistEngineState(area, next);
  await syncEngineAlarm(engineAlarmAt(next));
  // Mark the session only after reconciliation is durably committed. A
  // failed write blocks queued work and is retried on the next worker wake.
  await platform.storage.session.set({ engineSessionV1: true });
}

platform.action.onClicked.addListener(tab => enqueue(async () => {
  const route = classifyRoute(tab.url ?? '');
  let documentReachable = false;
  const isSiteTab = (() => {
    try {
      const url = new URL(tab.url ?? '');
      return url.origin === SITE_ORIGIN && !url.username && !url.password && !url.port;
    } catch { return false; }
  })();
  if (tab.id !== undefined && isSiteTab) {
    try {
      const results = await platform.scripting.executeScript({
        target: { tabId: tab.id },
        // Deliberately reads no form values, cookies, account identifiers, or HTML.
        func: () => document.readyState === 'interactive' || document.readyState === 'complete',
      });
      documentReachable = results[0]?.result === true;
    } catch { /* The page may have closed or navigated; do not inspect another tab. */ }
  }
  const previous = (await platform.storage.local.get(KEY))[KEY] as ProbeState | undefined;
  await platform.storage.local.set({ [KEY]: {
    version: 1, checkedAt: new Date().toISOString(), route, documentReachable,
    workerStarts: previous?.workerStarts ?? 1,
  } satisfies ProbeState });
  if (documentReachable && tab.id !== undefined) {
    lastTrustedTab = { tabId: tab.id };
    await platform.storage.session.set({ lastTrustedVisaTabV1: tab.id });
  }
  await openPanelWindow();
}));

platform.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== platform.runtime.id) return;
  if (typeof message?.type === 'string' && message.type.startsWith('PANEL_')) {
    if (!sender.url?.startsWith(platform.runtime.getURL('')) || new URL(sender.url).pathname !== '/panel.html') return;
    if (message.type === 'PANEL_HISTORY') {
      // Read-only and independent of a slow portal action in the engine queue.
      void ready.then(() => dateHistory.read()).then(rows => respond({ ok: true, rows }))
        .catch(() => respond({ ok: false, error: 'Unable to read date history. Reopen View Logs to try again.' }));
      return true;
    }
    if (message.type === 'PANEL_FOCUS_TAB') {
      enqueue(async () => {
        try {
          const area = { get: (keys: string[]) => platform.storage.local.get(keys), set: (values: Record<string, unknown>) => platform.storage.local.set(values) };
          await pinpointVisaTab(await loadEngineState(area), await preferredVisaTabId());
          respond({ ok: true });
        } catch (error) {
          const known = ['Several matching Visa tabs are open. Click the extension icon on the tab you want to view, then try again.', 'The Visa tab changed. Try again.'];
          respond({ ok: false, error: error instanceof Error && known.includes(error.message) ? error.message : 'Unable to show the Visa tab. Try again.' });
        }
      });
      return true;
    }
    if (!['PANEL_STATE', 'PANEL_START', 'PANEL_STOP'].includes(message.type)) return;
    if (message.type === 'PANEL_STOP') analytics?.end();
    if (message.type === 'PANEL_STOP') explicitStartEpoch += 1;
    if (message.type === 'PANEL_STOP' && executingRun) cancelledRuns.add(`${executingRun.owner}:${executingRun.runId}`);
    const requestEpoch = explicitStartEpoch;
    enqueue(async () => {
      const area = { get: (keys: string[]) => platform.storage.local.get(keys), set: (values: Record<string, unknown>) => platform.storage.local.set(values) };
      const requestCancelled = () => requestEpoch !== explicitStartEpoch;
      let readStep: PanelReadStep = 'state';
      let analyticsStart: string | null = null;
      try {
        const now = new Date().toISOString();
        let state = (await loadEngineState(area)) ?? emptyEngineState(now);
        if (message.type === 'PANEL_STOP' && state.owner && state.runId) {
          analytics?.end();
          state = stopRun(state, { owner: state.owner, runId: state.runId, now });
          readStep = 'save';
          await saveEngineState(area, state);
        }
        if (message.type === 'PANEL_START') {
          if (message.mode !== 'booking' && message.mode !== 'alerts') throw new Error('Invalid workflow.');
          if (state.intent && state.status !== 'running') {
            const verifyingRunId = state.runId;
            // Explicit Start during unresolved intent records durable permission
            // to restart AFTER verification, whether the attempt succeeds or
            // fails. Never discard unknown intent. Repeated Starts while
            // verification or authentication is active are idempotent: they
            // never reset tab, progress or deadlines. A stopped save with
            // intent normalizes to verifying first so queueing applies.
            if (state.status !== 'verifying') state = { ...state, status: 'verifying' as const, nextPollAt: null, updatedAt: now };
            readStep = 'appointment';
            const prefsForQueue = (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as Record<string, unknown> | undefined;
            let queueKey: string | null = null;
            try { queueKey = prefsForQueue ? policyKey(prefsForQueue) : null; } catch { queueKey = null; }
            if (state.owner && state.runId) {
              const queued = queueVerificationStart(state, { owner: state.owner, runId: state.runId,
                mode: message.mode, policyKey: queueKey, now });
              if (queued !== state) state = queued;
              if (isProductPanelSender(sender.url) && prefsForQueue && !preferencesError(prefsForQueue as unknown as Preferences))
                analytics?.queueRestart(state, message.mode, prefsForQueue.testMode === true);
            }
            const active = state.authentication !== null || (state.verification?.nextReadAt !== null && state.verification?.nextReadAt !== undefined);
            if (!active) {
              // Parked verification (no active check or login): resume it
              // automatically without dropping the separate tab when present.
              // Never replay an interrupted click; the 30s post-attempt delay
              // and three paced reads are preserved by the verification flow.
              state = await verifyFromDashboard(state, false);
            }
            readStep = 'save';
            await saveEngineState(area, state, verifyingRunId);
          } else if (state.status !== 'running') {
            if (state.status === 'verifying') state = { ...state, status: 'stopped' as const, authentication: null, verification: null, nextPollAt: null };
            const prefs = (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as Preferences | undefined;
            if (!prefs || preferencesError(prefs)) throw new Error('Save valid configurations before starting.');
            if (!state.intent && isProductPanelSender(sender.url)) analyticsStart = analytics?.start(message.mode, prefs.testMode) ?? null;
            const success = (await area.get(['engineSuccessV1'])).engineSuccessV1;
            if (!state.intent && (state.restartFailed || message.restart === true || panelSnapshot(state, undefined, success).status === 'success')) {
              state = { ...reviewLifecycle(startRun(state, { mode: message.mode, owner: 'product-panel-owner', runId: crypto.randomUUID(), now,
                nextPollAt: now }), prefs as unknown as Record<string, unknown>, now), restartPending: true };
              await saveEngineState(area, state);
              analytics?.link(analyticsStart, state);
              await syncEngineAlarm(engineAlarmAt(state));
              respond({ ok: true, snapshot: panelSnapshot(state, undefined, success) });
              return;
            }
            readStep = 'dashboard';
            const dashboards = (await platform.tabs.query({})).filter(tab => classifyRoute(tab.url ?? '') === 'dashboard');
            if (dashboards.length === 0) {
              state = reviewLifecycle(startRun(state, { mode: message.mode, owner: 'product-panel-owner', runId: crypto.randomUUID(), now }), prefs as unknown as Record<string, unknown>, now);
              state = beginTrackedAuthentication(state, 'start', now, Math.random);
              if (state.authentication && state.status === 'running') {
                // Dashboard-first reuse: whichever flow page the user is on
                // goes to the fixed site root first, which redirects to the
                // account dashboard when the profile cookie is still signed
                // in, then into the selected workflow in the same tab. A
                // signed-out clean landing advances promptly to sign-in via
                // the checkpointed browser navigation (no manual click).
                // Unrelated tabs are never hijacked; authentication falls
                // back to a fresh root tab.
                const entry = await startEntryTab();
                if (entry !== null) {
                  try {
                    // The bare dashboard route 403s; the site root is the
                    // session-reusing entry (dashboard when signed in,
                    // welcome landing when signed out). Skip the navigation
                    // when already at the root (its redirect/auto-advance
                    // still resolves) or login (preserved for sign-in).
                    const live = await platform.tabs.get(entry).catch(() => null);
                    let path = '';
                    try { path = new URL(live?.url ?? '').pathname; } catch { path = ''; }
                    if (path !== '/en-ca/niv' && path !== '/en-ca/niv/' && path !== '/en-ca/niv/users/sign_in')
                      await platform.tabs.update(entry, { url: 'https://ais.usvisa-info.com/en-ca/niv/' });
                    state = { ...state, authentication: { ...state.authentication, tabId: entry },
                      nextPollAt: new Date(Date.parse(now) + 2_000).toISOString(), updatedAt: new Date().toISOString() };
                  } catch { state = parkForReview(state, now); }
                }
              }
              readStep = 'save';
              await saveEngineState(area, state);
            } else {
              const tab = await dashboardTab();
              const dashboardPath = new URL(tab.url!).pathname;
              readStep = 'groups';
              const results = await platform.scripting.executeScript({ target: { tabId: tab.id! }, func: readDashboardGroups });
              // Maintenance cannot establish a group. Keep Start active and
              // retry this owned dashboard before resolving any identities.
              const discovered = (results[0]?.result as { groups?: unknown } | undefined)?.groups;
              let maintenance = false;
              if (Array.isArray(discovered) && discovered.length === 0) {
                try {
                  const check = await platform.scripting.executeScript({ target: { tabId: tab.id! }, func: readSiteMaintenance });
                  maintenance = (check[0]?.result as { maintenance?: unknown } | undefined)?.maintenance === true;
                } catch { /* An unreadable document still fails normal group resolution. */ }
              }
              if (maintenance) {
                state = reviewLifecycle(startRun(state, { mode: message.mode, owner: 'product-panel-owner', runId: crypto.randomUUID(), now }), prefs as unknown as Record<string, unknown>, now);
                state = beginTrackedAuthentication(state, 'start', now, Math.random);
                state = { ...state, authentication: { ...state.authentication!, tabId: tab.id! } };
                state = deferAuthenticationForMaintenance(state, now, Math.random);
                readStep = 'save';
                await saveEngineState(area, state);
              } else {
                readStep = 'selection';
                const match = resolveGroup(results[0]?.result as never, { mode: message.mode, paidIvr: prefs.paidIvr, unpaidIvr: prefs.unpaidIvr });
                let currentDate: string | null = null;
                let applicantIds: string[] | undefined;
                if (message.mode === 'booking') {
                  readStep = 'appointment';
                  const appt = await platform.scripting.executeScript({ target: { tabId: tab.id! }, func: readCurrentAppointment, args: [match.scheduleId, match.ivr, true, true, dashboardPath, true] });
                  const raw = appt[0]?.result;
                  // Stale signed-in-looking dashboard with an expired session:
                  // the cached DOM still resolves a group, but the bounded
                  // fresh baseline GET was denied/redirected. Never use cached
                  // data for binding; start auth-only and navigate the exact
                  // validated tab to the fixed official sign-in page. Ordinary
                  // transport failures and invalid readings stay generic.
                  // No intent reaches here: the gate above routes it
                  // verification-only without any baseline read or new auth.
                  if (isFreshBaselineAuthDenied(raw, match)) {
                    if (requestCancelled()) throw new Error('Dashboard context changed.');
                    const FIXED_SIGN_IN = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
                    const prefsSnapshot = JSON.stringify(prefs);
                    const savedTabUrl = tab.url;
                    state = reviewLifecycle(startRun(state, { mode: message.mode, owner: 'product-panel-owner', runId: crypto.randomUUID(), now }), prefs as unknown as Record<string, unknown>, now);
                    state = beginTrackedAuthentication(state, 'start', now, Math.random);
                    if (!state.authentication) throw new Error('Dashboard read failed.');
                    if (requestCancelled()) throw new Error('Dashboard context changed.');
                    // Durable checkpoint before any navigation: pending=true
                    // commits first and clears only after the fixed GET. An
                    // interrupted checkpoint parks on worker wake via the
                    // existing reconciliation; never a replacement tab and
                    // never an arbitrary URL.
                    const pendingState = { ...state, authentication: { ...state.authentication, tabId: tab.id!, pending: true }, updatedAt: new Date().toISOString() };
                    await saveEngineState(area, pendingState);
                    const parkPending = async () => {
                      const parked = parkForReview(pendingState, new Date().toISOString());
                      await saveEngineState(area, parked);
                      analytics?.link(analyticsStart, parked);
                      analytics?.observe(parked);
                      if (message.type !== 'PANEL_STATE') await syncEngineAlarm(engineAlarmAt(parked));
                      const saved = await area.get(['engineObservationV1', 'engineSuccessV1']);
                      respond({ ok: true, snapshot: panelSnapshot(parked, saved.engineObservationV1, saved.engineSuccessV1) });
                    };
                    try {
                      if (requestCancelled()) throw new Error('Dashboard context changed.');
                      await platform.tabs.get(tab.id!);
                      if (requestCancelled()) throw new Error('Dashboard context changed.');
                      const freshPrefs = (await area.get(['uiPreferencesV1'])).uiPreferencesV1;
                      if (requestCancelled() || JSON.stringify(freshPrefs) !== prefsSnapshot) throw new Error('Dashboard context changed.');
                      // Fresh snapshot after the storage wait: never trust the
                      // earlier live object. Exact clean dashboard URL, stable
                      // entire saved URL, complete (non-loading) tab and quiet
                      // (no pending navigation, including about:blank).
                      const live = await platform.tabs.get(tab.id!);
                      if (requestCancelled()) throw new Error('Dashboard context changed.');
                      const pendingUrl = (live as { pendingUrl?: unknown }).pendingUrl;
                      const pendingQuiet = pendingUrl === undefined || pendingUrl === '';
                      if (!isExactDashboardUrl(live.url, dashboardPath) || live.url !== savedTabUrl) throw new Error('Dashboard context changed.');
                      if ((live as { status?: unknown }).status === 'loading' || !pendingQuiet) throw new Error('Dashboard context changed.');
                      await platform.tabs.update(tab.id!, { url: FIXED_SIGN_IN });
                    } catch {
                      await parkPending();
                      return;
                    }
                    if (requestCancelled()) {
                      await parkPending();
                      return;
                    }
                    state = { ...pendingState, authentication: { ...pendingState.authentication, pending: false },
                      nextPollAt: new Date(Date.now() + 2_000).toISOString(), updatedAt: new Date().toISOString() };
                    readStep = 'save';
                    await saveEngineState(area, state);
                    analytics?.link(analyticsStart, state);
                    analytics?.observe(state);
                    if (message.type !== 'PANEL_STATE') await syncEngineAlarm(engineAlarmAt(state));
                    const savedAuth = await area.get(['engineObservationV1', 'engineSuccessV1']);
                    respond({ ok: true, snapshot: panelSnapshot(state, savedAuth.engineObservationV1, savedAuth.engineSuccessV1) });
                    return;
                  }
                  currentDate = appointmentDate(raw, match);
                  readStep = 'applicants';
                  applicantIds = appointmentApplicants(raw);
                }
                state = startRun(state, { mode: message.mode, owner: 'product-panel-owner', runId: crypto.randomUUID(), now,
                  // First read is fast for both modes: an already-open page is
                  // read almost immediately, and a fresh payment landing pulls
                  // the deadline forward on tab completion (see onUpdated below).
                  nextPollAt: new Date(Date.parse(now) + 2_000).toISOString() });
                state = bindGroup(state, { owner: state.owner!, runId: state.runId!, now, binding: { ...match, kind: message.mode === 'booking' ? 'paid' : 'unpaid', currentDate, dashboardPath,
                  ...(applicantIds ? { applicantIds } : {}) } });
                if (message.mode === 'booking') state = { ...state, stage: 'actions',
                  executor: { tabId: tab.id!, applicantIds: applicantIds!, targetTime: null, skippedDates: [], actionPending: false } };
                state = reviewLifecycle(state, prefs as unknown as Record<string, unknown>, now);
                if (message.mode === 'alerts') await prepareAlertScope(area, state);
                readStep = 'save';
                await saveEngineState(area, state);
                if (message.mode === 'alerts') {
                  const tabs = await platform.tabs.query({});
                  const payment = tabs.find(entry => entry.id !== undefined && entry.url !== undefined && classifyRoute(entry.url) === 'payment' && isSameGroupUrl(entry.url, match.scheduleId));
                  state = { ...state, monitorTabId: payment?.id ?? tab.id! };
                  await saveEngineState(area, state);
                  if (!payment) {
                    // Same-tab unpaid entry: retain the validated dashboard tab
                    // and navigate it to the bound group's payment summary
                    // instead of opening a second tab.
                    try {
                      const live = await platform.tabs.get(tab.id!);
                      if (classifyRoute(live.url ?? '') !== 'dashboard' || new URL(live.url!).pathname !== dashboardPath)
                        throw new Error('Dashboard context changed.');
                      await platform.tabs.update(tab.id!, { url: `https://ais.usvisa-info.com/en-ca/niv/schedule/${match.scheduleId}/payment` });
                    } catch { state = parkForReview(state, now); await saveEngineState(area, state); }
                  }
                }
              }
            }
          }
        }
        analytics?.link(analyticsStart, state);
        analytics?.observe(state);
        if (message.type !== 'PANEL_STATE') await syncEngineAlarm(engineAlarmAt(state));
        const saved = await area.get(['engineObservationV1', 'engineSuccessV1']);
        respond({ ok: true, snapshot: panelSnapshot(state, saved.engineObservationV1, saved.engineSuccessV1) });
      } catch (error) {
        analytics?.startFailed(analyticsStart);
        const detail = panelCommandError(error, readStep);
        // Validated classification beside the existing safe error: only the
        // exact known IVR domain errors (or their fixed safe diagnostics)
        // yield a specific kind; nothing arbitrary, no IVR or credentials.
        respond({ ok: false, error: detail, failureKind: panelFailureKind(error) });
      }
    });
    return true;
  }
  // Developer diagnostics read/export from the trusted bundled report page:
  // pruned, newest-first, allowlisted fields only (never preferences, engine
  // state, credentials, URLs or page content).
  if (message?.type === 'PROBE_DIAGNOSTICS' || message?.type === 'ENGINE_DIAGNOSTICS' || message?.type === 'ENGINE_PROBLEM_REPORT') {
    if (message.type === 'PROBE_DIAGNOSTICS') {
      if (sender.url !== platform.runtime.getURL('probe.html')) return;
    } else {
      // Production developer-console reader: only the bundled panel, with
      // the runtime sender id checked above. Website content scripts cannot
      // read diagnostics or use this to export any other storage keys.
      if (!isProductPanelSender(sender.url) || new URL(sender.url!).host !== platform.runtime.id) return;
    }
    void ready.then(async () => {
      const diagnostics = await engineDiagnostics.read();
      if (message.type !== 'ENGINE_PROBLEM_REPORT') return { ok: true, diagnostics };
      const state = await loadEngineState({ get: keys => platform.storage.local.get(keys), set: values => platform.storage.local.set(values) });
      return { ok: true, diagnostics, context: problemContext(state) };
    })
      .then(respond)
      .catch(() => respond({ ok: false }));
    return true;
  }
  // Only the bundled report page can operate the probe's wake-up test.
  if (message?.type === 'PROBE_WAKE') {
    if (sender.url !== platform.runtime.getURL('probe.html')) return;
    enqueue(async () => {
      try {
        await platform.alarms.create(ALARM, { delayInMinutes: 1 });
        respond({ ok: true });
      } catch { respond({ ok: false }); }
    });
    return true;
  }
  // Live group binding probe. Reads the dashboard snapshot from the
  // toolbar-selected tab, resolves it against the stored IVRs, and durably
  // binds a probe-owned run. Reads only: no clicks, fills, or navigation.
  // Only the bundled report page may trigger it.
  if (message?.type === 'PROBE_RESOLVE') {
    if (sender.url !== platform.runtime.getURL('probe.html')) return;
    enqueue(async () => {
      try {
        const mode = (message as { mode?: unknown }).mode;
        if (mode !== 'booking' && mode !== 'alerts') {
          respond({ ok: false });
          return;
        }
        if (!lastTrustedTab) {
          respond({ ok: false });
          return;
        }
        const tab = await platform.tabs.get(lastTrustedTab.tabId);
        if (classifyRoute(tab?.url ?? '') !== 'dashboard' || tab?.id === undefined) {
          respond({ ok: false });
          return;
        }
        const area = {
          get: (keys: string[]) => platform.storage.local.get(keys),
          set: (values: Record<string, unknown>) => platform.storage.local.set(values),
        };
        const prefs = (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as
          | { paidIvr?: unknown; unpaidIvr?: unknown }
          | undefined;
        const paidIvr = typeof prefs?.paidIvr === 'string' ? prefs.paidIvr : '';
        const unpaidIvr = typeof prefs?.unpaidIvr === 'string' ? prefs.unpaidIvr : '';
        const results = await platform.scripting.executeScript({ target: { tabId: tab.id }, func: readDashboardGroups });
        const raw = results[0]?.result as { groups?: { scheduleId?: unknown; ivr?: unknown; paymentStatus?: unknown }[] } | undefined;
        const identified = Array.isArray(raw?.groups)
          ? raw.groups.filter(
              (group): group is { scheduleId: string; ivr: string; paymentStatus?: unknown } =>
                typeof group?.scheduleId === 'string' && typeof group?.ivr === 'string',
            ).map(group => ({ scheduleId: group.scheduleId, ivr: group.ivr,
              ...(typeof group.paymentStatus === 'string' ? { paymentStatus: group.paymentStatus as never } : {}) }))
          : [];
        // Resolution throws on any ambiguity or mismatch: no state changes.
        const match = resolveGroup({ groups: identified }, { mode, paidIvr, unpaidIvr });
        let currentDate: string | null = null;
        let applicantIds: string[] | undefined;
        if (mode === 'booking') {
          const appt = await platform.scripting.executeScript({ target: { tabId: tab.id }, func: readCurrentAppointment, args: [match.scheduleId, match.ivr, false, true] });
          currentDate = appointmentDate(appt[0]?.result, match);
          applicantIds = appointmentApplicants(appt[0]?.result);
        }
        const now = new Date().toISOString();
        const current = (await loadEngineState(area)) ?? emptyEngineState(now);
        const owner = 'probe-owner-dev';
        const started =
          current.status === 'running' || current.status === 'verifying'
            ? current
            : startRun(current, { mode, owner, runId: crypto.randomUUID(), now });
        const next = bindGroup(started, {
          owner,
          runId: started.runId ?? '',
          binding: { ...match, kind: mode === 'booking' ? 'paid' : 'unpaid', currentDate, ...(applicantIds ? { applicantIds } : {}) },
          now,
        });
        if (next !== current) await saveEngineState(area, next);
        await syncEngineAlarm(engineAlarmAt(next));
        respond({ ok: true, mode, status: next.status, bound: next.group !== null, groupKind: next.group?.kind ?? null });
      } catch {
        respond({ ok: false });
      }
    });
    return true;
  }
  // Stops a probe-owned run. Ownership is enforced by the pure transition:
  // foreign runs are never touched.
  if (message?.type === 'PROBE_STOP') {
    if (sender.url !== platform.runtime.getURL('probe.html')) return;
    if (executingRun?.owner === 'probe-owner-dev') cancelledRuns.add(`${executingRun.owner}:${executingRun.runId}`);
    enqueue(async () => {
      try {
        const area = {
          get: (keys: string[]) => platform.storage.local.get(keys),
          set: (values: Record<string, unknown>) => platform.storage.local.set(values),
        };
        const now = new Date().toISOString();
        const current = await loadEngineState(area);
        if (!current) {
          respond({ ok: true, status: 'idle' });
          return;
        }
        const next = stopRun(current, { owner: 'probe-owner-dev', runId: current.runId ?? '', now });
        if (next !== current) await saveEngineState(area, next);
        await syncEngineAlarm(engineAlarmAt(next));
        respond({ ok: true, status: next.status });
      } catch {
        respond({ ok: false });
      }
    });
    return true;
  }
  // Kicks one poll cycle for the bound run by holding its deadline now. The
  // alarm loop still owns planning, budgets, and execution.
  if (message?.type === 'PROBE_POLL') {
    if (sender.url !== platform.runtime.getURL('probe.html')) return;
    enqueue(async () => {
      try {
        const area = {
          get: (keys: string[]) => platform.storage.local.get(keys),
          set: (values: Record<string, unknown>) => platform.storage.local.set(values),
        };
        const now = new Date().toISOString();
        const current = await loadEngineState(area);
        if (!current || current.status !== 'running' || !current.group) {
          respond({ ok: false });
          return;
        }
        const next = setNextPoll(current, {
          owner: current.owner ?? 'probe-owner-dev',
          runId: current.runId ?? '',
          nextPollAt: now,
          now,
        });
        if (next !== current) await saveEngineState(area, next);
        await syncEngineAlarm(engineAlarmAt(next));
        respond({ ok: true, status: next.status });
      } catch {
        respond({ ok: false });
      }
    });
    return true;
  }
  // Resets the unpaid monitor baseline so the next healthy read re-alerts.
  // Dev-only delivery check: scope and history stay intact, only the
  // observation/delivery state returns to fresh. Never touches engine runs.
  if (message?.type === 'PROBE_RESET') {
    if (sender.url !== platform.runtime.getURL('probe.html')) return;
    enqueue(async () => {
      try {
        const area = {
          get: (keys: string[]) => platform.storage.local.get(keys),
          set: (values: Record<string, unknown>) => platform.storage.local.set(values),
        };
        const saved = (await area.get(['unpaidMonitorV1'])).unpaidMonitorV1 as
          | { scopeKey?: unknown; monitor?: unknown }
          | undefined;
        if (!saved) {
          respond({ ok: false });
          return;
        }
        const monitor = validateMonitorState(saved.monitor);
        if (saved.scopeKey !== monitor.scopeKey) {
          respond({ ok: false });
          return;
        }
        await area.set({ unpaidMonitorV1: { scopeKey: saved.scopeKey, monitor: resetBaseline(monitor) } });
        respond({ ok: true });
      } catch {
        respond({ ok: false });
      }
    });
    return true;
  }
  // Read-only live adapter probe. Runs one dependency-free DOM reader on the
  // toolbar-selected trusted tab after re-validating its live URL, and
  // reports counts only — identifiers stay in worker storage, never in
  // responses or diagnostics. No clicks, no fills, no navigation. Only the
  // bundled report page may trigger it.
  if (message?.type === 'PROBE_READ') {
    if (sender.url !== platform.runtime.getURL('probe.html')) return;
    enqueue(async () => {
      try {
        const kind = (message as { kind?: unknown }).kind;
        if (kind !== 'dashboard' && kind !== 'summary' && kind !== 'form') {
          respond({ ok: false });
          return;
        }
        if (!lastTrustedTab) {
          respond({ ok: false, route: 'untrusted' });
          return;
        }
        const tab = await platform.tabs.get(lastTrustedTab.tabId);
        const route = classifyRoute(tab?.url ?? '');
        const allowed =
          (kind === 'dashboard' && route === 'dashboard') ||
          (kind === 'summary' && route === 'payment') ||
          (kind === 'form' && route === 'appointment');
        if (!allowed || tab?.id === undefined) {
          respond({ ok: false, route });
          return;
        }
        const func = kind === 'dashboard' ? readDashboardGroups : kind === 'summary' ? readSummaryRaw : readAppointmentForm;
        // One union member per call keeps the injected function serializable
        // and typed; all three readers are dependency-free by construction.
        const results = await platform.scripting.executeScript({
          target: { tabId: tab.id },
          func: func as () => { groups?: { ivr?: unknown }[]; headingFound?: unknown; rows?: unknown[]; facilityId?: unknown },
        });
        const value = results[0]?.result;
        const groups = Array.isArray(value?.groups) ? value.groups : null;
        const count = groups
          ? groups.length
          : Array.isArray(value?.rows)
            ? value.rows.length
            : value && typeof value === 'object'
              ? 1
              : 0;
        const identified = groups ? groups.filter(group => typeof group?.ivr === 'string').length : null;
        respond({ ok: true, route, count, ...(identified === null ? {} : { identified }) });
      } catch {
        respond({ ok: false });
      }
    });
    return true;
  }
  // Engine status readout for supervised runs. Reports run posture and
  // monitor progress with counts and dates the owner already knows — never
  // identifiers, never page text. Only the bundled report page may ask.
  if (message?.type === 'PROBE_STATUS') {
    if (sender.url !== platform.runtime.getURL('probe.html')) return;
    enqueue(async () => {
      try {
        const area = {
          get: (keys: string[]) => platform.storage.local.get(keys),
          set: (values: Record<string, unknown>) => platform.storage.local.set(values),
        };
        const saved = await area.get([ENGINE_KEY, 'unpaidMonitorV1', 'lastPollV1']);
        const state = saved[ENGINE_KEY] as
          | {
              status?: unknown;
              mode?: unknown;
              group?: { kind?: unknown } | null;
              consecutiveFailures?: unknown;
              nextPollAt?: unknown;
              lastCandidate?: unknown;
              stage?: unknown;
            }
          | undefined;
        const slot = saved.unpaidMonitorV1 as
          | { monitor?: { alert?: { pending?: unknown; delivered?: unknown }; baseline?: unknown; lastHealthyAt?: unknown } }
          | undefined;
        const poll = saved.lastPollV1 as { status?: unknown; dayCount?: unknown; at?: unknown } | undefined;
        respond({
          ok: true,
          status: state?.status ?? 'idle',
          mode: state?.mode ?? null,
          groupKind: state?.group?.kind ?? null,
          failures: state?.consecutiveFailures ?? 0,
          nextPollAt: state?.nextPollAt ?? null,
          lastCandidate: state?.lastCandidate ?? null,
          stage: state?.stage ?? null,
          lastPollStatus: typeof poll?.status === 'number' ? poll.status : null,
          lastPollDays: typeof poll?.dayCount === 'number' ? poll.dayCount : null,
          monitorPending: slot?.monitor?.alert?.pending ?? null,
          monitorDelivered: slot?.monitor?.alert?.delivered ?? null,
          monitorBaseline: slot?.monitor?.baseline ?? null,
          lastHealthyAt: slot?.monitor?.lastHealthyAt ?? null,
        });
      } catch {
        respond({ ok: false });
      }
    });
    return true;
  }
  // Engine control accepts only typed messages from bundled extension pages.
  // Website content, including the visa site itself, can never start, stop,
  // arm, or resolve a run. No credentials, page text, or URLs travel here.
  if (typeof message?.type === 'string' && message.type.startsWith('ENGINE_')) {
    // Compare against the full base URL: URL.origin is "null" for
    // chrome-extension: URLs outside the browser, so prefix-match instead.
    const extensionBase = platform.runtime.getURL('');
    if (!sender.url || !sender.url.startsWith(extensionBase)) return;
    if (message.type === 'ENGINE_STOP' && executingRun && executingRun.owner === message.owner && executingRun.runId === message.runId)
      cancelledRuns.add(`${message.owner}:${message.runId}`);
    enqueue(async () => {
      try {
        const validated = validateEngineMessage(message);
        const area = {
          get: (keys: string[]) => platform.storage.local.get(keys),
          set: (values: Record<string, unknown>) => platform.storage.local.set(values),
        };
        const now = new Date().toISOString();
        const current = (await loadEngineState(area)) ?? emptyEngineState(now);
        let next = current;
        switch (validated.type) {
          case 'ENGINE_START':
            next = startRun(current, {
              mode: validated.mode, owner: validated.owner, runId: validated.runId,
              now, nextPollAt: validated.nextPollAt ?? null,
            });
            break;
          case 'ENGINE_STOP':
            next = stopRun(current, { owner: validated.owner, runId: validated.runId, now });
            break;
          case 'ENGINE_INTENT':
            next = recordIntent(current, {
              owner: validated.owner, runId: validated.runId, intent: validated.intent, now,
            });
            break;
          case 'ENGINE_POLL':
            next = setNextPoll(current, {
              owner: validated.owner, runId: validated.runId, nextPollAt: validated.nextPollAt, now,
            });
            break;
          case 'ENGINE_VERIFY':
            // Developer verification trigger: never trusts a claimed outcome
            // (validated.outcome is ignored) and never bypasses fresh
            // dashboard reads, route/group trust, pacing or intent guards.
            // Preserves active tab/progress/deadlines (idempotent).
            if (current.owner === validated.owner && current.runId === validated.runId) next = await verifyFromDashboard(current, false);
            break;
          case 'ENGINE_RESOLVE': {
            // Resolution failures throw inside the guarded block: no state
            // change, no save, and an ok:false response. Never guess a group.
            const match = resolveGroup(validated.snapshot, {
              mode: validated.mode, paidIvr: validated.paidIvr, unpaidIvr: validated.unpaidIvr,
            });
            let currentDate: string | null = null;
            let applicantIds: string[] | undefined;
            let dashboardPath: string | undefined;
            if (validated.mode === 'booking') {
              const tab = await dashboardTab();
              dashboardPath = new URL(tab.url!).pathname;
              const result = await platform.scripting.executeScript({ target: { tabId: tab.id! }, func: readCurrentAppointment, args: [match.scheduleId, match.ivr, false, true, dashboardPath] });
              currentDate = appointmentDate(result[0]?.result, match);
              applicantIds = appointmentApplicants(result[0]?.result);
            }
            next = bindGroup(current, {
              owner: validated.owner,
              runId: validated.runId,
              binding: { ...match, kind: validated.mode === 'booking' ? 'paid' : 'unpaid', currentDate, ...(applicantIds ? { applicantIds } : {}), ...(dashboardPath ? { dashboardPath } : {}) },
              now,
            });
            break;
          }
        }
        if (next !== current) await saveEngineState(area, next);
        await syncEngineAlarm(engineAlarmAt(next));
        respond({ ok: true, status: next.status, runId: next.runId, generation: next.generation });
      } catch { respond({ ok: false }); }
    });
    return true;
  }
});

async function recoverPollException(area: import('./engine/storage').StorageArea): Promise<void> {
  const now = new Date().toISOString();
  try {
    // Always reload: a mutation may have committed a checkpoint before its
    // caller threw. Retrying from the old in-memory state could replay it.
    const latest = await loadEngineState(area);
    if (!latest) { await syncEngineAlarm(null); return; }
    let next = reconcileStartup(latest, now);
    if (latest.owner && latest.runId && cancelledRuns.has(`${latest.owner}:${latest.runId}`))
      next = stopRun(next, { owner: latest.owner, runId: latest.runId, now });
    const due = engineAlarmAt(next);
    if (next === latest && (!due || Date.parse(due) <= Date.now())) {
      if (next.restartPending && next.status === 'running' && !next.authentication) next = retryRestart(next, now, Math.random);
      else if ((next.status === 'running' && next.group) || next.authentication) {
        next = applyPollResult(next, { outcome: 'retryable', now, random: Math.random });
        noteExceptionRecovery(next);
        if (next.authentication) next = { ...next, authentication: { ...next.authentication, phase: 'retry' } };
        if (next.restartPending && next.consecutiveFailures >= SETUP_FAILURE_COOLDOWN_AFTER) next = restartExhausted(next, now);
      } else if (next.verification?.nextReadAt) {
        next = { ...next, verification: { ...next.verification,
          nextReadAt: new Date(Date.now() + pollDelaySeconds(Math.random, next.pollIntervalS) * 1000).toISOString() }, updatedAt: now };
      }
    }
    if (next !== latest) await saveEngineState(area, next);
    storageRetryAt = null;
    await syncEngineAlarm(engineAlarmAt(next));
  } catch {
    // No trusted state means no page actions, inference, or click replay. This
    // alarm retries storage/reconciliation only, including pending checkpoints.
    storageRetryAt = new Date(Date.now() + pollDelaySeconds(Math.random) * 1000).toISOString();
    await syncEngineAlarm(storageRetryAt);
  }
}

function queueEnginePoll(): void {
    enqueue(async () => {
      const area = {
        get: (keys: string[]) => platform.storage.local.get(keys),
        set: (values: Record<string, unknown>) => platform.storage.local.set(values),
      };
      try {
        if (storageRetryAt && Date.parse(storageRetryAt) > Date.now()) { await syncEngineAlarm(storageRetryAt); return; }
        storageRetryAt = null;
        const now = new Date().toISOString();
        const loaded = await loadEngineState(area);
        if (!loaded) return;
        let state = loaded;
        if (state.restartPending && state.status === 'running' && !state.authentication) {
          executingRun = state.owner && state.runId ? { owner: state.owner, runId: state.runId } : null;
          const deadline = engineAlarmAt(state);
          if (deadline && Date.parse(deadline) > Date.now()) { await syncEngineAlarm(deadline); return; }
          const next = await attemptRestart(area, state);
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        if (state.authentication) {
          executingRun = state.owner && state.runId ? { owner: state.owner, runId: state.runId } : null;
          const deadline = engineAlarmAt(state);
          if (deadline && Date.parse(deadline) > Date.now()) { await syncEngineAlarm(deadline); return; }
          let next = await runAuthentication(executionDependencies(area, state), state);
          if (state.restartPending && !next.intent && !next.manualAuthentication) {
            if (next.consecutiveFailures >= SETUP_FAILURE_COOLDOWN_AFTER) next = restartExhausted(next, new Date().toISOString());
            else if (next.status === 'stopped' && next.authenticationError) next = retryRestart(next, new Date().toISOString(), Math.random);
            else if (!next.authentication && next.status === 'running' && next.group) next = { ...next, restartPending: false };
          }
          // Same-tab unpaid entry: retain the validated authentication
          // dashboard tab and navigate it to the payment summary instead of
          // opening a second tab.
          if (!next.authentication && next.status === 'running' && next.mode === 'alerts' && next.group) {
            try {
              if (state.authentication.purpose === 'start') await prepareAlertScope(area, next);
              const group = next.group;
              // Renewal retains custody even when duplicate summaries exist.
              const existing = state.authentication.purpose === 'renew' ? undefined : (await platform.tabs.query({})).find(entry =>
                entry.id !== undefined && entry.url !== undefined && classifyRoute(entry.url) === 'payment' && isSameGroupUrl(entry.url, next.group!.scheduleId));
              next = { ...next, monitorTabId: existing?.id ?? state.authentication.tabId };
              if (!existing) {
                const authTabId = state.authentication.tabId;
                if (authTabId === null || authTabId === undefined) throw new Error('Missing authentication tab.');
                const live = await platform.tabs.get(authTabId);
                if (classifyRoute(live.url ?? '') !== 'dashboard' || !group.dashboardPath ||
                    new URL(live.url!).pathname !== group.dashboardPath || cancelledRuns.has(`${state.owner}:${state.runId}`))
                  throw new Error('Authentication context changed.');
                await saveEngineState(area, next);
                if (cancelledRuns.has(`${state.owner}:${state.runId}`)) throw new Error('Authentication cancelled.');
                await platform.tabs.update(authTabId, { url: `https://ais.usvisa-info.com/en-ca/niv/schedule/${group.scheduleId}/payment` });
              }
            } catch { next = parkForReview(next, new Date().toISOString()); }
          }
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        if (!state.group) return;
        if (state.status === 'verifying') {
          if (!state.verification?.nextReadAt) return;
          const next = await verifyFromDashboard(state);
          if (next !== state) await saveEngineState(area, next, state.runId);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        if (state.status !== 'running') return;
        executingRun = state.owner && state.runId ? { owner: state.owner, runId: state.runId } : null;
        const plan = planPollStep(state, now);
        if (plan.action !== 'poll-now') {
          await syncEngineAlarm(plan.action === 'wait' ? plan.until : null);
          return;
        }
        const durablePrefs = (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as Record<string, unknown> | undefined;
        let sessionExpired = state.startedAt !== null && Date.parse(now) - Date.parse(state.startedAt) >= SESSION_AGE_MINUTES * 60_000;
        if (state.executor && !state.intent) {
          try { sessionExpired ||= classifyRoute((await platform.tabs.get(state.executor.tabId)).url ?? '') === 'login'; }
          catch {
            const next = parkForReview(state, now);
            await saveEngineState(area, next);
            await syncEngineAlarm(null);
            return;
          }
        }
        if (sessionExpired && !state.intent && state.policyKey === policyKey(durablePrefs)) {
          const next = beginTrackedAuthentication(state, 'renew', now, Math.random);
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        const lifecycle = reviewLifecycle(state, durablePrefs, now);
        if (lifecycle !== state) await saveEngineState(area, lifecycle);
        state = lifecycle;
        if (state.status !== 'running') { await syncEngineAlarm(null); return; }
        if (!state.group) return;
        if (state.mode !== 'booking') {
          // Unpaid summary loop: read the heading-scoped seven-city summary
          // from a validated same-group payment tab, fold it into the
          // scope-bound monitor, and notify selected-consulate changes only.
          // Read failures budget a retry; corrupt baselines park for review.
          const stamped = new Date().toISOString();
          const park = async (detail: DiagnosticDetail = 'stage-guard') => {
            noteDiagnostic('poll-park', { mode: state.mode, detail });
            const parked = parkForReview(state, new Date().toISOString());
            if (parked !== state) await saveEngineState(area, parked);
            await syncEngineAlarm(null);
          };
          const failSoft = async () => {
            const next = pollRetry(state);
            await saveEngineState(area, next);
            await syncEngineAlarm(engineAlarmAt(next));
          };
          const prefs = (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as Record<string, unknown> | undefined;
          const consulate = prefs?.consulate;
          if (typeof consulate !== 'string' || !(consulate in CONSULATES)) {
            await park();
            return;
          }
          let windowPrefs;
          try {
            windowPrefs = {
              earliest: prefs?.earliest as string,
              latest: prefs?.latest as string,
              exclusions: [],
              onlyEarlier: false,
            };
            validatePreferences(windowPrefs);
          } catch {
            await park();
            return;
          }
          const scheduleId = state.group.scheduleId;
          const paymentTabs = await platform.tabs.query({});
          const matchingPayments = paymentTabs.filter(
            tab => tab.url !== undefined && classifyRoute(tab.url) === 'payment' && isSameGroupUrl(tab.url, scheduleId),
          );
          const payment = state.monitorTabId === null
            ? (matchingPayments.length === 1 ? matchingPayments[0] : undefined)
            : matchingPayments.find(tab => tab.id === state.monitorTabId);
          if (payment?.id === undefined) {
            if (paymentTabs.some(tab => classifyRoute(tab.url ?? '') === 'login')) {
              const next = beginTrackedAuthentication(state, 'renew', new Date().toISOString(), Math.random);
              await saveEngineState(area, next);
              await syncEngineAlarm(engineAlarmAt(next));
              return;
            }
            await park();
            return;
          }
          if (state.monitorTabId === null) {
            state = { ...state, monitorTabId: payment.id };
            await saveEngineState(area, state);
          }
          let raw: unknown;
          try {
            const results = await platform.scripting.executeScript({ target: { tabId: payment.id }, func: readSummaryRaw, args: [scheduleId] });
            raw = results[0]?.result;
          } catch {
            await failSoft();
            return;
          }
          // Site maintenance keeps the payment URL but drops the summary, and
          // the dead page never recovers without a refresh. Reload it (a safe
          // GET) and retry on budget; the landing re-read follows on load.
          // Persistent maintenance still reaches cooldown and review.
          if (typeof raw === 'object' && raw !== null && (raw as { maintenance?: unknown }).maintenance === true) {
            noteDiagnostic('poll-maintenance', { mode: state.mode, detail: 'maintenance' });
            try {
              await platform.tabs.reload(payment.id, { bypassCache: true });
              maintenanceReload = state.runId ? { runId: state.runId, tabId: payment.id } : null;
            } catch { maintenanceReload = null; }
            await failSoft();
            return;
          }
          try {
            const reading = normalizeSummaryRaw(
              raw as { headingFound: boolean; rows: { city: string; text: string }[] },
            );
            if (cancelledRuns.has(`${state.owner}:${state.runId}`)) { await park(); return; }
            const scopeKey = `alerts:${scheduleId}:${consulate}:any:${windowPrefs.earliest}:${windowPrefs.latest}`;
            const saved = (await area.get(['unpaidMonitorV1'])).unpaidMonitorV1 as
              | { scopeKey?: unknown; monitor?: unknown }
              | undefined;
            let monitor;
            try {
              monitor = monitorForScope(saved, scopeKey);
            } catch { await park(); return; }
            const { state: advanced, alertDue } = observeSummary(monitor, reading, {
              scopeKey,
              consulate: consulate as keyof typeof CONSULATES,
              prefs: windowPrefs,
              rangeOnly: false,
              now: stamped,
            });
            await area.set({ unpaidMonitorV1: { scopeKey, monitor: advanced } });
            await area.set({ engineObservationV1: { runId: state.runId, mode: state.mode, checkedAt: stamped, dates: [], rows: reading.rows } });
            void dateHistory.observe(state, consulate, reading.rows.find(row => row.city === consulate)?.date ?? null, stamped);
            analytics?.activated(state, reading.rows.length);
            if (alertDue) {
              if (cancelledRuns.has(`${state.owner}:${state.runId}`)) { await park(); return; }
              // Acceptance records creation only, never proof of delivery.
              await platform.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'US Visa Scheduler for Canada',
                message: `New date available: ${alertDue}`,
              });
              await area.set({ unpaidMonitorV1: { scopeKey, monitor: acceptNotification(advanced, alertDue) } });
            }
            notePollRecovered(state, 'healthy');
            const next = applyPollResult(state, { outcome: 'healthy', now: stamped, random: Math.random });
            await saveEngineState(area, next);
            await syncEngineAlarm(engineAlarmAt(next));
          } catch {
            await failSoft();
          }
          return;
        }
        // Booking stages prepare the owned form before polling, then fill a
        // candidate: one verified stage per alarm, with final Test Mode guards.
        // Submission/confirmation checkpoint exceptions route into automatic
        // verification (never a replay) when a durable intent exists; other
        // exceptions preserve the run for retry.
        if (state.mode === 'booking' && (state.stage !== null || !state.executor?.applicantIds)) {
          const prepared = state.stage === null ? setStage(state, 'actions', new Date().toISOString()) : state;
          let next: typeof state;
          try {
            next = await runBookingStage(executionDependencies(area, state), prepared);
          } catch {
            if (prepared.intent) {
              const at = new Date().toISOString();
              next = { ...parkForReview(prepared, at), stage: 'done',
                verification: { reads: [], nextReadAt: new Date(Date.parse(at) + 30_000).toISOString() } };
            } else throw new Error('Engine poll alarm failed.');
          }
          if (next!.status === 'stopped' && !next!.intent) next = beginTrackedAuthentication(prepared, 'renew', new Date().toISOString(), Math.random);
          if (next !== state) await saveEngineState(area, next!);
          await syncEngineAlarm(engineAlarmAt(next!));
          return;
        }
        // Paid fetch loop only; the unpaid summary loop arrives separately.
        // Anything unplannable parks for review instead of acting blindly.
        const park = async (detail: DiagnosticDetail = 'stage-guard') => {
          noteDiagnostic('poll-park', { mode: state.mode, detail });
          const parked = parkForReview(state, new Date().toISOString());
          if (parked !== state) await saveEngineState(area, parked);
          await syncEngineAlarm(null);
        };
        if (state.mode !== 'booking') return;
        const prefs = (await area.get(['uiPreferencesV1'])).uiPreferencesV1 as Record<string, unknown> | undefined;
        const consulate = prefs?.consulate;
        const earliest = prefs?.earliest;
        const latest = prefs?.latest;
        const onlyEarlier = prefs?.onlyEarlier === true;
        if (typeof consulate !== 'string' || !(consulate in CONSULATES)) {
          await park();
          return;
        }
        let windowPrefs;
        try {
          windowPrefs = { earliest, latest, exclusions: [], onlyEarlier } as {
            earliest: string;
            latest: string;
            exclusions: [];
            onlyEarlier: boolean;
          };
          validatePreferences(windowPrefs);
        } catch {
          await park();
          return;
        }
        const scheduleId = state.group.scheduleId;
        const tabs = await platform.tabs.query({});
        // Once the executor owns a tab, never poll a replacement or another
        // same-group tab after closure/navigation.
        const reader = tabs.find(tab => tab.id === state.executor!.tabId &&
          tab.url !== undefined && classifyRoute(tab.url) === 'appointment' && isSameGroupUrl(tab.url, scheduleId));
        if (reader?.id === undefined) {
          // A closed or navigated-away executor tab with a booking intent
          // still needs its outcome verified: schedule the read-only pass
          // (30s settling, then short-paced fresh reads) instead of a bare
          // park with no deadline. Runs without an intent park bare.
          if (state.intent) {
            const parked = parkForVerification(state, new Date().toISOString());
            if (parked !== state) await saveEngineState(area, parked);
            await syncEngineAlarm(engineAlarmAt(parked));
          } else await park();
          return;
        }
        const retryRead = async (detail?: DiagnosticDetail) => {
          const next = pollRetry(state, detail);
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
        };
        let implicitApplicantId: string | null = null;
        if (state.group.applicantIds?.length === 1 &&
            sameApplicants(state.executor!.applicantIds, state.group.applicantIds) && !new URL(reader.url!).search) {
          if (!state.group.dashboardPath) { await park(); return; }
          let baseline: InjectionResult[];
          try {
            baseline = await platform.scripting.executeScript({ target: { tabId: reader.id }, func: readCurrentAppointment,
              args: [scheduleId, state.group.ivr, true, true, state.group.dashboardPath, true] });
          } catch {
            // No reading means no permission to poll or infer an applicant.
            // Skip this cycle on the existing retry/cooldown budget; a failed
            // fresh GET or injection must not silently end normal monitoring.
            await retryRead('script-interrupted');
            return;
          }
          const reading = baseline[0]?.result as { scheduleId?: unknown; ivr?: unknown; kind?: unknown; status?: unknown } | undefined;
          if (reading?.kind === 'read-failure' && reading.scheduleId === scheduleId && reading.ivr === state.group.ivr &&
              typeof reading.status === 'number' && Number.isInteger(reading.status) && reading.status >= 0 && reading.status <= 599) {
            if (mapHttpStatus(reading.status) === 'denied') {
              noteDiagnostic('poll-denied', { mode: state.mode, outcome: 'denied' });
              const next = beginTrackedAuthentication(state, 'renew', new Date().toISOString(), Math.random);
              await saveEngineState(area, next);
              await syncEngineAlarm(engineAlarmAt(next));
            } else await retryRead('transport');
            return;
          }
          try {
            if (appointmentDate(baseline[0]?.result, state.group) !== state.group.currentDate) { await park('baseline-changed'); return; }
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (message === 'Appointment identity changed.') await park('group-changed');
            else if (message === 'Applicant roster changed.') await park('roster-changed');
            else await retryRead('reply-malformed');
            return;
          }
          implicitApplicantId = state.group.applicantIds[0];
        }
        let page: PaidPage | null;
        try {
          const result = await platform.scripting.executeScript({ target: { tabId: reader.id }, func: readPaidPage, args: [scheduleId, implicitApplicantId] });
          page = result[0]?.result as PaidPage;
        } catch { await retryRead('script-interrupted'); return; }
        // A maintenance page keeps the form URL but renders no usable form. As
        // in the unpaid loop, reload it and retry on budget; anything else
        // still parks. Readable pages with changed applicants always park.
        if (page && page.scheduleId !== scheduleId) { await park('group-changed'); return; }
        if (!page || page.kind !== 'form') {
          let maintenance = false;
          try {
            const check = await platform.scripting.executeScript({ target: { tabId: reader.id }, func: readSiteMaintenance });
            maintenance = (check[0]?.result as { maintenance?: unknown } | undefined)?.maintenance === true;
          } catch { maintenance = false; }
          if (maintenance) {
            noteDiagnostic('poll-maintenance', { mode: state.mode, detail: 'maintenance' });
            try { await platform.tabs.reload(reader.id, { bypassCache: true }); } catch { /* Tab loss parks below via retry budget. */ }
            const next = pollRetry(state, 'maintenance');
            await saveEngineState(area, next);
            await syncEngineAlarm(engineAlarmAt(next));
            return;
          }
          // Re-enter through auth-only recovery in the same owned tab. It
          // revalidates live custody, group, baseline and roster before any
          // booking action, and preserves the paced failure/cooldown deadline.
          const failed = pollRetry(state, page ? 'reply-malformed' : 'reply-missing');
          const auth = beginTrackedAuthentication(failed, 'renew', new Date().toISOString(), Math.random);
          const next = auth.authentication ? { ...auth, nextPollAt: failed.nextPollAt, cooldownUntil: failed.cooldownUntil } : auth;
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        if (!sameApplicants(page.applicantIds, state.executor!.applicantIds) ||
            (state.group.applicantIds && !sameApplicants(page.applicantIds, state.group.applicantIds)) || typeof prefs?.testMode !== 'boolean') {
          await park('roster-changed');
          return;
        }
        const schedulePath = `/en-ca/niv/schedule/${scheduleId}/appointment`;
        let status = 0;
        let body: unknown = null;
        try {
          const results = await platform.scripting.executeScript({
            target: { tabId: reader.id },
            func: fetchDaysJson,
            args: [schedulePath, CONSULATES[consulate as keyof typeof CONSULATES]],
          });
          const result = results[0]?.result as { status?: unknown; body?: unknown } | undefined;
          if (result && typeof result.status === 'number') {
            status = result.status;
            body = result.body;
          }
        } catch {
          status = 0;
          body = null;
        }
        const outcome = mapHttpStatus(status);
        if (cancelledRuns.has(`${state.owner}:${state.runId}`)) { await park(); return; }
        if (outcome === 'denied') {
          noteDiagnostic('poll-denied', { mode: state.mode, outcome: 'denied' });
          const next = beginTrackedAuthentication(state, 'renew', new Date().toISOString(), Math.random);
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        if (outcome === 'retryable') {
          const next = pollRetry(state, 'transport');
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        let dates: string[];
        try {
          dates = outcome === 'not-modified' ? [] : parseDaysPayload(body).map(entry => entry.date);
        } catch {
          const next = pollRetry(state, 'reply-malformed');
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        const stamped = new Date().toISOString();
        if (outcome === 'not-modified') {
          notePollRecovered(state, 'not-modified');
          const next = applyPollResult(state, { outcome, now: stamped, random: Math.random });
          await saveEngineState(area, next);
          await syncEngineAlarm(engineAlarmAt(next));
          return;
        }
        if (dates.length > 0) notePollRecovered(state, 'healthy');
        const applied = applyPollResult(state, {
          outcome: dates.length === 0 ? 'empty' : 'healthy',
          now: stamped,
          random: Math.random,
        });
        if (dates.length === 0) noteDiagnostic(applied.cooldownUntil && applied.cooldownUntil !== state.cooldownUntil ? 'poll-cooldown-entered' : 'poll-empty',
          { mode: 'booking', outcome: 'empty', detail: 'empty-result', failures: applied.consecutiveFailures });
        // Counts-only poll footprint for supervised debugging: how many days
        // the portal returned, never which dates.
        await area.set({ lastPollV1: { status, dayCount: dates.length, at: stamped } });
        await area.set({ engineObservationV1: { runId: state.runId, mode: state.mode, checkedAt: stamped, dates, rows: [] } });
        void dateHistory.observe(state, consulate, [...dates].sort()[0] ?? null, stamped);
        const candidate =
          dates.length === 0 ? null : earliestCandidate(
            dates.filter(date => !state.executor?.skippedDates.includes(date)), state.group.currentDate, windowPrefs);
        // Empty times exclude that date for this sweep; once every eligible
        // date is exhausted, the next paced poll starts a fresh sweep.
        if (candidate === null && applied.executor) applied.executor = { ...applied.executor, skippedDates: [] };
        const recorded = recordCandidate(applied, candidate, stamped);
        // A matched candidate is time-sensitive: save it, then continue on
        // the immediate short wake with the usual fresh policy/checkpoints.
        const next = recorded.lastCandidate && recorded.stage === null
          ? setStage({ ...recorded, nextPollAt: stamped, executor: recorded.executor && { ...recorded.executor, targetTime: null } },
              recorded.executor?.applicantIds ? 'form' : 'actions', stamped)
          : recorded;
        await saveEngineState(area, next);
        await syncEngineAlarm(engineAlarmAt(next));
      } catch {
        console.error('Engine poll alarm failed.');
        await recoverPollException(area);
      } finally {
        if (executingRun) cancelledRuns.delete(`${executingRun.owner}:${executingRun.runId}`);
        executingRun = null;
      }
    });
}

platform.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === HISTORY_ALARM) { void ready.then(() => dateHistory.prune()).catch(() => undefined); return; }
  if (alarm.name === ANALYTICS_ALARM) { void ready.then(() => analytics?.flush()).catch(() => undefined); return; }
  if (alarm.name === DIAGNOSTICS_ALARM) { void ready.then(() => engineDiagnostics.prune()).catch(() => undefined); return; }
  if (alarm.name === ENGINE_ALARM) { queueEnginePoll(); return; }
  if (alarm.name !== ALARM) return;
  enqueue(async () => {
    await platform.storage.local.set({ developmentProbeWakeAt: new Date().toISOString() });
  });
});

platform.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo as { status?: unknown } | undefined)?.status !== 'complete') return;
  enqueue(async () => {
    const area = { get: (keys: string[]) => platform.storage.local.get(keys), set: (values: Record<string, unknown>) => platform.storage.local.set(values) };
    const state = await loadEngineState(area);
    if (!state || !state.owner || !state.runId || cancelledRuns.has(`${state.owner}:${state.runId}`)) return;
    const url = (tab as { url?: unknown } | undefined)?.url;
    if (typeof url !== 'string') return;
    if (!state.nextPollAt || Date.parse(state.nextPollAt) <= Date.now()) return;
    const now = new Date().toISOString();
    if (state.authentication) {
      if (!['running', 'verifying'].includes(state.status) || state.authentication.tabId !== tabId || state.authentication.pending || state.authentication.phase === 'retry' || state.authentication.phase === 'cycle-wait' ||
          (state.cooldownUntil && Date.parse(state.cooldownUntil) > Date.now()) ||
          !['login', 'dashboard'].includes(classifyRoute(url))) return;
      let live;
      try { live = await platform.tabs.get(tabId); } catch { return; }
      if (live.url !== url || live.status === 'loading') return;
      const next = { ...state, nextPollAt: now, updatedAt: now };
      await saveEngineState(area, next);
      await syncEngineAlarm(engineAlarmAt(next));
      return;
    }
    if (state.status !== 'running' || !state.group || (state.cooldownUntil && Date.parse(state.cooldownUntil) > Date.now())) return;
    if (state.mode === 'booking') {
      if (!state.executor || state.executor.tabId !== tabId || state.executor.actionPending || state.intent || state.consecutiveFailures > 0 ||
          !['actions', 'warning', 'applicants', 'form'].includes(state.stage ?? '')) return;
      const route = classifyRoute(url);
      if (!((['actions', 'appointment'].includes(route) && isSameGroupUrl(url, state.group.scheduleId)) ||
          (state.stage === 'actions' && route === 'dashboard' && new URL(url).pathname === state.group.dashboardPath))) return;
      let live;
      try { live = await platform.tabs.get(tabId); } catch { return; }
      if (live.url !== url || live.status === 'loading') return;
      const next = setNextPoll(state, { owner: state.owner, runId: state.runId, nextPollAt: now, now });
      await saveEngineState(area, next);
      await syncEngineAlarm(engineAlarmAt(next));
      return;
    }
    if (classifyRoute(url) !== 'payment' || !isSameGroupUrl(url, state.group.scheduleId) ||
        (state.monitorTabId !== null && state.monitorTabId !== tabId)) return;
    const saved = await area.get(['engineObservationV1']);
    const observation = saved.engineObservationV1 as { runId?: unknown } | undefined;
    const observed = !!observation && observation.runId === state.runId;
    // A maintenance reload gets one immediate re-read on landing; afterwards
    // the normal cadence resumes. Anything else with an observation keeps it.
    const reloaded = maintenanceReload !== null && state.runId !== null &&
      maintenanceReload.runId === state.runId && maintenanceReload.tabId === tabId;
    if (reloaded) maintenanceReload = null;
    if (observed && !reloaded) return;
    const next = setNextPoll(state, { owner: state.owner, runId: state.runId, nextPollAt: new Date().toISOString(), now: new Date().toISOString() });
    if (next !== state) {
      await saveEngineState(area, next);
      await syncEngineAlarm(engineAlarmAt(next));
    }
  });
});

platform.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.uiPreferencesV1) return;
  explicitStartEpoch += 1;
  analytics?.end();
  if (executingRun) cancelledRuns.add(`${executingRun.owner}:${executingRun.runId}`);
  enqueue(async () => {
    analytics?.end();
    const area = { get: (keys: string[]) => platform.storage.local.get(keys), set: (values: Record<string, unknown>) => platform.storage.local.set(values) };
    const state = await loadEngineState(area);
    // Settings or credential changes after a queued verification restart cancel
    // the request (scoped to the requested configuration) while preserving
    // unresolved intent for review. Verification itself still resolves the
    // ORIGINAL saved group; only the automatic restart permission is dropped.
    if (state?.queuedStart) {
      await saveEngineState(area, { ...state, queuedStart: null, updatedAt: new Date().toISOString() });
      // Fall through to the usual parking below with the request cancelled.
    }
    const current = state?.queuedStart ? { ...state, queuedStart: null } : state;
    // Corrected configuration retires the previous stopped diagnostic. An
    // unresolved booking still retains all of its verification guidance.
    if (current?.status === 'stopped' && !current.intent && (current.loginFailed || current.authenticationError)) {
      await saveEngineState(area, { ...current, loginFailed: false, authenticationError: null, authenticationFailureReason: null, updatedAt: new Date().toISOString() });
      await syncEngineAlarm(null);
      return;
    }
    if (!current || (current.status !== 'running' && !current.authentication)) {
      // A verifying run with a queued request keeps its intent and parked
      // verification progress; only the request was cancelled above.
      if (state?.queuedStart) await syncEngineAlarm(engineAlarmAt({ ...state, queuedStart: null }));
      return;
    }
    const now = new Date().toISOString();
    const next = current.status === 'running' ? parkForReview(current, now) : { ...current, authentication: null, verification: null, nextPollAt: null, updatedAt: now };
    await saveEngineState(area, next);
    await syncEngineAlarm(null);
  });
});
