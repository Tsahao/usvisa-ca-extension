import { describe, expect, it } from 'vitest';
import { panelFailureKind } from '../src/engine/panel-errors';
import { panelCommandError } from '../src/engine/start-errors';
import { SELECTION_FAILURE_CODES, isDiagnosticDetail } from '../src/domain/diagnostics';
import {
  continuePathFor, inspectBoundGroup, normalizeReadingIvr, resolveGroup, sameGroupRef, selectionFailureCode,
  validateDashboardSnapshot, validateGroupBinding, type GroupBinding,
} from '../src/domain/groups';

const PAID = { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' as const };
const PAID_BOOKED = { scheduleId: '55555555', ivr: '66666666', paymentStatus: 'paid' as const };
const UNPAID = { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' as const };
const UNPAID_SECOND = { scheduleId: '77777777', ivr: '88888888', paymentStatus: 'unpaid' as const };
const UNKNOWN = { scheduleId: '99999991', ivr: '99999992', paymentStatus: 'unknown' as const };
// Provisional fallback evidence: an unknown card with no readable IVR is only
// selectable through its own exact trusted Continue link.
const LINKED_FIRST = { scheduleId: '99999991', ivr: null, paymentStatus: 'unknown' as const, continuePath: continuePathFor('99999991') };
const LINKED_SECOND = { scheduleId: '99999993', ivr: null, paymentStatus: 'unknown' as const, continuePath: continuePathFor('99999993') };

describe('IVR-bound group resolution with payment evidence', () => {
  const INCOMPLETE = { scheduleId: '', ivr: null, paymentStatus: 'unknown' };
  it('uses the first booking group with optional IVRs despite an unreadable later card', () => {
    expect(resolveGroup({ groups: [PAID, INCOMPLETE] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: PAID.scheduleId, ivr: PAID.ivr, paymentStatus: 'paid', inspectionRequired: false });
    expect(resolveGroup({ groups: [PAID, { ...UNPAID, ivr: null }] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: PAID.scheduleId, ivr: PAID.ivr, paymentStatus: 'paid', inspectionRequired: false });
  });
  it('keeps an unreadable first booking card in place rather than choosing a later group', () => {
    expect(() => resolveGroup({ groups: [INCOMPLETE, PAID] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Selected dashboard group is incomplete.');
  });
  it('matches an explicit IVR despite unrelated incomplete cards, without falling back on a miss', () => {
    expect(resolveGroup({ groups: [INCOMPLETE, PAID] }, { mode: 'booking', paidIvr: PAID.ivr, unpaidIvr: '' }))
      .toEqual({ scheduleId: PAID.scheduleId, ivr: PAID.ivr, paymentStatus: 'paid', inspectionRequired: false });
    expect(() => resolveGroup({ groups: [INCOMPLETE, PAID] }, { mode: 'booking', paidIvr: '99999999', unpaidIvr: '' }))
      .toThrow('No eligible paid group on the dashboard.');
  });
  it('uses the first unpaid alert group with optional IVRs despite an unreadable later card', () => {
    expect(resolveGroup({ groups: [PAID, UNPAID, INCOMPLETE] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr, paymentStatus: 'unpaid', inspectionRequired: false });
    expect(() => resolveGroup({ groups: [PAID, INCOMPLETE] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Selected dashboard group is incomplete.');
  });
  it('treats a missing paymentStatus as unknown, never implicitly unpaid', () => {
    const snapshot = validateDashboardSnapshot({ groups: [{ scheduleId: '11111111', ivr: '22222222' }] });
    expect(snapshot.groups).toEqual([{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'unknown' }]);
    const malformed = validateDashboardSnapshot({ groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'bogus' }] });
    expect(malformed.groups[0].paymentStatus).toBe('unknown');
    // Blank unpaid IVR with only an unknown group and no trusted entry link
    // cannot bind: catch-all, not unpaid.
    expect(() => resolveGroup({ groups: [{ scheduleId: '11111111', ivr: '22222222' }] },
      { mode: 'alerts', paidIvr: '', unpaidIvr: '' })).toThrow('Selected dashboard group is incomplete.');
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
      { scheduleId: PAID.scheduleId, ivr: PAID.ivr, paymentStatus: 'paid', inspectionRequired: false });
    // An unknown classification proceeds provisionally: the caller persists
    // the pending-inspection flag and downstream validation decides.
    expect(resolveGroup({ groups: [UNKNOWN] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: UNKNOWN.scheduleId, ivr: UNKNOWN.ivr, paymentStatus: 'unknown', inspectionRequired: true });
    expect(resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'booking', paidIvr: PAID.ivr, unpaidIvr: UNPAID.ivr }))
      .toEqual({ scheduleId: PAID.scheduleId, ivr: PAID.ivr, paymentStatus: 'paid', inspectionRequired: false });
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
      { scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr, paymentStatus: 'unpaid', inspectionRequired: false });
    expect(resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr, paymentStatus: 'unpaid', inspectionRequired: false });
    expect(resolveGroup({ groups: [PAID_BOOKED, PAID, UNPAID_SECOND, UNPAID] },
      { mode: 'alerts', paidIvr: '', unpaidIvr: '' })).toEqual(
      { scheduleId: UNPAID_SECOND.scheduleId, ivr: UNPAID_SECOND.ivr, paymentStatus: 'unpaid', inspectionRequired: false });
    // Configured paid-IVR exclusion is also skipped.
    expect(resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'alerts', paidIvr: PAID.ivr, unpaidIvr: '' })).toEqual(
      { scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr, paymentStatus: 'unpaid', inspectionRequired: false });
    expect(() => resolveGroup({ groups: [UNKNOWN, UNPAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Selected dashboard group is incomplete.');
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
        .toThrow('Selected dashboard group is incomplete.');
    }
    expect(panelFailureKind(new Error('No eligible unpaid group on the dashboard.'))).toBe('generic');
  });

  it('binds the exact positively unpaid IVR and never falls back', () => {
    expect(
      resolveGroup({ groups: [PAID, UNPAID] }, { mode: 'alerts', paidIvr: PAID.ivr, unpaidIvr: UNPAID.ivr }),
    ).toEqual({ scheduleId: UNPAID.scheduleId, ivr: UNPAID.ivr, paymentStatus: 'unpaid', inspectionRequired: false });
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

  it('proceeds provisionally for an explicitly selected unknown group', () => {
    // A matching explicit IVR proves the identity; the unknown payment
    // classification is inspected downstream instead of a catch-all refusal.
    expect(
      resolveGroup({ groups: [UNKNOWN] }, { mode: 'alerts', paidIvr: '', unpaidIvr: UNKNOWN.ivr }),
    ).toEqual({ scheduleId: UNKNOWN.scheduleId, ivr: UNKNOWN.ivr, paymentStatus: 'unknown', inspectionRequired: true });
    expect(
      resolveGroup({ groups: [PAID, UNKNOWN] }, { mode: 'alerts', paidIvr: PAID.ivr, unpaidIvr: UNKNOWN.ivr }),
    ).toEqual({ scheduleId: UNKNOWN.scheduleId, ivr: UNKNOWN.ivr, paymentStatus: 'unknown', inspectionRequired: true });
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

describe('blank-preference fallback through the card’s own trusted Continue link', () => {
  it('selects the first eligible unknown card in dashboard order without fabricating an IVR', () => {
    expect(resolveGroup({ groups: [PAID, LINKED_FIRST] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: LINKED_FIRST.scheduleId, ivr: null, paymentStatus: 'unknown', inspectionRequired: true });
    // Two linked candidates: the first in page order decides alone.
    expect(resolveGroup({ groups: [LINKED_FIRST, LINKED_SECOND] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: LINKED_FIRST.scheduleId, ivr: null, paymentStatus: 'unknown', inspectionRequired: true });
    // Missing evidence must not silently change the target to a sibling.
    expect(() => resolveGroup({ groups: [UNKNOWN, LINKED_SECOND] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Selected dashboard group is incomplete.');
    // The configured paid-IVR exclusion applies to the fallback too.
    expect(resolveGroup({ groups: [{ ...LINKED_FIRST, ivr: PAID.ivr }, LINKED_SECOND] },
      { mode: 'alerts', paidIvr: PAID.ivr, unpaidIvr: '' }))
      .toEqual({ scheduleId: LINKED_SECOND.scheduleId, ivr: null, paymentStatus: 'unknown', inspectionRequired: true });
    // A later unpaid card does not outrank an earlier inspectable candidate.
    expect(resolveGroup({ groups: [LINKED_FIRST, UNPAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: LINKED_FIRST.scheduleId, ivr: null, paymentStatus: 'unknown', inspectionRequired: true });
    expect(() => resolveGroup({ groups: [{ scheduleId: '', ivr: null }, UNPAID] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Selected dashboard group is incomplete.');
  });

  it('never treats contradictory cards as selectable and reports the conflict specifically', () => {
    const conflicted = { ...LINKED_FIRST, paymentConflict: true };
    expect(() => resolveGroup({ groups: [conflicted, LINKED_SECOND] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Conflicting dashboard payment markers.');
    // With no other eligible card the refusal is the fixed conflict message,
    // never the generic catch-all and never a silent selection.
    expect(() => resolveGroup({ groups: [conflicted] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Conflicting dashboard payment markers.');
    expect(() => resolveGroup({ groups: [PAID, conflicted] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Conflicting dashboard payment markers.');
    // Paid entry: a contradictory first card / explicit match stays blocking.
    expect(() => resolveGroup({ groups: [conflicted] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Conflicting dashboard payment markers.');
    expect(() => resolveGroup({ groups: [{ ...PAID, paymentStatus: 'unknown', paymentConflict: true }] },
      { mode: 'booking', paidIvr: PAID.ivr, unpaidIvr: '' }))
      .toThrow('Conflicting dashboard payment markers.');
    // Explicit unpaid selection on a contradictory card is never authorized.
    expect(() => resolveGroup({ groups: [{ ...UNPAID, paymentConflict: true }] },
      { mode: 'alerts', paidIvr: '', unpaidIvr: UNPAID.ivr }))
      .toThrow('Conflicting dashboard payment markers.');
  });

  it('fails closed on foreign, query-bearing or mismatched Continue evidence', () => {
    const base = { scheduleId: '99999991', ivr: '99999992', paymentStatus: 'unknown' as const };
    for (const continuePath of [
      '/en-ca/niv/schedule/99999999/continue_actions',
      `${continuePathFor('99999991')}?next=1`,
      `${continuePathFor('99999991')}#x`,
      `https://ais.usvisa-info.com${continuePathFor('99999991')}`,
      'continue_actions',
    ])
      expect(() => resolveGroup({ groups: [{ ...base, continuePath }] }, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
        .toThrow('Invalid dashboard group.');
    // An explicit null (no link observed) stays valid evidence of absence.
    expect(resolveGroup({ groups: [{ ...base, continuePath: null }] }, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: base.scheduleId, ivr: base.ivr, paymentStatus: 'unknown', inspectionRequired: true });
  });

  it('deduplicates unreadable IVRs but still rejects repeated readable identities and schedules', () => {
    expect(validateDashboardSnapshot({ groups: [LINKED_FIRST, LINKED_SECOND] }).groups).toHaveLength(2);
    expect(() => validateDashboardSnapshot({ groups: [{ ...LINKED_FIRST, ivr: '99999992' }, { ...LINKED_SECOND, ivr: '99999992' }] }))
      .toThrow('Ambiguous dashboard groups.');
    expect(() => validateDashboardSnapshot({ groups: [{ ...LINKED_FIRST, ivr: null }, { ...LINKED_SECOND, scheduleId: LINKED_FIRST.scheduleId }] }))
      .toThrow('Ambiguous dashboard groups.');
  });
});

describe('shared group identity and reading normalization', () => {
  it('treats the schedule as primary and a null IVR on either side as unknown, not a mismatch', () => {
    expect(sameGroupRef({ scheduleId: '1', ivr: '2' }, { scheduleId: '1', ivr: '2' })).toBe(true);
    expect(sameGroupRef({ scheduleId: '1', ivr: null }, { scheduleId: '1', ivr: '2' })).toBe(true);
    expect(sameGroupRef({ scheduleId: '1', ivr: '2' }, { scheduleId: '1', ivr: null })).toBe(true);
    expect(sameGroupRef({ scheduleId: '1', ivr: null }, { scheduleId: '1', ivr: null })).toBe(true);
    // Two readable IVRs must agree.
    expect(sameGroupRef({ scheduleId: '1', ivr: '2' }, { scheduleId: '1', ivr: '3' })).toBe(false);
    expect(sameGroupRef({ scheduleId: '1', ivr: '2' }, { scheduleId: '9', ivr: '2' })).toBe(false);
  });
  it('normalizes echoed readings without fabricating an IVR and fails closed on malformed values', () => {
    expect(normalizeReadingIvr(undefined)).toBeNull();
    expect(normalizeReadingIvr(null)).toBeNull();
    expect(normalizeReadingIvr('12345678')).toBe('12345678');
    expect(normalizeReadingIvr(12345678)).toBeUndefined();
    expect(normalizeReadingIvr('1234')).toBe('1234');
    expect(normalizeReadingIvr('')).toBeUndefined();
    expect(normalizeReadingIvr('12ab')).toBeUndefined();
    expect(normalizeReadingIvr('1'.repeat(33))).toBeUndefined();
  });
});

describe('post-selection inspection for provisional bindings', () => {
  const binding = (over: Partial<GroupBinding> = {}): GroupBinding =>
    ({ scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, ...over });
  it('resolves a compatible classification and keeps an unknown one provisional', () => {
    expect(inspectBoundGroup({ groups: [PAID] }, binding())).toEqual({ verdict: 'resolved' });
    expect(inspectBoundGroup({ groups: [{ ...PAID, paymentStatus: 'unknown' }] }, binding())).toEqual({ verdict: 'unknown' });
    // Alerts bindings are compatible with positively unpaid evidence.
    expect(inspectBoundGroup({ groups: [UNPAID] }, binding({ kind: 'unpaid', scheduleId: '33333333', ivr: '44444444' })))
      .toEqual({ verdict: 'resolved' });
  });
  it('blocks a positively incompatible classification with its precise code', () => {
    expect(inspectBoundGroup({ groups: [{ ...UNPAID, scheduleId: '11111111', ivr: '22222222' }] }, binding()))
      .toEqual({ verdict: 'blocked', code: 'payment-ineligible' });
    expect(inspectBoundGroup({ groups: [PAID] }, binding({ kind: 'unpaid' }))).toEqual({ verdict: 'blocked', code: 'payment-ineligible' });
  });
  it('blocks contradictory markers before the classification is even considered', () => {
    expect(inspectBoundGroup({ groups: [{ ...PAID, paymentStatus: 'unpaid', paymentConflict: true }] }, binding()))
      .toEqual({ verdict: 'blocked', code: 'payment-markers-conflict' });
  });
  it('matches the bound card by schedule even when either IVR is unreadable, and returns null when absent', () => {
    expect(inspectBoundGroup({ groups: [{ ...PAID, ivr: null }] }, binding())).toEqual({ verdict: 'resolved' });
    expect(inspectBoundGroup({ groups: [PAID] }, binding({ ivr: null }))).toEqual({ verdict: 'resolved' });
    // A readable disagreement is not the bound card.
    expect(inspectBoundGroup({ groups: [{ ...PAID, ivr: '99999999' }] }, binding())).toBeNull();
    expect(inspectBoundGroup({ groups: [UNPAID] }, binding())).toBeNull();
  });
});

describe('selection failure codes and binding migration', () => {
  it('maps only the exact fixed selection refusals and keeps every code allowlisted', () => {
    const expected: Record<string, string> = {
      'No dashboard group to bind.': 'no-dashboard-group',
      'Paid group not found on the dashboard.': 'paid-group-not-found',
      'No eligible paid group on the dashboard.': 'paid-group-unavailable',
      'Unpaid group rejected for paid booking.': 'unpaid-group-rejected',
      'Unpaid group not found on the dashboard.': 'unpaid-group-not-found',
      'No eligible unpaid group on the dashboard.': 'unpaid-group-unavailable',
      'Paid group rejected for unpaid tracking.': 'paid-group-rejected',
      'Conflicting dashboard payment markers.': 'payment-markers-conflict',
      'Invalid group binding.': 'group-binding-invalid',
      'Invalid dashboard path.': 'group-binding-invalid',
      'Selected dashboard group is incomplete.': 'selection-incomplete',
      'Invalid dashboard snapshot.': 'dashboard-snapshot-invalid',
      'Invalid dashboard group.': 'dashboard-group-invalid',
      'Ambiguous dashboard groups.': 'dashboard-groups-ambiguous',
      'Ambiguous dashboard group.': 'dashboard-groups-ambiguous',
    };
    for (const [message, code] of Object.entries(expected)) {
      expect(selectionFailureCode(message)).toBe(code);
      expect(SELECTION_FAILURE_CODES).toContain(code);
      expect(isDiagnosticDetail(code)).toBe(true);
    }
    for (const message of ['Selected group is not eligible for this workflow.', 'synthetic-secret', ''])
      expect(selectionFailureCode(message)).toBeNull();
  });
  it('migrates legacy bindings without pendingInspection and persists only a strict true', () => {
    const legacy = { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01' };
    expect(validateGroupBinding(legacy)).toEqual(legacy);
    expect(validateGroupBinding({ ...legacy, pendingInspection: true }))
      .toEqual({ ...legacy, pendingInspection: true });
    expect(validateGroupBinding({ ...legacy, pendingInspection: false })).toEqual(legacy);
    expect(validateGroupBinding({ ...legacy, ivr: null })).toEqual({ ...legacy, ivr: null });
    expect(validateGroupBinding({ ...legacy, pendingInspection: null })).toEqual(legacy);
    for (const pendingInspection of ['true', 1])
      expect(() => validateGroupBinding({ ...legacy, pendingInspection })).toThrow('Invalid group binding.');
  });
});
