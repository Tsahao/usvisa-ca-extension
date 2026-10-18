// Fixed allowlist analytics event builders. No credentials, IVR, group,
// applicant, tab, URL, date, preference, or raw error/DOM/network text ever
// enters telemetry. Every event carries only the fields below.

export const ANALYTICS_EVENTS = [
  'installation_seen',
  'workflow_started',
  'alerts_monitoring_established',
  'workflow_failed',
  'appointment_booked',
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export const FAILURE_REASONS = ['start-failed', 'setup-exhausted', 'authentication-failed', 'workflow-blocked'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const ANALYTICS_MODES = ['booking', 'alerts'] as const;
export type AnalyticsMode = (typeof ANALYTICS_MODES)[number];

export const ANALYTICS_ENVIRONMENTS = ['production'] as const;
export type AnalyticsEnvironment = (typeof ANALYTICS_ENVIRONMENTS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isFailureReason(value: unknown): value is FailureReason {
  return FAILURE_REASONS.includes(value as FailureReason);
}

export type AnalyticsProperties = {
  analytics_session_id?: string;
  mode?: AnalyticsMode;
  extension_version: string;
  environment: AnalyticsEnvironment;
  test_mode?: boolean;
  failure_reason?: FailureReason;
  $process_person_profile: false;
  $geoip_disable: true;
};

export type QueuedAnalyticsEvent = {
  uuid: string;
  event: AnalyticsEventName;
  distinct_id: string;
  timestamp: string;
  properties: AnalyticsProperties;
  attempts: number;
};

export function validateQueuedEvent(value: unknown): QueuedAnalyticsEvent {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid analytics event.');
  const entry = value as Record<string, unknown>;
  if (!isUuid(entry.uuid)) throw new Error('Invalid analytics event.');
  if (!ANALYTICS_EVENTS.includes(entry.event as AnalyticsEventName)) throw new Error('Invalid analytics event.');
  if (!isUuid(entry.distinct_id)) throw new Error('Invalid analytics event.');
  if (typeof entry.timestamp !== 'string' || !ISO_DATETIME_RE.test(entry.timestamp) || !Number.isFinite(Date.parse(entry.timestamp)))
    throw new Error('Invalid analytics event.');
  if (!Number.isInteger(entry.attempts) || (entry.attempts as number) < 0) throw new Error('Invalid analytics event.');
  const props = entry.properties as Record<string, unknown> | undefined;
  if (typeof props !== 'object' || props === null) throw new Error('Invalid analytics event.');
  if (typeof props.extension_version !== 'string' || !VERSION_RE.test(props.extension_version))
    throw new Error('Invalid analytics event.');
  if (props.environment !== 'production') throw new Error('Invalid analytics event.');
  if (props.$process_person_profile !== false || props.$geoip_disable !== true)
    throw new Error('Invalid analytics event.');
  // Reject any non-allowlisted property (prevents identifier leaks).
  const allowed = new Set(['analytics_session_id', 'mode', 'extension_version', 'environment', 'test_mode', 'failure_reason', '$process_person_profile', '$geoip_disable']);
  for (const key of Object.keys(props)) {
    if (!allowed.has(key)) throw new Error('Invalid analytics event.');
  }
  if (props.analytics_session_id !== undefined && !isUuid(props.analytics_session_id))
    throw new Error('Invalid analytics event.');
  if (props.mode !== undefined && props.mode !== 'booking' && props.mode !== 'alerts')
    throw new Error('Invalid analytics event.');
  if (props.test_mode !== undefined && typeof props.test_mode !== 'boolean')
    throw new Error('Invalid analytics event.');
  if (props.failure_reason !== undefined && !isFailureReason(props.failure_reason))
    throw new Error('Invalid analytics event.');
  // Per-event required fields.
  if (entry.event === 'installation_seen') {
    if (props.analytics_session_id !== undefined || props.mode !== undefined || props.test_mode !== undefined || props.failure_reason !== undefined)
      throw new Error('Invalid analytics event.');
  }
  if (entry.event === 'workflow_started' || entry.event === 'alerts_monitoring_established') {
    if (!isUuid(props.analytics_session_id) || (props.mode !== 'booking' && props.mode !== 'alerts') || typeof props.test_mode !== 'boolean' || props.failure_reason !== undefined)
      throw new Error('Invalid analytics event.');
  }
  if (entry.event === 'workflow_failed') {
    if (!isUuid(props.analytics_session_id) || (props.mode !== 'booking' && props.mode !== 'alerts') || typeof props.test_mode !== 'boolean' || !isFailureReason(props.failure_reason))
      throw new Error('Invalid analytics event.');
  }
  if (entry.event === 'alerts_monitoring_established' && props.mode !== 'alerts') throw new Error('Invalid analytics event.');
  if (entry.event === 'appointment_booked' && (!isUuid(props.analytics_session_id) || props.mode !== 'booking' || props.test_mode !== false || props.failure_reason !== undefined))
    throw new Error('Invalid analytics event.');
  return entry as unknown as QueuedAnalyticsEvent;
}

function baseProperties(version: string): Pick<AnalyticsProperties, 'extension_version' | 'environment' | '$process_person_profile' | '$geoip_disable'> {
  if (!VERSION_RE.test(version)) throw new Error('Invalid extension version.');
  return { extension_version: version, environment: 'production', $process_person_profile: false, $geoip_disable: true };
}

export function buildInstallationSeen(args: {
  eventUuid: string; distinctId: string; timestamp: string; extensionVersion: string;
}): QueuedAnalyticsEvent {
  if (!isUuid(args.eventUuid) || !isUuid(args.distinctId)) throw new Error('Invalid analytics identity.');
  if (!ISO_DATETIME_RE.test(args.timestamp)) throw new Error('Invalid analytics timestamp.');
  return { uuid: args.eventUuid, event: 'installation_seen', distinct_id: args.distinctId,
    timestamp: args.timestamp, properties: baseProperties(args.extensionVersion), attempts: 0 };
}

export function buildWorkflowStarted(args: {
  eventUuid: string; distinctId: string; timestamp: string; extensionVersion: string;
  analyticsSessionId: string; mode: AnalyticsMode; testMode: boolean;
}): QueuedAnalyticsEvent {
  if (!isUuid(args.eventUuid) || !isUuid(args.distinctId) || !isUuid(args.analyticsSessionId))
    throw new Error('Invalid analytics identity.');
  if (!ISO_DATETIME_RE.test(args.timestamp)) throw new Error('Invalid analytics timestamp.');
  if (args.mode !== 'booking' && args.mode !== 'alerts') throw new Error('Invalid analytics mode.');
  if (typeof args.testMode !== 'boolean') throw new Error('Invalid analytics mode flag.');
  return { uuid: args.eventUuid, event: 'workflow_started', distinct_id: args.distinctId,
    timestamp: args.timestamp,
    properties: { ...baseProperties(args.extensionVersion), analytics_session_id: args.analyticsSessionId, mode: args.mode, test_mode: args.testMode },
    attempts: 0 };
}

export function buildAlertsEstablished(args: {
  eventUuid: string; distinctId: string; timestamp: string; extensionVersion: string;
  analyticsSessionId: string; testMode: boolean;
}): QueuedAnalyticsEvent {
  if (!isUuid(args.eventUuid) || !isUuid(args.distinctId) || !isUuid(args.analyticsSessionId))
    throw new Error('Invalid analytics identity.');
  if (!ISO_DATETIME_RE.test(args.timestamp)) throw new Error('Invalid analytics timestamp.');
  if (typeof args.testMode !== 'boolean') throw new Error('Invalid analytics mode flag.');
  return { uuid: args.eventUuid, event: 'alerts_monitoring_established', distinct_id: args.distinctId,
    timestamp: args.timestamp,
    properties: { ...baseProperties(args.extensionVersion), analytics_session_id: args.analyticsSessionId, mode: 'alerts', test_mode: args.testMode },
    attempts: 0 };
}

export function buildAppointmentBooked(args: {
  eventUuid: string; distinctId: string; timestamp: string; extensionVersion: string;
  analyticsSessionId: string;
}): QueuedAnalyticsEvent {
  return validateQueuedEvent({ ...buildWorkflowStarted({ ...args, mode: 'booking', testMode: false }), event: 'appointment_booked' });
}

export function buildWorkflowFailed(args: {
  eventUuid: string; distinctId: string; timestamp: string; extensionVersion: string;
  analyticsSessionId: string; mode: AnalyticsMode; testMode: boolean; failureReason: FailureReason;
}): QueuedAnalyticsEvent {
  if (!isUuid(args.eventUuid) || !isUuid(args.distinctId) || !isUuid(args.analyticsSessionId))
    throw new Error('Invalid analytics identity.');
  if (!ISO_DATETIME_RE.test(args.timestamp)) throw new Error('Invalid analytics timestamp.');
  if (args.mode !== 'booking' && args.mode !== 'alerts') throw new Error('Invalid analytics mode.');
  if (typeof args.testMode !== 'boolean') throw new Error('Invalid analytics mode flag.');
  if (!isFailureReason(args.failureReason)) throw new Error('Invalid analytics reason.');
  return { uuid: args.eventUuid, event: 'workflow_failed', distinct_id: args.distinctId,
    timestamp: args.timestamp,
    properties: { ...baseProperties(args.extensionVersion), analytics_session_id: args.analyticsSessionId,
      mode: args.mode, test_mode: args.testMode, failure_reason: args.failureReason },
    attempts: 0 };
}

// PostHog capture payload. api_key carries the project token; no cookies,
// referrer, or extra enrichment. $ip is nulled and person processing plus
// GeoIP are disabled in properties where supported.
export function toCapturePayload(event: QueuedAnalyticsEvent, projectToken: string): Record<string, unknown> {
  validateQueuedEvent(event);
  if (!/^phc_[A-Za-z0-9]{10,128}$/.test(projectToken)) throw new Error('Invalid analytics token.');
  return {
    api_key: projectToken,
    event: event.event,
    distinct_id: event.distinct_id,
    timestamp: event.timestamp,
    uuid: event.uuid,
    properties: { ...event.properties, $ip: null, $process_person_profile: false, $geoip_disable: true },
  };
}
