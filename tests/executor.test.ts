import { describe, expect, it, vi } from 'vitest';
import { bindGroup, emptyEngineState, reconcileStartup, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
import { recordCandidate, setStage, type BookingStage } from '../src/engine/poll';
import { runBookingStage, type ExecDeps } from '../src/engine/executor';
import type { DiagnosticEvent } from '../src/domain/diagnostics';
import type { PaidPage } from '../src/adapter/paid';
import type { PaidAction } from '../src/adapter/acts';

const NOW = '2026-10-12T00:00:00.000Z';
const OWNER = 'owner-token-01';
const RUN = 'run-id-0001';
const BASE = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
const IDS = ['77777777', '88888888'];
const PREFS = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: true };
function seeded(stage: BookingStage): EngineState {
  const bound = bindGroup(startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }), {
    owner: OWNER, runId: RUN, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', applicantIds: IDS }, now: NOW,
  });
  return { ...setStage(recordCandidate(bound, '2026-11-19', NOW), stage, NOW),
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
    expect(vi.mocked(h.d.inject).mock.calls.map(call => call[1].name)).toEqual(['readCurrentAppointment', 'performDashboardContinue']);
  });
  it.each(['wrong-group', 'wrong-ivr', 'changed-roster', 'changed-baseline', 'cancelled'])(
    'still parks an unsafe dashboard handoff without clicking Continue (%s)', async issue => {
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
      expect(await runBookingStage(h.d, state)).toMatchObject({ status: 'verifying', nextPollAt: null, intent: null });
      expect(h.d.inject).toHaveBeenCalledOnce(); expect(h.checkpoints).toEqual([]); expect(h.mutations).toEqual([]);
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
    'still parks unsafe single-applicant re-entry readings (%s)', async issue => {
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
      expect(await runBookingStage(h.d, state)).toMatchObject({ status: 'verifying', intent: null, nextPollAt: null });
      expect(h.mutations).toEqual([]); expect(h.checkpoints).toEqual([]);
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
    expect(await runBookingStage(h.d, seeded('form'))).toMatchObject({ status: 'verifying', intent: null });
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
  it.each(['changed-date', 'changed-roster'])('refuses a changed fresh dashboard before dry-run completion (%s)', async issue => {
    const h = harness('form');
    const original = h.d.inject;
    h.d.inject = async (...args) => args[1].name === 'readCurrentAppointment'
      ? { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: issue === 'changed-date' ? 'December 1, 2026' : 'January 1, 2027', applicantIds: issue === 'changed-roster' ? IDS.slice(0, 1) : IDS }
      : original(...args);
    expect(await runBookingStage(h.d, seeded('form'))).toMatchObject({ status: 'verifying', intent: null });
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
    expect(form.d.inject).toHaveBeenCalledTimes(1);
    expect(ready.nextPollAt).toBe(NOW);
  });
  it('checkpoints Continue in the owned dashboard tab instead of opening a new tab', async () => {
    const h = harness('actions');
    h.d.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' }));
    const state = seeded('actions');
    state.lastCandidate = null;
    state.group!.dashboardPath = '/en-ca/niv/groups/55555555';
    const original = h.d.inject;
    h.d.inject = vi.fn(async (...args) => {
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
    expect(vi.mocked(h.d.inject).mock.calls.length).toBeLessThanOrEqual(1);
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
  it.each([false, undefined])('prepares gateways in both modes; a missing toggle defaults to Test Mode (%s)', async testMode => {
    const h = harness('actions');
    h.d.loadPrefs = async () => ({ ...PREFS, testMode });
    expect((await runBookingStage(h.d, seeded('actions'))).status).toBe('running');
    expect(h.mutations.map(value => value.action)).toEqual(['reschedule']);
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
  it('rereads the populated form, passes policy, then parks at the Test Mode dry-run boundary without clicking submit', async () => {
    const h = harness('form');
    const next = await runBookingStage(h.d, seeded('form'));
    expect(next).toMatchObject({ stage: 'done', status: 'verifying', intent: null, verification: null });
    expect(h.mutations).toEqual([]);
    expect(vi.mocked(h.d.inject).mock.calls.filter(call => call[1].name === 'readPaidPage')).toHaveLength(2);
    expect(vi.mocked(h.d.inject).mock.calls.some(call => call[1].name === 'performAppointmentSubmission')).toBe(false);
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
    expect(next.status).toBe('verifying');
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
    expect(await runBookingStage(h.d, seeded('form'))).toMatchObject({ stage: null, lastCandidate: null, status: 'running', executor: { skippedDates: ['2026-11-19'] } });
    expect(h.mutations).toEqual([]);
  });
  it('refuses preferences changing between the read and mutation', async () => {
    const h = harness('form');
    h.page.time = '';
    let calls = 0;
    h.d.loadPrefs = async () => ({ ...PREFS, testMode: ++calls === 1 });
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
