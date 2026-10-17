import { describe, expect, it } from 'vitest';
import { panelFailureKind } from '../src/engine/panel-errors';
import { panelCommandError } from '../src/engine/start-errors';
import { resolveGroup, validateDashboardSnapshot } from '../src/domain/groups';

const PAID = { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' as const };
const PAID_BOOKED = { scheduleId: '55555555', ivr: '66666666', paymentStatus: 'paid' as const };
const UNPAID = { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' as const };
const UNPAID_SECOND = { scheduleId: '77777777', ivr: '88888888', paymentStatus: 'unpaid' as const };
const UNKNOWN = { scheduleId: '99999991', ivr: '99999992', paymentStatus: 'unknown' as const };

describe('IVR-bound group resolution with payment evidence', () => {
  const INCOMPLETE = { scheduleId: '', ivr: null, paymentStatus: 'unknown' };
  it('uses the first booking group with optional IVRs despite an unreadable later card', () => {
    expect(resolveGroup({ groups: [PAID, INCOMPLETE] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: PAID.scheduleId, ivr: PAID.ivr });
    expect(resolveGroup({ groups: [PAID, { ...UNPAID, ivr: null }] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: PAID.scheduleId, ivr: PAID.ivr });
  });
  it('keeps an unreadable first booking card in place rather than choosing a later group', () => {
    expect(() => resolveGroup({ groups: [INCOMPLETE, PAID] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Selected dashboard group is incomplete.');
  });
  it('matches an explicit IVR despite unrelated incomplete cards, without falling back on a miss', () => {
    expect(resolveGroup({ groups: [INCOMPLETE, PAID] }, { mode: 'booking', paidIvr: PAID.ivr, unpaidIvr: '' }))
      .toEqual({ scheduleId: PAID.scheduleId, ivr: PAID.ivr });
    expect(() => resolveGroup({ groups: [INCOMPLETE, PAID] }, { mode: 'booking', paidIvr: '99999999', unpaidIvr: '' }))
      .toThrow('No eligible paid group on the dashboard.');
  });
  it('uses the first unpaid alert group with optional IVRs despite an unreadable later card', () => {
    expect(resolveGroup({ groups: [PAID, UNPAID, INCOMPLETE] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr });
    expect(() => resolveGroup({ groups: [PAID, INCOMPLETE] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('No eligible unpaid group on the dashboard.');
  });
  it('treats a missing paymentStatus as unknown, never implicitly unpaid', () => {
    const snapshot = validateDashboardSnapshot({ groups: [{ scheduleId: '11111111', ivr: '22222222' }] });
    expect(snapshot.groups).toEqual([{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'unknown' }]);
    const malformed = validateDashboardSnapshot({ groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'bogus' }] });
    expect(malformed.groups[0].paymentStatus).toBe('unknown');
    // Blank unpaid IVR with only an unknown group cannot bind: catch-all, not unpaid.
    expect(() => resolveGroup({ groups: [{ scheduleId: '11111111', ivr: '22222222' }] },
      { mode: 'alerts', paidIvr: '', unpaidIvr: '' })).toThrow('No eligible unpaid group on the dashboard.');
  });

  it('rejects a positively unpaid group for paid entry, including the first-group fallback', () => {
    expect(() => resolveGroup({ groups: [UNPAID] }, { mode: 'booking', paidIvr: '', unpaidIvr: UNPAID.ivr }))
      .toThrow('Unpaid group rejected for paid booking.');
    expect(() => resolveGroup({ groups: [UNPAID] }, { mode: 'booking', paidIvr: UNPAID.ivr, unpaidIvr: UNPAID.ivr }))
      .toThrow('Unpaid group rejected for paid booking.');
    expect(() => resolveGroup({ groups: [UNPAID, PAID] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Unpaid group rejected for paid booking.');
    expect(panelFailureKind(new Error('Unpaid group rejected for paid booking.'))).toBe('paid-ivr-not-found');
    expect(panelFailureKind(panelCommandError(new Error('Unpaid group rejected for paid booking.'), 'selection')))
      .toBe('paid-ivr-not-found');
  });

  it('preserves paid entry semantics for paid or unknown groups', () => {
    expect(resolveGroup({ groups: [PAID] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: PAID.scheduleId, ivr: PAID.ivr });
    expect(resolveGroup({ groups: [UNKNOWN] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: UNKNOWN.scheduleId, ivr: UNKNOWN.ivr });
    expect(resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'booking', paidIvr: PAID.ivr, unpaidIvr: UNPAID.ivr }))
      .toEqual({ scheduleId: PAID.scheduleId, ivr: PAID.ivr });
  });

  it('fails closed with a specific kind when the configured paid IVR is absent from a fully readable dashboard', () => {
    expect(() =>
      resolveGroup({ groups: [PAID] }, { mode: 'booking', paidIvr: '99999999', unpaidIvr: '' }),
    ).toThrow('Paid group not found on the dashboard.');
    // An unknown-status dashboard cannot prove absence: catch-all instead.
    expect(() =>
      resolveGroup({ groups: [UNKNOWN] }, { mode: 'booking', paidIvr: '99999999', unpaidIvr: '' }),
    ).toThrow('No eligible paid group on the dashboard.');
    expect(panelFailureKind(new Error('No eligible paid group on the dashboard.'))).toBe('generic');
  });

  it('skips paid groups for blank unpaid IVR and chooses the first positively unpaid group', () => {
    expect(resolveGroup({ groups: [UNPAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr });
    expect(resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr });
    expect(resolveGroup({ groups: [PAID_BOOKED, PAID, UNPAID_SECOND, UNPAID] },
      { mode: 'alerts', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: UNPAID_SECOND.scheduleId, ivr: UNPAID_SECOND.ivr });
    // Configured paid-IVR exclusion is also skipped.
    expect(resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'alerts', paidIvr: PAID.ivr, unpaidIvr: '' })).toEqual(
      { scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr });
    expect(resolveGroup({ groups: [UNKNOWN, UNPAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr });
  });

  it('reports a known unpaid-group failure when every readable group is paid', () => {
    expect(() => resolveGroup({ groups: [PAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Unpaid group not found on the dashboard.');
    expect(() => resolveGroup({ groups: [PAID, PAID_BOOKED] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Unpaid group not found on the dashboard.');
    expect(panelFailureKind(new Error('Unpaid group not found on the dashboard.'))).toBe('unpaid-ivr-not-found');
  });

  it('uses the catch-all when no valid unpaid choice exists but classification is unknown', () => {
    const unknownSecond = { scheduleId: '99999993', ivr: '99999994', paymentStatus: 'unknown' as const };
    for (const snapshot of [
      { groups: [UNKNOWN] },
      { groups: [PAID, UNKNOWN] },
      { groups: [UNKNOWN, unknownSecond] },
    ]) {
      expect(() => resolveGroup(snapshot, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
        .toThrow('No eligible unpaid group on the dashboard.');
    }
    expect(panelFailureKind(new Error('No eligible unpaid group on the dashboard.'))).toBe('generic');
  });

  it('binds the exact positively unpaid IVR and never falls back', () => {
    expect(
      resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'alerts', paidIvr: PAID.ivr, unpaidIvr: UNPAID.ivr }),
    ).toEqual({ scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr });
    // Unknown unpaid IVR must not silently resolve to the paid group.
    expect(() =>
      resolveGroup({ groups: [PAID] }, { mode: 'alerts', paidIvr: PAID.ivr, unpaidIvr: '99999999' }),
    ).toThrow('Unpaid group not found on the dashboard.');
    // Unknown-status dashboard cannot prove absence: catch-all.
    expect(() =>
      resolveGroup({ groups: [UNKNOWN] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '99999999' }),
    ).toThrow('No eligible unpaid group on the dashboard.');
  });

  it('rejects an explicitly selected paid group for alerts with the known kind', () => {
    expect(() =>
      resolveGroup({ groups: [PAID] }, { mode: 'alerts', paidIvr: PAID.ivr, unpaidIvr: PAID.ivr }),
    ).toThrow('Paid group rejected for unpaid tracking.');
    expect(() =>
      resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: PAID.ivr }),
    ).toThrow('Paid group rejected for unpaid tracking.');
    expect(panelFailureKind(new Error('Paid group rejected for unpaid tracking.'))).toBe('unpaid-ivr-not-found');
  });

  it('uses the catch-all for an explicitly selected unknown group', () => {
    expect(() =>
      resolveGroup({ groups: [UNKNOWN] }, { mode: 'alerts', paidIvr: '', unpaidIvr: UNKNOWN.ivr }),
    ).toThrow('No eligible unpaid group on the dashboard.');
  });

  it('rejects ambiguous and malformed snapshots without naming groups', () => {
    expect(() => validateDashboardSnapshot({ groups: [PAID, { ...PAID, ivr: '55555555' }] })).toThrow(
      'Ambiguous dashboard groups.',
    );
    expect(() => validateDashboardSnapshot({ groups: [PAID, { ...UNPAID, scheduleId: PAID.scheduleId }] })).toThrow(
      'Ambiguous dashboard groups.',
    );
    expect(() => resolveGroup({ groups: [] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' })).toThrow(
      'No dashboard group to bind.',
    );
    for (const bad of [null, {}, { groups: [{ scheduleId: 'abc', ivr: '123' }] }, { groups: 'x' }])
      expect(() => validateDashboardSnapshot(bad)).toThrow();
  });
});
