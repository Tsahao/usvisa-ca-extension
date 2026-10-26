import { isUuid, validateQueuedEvent, type QueuedAnalyticsEvent } from './events';

export const ANALYTICS_KEY = 'analyticsV1';
export const OUTBOX_MAX = 100;
export const MAX_ATTEMPTS = 10;

export type AnalyticsSession = {
  id: string;
  runId: string | null;
  mode: 'booking' | 'alerts';
  testMode: boolean;
  failed: boolean;
  activated: boolean;
  bookingSucceeded?: boolean;
  closed: boolean;
};

export type AnalyticsRecord = {
  version: 1;
  distinctId: string;
  session: AnalyticsSession | null;
  queued: { runId: string; mode: 'booking' | 'alerts'; testMode: boolean } | null;
  outbox: QueuedAnalyticsEvent[];
  nextFlushAt: string | null;
};

export type StorageArea = {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
};

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

// Do not regenerate an identity on read failures/corrupt saves. Refuse telemetry
// instead. All writes use one record, committing a milestone and its outbox
// event together; only a validated allowlist is ever serialized for delivery.
export function validateAnalyticsRecord(value: unknown): AnalyticsRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid analytics save.');
  const record = { ...value } as AnalyticsRecord;
  if (record.version !== 1 || !isUuid(record.distinctId)) throw new Error('Invalid analytics save.');
  if (record.session !== null) {
    const session = record.session;
    if (!session || !isUuid(session.id) || (session.runId !== null && !validRunId(session.runId)) ||
        !['booking', 'alerts'].includes(session.mode) ||
        !['testMode', 'failed', 'activated', 'closed'].every(key => typeof session[key as keyof AnalyticsSession] === 'boolean'))
      throw new Error('Invalid analytics session.');
    if (session.bookingSucceeded !== undefined && typeof session.bookingSucceeded !== 'boolean')
      throw new Error('Invalid analytics session.');
    // Discard the local ledger for the removed, never-required recovery event.
    record.session = { ...session };
    delete (record.session as AnalyticsSession & { baselineRevision?: unknown }).baselineRevision;
  }
  if (record.queued !== null && (!record.queued || !validRunId(record.queued.runId) ||
      !['booking', 'alerts'].includes(record.queued.mode) || typeof record.queued.testMode !== 'boolean'))
    throw new Error('Invalid analytics queue.');
  if (!Array.isArray(record.outbox) || record.outbox.length > OUTBOX_MAX) throw new Error('Invalid analytics outbox.');
  // A development build may have queued this retired event. Drop it before
  // normal validation/delivery so it is never sent and cannot block the five
  // supported milestones. Preserve the identity and all other queued events.
  record.outbox = record.outbox.filter(event => (event as { event?: unknown } | null)?.event !== 'appointment_baseline_updated');
  for (const event of record.outbox) {
    validateQueuedEvent(event);
    if (event.distinct_id !== record.distinctId || event.attempts > MAX_ATTEMPTS) throw new Error('Invalid analytics outbox.');
  }
  if (record.nextFlushAt !== null && (typeof record.nextFlushAt !== 'string' || !Number.isFinite(Date.parse(record.nextFlushAt))))
    throw new Error('Invalid analytics deadline.');
  return structuredClone(record);
}

export function appendEvent(record: AnalyticsRecord, event: QueuedAnalyticsEvent): void {
  record.outbox.push(event);
  if (record.outbox.length > OUTBOX_MAX) {
    const index = record.outbox.findIndex(entry => entry.event !== 'installation_seen');
    record.outbox.splice(index < 0 ? 0 : index, 1);
  }
  record.nextFlushAt ??= event.timestamp;
}
