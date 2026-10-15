import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinpointVisaTab, VISA_LOGIN_URL } from '../src/panel-tabs';
import { emptyEngineState, validateEngineState, type EngineState } from '../src/engine/workflow';

const group = { scheduleId: '11111111', ivr: '22222222', kind: 'paid' as const, currentDate: null, dashboardPath: '/en-ca/niv/groups/99999999' };
const site = 'https://ais.usvisa-info.com/en-ca/niv';
describe('pinpointing the working Visa tab', () => {
  let tabs: chrome.tabs.Tab[];
  let browser: any;
  let state: EngineState;
  const tab = (id: number, path: string, windowId = 20) => ({ id, windowId, url: `${site}/${path}`, active: false } as chrome.tabs.Tab);
  beforeEach(() => {
    tabs = [];
    state = { ...emptyEngineState('2026-10-13T18:00:00Z'), group,
      executor: { tabId: 7, applicantIds: null, targetTime: null, skippedDates: [], actionPending: false } };
    browser = {
      tabs: {
        query: vi.fn(async () => tabs),
        get: vi.fn(async (id: number) => { const found = tabs.find(tab => tab.id === id); if (!found) throw new Error('Closed'); return found; }),
        update: vi.fn(async (id: number) => tabs.find(tab => tab.id === id)),
        create: vi.fn(async () => ({})),
      },
      windows: { get: vi.fn(async () => ({ state: 'normal' })), update: vi.fn(async () => ({})) },
    };
    vi.stubGlobal('chrome', browser);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('focuses the exact paid tab among duplicates, including its current browser window', async () => {
    tabs = [tab(6, 'schedule/11111111/appointment'), tab(7, 'schedule/11111111/appointment', 30), tab(9, 'schedule/33333333/appointment')];
    const before = structuredClone(state);
    await pinpointVisaTab(state, 9);
    expect(browser.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(browser.windows.update).toHaveBeenCalledWith(30, { focused: true });
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });
  it('focuses the retained unpaid summary rather than another matching copy', async () => {
    state = { ...state, mode: 'alerts', executor: null, monitorTabId: 8, group: { ...group, kind: 'unpaid' } };
    tabs = [tab(6, 'schedule/11111111/payment'), tab(8, 'schedule/11111111/payment')];
    await pinpointVisaTab(state, 6);
    expect(browser.tabs.update).toHaveBeenCalledWith(8, { active: true });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
  it('prioritizes the authentication tab during renewal', async () => {
    state.authentication = { tabId: 10, phase: 'prepare', pending: false, startedAt: state.updatedAt, purpose: 'renew' };
    tabs = [tab(7, 'schedule/11111111/appointment'), tab(10, 'users/sign_in')];
    await pinpointVisaTab(state, null);
    expect(browser.tabs.update).toHaveBeenCalledWith(10, { active: true });
  });
  it('shows the verification dashboard without changing an unresolved intent', async () => {
    state.intent = { runId: 'run-id-0001', mode: 'booking', groupId: '11111111', targetDate: '2026-12-03', consulate: 'Vancouver', testMode: true, createdAt: state.updatedAt };
    state.verificationTabId = 11;
    tabs = [tab(7, 'schedule/11111111/appointment'), tab(11, 'groups/99999999')];
    const before = structuredClone(state);
    await pinpointVisaTab(state, null);
    expect(browser.tabs.update).toHaveBeenCalledWith(11, { active: true });
    expect(state).toEqual(before);
  });
  it('restores the source browser window if it is minimized', async () => {
    tabs = [tab(7, 'schedule/11111111/appointment')];
    browser.windows.get.mockResolvedValue({ state: 'minimized' });
    await pinpointVisaTab(state, null);
    expect(browser.windows.update.mock.calls).toEqual([[20, { state: 'normal' }], [20, { focused: true }]]);
  });
  it('uses the explicitly toolbar-selected official tab when no run is bound', async () => {
    tabs = [tab(1, 'groups'), tab(2, 'users/sign_in')];
    await pinpointVisaTab(null, 2);
    expect(browser.tabs.update).toHaveBeenCalledWith(2, { active: true });
  });
  it('opens only the official login when there is no corresponding trusted tab', async () => {
    tabs = [tab(9, 'schedule/33333333/payment'), { id: 7, windowId: 20, url: 'https://example.invalid/' } as chrome.tabs.Tab];
    await pinpointVisaTab(state, 7);
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: VISA_LOGIN_URL, active: true });
  });
  it('reuses an existing official login rather than opening another', async () => {
    tabs = [tab(10, 'users/sign_in')];
    await pinpointVisaTab(state, null);
    expect(browser.tabs.update).toHaveBeenCalledWith(10, { active: true });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
  it('refuses ambiguous unbound Visa tabs without opening a duplicate or guessing', async () => {
    tabs = [tab(1, 'groups'), tab(2, 'groups/99999999')];
    await expect(pinpointVisaTab(null, null)).rejects.toThrow('Several matching Visa tabs');
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
  it('refuses a tab that navigates away between discovery and activation', async () => {
    tabs = [tab(7, 'schedule/11111111/appointment')];
    browser.tabs.get.mockResolvedValueOnce(tabs[0]).mockResolvedValueOnce({ ...tabs[0], url: 'https://example.invalid/' });
    await expect(pinpointVisaTab(state, null)).rejects.toThrow('The Visa tab changed');
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });
  it('migrates legacy unpaid tab custody to unbound and rejects corrupt tab IDs', () => {
    const legacy = { ...emptyEngineState(state.updatedAt) } as Record<string, unknown>;
    delete legacy.monitorTabId;
    expect(validateEngineState(legacy).monitorTabId).toBeNull();
    for (const invalid of [-1, 1.5, '7', {}, Infinity]) expect(() => validateEngineState({ ...legacy, monitorTabId: invalid })).toThrow();
  });
});
