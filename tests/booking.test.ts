import { describe, expect, it } from 'vitest';
import { guardBooking, verifyBooking, type BookingExpectation, type BookingForm } from '../src/domain/booking';
import type { DatePreferences } from '../src/domain/dates';

const PREFS: DatePreferences = {
  earliest: '2026-11-01',
  latest: '2026-12-31',
  exclusions: [],
  onlyEarlier: true,
};

function form(overrides: Partial<BookingForm> = {}): BookingForm {
  return {
    scheduleId: '11111111',
    applicantIds: ['77777777', '88888888'],
    facilityId: 95,
    date: '2026-11-19',
    time: '09:15',
    ...overrides,
  };
}

function expected(overrides: Partial<BookingExpectation> = {}): BookingExpectation {
  return {
    scheduleId: '11111111',
    applicantIds: ['88888888', '77777777'],
    consulate: 'Vancouver',
    currentDate: '2027-06-21',
    prefs: PREFS,
    testMode: false,
    ...overrides,
  };
}

describe('pre-submit booking guard', () => {
  it('allows a fully eligible live form', () => {
    expect(guardBooking(form(), expected())).toEqual({ allowed: true });
  });

  it('denies every Test Mode confirmation even when eligible', () => {
    expect(guardBooking(form(), expected({ testMode: true }))).toEqual({ allowed: false, reason: 'test-mode' });
  });

  it('denies group, applicant, consulate, date, and time mismatches with fixed tokens', () => {
    expect(guardBooking(form({ scheduleId: '99999999' }), expected())).toEqual({ allowed: false, reason: 'group-mismatch' });
    expect(guardBooking(form({ applicantIds: ['77777777'] }), expected())).toEqual({
      allowed: false,
      reason: 'applicants-mismatch',
    });
    expect(guardBooking(form({ applicantIds: ['77777777', '88888888', '99999999'] }), expected())).toEqual({
      allowed: false,
      reason: 'applicants-mismatch',
    });
    expect(guardBooking(form({ facilityId: 94 }), expected())).toEqual({ allowed: false, reason: 'consulate-mismatch' });
    expect(guardBooking(form({ date: '2027-07-01' }), expected())).toEqual({ allowed: false, reason: 'date-ineligible' });
    expect(guardBooking(form({ date: '2026-10-01' }), expected())).toEqual({ allowed: false, reason: 'date-ineligible' });
    expect(guardBooking(form({ time: '' }), expected())).toEqual({ allowed: false, reason: 'time-missing' });
    const denial = guardBooking(form({ scheduleId: '99999999' }), expected());
    expect(JSON.stringify(denial)).not.toContain('99999999');
  });

  it('supports initial booking with no current appointment', () => {
    expect(guardBooking(form(), expected({ currentDate: null }))).toEqual({ allowed: true });
    expect(guardBooking(form({ date: '2026-10-01' }), expected({ currentDate: null }))).toEqual({
      allowed: false,
      reason: 'date-ineligible',
    });
  });

  it('fails closed on malformed forms instead of guessing', () => {
    expect(() => guardBooking({ ...form(), scheduleId: 'abc' }, expected())).toThrow();
    expect(() => guardBooking({ ...form(), applicantIds: 'x' as unknown as string[] }, expected())).toThrow();
    expect(() => guardBooking(null as unknown as BookingForm, expected())).toThrow();
  });
});

describe('date-only verification', () => {
  it('cannot claim success when the target date equals the previous date', () => {
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2026-11-19', reads: ['2026-11-19', '2026-11-19', '2026-11-19'] })).toBe('uncertain-stop');
  });
  it('confirms the target, continues on a repeated previous date, stops otherwise', () => {
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: ['2027-06-21', '2026-11-19'] })).toBe(
      'target-confirmed',
    );
    expect(
      verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: ['2027-06-21', '2027-06-21', '2027-06-21'] }),
    ).toBe('previous-continue');
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: ['2027-06-21', null] })).toBe(
      'uncertain-stop',
    );
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: ['2026-12-01'] })).toBe('uncertain-stop');
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: '2027-06-21', reads: [] })).toBe('uncertain-stop');
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: null, reads: ['2026-12-01'] })).toBe('uncertain-stop');
    expect(verifyBooking({ targetDate: '2026-11-19', previousDate: null, reads: ['not-a-date'] })).toBe('uncertain-stop');
  });
});
