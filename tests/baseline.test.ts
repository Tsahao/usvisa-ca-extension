import { describe, expect, it } from 'vitest';
import { adoptAppointmentBaseline } from '../src/engine/baseline';
import { bindGroup, emptyEngineState, startRun, validateEngineState } from '../src/engine/workflow';

const now = '2026-10-24T00:00:00.000Z';
const args = { owner: 'owner-token-01', runId: 'baseline-run-01', now };
const ids = ['77777777', '88888888'];
const reading = { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'September 15, 2026', applicantIds: ids };
function state() {
  return { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
    binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', applicantIds: ids } }),
    stage: 'form', lastCandidate: { date: '2026-11-19', consulate: 'Vancouver' as const },
    executor: { tabId: 7, applicantIds: ids, targetTime: '09:15', skippedDates: [{ date: '2026-11-20', consulate: 'Vancouver' as const }], actionPending: false } };
}

describe('fresh appointment baseline adoption', () => {
  it.each(['earlier', 'later', 'cancelled', 'new-booking'] as const)('adopts a validated %s date without keeping stale booking authority', issue => {
    const initial = state();
    if (issue === 'new-booking') initial.group!.currentDate = null;
    const raw = issue === 'cancelled' ? { ...reading, kind: 'unbooked', text: null }
      : { ...reading, text: issue === 'later' ? 'February 1, 2027' : reading.text };
    const next = validateEngineState(adoptAppointmentBaseline(initial, raw, now));
    expect(next).toMatchObject({ status: 'running', intent: null, lastCandidate: null, stage: null,
      executor: { tabId: 7, targetTime: null, skippedDates: [], actionPending: false }, failureContext: null });
    expect(next.group!.currentDate).toBe(issue === 'cancelled' ? null : issue === 'later' ? '2027-02-01' : '2026-09-15');
    expect(adoptAppointmentBaseline(next, raw, now)).toBe(next);
    expect(initial.group!.currentDate).toBe(issue === 'new-booking' ? null : '2027-01-01');
  });
  it.each(['wrong-group', 'wrong-ivr', 'missing-roster', 'changed-roster', 'malformed', 'missing-kind'])('refuses unsupported evidence (%s)', issue => {
    const raw = { ...reading } as Record<string, unknown>;
    if (issue === 'wrong-group') raw.scheduleId = '99999999';
    if (issue === 'wrong-ivr') raw.ivr = '99999999';
    if (issue === 'missing-roster') delete raw.applicantIds;
    if (issue === 'changed-roster') raw.applicantIds = [ids[0]];
    if (issue === 'malformed') raw.text = 'unrecognized';
    if (issue === 'missing-kind') delete raw.kind;
    expect(() => adoptAppointmentBaseline(state(), raw, now)).toThrow();
  });
  it.each(['intent', 'pending-mutation', 'pending-auth', 'stopped', 'unpaid'] as const)('does not reinterpret an uncertain or unqualified workflow (%s)', issue => {
    const initial = state();
    if (issue === 'intent') initial.intent = { runId: args.runId, groupId: '11111111', mode: 'booking', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: now };
    if (issue === 'pending-mutation') initial.executor.actionPending = true;
    if (issue === 'pending-auth') initial.authentication = { tabId: 7, pending: true, phase: 'submit', purpose: 'renew', startedAt: now };
    if (issue === 'stopped') initial.status = 'stopped';
    if (issue === 'unpaid') initial.group!.kind = 'unpaid';
    expect(() => adoptAppointmentBaseline(initial, reading, now)).toThrow();
  });
});
