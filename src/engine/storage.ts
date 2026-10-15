import { ENGINE_KEY, validateEngineState, type EngineState } from './workflow';

export { ENGINE_KEY };

export type StorageArea = {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
};

// Durable engine state lives in chrome.storage.local (trusted contexts only)
// so an interrupted confirmation survives a browser restart for review.
// Session storage is not used here: it resets on restart and would lose the
// pending intent. Throws fail closed — callers surface for review, never guess.
export async function loadEngineState(area: StorageArea): Promise<EngineState | null> {
  const saved = (await area.get([ENGINE_KEY]))[ENGINE_KEY];
  if (saved === undefined) return null;
  return validateEngineState(saved);
}

export async function saveEngineState(area: StorageArea, state: EngineState): Promise<void> {
  validateEngineState(state);
  await area.set({ [ENGINE_KEY]: state });
}
