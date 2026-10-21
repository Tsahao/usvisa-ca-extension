// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConsulateSelect } from '../src/ui/ConsulateSelect';
import type { Consulate } from '../src/domain/dates';

afterEach(cleanup);

function setup(disabled = false) {
  const change = vi.fn();
  const blur = vi.fn();
  const submit = vi.fn();
  function Harness() {
    const [value, setValue] = useState<Consulate[]>([]);
    return <><form onSubmit={event => { event.preventDefault(); submit(); }}><fieldset disabled={disabled}><ConsulateSelect value={value} change={next => { setValue(next); change(next); }} onFocus={() => {}} onBlur={blur} /></fieldset></form><button>After selector</button></>;
  }
  render(<Harness />);
  return { user: userEvent.setup(), change, blur, submit, trigger: screen.getByRole('button', { name: 'Consulate' }) };
}

describe('Figma multi-consulate menu', () => {
  it('supports keyboard selection without collapsing, navigation, Escape, and Tab dismissal', async () => {
    const { user, trigger, change } = setup();
    trigger.focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(change).toHaveBeenLastCalledWith(['Calgary']);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Calgary' }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{End}{Enter}');
    expect(change).toHaveBeenLastCalledWith(['Calgary', 'Quebec']);
    await user.keyboard('{Home}{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'Quebec City' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{ArrowUp}{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After selector' }));
  });

  it('dismisses on outside click without losing selections or submitting a form', async () => {
    const { user, trigger, blur, submit } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Vancouver' }));
    await user.click(screen.getByRole('button', { name: 'After selector' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.textContent).toBe('Vancouver');
    expect(blur).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await user.click(trigger);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Vancouver' }).getAttribute('aria-checked')).toBe('true');
  });

  it('inherits the active-run settings lock and never opens', async () => {
    const { user, trigger, change } = setup(true);
    expect(trigger.matches(':disabled')).toBe(true);
    await user.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });
});
