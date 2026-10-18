// New preferences use the positive Auto Mode flag. Keep reading the inverse
// legacy bit so an upgrade never silently changes booking authorization.
// An explicit but malformed new flag must not fall back to a legacy live bit.
export function readAutoMode(preferences: unknown): boolean | null {
  if (!preferences || typeof preferences !== 'object') return null;
  const value = preferences as Record<string, unknown>;
  if (Object.hasOwn(value, 'autoMode')) return typeof value.autoMode === 'boolean' ? value.autoMode : null;
  return typeof value.testMode === 'boolean' ? !value.testMode : null;
}
