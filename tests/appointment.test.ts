import { describe, expect, it } from 'vitest';
import { appointmentDate } from '../src/domain/appointment';

const group = { scheduleId: '11111111', ivr: '22222222' };
describe('group-scoped appointment dates', () => {
  it('parses a booked date and explicit unbooked state', () => {
    expect(appointmentDate({ ...group, kind: 'booked', text: 'October 13, 2026' }, group)).toBe('2026-10-13');
    expect(appointmentDate({ ...group, kind: 'unbooked', text: null }, group)).toBeNull();
  });
  it.each([null, { ...group, kind: 'booked', text: 'Date unavailable' }, { ...group, kind: 'booked', text: null }, { ...group, scheduleId: '33333333', kind: 'unbooked', text: null }])('refuses uncertainty instead of inferring initial booking', raw => {
    expect(() => appointmentDate(raw, group)).toThrow();
  });
});
