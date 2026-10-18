import { describe, expect, it } from 'vitest';
import {
  cooldownUntilSeconds,
  COOLDOWN_S,
  countFailure,
  failureRetryDelaySeconds,
  isSessionStale,
  mapHttpStatus,
  PAID_EMPTY_COOLDOWN_AFTER,
  pollDelaySeconds,
  refundFailures,
  SETUP_FAILURE_COOLDOWN_AFTER,
  shouldCooldown,
} from '../src/domain/timing';

describe('timing and failure budgets', () => {
  it('allows a 30-second minimum with unchanged jitter for healthy polls and retries', () => {
    expect(pollDelaySeconds(() => 0, 30)).toBe(30);
    expect(pollDelaySeconds(() => 0.9999, 30)).toBe(60);
    expect(failureRetryDelaySeconds(() => 0, 30)).toBe(30);
    for (const interval of [29, 30.5, 86401, NaN]) {
      expect(() => pollDelaySeconds(() => 0, interval)).toThrow('Invalid poll interval.');
    }
  });

  it('paces healthy polls at 60s plus 0–30s jitter', () => {
    expect(pollDelaySeconds(() => 0)).toBe(60);
    expect(pollDelaySeconds(() => 0.9999)).toBe(90);
    for (const roll of [0.1, 0.5, 0.9]) {
      const delay = pollDelaySeconds(() => roll);
      expect(delay).toBeGreaterThanOrEqual(60);
      expect(delay).toBeLessThanOrEqual(90);
    }
    expect(() => pollDelaySeconds(() => 1)).toThrow();
    expect(failureRetryDelaySeconds(() => 0, 60)).toBe(60);
    expect(failureRetryDelaySeconds(() => 0.9999, 600)).toBe(630);
  });

  it('classifies transport outcomes without touching observations', () => {
    expect(mapHttpStatus(200)).toBe('ok');
    expect(mapHttpStatus(304)).toBe('not-modified');
    expect(mapHttpStatus(502)).toBe('retryable');
    expect(mapHttpStatus(500)).toBe('retryable');
    expect(mapHttpStatus(429)).toBe('retryable');
    expect(mapHttpStatus(401)).toBe('denied');
    expect(mapHttpStatus(403)).toBe('denied');
  });

  it('trips cooldowns exactly at the paid-empty and setup-failure boundaries', () => {
    expect(shouldCooldown(PAID_EMPTY_COOLDOWN_AFTER - 1, PAID_EMPTY_COOLDOWN_AFTER)).toBe(false);
    expect(shouldCooldown(PAID_EMPTY_COOLDOWN_AFTER, PAID_EMPTY_COOLDOWN_AFTER)).toBe(true);
    expect(shouldCooldown(SETUP_FAILURE_COOLDOWN_AFTER - 1, SETUP_FAILURE_COOLDOWN_AFTER)).toBe(false);
    expect(shouldCooldown(SETUP_FAILURE_COOLDOWN_AFTER, SETUP_FAILURE_COOLDOWN_AFTER)).toBe(true);
    expect(cooldownUntilSeconds(1000)).toBe(1000 + COOLDOWN_S);
  });

  it('refunds the budget on healthy cycles and counts consecutive failures', () => {
    expect(refundFailures()).toBe(0);
    expect(countFailure(0)).toBe(1);
    expect(countFailure(3)).toBe(4);
    expect(() => countFailure(-1)).toThrow();
  });

  it('treats sessions as stale at the live-calibrated 60-minute age', () => {
    expect(isSessionStale(0, 59 * 60)).toBe(false);
    expect(isSessionStale(0, 60 * 60)).toBe(true);
    expect(isSessionStale(0, 90 * 60)).toBe(true);
  });
});
