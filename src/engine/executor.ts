import { canBook, CONSULATES, validatePreferences } from '../domain/dates';
import { guardBooking } from '../domain/booking';
import { sameApplicants, validateApplicantIds } from '../domain/applicants';
import { parseTimesPayload } from '../domain/availability';
import { classifyRoute } from '../domain/routes';
import { isSameGroupUrl } from '../domain/trust';
import { mapHttpStatus, SESSION_AGE_MINUTES } from '../domain/timing';
import { performPaidAction, type ActResult, type PaidAction } from '../adapter/acts';
import { readPaidPage, type PaidPage } from '../adapter/paid';
import { readCurrentAppointment } from '../adapter/reads';
import { appointmentDate } from '../domain/appointment';
import { fetchTimesJson, type PollResponse } from '../adapter/poll';
import { applyPollResult, setStage, type BookingStage } from './poll';
import { parkForReview, recordIntent, type EngineState } from './workflow';
import { policyKey } from './lifecycle';
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
};

type Prefs = {
  consulate: keyof typeof CONSULATES;
  earliest: string;
  latest: string;
  onlyEarlier: boolean;
  testMode: boolean;
  policyKey: string;
};
async function readPrefs(deps: ExecDeps): Promise<Prefs | null> {
  const raw = await deps.loadPrefs();
  if (!raw || typeof raw.consulate !== 'string' || !Object.hasOwn(CONSULATES, raw.consulate) ||
      typeof raw.earliest !== 'string' || typeof raw.latest !== 'string' || typeof raw.onlyEarlier !== 'boolean') return null;
  try { validatePreferences({ earliest: raw.earliest, latest: raw.latest, exclusions: [], onlyEarlier: raw.onlyEarlier }); }
  catch { return null; }
  return { consulate: raw.consulate as Prefs['consulate'], earliest: raw.earliest, latest: raw.latest,
    onlyEarlier: raw.onlyEarlier, testMode: raw.testMode !== false, policyKey: policyKey(raw) };
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
  const verify = (): EngineState => ({ ...parkForReview(state, deps.nowIso()), stage: 'done',
    verification: { reads: [], nextReadAt: new Date(Date.parse(deps.nowIso()) + 30_000).toISOString() } });
  const parkBare = () => parkForReview(state, deps.nowIso());
  // An interrupted mutation checkpoint (actionPending) with a durable intent
  // must route into scheduled verification, never park without a deadline.
  // Explicit cancellation still parks bare; other guards with an intent also
  // schedule verification instead of stalling.
  const park = () => (state.intent && !deps.isCancelled?.() ? verify() : parkBare());
  if (state.executor?.actionPending && state.intent) return verify();
  if (state.mode !== 'booking' || state.group.kind !== 'paid' || !owner || !runId || state.executor?.actionPending ||
      (state.stage === 'confirm' && !state.intent) ||
      (state.intent && !(state.stage === 'confirm' && state.intent.phase === 'submitted' && state.intent.runId === runId && state.intent.groupId === scheduleId))) return park();
  const prefs = await readPrefs(deps);
  if (deps.isCancelled?.()) return park();
  if (!state.startedAt || Date.parse(deps.nowIso()) - Date.parse(state.startedAt) >= SESSION_AGE_MINUTES * 60_000 ||
      (state.policyKey !== null && state.policyKey !== prefs?.policyKey)) return park();
  const windowPrefs = prefs && { earliest: prefs.earliest, latest: prefs.latest, exclusions: [], onlyEarlier: prefs.onlyEarlier };
  if (!prefs || !windowPrefs ||
      (state.lastCandidate !== null && !canBook(state.lastCandidate, state.group.currentDate, windowPrefs))) return park();
  if (state.stage === 'actions' && !state.group.applicantIds) return park();
  const prefsUnchanged = async () => JSON.stringify(await readPrefs(deps)) === JSON.stringify(prefs);
  const pace = (stage: BookingStage, delayMs = state.lastCandidate !== null &&
    ((state.stage === 'form' && stage === 'form') || stage === 'confirm') ? 0 : 2_000): EngineState => ({
    ...setStage(state, stage, deps.nowIso()),
    nextPollAt: new Date(Date.parse(deps.nowIso()) + delayMs).toISOString(), updatedAt: deps.nowIso(),
  });
  const retry = () => applyPollResult(state, { outcome: 'retryable', now: deps.nowIso(), random: deps.random });
  const trusted = (tab: ExecTab) => tab.url !== undefined &&
    ((['actions', 'appointment'].includes(classifyRoute(tab.url)) && isSameGroupUrl(tab.url, scheduleId)) ||
      (state.stage === 'actions' && state.group!.dashboardPath !== undefined && classifyRoute(tab.url) === 'dashboard' &&
        new URL(tab.url).pathname === state.group!.dashboardPath));
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
  if (state.group!.applicantIds && state.executor!.applicantIds && !sameApplicants(state.group!.applicantIds, state.executor!.applicantIds)) return park();
  const tabId = state.executor!.tabId;
  let owned;
  try { owned = await deps.getTab(tabId); } catch { return park(); }
  if (!trusted(owned)) return park();
  if (owned.status === 'loading') {
    const loadingSince = state.executor!.loadingSince ?? deps.nowIso();
    const elapsed = Date.parse(deps.nowIso()) - Date.parse(loadingSince);
    if (elapsed < 0 || elapsed >= 15_000) return park();
    state = { ...state, executor: { ...state.executor!, loadingSince } };
    return pace(state.stage as BookingStage, 2_000);
  }
  if (state.executor!.loadingSince !== undefined) {
    const { loadingSince, ...executor } = state.executor!;
    state = { ...state, executor };
  }
  const inject = async (func: (...args: never[]) => unknown, args: unknown[]): Promise<unknown> => {
    const tab = await deps.getTab(tabId);
    if (!trusted(tab) || deps.isCancelled?.()) throw new Error('Executor context changed.');
    return deps.inject(tabId, func, args);
  };
  if (classifyRoute(owned.url!) === 'dashboard') {
    if (!state.group!.dashboardPath || !state.group!.applicantIds || !await prefsUnchanged()) return park();
    try {
      const baseline = await inject(readCurrentAppointment, [scheduleId, state.group!.ivr, true, true, state.group!.dashboardPath]);
      if (appointmentDate(baseline, state.group!) !== state.group!.currentDate) return park();
    } catch { return park(); }
    state = { ...state, executor: { ...state.executor!, actionPending: true }, updatedAt: deps.nowIso() };
    await deps.saveState(state);
    if (deps.isCancelled?.() || !await prefsUnchanged()) return park();
    try {
      const result = await inject(performDashboardContinue, [{ scheduleId, ivr: state.group!.ivr,
        dashboardPath: state.group!.dashboardPath, applicantIds: state.group!.applicantIds }]) as { ok?: boolean };
      if (result?.ok !== true) return park();
    } catch { return park(); }
    state = { ...state, executor: { ...state.executor!, actionPending: false } };
    return pace('actions');
  }
  let implicitApplicantId: string | null = null;
  let page: PaidPage;
  try {
    page = await inject(readPaidPage, [scheduleId]) as PaidPage;
    if (!page && state.group!.applicantIds?.length === 1 &&
        sameApplicants(state.executor!.applicantIds, state.group!.applicantIds) && classifyRoute(owned.url!) === 'appointment' &&
        !new URL(owned.url!).search) {
      // Revalidate the independent complete roster before relying on a form
      // with no applicant IDs. Warning/selection pages keep their own guards.
      if (!state.group!.dashboardPath) return park();
      const baseline = await inject(readCurrentAppointment, [scheduleId, state.group!.ivr, true, true, state.group!.dashboardPath]);
      if (appointmentDate(baseline, state.group!) !== state.group!.currentDate) return park();
      implicitApplicantId = state.group!.applicantIds[0];
      page = await inject(readPaidPage, [scheduleId, implicitApplicantId]) as PaidPage;
    }
    if (!page || page.scheduleId !== scheduleId) return park();
  } catch { return park(); }
  if ((state.stage === 'warning' || state.stage === 'applicants') && page.kind === 'form') {
    const expected = state.group!.applicantIds ?? state.executor!.applicantIds;
    if (!expected || !sameApplicants(page.applicantIds, expected)) return park();
    state = { ...state, executor: { ...state.executor!, applicantIds: expected } };
    return pace('form');
  }
  if (state.stage === 'warning' && page.kind === 'applicants') return pace('applicants');

  const act = async (request: PaidAction, nextStage: BookingStage): Promise<EngineState> => {
    // Reread durable Test Mode and policy immediately before the mutation.
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
    onlyEarlier: prefs.onlyEarlier, testMode: prefs.testMode,
    ...(implicitApplicantId ? { implicitApplicantId } : {}),
  });
  const baselineUnchanged = async () => {
    if (!state.group!.applicantIds) return false;
    try {
      const baseline = await inject(readCurrentAppointment, [scheduleId, state.group!.ivr, true, true, state.group!.dashboardPath]);
      return appointmentDate(baseline, state.group!) === state.group!.currentDate;
    } catch { return false; }
  };
  switch (state.stage) {
    case 'confirm': {
      const intent = state.intent!;
      const time = state.executor!.targetTime;
      if (!time || intent.targetDate !== state.lastCandidate || intent.testMode !== prefs.testMode || intent.consulate !== prefs.consulate ||
          page.kind !== 'form' || page.slotWarning === true || page.calendarReady !== true ||
          page.date !== intent.targetDate || page.time !== time) return verify();
      if (prefs.testMode) return verify();
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
      if (deps.isCancelled?.() || !await prefsUnchanged() || !await baselineUnchanged()) return park();
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
        catch { return park(); }
        if (!response || mapHttpStatus(response.status) !== 'ok') {
          return response && mapHttpStatus(response.status) === 'denied'
            ? applyPollResult(state, { outcome: 'denied', now: deps.nowIso(), random: deps.random }) : retry();
        }
        let times: string[];
        try { times = parseTimesPayload(response.body); } catch { return retry(); }
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
      try { fresh = await inject(readPaidPage, [scheduleId, implicitApplicantId]) as PaidPage; } catch { return park(); }
      if (!fresh || fresh.kind !== 'form' || fresh.calendarReady !== true || fresh.slotWarning === true ||
          fresh.date !== date || fresh.time !== time || typeof fresh.facilityId !== 'number') return park();
      if (!await baselineUnchanged()) return park();
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
      if (prefs.testMode) {
        // Test Mode dry-run boundary: readiness guards above (roster, custody,
        // fresh form, baseline, date/window/earlier-only policy) have passed.
        // Never click the final Schedule/Reschedule submit and never open the
        // portal confirmation dialog — with or without a data-confirm gate.
        // Park without creating a booking intent or mutation checkpoint for a
        // click that will not occur. Legacy persisted test-mode intents still
        // verify; this path creates none.
        if (!await prefsUnchanged() || deps.isCancelled?.()) return park();
        return parkForReview(setStage(state, 'done', deps.nowIso()), deps.nowIso());
      }
      // Live submission (Test Mode explicitly OFF, user authorization October
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
        consulate: prefs.consulate, testMode: prefs.testMode, createdAt: deps.nowIso(), phase: 'prepared',
      } });
      state = { ...state, executor: { ...state.executor!, actionPending: true } };
      try { await deps.saveState(state); } catch { return verify(); }
      if (deps.isCancelled?.() || !await prefsUnchanged()) return verify();
      try {
        const result = await inject(performAppointmentSubmission, [submission('submit', date, time)]) as { ok?: boolean };
        if (result?.ok !== true) return verify();
      } catch { return verify(); }
      state = { ...state, intent: { ...state.intent!, phase: 'submitted' }, executor: { ...state.executor!, actionPending: false } };
      return pace('confirm');
    }
    default: return park();
  }
}
