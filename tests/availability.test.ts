import { describe, expect, it, vi } from 'vitest';
import { fetchDaysJson, fetchTimesJson } from '../src/adapter/poll';
import { parseDaysPayload, parseTimesPayload } from '../src/domain/availability';

describe('availability payloads', () => {
  it('accepts strict days and times shapes', () => {
    expect(parseDaysPayload([{ date: '2026-11-19' }, { date: '2026-11-20' }])).toEqual([
      { date: '2026-11-19' },
      { date: '2026-11-20' },
    ]);
    expect(parseDaysPayload([])).toEqual([]);
    expect(parseTimesPayload({ available_times: ['09:15', '10:30'] })).toEqual(['09:15', '10:30']);
  });

  it('rejects malformed payloads instead of misreading them', () => {
    for (const bad of [null, {}, 'x', [{ date: 'tomorrow' }], [{ date: null }], [{ noDate: 1 }]])
      expect(() => parseDaysPayload(bad)).toThrow('Invalid availability payload.');
    for (const bad of [null, [], {}, { available_times: ['9:15 AM'] }, { available_times: [42] }, { available_times: ['24:00'] }, { available_times: ['12:60'] }])
      expect(() => parseTimesPayload(bad)).toThrow('Invalid times payload.');
  });

  it('fetches page-side with the portal request marker', async () => {
    const json = vi.fn().mockResolvedValue([{ date: '2026-11-19' }]);
    const fetch = vi.fn().mockResolvedValue({ status: 200, json });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment' });
    try {
      const result = await fetchDaysJson('/en-ca/niv/schedule/12345/appointment', 95);
      expect(result).toEqual({ status: 200, body: [{ date: '2026-11-19' }] });
      expect(fetch.mock.calls[0][0]).toBe('/en-ca/niv/schedule/12345/appointment/days/95.json?appointments[expedite]=false');
      expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { 'x-requested-with': 'XMLHttpRequest' }, redirect: 'error', cache: 'no-store' });
      vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment?applicants[]=77777777' });
      const times = await fetchTimesJson('/en-ca/niv/schedule/12345/appointment', 95, '2026-11-19', ['77777777']);
      expect(times.status).toBe(200);
      expect(fetch.mock.calls[1][0]).toContain('/times/95.json?date=2026-11-19');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces error statuses with null bodies for worker classification', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 502, json: async () => { throw new Error('no body'); } });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment' });
    try {
      expect(await fetchDaysJson('/en-ca/niv/schedule/12345/appointment', 94)).toEqual({ status: 502, body: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects times requests with a different origin, route, or roster without fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      for (const href of ['https://example.invalid/',
        'https://ais.usvisa-info.com/en-ca/niv/schedule/99999/appointment?applicants[]=77777777',
        'https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment?applicants[]=88888888']) {
        vi.stubGlobal('location', { href });
        expect(await fetchTimesJson('/en-ca/niv/schedule/12345/appointment', 95, '2026-11-19', ['77777777']))
          .toEqual({ status: 0, body: null });
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects redirects and navigation during a times read', async () => {
    const href = 'https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment?applicants[]=77777777';
    vi.stubGlobal('location', { href });
    const fetch = vi.fn(async () => ({ status: 200, json: async () => {
      vi.stubGlobal('location', { href: 'https://example.invalid/' });
      return { available_times: ['09:15'] };
    } }));
    vi.stubGlobal('fetch', fetch);
    try {
      const isolated: typeof fetchTimesJson = new Function(`return (${fetchTimesJson.toString()})`)();
      expect(await isolated('/en-ca/niv/schedule/12345/appointment', 95, '2026-11-19', ['77777777'])).toEqual({ status: 0, body: null });
      expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error', cache: 'no-store', credentials: 'same-origin' }));
    } finally { vi.unstubAllGlobals(); }
  });

  it('aborts a stalled times read after its bounded deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment?applicants[]=77777777' });
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('synthetic abort')));
    })));
    try {
      const pending = fetchTimesJson('/en-ca/niv/schedule/12345/appointment', 95, '2026-11-19', ['77777777']);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toEqual({ status: 0, body: null });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
