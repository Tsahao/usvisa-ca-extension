import { describe, expect, it, vi } from 'vitest';
import { emptyHistory, HISTORY_TTL_MS, HISTORY_KEY, HISTORY_LIMIT, validateHistory, pruneHistory,
  observeHistory, markHistoryBooking, historyRows, type DateHistory } from '../src/domain/history';
import { createDateHistory } from '../src/engine/history';
import { bindGroup, emptyEngineState, startRun, type EngineState } from '../src/engine/workflow';

const NOW = '2026-10-16T18:00:00.000Z';
const SCOPE = 'a'.repeat(64);
const ATTEMPT = 'b'.repeat(64);
const stamp = (offset: number) => new Date(Date.parse(NOW) + offset).toISOString();
const reading = (earliestDate: string | null, offset = 0, scope = SCOPE) => ({ scope, earliestDate, checkedAt: stamp(offset) });
const attempt = (createdAt = NOW) => ({ scope: SCOPE, targetDate: '2026-11-19', createdAt, attempt: ATTEMPT });

describe('bounded date-change history', () => {
  it('records first availability and changes in both directions, independently of booking eligibility', () => {
    let state = observeHistory(emptyHistory(), reading(null, -4000), NOW);
    expect(state.entries).toEqual([]);
    for (const [date, offset] of [['2026-11-19', -3000], ['2026-11-19', -2000], ['2026-10-17', -1000], ['2027-08-01', 0]] as const)
      state = observeHistory(state, reading(date, offset), NOW);
    expect(historyRows(state, NOW).map(row => [row.earliestDate, row.booked])).toEqual([
      ['2027-08-01', 'No'], ['2026-10-17', 'No'], ['2026-11-19', 'No'],
    ]);
  });

  it('tracks disappearance without adding a blank row and records reappearance', () => {
    let state = observeHistory(emptyHistory(), reading('2026-11-19', -2000), NOW);
    state = observeHistory(state, reading(null, -1000), NOW);
    state = observeHistory(state, reading('2026-11-19'), NOW);
    expect(state.entries.map(row => row.earliestDate)).toEqual(['2026-11-19', '2026-11-19']);
    expect(state.entries[0].id).not.toBe(state.entries[1].id);
  });

  it('deduplicates duplicate and out-of-order observations while preserving independent scopes', () => {
    let state = observeHistory(emptyHistory(), reading('2026-11-19'), NOW);
    state = observeHistory(state, reading('2026-12-01', -1), NOW);
    state = observeHistory(state, reading('2026-12-01'), NOW);
    state = observeHistory(state, reading('2026-11-19', 0, 'c'.repeat(64)), NOW);
    expect(state.entries).toHaveLength(2);
    expect(state.entries.every(row => row.earliestDate === '2026-11-19')).toBe(true);
  });

  it('keeps the newest 100 rows and prunes at the exact 24-hour boundary', () => {
    let state = emptyHistory();
    for (let index = 0; index < 105; index++) state = observeHistory(state,
      reading(index % 2 ? '2026-11-19' : '2026-11-20', -105_000 + index * 1000), NOW);
    expect(state.entries).toHaveLength(HISTORY_LIMIT);
    expect(state.entries[0].checkedAt).toBe(stamp(-1000));
    expect(pruneHistory(state, stamp(HISTORY_TTL_MS - 1000)).entries).toEqual([]);
    const edge = observeHistory(emptyHistory(), reading('2026-11-19'), NOW);
    expect(pruneHistory(edge, stamp(HISTORY_TTL_MS - 1)).entries).toHaveLength(1);
    expect(pruneHistory(edge, stamp(HISTORY_TTL_MS))).toEqual(emptyHistory());
  });

  it('expires rows even when unchanged healthy polling continues, without recreating them', () => {
    const first = observeHistory(emptyHistory(), reading('2026-11-19'), NOW);
    const refreshed = observeHistory(first, reading('2026-11-19', HISTORY_TTL_MS - 1000), stamp(HISTORY_TTL_MS - 1000));
    const next = observeHistory(refreshed, reading('2026-11-19', HISTORY_TTL_MS), stamp(HISTORY_TTL_MS));
    expect(next.entries).toEqual([]);
    expect(next.baselines).toHaveLength(1);
  });

  it('marks an exact appointment Attempted, promotes only matching verified success, and never downgrades Yes', () => {
    const original = observeHistory(emptyHistory(), reading('2026-11-19', -1000), NOW);
    const attempted = markHistoryBooking(original, attempt(), 'Attempted', NOW);
    expect(attempted.entries[0].booked).toBe('Attempted');
    expect(markHistoryBooking(attempted, { ...attempt(), attempt: 'd'.repeat(64) }, 'Yes', NOW)).toEqual(attempted);
    const booked = markHistoryBooking(attempted, attempt(), 'Yes', NOW);
    expect(booked.entries[0].booked).toBe('Yes');
    expect(markHistoryBooking(booked, attempt(), 'Attempted', NOW)).toEqual(booked);
  });

  it('can promote a second real attempt on an unchanged date after the first failed', () => {
    const original = observeHistory(emptyHistory(), reading('2026-11-19', -2000), NOW);
    let state = markHistoryBooking(original, attempt(stamp(-1000)), 'Attempted', NOW);
    const second = { ...attempt(), attempt: 'd'.repeat(64) };
    state = markHistoryBooking(state, second, 'Attempted', NOW);
    expect(markHistoryBooking(state, second, 'Yes', NOW).entries[0].booked).toBe('Yes');
  });

  it('does not attach a later candidate or stale result to a different/latest observed row', () => {
    const original = observeHistory(emptyHistory(), reading('2026-11-19', -2000), NOW);
    expect(markHistoryBooking(original, { ...attempt(), targetDate: '2026-12-01' }, 'Attempted', NOW)).toEqual(original);
    const later = observeHistory(original, reading('2026-12-01', -1000), NOW);
    expect(markHistoryBooking(later, attempt(), 'Yes', NOW)).toEqual(later);
    expect(markHistoryBooking(original, attempt(stamp(-3000)), 'Attempted', NOW)).toEqual(original);
    expect(markHistoryBooking(original, attempt(), 'Yes', stamp(HISTORY_TTL_MS)).entries).toEqual([]);
  });

  it.each([null, {}, { version: 2, entries: [], baselines: [] },
    { version: 1, entries: new Array(101).fill(null), baselines: [] },
    { version: 1, entries: [{ scope: SCOPE, earliestDate: '2026-02-31' }], baselines: [] }])('refuses malformed saved data: %j', raw => {
    expect(() => validateHistory(raw)).toThrow('Invalid date history.');
  });

  it('drops unknown fields and returns only display-safe fields to the panel', () => {
    const state = observeHistory(emptyHistory(), reading('2026-11-19'), NOW);
    const dirty = { ...state, secret: 'must-not-survive', entries: state.entries.map(row => ({ ...row, secret: 'must-not-survive' })) };
    expect(JSON.stringify(validateHistory(dirty))).not.toContain('must-not-survive');
    expect(Object.keys(historyRows(state, NOW)[0])).toEqual(['id', 'checkedAt', 'earliestDate', 'booked']);
  });
});

function workerHarness() {
  let now = NOW;
  const stored: Record<string, unknown> = {};
  const area = { get: vi.fn(async () => ({ ...stored })), set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }) };
  const schedule = vi.fn(async (_expiry: string | null) => {});
  const build = () => createDateHistory({ area, now: () => now, schedule });
  const args = { owner: 'synthetic-owner', runId: 'synthetic-run', now: NOW };
  const state = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
    binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: null, applicantIds: ['77777777'] } });
  const intent: EngineState = { ...state, intent: { runId: state.runId!, mode: 'booking', groupId: '11111111',
    consulate: 'Vancouver', targetDate: '2026-11-19', testMode: false, phase: 'prepared', createdAt: NOW } };
  return { stored, area, schedule, build, state, intent, tick: (offset: number) => { now = stamp(offset); } };
}

describe('independent local history recording', () => {
  it('serializes observations/attempt/success and survives a new worker instance without persisting portal identity', async () => {
    const h = workerHarness(); const store = h.build();
    // Deliberately not awaited between events: real worker hooks do not block.
    void store.observe(h.state, 'Vancouver', '2026-11-19', stamp(-1000));
    void store.attempted(h.intent);
    void store.confirmed(h.intent);
    expect(await store.read()).toEqual([expect.objectContaining({ earliestDate: '2026-11-19', booked: 'Yes' })]);
    expect(await h.build().read()).toEqual(await store.read());
    const serialized = JSON.stringify(h.stored);
    for (const privateValue of ['11111111', '22222222', '77777777', 'synthetic-run', 'Vancouver']) expect(serialized).not.toContain(privateValue);
    expect(h.schedule).toHaveBeenLastCalledWith(stamp(HISTORY_TTL_MS - 1000));
  });

  it('never marks Test Mode or unpaid monitoring as a booking attempt/success', async () => {
    const h = workerHarness(); const store = h.build();
    await store.observe(h.state, 'Vancouver', '2026-11-19', stamp(-1000));
    const test = { ...h.intent, intent: { ...h.intent.intent!, testMode: true } };
    await store.attempted(test); await store.confirmed(test);
    await store.attempted({ ...h.intent, mode: 'alerts' });
    await store.confirmed({ ...h.intent, group: { ...h.intent.group!, kind: 'unpaid' } });
    expect((await store.read())[0].booked).toBe('No');
  });

  it('isolates consulates, payment workflows and groups, while deduplicating a fresh run in the same scope', async () => {
    const h = workerHarness(); const store = h.build();
    await store.observe(h.state, 'Vancouver', '2026-11-19', stamp(-3000));
    await store.observe({ ...h.state, runId: 'new-run' }, 'Vancouver', '2026-11-19', stamp(-2000));
    await store.observe(h.state, 'Toronto', '2026-11-19', stamp(-1000));
    const alerts = { ...h.state, mode: 'alerts' as const, group: { ...h.state.group!, kind: 'unpaid' as const } };
    await store.observe(alerts, 'Vancouver', '2026-11-19', NOW);
    await store.observe({ ...h.state, group: { ...h.state.group!, scheduleId: '99999999' } }, 'Vancouver', '2026-11-19', NOW);
    expect(await store.read()).toHaveLength(4);
  });

  it('does not gate workflow callers on storage/hash/scheduler failures, and allows a later retry', async () => {
    const h = workerHarness(); const store = h.build();
    h.area.get.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(store.observe(h.state, 'Vancouver', '2026-11-19', stamp(-1000))).resolves.toBeUndefined();
    h.area.set.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(store.observe(h.state, 'Vancouver', '2026-11-19', stamp(-1000))).resolves.toBeUndefined();
    h.schedule.mockRejectedValueOnce(new Error('synthetic failure'));
    await store.observe(h.state, 'Vancouver', '2026-11-19', NOW);
    expect(await store.read()).toHaveLength(1);
  });

  it('cleans expired rows on wake/alarm and does not loop on unchanged panel reads', async () => {
    const h = workerHarness(); const store = h.build();
    await store.observe(h.state, 'Vancouver', '2026-11-19', NOW);
    h.area.set.mockClear();
    await store.read(); await store.read();
    expect(h.area.set).not.toHaveBeenCalled();
    h.tick(HISTORY_TTL_MS);
    await h.build().prune();
    expect(h.stored[HISTORY_KEY]).toEqual(emptyHistory());
    expect(h.schedule).toHaveBeenLastCalledWith(null);
  });

  it('keeps a corrupt history slot from affecting other records and reports a fixed panel-read failure', async () => {
    const h = workerHarness(); const store = h.build();
    h.stored[HISTORY_KEY] = { version: 2 };
    h.stored.engineStateV1 = h.state;
    await expect(store.attempted(h.intent)).resolves.toBeUndefined();
    await expect(store.read()).rejects.toThrow('Invalid date history.');
    expect(h.stored.engineStateV1).toBe(h.state);
  });
});
