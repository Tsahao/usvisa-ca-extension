// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/ui/App';
import { calendarDays, DEMO_PREFERENCES, preferencesError, shiftMonth } from '../src/ui/model';

afterEach(cleanup);

async function preview() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: 'Get date alerts For Unpaid Visa Group' });
  return user;
}

describe('Figma interface behavior', () => {
  it('opens View Logs with Back only and retains the unsaved Settings draft/disclosure', async () => {
    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Fill synthetic preferences' }));
    await user.click(screen.getByRole('button', { name: 'Open configuration' }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.clear(screen.getByLabelText('Checking interval (s)'));
    await user.type(screen.getByLabelText('Checking interval (s)'), '120');
    await user.click(screen.getByRole('button', { name: 'View Logs' }));
    expect(screen.getByText('No available dates are recorded')).not.toBeNull();
    const nav = screen.getByRole('navigation');
    expect(within(nav).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByLabelText('Checking interval (s)') as HTMLInputElement).value).toBe('120');
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('lets an active workflow view history while Settings remain locked, without stopping the run', async () => {
    const user = await preview();
    await user.selectOptions(screen.getByLabelText('Preview scenario'), 'running');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByLabelText('Email').matches(':disabled')).toBe(true);
    expect((screen.getByRole('button', { name: 'View Logs' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Reset Advanced' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'View Logs' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Stop preview' })).not.toBeNull();
  });

  it('opens Coffee from booking success and returns to the same result', async () => {
    const user = await preview();
    await user.selectOptions(screen.getByLabelText('Preview scenario'), 'success');
    await user.click(screen.getByRole('button', { name: 'Buy me a coffee?' }));
    expect((screen.getByRole('textbox', { name: 'Amount in USD' }) as HTMLInputElement).value).toBe('5');
    await user.click(screen.getByRole('button', { name: 'Booking' }));
    expect(screen.getByRole('heading', { name: 'Appointment booked' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Buy me a coffee?' })).not.toBeNull();
  });

  it('bounds coffee amounts to whole numbers from 1 through 99', async () => {
    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Open configuration' }));
    await user.click(screen.getByRole('button', { name: 'Coffee' }));
    const amount = screen.getByRole('textbox', { name: 'Amount in USD' }) as HTMLInputElement;
    for (const invalid of ['0', '-1', '1.5', '100', '1e1', 'NaN']) {
      fireEvent.change(amount, { target: { value: invalid } });
      expect(amount.value).toBe('5');
    }
    fireEvent.change(amount, { target: { value: '1' } });
    expect((screen.getByRole('button', { name: 'Decrease amount' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Increase amount' }));
    expect(amount.value).toBe('2');
    fireEvent.change(amount, { target: { value: '99' } });
    expect((screen.getByRole('button', { name: 'Increase amount' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(amount);
    expect((screen.getByRole('button', { name: 'Continue to Stripe' }) as HTMLButtonElement).disabled).toBe(true);
    await user.tab();
    expect(amount.value).toBe('5');
  });

  it('requires complete preferences but does not show terms before entering a workflow', async () => {
    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Get date alerts For Unpaid Visa Group' }));
    expect(screen.queryByRole('heading', { name: 'Terms & conditions' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'preview@example.invalid');
    await user.type(screen.getByLabelText('Password'), 'synthetic-password');
    await user.selectOptions(screen.getByLabelText('Consulate'), 'Calgary');
    await user.type(screen.getByLabelText('Earliest Acceptable'), '2026-11-01');
    await user.type(screen.getByLabelText('Latest Acceptable'), '2027-12-31');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Start preview' });
    await user.click(screen.getByRole('button', { name: 'Start preview' }));
    expect(screen.getByRole('heading', { name: 'Calgary' })).toBeDefined();
    const list = screen.getByLabelText('Other consulate dates');
    expect(list.children.length).toBe(6);
    expect(within(list).queryByText('Calgary')).toBeNull();
    expect(within(list).getByText('Vancouver')).toBeDefined();
  });

  it.each(['Book or reschedule For Paid Visa Group', 'Get date alerts For Unpaid Visa Group'])('opens and starts %s without terms acknowledgement', async entry => {
    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Fill synthetic preferences' }));
    await user.click(screen.getByRole('button', { name: entry }));
    await user.click(await screen.findByRole('button', { name: 'Start preview' }));
    expect(screen.queryByRole('heading', { name: 'Terms & conditions' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop preview' })).toBeDefined();
  });

  it('shows terms only through a deliberate hyperlink click', async () => {
    const user = await preview();
    await user.click(screen.getByRole('link', { name: 'Terms & Conditions' }));
    expect(screen.getByRole('heading', { name: 'Terms & conditions' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('link', { name: 'Terms & Conditions' })).toBeDefined();
  });

  it('returns from Terms to the same unsaved Settings draft and disclosure', async () => {
    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Get date alerts For Unpaid Visa Group' }));
    await user.type(screen.getByLabelText('Email'), 'draft@example.invalid');
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.type(screen.getByLabelText('Unpaid IVR Group'), '44444444');
    const form = screen.getByLabelText('Email').closest('form')!;
    const scroller = form.firstElementChild as HTMLElement;
    fireEvent.scroll(scroller, { target: { scrollTop: 90 } });
    await user.click(screen.getByRole('link', { name: 'Terms & Conditions' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'I Understand' })).toBeNull();
    expect(within(screen.getByRole('navigation')).getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('draft@example.invalid');
    expect((screen.getByLabelText('Unpaid IVR Group') as HTMLInputElement).value).toBe('44444444');
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
    expect(scroller.scrollTop).toBe(90);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Get date alerts For Unpaid Visa Group' })).not.toBeNull();
  });

  it('allows Terms from locked Settings without stopping the run', async () => {
    const user = await preview();
    await user.selectOptions(screen.getByLabelText('Preview scenario'), 'running');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('link', { name: 'Terms & Conditions' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Email').matches(':disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Stop preview' })).not.toBeNull();
  });

  it('shows two separated dashes, not one em dash, for missing values', async () => {
    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Fill synthetic preferences' }));
    await user.click(screen.getByRole('button', { name: 'Book or reschedule For Paid Visa Group' }));
    const earliest = screen.getByRole('heading', { name: 'Earliest Available' }).parentElement!;
    expect(within(earliest).getByText('- -')).toBeDefined();
    expect(screen.getByText('No current appointment')).toBeDefined();
    expect(document.body.textContent).not.toContain('—');
  });

  it('keeps a run on hide/tab navigation and requires explicit Stop', async () => {
    const user = await preview();
    await user.selectOptions(screen.getByLabelText('Preview scenario'), 'running');
    await screen.findByRole('button', { name: 'Stop preview' });
    await user.click(screen.getByRole('button', { name: 'Hide panel' }));
    await user.click(screen.getByRole('button', { name: 'Show scheduler · running' }));
    expect(screen.getByRole('button', { name: 'Stop preview' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Booking' }));
    expect(screen.getByRole('heading', { name: 'Earliest Available' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Stop preview' }));
    expect(screen.getByRole('button', { name: 'Start preview' })).toBeDefined();
  });

  it('discards cancelled edits and shows Auto Mode on without expanding Advanced', async () => {    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Fill synthetic preferences' }));
    await user.click(screen.getByRole('button', { name: 'Open configuration' }));
    await user.clear(screen.getByRole('textbox', { name: 'Email' }));
    expect((screen.getByRole('switch', { name: 'Auto Mode' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('switch', { name: 'Auto Mode' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Open configuration' }));
    expect((screen.getByRole('textbox', { name: 'Email' }) as HTMLInputElement).value).toBe('preview@example.invalid');
    expect((screen.getByRole('switch', { name: 'Auto Mode' }) as HTMLInputElement).checked).toBe(true);
  });

  it('reflects saved Auto Mode off and never shows the old amber warning', async () => {
    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Fill synthetic preferences' }));
    await user.click(screen.getByRole('button', { name: 'Open configuration' }));
    await user.click(screen.getByRole('switch', { name: 'Auto Mode' }));
    expect((screen.getByRole('switch', { name: 'Auto Mode' }) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByText(/Test Mode/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(screen.queryByText(/Test Mode/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open configuration' }));
    expect((screen.getByRole('switch', { name: 'Auto Mode' }) as HTMLInputElement).checked).toBe(false);
  });

  it('keeps Advanced limited to documented settings and resets them', async () => {
    const user = await preview();
    await user.click(screen.getByRole('button', { name: 'Fill synthetic preferences' }));
    await user.click(screen.getByRole('button', { name: 'Open configuration' }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.click(screen.getByRole('switch', { name: 'Auto Mode' }));
    await user.clear(screen.getByLabelText('Checking interval (s)'));
    await user.type(screen.getByLabelText('Checking interval (s)'), '120');
    await user.click(screen.getByRole('button', { name: 'Reset Advanced' }));
    expect((screen.getByRole('switch', { name: 'Auto Mode' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Checking interval (s)') as HTMLInputElement).value).toBe('60');
    expect(screen.getByLabelText('Paid IVR Group')).toBeDefined();
    expect(screen.getByLabelText('Unpaid IVR Group')).toBeDefined();
    expect(screen.queryByText(/exclusion|clear saved credentials|notifications:|alert range/i)).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps calendar days informational', async () => {
    const user = await preview();
    await user.selectOptions(screen.getByLabelText('Preview scenario'), 'running');
    const calendar = await screen.findByLabelText('Appointment availability calendar');
    expect(within(calendar).getAllByRole('button').length).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(within(calendar).getByText('January 2027')).toBeDefined();

  });

  it('protects active settings until Stop', async () => {
    const user = await preview();
    await user.selectOptions(screen.getByLabelText('Preview workflow'), 'alerts');
    await user.selectOptions(screen.getByLabelText('Preview scenario'), 'running');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByLabelText('Email').matches(':disabled')).toBe(true);
    expect(screen.getByRole('switch', { name: 'Auto Mode' }).matches(':disabled')).toBe(true);
    expect(screen.getByRole('note').textContent).toMatch(/stop monitoring to modify settings/i);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Stop preview' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByLabelText('Email').matches(':disabled')).toBe(false);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText(/Reset alert baseline/)).toBeNull();
  });
});

describe('calendar and preference edge cases', () => {
  it.each(['2026-02', '2026-05', '2026-08', '2026-12', '2028-02'])('always shows six complete weeks for %s', month => {
    const days = calendarDays(month);
    expect(days).toHaveLength(42);
    expect(new Set(days.map(day => day.iso)).size).toBe(42);
    expect(new Date(`${days[0].iso}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(new Date(`${days[41].iso}T00:00:00Z`).getUTCDay()).toBe(6);
    expect(days.filter(day => day.inMonth)).toHaveLength(new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`).getTime() / 86400000 - new Date(`${month}-01T00:00:00Z`).getTime() / 86400000);
  });
  it('handles leap years and year boundaries with Sunday-first weeks', () => {
    const days = calendarDays('2028-02');
    expect(days.filter(day => day.inMonth).length).toBe(29);
    expect(days.length % 7).toBe(0);
    expect(new Date(`${days[0].iso}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
  });
  it('rejects reversed date windows, invalid IVRs and impossible intervals', () => {
    expect(preferencesError(DEMO_PREFERENCES)).toBeNull();
    expect(preferencesError({ ...DEMO_PREFERENCES, earliest: '2028-01-01' })).toContain('window');
    expect(preferencesError({ ...DEMO_PREFERENCES, paidIvr: 'abc' })).toContain('digits');
    expect(preferencesError({ ...DEMO_PREFERENCES, interval: 0 })).toContain('interval');
  });
});
