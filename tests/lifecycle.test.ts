import { describe, expect, it } from 'vitest';
import { policyKey, reviewLifecycle } from '../src/engine/lifecycle';
import { emptyEngineState, startRun, validateEngineState } from '../src/engine/workflow';
import { applyPollResult } from '../src/engine/poll';

const NOW = '2026-10-12T00:00:00.000Z';
const prefs = { consulates: ['Vancouver'], earliest: '2026-11-01', latest: '2026-12-31', testMode: true, onlyEarlier: true, interval: 120 };
const seeded = () => startRun(emptyEngineState(NOW), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now: NOW });
describe('durable lifecycle review', () => {
  it('pins non-secret settings and honors the configured healthy interval', () => {
    const state = reviewLifecycle(seeded(), { ...prefs, email: 'synthetic@example.invalid', password: 'synthetic-password' }, NOW);
    expect(state.pollIntervalS).toBe(120);
    expect(state.policyKey).toBe(policyKey(prefs));
    expect(state.policyKey).not.toContain('synthetic');
    expect(applyPollResult(state, { outcome: 'healthy', now: NOW, random: () => 0 }).nextPollAt).toBe('2026-10-12T00:02:00.000Z');
  });
  it('preserves session budget across durable saves and stops at the boundary', () => {
    const state = validateEngineState(JSON.parse(JSON.stringify(reviewLifecycle(seeded(), prefs, NOW))));
    expect(reviewLifecycle(state, prefs, '2026-10-12T00:59:59.000Z').status).toBe('running');
    expect(reviewLifecycle(state, prefs, '2026-10-12T01:00:00.000Z')).toMatchObject({ status: 'verifying', nextPollAt: null });
    expect(reviewLifecycle({ ...state, startedAt: null }, prefs, NOW).status).toBe('verifying');
  });
  it.each(['consulates', 'testMode', 'interval', 'paidIvr'])('parks before any next cycle on a changed setting (%s)', key => {
    const state = reviewLifecycle(seeded(), prefs, NOW);
    expect(reviewLifecycle(state, { ...prefs, [key]: 'changed' }, NOW).status).toBe('verifying');
  });
});
describe('policy key consulate selection', () => {
  it('keys the policy on the ordered selection', () => {
    const base = { earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, autoMode: true, interval: 60, paidIvr: '', unpaidIvr: '' };
    expect(policyKey({ ...base, consulates: ['Toronto', 'Halifax'] })).toBe(policyKey({ ...base, consulates: ['Halifax', 'Toronto'] }));
    expect(policyKey({ ...base, consulates: ['Toronto'] })).not.toBe(policyKey({ ...base, consulates: ['Toronto', 'Halifax'] }));
    expect(policyKey({ ...base, consulate: 'Toronto' })).toBe(policyKey({ ...base, consulates: ['Toronto'] }));
  });
});
