// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReportProblem } from '../src/ui/ReportProblem';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture(sendMessage = vi.fn(async () => ({ ok: true, diagnostics: { version: 1, entries: [] },
  context: { status: 'stopped', stage: 'form' } }))) {
  const create = vi.fn(async (_options: { url: string }) => ({}));
  vi.stubGlobal('chrome', { runtime: { sendMessage, getManifest: () => ({ version: '0.2.2' }) }, tabs: { create } });
  render(<ReportProblem live mode="booking" status="failure" autoMode failureKind="generic" />);
  return { sendMessage, create, button: screen.getByRole('button', { name: 'Report a problem' }) };
}

describe('Report problem button', () => {
  it('only reads diagnostics and opens an editable mailto draft', async () => {
    const f = fixture(); fireEvent.click(f.button);
    await waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ENGINE_PROBLEM_REPORT' });
    const url = f.create.mock.calls[0][0].url;
    expect(url).toMatch(/^mailto:browser\.latte\.1k@icloud\.com\?/);
    expect(new URL(url).searchParams.get('body')).toContain('Workflow stage: form');
  });
  it('still opens a basic draft if the worker is unreachable', async () => {
    const f = fixture(vi.fn(async () => { throw new Error('private raw error'); }));
    fireEvent.click(f.button);
    await waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
    expect(new URL(f.create.mock.calls[0][0].url).searchParams.get('body')).toContain('Diagnostics unavailable.');
  });
  it('bounds a stalled worker request and prevents duplicate drafts while loading', async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(() => new Promise(() => {})));
    fireEvent.click(f.button); fireEvent.click(f.button);
    expect((f.button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('shows a safe error if opening the email handler fails', async () => {
    const f = fixture(); f.create.mockRejectedValue(new Error('private raw error'));
    fireEvent.click(f.button);
    expect((await screen.findByRole('alert')).textContent).toBe('Unable to open your email app. Please try again.');
  });
});
