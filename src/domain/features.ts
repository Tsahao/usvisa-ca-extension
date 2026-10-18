import { validateDashboardSnapshot, type EngineMode } from './groups';

export type DashboardFeatures = 'booking' | 'alerts' | 'both';
export type DashboardDiscovery = {
  features: DashboardFeatures | null;
  requested: boolean;
  choosing: boolean;
};

export function isDashboardFeatures(value: unknown): value is DashboardFeatures {
  return value === 'booking' || value === 'alerts' || value === 'both';
}

// Classification controls which features are offered, never permission to act.
// Unknown/incomplete markup offers scheduling as the documented fallback;
// normal exact-group, paid-baseline and complete-roster guards still apply.
export function dashboardFeatures(raw: unknown): DashboardFeatures {
  if (!raw || typeof raw !== 'object' || !('groups' in raw) || !Array.isArray(raw.groups))
    throw new Error('Invalid dashboard snapshot.');
  const groups = raw.groups;
  if (groups.some(group => !group || typeof group !== 'object')) throw new Error('Invalid dashboard group.');
  if (groups.some(group => group.scheduleId === '' || group.ivr === null)) return 'booking';
  const snapshot = validateDashboardSnapshot(raw);
  if (!snapshot.groups.length || snapshot.groups.some(group => group.paymentStatus === 'unknown')) return 'booking';
  const paid = snapshot.groups.some(group => group.paymentStatus === 'paid');
  const unpaid = snapshot.groups.some(group => group.paymentStatus === 'unpaid');
  return paid && unpaid ? 'both' : unpaid ? 'alerts' : 'booking';
}

export function featureMode(features: DashboardFeatures, preferred: EngineMode): EngineMode {
  return features === 'both' ? preferred : features;
}
