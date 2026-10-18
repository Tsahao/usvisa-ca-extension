import { isIsoDate } from './dates';
import { validateApplicantIds } from './applicants';

export type GroupKind = 'paid' | 'unpaid';
export type EngineMode = 'booking' | 'alerts';

export type PaymentStatus = 'paid' | 'unpaid' | 'unknown';

export type GroupRef = {
  scheduleId: string;
  ivr: string;
};

export type DashboardGroupReading = GroupRef & {
  paymentStatus?: PaymentStatus;
};

export type GroupBinding = GroupRef & {
  kind: GroupKind;
  currentDate: string | null;
  applicantIds?: string[];
  dashboardPath?: string;
};

export type DashboardSnapshot = {
  groups: (GroupRef & { paymentStatus?: PaymentStatus })[];
};

function isDigitId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && value.length >= 1 && value.length <= maxLength;
}

export function validateGroupRef(value: unknown): GroupRef {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid dashboard group.');
  const group = value as Record<string, unknown>;
  if (!isDigitId(group.scheduleId, 32) || !isDigitId(group.ivr, 32)) throw new Error('Invalid dashboard group.');
  return { scheduleId: group.scheduleId as string, ivr: group.ivr as string };
}

export function validateDashboardSnapshot(value: unknown): DashboardSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid dashboard snapshot.');
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.groups)) throw new Error('Invalid dashboard snapshot.');
  const groups = snapshot.groups.map(item => {
    const ref = validateGroupRef(item);
    const status = (item as Record<string, unknown>).paymentStatus;
    // Old synthetic/developer snapshots predate payment evidence: missing or
    // malformed status is unknown, never implicitly unpaid.
    const paymentStatus: PaymentStatus =
      status === 'paid' || status === 'unpaid' || status === 'unknown' ? status : 'unknown';
    return { ...ref, paymentStatus };
  });
  const scheduleIds = new Set(groups.map(group => group.scheduleId));
  const ivrs = new Set(groups.map(group => group.ivr));
  if (scheduleIds.size !== groups.length || ivrs.size !== groups.length)
    throw new Error('Ambiguous dashboard groups.');
  return { groups };
}

export function validateGroupBinding(value: unknown): GroupBinding {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid group binding.');
  const binding = value as Record<string, unknown>;
  const ref = validateGroupRef(binding);
  if (binding.kind !== 'paid' && binding.kind !== 'unpaid') throw new Error('Invalid group binding.');
  // Older bindings predate the current-appointment date; initial-booking
  // semantics (null) is the safe migration, never a guessed date.
  const currentDate = binding.currentDate === undefined || binding.currentDate === null ? null : binding.currentDate;
  if (typeof currentDate !== 'string' && currentDate !== null) throw new Error('Invalid group binding.');
  if (currentDate !== null && !isIsoDate(currentDate)) throw new Error('Invalid group binding.');
  if (binding.dashboardPath !== undefined && (typeof binding.dashboardPath !== 'string' || !/^\/en-ca\/niv\/groups(?:\/[0-9]{1,32})?$/.test(binding.dashboardPath)))
    throw new Error('Invalid dashboard path.');
  return { ...ref, kind: binding.kind as GroupKind, currentDate,
    ...(binding.dashboardPath === undefined ? {} : { dashboardPath: binding.dashboardPath }),
    ...(binding.applicantIds === undefined ? {} : { applicantIds: validateApplicantIds(binding.applicantIds) }) };
}

// Binds a run to exactly one dashboard group. Fixed diagnostics only: group
// identifiers never appear in error text.
// - Paid exact IVR when configured; product discovery prefers the first paid
//   group in page order. Legacy/developer callers retain their first-card
//   fallback. A positively identified unpaid group is always rejected
//   before any booking workflow; unknown status otherwise preserves existing
//   paid entry/baseline/roster semantics. Absence of a booking proves nothing.
// - Unpaid blank skips paid groups (including the configured paid-IVR
//   exclusion) and chooses the first positively identified unpaid group in
//   dashboard order. An explicit unpaid IVR must match that exact positively
//   unpaid group and never falls back. All-readable-paid and explicit-paid
//   selections are known unpaid-group failures; unknown classification is a
//   catch-all. Missing explicit IVR on a fully readable dashboard stays
//   specific; otherwise it fails closed as generic.
export function resolveGroup(
  snapshot: unknown,
  args: { mode: EngineMode; paidIvr: string; unpaidIvr: string; preferPaid?: boolean },
): GroupRef {
  // Selection needs the chosen card's identity, not complete identities for
  // every sibling. Preserve incomplete placeholders and their page positions;
  // filtering them could silently change what "first group" means.
  if (!snapshot || typeof snapshot !== 'object' || !('groups' in snapshot) || !Array.isArray(snapshot.groups))
    throw new Error('Invalid dashboard snapshot.');
  const groups = snapshot.groups.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid dashboard group.');
    const group = item as Record<string, unknown>;
    if (group.scheduleId !== '' && !isDigitId(group.scheduleId, 32)) throw new Error('Invalid dashboard group.');
    if (group.ivr !== null && !isDigitId(group.ivr, 32)) throw new Error('Invalid dashboard group.');
    const paymentStatus: PaymentStatus = group.paymentStatus === 'paid' || group.paymentStatus === 'unpaid' ? group.paymentStatus : 'unknown';
    return { scheduleId: group.scheduleId as string, ivr: group.ivr as string | null, paymentStatus };
  });
  const scheduleIds = groups.map(group => group.scheduleId).filter(id => id !== '');
  const ivrs = groups.map(group => group.ivr).filter(id => id !== null);
  if (new Set(scheduleIds).size !== scheduleIds.length || new Set(ivrs).size !== ivrs.length)
    throw new Error('Ambiguous dashboard groups.');
  const selectedRef = (group: typeof groups[number]): GroupRef => {
    if (!group.scheduleId || group.ivr === null) throw new Error('Selected dashboard group is incomplete.');
    return validateGroupRef(group);
  };
  if (args.paidIvr !== '' && !isDigitId(args.paidIvr, 32)) throw new Error('Invalid paid IVR.');
  if (args.unpaidIvr !== '' && !isDigitId(args.unpaidIvr, 32)) throw new Error('Invalid unpaid IVR.');
  if (args.mode !== 'booking' && args.mode !== 'alerts') throw new Error('Invalid resolve mode.');
  if (groups.length === 0) throw new Error('No dashboard group to bind.');
  const fullyReadable = groups.every(group => group.scheduleId !== '' && group.ivr !== null && group.paymentStatus !== 'unknown');
  if (args.mode === 'booking') {
    if (args.paidIvr !== '') {
      const match = groups.find(group => group.ivr === args.paidIvr);
      if (!match) {
        if (fullyReadable) throw new Error('Paid group not found on the dashboard.');
        throw new Error('No eligible paid group on the dashboard.');
      }
      if (args.unpaidIvr !== '' && match.ivr === args.unpaidIvr) throw new Error('Unpaid group rejected for paid booking.');
      if (match.paymentStatus === 'unpaid') throw new Error('Unpaid group rejected for paid booking.');
      return selectedRef(match);
    }
    const first = args.preferPaid ? groups.find(group => group.paymentStatus === 'paid') ?? groups[0] : groups[0];
    if (args.unpaidIvr !== '' && first.ivr === args.unpaidIvr) throw new Error('Unpaid group rejected for paid booking.');
    if (first.paymentStatus === 'unpaid') throw new Error('Unpaid group rejected for paid booking.');
    return selectedRef(first);
  }
  if (args.unpaidIvr === '') {
    for (const group of groups) {
      if (args.paidIvr !== '' && group.ivr === args.paidIvr) continue;
      if (group.paymentStatus === 'paid') continue;
      if (group.paymentStatus === 'unpaid') {
        return selectedRef(group);
      }
    }
    if (fullyReadable && groups.every(group => group.paymentStatus === 'paid')) throw new Error('Unpaid group not found on the dashboard.');
    throw new Error('No eligible unpaid group on the dashboard.');
  }
  const match = groups.find(group => group.ivr === args.unpaidIvr);
  if (!match) {
    if (fullyReadable) throw new Error('Unpaid group not found on the dashboard.');
    throw new Error('No eligible unpaid group on the dashboard.');
  }
  if (args.paidIvr !== '' && match.ivr === args.paidIvr) throw new Error('Paid group rejected for unpaid tracking.');
  if (match.paymentStatus === 'paid') throw new Error('Paid group rejected for unpaid tracking.');
  if (match.paymentStatus !== 'unpaid') throw new Error('No eligible unpaid group on the dashboard.');
  return selectedRef(match);
}
