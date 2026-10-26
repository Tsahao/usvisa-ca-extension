import { describe, expect, it, vi } from 'vitest';
import { bindGroup, emptyEngineState, reconcileStartup, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
import { recordCandidate, setStage, type BookingStage } from '../src/engine/poll';
import { runAuthentication } from '../src/engine/authentication';
import { runBookingStage, type ExecDeps } from '../src/engine/executor';
import type { DiagnosticEvent } from '../src/domain/diagnostics';
import type { PaidPage } from '../src/adapter/paid';
import type { PaidAction } from '../src/adapter/acts';

const NOW = '2026-10-12T00:00:00.000Z';
const OWNER = 'owner-token-01';
const RUN = 'run-id-0001';
const BASE = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
const IDS = ['77777777', '88888888'];
const PREFS = { consulates: ['Toronto', 'Vancouver'], earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, autoMode: true };
function seeded(stage: BookingStage): EngineState {
  const bound = bindGroup(startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }), {
    owner: OWNER, runId: RUN, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', applicantIds: IDS }, now: NOW,
  });
  return { ...setStage(recordCandidate(bound, { date: '2026-11-19', consulate: 'Vancouver' }, NOW), stage, NOW),
    executor: { tabId: 7, applicantIds: stage === 'form' ? IDS : null, targetTime: null, skippedDates: [], actionPending: false } };
}
function harness(kind: PaidPage['kind']) {
  const page: PaidPage = { kind, scheduleId: '11111111', applicantIds: IDS, facilityId: 95, date: '2026-11-19', time: '09:15', calendarReady: true,
    applicants: IDS.map(id => ({ id, checked: true, disabled: false })) };
  const url = `${BASE}/${kind === 'actions' ? 'continue_actions' : 'appointment?applicants[]=77777777&applicants[]=88888888'}`;
  const mutations: PaidAction[] = [];
  const checkpoints: EngineState[] = [];
  const d: ExecDeps = {
    nowIso: () => NOW, random: () => 0,
    queryTabs: vi.fn(async () => [{ id: 7, url }]), getTab: vi.fn(async () => ({ id: 7, url })),
    createTab: vi.fn(async () => ({ id: 9 })), loadPrefs: vi.fn(async () => ({ ...PREFS })),
    saveState: vi.fn(async state => { checkpoints.push(structuredClone(state)); }),
    inject: vi.fn(async (_id, func, args) => {
      if (func.name === 'readPaidPage') return structuredClone(page);
      if (func.name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: IDS };
      if (func.name === 'fetchTimesJson') return { status: 200, body: { available_times: ['10:30', '09:15'] } };
      if (func.name === 'performPaidAction') {
        expect(checkpoints.at(-1)?.executor?.actionPending).toBe(true);
        mutations.push(args![0] as PaidAction);
        return { ok: true, advanced: true };
      }
      throw new Error('Unexpected injection');
    }),
  };
  return { d, page, mutations, checkpoints };
}

describe('paid executor', () => {
  it('resolves provisional payment evidence only on a form with independently revalidated roster and baseline', async () => {
    const h = harness('form'); const state = seeded('form');
    state.group = { ...state.group!, ivr: null, pendingInspection: true, dashboardPath: '/en-ca/niv/groups' };
    state.lastCandidate = null;
    const events: DiagnosticEvent[] = [];
    h.d.recordDiagnostic = event => { events.push(event); };
    const next = validateEngineState(await runBookingStage(h.d, state));
    expect(next.group!.pendingInspection).toBeUndefined();
    expect(next).toMatchObject({ status: 'running', stage: null, intent: null });
    expect(h.mutations).toEqual([]);
    expect(h.checkpoints[0].group!.pendingInspection).toBeUndefined();
    expect(events.map(event => event.code)).toEqual(['payment-inspection-attempted', 'payment-inspection-resolved']);
    expect(vi.mocked(h.d.inject).mock.calls.map(call => call[1].name).filter(name => name !== 'readSiteMaintenance')).toEqual(['readPaidPage', 'readCurrentAppointment']);
  });
  it.each(['wrong-roster', 'wrong-baseline', 'wrong-ivr', 'missing-page', 'actions-only'])(
    'does not resolve inspection or submit with unsupported capability (%s)', async issue => {
      const h = harness(issue === 'actions-only' ? 'actions' : 'form');
      const state = seeded(issue === 'actions-only' ? 'actions' : 'form');
      state.group = { ...state.group!, pendingInspection: true, dashboardPath: '/en-ca/niv/groups' };
      const original = h.d.inject;
      h.d.inject = vi.fn(async (id, func, args) => {
        if (func.name === 'readPaidPage' && issue === 'missing-page') return null;
        if (func.name === 'readCurrentAppointment' && issue === 'wrong-baseline')
          return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 2, 2027', applicantIds: IDS };
        if (func.name === 'readCurrentAppointment' && issue === 'wrong-ivr')
          return { scheduleId: '11111111', ivr: '99999999', kind: 'booked', text: 'January 1, 2027', applicantIds: IDS };
        return original(id, func, args);
      });
      if (issue === 'wrong-roster') h.page.applicantIds = ['99999999'];
      const events: DiagnosticEvent[] = [];
      h.d.recordDiagnostic = event => { events.push(event); };
      const next = await runBookingStage(h.d, state);
      expect(next.group!.pendingInspection).toBe(true);
      expect(events.some(event => event.code === 'payment-inspection-resolved')).toBe(false);
      expect(h.mutations.every(action => action.action === 'reschedule')).toBe(true);
      expect(next.intent).toBeNull();
    });
  it('retries a read-only page interruption and recovers without skipping the action checkpoint', async () => {
    const h = harness('actions');
    const original = h.d.inject;
    h.d.inject = vi.fn(async () => { throw new Error('synthetic transport interruption'); });
    const state = await runBookingStage(h.d, seeded('actions'));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, intent: null, executor: { actionPending: false } });
    expect(h.mutations).toEqual([]);
    expect(h.checkpoints).toEqual([]);
    h.d.nowIso = () => '2026-10-12T00:01:00.000Z';
    h.d.inject = original;
    const next = await runBookingStage(h.d, state);
    expect(next).toMatchObject({ status: 'running', stage: 'warning', executor: { actionPending: false } });
    expect(h.mutations.map(m => m.action)).toEqual(['reschedule']);
    expect(h.checkpoints[0].executor!.actionPending).toBe(true);
  });
  it.each(['missing', 'malformed'] as const)('retries a %s dashboard baseline without clicking Continue', async issue => {
    const h = harness('actions'); const state = seeded('actions');
    state.group!.dashboardPath = '/en-ca/niv/groups/55555555';
    h.d.getTab = async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    h.d.inject = vi.fn(async () => issue === 'missing' ? null : { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', status: '503' });
    expect(await runBookingStage(h.d, state)).toMatchObject({ status: 'running', consecutiveFailures: 1, nextPollAt: '2026-10-12T00:01:00.000Z' });
    expect(h.mutations).toEqual([]); expect(h.checkpoints).toEqual([]);
  });
  it.each([0, 502, 503, 401, 403])('retries/renews a failed dashboard baseline GET before Continue (%s)', async status => {
    const h = harness('actions'); const state = seeded('actions');
    state.lastCandidate = null;
    state.group!.dashboardPath = '/en-ca/niv/groups/55555555';
    state.executor!.applicantIds = IDS;
    h.d.getTab = async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    const original = h.d.inject;
    h.d.inject = vi.fn(async (_id, func, args) => {
      expect(func.name).toBe('readCurrentAppointment');
      expect(args).toEqual(['11111111', '22222222', true, true, state.group!.dashboardPath, true]);
      return { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status };
    });
    const events: DiagnosticEvent[] = [];
    h.d.recordDiagnostic = event => { events.push(event); };
    const next = validateEngineState(await runBookingStage(h.d, state));
    expect(next).toMatchObject({ status: status === 401 || status === 403 ? 'stopped' : 'running', stage: 'actions',
      intent: null, lastCandidate: null, executor: { tabId: 7, actionPending: false } });
    expect(h.checkpoints).toEqual([]); expect(h.mutations).toEqual([]); expect(h.d.createTab).not.toHaveBeenCalled();
    if (status === 401 || status === 403) return;
    // The counted retry carries the booking stage as its fixed phase context.
    expect(events).toEqual([{ code: 'executor-retry', detail: 'transport', mode: 'booking', phase: 'actions', failures: 1 }]);
    // Fixed allowlisted fields only: never the status code or page content.
    expect(Object.keys(events[0]).sort()).toEqual(['code', 'detail', 'failures', 'mode', 'phase']);
    expect(next.nextPollAt).toBe('2026-10-12T00:01:00.000Z'); expect(next.consecutiveFailures).toBe(1);
    const cooled = await runBookingStage(h.d, { ...state, consecutiveFailures: 9 });
    expect(cooled).toMatchObject({ status: 'running', consecutiveFailures: 10, nextPollAt: null, cooldownUntil: '2026-10-12T00:30:00.000Z' });
    h.d.inject = vi.fn(async (...args) => args[1].name === 'performDashboardContinue' ? { ok: true } : original(args[0], args[1], args[2]));
    expect(await runBookingStage(h.d, next)).toMatchObject({ status: 'running', stage: 'actions', executor: { tabId: 7, actionPending: false } });
    expect(h.checkpoints).toHaveLength(1); expect(h.checkpoints[0].executor?.actionPending).toBe(true);
    expect(vi.mocked(h.d.inject).mock.calls.map(call => call[1].name).filter(name => name !== 'readSiteMaintenance')).toEqual(['readCurrentAppointment', 'performDashboardContinue']);
  });
  it('continues a null-IVR dashboard binding with a null request IVR after a readable baseline', async () => {
    const h = harness('actions'); const state = seeded('actions');
    state.lastCandidate = null;
    state.group = { ...state.group!, ivr: null, dashboardPath: '/en-ca/niv/groups/55555555' };
    state.executor!.applicantIds = IDS;
    h.d.getTab = async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    h.d.inject = vi.fn(async (_id, func, args) => {
      if (func.name === 'readCurrentAppointment') {
        expect(args).toEqual(['11111111', null, true, true, '/en-ca/niv/groups/55555555', true]);
        return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: IDS };
      }
      if (func.name === 'performDashboardContinue') {
        expect(args![0]).toEqual({ scheduleId: '11111111', ivr: null, dashboardPath: '/en-ca/niv/groups/55555555', applicantIds: IDS });
        return { ok: true };
      }
      throw new Error('Unexpected injection');
    });
    const next = validateEngineState(await runBookingStage(h.d, state));
    expect(next).toMatchObject({ status: 'running', stage: 'actions', executor: { tabId: 7, actionPending: false } });
    expect(h.mutations).toEqual([]);
    expect(h.checkpoints).toHaveLength(1);
    expect(h.checkpoints[0].executor!.actionPending).toBe(true);
    expect(vi.mocked(h.d.inject).mock.calls.map(call => call[1].name).filter(name => name !== 'readSiteMaintenance')).toEqual(['readCurrentAppointment', 'performDashboardContinue']);
  });
  it.each([
    { bindingIvr: null, reading: { scheduleId: '11111111', ivr: '99999999' }, outcome: 'retry' },
    { bindingIvr: null, reading: { scheduleId: '11111111', ivr: null }, outcome: 'retry' },
    { bindingIvr: '22222222', reading: { scheduleId: '11111111', ivr: null }, outcome: 'retry' },
    { bindingIvr: null, reading: { scheduleId: '11111111', ivr: 12345 }, outcome: 'park' },
    { bindingIvr: null, reading: { scheduleId: '99999999', ivr: null }, outcome: 'park' },
  ] as const)('classifies null-aware dashboard baseline read failures (%j)', async ({ bindingIvr, reading, outcome }) => {
    const h = harness('actions'); const state = seeded('actions');
    state.lastCandidate = null;
    state.group = { ...state.group!, ivr: bindingIvr, dashboardPath: '/en-ca/niv/groups/55555555' };
    state.executor!.applicantIds = IDS;
    h.d.getTab = async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    h.d.inject = vi.fn(async () => ({ ...reading, kind: 'read-failure', text: null, status: 503 }));
    const next = validateEngineState(await runBookingStage(h.d, state));
    if (outcome === 'park') {
      expect(next).toMatchObject({ status: 'verifying', nextPollAt: null, intent: null });
      expect(vi.mocked(h.d.inject).mock.calls.map(call => call[1].name).filter(name => name !== 'readSiteMaintenance')).toEqual(['readCurrentAppointment']);
    } else {
      // A null IVR on either side and a readable disagreement against a null
      // binding never fabricate an identity mismatch: the schedule is primary
      // and the failed GET stays on the counted retry budget.
      expect(next).toMatchObject({ status: 'running', consecutiveFailures: 1, nextPollAt: '2026-10-12T00:01:00.000Z' });
    }
    expect(h.mutations).toEqual([]); expect(h.checkpoints).toEqual([]);
  });
  it.each(['wrong-group', 'wrong-ivr', 'changed-roster', 'changed-baseline', 'cancelled'])(
    'recovers date-only dashboard changes and parks unsafe handoffs without clicking Continue (%s)', async issue => {
      const h = harness('actions'); const state = seeded('actions');
      state.lastCandidate = null; state.group!.dashboardPath = '/en-ca/niv/groups/55555555'; state.executor!.applicantIds = IDS;
      h.d.getTab = async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
      let cancelled = false; h.d.isCancelled = () => cancelled;
      h.d.inject = vi.fn(async () => {
        if (issue === 'cancelled') cancelled = true;
        if (issue === 'missing-reading') return null;
        if (issue === 'changed-roster' || issue === 'changed-baseline') return { scheduleId: '11111111', ivr: '22222222', kind: 'booked',
          text: issue === 'changed-baseline' ? 'December 1, 2026' : 'January 1, 2027', applicantIds: issue === 'changed-roster' ? IDS.slice(0, 1) : IDS };
        return { scheduleId: issue === 'wrong-group' ? '99999999' : '11111111', ivr: issue === 'wrong-ivr' ? '99999999' : '22222222', kind: 'read-failure', status: issue === 'malformed-status' ? '502' : 502 };
      });
      const next = await runBookingStage(h.d, state);
      expect(next).toMatchObject(issue === 'changed-baseline'
        ? { status: 'running', group: { currentDate: '2026-12-01' }, lastCandidate: null,
            authentication: { purpose: 'renew', dashboardFirst: true }, intent: null }
        : { status: 'verifying', nextPollAt: null, intent: null });
      expect(vi.mocked(h.d.inject).mock.calls.filter(([, func]) => func.name !== 'readSiteMaintenance')).toHaveLength(issue === 'cancelled' ? 0 : 1); expect(h.checkpoints).toEqual([]); expect(h.mutations).toEqual([]);
    });
  it.each([0, 503, 401, 403])('classifies transient single-applicant re-entry reads without booking (%s)', async status => {
    const h = harness('form');
    const state = seeded('warning');
    state.lastCandidate = null;
    state.group = { ...state.group!, applicantIds: [IDS[0]], dashboardPath: '/en-ca/niv/groups/99999999' };
    state.executor = { ...state.executor!, applicantIds: [IDS[0]] };
    h.d.getTab = async () => ({ id: 7, url: `${BASE}/appointment` });
    h.d.inject = vi.fn(async (_id, func, args) => {
      if (func.name === 'readPaidPage') return null;
      expect(func.name).toBe('readCurrentAppointment');
      expect(args?.slice(2)).toEqual([true, true, '/en-ca/niv/groups/99999999', true]);
      return { scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status };
    });
    const next = await runBookingStage(h.d, state);
    expect(next).toMatchObject({ status: status === 401 || status === 403 ? 'stopped' : 'running', intent: null, stage: 'warning', lastCandidate: null });
    if (status === 0 || status === 503) {
      expect(next.consecutiveFailures).toBe(1);
      expect(next.nextPollAt).toBe('2026-10-12T00:01:00.000Z');
      const cooled = await runBookingStage(h.d, { ...state, consecutiveFailures: 9 });
      expect(cooled).toMatchObject({ status: 'running', consecutiveFailures: 10, nextPollAt: null, cooldownUntil: '2026-10-12T00:30:00.000Z' });
    }
    expect(h.mutations).toEqual([]); expect(h.checkpoints).toEqual([]);
  });
  it.each(['wrong-identity', 'changed-roster', 'changed-baseline'])(
    'recovers date-only re-entry changes and parks unsafe readings (%s)', async issue => {
      const h = harness('form'); const state = seeded('warning');
      state.lastCandidate = null;
      state.group = { ...state.group!, applicantIds: [IDS[0]], dashboardPath: '/en-ca/niv/groups/99999999' };
      state.executor = { ...state.executor!, applicantIds: [IDS[0]] };
      h.d.getTab = async () => ({ id: 7, url: `${BASE}/appointment` });
      h.d.inject = vi.fn(async (_id, func) => {
        if (func.name === 'readPaidPage' || issue === 'missing-reading') return null;
        if (issue === 'wrong-identity' || issue === 'malformed-status') return { scheduleId: issue === 'wrong-identity' ? '99999999' : '11111111', ivr: '22222222', kind: 'read-failure', status: issue === 'malformed-status' ? '503' : 503 };
        return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: issue === 'changed-baseline' ? 'December 1, 2026' : 'January 1, 2027', applicantIds: issue === 'changed-roster' ? IDS : [IDS[0]] };
      });
      const next = await runBookingStage(h.d, state);
      expect(next).toMatchObject(issue === 'changed-baseline'
        ? { status: 'running', group: { currentDate: '2026-12-01' }, lastCandidate: null,
            authentication: { purpose: 'renew', dashboardFirst: true }, intent: null }
        : { status: 'verifying', intent: null, nextPollAt: null });
      expect(h.mutations).toEqual([]); expect(h.checkpoints).toEqual([]);
    });
  it('binds the sole applicant on the form reached through the acknowledged warning query', async () => {
    // One-applicant groups skip the applicant picker: acknowledging the limit
    // warning lands directly on the booking form with only the warning's own
    // GET parameters, never applicants[].
    const h = harness('form'); const state = seeded('applicants');
    state.lastCandidate = null;
    state.group = { ...state.group!, applicantIds: [IDS[0]], dashboardPath: '/en-ca/niv/groups/99999999' };
    state.executor = { ...state.executor!, applicantIds: [IDS[0]] };
    h.d.getTab = async () => ({ id: 7, url: `${BASE}/appointment?confirmed_limit_message=1&commit=Continue` });
    h.d.inject = vi.fn(async (_id, func, args) => {
      if (func.name === 'readPaidPage') return args?.length === 2 && args[1] === IDS[0] ? { ...structuredClone(h.page), applicantIds: [IDS[0]], applicants: [] } : null;
      if (func.name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: [IDS[0]] };
      throw new Error('Unexpected injection');
    });
    const next = await runBookingStage(h.d, state);
    expect(next).toMatchObject({ status: 'running', stage: 'form', consecutiveFailures: 0, authentication: null });
    expect(next.executor!.applicantIds).toEqual([IDS[0]]);
    expect(vi.mocked(h.d.inject).mock.calls.map(call => call[1].name).filter(name => name !== 'readSiteMaintenance')).toEqual(['readPaidPage', 'readCurrentAppointment', 'readPaidPage']);
    expect(h.mutations).toEqual([]);
  });
  it.each(['?confirmed_limit_message=0&commit=Continue', '?confirmed_limit_message=1&other=1'])('never infers the sole applicant on an appointment URL with any other query (%s)', async query => {
    const h = harness('form'); const state = seeded('applicants');
    state.lastCandidate = null;
    state.group = { ...state.group!, applicantIds: [IDS[0]], dashboardPath: '/en-ca/niv/groups/99999999' };
    state.executor = { ...state.executor!, applicantIds: [IDS[0]] };
    h.d.getTab = async () => ({ id: 7, url: `${BASE}/appointment${query}` });
    h.d.inject = vi.fn(async () => null);
    const next = await runBookingStage(h.d, state);
    expect(vi.mocked(h.d.inject).mock.calls.map(call => call[1].name).filter(name => name !== 'readSiteMaintenance')).toEqual(['readPaidPage']);
    expect(next.consecutiveFailures).toBe(1);
    expect(h.mutations).toEqual([]);
  });
  it('reselects an equal date whose portal calendar state has not been loaded', async () => {
    const h = harness('form');
    h.page.calendarReady = false;
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next.status).toBe('running');
    expect(h.mutations.map(value => value.action)).toEqual(['date']);
    expect(vi.mocked(h.d.inject).mock.calls.some(call => call[1].name === 'fetchTimesJson')).toBe(false);
  });
  it('refuses readiness and submission when the portal reports a business-day/time warning', async () => {
    const h = harness('form');
    h.page.slotWarning = true;
    expect(await runBookingStage(h.d, seeded('form'))).toMatchObject({ status: 'running', intent: null, lastCandidate: null, stage: null,
      executor: { skippedDates: [{ consulate: 'Vancouver', date: '2026-11-19' }] } });
    expect(h.mutations).toEqual([]);
  });
  it('parks legacy gateway state without an independently bound dashboard roster', async () => {
    const h = harness('actions');
    const state = seeded('actions');
    delete state.group!.applicantIds;
    const next = await runBookingStage(h.d, state);
    expect(next.status).toBe('verifying');
    expect(h.d.inject).not.toHaveBeenCalled();
    expect(h.mutations).toEqual([]);
  });
  it('rejects a missing applicant on selection against the independent dashboard roster', async () => {
    const h = harness('applicants');
    h.page.applicants = h.page.applicants.slice(0, 1);
    const next = await runBookingStage(h.d, seeded('applicants'));
    expect(next.status).toBe('verifying');
    expect(h.mutations).toEqual([]);
  });
  it.each(['changed-date', 'changed-roster'])('revalidates a changed fresh dashboard before submission (%s)', async issue => {
    const h = harness('form');
    const original = h.d.inject;
    h.d.inject = async (...args) => args[1].name === 'readCurrentAppointment'
      ? { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: issue === 'changed-date' ? 'December 1, 2026' : 'January 1, 2027', applicantIds: issue === 'changed-roster' ? IDS.slice(0, 1) : IDS }
      : original(...args);
    expect(await runBookingStage(h.d, seeded('form'))).toMatchObject(issue === 'changed-date'
      ? { status: 'running', group: { currentDate: '2026-12-01' }, lastCandidate: null, intent: null,
          authentication: { purpose: 'renew', dashboardFirst: true } }
      : { status: 'verifying', intent: null });
    expect(h.mutations).toEqual([]);
  });
  it('honors Stop arriving during the pending checkpoint without injecting a mutation', async () => {
    const h = harness('actions');
    let cancelled = false;
    h.d.isCancelled = () => cancelled;
    h.d.saveState = async () => { cancelled = true; };
    const next = await runBookingStage(h.d, seeded('actions'));
    expect(next).toMatchObject({ status: 'verifying', executor: { actionPending: true } });
    expect(h.mutations).toEqual([]);
  });
  it('prepares gateways without a candidate and hands a verified form back to polling', async () => {
    const gateway = harness('actions');
    const next = await runBookingStage(gateway.d, { ...seeded('actions'), lastCandidate: null });
    expect(next).toMatchObject({ stage: 'warning', status: 'running', lastCandidate: null });
    expect(gateway.mutations.map(value => value.action)).toEqual(['reschedule']);
    const form = harness('form');
    const ready = await runBookingStage(form.d, { ...seeded('form'), lastCandidate: null });
    expect(ready).toMatchObject({ stage: null, status: 'running', lastCandidate: null, executor: { applicantIds: IDS, targetTime: null } });
    expect(form.mutations).toEqual([]);
    expect(vi.mocked(form.d.inject).mock.calls.filter(([, func]) => func.name !== 'readSiteMaintenance')).toHaveLength(1);
    expect(ready.nextPollAt).toBe(NOW);
  });
  it('checkpoints Continue in the owned dashboard tab instead of opening a new tab', async () => {
    const h = harness('actions');
    h.d.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' }));
    const state = seeded('actions');
    state.lastCandidate = null;
    state.group!.dashboardPath = '/en-ca/niv/groups/55555555';
    const original = h.d.inject;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => {
      if (args[1].name !== 'performDashboardContinue') return original(args[0], args[1], args[2]);
      expect(h.checkpoints.at(-1)?.executor).toMatchObject({ tabId: 7, actionPending: true });
      expect(args[0]).toBe(7);
      return { ok: true };
    });
    expect(await runBookingStage(h.d, state)).toMatchObject({ stage: 'actions', executor: { tabId: 7, actionPending: false }, nextPollAt: '2026-10-12T00:00:02.000Z' });
    expect(h.d.createTab).not.toHaveBeenCalled();
  });
  it('waits for the owned page to finish loading before reading or mutating it', async () => {
    const h = harness('actions');
    h.d.getTab = vi.fn(async () => ({ id: 7, url: `${BASE}/continue_actions`, status: 'loading' }));
    const next = await runBookingStage(h.d, seeded('actions'));
    expect(next).toMatchObject({ stage: 'actions', nextPollAt: '2026-10-12T00:00:02.000Z', executor: { loadingSince: NOW } });
    h.d.nowIso = () => '2026-10-12T00:00:16.000Z';
    const retried = await runBookingStage(h.d, validateEngineState(next));
    expect(retried).toMatchObject({ status: 'running', consecutiveFailures: 1, nextPollAt: '2026-10-12T00:01:16.000Z' });
    expect(h.d.inject).not.toHaveBeenCalled();
    h.d.nowIso = () => '2026-10-12T00:01:16.000Z';
    h.d.getTab = async () => ({ id: 7, url: `${BASE}/continue_actions`, status: 'complete' });
    expect(await runBookingStage(h.d, retried)).toMatchObject({ status: 'running', stage: 'warning', executor: { actionPending: false } });
  });
  it.each([null, ['77777777']])('refuses bootstrap form handoff without the independent full roster (%s)', async applicantIds => {
    const h = harness('form');
    const state = seeded('form');
    const next = await runBookingStage(h.d, { ...state, lastCandidate: null, executor: { ...state.executor!, applicantIds } });
    expect(next.status).toBe('verifying');
    expect(h.mutations).toEqual([]);
    expect(vi.mocked(h.d.inject).mock.calls.filter(([, func]) => func.name !== 'readSiteMaintenance').length).toBeLessThanOrEqual(1);
  });
  it('checkpoints before a gateway action and paces verified arrival', async () => {
    const h = harness('actions');
    const next = await runBookingStage(h.d, seeded('actions'));
    expect(next).toMatchObject({ stage: 'warning', status: 'running', nextPollAt: '2026-10-12T00:00:02.000Z' });
    expect(h.mutations.map(value => value.action)).toEqual(['reschedule']);
    expect(next.executor?.actionPending).toBe(false);
  });
  it('waits for a newly created tab and never recreates a closed owned tab', async () => {
    const h = harness('actions');
    h.d.queryTabs = vi.fn(async () => []);
    const next = await runBookingStage(h.d, { ...seeded('actions'), executor: null });
    expect(next.executor?.tabId).toBe(9);
    expect(h.d.inject).not.toHaveBeenCalled();
    h.d.getTab = vi.fn(async () => { throw new Error('tab closed'); });
    expect((await runBookingStage(h.d, next)).status).toBe('verifying');
    expect(h.d.createTab).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('prepares the monitoring gateway with Auto Mode %s', async autoMode => {
    const h = harness('actions');
    h.d.loadPrefs = async () => ({ ...PREFS, autoMode });
    expect((await runBookingStage(h.d, { ...seeded('actions'), lastCandidate: null })).status).toBe('running');
    expect(h.mutations.map(value => value.action)).toEqual(['reschedule']);
  });
  it('fails closed when the booking permission is missing', async () => {
    const h = harness('actions');
    h.d.loadPrefs = async () => ({ ...PREFS, autoMode: undefined });
    expect((await runBookingStage(h.d, seeded('actions'))).status).toBe('verifying');
    expect(h.d.inject).not.toHaveBeenCalled();
  });
  it('does no paid work for an unpaid run', async () => {
    const h = harness('actions');
    expect((await runBookingStage(h.d, { ...seeded('actions'), mode: 'alerts' })).status).toBe('verifying');
    expect(h.d.inject).not.toHaveBeenCalled();
  });
  it('binds the complete independent roster before Continue', async () => {
    const h = harness('applicants');
    h.page.applicantIds = [];
    const next = await runBookingStage(h.d, seeded('applicants'));
    expect(next.stage).toBe('form');
    expect(h.checkpoints[0].executor?.applicantIds).toEqual(IDS);
    expect(h.mutations[0]).toMatchObject({ action: 'applicants', applicantIds: IDS });
    expect(validateEngineState(JSON.parse(JSON.stringify(next))).executor?.applicantIds).toEqual(IDS);
  });
  it.each(['unchecked', 'duplicate', 'empty', 'disabled'])('refuses an invalid applicant selection: %s', issue => {
    const h = harness('applicants');
    if (issue === 'unchecked') h.page.applicants[0].checked = false;
    if (issue === 'disabled') h.page.applicants[0].disabled = true;
    if (issue === 'duplicate') h.page.applicants[1].id = IDS[0];
    if (issue === 'empty') h.page.applicants = [];
    return runBookingStage(h.d, seeded('applicants')).then(next => {
      expect(next.status).toBe('verifying');
      expect(h.mutations).toEqual([]);
    });
  });
  it('refuses downstream subsets and legacy forms with no bound roster', async () => {
    const h = harness('form');
    h.page.applicantIds = [IDS[0]];
    expect((await runBookingStage(h.d, seeded('form'))).status).toBe('verifying');
    expect(h.mutations).toEqual([]);
    h.page.applicantIds = IDS;
    expect((await runBookingStage(h.d, { ...seeded('form'), executor: null })).status).toBe('verifying');
  });
  it.each(['facility', 'date', 'time'] as const)('fills only the %s field per alarm', async action => {
    const h = harness('form');
    if (action === 'facility') h.page.facilityId = 94;
    if (action === 'date') h.page.date = '';
    if (action === 'time') h.page.time = '';
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'running', stage: 'form', intent: null });
    expect(next.nextPollAt).toBe(NOW);
    expect(h.mutations).toHaveLength(1);
    expect(h.mutations[0].action).toBe(action);
    if (action === 'time') expect(next.executor?.targetTime).toBe('09:15');
  });
  it('keeps monitoring with Auto Mode OFF without reading or filling a matched form', async () => {
    const h = harness('form');
    h.d.loadPrefs = async () => ({ ...PREFS, autoMode: false });
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ stage: null, status: 'running', intent: null, verification: null });
    expect(next.nextPollAt).toBe('2026-10-12T00:01:00.000Z');
    expect(h.mutations).toEqual([]);
    expect(h.d.inject).not.toHaveBeenCalled();
    expect(h.checkpoints).toEqual([]);
  });
  it('rejects actual form changes on the last reread', async () => {
    const h = harness('form');
    const original = h.d.inject;
    let reads = 0;
    h.d.inject = async (...args) => {
      if (args[1].name === 'readPaidPage' && ++reads === 2) return { ...h.page, date: '2026-11-20' };
      return original(...args);
    };
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'running', authentication: { dashboardFirst: true, phase: 'retry' }, lastCandidate: null, formLoadFailures: 1 });
    expect(next.intent).toBeNull();
  });
  it.each([502, 304, 403])('classifies times status %s without filling or inventing availability', async status => {
    const h = harness('form');
    const original = h.d.inject;
    h.d.inject = async (...args) => args[1].name === 'fetchTimesJson' ? { status, body: null } : original(...args);
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next.status).toBe(status === 403 ? 'stopped' : 'running');
    expect(next.consecutiveFailures).toBe(status === 403 ? 0 : 1);
    expect(h.mutations).toEqual([]);
  });
  it('returns to days polling when a candidate has no times', async () => {
    const h = harness('form');
    const original = h.d.inject;
    h.d.inject = async (...args) => args[1].name === 'fetchTimesJson' ? { status: 200, body: { available_times: [] } } : original(...args);
    expect(await runBookingStage(h.d, seeded('form'))).toMatchObject({ stage: null, lastCandidate: null, status: 'running', executor: { skippedDates: [{ consulate: 'Vancouver', date: '2026-11-19' }] } });
    expect(h.mutations).toEqual([]);
  });
  it('books the candidate consulate, not the first selected one', async () => {
    const h = harness('form'); h.page.facilityId = 94;
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'running', stage: 'form', intent: null });
    expect(h.mutations[0]).toMatchObject({ action: 'facility', facilityId: 95 });
  });
  it('skips a date per consulate when its times are empty', async () => {
    const h = harness('form');
    const original = h.d.inject;
    h.d.inject = async (...args) => args[1].name === 'fetchTimesJson' ? { status: 200, body: { available_times: [] } } : original(...args);
    const state = seeded('form');
    state.executor!.skippedDates = [{ consulate: 'Toronto', date: '2026-11-19' }];
    const next = await runBookingStage(h.d, state);
    expect(next.executor!.skippedDates).toEqual([{ consulate: 'Toronto', date: '2026-11-19' }, { consulate: 'Vancouver', date: '2026-11-19' }]);
    const fresh = await runBookingStage(h.d, seeded('form'));
    expect(fresh.executor!.skippedDates).toEqual([{ consulate: 'Vancouver', date: '2026-11-19' }]);
  });
  it('parks instead of booking a candidate whose consulate is unselected', async () => {
    const h = harness('form');
    h.d.loadPrefs = async () => ({ ...PREFS, consulates: ['Toronto'] });
    const events: DiagnosticEvent[] = [];
    h.d.recordDiagnostic = event => { events.push(event); };
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'verifying', intent: null });
    expect(h.mutations.filter(m => (m.action as string) === 'submit' || (m.action as string) === 'confirm')).toEqual([]);
    expect(h.mutations).toEqual([]);
    expect(vi.mocked(h.d.inject).mock.calls.map(call => call[1].name).filter(name => name !== 'readSiteMaintenance')).not.toContain('performAppointmentSubmission');
    expect(JSON.stringify(events)).not.toMatch(/Toronto|Vancouver|2026-11-19/);
  });
  it('parks an unselected candidate before any field change', async () => {
    // The form still shows another facility, so without the pre-check the
    // stage would switch the facility before the final guard refused it.
    const h = harness('form'); h.page.facilityId = 94; h.page.date = ''; h.page.time = '';
    h.d.loadPrefs = async () => ({ ...PREFS, consulates: ['Toronto'] });
    const events: DiagnosticEvent[] = [];
    h.d.recordDiagnostic = event => { events.push(event); };
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'verifying', intent: null });
    expect(h.mutations).toEqual([]);
    expect(h.checkpoints).toEqual([]);
    const names = vi.mocked(h.d.inject).mock.calls.map(call => call[1].name).filter(name => name !== 'readSiteMaintenance');
    expect(names).not.toContain('performPaidAction');
    expect(names).not.toContain('fetchTimesJson');
    expect(names).not.toContain('performAppointmentSubmission');
    expect(events.filter(event => event.code === 'executor-park').at(-1)).toMatchObject({ detail: 'config-changed' });
    expect(JSON.stringify(events)).not.toMatch(/Toronto|Vancouver|2026-11-19/);
  });
  it('skips the date when the slot vanishes during a consulate switch', async () => {
    const h = harness('form'); h.page.facilityId = 94;
    const original = h.d.inject;
    h.d.inject = async (...args) => {
      if (args[1].name === 'performPaidAction') {
        h.mutations.push(args[2]![0] as PaidAction);
        return { ok: false, reason: 'facility-date-unavailable' };
      }
      return original(...args);
    };
    const events: DiagnosticEvent[] = [];
    h.d.recordDiagnostic = event => { events.push(event); };
    const state = seeded('form');
    state.executor!.skippedDates = [{ consulate: 'Toronto', date: '2026-11-19' }];
    const next = validateEngineState(await runBookingStage(h.d, state));
    expect(h.mutations.map(m => m.action)).toEqual(['facility']);
    expect(next).toMatchObject({ status: 'running', stage: null, lastCandidate: null, intent: null,
      executor: { targetTime: null, actionPending: false,
        skippedDates: [{ consulate: 'Toronto', date: '2026-11-19' }, { consulate: 'Vancouver', date: '2026-11-19' }] } });
    expect(JSON.stringify(events)).not.toMatch(/Toronto|Vancouver|2026-11-19/);
  });
  it('dedupes the skipped pair when the slot vanishes again', async () => {
    const h = harness('form'); h.page.facilityId = 94;
    const original = h.d.inject;
    h.d.inject = async (...args) => args[1].name === 'performPaidAction'
      ? { ok: false, reason: 'facility-date-unavailable' } : original(...args);
    const state = seeded('form');
    state.executor!.skippedDates = [{ consulate: 'Vancouver', date: '2026-11-19' }];
    const next = await runBookingStage(h.d, state);
    expect(next).toMatchObject({ status: 'running', stage: null, lastCandidate: null });
    expect(next.executor!.skippedDates).toEqual([{ consulate: 'Vancouver', date: '2026-11-19' }]);
  });
  it('still parks on any other facility refusal', async () => {
    const h = harness('form'); h.page.facilityId = 94;
    const original = h.d.inject;
    h.d.inject = async (...args) => args[1].name === 'performPaidAction'
      ? { ok: false, reason: 'facility-response-invalid' } : original(...args);
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'verifying' });
  });
  it('refuses preferences changing between the read and mutation', async () => {
    const h = harness('form');
    h.page.time = '';
    let calls = 0;
    h.d.loadPrefs = async () => ({ ...PREFS, autoMode: ++calls === 1 });
    expect((await runBookingStage(h.d, seeded('form'))).status).toBe('verifying');
    expect(h.mutations).toEqual([]);
  });
  it('does not inject a mutation when checkpoint storage fails', async () => {
    const h = harness('actions');
    h.d.saveState = async () => { throw new Error('synthetic storage failure'); };
    await expect(runBookingStage(h.d, seeded('actions'))).rejects.toThrow('synthetic storage failure');
    expect(h.mutations).toEqual([]);
  });
  it('parks an interrupted mutation after wake without replaying it', async () => {
    const h = harness('actions');
    const state = seeded('actions');
    state.executor!.actionPending = true;
    expect(reconcileStartup(state, NOW).status).toBe('verifying');
    expect((await runBookingStage(h.d, state)).status).toBe('verifying');
    expect(h.d.inject).not.toHaveBeenCalled();
  });
  it('parks after navigation to a different group before injection', async () => {
    const h = harness('form');
    h.d.getTab = async () => ({ id: 7, url: BASE.replace('11111111', '99999999') + '/appointment' });
    expect((await runBookingStage(h.d, seeded('form'))).status).toBe('verifying');
    expect(h.d.inject).not.toHaveBeenCalled();
  });
});

describe('workflow-blocked telemetry source', () => {
  it.each(['tab', 'roster'] as const)('retains the %s refusal and booking stage without old authentication context', async issue => {
    const h = harness('form');
    const initial = seeded('form');
    initial.failureContext = { category: 'authentication-failed', code: 'credential-rejected', step: 'login-submit', authPurpose: 'start' };
    if (issue === 'tab') h.d.getTab = vi.fn(async () => { throw new Error('synthetic closed tab'); });
    else h.page.applicantIds = ['99999999'];
    const next = validateEngineState(await runBookingStage(h.d, initial));
    expect(next).toMatchObject({ status: 'verifying', failureContext: { category: 'workflow-blocked',
      code: issue === 'tab' ? 'tab-unavailable' : 'applicant-roster-changed', step: 'booking-form' } });
    expect(next.failureContext).not.toHaveProperty('authPurpose');
    expect(h.mutations).toEqual([]);
  });
});

describe('date-only baseline recovery safety', () => {
  it.each(['cancelled', 'settings-changed'])('does not adopt or submit after %s during the fresh baseline read', async issue => {
    const h = harness('form'); const initial = seeded('form');
    let cancelled = false; let changed = false;
    h.d.isCancelled = () => cancelled;
    h.d.loadPrefs = async () => ({ ...PREFS, ...(changed ? { latest: '2026-12-01' } : {}) });
    const inject = h.d.inject;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => {
      if (args[1].name === 'readCurrentAppointment') {
        cancelled = issue === 'cancelled'; changed = issue === 'settings-changed';
        return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'September 15, 2026', applicantIds: IDS };
      }
      return inject(...args);
    });
    const next = await runBookingStage(h.d, initial);
    expect(next).toMatchObject({ status: 'verifying', group: { currentDate: '2027-01-01' }, intent: null });
    expect(h.mutations).toEqual([]);
    expect(vi.mocked(h.d.inject).mock.calls.some(call => call[1].name === 'performAppointmentSubmission')).toBe(false);
  });
  it('sends a changed pre-confirmation baseline to verification without adopting or clicking confirmation', async () => {
    const h = harness('form'); const initial = seeded('confirm');
    initial.intent = { runId: RUN, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, phase: 'submitted', createdAt: NOW };
    initial.executor!.targetTime = '09:15';
    const inject = h.d.inject;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => {
      if (args[1].name === 'waitForAppointmentDialog') return { ok: true };
      if (args[1].name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: '22222222',
        kind: 'booked', text: 'September 15, 2026', applicantIds: IDS };
      return inject(...args);
    });
    const next = await runBookingStage(h.d, initial);
    expect(next).toMatchObject({ status: 'verifying', stage: 'done', group: { currentDate: '2027-01-01' },
      intent: initial.intent, verification: { nextReadAt: '2026-10-12T00:00:30.000Z' } });
    expect(vi.mocked(h.d.inject).mock.calls.some(call => call[1].name === 'performAppointmentSubmission')).toBe(false);
  });
});

it('cannot execute a stale candidate stage while baseline recovery authentication is active', async () => {
  const h = harness('form'); const initial = seeded('form');
  initial.authentication = { tabId: 7, phase: 'prepare', purpose: 'renew', pending: false, startedAt: NOW, dashboardFirst: true };
  expect(await runBookingStage(h.d, initial)).toBe(initial);
  expect(h.d.inject).not.toHaveBeenCalled();
  expect(h.d.loadPrefs).not.toHaveBeenCalled();
});

describe('actionable failure attribution', () => {
  it.each([
    ['facility', 'facility-response-invalid', 'booking-facility-change'],
    ['date', 'calendar-response-invalid', 'booking-date-change'],
    ['time', 'control-disabled', 'booking-time-change'],
  ] as const)('preserves the adapter cause for a failed %s action', async (action, reason, step) => {
    const h = harness('form');
    if (action === 'facility') h.page.facilityId = 94;
    if (action === 'date') h.page.calendarReady = false;
    if (action === 'time') h.page.time = '10:30';
    const inject = h.d.inject;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'performPaidAction'
      ? { ok: false, reason } : inject(...args));
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'verifying', intent: null,
      failureContext: { category: 'workflow-blocked', code: reason, step } });
    expect(h.checkpoints.at(-1)).toMatchObject({ failureContext: { code: 'checkpoint-interrupted', step }, executor: { actionPending: true } });
  });
  it.each([
    [null, 'adapter-reply-missing'],
    [undefined, 'adapter-reply-missing'],
    [[], 'adapter-reply-malformed'],
    [{ ok: 'false' }, 'adapter-reply-malformed'],
    [{ ok: false, reason: 'private@example.invalid <html>secret</html>' }, 'adapter-reason-unrecognized'],
  ] as const)('distinguishes unusable action replies without exporting them (%j)', async (reply, code) => {
    const h = harness('form'); h.page.calendarReady = false;
    const inject = h.d.inject;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'performPaidAction' ? reply : inject(...args));
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next.failureContext).toEqual({ category: 'workflow-blocked', code, step: 'booking-date-change' });
    expect(JSON.stringify(next.failureContext)).not.toMatch(/private@|html|secret/);
  });
  it.each([
    ['form-facility-invalid', { facilityId: null }],
    ['page-kind-mismatch', { kind: 'warning' }],
    ['booking-policy-consulate-mismatch', { facilityId: 94 }],
  ] as const)('names the precise final form refusal (%s)', async (code, patch) => {
    const h = harness('form'); const inject = h.d.inject;
    let reads = 0;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'readPaidPage' && ++reads === 2
      ? { ...h.page, ...patch } : inject(...args));
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'verifying', intent: null, failureContext: { code,
      step: code.startsWith('booking-policy-') ? 'booking-policy-check' : 'booking-form-read' } });
    expect(vi.mocked(h.d.inject).mock.calls.some(call => call[1].name === 'performAppointmentSubmission')).toBe(false);
  });
  it('retains the exact interrupted action through worker recovery, without replay', async () => {
    const h = harness('form'); h.page.calendarReady = false;
    h.d.saveState = async checkpoint => { h.checkpoints.push(structuredClone(checkpoint)); throw new Error('synthetic save interrupted'); };
    await expect(runBookingStage(h.d, seeded('form'))).rejects.toThrow('synthetic save interrupted');
    const restored = reconcileStartup(h.checkpoints.at(-1)!, NOW);
    expect(restored).toMatchObject({ status: 'verifying', failureContext: {
      category: 'workflow-blocked', code: 'checkpoint-interrupted', step: 'booking-date-change' } });
    expect(h.mutations).toEqual([]);
  });
});


describe('automatic form timeout recovery', () => {
  function timeoutHarness(action: 'date' | 'facility') {
    const h = harness('form');
    if (action === 'date') h.page.calendarReady = false;
    else h.page.facilityId = 94;
    const original = h.d.inject;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'performPaidAction'
      ? { ok: false, reason: action === 'date' ? 'calendar-load-timeout' : 'facility-load-timeout' } : original(...args));
    return h;
  }
  it.each(['date', 'facility'] as const)('rebuilds after a returned %s timeout with no stale candidate or terminal failure', async action => {
    const h = timeoutHarness(action);
    const next = validateEngineState(await runBookingStage(h.d, seeded('form')));
    expect(next).toMatchObject({ status: 'running', intent: null, stage: null, lastCandidate: null,
      formLoadFailures: 1, consecutiveFailures: 1, nextPollAt: '2026-10-12T00:01:00.000Z', failureContext: null,
      executor: { tabId: 7, actionPending: false, targetTime: null, skippedDates: [] },
      authentication: { purpose: 'renew', phase: 'retry', dashboardFirst: true, pending: false } });
    expect(h.d.createTab).not.toHaveBeenCalled();
    const prefs = { ...PREFS, email: 'fixture@example.invalid', password: 'synthetic-password', interval: 60, paidIvr: '22222222', unpaidIvr: '' };
    h.d.loadPrefs = async () => prefs;
    h.d.navigateTab = vi.fn(async () => ({}));
    // Even direct/early execution cannot shorten the retry deadline.
    expect(await runAuthentication(h.d, next)).toEqual(next);
    expect(h.d.navigateTab).not.toHaveBeenCalled();
    h.d.nowIso = () => '2026-10-12T00:01:00.000Z';
    const recovering = await runAuthentication(h.d, next);
    expect(recovering.status).toBe('running');
    expect(h.d.navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/');
    expect(h.checkpoints.at(-1)).toMatchObject({ authentication: { pending: true, checkpoint: 'navigation' } });
    expect(h.d.inject).not.toHaveBeenCalledWith(7, expect.objectContaining({ name: 'performAppointmentSubmission' }), expect.anything());
  });
  it('cools down repeated timeouts even when dashboard authentication and polls succeeded between them', async () => {
    const h = timeoutHarness('date');
    let state = seeded('form');
    for (let count = 1; count <= 10; count++) {
      const next = validateEngineState(await runBookingStage(h.d, state));
      expect(next.status).toBe('running');
      expect(next.formLoadFailures).toBe(count === 10 ? 0 : count);
      expect(next.cooldownUntil).toBe(count === 10 ? '2026-10-12T00:30:00.000Z' : null);
      // Successful auth/polls reset their own budgets, but retain the
      // persisted form timeout count until a date/time action succeeds.
      state = { ...seeded('form'), formLoadFailures: next.formLoadFailures };
    }
  });
  it.each(['cancelled', 'settings', 'navigation'] as const)('does not rebuild after %s changed during the timeout', async issue => {
    const h = timeoutHarness('date'); const inject = h.d.inject;
    let returned = false;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => {
      const reply = await inject(...args);
      if (args[1].name === 'performPaidAction') returned = true;
      return reply;
    });
    h.d.isCancelled = () => issue === 'cancelled' && returned;
    h.d.loadPrefs = async () => ({ ...PREFS, onlyEarlier: !(issue === 'settings' && returned) });
    const getTab = h.d.getTab;
    h.d.getTab = async id => issue === 'navigation' && returned ? { id, url: 'https://example.invalid/' } : getTab(id);
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next.authentication).toBeNull();
    expect(next.status).toBe('verifying');
  });
  it('retains the separate timeout budget until final form validation succeeds', async () => {
    const h = harness('form'); h.page.calendarReady = false;
    const next = await runBookingStage(h.d, { ...seeded('form'), formLoadFailures: 8 });
    expect(next).toMatchObject({ status: 'running', formLoadFailures: 8, executor: { actionPending: false } });
  });
  it('migrates old saves and refuses corrupt recovery budgets', () => {
    const legacy = seeded('form'); delete legacy.formLoadFailures;
    expect(validateEngineState(legacy).formLoadFailures).toBe(0);
    for (const formLoadFailures of [-1, 10, 0.5, '1'])
      expect(() => validateEngineState({ ...legacy, formLoadFailures })).toThrow('Invalid form recovery budget.');
  });
});

describe('safe broader recovery', () => {
  it.each(['date', 'facility'] as const)('paces transient %s errors and denied responses on the durable form budget', async action => {
    for (const suffix of ['load-timeout', 'network-failed', 'server-error', 'request-denied', 'request-retryable']) {
      const h = harness('form'); if (action === 'date') h.page.calendarReady = false; else h.page.facilityId = 94;
      const inject = h.d.inject;
      h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'performPaidAction'
        ? { ok: false, reason: `${action === 'date' ? 'calendar' : 'facility'}-${suffix}` } : inject(...args));
      const next = validateEngineState(await runBookingStage(h.d, { ...seeded('form'), formLoadFailures: 9 }));
      expect(next).toMatchObject({ status: 'running', intent: null, lastCandidate: null, formLoadFailures: 0,
        cooldownUntil: '2026-10-12T00:30:00.000Z', authentication: { dashboardFirst: true, phase: 'retry' }, executor: { actionPending: false } });
      expect(vi.mocked(h.d.inject).mock.calls.some(call => call[1].name === 'performAppointmentSubmission')).toBe(false);
    }
  });
  it('skips only the current consulate/date when a time vanished', async () => {
    const h = harness('form'); h.page.time = '10:30'; const inject = h.d.inject;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'performPaidAction'
      ? { ok: false, reason: 'time-option-unavailable' } : inject(...args));
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ status: 'running', stage: null, lastCandidate: null, authentication: null,
      nextPollAt: '2026-10-12T00:01:00.000Z', executor: { actionPending: false, targetTime: null,
        skippedDates: [{ consulate: 'Vancouver', date: '2026-11-19' }] } });
  });
  it.each(['null', 'not-ready', 'date', 'time'] as const)('rebuilds a final reread %s and retains its budget through successful field selections', async issue => {
    const h = harness('form'); const inject = h.d.inject; let reads = 0;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'readPaidPage' && ++reads === 2
      ? issue === 'null' ? null : { ...h.page, ...(issue === 'not-ready' ? { calendarReady: false } : issue === 'date' ? { date: '2026-11-20' } : { time: '10:30' }) } : inject(...args));
    const next = await runBookingStage(h.d, { ...seeded('form'), formLoadFailures: 9 });
    expect(next).toMatchObject({ status: 'running', intent: null, lastCandidate: null, cooldownUntil: '2026-10-12T00:30:00.000Z',
      formLoadFailures: 0, authentication: { dashboardFirst: true, phase: 'retry' } });
    expect(vi.mocked(h.d.inject).mock.calls.some(call => call[1].name === 'performAppointmentSubmission')).toBe(false);
  });
  it.each(['group', 'roster'] as const)('does not rebuild or skip a slot when a simultaneous %s mismatch is readable', async issue => {
    const h = harness('form'); const inject = h.d.inject; let reads = 0;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'readPaidPage' && ++reads === 2
      ? { ...h.page, slotWarning: true, calendarReady: false, ...(issue === 'group' ? { scheduleId: '99999999' } : { applicantIds: ['99999999'] }) } : inject(...args));
    expect(await runBookingStage(h.d, seeded('form'))).toMatchObject({ status: 'verifying', authentication: null,
      failureContext: { code: issue === 'group' ? 'group-identity-changed' : 'applicant-roster-changed' } });
  });
  it.each(['missing', 'exception', 'wake'] as const)('rebuilds a typed preliminary GET after %s, without replaying its click', async issue => {
    const h = harness('actions'); const inject = h.d.inject;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => {
      if (args[1].name !== 'performPaidAction') return inject(...args);
      if (issue === 'wake') throw new Error('Synthetic interruption');
      if (issue === 'exception') throw new Error('Synthetic lost navigation reply');
      return null;
    });
    let next: EngineState;
    if (issue === 'wake') {
      const checkpoint = { ...seeded('actions'), executor: { ...seeded('actions').executor!, applicantIds: IDS, actionPending: true, entryAction: 'reschedule' as const } };
      const woke = reconcileStartup(validateEngineState(checkpoint), NOW);
      expect(woke.status).toBe('running');
      expect(reconcileStartup(checkpoint, NOW, true).status).toBe('verifying');
      next = await runBookingStage(h.d, woke);
      expect(h.d.inject).not.toHaveBeenCalled();
    } else {
      const initial = seeded('actions'); initial.executor!.applicantIds = IDS;
      next = await runBookingStage(h.d, initial);
      expect(vi.mocked(h.d.inject).mock.calls.filter(call => call[1].name === 'performPaidAction')).toHaveLength(1);
      expect(h.checkpoints.at(-1)?.executor?.entryAction).toBe('reschedule');
    }
    expect(validateEngineState(next)).toMatchObject({ status: 'running', intent: null, lastCandidate: null, entryRecoveryFailures: 1,
      authentication: { dashboardFirst: true, phase: 'retry' }, executor: { actionPending: false } });
  });
  it('keeps explicit unsafe gateway refusals blocked and does not recover a generic pending checkpoint', async () => {
    const h = harness('actions'); const inject = h.d.inject; const initial = seeded('actions'); initial.executor!.applicantIds = IDS;
    h.d.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'performPaidAction'
      ? { ok: false, reason: 'wrong-target' } : inject(...args));
    expect(await runBookingStage(h.d, initial)).toMatchObject({ status: 'verifying', authentication: null, failureContext: { code: 'wrong-target' } });
    const generic = { ...initial, executor: { ...initial.executor!, actionPending: true } };
    expect(reconcileStartup(generic, NOW).status).toBe('verifying');
    expect(await runBookingStage(h.d, generic)).toMatchObject({ status: 'verifying', authentication: null });
  });
  it('resets form recovery only after all final safety checks passed, before a new intent', async () => {
    const h = harness('form');
    h.d.inject = vi.fn(async (id, func, args) => func.name === 'performAppointmentSubmission' ? { ok: false } :
      func.name === 'readPaidPage' ? h.page : func.name === 'readCurrentAppointment'
        ? { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: IDS }
        : { status: 200, body: { available_times: ['09:15'] } });
    const next = await runBookingStage(h.d, { ...seeded('form'), formLoadFailures: 9 });
    expect(next).toMatchObject({ formLoadFailures: 0, status: 'verifying', stage: 'done', intent: { phase: 'prepared' } });
  });
});
