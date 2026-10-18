import { CONSULATES, isIsoDate } from '../domain/dates';
import { validateSummaryReading } from '../domain/summary';
import { panelFailureKind, type PanelFailureKind } from './panel-errors';
import type { EngineState } from './workflow';
import type { DashboardFeatures } from '../domain/features';

export type PanelSnapshot = {
  mode: 'booking' | 'alerts'; status: 'idle' | 'running' | 'success' | 'failure'; reviewRequired: boolean;
  dates: string[]; rows: { city: keyof typeof CONSULATES; date: string | null }[];
  checkedAt: string | null; currentDate: string | null; confirmedDate: string | null;
  manualAuthentication?: boolean;
  reviewMessage?: string;
  failureKind?: PanelFailureKind;
  restartFailed?: boolean;
  availableModes?: DashboardFeatures;
  modeChoiceRequired?: boolean;
  discovering?: boolean;
};

export function panelSnapshot(state: EngineState | null, raw: unknown, success: unknown): PanelSnapshot {
  const snapshot: PanelSnapshot = { mode: state?.mode ?? 'booking', status: state?.status === 'running' || state?.verification?.nextReadAt || state?.authentication ? 'running' : 'idle',
    reviewRequired: state?.status === 'verifying' || state?.manualAuthentication === true || !!state?.authenticationError || !!state?.verificationError, dates: [], rows: [], checkedAt: null, currentDate: state?.group?.currentDate ?? null, confirmedDate: null,
    ...(state?.manualAuthentication ? { manualAuthentication: true } : {}) };
  if (state?.restartFailed) snapshot.restartFailed = true;
  if (state?.discovery?.features) snapshot.availableModes = state.discovery.features;
  if (state?.discovery?.choosing) snapshot.modeChoiceRequired = true;
  if (state?.status === 'running' && state.discovery?.requested) snapshot.discovering = true;
  if (state?.manualAuthentication) snapshot.reviewMessage = 'Sign in manually on the official website, then press Start.';
  else if (state?.intent) snapshot.reviewMessage = snapshot.status === 'running'
    ? 'Checking the previous booking attempt. No new booking will start during this check.'
    : (state?.verificationError ?? 'The previous booking attempt needs checking. Press Start to verify its result first.');
  else if (state?.verificationError) snapshot.reviewMessage = state.verificationError;
  if (state?.authenticationError) snapshot.reviewMessage = [snapshot.reviewMessage, state.authenticationError].filter(Boolean).join(' ');
  // A real stopped failure carries a validated classification so the UI can
  // show the catch-all or the matching IVR state. Manual handoff keeps its
  // existing banner; parked verifying states (including unresolved intent)
  // are never marked as failures here, even with verification diagnostics.
  if (state?.status === 'stopped' && !state.manualAuthentication && (state.loginFailed || state.authenticationError)) {
    snapshot.status = 'failure';
    snapshot.failureKind = panelFailureKind(state.authenticationError ?? new Error('stopped'));
    snapshot.reviewRequired = true;
  }
  if (state?.status === 'stopped' && success && typeof success === 'object') {
    const confirmed = success as Record<string, unknown>;
    if (confirmed.runId === state.runId && isIsoDate(confirmed.date as string)) { snapshot.status = 'success'; snapshot.confirmedDate = confirmed.date as string; delete snapshot.failureKind; }
  }
  if (!raw || typeof raw !== 'object' || !state) return snapshot;
  const observation = raw as Record<string, unknown>;
  if (observation.runId !== state.runId || observation.mode !== state.mode || typeof observation.checkedAt !== 'string' || !Number.isFinite(Date.parse(observation.checkedAt))) return snapshot;
  try {
    if (state.mode === 'booking') {
      if (!Array.isArray(observation.dates) || !observation.dates.every(isIsoDate)) return snapshot;
      snapshot.dates = [...new Set(observation.dates)] as string[];
    } else snapshot.rows = validateSummaryReading({ heading: 'First Available Appointments', rows: observation.rows }).rows;
    snapshot.checkedAt = observation.checkedAt;
  } catch { return snapshot; }
  return snapshot;
}
