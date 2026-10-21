// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Configuration } from '../src/ui/Configuration';
import { PreferenceFields } from '../src/ui/PreferenceFields';
import { DEMO_PREFERENCES, EMPTY_PREFERENCES, preferenceIssues, preferencesError, updatePreference } from '../src/ui/model';
import { CONSULATE_ORDER, validatePreferences } from '../src/domain/dates';

afterEach(cleanup);

function setup(preferences = EMPTY_PREFERENCES) {
  const props = { preferences, active: false, save: vi.fn(async () => {}), cancel: vi.fn(), trackScroll: vi.fn(), openTerms: vi.fn() };
  return { ...render(<Configuration {...props} />), props, user: userEvent.setup() };
}

function expectQuiet() { expect(screen.queryByRole('alert')).toBeNull(); }
function saveDisabled() { return (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled; }

describe('Settings validation timing', () => {
  it('raises the interval only when needed as selections grow, and keeps Reset Advanced above the minimum', async () => {
    const { user, props } = setup({ ...DEMO_PREFERENCES, interval: 30 });
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    const interval = screen.getByLabelText('Checking interval (s)') as HTMLInputElement;
    expect(interval.min).toBe('30');
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }));
    expect(interval.min).toBe('60');
    expect(interval.value).toBe('60');
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Halifax' }));
    expect(interval.min).toBe('90');
    expect(interval.value).toBe('90');
    expect(screen.getByRole('button', { name: 'Consulate' }).title).toBe('');
    await user.keyboard('{Escape}');
    fireEvent.change(interval, { target: { value: '89' } });
    expect(saveDisabled()).toBe(true);
    await user.click(interval);
    await user.click(screen.getByLabelText('Email'));
    expect(screen.getByRole('alert').textContent).toBe('Checking interval must be a whole number from 90 to 86400 seconds.');
    await user.click(screen.getByRole('button', { name: 'Reset Advanced' }));
    expect(interval.value).toBe('90');
    expect(saveDisabled()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Halifax' }));
    expect(interval.min).toBe('60');
    expect(interval.value).toBe('60');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.save).toHaveBeenCalledExactlyOnceWith({ ...DEMO_PREFERENCES, consulates: ['Calgary', 'Vancouver'], interval: 60 });
  });

  it.each([false, true])('reverses an automatic increase unless the interval was manually overwritten (%s)', async manual => {
    const { user, props } = setup(DEMO_PREFERENCES);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    const interval = screen.getByLabelText('Checking interval (s)') as HTMLInputElement;
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Halifax' }));
    expect(interval.value).toBe('90');
    await user.keyboard('{Escape}');
    if (manual) {
      // Retyping the same auto-raised number still expresses a manual choice.
      await user.clear(interval);
      await user.type(interval, '90');
    }
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Halifax' }));
    expect(interval.value).toBe(manual ? '90' : '60');
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }));
    expect(interval.value).toBe(manual ? '90' : '60');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.save).toHaveBeenCalledExactlyOnceWith({ ...DEMO_PREFERENCES, interval: manual ? 90 : 60 });
  });

  it('raises an old below-minimum interval in the draft without changing saved preferences', async () => {
    const saved = { ...DEMO_PREFERENCES, consulates: [...CONSULATE_ORDER], interval: 60 };
    const { user, props } = setup(saved);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect((screen.getByLabelText('Checking interval (s)') as HTMLInputElement).value).toBe('210');
    expect(saved.interval).toBe(60);
    expect(props.save).not.toHaveBeenCalled();
  });
  it('allows saving a 30-second checking interval', async () => {
    const { user, props } = setup(DEMO_PREFERENCES);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    const input = screen.getByLabelText('Checking interval (s)');
    expect(input.getAttribute('min')).toBe('30');
    await user.clear(input);
    await user.type(input, '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.save).toHaveBeenCalledExactlyOnceWith({ ...DEMO_PREFERENCES, interval: 30 });
    expectQuiet();
  });

  it('stays quiet throughout first-time entry and only enables Save for a complete valid draft', async () => {
    const { user, props } = setup();
    expectQuiet();
    expect(saveDisabled()).toBe(true);
    await user.type(screen.getByLabelText('Email'), 'synthetic@example.invalid');
    expectQuiet();
    await user.type(screen.getByLabelText('Password'), 'synthetic-password');
    expectQuiet();
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }));
    expectQuiet();
    await user.click(screen.getByLabelText('Earliest Acceptable'));
    fireEvent.change(screen.getByLabelText('Earliest Acceptable'), { target: { value: '2026-11-01' } });
    await user.click(screen.getByLabelText('Latest Acceptable'));
    expectQuiet();
    expect(saveDisabled()).toBe(true);
    fireEvent.change(screen.getByLabelText('Latest Acceptable'), { target: { value: '2027-12-31' } });
    expectQuiet();
    expect(saveDisabled()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.save).toHaveBeenCalledExactlyOnceWith({ ...EMPTY_PREFERENCES, email: 'synthetic@example.invalid', password: 'synthetic-password', consulates: ['Calgary'], earliest: '2026-11-01', latest: '2027-12-31' });
    expectQuiet();
  });

  it.each([
    ['Password', 'Enter your visa account password.'],
    ['Earliest Acceptable', 'Choose a valid inclusive date window.'],
    ['Latest Acceptable', 'Choose a valid inclusive date window.'],
  ])('only warns about the completed %s field and hides its warning on refocus', async (label, message) => {
    const { user } = setup();
    await user.click(screen.getByLabelText(label));
    expectQuiet();
    await user.click(screen.getByRole('heading', { name: 'Login and preferences' }));
    expect(screen.getByRole('alert').textContent).toBe(message);
    await user.click(screen.getByLabelText(label));
    expectQuiet();
    expect(saveDisabled()).toBe(true);
  });

  it('warns about an emptied consulate group only after focus leaves it', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }));
    expectQuiet();
    await user.click(screen.getByRole('heading', { name: 'Login and preferences' }));
    expect(screen.getByRole('alert').textContent).toBe('Select at least one consulate.');
    await user.click(screen.getByRole('button', { name: 'Consulate' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }));
    expectQuiet();
  });

  it('keeps the checkmark menu open while selecting and stores the canonical order', async () => {
    let latestDraft = { ...EMPTY_PREFERENCES };
    function Harness() {
      const [draft, setDraft] = useState(EMPTY_PREFERENCES);
      latestDraft = draft;
      return <PreferenceFields draft={draft} update={(key, value) => setDraft(current => updatePreference(current, key, value))} validationEvents={() => ({ onFocus: () => {}, onBlur: () => {} })} />;
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Consulate' });
    expect(trigger.textContent).toBe('Select');
    expect(screen.getByText('Select one or multiple')).toBeTruthy();
    await user.click(trigger);
    expect(screen.getAllByRole('menuitemcheckbox').map(item => item.textContent)).toEqual(['Calgary', 'Halifax', 'Ottawa', 'Toronto', 'Vancouver', 'Montreal', 'Quebec City']);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Toronto' }));
    expect(trigger.textContent).toBe('Toronto');
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Halifax' }));
    expect(latestDraft.consulates).toEqual(['Halifax', 'Toronto']);
    expect(trigger.textContent).toBe('2 Selected');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Toronto' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Halifax' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Vancouver' }));
    expect(trigger.title).toBe('');
    expect(latestDraft.interval).toBe(90);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Toronto' }));
    expect(latestDraft.consulates).toEqual(['Halifax', 'Vancouver']);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('removes corrected warnings without exposing the next untouched required field', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Password'));
    await user.click(screen.getByLabelText('Email'));
    expect(screen.getByRole('alert').textContent).toMatch(/password/);
    await user.type(screen.getByLabelText('Password'), 'synthetic-password');
    await user.click(screen.getByLabelText('Email'));
    expectQuiet();
    expect(saveDisabled()).toBe(true);
  });

  it('waits for both date fields to finish before showing a reversed-window warning', async () => {
    const { user } = setup({ ...DEMO_PREFERENCES, earliest: '', latest: '2026-11-01' });
    const earliest = screen.getByLabelText('Earliest Acceptable');
    const latest = screen.getByLabelText('Latest Acceptable');
    await user.click(earliest);
    fireEvent.change(earliest, { target: { value: '2027-01-01' } });
    await user.click(screen.getByLabelText('Email'));
    expectQuiet(); // The prefilled other date has not been reviewed yet.
    expect(saveDisabled()).toBe(true);
    await user.click(latest);
    expectQuiet();
    await user.click(screen.getByLabelText('Email'));
    expect(screen.getByRole('alert').textContent).toBe('Choose a valid inclusive date window.');
    await user.click(earliest);
    expectQuiet();
    fireEvent.change(earliest, { target: { value: '2026-10-31' } });
    await user.click(screen.getByLabelText('Email'));
    expectQuiet();
    expect(saveDisabled()).toBe(false);
  });

  it.each([
    ['Checking interval (s)', '1', /Checking interval/],
    ['Paid IVR Group', 'synthetic', /IVR groups/],
    ['Unpaid IVR Group', 'synthetic', /IVR groups/],
  ] as const)('defers invalid %s until blur; Reset Advanced clears it without flagging untouched fields', async (label, value, message) => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.clear(screen.getByLabelText(label));
    await user.type(screen.getByLabelText(label), value);
    expectQuiet();
    await user.click(screen.getByLabelText('Email'));
    expect(screen.getByRole('alert').textContent).toMatch(message);
    await user.click(screen.getByRole('button', { name: 'Reset Advanced' }));
    expectQuiet();
    expect(saveDisabled()).toBe(true);
  });

  it('resets completion and stale save errors when asynchronous preferences are replaced', async () => {
    const { user, props, rerender } = setup(DEMO_PREFERENCES);
    props.save.mockRejectedValueOnce(new Error('synthetic storage failure'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('Unable to save preferences. Please try again.');
    rerender(<Configuration {...props} preferences={{ ...EMPTY_PREFERENCES }} />);
    expectQuiet();
    await user.type(screen.getByLabelText('Email'), 'synthetic@example.invalid');
    expectQuiet();
    expect(saveDisabled()).toBe(true);
  });

  it('resets completed-field warnings on preference replacement and preserves the active lock', async () => {
    const { user, props, rerender } = setup();
    await user.click(screen.getByLabelText('Password'));
    await user.click(screen.getByLabelText('Email'));
    expect(screen.getByRole('alert')).not.toBeNull();
    rerender(<Configuration {...props} preferences={{ ...EMPTY_PREFERENCES }} active />);
    expectQuiet();
    expect(screen.getByLabelText('Password').matches(':disabled')).toBe(true);
    expect(saveDisabled()).toBe(true);
    fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    expect(props.save).not.toHaveBeenCalled();
  });

  it('retains the independent submit guard even when an invalid form is submitted programmatically', () => {
    const { props } = setup();
    fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    expect(props.save).not.toHaveBeenCalled();
    expectQuiet();
  });
});

describe('shared preference validation', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('enforces the %s-consulate minimum on valid integer intervals', count => {
    const consulates = CONSULATE_ORDER.slice(0, count);
    expect(preferencesError({ ...DEMO_PREFERENCES, consulates, interval: count * 30 })).toBeNull();
    expect(preferencesError({ ...DEMO_PREFERENCES, consulates, interval: count * 30 - 1 })).toBe(`Checking interval must be a whole number from ${count * 30} to 86400 seconds.`);
    expect(preferencesError({ ...DEMO_PREFERENCES, consulates, interval: 86400 })).toBeNull();
    expect(preferencesError({ ...DEMO_PREFERENCES, consulates, interval: 86401 })).not.toBeNull();
    expect(preferencesError({ ...DEMO_PREFERENCES, consulates, interval: count * 30 + 0.5 })).not.toBeNull();
  });
  it('requires at least one consulate', () => {
    expect(preferenceIssues({ ...DEMO_PREFERENCES, consulates: [] })).toContainEqual({ fields: ['consulates'], message: 'Select at least one consulate.' });
    expect(preferenceIssues({ ...DEMO_PREFERENCES, consulates: ['Toronto', 'Halifax'] }).some(issue => issue.fields.includes('consulates'))).toBe(false);
  });

  it.each([29, 30, 59, 60, 30.5, 86400, 86401])('validates checking interval boundary %s', interval => {
    const error = preferencesError({ ...DEMO_PREFERENCES, interval });
    if (Number.isInteger(interval) && interval >= 30 && interval <= 86400) expect(error).toBeNull();
    else expect(error).toBe('Checking interval must be a whole number from 30 to 86400 seconds.');
  });

  it.each([
    ['', ''], ['2026-02-30', '2027-01-01'], ['2027-01-01', '2026-11-01'],
    ['2026-11-01', '2026-11-01'], ['2026-11-01', '2027-01-01'],
  ])('keeps UI date validity identical to domain validation for %s–%s', (earliest, latest) => {
    const prefs = { ...DEMO_PREFERENCES, earliest, latest };
    let domainValid = true;
    try { validatePreferences({ ...prefs, exclusions: [] }); } catch { domainValid = false; }
    expect(preferencesError(prefs) === null).toBe(domainValid);
  });

  it('keeps the no-email-format-gate decision and reports independently scoped invalid IVRs', () => {
    expect(preferencesError({ ...DEMO_PREFERENCES, email: 'not-an-email' })).toBeNull();
    expect(preferenceIssues({ ...DEMO_PREFERENCES, unpaidIvr: 'synthetic' })).toEqual([
      { fields: ['unpaidIvr'], message: 'IVR groups must contain digits only.' },
    ]);
  });
});
