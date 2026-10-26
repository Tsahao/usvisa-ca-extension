import { parseLongDateUs } from './dates';
import { normalizeReadingIvr, sameGroupRef, type GroupRef } from './groups';
import { sameApplicants, validateApplicantIds } from './applicants';
import { normalizeVisaClassLabels, type VisaClass } from './visa-classes';

export function appointmentDate(raw: unknown, expected: GroupRef & { applicantIds?: string[] }): string | null {
  if (!raw || typeof raw !== 'object') throw new Error('Missing appointment reading.');
  const reading = raw as Record<string, unknown>;
  // Schedule is the primary identity. A null (unreadable) IVR on either side
  // never fabricates a mismatch, while two readable IVRs must agree; missing
  // or malformed identity fields still fail closed.
  const scheduleId = typeof reading.scheduleId === 'string' ? reading.scheduleId : '';
  const ivr = normalizeReadingIvr(reading.ivr);
  if (ivr === undefined || !sameGroupRef({ scheduleId, ivr }, expected)) throw new Error('Appointment identity changed.');
  if (expected.applicantIds && !sameApplicants(reading.applicantIds, expected.applicantIds)) throw new Error('Applicant roster changed.');
  if (reading.kind === 'unbooked' && reading.text === null) return null;
  if (reading.kind !== 'booked' || typeof reading.text !== 'string') throw new Error('Unknown appointment state.');
  const date = parseLongDateUs(reading.text);
  if (date === null) throw new Error('Unreadable appointment date.');
  return date;
}

// Outcome-verification date read: matches the saved schedule AND IVR exactly
// and never borrows sibling/historical cards (the page scope already enforces
// this), but does NOT require the old complete applicant roster. A matching
// attempted date proves an appointment for the current saved group even when
// the roster changed (for example two original applicants becoming one). All
// booking-form/submission/preconfirm and renewal paths keep the strict
// complete-roster check above.
export function appointmentDateRelaxed(raw: unknown, expected: GroupRef): string | null {
  return appointmentDate(raw, { scheduleId: expected.scheduleId, ivr: expected.ivr });
}

export function appointmentApplicants(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') throw new Error('Missing applicant roster.');
  return validateApplicantIds((raw as Record<string, unknown>).applicantIds);
}

// Optional analytics metadata from the same scoped dashboard table as the
// complete roster. Any missing/ambiguous evidence degrades to unknown, never a
// workflow error or a value borrowed from a sibling group/applicant.
export function appointmentVisaClasses(raw: unknown, expected: GroupRef & { applicantIds?: string[] }): VisaClass[] {
  try {
    appointmentDateRelaxed(raw, expected);
    const snapshot = (raw as { visaClassSnapshot?: { applicantIds?: unknown; labels?: unknown } }).visaClassSnapshot;
    if (!snapshot || !expected.applicantIds || !sameApplicants(snapshot.applicantIds, expected.applicantIds) ||
        !Array.isArray(snapshot.labels) || snapshot.labels.length !== expected.applicantIds.length) return ['unknown'];
    return normalizeVisaClassLabels(snapshot.labels);
  } catch { return ['unknown']; }
}
