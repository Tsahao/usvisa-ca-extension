import { describe, expect, it } from 'vitest';
import { initialMonitor, monitorForScope } from '../src/domain/monitor';

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
