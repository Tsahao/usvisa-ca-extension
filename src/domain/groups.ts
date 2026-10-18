import { isIsoDate } from './dates';
import { validateApplicantIds } from './applicants';
import type { SelectionFailureCode } from './diagnostics';

export type GroupKind = 'paid' | 'unpaid';
export type EngineMode = 'booking' | 'alerts';

export type PaymentStatus = 'paid' | 'unpaid' | 'unknown';

// The IVR Account Number is portal evidence, not a guaranteed reading: a card
// can expose a valid schedule and its own trusted Continue link while the IVR
// stays unreadable. It is therefore nullable end to end and never fabricated,
// and a null IVR is only ever selected through the blank-preference fallback.
export type GroupRef = {
  scheduleId: string;
  ivr: string | null;
};

// Reader-supplied per-card evidence. `continuePath` is the exact trusted
// same-origin continue_actions path observed on the card (null when absent);
// `paymentConflict` marks contradictory paid/unpaid markers on the same card
// so a degraded reading is never silently treated as a selectable unknown.
export type DashboardGroup = GroupRef & {
  paymentStatus?: PaymentStatus;
  continuePath?: string | null;
  paymentConflict?: boolean;
};

export type GroupBinding = GroupRef & {
  kind: GroupKind;
  currentDate: string | null;
  applicantIds?: string[];
  dashboardPath?: string;
  // The binding was chosen while its payment classification was unknown:
  // downstream work proceeds on validated workflow capability (legitimate
  // booking controls plus the existing baseline/roster safeguards), and a
  // later fresh resolution that confirms an incompatible status blocks the
  // run. Absent in legacy saves; absent equals false.
  pendingInspection?: boolean;
};

export type DashboardSnapshot = {
  groups: DashboardGroup[];
};

// Provisional resolution result: the selected ref plus the payment evidence
// observed at selection time. Callers persist `inspectionRequired` as the
// durable binding's pending-inspection flag and record the fixed degraded
// diagnostics before proceeding.
export type GroupResolution = GroupRef & {
  paymentStatus: PaymentStatus;
  inspectionRequired: boolean;
};

// The portal's own group workflow entry, trusted same-origin and
// query/fragment-free. This is the only Continue shape that may authorize a
// null-IVR selection; it is compared as an exact fixed literal, never parsed
// from arbitrary hrefs.
export function continuePathFor(scheduleId: string): string {
  return `/en-ca/niv/schedule/${scheduleId}/continue_actions`;
}

// Same-group identity across a saved binding and a fresh reading. The schedule
// is always the primary identity; a null IVR (unreadable reading) on either
// side never fabricates a mismatch, while two readable IVRs must agree.
export function sameGroupRef(a: GroupRef, b: GroupRef): boolean {
  return a.scheduleId === b.scheduleId && (a.ivr === null || b.ivr === null || a.ivr === b.ivr);
}

function isDigitId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && value.length >= 1 && value.length <= maxLength;
}

export function validateGroupRef(value: unknown): GroupRef {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid dashboard group.');
  const group = value as Record<string, unknown>;
  if (!isDigitId(group.scheduleId, 32) || (group.ivr !== null && !isDigitId(group.ivr, 32)))
    throw new Error('Invalid dashboard group.');
  return { scheduleId: group.scheduleId as string, ivr: group.ivr as string | null };
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
  // A null IVR (unreadable card) carries no identity information, so two
  // unreadable cards are not two claimants of the same identity; only
  // conflicting readable IVRs stay ambiguous.
  const ivrs = groups.map(group => group.ivr).filter((id): id is string => id !== null);
  if (scheduleIds.size !== groups.length || new Set(ivrs).size !== ivrs.length)
    throw new Error('Ambiguous dashboard groups.');
  return { groups };
}

// Stable identifier-free code for each fixed resolveGroup/binding refusal, so
// the retained terminal diagnostic and the Report a problem draft carry the
// exact selection cause instead of the overloaded group-changed detail. The
// literals live in the diagnostics allowlist and never carry identifiers.
const SELECTION_FAILURE_CODES_BY_MESSAGE: Record<string, SelectionFailureCode> = {
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
  'Invalid dashboard snapshot.': 'dashboard-snapshot-invalid',
  'Invalid dashboard group.': 'dashboard-group-invalid',
  'Ambiguous dashboard groups.': 'dashboard-groups-ambiguous',
  'Ambiguous dashboard group.': 'dashboard-groups-ambiguous',
  'Selected dashboard group is incomplete.': 'selection-incomplete',
};

// Classification is independent of recovery policy: direct Start refusals
// retain these codes, while authentication can retry a transient DOM reading.
export function isRetryableSelectionFailure(code: SelectionFailureCode): boolean {
  return ['dashboard-snapshot-invalid', 'dashboard-group-invalid', 'dashboard-groups-ambiguous', 'selection-incomplete'].includes(code);
}

export function selectionFailureCode(message: string): SelectionFailureCode | null {
  return Object.hasOwn(SELECTION_FAILURE_CODES_BY_MESSAGE, message) ? SELECTION_FAILURE_CODES_BY_MESSAGE[message]! : null;
}

// Normalize a raw reading's echoed IVR field. A missing/null field reads as an
// unreadable (null) IVR; malformed non-string or non-digit values return
// undefined so callers fail closed. Never fabricates an IVR.
export function normalizeReadingIvr(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && /^[0-9]{1,32}$/.test(value) ? value : undefined;
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
  // Older bindings predate provisional inspection; absent migrates to false
  // so legacy runs keep byte-identical behavior. Only a strict true persists.
  const pendingInspection = binding.pendingInspection ?? false;
  if (typeof pendingInspection !== 'boolean') throw new Error('Invalid group binding.');
  if (binding.dashboardPath !== undefined && (typeof binding.dashboardPath !== 'string' || !/^\/en-ca\/niv\/groups(?:\/[0-9]{1,32})?$/.test(binding.dashboardPath)))
    throw new Error('Invalid dashboard path.');
  return { ...ref, kind: binding.kind as GroupKind, currentDate,
    ...(pendingInspection ? { pendingInspection: true } : {}),
    ...(binding.dashboardPath === undefined ? {} : { dashboardPath: binding.dashboardPath }),
    ...(binding.applicantIds === undefined ? {} : { applicantIds: validateApplicantIds(binding.applicantIds) }) };
}

// Lenient selection parse shared by resolveGroup and the post-selection
// inspection: selection needs the chosen card's identity, not complete
// identities for every sibling. Preserve incomplete placeholders and their
// page positions; filtering them could silently change what "first group"
// means. Malformed evidence fails closed.
type ParsedGroup = {
  scheduleId: string;
  ivr: string | null;
  paymentStatus: PaymentStatus;
  continuePath: string | null;
  paymentConflict: boolean;
};

function parseDashboardGroups(snapshot: unknown): ParsedGroup[] {
  if (!snapshot || typeof snapshot !== 'object' || !('groups' in snapshot) || !Array.isArray(snapshot.groups))
    throw new Error('Invalid dashboard snapshot.');
  return snapshot.groups.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid dashboard group.');
    const group = item as Record<string, unknown>;
    if (group.scheduleId !== '' && !isDigitId(group.scheduleId, 32)) throw new Error('Invalid dashboard group.');
    if (group.ivr !== null && !isDigitId(group.ivr, 32)) throw new Error('Invalid dashboard group.');
    // A present Continue path must be the exact trusted literal for this
    // schedule; anything else (foreign, query-bearing, mismatched) is
    // malformed evidence and fails closed instead of authorizing entry.
    const observedContinue = group.continuePath;
    const continuePath = typeof observedContinue === 'string' && group.scheduleId !== '' &&
      observedContinue === continuePathFor(group.scheduleId) ? observedContinue : null;
    if (observedContinue !== undefined && observedContinue !== null && continuePath === null)
      throw new Error('Invalid dashboard group.');
    const paymentStatus: PaymentStatus = group.paymentStatus === 'paid' || group.paymentStatus === 'unpaid' ? group.paymentStatus : 'unknown';
    return { scheduleId: group.scheduleId as string, ivr: group.ivr as string | null, paymentStatus, continuePath,
      paymentConflict: group.paymentConflict === true };
  });
}

// Post-selection inspection verdict for a provisional (pendingInspection)
// binding, evaluated against a fresh raw snapshot before re-resolution.
// 'resolved' confirms the payment classification matches the binding kind;
// 'unknown' keeps the provisional flag; 'blocked' carries the precise fixed
// code (contradictory markers or a positively incompatible status); null
// means the bound card is absent from this reading, and the caller's ordinary
// identity comparison reports the movement instead.
export function inspectBoundGroup(
  snapshot: unknown,
  binding: GroupBinding,
): { verdict: 'resolved' } | { verdict: 'unknown' } | { verdict: 'blocked'; code: SelectionFailureCode } | null {
  const groups = parseDashboardGroups(snapshot);
  const found = groups.find(group => group.scheduleId !== '' && sameGroupRef(group, binding));
  if (!found) return null;
  if (found.paymentConflict) return { verdict: 'blocked', code: 'payment-markers-conflict' };
  const compatible = binding.kind === 'paid' ? 'paid' : 'unpaid';
  const incompatible = binding.kind === 'paid' ? 'unpaid' : 'paid';
  if (found.paymentStatus === incompatible) return { verdict: 'blocked', code: 'payment-ineligible' };
  if (found.paymentStatus === compatible) return { verdict: 'resolved' };
  return { verdict: 'unknown' };
}

// Binds a run to exactly one dashboard group. Fixed diagnostics only: group
// identifiers never appear in error text.
// - Paid exact IVR when configured; product discovery prefers the first paid
//   group in page order. Legacy/developer callers retain their first-card
//   fallback. A positively identified unpaid group is always rejected
//   before any booking workflow; unknown status proceeds provisionally
//   (inspectionRequired) while contradictory payment markers stay blocking.
//   Absence of a booking proves nothing.
// - Unpaid blank skips paid groups (including the configured paid-IVR
//   exclusion), then inspects the first remaining card in dashboard order.
//   A genuinely unknown card must prove its own workflow entry with a trusted
//   same-card Continue link and binds provisionally for inspection. Unreadable
//   or contradictory candidates never silently redirect selection to a sibling.
//   An explicit unpaid IVR must match that exact
//   card: a positively paid card stays rejected, an unknown one proceeds
//   provisionally, and a contradictory one stays blocking. All-readable-paid
//   and explicit-paid selections are known unpaid-group failures; other
//   unknown classification is a catch-all.
// - A card with no readable IVR is selectable only through the blank-preference
//   fallback and only with its own trusted Continue link; the stable schedule
//   ID is revalidated downstream. The IVR is never fabricated.
export function resolveGroup(
  snapshot: unknown,
  args: { mode: EngineMode; paidIvr: string; unpaidIvr: string; preferPaid?: boolean },
): GroupResolution {
  const groups = parseDashboardGroups(snapshot);
  const scheduleIds = groups.map(group => group.scheduleId).filter(id => id !== '');
  const ivrs = groups.map(group => group.ivr).filter((id): id is string => id !== null);
  if (new Set(scheduleIds).size !== scheduleIds.length || new Set(ivrs).size !== ivrs.length)
    throw new Error('Ambiguous dashboard groups.');
  // Entry evidence: a readable IVR, or the card's own trusted Continue link.
  // A card with neither is never selectable and never authorizes a mode.
  const selectable = (group: typeof groups[number]): boolean => group.scheduleId !== '' &&
    (group.ivr !== null || group.continuePath !== null);
  const selectedRef = (group: typeof groups[number]): GroupRef => {
    if (!selectable(group)) throw new Error('Selected dashboard group is incomplete.');
    return { scheduleId: group.scheduleId, ivr: group.ivr };
  };
  const resolution = (group: typeof groups[number]): GroupResolution => ({
    ...selectedRef(group),
    paymentStatus: group.paymentStatus,
    // Unknown classification proceeds provisionally: the caller persists the
    // durable pending-inspection flag and downstream validation decides
    // whether the run continues or blocks.
    inspectionRequired: group.paymentStatus === 'unknown',
  });
  if (args.paidIvr !== '' && !isDigitId(args.paidIvr, 32)) throw new Error('Invalid paid IVR.');
  if (args.unpaidIvr !== '' && !isDigitId(args.unpaidIvr, 32)) throw new Error('Invalid unpaid IVR.');
  if (args.mode !== 'booking' && args.mode !== 'alerts') throw new Error('Invalid resolve mode.');
  if (groups.length === 0) throw new Error('No dashboard group to bind.');
  const fullyReadable = groups.every(group => group.scheduleId !== '' && group.ivr !== null && group.paymentStatus !== 'unknown');
  const excluded = (group: typeof groups[number]): boolean => args.paidIvr !== '' && group.ivr === args.paidIvr;
  if (args.mode === 'booking') {
    if (args.paidIvr !== '') {
      const match = groups.find(group => group.ivr === args.paidIvr);
      if (!match) {
        if (fullyReadable) throw new Error('Paid group not found on the dashboard.');
        throw new Error('No eligible paid group on the dashboard.');
      }
      if (match.paymentConflict) throw new Error('Conflicting dashboard payment markers.');
      if (args.unpaidIvr !== '' && match.ivr === args.unpaidIvr) throw new Error('Unpaid group rejected for paid booking.');
      if (match.paymentStatus === 'unpaid') throw new Error('Unpaid group rejected for paid booking.');
      return resolution(match);
    }
    const first = args.preferPaid ? groups.find(group => group.paymentStatus === 'paid') ?? groups[0] : groups[0];
    if (first.paymentConflict) throw new Error('Conflicting dashboard payment markers.');
    if (args.unpaidIvr !== '' && first.ivr === args.unpaidIvr) throw new Error('Unpaid group rejected for paid booking.');
    if (first.paymentStatus === 'unpaid') throw new Error('Unpaid group rejected for paid booking.');
    return resolution(first);
  }
  if (args.unpaidIvr === '') {
    // Inspect the first potentially eligible card, not the first card whose
    // markup happens to be readable. Never jump over an uncertain candidate.
    for (const group of groups) {
      if (excluded(group)) continue;
      if (group.paymentConflict) throw new Error('Conflicting dashboard payment markers.');
      if (group.paymentStatus === 'paid') continue;
      if (group.paymentStatus === 'unpaid') return resolution(group);
      if (group.continuePath === null) throw new Error('Selected dashboard group is incomplete.');
      return resolution(group);
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
  if (match.paymentConflict) throw new Error('Conflicting dashboard payment markers.');
  // A matching explicit IVR proves the group identity; an unknown payment
  // classification still proceeds provisionally for inspection instead of a
  // catch-all rejection.
  return resolution(match);
}
