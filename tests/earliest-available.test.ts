import { describe, expect, it } from 'vitest';
import { earliestCandidate, type DatePreferences } from '../src/domain/dates';
import { earliestObserved, formatDate } from '../src/ui/model';

describe('paid panel earliest-available display', () => {
  it('returns the earliest sorted valid observed date without policy filtering', () => {
    expect(earliestObserved(['2026-11-25', '2026-11-19', '2026-11-24'])).toBe('2026-11-19');
  });
  it('handles empty, unsorted, and malformed days without throwing', () => {
    expect(earliestObserved([])).toBeNull();
    expect(earliestObserved(['not-a-date', '', '2026-11-24', '2026-11-19'])).toBe('2026-11-19');
    expect(earliestObserved(['not-a-date'])).toBeNull();
  });
  it('displays later-than-booked dates while the booking candidate stays filtered', () => {
    const days = ['2026-11-25', '2026-11-19', '2026-11-24'];
    const prefs: DatePreferences = {
      earliest: '2026-11-01', latest: '2026-12-31', exclusions: [], onlyEarlier: true,
    };
    expect(earliestObserved(days)).toBe('2026-11-19');
    expect(formatDate(earliestObserved(days))).not.toBe('Unavailable');
    expect(earliestCandidate(days, '2026-11-06', prefs)).toBeNull();
  });
  it('displays out-of-window dates while the booking candidate stays filtered', () => {
    const days = ['2026-11-25', '2026-11-19', '2026-11-24'];
    const prefs: DatePreferences = {
      earliest: '2026-12-01', latest: '2026-12-31', exclusions: [], onlyEarlier: true,
    };
    expect(earliestObserved(days)).toBe('2026-11-19');
    expect(earliestCandidate(days, '2026-11-06', prefs)).toBeNull();
  });
});
