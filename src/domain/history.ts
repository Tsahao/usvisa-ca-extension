import { CONSULATES, isIsoDate, type Consulate } from './dates';

export const HISTORY_KEY = 'dateHistoryV1';
export const HISTORY_ALARM = 'dateHistoryExpiry';
export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
export const HISTORY_LIMIT = 100;
export type BookingResult = 'No' | 'Attempted' | 'Yes';
export type HistoryRow = { id: string; checkedAt: string; earliestDate: string; booked: BookingResult; consulate?: Consulate };
export type HistoryEntry = HistoryRow & { scope: string; attempt: string | null };
type Baseline = { scope: string; date: string | null; checkedAt: string };
export type DateHistory = { version: 1; entries: HistoryEntry[]; baselines: Baseline[] };

export function emptyHistory(): DateHistory { return { version: 1, entries: [], baselines: [] }; }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const consulateKey = (value: unknown): value is Consulate => typeof value === 'string' && Object.hasOwn(CONSULATES, value);
const date = (value: unknown): value is string => typeof value === 'string' && isIsoDate(value);

// Reconstruct only the allowlisted fields. History never retains raw portal
// content, account/group/applicant IDs, credentials, or arbitrary saved fields.
export function validateHistory(raw: unknown): DateHistory {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid date history.');
  const value = raw as DateHistory;
  if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > HISTORY_LIMIT ||
      !Array.isArray(value.baselines) || value.baselines.length > HISTORY_LIMIT) throw new Error('Invalid date history.');
  const entries = value.entries.map(entry => {
    if (!entry || !digest(entry.scope) || !timestamp(entry.checkedAt) || !date(entry.earliestDate) ||
        entry.id !== `${entry.scope}:${entry.checkedAt}` || !['No', 'Attempted', 'Yes'].includes(entry.booked) ||
        !(entry.attempt === null || digest(entry.attempt)) || (entry.booked !== 'No' && entry.attempt === null) ||
        !(entry.consulate === undefined || consulateKey(entry.consulate)))
      throw new Error('Invalid date history.');
    return { id: entry.id, scope: entry.scope, checkedAt: entry.checkedAt,
      earliestDate: entry.earliestDate, booked: entry.booked, attempt: entry.attempt,
      ...(entry.consulate === undefined ? {} : { consulate: entry.consulate }) };
  });
  const baselines = value.baselines.map(baseline => {
    if (!baseline || !digest(baseline.scope) || !timestamp(baseline.checkedAt) ||
        !(baseline.date === null || date(baseline.date))) throw new Error('Invalid date history.');
    return { scope: baseline.scope, date: baseline.date, checkedAt: baseline.checkedAt };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length ||
      new Set(baselines.map(baseline => baseline.scope)).size !== baselines.length) throw new Error('Invalid date history.');
  return { version: 1, entries, baselines };
}

export function pruneHistory(history: DateHistory, now: string): DateHistory {
  if (!timestamp(now)) throw new Error('Invalid history time.');
  const current = Date.parse(now);
  const retained = (item: { checkedAt: string }) => Date.parse(item.checkedAt) > current - HISTORY_TTL_MS && Date.parse(item.checkedAt) <= current;
  const newest = (a: { checkedAt: string }, b: { checkedAt: string }) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt);
  return { version: 1, entries: history.entries.filter(retained).sort(newest).slice(0, HISTORY_LIMIT),
    baselines: history.baselines.filter(retained).sort(newest).slice(0, HISTORY_LIMIT) };
}

export function observeHistory(history: DateHistory, reading: { scope: string; earliestDate: string | null; checkedAt: string; consulate: Consulate }, now: string): DateHistory {
  const clean = pruneHistory(history, now);
  if (!digest(reading.scope) || !timestamp(reading.checkedAt) || Date.parse(reading.checkedAt) > Date.parse(now) ||
      Date.parse(reading.checkedAt) <= Date.parse(now) - HISTORY_TTL_MS ||
      !(reading.earliestDate === null || date(reading.earliestDate)) || !consulateKey(reading.consulate)) throw new Error('Invalid history reading.');
  const previous = clean.baselines.find(item => item.scope === reading.scope);
  if (previous && Date.parse(previous.checkedAt) >= Date.parse(reading.checkedAt)) return clean;
  const changed = !previous || previous.date !== reading.earliestDate;
  const entry: HistoryEntry | null = changed && reading.earliestDate !== null
    ? { id: `${reading.scope}:${reading.checkedAt}`, scope: reading.scope, checkedAt: reading.checkedAt,
      earliestDate: reading.earliestDate, booked: 'No', attempt: null, consulate: reading.consulate } : null;
  return pruneHistory({ version: 1, entries: entry ? [entry, ...clean.entries] : clean.entries,
    baselines: [{ scope: reading.scope, date: reading.earliestDate, checkedAt: reading.checkedAt },
      ...clean.baselines.filter(item => item.scope !== reading.scope)].slice(0, HISTORY_LIMIT) }, now);
}

// A candidate may differ from the raw earliest date (e.g. outside the user's
// date window). Only that exact observed appointment can receive its outcome.
export function markHistoryBooking(history: DateHistory, event: { scope: string; targetDate: string; createdAt: string; attempt: string }, result: 'Attempted' | 'Yes', now: string): DateHistory {
  const clean = pruneHistory(history, now);
  if (!digest(event.scope) || !digest(event.attempt) || !date(event.targetDate) || !timestamp(event.createdAt) ||
      Date.parse(event.createdAt) > Date.parse(now)) throw new Error('Invalid history attempt.');
  const latest = clean.entries.find(entry => entry.scope === event.scope);
  if (!latest || latest.earliestDate !== event.targetDate || Date.parse(latest.checkedAt) > Date.parse(event.createdAt) ||
      (result === 'Yes' && latest.attempt !== null && latest.attempt !== event.attempt) || latest.booked === 'Yes') return clean;
  return { ...clean, entries: clean.entries.map(entry => entry === latest
    ? { ...entry, booked: entry.booked === 'Yes' ? 'Yes' : result, attempt: event.attempt } : entry) };
}

export function historyRows(history: DateHistory, now: string): HistoryRow[] {
  return pruneHistory(history, now).entries.map(({ id, checkedAt, earliestDate, booked, consulate }) =>
    ({ id, checkedAt, earliestDate, booked, ...(consulate === undefined ? {} : { consulate }) }));
}

export function historyExpiry(history: DateHistory): string | null {
  const times = [...history.entries, ...history.baselines].map(item => Date.parse(item.checkedAt) + HISTORY_TTL_MS);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}
