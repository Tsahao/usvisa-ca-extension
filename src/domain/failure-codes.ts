// Fixed, identifier-free leaf causes shared by engine analytics and local
// diagnostics. Never accept arbitrary adapter replies or exception messages.
export const PAID_ADAPTER_FAILURE_CODES = [
  'applicants-mismatch', 'bad-slot', 'calendar-context-changed',
  'calendar-load-timeout', 'calendar-missing',
  'control-disabled', 'control-missing', 'facility-date-unavailable',
  'calendar-load-ambiguous', 'calendar-request-retryable', 'facility-request-retryable', 'facility-load-ambiguous', 'facility-load-timeout',
  'facility-missing', 'form-missing', 'wrong-action', 'wrong-route', 'wrong-stage', 'wrong-target',
  'facility-request-denied', 'facility-network-failed', 'facility-server-error', 'facility-http-error',
  'facility-context-changed', 'facility-response-invalid', 'facility-change-handler-failed',
  'calendar-request-denied', 'calendar-network-failed', 'calendar-server-error', 'calendar-http-error',
  'calendar-response-invalid', 'calendar-times-mismatch', 'calendar-callback-failed', 'time-option-unavailable',
] as const;
export type PaidAdapterFailureCode = (typeof PAID_ADAPTER_FAILURE_CODES)[number];
export const WORKFLOW_DETAIL_CODES = [
  ...PAID_ADAPTER_FAILURE_CODES,
  'tab-navigation-pending', 'tab-loading',
  'executor-mode-invalid', 'executor-group-unpaid', 'executor-owner-missing', 'executor-run-missing',
  'confirmation-intent-missing', 'confirmation-intent-mismatch', 'booking-stage-unrecognized', 'executor-missing', 'executor-tab-ambiguous', 'executor-tab-missing',
  'dashboard-path-missing', 'page-kind-mismatch', 'applicant-selection-invalid', 'applicant-selection-malformed',
  'form-read-missing', 'calendar-not-ready', 'portal-slot-warning',
  'form-date-mismatch', 'form-time-mismatch', 'form-facility-invalid', 'booking-form-invalid',
  'test-mode-guard-inconsistent', 'warning-acknowledgement-refused',
  'adapter-execution-failed', 'adapter-reply-missing', 'adapter-reply-malformed', 'adapter-reason-unrecognized',
  'booking-policy-group-mismatch', 'booking-policy-applicants-mismatch',
  'booking-policy-consulate-unselected', 'booking-policy-consulate-mismatch',
  'booking-policy-date-ineligible', 'booking-policy-time-missing', 'booking-policy-test-mode',
  'auth-retry-maintenance', 'auth-retry-transport', 'auth-retry-script-interrupted',
  'auth-retry-stalled-load', 'auth-retry-reply-missing', 'auth-retry-reply-malformed', 'auth-retry-reading-unclassified',
  'poll-consulates-invalid', 'poll-date-window-invalid', 'summary-tab-unavailable',
  'summary-tab-ambiguous', 'monitor-state-invalid', 'owned-tab-check-failed',
  'entry-navigation-failed', 'entry-context-changed', 'tab-query-failed', 'authentication-tab-missing',
  'start-state-read-failed', 'start-dashboard-inspection-failed', 'start-groups-read-failed',
  'start-selection-failed', 'start-baseline-read-failed', 'start-roster-read-failed', 'start-save-failed',
  'start-configuration-invalid', 'start-mode-invalid', 'start-dashboard-ambiguous', 'start-dashboard-tab-missing',
  'start-context-changed', 'poll-alarm-failed', 'worker-auth-checkpoint-interrupted',
] as const;

export function isPaidAdapterFailureCode(value: unknown): value is PaidAdapterFailureCode {
  return PAID_ADAPTER_FAILURE_CODES.includes(value as PaidAdapterFailureCode);
}
