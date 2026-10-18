import { canBook, CONSULATES, validatePreferences } from '../domain/dates';
import { guardBooking } from '../domain/booking';
import { readAutoMode } from '../domain/auto-mode';
import { sameApplicants, validateApplicantIds } from '../domain/applicants';
import { parseTimesPayload } from '../domain/availability';
import { classifyRoute } from '../domain/routes';
import { isSameGroupUrl } from '../domain/trust';
import { mapHttpStatus, SESSION_AGE_MINUTES } from '../domain/timing';
import { isDiagnosticPhase, type DiagnosticDetail, type DiagnosticEvent } from '../domain/diagnostics';
import { performPaidAction, type ActResult, type PaidAction } from '../adapter/acts';
import { readPaidPage, type PaidPage } from '../adapter/paid';
import { readCurrentAppointment } from '../adapter/reads';
import { appointmentDate } from '../domain/appointment';
import { fetchTimesJson, type PollResponse } from '../adapter/poll';
import { applyPollResult, setStage, type BookingStage } from './poll';
import { parkForReview, recordIntent, type EngineState } from './workflow';
import { policyKey } from './lifecycle';
import { beginAuthentication } from './authentication';
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

type Prefs = {
  consulate: keyof typeof CONSULATES;
  earliest: string;
  latest: string;
  onlyEarlier: boolean;
  autoMode: boolean;
  policyKey: string;
};
async function readPrefs(deps: ExecDeps): Promise<Prefs | null> {
  const raw = await deps.loadPrefs();
  const autoMode = readAutoMode(raw);
  if (!raw || typeof raw.consulate !== 'string' || !Object.hasOwn(CONSULATES, raw.consulate) ||
      typeof raw.earliest !== 'string' || typeof raw.latest !== 'string' || typeof raw.onlyEarlier !== 'boolean' || autoMode === null) return null;
  try { validatePreferences({ earliest: raw.earliest, latest: raw.latest, exclusions: [], onlyEarlier: raw.onlyEarlier }); }
  catch { return null; }
  return { consulate: raw.consulate as Prefs['consulate'], earliest: raw.earliest, latest: raw.latest,
    onlyEarlier: raw.onlyEarlier, autoMode, policyKey: policyKey(raw) };
}

// A stage owns one tab throughout the run. Reads revalidate immediately;
// page adapters repeat origin/group/roster checks inside the injected call.
// Each mutation keeps its own durable checkpoint. Matched-candidate field
// steps continue immediately after validated readiness, including the portal's
// change-triggered facility-days request. Navigation keeps its ordinary pacing.
export async function runBookingStage(deps: ExecDeps, initial: EngineState): Promise<EngineState> {
  let state = initial;
  if (state.status !== 'running' || !state.group || !state.stage) return state;
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
  const parkBare = (detail: DiagnosticDetail = 'stage-guard') => {
    note('executor-park', detail);
    return parkForReview(state, deps.nowIso());
  };
  const park = (detail?: DiagnosticDetail) => (state.intent && !deps.isCancelled?.() ? verify() : parkBare(detail));
  if (state.executor?.actionPending && state.intent) return verify();
  if (state.mode !== 'booking' || state.group.kind !== 'paid' || !owner || !runId || state.executor?.actionPending ||
      (state.stage === 'confirm' && !state.intent) ||
      (state.intent && !(state.stage === 'confirm' && state.intent.phase === 'submitted' && state.intent.runId === runId && state.intent.groupId === scheduleId))) return park();
  const prefs = await readPrefs(deps);
  if (deps.isCancelled?.()) return park('cancelled');
  if (!state.startedAt || Date.parse(deps.nowIso()) - Date.parse(state.startedAt) >= SESSION_AGE_MINUTES * 60_000 ||
      (state.policyKey !== null && state.policyKey !== prefs?.policyKey)) return park('config-changed');
  const windowPrefs = prefs && { earliest: prefs.earliest, latest: prefs.latest, exclusions: [], onlyEarlier: prefs.onlyEarlier };
  if (!prefs || !windowPrefs) return park('config-changed');
  if (state.lastCandidate !== null && !canBook(state.lastCandidate, state.group.currentDate, windowPrefs)) return park('candidate-invalid');
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
    if (reading.scheduleId !== scheduleId || reading.ivr !== state.group!.ivr) return park('group-changed');
    if (deps.isCancelled?.()) return park();
    if (typeof reading.status !== 'number' || !Number.isInteger(reading.status) || reading.status < 0 || reading.status > 599) return retry('reply-malformed');
    return mapHttpStatus(reading.status) === 'denied'
      ? applyPollResult(state, { outcome: 'denied', now: deps.nowIso(), random: deps.random }) : retry();
  };
  const trusted = (tab: ExecTab) => tab.url !== undefined &&
    ((['actions', 'appointment'].includes(classifyRoute(tab.url)) && isSameGroupUrl(tab.url, scheduleId)) ||
      (state.stage === 'actions' && state.group!.dashboardPath !== undefined && classifyRoute(tab.url) === 'dashboard' &&
        new URL(tab.url).pathname === state.group!.dashboardPath));
  const baselineInvalid = (error: unknown): EngineState => {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Appointment identity changed.') return park('group-changed');
    if (message === 'Applicant roster changed.') return park('roster-changed');
    return retry('reply-malformed');
  };
  if (!state.executor) {
    // Legacy downstream stages cannot bootstrap their expected roster from
    // the same form they intend to validate.
    if (state.stage !== 'actions' && state.stage !== 'applicants') return park();
    const tabs = (await deps.queryTabs()).filter(tab => trusted(tab) &&
      (state.stage === 'actions' ? classifyRoute(tab.url!) === 'actions' : classifyRoute(tab.url!) === 'appointment'));
    if (tabs.length > 1) return park();
    let tab = tabs[0];
    if (!tab) {
      if (state.stage !== 'actions') return park();
      tab = await deps.createTab(`https://ais.usvisa-info.com/en-ca/niv/schedule/${scheduleId}/continue_actions`);
      if (tab.id === undefined) return retry();
      state = { ...state, executor: { tabId: tab.id, applicantIds: state.group!.applicantIds ?? null, targetTime: null, skippedDates: [], actionPending: false } };
      return pace('actions'); // wait for load; never inject into a new blank tab
    }
    if (tab.id === undefined) return park();
    state = { ...state, executor: { tabId: tab.id, applicantIds: state.group!.applicantIds ?? null, targetTime: null, skippedDates: [], actionPending: false } };
  }
  if (state.group!.applicantIds && state.executor!.applicantIds && !sameApplicants(state.group!.applicantIds, state.executor!.applicantIds)) return park('roster-changed');
  const tabId = state.executor!.tabId;
  let owned;
  try { owned = await deps.getTab(tabId); } catch { return park('tab-lost'); }
  if (!trusted(owned) || (owned.pendingUrl && owned.pendingUrl !== 'about:blank' && !trusted({ url: owned.pendingUrl }))) return park('untrusted-url');
  if (owned.status === 'loading') {
    const loadingSince = state.executor!.loadingSince ?? deps.nowIso();
    const elapsed = Date.parse(deps.nowIso()) - Date.parse(loadingSince);
    if (elapsed < 0) return park();
    if (elapsed >= 15_000) {
      // An uncertain booking intent never retries on readiness alone: the
      // stalled load routes into the existing fresh verification. Without an
      // intent the readiness stall is recoverable: count it once, clear the
      // loading marker, and — only after re-confirming cancellation,
      // preferences and live trust — give the same trusted document one
      // fresh browser GET (never DOM injection).
      if (state.intent) return verify();
      if (deps.isCancelled?.() || !await prefsUnchanged()) return park();
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
  const inject = async (func: (...args: never[]) => unknown, args: unknown[]): Promise<unknown> => {
    const tab = await deps.getTab(tabId);
    if (!trusted(tab) || (tab.pendingUrl && tab.pendingUrl !== 'about:blank') || tab.status === 'loading' || deps.isCancelled?.()) throw new Error('Executor context changed.');
    return deps.inject(tabId, func, args);
  };
  if (classifyRoute(owned.url!) === 'dashboard') {
    if (!state.group!.dashboardPath || !state.group!.applicantIds || !await prefsUnchanged()) return park();
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
    if (baselineDate !== state.group!.currentDate) return park('baseline-changed');
    state = { ...state, executor: { ...state.executor!, actionPending: true }, updatedAt: deps.nowIso() };
    await deps.saveState(state);
    if (deps.isCancelled?.() || !await prefsUnchanged()) return park();
    try {
      const result = await inject(performDashboardContinue, [{ scheduleId, ivr: state.group!.ivr,
        dashboardPath: state.group!.dashboardPath, applicantIds: state.group!.applicantIds }]) as { ok?: boolean };
      if (result?.ok !== true) return park('navigation-unconfirmed');
    } catch { return park('navigation-unconfirmed'); }
    state = { ...state, executor: { ...state.executor!, actionPending: false } };
    return pace('actions');
  }
  let implicitApplicantId: string | null = null;
  let page: PaidPage | null;
  try {
    page = await inject(readPaidPage, [scheduleId]) as PaidPage;
    if (!page && state.group!.applicantIds?.length === 1 &&
        sameApplicants(state.executor!.applicantIds, state.group!.applicantIds) && classifyRoute(owned.url!) === 'appointment' &&
        !new URL(owned.url!).search) {
      // Revalidate the independent complete roster before relying on a form
      // with no applicant IDs. Warning/selection pages keep their own guards.
      if (!state.group!.dashboardPath) return park();
      let baseline: unknown;
      try { baseline = await inject(readCurrentAppointment, [scheduleId, state.group!.ivr, true, true, state.group!.dashboardPath, true]); }
      catch { return retry('script-interrupted'); }
      const failure = baselineFailure(baseline);
      if (failure) return failure;
      let baselineDate: string | null;
      try { baselineDate = appointmentDate(baseline, state.group!); }
      catch (error) { return baselineInvalid(error); }
      if (baselineDate !== state.group!.currentDate) return park('baseline-changed');
      implicitApplicantId = state.group!.applicantIds[0];
      page = await inject(readPaidPage, [scheduleId, implicitApplicantId]) as PaidPage;
    }
  } catch { return retry('script-interrupted'); }
  // A missing reply or a foreign schedule never mutates or retries blindly:
  // the missing read retries read-only on the shared budget, while a page for
  // a different group stays terminal.
  if (!page) return recoverEntry();
  if (page.scheduleId !== scheduleId) return park('group-changed');
  if ((state.stage === 'warning' || state.stage === 'applicants') && page.kind === 'form') {
    const expected = state.group!.applicantIds ?? state.executor!.applicantIds;
    if (!expected || !sameApplicants(page.applicantIds, expected)) return park('roster-changed');
    state = { ...state, executor: { ...state.executor!, applicantIds: expected } };
    return pace('form');
  }
  if (state.stage === 'warning' && page.kind === 'applicants') return pace('applicants');

  const act = async (request: PaidAction, nextStage: BookingStage): Promise<EngineState> => {
    // Reread durable Auto Mode and policy immediately before the mutation.
    if (deps.isCancelled?.() || !await prefsUnchanged()) return park();
    state = { ...state, executor: { ...state.executor!, actionPending: true }, updatedAt: deps.nowIso() };
    await deps.saveState(state);
    if (deps.isCancelled?.()) return park();
    let result: ActResult;
    try { result = await inject(performPaidAction, [implicitApplicantId ? { ...request, implicitApplicantId } : request]) as ActResult; }
    catch { return park(); }
    if (!result || result.ok !== true) return park();
    state = { ...state, executor: { ...state.executor!, actionPending: false } };
    return pace(result.advanced === false ? state.stage as BookingStage : nextStage);
  };
  const request = { scheduleId };
  const submission = (action: SubmissionRequest['action'], date: string, time: string): SubmissionRequest => ({
    action, scheduleId, applicantIds: state.executor!.applicantIds!, facilityId: CONSULATES[prefs.consulate], date, time,
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
      return appointmentDate(baseline, state.group!) === state.group!.currentDate ? null : park('baseline-changed');
    } catch (error) { return baselineInvalid(error); }
  };
  switch (state.stage) {
    case 'confirm': {
      const intent = state.intent!;
      const time = state.executor!.targetTime;
      if (!time || intent.targetDate !== state.lastCandidate || intent.testMode !== !prefs.autoMode || intent.consulate !== prefs.consulate ||
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
        if (deps.isCancelled?.()) return parkBare();
        if (ready?.ok !== true) return verify();
      } catch { return park(); }
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
      if (page.kind !== 'actions') return park();
      return act({ ...request, action: state.group!.currentDate === null ? 'schedule' : 'reschedule' }, 'warning');
    case 'warning':
      if (page.kind !== 'warning') return park();
      return act({ ...request, action: 'warning' }, 'applicants');
    case 'applicants': {
      if (page.kind !== 'applicants' || !Array.isArray(page.applicants) ||
          page.applicants.some(entry => entry.checked !== true || entry.disabled !== false)) return park();
      let ids: string[];
      try { ids = validateApplicantIds(page.applicants.map(entry => entry.id)); } catch { return park(); }
      if (state.group!.applicantIds && !sameApplicants(state.group!.applicantIds, ids)) return park();
      if (state.executor!.applicantIds && !sameApplicants(state.executor!.applicantIds, ids)) return park();
      state = { ...state, executor: { ...state.executor!, applicantIds: ids } };
      return act({ ...request, action: 'applicants', applicantIds: ids }, 'form');
    }
    case 'form': {
      const ids = state.executor!.applicantIds;
      if (page.kind !== 'form' || !sameApplicants(page.applicantIds, ids) || !ids) return park();
      if (state.lastCandidate === null) {
        if (!await prefsUnchanged()) return park();
        if (state.consecutiveFailures > 0) note('executor-recovered', undefined, 0);
        return { ...applyPollResult(state, { outcome: 'healthy', now: deps.nowIso(), random: deps.random }),
          nextPollAt: deps.nowIso(), stage: null, executor: { ...state.executor!, targetTime: null } };
      }
      const facilityId = CONSULATES[prefs.consulate];
      const date = state.lastCandidate!;
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
            executor: { ...state.executor!, targetTime: null, skippedDates: [...new Set([...state.executor!.skippedDates, date])] } };
        }
        time = [...times].sort()[0];
        state = { ...state, executor: { ...state.executor!, targetTime: time } };
      }
      if (page.time !== time) return act({ ...fields, action: 'time', time }, 'form');
      // This read comes after any field changes in a prior alarm. The IDs
      // expected here were bound from the dashboard before gateway entry,
      // never copied from this form's query.
      if (!await prefsUnchanged()) return park();
      let fresh: PaidPage;
      try { fresh = await inject(readPaidPage, [scheduleId, implicitApplicantId]) as PaidPage; } catch { return retry('script-interrupted'); }
      if (!fresh || fresh.kind !== 'form' || fresh.calendarReady !== true || fresh.slotWarning === true ||
          fresh.date !== date || fresh.time !== time || typeof fresh.facilityId !== 'number') return park();
      const refused = await baselineGuard();
      if (refused) return refused;
      const expected = { scheduleId, applicantIds: ids, consulate: prefs.consulate, currentDate: state.group!.currentDate,
        prefs: windowPrefs, testMode: false };
      try {
        const form = { ...fresh, facilityId: fresh.facilityId };
        if (!guardBooking(form, expected).allowed) return park();
        const locked = guardBooking(form, { ...expected, testMode: true });
        if (locked.allowed || locked.reason !== 'test-mode') return park();
      } catch { return park(); }
      if (fresh.warningAcknowledged === false) {
        if (!await prefsUnchanged() || deps.isCancelled?.()) return park();
        state = { ...state, executor: { ...state.executor!, actionPending: true } };
        await deps.saveState(state);
        if (deps.isCancelled?.() || !await prefsUnchanged()) return park();
        try {
          const result = await inject(performAppointmentSubmission, [submission('acknowledge', date, time)]) as { ok?: boolean };
          if (result?.ok !== true) return park();
        } catch { return park(); }
        state = { ...state, executor: { ...state.executor!, actionPending: false } };
        return pace('form');
      }
      if (!prefs.autoMode) {
        // Defense in depth: only explicit Auto Mode ON may submit.
        if (!await prefsUnchanged() || deps.isCancelled?.()) return park();
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
      if (!await prefsUnchanged() || deps.isCancelled?.()) return park();
      state = recordIntent(state, { owner, runId, now: deps.nowIso(), intent: {
        runId, mode: 'booking', groupId: scheduleId, targetDate: fresh.date,
        consulate: prefs.consulate, testMode: !prefs.autoMode, createdAt: deps.nowIso(), phase: 'prepared',
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
    default: return park();
  }
}
