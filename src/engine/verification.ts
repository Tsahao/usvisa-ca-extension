import { appointmentApplicants, appointmentDateRelaxed } from '../domain/appointment';
import { sameApplicants } from '../domain/applicants';
import { verifyBooking } from '../domain/booking';
import { COOLDOWN_S, SETUP_FAILURE_COOLDOWN_AFTER, VERIFICATION_READ_GAP_S, pollDelaySeconds } from '../domain/timing';
import type { DiagnosticDetail, DiagnosticEvent } from '../domain/diagnostics';
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
  // Best-effort bounded developer diagnostics (fixed allowlisted codes only);
  // never awaited, never gates a read or an outcome classification.
  recordDiagnostic?: (event: DiagnosticEvent) => void;
  random?: () => number;
  isCancelled?: () => boolean;
}): Promise<EngineState> {
  if (state.status !== 'verifying' || !state.intent || !state.group || !state.owner || !state.runId ||
      state.intent.groupId !== state.group.scheduleId || state.intent.runId !== state.runId || state.mode !== 'booking') return state;
  const now = deps.now();
  if (deps.isCancelled?.()) return { ...state, verification: null, nextPollAt: null, updatedAt: now };
  if (state.verification?.nextReadAt && Date.parse(state.verification.nextReadAt) > Date.parse(now)) return state;
  const note = (code: DiagnosticEvent['code'], detail?: DiagnosticDetail, rest: Partial<DiagnosticEvent> = {}): void => {
    // Verification reads always report the fixed verification phase.
    try { deps.recordDiagnostic?.({ code, mode: 'booking', phase: 'verify', ...(detail === undefined ? {} : { detail }), ...rest }); } catch { /* Diagnostics never gate verification. */ }
  };
  const unreadable = (detail: DiagnosticDetail, retryable: boolean): EngineState => {
    // Only an actively scheduled verification may self-recover. Deliberate
    // Stop/manual/restart parks have no deadline and cannot gain one here.
    if (retryable && state.verification?.nextReadAt && !deps.isCancelled?.()) {
      const cooled = state.cooldownUntil !== null && Date.parse(state.cooldownUntil) <= Date.parse(now);
      const failures = (cooled ? 0 : state.consecutiveFailures) + 1;
      const cooldownUntil = failures >= SETUP_FAILURE_COOLDOWN_AFTER
        ? new Date(Date.parse(now) + COOLDOWN_S * 1000).toISOString() : null;
      const nextReadAt = cooldownUntil ?? new Date(Date.parse(now) + pollDelaySeconds(deps.random ?? Math.random, state.pollIntervalS) * 1000).toISOString();
      note(cooldownUntil ? 'verification-cooldown-entered' : 'verification-retry', detail, { failures });
      // Discard partial evidence: recovery requires three fresh valid reads,
      // and never repeats a booking action or infers an unbooked result.
      return { ...state, consecutiveFailures: failures, cooldownUntil, verification: { reads: [], nextReadAt },
        nextPollAt: null, verificationError: null, updatedAt: now };
    }
    note('verification-unreadable', detail);
    return { ...state, verification: null, nextPollAt: null, verificationError: VERIFICATION_UNREADABLE, updatedAt: now };
  };
  let raw: unknown;
  try { raw = await deps.read(); }
  catch {
    // Missing markup, timeout, login, wrong group and transport errors are
    // never positive unbooked evidence. Preserve intent and park with a fixed
    // identifier-free reason instead of clearing progress silently.
    // The production reader catches transient injection errors only after
    // revalidating custody and returns a typed read-failure. A thrown reader
    // means trust/custody could not be established and must stay parked.
    return unreadable('reply-missing', false);
  }
  if (deps.isCancelled?.()) return { ...state, verification: null, nextPollAt: null, updatedAt: now };
  if (raw == null) return unreadable('reply-missing', true);
  const reading = raw as { scheduleId?: unknown; ivr?: unknown; kind?: unknown; status?: unknown };
  if ((typeof reading.scheduleId === 'string' && reading.scheduleId !== state.group.scheduleId) ||
      (typeof reading.ivr === 'string' && reading.ivr !== state.group.ivr)) return unreadable('group-changed', false);
  if (reading.scheduleId !== state.group.scheduleId || reading.ivr !== state.group.ivr) return unreadable('reply-malformed', true);
  if (reading.kind === 'read-failure') return unreadable('transport', true);
  let date: string | null;
  try {
    // Relaxed outcome read: exact schedule AND IVR, never sibling borrowing,
    // but no old-roster requirement. A matching target date proves an
    // appointment for the current saved group even when applicants changed.
    date = appointmentDateRelaxed(raw, state.group);
  } catch {
    return unreadable('reply-malformed', true);
  }
  if (state.consecutiveFailures > 0) note('verification-recovered', undefined, { failures: 0, outcome: 'healthy' });
  const healthyState = { ...state, consecutiveFailures: 0, cooldownUntil: null };
  const reads = [...state.verification?.reads ?? [], date];
  // The initial 30s post-attempt settling delay is scheduled at every
  // verification entry point and is never shortened here: consecutive fresh
  // reads only need a short gap to stay independent, so they use the shared
  // short-timer/durable-alarm pacing instead of a second settling wait.
  if (reads.length < 3) {
    note('verification-progress');
    return { ...healthyState, verification: { reads, nextReadAt: new Date(Date.parse(now) + VERIFICATION_READ_GAP_S * 1000).toISOString() },
      verificationError: null, updatedAt: now };
  }
  const outcome = verifyBooking({ targetDate: state.intent.targetDate, previousDate: state.group.currentDate, reads });
  if (outcome === 'uncertain-stop') {
    note('verification-unreadable');
    return { ...state, verification: null, nextPollAt: null, verificationError: VERIFICATION_UNREADABLE, updatedAt: now };
  }
  // Recognized success resolves even when the roster changed, so a changed
  // roster cannot keep a known successful appointment locked.
  if (outcome === 'target-confirmed') {
    const resolved = resolveVerification(healthyState, { owner: state.owner, runId: state.runId, outcome, now });
    note('verification-resolved', undefined, { outcome });
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
    ({ ...healthyState, status: 'stopped' as const, intent: null, stage: null, executor: null, verification: null,
      authentication: null, verificationTabId: null, lastCandidate: null, nextPollAt: null,
      verificationError: reason, queuedStart: null, updatedAt: now });
  if (!state.group.applicantIds) {
    note('verification-blocked', 'roster-changed');
    return blocked(VERIFICATION_ROSTER_CHANGED);
  }
  try {
    const rosterRaw = deps.readRoster ? await deps.readRoster() : raw;
    if (rosterRaw == null || (rosterRaw as { kind?: unknown }).kind === 'read-failure') return unreadable('transport', true);
    const current = appointmentApplicants(rosterRaw);
    if (!sameApplicants(current, state.group.applicantIds)) {
      note('verification-blocked', 'roster-changed');
      return blocked(VERIFICATION_ROSTER_CHANGED);
    }
  } catch {
    note('verification-blocked', 'roster-changed');
    return blocked(VERIFICATION_ROSTER_CHANGED);
  }
  if (deps.isCancelled?.()) return { ...state, verification: null, nextPollAt: null, updatedAt: now };
  if (deps.currentPolicyKey !== undefined) {
    if (deps.currentPolicyKey === null) {
      note('verification-blocked', 'config-changed');
      return blocked(VERIFICATION_CONFIG_CHANGED);
    }
    if (state.queuedStart) {
      if (deps.currentPolicyKey !== state.queuedStart.policyKey) {
        note('verification-blocked', 'config-changed');
        return blocked(VERIFICATION_CONFIG_CHANGED);
      }
    } else if (state.policyKey !== null && deps.currentPolicyKey !== state.policyKey) {
      note('verification-blocked', 'config-changed');
      return blocked(VERIFICATION_CONFIG_CHANGED);
    }
  }
  const resolved = resolveVerification(healthyState, { owner: state.owner, runId: state.runId, outcome, now });
  note('verification-resolved', undefined, { outcome });
  if (state.intent.testMode) return { ...resolved, status: 'stopped', nextPollAt: null, queuedStart: null };
  return resolved;
}
