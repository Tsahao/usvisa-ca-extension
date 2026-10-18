import { dashboardFeatures, featureMode } from '../domain/features';
import type { EngineState } from './workflow';

// Runs only after the caller validates a live dashboard and cancellation.
// Legacy runs retain their selected workflow on first discovery. Once known,
// a changed feature set may select a new mode during safe dashboard entry.
// Verification always retains the original group and bypasses this function.
export function assessDashboard(state: EngineState, raw: unknown): EngineState {
  if (state.intent || state.executor?.actionPending) return state;
  const features = dashboardFeatures(raw);
  const previous = state.discovery;
  const choosing = previous?.requested === true && features === 'both';
  const mode = previous ? featureMode(features, state.mode) : state.mode;
  const next: EngineState = { ...state, discovery: { features, requested: false, choosing } };
  if (choosing) return { ...next, status: 'stopped', authentication: null, group: null, executor: null,
    monitorTabId: null, lastCandidate: null, stage: null, nextPollAt: null, restartPending: false };
  if (mode === state.mode) return next;
  // There is no unresolved mutation here. New-mode binding still has to pass
  // that mode's exact IVR, payment status, baseline and roster checks.
  return { ...next, mode, group: null, executor: null, monitorTabId: null, lastCandidate: null, stage: null };
}
