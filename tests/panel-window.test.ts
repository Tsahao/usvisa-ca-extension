// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitCurrentPanelWindow, openPanelWindow, PANEL_CLIENT_HEIGHT, PANEL_CLIENT_WIDTH } from '../src/panel-window';

describe('detached scheduler window', () => {
  let session: Record<string, unknown>;
  let tabs: { id: number; windowId: number; url: string }[];
  let browser: any;
  const url = 'chrome-extension://synthetic/panel.html?detached=1';
  beforeEach(() => {
    session = {}; tabs = [];
    browser = {
      runtime: { getURL: (path: string) => `chrome-extension://synthetic/${path}` },
      storage: { session: { get: vi.fn(async () => session), set: vi.fn(async (values: object) => Object.assign(session, values)) } },
      tabs: { query: vi.fn(async () => tabs), get: vi.fn(async (id: number) => {
        const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Closed'); return tab;
      }) },
      windows: {
        create: vi.fn(async () => { const tab = { id: 7, windowId: 8, url }; tabs.push(tab); return { id: 8, tabs: [tab] }; }),
        get: vi.fn(async () => ({ id: 8, type: 'popup', state: 'normal' })),
        getCurrent: vi.fn(async () => ({ id: 8, type: 'popup', state: 'normal' })),
        update: vi.fn(async () => ({})),
      },
    };
    vi.stubGlobal('chrome', browser);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('creates one compact popup and subsequently brings the same window forward', async () => {
    await openPanelWindow(); await openPanelWindow();
    expect(browser.windows.create).toHaveBeenCalledTimes(1);
    expect(browser.windows.create).toHaveBeenCalledWith({ url, type: 'popup', focused: true, width: 356, height: 618 });
    expect(browser.windows.update).toHaveBeenCalledWith(8, { focused: true });
    expect(session.panelWindowV1).toEqual({ tabId: 7 });
  });
  it('rediscovers an existing popup after the extension session marker is cleared', async () => {
    tabs = [{ id: 7, windowId: 8, url }];
    await openPanelWindow();
    expect(browser.windows.create).not.toHaveBeenCalled();
    expect(session.panelWindowV1).toEqual({ tabId: 7 });
  });
  it('restores a minimized window without resetting the user’s dimensions', async () => {
    tabs = [{ id: 7, windowId: 8, url }];
    browser.windows.get.mockResolvedValue({ id: 8, type: 'popup', state: 'minimized', width: 700, height: 800 });
    await openPanelWindow();
    expect(browser.windows.update.mock.calls).toEqual([[8, { state: 'normal' }], [8, { focused: true }]]);
    expect(browser.windows.create).not.toHaveBeenCalled();
  });
  it('never focuses an unrelated window through a stale saved tab ID', async () => {
    session.panelWindowV1 = { tabId: 9 };
    tabs = [{ id: 9, windowId: 10, url: 'https://example.invalid/' }];
    await openPanelWindow();
    expect(browser.windows.update).not.toHaveBeenCalled();
    expect(browser.windows.create).toHaveBeenCalledTimes(1);
  });
  it('does not reuse a normal browser window containing the detached URL', async () => {
    tabs = [{ id: 9, windowId: 10, url }];
    browser.windows.get.mockResolvedValue({ id: 10, type: 'normal', state: 'normal' });
    await openPanelWindow();
    expect(browser.windows.create).toHaveBeenCalledTimes(1);
    expect(browser.windows.update).not.toHaveBeenCalled();
  });
  it('adds the measured native frame to the original client dimensions', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    vi.stubGlobal('window', { outerWidth: 364, innerWidth: 356, outerHeight: 608, innerHeight: 566 });
    await fitCurrentPanelWindow();
    expect(browser.windows.update).toHaveBeenCalledWith(8, { width: PANEL_CLIENT_WIDTH + 8, height: PANEL_CLIENT_HEIGHT + 42 });
  });
  it('does not resize a normal browser window opened directly on the panel URL', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    browser.windows.getCurrent.mockResolvedValue({ id: 10, type: 'normal', state: 'normal' });
    await fitCurrentPanelWindow();
    expect(browser.windows.update).not.toHaveBeenCalled();
  });
});
