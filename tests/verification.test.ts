import { describe, expect, it, vi } from 'vitest';
import { bindGroup, emptyEngineState, parkForReview, recordIntent, reconcileStartup, startRun, validateEngineState } from '../src/engine/workflow';
import { runVerificationRead } from '../src/engine/verification';
import type { DiagnosticEvent } from '../src/domain/diagnostics';
import { engineAlarmAt } from '../src/engine/poll';

const NOW = '2026-10-12T00:00:00.000Z';
const identity = { scheduleId: '11111111', ivr: '22222222' };
const roster = ['77777777', '88888888'];
function seeded(testMode = false, ivr: string | null = identity.ivr) {
  const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
  const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), {
    ...args, binding: { ...identity, ivr, kind: 'paid', currentDate: '2027-06-21', applicantIds: roster },
  });
  return parkForReview(recordIntent(bound, { ...args, intent: {
    runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19', consulate: 'Vancouver', testMode, createdAt: NOW,
  } }), NOW);
}
describe('fresh dashboard verification', () => {
  it('retries a transient active read, retains the intent, and requires three new valid reads before continuation', async () => {
    let now = NOW;
    let state = { ...seeded(), verification: { reads: ['2027-06-21'], nextReadAt: NOW } };
    const intent = state.intent;
    const events: DiagnosticEvent[] = [];
    const recordDiagnostic = (event: DiagnosticEvent) => { events.push(event); };
    let next = await runVerificationRead(state, { now: () => now, random: () => 0, recordDiagnostic,
      read: async () => ({ ...identity, kind: 'read-failure', text: null, status: 503 }) });
    expect(next).toMatchObject({ status: 'verifying', intent, consecutiveFailures: 1,
      verification: { reads: [], nextReadAt: '2026-10-12T00:01:00.000Z' } });
    const read = vi.fn(async () => ({ ...identity, kind: 'booked', text: 'June 21, 2027', applicantIds: roster }));
    expect(await runVerificationRead(next, { now: () => now, read })).toBe(next);
    expect(read).not.toHaveBeenCalled();
    for (const stamp of ['2026-10-12T00:01:00.000Z', '2026-10-12T00:01:02.000Z', '2026-10-12T00:01:04.000Z']) {
      now = stamp;
      next = validateEngineState(await runVerificationRead(next, { now: () => now, read, recordDiagnostic }));
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(next).toMatchObject({ status: 'running', intent: null, consecutiveFailures: 0, cooldownUntil: null });
    expect(events).toContainEqual(expect.objectContaining({ code: 'verification-recovered', failures: 0 }));
    expect(events.at(-1)).toMatchObject({ code: 'verification-resolved', outcome: 'previous-continue' });
  });
  it('cools down after ten transient verification failures and automatically resumes read-only', async () => {
    let now = NOW;
    let state = { ...seeded(), verification: { reads: [], nextReadAt: NOW } };
    const read = async () => ({ ...identity, kind: 'read-failure', text: null, status: 0 });
    for (let index = 1; index <= 10; index++) {
      state = await runVerificationRead(state, { now: () => now, read, random: () => 0 }) as typeof state;
      expect(state.consecutiveFailures).toBe(index);
      now = state.verification!.nextReadAt!;
    }
    expect(state.cooldownUntil).toBe('2026-10-12T00:39:00.000Z');
    expect(engineAlarmAt(state)).toBe(state.cooldownUntil);
    state = await runVerificationRead(state, { now: () => now, read, random: () => 0 }) as typeof state;
    expect(state).toMatchObject({ status: 'verifying', consecutiveFailures: 1, cooldownUntil: null, intent: expect.any(Object) });
  });
  it('never schedules recovery for a deliberately parked verifier or a changed identity', async () => {
    const parked = seeded();
    const failed = { ...identity, kind: 'read-failure', text: null, status: 503 };
    expect(await runVerificationRead(parked, { now: () => NOW, read: async () => failed })).toMatchObject({ verification: null });
    const active = { ...parked, verification: { reads: [], nextReadAt: NOW } };
    const read = vi.fn(async () => ({ ...failed, scheduleId: '33333333' }));
    expect(await runVerificationRead(active, { now: () => NOW, read })).toMatchObject({ verification: null, intent: active.intent });
    read.mockClear();
    expect(await runVerificationRead(active, { now: () => NOW, read, isCancelled: () => true })).toMatchObject({ verification: null });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([false, true])('requires three quickly-paced reads and stops a Test Mode run instead of repeating it (%s)', async testMode => {
    let now = NOW;
    const read = vi.fn(async () => ({ ...identity, kind: 'booked', text: 'June 21, 2027', applicantIds: roster }));
    let state = await runVerificationRead(seeded(testMode), { now: () => now, read });
    expect(state.status).toBe('verifying');
    expect(engineAlarmAt(state)).toBe('2026-10-12T00:00:02.000Z');
    expect(await runVerificationRead(state, { now: () => now, read })).toBe(state);
    expect(read).toHaveBeenCalledTimes(1);
    state = validateEngineState(JSON.parse(JSON.stringify(state)));
    expect(reconcileStartup(state, NOW).verification).toEqual(state.verification);
    // A restart discards stale partial reads and parks with no deadline for
    // an explicit Start instead of healing the stranded check into a pass
    // that could resolve to running.
    expect(reconcileStartup(state, NOW, true).verification).toBeNull();
    for (const timestamp of ['2026-10-12T00:00:02.000Z', '2026-10-12T00:00:04.000Z']) {
      now = timestamp;
      state = await runVerificationRead(state, { now: () => now, read });
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(state).toMatchObject({ status: testMode ? 'stopped' : 'running', intent: null, verification: null, stage: null, executor: null });
  });
  it('resolves an observed target after all reads', async () => {
    let state = seeded();
    for (const now of [NOW, '2026-10-12T00:00:02.000Z', '2026-10-12T00:00:04.000Z']) {
      state = await runVerificationRead(state, { now: () => now, read: async () => ({ ...identity, kind: 'booked', text: 'November 19, 2026', applicantIds: roster }) });
    }
    expect(state).toMatchObject({ status: 'stopped', intent: null, nextPollAt: null });
  });
  it.each(['wrong-group', 'malformed', 'failed'])('keeps unresolved intent on an uncertain fresh read (%s)', async scenario => {
    const state = seeded();
    const next = await runVerificationRead(state, { now: () => NOW, read: async () => {
      if (scenario === 'failed') throw new Error('read failed');
      return { ...identity, scheduleId: scenario === 'wrong-group' ? '33333333' : identity.scheduleId, kind: 'booked', text: 'Unreadable' };
    } });
    expect(next).toMatchObject({ status: 'verifying', intent: state.intent, verification: null });
    expect(engineAlarmAt(next)).toBeNull();
  });
  it('records fixed unreadable diagnostics in the verify phase without raw errors', async () => {
    const events: DiagnosticEvent[] = [];
    const next = await runVerificationRead(seeded(), { now: () => NOW,
      read: async () => { throw new Error('synthetic page failure'); },
      recordDiagnostic: event => { events.push(event); } });
    expect(next).toMatchObject({ status: 'verifying', verification: null });
    expect(events).toEqual([{ code: 'verification-unreadable', detail: 'reply-missing', mode: 'booking', phase: 'verify' }]);
    expect(JSON.stringify(events)).not.toContain('synthetic page failure');
  });
  it('treats a null IVR on either side as identity-compatible and keeps readable disagreements terminal', async () => {
    const events: DiagnosticEvent[] = [];
    // A fallback-bound null-IVR group is proven by its stable schedule: a
    // readable fresh IVR never fabricates a mismatch, so the read progresses.
    const read = vi.fn(async () => ({ scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'June 21, 2027', applicantIds: roster }));
    const progressed = await runVerificationRead({ ...seeded(false, null), verification: { reads: [], nextReadAt: NOW } },
      { now: () => NOW, read, recordDiagnostic: event => { events.push(event); } });
    expect(progressed).toMatchObject({ status: 'verifying', consecutiveFailures: 0, verification: { reads: ['2027-06-21'] } });
    // A readable binding accepts a missing (null) IVR reply the same way.
    const missing = await runVerificationRead({ ...seeded(), verification: { reads: [], nextReadAt: NOW } }, { now: () => NOW,
      read: async () => ({ scheduleId: '11111111', kind: 'booked', text: 'June 21, 2027', applicantIds: roster }) });
    expect(missing).toMatchObject({ status: 'verifying', verification: { reads: ['2027-06-21'] } });
    // Two readable IVRs must agree...
    const mismatch = await runVerificationRead({ ...seeded(), verification: { reads: ['2027-06-21'], nextReadAt: NOW } }, { now: () => NOW,
      recordDiagnostic: event => { events.push(event); },
      read: async () => ({ scheduleId: '11111111', ivr: '99999999', kind: 'booked', text: 'June 21, 2027', applicantIds: roster }) });
    expect(mismatch).toMatchObject({ status: 'verifying', verification: null });
    expect(events).toContainEqual(expect.objectContaining({ code: 'verification-unreadable', detail: 'group-changed' }));
    // ...while a malformed non-string IVR stays a recoverable unreadable reply.
    const malformed = await runVerificationRead({ ...seeded(), verification: { reads: [], nextReadAt: NOW } }, { now: () => NOW,
      read: async () => ({ scheduleId: '11111111', ivr: 12345, kind: 'booked', text: 'June 21, 2027', applicantIds: roster }) });
    expect(malformed).toMatchObject({ status: 'verifying', consecutiveFailures: 1, verification: { reads: [] } });
  });
});
