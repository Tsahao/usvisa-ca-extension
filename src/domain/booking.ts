import { sameApplicants } from './applicants';
import { canBook, CONSULATES, isIsoDate, type Consulate, type DatePreferences } from './dates';

// Actual booking-form state immediately before confirmation. Callers supply
// values reread from the live form, never cached planning data.
export type BookingForm = {
  scheduleId: string;
  applicantIds: string[];
  facilityId: number;
  date: string;
  time: string;
};

export type BookingExpectation = {
  scheduleId: string;
  applicantIds: string[];
  consulate: Consulate;
  currentDate: string | null;
  prefs: DatePreferences;
  testMode: boolean;
};

export type GuardDenial =
  | 'test-mode'
  | 'group-mismatch'
  | 'applicants-mismatch'
  | 'consulate-mismatch'
  | 'date-ineligible'
  | 'time-missing';

function isDigitId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
}

// Pre-submit guard. Denials use fixed tokens so group identifiers, applicant
// lists, and dates never leak into diagnostics. Test Mode denies even a
// fully eligible form: a dry run never reaches final confirmation.
export function guardBooking(
  form: BookingForm,
  expected: BookingExpectation,
): { allowed: true } | { allowed: false; reason: GuardDenial } {
  if (typeof form !== 'object' || form === null) throw new Error('Invalid booking form.');
  if (!isDigitId(form.scheduleId) || !Array.isArray(form.applicantIds) || !form.applicantIds.every(isDigitId))
    throw new Error('Invalid booking form.');
  if (!Number.isInteger(form.facilityId) || typeof form.date !== 'string' || typeof form.time !== 'string')
    throw new Error('Invalid booking form.');
  if (!isDigitId(expected.scheduleId) || !expected.applicantIds.every(isDigitId))
    throw new Error('Invalid booking expectation.');
  if (!(expected.consulate in CONSULATES)) throw new Error('Invalid booking expectation.');
  if (expected.currentDate !== null && !isIsoDate(expected.currentDate)) return { allowed: false, reason: 'date-ineligible' };
  if (expected.testMode) return { allowed: false, reason: 'test-mode' };
  if (form.scheduleId !== expected.scheduleId) return { allowed: false, reason: 'group-mismatch' };
  if (!sameApplicants(form.applicantIds, expected.applicantIds)) return { allowed: false, reason: 'applicants-mismatch' };
  if (form.facilityId !== CONSULATES[expected.consulate]) return { allowed: false, reason: 'consulate-mismatch' };
  if (!canBook(form.date, expected.currentDate, expected.prefs)) return { allowed: false, reason: 'date-ineligible' };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(form.time)) return { allowed: false, reason: 'time-missing' };
  return { allowed: true };
}

export type VerificationOutcome = 'target-confirmed' | 'previous-continue' | 'unbooked-continue' | 'uncertain-stop';

// Date-only verification over fresh validated dashboard reads (default 3,
// 2s apart with short-timer/durable-alarm pacing after the 30s post-attempt
// settling delay; scheduling delays tolerated). Read-only under
// any mode: target success ends the run, a repeated previous date permits
// continuation, three positively unbooked readings (explicit
// ready_to_schedule with zero booked markup, never missing/error readings)
// permit continuation with a null baseline, and anything uncertain or missing
// stops for manual checking.
export function verifyBooking(args: {
  targetDate: string;
  previousDate: string | null;
  reads: (string | null)[];
}): VerificationOutcome {
  if (!isIsoDate(args.targetDate)) throw new Error('Invalid verification target.');
  if (args.previousDate !== null && !isIsoDate(args.previousDate)) throw new Error('Invalid verification baseline.');
  if (!Array.isArray(args.reads) || args.reads.length === 0) return 'uncertain-stop';
  if (args.targetDate === args.previousDate) return 'uncertain-stop';
  for (const read of args.reads) {
    if (read !== null && !isIsoDate(read)) return 'uncertain-stop';
  }
  if (args.reads[args.reads.length - 1] === args.targetDate) return 'target-confirmed';
  if (args.previousDate !== null && args.reads.every(read => read === args.previousDate)) return 'previous-continue';
  if (args.reads.every(read => read === null)) return 'unbooked-continue';
  return 'uncertain-stop';
}
