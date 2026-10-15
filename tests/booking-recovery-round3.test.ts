// Synthetic round-3 booking-recovery regressions: false-success discrimination,
// blocked-failure preservation, and fresh restart validation (IVR + baseline).
// No real accounts, secrets, page dumps or notifications.
import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_CONFIG_CHANGED, VERIFICATION_ROSTER_CHANGED, VERIFICATION_UNREADABLE,
  bindGroup, emptyEngineState, parkForReview, recordIntent, startRun,
} from '../src/engine/workflow';
import { runVerificationRead } from '../src/engine/verification';
import { policyKey } from '../src/engine/lifecycle';

const NOW = '2026-10-12T00:00:00.000Z';
const ids = ['77777777', '88888888'];
const single = ['77777777'];
const identity = { scheduleId: '11111111', ivr: '22222222' };
const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
  earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false,
  interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };

function verifying(applicantIds: string[] | undefined = ids, currentDate: string | null = '2027-06-21') {
  const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
    binding: { ...identity, kind: 'paid', currentDate, ...(applicantIds ? { applicantIds } : {}) } });
  return parkForReview(recordIntent(bound, { ...args, intent: {
    runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
    consulate: 'Vancouver', testMode: false, createdAt: NOW } }), NOW);
}

async function terminal(initial: ReturnType<typeof verifying>, raws: unknown[], opts: {
  currentPolicyKey?: string | null; rosterRaws?: (unknown | Error)[];
} = {}) {
  let state = initial;
  let clock = NOW;
  for (let i = 0; i < raws.length; i++) {
    clock = new Date(Date.parse(clock) + 30_000).toISOString();
    const at = clock;
    const raw = raws[i];
    const rosterRaw = opts.rosterRaws?.[i];
    state = await runVerificationRead(state, { now: () => at,
      read: async () => { if (raw instanceof Error) throw raw; return raw; },
      ...(opts.rosterRaws ? { readRoster: async () => { if (rosterRaw instanceof Error) throw rosterRaw; return rosterRaw; } } : {}),
      ...(opts.currentPolicyKey === undefined ? {} : { currentPolicyKey: opts.currentPolicyKey }) });
  }
  return state;
}

const booked = (text: string, applicantIds: string[] = ids) => ({ ...identity, kind: 'booked', text, applicantIds });
const unbooked = (applicantIds: string[] = ids) => ({ ...identity, kind: 'unbooked', text: null, applicantIds });

// Background's verified-success gate must be explicit: stopped + cleared
// intent + no blocking diagnostic. These pure-engine outcomes establish the
// contract the background gate relies on, so a blocked failure can never be
// mistaken for success.
describe('verified-success discrimination contract', () => {
  it('success carries no diagnostic while blocked failures do', async () => {
    const key = policyKey(prefs as unknown as Record<string, unknown>);
    const target = booked('November 19, 2026', single);
    const success = await terminal(verifying(), [target, target, target],
      { currentPolicyKey: key, rosterRaws: [new Error('x'), new Error('x'), new Error('x')] });
    expect(success).toMatchObject({ status: 'stopped', intent: null, verificationError: null });

    const prev = booked('June 21, 2027', single);
    const blockedRoster = await terminal(verifying(), [prev, prev, prev], { currentPolicyKey: key });
    expect(blockedRoster).toMatchObject({ status: 'stopped', intent: null, verificationError: VERIFICATION_ROSTER_CHANGED });

    const prevOk = booked('June 21, 2027');
    const blockedConfig = await terminal({ ...verifying(), policyKey: key }, [prevOk, prevOk, prevOk],
      { currentPolicyKey: 'different-key' });
    expect(blockedConfig).toMatchObject({ status: 'stopped', intent: null, verificationError: VERIFICATION_CONFIG_CHANGED });

    // Background gate: only the first may record engineSuccessV1.
    const isVerifiedSuccess = (s: typeof success) => s.intent === null && s.status === 'stopped' && s.verificationError === null;
    expect(isVerifiedSuccess(success)).toBe(true);
    expect(isVerifiedSuccess(blockedRoster)).toBe(false);
    expect(isVerifiedSuccess(blockedConfig)).toBe(false);
  });

  it('unbooked failure with roster/config block is not success', async () => {
    const key = policyKey(prefs as unknown as Record<string, unknown>);
    const unbookedRaw = unbooked(single);
    const blockedRoster = await terminal(verifying(), [unbookedRaw, unbookedRaw, unbookedRaw], { currentPolicyKey: key });
    expect(blockedRoster).toMatchObject({ status: 'stopped', verificationError: VERIFICATION_ROSTER_CHANGED });
    expect(blockedRoster.intent).toBeNull();
    expect(blockedRoster.verificationError).not.toBeNull();

    const unbookedOk = unbooked();
    const blockedConfig = await terminal({ ...verifying(), policyKey: key }, [unbookedOk, unbookedOk, unbookedOk],
      { currentPolicyKey: null });
    expect(blockedConfig).toMatchObject({ status: 'stopped', verificationError: VERIFICATION_CONFIG_CHANGED });
  });

  it('unknown readings preserve intent and never qualify as success', async () => {
    const mixed = await terminal(verifying(),
      [booked('June 21, 2027'), booked('June 21, 2027'), booked('December 1, 2026')]);
    expect(mixed.intent).not.toBeNull();
    expect(mixed.status).toBe('verifying');
    expect(mixed.verificationError).toBe(VERIFICATION_UNREADABLE);
  });
});
