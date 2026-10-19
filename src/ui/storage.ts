import { platform } from '../platform';
import { EMPTY_PREFERENCES, EMPTY_RUN, type Mode, type Preferences, type Run } from './model';
import { readAutoMode } from '../domain/auto-mode';
import { selectedConsulates } from '../domain/dates';

const KEY = 'uiPreferencesV1';
const TERMS_KEY = 'uiTermsVersion';
const RUN_KEY = 'uiSimulatedRunV1';
const LAST_MODE_KEY = 'uiLastModeV1';
export const isExtension = platform.hasRuntimeId;
function parseLastMode(value: unknown): Mode | null {
  return value === 'booking' || value === 'alerts' ? value : null;
}
export async function loadUiState(includeSimulatedRun = true): Promise<{ preferences: Preferences; terms: string; run: Run; lastMode: Mode | null }> {
  if (!isExtension) return { preferences: structuredClone(EMPTY_PREFERENCES), terms: '', run: { ...EMPTY_RUN }, lastMode: null };
  await platform.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const [local, session] = await Promise.all([platform.storage.local.get([KEY, TERMS_KEY, LAST_MODE_KEY]), platform.storage.session.get(RUN_KEY)]);
  let raw = local[KEY];
  if (raw && typeof raw === 'object' && !('consulates' in raw)) {
    // Legacy single `consulate` becomes the ordered selection ([] when unset or unknown).
    const { consulate: _legacy, ...rest } = raw as Record<string, unknown>;
    raw = { ...rest, consulates: selectedConsulates(raw) ?? [] };
  }
  const saved = raw && typeof raw === 'object' ? { ...raw, autoMode: readAutoMode(raw) } as Preferences : undefined;
  const terms = local[TERMS_KEY];
  const run = includeSimulatedRun ? session[RUN_KEY] as Run | undefined : undefined;
  if (raw !== undefined && (!saved || typeof saved !== 'object' || Object.keys(EMPTY_PREFERENCES).some(key => typeof saved[key as keyof Preferences] !== typeof EMPTY_PREFERENCES[key as keyof Preferences]))) throw new Error('Invalid saved preferences.');
  if (run && (typeof run !== 'object' || !['booking', 'alerts'].includes(run.mode) || !['idle', 'running', 'success', 'failure', 'recovering', 'cooldown', 'expired', 'review'].includes(run.status) || (run.lastChecked !== null && typeof run.lastChecked !== 'string'))) throw new Error('Invalid preview state.');
  const preferences = saved ? Object.fromEntries(Object.keys(EMPTY_PREFERENCES).map(key => [key, saved[key as keyof Preferences]])) as Preferences : structuredClone(EMPTY_PREFERENCES);
  const restoredRun: Run = run ? { mode: run.mode, status: ['idle', 'running', 'success', 'failure'].includes(run.status) ? run.status : 'idle', lastChecked: run.lastChecked } : { ...EMPTY_RUN };
  return { preferences, terms: typeof terms === 'string' ? terms : '', run: restoredRun, lastMode: parseLastMode(local[LAST_MODE_KEY]) };
}
export async function savePreferences(preferences: Preferences): Promise<void> {
  if (isExtension) await platform.storage.local.set({ [KEY]: preferences });
}
export async function saveTerms(version: string): Promise<void> {
  if (isExtension) await platform.storage.local.set({ [TERMS_KEY]: version });
}
export async function saveRun(run: Run): Promise<void> {
  if (isExtension) await platform.storage.session.set({ [RUN_KEY]: run });
}
export async function saveLastMode(mode: Mode): Promise<void> {
  if (isExtension) await platform.storage.local.set({ [LAST_MODE_KEY]: mode });
}
