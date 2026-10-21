// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO_PREFERENCES, EMPTY_PREFERENCES } from '../src/ui/model';

afterEach(() => { cleanup(); vi.resetModules(); vi.unstubAllGlobals(); });

function stubExtension(options: { preferences?: unknown; lastMode?: unknown; snapshot: Record<string, unknown> }) {
  const localState: Record<string, unknown> = {
    ...(options.preferences !== undefined ? { uiPreferencesV1: options.preferences } : { uiPreferencesV1: { ...DEMO_PREFERENCES } }),
    ...(options.lastMode !== undefined ? { uiLastModeV1: options.lastMode } : {}),
  };
  const sendMessage = vi.fn(async (_message: { type: string }) => ({ ok: true, snapshot: options.snapshot }));
  vi.stubGlobal('chrome', {
    runtime: { id: 'synthetic', sendMessage },
    tabs: { create: vi.fn(async () => ({ id: 123 })) },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, localState[key]]))),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(localState, values); }),
        setAccessLevel: vi.fn(async () => undefined),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  return { localState, sendMessage, refreshWorker: async (snapshot: Record<string, unknown>) => {
    options.snapshot = snapshot;
    const listener = (chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    await act(async () => { listener?.({ engineObservationV1: {} }, 'local'); });
  } };
}

const idleSnapshot = (mode: string): Record<string, unknown> =>
  ({ mode, status: 'idle', reviewRequired: false, dates: [], rows: [], checkedAt: null, currentDate: null, confirmedDate: null });

describe('paid/unpaid workflow retention', () => {
  it.each([false, true])('preserves automatic interval memory across save/reopen and honors a later manual edit (%s)', async manual => {
    const { localState } = stubExtension({ snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    const first = render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Halifax' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(localState.uiPreferencesV1).toMatchObject({ interval: 90, intervalBeforeAutoIncrease: 60 });
    first.unmount();
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    const interval = screen.getByLabelText('Checking interval (s)') as HTMLInputElement;
    expect(interval.value).toBe('90');
    if (manual) {
      await user.clear(interval);
      await user.type(interval, '120');
    }
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Halifax' }));
    expect(interval.value).toBe(manual ? '120' : '60');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(localState.uiPreferencesV1).toMatchObject({ interval: manual ? 120 : 60 });
    expect(localState.uiPreferencesV1).not.toHaveProperty('intervalBeforeAutoIncrease');
  });

  it('shows the union of selected-consulate dates in one live calendar with a date-only earliest', async () => {
    stubExtension({ preferences: { ...DEMO_PREFERENCES, consulates: ['Calgary', 'Vancouver'] }, snapshot: {
      ...idleSnapshot('booking'), status: 'running', checkedAt: '2026-10-21T12:00:00Z',
      dates: ['2027-01-01', '2027-01-02'], byConsulate: [
        { consulate: 'Vancouver', dates: ['2027-01-01'] },
        { consulate: 'Calgary', dates: ['2027-01-01', '2027-01-02'] },
      ],
    } });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('button', { name: 'Stop' });
    const calendar = screen.getByLabelText('Appointment availability calendar');
    expect(within(calendar).getByLabelText('2027-01-01, available')).not.toBeNull();
    expect(within(calendar).getByLabelText('2027-01-02, available')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Earliest Available' }).parentElement?.lastChild?.textContent).toBe('Jan 1, 2027');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it.each([true, false])('migrates saved Test Mode %s to inverse Auto Mode and saves only the new preference', async testMode => {
    const { autoMode: _autoMode, ...legacy } = DEMO_PREFERENCES;
    const { localState } = stubExtension({ preferences: { ...legacy, testMode }, snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.queryByText(/Test Mode/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect((screen.getByRole('switch', { name: 'Auto Mode' }) as HTMLInputElement).checked).toBe(!testMode);
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(localState.uiPreferencesV1).toMatchObject({ autoMode: !testMode });
    expect(localState.uiPreferencesV1).not.toHaveProperty('testMode');
  });

  it('opens coffee checkout separately while worker observations continue without Start/Stop', async () => {
    const { sendMessage, refreshWorker, localState } = stubExtension({ lastMode: 'alerts', snapshot: { ...idleSnapshot('alerts'), status: 'running' } });
    const { App } = await import('../src/ui/App');
    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Stop' });
    await user.click(screen.getByRole('button', { name: 'Coffee' }));
    expect(screen.getByRole('button', { name: 'Coffee' }).getAttribute('aria-current')).toBe('page');
    await refreshWorker({ ...idleSnapshot('alerts'), status: 'running', checkedAt: '2026-10-14T19:30:00Z' });
    expect(screen.getByRole('heading', { name: 'Buy me a coffee?' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue to Stripe' }));
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://buy.stripe.com/fZu8wIfiZbhs8PU41r8EM00?prefilled_amount=500' });
    await user.click(screen.getByRole('button', { name: 'CAD' }));
    expect(screen.getByRole('button', { name: 'CAD' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Amount in CAD' }) as HTMLInputElement).value).toBe('5');
    await user.click(screen.getByRole('button', { name: 'Increase amount' }));
    await user.click(screen.getByRole('button', { name: 'Continue to Stripe' }));
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'https://buy.stripe.com/4gM5kw2wdado3vA9lL8EM01?prefilled_amount=600' });
    await user.click(screen.getByRole('button', { name: 'USD' }));
    expect((screen.getByRole('textbox', { name: 'Amount in USD' }) as HTMLInputElement).value).toBe('6');
    await user.click(screen.getByRole('button', { name: 'Continue to Stripe' }));
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'https://buy.stripe.com/fZu8wIfiZbhs8PU41r8EM00?prefilled_amount=600' });
    expect(localState.uiLastModeV1).toBe('alerts');
    expect(sendMessage.mock.calls.every(([message]) => message.type === 'PANEL_STATE')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull();
  });

  it('retains unsaved Settings when visiting Coffee, and shows checkout failures in the existing banner', async () => {
    stubExtension({ snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Start' });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'unsaved@example.invalid');
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.click(screen.getByRole('button', { name: 'Coffee' }));
    vi.mocked(chrome.tabs.create).mockRejectedValueOnce(new Error('Synthetic tab failure'));
    await user.click(screen.getByRole('button', { name: 'Continue to Stripe' }));
    expect(screen.getByRole('alert').textContent).toBe('Unable to open Stripe. Please try again.');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('unsaved@example.invalid');
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('reopens the stored paid workflow instead of home', async () => {
    stubExtension({ lastMode: 'booking', snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.queryByRole('button', { name: 'Book or reschedule For Paid Visa Group' })).toBeNull();
  });

  it('reopens the stored unpaid workflow instead of home', async () => {
    stubExtension({ lastMode: 'alerts', snapshot: idleSnapshot('alerts') });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.queryByRole('button', { name: 'Get date alerts For Unpaid Visa Group' })).toBeNull();
  });

  it('shows home for incomplete mandatory configuration even with a stored workflow', async () => {
    stubExtension({ preferences: { ...EMPTY_PREFERENCES }, lastMode: 'alerts', snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
  });

  it('falls back to booking for configured users with an obsolete stored workflow', async () => {
    stubExtension({ lastMode: 'exclusions-preview', snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.getByRole('heading', { name: 'Earliest Available' })).not.toBeNull();
  });

  it('follows an active worker run even without a stored workflow', async () => {
    stubExtension({ snapshot: { ...idleSnapshot('alerts'), status: 'running' } });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('button', { name: 'Stop' });
    expect(screen.queryByRole('button', { name: 'Book or reschedule For Paid Visa Group' })).toBeNull();
  });

  it('keeps incomplete setup on Home across active worker updates', async () => {
    const { refreshWorker } = stubExtension({ preferences: { ...EMPTY_PREFERENCES }, snapshot: { ...idleSnapshot('alerts'), status: 'running' } });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('button', { name: 'Sign in' });
    await refreshWorker({ ...idleSnapshot('alerts'), status: 'running', checkedAt: '2026-10-13T18:00:00Z' });
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('offers mandatory configuration directly on first-time Home', async () => {
    stubExtension({ preferences: { ...EMPTY_PREFERENCES }, lastMode: 'booking', snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.getByLabelText('Email')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('persists the chosen workflow for the next popup open', async () => {
    const { localState } = stubExtension({ snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    await user.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(localState.uiLastModeV1).toBe('alerts');
  });

  it('keeps the selected tab visible across headless worker updates and reopening', async () => {
    const { refreshWorker, localState, sendMessage } = stubExtension({ lastMode: 'alerts', snapshot: { ...idleSnapshot('alerts'), status: 'running' } });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    const mounted = render(<App />);
    await screen.findByRole('button', { name: 'Stop' });
    sendMessage.mockClear();
    await user.click(screen.getByRole('button', { name: 'Booking' }));
    await refreshWorker({ ...idleSnapshot('alerts'), status: 'running', checkedAt: '2026-10-13T18:00:00Z' });
    expect(screen.getByRole('heading', { name: 'Earliest Available' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Start' })).not.toBeNull();
    expect(localState.uiLastModeV1).toBe('booking');
    expect(sendMessage.mock.calls.some(([message]) => ['PANEL_START', 'PANEL_STOP'].includes(message.type))).toBe(false);
    mounted.unmount();
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.getByRole('heading', { name: 'Earliest Available' })).not.toBeNull();
  });

  it('pinpoints from Settings without changing the view or issuing Start or Stop', async () => {
    const { sendMessage } = stubExtension({ snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    sendMessage.mockClear();
    await user.click(screen.getByRole('button', { name: 'Show Visa tab' }));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'PANEL_FOCUS_TAB' });
    expect(screen.getByLabelText('Email')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Show Visa tab' }).hasAttribute('aria-current')).toBe(false);
  });

  it('marks only the selected page and leaves Visa action without an active state', async () => {
    stubExtension({ lastMode: 'booking', snapshot: idleSnapshot('booking') });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    const toolbar = screen.getByRole('navigation', { name: 'Scheduler navigation' });
    expect(within(toolbar).getAllByRole('button')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Booking' }).getAttribute('aria-current')).toBe('page');
    await user.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(screen.getByRole('button', { name: 'Alerts' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Booking' }).hasAttribute('aria-current')).toBe(false);
  });

  it('locks Settings while another tab owns a running worker workflow', async () => {
    stubExtension({ lastMode: 'alerts', snapshot: { ...idleSnapshot('alerts'), status: 'running' } });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Stop' });
    await user.click(screen.getByRole('button', { name: 'Booking' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByLabelText('Email').matches(':disabled')).toBe(true);
    expect(screen.getByRole('note').textContent).toMatch(/stop monitoring to modify settings/i);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the current workflow and observation when its tab is clicked again', async () => {
    const { sendMessage } = stubExtension({ lastMode: 'alerts', snapshot: { ...idleSnapshot('alerts'), status: 'running', checkedAt: '2026-10-13T18:00:00Z' } });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Stop' });
    sendMessage.mockClear();
    await user.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

});

describe('saved consulate migration', () => {
  it('migrates a saved single consulate and an unconfigured one', async () => {
    const { consulates: _consulates, ...legacy } = DEMO_PREFERENCES;
    stubExtension({ preferences: { ...legacy, consulate: 'Toronto' }, snapshot: idleSnapshot('booking') });
    const { loadUiState } = await import('../src/ui/storage');
    expect((await loadUiState()).preferences.consulates).toEqual(['Toronto']);
    expect((await loadUiState()).preferences).not.toHaveProperty('consulate');
    stubExtension({ preferences: { ...legacy, consulate: '' }, snapshot: idleSnapshot('booking') });
    expect((await loadUiState()).preferences.consulates).toEqual([]);
  });
});

describe('toolbar scroll background', () => {
  it('shares the panel background until content scrolls beneath it', async () => {
    stubExtension({ lastMode: 'booking', snapshot: idleSnapshot('booking') });
    const [{ App }, { default: panelStyles }] = await Promise.all([
      import('../src/ui/App'),
      import('../src/ui/Panel.module.css'),
    ]);
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('button', { name: 'Start' });
    const nav = await screen.findByRole('navigation', { name: 'Scheduler navigation' });
    expect(nav.className).not.toContain(panelStyles.toolbarScrolled);
    const scroller = container.querySelector(`.${panelStyles.workflowContent}`);
    expect(scroller).not.toBeNull();
    fireEvent.scroll(scroller!, { target: { scrollTop: 60 } });
    expect(nav.className).toContain(panelStyles.toolbarScrolled);
    fireEvent.scroll(scroller!, { target: { scrollTop: 0 } });
    expect(nav.className).not.toContain(panelStyles.toolbarScrolled);
    // Switching views resets the toolbar to the shared panel background.
    fireEvent.scroll(scroller!, { target: { scrollTop: 60 } });
    await user.click(screen.getByRole('button', { name: 'Alerts' }));
    expect((await screen.findByRole('navigation', { name: 'Scheduler navigation' })).className)
      .not.toContain(panelStyles.toolbarScrolled);
  });
});
