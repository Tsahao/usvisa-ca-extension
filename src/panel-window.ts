// The detached product window is the floating Chrome popup itself: the client
// area snugly fits the existing 356 × 586 panel with no artificial card,
// gutter, shadow, border or rounded corners.
export const PANEL_CLIENT_WIDTH = 356;
export const PANEL_CLIENT_HEIGHT = 586;
const WINDOW_KEY = 'panelWindowV1';

export async function openPanelWindow(): Promise<void> {
  const url = chrome.runtime.getURL('panel.html?detached=1');
  const saved = (await chrome.storage.session.get(WINDOW_KEY))[WINDOW_KEY] as { tabId?: number } | undefined;
  const candidates = saved?.tabId === undefined ? [] : [saved.tabId];
  // Session storage may have been cleared by an extension reload while its
  // window remains open. Rediscover only our exact detached extension page.
  const tabs = await chrome.tabs.query({});
  candidates.push(...tabs.filter(tab => tab.url === url && tab.id !== undefined).map(tab => tab.id!));
  for (const tabId of new Set(candidates)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url !== url) continue;
      const window = await chrome.windows.get(tab.windowId);
      if (window.type !== 'popup') continue;
      if (window.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' });
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.storage.session.set({ [WINDOW_KEY]: { tabId } });
      return;
    } catch { /* Closed or navigated since the last toolbar click. */ }
  }
  const window = await chrome.windows.create({ url, type: 'popup', focused: true,
    width: PANEL_CLIENT_WIDTH, height: PANEL_CLIENT_HEIGHT + 32 });
  const tabId = window?.tabs?.[0]?.id;
  await chrome.storage.session.set({ [WINDOW_KEY]: tabId === undefined ? null : { tabId } });
}

// Chrome's window dimensions include native chrome. Measure it once after
// layout, rather than assuming every operating system uses a 32px title bar.
// This is an initial fit only: subsequent user resizing is unrestricted.
export async function fitCurrentPanelWindow(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const current = await chrome.windows.getCurrent();
  if (current.type !== 'popup' || current.id === undefined || current.state !== 'normal') return;
  const frameWidth = Math.max(0, window.outerWidth - window.innerWidth);
  const frameHeight = Math.max(0, window.outerHeight - window.innerHeight);
  if (frameWidth > 256 || frameHeight > 512) return;
  await chrome.windows.update(current.id, { width: PANEL_CLIENT_WIDTH + frameWidth, height: PANEL_CLIENT_HEIGHT + frameHeight });
}
