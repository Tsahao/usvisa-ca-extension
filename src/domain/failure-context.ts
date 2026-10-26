import { WORKFLOW_DETAIL_CODES, isPaidAdapterFailureCode } from './failure-codes';
import { AUTHENTICATION_FAILURE_REASONS, SELECTION_FAILURE_CODES } from './diagnostics';

// Public telemetry vocabulary. Never accept raw errors, routes or page data.
// Local diagnostic details must be explicitly mapped before they can leave
// the device; adding a local diagnostic does not automatically export it.
export const FAILURE_REASONS = ['start-failed', 'setup-exhausted', 'authentication-failed', 'workflow-blocked'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
export const FAILURE_CODES = [
  ...AUTHENTICATION_FAILURE_REASONS,
  ...WORKFLOW_DETAIL_CODES,
  'unknown', 'stage-guard', 'candidate-invalid', 'applicant-roster-missing',
  'navigation-unconfirmed', 'renewal-limit', 'checkpoint-interrupted',
  'session-age-exceeded', 'clock-invalid', 'setup-retry-limit',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export const FAILURE_STEPS = [
  'unknown', 'configuration-check', 'tab-check', 'navigation', 'state-save',
  'authentication-context', 'login-prepare', 'login-submit', 'login-wait',
  'authentication-retry', 'authentication-cycle-wait', 'dashboard-read',
  'group-selection', 'group-check', 'roster-check', 'baseline-check',
  'booking-actions', 'booking-warning', 'booking-applicants', 'booking-form',
  'booking-confirm', 'booking-poll', 'alerts-poll', 'lifecycle-check',
  'worker-recovery', 'restart-setup',
  'booking-schedule-entry', 'booking-reschedule-entry', 'booking-facility-change',
  'booking-date-change', 'booking-time-change', 'booking-form-read',
  'booking-policy-check', 'booking-warning-acknowledge', 'dashboard-continue',
  'start-state', 'start-dashboard', 'start-groups', 'start-selection', 'start-baseline', 'start-roster', 'start-save',
  'alerts-entry', 'poll-scheduling',
  'auth-entry-read', 'auth-renewal-entry', 'auth-stalled-load-check', 'auth-stalled-load-navigation',
  'auth-retry-load-check', 'auth-retry-load-navigation', 'auth-cycle-navigation', 'auth-race-check',
  'auth-entry-progress-check', 'auth-landing-navigation',
] as const;
export type FailureStep = (typeof FAILURE_STEPS)[number];
export const AUTH_PURPOSES = ['start', 'renew', 'verify'] as const;
export type AuthPurpose = (typeof AUTH_PURPOSES)[number];
export type FailureContext = { category: FailureReason; code: FailureCode; step: FailureStep; authPurpose?: AuthPurpose };

export const isFailureCode = (value: unknown): value is FailureCode => FAILURE_CODES.includes(value as FailureCode);
export const isFailureStep = (value: unknown): value is FailureStep => FAILURE_STEPS.includes(value as FailureStep);
export const isAuthPurpose = (value: unknown): value is AuthPurpose => AUTH_PURPOSES.includes(value as AuthPurpose);

// Optional diagnostics cannot invalidate a workflow checkpoint. Drop legacy,
// corrupt or extra fields and return a fresh object, never the input object.
export function readFailureContext(value: unknown): FailureContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['category', 'code', 'step', 'authPurpose'].includes(key)) ||
      !FAILURE_REASONS.includes(v.category as FailureReason) || !isFailureCode(v.code) || !isFailureStep(v.step) ||
      (v.authPurpose !== undefined && !isAuthPurpose(v.authPurpose))) return null;
  return { category: v.category as FailureReason, code: v.code, step: v.step,
    ...(v.authPurpose === undefined ? {} : { authPurpose: v.authPurpose as AuthPurpose }) };
}

export function authenticationFailureStep(code: FailureCode, phase: string): FailureStep {
  if (SELECTION_FAILURE_CODES.includes(code as (typeof SELECTION_FAILURE_CODES)[number])) return 'group-selection';
  switch (code) {
    case 'configuration-changed': return 'configuration-check';
    case 'tab-unavailable': case 'auth-login-tabs-ambiguous': return 'tab-check';
    case 'navigation-failed': case 'untrusted-navigation': return 'navigation';
    case 'context-changed': case 'auth-pending-checkpoint': case 'auth-clock-invalid': case 'auth-intent-conflict': return 'authentication-context';
    case 'group-identity-changed': return 'group-check';
    case 'applicant-roster-changed': return 'roster-check';
  }
  switch (phase) {
    case 'prepare': return 'login-prepare';
    case 'submit': return 'login-submit';
    case 'wait': return 'login-wait';
    case 'retry': return 'authentication-retry';
    case 'cycle-wait': return 'authentication-cycle-wait';
    default: return 'unknown';
  }
}

export function bookingFailureStep(stage: unknown): FailureStep {
  switch (stage) {
    case 'actions': return 'booking-actions';
    case 'warning': return 'booking-warning';
    case 'applicants': return 'booking-applicants';
    case 'form': return 'booking-form';
    case 'confirm': return 'booking-confirm';
    default: return 'unknown';
  }
}

export function blockedFailureContext(detail: unknown, step: FailureStep): FailureContext {
  const codes: Record<string, FailureCode> = {
    'tab-lost': 'tab-unavailable', 'untrusted-url': 'untrusted-navigation',
    'config-changed': 'configuration-changed', 'cancelled': 'cancelled',
    'group-changed': 'group-identity-changed', 'roster-changed': 'applicant-roster-changed',
    'roster-missing': 'applicant-roster-missing',
    'candidate-invalid': 'candidate-invalid', 'navigation-unconfirmed': 'navigation-unconfirmed',
    'stage-guard': 'stage-guard',
  };
  const code = typeof detail === 'string' && Object.hasOwn(codes, detail) ? codes[detail] : isFailureCode(detail) ? detail : 'unknown';
  return { category: 'workflow-blocked', code, step };
}

// The operation is recorded in failure_step; only known literal reasons may
// cross the adapter boundary. Missing/malformed/unknown replies stay distinct.
export function adapterFailureCode(reply: unknown): FailureCode {
  if (reply === null || reply === undefined) return 'adapter-reply-missing';
  if (typeof reply !== 'object' || Array.isArray(reply)) return 'adapter-reply-malformed';
  const result = reply as { ok?: unknown; reason?: unknown };
  if (result.ok !== false) return 'adapter-reply-malformed';
  return isPaidAdapterFailureCode(result.reason) ? result.reason : 'adapter-reason-unrecognized';
}
export function paidActionStep(action: string): FailureStep {
  switch (action) {
    case 'schedule': return 'booking-schedule-entry';
    case 'reschedule': return 'booking-reschedule-entry';
    case 'warning': return 'booking-warning';
    case 'applicants': return 'booking-applicants';
    case 'facility': return 'booking-facility-change';
    case 'date': return 'booking-date-change';
    case 'time': return 'booking-time-change';
    default: return 'booking-form';
  }
}

// Preserve the last counted setup retry for a later setup-exhausted event;
// this does not emit an event for a retry or for recovery.
export function authenticationRetryContext(detail: string, phase: string, purpose: AuthPurpose): FailureContext {
  const codes: Record<string, FailureCode> = { maintenance: 'auth-retry-maintenance', transport: 'auth-retry-transport',
    'script-interrupted': 'auth-retry-script-interrupted', 'stalled-load': 'auth-retry-stalled-load',
    'reply-missing': 'auth-retry-reply-missing', 'reply-malformed': 'auth-retry-reply-malformed' };
  const code = Object.hasOwn(codes, detail) ? codes[detail] : isFailureCode(detail) ? detail : 'auth-retry-reading-unclassified';
  return { category: 'setup-exhausted', code, step: authenticationFailureStep(code, phase), authPurpose: purpose };
}
