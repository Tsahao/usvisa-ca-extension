import { describe, expect, it, vi } from 'vitest';
import { bindGroup, emptyEngineState, parkForReview, recordIntent, reconcileStartup, startRun, validateEngineState } from '../src/engine/workflow';
import { runVerificationRead } from '../src/engine/verification';
import { engineAlarmAt } from '../src/engine/poll';

const NOW = '2026-10-12T00:00:00.000Z';
const identity = { scheduleId: '11111111', ivr: '22222222' };
const roster = ['77777777', '88888888'];
function seeded(testMode = false) {
  const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
  const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), {
    ...args, binding: { ...identity, kind: 'paid', currentDate: '2027-06-21', applicantIds: roster },
  });
  return parkForReview(recordIntent(bound, { ...args, intent: {
    runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19', consulate: 'Vancouver', testMode, createdAt: NOW,
  } }), NOW);
}
describe('fresh dashboard verification', () => {
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
});
