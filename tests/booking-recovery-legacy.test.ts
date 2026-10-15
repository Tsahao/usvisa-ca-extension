// Synthetic booking-recovery regressions for old-version state, stop/close
// paths, short inter-read pacing and suspend/restart durability.
// No real accounts, secrets, page dumps or notifications.
import { describe, expect, it, vi } from 'vitest';
import { VERIFICATION_CONFIG_CHANGED, VERIFICATION_ROSTER_CHANGED, VERIFICATION_UNREADABLE,
  bindGroup, emptyEngineState, parkForReview, parkForVerification, queueVerificationStart,
  recordIntent, reconcileStartup, startRun, stopRun, validateEngineState } from '../src/engine/workflow';
import { runVerificationRead } from '../src/engine/verification';
import { beginAuthentication, runAuthentication } from '../src/engine/authentication';
import { engineAlarmAt } from '../src/engine/poll';
import { policyKey } from '../src/engine/lifecycle';
import type { ExecDeps } from '../src/engine/executor';

const NOW = '2026-10-12T00:00:00.000Z';
const ids = ['77777777', '88888888'];
const identity = { scheduleId: '11111111', ivr: '22222222' };
const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
  earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false,
  interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };

// A save as an older build would have written it: no queued-start permission,
// no verification-failure metadata, no canonical dashboard path, no roster,
// no per-cycle authentication fields and no intent phase.
function legacySave(status: 'running' | 'stopped', testMode = false) {
  return {
    version: 1, runId: args.runId, owner: args.owner, generation: 3, mode: 'booking', status,
    intent: { runId: args.runId, mode: 'booking', groupId: identity.scheduleId,
      targetDate: '2026-11-19', consulate: 'Vancouver', testMode, createdAt: '2026-10-11T00:00:00.000Z' },
    group: { scheduleId: identity.scheduleId, ivr: identity.ivr, kind: 'paid', currentDate: '2027-06-21' },
    consecutiveFailures: 0, cooldownUntil: null, lastCandidate: null, stage: null, executor: null,
    monitorTabId: null, verification: null, nextPollAt: null,
    alert: { observed: null, delivered: null, pending: false },
    updatedAt: '2026-10-11T00:00:00.000Z', startedAt: '2026-10-11T00:00:00.000Z',
    policyKey: null, pollIntervalS: 60, authentication: null,
    sessionRenewals: 0, loginFailed: false, manualAuthentication: false, verificationTabId: null,
  };
}

const booked = (text: string, applicantIds: string[] = ids) => ({ ...identity, kind: 'booked', text, applicantIds });

async function threeReads(initial: ReturnType<typeof validateEngineState>, raws: unknown[], opts: {
  currentPolicyKey?: string | null;
} = {}) {
  // Old-version saves reach verification through startup reconciliation, the
  // same path the worker takes after an upgrade or restart.
  let state = reconcileStartup(initial, NOW, true);
  let clock = NOW;
  for (const raw of raws) {
    clock = new Date(Date.parse(clock) + 2_000).toISOString();
    const at = clock;
    state = await runVerificationRead(state, { now: () => at, read: async () => raw,
      ...(opts.currentPolicyKey === undefined ? {} : { currentPolicyKey: opts.currentPolicyKey }) });
  }
  return state;
}

describe('old-version saved state', () => {
  it('validates, migrates and parks on restart for an explicit Start instead of auto-healing', () => {
    const restored = validateEngineState(legacySave('stopped'));
    expect(restored.queuedStart).toBeNull();
    expect(restored.verificationError).toBeNull();
    // Restart parks the stranded check with no deadline instead of healing it
    // into a fresh pass: intent and roster state are preserved, the queued
    // restart stays cancelled and there is nothing to navigate yet. A
    // third verification read can resolve previous/unbooked outcomes to
    // running, so auto-healing here would resume live booking against the
    // user's Stop/restart. An explicit Start resumes the parked check.
    const restarted = reconcileStartup(restored, NOW, true);
    expect(restarted).toMatchObject({ status: 'verifying', verification: null,
      queuedStart: null, verificationTabId: null });
    expect(restarted.intent).toEqual(restored.intent);
    expect(restored.group?.applicantIds).toBeUndefined();
    // No durable alarm deadline: the worker has nothing to wake for until an
    // explicit Start.
    expect(engineAlarmAt(restarted)).toBeNull();
  });
  it('parks a running legacy save with the settling delay on worker wake, and bare on restart', () => {
    const woken = reconcileStartup(validateEngineState(legacySave('running')), NOW, false);
    expect(woken).toMatchObject({ status: 'verifying' });
    expect(woken.intent).not.toBeNull();
    // An interrupted live mutation keeps the original 30s post-attempt
    // settling delay instead of reading immediately.
    expect(woken.verification).toEqual({ reads: [], nextReadAt: '2026-10-12T00:00:30.000Z' });
    const restarted = reconcileStartup(validateEngineState(legacySave('running')), NOW, true);
    expect(restarted).toMatchObject({ status: 'verifying', verification: null });
    expect(restarted.intent).not.toBeNull();
    expect(engineAlarmAt(restarted)).toBeNull();
  });
  it('never records success or continues for a legacy save without a roster on failure', async () => {
    const key = policyKey(prefs as unknown as Record<string, unknown>);
    const prev = booked('June 21, 2027');
    const blocked = await threeReads(validateEngineState(legacySave('stopped')), [prev, prev, prev],
      { currentPolicyKey: key });
    expect(blocked).toMatchObject({ status: 'stopped', intent: null, verification: null,
      verificationError: VERIFICATION_ROSTER_CHANGED, queuedStart: null });
    // The background success gate (stopped + cleared intent + no diagnostic)
    // stays false, so no misleading success is recorded for the old attempt.
    expect(blocked.intent === null && blocked.status === 'stopped' && blocked.verificationError === null).toBe(false);
  });
  it('blocks a legacy save on missing configuration without authorizing continuation', async () => {
    // A complete roster reaches the configuration gate; the missing policy
    // still fails closed with the existing banner and no continuation.
    const saved = validateEngineState({ ...legacySave('stopped'),
      group: { ...legacySave('stopped').group, applicantIds: ids } });
    const prev = booked('June 21, 2027');
    const blocked = await threeReads(saved, [prev, prev, prev],
      { currentPolicyKey: null });
    expect(blocked).toMatchObject({ status: 'stopped', intent: null, verificationError: VERIFICATION_CONFIG_CHANGED, queuedStart: null });
  });
  it('resolves legacy Test Mode intents read-only without arming a live run', async () => {
    const target = booked('November 19, 2026');
    const targetState = await threeReads(validateEngineState(legacySave('stopped', true)), [target, target, target]);
    expect(targetState).toMatchObject({ status: 'stopped', intent: null, queuedStart: null });
    // A legacy test intent never satisfies the live success gate even when
    // the dashboard shows the target date: Test Mode never clicked anything.
    const prev = booked('June 21, 2027');
    const failed = await threeReads(validateEngineState(legacySave('stopped', true)), [prev, prev, prev]);
    expect(failed).toMatchObject({ status: 'stopped', intent: null, queuedStart: null });
    expect(failed.status).not.toBe('running');
  });
});

describe('stop/close recovery paths', () => {
  function verifying() {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-06-21', applicantIds: ids } });
    return parkForReview(recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW } }), NOW);
  }
  it('parks a closed verify-authentication tab with the fixed banner and keeps intent', async () => {
    let state = beginAuthentication(verifying(), 'verify', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const deps: ExecDeps = { nowIso: () => NOW, random: () => 0,
      loadPrefs: async () => ({ ...prefs }),
      queryTabs: async () => [], getTab: async () => { throw new Error('Synthetic closed tab'); },
      createTab: async () => ({ id: 9, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in' }),
      saveState: async () => undefined, inject: async () => { throw new Error('Unexpected inject'); } };
    const next = validateEngineState(JSON.parse(JSON.stringify(await runAuthentication(deps, state))));
    expect(next).toMatchObject({ status: 'verifying', authentication: null, verification: null,
      loginFailed: true, verificationError: VERIFICATION_UNREADABLE });
    expect(next.intent).toEqual(state.intent);
  });
  it('Stop during verification keeps intent for a later Start resume', () => {
    const active = { ...verifying(), verification: { reads: ['2027-06-21'], nextReadAt: NOW }, verificationTabId: 11,
      authentication: { tabId: 7, phase: 'prepare' as const, pending: false, startedAt: NOW, purpose: 'verify' as const } };
    const queued = queueVerificationStart(active, { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: null, now: NOW });
    const stopped = stopRun(queued, { ...args, now: '2026-10-12T00:01:00.000Z' });
    expect(stopped).toMatchObject({ status: 'verifying', authentication: null, verification: null,
      verificationTabId: null, queuedStart: null });
    expect(stopped.intent).toEqual(queued.intent);
    // A later worker wake keeps the parked check parked with no deadline
    // instead of healing it into a fresh pass: previous/unbooked reads must
    // never flip a stopped run back to running without an explicit Start.
    const woken = reconcileStartup(stopped, '2026-10-12T00:01:00.000Z', false);
    expect(woken.verification).toBeNull();
    expect(engineAlarmAt(woken)).toBeNull();
    expect(woken.intent).toEqual(queued.intent);
    // A browser restart parks the same way.
    const restartedStop = reconcileStartup(stopped, '2026-10-12T00:01:00.000Z', true);
    expect(restartedStop.verification).toBeNull();
    expect(restartedStop.queuedStart).toBeNull();
    expect(restartedStop.intent).toEqual(queued.intent);
  });
  it('schedules verification with the settling delay when parking a run with intent', () => {
    const parked = parkForVerification({ ...verifying(), status: 'running' }, NOW);
    expect(parked).toMatchObject({ status: 'verifying',
      verification: { reads: [], nextReadAt: '2026-10-12T00:00:30.000Z' } });
    expect(engineAlarmAt(parked)).toBe('2026-10-12T00:00:30.000Z');
    // Runs without an intent still park bare with no verification deadline.
    const bare = parkForVerification(
      { ...verifying(), status: 'running', intent: null }, NOW);
    expect(bare.verification).toBeNull();
    expect(engineAlarmAt(bare)).toBeNull();
  });
});

describe('verification pacing and durability', () => {
  it('spaces independent fresh reads two seconds apart on the durable alarm', async () => {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-06-21', applicantIds: ids } });
    const initial = parkForReview(recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW } }), NOW);
    const read = vi.fn(async () => booked('June 21, 2027'));
    const first = await runVerificationRead(initial, { now: () => NOW, read });
    expect(first.verification).toMatchObject({ reads: ['2027-06-21'] });
    expect(first.verification!.nextReadAt).toBe('2026-10-12T00:00:02.000Z');
    // The 2s deadline is durable engine state (alarm fallback) and also short
    // enough for the existing <=5s short-timer fast wake; early calls read once.
    expect(engineAlarmAt(first)).toBe('2026-10-12T00:00:02.000Z');
    expect(await runVerificationRead(first, { now: () => NOW, read })).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('preserves verification progress and queued restarts across suspension', () => {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-06-21', applicantIds: ids } });
    const initial = parkForReview(recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW } }), NOW);
    const active = { ...initial, verification: { reads: ['2027-06-21'], nextReadAt: '2026-10-12T00:00:02.000Z' } };
    const queued = queueVerificationStart(active, { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: 'key-1', now: NOW });
    const suspended = reconcileStartup(queued, NOW, false);
    expect(suspended.verification).toEqual(active.verification);
    expect(suspended.queuedStart).toEqual(queued.queuedStart);
    expect(engineAlarmAt(suspended)).toBe('2026-10-12T00:00:02.000Z');
    // A restart discards stale partial reads and parks with no deadline for
    // an explicit Start, keeping the intent and cancelling the queued
    // restart until a new explicit Start.
    const restarted = reconcileStartup(queued, NOW, true);
    expect(restarted.verification).toBeNull();
    expect(engineAlarmAt(restarted)).toBeNull();
    expect(restarted.queuedStart).toBeNull();
    expect(restarted.intent).toEqual(queued.intent);
  });
});

describe('deliberate parks never auto-resume booking', () => {
  function stoppedPark() {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-06-21', applicantIds: ids } });
    const active = parkForReview(recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW } }), NOW);
    const queued = queueVerificationStart(
      { ...active, verification: { reads: ['2027-06-21'], nextReadAt: NOW }, verificationTabId: 11 },
      { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: null, now: NOW });
    return stopRun(queued, { ...args, now: '2026-10-12T00:01:00.000Z' });
  }
  // Drives verification exactly as the worker does: a read happens only when
  // a durable deadline is due (the queueEnginePoll guard returns early with
  // no deadline). A parked run therefore consumes no reads at all.
  async function driveWorkerReads(initial: ReturnType<typeof validateEngineState>, raws: unknown[]) {
    let state = initial;
    let calls = 0;
    let clock = Date.parse('2026-10-12T00:01:00.000Z');
    for (const raw of raws) {
      const due = state.verification?.nextReadAt;
      if (!due) break;
      clock = Math.max(clock, Date.parse(due));
      const at = new Date(clock).toISOString();
      calls += 1;
      state = await runVerificationRead(state, { now: () => at, read: async () => raw });
      clock += 2_000;
      if (state.status !== 'verifying') break;
    }
    return { state, calls };
  }
  it.each(['previous', 'unbooked'])('Stop, wake and three %s reads cannot become running without an explicit Start', async kind => {
    const prev = booked('June 21, 2027');
    const unbookedRaw = { ...identity, kind: 'unbooked', text: null, applicantIds: ids };
    const raws = kind === 'previous' ? [prev, prev, prev] : [unbookedRaw, unbookedRaw, unbookedRaw];
    for (const browserRestart of [false, true]) {
      const parked = reconcileStartup(stoppedPark(), '2026-10-12T00:01:00.000Z', browserRestart);
      expect(parked.verification).toBeNull();
      expect(engineAlarmAt(parked)).toBeNull();
      const { state, calls } = await driveWorkerReads(validateEngineState(JSON.parse(JSON.stringify(parked))), raws);
      expect(calls).toBe(0);
      expect(state.status).not.toBe('running');
      expect(state.status).toBe('verifying');
      expect(state.intent).toEqual(parked.intent);
      expect(state.queuedStart).toBeNull();
    }
  });
  it('an actively scheduled pass still resolves through the same worker path (positive control)', async () => {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-06-21', applicantIds: ids } });
    const scheduled = parkForVerification({ ...recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW } }), status: 'running' as const }, NOW);
    const prev = booked('June 21, 2027');
    const { state, calls } = await driveWorkerReads(
      validateEngineState(JSON.parse(JSON.stringify({ ...scheduled, updatedAt: NOW }))), [prev, prev, prev]);
    expect(calls).toBe(3);
    expect(state).toMatchObject({ status: 'running', intent: null });
  });
  it('manual-auth and error parks survive repeated wakes without signing in', () => {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-06-21', applicantIds: ids } });
    const base = parkForReview(recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW } }), NOW);
    const manual = { ...base, authentication: null, verification: null, nextPollAt: null,
      loginFailed: false, manualAuthentication: true };
    const errored = { ...base, authentication: null, verification: null, nextPollAt: null,
      loginFailed: true, verificationError: VERIFICATION_UNREADABLE };
    for (const parked of [manual, errored]) {
      for (const browserRestart of [false, true]) {
        const woken = reconcileStartup(validateEngineState(JSON.parse(JSON.stringify(parked))), '2026-10-12T00:02:00.000Z', browserRestart);
        // No login is scheduled and no verification pass is healed: repeated
        // wakes must not sign in or resolve behind the user's back.
        expect(woken.authentication).toBeNull();
        expect(woken.verification).toBeNull();
        expect(engineAlarmAt(woken)).toBeNull();
        expect(woken.intent).toEqual(parked.intent);
        const rewoken = reconcileStartup(woken, '2026-10-12T00:03:00.000Z', browserRestart);
        expect(rewoken.authentication).toBeNull();
        expect(rewoken.verification).toBeNull();
        expect(rewoken.intent).toEqual(parked.intent);
      }
    }
    expect(manual.manualAuthentication).toBe(true);
    expect(errored.verificationError).toBe(VERIFICATION_UNREADABLE);
  });
  it('an interrupted mutation keeps its remaining settling delay on suspension and parks on restart', () => {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-06-21', applicantIds: ids } });
    const interrupted = { ...recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW, phase: 'confirming' as const } }),
      stage: 'confirm' as const,
      executor: { tabId: 7, applicantIds: ids, targetTime: '08:00', skippedDates: [], actionPending: true } };
    // Worker suspension schedules the full 30s settle instead of reading now.
    const woken = reconcileStartup(validateEngineState(JSON.parse(JSON.stringify(interrupted))), NOW, false);
    expect(woken.verification).toEqual({ reads: [], nextReadAt: '2026-10-12T00:00:30.000Z' });
    // Suspension mid-settle preserves the exact remaining deadline.
    const midSettle = reconcileStartup(woken, '2026-10-12T00:00:10.000Z', false);
    expect(midSettle.verification).toEqual({ reads: [], nextReadAt: '2026-10-12T00:00:30.000Z' });
    expect(engineAlarmAt(midSettle)).toBe('2026-10-12T00:00:30.000Z');
    // A restart parks with no deadline for an explicit Start.
    const restarted = reconcileStartup(woken, '2026-10-12T00:00:10.000Z', true);
    expect(restarted.verification).toBeNull();
    expect(engineAlarmAt(restarted)).toBeNull();
    expect(restarted.intent).toEqual(interrupted.intent);
  });
});
