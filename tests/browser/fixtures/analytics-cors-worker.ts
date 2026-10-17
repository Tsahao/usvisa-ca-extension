// Synthetic-only worker. Its real fetch is redirected to a loopback HTTP
// fixture, not intercepted/fulfilled by Playwright. No owner project token.
import { buildInstallationSeen } from '../../../src/analytics/events';
import { resolveAnalyticsConfig } from '../../../src/analytics/config';
import { sendOneEvent } from '../../../src/analytics/transport';
import { createAnalyticsTracker } from '../../../src/analytics/tracker';

const config = resolveAnalyticsConfig({ token: 'phc_synthetic000000000000000000', host: 'https://us.i.posthog.com' });
const event = () => buildInstallationSeen({ eventUuid: crypto.randomUUID(), distinctId: crypto.randomUUID(),
  timestamp: new Date().toISOString(), extensionVersion: 'cors-synthetic' });
const fetchTo = (url: string) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error('Loopback fixtures only');
  return (_input: string, init: RequestInit) => fetch(url, init);
};
Object.assign(globalThis, { analyticsProbe: {
  async send(url: string, timeoutMs = 1000) {
    try { await sendOneEvent({ event: event(), config, fetchFn: fetchTo(url), timeoutMs }); return true; }
    catch { return false; }
  },
  async seed() {
    const item = event();
    await chrome.storage.local.set({ analyticsV1: { version: 1, distinctId: item.distinct_id,
      session: null, queued: null, outbox: [item], nextFlushAt: null }, workflowSentinel: 'unchanged' });
    return item.uuid;
  },
  async flush(url: string) {
    const tracker = createAnalyticsTracker({ config, area: chrome.storage.local, fetchFn: fetchTo(url),
      nowIso: () => new Date().toISOString(), uuid: () => crypto.randomUUID(),
      extensionVersion: 'cors-synthetic', scheduleFlush: () => undefined });
    await tracker.flush();
    return chrome.storage.local.get(['analyticsV1', 'workflowSentinel']);
  },
} });
