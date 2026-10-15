// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPanel } from '../src/mount-panel';
import { DEMO_PREFERENCES, TERMS_VERSION } from '../src/ui/model';

afterEach(() => { vi.unstubAllGlobals(); document.documentElement.querySelectorAll('iframe').forEach(frame => frame.remove()); });

describe('floating panel boundaries', () => {
  it('does not mount on an untrusted site', () => {
    vi.stubGlobal('location', { origin: 'https://example.invalid' });
    expect(mountPanel('chrome-extension://synthetic/panel.html?embedded=1')).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('mounts once, toggles visibility, and accepts only its own hide message', () => {
    vi.stubGlobal('location', { origin: 'https://ais.usvisa-info.com' });
    const url = 'chrome-extension://synthetic/panel.html?embedded=1';
    expect(mountPanel(url)).toBe(true);
    const frame = document.querySelector('iframe')!;
    expect(frame.src).toBe(url);
    expect(mountPanel(url)).toBe(true);
    expect(document.querySelectorAll('iframe').length).toBe(1);
    expect(frame.style.display).toBe('none');
    mountPanel(url);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'USVISA_HIDE_PANEL' }, source: frame.contentWindow, origin: 'https://example.invalid' }));
    expect(frame.style.display).toBe('block');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'USVISA_HIDE_PANEL' }, source: window, origin: 'chrome-extension://synthetic' }));
    expect(frame.style.display).toBe('block');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'USVISA_HIDE_PANEL' }, source: frame.contentWindow, origin: 'chrome-extension://synthetic' }));
    expect(frame.style.display).toBe('none');
  });
  it('replaces a stale frame from an older build instead of toggling it', () => {
    vi.stubGlobal('location', { origin: 'https://ais.usvisa-info.com' });
    const url = 'chrome-extension://synthetic/panel.html?embedded=1';
    expect(mountPanel(url)).toBe(true);
    const stale = document.querySelector('iframe')!;
    stale.style.width = '404px';
    expect(mountPanel(url)).toBe(true);
    const frames = document.querySelectorAll('iframe');
    expect(frames.length).toBe(1);
    expect(frames[0]).not.toBe(stale);
    expect(frames[0].style.width).toBe('388px');
  });
});

describe('extension UI storage', () => {
  let local: Record<string, unknown>;
  let session: Record<string, unknown>;
  let access: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules(); local = {}; session = {}; access = vi.fn().mockResolvedValue(undefined);
    const area = (state: Record<string, unknown>) => ({ get: vi.fn(async () => ({ ...state })), set: vi.fn(async (values: Record<string, unknown>) => Object.assign(state, values)) });
    vi.stubGlobal('chrome', { runtime: { id: 'synthetic' }, storage: { local: { ...area(local), setAccessLevel: access }, session: area(session) } });
  });
  it('retains preferences and terms locally while keeping simulated runs in session storage', async () => {
    const storage = await import('../src/ui/storage');
    await storage.savePreferences(DEMO_PREFERENCES);
    await storage.saveTerms(TERMS_VERSION);
    await storage.saveRun({ mode: 'alerts', status: 'running', lastChecked: '23:51:04' });
    const state = await storage.loadUiState();
    expect(state.preferences).toEqual(DEMO_PREFERENCES);
    expect(state.terms).toBe(TERMS_VERSION);
    expect(state.run).toEqual({ mode: 'alerts', status: 'running', lastChecked: '23:51:04' });
    expect(access).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(JSON.stringify(session)).not.toContain(DEMO_PREFERENCES.password);
    session = {};
    await storage.savePreferences({ ...DEMO_PREFERENCES, email: '', password: '' });
    expect(JSON.stringify(local)).not.toContain(DEMO_PREFERENCES.password);
  });
  it('drops obsolete preferences and undocumented preview states when loading older saves', async () => {
    local.uiPreferencesV1 = { ...DEMO_PREFERENCES, exclusions: [{ start: '2026-12-01', end: '2027-12-31' }], alertsInRange: true };
    session.uiSimulatedRunV1 = { mode: 'booking', status: 'review', lastChecked: null, baseline: 3 };
    const storage = await import('../src/ui/storage');
    const state = await storage.loadUiState();
    expect(state.preferences).toEqual(DEMO_PREFERENCES);
    expect(state.run).toEqual({ mode: 'booking', status: 'idle', lastChecked: null });
    await storage.savePreferences(state.preferences);
    expect(local.uiPreferencesV1).toEqual(DEMO_PREFERENCES);
  });
  it('fails closed on malformed stored preferences instead of rendering broken data', async () => {
    local.uiPreferencesV1 = { email: DEMO_PREFERENCES.email, exclusions: null };
    const storage = await import('../src/ui/storage');
    await expect(storage.loadUiState()).rejects.toThrow('Invalid saved preferences.');
  });
  it('retains the last paid/unpaid workflow locally and ignores obsolete values', async () => {
    const storage = await import('../src/ui/storage');
    expect((await storage.loadUiState()).lastMode).toBeNull();
    await storage.saveLastMode('alerts');
    expect(local.uiLastModeV1).toBe('alerts');
    expect((await storage.loadUiState()).lastMode).toBe('alerts');
    local.uiLastModeV1 = 'exclusions-preview';
    expect((await storage.loadUiState()).lastMode).toBeNull();
  });
});
