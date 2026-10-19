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

// The acknowledged limit warning submits a GET form that lands a sole
// applicant directly on the booking form with only its own parameters in the
// query. Only that exact shape, or no query at all, may bind an implicit
// applicant; applicants[] and anything else stay explicit.
export function isBareAppointmentQuery(url: URL): boolean {
  if (!url.search) return true;
  for (const [key, value] of url.searchParams) {
    if (key === 'confirmed_limit_message' && value === '1' && url.searchParams.getAll(key).length === 1) continue;
    if (key === 'commit' && url.searchParams.getAll(key).length === 1) continue;
    return false;
  }
  return url.searchParams.get('confirmed_limit_message') === '1';
}
