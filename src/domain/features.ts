import type { EngineMode } from './groups';

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
// Positive evidence independently exposes each feature. Only a dashboard
// without either known group type offers scheduling as the fallback;
// normal exact-group, paid-baseline and complete-roster guards still apply.
export function dashboardFeatures(raw: unknown): DashboardFeatures {
  if (!raw || typeof raw !== 'object' || !('groups' in raw) || !Array.isArray(raw.groups))
    throw new Error('Invalid dashboard snapshot.');
  const groups = raw.groups;
  // Unreadable siblings must not erase positive payment evidence. Preserve
  // the reader's incomplete identities while rejecting malformed/duplicate
  // identifiers; exact selected-group validation still gates every workflow.
  const digitId = (value: unknown) => typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
  for (const group of groups) {
    if (!group || typeof group !== 'object' ||
        (group.scheduleId !== '' && !digitId(group.scheduleId)) ||
        (group.ivr !== null && !digitId(group.ivr))) throw new Error('Invalid dashboard group.');
  }
  const schedules = groups.map(group => group.scheduleId).filter(id => id !== '');
  const ivrs = groups.map(group => group.ivr).filter(id => id !== null);
  if (new Set(schedules).size !== schedules.length || new Set(ivrs).size !== ivrs.length)
    throw new Error('Ambiguous dashboard groups.');
  const paid = groups.some(group => group.paymentStatus === 'paid');
  const unpaid = groups.some(group => group.paymentStatus === 'unpaid');
  return paid && unpaid ? 'both' : unpaid ? 'alerts' : 'booking';
}

export function featureMode(features: DashboardFeatures, preferred: EngineMode): EngineMode {
  return features === 'both' ? preferred : features;
}
