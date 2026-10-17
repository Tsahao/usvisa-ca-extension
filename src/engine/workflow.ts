import { isPanelCommandErrorMessage } from './start-errors';
import { isAuthenticationFailureReason, type AuthenticationFailureReason } from '../domain/diagnostics';
import { emptyAlertState, type AlertState } from '../domain/alerts';
import { validateApplicantIds } from '../domain/applicants';
import { isIsoDate } from '../domain/dates';
import { validateGroupBinding, type GroupBinding } from '../domain/groups';

export const ENGINE_VERSION = 1 as const;
export const ENGINE_KEY = 'engineStateV1';

export type EngineMode = 'booking' | 'alerts';
export type EngineStatus = 'idle' | 'running' | 'verifying' | 'stopped';
export type VerificationOutcome = 'target-confirmed' | 'previous-continue' | 'unbooked-continue' | 'uncertain-stop';

// Fixed identifier-free verification parking reasons. New optional fields
// validate against this list and migrate old saves to null; the panel shows
// these instead of endlessly repeating a bare Press Start.
export const VERIFICATION_UNREADABLE =
  'The previous booking attempt could not be verified. The dashboard reading was unclear. Press Start to verify its result again.';
export const VERIFICATION_ROSTER_CHANGED =
  'The applicant list changed since the booking attempt. Automatic booking is paused. Press Start to verify the attempt before continuing.';
export const VERIFICATION_CONFIG_CHANGED =
  'Settings changed since the booking attempt. Automatic booking is paused. Press Start to continue with the new configuration after verification.';
export const VERIFICATION_ERRORS = [VERIFICATION_UNREADABLE, VERIFICATION_ROSTER_CHANGED, VERIFICATION_CONFIG_CHANGED] as const;
export type VerificationError = (typeof VERIFICATION_ERRORS)[number];
export function isVerificationErrorMessage(value: unknown): value is string {
  return typeof value === 'string' && (VERIFICATION_ERRORS as readonly string[]).includes(value);
}

// Fixed identifier-free authentication failure reasons (developer state only,
// never shown in product UI/copy). Optional in saves; old saves migrate to
// null and malformed values fail closed. Cleared on fresh/healthy
// authentication and preserved existing panel/analytics semantics (panel
// keeps using loginFailed/authenticationError; analytics keeps its existing
// terminal-failure classification). The allowlist lives with the diagnostics
// schema so workflow saves and diagnostic events cannot drift apart.
export { AUTHENTICATION_FAILURE_REASONS, isAuthenticationFailureReason, type AuthenticationFailureReason } from '../domain/diagnostics';

// Durable permission to restart AFTER verification resolves, created by an
// explicit product Start during unresolved intent. Scoped to the verifying
// run and the requested configuration (policy snapshot at request time).
// Backward-compatible: absent in old saves, migrates to null.
export type QueuedStart = {
  owner: string;
  runId: string;
  mode: EngineMode;
  requestedAt: string;
  policyKey: string | null;
};

export type ConfirmationIntent = {
  runId: string;
  mode: EngineMode;
  groupId: string;
  targetDate: string;
  consulate: string;
  testMode: boolean;
  createdAt: string;
  phase?: 'prepared' | 'submitted' | 'confirming';
};

export type ExecutorState = {
  tabId: number;
  applicantIds: string[] | null;
  targetTime: string | null;
  skippedDates: string[];
  actionPending: boolean;
  loadingSince?: string;
};

export type AuthenticationState = {
  tabId: number | null; phase: 'prepare' | 'submit' | 'wait' | 'retry' | 'cycle-wait'; pending: boolean;
  startedAt: string; purpose: 'start' | 'renew' | 'verify';
  // Durable per-auth-cycle deadline: one fresh-GET cycle lasts the configured
  // checking interval plus jitter. Legacy saves omit these fields and migrate
  // at validation/runtime; keep them optional so older literals still compile.
  cycleStartedAt?: string;
  cycleDeadline?: string | null;
  submittedInCycle?: boolean;
  // What the durable pending checkpoint guards: 'navigation' is a browser-side
  // GET to a fixed approved target (an interrupted one is safely recoverable
  // on worker wake), 'action' is an injected login form action which may have
  // submitted a POST (never replayed; resumes read-only on worker wake).
  // Optional: unknown/legacy checkpoints still park for explicit review.
  checkpoint?: 'navigation' | 'action';
};

export type EngineState = {
  version: 1;
  runId: string | null;
  owner: string | null;
  generation: number;
  mode: EngineMode;
  status: EngineStatus;
  intent: ConfirmationIntent | null;
  group: GroupBinding | null;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  lastCandidate: string | null;
  stage: string | null;
  executor: ExecutorState | null;
  monitorTabId: number | null;
  verification: { reads: (string | null)[]; nextReadAt: string | null } | null;
  nextPollAt: string | null;
  alert: AlertState;
  updatedAt: string;
  startedAt: string | null;
  policyKey: string | null;
  pollIntervalS: number;
  authentication: AuthenticationState | null;
  // Renewal starts since the last fully validated authentication success.
  // Successful hourly renewals reset this; it is not a lifetime run limit.
  sessionRenewals: number;
  loginFailed: boolean;
  authenticationError?: string | null;
  // Retained fixed identifier-free authentication failure diagnostic reason.
  // Developer state only: never rendered in product UI/copy, never carries
  // URLs, credentials, identifiers or page contents. Optional; old saves
  // migrate to null.
  authenticationFailureReason?: AuthenticationFailureReason | null;
  manualAuthentication: boolean;
  verificationTabId: number | null;
  queuedStart?: QueuedStart | null;
  verificationError?: string | null;
  // Explicit restart-after-success setup. No group or mutation is authorized
  // until fresh dashboard validation succeeds. Old saves migrate to false.
  restartPending?: boolean;
  restartFailed?: boolean;
};

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function emptyEngineState(now: string): EngineState {
  if (!isIsoDateTime(now)) throw new Error('Invalid engine timestamp.');
  return {
    version: ENGINE_VERSION,
    runId: null,
    owner: null,
    generation: 0,
    mode: 'booking',
    status: 'idle',
    intent: null,
    group: null,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastCandidate: null,
    stage: null,
    executor: null,
    monitorTabId: null,
    verification: null,
    nextPollAt: null,
    alert: emptyAlertState(),
    updatedAt: now,
    startedAt: null,
    policyKey: null,
    pollIntervalS: 60,
    authentication: null, sessionRenewals: 0, loginFailed: false, authenticationError: null, authenticationFailureReason: null, manualAuthentication: false, verificationTabId: null,
    queuedStart: null, verificationError: null, restartPending: false, restartFailed: false,
  };
}

function validateAlert(value: unknown): AlertState {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid engine alert state.');
  const state = value as Record<string, unknown>;
  const { observed, delivered, pending } = state;
  if (!(observed === undefined || observed === null || (typeof observed === 'string' && isIsoDate(observed))))
    throw new Error('Invalid engine alert observation.');
  if (!(delivered === null || (typeof delivered === 'string' && isIsoDate(delivered))))
    throw new Error('Invalid engine alert delivery.');
  if (typeof pending !== 'boolean') throw new Error('Invalid engine alert pending flag.');
  return { observed: observed as AlertState['observed'], delivered: delivered as AlertState['delivered'], pending };
}

function validateIntent(value: unknown): ConfirmationIntent {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid confirmation intent.');
  const intent = value as Record<string, unknown>;
  if (!isOpaqueId(intent.runId)) throw new Error('Invalid confirmation intent.');
  if (intent.mode !== 'booking' && intent.mode !== 'alerts') throw new Error('Invalid confirmation intent.');
  if (!isOpaqueId(intent.groupId)) throw new Error('Invalid confirmation intent.');
  if (typeof intent.targetDate !== 'string' || !isIsoDate(intent.targetDate))
    throw new Error('Invalid confirmation intent.');
  if (typeof intent.consulate !== 'string' || intent.consulate.length === 0 || intent.consulate.length > 64)
    throw new Error('Invalid confirmation intent.');
  if (typeof intent.testMode !== 'boolean') throw new Error('Invalid confirmation intent.');
  if (!isIsoDateTime(intent.createdAt)) throw new Error('Invalid confirmation intent.');
  if (intent.phase !== undefined && !['prepared', 'submitted', 'confirming'].includes(intent.phase as string)) throw new Error('Invalid confirmation phase.');
  return intent as ConfirmationIntent;
}

// Fail closed: any malformed or unversioned save throws instead of guessing.
export function validateEngineState(value: unknown): EngineState {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid engine state.');
  const state = value as Record<string, unknown>;
  if (state.version !== ENGINE_VERSION) throw new Error('Unsupported engine state version.');
  if (!(state.runId === null || isOpaqueId(state.runId))) throw new Error('Invalid engine state.');
  if (!(state.owner === null || isOpaqueId(state.owner))) throw new Error('Invalid engine state.');
  if (!Number.isInteger(state.generation) || (state.generation as number) < 0)
    throw new Error('Invalid engine state.');
  if (state.mode !== 'booking' && state.mode !== 'alerts') throw new Error('Invalid engine state.');
  if (!['idle', 'running', 'verifying', 'stopped'].includes(state.status as string))
    throw new Error('Invalid engine state.');
  if (!(state.intent === null || typeof state.intent === 'object'))
    throw new Error('Invalid engine state.');
  if (state.intent !== null) validateIntent(state.intent);
  if (!(state.nextPollAt === null || isIsoDateTime(state.nextPollAt)))
    throw new Error('Invalid engine state.');
  if (!isIsoDateTime(state.updatedAt)) throw new Error('Invalid engine state.');
  const startedAt = state.startedAt ?? null;
  const policyKey = state.policyKey ?? null;
  const pollIntervalS = state.pollIntervalS ?? 60;
  let authentication: AuthenticationState | null = null;
  const sessionRenewals = state.sessionRenewals ?? 0;
  const loginFailed = state.loginFailed ?? false;
  const authenticationError = state.authenticationError ?? null;
  if (authenticationError !== null && !isPanelCommandErrorMessage(authenticationError)) throw new Error('Invalid authentication diagnostic.');
  const authenticationFailureReason = state.authenticationFailureReason === undefined || state.authenticationFailureReason === null
    ? null : state.authenticationFailureReason;
  if (authenticationFailureReason !== null && !isAuthenticationFailureReason(authenticationFailureReason))
    throw new Error('Invalid authentication diagnostic.');
  const manualAuthentication = state.manualAuthentication ?? false;
  const verificationTabId = state.verificationTabId ?? null;
  const monitorTabId = state.monitorTabId ?? null;
  if (!Number.isInteger(sessionRenewals) || (sessionRenewals as number) < 0 || (sessionRenewals as number) > 3 || typeof loginFailed !== 'boolean' || typeof manualAuthentication !== 'boolean' ||
      !(verificationTabId === null || (Number.isSafeInteger(verificationTabId) && (verificationTabId as number) >= 0)) ||
      !(monitorTabId === null || (Number.isSafeInteger(monitorTabId) && (monitorTabId as number) >= 0))) throw new Error('Invalid authentication state.');
  if (state.authentication !== undefined && state.authentication !== null) {
    const auth = state.authentication as AuthenticationState;
    if (!(auth.tabId === null || (Number.isSafeInteger(auth.tabId) && auth.tabId >= 0)) ||
        !['prepare', 'submit', 'wait', 'retry', 'cycle-wait'].includes(auth.phase) || typeof auth.pending !== 'boolean' || !isIsoDateTime(auth.startedAt) ||
        !['start', 'renew', 'verify'].includes(auth.purpose)) throw new Error('Invalid authentication state.');
    // Compatibility: older saves predate per-cycle deadlines. Migrate them to
    // one cycle anchored at the recorded start with the saved interval and no
    // added jitter, so validation stays deterministic. Runtime fills jittered
    // deadlines for fresh cycles.
    const interval = Number.isInteger(pollIntervalS) ? pollIntervalS as number : 60;
    const cycleStartedAt = auth.cycleStartedAt === undefined ? auth.startedAt : auth.cycleStartedAt;
    if (!isIsoDateTime(cycleStartedAt)) throw new Error('Invalid authentication state.');
    let cycleDeadline: string | null = auth.cycleDeadline === undefined ? null : auth.cycleDeadline;
    if (cycleDeadline === null && auth.cycleDeadline === undefined) {
      const anchored = Date.parse(cycleStartedAt);
      if (!Number.isFinite(anchored)) throw new Error('Invalid authentication state.');
      cycleDeadline = new Date(anchored + interval * 1000).toISOString();
    }
    if (cycleDeadline !== null && !isIsoDateTime(cycleDeadline)) throw new Error('Invalid authentication state.');
    const submittedInCycle = auth.submittedInCycle === undefined ? auth.phase === 'wait' : auth.submittedInCycle;
    if (typeof submittedInCycle !== 'boolean') throw new Error('Invalid authentication state.');
    if (!(auth.checkpoint === undefined || auth.checkpoint === 'navigation' || auth.checkpoint === 'action'))
      throw new Error('Invalid authentication state.');
    authentication = { tabId: auth.tabId, phase: auth.phase, pending: auth.pending, startedAt: auth.startedAt, purpose: auth.purpose,
      cycleStartedAt, cycleDeadline, submittedInCycle,
      ...(auth.checkpoint === undefined ? {} : { checkpoint: auth.checkpoint }) };
  }
  if (!Number.isInteger(pollIntervalS) || (pollIntervalS as number) < 60 || (pollIntervalS as number) > 86400) throw new Error('Invalid poll interval.');
  if (!(startedAt === null || isIsoDateTime(startedAt)) ||
      !(policyKey === null || (typeof policyKey === 'string' && policyKey.length <= 1024))) throw new Error('Invalid lifecycle state.');
  const alert = validateAlert(state.alert);
  // Older saves predate group binding; they migrate to unbound.
  const group = state.group === undefined || state.group === null ? null : validateGroupBinding(state.group);
  const consecutiveFailures = state.consecutiveFailures === undefined ? 0 : state.consecutiveFailures;
  if (!Number.isInteger(consecutiveFailures) || (consecutiveFailures as number) < 0)
    throw new Error('Invalid engine state.');
  const cooldownUntil = state.cooldownUntil === undefined || state.cooldownUntil === null ? null : state.cooldownUntil;
  if (cooldownUntil !== null && !isIsoDateTime(cooldownUntil)) throw new Error('Invalid engine state.');
  const lastCandidate = state.lastCandidate === undefined || state.lastCandidate === null ? null : state.lastCandidate;
  if (lastCandidate !== null && !isIsoDate(lastCandidate as string)) throw new Error('Invalid engine state.');
  const stage = state.stage === undefined || state.stage === null ? null : state.stage;
  if (stage !== null && !['actions', 'warning', 'applicants', 'form', 'confirm', 'done'].includes(stage as string))
    throw new Error('Invalid engine state.');
  // Legacy runs have no independent roster/tab custody: never infer it
  // from a downstream booking URL.
  let executor: ExecutorState | null = null;
  if (state.executor !== undefined && state.executor !== null) {
    const value = state.executor as ExecutorState;
    if (!Number.isSafeInteger(value.tabId) || value.tabId < 0 || typeof value.actionPending !== 'boolean' ||
        !(value.targetTime === null || (typeof value.targetTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.targetTime))))
      throw new Error('Invalid executor state.');
    const skippedDates = value.skippedDates ?? [];
    if (value.loadingSince !== undefined && !isIsoDateTime(value.loadingSince)) throw new Error('Invalid executor loading state.');
    if (!Array.isArray(skippedDates) || skippedDates.length > 3660 || !skippedDates.every(isIsoDate) ||
        new Set(skippedDates).size !== skippedDates.length) throw new Error('Invalid executor state.');
    executor = { skippedDates: [...skippedDates], tabId: value.tabId, actionPending: value.actionPending, targetTime: value.targetTime,
      ...(value.loadingSince === undefined ? {} : { loadingSince: value.loadingSince }),
      applicantIds: value.applicantIds === null ? null : validateApplicantIds(value.applicantIds) };
  }
  let verification: EngineState['verification'] = null;
  if (state.verification !== undefined && state.verification !== null) {
    const progress = state.verification as NonNullable<EngineState['verification']>;
    if (!Array.isArray(progress.reads) || progress.reads.length > 3 || !progress.reads.every(date => date === null || isIsoDate(date)) ||
        !(progress.nextReadAt === null || isIsoDateTime(progress.nextReadAt))) throw new Error('Invalid verification state.');
    verification = { reads: [...progress.reads], nextReadAt: progress.nextReadAt };
  }
  // Optional durable queued-start permission and fixed verification parking
  // reason. Old saves omit both and migrate to null; malformed values fail
  // closed. Credentials are never stored here.
  let queuedStart: QueuedStart | null = null;
  if (state.queuedStart !== undefined && state.queuedStart !== null) {
    const queued = state.queuedStart as Record<string, unknown>;
    if (!isOpaqueId(queued.owner) || !isOpaqueId(queued.runId) || (queued.mode !== 'booking' && queued.mode !== 'alerts') ||
        !isIsoDateTime(queued.requestedAt) || !(queued.policyKey === null || (typeof queued.policyKey === 'string' && (queued.policyKey as string).length <= 1024)))
      throw new Error('Invalid queued start.');
    queuedStart = { owner: queued.owner as string, runId: queued.runId as string, mode: queued.mode as EngineMode,
      requestedAt: queued.requestedAt as string, policyKey: queued.policyKey as string | null };
  }
  const verificationError = state.verificationError === undefined || state.verificationError === null ? null : state.verificationError;
  if (verificationError !== null && !isVerificationErrorMessage(verificationError)) throw new Error('Invalid verification diagnostic.');
  const restartPending = state.restartPending ?? false;
  if (typeof restartPending !== 'boolean' || (restartPending && state.intent)) throw new Error('Invalid restart state.');
  const restartFailed = state.restartFailed ?? false;
  if (typeof restartFailed !== 'boolean') throw new Error('Invalid restart state.');
  // Idle and stopped states never carry an active deadline.
  if ((state.status === 'idle' || state.status === 'stopped') && state.nextPollAt !== null)
    throw new Error('Invalid engine state.');
  return {
    version: ENGINE_VERSION,
    runId: state.runId as string | null,
    owner: state.owner as string | null,
    generation: state.generation as number,
    mode: state.mode as EngineMode,
    status: state.status as EngineStatus,
    intent: state.intent === null ? null : validateIntent(state.intent),
    group,
    consecutiveFailures: consecutiveFailures as number,
    cooldownUntil: cooldownUntil as string | null,
    lastCandidate: lastCandidate as string | null,
    stage: stage as string | null,
    executor,
    monitorTabId: monitorTabId as number | null,
    verification,
    nextPollAt: state.nextPollAt as string | null,
    alert,
    updatedAt: state.updatedAt as string,
    startedAt,
    policyKey,
    pollIntervalS: pollIntervalS as number,
    authentication, sessionRenewals: sessionRenewals as number,
    loginFailed: loginFailed as boolean, authenticationError: authenticationError as string | null, authenticationFailureReason: authenticationFailureReason as AuthenticationFailureReason | null, manualAuthentication: manualAuthentication as boolean, verificationTabId: verificationTabId as number | null,
    queuedStart, verificationError: verificationError as string | null, restartPending, restartFailed,
  };
}

// Duplicate Start is idempotent: a running workflow keeps its runId and
// generation so reopening a panel cannot duplicate work.
export function startRun(
  state: EngineState,
  args: { mode: EngineMode; owner: string; runId: string; now: string; nextPollAt?: string | null },
): EngineState {
  if (!isOpaqueId(args.owner) || !isOpaqueId(args.runId) || !isIsoDateTime(args.now))
    throw new Error('Invalid start request.');
  if (args.mode !== 'booking' && args.mode !== 'alerts') throw new Error('Invalid start request.');
  if (args.nextPollAt !== undefined && args.nextPollAt !== null && !isIsoDateTime(args.nextPollAt))
    throw new Error('Invalid start request.');
  if (state.status === 'running') return state;
  if (state.status === 'verifying') return state;
  // Legacy stopped saves may still contain an unresolved confirmation.
  if (state.intent !== null) return { ...state, status: 'verifying', nextPollAt: null, updatedAt: args.now };
  return {
    version: ENGINE_VERSION,
    runId: args.runId,
    owner: args.owner,
    generation: state.generation + 1,
    mode: args.mode,
    status: 'running',
    intent: null,
    group: null,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastCandidate: null,
    stage: null,
    executor: null,
    monitorTabId: null,
    verification: null,
    nextPollAt: args.nextPollAt ?? null,
    alert: state.alert,
    updatedAt: args.now,
    startedAt: args.now,
    policyKey: null,
    pollIntervalS: 60,
    authentication: null, sessionRenewals: 0, loginFailed: false, authenticationError: null, authenticationFailureReason: null, manualAuthentication: false, verificationTabId: null,
    queuedStart: null, verificationError: null, restartPending: false, restartFailed: false,
  };
}

// Explicit product Start during unresolved intent records durable permission
// to restart AFTER verification resolves. Idempotent while verification or
// authentication is active: repeated Starts never reset tab, progress or
// deadlines. Scoped to the verifying run and the requested configuration
// (policy snapshot at request time); unknown intent is never discarded.
export function queueVerificationStart(
  state: EngineState,
  args: { owner: string; runId: string; mode: EngineMode; policyKey: string | null; now: string },
): EngineState {
  if (!isOpaqueId(args.owner) || !isOpaqueId(args.runId) || !isIsoDateTime(args.now))
    throw new Error('Invalid queued start.');
  if (args.mode !== 'booking' && args.mode !== 'alerts') throw new Error('Invalid queued start.');
  if (args.policyKey !== null && (typeof args.policyKey !== 'string' || args.policyKey.length > 1024))
    throw new Error('Invalid queued start.');
  if (state.status !== 'verifying' || !state.intent) return state;
  if (state.owner !== args.owner || state.runId !== args.runId) return state;
  const existing = state.queuedStart;
  if (existing && existing.owner === args.owner && existing.runId === args.runId && existing.mode === args.mode &&
      existing.policyKey === args.policyKey) return state;
  return { ...state, queuedStart: { owner: args.owner, runId: args.runId, mode: args.mode, requestedAt: args.now, policyKey: args.policyKey },
    updatedAt: args.now };
}

// Stop cancels queued restart permission but retains unresolved intent.
export function cancelQueuedStart(state: EngineState, now: string): EngineState {
  if (!isIsoDateTime(now)) throw new Error('Invalid engine timestamp.');
  if (!state.queuedStart) return state;
  return { ...state, queuedStart: null, updatedAt: now };
}

// Only the owning context can stop its run. The confirmation intent and alert
// observation survive so an interrupted confirmation remains reviewable.
// Stop cancels queued restart permission but retains unresolved intent, and
// releases verifier custody so a later Start revalidates fresh.
export function stopRun(state: EngineState, args: { owner: string; runId: string; now: string }): EngineState {
  if (!isOpaqueId(args.owner) || !isOpaqueId(args.runId) || !isIsoDateTime(args.now)) throw new Error('Invalid stop request.');
  if (state.status !== 'running' && state.status !== 'verifying') return state;
  if (state.owner !== args.owner || state.runId !== args.runId) return state;
  return { ...state, status: state.intent ? 'verifying' : 'stopped', authentication: null, verification: null, nextPollAt: null,
    verificationTabId: null, queuedStart: null, restartPending: false, updatedAt: args.now };
}

// Intent is persisted before any irreversible action. Late or foreign intents
// are dropped so stale messages cannot arm a confirmation.
export function recordIntent(
  state: EngineState,
  args: { owner: string; runId: string; intent: ConfirmationIntent; now: string },
): EngineState {
  if (!isOpaqueId(args.owner) || !isOpaqueId(args.runId) || !isIsoDateTime(args.now))
    throw new Error('Invalid intent request.');
  const intent = validateIntent(args.intent);
  if (state.status !== 'running') return state;
  if (state.owner !== args.owner || state.runId !== args.runId) return state;
  if (intent.runId !== state.runId) return state;
  return { ...state, intent, updatedAt: args.now };
}

// Binds a running workflow to its resolved dashboard group. Binding is set
// once per run: a fresh Start clears it, but re-resolution mid-run is
// refused so a run can never silently change groups. Late or foreign
// bindings are dropped; a fresh Start always clears the previous binding.
export function bindGroup(
  state: EngineState,
  args: { owner: string; runId: string; binding: GroupBinding; now: string },
): EngineState {
  if (!isOpaqueId(args.owner) || !isOpaqueId(args.runId) || !isIsoDateTime(args.now))
    throw new Error('Invalid group binding request.');
  const binding = validateGroupBinding(args.binding);
  if (state.status !== 'running') return state;
  if (state.owner !== args.owner || state.runId !== args.runId) return state;
  if (state.group !== null) return state;
  return { ...state, group: binding, updatedAt: args.now };
}

export function setNextPoll(  state: EngineState,
  args: { owner: string; runId: string; nextPollAt: string | null; now: string },
): EngineState {
  if (!isOpaqueId(args.owner) || !isOpaqueId(args.runId) || !isIsoDateTime(args.now))
    throw new Error('Invalid poll schedule.');
  if (args.nextPollAt !== null && !isIsoDateTime(args.nextPollAt)) throw new Error('Invalid poll schedule.');
  if (state.status !== 'running') return state;
  if (state.owner !== args.owner || state.runId !== args.runId) return state;
  return { ...state, nextPollAt: args.nextPollAt, updatedAt: args.now };
}

// Worker startup reconciliation. An interrupted confirmation transitions to
// verification and is never replayed blindly. Worker suspension preserves
// deadlines and queued restart permission; browser restart parks work and
// cancels the queued request until a new Start. An overdue alarm triggers one
// revalidated cycle, never a replay of every missed poll.
export function reconcileStartup(state: EngineState, now: string, browserRestart = false): EngineState {
  if (!isIsoDateTime(now)) throw new Error('Invalid engine timestamp.');
  // An interrupted browser-side GET checkpoint is provably safe to recover on
  // worker wake: no POST can be replayed by a navigation, and the recovered
  // state revalidates the owned tab, settings, group, baseline and roster
  // before any fill, click or submit. The durable wait is held (the saved
  // cycle deadline when still in the future); Stop and edited settings keep
  // being respected by the resumed pass. Login action checkpoints resume
  // read-only below; unknown/legacy checkpoints and a real browser restart
  // stay parked per the product contract.
  if (state.authentication?.pending && !browserRestart && state.authentication.checkpoint === 'navigation') {
    const deadline = state.authentication.cycleDeadline && Date.parse(state.authentication.cycleDeadline) > Date.parse(now)
      ? state.authentication.cycleDeadline : now;
    state = { ...state, authentication: { ...state.authentication, pending: false, checkpoint: undefined, phase: 'retry' },
      nextPollAt: deadline, updatedAt: now };
  }
  else if (state.authentication?.pending && !browserRestart && state.authentication.checkpoint === 'action') {
    // This checkpoint covers login preparation/submission only, never a
    // booking action. Treat its reply as uncertain, consume the cycle's
    // single submit allowance, and resume read-only at the durable deadline.
    // A subsequent cycle must start with a fresh GET; no POST is replayed.
    const deadline = state.authentication.cycleDeadline && Date.parse(state.authentication.cycleDeadline) > Date.parse(now)
      ? state.authentication.cycleDeadline : now;
    state = { ...state, authentication: { ...state.authentication, pending: false, checkpoint: undefined,
      submittedInCycle: true, phase: 'wait' }, nextPollAt: deadline, updatedAt: now };
  }
  else if (state.authentication?.pending) state = { ...state, status: 'verifying', authentication: null, verification: null, nextPollAt: null,
    verificationTabId: null, restartPending: false, ...(browserRestart ? { queuedStart: null } : {}), updatedAt: now } as EngineState;
  else if (browserRestart && state.authentication) state = { ...state, status: 'verifying', authentication: null, verification: null, nextPollAt: null,
    verificationTabId: null, queuedStart: null, restartPending: false, updatedAt: now };
  else if (browserRestart && state.status === 'verifying' && state.verification !== null)
    state = { ...state, verification: null, nextPollAt: null, verificationTabId: null, queuedStart: null, updatedAt: now };
  else if (browserRestart && (state.status === 'verifying' || state.status === 'running') && state.queuedStart)
    state = { ...state, queuedStart: null, verification: state.status === 'verifying' ? null : state.verification,
      verificationTabId: null,
      nextPollAt: state.status === 'verifying' ? null : state.nextPollAt, authentication: null, status: state.intent ? 'verifying' : state.status, updatedAt: now };
  else if ((state.status === 'running' || state.status === 'stopped') && state.intent !== null) {
    if (!browserRestart && state.status === 'running' && state.intent.phase === 'submitted' && state.stage === 'confirm' && !state.executor?.actionPending) return state;
    // An interrupted live mutation on worker wake (never a deliberate Stop)
    // keeps the original 30s post-attempt settling delay: schedule a fresh
    // read-only verification pass 30s out instead of reading immediately.
    // Deliberately parked states (Stop, browser restart, legacy stopped
    // saves) stay parked with no deadline for an explicit Start.
    if (!browserRestart && state.status === 'running')
      state = { ...state, status: 'verifying', verification: { reads: [], nextReadAt: new Date(Date.parse(now) + 30_000).toISOString() }, nextPollAt: null, updatedAt: now };
    else state = { ...state, status: 'verifying', verification: null, nextPollAt: null, updatedAt: now };
  }
  else if (state.status === 'running' && state.executor?.actionPending) state = parkForReview(state, now);
  else if (state.status === 'running' && browserRestart) state = parkForReview(state, now);
  // Deliberately parked verification (Stop, browser restart, manual sign-in,
  // fixed error banners) stays parked with no deadline: the alarm loop has
  // nothing to wake for until an explicit Start resumes it. Never auto-heal
  // these into a fresh pass here: a third verification read can resolve
  // previous/unbooked outcomes to running, which would resume live booking
  // against the user's Stop/restart.
  return state;
}

// Parks a running workflow for manual review without ending it: tab loss,
// invalid configuration, or any situation where continuing blindly would be
// unsafe. Everything is preserved; only the deadline is dropped.
export function parkForReview(state: EngineState, now: string): EngineState {
  if (!isIsoDateTime(now)) throw new Error('Invalid engine timestamp.');
  if (state.status !== 'running') return state;
  return { ...state, status: 'verifying', authentication: null, nextPollAt: null, restartPending: false, updatedAt: now };
}

// Parks a run that still holds a booking intent for automatic verification
// instead of a bare park: the durable 30s post-attempt settling delay is
// scheduled, then three short-paced fresh reads resolve the intent. Never
// replays an interrupted click; a run without an intent parks bare.
export function parkForVerification(state: EngineState, now: string): EngineState {
  if (!isIsoDateTime(now)) throw new Error('Invalid engine timestamp.');
  const parked = parkForReview(state, now);
  if (parked === state || !parked.intent) return parked;
  return { ...parked, verification: { reads: [], nextReadAt: new Date(Date.parse(now) + 30_000).toISOString() }, updatedAt: now };
}

export function resolveVerification(  state: EngineState,
  args: { owner: string; runId: string; outcome: VerificationOutcome; now: string },
): EngineState {
  if (!isOpaqueId(args.owner) || !isOpaqueId(args.runId) || !isIsoDateTime(args.now))
    throw new Error('Invalid verification resolution.');
  if (!['target-confirmed', 'previous-continue', 'unbooked-continue', 'uncertain-stop'].includes(args.outcome))
    throw new Error('Invalid verification resolution.');
  if (state.status !== 'verifying') return state;
  if (state.owner !== args.owner || state.runId !== args.runId) return state;
  if (args.outcome === 'target-confirmed')
    return { ...state, status: 'stopped', intent: null, stage: null, executor: null, verification: null, authentication: null, verificationTabId: null, lastCandidate: null, nextPollAt: null,
      verificationError: null, updatedAt: args.now };
  if (args.outcome === 'previous-continue')
    return { ...state, status: 'running', intent: null, stage: null, executor: null, verification: null, authentication: null, verificationTabId: null, lastCandidate: null, nextPollAt: args.now,
      verificationError: null, updatedAt: args.now };
  if (args.outcome === 'unbooked-continue') {
    // Failed attempt with three positively unbooked readings continues with a
    // null appointment baseline, including a previously booked baseline.
    const group = state.group ? { ...state.group, currentDate: null } : null;
    return { ...state, status: 'running', intent: null, stage: null, executor: null, verification: null, authentication: null, verificationTabId: null, lastCandidate: null, nextPollAt: args.now,
      group, verificationError: null, updatedAt: args.now };
  }
  return { ...state, updatedAt: args.now };
}

// Stale-result rejection for async poll/read completions.
export function isStaleResult(state: EngineState, runId: string | null, generation: number): boolean {
  return state.runId !== runId || state.generation !== generation;
}
