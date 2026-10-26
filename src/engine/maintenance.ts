import { readSiteMaintenance } from '../adapter/reads';
import { SITE_ORIGIN } from '../domain/routes';
import { trustedRenewalUrl } from './navigation-recovery';
import type { ExecDeps, ExecTab } from './executor';
import type { EngineState } from './workflow';

// Permission to inspect an outage document is separate from permission to
// read account data or act on a booking form. Only evidenced portal routes
// and the saved group's workflow are eligible; an outage never binds identity.
export function maintenanceUrl(state: EngineState, value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '');
    if (url.origin !== SITE_ORIGIN || url.username || url.password || url.port || url.hash) return false;
    if (!url.search && ['/en-ca/niv', '/en-ca/niv/', '/en-ca/niv/users/sign_in', '/en-ca/niv/account', '/en-ca/niv/account/'].includes(url.pathname)) return true;
    if (state.group) {
      if (trustedRenewalUrl(state, value)) return true;
      return !url.search && url.pathname === `/en-ca/niv/schedule/${state.group.scheduleId}/continue`;
    }
    // Explicit Start can own a payment tab before resolving its group. This
    // permits outage observation only; the page never establishes identity.
    if (state.authentication?.purpose === 'start' && !url.search && /^\/en-ca\/niv\/schedule\/[0-9]+\/payment$/.test(url.pathname)) return true;
    return !url.search && /^\/en-ca\/niv\/groups(?:\/[0-9]+)?$/.test(url.pathname);
  } catch { return false; }
}

// Read-only, same-document observation. Recheck both custody and settings
// after injection: stale maintenance replies cannot authorize recovery.
// A missing/interrupted reply isn't evidence of maintenance; callers retain
// their ordinary read/action refusal paths in that case.
export async function observeMaintenance(deps: Pick<ExecDeps, 'getTab' | 'inject' | 'loadPrefs' | 'isCancelled'>,
    state: EngineState, tabId: number): Promise<boolean> {
  if (!state.owner || !state.runId || deps.isCancelled?.() ||
      !(state.status === 'running' || (state.status === 'verifying' && (state.authentication || state.verification?.nextReadAt)))) return false;
  const ownedId = state.authentication?.tabId ?? (state.status === 'verifying' ? state.verificationTabId
    : state.mode === 'booking' ? state.executor?.tabId : state.monitorTabId);
  if (ownedId != null && ownedId !== tabId) return false;
  const prefs = await deps.loadPrefs();
  const tab = await deps.getTab(tabId);
  if (tab.id !== tabId || tab.status === 'loading' || tab.pendingUrl || !maintenanceUrl(state, tab.url)) return false;
  const result = await deps.inject(tabId, readSiteMaintenance, [true, tab.url]) as { maintenance?: unknown } | undefined;
  if (result?.maintenance !== true) return false;
  return confirmMaintenance(deps, state, tab, prefs);
}

export async function confirmMaintenance(deps: Pick<ExecDeps, 'getTab' | 'loadPrefs' | 'isCancelled'>,
    state: EngineState, tab: ExecTab, prefs: unknown): Promise<boolean> {
  if (tab.id === undefined || !maintenanceUrl(state, tab.url)) return false;
  const currentPrefs = await deps.loadPrefs();
  const live = await deps.getTab(tab.id);
  return !deps.isCancelled?.() && JSON.stringify(currentPrefs) === JSON.stringify(prefs) &&
    live.id === tab.id && live.url === tab.url && live.status !== 'loading' && !live.pendingUrl && maintenanceUrl(state, live.url);
}
