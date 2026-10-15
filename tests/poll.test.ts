import { describe, expect, it } from 'vitest';
import { bindGroup, emptyEngineState, startRun } from '../src/engine/workflow';
import { applyPollResult, engineAlarmAt, planPollStep } from '../src/engine/poll';

const NOW = '2026-10-12T00:00:00.000Z';
const OWNER = 'owner-token-01';
const RUN = 'run-id-0001';
const BINDING = { scheduleId: '11111111', ivr: '22222222', kind: 'paid' as const, currentDate: null };

function running() {
  const started = startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW });
  return bindGroup(started, { owner: OWNER, runId: RUN, binding: BINDING, now: NOW });
}

describe('poll planner and budgets', () => {
  it('polls bound runs, waits on deadlines, and parks everything else', () => {
    expect(planPollStep(running(), NOW)).toEqual({ action: 'poll-now' });
    expect(planPollStep(emptyEngineState(NOW), NOW)).toEqual({ action: 'none', reason: 'not-running' });
    expect(
      planPollStep(startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }), NOW),
    ).toEqual({ action: 'none', reason: 'unbound' });
    const waiting = { ...running(), nextPollAt: '2026-10-12T01:00:00.000Z' };
    expect(planPollStep(waiting, NOW)).toEqual({ action: 'wait', until: '2026-10-12T01:00:00.000Z' });
    const cooling = { ...running(), cooldownUntil: '2026-10-12T01:00:00.000Z' };
    expect(planPollStep(cooling, NOW)).toEqual({ action: 'wait', until: cooling.cooldownUntil });
  });

  it('refunds healthy polls with jittered deadlines', () => {
    const next = applyPollResult(running(), { outcome: 'healthy', now: NOW, random: () => 0 });
    expect(next.consecutiveFailures).toBe(0);
    expect(next.cooldownUntil).toBeNull();
    expect(next.nextPollAt).toBe('2026-10-12T00:01:00.000Z');
  });

  it('cools paid empties at four and retries on the configured cadence before that', () => {
    let state = running();
    for (let count = 1; count <= 3; count += 1) {
      state = applyPollResult(state, { outcome: 'empty', now: NOW, random: () => 0 });
      expect(state.consecutiveFailures).toBe(count);
      expect(state.nextPollAt).toBe('2026-10-12T00:01:00.000Z');
    }
    state = applyPollResult(state, { outcome: 'empty', now: NOW, random: () => 0 });
    expect(state.consecutiveFailures).toBe(4);
    expect(state.nextPollAt).toBeNull();
    expect(state.cooldownUntil).toBe('2026-10-12T00:30:00.000Z');
    expect(engineAlarmAt(state)).toBe(state.cooldownUntil);
  });

  it('keeps the cooldown deadline despite an earlier poll kick and resets the budget after expiry', () => {
    const cooled = { ...running(), consecutiveFailures: 10, cooldownUntil: '2026-10-12T01:00:00.000Z', nextPollAt: NOW };
    expect(planPollStep(cooled, NOW)).toEqual({ action: 'wait', until: cooled.cooldownUntil });
    expect(engineAlarmAt(cooled)).toBe(cooled.cooldownUntil);
    expect(engineAlarmAt({ ...cooled, status: 'verifying' })).toBeNull();
    expect(planPollStep(cooled, cooled.cooldownUntil)).toEqual({ action: 'poll-now' });
    const failed = applyPollResult(cooled, { outcome: 'retryable', now: cooled.cooldownUntil, random: () => 0 });
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.cooldownUntil).toBeNull();
    expect(failed.nextPollAt).toBe('2026-10-12T01:01:00.000Z');
  });

  it('budgets verification authentication retries without losing intent', () => {
    const bound = bindGroup(
      startRun(emptyEngineState(NOW), { mode: 'booking', owner: OWNER, runId: RUN, now: NOW }),
      { owner: OWNER, runId: RUN, binding: BINDING, now: NOW },
    );
    const verifying = { ...bound, status: 'verifying' as const,
      intent: { runId: RUN, mode: 'booking' as const, groupId: '11111111', targetDate: '2026-11-19',
        consulate: 'Vancouver', testMode: true, createdAt: NOW },
      authentication: { tabId: 7, phase: 'prepare' as const, pending: false, startedAt: NOW, purpose: 'verify' as const } };
    const failed = applyPollResult(verifying, { outcome: 'retryable', now: NOW, random: () => 0 });
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.cooldownUntil).toBeNull();
    expect(failed.nextPollAt).toBe('2026-10-12T00:01:00.000Z');
    expect(failed.status).toBe('verifying');
    expect(failed.intent).toEqual(verifying.intent);
  });

  it('treats unpaid emptiness as healthy and denied as a terminal stop', () => {
    const alerts = bindGroup(
      startRun(emptyEngineState(NOW), { mode: 'alerts', owner: OWNER, runId: RUN, now: NOW }),
      { owner: OWNER, runId: RUN, binding: { ...BINDING, kind: 'unpaid' }, now: NOW },
    );
    const kept = applyPollResult(alerts, { outcome: 'empty', now: NOW, random: () => 0 });
    expect(kept.consecutiveFailures).toBe(0);
    expect(kept.status).toBe('running');
    const denied = applyPollResult(running(), { outcome: 'denied', now: NOW, random: () => 0 });
    expect(denied.status).toBe('stopped');
    expect(denied.nextPollAt).toBeNull();
  });
});
