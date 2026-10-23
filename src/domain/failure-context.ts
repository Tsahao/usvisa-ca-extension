import { AUTHENTICATION_FAILURE_REASONS, SELECTION_FAILURE_CODES } from './diagnostics';

// Public telemetry vocabulary. Never accept raw errors, routes or page data.
// Local diagnostic details must be explicitly mapped before they can leave
// the device; adding a local diagnostic does not automatically export it.
export const FAILURE_REASONS = ['start-failed', 'setup-exhausted', 'authentication-failed', 'workflow-blocked'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
export const FAILURE_CODES = [
  ...AUTHENTICATION_FAILURE_REASONS,
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
    case 'tab-unavailable': return 'tab-check';
    case 'navigation-failed': case 'untrusted-navigation': return 'navigation';
    case 'context-changed': return 'authentication-context';
    case 'group-identity-changed': return 'group-check';
    case 'applicant-roster-changed': return 'roster-check';
    case 'appointment-date-changed': return 'baseline-check';
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
    'roster-missing': 'applicant-roster-missing', 'baseline-changed': 'appointment-date-changed',
    'candidate-invalid': 'candidate-invalid', 'navigation-unconfirmed': 'navigation-unconfirmed',
    'stage-guard': 'stage-guard',
  };
  const code = typeof detail === 'string' && Object.hasOwn(codes, detail) ? codes[detail] : 'unknown';
  return { category: 'workflow-blocked', code, step };
}
