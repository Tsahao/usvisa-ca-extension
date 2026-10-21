import { describe, expect, it } from 'vitest';
import {
  emptyEngineState,
  isStaleResult,
  reconcileStartup,
  recordIntent,
  resolveVerification,
  setNextPoll,
  startRun,
  stopRun,
  bindGroup,
  validateEngineState,
  type ConfirmationIntent,
} from '../src/engine/workflow';
import { recordCandidate } from '../src/engine/poll';
import { validateEngineMessage } from '../src/engine/messages';
import { loadEngineState, saveEngineState } from '../src/engine/storage';

const NOW = '2026-10-12T00:00:00.000Z';
const LATER = '2026-10-12T00:05:00.000Z';
const OWNER = 'owner-token-01';
const OTHER = 'other-owner-02';
const RUN = 'run-id-0001';
const RUN2 = 'run-id-0002';

function intent(runId = RUN): ConfirmationIntent {
  return {
    runId,
    mode: 'booking',
    groupId: 'group-1234',
    targetDate: '2026-12-01',
    consulate: 'Vancouver',
    testMode: true,
    createdAt: NOW,
  };
}

describe('resumable engine', () => {
  it('rejects unversioned and malformed saves instead of guessing', () => {
    expect(() => validateEngineState(null)).toThrow();
    expect(() => validateEngineState({ version: 999 })).toThrow();
    expect(() => validateEngineState({ ...emptyEngineState(NOW), status: 'flying' })).toThrow();
    expect(() => validateEngineState({ ...emptyEngineState(NOW), nextPollAt: 'soon' })).toThrow();
  });

  it('makes duplicate Start idempotent without duplicating work', () => {
    const first = startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW });
    const duplicate = startRun(first, { mode: 'alerts', owner: OTHER, runId: RUN2, now: LATER });
    expect(duplicate).toEqual(first);
    expect(duplicate.generation).toBe(1);
  });

  it('enforces one-run ownership on stop and intent', () => {
    const running = startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW });
    expect(stopRun(running, { owner: OTHER, runId: RUN, now: LATER })).toEqual(running);
    expect(recordIntent(running, { owner: OTHER, runId: RUN, intent: intent(), now: LATER })).toEqual(running);
    expect(recordIntent(running, { owner: OWNER, runId: RUN2, intent: intent(RUN2), now: LATER })).toEqual(running);
  });

  it('moves an interrupted confirmation to verification and never replays it', () => {
    const running = recordIntent(
      startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }),
      { owner: OWNER, runId: RUN, intent: intent(), now: NOW },
    );
    const restarted = reconcileStartup(JSON.parse(JSON.stringify(running)), LATER);
    expect(restarted.status).toBe('verifying');
    expect(restarted.intent).toEqual(intent());
    expect(restarted.nextPollAt).toBeNull();
    // A second restart stays in verification; it never auto-resumes.
    expect(reconcileStartup(restarted, LATER).status).toBe('verifying');
  });

  it('preserves deadlines across worker suspension', () => {
    const running = setNextPoll(
      startRun(emptyEngineState(NOW), { mode: 'alerts', owner: OWNER, runId: RUN, now: NOW }),
      { owner: OWNER, runId: RUN, nextPollAt: LATER, now: NOW },
    );
    const restarted = reconcileStartup(running, LATER);
    expect(restarted.status).toBe('running');
    expect(restarted.nextPollAt).toBe(LATER);
    expect(restarted.runId).toBe(RUN);
    expect(reconcileStartup(running, NOW).nextPollAt).toBe(LATER);
    expect(reconcileStartup(running, NOW, true).status).toBe('verifying');
  });

  it('rejects a late Stop from a previous run using the same owner', () => {
    const running = startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN2, now: NOW });
    expect(stopRun(running, { owner: OWNER, runId: RUN, now: LATER })).toBe(running);
  });

  it('cannot bypass an unresolved intent with Stop then Start, including legacy stopped saves', () => {
    const running = recordIntent(startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }), {
      owner: OWNER, runId: RUN, intent: intent(), now: NOW,
    });
    const stopped = stopRun(running, { owner: OWNER, runId: RUN, now: LATER });
    const args = { mode: 'booking' as const, owner: OWNER, runId: RUN2, now: LATER };
    expect(startRun(stopped, args)).toBe(stopped);
    const legacy = { ...stopped, status: 'stopped' as const };
    expect(startRun(legacy, args)).toMatchObject({ status: 'verifying', runId: RUN, intent: intent() });
    expect(reconcileStartup(legacy, LATER).status).toBe('verifying');
    const resolved = resolveVerification(stopped, { owner: OWNER, runId: RUN, outcome: 'target-confirmed', now: LATER });
    expect(startRun(resolved, args)).toMatchObject({ status: 'running', runId: RUN2, intent: null });
  });

  it('resolves verification only for the owning run and consumes intent on continue', () => {
    const verifying = reconcileStartup(
      recordIntent(startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }), {
        owner: OWNER,
        runId: RUN,
        intent: intent(),
        now: NOW,
      }),
      LATER,
    );
    expect(resolveVerification(verifying, { owner: OTHER, runId: RUN, outcome: 'previous-continue', now: LATER })).toEqual(
      verifying,
    );
    const continued = resolveVerification({ ...verifying, stage: 'done', lastCandidate: { date: '2026-12-01', consulate: 'Vancouver' } }, {
      owner: OWNER,
      runId: RUN,
      outcome: 'previous-continue',
      now: LATER,
    });
    expect(continued.status).toBe('running');
    expect(continued.intent).toBeNull();
    expect(continued.stage).toBeNull();
    expect(continued.lastCandidate).toBeNull();
    expect(continued.nextPollAt).toBe(LATER);
    const uncertain = resolveVerification(verifying, {
      owner: OWNER,
      runId: RUN,
      outcome: 'uncertain-stop',
      now: LATER,
    });
    expect(uncertain.status).toBe('verifying');
    expect(uncertain.intent).toEqual(intent());
  });

  it('rejects stale async results by run identity and generation', () => {
    const running = startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW });
    expect(isStaleResult(running, RUN, running.generation)).toBe(false);
    expect(isStaleResult(running, RUN2, running.generation)).toBe(true);
    expect(isStaleResult(running, RUN, running.generation + 1)).toBe(true);
  });

  it('preserves intent and alert state on explicit stop while clearing deadlines', () => {
    const running = setNextPoll(
      recordIntent(startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }), {
        owner: OWNER,
        runId: RUN,
        intent: intent(),
        now: NOW,
      }),
      { owner: OWNER, runId: RUN, nextPollAt: LATER, now: NOW },
    );
    const stopped = stopRun(running, { owner: OWNER, runId: RUN, now: LATER });
    expect(stopped.status).toBe('verifying');
    expect(stopped.nextPollAt).toBeNull();
    expect(stopped.intent).toEqual(intent());
  });

  it('rejects malformed messages without exposing private content', () => {
    expect(() => validateEngineMessage({ type: 'ENGINE_START', mode: 'booking' })).toThrow();
    expect(() => validateEngineMessage({ type: 'BOGUS', owner: OWNER, runId: RUN, now: NOW })).toThrow();
    const message = validateEngineMessage({ type: 'ENGINE_STOP', owner: OWNER, runId: RUN, now: NOW });
    expect(message).toEqual({ type: 'ENGINE_STOP', owner: OWNER, runId: RUN, now: NOW });
    expect(JSON.stringify(message)).not.toContain('password');
  });

  it('binds a resolved group to the owning run and clears it on fresh start', async () => {
    const { bindGroup } = await import('../src/engine/workflow');
    const binding = { scheduleId: '11111111', ivr: '22222222', kind: 'paid' as const, currentDate: null };
    const running = startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW });
    expect(running.group).toBeNull();
    const bound = bindGroup(running, { owner: OWNER, runId: RUN, binding, now: LATER });
    expect(bound.group).toEqual(binding);
    expect(bindGroup(bound, { owner: OTHER, runId: RUN, binding, now: LATER })).toEqual(bound);
    expect(bindGroup(bound, { owner: OWNER, runId: RUN, binding: { ...binding, scheduleId: '99999999' }, now: LATER })).toEqual(bound);
    const stopped = stopRun(bound, { owner: OWNER, runId: RUN, now: LATER });
    expect(stopped.group).toEqual(binding);
    const restarted = startRun(stopped, { mode: 'booking', owner: OWNER, runId: RUN2, now: LATER });
    expect(restarted.group).toBeNull();
  });

  it('migrates group-less saves to unbound instead of rejecting them', async () => {
    const { validateEngineState } = await import('../src/engine/workflow');
    const legacy = { ...emptyEngineState(NOW) };
    delete (legacy as Record<string, unknown>).group;
    expect(validateEngineState(legacy).group).toBeNull();
  });

  it('parks running work for review without losing anything', async () => {
    const { parkForReview } = await import('../src/engine/workflow');
    const running = startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW });
    const parked = parkForReview(setNextPoll(running, { owner: OWNER, runId: RUN, nextPollAt: LATER, now: NOW }), LATER);
    expect(parked.status).toBe('verifying');
    expect(parked.nextPollAt).toBeNull();
    expect(parked.runId).toBe(RUN);
    expect(parkForReview(emptyEngineState(NOW), LATER).status).toBe('idle');
  });

  it('survives a storage round-trip and fails closed when writes fail', async () => {
    const state = recordIntent(
      startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }),
      { owner: OWNER, runId: RUN, intent: intent(), now: NOW },
    );
    let saved: Record<string, unknown> = {};
    const area = {
      get: async () => ({ ...saved }),
      set: async (values: Record<string, unknown>) => {
        saved = { ...saved, ...values };
      },
    };
    await saveEngineState(area, state);
    expect(await loadEngineState(area)).toEqual(state);
    saved = { engineStateV1: { version: 1, broken: true } };
    await expect(loadEngineState(area)).rejects.toThrow();
    const failing = {
      get: async () => ({}),
      set: async () => {
        throw new Error('quota exceeded');
      },
    };
    await expect(saveEngineState(failing, state)).rejects.toThrow();
  });

  it('clears legacy string candidates and validates consulate candidates', () => {
    const saved = JSON.parse(JSON.stringify(emptyEngineState(NOW)));
    const executor = { tabId: 7, applicantIds: null, targetTime: null, actionPending: false };
    expect(validateEngineState({ ...saved, lastCandidate: '2026-11-19' }).lastCandidate).toBeNull();
    expect(validateEngineState({ ...saved, lastCandidate: { date: '2026-11-19', consulate: 'Halifax' } }).lastCandidate)
      .toEqual({ date: '2026-11-19', consulate: 'Halifax' });
    expect(() => validateEngineState({ ...saved, lastCandidate: { date: '2026-11-19', consulate: 'Paris' } })).toThrow('Invalid engine state.');
    expect(() => validateEngineState({ ...saved, lastCandidate: { date: 'nope', consulate: 'Halifax' } })).toThrow('Invalid engine state.');
    expect(validateEngineState({ ...saved, executor: { ...executor, skippedDates: ['2026-11-19', { consulate: 'Toronto', date: '2026-11-20' }] } })
      .executor!.skippedDates).toEqual([{ consulate: 'Toronto', date: '2026-11-20' }]);
    expect(() => validateEngineState({ ...saved, executor: { ...executor, skippedDates: [{ consulate: 'Toronto', date: '2026-11-20' }, { consulate: 'Toronto', date: '2026-11-20' }] } }))
      .toThrow('Invalid executor state.');
    expect(() => validateEngineState({ ...saved, executor: { ...executor, skippedDates: [{ consulate: 'Paris', date: '2026-11-20' }] } }))
      .toThrow('Invalid executor state.');
  });

  it('records consulate candidates only while running', () => {
    const started = startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW });
    const running = bindGroup(started, { owner: OWNER, runId: RUN, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null }, now: NOW });
    expect(recordCandidate(running, { date: '2026-11-19', consulate: 'Halifax' }, NOW).lastCandidate).toEqual({ date: '2026-11-19', consulate: 'Halifax' });
    expect(() => recordCandidate(running, { date: '2026-11-19', consulate: 'Paris' as never }, NOW)).toThrow('Invalid candidate consulate.');
    expect(() => recordCandidate(running, { date: 'bad', consulate: 'Halifax' }, NOW)).toThrow('Invalid candidate date.');
  });
});
