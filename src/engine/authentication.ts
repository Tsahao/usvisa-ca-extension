import { panelCommandError, type PanelReadStep } from './start-errors';
import { performLoginAction, probeLoginStatus, type LoginProbeResult, type LoginResult } from '../adapter/login';
import { readCurrentAppointment, readDashboardGroups, readSiteMaintenance } from '../adapter/reads';
import { appointmentApplicants, appointmentDate } from '../domain/appointment';
import { sameApplicants } from '../domain/applicants';
import { resolveGroup, validateDashboardSnapshot } from '../domain/groups';
import { classifyRoute, SITE_ORIGIN } from '../domain/routes';
import { isDiagnosticDetail, type DiagnosticCode, type DiagnosticDetail, type DiagnosticEvent } from '../domain/diagnostics';
import {
  countFailure,
  cooldownUntilSeconds,
  pollDelaySeconds,
  SETUP_FAILURE_COOLDOWN_AFTER,
  shouldCooldown,
} from '../domain/timing';
import { preferencesError, type Preferences } from '../ui/model';
import { policyKey, reviewLifecycle } from './lifecycle';
import { bindGroup, parkForReview, VERIFICATION_UNREADABLE, isAuthenticationFailureReason, type AuthenticationFailureReason, type AuthenticationState, type EngineState } from './workflow';
import type { ExecDeps } from './executor';
import { applyPollResult, engineAlarmAt } from './poll';

// Renewal keeps the existing workflow tab. Validate its current and pending
// navigation before replacing it with a fresh GET; never adopt a duplicate.
function trustedRenewalUrl(state: EngineState, value: string | undefined): boolean {
  if (!state.group || !value) return false;
  try {
    const url = new URL(value);
    if (url.origin !== SITE_ORIGIN || url.username || url.password || url.port || url.hash) return false;
    if (!url.search && ['/en-ca/niv', '/en-ca/niv/', '/en-ca/niv/users/sign_in', state.group.dashboardPath].includes(url.pathname)) return true;
    const base = `/en-ca/niv/schedule/${state.group.scheduleId}`;
    if (state.mode === 'alerts') return url.pathname === `${base}/payment` && !url.search;
    if (url.pathname === `${base}/continue_actions`) return !url.search;
    if (url.pathname !== `${base}/appointment`) return false;
    for (const [key, value] of url.searchParams) {
      if (key === 'applicants[]' && /^[0-9]{1,32}$/.test(value)) continue;
      if (key === 'confirmed_limit_message' && value === '1' && url.searchParams.getAll(key).length === 1) continue;
      return false;
    }
    const applicants = url.searchParams.getAll('applicants[]');
    return !applicants.length || sameApplicants(applicants, state.group.applicantIds);
  } catch { return false; }
}

export function deferAuthenticationForMaintenance(state: EngineState, now: string, random: () => number): EngineState {
  if (!state.authentication || state.authentication.pending || !['running', 'verifying'].includes(state.status)) return state;
  return { ...applyPollResult(state, { outcome: 'maintenance', now, random }),
    authentication: { ...state.authentication, phase: 'retry', pending: false, checkpoint: undefined },
    loginFailed: false, authenticationError: null, authenticationFailureReason: null, manualAuthentication: false };
}

export function beginAuthentication(state: EngineState, purpose: AuthenticationState['purpose'], now: string, random: () => number = () => 0): EngineState {
  if (state.authentication || (purpose !== 'verify' && (state.status !== 'running' || state.intent)) ||
      (purpose === 'verify' && (state.status !== 'verifying' || !state.intent))) return state;
  if (purpose === 'renew' && state.sessionRenewals >= 3) return parkForReview(state, now);
  // Each authentication attempt runs in durable fresh-GET cycles bounded by the
  // configured checking interval plus jitter — no fixed total timeout.
  const cycleDeadline = new Date(Date.parse(now) + pollDelaySeconds(random, state.pollIntervalS) * 1000).toISOString();
  return { ...state, authentication: { tabId: null, phase: 'prepare', pending: false, purpose, startedAt: now,
      cycleStartedAt: now, cycleDeadline, submittedInCycle: false },
    sessionRenewals: state.sessionRenewals + (purpose === 'renew' ? 1 : 0),
    verification: purpose === 'verify' ? null : state.verification, loginFailed: false, authenticationError: null, authenticationFailureReason: null, manualAuthentication: false, nextPollAt: now, updatedAt: now };
}

export async function runAuthentication(deps: ExecDeps, initial: EngineState): Promise<EngineState> {
  let state = initial;
  let auth = state.authentication;
  if (!auth || !['running', 'verifying'].includes(state.status)) return state;
  // Runtime migration for saves that predate per-cycle deadlines.
  const migrated = migrateAuthCycle(auth, state.pollIntervalS);
  if (migrated !== auth) {
    state = { ...state, authentication: migrated };
    auth = migrated;
  }
  const now = deps.nowIso();
  // Bounded local developer diagnostics (fixed allowlisted codes only).
  // Best effort by contract: recording is fire-and-forget and never awaited,
  // never blocks, and never alters an engine or page action. Events carry the
  // run purpose/mode and the observed failure budget only — never
  // credentials, URLs, identifiers, page contents or raw errors.
  const note = (code: DiagnosticCode, rest: Omit<DiagnosticEvent, 'code' | 'purpose' | 'mode' | 'phase'> = {}): void => {
    // The cycle phase is always attached from the current cycle descriptor
    // (prepare/submit/wait/retry/cycle-wait) so post-run analysis can place
    // every validation branch, retry, cooldown and terminal transition in
    // its stage; it is a fixed allowlisted value, never page/state content.
    try { deps.recordDiagnostic?.({ code, purpose: auth!.purpose, mode: state.mode, phase: auth!.phase, ...rest }); } catch { /* Diagnostics never gate engine work. */ }
  };
  // The injected adapter returns fixed allowlisted validation-branch codes.
  // Page replies are never trusted verbatim: unknown or malformed values are
  // dropped instead of recorded.
  const detailOf = (result: { detail?: unknown } | null | undefined): DiagnosticDetail | undefined =>
    isDiagnosticDetail(result?.detail) ? result.detail : undefined;
  // A failed verification login (for example a closed authentication tab)
  // keeps the unresolved intent but would otherwise strand with no deadline
  // and no banner. Record the existing fixed unreadable reason so the panel
  // explains the parked check and an explicit Start resumes it; runs without
  // an intent keep their previous diagnostics. The retained fixed
  // identifier-free authentication failure reason records which check failed
  // for future diagnosis (developer state only, never product UI/copy, never
  // raw exceptions, URLs, credentials, identifiers or page contents).
  const fail = (reason: AuthenticationFailureReason, detail?: DiagnosticDetail): EngineState => {
    if (!isAuthenticationFailureReason(reason)) throw new Error('Invalid authentication diagnostic.');
    if (detail !== undefined && !isDiagnosticDetail(detail)) throw new Error('Invalid authentication diagnostic.');
    note('auth-terminal', { reason, failures: state.consecutiveFailures, ...(detail === undefined ? {} : { detail }) });
    return { ...state, status: state.intent ? 'verifying' : 'stopped', authentication: null,
      verification: null, nextPollAt: null, loginFailed: true, authenticationFailureReason: reason,
      ...(state.intent ? { verificationError: VERIFICATION_UNREADABLE } : {}), updatedAt: deps.nowIso() };
  };
  const pace = (): EngineState => ({ ...state, nextPollAt: new Date(Date.parse(deps.nowIso()) + 2_000).toISOString(), updatedAt: deps.nowIso() });
  // Recoverable transient failure on the authentication entry (unrecognized
  // reading, lost or malformed reply, script interruption, stalled load,
  // transport): count exactly one failure on the durable shared budget and
  // hold a retry at the configured checking interval plus jitter — or the
  // existing 30-minute cooldown after ten consecutive failures. The page is
  // never mutated here, the pending checkpoint is cleared so no interrupted
  // navigation is retried, and the next wake revalidates trust, group,
  // baseline/roster and the current configuration before any fill, click or
  // submit. An uncertain submit is never replayed by this path.
  const deferRecoverable = (detail: DiagnosticDetail): EngineState => {
    if (!isDiagnosticDetail(detail)) throw new Error('Invalid authentication diagnostic.');
    const next = applyPollResult(state, { outcome: 'retryable', now: deps.nowIso(), random: deps.random });
    const enteredCooldown = next.cooldownUntil !== null && next.cooldownUntil !== state.cooldownUntil;
    note(enteredCooldown ? 'auth-cooldown-entered' : 'auth-retry-scheduled', { detail, failures: next.consecutiveFailures });
    return { ...next,
      authentication: auth ? { ...auth, phase: 'retry' as const, pending: false, checkpoint: undefined } : null,
      loginFailed: false, authenticationError: null, authenticationFailureReason: null, manualAuthentication: false };
  };
  // A maintenance read may fail transiently on a still-trusted authentication
  // entry document (script interruption, overlay teardown mid-read, or a
  // redirect that settled back before the reply). Independently revalidate
  // configuration/cancellation and the live tab: the exact trusted entry
  // route with a trusted/quiet pending navigation holds a counted read-only
  // retry — nothing was mutated, the pending checkpoint is cleared, and the
  // next pass reclassifies the route and fully revalidates trust, group,
  // baseline/roster and configuration before any action. Offsite/unknown
  // URLs and lost custody keep the existing terminal refusal (null).
  const recoverableEntryRead = async (isTrustedEntry: (url: string | undefined) => boolean): Promise<EngineState | null> => {
    if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
    const tabId = state.authentication?.tabId;
    if (tabId === null || tabId === undefined) return fail('tab-unavailable');
    let live: Awaited<ReturnType<ExecDeps['getTab']>>;
    try { live = await deps.getTab(tabId); } catch { return fail('tab-unavailable'); }
    if (!isTrustedEntry(live.url) || !isTrustedRacePending(live.pendingUrl)) return null;
    note('auth-script-interrupted', { detail: 'script-interrupted' });
    return deferRecoverable('script-interrupted');
  };
  if (deps.isCancelled?.()) return fail('cancelled');
  if (auth.pending || Date.parse(now) < Date.parse(auth.startedAt) ||
      (state.intent && auth.purpose !== 'verify')) return fail('context-changed');
  const prefs = await deps.loadPrefs() as Preferences | undefined;
  try {
    // Verification resolves the ORIGINAL saved group even when booking
    // preferences were edited: a policy-key mismatch must not fail the
    // sign-in itself. Verification login needs valid current credentials
    // only, not whole booking configuration; later automatic failure
    // continuation requires unchanged configuration, while an explicit queued
    // Start may restart with the new valid configuration after the original
    // group is verified. Credentials are never stored in engine state.
    if (auth.purpose === 'verify') {
      if (!prefs || typeof prefs.email !== 'string' || prefs.email.length === 0 ||
          typeof prefs.password !== 'string' || prefs.password.length === 0) return fail('configuration-changed');
    } else if (!prefs || preferencesError(prefs) ||
        (state.policyKey !== null && state.policyKey !== policyKey(prefs as unknown as Record<string, unknown>))) return fail('configuration-changed');
  } catch { return fail('configuration-changed'); }
  const unchanged = async () => JSON.stringify(await deps.loadPrefs()) === JSON.stringify(prefs) && !deps.isCancelled?.();
  const deadline = engineAlarmAt(state);
  // Counted waits (cooldown/retry) and early cycle-waits hold their durable
  // deadlines: load events and early alarms cannot shorten them.
  if ((auth.phase === 'retry' || auth.phase === 'cycle-wait') && deadline && Date.parse(deadline) > Date.parse(now)) return state;
  const cycleDeadline = auth.cycleDeadline ?? new Date(Date.parse(auth.cycleStartedAt ?? auth.startedAt) + state.pollIntervalS * 1000).toISOString();
  const expired = Date.parse(now) >= Date.parse(cycleDeadline);
  if (auth.tabId === null) {
    if (state.cooldownUntil && Date.parse(state.cooldownUntil) > Date.parse(now)) return state;
    // No attempt has run yet in an unexpired cycle; an expiry with no tab
    // simply opens a fresh cycle instead of counting a failure.
    if (expired) {
      const fresh = new Date(Date.parse(now) + pollDelaySeconds(deps.random, state.pollIntervalS) * 1000).toISOString();
      auth = { ...auth, cycleStartedAt: now, cycleDeadline: fresh, submittedInCycle: false };
      state = { ...state, authentication: auth };
    }
    const ownedTabId = auth.purpose === 'renew'
      ? (state.mode === 'booking' ? state.executor?.tabId : state.monitorTabId) : null;
    if (ownedTabId !== null && ownedTabId !== undefined) {
      const trusted = (tab: Awaited<ReturnType<ExecDeps['getTab']>>) => trustedRenewalUrl(state, tab.url) &&
        (!tab.pendingUrl || trustedRenewalUrl(state, tab.pendingUrl));
      try {
        const owned = await deps.getTab(ownedTabId);
        if (!trusted(owned)) return fail('untrusted-navigation');
        if (!deps.navigateTab) return fail('navigation-failed');
        if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
        state = { ...state, authentication: { ...auth, tabId: ownedTabId, pending: true, checkpoint: 'navigation' }, updatedAt: deps.nowIso() };
        await deps.saveState(state);
        const live = await deps.getTab(ownedTabId);
        if (!trusted(live)) return fail('untrusted-navigation');
        if (live.url !== owned.url || live.pendingUrl !== owned.pendingUrl) {
          // Trusted in-progress navigation on the owned renewal tab: the page
          // redirected between the two live reads. Never act on the raced
          // checkpoint; clear it durably and recover on the counted retry
          // budget. The next pass re-resolves and fully revalidates the owned
          // tab (trust, group, baseline/roster, current configuration) before
          // any fill, click or submit.
          const next = deferRecoverable('trusted-progress');
          await deps.saveState(next);
          return next;
        }
        if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
        await deps.navigateTab(ownedTabId, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
        state = { ...state, authentication: { ...state.authentication!, pending: false, checkpoint: undefined } };
        return pace();
      } catch { return fail('tab-unavailable'); }
    }
    const existing = auth.purpose === 'start' ? (await deps.queryTabs()).filter(tab => classifyRoute(tab.url ?? '') === 'login') : [];
    if (existing.length > 1) return fail('untrusted-navigation');
    // Start tries the fixed site root first to reuse a valid profile
    // session (it redirects to the account dashboard when signed in; a
    // signed-out clean landing advances promptly to sign-in). Renew and
    // verify keep the direct sign-in entry; the bare dashboard route 403s,
    // so a signed-out run never parks on the public welcome landing. A
    // signed-in cookie still resolves through the dashboard handler with
    // zero credential fill or login submission.
    const startRoot = 'https://ais.usvisa-info.com/en-ca/niv/';
    const tab = existing[0] ?? await deps.createTab(auth.purpose === 'start' ? startRoot : 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    if (tab.id === undefined) return fail('tab-unavailable');
    state = { ...state, authentication: { ...auth, tabId: tab.id } };
    return pace();
  }
  let tab;
  try { tab = await deps.getTab(auth.tabId); } catch { return fail('tab-unavailable'); }
  // Fixed approved recovery target for every purpose: the official sign-in
  // page (cookies are shared profile-wide). Browser-side navigation is itself
  // a GET, so an interrupted POST is never replayed. Start's initial entry
  // is the site root (dashboard-first); recovery still falls back here.
  const fixedTarget = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
  const startRoot = 'https://ais.usvisa-info.com/en-ca/niv/';
  const cleanUrl = (value: string | undefined): URL | null => {
    try {
      const parsed = new URL(value ?? '');
      if (parsed.origin !== SITE_ORIGIN || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
      return parsed;
    } catch { return null; }
  };
  // Exact supported authentication routes for stalled-load recovery: the fixed
  // root/login/dashboard identity plus the evidenced Start account page. Query,
  // fragment, authority-bearing and unknown same-origin URLs never navigate.
  const supportedStalledPath = (pathname: string): boolean => {
    if (pathname === '/en-ca/niv/users/sign_in') return true;
    if (pathname === '/en-ca/niv' || pathname === '/en-ca/niv/') return true;
    if (pathname === '/en-ca/niv/groups' || /^\/en-ca\/niv\/groups\/[0-9]+$/.test(pathname)) return true;
    if (auth.purpose === 'start' && (pathname === '/en-ca/niv/account' || pathname === '/en-ca/niv/account/')) return true;
    return false;
  };
  // Validates BOTH the live URL and the pending navigation URL when present.
  // An extension-created blank tab is only safe with an independently trusted
  // expected pending URL (exactly the fixed recovery target, plus the Start
  // site-root entry for dashboard-first fresh tabs); it is never
  // broadly allowed.
  const stalledUrlsTrusted = (liveUrl: string | undefined, pendingUrl: string | undefined): boolean => {
    const pending = pendingUrl ?? '';
    if (liveUrl === 'about:blank') return pending === fixedTarget ||
      (auth.purpose === 'start' && pending === startRoot);
    const live = cleanUrl(liveUrl);
    if (!live || !supportedStalledPath(live.pathname)) return false;
    if (pending === '' || pending === 'about:blank') return true;
    const pendingParsed = cleanUrl(pending);
    if (!pendingParsed || !supportedStalledPath(pendingParsed.pathname)) return false;
    return true;
  };
  // Narrow trusted URL helpers for redirect-race pacing. Every check requires
  // the exact HTTPS origin with no credentials/port and no query/fragment;
  // unknown same-origin paths and offsite URLs never pace.
  const trustedDashboardUrl = (value: string | undefined): boolean => {
    const parsed = cleanUrl(value);
    if (!parsed) return false;
    return parsed.pathname === '/en-ca/niv/groups' || /^\/en-ca\/niv\/groups\/[0-9]+$/.test(parsed.pathname);
  };
  const trustedRootUrl = (value: string | undefined): boolean => {
    const parsed = cleanUrl(value);
    if (!parsed) return false;
    return parsed.pathname === '/en-ca/niv' || parsed.pathname === '/en-ca/niv/';
  };
  const trustedLoginUrl = (value: string | undefined): boolean => {
    const parsed = cleanUrl(value);
    if (!parsed) return false;
    return parsed.pathname === '/en-ca/niv/users/sign_in';
  };
  // Landing redirect race: a snapshot clean completed root may redirect to the
  // trusted dashboard or begin loading between the snapshot read and the
  // checkpointed browser navigation. Pace trusted in-progress navigation
  // instead of failing or overriding it. Untrusted/offsite/unknown routes,
  // query/fragment URLs, and missing navigation support remain refusal.
  const landingRedirectWait = (live: { url?: string; status?: string; pendingUrl?: string }): 'wait' | 'proceed' | 'fail' => {
    if (live.status === 'loading') return stalledUrlsTrusted(live.url, live.pendingUrl) ? 'wait' : 'fail';
    if (live.url !== tab.url) {
      if (trustedDashboardUrl(live.url) || trustedLoginUrl(live.url)) return 'wait';
      if (trustedRootUrl(live.url)) return 'proceed';
      return 'fail';
    }
    const pending = live.pendingUrl ?? '';
    if (pending === '' || pending === 'about:blank') return 'proceed';
    if (trustedDashboardUrl(pending) || trustedRootUrl(pending) || trustedLoginUrl(pending)) return 'wait';
    return 'fail';
  };
  // En-route Start: background navigated a reused flow tab to the fixed site
  // root but the document has not committed yet. Only when the independently
  // observed pendingUrl is EXACTLY the fixed site root (or its clean trusted
  // dashboard redirect) and the live origin is trustworthy, wait without any
  // DOM injection/credentials until navigation finishes or the cycle budget
  // expires. No pending URL keeps the existing refusal; untrusted pending
  // URLs fail closed with no reads/actions.
  const enRouteStartPending = (live: { url?: string; pendingUrl?: string }): boolean => {
    if (auth.purpose !== 'start') return false;
    const pending = live.pendingUrl ?? '';
    const isRoot = pending === startRoot;
    let isDashboard = false;
    if (!isRoot) {
      if (pending === '' || pending === 'about:blank') return false;
      if (!trustedDashboardUrl(pending)) return false;
      isDashboard = true;
    }
    let liveParsed: URL | null = null;
    try { liveParsed = new URL(live.url ?? ''); } catch { return false; }
    if (!liveParsed || liveParsed.origin !== SITE_ORIGIN || liveParsed.username ||
        liveParsed.password || liveParsed.port || liveParsed.search || liveParsed.hash) return false;
    return isRoot || isDashboard;
  };
  // A stalled load counts exactly once per configured cycle and recovers
  // through a checkpointed browser-side navigation of the validated owned tab
  // to a fixed approved target — never DOM injection into the loading tab and
  // never a POST replay. A counted retry wait holds its durable deadline
  // instead: it resumes with a fresh GET once the tab completes.
  const expireStalledLoad = async (currentUrl: string, currentPending?: string): Promise<EngineState> => {
    try {
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== currentUrl || (live.pendingUrl ?? undefined) !== (currentPending ?? undefined) || live.status !== 'loading') return pace();
      if (!stalledUrlsTrusted(live.url, live.pendingUrl)) return fail('untrusted-navigation');
    } catch { return fail('tab-unavailable'); }
    const cooled = state.cooldownUntil !== null && Date.parse(state.cooldownUntil) <= Date.parse(now);
    const failures = countFailure(cooled ? 0 : state.consecutiveFailures);
    if (shouldCooldown(failures, SETUP_FAILURE_COOLDOWN_AFTER)) {
      const cooldownUntil = new Date(cooldownUntilSeconds(Math.floor(Date.parse(now) / 1000)) * 1000).toISOString();
      note('auth-cooldown-entered', { detail: 'stalled-load', failures });
      return { ...state, consecutiveFailures: failures, cooldownUntil, nextPollAt: null,
        authentication: { ...auth, phase: 'retry', pending: false, checkpoint: undefined }, updatedAt: now };
    }
    note('auth-retry-scheduled', { detail: 'stalled-load', failures });
    // Durable mutation checkpoint: pending=true commits before any browser
    // navigation and clears only after the navigation succeeds. An interrupted
    // checkpoint keeps pending=true and parks on worker wake via the existing
    // startup reconciliation; a navigation error stays safe and never replays
    // a POST.
    const rolled = { ...state, consecutiveFailures: failures, cooldownUntil: null,
      authentication: rollAuthCycle({ ...auth, phase: 'prepare', pending: true, checkpoint: 'navigation' }, now, deps.random, state.pollIntervalS),
      updatedAt: now };
    await deps.saveState(rolled);
    state = { ...rolled };
    try {
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== currentUrl || (live.pendingUrl ?? undefined) !== (currentPending ?? undefined) || live.status !== 'loading') return pace();
      if (!stalledUrlsTrusted(live.url, live.pendingUrl)) return fail('untrusted-navigation');
      if (deps.navigateTab) await deps.navigateTab(auth.tabId!, fixedTarget);
    } catch { return fail('tab-unavailable'); }
    state = { ...state, authentication: { ...state.authentication!, pending: false, checkpoint: undefined } };
    return pace();
  };
  // A due counted-retry or expired-cooldown wait resumes while the tab is
  // still loading: checkpoint a fresh browser-side GET to the same fixed
  // target and roll a fresh cycle WITHOUT recounting the existing failure.
  // An expired cooldown resets its failure budget; a subsequent full cycle
  // that is still loading counts once and retries, so ten new failures
  // earn a fresh cooldown. No short overdue loops: the durable deadline
  // always advances.
  const resumeRetryLoad = async (currentUrl: string, currentPending?: string): Promise<EngineState> => {
    try {
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== currentUrl || (live.pendingUrl ?? undefined) !== (currentPending ?? undefined) || live.status !== 'loading') return pace();
      if (!stalledUrlsTrusted(live.url, live.pendingUrl)) return fail('untrusted-navigation');
    } catch { return fail('tab-unavailable'); }
    const cooled = state.cooldownUntil !== null && Date.parse(state.cooldownUntil) <= Date.parse(now);
    const rolled = { ...state, consecutiveFailures: cooled ? 0 : state.consecutiveFailures, cooldownUntil: null,
      authentication: rollAuthCycle({ ...auth, phase: 'prepare', pending: true, checkpoint: 'navigation' }, now, deps.random, state.pollIntervalS),
      updatedAt: now };
    await deps.saveState(rolled);
    state = { ...rolled };
    try {
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== currentUrl || (live.pendingUrl ?? undefined) !== (currentPending ?? undefined) || live.status !== 'loading') return pace();
      if (!stalledUrlsTrusted(live.url, live.pendingUrl)) return fail('untrusted-navigation');
      if (deps.navigateTab) await deps.navigateTab(auth.tabId!, fixedTarget);
    } catch { return fail('tab-unavailable'); }
    state = { ...state, authentication: { ...state.authentication!, pending: false, checkpoint: undefined } };
    return pace();
  };
  if (tab.status === 'loading') {
    // Loading delays injection but never suppresses cycle-expiry accounting:
    // an overdue cycle advances its durable deadline instead of busy-looping
    // on short timers, and a cycle-wait overdue state cannot livelock. A due
    // retry/cooldown wait resumes with a checkpointed fresh GET instead of
    // pacing on short timers forever.
    if (expired && auth.phase !== 'retry') return expireStalledLoad(tab.url ?? '', tab.pendingUrl);
    if (auth.phase === 'cycle-wait') return state;
    if (auth.phase === 'retry') {
      if (deadline && Date.parse(deadline) > Date.parse(now)) return state;
      return resumeRetryLoad(tab.url ?? '', tab.pendingUrl);
    }
    return pace();
  }
  const route = classifyRoute(tab.url ?? '');
  const siteTab = (() => {
    try {
      const current = new URL(tab.url ?? '');
      return current.origin === SITE_ORIGIN && !current.username && !current.password && !current.port;
    } catch { return false; }
  })();
  const inject = async (func: (...args: never[]) => unknown, args: unknown[]) => {
    const current = await deps.getTab(auth.tabId!);
    if (current.url !== tab.url || current.status === 'loading' || !await unchanged()) throw new Error('Authentication context changed.');
    return deps.inject(auth.tabId!, func, args);
  };
  // A page-side location.replace can destroy its execution context before
  // executeScript delivers the reply, turning a successful GET into a false
  // login failure. Loaded-page retries use the browser API like stalled-load
  // recovery. Callers durably checkpoint pending=true before reaching here.
  // The result separates benign races (the tab already moved to another
  // trusted route or is still loading) from terminal custody/cancellation
  // failures so an interrupted retry never stops the run or double-counts.
  type FreshGetResult = 'ok' | 'retry' | 'cancelled' | 'configuration-changed' | 'navigation-failed' | 'untrusted-navigation';
  // The live document must be a caller-validated fresh-GET target, or the
  // snapshot route itself while its pending navigation stays trusted (an
  // en-route appointment/payment page is held for the next cycle instead of
  // being reloaded). Anything else is an untrusted navigation and stays
  // terminal; a quiet pending URL is limited to the supported stalled paths.
  const trustedLiveForFreshGet = (liveUrl: string | undefined, pendingUrl: string | undefined): boolean => {
    if (stalledUrlsTrusted(liveUrl, pendingUrl)) return true;
    const live = cleanUrl(liveUrl);
    if (!live || liveUrl !== tab.url) return false;
    const pending = pendingUrl ?? '';
    if (pending === '' || pending === 'about:blank') return true;
    const parsed = cleanUrl(pending);
    return !!parsed && supportedStalledPath(parsed.pathname);
  };
  const freshGet = async (): Promise<FreshGetResult> => {
    if (!deps.navigateTab) return 'navigation-failed';
    if (!await unchanged()) return deps.isCancelled?.() ? 'cancelled' : 'configuration-changed';
    const live = await deps.getTab(auth.tabId!);
    if (!trustedLiveForFreshGet(live.url, live.pendingUrl)) return 'untrusted-navigation';
    if (live.url !== tab.url || live.status === 'loading') return 'retry';
    const target = cleanUrl(live.url);
    if (!target || !supportedStalledPath(target.pathname)) return 'retry';
    if (!await unchanged()) return deps.isCancelled?.() ? 'cancelled' : 'configuration-changed';
    await deps.navigateTab(auth.tabId!, target.href);
    return 'ok';
  };
  // An expired cycle counts exactly ONE failure and — unless the setup budget
  // is exhausted — starts the next fresh-GET cycle immediately with no
  // additional full interval. A trustworthy dashboard already had its chance
  // above, so only non-dashboard routes arrive here.
  const expireCycle = async (detail: DiagnosticDetail = 'reply-malformed'): Promise<EngineState> => {
    const cooled = state.cooldownUntil !== null && Date.parse(state.cooldownUntil) <= Date.parse(now);
    const failures = countFailure(cooled ? 0 : state.consecutiveFailures);
    if (shouldCooldown(failures, SETUP_FAILURE_COOLDOWN_AFTER)) {
      const cooldownUntil = new Date(cooldownUntilSeconds(Math.floor(Date.parse(now) / 1000)) * 1000).toISOString();
      note('auth-cooldown-entered', { detail, failures });
      return { ...state, consecutiveFailures: failures, cooldownUntil, nextPollAt: null,
        authentication: { ...auth, phase: 'retry', pending: false, checkpoint: undefined }, updatedAt: now };
    }
    note('auth-cycle-expired', { detail, failures });
    const rolled = { ...state, consecutiveFailures: failures, cooldownUntil: null,
      authentication: rollAuthCycle({ ...auth, phase: 'prepare', pending: true, checkpoint: 'navigation' }, now, deps.random, state.pollIntervalS),
      updatedAt: now };
    await deps.saveState(rolled);
    state = rolled;
    try {
      const result = await freshGet();
      // A benign race (moved to another trusted route or still loading) holds
      // the rolled cycle's durable deadline as a retry: the counted failure
      // already committed and is never double-counted, and the next pass
      // revalidates before any action. Cancellation/configuration, missing
      // navigation and untrusted live URLs stay terminal.
      if (result === 'retry') return holdRolledCycle();
      if (result !== 'ok') return fail(result);
    } catch { return fail('tab-unavailable'); }
    state = { ...rolled, authentication: { ...rolled.authentication!, pending: false, checkpoint: undefined } };
    return { ...state, nextPollAt: new Date(Date.parse(deps.nowIso()) + 2_000).toISOString(), updatedAt: deps.nowIso() };
  };
  // Holds an already-rolled cycle as a counted retry whose durable deadline is
  // the rolled cycle's own deadline (never shortened by load events): the
  // failure was counted when the cycle rolled, the pending browser-GET
  // checkpoint is cleared, and the next wake revalidates trust, group,
  // baseline/roster and configuration before any action.
  const holdRolledCycle = async (): Promise<EngineState> => {
    const held = { ...state,
      authentication: { ...state.authentication!, phase: 'retry' as const, pending: false, checkpoint: undefined },
      nextPollAt: state.authentication!.cycleDeadline ?? new Date(Date.parse(deps.nowIso()) + pollDelaySeconds(deps.random, state.pollIntervalS) * 1000).toISOString(),
      updatedAt: deps.nowIso() };
    await deps.saveState(held);
    state = held;
    return held;
  };
  // Retry-phase resume: roll a fresh cycle with the durable browser-side GET
  // checkpoint, then run the fresh GET. Benign races hold the rolled cycle;
  // terminal results keep their fixed reasons.
  const resumeRetryCycle = async (): Promise<EngineState> => {
    state = { ...state, authentication: rollAuthCycle({ ...state.authentication!, phase: 'prepare', pending: true, checkpoint: 'navigation', startedAt: now }, now, deps.random, state.pollIntervalS), updatedAt: now };
    await deps.saveState(state);
    let result: FreshGetResult;
    try { result = await freshGet(); } catch { return fail('tab-unavailable'); }
    if (result === 'retry') return holdRolledCycle();
    if (result !== 'ok') return fail(result);
    state = { ...state, authentication: { ...state.authentication!, pending: false, checkpoint: undefined } };
    return pace();
  };
  // Narrow login-to-dashboard navigation-race recovery: a snapshot exact
  // official login may auto-navigate toward the trusted dashboard before the
  // injection replies (guard throws, or the redirect destroys the reply).
  // Only independently validated login-to-dashboard progress paces instead
  // of failing; same-document reads stay fail-closed. Strict exact origin,
  // no query/fragment, exact paths with saved dashboard custody; live and
  // pending URLs plus settings/cancellation rechecked; never message URLs.
  // Fresh dashboard group/baseline/roster validation still gates
  // continuation; intent stays verification-only. Cycle deadlines,
  // single-submit and retry/cooldown/renewal budgets are unchanged: expiry
  // counts via the existing budgets with fixed-sign-in recovery for every
  // purpose, rejection/challenge is never cleared, and no POST is replayed
  // nor any fill/submit repeated due solely to a lost reply.
  const isExactLoginUrl = (value: string | undefined): boolean => {
    const parsed = cleanUrl(value);
    return !!parsed && parsed.pathname === '/en-ca/niv/users/sign_in';
  };
  const isTrustedDashboardForRace = (value: string | undefined): boolean => {
    const parsed = cleanUrl(value);
    if (!parsed) return false;
    if (parsed.pathname !== '/en-ca/niv/groups' && !/^\/en-ca\/niv\/groups\/[0-9]+$/.test(parsed.pathname)) return false;
    const saved = state.group?.dashboardPath;
    if (saved) return parsed.pathname === saved;
    return true;
  };
  const isTrustedRacePending = (value: string | undefined): boolean => {
    const pending = value ?? '';
    if (pending === '' || pending === 'about:blank') return true;
    return isExactLoginUrl(pending) || isTrustedDashboardForRace(pending);
  };
  // Validated progress paces without injecting or resetting the deadline;
  // expiry uses the existing checkpointed GET recovery. Otherwise fail closed.
  const paceLoginToDashboardRace = async (snapshotUrl: string | undefined): Promise<EngineState | null> => {
    if (!isExactLoginUrl(snapshotUrl)) return null;
    let live: Awaited<ReturnType<ExecDeps['getTab']>>;
    try {
      if (!await unchanged()) return null;
      live = await deps.getTab(auth.tabId!);
    } catch { return null; }
    if (!await unchanged()) return null;
    if (!isTrustedRacePending(live.pendingUrl)) return null;
    const liveIsLogin = isExactLoginUrl(live.url);
    const liveIsDashboard = isTrustedDashboardForRace(live.url);
    if (!liveIsLogin && !liveIsDashboard) return null;
    // Same-document (no progress) stays fail-closed: only loading or a
    // changed URL toward the trusted dashboard paces.
    const sameDocument = (live.url ?? '') === (snapshotUrl ?? '') && (live.pendingUrl ?? '') === '';
    if (sameDocument && live.status !== 'loading') return null;
    // Resolves only the checkpoint this race just validated: read-only races
    // hold none and pace in memory, while the submit path clears its
    // pending=true checkpoint durably and in memory, marks the cycle
    // submitted and continues read-only so a bounce back to login cannot
    // replay the POST (or repeat the fill) within this cycle. Clearing never
    // authorizes a replay, and an interrupted clear keeps the saved pending
    // checkpoint; worker-wake recovery consumes its submit allowance and
    // continues read-only. Null returns stop safely below
    // with no further injection or navigation.
    const settlePending = async (): Promise<EngineState | null> => {
      if (!state.authentication?.pending) {
        note('auth-redirect-progress', { detail: 'trusted-progress' });
        return pace();
      }
      if (!await unchanged()) return null;
      const cleared = { ...state, authentication: { ...state.authentication!,
        pending: false, checkpoint: undefined, submittedInCycle: true, phase: 'wait' as const }, updatedAt: deps.nowIso() };
      await deps.saveState(cleared);
      state = cleared;
      note('auth-redirect-progress', { detail: 'trusted-progress' });
      return pace();
    };
    // Expired races use fixed-sign-in stalled recovery for every purpose. A
    // loading-to-complete race paces inside the helper with the checkpoint
    // still set, so clear it here and never return pending with a deadline.
    const settleStalled = async (currentUrl: string, currentPending?: string): Promise<EngineState | null> => {
      const stalled = await expireStalledLoad(currentUrl, currentPending);
      if (!stalled.authentication?.pending) return stalled;
      state = stalled;
      return settlePending();
    };
    if (liveIsLogin && !liveIsDashboard) {
      // Same-login progress is only an independently observed trusted
      // dashboard pending navigation. Ambiguous reloads stay fail-closed to
      // preserve the injection guard; expiry counts via the existing budgets
      // instead of pacing a stale redirect.
      const pendingIsDashboard = isTrustedDashboardForRace(live.pendingUrl) &&
        (live.pendingUrl ?? '') !== '' && (live.pendingUrl ?? '') !== 'about:blank';
      if (!pendingIsDashboard) return null;
      if (expired) {
        if (live.status === 'loading') return settleStalled(live.url ?? '', live.pendingUrl);
        return expireCycle();
      }
      return settlePending();
    }
    // Validated login-to-dashboard progress. A complete dashboard paces once
    // (even past expiry) so the next pass freshly binds group/baseline/roster
    // with zero POSTs; an expired loading dashboard counts via fixed-sign-in
    // stalled recovery, never a same-dashboard GET.
    if (live.status === 'loading') {
      if (!expired) return settlePending();
      return settleStalled(live.url ?? '', live.pendingUrl);
    }
    return settlePending();
  };
  // Diagnostic specificity for a refused login race: settings/cancellation,
  // lost tab and untrusted navigation keep their fixed reasons instead of a
  // generic context change. Only validated progress above paces; everything
  // else fails closed here.
  const failRaceClosed = async (): Promise<EngineState> => {
    try {
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      const live = await deps.getTab(auth.tabId!);
      if (!isTrustedRacePending(live.pendingUrl) ||
          (!isExactLoginUrl(live.url) && !isTrustedDashboardForRace(live.url))) {
        return fail('untrusted-navigation');
      }
    } catch {
      return fail('tab-unavailable');
    }
    return fail('context-changed');
  };
  // Validate the exact authentication route before inspecting the document;
  // outage retries cannot confer trust on an unexpected page or group.
  if (['login', 'landing', 'dashboard'].includes(route)) {
    const url = new URL(tab.url!);
    if (url.search || url.hash) return fail('untrusted-navigation');
    if (auth.phase === 'retry') return resumeRetryCycle();
    // Landing redirect race: a snapshot clean completed root may have
    // redirected to the trusted dashboard (or begun loading) before the
    // maintenance read. Never inject into a changed/untrusted document; pace
    // trusted in-progress navigation instead of failing. Untrusted URLs and
    // configuration/cancellation remain refusal.
    if (route === 'landing') {
      try {
        const live = await deps.getTab(auth.tabId!);
        if (live.url !== tab.url || live.status === 'loading' ||
            (live.pendingUrl !== undefined && live.pendingUrl !== '' && live.pendingUrl !== 'about:blank')) {
          const decision = landingRedirectWait(live);
          if (decision === 'wait') {
            if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
            if (expired) {
              // Bounded trusted wait: a completed same-root snapshot with a
              // trusted pending redirect counts one expiry failure/fresh GET
              // instead of pacing forever; a progressed completed trusted
              // dashboard still paces so the next pass binds it; loading uses
              // the existing stalled-load budget. No trust expansion.
              if (live.status === 'loading') return expireStalledLoad(live.url ?? '', live.pendingUrl);
              if ((live.url ?? '') !== (tab.url ?? '')) return pace();
              return expireCycle();
            }
            return pace();
          }
          if (decision === 'fail') return fail('untrusted-navigation');
        }
      } catch { return fail('tab-unavailable'); }
    }
    try {
      const result = await inject(readSiteMaintenance, [true]) as { maintenance?: unknown } | undefined;
      if (result?.maintenance === true) {
        note('auth-maintenance', { detail: 'maintenance' });
        return deferAuthenticationForMaintenance(state, now, deps.random);
      }
    } catch {
      // A trusted root-to-dashboard change before the injection throws via the
      // snapshot-URL guard without injecting. Pace it instead of failing. The
      // same narrow recovery applies to an exact-login-to-trusted-dashboard
      // redirect race (the probable October 15 live pause). A same-document
      // transient failure on the still-loaded exact login or clean root is
      // revalidated and held as a counted read-only retry; untrusted/unknown
      // live documents and lost custody stay fail-closed.
      if (route === 'landing') {
        let live: Awaited<ReturnType<ExecDeps['getTab']>>;
        try { live = await deps.getTab(auth.tabId!); } catch { return fail('tab-unavailable'); }
        if (landingRedirectWait(live) === 'wait') {
          if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
          if (expired) {
            if (live.status === 'loading') return expireStalledLoad(live.url ?? '', live.pendingUrl);
            if ((live.url ?? '') !== (tab.url ?? '')) return pace();
            return expireCycle();
          }
          return pace();
        }
        // The exact clean root snapshot is still the live document (decision
        // 'proceed'): a transient maintenance-read failure is recoverable on
        // the counted read-only retry budget. Untrusted/unknown live documents
        // keep the existing refusal below.
        const recovered = await recoverableEntryRead(trustedRootUrl);
        if (recovered) return recovered;
        return fail('context-changed');
      }
      if (route === 'login') {
        try {
          const raced = await paceLoginToDashboardRace(tab.url);
          if (raced) return raced;
        } catch { /* Fall through to the validated retry below. */ }
        const recovered = await recoverableEntryRead(isExactLoginUrl);
        if (recovered) return recovered;
        return failRaceClosed();
      }
      // Dashboard maintenance-inject failure on an already-validated trusted
      // dashboard: a transient injection interruption (overlay removal
      // mid-read, session redirect, lost reply) recovers on the counted retry
      // budget after re-confirming configuration/cancellation. The next pass
      // reclassifies the live route and fully revalidates trust, group and
      // baseline before any action; untrusted URLs never reach here.
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      return deferRecoverable('script-interrupted');
    }
  } else if (siteTab && auth.purpose === 'start') {
    // A reused same-origin page (for example /account serving a Doing
    // Maintenance document) is en route to identity resolution through the
    // Start navigation to the site root. Check the strict outage document
    // first so maintenance refreshes on budget instead of failing, otherwise
    // wait for that navigation within the bounded attempt. Renew and verify
    // stay strict and fall through to the failure below.
    //
    // Reads stay on evidenced routes only: the fresh-GET allow-list plus the
    // same-group payment page Start reuses en route. Query/fragment URLs and
    // unknown same-origin paths inject nothing and fail closed.
    const current = (() => { try { return new URL(tab.url!); } catch { return null; } })();
    if (!current || current.search || current.hash) return fail('untrusted-navigation');
    if (!/^\/en-ca\/niv(?:\/?|\/users\/sign_in|\/groups(?:\/[0-9]+)?|\/account\/?)$/.test(current.pathname) &&
        !/^\/en-ca\/niv\/schedule\/[0-9]+\/payment$/.test(current.pathname)) {
      // Narrow en-route Start: background navigated this reused flow tab to the
      // fixed site root but the document has not committed yet. Only an
      // independently observed EXACT fixed-root (or clean trusted dashboard
      // redirect) pending URL with a trustworthy live origin waits without any
      // DOM injection/credentials; all other paths keep the existing refusal.
      // No pending URL keeps refusal; untrusted pending fails closed.
      try {
        const live = await deps.getTab(auth.tabId!);
        if (enRouteStartPending(live)) {
          if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
          if (expired) return expireCycle();
          return pace();
        }
      } catch { return fail('tab-unavailable'); }
      return fail('untrusted-navigation');
    }
    if (auth.phase === 'retry') {
      const retrying = (() => { try { return new URL(tab.url!); } catch { return null; } })();
      if (!retrying || retrying.search || retrying.hash) return fail('untrusted-navigation');
      return resumeRetryCycle();
    }
    try {
      const result = await inject(readSiteMaintenance, [true]) as { maintenance?: unknown } | undefined;
      if (result?.maintenance === true) {
        note('auth-maintenance', { detail: 'maintenance' });
        return deferAuthenticationForMaintenance(state, now, deps.random);
      }
    } catch {
      try {
        const raced = await paceLoginToDashboardRace(tab.url);
        if (raced) return raced;
      } catch { /* Fall through to refusal below. */ }
      return failRaceClosed();
    }
    if (expired) return expireCycle();
    return pace();
  } else if (auth.phase === 'retry') return fail('untrusted-navigation');
  if (route === 'dashboard') {
    let readStep: PanelReadStep = 'groups';
    // Terminal classification for a fresh trusted dashboard reading: the
    // selection itself cannot resolve (fixed resolveGroup refusal messages) or
    // the bound identity changed (sentinel below). Those need a configured
    // correction; every other error here is a transient malformed reading or an
    // interrupted injection and recovers on the counted retry budget with a
    // full revalidation pass before any action. No page is ever mutated by
    // either path.
    const GROUP_MISMATCHES = new Set([
      'No dashboard group to bind.',
      'Paid group not found on the dashboard.',
      'No eligible paid group on the dashboard.',
      'Unpaid group rejected for paid booking.',
      'Unpaid group not found on the dashboard.',
      'No eligible unpaid group on the dashboard.',
      'Paid group rejected for unpaid tracking.',
      'Invalid group binding.',
      'Invalid dashboard path.',
    ]);
    const dashboardFailure = (error: unknown, detail: DiagnosticDetail): EngineState => ({ ...fail('unrecognized-reading', detail),
      loginFailed: false, authenticationFailureReason: null, authenticationError: panelCommandError(error, readStep) });
    try {
      const dashboardPath = new URL(tab.url!).pathname;
      const raw = await inject(readDashboardGroups, []);
      // Verification resolves the ORIGINAL saved group by exact schedule AND
      // IVR, never via current booking preferences and never by borrowing a
      // sibling/historical card. The old complete roster is NOT required to
      // authenticate verification; later outcome classification is roster
      // relaxed while renewal and booking paths stay strict.
      if (auth.purpose === 'verify') {
        if (!state.group) return dashboardFailure(new Error('Authenticated group changed.'), 'group-changed');
        const snapshot = validateDashboardSnapshot(raw as never);
        const found = snapshot.groups.find(group => group.scheduleId === state.group!.scheduleId && group.ivr === state.group!.ivr);
        if (!found) return dashboardFailure(new Error('Authenticated group changed.'), 'group-changed');
        if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
        if (state.consecutiveFailures > 0) note('auth-recovered', { outcome: 'healthy', failures: 0 });
        return { ...state, authentication: null, authenticationFailureReason: null, verificationTabId: auth.tabId, verification: { reads: [], nextReadAt: deps.nowIso() },
          consecutiveFailures: 0, cooldownUntil: null, nextPollAt: null, updatedAt: deps.nowIso() };
      }
      readStep = 'selection';
      const match = resolveGroup(raw as never, { mode: state.mode, paidIvr: prefs.paidIvr, unpaidIvr: prefs.unpaidIvr });
      let currentDate: string | null = null;
      let applicantIds: string[] | undefined;
      if (state.mode === 'booking') {
        readStep = 'appointment';
        const baseline = await inject(readCurrentAppointment, [match.scheduleId, match.ivr, false, true, dashboardPath]);
        currentDate = appointmentDate(baseline, match);
        readStep = 'applicants';
        applicantIds = appointmentApplicants(baseline);
      }
      // The combined identity check is split into group / roster / baseline so
      // the retained terminal diagnostic records exactly which identity moved.
      if (state.group && (state.group.scheduleId !== match.scheduleId || state.group.ivr !== match.ivr))
        return dashboardFailure(new Error('Authenticated group changed.'), 'group-changed');
      if (state.group?.applicantIds && !sameApplicants(state.group.applicantIds, applicantIds))
        return dashboardFailure(new Error('Authenticated group changed.'), 'roster-changed');
      if (state.group && state.group.currentDate !== currentDate)
        return dashboardFailure(new Error('Authenticated group changed.'), 'baseline-changed');
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      if (!state.group) state = bindGroup(state, { owner: state.owner!, runId: state.runId!, now: deps.nowIso(),
        binding: { ...match, kind: state.mode === 'booking' ? 'paid' : 'unpaid', currentDate, dashboardPath, ...(applicantIds ? { applicantIds } : {}) } });
      if (state.consecutiveFailures > 0) note('auth-recovered', { outcome: 'healthy', failures: 0 });
      state = { ...state, authentication: null, authenticationFailureReason: null, executor: null, stage: null, lastCandidate: null, startedAt: deps.nowIso(),
        group: state.group ? { ...state.group, dashboardPath } : null,
        // Successful, fully revalidated renewals do not consume a lifetime
        // run budget. Unsuccessful renewal starts remain bounded at three.
        sessionRenewals: 0, consecutiveFailures: 0, cooldownUntil: null, updatedAt: deps.nowIso() };
      if (state.mode === 'booking') state = { ...state, stage: 'actions',
        executor: { tabId: auth.tabId, applicantIds: applicantIds!, targetTime: null, skippedDates: [], actionPending: false } };
      return paceWithPolicy(state, prefs, deps.nowIso());
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      if (message === 'Applicant roster changed.') return dashboardFailure(error, 'roster-changed');
      if (message === 'Appointment identity changed.') return dashboardFailure(error, 'group-changed');
      if (message === 'Authenticated group changed.' || GROUP_MISMATCHES.has(message))
        return dashboardFailure(error, 'group-changed');
      if (message === 'Authentication context changed.') return deferRecoverable('script-interrupted');
      return deferRecoverable('reply-malformed');
    }
  }
  if (route === 'landing') {
    // The site root redirects to the dashboard when signed in. Every purpose
    // leaves a fully loaded clean landing page for the fixed official sign-in
    // URL in the same tab (checkpointed browser navigation, single submit per
    // cycle) instead of parking on the public welcome page waiting for a
    // manual Sign In click: the loading case above already excluded an
    // in-flight redirect, and maintenance was already checked, so a complete
    // landing means signed out. Exact routes, maintenance and cooldown
    // budgets, and CAPTCHA/second-factor/manual guidance are kept. No click
    // is replayed; the navigation is a plain same-tab browser GET to the
    // fixed URL (page-side navigation would lose its executeScript reply).
    const goToLogin = async (): Promise<boolean> => {
      if (!deps.navigateTab || !await unchanged()) return false;
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== tab.url || live.status === 'loading') return false;
      const parsed = cleanUrl(live.url);
      if (!parsed || (parsed.pathname !== '/en-ca/niv' && parsed.pathname !== '/en-ca/niv/')) return false;
      // A trusted dashboard redirect pending on a complete root must never be
      // aborted to login: the pending check below already waited, but recheck
      // here to close the read-to-navigation race.
      const pending = live.pendingUrl ?? '';
      if (pending !== '' && pending !== 'about:blank') return false;
      if (!await unchanged()) return false;
      await deps.navigateTab(auth.tabId!, fixedTarget);
      return true;
    };
    // Trusted redirect progress between the snapshot read and the checkpointed
    // navigation paces instead of failing or overriding it. Every paced return
    // after a pending=true save durably and in-memory clears pending so the
    // next wake does not park via checkpoint reconciliation; configuration,
    // cancellation, untrusted URLs and missing navigation support stay refusal.
    const clearPendingAndPace = async (): Promise<EngineState> => {
      const cleared = { ...state, authentication: { ...state.authentication!, pending: false, checkpoint: undefined } };
      await deps.saveState(cleared);
      state = cleared;
      return pace();
    };
    const paceTrustedRedirect = async (): Promise<EngineState | null> => {
      let live;
      try { live = await deps.getTab(auth.tabId!); } catch { return null; }
      const decision = landingRedirectWait(live);
      if (decision !== 'wait') return null;
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      if (expired) {
        // Same bounded accounting after the pending=true checkpoint. A
        // progressed completed dashboard still clears and paces so the next
        // pass binds with zero credentials/POST; same-root pending counts via
        // the existing expiry budget; loading uses stalled-load recovery.
        if (live.status === 'loading') {
          const stalled = await expireStalledLoad(live.url ?? '', live.pendingUrl);
          // A loading-to-complete race paces without clearing inside the
          // helper; clear here so the next wake does not park.
          if (stalled.authentication?.pending) return clearPendingAndPace();
          return stalled;
        }
        if ((live.url ?? '') !== (tab.url ?? '')) return clearPendingAndPace();
        return expireCycle();
      }
      return clearPendingAndPace();
    };
    if (auth.purpose === 'verify') {
      // The tab is fully loaded (loading case handled earlier) on the exact
      // root, maintenance already checked, so a clean landing means signed
      // out. Checkpoint before the navigation and roll a fresh GET cycle
      // without counting an extra failure or replaying a POST; the
      // single-submit rule and budgets stay intact.
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      state = { ...state, authentication: { ...auth, pending: true, checkpoint: 'navigation' }, updatedAt: deps.nowIso() };
      await deps.saveState(state);
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      try {
        const waited = await paceTrustedRedirect();
        if (waited) return waited;
        if (!await goToLogin()) {
          const raced = await paceTrustedRedirect();
          if (raced) return raced;
          return fail('navigation-failed');
        }
      } catch { return fail('tab-unavailable'); }
      state = { ...state, authentication: { ...auth, pending: false, checkpoint: undefined, cycleStartedAt: deps.nowIso(),
        cycleDeadline: new Date(Date.parse(deps.nowIso()) + state.pollIntervalS * 1000).toISOString() } };
      return pace();
    }
    if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
    state = { ...state, authentication: { ...auth, pending: true, checkpoint: 'navigation' }, updatedAt: deps.nowIso() };
    await deps.saveState(state);
    if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
    try {
      const waited = await paceTrustedRedirect();
      if (waited) return waited;
      if (!await goToLogin()) {
        const raced = await paceTrustedRedirect();
        if (raced) return raced;
        return fail('navigation-failed');
      }
    } catch { return fail('tab-unavailable'); }
    state = { ...state, authentication: { ...state.authentication!, pending: false, checkpoint: undefined } };
    return pace();
  }
  if (route !== 'login') {
    // A reused payment tab is still en route to the dashboard right after
    // Start; wait out the remaining cycle instead of failing.
    if (route === 'payment' && auth.purpose === 'start') {
      if (expired) return expireCycle();
      return pace();
    }
    return fail('untrusted-navigation');
  }
  // A transient wait holds its durable deadline; only expiry moves it. At
  // expiry a strictly read-only probe still runs first: an explicit
  // rejection, a fresh challenge, or an unrecognized reading wins over
  // counting a generic cycle failure, while a clean or transient reading
  // falls through to the counted fresh-GET expiry below.
  if (auth.phase === 'cycle-wait') {
    if (expired) {
      try {
        const probe = await inject(probeLoginStatus, []) as LoginProbeResult | undefined;
        if (probe?.ok === false && probe.reason === 'credential-rejected') return fail('credential-rejected', detailOf(probe));
        if (probe?.ok === false && probe.reason === 'manual-authentication') {
          note('auth-manual', { detail: detailOf(probe) });
          return { ...state, status: state.intent ? 'verifying' : 'stopped',
            authentication: null, authenticationFailureReason: null, verification: null, nextPollAt: null, loginFailed: false, manualAuthentication: true, updatedAt: deps.nowIso() };
        }
        if (probe?.ok !== true && probe?.reason !== 'retryable') {
          // Unknown reading: explicit rejection/challenge above wins; a lost
          // or unclassified reply first gets the validated
          // login-to-dashboard progress check, then the counted fresh-GET
          // expiry instead of a terminal stop. The probe is strictly
          // read-only, so nothing is mutated and no POST is replayed.
          const reasonless = probe == null || (probe.ok === false && probe.reason == null);
          if (reasonless) {
            try {
              const raced = await paceLoginToDashboardRace(tab.url);
              if (raced) return raced;
            } catch { /* Fall through to the counted expiry below. */ }
          }
          if (probe == null) note('auth-reply-missing', { detail: 'reply-missing' });
          else if (probe.ok === false) note('auth-validation-failed', { detail: detailOf(probe) });
          else note('auth-reply-malformed', { detail: 'reply-malformed' });
          return expireCycle();
        }
        if (probe?.ok === false) note('auth-validation-failed', { detail: detailOf(probe) });
      } catch {
        try {
          const raced = await paceLoginToDashboardRace(tab.url);
          if (raced) return raced;
        } catch { /* Fall through to the counted retry below. */ }
        if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
        note('auth-script-interrupted', { detail: 'script-interrupted' });
        return deferRecoverable('script-interrupted');
      }
      return expireCycle();
    }
    if (state.nextPollAt !== cycleDeadline) return { ...state, nextPollAt: cycleDeadline, updatedAt: now };
    return state;
  }
  if (auth.phase === 'wait') {
    // Post-submit probe is strictly read-only: it never fills, clicks, or
    // submits, so the single-submit rule survives a slow redirect. A clean
    // signed-out form keeps waiting; an explicit rejection stops immediately
    // and a fresh challenge hands to the user without spending the budget.
    // The probe runs before any expiry accounting so rejection/challenge
    // state observed exactly at (or after) the deadline is never cleared by
    // the expiry GET and resubmitted next cycle. Zero additional submits.
    try {
      const probe = await inject(probeLoginStatus, []) as LoginProbeResult | undefined;
      if (probe?.ok === false && probe.reason === 'credential-rejected') return fail('credential-rejected', detailOf(probe));
      if (probe?.ok === false && probe.reason === 'manual-authentication') {
        note('auth-manual', { detail: detailOf(probe) });
        return { ...state, status: state.intent ? 'verifying' : 'stopped',
          authentication: null, authenticationFailureReason: null, verification: null, nextPollAt: null, loginFailed: false, manualAuthentication: true, updatedAt: deps.nowIso() };
      }
      if (probe?.ok === false && probe.reason === 'retryable') {
        note('auth-validation-failed', { detail: detailOf(probe) });
        if (expired) return expireCycle();
        return { ...state, authentication: { ...auth, phase: 'cycle-wait' }, nextPollAt: cycleDeadline, updatedAt: now };
      }
      if (probe?.ok !== true) {
        // Same narrow lost-reply fallback as expiry probes: empty or
        // reasonless replies may recover via validated progress only. An
        // unknown reading never stops the run: it holds the durable cycle
        // deadline so the read-only expiry probe can classify it (or expires
        // immediately when already overdue). Nothing is mutated; no POST is
        // replayed.
        const reasonless = probe == null || (probe.ok === false && probe.reason == null);
        if (reasonless) {
          try {
            const raced = await paceLoginToDashboardRace(tab.url);
            if (raced) return raced;
          } catch { /* Fall through to the paced hold below. */ }
        }
        if (probe == null) note('auth-reply-missing', { detail: 'reply-missing' });
        else if (probe.ok === false) note('auth-validation-failed', { detail: detailOf(probe) });
        else note('auth-reply-malformed', { detail: 'reply-malformed' });
        if (expired) return expireCycle();
        return { ...state, authentication: { ...auth, phase: 'cycle-wait' }, nextPollAt: cycleDeadline, updatedAt: now };
      }
    } catch {
      try {
        const raced = await paceLoginToDashboardRace(tab.url);
        if (raced) return raced;
      } catch { /* Fall through to the counted retry below. */ }
      if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
      note('auth-script-interrupted', { detail: 'script-interrupted' });
      return deferRecoverable('script-interrupted');
    }
    if (expired) return expireCycle();
    return pace();
  }
  if (expired) return expireCycle();
  // At most one login submission per cycle: a fresh GET must revalidate before
  // any further submit, so never replay a POST within the same cycle.
  if (auth.phase === 'submit' && auth.submittedInCycle === true) {
    return { ...state, authentication: { ...auth, phase: 'cycle-wait' }, nextPollAt: cycleDeadline, updatedAt: now };
  }
  if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
  state = { ...state, authentication: { ...auth, pending: true, checkpoint: 'action' }, updatedAt: deps.nowIso() };
  await deps.saveState(state);
  if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
  try {
    // The adapter may report identifiable transient incompleteness as
    // 'retryable' and explicit credential rejection as 'credential-rejected'.
    // Every other outcome — including a missing reply — settles the uncertain
    // cycle instead of stopping: the pending checkpoint clears durably, the
    // cycle is marked submitted, and the paced wait revalidates with a fresh
    // GET before any further fill or submit. The POST is never replayed.
    const result = await inject(performLoginAction, [{ action: auth.phase, email: prefs.email.trim(), password: prefs.password }]) as (LoginResult & { reason?: string }) | undefined;
    if (result?.ok === false && result.reason === 'sign-in-notice-dismissed') {
      note('auth-notice-dismissed');
      state = { ...state, authentication: { ...auth, pending: false, checkpoint: undefined } };
      return pace();
    }
    if (result?.ok === false && result.reason === 'manual-authentication') {
      note('auth-manual', { detail: detailOf(result) });
      return { ...state, status: state.intent ? 'verifying' : 'stopped',
        authentication: null, authenticationFailureReason: null, verification: null, nextPollAt: null, loginFailed: false, manualAuthentication: true, updatedAt: deps.nowIso() };
    }
    if (result?.ok === false && result.reason === 'credential-rejected') return fail('credential-rejected', detailOf(result));
    if (result?.ok === false && result.reason === 'retryable') {
      note('auth-validation-failed', { detail: detailOf(result) });
      if (expired) return expireCycle();
      return { ...state, authentication: { ...auth, phase: 'cycle-wait' }, nextPollAt: cycleDeadline, updatedAt: now };
    }
    if (result?.ok !== true) {
      // Lost submit-reply fallback: no explicit notice/challenge/rejection or
      // transient semantic took precedence above, so only an empty or
      // reasonless reply may recover via validated dashboard progress.
      const reasonless = result == null || (result.ok === false && result.reason == null);
      if (reasonless) {
        try {
          const raced = await paceLoginToDashboardRace(tab.url);
          if (raced) return raced;
        } catch { /* Fall through to the settled wait below. */ }
      }
      if (result == null) note('auth-reply-missing', { detail: 'reply-missing' });
      else if (result.ok === false) note('auth-validation-failed', { detail: detailOf(result) });
      else note('auth-reply-malformed', { detail: 'reply-malformed' });
      // Settle the uncertain submission: clear the pending checkpoint and mark
      // the cycle submitted (durably where possible) so a bounce back to login
      // cannot replay the POST or repeat the fill within this cycle. The paced
      // wait keeps the run alive; the read-only probe and the cycle deadline
      // classify the outcome, and any later cycle revalidates with a fresh GET
      // before another submit.
      state = { ...state, authentication: { ...state.authentication!, pending: false, checkpoint: undefined, submittedInCycle: true, phase: 'wait' as const }, updatedAt: deps.nowIso() };
      try { await deps.saveState(state); } catch { /* The caller retries persistence; wake recovery consumes the submit allowance without replay. */ }
      return pace();
    }
    note(auth.phase === 'prepare' ? 'auth-prepared' : 'auth-submitted');
  } catch {
    // A successful submit may redirect to the trusted dashboard before its
    // reply returns (lost submit reply), and a prepare fill may race the same
    // automatic navigation. Validated exact-login-to-trusted-dashboard
    // progress paces without replaying the POST; an unambiguously unchanged
    // trusted login document settles the uncertain cycle the same way as a
    // missing reply; every other live state stays fail-closed with no
    // re-fill/submit.
    try {
      const raced = await paceLoginToDashboardRace(tab.url);
      if (raced) return raced;
    } catch { /* Fall through to the settled wait below. */ }
    let settled = false;
    try {
      const live = await deps.getTab(auth.tabId!);
      settled = live.url === tab.url && live.status !== 'loading' && isExactLoginUrl(live.url) &&
        ((live.pendingUrl ?? '') === '' || live.pendingUrl === 'about:blank');
    } catch { settled = false; }
    if (!settled) return failRaceClosed();
    if (!await unchanged()) return fail(deps.isCancelled?.() ? 'cancelled' : 'configuration-changed');
    note('auth-script-interrupted', { detail: 'script-interrupted' });
    state = { ...state, authentication: { ...state.authentication!, pending: false, checkpoint: undefined, submittedInCycle: true, phase: 'wait' as const }, updatedAt: deps.nowIso() };
    try { await deps.saveState(state); } catch { /* The caller retries persistence; wake recovery consumes the submit allowance without replay. */ }
    return pace();
  }
  state = { ...state, authentication: { ...auth, pending: false, checkpoint: undefined, phase: auth.phase === 'prepare' ? 'submit' : 'wait',
    submittedInCycle: auth.phase === 'submit' ? true : (auth.submittedInCycle ?? false) } };
  return pace();
}

function migrateAuthCycle(auth: AuthenticationState, pollIntervalS: number): AuthenticationState {
  if (auth.cycleStartedAt !== undefined && auth.cycleDeadline !== undefined && auth.submittedInCycle !== undefined) return auth;
  const started = auth.cycleStartedAt ?? auth.startedAt;
  const deadline = auth.cycleDeadline ?? new Date(Date.parse(started) + pollIntervalS * 1000).toISOString();
  return { ...auth, cycleStartedAt: started, cycleDeadline: deadline,
    submittedInCycle: auth.submittedInCycle ?? auth.phase === 'wait' };
}

function rollAuthCycle(auth: AuthenticationState, now: string, random: () => number, pollIntervalS: number): AuthenticationState {
  // A fresh cycle revalidates with a GET (never a POST replay) and resets the
  // single-submit allowance.
  return { ...auth, cycleStartedAt: now,
    cycleDeadline: new Date(Date.parse(now) + pollDelaySeconds(random, pollIntervalS) * 1000).toISOString(),
    submittedInCycle: false };
}

function paceWithPolicy(state: EngineState, prefs: Preferences, now: string): EngineState {
  // First read after authentication is fast for both modes; the payment
  // landing listener pulls an alerts deadline forward on tab completion.
  return { ...reviewLifecycle(state, prefs as unknown as Record<string, unknown>, now), nextPollAt: new Date(Date.parse(now) + 2_000).toISOString() };
}
