import { panelCommandError, type PanelReadStep } from './start-errors';
import { performLoginAction, probeLoginStatus, type LoginProbeResult, type LoginResult } from '../adapter/login';
import { readCurrentAppointment, readDashboardGroups, readSiteMaintenance } from '../adapter/reads';
import { appointmentApplicants, appointmentDate } from '../domain/appointment';
import { sameApplicants } from '../domain/applicants';
import { resolveGroup, validateDashboardSnapshot } from '../domain/groups';
import { classifyRoute, SITE_ORIGIN } from '../domain/routes';
import {
  countFailure,
  cooldownUntilSeconds,
  pollDelaySeconds,
  SETUP_FAILURE_COOLDOWN_AFTER,
  shouldCooldown,
} from '../domain/timing';
import { preferencesError, type Preferences } from '../ui/model';
import { policyKey, reviewLifecycle } from './lifecycle';
import { bindGroup, parkForReview, VERIFICATION_UNREADABLE, type AuthenticationState, type EngineState } from './workflow';
import type { ExecDeps } from './executor';
import { applyPollResult, engineAlarmAt } from './poll';

export function deferAuthenticationForMaintenance(state: EngineState, now: string, random: () => number): EngineState {
  if (!state.authentication || state.authentication.pending || !['running', 'verifying'].includes(state.status)) return state;
  return { ...applyPollResult(state, { outcome: 'maintenance', now, random }),
    authentication: { ...state.authentication, phase: 'retry', pending: false },
    loginFailed: false, authenticationError: null, manualAuthentication: false };
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
    verification: purpose === 'verify' ? null : state.verification, loginFailed: false, authenticationError: null, manualAuthentication: false, nextPollAt: now, updatedAt: now };
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
  // A failed verification login (for example a closed authentication tab)
  // keeps the unresolved intent but would otherwise strand with no deadline
  // and no banner. Record the existing fixed unreadable reason so the panel
  // explains the parked check and an explicit Start resumes it; runs without
  // an intent keep their previous diagnostics.
  const fail = (): EngineState => ({ ...state, status: state.intent ? 'verifying' : 'stopped', authentication: null,
    verification: null, nextPollAt: null, loginFailed: true,
    ...(state.intent ? { verificationError: VERIFICATION_UNREADABLE } : {}), updatedAt: deps.nowIso() });
  const pace = (): EngineState => ({ ...state, nextPollAt: new Date(Date.parse(deps.nowIso()) + 2_000).toISOString(), updatedAt: deps.nowIso() });
  if (auth.pending || Date.parse(now) < Date.parse(auth.startedAt) ||
      (state.intent && auth.purpose !== 'verify') || deps.isCancelled?.()) return fail();
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
          typeof prefs.password !== 'string' || prefs.password.length === 0) return fail();
    } else if (!prefs || preferencesError(prefs) ||
        (state.policyKey !== null && state.policyKey !== policyKey(prefs as unknown as Record<string, unknown>))) return fail();
  } catch { return fail(); }
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
    const existing = auth.purpose === 'start' ? (await deps.queryTabs()).filter(tab => classifyRoute(tab.url ?? '') === 'login') : [];
    if (existing.length > 1) return fail();
    // Start tries the fixed site root first to reuse a valid profile
    // session (it redirects to the account dashboard when signed in; a
    // signed-out clean landing advances promptly to sign-in). Renew and
    // verify keep the direct sign-in entry; the bare dashboard route 403s,
    // so a signed-out run never parks on the public welcome landing. A
    // signed-in cookie still resolves through the dashboard handler with
    // zero credential fill or login submission.
    const startRoot = 'https://ais.usvisa-info.com/en-ca/niv/';
    const tab = existing[0] ?? await deps.createTab(auth.purpose === 'start' ? startRoot : 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    if (tab.id === undefined) return fail();
    state = { ...state, authentication: { ...auth, tabId: tab.id } };
    return pace();
  }
  let tab;
  try { tab = await deps.getTab(auth.tabId); } catch { return fail(); }
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
      if (!await unchanged()) return fail();
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== currentUrl || (live.pendingUrl ?? undefined) !== (currentPending ?? undefined) || live.status !== 'loading') return pace();
      if (!stalledUrlsTrusted(live.url, live.pendingUrl)) return fail();
    } catch { return fail(); }
    const cooled = state.cooldownUntil !== null && Date.parse(state.cooldownUntil) <= Date.parse(now);
    const failures = countFailure(cooled ? 0 : state.consecutiveFailures);
    if (shouldCooldown(failures, SETUP_FAILURE_COOLDOWN_AFTER)) {
      const cooldownUntil = new Date(cooldownUntilSeconds(Math.floor(Date.parse(now) / 1000)) * 1000).toISOString();
      return { ...state, consecutiveFailures: failures, cooldownUntil, nextPollAt: null,
        authentication: { ...auth, phase: 'retry', pending: false }, updatedAt: now };
    }
    // Durable mutation checkpoint: pending=true commits before any browser
    // navigation and clears only after the navigation succeeds. An interrupted
    // checkpoint keeps pending=true and parks on worker wake via the existing
    // startup reconciliation; a navigation error stays safe and never replays
    // a POST.
    const rolled = { ...state, consecutiveFailures: failures, cooldownUntil: null,
      authentication: rollAuthCycle({ ...auth, phase: 'prepare', pending: true }, now, deps.random, state.pollIntervalS),
      updatedAt: now };
    await deps.saveState(rolled);
    state = { ...rolled };
    try {
      if (!await unchanged()) return fail();
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== currentUrl || (live.pendingUrl ?? undefined) !== (currentPending ?? undefined) || live.status !== 'loading') return pace();
      if (!stalledUrlsTrusted(live.url, live.pendingUrl)) return fail();
      if (deps.navigateTab) await deps.navigateTab(auth.tabId!, fixedTarget);
    } catch { return fail(); }
    state = { ...state, authentication: { ...state.authentication!, pending: false } };
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
      if (!await unchanged()) return fail();
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== currentUrl || (live.pendingUrl ?? undefined) !== (currentPending ?? undefined) || live.status !== 'loading') return pace();
      if (!stalledUrlsTrusted(live.url, live.pendingUrl)) return fail();
    } catch { return fail(); }
    const cooled = state.cooldownUntil !== null && Date.parse(state.cooldownUntil) <= Date.parse(now);
    const rolled = { ...state, consecutiveFailures: cooled ? 0 : state.consecutiveFailures, cooldownUntil: null,
      authentication: rollAuthCycle({ ...auth, phase: 'prepare', pending: true }, now, deps.random, state.pollIntervalS),
      updatedAt: now };
    await deps.saveState(rolled);
    state = { ...rolled };
    try {
      if (!await unchanged()) return fail();
      const live = await deps.getTab(auth.tabId!);
      if (live.url !== currentUrl || (live.pendingUrl ?? undefined) !== (currentPending ?? undefined) || live.status !== 'loading') return pace();
      if (!stalledUrlsTrusted(live.url, live.pendingUrl)) return fail();
      if (deps.navigateTab) await deps.navigateTab(auth.tabId!, fixedTarget);
    } catch { return fail(); }
    state = { ...state, authentication: { ...state.authentication!, pending: false } };
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
  const freshGet = async (): Promise<boolean> => {
    if (!deps.navigateTab || !await unchanged()) return false;
    const live = await deps.getTab(auth.tabId!);
    if (live.url !== tab.url || live.status === 'loading' || !stalledUrlsTrusted(live.url, live.pendingUrl)) return false;
    const target = cleanUrl(live.url);
    if (!target || !supportedStalledPath(target.pathname) || !await unchanged()) return false;
    await deps.navigateTab(auth.tabId!, target.href);
    return true;
  };
  // An expired cycle counts exactly ONE failure and — unless the setup budget
  // is exhausted — starts the next fresh-GET cycle immediately with no
  // additional full interval. A trustworthy dashboard already had its chance
  // above, so only non-dashboard routes arrive here.
  const expireCycle = async (): Promise<EngineState> => {
    const cooled = state.cooldownUntil !== null && Date.parse(state.cooldownUntil) <= Date.parse(now);
    const failures = countFailure(cooled ? 0 : state.consecutiveFailures);
    if (shouldCooldown(failures, SETUP_FAILURE_COOLDOWN_AFTER)) {
      const cooldownUntil = new Date(cooldownUntilSeconds(Math.floor(Date.parse(now) / 1000)) * 1000).toISOString();
      return { ...state, consecutiveFailures: failures, cooldownUntil, nextPollAt: null,
        authentication: { ...auth, phase: 'retry', pending: false }, updatedAt: now };
    }
    const rolled = { ...state, consecutiveFailures: failures, cooldownUntil: null,
      authentication: rollAuthCycle({ ...auth, phase: 'prepare', pending: true }, now, deps.random, state.pollIntervalS),
      updatedAt: now };
    await deps.saveState(rolled);
    try {
      if (!await freshGet()) return fail();
    } catch { return fail(); }
    state = { ...rolled, authentication: { ...rolled.authentication!, pending: false } };
    return { ...state, nextPollAt: new Date(Date.parse(deps.nowIso()) + 2_000).toISOString(), updatedAt: deps.nowIso() };
  };
  // Validate the exact authentication route before inspecting the document;
  // outage retries cannot confer trust on an unexpected page or group.
  if (['login', 'landing', 'dashboard'].includes(route)) {
    const url = new URL(tab.url!);
    if (url.search || url.hash) return fail();
    if (auth.phase === 'retry') {
      state = { ...state, authentication: rollAuthCycle({ ...auth, phase: 'prepare', pending: true, startedAt: now }, now, deps.random, state.pollIntervalS), updatedAt: now };
      await deps.saveState(state);
      try {
        if (!await freshGet()) return fail();
      } catch { return fail(); }
      state = { ...state, authentication: { ...state.authentication!, pending: false } };
      return pace();
    }
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
            if (!await unchanged()) return fail();
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
          if (decision === 'fail') return fail();
        }
      } catch { return fail(); }
    }
    try {
      const result = await inject(readSiteMaintenance, [true]) as { maintenance?: unknown } | undefined;
      if (result?.maintenance === true) return deferAuthenticationForMaintenance(state, now, deps.random);
    } catch {
      // A trusted root-to-dashboard change before the injection throws via the
      // snapshot-URL guard without injecting. Pace it instead of failing; all
      // other injection failures stay fail-closed.
      if (route === 'landing') {
        try {
          const live = await deps.getTab(auth.tabId!);
          if (landingRedirectWait(live) === 'wait') {
            if (!await unchanged()) return fail();
            if (expired) {
              if (live.status === 'loading') return expireStalledLoad(live.url ?? '', live.pendingUrl);
              if ((live.url ?? '') !== (tab.url ?? '')) return pace();
              return expireCycle();
            }
            return pace();
          }
        } catch { /* Fall through to refusal below. */ }
      }
      return fail();
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
    if (!current || current.search || current.hash) return fail();
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
          if (!await unchanged()) return fail();
          if (expired) return expireCycle();
          return pace();
        }
      } catch { return fail(); }
      return fail();
    }
    if (auth.phase === 'retry') {
      const retrying = (() => { try { return new URL(tab.url!); } catch { return null; } })();
      if (!retrying || retrying.search || retrying.hash) return fail();
      state = { ...state, authentication: rollAuthCycle({ ...auth, phase: 'prepare', pending: true, startedAt: now }, now, deps.random, state.pollIntervalS), updatedAt: now };
      await deps.saveState(state);
      try {
        if (!await freshGet()) return fail();
      } catch { return fail(); }
      state = { ...state, authentication: { ...state.authentication!, pending: false } };
      return pace();
    }
    try {
      const result = await inject(readSiteMaintenance, [true]) as { maintenance?: unknown } | undefined;
      if (result?.maintenance === true) return deferAuthenticationForMaintenance(state, now, deps.random);
    } catch { return fail(); }
    if (expired) return expireCycle();
    return pace();
  } else if (auth.phase === 'retry') return fail();
  if (route === 'dashboard') {
    let readStep: PanelReadStep = 'groups';
    const dashboardFailure = (error: unknown): EngineState => ({ ...fail(), loginFailed: false,
      authenticationError: panelCommandError(error, readStep) });
    try {
      const dashboardPath = new URL(tab.url!).pathname;
      const raw = await inject(readDashboardGroups, []);
      // Verification resolves the ORIGINAL saved group by exact schedule AND
      // IVR, never via current booking preferences and never by borrowing a
      // sibling/historical card. The old complete roster is NOT required to
      // authenticate verification; later outcome classification is roster
      // relaxed while renewal and booking paths stay strict.
      if (auth.purpose === 'verify') {
        if (!state.group) return dashboardFailure(new Error('Authenticated group changed.'));
        const snapshot = validateDashboardSnapshot(raw as never);
        const found = snapshot.groups.find(group => group.scheduleId === state.group!.scheduleId && group.ivr === state.group!.ivr);
        if (!found) return dashboardFailure(new Error('Authenticated group changed.'));
        if (!await unchanged()) return fail();
        return { ...state, authentication: null, verificationTabId: auth.tabId, verification: { reads: [], nextReadAt: deps.nowIso() },
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
      if (state.group && (state.group.scheduleId !== match.scheduleId || state.group.ivr !== match.ivr ||
          (state.group.applicantIds && !sameApplicants(state.group.applicantIds, applicantIds)) ||
          state.group.currentDate !== currentDate)) return dashboardFailure(new Error('Authenticated group changed.'));
      if (!await unchanged()) return fail();
      if (!state.group) state = bindGroup(state, { owner: state.owner!, runId: state.runId!, now: deps.nowIso(),
        binding: { ...match, kind: state.mode === 'booking' ? 'paid' : 'unpaid', currentDate, dashboardPath, ...(applicantIds ? { applicantIds } : {}) } });
      state = { ...state, authentication: null, executor: null, stage: null, lastCandidate: null, startedAt: deps.nowIso(),
        group: state.group ? { ...state.group, dashboardPath } : null,
        consecutiveFailures: 0, cooldownUntil: null, updatedAt: deps.nowIso() };
      if (state.mode === 'booking') state = { ...state, stage: 'actions',
        executor: { tabId: auth.tabId, applicantIds: applicantIds!, targetTime: null, skippedDates: [], actionPending: false } };
      return paceWithPolicy(state, prefs, deps.nowIso());
    } catch (error) { return dashboardFailure(error); }
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
      const cleared = { ...state, authentication: { ...state.authentication!, pending: false } };
      await deps.saveState(cleared);
      state = cleared;
      return pace();
    };
    const paceTrustedRedirect = async (): Promise<EngineState | null> => {
      let live;
      try { live = await deps.getTab(auth.tabId!); } catch { return null; }
      const decision = landingRedirectWait(live);
      if (decision !== 'wait') return null;
      if (!await unchanged()) return fail();
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
      if (!await unchanged()) return fail();
      state = { ...state, authentication: { ...auth, pending: true }, updatedAt: deps.nowIso() };
      await deps.saveState(state);
      if (!await unchanged()) return fail();
      try {
        const waited = await paceTrustedRedirect();
        if (waited) return waited;
        if (!await goToLogin()) {
          const raced = await paceTrustedRedirect();
          if (raced) return raced;
          return fail();
        }
      } catch { return fail(); }
      state = { ...state, authentication: { ...auth, pending: false, cycleStartedAt: deps.nowIso(),
        cycleDeadline: new Date(Date.parse(deps.nowIso()) + state.pollIntervalS * 1000).toISOString() } };
      return pace();
    }
    if (!await unchanged()) return fail();
    state = { ...state, authentication: { ...auth, pending: true }, updatedAt: deps.nowIso() };
    await deps.saveState(state);
    if (!await unchanged()) return fail();
    try {
      const waited = await paceTrustedRedirect();
      if (waited) return waited;
      if (!await goToLogin()) {
        const raced = await paceTrustedRedirect();
        if (raced) return raced;
        return fail();
      }
    } catch { return fail(); }
    state = { ...state, authentication: { ...state.authentication!, pending: false } };
    return pace();
  }
  if (route !== 'login') {
    // A reused payment tab is still en route to the dashboard right after
    // Start; wait out the remaining cycle instead of failing.
    if (route === 'payment' && auth.purpose === 'start') {
      if (expired) return expireCycle();
      return pace();
    }
    return fail();
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
        if (probe?.ok === false && probe.reason === 'credential-rejected') return fail();
        if (probe?.ok === false && probe.reason === 'manual-authentication') return { ...state, status: state.intent ? 'verifying' : 'stopped',
          authentication: null, verification: null, nextPollAt: null, loginFailed: false, manualAuthentication: true, updatedAt: deps.nowIso() };
        if (probe?.ok !== true && probe?.reason !== 'retryable') return fail();
      } catch { return fail(); }
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
      if (probe?.ok === false && probe.reason === 'credential-rejected') return fail();
      if (probe?.ok === false && probe.reason === 'manual-authentication') return { ...state, status: state.intent ? 'verifying' : 'stopped',
        authentication: null, verification: null, nextPollAt: null, loginFailed: false, manualAuthentication: true, updatedAt: deps.nowIso() };
      if (probe?.ok === false && probe.reason === 'retryable') {
        if (expired) return expireCycle();
        return { ...state, authentication: { ...auth, phase: 'cycle-wait' }, nextPollAt: cycleDeadline, updatedAt: now };
      }
      if (probe?.ok !== true) return fail();
    } catch { return fail(); }
    if (expired) return expireCycle();
    return pace();
  }
  if (expired) return expireCycle();
  // At most one login submission per cycle: a fresh GET must revalidate before
  // any further submit, so never replay a POST within the same cycle.
  if (auth.phase === 'submit' && auth.submittedInCycle === true) {
    return { ...state, authentication: { ...auth, phase: 'cycle-wait' }, nextPollAt: cycleDeadline, updatedAt: now };
  }
  if (!await unchanged()) return fail();
  state = { ...state, authentication: { ...auth, pending: true }, updatedAt: deps.nowIso() };
  await deps.saveState(state);
  if (!await unchanged()) return fail();
  try {
    // The adapter may report identifiable transient incompleteness as
    // 'retryable' and explicit credential rejection as 'credential-rejected'.
    // Any other ok:false stays unsafe and fails immediately below — never
    // reinterpret an unrecognized outcome as transient.
    const result = await inject(performLoginAction, [{ action: auth.phase, email: prefs.email.trim(), password: prefs.password }]) as (LoginResult & { reason?: string }) | undefined;
    if (result?.ok === false && result.reason === 'sign-in-notice-dismissed') {
      state = { ...state, authentication: { ...auth, pending: false } };
      return pace();
    }
    if (result?.ok === false && result.reason === 'manual-authentication') return { ...state, status: state.intent ? 'verifying' : 'stopped',
      authentication: null, verification: null, nextPollAt: null, loginFailed: false, manualAuthentication: true, updatedAt: deps.nowIso() };
    if (result?.ok === false && result.reason === 'credential-rejected') return fail();
    if (result?.ok === false && result.reason === 'retryable') {
      if (expired) return expireCycle();
      return { ...state, authentication: { ...auth, phase: 'cycle-wait' }, nextPollAt: cycleDeadline, updatedAt: now };
    }
    if (result?.ok !== true) return fail();
  } catch { return fail(); }
  state = { ...state, authentication: { ...auth, pending: false, phase: auth.phase === 'prepare' ? 'submit' : 'wait',
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
