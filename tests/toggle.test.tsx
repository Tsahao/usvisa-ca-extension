// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toggle } from '../src/ui/Toggle';

afterEach(cleanup);

describe('shared Figma toggle', () => {
  it('toggles through both the visible label and the native keyboard interaction', async () => {
    const change = vi.fn();
    function Harness() {
      const [checked, setChecked] = useState(false);
      return <Toggle label="Auto Book" checked={checked} change={value => { setChecked(value); change(value); }} />;
    }
    const user = userEvent.setup();
    render(<Harness />);
    const control = screen.getByRole('switch', { name: 'Auto Book' }) as HTMLInputElement;
    expect(control.checked).toBe(false);
    await user.click(screen.getByText('Auto Book'));
    expect(change).toHaveBeenLastCalledWith(true);
    expect(control.checked).toBe(true);
    control.focus();
    await user.keyboard(' ');
    expect(change).toHaveBeenLastCalledWith(false);
    expect(control.checked).toBe(false);
  });

  it.each(['own disabled prop', 'disabled fieldset'])('keeps its checked state and cannot change through %s', async lock => {
    const change = vi.fn();
    render(<fieldset disabled={lock === 'disabled fieldset'}><Toggle label="Earlier appointments only" checked change={change} disabled={lock === 'own disabled prop'} /></fieldset>);
    const user = userEvent.setup();
    const control = screen.getByRole('switch', { name: 'Earlier appointments only' }) as HTMLInputElement;
    expect(control.matches(':disabled')).toBe(true);
    await user.click(control);
    await user.click(screen.getByText('Earlier appointments only'));
    expect(control.checked).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });
});
