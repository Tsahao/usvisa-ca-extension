import { appointmentApplicants, appointmentDateRelaxed } from '../domain/appointment';
import { sameApplicants } from '../domain/applicants';
import { verifyBooking } from '../domain/booking';
import { VERIFICATION_READ_GAP_S } from '../domain/timing';
import { VERIFICATION_CONFIG_CHANGED, VERIFICATION_ROSTER_CHANGED, VERIFICATION_UNREADABLE, resolveVerification, type EngineState } from './workflow';

export async function runVerificationRead(state: EngineState, deps: {
  now: () => string;
  read: () => Promise<unknown>;
  // Strict roster re-read for future-continuation guard only. Production
  // supplies a fresh includeApplicants=true read; unit harnesses may omit it
  // to fall back to the date-read raw. Never gates success classification.
  readRoster?: () => Promise<unknown>;
  // Current non-secret policy snapshot for automatic-continuation guard.
  // null (missing/invalid prefs or storage failure) blocks auto-continue
  // while still allowing original-group verification. Background always
  // supplies string|null (never undefined); legacy harnesses may omit it
  // to skip the guard. Never gates success classification.
  currentPolicyKey?: string | null;
}): Promise<EngineState> {
  if (state.status !== 'verifying' || !state.intent || !state.group || !state.owner || !state.runId ||
      state.intent.groupId !== state.group.scheduleId || state.intent.runId !== state.runId || state.mode !== 'booking') return state;
  const now = deps.now();
  if (state.verification?.nextReadAt && Date.parse(state.verification.nextReadAt) > Date.parse(now)) return state;
  let raw: unknown;
  try { raw = await deps.read(); }
  catch {
    // Missing markup, timeout, login, wrong group and transport errors are
    // never positive unbooked evidence. Preserve intent and park with a fixed
    // identifier-free reason instead of clearing progress silently.
    return { ...state, verification: null, nextPollAt: null, verificationError: VERIFICATION_UNREADABLE, updatedAt: now };
  }
  let date: string | null;
  try {
    // Relaxed outcome read: exact schedule AND IVR, never sibling borrowing,
    // but no old-roster requirement. A matching target date proves an
    // appointment for the current saved group even when applicants changed.
    date = appointmentDateRelaxed(raw, state.group);
  } catch {
    return { ...state, verification: null, nextPollAt: null, verificationError: VERIFICATION_UNREADABLE, updatedAt: now };
  }
  const reads = [...state.verification?.reads ?? [], date];
  // The initial 30s post-attempt settling delay is scheduled at every
  // verification entry point and is never shortened here: consecutive fresh
  // reads only need a short gap to stay independent, so they use the shared
  // short-timer/durable-alarm pacing instead of a second settling wait.
  if (reads.length < 3) return { ...state, verification: { reads, nextReadAt: new Date(Date.parse(now) + VERIFICATION_READ_GAP_S * 1000).toISOString() },
    verificationError: null, updatedAt: now };
  const outcome = verifyBooking({ targetDate: state.intent.targetDate, previousDate: state.group.currentDate, reads });
  if (outcome === 'uncertain-stop')
    return { ...state, verification: null, nextPollAt: null, verificationError: VERIFICATION_UNREADABLE, updatedAt: now };
  // Recognized success resolves even when the roster changed, so a changed
  // roster cannot keep a known successful appointment locked.
  if (outcome === 'target-confirmed') {
    const resolved = resolveVerification(state, { owner: state.owner, runId: state.runId, outcome, now });
    // Legacy Test Mode intents resolve read-only then stop; never authorize
    // live mutations because of a legacy testMode intent. Clear any queued
    // restart so a stale test intent cannot arm a live run.
    if (state.intent.testMode) return { ...resolved, status: 'stopped', nextPollAt: null, queuedStart: null };
    return resolved;
  }
  // Failed attempts (previous-continue / unbooked-continue) require fresh
  // guards before another automatic attempt, including a queued manual
  // restart. Never drop an applicant silently. Missing original roster never
  // authorizes continuation. A blocked known outcome still resolves (clears
  // intent, consumes any queued request) and pauses with a fixed banner
  // reason instead of verifying forever.
  const blocked = (reason: typeof VERIFICATION_ROSTER_CHANGED | typeof VERIFICATION_CONFIG_CHANGED): EngineState =>
    ({ ...state, status: 'stopped' as const, intent: null, stage: null, executor: null, verification: null,
      authentication: null, verificationTabId: null, lastCandidate: null, nextPollAt: null,
      verificationError: reason, queuedStart: null, updatedAt: now });
  if (!state.group.applicantIds) return blocked(VERIFICATION_ROSTER_CHANGED);
  try {
    const rosterRaw = deps.readRoster ? await deps.readRoster() : raw;
    const current = appointmentApplicants(rosterRaw);
    if (!sameApplicants(current, state.group.applicantIds)) return blocked(VERIFICATION_ROSTER_CHANGED);
  } catch {
    return blocked(VERIFICATION_ROSTER_CHANGED);
  }
  if (deps.currentPolicyKey !== undefined) {
    if (deps.currentPolicyKey === null) return blocked(VERIFICATION_CONFIG_CHANGED);
    if (state.queuedStart) {
      if (deps.currentPolicyKey !== state.queuedStart.policyKey) return blocked(VERIFICATION_CONFIG_CHANGED);
    } else if (state.policyKey !== null && deps.currentPolicyKey !== state.policyKey) {
      return blocked(VERIFICATION_CONFIG_CHANGED);
    }
  }
  const resolved = resolveVerification(state, { owner: state.owner, runId: state.runId, outcome, now });
  if (state.intent.testMode) return { ...resolved, status: 'stopped', nextPollAt: null, queuedStart: null };
  return resolved;
}
