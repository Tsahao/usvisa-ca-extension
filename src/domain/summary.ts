import { CONSULATES, isIsoDate, parseLongDateUs, type Consulate } from './dates';

export const SUMMARY_HEADING = 'First Available Appointments';

export type SummaryRow = {
  city: Consulate;
  date: string | null;
};

export type SummaryReading = {
  heading: string;
  rows: SummaryRow[];
};

const CITIES = Object.keys(CONSULATES) as Consulate[];

// Heading-scoped seven-city summary validation. The tracker reads only the
// `First Available Appointments` section, never applicant/fee tables.
// null is explicit per-city unavailability; anything malformed, missing, or
// duplicated throws so the caller leaves the last healthy observation alone.
export function validateSummaryReading(value: unknown): SummaryReading {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid availability summary.');
  const reading = value as Record<string, unknown>;
  if (reading.heading !== SUMMARY_HEADING) throw new Error('Invalid availability summary.');
  if (!Array.isArray(reading.rows) || reading.rows.length !== CITIES.length)
    throw new Error('Invalid availability summary.');
  const seen = new Set<string>();
  const rows: SummaryRow[] = reading.rows.map(row => {
    if (typeof row !== 'object' || row === null) throw new Error('Invalid availability summary.');
    const entry = row as Record<string, unknown>;
    if (!CITIES.includes(entry.city as Consulate) || seen.has(entry.city as string))
      throw new Error('Invalid availability summary.');
    seen.add(entry.city as string);
    if (entry.date !== null && (typeof entry.date !== 'string' || !isIsoDate(entry.date)))
      throw new Error('Invalid availability summary.');
    return { city: entry.city as Consulate, date: entry.date as string | null };
  });
  return { heading: SUMMARY_HEADING, rows };
}

export function selectedDate(reading: SummaryReading, consulate: Consulate): string | null {
  const row = validateSummaryReading(reading).rows.find(entry => entry.city === consulate);
  if (!row) throw new Error('Selected consulate missing from the summary.');
  return row.date;
}

const CITY_TEXT: Record<string, Consulate> = {
  Calgary: 'Calgary',
  Halifax: 'Halifax',
  Montreal: 'Montreal',
  Ottawa: 'Ottawa',
  'Quebec City': 'Quebec',
  Quebec: 'Quebec',
  Toronto: 'Toronto',
  Vancouver: 'Vancouver',
};

const UNAVAILABLE_TEXT = new Set(['', 'No Appointments Available', 'Unavailable', 'N/A', '-']);

// Normalizes raw adapter text into a validated reading. City labels must
// match the known set and dates must parse; anything else throws so the
// caller leaves the last healthy observation untouched.
export function normalizeSummaryRaw(value: { headingFound: boolean; rows: { city: string; text: string }[] }): SummaryReading {
  if (!value.headingFound) throw new Error('Availability summary heading missing.');
  const rows = value.rows.map(row => {
    const city = CITY_TEXT[(row.city ?? '').trim()];
    if (!city) throw new Error('Unknown summary city.');
    const text = (row.text ?? '').trim();
    if (UNAVAILABLE_TEXT.has(text)) return { city, date: null };
    const date = parseLongDateUs(text);
    if (!date) throw new Error('Unknown summary date.');
    return { city, date };
  });
  return validateSummaryReading({ heading: SUMMARY_HEADING, rows });
}
