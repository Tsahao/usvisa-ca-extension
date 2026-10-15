export const SITE_ORIGIN = 'https://ais.usvisa-info.com';
export type RouteKind = 'login' | 'dashboard' | 'landing' | 'appointment' | 'payment' | 'actions' | 'untrusted' | 'unsupported';

// Never return arbitrary hosts, URLs, account IDs, or page text to diagnostics.
export function classifyRoute(value: string): RouteKind {
  let url: URL;
  try { url = new URL(value); } catch { return 'untrusted'; }
  if (url.origin !== SITE_ORIGIN || url.username || url.password || url.port) return 'untrusted';
  if (url.pathname === '/en-ca/niv/users/sign_in') return 'login';
  // The site root redirects to the account dashboard when signed in and
  // offers Continue to sign-in otherwise. It carries no schedule segment.
  if (url.pathname === '/en-ca/niv' || url.pathname === '/en-ca/niv/') return 'landing';
  if (url.pathname === '/en-ca/niv/groups') return 'dashboard';
  if (/^\/en-ca\/niv\/groups\/[0-9]+$/.test(url.pathname)) return 'dashboard';
  if (/^\/en-ca\/niv\/schedule\/[0-9]+\/appointment$/.test(url.pathname)) return 'appointment';
  if (/^\/en-ca\/niv\/schedule\/[0-9]+\/payment$/.test(url.pathname)) return 'payment';
  if (/^\/en-ca\/niv\/schedule\/[0-9]+\/continue_actions$/.test(url.pathname)) return 'actions';
  return 'unsupported';
}
