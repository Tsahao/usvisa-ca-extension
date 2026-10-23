import { blockedFailureContext } from '../domain/failure-context';
import { minimumPollIntervalSeconds, SESSION_AGE_MINUTES } from '../domain/timing';
import { parkForReview, type EngineState } from './workflow';
import { readAutoMode } from '../domain/auto-mode';
import { selectedConsulates } from '../domain/dates';

export function policyKey(preferences: Record<string, unknown> | undefined): string {
  const keys = ['consulates', 'earliest', 'latest', 'onlyEarlier', 'testMode', 'interval', 'paidIvr', 'unpaidIvr'];
  const autoMode = readAutoMode(preferences);
  // Preserve the serialized policy's inverse bit for in-flight legacy runs.
  return JSON.stringify(keys.map(key => key === 'testMode'
    ? (autoMode === null ? null : !autoMode)
    : key === 'consulates'
      ? selectedConsulates(preferences)
      : preferences?.[key] ?? null));
}

export function reviewLifecycle(state: EngineState, preferences: Record<string, unknown> | undefined, now: string): EngineState {
  if (state.status !== 'running') return state;
  const elapsed = state.startedAt === null ? Infinity : Date.parse(now) - Date.parse(state.startedAt);
  const key = policyKey(preferences);
  const interval = preferences?.interval ?? 60;
  const minimumInterval = minimumPollIntervalSeconds(preferences);
  if (!Number.isInteger(interval) || (interval as number) < minimumInterval || (interval as number) > 86400 ||
      (state.policyKey !== null && state.pollIntervalS < minimumInterval)) return parkForReview(state, now, blockedFailureContext('config-changed', 'lifecycle-check'));
  if (elapsed < 0 || elapsed >= SESSION_AGE_MINUTES * 60_000)
    return parkForReview(state, now, { category: 'workflow-blocked',
      code: elapsed < 0 ? 'clock-invalid' : 'session-age-exceeded', step: 'lifecycle-check' });
  if (state.policyKey !== null && state.policyKey !== key)
    return parkForReview(state, now, blockedFailureContext('config-changed', 'lifecycle-check'));
  return state.policyKey === null ? { ...state, policyKey: key, pollIntervalS: interval as number, updatedAt: now } : state;
}
