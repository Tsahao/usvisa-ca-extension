export const CONSULATES = {
  Calgary: 89, Halifax: 90, Montreal: 91, Ottawa: 92,
  Quebec: 93, Toronto: 94, Vancouver: 95,
} as const;
export type Consulate = keyof typeof CONSULATES;
export type DateRange = { start: string; end: string };
export type DatePreferences = {
  earliest: string; latest: string; exclusions: DateRange[];
  onlyEarlier: boolean;
};

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Parses dashboard and summary prose dates in US ("October 13, 2026") and
// day-first ("19 November, 2026") order. Returns the ISO day or null when no
// calendar date is present. Never throws.
export function parseLongDateUs(text: string): string | null {
  const us = /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(text);
  const dayFirst = /(\d{1,2})\s+([A-Za-z]+),\s+(\d{4})/.exec(text);
  const match = us ?? dayFirst;
  if (!match) return null;
  const monthName = us ? match[1] : match[2];
  const dayText = us ? match[2] : match[1];
  const yearText = match[3];
  const month = LONG_MONTHS.indexOf(monthName);
  if (month === -1) return null;
  const day = Number(dayText);
  const iso = new Date(Date.UTC(Number(yearText), month, day)).toISOString().slice(0, 10);
  const check = new Date(`${iso}T00:00:00.000Z`);
  if (check.getUTCFullYear() !== Number(yearText) || check.getUTCMonth() !== month || check.getUTCDate() !== day)
    return null;
  return iso;
}

export function validatePreferences(prefs: DatePreferences): void {
  if (!isIsoDate(prefs.earliest) || !isIsoDate(prefs.latest) || prefs.earliest > prefs.latest)
    throw new Error('Choose a valid inclusive date window.');
  if (prefs.exclusions.length > 9) throw new Error('Use at most nine exclusion ranges.');
  for (const range of prefs.exclusions) {
    if (!isIsoDate(range.start) || !isIsoDate(range.end) || range.start > range.end)
      throw new Error('Choose valid exclusion ranges.');
  }
}

export function inWindow(value: string, prefs: DatePreferences): boolean {
  validatePreferences(prefs);
  return isIsoDate(value) && value >= prefs.earliest && value <= prefs.latest
    && !prefs.exclusions.some(range => value >= range.start && value <= range.end);
}

export function canBook(value: string, currentDate: string | null, prefs: DatePreferences): boolean {
  if (currentDate !== null && !isIsoDate(currentDate)) return false;
  return inWindow(value, prefs) && (!prefs.onlyEarlier || currentDate === null || value < currentDate);
}

export function earliestCandidate(dates: string[], currentDate: string | null, prefs: DatePreferences): string | null {
  return [...dates].sort().find(value => canBook(value, currentDate, prefs)) ?? null;
}
