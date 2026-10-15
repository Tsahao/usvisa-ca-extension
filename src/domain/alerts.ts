import { inWindow, isIsoDate, type DatePreferences } from './dates';

export type AlertState = {
  observed: string | null | undefined;
  delivered: string | null;
  pending: boolean;
};
export const emptyAlertState = (): AlertState => ({ observed: undefined, delivered: null, pending: false });

// Call only after a healthy summary read. Read failures leave state untouched.
// null means explicit unavailability; undefined means no healthy observation yet.
export function observeDate(state: AlertState, date: string | null, prefs: DatePreferences, rangeOnly: boolean): AlertState {
  if (date !== null && !isIsoDate(date)) throw new Error('Invalid appointment observation.');
  if (date === state.observed) return state;
  return { ...state, observed: date, pending: date !== null && (!rangeOnly || inWindow(date, prefs)) };
}

// "delivered" means Chrome accepted notification creation, not that it was seen.
// Delayed results must never mark a newer observation as delivered.
export function notificationAccepted(state: AlertState, date: string): AlertState {
  if (!state.pending || state.observed !== date) return state;
  return { ...state, delivered: date, pending: false };
}
