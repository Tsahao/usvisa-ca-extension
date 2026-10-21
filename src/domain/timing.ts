// Timing and failure-budget core for steps 4–6. Pure and synthetic-only:
// no live reads, no actions. Budgets follow the parity contract with one
// live calibration: session age defaults to 60 minutes (observed), not 90.
import { selectedConsulates } from './dates';

export const POLL_INTERVAL_S = 60;
export const POLL_JITTER_S = 30;
export const SESSION_RENEWAL_DELAY_S = 60;
export const COOLDOWN_S = 1800;
export const SESSION_AGE_MINUTES = 60;
export const PAID_EMPTY_COOLDOWN_AFTER = 4;
export const SETUP_FAILURE_COOLDOWN_AFTER = 10;
// Spacing between the three independent fresh verification reads. The 30s
// post-mutation settling delay is scheduled separately at every verification
// entry point and is unchanged: these short gaps only guard against transient
// read errors, so they ride the existing short-timer acceleration (<=5s fast
// wake) with the durable alarm as the suspension fallback.
export const VERIFICATION_READ_GAP_S = 2;
export const STAGE_PACE_S = 30;

// One 30-second allowance per selected consulate, in either workflow. An
// empty/invalid selection is rejected separately; keep its input floor at 30s.
export function minimumPollIntervalSeconds(preferences: unknown): number {
  return Math.max(1, selectedConsulates(preferences)?.length ?? 0) * 30;
}

export type HttpOutcome = 'ok' | 'not-modified' | 'retryable' | 'denied';

// Transport classification. 502 is a busy/empty signal, never an observation;
// 304 revalidates cache; 401/403 is access-denied with no bypass.
export function mapHttpStatus(status: number): HttpOutcome {
  if (status === 200) return 'ok';
  if (status === 304) return 'not-modified';
  if (status === 401 || status === 403) return 'denied';
  if (Number.isInteger(status) && status >= 500 && status <= 599) return 'retryable';
  if (status === 408 || status === 429) return 'retryable';
  return 'retryable';
}

// Healthy poll cadence: configured base (default 60s) plus 0–30s jitter. Randomness is injected so
// tests stay deterministic; callers pass Math.random in production.
export function pollDelaySeconds(random: () => number, interval = POLL_INTERVAL_S): number {
  if (!Number.isInteger(interval) || interval < 30 || interval > 86400) throw new Error('Invalid poll interval.');
  const roll = random();
  if (!(roll >= 0 && roll < 1)) throw new Error('Invalid random source.');
  return interval + Math.floor(roll * (POLL_JITTER_S + 1));
}

// Failed availability polls retry on the same configured cadence as healthy
// polls: interval plus jitter. Callers pass Math.random in production.
export function failureRetryDelaySeconds(random: () => number, interval = POLL_INTERVAL_S): number {
  return pollDelaySeconds(random, interval);
}

// A healthy cycle, idle stretch, or notification refunds the failure budget
// in full: only consecutive failures consume it.
export function refundFailures(): number {
  return 0;
}

export function countFailure(consecutiveFailures: number): number {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0)
    throw new Error('Invalid failure count.');
  return consecutiveFailures + 1;
}

// Paid empty-list and setup-failure streams earn an 1800s cooldown at their
// respective boundaries. Unavailability on the unpaid side is healthy data,
// never a cooler trip — callers must not route it here.
export function shouldCooldown(consecutiveFailures: number, threshold: number): boolean {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) throw new Error('Invalid failure count.');
  if (!Number.isInteger(threshold) || threshold <= 0) throw new Error('Invalid cooldown threshold.');
  return consecutiveFailures >= threshold;
}

export function cooldownUntilSeconds(nowEpochS: number): number {
  if (!Number.isFinite(nowEpochS) || nowEpochS < 0) throw new Error('Invalid timestamp.');
  return Math.floor(nowEpochS) + COOLDOWN_S;
}

export function isSessionStale(sessionStartedEpochS: number, nowEpochS: number): boolean {
  if (!Number.isFinite(sessionStartedEpochS) || !Number.isFinite(nowEpochS)) throw new Error('Invalid timestamp.');
  return nowEpochS - sessionStartedEpochS >= SESSION_AGE_MINUTES * 60;
}
