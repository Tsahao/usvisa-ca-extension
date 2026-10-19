import { describe, expect, it } from 'vitest';
import { initialMonitor, monitorForScope, monitorsForScope } from '../src/domain/monitor';

describe('fresh alert scope initialization', () => {
  it('retains same-scope notification history and never transfers it to a new scope', () => {
    const monitor = { ...initialMonitor('old-scope'), baseline: '2026-11-19', lastHealthyAt: '2026-10-14T12:00:00Z',
      alert: { observed: '2026-11-19', delivered: '2026-11-19', pending: false } };
    const slot = { scopeKey: monitor.scopeKey, monitor };
    expect(monitorForScope(slot, 'old-scope', true)).toEqual(monitor);
    expect(() => monitorForScope(slot, 'new-scope')).toThrow();
    expect(monitorForScope(slot, 'new-scope', true)).toEqual(initialMonitor('new-scope'));
  });
  it.each(['baseline', 'timestamp', 'observed', 'delivered', 'slot'])('refuses malformed %s even during a fresh Start', issue => {
    const monitor = { ...initialMonitor('old-scope') };
    if (issue === 'baseline') monitor.baseline = 'not-a-date';
    if (issue === 'timestamp') monitor.lastHealthyAt = 'not-a-timestamp';
    if (issue === 'observed') monitor.alert.observed = 'not-a-date';
    if (issue === 'delivered') monitor.alert.delivered = 'not-a-date';
    expect(() => monitorForScope({ scopeKey: issue === 'slot' ? 'different-scope' : 'old-scope', monitor }, 'new-scope', true)).toThrow();
  });
});

describe('per-consulate alert monitors', () => {
  it('keeps one monitor per consulate under one scope and rejects the legacy slot', () => {
    const fresh = monitorsForScope(undefined, 'k', ['Halifax', 'Toronto']);
    expect(Object.keys(fresh)).toEqual(['Halifax', 'Toronto']);
    expect(fresh.Halifax!.scopeKey).toBe('k:Halifax');
    expect(() => monitorsForScope({ scopeKey: 'k', monitor: initialMonitor('k') }, 'k', ['Halifax'])).toThrow('Monitor scope changed.');
    expect(monitorsForScope({ scopeKey: 'k', monitor: initialMonitor('k') }, 'k', ['Halifax'], true).Halifax!.scopeKey).toBe('k:Halifax');
    expect(() => monitorsForScope({ scopeKey: 'other', monitors: {} }, 'k', ['Halifax'])).toThrow('Monitor scope changed.');
    expect(monitorsForScope({ scopeKey: 'other', monitors: {} }, 'k', ['Halifax'], true)).toEqual({ Halifax: initialMonitor('k:Halifax') });
  });
  it('retains same-scope history and creates missing consulates fresh', () => {
    const halifax = { ...initialMonitor('k:Halifax'), baseline: '2026-11-19', lastHealthyAt: '2026-10-14T12:00:00Z',
      alert: { observed: '2026-11-19', delivered: '2026-11-19', pending: false } };
    const result = monitorsForScope({ scopeKey: 'k', monitors: { Halifax: halifax } }, 'k', ['Halifax', 'Toronto']);
    expect(result).toEqual({ Halifax: halifax, Toronto: initialMonitor('k:Toronto') });
    expect(monitorsForScope({ scopeKey: 'k', monitors: { Halifax: halifax } }, 'k', ['Halifax'], true)).toEqual({ Halifax: halifax });
  });
  it.each([
    ['null', null],
    ['string', 'slot'],
    ['missing monitors', { scopeKey: 'k' }],
    ['monitors array', { scopeKey: 'k', monitors: [] }],
    ['bad monitor', { scopeKey: 'k', monitors: { Halifax: { scopeKey: 'k:Halifax', alert: null, baseline: null, lastHealthyAt: null } } }],
    ['mismatched inner key', { scopeKey: 'k', monitors: { Halifax: initialMonitor('k:Toronto') } }],
    ['unknown consulate', { scopeKey: 'k', monitors: { Atlantis: initialMonitor('k:Atlantis') } }],
    ['missing scope key', { monitors: {} }],
  ])('refuses a malformed slot (%s) even during a fresh Start', (_label, slot) => {
    expect(() => monitorsForScope(slot, 'k', ['Halifax'])).toThrow('Invalid monitor slot.');
    expect(() => monitorsForScope(slot, 'k', ['Halifax'], true)).toThrow('Invalid monitor slot.');
  });
});
