import { describe, expect, it } from 'vitest';
import { readAutoMode } from '../src/domain/auto-mode';
import { policyKey } from '../src/engine/lifecycle';

describe('Auto Mode compatibility and authorization', () => {
  it.each([true, false])('inverts legacy Test Mode %s without changing an in-flight policy', testMode => {
    const legacy = { consulate: 'Vancouver', testMode, interval: 60 };
    const current = { consulate: 'Vancouver', autoMode: !testMode, interval: 60 };
    expect(readAutoMode(legacy)).toBe(!testMode);
    expect(readAutoMode(current)).toBe(!testMode);
    expect(policyKey(legacy)).toBe(policyKey(current));
  });

  it('gives the explicit new preference precedence over a stale legacy flag', () => {
    expect(readAutoMode({ autoMode: false, testMode: false })).toBe(false);
    expect(readAutoMode({ autoMode: true, testMode: true })).toBe(true);
  });

  it.each([undefined, null, {}, { autoMode: 'true' }, { testMode: 0 }, { autoMode: undefined, testMode: false }])
    ('fails closed for a missing or malformed permission (%j)', value => {
      expect(readAutoMode(value)).toBeNull();
    });
});
