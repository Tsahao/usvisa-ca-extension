import { pollDelaySeconds, SETUP_FAILURE_COOLDOWN_AFTER } from '../domain/timing';
import type { EngineState } from './workflow';

export function restartExhausted(state: EngineState, now: string): EngineState {
  return { ...state, status: 'stopped', restartPending: false, restartFailed: true, authentication: null, group: null, executor: null,
    stage: null, nextPollAt: null, cooldownUntil: null, loginFailed: true, authenticationError: null, updatedAt: now };
}

// Setup retries are read-only fresh validation, never a booking-click retry.
// Unlike ordinary maintenance's cooldown, explicit restart exhaustion surfaces
// the existing generic design error after ten failed attempts.
export function retryRestart(state: EngineState, now: string, random: () => number): EngineState {
  if (!state.restartPending || state.intent) return state;
  const failures = state.consecutiveFailures + 1;
  const counted = { ...state, consecutiveFailures: failures };
  if (failures >= SETUP_FAILURE_COOLDOWN_AFTER) return restartExhausted(counted, now);
  return { ...counted, status: 'running', authentication: null, group: null, executor: null, stage: null,
    cooldownUntil: null, loginFailed: false, authenticationError: null, manualAuthentication: false,
    nextPollAt: new Date(Date.parse(now) + pollDelaySeconds(random, state.pollIntervalS) * 1000).toISOString(), updatedAt: now };
}
