// Read-only DOM readers for the website adapter. These functions run inside
// chrome.scripting.executeScript, so they must stay dependency-free: no
// imports, no closures, no chrome API calls. They return plain JSON only —
// never credentials, never full page text. Validation happens in the worker
// (src/domain/*), which rejects anything malformed before binding or storing.

export type DashboardPaymentStatus = 'paid' | 'unpaid' | 'unknown';

export type DashboardGroup = {
  scheduleId: string;
  ivr: string | null;
  paymentStatus: DashboardPaymentStatus;
  // Exact same-card trusted Continue path
  // (`/en-ca/niv/schedule/<id>/continue_actions`) when the card exposes one;
  // null otherwise. Never a parsed or derived href.
  continuePath: string | null;
  // Contradictory paid/unpaid markers on the same card: the card stays
  // unclassified and is never selectable.
  paymentConflict: boolean;
};

export function readDashboardGroups(): { groups: DashboardGroup[] } {
  const current = new URL(location.href);
  if (current.origin !== 'https://ais.usvisa-info.com' || current.username || current.password || current.port || current.hash || current.search ||
      !/^\/en-ca\/niv\/groups(?:\/[0-9]+)?$/.test(current.pathname)) throw new Error('Dashboard context changed.');
  const links = Array.from(
    document.querySelectorAll(
      '.application.card a[href], p.consular-appt [href], .ready_to_schedule p.delivery [href], ul.actions a[href*="continue_actions"]',
    ),
  );
  const groups: DashboardGroup[] = [];
  // Owning nodes for duplicate-schedule detection: repeated links inside one
  // outer card deduplicate, but the same schedule on two distinct cards
  // rejects even with identical IVR/status. Legacy links without an outer
  // card use their section/parent as the owner proxy. DOM nodes never leave
  // this function; only plain JSON is returned.
  const owners: (Element | null)[] = [];
  const boundOuters: Element[] = [];
  // Fully trusted same-origin link targets only: query, fragment and
  // authority-bearing URLs are never usable identifiers.
  const trustedPath = (value: string | null): string | null => {
    try {
      const url = new URL(value ?? '', 'https://ais.usvisa-info.com');
      if (url.origin !== 'https://ais.usvisa-info.com' || url.username || url.password || url.port || url.hash || url.search) return null;
      return url.pathname;
    } catch { return null; }
  };
  // Group-content scope: the outer application card minus nested .card
  // sections (delivery containers) and applicant tables. Ordinary plain-div
  // nesting remains supported.
  const inScope = (outer: Element, element: Element): boolean => {
    try {
      if (element.closest('.application.card') !== outer) return false;
      const card = element.closest('.card');
      if (card !== null && card !== outer) return false;
      if (element.closest('table') !== null) return false;
      return true;
    } catch { return false; }
  };
  for (const link of links) {
    const href = (link as HTMLAnchorElement).getAttribute('href') ?? '';
    let target: URL;
    try { target = new URL(href, 'https://ais.usvisa-info.com'); } catch { continue; }
    // Archived applications may expose only applicant Details links. Those
    // identify the enclosing card, but never authorize a booking by themselves.
    const matched = target.pathname.match(/^\/en-ca\/niv\/schedule\/([0-9]{1,32})\/(?:appointment|continue_actions|payment|addresses\/(?:delivery|consulate)|applicants\/[0-9]{1,32}(?:\/edit)?)$/);
    if (target.origin !== 'https://ais.usvisa-info.com' || target.username || target.password || target.port || target.hash || target.search || !matched) continue;
    const digits = matched[1];
    // The portal's outer application card is the group boundary. Schedule,
    // IVR, payment markers and status are scoped strictly to that same card;
    // sibling groups, inner delivery-card text, applicant strongs/links and
    // page wrappers are never borrowed. Legacy markup without an outer card
    // keeps bounded identity discovery, but only positive outer-card markers
    // authorize unpaid.
    const outer = (link as Element).closest('.application.card');
    // Nearest ancestor scope holding a bare-STRONG IVR. Every in-scope
    // STRONG is scanned for pure-digit runs of 5+ characters, so a label or
    // decoy STRONG cannot shadow the IVR; years, counts, and formatted
    // numbers cannot match. STRONGs inside nested .card sections or
    // applicant tables are decoys, never IVR evidence.
    let ivr: string | null = null;
    if (outer) {
      const schedules = new Set(Array.from(outer.querySelectorAll('a[href]')).map(element => {
        const path = trustedPath(element.getAttribute('href'));
        return path ? path.match(/^\/en-ca\/niv\/schedule\/([0-9]+)\//)?.[1] : undefined;
      }).filter(Boolean));
      if (schedules.size > 1) throw new Error('Ambiguous dashboard group.');
      if (schedules.size === 1 && !schedules.has(digits)) throw new Error('Ambiguous dashboard group.');
      const strongs = Array.from(outer.querySelectorAll('strong')).filter(element => inScope(outer, element));
      const identifiers = [...new Set(strongs.map(strong => (strong.textContent ?? '').trim()).filter(text => /^[0-9]{5,32}$/.test(text)))];
      if (identifiers.length > 1) throw new Error('Ambiguous dashboard group.');
      ivr = identifiers[0] ?? null;
    } else {
      let scope: Element | null = link;
      for (let depth = 0; depth < 8 && scope && ivr === null; depth += 1) {
        scope = scope.parentElement;
        if (scope) {
          const schedules = new Set(Array.from(scope.querySelectorAll('a[href]')).map(element => {
            const path = trustedPath(element.getAttribute('href'));
            return path ? path.match(/^\/en-ca\/niv\/schedule\/([0-9]+)\//)?.[1] : undefined;
          }).filter(Boolean));
          if (schedules.size > 1) break;
        }
        const strongs = scope ? Array.from(scope.querySelectorAll('strong')) : [];
        const identifiers = [...new Set(strongs.map(strong => (strong.textContent ?? '').trim()).filter(text => /^[0-9]{5,32}$/.test(text)))];
        if (identifiers.length > 1) break;
        ivr = identifiers[0] ?? null;
      }
    }
    // Contradictory paid/unpaid markers (including two different status
    // labels) classify as conflicting, never as a selectable unknown.
    let paymentConflict = false;
    const paymentStatus: DashboardPaymentStatus = (() => {
      // Dependency-free inline payment classification: this function is
      // serialized into the page, so no outside helpers or closures.
      if (!outer) return 'unknown' as const;
      // Unpaid requires BOTH the outer needs_payment marker and a normalized
      // group-scoped "Pay Visa Fee" status. The small "Current Status" label
      // is removed before comparing; inner delivery-card text, applicant
      // tables and nested application cards never count.
      const statusEls = Array.from(outer.querySelectorAll('h4.status')).filter(element => inScope(outer, element));
      const normalized = [...new Set(statusEls.map(element => {
        const clone = element.cloneNode(true) as Element;
        clone.querySelectorAll('small').forEach(node => node.remove());
        return ((clone.textContent ?? '').trim().replace(/\s+/g, ' '));
      }))];
      if (normalized.length > 1) { paymentConflict = true; return 'unknown' as const; }
      const payFee = (normalized[0] ?? '') === 'Pay Visa Fee';
      const needsPayment = outer.classList.contains('needs_payment');
      // A booked summary may sit inside a nested .card. Recognize its outer
      // attend_appointment marker only with the matching group-scoped status,
      // without loosening nested-card scoping for identity or other evidence.
      const bookedStatus = outer.classList.contains('attend_appointment') && normalized[0] === 'Attend Appointment';
      // Paid markers are group-scoped ready_to_schedule or booked appointment
      // evidence. Both paid and unpaid cards can carry continue_actions links,
      // so link shape alone is never evidence.
      const paidMarker = bookedStatus || outer.classList.contains('ready_to_schedule') ||
        Array.from(outer.querySelectorAll('.ready_to_schedule')).some(element => inScope(outer, element)) ||
        Array.from(outer.querySelectorAll('p.consular-appt')).some(element => inScope(outer, element));
      // Consistency: contradictory markers stay unknown even when the status
      // is missing or malformed, and a bare Pay Visa Fee status against paid
      // markers is contradictory even without the needs_payment class.
      if (needsPayment && paidMarker) { paymentConflict = true; return 'unknown' as const; }
      if (payFee && paidMarker) { paymentConflict = true; return 'unknown' as const; }
      const unpaidEvidence = needsPayment && payFee;
      if (unpaidEvidence && paidMarker) { paymentConflict = true; return 'unknown' as const; }
      if (unpaidEvidence) return 'unpaid' as const;
      if (paidMarker) return 'paid' as const;
      return 'unknown' as const;
    })();
    // The card's own trusted Continue entry, exact fixed literal only. A
    // continue-shaped href for another schedule, another origin, or with a
    // query/fragment is never entry evidence.
    let continuePath: string | null = null;
    if (outer && !paymentConflict) {
      const expectedContinue = `/en-ca/niv/schedule/${digits}/continue_actions`;
      const trustedContinue = Array.from(outer.querySelectorAll('a[href]')).some(element =>
        trustedPath(element.getAttribute('href')) === expectedContinue && inScope(outer, element));
      continuePath = trustedContinue ? expectedContinue : null;
    }
    const owner: Element | null = outer ?? (link as Element).closest('section') ?? (link as Element).parentElement;
    const existingIndex = groups.findIndex(group => group.scheduleId === digits);
    if (existingIndex >= 0) {
      // Repeated links inside one card deduplicate; the same schedule on a
      // distinct card rejects even with identical IVR/status.
      if (owners[existingIndex] !== owner) throw new Error('Ambiguous dashboard group.');
      const existing = groups[existingIndex];
      if (existing.ivr !== ivr || existing.continuePath !== continuePath) throw new Error('Ambiguous dashboard group.');
      // Contradictory paid/unpaid evidence across links degrades to unknown;
      // conflicting identities already reject above.
      if (existing.paymentStatus !== paymentStatus) { existing.paymentStatus = 'unknown'; existing.paymentConflict = true; }
      existing.paymentConflict ||= paymentConflict;
      continue;
    }
    groups.push({ scheduleId: digits, ivr, paymentStatus, continuePath, paymentConflict });
    owners.push(owner);
    if (outer && !boundOuters.includes(outer)) boundOuters.push(outer);
  }
  // Keep unreadable cards in their actual page positions. Selection validates
  // the chosen card without requiring every sibling to be readable; dropping
  // or appending an unreadable first card would select the wrong default.
  const entries = groups.map((group, index) => ({ group, owner: owners[index] }));
  for (const candidate of Array.from(document.querySelectorAll('.application.card'))) {
    if (!boundOuters.includes(candidate)) entries.push({ group: { scheduleId: '', ivr: null, paymentStatus: 'unknown', continuePath: null, paymentConflict: false }, owner: candidate });
  }
  entries.sort((a, b) => {
    if (!a.owner || !b.owner || a.owner === b.owner) return 0;
    const position = a.owner.compareDocumentPosition(b.owner);
    return position & 4 ? -1 : position & 2 ? 1 : 0;
  });
  return { groups: entries.map(entry => entry.group) };
}

export type SummaryRaw = {
  headingFound: boolean;
  rows: { city: string; text: string }[];
  maintenance?: boolean;
};

export function readSummaryRaw(scheduleId?: string): SummaryRaw {
  const trusted = () => {
    const current = new URL(location.href);
    return current.origin === 'https://ais.usvisa-info.com' && !current.username && !current.password && !current.port && !current.hash &&
      current.pathname === `/en-ca/niv/schedule/${scheduleId}/payment`;
  };
  if (scheduleId !== undefined && (!/^[0-9]{1,32}$/.test(scheduleId) || !trusted())) throw new Error('Summary context changed.');
  const heads = Array.from(document.querySelectorAll('h1, h2, h3, h4, caption'));
  const head = heads.find(element => (element.textContent ?? '').trim() === 'First Available Appointments');
  // A site maintenance page keeps the payment URL but drops the summary. Flag
  // it only when the heading is absent and the page says so: the flag triggers
  // one bounded reload, never an alert or a booking action.
  if (!head) {
    const bodyText = document.body?.innerText ?? document.body?.textContent ?? '';
    if (/maintenance/i.test(bodyText)) return { headingFound: false, rows: [], maintenance: true };
    return { headingFound: false, rows: [] };
  }
  let scope: Element | null = head;
  let table: Element | null = null;
  for (let depth = 0; depth < 4 && scope && !table; depth += 1) {
    scope = scope.parentElement;
    table = scope ? scope.querySelector('table') : null;
  }
  if (!table && head.nextElementSibling && head.nextElementSibling.tagName === 'TABLE') {
    table = head.nextElementSibling;
  }
  if (!table) return { headingFound: true, rows: [] };
  const rows = Array.from(table.querySelectorAll('tr')).map(row => {
    const cells = Array.from(row.querySelectorAll('td, th'));
    return {
      city: (cells[0]?.textContent ?? '').trim(),
      text: (cells[cells.length - 1]?.textContent ?? '').trim(),
    };
  });
  if (scheduleId !== undefined && !trusted()) throw new Error('Summary context changed.');
  return { headingFound: true, rows };
}

// Site-wide maintenance signal, usable on any page. Matches the maintenance
// document structurally (its heading and construction container) with a page
// phrase fallback for wording variants. Self-contained for page injection.
// Authentication uses a stricter outage-document check so a maintenance
// announcement on a normal sign-in form cannot defer credential handling.
// The flag never supplies availability or authorizes a booking action.
export function readSiteMaintenance(authenticationOnly = false): { maintenance: boolean } {
  if (authenticationOnly && document.querySelector('#sign_in_form')) return { maintenance: false };
  const heading = Array.from(document.querySelectorAll('h1')).some(
    element => (element.textContent ?? '').trim().toLowerCase() === 'doing maintenance',
  );
  if (heading || document.querySelector('.construction-background') !== null) return { maintenance: true };
  const bodyText = document.body?.innerText ?? document.body?.textContent ?? '';
  return { maintenance: authenticationOnly
    ? /(?:website is down for planned maintenance|nonimmigrant visa section is currently under maintenance)/i.test(bodyText)
    : /maintenance/i.test(bodyText) };
}

export type AppointmentFormRaw = {
  scheduleId: string | null;
  facilityId: number | null;
  date: string;
  time: string;
};
export function readAppointmentForm(): AppointmentFormRaw {  const path = location.pathname ?? '';
  const schedule = path.match(/^\/en-ca\/niv\/schedule\/([0-9]+)\//);
  const facility = document.getElementById('appointments_consulate_appointment_facility_id') as HTMLSelectElement | null;
  const date = document.getElementById('appointments_consulate_appointment_date') as HTMLInputElement | null;
  const time = document.getElementById('appointments_consulate_appointment_time') as HTMLSelectElement | null;
  return {
    scheduleId: schedule ? schedule[1] : null,
    facilityId: facility && facility.value !== '' ? Number(facility.value) : null,
    date: date?.value ?? '',
    time: time?.value ?? '',
  };
}

// Selected-group dashboard baseline and optional independent Details roster.
// Missing prose is uncertain; only an explicit unbooked marker yields null.
// The IVR echo is nullable: a null request (unreadable card) matches by
// schedule alone and never fabricates an identity.
export type CurrentAppointmentRaw =
  | { scheduleId: string; ivr: string | null; kind: 'booked' | 'unbooked'; text: string | null; applicantIds?: string[] }
  | { scheduleId: string; ivr: string | null; kind: 'read-failure'; text: null; status: number; redirected?: boolean; applicantIds?: never };

export async function readCurrentAppointment(scheduleId: string, ivr: string | null, fresh = false, includeApplicants = false, dashboardPath?: string, reportReadFailure = false): Promise<CurrentAppointmentRaw> {
  if (!/^[0-9]{1,32}$/.test(scheduleId) || (ivr !== null && !/^[0-9]{1,32}$/.test(ivr))) throw new Error('Invalid appointment identity.');
  if (dashboardPath !== undefined && !/^\/en-ca\/niv\/groups(?:\/[0-9]{1,32})?$/.test(dashboardPath)) throw new Error('Invalid dashboard path.');
  const trusted = (value: string) => {
    const url = new URL(value);
    if (url.origin !== 'https://ais.usvisa-info.com' || url.username || url.password || url.port || url.hash) return false;
    return fresh
      ? /^\/en-ca\/niv\/groups(?:\/[0-9]+)?$/.test(url.pathname) || url.pathname === `/en-ca/niv/schedule/${scheduleId}/appointment` || url.pathname === `/en-ca/niv/schedule/${scheduleId}/appointment/instructions` || url.pathname === `/en-ca/niv/schedule/${scheduleId}/continue_actions`
      : /^\/en-ca\/niv\/groups(?:\/[0-9]+)?$/.test(url.pathname);
  };
  if (!trusted(location.href)) throw new Error('Appointment context changed.');
  const currentHref = location.href;
  const currentPath = new URL(currentHref).pathname;
  const onDashboard = /^\/en-ca\/niv\/groups(?:\/[0-9]+)?$/.test(currentPath);
  if (onDashboard && dashboardPath !== undefined && dashboardPath !== currentPath) throw new Error('Dashboard context changed.');
  let root = document;
  if (fresh) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    let status = 0;
    let redirected = false;
    try {
      // Without a validated account path, start at the site root: it
      // redirects to the account dashboard when signed in, while the bare
      // dashboard route 403s. Only a same-origin dashboard landing is read.
      const entryRoot = dashboardPath === undefined && !onDashboard;
      const response = await fetch(`https://ais.usvisa-info.com${dashboardPath ?? (onDashboard ? currentPath : '/en-ca/niv/')}`, {
        credentials: 'same-origin', cache: 'no-store', redirect: entryRoot ? 'follow' : 'manual', signal: controller.signal,
      });
      // An expired session redirects the dashboard GET toward sign-in. With
      // redirect:manual the browser exposes that only as an opaqueredirect
      // (status 0, no Location, no target inference). Never follow it here;
      // the worker decides a fixed sign-in recovery from the typed flag.
      const responseType = (response as unknown as { type?: unknown }).type;
      if (!entryRoot && responseType === 'opaqueredirect') {
        status = 0;
        redirected = true;
        throw new Error('Dashboard read failed.');
      }
      status = response.status;
      if (response.status !== 200) throw new Error('Dashboard read failed.');
      if (entryRoot) {
        let finalPath: string;
        try {
          const final = new URL(typeof response.url === 'string' ? response.url : '');
          if (final.origin !== 'https://ais.usvisa-info.com') throw new Error('Dashboard read failed.');
          finalPath = final.pathname;
        } catch { throw new Error('Dashboard read failed.'); }
        if (!/^\/en-ca\/niv\/groups(?:\/[0-9]+)?$/.test(finalPath)) throw new Error('Dashboard read failed.');
      }
      const html = await response.text();
      if (!trusted(location.href) || location.href !== currentHref) throw new Error('Appointment context changed.');
      root = new DOMParser().parseFromString(html, 'text/html');
    } catch {
      // Chromium can resolve executeScript with result=null when an async
      // page function throws. Polling opts into a plain transport result so
      // failed GETs stay distinguishable from invalid returned roster data.
      // Context changes and all later group/roster parse failures still refuse.
      // An expired-session redirect is typed with redirected:true (status 0);
      // ordinary transport failures omit the flag and stay generic.
      if (!trusted(location.href) || location.href !== currentHref) throw new Error('Appointment context changed.');
      if (reportReadFailure === true) return { scheduleId, ivr, kind: 'read-failure', text: null, status: status === 200 ? 0 : status, ...(redirected ? { redirected: true as const } : {}) };
      throw new Error('Dashboard read failed.');
    } finally { clearTimeout(deadline); }
  }
  const identity = (link: Element): string | null => {
    try {
      const url = new URL(link.getAttribute('href') ?? '', 'https://ais.usvisa-info.com');
      const matched = url.pathname.match(/^\/en-ca\/niv\/schedule\/([0-9]{1,32})\/(?:appointment|continue_actions|payment|addresses\/(?:delivery|consulate)|applicants\/[0-9]{1,32}(?:\/edit)?)$/);
      return url.origin === 'https://ais.usvisa-info.com' && !url.username && !url.password && !url.port && !url.hash && matched ? matched[1] : null;
    } catch { return null; }
  };
  const links = Array.from(root.querySelectorAll('p.consular-appt a[href], .ready_to_schedule a[href], ul.actions a[href]')).filter(link => identity(link) === scheduleId);
  const scopes = new Set<Element>();
  for (const link of links) {
    // The portal's card is the group boundary. Do not let links at different
    // nesting depths resolve to different page wrappers, or borrow another
    // card's unbooked marker/roster. Older markup uses the bounded fallback.
    const card = link.closest('.application.card');
    let scope: Element | null = card ?? link.parentElement;
    let matchedScope: Element | null = null;
    for (let depth = 0; depth < 8 && scope; depth += 1, scope = scope.parentElement) {
      const groups = new Set(Array.from(scope.querySelectorAll('a[href]')).map(identity).filter(value => value !== null));
      const identifiers = new Set(Array.from(scope.querySelectorAll('strong')).map(element => (element.textContent ?? '').trim()).filter(value => /^[0-9]{5,32}$/.test(value)));
      if (groups.size > 1 || identifiers.size > 1) break;
      // A null-IVR request matches the unique schedule scope; the card
      // boundary still applies, and any readable identifier in scope is
      // never borrowed as identity for a readable request.
      if (groups.size === 1 && groups.has(scheduleId) && (ivr === null || identifiers.has(ivr))) matchedScope = scope;
      if (card) break;
    }
    if (matchedScope) scopes.add(matchedScope);
  }
  if (scopes.size !== 1) throw new Error('Ambiguous appointment group.');
  const scope = [...scopes][0];
  let applicantIds: string[] | undefined;
  if (includeApplicants) {
    const applicantIdentity = (link: Element) => {
      const target = new URL(link.getAttribute('href') ?? '', 'https://ais.usvisa-info.com');
      const matched = target.pathname.match(/^\/en-ca\/niv\/schedule\/([0-9]{1,32})\/applicants\/([0-9]{1,32})$/);
      if (!matched || (link.getAttribute('data-method') && link.getAttribute('data-method')?.toLowerCase() !== 'get')) return null;
      if (target.origin !== 'https://ais.usvisa-info.com' || target.username || target.password || target.port || target.hash || target.search || matched[1] !== scheduleId)
        throw new Error('Applicant identity changed.');
      return matched[2];
    };
    const tables = new Set<Element>();
    for (const link of Array.from(scope.querySelectorAll('a[href]'))) {
      if (applicantIdentity(link) !== null) {
        const table = link.closest('table');
        if (!table || !scope.contains(table)) throw new Error('Unknown applicant table.');
        tables.add(table);
      }
    }
    if (tables.size !== 1) throw new Error('Ambiguous applicant table.');
    const table = [...tables][0];
    const rows = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table && !row.closest('thead') && Array.from(row.children).some(cell => cell.tagName === 'TD'));
    applicantIds = rows.map(row => {
      const identifiers = new Set(Array.from(row.querySelectorAll('a[href]')).map(applicantIdentity).filter(value => value !== null));
      if (identifiers.size !== 1) throw new Error('Incomplete applicant roster.');
      return [...identifiers][0]!;
    });
    if (!applicantIds.length || applicantIds.length > 100 || new Set(applicantIds).size !== applicantIds.length) throw new Error('Invalid applicant roster.');
    applicantIds.sort();
  }
  const entries = Array.from(scope.querySelectorAll('p.consular-appt'));
  if (entries.length === 1) {
    const text = (entries[0].textContent ?? '').trim();
    if (!text) throw new Error('Missing appointment date.');
    return { scheduleId, ivr, kind: 'booked', text, ...(applicantIds ? { applicantIds } : {}) };
  }
  if (entries.length !== 0 || (!scope.matches('.ready_to_schedule') && !scope.querySelector('.ready_to_schedule'))) throw new Error('Unknown appointment state.');
  return { scheduleId, ivr, kind: 'unbooked', text: null, ...(applicantIds ? { applicantIds } : {}) };
}

// Applicant checkbox states for retain-all enforcement. Raw booleans only;
// the worker refuses to advance on any unchecked box.
export function readApplicantChecks(): { checked: boolean[] } {
  return { checked: Array.from(document.querySelectorAll('input[type="checkbox"]')).map(box => (box as HTMLInputElement).checked) };
}
