// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO_PREFERENCES } from '../src/ui/model';

afterEach(() => { cleanup(); vi.resetModules(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const PAID_SAFE = 'No eligible paid group was found on this dashboard. Check the Paid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.';
const UNPAID_SAFE = 'No eligible unpaid group was found on this dashboard. Check the Unpaid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.';
const GENERIC_SAFE = 'The extension could not match the selected IVR to a dashboard group. Check the IVR in Settings; if it matches, report this message.';
const MAINTENANCE_SAFE = 'The visa website is under maintenance. Wait for it to recover, then press Start.';

const idleSnapshot = (mode: string): Record<string, unknown> =>
  ({ mode, status: 'idle', reviewRequired: false, dates: [], rows: [], checkedAt: null, currentDate: null, confirmedDate: null });
const failureSnapshot = (mode: string, kind: string): Record<string, unknown> =>
  ({ ...idleSnapshot(mode), status: 'failure', reviewRequired: true, failureKind: kind,
    reviewMessage: kind === 'paid-ivr-not-found' ? PAID_SAFE : kind === 'unpaid-ivr-not-found' ? UNPAID_SAFE : GENERIC_SAFE });

function stubEngine(options: {
  snapshot: Record<string, unknown>;
  lastMode?: unknown;
  onMessage?: (message: { type: string; mode?: string }) => unknown;
}) {
  const localState: Record<string, unknown> = {
    uiPreferencesV1: { ...DEMO_PREFERENCES },
    uiLastModeV1: options.lastMode ?? (options.snapshot.mode as string),
  };
  const holder: { snapshot: Record<string, unknown> } = { snapshot: options.snapshot };
  const sendMessage = vi.fn(async (message: { type: string; mode?: string }) => {
    if (options.onMessage) return options.onMessage(message);
    return { ok: true, snapshot: holder.snapshot };
  });
  vi.stubGlobal('chrome', {
    runtime: { id: 'synthetic', sendMessage },
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
  return { sendMessage, holder,
    refreshWorker: async (snapshot: Record<string, unknown>) => {
      holder.snapshot = snapshot;
      const listener = (chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      await act(async () => { listener?.({ engineObservationV1: {} }, 'local'); });
    } };
}

describe('panel command error typing', () => {
  it('passes through validated failure metadata and keeps safe messages', async () => {
    const sendMessage = vi.fn(async () => ({ ok: false, error: UNPAID_SAFE, failureKind: 'unpaid-ivr-not-found' }));
    vi.stubGlobal('chrome', { runtime: { id: 'synthetic', sendMessage } });
    const { PanelCommandError, panelCommand } = await import('../src/ui/engine');
    const failure = await panelCommand('START', 'alerts').catch(error => error);
    expect(failure).toBeInstanceOf(PanelCommandError);
    expect((failure as InstanceType<typeof PanelCommandError>).failureKind).toBe('unpaid-ivr-not-found');
    expect((failure as Error).message).toBe(UNPAID_SAFE);
  });

  it('falls back to the catch-all kind for unknown or missing metadata', async () => {
    for (const reply of [
      { ok: false, error: GENERIC_SAFE, failureKind: 'bogus-kind' },
      { ok: false, error: GENERIC_SAFE },
      { ok: false },
    ]) {
      vi.resetModules();
      const sendMessage = vi.fn(async () => reply);
      vi.stubGlobal('chrome', { runtime: { id: 'synthetic', sendMessage } });
      const { PanelCommandError, panelCommand } = await import('../src/ui/engine');
      const failure = await panelCommand('START', 'booking').catch(error => error);
      expect(failure).toBeInstanceOf(PanelCommandError);
      expect((failure as InstanceType<typeof PanelCommandError>).failureKind).toBe('generic');
    }
  });
});

describe('persisted worker failure screens', () => {
  it.each([
    { kind: 'generic', title: 'That didn’t work', mode: 'booking' },
    { kind: 'paid-ivr-not-found', title: 'Couldn’t find paid group', mode: 'booking' },
    { kind: 'unpaid-ivr-not-found', title: 'Couldn’t find unpaid group', mode: 'alerts' },
  ])('renders "$title" with configure and retry affordances', async ({ kind, title, mode }) => {
    stubEngine({ snapshot: failureSnapshot(mode, kind) });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: title })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Check configurations' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull();
    expect(screen.getByText('Tap to retry')).not.toBeNull();
    // The screen already conveys the diagnostic: no duplicate banner.
    expect(screen.queryByRole('alert')).toBeNull();
    // Check configurations opens Settings without starting work.
    await user.click(screen.getByRole('button', { name: 'Check configurations' }));
    expect(screen.getByLabelText('Email')).not.toBeNull();
  });

  it('keeps the specific screen across a stale idle refresh and clears on healthy work', async () => {
    const { refreshWorker } = stubEngine({ snapshot: failureSnapshot('booking', 'paid-ivr-not-found') });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('heading', { name: 'Couldn’t find paid group' });
    // A thrown START leaves the old idle snapshot behind; it must not discard.
    await refreshWorker(idleSnapshot('booking'));
    expect(screen.getByRole('heading', { name: 'Couldn’t find paid group' })).not.toBeNull();
    // Healthy running state clears the screen error.
    await refreshWorker({ ...idleSnapshot('booking'), status: 'running' });
    expect(screen.queryByRole('heading', { name: 'Couldn’t find paid group' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull();
  });

  it('restores the persisted failure when returning to the failed workflow', async () => {
    stubEngine({ snapshot: failureSnapshot('booking', 'generic') });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'That didn’t work' });
    await user.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(screen.queryByRole('heading', { name: 'That didn’t work' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Booking' }));
    expect(await screen.findByRole('heading', { name: 'That didn’t work' })).not.toBeNull();
  });

  it('returns to Start after saving corrected settings for a persisted IVR failure', async () => {
    stubEngine({ snapshot: failureSnapshot('booking', 'paid-ivr-not-found') });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Check configurations' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Start' })).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Couldn’t find paid group' })).toBeNull();
  });
});

describe('Start-command failure screens', () => {
  it('quietly retries a lost restart response at the configured staggered interval', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const success = { ...idleSnapshot('booking'), status: 'success', confirmedDate: '2026-11-19' };
    let attempts = 0;
    const h = stubEngine({ snapshot: success, onMessage: message => {
      if (message.type !== 'PANEL_START') return { ok: true, snapshot: success };
      attempts++;
      return attempts === 1 ? { ok: false, error: PAID_SAFE, failureKind: 'paid-ivr-not-found' }
        : { ok: true, snapshot: { ...idleSnapshot('booking'), status: 'running' } };
    } });
    const { App } = await import('../src/ui/App');
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(attempts).toBe(1);
    expect(screen.queryByRole('heading', { name: 'Appointment booked' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'That didn’t work' })).toBeNull();
    await h.refreshWorker(success);
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(attempts).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(attempts).toBe(2);
    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull();
  });

  it('shows the generic design error only after ten lost restart responses, not the old success', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const success = { ...idleSnapshot('booking'), status: 'success', confirmedDate: '2026-11-19' };
    let attempts = 0;
    const h = stubEngine({ snapshot: success, onMessage: message => {
      if (message.type !== 'PANEL_START') return { ok: true, snapshot: success };
      attempts++; return { ok: false, error: PAID_SAFE, failureKind: 'paid-ivr-not-found' };
    } });
    const { App } = await import('../src/ui/App');
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    for (let retry = 1; retry < 10; retry++) {
      expect(screen.queryByRole('heading', { name: 'That didn’t work' })).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    }
    expect(attempts).toBe(10);
    expect(screen.getByRole('heading', { name: 'That didn’t work' })).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Appointment booked' })).toBeNull();
    await h.refreshWorker(success);
    expect(screen.getByRole('heading', { name: 'That didn’t work' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Check configurations' })).not.toBeNull();
  });

  it('cancels lost-response restart retries when Stop is pressed', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const success = { ...idleSnapshot('booking'), status: 'success', confirmedDate: '2026-11-19' };
    let attempts = 0;
    stubEngine({ snapshot: success, onMessage: message => {
      if (message.type !== 'PANEL_START') return { ok: true, snapshot: success };
      attempts++; throw new Error('Synthetic lost response');
    } });
    const { App } = await import('../src/ui/App');
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(attempts).toBe(1);
  });

  it('hands lost-response retries to an observed worker run instead of starting again after it succeeds', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const success = { ...idleSnapshot('booking'), status: 'success', confirmedDate: '2026-11-19' };
    let attempts = 0;
    const h = stubEngine({ snapshot: success, onMessage: message => {
      if (message.type !== 'PANEL_START') return { ok: true, snapshot: h.holder.snapshot };
      attempts++; throw new Error('Synthetic response lost after acceptance');
    } });
    const { App } = await import('../src/ui/App');
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await h.refreshWorker({ ...idleSnapshot('booking'), status: 'running' });
    await h.refreshWorker(success);
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(attempts).toBe(1);
    expect(screen.getByRole('heading', { name: 'Appointment booked' })).not.toBeNull();
  });

  it('shows the paid screen when the typed paid IVR is missing', async () => {
    const { sendMessage } = stubEngine({
      snapshot: idleSnapshot('booking'),
      onMessage: message => message.type === 'PANEL_START'
        ? { ok: false, error: PAID_SAFE, failureKind: 'paid-ivr-not-found' }
        : { ok: true, snapshot: idleSnapshot('booking') },
    });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Couldn’t find paid group' })).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'PANEL_START', mode: 'booking' });
  });

  it('shows the unpaid screen for a wrong unpaid Start', async () => {
    const { sendMessage } = stubEngine({
      snapshot: idleSnapshot('alerts'),
      lastMode: 'alerts',
      onMessage: message => message.type === 'PANEL_START'
        ? { ok: false, error: UNPAID_SAFE, failureKind: 'unpaid-ivr-not-found' }
        : { ok: true, snapshot: idleSnapshot('alerts') },
    });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Couldn’t find unpaid group' })).not.toBeNull();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'PANEL_START', mode: 'alerts' });
  });

  it('catches other genuine workflow failures with the catch-all screen', async () => {
    stubEngine({
      snapshot: idleSnapshot('booking'),
      onMessage: message => message.type === 'PANEL_START'
        ? { ok: false, error: GENERIC_SAFE, failureKind: 'generic' }
        : { ok: true, snapshot: idleSnapshot('booking') },
    });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'That didn’t work' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull();
  });

  it.each(['missing-response', 'unknown-response', 'connection-rejection'])('uses the catch-all for %s Start failures', async issue => {
    stubEngine({ snapshot: idleSnapshot('booking'), onMessage: message => {
      if (message.type !== 'PANEL_START') return { ok: true, snapshot: idleSnapshot('booking') };
      if (issue === 'connection-rejection') throw new Error('synthetic-private-transport-detail');
      return issue === 'missing-response' ? undefined : { ok: false, error: 'synthetic-private-worker-detail', failureKind: 'unknown' };
    } });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'That didn’t work' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/synthetic-private/)).toBeNull();
  });

  it('retries with the same workflow Start and recovers on running', async () => {
    let attempts = 0;
    const running = { ...idleSnapshot('booking'), status: 'running' };
    stubEngine({
      snapshot: idleSnapshot('booking'),
      onMessage: message => {
        if (message.type !== 'PANEL_START') return { ok: true, snapshot: idleSnapshot('booking') };
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: PAID_SAFE, failureKind: 'paid-ivr-not-found' }
          : { ok: true, snapshot: running };
      },
    });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByRole('heading', { name: 'Couldn’t find paid group' });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Stop' });
    expect(attempts).toBe(2);
    expect(screen.queryByRole('heading', { name: 'Couldn’t find paid group' })).toBeNull();
  });

  it('clears the screen error when Settings are saved', async () => {
    stubEngine({
      snapshot: idleSnapshot('booking'),
      onMessage: message => message.type === 'PANEL_START'
        ? { ok: false, error: PAID_SAFE, failureKind: 'paid-ivr-not-found' }
        : { ok: true, snapshot: idleSnapshot('booking') },
    });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByRole('heading', { name: 'Couldn’t find paid group' });
    await user.click(screen.getByRole('button', { name: 'Check configurations' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.queryByRole('heading', { name: 'Couldn’t find paid group' })).toBeNull();
  });

  it('keeps maintenance as a banner-only running panel', async () => {
    stubEngine({
      snapshot: idleSnapshot('booking'),
      onMessage: message => message.type === 'PANEL_START'
        ? { ok: false, error: MAINTENANCE_SAFE, failureKind: 'generic' }
        : { ok: true, snapshot: idleSnapshot('booking') },
    });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('under maintenance');
    expect(screen.queryByRole('heading', { name: 'That didn’t work' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start' })).not.toBeNull();
  });
});

describe('manual and verification recovery preserved', () => {
  it('keeps the manual sign-in banner without a failure screen', async () => {
    stubEngine({ snapshot: { ...idleSnapshot('booking'), status: 'running',
      manualAuthentication: true, reviewMessage: 'Sign in manually on the official website, then press Start.' } });
    const { App } = await import('../src/ui/App');
    render(<App />);
    await screen.findByRole('button', { name: 'Stop' });
    expect(screen.getByRole('alert').textContent).toContain('Sign in manually');
    expect(screen.queryByRole('heading', { name: 'That didn’t work' })).toBeNull();
  });

  it('keeps the unresolved-intent banner and routes Start back to verification', async () => {
    const verifying = { ...idleSnapshot('alerts'), status: 'running', reviewRequired: true,
      checkedAt: '2026-10-13T18:00:00Z',
      reviewMessage: 'Checking the previous booking attempt. No new booking will start during this check.' };
    const { sendMessage } = stubEngine({ snapshot: verifying, lastMode: 'alerts' });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Stop' });
    await user.click(screen.getByRole('button', { name: 'Booking' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(screen.getByRole('alert').textContent).toContain('previous booking attempt');
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'PANEL_START', mode: 'booking' });
    expect(screen.queryByRole('heading', { name: 'That didn’t work' })).toBeNull();
  });

  it('preserves unresolved booking guidance beside a stopped failure', async () => {
    const recovery = 'The previous booking attempt needs checking. Press Start to verify its result first.';
    const { sendMessage } = stubEngine({ snapshot: { ...failureSnapshot('booking', 'generic'), reviewMessage: `${recovery} ${GENERIC_SAFE}` } });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole('heading', { name: 'That didn’t work' });
    expect(screen.getByRole('alert').textContent).toContain(recovery);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'PANEL_START', mode: 'booking' });
  });

  it.each(['verification', 'manual-authentication'])('clears a stale local error for %s recovery', async issue => {
    const recovery = issue === 'verification' ? 'The previous booking attempt needs checking. Press Start to verify its result first.'
      : 'Sign in manually on the official website, then press Start.';
    const h = stubEngine({ snapshot: idleSnapshot('booking') });
    h.sendMessage.mockImplementation(async message => message.type === 'PANEL_START'
      ? { ok: false, error: PAID_SAFE, failureKind: 'paid-ivr-not-found' }
      : { ok: true, snapshot: h.holder.snapshot });
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByRole('heading', { name: 'Couldn’t find paid group' });
    await h.refreshWorker({ ...idleSnapshot('booking'), reviewRequired: true, reviewMessage: recovery,
      ...(issue === 'manual-authentication' ? { manualAuthentication: true } : {}) });
    expect(screen.queryByRole('heading', { name: 'Couldn’t find paid group' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(recovery);
    expect(screen.getByRole('button', { name: 'Start' })).not.toBeNull();
  });
});

describe('developer preview failure scenarios', () => {
  async function preview() {
    const { App } = await import('../src/ui/App');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Get date alerts For Unpaid Visa Group' });
    await user.click(screen.getByRole('button', { name: 'Fill synthetic preferences' }));
    await user.click(screen.getByRole('button', { name: 'Book or reschedule For Paid Visa Group' }));
    await screen.findByRole('button', { name: 'Start preview' });
    return user;
  }

  it.each([
    { option: 'Generic failure', title: 'That didn’t work' },
    { option: 'Paid group failure', title: 'Couldn’t find paid group' },
    { option: 'Unpaid group failure', title: 'Couldn’t find unpaid group' },
  ])('previews "$title" without product controls', async ({ option, title }) => {
    const user = await preview();
    await user.selectOptions(screen.getByLabelText('Preview scenario'), option);
    expect(await screen.findByRole('heading', { name: title })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Check configurations' })).not.toBeNull();
    expect(screen.getByText('Tap to retry')).not.toBeNull();
    expect(screen.queryByText('Login Failed')).toBeNull();
    expect(screen.queryByText('Login failure')).toBeNull();
  });
});
