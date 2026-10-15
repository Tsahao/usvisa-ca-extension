import { describe, expect, it } from 'vitest';
import { CONSULATES, type Consulate } from '../src/domain/dates';
import { selectedDate, SUMMARY_HEADING, normalizeSummaryRaw, validateSummaryReading } from '../src/domain/summary';

const CITIES = Object.keys(CONSULATES) as Consulate[];

function reading(dates: Record<string, string | null>) {
  return {
    heading: SUMMARY_HEADING,
    rows: CITIES.map(city => ({ city, date: dates[city] ?? null })),
  };
}

describe('heading-scoped availability summary', () => {
  it('accepts a full seven-city reading with explicit unavailability', () => {
    const value = reading({ Vancouver: '2026-11-19', Toronto: null });
    expect(validateSummaryReading(value).rows).toHaveLength(7);
    expect(selectedDate(validateSummaryReading(value), 'Vancouver')).toBe('2026-11-19');
    expect(selectedDate(validateSummaryReading(value), 'Toronto')).toBeNull();
  });

  it('rejects wrong headings, partial rows, duplicates, and bad dates', () => {    const good = reading({});
    expect(() => validateSummaryReading({ ...good, heading: 'MRV Fee Details' })).toThrow();
    expect(() => validateSummaryReading({ ...good, rows: good.rows.slice(0, 6) })).toThrow();
    expect(() => validateSummaryReading({ ...good, rows: [...good.rows.slice(1), good.rows[0]] })).not.toThrow();
    const duplicated = { ...good, rows: [good.rows[0], ...good.rows.slice(0, 6)] };
    expect(() => validateSummaryReading(duplicated)).toThrow();
    expect(() => validateSummaryReading({ ...good, rows: [{ city: 'Atlantis', date: null }] })).toThrow();
    expect(() =>
      validateSummaryReading(reading({ Vancouver: 'tomorrow' })),
    ).toThrow();
    expect(() => validateSummaryReading(null)).toThrow();
  });

  it('normalizes raw adapter text into a validated reading', () => {
    const raw = {
      headingFound: true,
      rows: [
        ...CITIES.filter(city => city !== 'Vancouver' && city !== 'Toronto').map(city => ({ city, text: 'No Appointments Available' })),
        { city: 'Vancouver', text: 'November 19, 2026' },
        { city: 'Toronto', text: '' },
      ],
    };
    const reading = normalizeSummaryRaw(raw);
    expect(selectedDate(reading, 'Vancouver')).toBe('2026-11-19');
    expect(selectedDate(reading, 'Toronto')).toBeNull();
    const dayFirst = normalizeSummaryRaw({
      headingFound: true,
      rows: CITIES.map(city => ({ city, text: city === 'Calgary' ? '19 November, 2026' : 'No Appointments Available' })),
    });
    expect(selectedDate(dayFirst, 'Calgary')).toBe('2026-11-19');    expect(() => normalizeSummaryRaw({ headingFound: false, rows: [] })).toThrow();
    expect(() =>
      normalizeSummaryRaw({ headingFound: true, rows: [{ city: 'Atlantis', text: 'November 19, 2026' }] }),
    ).toThrow();
    expect(() =>
      normalizeSummaryRaw({ headingFound: true, rows: [{ city: 'Vancouver', text: 'sometime soon' }] }),
    ).toThrow();
  });
});
