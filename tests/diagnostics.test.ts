import { describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTICS_COALESCE_MS,
  DIAGNOSTICS_KEY,
  DIAGNOSTICS_LIMIT,
  DIAGNOSTICS_REPEAT_LIMIT,
  DIAGNOSTICS_TTL_MS,
  appendDiagnostic,
  diagnosticsExpiry,
  diagnosticsSnapshot,
  emptyDiagnostics,
  pruneDiagnostics,
  validateDiagnostics,
  type DiagnosticEntry,
  type DiagnosticEvent,
} from '../src/domain/diagnostics';
import { createEngineDiagnostics } from '../src/engine/diagnostics';

const NOW = '2026-10-16T18:00:00.000Z';
const stamp = (offset: number) => new Date(Date.parse(NOW) + offset).toISOString();
const retryEvent = (failures: number, detail: DiagnosticEvent['detail'] = 'reply-malformed'): DiagnosticEvent =>
  ({ code: 'auth-retry-scheduled', detail, purpose: 'start', mode: 'booking', failures });

describe('bounded developer diagnostics log', () => {
  it('appends newest first and collapses identical repeats inside the window into a bounded count', () => {
    let log = emptyDiagnostics();
    log = appendDiagnostic(log, retryEvent(1), NOW);
    log = appendDiagnostic(log, retryEvent(1), stamp(1000));
    log = appendDiagnostic(log, { code: 'auth-script-interrupted', detail: 'script-interrupted', purpose: 'start', mode: 'booking' }, stamp(2000));
    log = appendDiagnostic(log, retryEvent(3), stamp(3000));
    log = appendDiagnostic(log, retryEvent(4), stamp(3000 + DIAGNOSTICS_COALESCE_MS + 1));
    expect(log.entries.map(entry => entry.code)).toEqual([
      'auth-retry-scheduled', 'auth-retry-scheduled', 'auth-script-interrupted', 'auth-retry-scheduled',
    ]);
    expect(log.entries.map(entry => entry.count ?? 1)).toEqual([1, 1, 1, 2]);
    // Only identical counters collapse; different counters retain their own entry.
    expect(log.entries.at(-1)).toMatchObject({ failures: 1 });
    // A different code or an out-of-window repeat always opens a distinct entry.
    expect(log.entries[1].detail).toBe('reply-malformed');
    expect(log.entries[2].detail).toBe('script-interrupted');
  });

  it('treats the fixed phase as part of the coalesced signal', () => {
    let log = appendDiagnostic(emptyDiagnostics(), { ...retryEvent(1), phase: 'prepare' }, NOW);
    log = appendDiagnostic(log, { ...retryEvent(2), phase: 'submit' }, stamp(1000));
    expect(log.entries.map(entry => entry.phase)).toEqual(['submit', 'prepare']);
    log = appendDiagnostic(log, { ...retryEvent(2), phase: 'submit' }, stamp(2000));
    expect(log.entries.map(entry => entry.count ?? 1)).toEqual([2, 1]);
  });

  it('caps collapsed repeats at the fixed bound and starts a fresh entry beyond it', () => {
    let log = emptyDiagnostics();
    for (let index = 0; index < DIAGNOSTICS_REPEAT_LIMIT; index++) log = appendDiagnostic(log, retryEvent(1), NOW);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].count).toBe(DIAGNOSTICS_REPEAT_LIMIT);
    log = appendDiagnostic(log, retryEvent(1), NOW);
    expect(log.entries.map(entry => entry.count ?? 1)).toEqual([1, DIAGNOSTICS_REPEAT_LIMIT]);
  });

  it('prunes at the exact 7-day boundary, drops future-dated entries, and keeps only the newest bounded slice', () => {
    const old = { at: stamp(-DIAGNOSTICS_TTL_MS), code: 'auth-started', purpose: 'start' } as DiagnosticEntry;
    const future = { at: stamp(1000), code: 'auth-submitted', purpose: 'start' } as DiagnosticEntry;
    const fresh = { at: stamp(-DIAGNOSTICS_TTL_MS + 1000), code: 'auth-prepared', purpose: 'start' } as DiagnosticEntry;
    const pruned = pruneDiagnostics({ version: 1, entries: [old, fresh, future] }, NOW);
    expect(pruned.entries.map(entry => entry.code)).toEqual(['auth-prepared']);
    const many: DiagnosticEntry[] = Array.from({ length: DIAGNOSTICS_LIMIT + 50 },
      (_, index) => ({ at: stamp(-index * 1000), code: 'auth-started', purpose: 'start' }));
    const bounded = pruneDiagnostics({ version: 1, entries: many }, NOW);
    expect(bounded.entries).toHaveLength(DIAGNOSTICS_LIMIT);
    expect(bounded.entries[0].at).toBe(NOW);
    expect(() => pruneDiagnostics(emptyDiagnostics(), 'not-a-timestamp')).toThrow('Invalid diagnostics time.');
  });

  it('refuses malformed or tampered logs and reconstructs only allowlisted fields', () => {
    expect(() => validateDiagnostics(null)).toThrow('Invalid diagnostics log.');
    expect(() => validateDiagnostics({})).toThrow('Invalid diagnostics log.');
    expect(() => validateDiagnostics({ version: 2, entries: [] })).toThrow('Invalid diagnostics log.');
    expect(() => validateDiagnostics({ version: 1, entries: 'not-an-array' })).toThrow('Invalid diagnostics log.');
    expect(() => validateDiagnostics({ version: 1, entries: [null] })).toThrow('Invalid diagnostics entry.');
    expect(() => validateDiagnostics({ version: 1, entries: [{ at: NOW, code: 'not-a-code' }] })).toThrow('Invalid diagnostics entry.');
    expect(() => validateDiagnostics({ version: 1, entries: [{ at: 'not-a-timestamp', code: 'auth-started' }] })).toThrow('Invalid diagnostics entry.');
    expect(() => validateDiagnostics({ version: 1, entries: [{ at: NOW, code: 'auth-started', detail: 'not-a-detail' }] })).toThrow('Invalid diagnostics entry.');
    expect(() => validateDiagnostics({ version: 1, entries: [{ at: NOW, code: 'auth-started', phase: 'not-a-phase' }] })).toThrow('Invalid diagnostics entry.');
    expect(() => validateDiagnostics({ version: 1, entries: [{ at: NOW, code: 'auth-started', failures: -1 }] })).toThrow('Invalid diagnostics entry.');
    expect(() => validateDiagnostics({ version: 1, entries: new Array(DIAGNOSTICS_LIMIT + 1).fill({ at: NOW, code: 'auth-started' }) }))
      .toThrow('Invalid diagnostics log.');
    const clean = validateDiagnostics({ version: 1, entries: [{
      at: NOW, code: 'auth-terminal', reason: 'credential-rejected', detail: 'credential-rejected', phase: 'retry', failures: 2, count: 3,
      secret: 'must-not-survive', url: 'https://example.invalid', page: '<html>',
    }] });
    expect(clean.entries).toEqual([{ at: NOW, code: 'auth-terminal', detail: 'credential-rejected', phase: 'retry', reason: 'credential-rejected', failures: 2, count: 3 }]);
    expect(JSON.stringify(clean)).not.toContain('must-not-survive');
    expect(JSON.stringify(clean)).not.toContain('example.invalid');
  });

  it('exports a pruned newest-first snapshot with fixed retention and a TTL expiry', () => {
    let log = emptyDiagnostics();
    expect(diagnosticsExpiry(log)).toBeNull();
    log = appendDiagnostic(log, retryEvent(1), NOW);
    log = appendDiagnostic(log, { code: 'auth-recovered', outcome: 'healthy', purpose: 'start', mode: 'booking' }, stamp(1000));
    expect(diagnosticsExpiry(log)).toBe(stamp(DIAGNOSTICS_TTL_MS));
    const snapshot = diagnosticsSnapshot(log, stamp(1000));
    expect(snapshot.retention).toEqual({ ttlMs: DIAGNOSTICS_TTL_MS, limit: DIAGNOSTICS_LIMIT });
    expect(snapshot.entries.map(entry => entry.code)).toEqual(['auth-recovered', 'auth-retry-scheduled']);
    // Past the oldest entry's TTL the snapshot never returns stale records.
    expect(diagnosticsSnapshot(log, stamp(DIAGNOSTICS_TTL_MS + 2000)).entries).toEqual([]);
  });

  it('never records healthy ticks or values outside the fixed allowlists', () => {
    expect(() => appendDiagnostic(emptyDiagnostics(), { code: 'not-a-code' } as never, NOW)).toThrow('Invalid diagnostics entry.');
    expect(() => appendDiagnostic(emptyDiagnostics(), retryEvent(1), 'not-a-timestamp')).toThrow('Invalid diagnostics time.');
  });
});

const detailCycle = ['reply-malformed', 'script-interrupted', 'trusted-progress', 'stalled-load'] as const;

function workerHarness(maxPending?: number) {
  let now = NOW;
  const stored: Record<string, unknown> = {};
  const area = { get: vi.fn(async () => ({ ...stored })), set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }) };
  const schedule = vi.fn(async (_expiry: string | null) => {});
  const build = () => createEngineDiagnostics({ area, now: () => now, schedule, ...(maxPending === undefined ? {} : { maxPending }) });
  return { stored, area, schedule, build, tick: (offset: number) => { now = stamp(offset); } };
}

describe('independent local diagnostics recording', () => {
  it('captures event time and validated build versions before queued writes drain', async () => {
    const h = workerHarness();
    let time = NOW; let version = '0.2.1';
    const store = createEngineDiagnostics({ area: h.area, schedule: h.schedule, now: () => time, extensionVersion: () => version });
    const first = store.record(retryEvent(1));
    time = stamp(1000); version = '0.2.2';
    const second = store.record(retryEvent(2));
    time = stamp(9000);
    await Promise.all([first, second]);
    const snapshot = await store.read();
    expect(snapshot.extensionVersion).toBe('0.2.2');
    expect(snapshot.entries.map(e => [e.at, e.extensionVersion, e.failures])).toEqual([[stamp(1000), '0.2.2', 2], [NOW, '0.2.1', 1]]);
    version = 'secret@example.invalid';
    await store.record({ code: 'auth-recovered' });
    expect((await store.read()).extensionVersion).toBeNull();
    expect(JSON.stringify(await store.read())).not.toContain(version);
  });
  it('serializes queued records in order, stays durable across worker instances, and schedules retention', async () => {
    const h = workerHarness(); const store = h.build();
    void store.record(retryEvent(1));
    void store.record({ code: 'auth-cooldown-entered', detail: 'reply-malformed', purpose: 'start', mode: 'booking', failures: 10 });
    await store.record({ code: 'auth-recovered', outcome: 'healthy', purpose: 'start', mode: 'booking' });
    const snapshot = await store.read();
    expect(snapshot.entries.map(entry => entry.code)).toEqual(['auth-recovered', 'auth-cooldown-entered', 'auth-retry-scheduled']);
    expect((await h.build().read()).entries).toEqual(snapshot.entries);
    expect(h.schedule).toHaveBeenLastCalledWith(stamp(DIAGNOSTICS_TTL_MS));
    // The log is a separate key: engine state and prefs are never touched.
    expect(h.stored.engineStateV1).toBeUndefined();
    expect(Object.keys(h.stored)).toEqual([DIAGNOSTICS_KEY]);
  });

  it('drops records beyond the queued bound without blocking or throwing', async () => {
    const h = workerHarness(1); const store = h.build();
    let unblock!: () => void;
    h.area.get.mockImplementationOnce(() => new Promise(resolve => { unblock = () => resolve({ ...h.stored }); }));
    const first = store.record(retryEvent(1, detailCycle[0]));
    const second = store.record(retryEvent(2, detailCycle[1]));
    await Promise.resolve(); await Promise.resolve();
    unblock();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    const snapshot = await store.read();
    expect(snapshot.entries.map(entry => entry.detail)).toEqual([detailCycle[0]]);
  });

  it('degrades a corrupt or failing log to best effort without throwing into callers', async () => {
    const h = workerHarness(); const store = h.build();
    h.stored[DIAGNOSTICS_KEY] = { version: 2 };
    await expect(store.record(retryEvent(1, detailCycle[0]))).resolves.toBeUndefined();
    expect(validateDiagnostics(h.stored[DIAGNOSTICS_KEY]).entries).toHaveLength(1);
    h.area.get.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(store.record(retryEvent(2, detailCycle[1]))).resolves.toBeUndefined();
    h.area.set.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(store.record(retryEvent(3, detailCycle[2]))).resolves.toBeUndefined();
    h.schedule.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(store.record(retryEvent(4, detailCycle[3]))).resolves.toBeUndefined();
    await expect(store.record({ code: 'not-a-code' } as never)).resolves.toBeUndefined();
    const log = validateDiagnostics(h.stored[DIAGNOSTICS_KEY]);
    expect(log.entries.map(entry => entry.detail)).toEqual([detailCycle[3], detailCycle[0]]);
  });

  it('never clears recorded entries on later reads or cleanups, and expires only through retention', async () => {
    const h = workerHarness(); const store = h.build();
    await store.record(retryEvent(1));
    h.stored.engineStateV1 = { status: 'running' };
    await store.read(); await store.read();
    await h.build().prune();
    expect(h.stored.engineStateV1).toEqual({ status: 'running' });
    expect(validateDiagnostics(h.stored[DIAGNOSTICS_KEY]).entries).toHaveLength(1);
    h.tick(DIAGNOSTICS_TTL_MS + 1000);
    await h.build().prune();
    expect(h.stored[DIAGNOSTICS_KEY]).toEqual(emptyDiagnostics());
    expect(h.schedule).toHaveBeenLastCalledWith(null);
  });
});
