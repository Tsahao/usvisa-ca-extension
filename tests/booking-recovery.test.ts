// Synthetic booking-recovery regressions for the approved plan.
// No real accounts, secrets, page dumps or external notifications.
import { describe, expect, it, vi } from 'vitest';
import { verifyBooking } from '../src/domain/booking';
import { appointmentDateRelaxed } from '../src/domain/appointment';
import {
  VERIFICATION_CONFIG_CHANGED, VERIFICATION_ROSTER_CHANGED, VERIFICATION_UNREADABLE,
  bindGroup, cancelQueuedStart, emptyEngineState, parkForReview, queueVerificationStart,
  recordIntent, reconcileStartup, resolveVerification, startRun, stopRun, validateEngineState,
  type EngineState,
} from '../src/engine/workflow';
import { runVerificationRead } from '../src/engine/verification';
import { beginAuthentication, runAuthentication } from '../src/engine/authentication';
import { policyKey } from '../src/engine/lifecycle';
import { panelSnapshot } from '../src/engine/panel';
import type { ExecDeps } from '../src/engine/executor';

const NOW = '2026-10-12T00:00:00.000Z';
const ids = ['77777777', '88888888'];
const single = ['77777777'];
const identity = { scheduleId: '11111111', ivr: '22222222' };
const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
  earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false,
  interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };

function verifying(testMode = false, applicantIds: string[] | undefined = ids, currentDate: string | null = '2027-06-21') {
  const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
    binding: { ...identity, kind: 'paid', currentDate, ...(applicantIds ? { applicantIds } : {}) } });
  const withIntent = recordIntent(bound, { ...args, intent: {
    runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
    consulate: 'Vancouver', testMode, createdAt: NOW } });
  return parkForReview(withIntent, NOW);
}

async function threeReads(initial: EngineState, raws: unknown[], currentPolicyKey?: string | null) {
  let state = initial;
  let clock = NOW;
  for (const raw of raws) {
    clock = new Date(Date.parse(clock) + 30_000).toISOString();
    const at = clock;
    state = await runVerificationRead(state, { now: () => at, read: async () => {
      if (raw instanceof Error) throw raw;
      return raw;
    }, ...(currentPolicyKey === undefined ? {} : { currentPolicyKey }) });
  }
  return state;
}

const booked = (text: string, applicantIds: string[] = ids) =>
  ({ ...identity, kind: 'booked', text, applicantIds });
const unbooked = (applicantIds: string[] = ids) =>
  ({ ...identity, kind: 'unbooked', text: null, applicantIds });

describe('booking-recovery domain outcome', () => {
  it('continues on three positively unbooked readings with null or booked baselines', () => {
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: null, reads: [null, null, null] })).toBe('unbooked-continue');
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: [null, null, null] })).toBe('unbooked-continue');
  });
  it('keeps mixed, third-date and malformed readings uncertain', () => {
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: ['2027-06-21', '2027-06-21', null] })).toBe('uncertain-stop');
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: [null, null, '2026-11-19'] })).toBe('target-confirmed');
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: ['2027-06-21', '2027-06-21', '2026-12-01'] })).toBe('uncertain-stop');
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2026-11-19', reads: ['2026-11-19', '2026-11-19', '2026-11-19'] })).toBe('uncertain-stop');
  });
  it('relaxes roster only for outcome reads while matching schedule and IVR exactly', () => {
    // Two original applicants becoming one still target-confirms the saved group.
    expect(appointmentDateRelaxed(booked('November 19, 2026', single), identity)).toBe('2026-11-19');
    // Sibling/historical cards are never borrowed.
    expect(() => appointmentDateRelaxed({ ...identity, scheduleId: '33333333', kind: 'booked', text: 'November 19, 2026' }, identity)).toThrow();
    expect(() => appointmentDateRelaxed({ ...identity, ivr: '99999999', kind: 'booked', text: 'November 19, 2026' }, identity)).toThrow();
  });
});

describe('booking-recovery verification reads', () => {
  it('target-confirms despite changed or missing old roster and records success regardless', async () => {
    for (const saved of [ids, single, undefined]) {
      const initial = verifying(false, saved);
      const state = await threeReads(initial, [
        booked('November 19, 2026', single), booked('November 19, 2026', single), booked('November 19, 2026', single)]);
      expect(state).toMatchObject({ status: 'stopped', intent: null, verification: null, verificationError: null });
    }
  });
  it('continues on repeated previous date and nulls the baseline only for positive unbooked', async () => {
    const previous = await threeReads(verifying(), [booked('June 21, 2027'), booked('June 21, 2027'), booked('June 21, 2027')]);
    expect(previous).toMatchObject({ status: 'running', intent: null, group: { currentDate: '2027-06-21' } });
    const fromBooked = await threeReads(verifying(false, ids, '2027-06-21'), [unbooked(), unbooked(), unbooked()]);
    expect(fromBooked).toMatchObject({ status: 'running', intent: null, group: { currentDate: null } });
    const fromNull = await threeReads(verifying(false, single, null), [unbooked(single), unbooked(single), unbooked(single)]);
    expect(fromNull).toMatchObject({ status: 'running', intent: null, group: { currentDate: null } });
  });
  it('blocks automatic continuation on changed or unreadable roster by resolving and pausing', async () => {
    const changed = await threeReads(verifying(false, ids), [
      booked('June 21, 2027', single), booked('June 21, 2027', single), booked('June 21, 2027', single)]);
    expect(changed).toMatchObject({ status: 'stopped', intent: null, verification: null, verificationError: VERIFICATION_ROSTER_CHANGED, queuedStart: null });
    const unreadable = await threeReads(verifying(false, ids), [
      { ...identity, kind: 'booked', text: 'June 21, 2027' },
      { ...identity, kind: 'booked', text: 'June 21, 2027' },
      { ...identity, kind: 'booked', text: 'June 21, 2027' }]);
    expect(unreadable).toMatchObject({ status: 'stopped', intent: null, verificationError: VERIFICATION_ROSTER_CHANGED });
  });
  it('parks mixed, third-date, malformed and sibling readings with a fixed reason', async () => {
    const mixed = await threeReads(verifying(), [booked('June 21, 2027'), booked('June 21, 2027'), booked('December 1, 2026')]);
    expect(mixed).toMatchObject({ status: 'verifying', verification: null, verificationError: VERIFICATION_UNREADABLE });
    expect(mixed.intent).not.toBeNull();
    const sibling = await threeReads(verifying(), [
      { ...identity, scheduleId: '33333333', kind: 'booked', text: 'November 19, 2026', applicantIds: ids },
      { ...identity, scheduleId: '33333333', kind: 'booked', text: 'November 19, 2026', applicantIds: ids },
      { ...identity, scheduleId: '33333333', kind: 'booked', text: 'November 19, 2026', applicantIds: ids }]);
    expect(sibling).toMatchObject({ status: 'verifying', verificationError: VERIFICATION_UNREADABLE });
    // A read error (missing markup, timeout, login) parks immediately with the
    // fixed reason and preserves intent; the worker does not auto-retry a
    // parked verification without a deadline (see queueEnginePoll guard).
    const errored = await runVerificationRead(verifying(), { now: () => NOW, read: async () => { throw new Error('timeout'); } });
    expect(errored).toMatchObject({ status: 'verifying', verification: null, verificationError: VERIFICATION_UNREADABLE });
    expect(errored.intent).not.toBeNull();
  });
  it('requires unchanged configuration before automatic failure continuation', async () => {
    const originalKey = policyKey({ consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' });
    const changedKey = policyKey({ consulate: 'Toronto', earliest: '2026-11-01', latest: '2026-12-31',
      onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' });
    const base = { ...verifying(), policyKey: originalKey };
    const blocked = await threeReads(base, [booked('June 21, 2027'), booked('June 21, 2027'), booked('June 21, 2027')], changedKey);
    expect(blocked).toMatchObject({ status: 'stopped', intent: null, verificationError: VERIFICATION_CONFIG_CHANGED, queuedStart: null });
    const allowed = await threeReads(base, [booked('June 21, 2027'), booked('June 21, 2027'), booked('June 21, 2027')], originalKey);
    expect(allowed).toMatchObject({ status: 'running', intent: null });
  });
  it('resolves legacy Test Mode intents read-only then stops without live restart', async () => {
    const target = await threeReads(verifying(true), [booked('November 19, 2026'), booked('November 19, 2026'), booked('November 19, 2026')]);
    expect(target).toMatchObject({ status: 'stopped', intent: null, queuedStart: null });
    const previous = await threeReads(verifying(true), [booked('June 21, 2027'), booked('June 21, 2027'), booked('June 21, 2027')]);
    expect(previous).toMatchObject({ status: 'stopped', intent: null, queuedStart: null });
    const unbookedReads = await threeReads(verifying(true, ids, null), [unbooked(), unbooked(), unbooked()]);
    expect(unbookedReads).toMatchObject({ status: 'stopped', intent: null });
  });
  it('preserves the short inter-read pacing after the post-attempt delay', async () => {
    let now = NOW;
    const read = vi.fn(async () => booked('June 21, 2027'));
    let state = verifying();
    state = await runVerificationRead(state, { now: () => now, read });
    expect(state.verification).toMatchObject({ reads: ['2027-06-21'] });
    expect(Date.parse(state.verification!.nextReadAt!) - Date.parse(now)).toBe(2_000);
    expect(await runVerificationRead(state, { now: () => now, read })).toBe(state);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('booking-recovery queued restart permission', () => {
  it('is idempotent while verification or auth is active and never resets progress', () => {
    const active = { ...verifying(), verification: { reads: ['2027-06-21'], nextReadAt: NOW }, verificationTabId: 11, nextPollAt: null };
    const queued = queueVerificationStart(active, { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: 'key-1', now: NOW });
    expect(queued.queuedStart).toMatchObject({ owner: args.owner, runId: args.runId, mode: 'booking', policyKey: 'key-1' });
    expect(queued.verification).toEqual(active.verification);
    expect(queued.verificationTabId).toBe(11);
    expect(queueVerificationStart(queued, { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: 'key-1', now: NOW })).toBe(queued);
  });
  it('Stop cancels the request but retains unresolved intent', () => {
    const queued = queueVerificationStart(verifying(), { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: null, now: NOW });
    const stopped = stopRun(queued, { ...args, now: '2026-10-12T00:01:00.000Z' });
    expect(stopped.queuedStart).toBeNull();
    expect(stopped.intent).toEqual(queued.intent);
    expect(stopped.status).toBe('verifying');
  });
  it('suspension retains the request while browser restart cancels it', () => {
    const queued = queueVerificationStart(
      { ...verifying(), verification: { reads: ['2027-06-21'], nextReadAt: NOW } },
      { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: null, now: NOW });
    expect(reconcileStartup(queued, NOW).queuedStart).toEqual(queued.queuedStart);
    expect(reconcileStartup(queued, NOW).verification).toEqual(queued.verification);
    const restarted = reconcileStartup(queued, NOW, true);
    expect(restarted.queuedStart).toBeNull();
    expect(restarted.intent).toEqual(queued.intent);
    // A restart discards stale partial reads and parks with no deadline for
    // an explicit Start (never an auto-healed pass that could resolve to
    // running), while the queued restart stays cancelled and custody is
    // released.
    expect(restarted.verification).toBeNull();
  });
  it('credential and config changes cancel the request via explicit helper', () => {
    const queued = queueVerificationStart(verifying(), { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: 'old', now: NOW });
    expect(cancelQueuedStart(queued, NOW).queuedStart).toBeNull();
    expect(cancelQueuedStart(queued, NOW).intent).toEqual(queued.intent);
  });
  it('resolves unbooked-continue with a null baseline and validates new fields', () => {
    const continued = resolveVerification(verifying(), { ...args, outcome: 'unbooked-continue', now: NOW });
    expect(continued).toMatchObject({ status: 'running', intent: null, group: { currentDate: null } });
    expect(() => validateEngineState({ ...continued, verificationError: 'synthetic-secret' })).toThrow();
    expect(validateEngineState({ ...continued, queuedStart: null, verificationError: null }).queuedStart).toBeNull();
    expect(validateEngineState(continued).verificationError).toBeNull();
  });
  it('never stores credentials in engine state or policy keys', () => {
    const state = verifying();
    expect(JSON.stringify(state)).not.toContain('synthetic-password');
    expect(JSON.stringify(state)).not.toContain('fixture@example.invalid');
    expect(policyKey(prefs as unknown as Record<string, unknown>)).not.toContain('synthetic-password');
  });
});

describe('booking-recovery verification login', () => {
  function authHarness(url: string, groups: unknown, appointment: unknown) {
    let clock = NOW;
    let currentUrl = url;
    const navigated: Array<[number, string]> = [];
    const deps: ExecDeps = { nowIso: () => clock, random: () => 0, loadPrefs: async () => ({ ...prefs }),
      queryTabs: async () => [], getTab: async () => ({ id: 7, url: currentUrl }),
      createTab: async () => ({ id: 7, url: currentUrl }),
      saveState: async () => undefined,
      navigateTab: vi.fn(async (tabId: number, target: string) => { navigated.push([tabId, target]); currentUrl = target; }),
      inject: vi.fn(async (_tab, func) => {
        if (func.name === 'readSiteMaintenance') return { maintenance: false };
        if (func.name === 'retryAuthenticationPage') return { ok: true };
        if (func.name === 'goToLoginFromLanding') return { ok: true };
        if (func.name === 'readDashboardGroups') return groups;
        if (func.name === 'readCurrentAppointment') {
          if (appointment instanceof Error) throw appointment;
          return appointment;
        }
        if (func.name === 'performLoginAction') return { ok: true };
        if (func.name === 'probeLoginStatus') return { ok: true };
        throw new Error(`Unexpected ${func.name}`);
      }) };
    return { deps, navigated, tick: (seconds: number) => { clock = new Date(Date.parse(clock) + seconds * 1000).toISOString(); } };
  }
  it('verifies the original saved group despite changed booking preferences', async () => {
    // Prefs now select a different IVR and a different window, but the saved
    // paid group is still on the dashboard: verification must still bind it.
    const h = authHarness('https://ais.usvisa-info.com/en-ca/niv/groups',
      { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] },
      { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: ids });
    h.deps.loadPrefs = async () => ({ ...prefs, paidIvr: '99999999', consulate: 'Toronto' });
    const saved = verifying(false, ids, '2027-01-01');
    // Policy mismatch must not fail verification login itself.
    let state = beginAuthentication(saved, 'verify', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const next = await runAuthentication(h.deps, state);
    expect(next.authentication).toBeNull();
    expect(next.verificationTabId).toBe(7);
    expect(next.group).toEqual(saved.group);
  });
  it('moves a clean signed-out landing page to the fixed sign-in URL promptly', async () => {
    const h = authHarness('https://ais.usvisa-info.com/en-ca/niv/', { groups: [] }, null);
    // A fully loaded landing page means signed out: verification proceeds to
    // the exact official sign-in URL at once via checkpointed browser
    // navigation (no page-script reply to lose), without parking on the
    // public welcome page and without extra submits.
    let state = beginAuthentication(verifying(), 'verify', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.tick(2);
    const moved = await runAuthentication(h.deps, state);
    const names = vi.mocked(h.deps.inject).mock.calls.map(call => (call[1] as { name: string }).name);
    expect(names).not.toContain('goToLoginFromLanding');
    expect(h.navigated).toEqual([[7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in']]);
    expect(moved.authentication).not.toBeNull();
    expect(moved.consecutiveFailures).toBe(0);
    expect(moved.intent).toEqual(state.intent);
  });
});

describe('booking-recovery panel guidance', () => {
  it('explains active checks, parked reasons and never mislabels intent as credential failure', () => {
    const intent = { runId: args.runId, groupId: '11111111', mode: 'booking' as const, targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW };
    const base = { ...startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), intent };
    const checking = panelSnapshot({ ...base, status: 'verifying', verification: { reads: [], nextReadAt: NOW } }, null, null);
    expect(checking).toMatchObject({ status: 'running', reviewRequired: true });
    expect(checking.reviewMessage).toContain('Checking the previous booking attempt');
    const parked = panelSnapshot({ ...base, status: 'verifying', verification: null, verificationError: VERIFICATION_ROSTER_CHANGED }, null, null);
    expect(parked.status).not.toBe('failure');
    expect(parked.failureKind).toBeUndefined();
    expect(parked.reviewMessage).toBe(VERIFICATION_ROSTER_CHANGED);
    const unreadable = panelSnapshot({ ...base, status: 'verifying', verification: null, verificationError: VERIFICATION_UNREADABLE }, null, null);
    expect(unreadable.reviewMessage).toBe(VERIFICATION_UNREADABLE);
    const config = panelSnapshot({ ...base, status: 'verifying', verification: null, verificationError: VERIFICATION_CONFIG_CHANGED }, null, null);
    expect(config.reviewMessage).toBe(VERIFICATION_CONFIG_CHANGED);
  });
});
