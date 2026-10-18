export type DashboardContinueRequest = { scheduleId: string; ivr: string | null; dashboardPath: string; applicantIds: string[] };

export function performDashboardContinue(request: DashboardContinueRequest): { ok: boolean } {
  const url = new URL(location.href);
  const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length > 0 && ids.length <= 100 &&
    ids.every(id => typeof id === 'string' && /^[0-9]{1,32}$/.test(id)) && new Set(ids).size === ids.length;
  if (url.origin !== 'https://ais.usvisa-info.com' || url.username || url.password || url.port || url.hash ||
      !/^\/en-ca\/niv\/groups(?:\/[0-9]{1,32})?$/.test(request.dashboardPath) || url.pathname !== request.dashboardPath ||
      !/^[0-9]{1,32}$/.test(request.scheduleId) || (request.ivr !== null && !/^[0-9]{5,32}$/.test(request.ivr)) || !validIds(request.applicantIds)) return { ok: false };
  const targetPath = `/en-ca/niv/schedule/${request.scheduleId}/continue_actions`;
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('ul.actions a[href]')).filter(link => {
    const target = new URL(link.getAttribute('href') ?? '', url);
    return target.origin === url.origin && !target.username && !target.password && !target.port && !target.hash && !target.search && target.pathname === targetPath;
  });
  if (links.length !== 1) return { ok: false };
  const link = links[0];
  let scope: Element | null = link.parentElement;
  let group: Element | null = null;
  for (let depth = 0; depth < 8 && scope; depth += 1, scope = scope.parentElement) {
    const schedules = new Set(Array.from(scope.querySelectorAll('a[href]')).map(element => {
      try {
        const target = new URL(element.getAttribute('href') ?? '', url);
        return target.origin === url.origin ? target.pathname.match(/^\/en-ca\/niv\/schedule\/([0-9]+)\//)?.[1] : undefined;
      } catch { return undefined; }
    }).filter(Boolean));
    const ivrs = new Set(Array.from(scope.querySelectorAll('strong')).map(element => (element.textContent ?? '').trim()).filter(value => /^[0-9]{5,32}$/.test(value)));
    if (schedules.size > 1 || ivrs.size > 1) break;
    // A null-IVR binding proves the group by the unique schedule scope: the
    // exact-schedule Continue link (single, exact path) is the entry
    // evidence. A readable binding additionally requires its exact IVR.
    if (schedules.size === 1 && schedules.has(request.scheduleId) && (request.ivr === null || ivrs.has(request.ivr))) group = scope;
  }
  if (!group) return { ok: false };
  const tables = Array.from(group.querySelectorAll('table')).filter(table => table.querySelector(`a[href*="/applicants/"]`));
  if (tables.length !== 1) return { ok: false };
  const rows = Array.from(tables[0].querySelectorAll('tr')).filter(row => row.closest('table') === tables[0] && !row.closest('thead') && Array.from(row.children).some(cell => cell.tagName === 'TD'));
  const ids = rows.map(row => {
    const applicants = new Set(Array.from(row.querySelectorAll('a[href]')).map(element => {
      const target = new URL(element.getAttribute('href') ?? '', url);
      const matched = target.pathname.match(/^\/en-ca\/niv\/schedule\/([0-9]{1,32})\/applicants\/([0-9]{1,32})$/);
      if (!matched || (element.getAttribute('data-method') && element.getAttribute('data-method')?.toLowerCase() !== 'get')) return null;
      if (target.origin !== url.origin || target.username || target.password || target.port || target.hash || target.search || matched[1] !== request.scheduleId) return 'invalid';
      return matched[2];
    }).filter(value => value !== null));
    return applicants.size === 1 ? [...applicants][0] : 'invalid';
  });
  if (!validIds(ids) || ids.length !== request.applicantIds.length || !ids.every(id => request.applicantIds.includes(id))) return { ok: false };
  for (let element: HTMLElement | null = link; element; element = element.parentElement) {
    if (element.hidden || getComputedStyle(element).display === 'none' || getComputedStyle(element).visibility === 'hidden') return { ok: false };
  }
  const target = link.target || document.querySelector<HTMLBaseElement>('base[target]')?.target;
  if ((target && target.toLowerCase() !== '_self') || link.hasAttribute('download') || link.getAttribute('aria-disabled') === 'true' || link.hasAttribute('data-method')) return { ok: false };
  link.click();
  return { ok: true };
}
