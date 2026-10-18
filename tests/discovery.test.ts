import { describe, expect, it } from 'vitest';
import { dashboardFeatures } from '../src/domain/features';
import { resolveGroup } from '../src/domain/groups';
import { assessDashboard } from '../src/engine/discovery';
import { panelSnapshot } from '../src/engine/panel';
import { emptyEngineState, startRun, stopRun, validateEngineState, type EngineState } from '../src/engine/workflow';

const now = '2026-10-17T12:00:00.000Z';
const paid = { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' };
const unpaid = { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' };
const started = (): EngineState => ({ ...startRun(emptyEngineState(now), { mode: 'booking', owner: 'owner-token-01', runId: 'run-token-001', now }),
  discovery: { features: null, requested: true, choosing: false } });

describe('dashboard-driven onboarding', () => {
  it.each([
    [[paid], 'booking'], [[unpaid], 'alerts'], [[unpaid, paid], 'both'],
    [[{ ...paid, paymentStatus: 'unknown' }], 'booking'],
    [[paid, { ...unpaid, paymentStatus: 'unknown' }], 'booking'],
    [[{ scheduleId: '', ivr: null, paymentStatus: 'unknown' }], 'booking'], [[], 'booking'],
  ])('classifies trusted payment evidence with a scheduling fallback (%j)', (groups, expected) => {
    expect(dashboardFeatures({ groups })).toBe(expected);
  });

  it('rejects malformed and ambiguous identities rather than making them feature evidence', () => {
    for (const raw of [null, {}, { groups: null }, { groups: [null] }, { groups: [{ ...paid, scheduleId: 'bad' }] }, { groups: [paid, paid] }])
      expect(() => dashboardFeatures(raw)).toThrow();
  });

  it('automatically chooses the sole feature without creating booking authority', () => {
    const selected = assessDashboard(started(), { groups: [unpaid] });
    expect(selected).toMatchObject({ mode: 'alerts', status: 'running', intent: null, group: null, executor: null,
      discovery: { features: 'alerts', requested: false, choosing: false } });
    expect(panelSnapshot(selected, null, null)).toMatchObject({ mode: 'alerts', availableModes: 'alerts' });
  });

  it('parks mixed first-time accounts on the dashboard with no work or deadlines', () => {
    const chosen = assessDashboard(started(), { groups: [unpaid, paid] });
    expect(validateEngineState(chosen)).toMatchObject({ status: 'stopped', group: null, authentication: null, intent: null,
      nextPollAt: null, executor: null, monitorTabId: null, discovery: { features: 'both', choosing: true, requested: false } });
    expect(panelSnapshot(chosen, null, null)).toMatchObject({ status: 'idle', availableModes: 'both', modeChoiceRequired: true });
    const resumed = startRun(chosen, { mode: 'alerts', owner: 'owner-token-01', runId: 'run-token-002', now });
    expect(assessDashboard(resumed, { groups: [unpaid, paid] })).toMatchObject({ mode: 'alerts', status: 'running', discovery: { choosing: false } });
  });

  it('retains initial discovery across an explicit Stop and resumes only on Start', () => {
    const state = started();
    const stopped = stopRun(state, { owner: state.owner!, runId: state.runId!, now });
    expect(stopped.status).toBe('stopped');
    expect(stopped.nextPollAt).toBeNull();
    expect(panelSnapshot(stopped, null, null).discovering).toBeUndefined();
    const resumed = startRun(stopped, { mode: 'booking', owner: state.owner!, runId: 'run-token-002', now });
    expect(assessDashboard(resumed, { groups: [paid, unpaid] }).discovery?.choosing).toBe(true);
  });

  it('preserves the last mode for returning mixed accounts and updates a changed sole feature', () => {
    const returning: EngineState = { ...started(), mode: 'alerts', discovery: { features: 'both', requested: false, choosing: false } };
    expect(assessDashboard(returning, { groups: [paid, unpaid] })).toMatchObject({ mode: 'alerts', discovery: { choosing: false } });
    expect(assessDashboard(returning, { groups: [paid] })).toMatchObject({ mode: 'booking', group: null, executor: null, lastCandidate: null });
  });

  it('never lets feature discovery discard unresolved intent or a mutation checkpoint', () => {
    const state = started();
    const intent = { runId: state.runId!, mode: 'booking' as const, groupId: paid.scheduleId, targetDate: '2026-12-01', consulate: 'Vancouver', testMode: false, createdAt: now };
    const verifying = { ...state, intent };
    expect(assessDashboard(verifying, { groups: [unpaid] })).toBe(verifying);
    const mutating = { ...state, executor: { tabId: 7, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: true } };
    expect(assessDashboard(mutating, { groups: [unpaid] })).toBe(mutating);
  });

  it('uses the first paid group in mixed page order, while exact IVRs never fall back', () => {
    const args = { mode: 'booking' as const, paidIvr: '', unpaidIvr: '', preferPaid: true };
    expect(resolveGroup({ groups: [unpaid, paid] }, args)).toEqual({ scheduleId: paid.scheduleId, ivr: paid.ivr });
    expect(() => resolveGroup({ groups: [unpaid, paid] }, { ...args, paidIvr: unpaid.ivr })).toThrow('Unpaid group rejected');
    expect(() => resolveGroup({ groups: [unpaid, paid] }, { ...args, paidIvr: '99999999' })).toThrow('Paid group not found');
  });

  it('migrates old states without assuming feature availability and rejects corrupt discovery saves', () => {
    expect(validateEngineState(emptyEngineState(now)).discovery).toBeUndefined();
    for (const discovery of [null, {}, { features: 'all', choosing: false, requested: false },
      { features: 'booking', choosing: true, requested: false }, { features: 'both', choosing: true, requested: true }])
      expect(() => validateEngineState({ ...started(), discovery })).toThrow('Invalid dashboard discovery');
  });
});
