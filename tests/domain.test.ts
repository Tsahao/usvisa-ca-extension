import { describe, expect, it } from 'vitest';
import { classifyRoute, isBareAppointmentQuery } from '../src/domain/routes';
import { CONSULATES, CONSULATE_ORDER, canBook, earliestCandidate, earliestCandidateAcross, selectedConsulates, isIsoDate, parseLongDateUs, type DatePreferences } from '../src/domain/dates';
import { emptyAlertState, notificationAccepted, observeDate } from '../src/domain/alerts';
import { CITIES, DEFAULT_ADVANCED, EMPTY_PREFERENCES } from '../src/ui/model';

const prefs: DatePreferences = {
  earliest: '2026-11-01', latest: '2026-12-31',
  exclusions: [{ start: '2026-11-10', end: '2026-11-15' }], onlyEarlier: true,
};
describe('auto mode default', () => {
  it('ships ON for fresh preferences and is not an advanced setting', () => {
    expect(DEFAULT_ADVANCED).not.toHaveProperty('autoMode');
    expect(EMPTY_PREFERENCES.autoMode).toBe(true);
  });
});
describe('consulate tables', () => {
  it('keeps the order, facility map and UI city list in parity', () => {
    expect([...CONSULATE_ORDER].sort()).toEqual(Object.keys(CONSULATES).sort());
    expect(CITIES).toEqual([...CONSULATE_ORDER]);
  });
});
describe('bare appointment query', () => {
  const at = (query: string) => new URL(`https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment${query}`);
  it.each([
    ['', true],
    ['?confirmed_limit_message=1&commit=Continue', true],
    ['?commit=Continue', false],
    ['?confirmed_limit_message=0&commit=Continue', false],
    ['?confirmed_limit_message=1&confirmed_limit_message=1&commit=Continue', false],
    ['?confirmed_limit_message=1&commit=Continue&commit=Continue', false],
    ['?confirmed_limit_message=1&other=1', false],
    ['?applicants[]=1', false],
  ])('classifies %j as %s', (query, expected) => {
    expect(isBareAppointmentQuery(at(query))).toBe(expected);
  });
});
describe('dashboard prose dates', () => {
  it('parses long US dates and ignores non-dates', () => {
    expect(parseLongDateUs('Tuesday, October 13, 2026 8:15 AM')).toBe('2026-10-13');
    expect(parseLongDateUs('January 1, 2027')).toBe('2027-01-01');
    expect(parseLongDateUs('19 November, 2026')).toBe('2026-11-19');
    expect(parseLongDateUs('No appointment scheduled')).toBeNull();
    expect(parseLongDateUs('February 30, 2026')).toBeNull();
  });
});
describe('trusted routes', () => {
  it.each([
    ['https://ais.usvisa-info.com/en-ca/niv/users/sign_in', 'login'],
    ['https://ais.usvisa-info.com/en-ca/niv', 'landing'],
    ['https://ais.usvisa-info.com/en-ca/niv/', 'landing'],
    ['https://ais.usvisa-info.com/en-ca/niv/groups', 'dashboard'],
    ['https://ais.usvisa-info.com/en-ca/niv/groups/12345', 'dashboard'],
    ['https://ais.usvisa-info.com/en-ca/niv/groups/abc', 'unsupported'],
    ['https://ais.usvisa-info.com/en-ca/niv/schedule/12345/continue_actions', 'actions'],
    ['https://ais.usvisa-info.com/en-ca/niv/schedule/12345/payment', 'payment'],
    ['https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment', 'appointment'],
    ['https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment/extra', 'unsupported'],
    ['https://ais.usvisa-info.com.evil.invalid/en-ca/niv/groups', 'untrusted'],
    ['http://ais.usvisa-info.com/en-ca/niv/groups', 'untrusted'],
    ['https://ais.usvisa-info.com:8443/en-ca/niv/groups', 'untrusted'],
    ['https://user:secret@ais.usvisa-info.com/en-ca/niv/groups', 'untrusted'],
    ['chrome://newtab/', 'untrusted'],
    ['', 'untrusted'],
  ])('classifies %s without exposing identity', (url, result) => expect(classifyRoute(url)).toBe(result));
});
describe('booking policy', () => {
  it.each(['2026-02-29', '2026-2-01', '2026-13-01', 'not a date'])('rejects malformed date %s', value => {
    expect(isIsoDate(value)).toBe(false);
  });
  it('accepts leap dates and compares date-only values without local timezone shifts', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(canBook('2026-11-01', '2027-01-01', prefs)).toBe(true);
    expect(canBook('2026-12-31', null, prefs)).toBe(true);
  });
  it('blocks both exclusion boundaries and dates outside the window', () => {
    for (const value of ['2026-11-10', '2026-11-15', '2026-10-31', '2027-01-01'])
      expect(canBook(value, null, prefs)).toBe(false);
  });
  it('requires strictly earlier dates unless explicitly disabled', () => {
    expect(canBook('2026-12-01', '2026-12-01', prefs)).toBe(false);
    expect(canBook('2026-12-02', '2026-12-01', prefs)).toBe(false);
    expect(canBook('2026-12-02', '2026-12-01', { ...prefs, onlyEarlier: false })).toBe(true);
    expect(canBook('2026-12-02', 'invalid', prefs)).toBe(false);
  });
  it('never books the current date, even with earlier-only off', () => {
    expect(canBook('2026-12-01', '2026-12-01', { ...prefs, onlyEarlier: false })).toBe(false);
    expect(canBook('2026-12-01', '2026-12-01', prefs)).toBe(false);
    expect(earliestCandidate(['2026-12-01', '2026-12-02'], '2026-12-01', { ...prefs, onlyEarlier: false })).toBe('2026-12-02');
    expect(earliestCandidateAcross([{ consulate: 'Toronto', dates: ['2026-12-01'] }, { consulate: 'Vancouver', dates: ['2026-12-03'] }],
      '2026-12-01', { ...prefs, onlyEarlier: false })).toEqual({ consulate: 'Vancouver', date: '2026-12-03' });
  });
  it('finds the earliest eligible candidate across the full list', () => {
    expect(earliestCandidate(['2026-12-30', '2026-10-01', '2026-11-11', '2026-11-16'], null, prefs)).toBe('2026-11-16');
  });
  it('rejects invalid windows instead of silently allowing booking', () => {
    expect(() => canBook('2026-12-01', null, { ...prefs, latest: '2026-10-01' })).toThrow();
  });
});
describe('selected-consulate alert transitions', () => {
  it('alerts initially, suppresses unchanged delivered dates, and reports later changes', () => {
    let state = observeDate(emptyAlertState(), '2026-11-20', prefs, true);
    expect(state.pending).toBe(true);
    state = notificationAccepted(state, '2026-11-20');
    expect(observeDate(state, '2026-11-20', prefs, true).pending).toBe(false);
    expect(observeDate(state, '2026-11-21', prefs, true).pending).toBe(true);
  });
  it('alerts again after unavailability, including after state serialization', () => {
    let state = notificationAccepted(observeDate(emptyAlertState(), '2026-11-20', prefs, true), '2026-11-20');
    state = observeDate(state, null, prefs, true);
    expect(state.pending).toBe(false);
    state = JSON.parse(JSON.stringify(state));
    expect(observeDate(state, '2026-11-20', prefs, true).pending).toBe(true);
  });
  it('records filtered changes and alerts when the previous date returns', () => {
    let state = notificationAccepted(observeDate(emptyAlertState(), '2026-11-20', prefs, true), '2026-11-20');
    state = observeDate(state, '2026-11-12', prefs, true);
    expect(state.observed).toBe('2026-11-12');
    expect(state.pending).toBe(false);
    expect(observeDate(state, '2026-11-20', prefs, true).pending).toBe(true);
  });
  it('reports out-of-window dates when range filtering is disabled', () => {
    expect(observeDate(emptyAlertState(), '2028-01-01', prefs, false).pending).toBe(true);
  });
  it('retains pending alerts on unchanged observations and ignores obsolete delivery acknowledgments', () => {
    const state = observeDate(emptyAlertState(), '2026-11-20', prefs, true);
    expect(observeDate(state, '2026-11-20', prefs, true)).toEqual(state);
    expect(notificationAccepted(state, '2026-11-19')).toEqual(state);
  });
  it('does not mutate a healthy observation when new data is malformed', () => {
    const state = observeDate(emptyAlertState(), '2026-11-20', prefs, true);
    expect(() => observeDate(state, 'tomorrow', prefs, true)).toThrow();
    expect(state.observed).toBe('2026-11-20');
  });
});

describe('consulate selections', () => {
  it('orders, dedupes and migrates selections', () => {
    expect(selectedConsulates({ consulates: ['Toronto', 'Halifax', 'Toronto'] })).toEqual(['Halifax', 'Toronto']);
    expect(selectedConsulates({ consulate: 'Toronto' })).toEqual(['Toronto']);
    expect(selectedConsulates({ consulate: '' })).toEqual([]);
    expect(selectedConsulates({ consulates: [] })).toEqual([]);
    expect(selectedConsulates({ consulates: ['Paris'] })).toBeNull();
    expect(selectedConsulates({})).toBeNull();
    expect(selectedConsulates(undefined)).toBeNull();
  });
  it('picks the earliest eligible date across consulates, ties by order', () => {
    const prefs = { earliest: '2026-11-01', latest: '2026-12-31', exclusions: [], onlyEarlier: true };
    expect(earliestCandidateAcross([
      { consulate: 'Toronto', dates: ['2026-12-03', '2027-01-04'] },
      { consulate: 'Halifax', dates: ['2026-11-20'] },
    ], '2028-04-18', prefs)).toEqual({ date: '2026-11-20', consulate: 'Halifax' });
    expect(earliestCandidateAcross([
      { consulate: 'Toronto', dates: ['2026-11-20'] },
      { consulate: 'Halifax', dates: ['2026-11-20'] },
    ], '2028-04-18', prefs)).toEqual({ date: '2026-11-20', consulate: 'Toronto' });
    expect(earliestCandidateAcross([{ consulate: 'Toronto', dates: ['2027-01-04'] }], '2028-04-18', prefs)).toBeNull();
    expect(earliestCandidateAcross([], '2028-04-18', prefs)).toBeNull();
  });
});
