// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeScreen } from '../src/ui/HomeScreen';
import { DEMO_PREFERENCES, EMPTY_PREFERENCES } from '../src/ui/model';

afterEach(() => { cleanup(); vi.resetModules(); vi.unstubAllGlobals(); });
const idle = { mode: 'booking', status: 'idle', reviewRequired: false, dates: [], rows: [], checkedAt: null, currentDate: null, confirmedDate: null };
function extension(snapshot = { ...idle }, preferences = { ...DEMO_PREFERENCES }) {
  const stored: Record<string, unknown> = { uiPreferencesV1: preferences };
  const holder = { snapshot };
  const sendMessage = vi.fn(async (_message: { type: string }) => ({ ok: true, snapshot: holder.snapshot }));
  vi.stubGlobal('chrome', { runtime: { id: 'synthetic', sendMessage }, storage: {
    local: { get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, stored[key]]))),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }), setAccessLevel: vi.fn(async () => {}) },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  } });
  return { stored, sendMessage, refresh: async (next: typeof snapshot) => {
    holder.snapshot = next;
    await act(async () => { vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0]({ engineStateV1: {} }, 'local'); });
  } };
}

describe('redesigned sign-in panel', () => {
  it('requires every mandatory field and a valid window without an email-format gate', async () => {
    const signIn = vi.fn(async () => {}); const user = userEvent.setup();
    render(<HomeScreen preferences={EMPTY_PREFERENCES} signIn={signIn} openTerms={() => {}} />);
    const button = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner-address' } });
    await user.type(screen.getByLabelText('Password'), 'synthetic-password');
    await user.click(screen.getByRole('checkbox', { name: 'Vancouver' }));
    fireEvent.change(screen.getByLabelText('Earliest Acceptable'), { target: { value: '2026-12-01' } });
    expect(button.disabled).toBe(true); expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Latest Acceptable'), { target: { value: '2026-11-01' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Latest Acceptable'), { target: { value: '2026-12-31' } });
    await user.click(screen.getByRole('switch', { name: 'Auto Book' }));
    expect(button.disabled).toBe(false);
    await user.click(button);
    expect(signIn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ email: 'owner-address', autoMode: false }));
  });

  it('retains the welcome draft through Terms without saving or starting', async () => {
    const { sendMessage, stored } = extension({ ...idle }, { ...EMPTY_PREFERENCES });
    const { App } = await import('../src/ui/App'); const user = userEvent.setup(); render(<App />);
    await screen.findByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText('Email'), 'draft@example.invalid');
    await user.type(screen.getByLabelText('Password'), 'draft-password');
    await user.click(screen.getByRole('link', { name: 'Terms & Conditions' }));
    expect(within(screen.getByRole('navigation')).getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('draft@example.invalid');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('draft-password');
    expect(stored.uiPreferencesV1).toEqual(EMPTY_PREFERENCES);
    expect(sendMessage.mock.calls.every(([message]) => message.type === 'PANEL_STATE')).toBe(true);
  });

  it.each(['booking', 'alerts'] as const)('retains %s-only tabs when reopening without automatically starting', async mode => {
    const { sendMessage } = extension({ ...idle, mode, availableModes: mode } as typeof idle);
    const { App } = await import('../src/ui/App'); render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    expect(within(screen.getByRole('navigation')).getAllByRole('button')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: mode === 'booking' ? 'Alerts' : 'Booking' })).toBeNull();
    expect(sendMessage.mock.calls.every(([message]) => message.type === 'PANEL_STATE')).toBe(true);
  });

  it.each(['tile', 'tab'])('starts either mixed-account %s once and never returns to the chooser', async control => {
    const h = extension({ ...idle, availableModes: 'both', modeChoiceRequired: true } as typeof idle);
    const { App } = await import('../src/ui/App'); const user = userEvent.setup(); render(<App />);
    await screen.findByRole('heading', { name: 'Select a mode to start' });
    h.sendMessage.mockImplementation(async message => ({ ok: true, snapshot: message.type === 'PANEL_START'
      ? { ...idle, mode: 'alerts', status: 'running', availableModes: 'both' } : { ...idle, mode: 'alerts', availableModes: 'both' } }));
    await user.click(screen.getByRole('button', { name: control === 'tile' ? 'View dates Visa fee unpaid' : 'Alerts' }));
    await screen.findByRole('button', { name: 'Stop' });
    expect(h.sendMessage.mock.calls.filter(([message]) => message.type === 'PANEL_START')).toEqual([[{ type: 'PANEL_START', mode: 'alerts' }]]);
    expect(screen.queryByRole('heading', { name: 'Select a mode to start' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Select a mode to start' })).toBeNull();
  });
});
