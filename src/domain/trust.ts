import { classifyRoute, SITE_ORIGIN, type RouteKind } from './routes';

export type TrustedUrl = {
  href: string;
  route: RouteKind;
  scheduleId: string | null;
};

function extractScheduleId(pathname: string): string | null {
  const dashboard = pathname.match(/^\/en-ca\/niv\/groups\/([0-9]+)$/);
  if (dashboard) return dashboard[1];
  const schedule = pathname.match(/^\/en-ca\/niv\/schedule\/([0-9]+)\//);
  if (schedule) return schedule[1];
  return null;
}

// Parses a candidate URL into a trusted reference. Anything off-origin,
// credential-bearing, malformed, or outside the known route set throws —
// callers never persist or navigate to it. Query strings are preserved:
// appointment flow variants live in them.
export function parseTrustedUrl(value: string): TrustedUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Untrusted URL.');
  }
  if (url.origin !== SITE_ORIGIN || url.username || url.password || url.port) throw new Error('Untrusted URL.');
  const route = classifyRoute(value);
  if (route === 'untrusted' || route === 'unsupported') throw new Error('Untrusted URL.');
  return { href: url.href, route, scheduleId: extractScheduleId(url.pathname) };
}

// Restoration gate: only a saved trusted URL whose group binding still
// matches may be reopened. Group-neutral pages (bare dashboard, login)
// carry no schedule segment and pass for any bound group; group-bound pages
// must match exactly. Never throws: doubt means do not navigate.
export function isSameGroupUrl(value: string, scheduleId: string): boolean {
  try {
    const parsed = parseTrustedUrl(value);
    if (!/^[0-9]{1,32}$/.test(scheduleId)) return false;
    if (parsed.scheduleId === null) return true;
    return parsed.scheduleId === scheduleId;
  } catch {
    return false;
  }
}
