// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { History } from '../src/ui/History';
import { NO_VALUE } from '../src/ui/model';
import { HISTORY_KEY, HISTORY_TTL_MS } from '../src/domain/history';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('read-only live history view', () => {
  it('loads local rows, refreshes on history changes, and unsubscribes without workflow commands', async () => {
    const rows = [{ id: 'row-1', checkedAt: new Date().toISOString(), earliestDate: '2026-11-19', booked: 'Attempted', consulate: 'Vancouver' }];
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, rows });
    let changed: (changes: Record<string, unknown>, area: string) => void = () => {};
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage }, storage: { onChanged: { addListener: (listener: typeof changed) => { changed = listener; }, removeListener } } });
    const { unmount } = render(<History live trackScroll={() => {}} />);
    expect(await screen.findByText('Vancouver')).not.toBeNull();
    rows[0].earliestDate = '2026-11-20';
    act(() => changed({ [HISTORY_KEY]: {} }, 'local'));
    expect(await screen.findByText('Nov 20, 2026')).not.toBeNull();
    act(() => changed({ engineStateV1: {} }, 'local'));
    expect(sendMessage.mock.calls).toEqual([[{ type: 'PANEL_HISTORY' }], [{ type: 'PANEL_HISTORY' }]]);
    unmount();
    expect(removeListener).toHaveBeenCalledWith(changed);
  });

  it('reports storage failure without displaying a false empty result or inventing history', async () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: false }) },
      storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
    render(<History live trackScroll={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to read date history.'));
    expect(screen.queryByText('No available dates are recorded')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('removes a displayed row at its exact retention deadline while the view stays open', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-10-16T18:00:00.000Z');
    vi.setSystemTime(now);
    const rows = [{ id: 'row-1', checkedAt: new Date(now.getTime() - HISTORY_TTL_MS + 1000).toISOString(), earliestDate: '2026-11-19', booked: 'No' as const }];
    render(<History live={false} previewRows={rows} trackScroll={() => {}} />);
    expect(screen.getByRole('table')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No available dates are recorded')).not.toBeNull();
  });

  it('shows the consulate column, with a placeholder for rows that predate it', () => {
    const checkedAt = new Date().toISOString();
    const rows = [
      { id: 'row-1', checkedAt, earliestDate: '2026-11-19', booked: 'No' as const, consulate: 'Halifax' as const },
      { id: 'row-2', checkedAt, earliestDate: '2026-11-20', booked: 'No' as const },
    ];
    render(<History live={false} previewRows={rows} trackScroll={() => {}} />);
    const headers = screen.getAllByRole('columnheader').map(header => header.textContent);
    expect(headers).toEqual(['Checked', 'Earliest Date', 'City']);
    expect(screen.queryByRole('columnheader', { name: 'Booked' })).toBeNull();
    expect(screen.getByRole('cell', { name: 'Halifax' })).not.toBeNull();
    expect(screen.getByRole('cell', { name: NO_VALUE })).not.toBeNull();
  });
});
