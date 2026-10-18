import { emptyAlertState, notificationAccepted, observeDate, type AlertState } from './alerts';
import { isIsoDate, type Consulate, type DatePreferences } from './dates';
import { selectedDate, validateSummaryReading } from './summary';
export type MonitorState = {
  scopeKey: string;
  alert: AlertState;
  baseline: string | null;
  lastHealthyAt: string | null;
};

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

// Scope binds preferences, policy, account, and resolved group/schedule.
// A configuration or group change never silently inherits another scope's
// baseline: mismatched observations throw and the caller must reset
// explicitly. The key itself carries no identifiers outward.
export function initialMonitor(scopeKey: string): MonitorState {
  if (typeof scopeKey !== 'string' || scopeKey.length === 0) throw new Error('Invalid monitor scope.');
  return { scopeKey, alert: emptyAlertState(), baseline: null, lastHealthyAt: null };
}

export function resetBaseline(state: MonitorState): MonitorState {
  return { scopeKey: state.scopeKey, alert: emptyAlertState(), baseline: null, lastHealthyAt: state.lastHealthyAt };
}

// Applies one healthy summary read. Malformed readings throw before any
// state is touched, so read failures never alter the observation.
// Returns the next state plus the date owed a notification, if any.
export function observeSummary(
  state: MonitorState,
  reading: unknown,
  args: { scopeKey: string; consulate: Consulate; prefs: DatePreferences; rangeOnly: boolean; now: string },
): { state: MonitorState; alertDue: string | null } {
  const date = selectedDate(validateSummaryReading(reading), args.consulate);
  return observeMonitorDate(state, date, args);
}

// Shared change detection/delivery semantics for summary alerts and eligible
// paid dates. The paid caller applies the full window/earlier-only policy first.
export function observeMonitorDate(
  state: MonitorState,
  date: string | null,
  args: { scopeKey: string; prefs: DatePreferences; rangeOnly: boolean; now: string },
): { state: MonitorState; alertDue: string | null } {
  if (args.scopeKey !== state.scopeKey) throw new Error('Monitor scope changed; reset the baseline explicitly.');
  if (!isIsoDateTime(args.now)) throw new Error('Invalid monitor timestamp.');
  const alert = observeDate(state.alert, date, args.prefs, args.rangeOnly);
  const next: MonitorState = {
    ...state,
    alert,
    baseline: state.baseline ?? date,
    lastHealthyAt: args.now,
  };
  return { state: next, alertDue: alert.pending && alert.observed ? alert.observed : null };
}

// Records Chrome's acceptance of a notification creation. Acceptance is not
// proof the user saw it, and a delayed acceptance for a superseded date is
// dropped: obsolete intermediate dates are never marked delivered.
export function acceptNotification(state: MonitorState, date: string): MonitorState {
  return { ...state, alert: notificationAccepted(state.alert, date) };
}

// Durable-shape validation for the worker's monitor slot. Anything malformed
// throws so the worker parks for review instead of inheriting a stranger's
// baseline. No identifiers are involved: scope keys are opaque.
export function validateMonitorState(value: unknown): MonitorState {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid monitor state.');
  const state = value as Record<string, unknown>;
  if (typeof state.scopeKey !== 'string' || state.scopeKey.length === 0) throw new Error('Invalid monitor state.');
  if (state.baseline !== null && (typeof state.baseline !== 'string' || !isIsoDate(state.baseline))) throw new Error('Invalid monitor state.');
  if (state.lastHealthyAt !== null && !isIsoDateTime(state.lastHealthyAt)) throw new Error('Invalid monitor state.');
  const alert = state.alert as Record<string, unknown> | undefined;
  if (typeof alert !== 'object' || alert === null || typeof alert.pending !== 'boolean') throw new Error('Invalid monitor state.');
  if (!(alert.observed === undefined || alert.observed === null || (typeof alert.observed === 'string' && isIsoDate(alert.observed))) ||
      !(alert.delivered === null || (typeof alert.delivered === 'string' && isIsoDate(alert.delivered))) ||
      (alert.pending && typeof alert.observed !== 'string')) throw new Error('Invalid monitor state.');
  return state as MonitorState;
}

// Only a freshly validated Start may establish a different scope. A corrupt
// slot is never silently repaired, even during Start; same-scope delivery
// history survives restarts and ordinary polls cannot transfer a baseline.
export function monitorForScope(saved: unknown, scopeKey: string, freshStart = false): MonitorState {
  if (saved === undefined) return initialMonitor(scopeKey);
  if (!saved || typeof saved !== 'object') throw new Error('Invalid monitor slot.');
  const slot = saved as Record<string, unknown>;
  const monitor = validateMonitorState(slot.monitor);
  if (slot.scopeKey !== monitor.scopeKey) throw new Error('Invalid monitor slot.');
  if (monitor.scopeKey === scopeKey) return monitor;
  if (!freshStart) throw new Error('Monitor scope changed.');
  return initialMonitor(scopeKey);
}
