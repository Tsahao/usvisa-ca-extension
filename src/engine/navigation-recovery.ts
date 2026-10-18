import { sameApplicants } from '../domain/applicants';
import { classifyRoute, SITE_ORIGIN } from '../domain/routes';
import type { ExecTab } from './executor';
import type { EngineState } from './workflow';

function appointmentQueryApplicants(url: URL): string[] | null {
  for (const [key, value] of url.searchParams) {
    if (key === 'applicants[]' && /^[0-9]{1,32}$/.test(value)) continue;
    if (key === 'confirmed_limit_message' && value === '1' && url.searchParams.getAll(key).length === 1) continue;
    if (key === 'commit' && value === 'Continue' && url.searchParams.getAll(key).length === 1) continue;
    return null;
  }
  const applicants = url.searchParams.getAll('applicants[]');
  return new Set(applicants).size === applicants.length ? applicants : null;
}

// Shared with ordinary renewal: existing exact routes and portal-generated
// applicant/warning query validation remain the normal custody allow-list.
export function trustedRenewalUrl(state: EngineState, value: string | undefined): boolean {
  if (!state.group || !value) return false;
  try {
    const url = new URL(value);
    if (url.origin !== SITE_ORIGIN || url.username || url.password || url.port || url.hash) return false;
    if (!url.search && ['/en-ca/niv', '/en-ca/niv/', '/en-ca/niv/users/sign_in', state.group.dashboardPath].includes(url.pathname)) return true;
    const base = `/en-ca/niv/schedule/${state.group.scheduleId}`;
    if (state.mode === 'alerts') return url.pathname === `${base}/payment` && !url.search;
    if (url.pathname === `${base}/continue_actions`) return !url.search;
    if (url.pathname !== `${base}/appointment`) return false;
    const applicants = appointmentQueryApplicants(url);
    return applicants !== null && (!applicants.length || sameApplicants(applicants, state.group.applicantIds));
  } catch { return false; }
}

// These URLs authorize only replacing the owned tab with a fixed browser GET,
// never reading or acting on the unexpected document, including another group.
// Dirty URLs, other locales and offsite tabs are not recoverable custody.
export function isNavigationRecoveryUrl(state: EngineState, value: string | undefined): boolean {
  if (!state.group || !value) return false;
  if (trustedRenewalUrl(state, value)) return true;
  try {
    const url = new URL(value);
    if (url.origin !== SITE_ORIGIN || url.username || url.password || url.port || url.hash ||
        !/^\/en-ca\/niv(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(url.pathname)) return false;
    if (url.pathname.startsWith('/en-ca/niv/groups'))
      return classifyRoute(value) === 'dashboard' && !url.search;
    if (url.pathname.startsWith('/en-ca/niv/schedule')) {
      if (!/^\/en-ca\/niv\/schedule\/[0-9]+(?:\/|$)/.test(url.pathname)) return false;
      // Another group's applicant IDs can establish only a safe GET source;
      // they never replace the run's group or full original applicant roster.
      return !url.search || (classifyRoute(value) === 'appointment' && appointmentQueryApplicants(url) !== null);
    }
    return !url.search;
  } catch { return false; }
}

export function needsNavigationRecovery(state: EngineState, tab: ExecTab): boolean {
  const ownedId = state.mode === 'booking' ? state.executor?.tabId : state.monitorTabId;
  if (state.status !== 'running' || !state.group || state.authentication || state.intent ||
      state.executor?.actionPending || ownedId == null || tab.id !== ownedId ||
      !isNavigationRecoveryUrl(state, tab.url) ||
      (tab.pendingUrl && !isNavigationRecoveryUrl(state, tab.pendingUrl))) return false;
  const expected = (url: string): boolean => {
    if (!trustedRenewalUrl(state, url)) return false;
    const route = classifyRoute(url);
    if (route === 'dashboard') return state.mode === 'booking' && state.stage === 'actions' &&
      new URL(url).pathname === state.group!.dashboardPath;
    if (state.mode === 'alerts') return route === 'payment';
    return route === 'appointment' || (state.stage !== null && route === 'actions');
  };
  return !expected(tab.url!) || (!!tab.pendingUrl && !expected(tab.pendingUrl));
}
