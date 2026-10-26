import { WORKFLOW_DETAIL_CODES } from './failure-codes';
// Bounded local developer diagnostics for unattended reliability analysis.
// Event-driven, allowlisted fixed codes only: entries never carry credentials,
// page contents/HTML, URLs, identifiers, appointment dates, raw exceptions or
// arbitrary values. Storage is chrome.storage.local (trusted contexts only),
// separate from the workflow checkpoint and the user-facing date history.

export const DIAGNOSTICS_KEY = 'engineDiagnosticsV1';
export const DIAGNOSTICS_ALARM = 'engineDiagnosticsExpiry';
export const DIAGNOSTICS_VERSION = 1 as const;
// 7-day retention with a hard entry bound. Repeated identical events collapse
// into one entry with a bounded repeat count so a long failing run cannot fill
// the ring with a single signal.
export const DIAGNOSTICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAGNOSTICS_LIMIT = 1500;
export const DIAGNOSTICS_REPEAT_LIMIT = 999;
export const DIAGNOSTICS_COALESCE_MS = 5 * 60 * 1000;

// Stable identifier-free terminal codes for dashboard group selection
// refusals and post-inspection incompatibility. Fixed literals shared by the
// authentication failure-reason allowlist and the diagnostic-detail allowlist
// so a Report a problem draft can carry the exact selection cause (never a
// generic UI category, never an overloaded single code). No identifiers, IVRs,
// schedule IDs or page content can appear in these values.
export const SELECTION_FAILURE_CODES = [
  'no-dashboard-group',
  'paid-group-not-found',
  'paid-group-unavailable',
  'unpaid-group-rejected',
  'unpaid-group-not-found',
  'unpaid-group-unavailable',
  'paid-group-rejected',
  'payment-markers-conflict',
  'payment-ineligible',
  'group-binding-invalid',
  'dashboard-snapshot-invalid',
  'dashboard-group-invalid',
  'dashboard-groups-ambiguous',
  'selection-incomplete',
] as const;
export type SelectionFailureCode = (typeof SELECTION_FAILURE_CODES)[number];

// Fixed identifier-free authentication failure reasons (also allowlisted for analytics,
// never shown in product UI/copy). Optional in saves; old saves migrate to
// null and malformed values fail closed. Defined here so diagnostics and the
// workflow share one allowlist.
export const AUTHENTICATION_FAILURE_REASONS = [
  'configuration-changed',
  'cancelled',
  'tab-unavailable',
  'untrusted-navigation',
  'context-changed',
  'auth-login-tabs-ambiguous', 'auth-pending-checkpoint', 'auth-clock-invalid', 'auth-intent-conflict',
  'navigation-failed',
  'storage-unavailable',
  'operation-failed',
  'unrecognized-reading',
  'credential-rejected',
  // Exact dashboard selection causes (proposal 7): each fixed resolveGroup
  // refusal records its own stable code instead of the overloaded
  // group-changed detail.
  ...SELECTION_FAILURE_CODES,
  // Identity moved after fresh re-resolution: the bound group, appointment
  // baseline or applicant roster no longer matches the saved binding.
  'group-identity-changed',
  'applicant-roster-changed',
] as const;
export type AuthenticationFailureReason = (typeof AUTHENTICATION_FAILURE_REASONS)[number];
export function isAuthenticationFailureReason(value: unknown): value is AuthenticationFailureReason {
  return typeof value === 'string' && (AUTHENTICATION_FAILURE_REASONS as readonly string[]).includes(value);
}

// Fixed event codes. One entry per meaningful transition; healthy polling
// ticks and repeated identical recoveries are never recorded (recoveries
// collapse through the repeat count instead).
export const DIAGNOSTIC_CODES = [
  'auth-started',
  'auth-prepared',
  'auth-submitted',
  'auth-notice-dismissed',
  'auth-validation-failed',
  'auth-reply-missing',
  'auth-reply-malformed',
  'auth-script-interrupted',
  'auth-retry-scheduled',
  'auth-cooldown-entered',
  'auth-cycle-expired',
  'auth-maintenance',
  'auth-manual',
  'auth-recovered',
  'auth-redirect-progress',
  'auth-terminal',
  'executor-retry',
  'executor-park',
  'executor-verification',
  'executor-recovered',
  'poll-retry',
  'poll-park',
  'poll-cooldown-entered',
  'poll-recovered',
  'poll-denied',
  'poll-empty',
  'poll-maintenance',
  'poll-park',
  'verification-progress',
  'verification-unreadable',
  'verification-retry',
  'verification-cooldown-entered',
  'verification-recovered',
  'verification-cooldown-entered',
  'verification-blocked',
  'verification-resolved',
  'auth-checkpoint-recovered',
  'engine-exception-recovered',
  // Degraded success: work continued although one identity/status signal was
  // unreadable. Non-terminal by design; the fixed code records exactly which
  // signal was missing. Repeated occurrences coalesce.
  'ivr-unreadable-proceeded',
  'payment-unknown-proceeded',
  // Attempted recovery: a provisional (pending-inspection) binding was
  // re-resolved and its payment classification confirmed compatible.
  'payment-inspection-resolved',
  'payment-inspection-attempted',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

// Fixed validation/recovery detail codes: the exact trusted-login form
// validation branch (or the fixed recovery context) that produced the event.
export const DIAGNOSTIC_DETAILS = [
  ...WORKFLOW_DETAIL_CODES,
  // Trusted sign-in form validation branches (adapter/login.ts literals).
  'url-mismatch',
  'form-missing',
  'form-duplicate',
  'form-loading',
  'email-missing',
  'email-duplicate',
  'password-missing',
  'password-duplicate',
  'policy-missing',
  'policy-duplicate',
  'form-method',
  'form-destination',
  'submit-count',
  'submit-disabled',
  'submit-override',
  'control-detached',
  'control-disabled',
  'policy-type',
  'password-type',
  'email-type',
  'credentials-invalid',
  'fields-changed',
  'policy-unchecked',
  'prepare-not-retained',
  'banner-unclassified',
  'notice-unrecognized',
  'challenge-detected',
  'captcha-detected',
  'overlay-detected',
  // Worker-side reply and recovery context (never page content).
  'reply-missing',
  'reply-malformed',
  'unknown-reason',
  'unclassified-refusal',
  'script-interrupted',
  'navigation-failed',
  'stalled-load',
  'trusted-progress',
  'transport',
  'maintenance',
  'empty-result',
  'tab-lost',
  'untrusted-url',
  'config-changed',
  'cancelled',
  'credential-rejected',
  'manual-authentication',
  'group-changed',
  'roster-changed',
  'roster-missing',
  'stage-guard',
  'candidate-invalid',
  'loading-timeout',
  'read-interrupted',
  'page-mismatch',
  'selection-invalid',
  // Exact terminal selection causes share the failure-reason literals so the
  // retained diagnostic detail is never the overloaded group-changed code.
  // Some (e.g. selection-incomplete) also describe retryable DOM readings.
  ...SELECTION_FAILURE_CODES,
  'mutation-unconfirmed',
  'navigation-unconfirmed',
  'test-mode-boundary',
  'navigation-checkpoint',
  'action-checkpoint',
  'action-unconfirmed',
] as const;
export type DiagnosticDetail = (typeof DIAGNOSTIC_DETAILS)[number];
export function isDiagnosticDetail(value: unknown): value is DiagnosticDetail {
  return typeof value === 'string' && (DIAGNOSTIC_DETAILS as readonly string[]).includes(value);
}

export const DIAGNOSTIC_PHASES = [
  'prepare', 'submit', 'wait', 'retry', 'cycle-wait',
  'actions', 'warning', 'applicants', 'form', 'confirm', 'done',
  'startup', 'verify',
] as const;
export type DiagnosticPhase = (typeof DIAGNOSTIC_PHASES)[number];
export function isDiagnosticPhase(value: unknown): value is DiagnosticPhase {
  return typeof value === 'string' && (DIAGNOSTIC_PHASES as readonly string[]).includes(value);
}

export const DIAGNOSTIC_OUTCOMES = [
  'healthy', 'not-modified', 'empty', 'retryable', 'maintenance', 'denied',
  'target-confirmed', 'previous-continue', 'unbooked-continue', 'uncertain-stop',
] as const;
export type DiagnosticOutcome = (typeof DIAGNOSTIC_OUTCOMES)[number];
export function isDiagnosticOutcome(value: unknown): value is DiagnosticOutcome {
  return typeof value === 'string' && (DIAGNOSTIC_OUTCOMES as readonly string[]).includes(value);
}

export type DiagnosticPurpose = 'start' | 'renew' | 'verify';
export type DiagnosticMode = 'booking' | 'alerts';

// Bounded validated extension version (manifest version shape). Recorded with
// every entry and reported in the read snapshot so a long unattended run can
// be analyzed across an update. Never a build ID, token or private value.
export function isExtensionVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && /^[0-9]{1,8}(\.[0-9]{1,8}){0,3}$/.test(value);
}

export type DiagnosticEntry = {
  at: string;
  code: DiagnosticCode;
  detail?: DiagnosticDetail;
  phase?: DiagnosticPhase;
  reason?: AuthenticationFailureReason;
  outcome?: DiagnosticOutcome;
  purpose?: DiagnosticPurpose;
  mode?: DiagnosticMode;
  // Durable failure budget observed at the event, never arbitrary state.
  failures?: number;
  // Validated extension build version when the event was recorded.
  extensionVersion?: string;
  // Collapsed identical repeats (1 when not collapsed).
  count?: number;
};

export type DiagnosticEvent = Omit<DiagnosticEntry, 'at' | 'count'>;
export type DiagnosticsLog = { version: 1; entries: DiagnosticEntry[] };

export function emptyDiagnostics(): DiagnosticsLog {
  return { version: DIAGNOSTICS_VERSION, entries: [] };
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isFailureCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 9999;
}

// Fail closed on malformed saves: reconstruct only allowlisted fields so a
// tampered or legacy record can never smuggle private values into analysis.
export function validateDiagnostics(raw: unknown): DiagnosticsLog {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid diagnostics log.');
  const value = raw as { version?: unknown; entries?: unknown };
  if (value.version !== DIAGNOSTICS_VERSION || !Array.isArray(value.entries) || value.entries.length > DIAGNOSTICS_LIMIT)
    throw new Error('Invalid diagnostics log.');
  const entries: DiagnosticEntry[] = value.entries.map(item => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid diagnostics entry.');
    const entry = item as Record<string, unknown>;
    if (!canonicalTimestamp(entry.at) || !(DIAGNOSTIC_CODES as readonly unknown[]).includes(entry.code))
      throw new Error('Invalid diagnostics entry.');
    if (!(entry.detail === undefined || isDiagnosticDetail(entry.detail))) throw new Error('Invalid diagnostics entry.');
    if (!(entry.phase === undefined || isDiagnosticPhase(entry.phase))) throw new Error('Invalid diagnostics entry.');
    if (!(entry.reason === undefined || isAuthenticationFailureReason(entry.reason))) throw new Error('Invalid diagnostics entry.');
    if (!(entry.outcome === undefined || isDiagnosticOutcome(entry.outcome))) throw new Error('Invalid diagnostics entry.');
    if (!(entry.purpose === undefined || entry.purpose === 'start' || entry.purpose === 'renew' || entry.purpose === 'verify'))
      throw new Error('Invalid diagnostics entry.');
    if (!(entry.mode === undefined || entry.mode === 'booking' || entry.mode === 'alerts'))
      throw new Error('Invalid diagnostics entry.');
    if (!(entry.failures === undefined || isFailureCount(entry.failures))) throw new Error('Invalid diagnostics entry.');
    if (!(entry.extensionVersion === undefined || isExtensionVersion(entry.extensionVersion)))
      throw new Error('Invalid diagnostics entry.');
    if (!(entry.count === undefined || (Number.isInteger(entry.count) && (entry.count as number) >= 1 && (entry.count as number) <= DIAGNOSTICS_REPEAT_LIMIT)))
      throw new Error('Invalid diagnostics entry.');
    return {
      at: entry.at as string,
      code: entry.code as DiagnosticCode,
      ...(entry.detail === undefined ? {} : { detail: entry.detail as DiagnosticDetail }),
      ...(entry.phase === undefined ? {} : { phase: entry.phase as DiagnosticPhase }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason as AuthenticationFailureReason }),
      ...(entry.outcome === undefined ? {} : { outcome: entry.outcome as DiagnosticOutcome }),
      ...(entry.purpose === undefined ? {} : { purpose: entry.purpose as DiagnosticPurpose }),
      ...(entry.mode === undefined ? {} : { mode: entry.mode as DiagnosticMode }),
      ...(entry.failures === undefined ? {} : { failures: entry.failures as number }),
      ...(entry.extensionVersion === undefined ? {} : { extensionVersion: entry.extensionVersion as string }),
      ...(entry.count === undefined ? {} : { count: entry.count as number }),
    };
  });
  return { version: DIAGNOSTICS_VERSION, entries };
}

// TTL + hard bound, newest first. Future-dated entries are dropped rather than
// trusted (worker clock changes must not pin stale records forever).
export function pruneDiagnostics(log: DiagnosticsLog, now: string): DiagnosticsLog {
  if (!canonicalTimestamp(now)) throw new Error('Invalid diagnostics time.');
  const current = Date.parse(now);
  const retained = log.entries.filter(entry => {
    const at = Date.parse(entry.at);
    return at > current - DIAGNOSTICS_TTL_MS && at <= current;
  });
  const newest = (a: DiagnosticEntry, b: DiagnosticEntry) => Date.parse(b.at) - Date.parse(a.at);
  return { version: DIAGNOSTICS_VERSION, entries: [...retained].sort(newest).slice(0, DIAGNOSTICS_LIMIT) };
}

// A repeat only collapses when every allowlisted signal field matches,
// including the observed failure count and extension version: a run whose
// counters or build changed inside the coalescing window keeps a distinct
// entry instead of silently rewriting history.
function sameSignal(a: DiagnosticEntry, b: DiagnosticEvent): boolean {
  return a.code === b.code && a.detail === b.detail && a.phase === b.phase && a.reason === b.reason &&
    a.outcome === b.outcome && a.purpose === b.purpose && a.mode === b.mode &&
    a.failures === b.failures && a.extensionVersion === b.extensionVersion;
}

// Appends one event (newest first). A repeated identical signal within the
// coalescing window collapses into the newest entry's bounded repeat count
// instead of growing the ring. The collapsed entry keeps the latest observed
// timestamp and its already-current counters (the signal includes them).
export function appendDiagnostic(log: DiagnosticsLog, event: DiagnosticEvent, now: string): DiagnosticsLog {
  if (!canonicalTimestamp(now)) throw new Error('Invalid diagnostics time.');
  const clean = pruneDiagnostics(log, now);
  const entry = validateDiagnostics({ version: DIAGNOSTICS_VERSION,
    entries: [{ ...event, at: now }] }).entries[0];
  const newest = clean.entries[0];
  if (newest && sameSignal(newest, event) && (newest.count ?? 1) < DIAGNOSTICS_REPEAT_LIMIT &&
      Date.parse(newest.at) >= Date.parse(now) - DIAGNOSTICS_COALESCE_MS) {
    const collapsed = { ...newest, at: now, count: (newest.count ?? 1) + 1 };
    return pruneDiagnostics({ version: DIAGNOSTICS_VERSION, entries: [collapsed, ...clean.entries.slice(1)] }, now);
  }
  return pruneDiagnostics({ version: DIAGNOSTICS_VERSION, entries: [entry, ...clean.entries] }, now);
}

export function diagnosticsExpiry(log: DiagnosticsLog): string | null {
  if (!log.entries.length) return null;
  const oldest = Math.min(...log.entries.map(entry => Date.parse(entry.at)));
  return new Date(oldest + DIAGNOSTICS_TTL_MS).toISOString();
}

export type DiagnosticsSnapshot = {
  version: 1;
  // Current validated extension version at read time (null when unknown).
  extensionVersion: string | null;
  entries: DiagnosticEntry[];
  retention: { ttlMs: number; limit: number };
};

// Read-only view for the documented developer reader: pruned, newest first,
// allowlisted fields only (never preferences, engine state or page content).
export function diagnosticsSnapshot(log: DiagnosticsLog, now: string, extensionVersion: string | null = null): DiagnosticsSnapshot {
  const clean = pruneDiagnostics(log, now);
  if (extensionVersion !== null && !isExtensionVersion(extensionVersion)) throw new Error('Invalid extension version.');
  return { version: DIAGNOSTICS_VERSION, extensionVersion, entries: clean.entries,
    retention: { ttlMs: DIAGNOSTICS_TTL_MS, limit: DIAGNOSTICS_LIMIT } };
}
