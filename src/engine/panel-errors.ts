import { panelCommandError } from './start-errors';

// Classified panel failure for the three Figma error states: a catch-all
// plus two selected-group states. Only exact known domain errors and
// their exact fixed safe diagnostics classify as specific kinds; everything
// else (unknown, unreadable, ambiguous, changed group) stays generic. No
// identifiers, URLs, or credentials ever appear here.
export type PanelFailureKind = 'generic' | 'paid-ivr-not-found' | 'unpaid-ivr-not-found';

const PAID_DOMAIN = 'Paid group not found on the dashboard.';
const UNPAID_DOMAIN = 'Unpaid group not found on the dashboard.';
const PAID_REJECTED_DOMAIN = 'Unpaid group rejected for paid booking.';
const UNPAID_REJECTED_DOMAIN = 'Paid group rejected for unpaid tracking.';

// Derive the exact fixed safe diagnostics from the single source so the
// classification cannot drift from the user-visible messages.
const PAID_SAFE = panelCommandError(new Error(PAID_DOMAIN), 'selection');
const UNPAID_SAFE = panelCommandError(new Error(UNPAID_DOMAIN), 'selection');
const PAID_REJECTED_SAFE = panelCommandError(new Error(PAID_REJECTED_DOMAIN), 'selection');
const UNPAID_REJECTED_SAFE = panelCommandError(new Error(UNPAID_REJECTED_DOMAIN), 'selection');

export function isPanelFailureKind(value: unknown): value is PanelFailureKind {
  return value === 'generic' || value === 'paid-ivr-not-found' || value === 'unpaid-ivr-not-found';
}

export function panelFailureKind(error: unknown): PanelFailureKind {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (message === PAID_DOMAIN || message === PAID_SAFE ||
      message === PAID_REJECTED_DOMAIN || message === PAID_REJECTED_SAFE) return 'paid-ivr-not-found';
  if (message === UNPAID_DOMAIN || message === UNPAID_SAFE ||
      message === UNPAID_REJECTED_DOMAIN || message === UNPAID_REJECTED_SAFE) return 'unpaid-ivr-not-found';
  return 'generic';
}
