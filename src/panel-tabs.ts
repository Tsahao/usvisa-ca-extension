import { platform, type Tab } from './platform';
import { classifyRoute, SITE_ORIGIN } from './domain/routes';
import { isSameGroupUrl } from './domain/trust';
import type { EngineState } from './engine/workflow';

export const VISA_LOGIN_URL = `${SITE_ORIGIN}/en-ca/niv/users/sign_in`;
const trusted = (tab: Tab) => tab.id !== undefined && !['untrusted', 'unsupported'].includes(classifyRoute(tab.url ?? ''));

function matchesGroup(tab: Tab, state: EngineState): boolean {
  if (!trusted(tab) || !state.group) return false;
  const route = classifyRoute(tab.url!);
  if (route === 'dashboard') return !!state.group.dashboardPath && new URL(tab.url!).pathname === state.group.dashboardPath;
  return ['actions', 'appointment', 'payment'].includes(route) && isSameGroupUrl(tab.url!, state.group.scheduleId);
}

// Locate only; this never transfers custody, starts authentication, navigates
// an existing page, or resolves a booking intent. Message-supplied targets
// cannot select the tab or the fixed official login URL.
export async function pinpointVisaTab(state: EngineState | null, preferredTabId: number | null): Promise<void> {
  const ownedIds = [state?.authentication?.tabId,
    state?.intent ? state.verificationTabId : null,
    state?.mode === 'booking' ? state.executor?.tabId : state?.monitorTabId];
  let target: Tab | undefined;
  for (const tabId of ownedIds) {
    if (tabId === undefined || tabId === null) continue;
    const tab = await platform.tabs.get(tabId).catch(() => null);
    if (!tab || !trusted(tab)) continue;
    const route = classifyRoute(tab.url!);
    const authenticating = tabId === state?.authentication?.tabId;
    if (route === 'login' || (authenticating && ['landing', 'dashboard'].includes(route)) ||
        (state && matchesGroup(tab, state))) { target = tab; break; }
  }
  if (!target) {
    const tabs = (await platform.tabs.query({})).filter(trusted);
    const scoped = state?.group
      ? tabs.filter(tab => matchesGroup(tab, state) || classifyRoute(tab.url!) === 'login')
      : tabs;
    target = scoped.find(tab => tab.id === preferredTabId) ??
      (scoped.length === 1 ? scoped[0] : undefined);
    if (!target && scoped.length > 1) throw new Error('Several matching Visa tabs are open. Click the extension icon on the tab you want to view, then try again.');
  }
  if (!target) {
    await platform.tabs.create({ url: VISA_LOGIN_URL, active: true });
    return;
  }
  // Revalidate after discovery so a changed URL cannot redirect this action
  // to an unrelated site. Use its current window if the user moved the tab.
  const live = await platform.tabs.get(target.id!);
  if (!trusted(live) || live.url !== target.url) throw new Error('The Visa tab changed. Try again.');
  const window = await platform.windows.get(live.windowId);
  if (window.state === 'minimized') await platform.windows.update(live.windowId, { state: 'normal' });
  const activated = await platform.tabs.update(live.id!, { active: true });
  await platform.windows.update(activated?.windowId ?? live.windowId, { focused: true });
}
