// PostHog build-time configuration. Manual fetch only, no SDK.
//
// Allowed ingestion hosts are exactly the fixed PostHog US/EU hosts. Any
// other host (including paths, queries, credentials, ports) disables
// tracking with zero network traffic.

export const POSTHOG_ALLOWED_HOSTS = [
  'https://us.i.posthog.com',
  'https://eu.i.posthog.com',
] as const;
export type PostHogAllowedHost = (typeof POSTHOG_ALLOWED_HOSTS)[number];

export const POSTHOG_ENDPOINT_PATH = '/i/v0/e/';

export type AnalyticsConfig =
  | { enabled: false }
  | { enabled: true; projectToken: string; host: PostHogAllowedHost; endpoint: string };

function isAllowedHost(value: string): value is PostHogAllowedHost {
  return (POSTHOG_ALLOWED_HOSTS as readonly string[]).includes(value);
}

// PostHog project tokens start with phc_. Reject anything else so a pasted
// secret, URL, or placeholder never becomes network traffic.
function isToken(value: string): boolean {
  return /^phc_[A-Za-z0-9]{10,128}$/.test(value);
}

export function resolveAnalyticsConfig(env: {
  token?: unknown;
  host?: unknown;
  enabledFlag?: unknown;
}): AnalyticsConfig {
  const token = typeof env.token === 'string' ? env.token.trim() : '';
  const host = typeof env.host === 'string' ? env.host.trim() : '';
  const flag = typeof env.enabledFlag === 'string' ? env.enabledFlag.trim().toLowerCase() : '';
  if (['0', 'false', 'no', 'off', 'disabled'].includes(flag)) return { enabled: false };
  if (!['', '1', 'true', 'yes', 'on', 'enabled'].includes(flag)) return { enabled: false };
  if (!isToken(token)) return { enabled: false };
  if (!isAllowedHost(host)) return { enabled: false };
  return { enabled: true, projectToken: token, host, endpoint: `${host}${POSTHOG_ENDPOINT_PATH}` };
}

// Reads Vite build-time env. Absent/malformed config disables tracking.
export function buildTimeAnalyticsConfig(): AnalyticsConfig {
  try {
    if (!import.meta.env.PROD || import.meta.env.MODE === 'test') return { enabled: false };
    return resolveAnalyticsConfig({
      token: import.meta.env.VITE_POSTHOG_PROJECT_TOKEN,
      host: import.meta.env.VITE_POSTHOG_HOST,
      enabledFlag: import.meta.env.VITE_POSTHOG_ENABLED,
    });
  } catch {
    return { enabled: false };
  }
}

export function isPostHogEndpoint(url: string, config: AnalyticsConfig): boolean {
  if (!config.enabled) return false;
  return url === config.endpoint;
}
