import { CONSULATE_ORDER, isIsoDate, selectedConsulates, type Consulate } from '../domain/dates';
import { readAutoMode } from '../domain/auto-mode';
import { minimumPollIntervalSeconds } from '../domain/timing';

export const TERMS_VERSION = 'ui-preview-1';
export const CITIES: Consulate[] = [...CONSULATE_ORDER];
// Figma's visual order is independent of the booking engine's tie-break order.
export const CITY_DISPLAY_ORDER: readonly Consulate[] = ['Calgary', 'Halifax', 'Ottawa', 'Toronto', 'Vancouver', 'Montreal', 'Quebec'];
export type Mode = 'booking' | 'alerts';
export type RunStatus = 'idle' | 'running' | 'success' | 'failure';
export type Preferences = {
  email: string; password: string; consulates: Consulate[]; earliest: string; latest: string;
  autoMode: boolean; onlyEarlier: boolean; interval: number;
  // UI-only rollback memory when the consulate minimum raised the interval.
  intervalBeforeAutoIncrease?: number;
  paidIvr: string; unpaidIvr: string;
};
export type Run = { mode: Mode; status: RunStatus; lastChecked: string | null };
export const DEFAULT_ADVANCED = {
  onlyEarlier: true, interval: 60, paidIvr: '', unpaidIvr: '',
};
export const EMPTY_PREFERENCES: Preferences = { email: '', password: '', consulates: [], earliest: '', latest: '', autoMode: true, ...DEFAULT_ADVANCED };
export const DEMO_PREFERENCES: Preferences = {
  ...EMPTY_PREFERENCES, email: 'preview@example.invalid', password: 'synthetic-preview-password',
  consulates: ['Vancouver'], earliest: '2026-11-01', latest: '2027-12-31',
};
export const DEMO_DATES: Record<Consulate, string | null> = {
  Calgary: '2026-12-21', Halifax: '2027-01-22', Montreal: '2026-12-03',
  Ottawa: '2027-02-17', Quebec: null, Toronto: '2026-11-26', Vancouver: '2026-11-19',
};
export const DEMO_AVAILABILITY = ['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-28', '2026-12-29'];
export const DEMO_APPOINTMENT = '2027-06-21';
export const EMPTY_RUN: Run = { mode: 'booking', status: 'idle', lastChecked: null };

export type PreferenceIssue = { fields: (keyof Preferences)[]; message: string };

export function intervalBaseline(prefs: Preferences): number {
  const remembered = prefs.intervalBeforeAutoIncrease;
  // Ignore malformed/stale metadata rather than reducing a user's saved value.
  return typeof remembered === 'number' && Number.isInteger(remembered) && remembered >= 30 &&
    Number.isInteger(prefs.interval) && prefs.interval <= 86400 && remembered < prefs.interval
    ? remembered : prefs.interval;
}

// Normalize drafts only: existing saved settings are not silently rewritten.
// Reversible automatic increases never replace the user's original choice.
export function withMinimumInterval(prefs: Preferences): Preferences {
  const { intervalBeforeAutoIncrease: _remembered, ...rest } = prefs;
  const baseline = intervalBaseline(prefs);
  const interval = Math.max(baseline, minimumPollIntervalSeconds(prefs));
  return { ...rest, interval, ...(interval > baseline && Number.isInteger(baseline) && baseline >= 30
    ? { intervalBeforeAutoIncrease: baseline } : {}) };
}

export function updatePreference<K extends keyof Preferences>(prefs: Preferences, key: K, value: Preferences[K]): Preferences {
  const next = { ...prefs, [key]: value };
  if (key === 'consulates') return withMinimumInterval(next);
  if (key === 'interval') {
    // Even editing an auto-raised value back to the same number is an explicit
    // choice. Only consulate changes may create rollback memory.
    const { intervalBeforeAutoIncrease: _remembered, ...manual } = next;
    return manual;
  }
  return next;
}

export function preferenceIssues(prefs: Preferences): PreferenceIssue[] {
  const issues: PreferenceIssue[] = [];
  if (readAutoMode(prefs) === null) issues.push({ fields: ['autoMode'], message: 'Choose whether to book appointments automatically.' });
  // No email-format gate by user decision: owners enter their own account
  // email, and a wrong address fails at sign-in instead of blocking setup.
  if (!prefs.password) issues.push({ fields: ['password'], message: 'Enter your visa account password.' });
  if (!selectedConsulates(prefs)?.length) issues.push({ fields: ['consulates'], message: 'Select at least one consulate.' });
  for (const field of ['earliest', 'latest'] as const) {
    if (!isIsoDate(prefs[field])) issues.push({ fields: [field], message: 'Choose a valid inclusive date window.' });
  }
  if (isIsoDate(prefs.earliest) && isIsoDate(prefs.latest) && prefs.earliest > prefs.latest)
    issues.push({ fields: ['earliest', 'latest'], message: 'Choose a valid inclusive date window.' });
  const minimumInterval = minimumPollIntervalSeconds(prefs);
  if (!Number.isInteger(prefs.interval) || prefs.interval < minimumInterval || prefs.interval > 86400)
    issues.push({ fields: ['interval'], message: `Checking interval must be a whole number from ${minimumInterval} to 86400 seconds.` });
  for (const field of ['paidIvr', 'unpaidIvr'] as const) {
    if (prefs[field] !== '' && !/^\d+$/.test(prefs[field])) issues.push({ fields: [field], message: 'IVR groups must contain digits only.' });
  }
  return issues;
}

export function preferencesError(prefs: Preferences): string | null {
  return preferenceIssues(prefs)[0]?.message ?? null;
}

// Figma renders a missing value as a pair of dashes. A single em dash reads as
// one continuous line, so keep the two marks visibly apart.
export const NO_VALUE = '- -';

export function formatDate(value: string | null): string {
  if (!value) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}
export function cityLabel(city: string): string { return city === 'Quebec' ? 'Quebec City' : city; }
export function earliestObserved(dates: string[]): string | null {
  return [...dates].filter(isIsoDate).sort()[0] ?? null;
}
export function calendarDays(month: string): { iso: string; day: number; inMonth: boolean }[] {
  const first = new Date(`${month}-01T00:00:00Z`);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1 - first.getUTCDay() + index));
    return { iso: date.toISOString().slice(0, 10), day: date.getUTCDate(), inMonth: date.getUTCMonth() === first.getUTCMonth() };
  });
}
export function shiftMonth(month: string, change: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + change);
  return date.toISOString().slice(0, 7);
}
