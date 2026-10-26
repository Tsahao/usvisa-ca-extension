import { adoptAppointmentBaseline } from './baseline';
import { adapterFailureCode, blockedFailureContext, bookingFailureStep, paidActionStep, type FailureCode, type FailureStep } from '../domain/failure-context';
import { canBook, CONSULATES, selectedConsulates, validatePreferences, type Consulate } from '../domain/dates';
import { guardBooking } from '../domain/booking';
import { readAutoMode } from '../domain/auto-mode';
import { sameApplicants, validateApplicantIds } from '../domain/applicants';
import { parseTimesPayload } from '../domain/availability';
import { isBareAppointmentQuery, classifyRoute } from '../domain/routes';
import { isSameGroupUrl } from '../domain/trust';
import { normalizeReadingIvr } from '../domain/groups';
import { mapHttpStatus, SESSION_AGE_MINUTES } from '../domain/timing';
import { isDiagnosticDetail, isDiagnosticPhase, type DiagnosticDetail, type DiagnosticEvent } from '../domain/diagnostics';
import { performPaidAction, type ActResult, type PaidAction } from '../adapter/acts';
import { readPaidPage, type PaidPage } from '../adapter/paid';
import { readCurrentAppointment } from '../adapter/reads';
import { appointmentDate } from '../domain/appointment';
import { fetchTimesJson, type PollResponse } from '../adapter/poll';
import { applyPollResult, setStage, type BookingStage } from './poll';
import { isEntryCheckpoint, parkForReview, recordIntent, type EngineState } from './workflow';
import { policyKey } from './lifecycle';
import { trustedRenewalUrl } from './navigation-recovery';
import { beginAuthentication, recoverMaintenance } from './authentication';
import { observeMaintenance } from './maintenance';
import { performAppointmentSubmission, waitForAppointmentDialog, type SubmissionRequest } from '../adapter/confirmation';
import { performDashboardContinue } from '../adapter/dashboard-entry';

export type ExecTab = { id?: number; url?: string; status?: string; pendingUrl?: string };
export type ExecDeps = {
  nowIso: () => string;
  random: () => number;
  queryTabs: () => Promise<ExecTab[]>;
  getTab: (tabId: number) => Promise<ExecTab>;
  createTab: (url: string) => Promise<ExecTab>;
  inject: (tabId: number, func: (...args: never[]) => unknown, args?: unknown[]) => Promise<unknown>;
  loadPrefs: () => Promise<Record<string, unknown> | undefined>;
  // Browser-side navigation for authentication GET recovery, always to a
  // freshly validated owned tab/allowed target. Loaded retry paths fail
  // closed without it; optional for executor-only dependency harnesses.
  navigateTab?: (tabId: number, url: string) => Promise<unknown>;
  // A checkpoint must commit before any DOM mutation. Failure throws and
  // prevents injection; an interrupted checkpoint parks on worker wake.
  saveState: (state: EngineState) => Promise<void>;
  isCancelled?: () => boolean;
  // Best-effort local history only; never awaited or allowed to gate an action.
  onBookingAttempt?: (state: EngineState) => void;
  // Best-effort bounded local developer diagnostics (fixed allowlisted codes
  // only). Fire-and-forget by contract: recording never blocks, gates or
  // alters a booking/authentication/engine action. Optional so unit
  // harnesses without a diagnostics recorder stay unchanged.
  recordDiagnostic?: (event: DiagnosticEvent) => void;
};

class ExecutorContextError extends Error {
  constructor(readonly code: FailureCode) { super('Executor context changed.'); }
}
function executionFailureCode(error: unknown): FailureCode {
  return error instanceof ExecutorContextError ? error.code : 'adapter-execution-failed';
}

type Prefs = {
  consulates: Consulate[];
  earliest: string;
  latest: string;
  onlyEarlier: boolean;
  autoMode: boolean;
  policyKey: string;
};
async function readPrefs(deps: ExecDeps): Promise<Prefs | null> {
  const raw = await deps.loadPrefs();
  const autoMode = readAutoMode(raw);
  const consulates = selectedConsulates(raw);
  if (!raw || !consulates || consulates.length === 0 ||
      typeof raw.earliest !== 'string' || typeof raw.latest !== 'string' || typeof raw.onlyEarlier !== 'boolean' || autoMode === null) return null;
  try { validatePreferences({ earliest: raw.earliest, latest: raw.latest, exclusions: [], onlyEarlier: raw.onlyEarlier }); }
  catch { return null; }
  return { consulates, earliest: raw.earliest, latest: raw.latest,
    onlyEarlier: raw.onlyEarlier, autoMode, policyKey: policyKey(raw) };
}

// A stage owns one tab throughout the run. Reads revalidate immediately;
// page adapters repeat origin/group/roster checks inside the injected call.
// Each mutation keeps its own durable checkpoint. Matched-candidate field
// steps continue immediately after validated readiness, including the portal's
// change-triggered facility-days request. Navigation keeps its ordinary pacing.
export async function runBookingStage(deps: ExecDeps, initial: EngineState): Promise<EngineState> {
  let state = initial;
  if (state.status !== 'running' || state.authentication || !state.group || !state.stage) return state;
  const scheduleId = state.group.scheduleId;
  const owner = state.owner;
  const runId = state.runId;
  // Best-effort bounded developer diagnostics: fixed allowlisted codes only,
  // recorded around the existing decisions without ever changing them. The
  // current booking stage is attached when it is an allowlisted phase so
  // post-run analysis can place each retry/park/verification in its stage.
  const note = (code: DiagnosticEvent['code'], detail?: DiagnosticDetail, failures?: number): void => {
    const stage = state.stage;
    try { deps.recordDiagnostic?.({ code, ...(detail === undefined ? {} : { detail }), mode: 'booking', ...(isDiagnosticPhase(stage) ? { phase: stage } : {}),
      ...(failures === undefined ? {} : { failures }) }); } catch { /* Diagnostics never gate booking. */ }
  };
  const verify = (): EngineState => {
    note('executor-verification', 'action-unconfirmed');
    return { ...parkForReview(state, deps.nowIso()), stage: 'done',
      verification: { reads: [], nextReadAt: new Date(Date.parse(deps.nowIso()) + 30_000).toISOString() } };
  };
  // An interrupted mutation checkpoint (actionPending) with a durable intent
  // must route into scheduled verification, never park without a deadline.
  // Explicit cancellation still parks bare; other guards with an intent also
  // schedule verification instead of stalling. The caller passes the exact
  // fixed reason so post-run analysis never reads a generic stage guard.
  const parkBare = (detail: DiagnosticDetail | FailureCode, step = bookingFailureStep(state.stage)) => {
    note('executor-park', isDiagnosticDetail(detail) ? detail : undefined);
    return parkForReview(state, deps.nowIso(), blockedFailureContext(detail, step));
  };
  const park = (detail: DiagnosticDetail | FailureCode, step?: FailureStep) => (state.intent && !deps.isCancelled?.() ? verify() : parkBare(detail, step));
  if (state.executor?.actionPending && state.intent) return verify();
  if (state.mode !== 'booking') return park('executor-mode-invalid');
  if (state.group.kind !== 'paid') return park('executor-group-unpaid');
  if (!owner) return park('executor-owner-missing');
  if (!runId) return park('executor-run-missing');
  if (state.executor?.actionPending && !isEntryCheckpoint(state)) return park('checkpoint-interrupted');
  if (state.stage === 'confirm' && !state.intent) return park('confirmation-intent-missing');
  if (state.intent && !(state.stage === 'confirm' && state.intent.phase === 'submitted' && state.intent.runId === runId && state.intent.groupId === scheduleId))
    return park('confirmation-intent-mismatch');
  const prefs = await readPrefs(deps);
  if (deps.isCancelled?.()) return park('cancelled');
  if (!state.startedAt || Date.parse(deps.nowIso()) - Date.parse(state.startedAt) >= SESSION_AGE_MINUTES * 60_000 ||
      (state.policyKey !== null && state.policyKey !== prefs?.policyKey)) return park('config-changed');
  const windowPrefs = prefs && { earliest: prefs.earliest, latest: prefs.latest, exclusions: [], onlyEarlier: prefs.onlyEarlier };
  if (!prefs || !windowPrefs) return park('config-changed');
  if (state.lastCandidate !== null && !canBook(state.lastCandidate.date, state.group.currentDate, windowPrefs)) return park('candidate-invalid');
  // Monitoring never fills a candidate or creates a booking intent. This also
  // protects a persisted candidate stage after an upgrade or a direct call;
  // the worker owns notifications and continues its normal paced polls.
  if (!prefs.autoMode && state.lastCandidate !== null && !state.intent) {
    return { ...applyPollResult(state, { outcome: 'healthy', now: deps.nowIso(), random: deps.random }),
      stage: null, lastCandidate: null, executor: state.executor && { ...state.executor, targetTime: null } };
  }
  if (state.stage === 'actions' && !state.group.applicantIds) return park('roster-missing');
  const prefsUnchanged = async () => JSON.stringify(await readPrefs(deps)) === JSON.stringify(prefs);
  const pace = (stage: BookingStage, delayMs = state.lastCandidate !== null &&
    ((state.stage === 'form' && stage === 'form') || stage === 'confirm') ? 0 : 2_000): EngineState => ({
    ...setStage(state, stage, deps.nowIso()),
    nextPollAt: new Date(Date.parse(deps.nowIso()) + delayMs).toISOString(), updatedAt: deps.nowIso(),
  });
  const retry = (detail: DiagnosticDetail = 'transport'): EngineState => {
    if (state.intent) return verify();
    if (deps.isCancelled?.()) return parkBare('cancelled');
    const next = applyPollResult(state, { outcome: 'retryable', now: deps.nowIso(), random: deps.random });
    note('executor-retry', detail, next.consecutiveFailures);
    return next;
  };
  const recoverEntry = (): EngineState => {
    const failed = retry('reply-missing');
    if (failed.status !== 'running' || failed.intent) return failed;
    const renewed = beginAuthentication(failed, 'renew', deps.nowIso(), deps.random);
    return renewed.authentication ? { ...renewed, nextPollAt: failed.nextPollAt, cooldownUntil: failed.cooldownUntil } : renewed;
  };
  // Both dashboard handoff and sole-applicant re-entry use fresh baseline
  // GETs. A classified transport failure needs the shared retry/cooldown
  // budget, not a permanent safety pause. Invalid/changed readings still
  // reach the strict baseline/roster checks; unresolved intent never retries.
  const baselineFailure = (raw: unknown): EngineState | null => {
    const reading = raw as { scheduleId?: unknown; ivr?: unknown; kind?: unknown; status?: unknown } | null;
    if (state.intent || reading?.kind !== 'read-failure') return null;
    // The schedule is the primary identity; a null (unreadable) IVR on either
    // side never fabricates a mismatch, while a readable disagreement or a
    // malformed/missing field stays terminal.
    const readingIvr = normalizeReadingIvr(reading.ivr);
    if (reading.scheduleId !== scheduleId || readingIvr === undefined ||
        (readingIvr !== null && state.group!.ivr !== null && readingIvr !== state.group!.ivr)) return park('group-changed');
    if (deps.isCancelled?.()) return park('cancelled');
    if (typeof reading.status !== 'number' || !Number.isInteger(reading.status) || reading.status < 0 || reading.status > 599) return retry('reply-malformed');
    return mapHttpStatus(reading.status) === 'denied'
      ? applyPollResult(state, { outcome: 'denied', now: deps.nowIso(), random: deps.random }) : retry();
  };
  const entrySource = (value: string | undefined): boolean => {
    if (trustedRenewalUrl(state, value)) return true;
    // The audited initial-booking link can briefly be on /continue before
    // redirecting to the form. It is only a source for replacing a known GET.
    try {
      const url = new URL(value ?? '');
      return state.executor?.entryAction === 'schedule' && url.origin === 'https://ais.usvisa-info.com' &&
        !url.username && !url.password && !url.port && !url.search && !url.hash &&
        url.pathname === `/en-ca/niv/schedule/${scheduleId}/continue`;
    } catch { return false; }
  };
  const trusted = (tab: ExecTab) => tab.url !== undefined &&
    ((isEntryCheckpoint(state) && entrySource(tab.url)) || (['actions', 'appointment'].includes(classifyRoute(tab.url)) && isSameGroupUrl(tab.url, scheduleId)) ||
      (state.stage === 'actions' && state.group!.dashboardPath !== undefined && classifyRoute(tab.url) === 'dashboard' &&
        new URL(tab.url).pathname === state.group!.dashboardPath));
  const recoverBaseline = async (reading: unknown): Promise<EngineState> => {
    if (state.intent) return verify();
    if (deps.isCancelled?.() || !await prefsUnchanged()) return park('config-changed');
    const live = await deps.getTab(state.executor!.tabId);
    if (!trusted(live) || live.url !== owned.url || live.status === 'loading' ||
        (live.pendingUrl && live.pendingUrl !== 'about:blank')) return park('untrusted-url');
    if (deps.isCancelled?.() || !await prefsUnchanged()) return park('config-changed');
    if (deps.isCancelled?.()) return park('cancelled');
    state = adoptAppointmentBaseline(state, reading, deps.nowIso());
    // Re-enter on the owned tab with the new baseline and no stale candidate.
    // This also selects the correct initial/reschedule gateway after a
    // booked/unbooked transition. No click is authorized by this read alone.
    return beginAuthentication(state, 'renew', deps.nowIso(), deps.random, true);
  };
  const baselineInvalid = (error: unknown): EngineState => {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Appointment identity changed.') return park('group-changed');
    if (message === 'Applicant roster changed.') return park('roster-changed');
    return retry('reply-malformed');
  };
  if (!state.executor) {
    // Legacy downstream stages cannot bootstrap their expected roster from
    // the same form they intend to validate.
    if (state.stage !== 'actions' && state.stage !== 'applicants') return park('executor-missing');
    const tabs = (await deps.queryTabs()).filter(tab => trusted(tab) &&
      (state.stage === 'actions' ? classifyRoute(tab.url!) === 'actions' : classifyRoute(tab.url!) === 'appointment'));
    if (tabs.length > 1) return park('executor-tab-ambiguous');
    let tab = tabs[0];
    if (!tab) {
      if (state.stage !== 'actions') return park('executor-tab-missing');
      tab = await deps.createTab(`https://ais.usvisa-info.com/en-ca/niv/schedule/${scheduleId}/continue_actions`);
      if (tab.id === undefined) return retry();
      state = { ...state, executor: { tabId: tab.id, applicantIds: state.group!.applicantIds ?? null, targetTime: null, skippedDates: [], actionPending: false } };
      return pace('actions'); // wait for load; never inject into a new blank tab
    }
    if (tab.id === undefined) return park('executor-tab-missing');
    state = { ...state, executor: { tabId: tab.id, applicantIds: state.group!.applicantIds ?? null, targetTime: null, skippedDates: [], actionPending: false } };
  }
  if (state.group!.applicantIds && state.executor!.applicantIds && !sameApplicants(state.group!.applicantIds, state.executor!.applicantIds)) return park('roster-changed');
  const tabId = state.executor!.tabId;
  let owned: ExecTab;
  try { owned = await deps.getTab(tabId); } catch { return park('tab-lost'); }
  if (!trusted(owned) || (owned.pendingUrl && owned.pendingUrl !== 'about:blank' && !trusted({ url: owned.pendingUrl }))) return park('untrusted-url');
  try {
    if (!state.executor!.actionPending && await observeMaintenance(deps, state, tabId)) {
      if (state.intent) return verify();
      if (!await prefsUnchanged()) return park('config-changed');
      note('poll-maintenance', 'maintenance');
      return recoverMaintenance(state, tabId, deps.nowIso(), deps.random);
    }
  } catch { /* No outage evidence: retain ordinary stage/read guards below. */ }
  if (owned.status === 'loading') {
    const loadingSince = state.executor!.loadingSince ?? deps.nowIso();
    const elapsed = Date.parse(deps.nowIso()) - Date.parse(loadingSince);
    if (elapsed < 0) return park('clock-invalid');
    if (elapsed >= 15_000) {
      // An uncertain booking intent never retries on readiness alone: the
      // stalled load routes into the existing fresh verification. Without an
      // intent the readiness stall is recoverable: count it once, clear the
      // loading marker, and — only after re-confirming cancellation,
      // preferences and live trust — give the same trusted document one
      // fresh browser GET (never DOM injection).
      if (state.intent) return verify();
      if (deps.isCancelled?.() || !await prefsUnchanged()) return park(deps.isCancelled?.() ? 'cancelled' : 'config-changed');
      const { loadingSince: _stalled, ...executor } = state.executor!;
      const next = { ...retry('stalled-load'), executor, updatedAt: deps.nowIso() };
      if (!deps.navigateTab) return next;
      try {
        const live = await deps.getTab(tabId);
        if (live.url !== owned.url || live.status !== 'loading' || !trusted(live) ||
            (live.pendingUrl && live.pendingUrl !== 'about:blank') || deps.isCancelled?.() || !await prefsUnchanged()) return next;
        await deps.navigateTab(tabId, owned.url!);
      } catch { /* The counted retry already holds; the reload is best effort. */ }
      return next;
    }
    state = { ...state, executor: { ...state.executor!, loadingSince } };
    return pace(state.stage as BookingStage, 2_000);
  }
  if (state.executor!.loadingSince !== undefined) {
    const { loadingSince, ...executor } = state.executor!;
    state = { ...state, executor };
  }
  const rebuild = async (detail: FailureCode, entry = false): Promise<EngineState> => {
    if (state.intent) return verify();
    if (entry && !isEntryCheckpoint(state)) return parkBare('checkpoint-interrupted');
    if (deps.isCancelled?.()) return parkBare('cancelled');
    if (!await prefsUnchanged()) return parkBare('config-changed');
    if (!state.group!.applicantIds || !sameApplicants(state.group!.applicantIds, state.executor!.applicantIds)) return parkBare('roster-changed');
    let live: ExecTab;
    try { live = await deps.getTab(tabId); } catch { return parkBare('tab-lost'); }
    // Preliminary GET actions can already have reached a trusted destination.
    // Inspect custody, then abandon the uncertain action through a fixed GET.
    // Field/form recovery requires the original quiet document instead.
    if (entry ? (!entrySource(live.url) || (live.pendingUrl && !entrySource(live.pendingUrl))) :
        (live.url !== owned.url || !trusted(live) || live.status === 'loading' || (live.pendingUrl && live.pendingUrl !== 'about:blank')))
      return parkBare('untrusted-url');
    if (deps.isCancelled?.()) return parkBare('cancelled');
    if (!await prefsUnchanged()) return parkBare('config-changed');
    const failures = entry ? state.entryRecoveryFailures ?? 0 : state.formLoadFailures ?? 0;
    const failed = applyPollResult({ ...state, consecutiveFailures: failures, failureContext: null, lastCandidate: null, stage: null,
      executor: { ...state.executor!, entryAction: undefined, actionPending: false, targetTime: null, skippedDates: [] } },
      { outcome: 'retryable', now: deps.nowIso(), random: deps.random });
    note('executor-retry', isDiagnosticDetail(detail) ? detail : undefined, failed.consecutiveFailures);
    const renewed = beginAuthentication({ ...failed,
      ...(entry ? { entryRecoveryFailures: failed.cooldownUntil ? 0 : failed.consecutiveFailures }
        : { formLoadFailures: failed.cooldownUntil ? 0 : failed.consecutiveFailures }) }, 'renew', deps.nowIso(), deps.random, true);
    return renewed.authentication ? { ...renewed, nextPollAt: failed.nextPollAt, cooldownUntil: failed.cooldownUntil,
      authentication: { ...renewed.authentication, phase: 'retry' } } : renewed;
  };
  const skipCandidate = async (): Promise<EngineState> => {
    if (state.intent) return verify();
    if (deps.isCancelled?.() || !await prefsUnchanged()) return park(deps.isCancelled?.() ? 'cancelled' : 'config-changed');
    if (!state.lastCandidate) return park('candidate-invalid');
    const { consulate, date } = state.lastCandidate;
    return { ...applyPollResult(state, { outcome: 'healthy', now: deps.nowIso(), random: deps.random }),
      stage: null, lastCandidate: null, failureContext: null,
      executor: { ...state.executor!, entryAction: undefined, actionPending: false, targetTime: null,
        skippedDates: [...state.executor!.skippedDates.filter(entry => !(entry.consulate === consulate && entry.date === date)), { consulate, date }] } };
  };
  if (isEntryCheckpoint(state)) return rebuild('checkpoint-interrupted', true);
  const inject = async (func: (...args: never[]) => unknown, args: unknown[]): Promise<unknown> => {
    let tab: ExecTab;
    try { tab = await deps.getTab(tabId); } catch { throw new ExecutorContextError('tab-unavailable'); }
    if (!trusted(tab)) throw new ExecutorContextError('untrusted-navigation');
    if (tab.pendingUrl && tab.pendingUrl !== 'about:blank') throw new ExecutorContextError('tab-navigation-pending');
    if (tab.status === 'loading') throw new ExecutorContextError('tab-loading');
    if (deps.isCancelled?.()) throw new ExecutorContextError('cancelled');
    return deps.inject(tabId, func, args);
  };
  if (classifyRoute(owned.url!) === 'dashboard') {
    if (!state.group!.dashboardPath) return park('dashboard-path-missing');
    if (!state.group!.applicantIds) return park('roster-missing');
    if (!await prefsUnchanged()) return park('config-changed');
    // The pre-continue baseline read is read-only: a transient interruption
    // or malformed reply retries on the shared budget with a full re-read
    // before the mutation below; only a changed baseline stays terminal.
    let baseline: unknown;
    try { baseline = await inject(readCurrentAppointment, [scheduleId, state.group!.ivr, true, true, state.group!.dashboardPath, true]); }
    catch { return retry('script-interrupted'); }
    const failure = baselineFailure(baseline);
    if (failure) return failure;
    let baselineDate: string | null;
    try { baselineDate = appointmentDate(baseline, state.group!); }
    catch (error) { return baselineInvalid(error); }
    if (baselineDate !== state.group!.currentDate) return recoverBaseline(baseline);
    state = { ...state, executor: { ...state.executor!, entryAction: 'dashboard-continue', actionPending: true }, updatedAt: deps.nowIso() };
    await deps.saveState(state);
    if (deps.isCancelled?.() || !await prefsUnchanged()) return park(deps.isCancelled?.() ? 'cancelled' : 'config-changed');
    try {
      const result = await inject(performDashboardContinue, [{ scheduleId, ivr: state.group!.ivr,
        dashboardPath: state.group!.dashboardPath, applicantIds: state.group!.applicantIds }]) as { ok?: boolean };
      if (result?.ok !== true) return result?.ok === false ? park('navigation-unconfirmed') : rebuild('navigation-unconfirmed', true);
    } catch (error) {
      if (error instanceof ExecutorContextError) return park(error.code);
      return rebuild('navigation-unconfirmed', true);
    }
    state = { ...state, executor: { ...state.executor!, entryAction: undefined, actionPending: false } };
    return pace('actions');
  }
  let implicitApplicantId: string | null = null;
  if (state.group!.pendingInspection) note('payment-inspection-attempted');
  let page: PaidPage | null;
  try {
    page = await inject(readPaidPage, state.group!.pendingInspection ? [scheduleId, null, true] : [scheduleId]) as PaidPage;
    if (!page && state.group!.applicantIds?.length === 1 &&
        sameApplicants(state.executor!.applicantIds, state.group!.applicantIds) && classifyRoute(owned.url!) === 'appointment' &&
        isBareAppointmentQuery(new URL(owned.url!))) {
      // Revalidate the independent complete roster before relying on a form
      // with no applicant IDs. Warning/selection pages keep their own guards.
      if (!state.group!.dashboardPath) return park('dashboard-path-missing');
      let baseline: unknown;
      try { baseline = await inject(readCurrentAppointment, [scheduleId, state.group!.ivr, true, true, state.group!.dashboardPath, true]); }
      catch { return retry('script-interrupted'); }
      const failure = baselineFailure(baseline);
      if (failure) return failure;
      let baselineDate: string | null;
      try { baselineDate = appointmentDate(baseline, state.group!); }
      catch (error) { return baselineInvalid(error); }
      if (baselineDate !== state.group!.currentDate) return recoverBaseline(baseline);
      implicitApplicantId = state.group!.applicantIds[0];
      page = await inject(readPaidPage, state.group!.pendingInspection ? [scheduleId, implicitApplicantId, true] : [scheduleId, implicitApplicantId]) as PaidPage;
    }
  } catch { return retry('script-interrupted'); }
  // A missing reply or a foreign schedule never mutates or retries blindly:
  // the missing read retries read-only on the shared budget, while a page for
  // a different group stays terminal.
  if (!page) return recoverEntry();
  if (page.scheduleId !== scheduleId) return park('group-changed');
  if (page.kind === 'form' && sameApplicants(page.applicantIds, state.group!.applicantIds)) state = { ...state, entryRecoveryFailures: 0 };
  if ((state.stage === 'warning' || state.stage === 'applicants') && page.kind === 'form') {
    const expected = state.group!.applicantIds ?? state.executor!.applicantIds;
    if (!expected || !sameApplicants(page.applicantIds, expected)) return park('roster-changed');
    state = { ...state, executor: { ...state.executor!, applicantIds: expected } };
    return pace('form');
  }
  if (state.stage === 'warning' && page.kind === 'applicants') return pace('applicants');

  const act = async (request: PaidAction, nextStage: BookingStage): Promise<EngineState> => {
    const actionStep = paidActionStep(request.action);
    // Reread durable Auto Mode and policy immediately before the mutation.
    if (deps.isCancelled?.() || !await prefsUnchanged()) return park(deps.isCancelled?.() ? 'cancelled' : 'config-changed');
    const entryAction = ['schedule', 'reschedule', 'warning', 'applicants'].includes(request.action) ? request.action as NonNullable<EngineState['executor']>['entryAction'] : undefined;
    state = { ...state, failureContext: blockedFailureContext('checkpoint-interrupted', actionStep), executor: { ...state.executor!, entryAction, actionPending: true }, updatedAt: deps.nowIso() };
    await deps.saveState(state);
    if (deps.isCancelled?.()) return park('cancelled');
    let result: ActResult;
    try { result = await inject(performPaidAction, [implicitApplicantId ? { ...request, implicitApplicantId } : request]) as ActResult; }
    catch (error) {
      if (entryAction && !(error instanceof ExecutorContextError)) return rebuild('adapter-execution-failed', true);
      return park(executionFailureCode(error), actionStep);
    }
    if (entryAction && result == null) return rebuild('adapter-reply-missing', true);
    if (result?.ok === false && !state.intent &&
        ((request.action === 'facility' && result.reason === 'facility-date-unavailable') ||
         (request.action === 'time' && result.reason === 'time-option-unavailable'))) return skipCandidate();
    const transient = request.action === 'date' ? ['calendar-load-timeout', 'calendar-network-failed', 'calendar-server-error', 'calendar-request-denied', 'calendar-request-retryable'] :
      request.action === 'facility' ? ['facility-load-timeout', 'facility-network-failed', 'facility-server-error', 'facility-request-denied', 'facility-request-retryable'] : [];
    if (result?.ok === false && transient.includes(result.reason)) return rebuild(adapterFailureCode(result));
    if (!result || result.ok !== true) return park(adapterFailureCode(result), actionStep);
    state = { ...state, failureContext: null,
      executor: { ...state.executor!, entryAction: undefined, actionPending: false } };
    return pace(result.advanced === false ? state.stage as BookingStage : nextStage);
  };
  const request = { scheduleId };
  const submission = (action: SubmissionRequest['action'], date: string, time: string): SubmissionRequest => ({
    action, scheduleId, applicantIds: state.executor!.applicantIds!, facilityId: CONSULATES[state.lastCandidate!.consulate], date, time,
    earliest: prefs.earliest, latest: prefs.latest, currentDate: state.group!.currentDate,
    currentDateTag: state.group!.currentDate === null ? 'unbooked' : 'booked',
    // Serialized submit guards/intents retain their inverse legacy bit.
    onlyEarlier: prefs.onlyEarlier, testMode: !prefs.autoMode,
    ...(implicitApplicantId ? { implicitApplicantId } : {}),
  });
  const baselineGuard = async (): Promise<EngineState | null> => {
    if (!state.group!.applicantIds) return park('roster-missing');
    let baseline: unknown;
    try {
      baseline = await inject(readCurrentAppointment, [scheduleId, state.group!.ivr, true, true, state.group!.dashboardPath, true]);
    } catch { return retry('script-interrupted'); }
    const failure = baselineFailure(baseline);
    if (failure) return failure;
    try {
      return appointmentDate(baseline, state.group!) === state.group!.currentDate ? null : await recoverBaseline(baseline);
    } catch (error) { return baselineInvalid(error); }
  };
  switch (state.stage) {
    case 'confirm': {
      const intent = state.intent!;
      const time = state.executor!.targetTime;
      if (!time || intent.targetDate !== state.lastCandidate?.date || intent.testMode !== !prefs.autoMode || intent.consulate !== state.lastCandidate?.consulate ||
          page.kind !== 'form' || page.slotWarning === true || page.calendarReady !== true ||
          page.date !== intent.targetDate || page.time !== time) return verify();
      if (!prefs.autoMode) return verify();
      // This injected wait only reads the bound document. It cannot click,
      // submit or replay anything; Stop/settings changes are checked after
      // it returns and again after the durable confirmation checkpoint.
      // The original intent timestamp bounds waiting across worker wakes.
      const remaining = Math.max(0, Math.min(15_000, 15_000 - (Date.parse(deps.nowIso()) - Date.parse(intent.createdAt))));
      try {
        const ready = await inject(waitForAppointmentDialog, [submission('confirm', intent.targetDate, time), remaining]) as { ok?: boolean };
        if (deps.isCancelled?.()) return parkBare('cancelled');
        if (ready?.ok !== true) return verify();
      } catch { return park('adapter-execution-failed', 'booking-confirm'); }
      if (deps.isCancelled?.() || !await prefsUnchanged()) return park('config-changed');
      const refused = await baselineGuard();
      if (refused) return refused;
      state = { ...state, intent: { ...intent, phase: 'confirming' }, executor: { ...state.executor!, actionPending: true }, updatedAt: deps.nowIso() };
      // Durable mutation checkpoint before the final confirmation click. An
      // interrupted checkpoint or click must route into automatic verification
      // (never a replay), preserving the 30s post-attempt delay and three
      // paced reads.
      try { await deps.saveState(state); } catch { return verify(); }
      if (deps.isCancelled?.() || !await prefsUnchanged()) return verify();
      try { await inject(performAppointmentSubmission, [submission('confirm', intent.targetDate, time)]); } catch { return verify(); }
      state = { ...state, executor: { ...state.executor!, actionPending: false } };
      return verify();
    }
    case 'actions':
      if (page.kind !== 'actions') return park('page-kind-mismatch');
      return act({ ...request, action: state.group!.currentDate === null ? 'schedule' : 'reschedule' }, 'warning');
    case 'warning':
      if (page.kind !== 'warning') return park('page-kind-mismatch');
      return act({ ...request, action: 'warning' }, 'applicants');
    case 'applicants': {
      if (page.kind !== 'applicants') return park('page-kind-mismatch');
      if (!Array.isArray(page.applicants)) return park('applicant-selection-malformed');
      if (page.applicants.some(entry => entry.checked !== true || entry.disabled !== false)) return park('applicant-selection-invalid');
      let ids: string[];
      try { ids = validateApplicantIds(page.applicants.map(entry => entry.id)); } catch { return park('applicant-selection-malformed'); }
      if (state.group!.applicantIds && !sameApplicants(state.group!.applicantIds, ids)) return park('roster-changed');
      if (state.executor!.applicantIds && !sameApplicants(state.executor!.applicantIds, ids)) return park('roster-changed');
      state = { ...state, executor: { ...state.executor!, applicantIds: ids } };
      return act({ ...request, action: 'applicants', applicantIds: ids }, 'form');
    }
    case 'form': {
      const ids = state.executor!.applicantIds;
      if (page.kind !== 'form') return park('page-kind-mismatch');
      if (!ids) return park('roster-missing');
      if (!sameApplicants(page.applicantIds, ids)) return park('roster-changed');
      if (state.group!.pendingInspection) {
        // Actual form controls and the independent bound roster/baseline,
        // not a continue_actions URL, establish booking capability.
        if (!sameApplicants(state.group!.applicantIds, ids)) return park('roster-changed');
        const refused = await baselineGuard();
        if (refused) return refused;
        if (deps.isCancelled?.() || !await prefsUnchanged()) return park('config-changed');
        const { pendingInspection: _resolved, ...group } = state.group!;
        state = { ...state, group, updatedAt: deps.nowIso() };
        await deps.saveState(state);
        note('payment-inspection-resolved');
      }
      if (state.lastCandidate === null) {
        if (!await prefsUnchanged()) return park('config-changed');
        if (state.consecutiveFailures > 0) note('executor-recovered', undefined, 0);
        return { ...applyPollResult(state, { outcome: 'healthy', now: deps.nowIso(), random: deps.random }),
          nextPollAt: deps.nowIso(), stage: null, executor: { ...state.executor!, targetTime: null } };
      }
      const consulate = state.lastCandidate!.consulate;
      // A candidate whose consulate is no longer selected never reaches a
      // field change; the final guard would refuse it anyway.
      if (!prefs.consulates.includes(consulate)) return park('config-changed');
      const facilityId = CONSULATES[consulate];
      const date = state.lastCandidate!.date;
      const fields = { ...request, applicantIds: ids, facilityId, date };
      if (page.facilityId !== facilityId) {
        state = { ...state, executor: { ...state.executor!, targetTime: null } };
        return act({ ...fields, action: 'facility' }, 'form');
      }
      if (page.date !== date || page.calendarReady !== true) {
        state = { ...state, executor: { ...state.executor!, targetTime: null } };
        return act({ ...fields, action: 'date' }, 'form');
      }
      let time = state.executor!.targetTime;
      if (time === null || page.time !== time) {
        let response: PollResponse;
        try { response = await inject(fetchTimesJson, [`/en-ca/niv/schedule/${scheduleId}/appointment`, facilityId, date, ids, implicitApplicantId]) as PollResponse; }
        catch { return retry('script-interrupted'); }
        if (!response || mapHttpStatus(response.status) !== 'ok') {
          return response && mapHttpStatus(response.status) === 'denied'
            ? applyPollResult(state, { outcome: 'denied', now: deps.nowIso(), random: deps.random }) : retry();
        }
        let times: string[];
        try { times = parseTimesPayload(response.body); } catch { return retry('reply-malformed'); }
        if (!times.length) {
          // Candidate disappeared; discard it and return to days polling.
          return { ...applyPollResult(state, { outcome: 'healthy', now: deps.nowIso(), random: deps.random }),
            stage: null, lastCandidate: null,
            executor: { ...state.executor!, targetTime: null,
            skippedDates: [...state.executor!.skippedDates.filter(entry => !(entry.consulate === consulate && entry.date === date)),
              { consulate, date }] } };
        }
        time = [...times].sort()[0];
        state = { ...state, executor: { ...state.executor!, targetTime: time } };
      }
      if (page.time !== time) return act({ ...fields, action: 'time', time }, 'form');
      // This read comes after any field changes in a prior alarm. The IDs
      // expected here were bound from the dashboard before gateway entry,
      // never copied from this form's query.
      if (!await prefsUnchanged()) return park('config-changed');
      let fresh: PaidPage;
      try { fresh = await inject(readPaidPage, [scheduleId, implicitApplicantId]) as PaidPage; } catch { return retry('script-interrupted'); }
      if (!fresh) return rebuild('form-read-missing');
      if (fresh.scheduleId !== scheduleId) return park('group-changed');
      if (!sameApplicants(fresh.applicantIds, ids)) return park('roster-changed');
      if (fresh.kind !== 'form') return park('page-kind-mismatch', 'booking-form-read');
      if (fresh.calendarReady !== true) return rebuild('calendar-not-ready');
      if (fresh.slotWarning === true) return skipCandidate();
      if (fresh.date !== date) return rebuild('form-date-mismatch');
      if (fresh.time !== time) return rebuild('form-time-mismatch');
      if (typeof fresh.facilityId !== 'number') return park('form-facility-invalid', 'booking-form-read');
      const refused = await baselineGuard();
      if (refused) return refused;
      const expected = { scheduleId, applicantIds: ids, consulate, selected: prefs.consulates, currentDate: state.group!.currentDate,
        prefs: windowPrefs, testMode: false };
      try {
        const form = { ...fresh, facilityId: fresh.facilityId };
        const verdict = guardBooking(form, expected);
        if (!verdict.allowed) return park(`booking-policy-${verdict.reason}`, 'booking-policy-check');
        const locked = guardBooking(form, { ...expected, testMode: true });
        if (locked.allowed || locked.reason !== 'test-mode') return park('test-mode-guard-inconsistent', 'booking-policy-check');
      } catch { return park('booking-form-invalid', 'booking-policy-check'); }
      state = { ...state, formLoadFailures: 0 };
      if (fresh.warningAcknowledged === false) {
        if (!await prefsUnchanged() || deps.isCancelled?.()) return park(deps.isCancelled?.() ? 'cancelled' : 'config-changed');
        state = { ...state, executor: { ...state.executor!, actionPending: true } };
        await deps.saveState(state);
        if (deps.isCancelled?.() || !await prefsUnchanged()) return park(deps.isCancelled?.() ? 'cancelled' : 'config-changed');
        try {
          const result = await inject(performAppointmentSubmission, [submission('acknowledge', date, time)]) as { ok?: boolean };
          if (result?.ok !== true) return park(result == null ? 'adapter-reply-missing' : 'warning-acknowledgement-refused', 'booking-warning-acknowledge');
        } catch (error) { return park(executionFailureCode(error), 'booking-warning-acknowledge'); }
        state = { ...state, executor: { ...state.executor!, actionPending: false } };
        return pace('form');
      }
      if (!prefs.autoMode) {
        // Defense in depth: only explicit Auto Mode ON may submit.
        if (!await prefsUnchanged() || deps.isCancelled?.()) return park(deps.isCancelled?.() ? 'cancelled' : 'config-changed');
        return { ...applyPollResult(state, { outcome: 'healthy', now: deps.nowIso(), random: deps.random }), stage: null };
      }
      // Live submission (Auto Mode explicitly ON, user authorization October
      // 15, 2026 for the no-gate case only): click the validated
      // Schedule/Reschedule submit with a valid gate or with a fully absent
      // gate. A valid gate opens the recognized confirmation dialog for
      // the readiness-driven confirm stage; an absent gate submits directly and the
      // confirm stage finds no dialog and routes into verification. A
      // present-but-malformed gate refuses inside the injected adapter
      // without clicking and routes into verification below.
      // Unknown/ambiguous dialogs are never blindly confirmed. The submit
      // click itself can finalize booking, so the durable booking intent AND
      // the mutation checkpoint are both persisted BEFORE the click.
      // Interrupted, failed or uncertain submits never replay: they route
      // into the existing fresh verification with its settling deadlines.
      if (!await prefsUnchanged() || deps.isCancelled?.()) return park(deps.isCancelled?.() ? 'cancelled' : 'config-changed');
      state = recordIntent(state, { owner, runId, now: deps.nowIso(), intent: {
        runId, mode: 'booking', groupId: scheduleId, targetDate: fresh.date,
        consulate, testMode: !prefs.autoMode, createdAt: deps.nowIso(), phase: 'prepared',
      } });
      state = { ...state, executor: { ...state.executor!, actionPending: true } };
      try { await deps.saveState(state); } catch { return verify(); }
      if (deps.isCancelled?.() || !await prefsUnchanged()) return verify();
      const noteAttempt = () => { try { deps.onBookingAttempt?.(state); } catch { /* History is independent of booking. */ } };
      try {
        const result = await inject(performAppointmentSubmission, [submission('submit', date, time)]) as { ok?: boolean };
        // Explicit refusal proves the guard never clicked. A missing reply
        // cannot establish that, so it stays an unconfirmed attempt.
        if (result?.ok !== false) noteAttempt();
        if (result?.ok !== true) return verify();
      } catch { noteAttempt(); return verify(); }
      state = { ...state, intent: { ...state.intent!, phase: 'submitted' }, executor: { ...state.executor!, actionPending: false } };
      return pace('confirm');
    }
    default: return park('booking-stage-unrecognized');
  }
}
