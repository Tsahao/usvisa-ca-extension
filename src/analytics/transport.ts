// Manual PostHog transport. No SDK, no autocapture, no heatmaps, no replay,
// no automatic error collection. One POST per queued event to the exact
// configured endpoint only. Redirects are rejected, cookies/referrer never
// sent, endpoint has a bounded timeout.

import { resolveAnalyticsConfig, type AnalyticsConfig } from './config';
import { toCapturePayload, validateQueuedEvent, type QueuedAnalyticsEvent } from './events';

export const ANALYTICS_TIMEOUT_MS = 10_000;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export function captureBody(event: QueuedAnalyticsEvent, projectToken: string): string {
  return JSON.stringify(toCapturePayload(event, projectToken));
}

// Sends one event. Throws on any transport, status, host, or shape problem so
// the caller keeps the event queued for bounded retry. Never sends
// credentials, cookies, or referrer; rejects redirects and untrusted hosts.
export async function sendOneEvent(args: {
  event: QueuedAnalyticsEvent;
  config: AnalyticsConfig;
  fetchFn: FetchFn;
  timeoutMs?: number;
}): Promise<void> {
  const { event, config, fetchFn } = args;
  const timeoutMs = args.timeoutMs ?? ANALYTICS_TIMEOUT_MS;
  validateQueuedEvent(event);
  if (!config.enabled) throw new Error('Analytics disabled.');
  const checked = resolveAnalyticsConfig({ token: config.projectToken, host: config.host });
  if (!checked.enabled || checked.endpoint !== config.endpoint) throw new Error('Invalid analytics endpoint.');
  const body = captureBody(event, config.projectToken);
  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> | null = typeof setTimeout === 'function'
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetchFn(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      keepalive: false,
      signal: controller.signal,
    });
    if (!response || typeof response.ok !== 'boolean' || !response.ok) throw new Error('Analytics send failed.');
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
