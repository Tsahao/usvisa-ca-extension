export type PaidAction = {
  action: 'reschedule' | 'schedule' | 'warning' | 'applicants' | 'facility' | 'date' | 'time';
  scheduleId: string;
  applicantIds?: string[];
  implicitApplicantId?: string;
  facilityId?: number;
  date?: string;
  time?: string;
  availableTimes?: string[];
};
export type ActResult = { ok: true; advanced?: boolean } | { ok: false; reason: string };

// One mutation per call (gateway expansion may require another
// alarm). No imported/module helpers: Chrome serializes this function alone.
// There is deliberately no appointment-submit or confirmation action.
export async function performPaidAction(request: PaidAction): Promise<ActResult> {
  const refuse = (reason: string): ActResult => ({ ok: false, reason });
  const url = new URL(location.href);
  const base = `/en-ca/niv/schedule/${request.scheduleId}`;
  if (!/^[0-9]{1,32}$/.test(request.scheduleId) || url.origin !== 'https://ais.usvisa-info.com' ||
      url.username || url.password || url.port || url.hash) return refuse('wrong-route');
  const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length > 0 && ids.length <= 100 &&
    ids.every(id => typeof id === 'string' && /^[0-9]{1,32}$/.test(id)) && new Set(ids).size === ids.length;
  const sameIds = (ids: string[]) => validIds(ids) && validIds(request.applicantIds) &&
    ids.length === request.applicantIds.length && ids.every(id => request.applicantIds!.includes(id));
  const visible = (el: HTMLElement) => {
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      if (node.hidden || getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') return false;
    }
    return true;
  };
  // Normalized copy matching: collapse whitespace and ignore case, then
  // require an exact match. "Schedule Appointment" is the first-time
  // continue_actions gateway copy (it replaces "Reschedule Appointment"
  // there); warning/applicant GET forms still advance via "Continue" only.
  const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const validTarget = (target: string) => {
    try {
      const next = new URL(target, url);
      return next.origin === url.origin && !next.username && !next.password && !next.port && !next.hash &&
        ([`${base}/appointment`, `${base}/continue_actions`].includes(next.pathname) ||
          (request.action === 'schedule' && next.pathname === `${base}/continue` && !next.search));
    } catch { return false; }
  };
  // These controls may navigate with GET, never mutate an appointment. Check
  // both the form and effective submitter overrides before any gateway click.
  const safeNavigation = (el: HTMLElement): boolean => {
    if (el.hasAttribute('data-method') || el.hasAttribute('formmethod') || el.hasAttribute('formaction') ||
        el.hasAttribute('formtarget') || el.hasAttribute('download')) return false;
    const form = (el as HTMLButtonElement).form;
    if (form && (form.method.toLowerCase() !== 'get' || !validTarget(form.getAttribute('action') ?? '') ||
        form.querySelector('input[name="_method"]') || (form.target && form.target.toLowerCase() !== '_self'))) return false;
    const target = el instanceof HTMLAnchorElement ? el.target : '';
    const inherited = document.querySelector<HTMLBaseElement>('base[target]')?.target;
    return ![target, inherited].some(value => value && value.toLowerCase() !== '_self');
  };
  const click = (el: HTMLElement | undefined): ActResult => {
    if (!el || el.id === 'appointments_submit' || !visible(el) || ('disabled' in el && el.disabled)) return refuse('control-missing');
    if (!safeNavigation(el)) return refuse('wrong-target');
    // Never navigate arbitrary hrefs or submit a form to another origin/group.
    const target = el instanceof HTMLAnchorElement ? el.href : el.getAttribute('formaction') ??
      (el as HTMLButtonElement).form?.getAttribute('action');
    if (target && !validTarget(target)) return refuse('wrong-target');
    const form = (el as HTMLButtonElement).form;
    if ((request.action === 'warning' || request.action === 'applicants') && form &&
        (form.method.toLowerCase() !== 'get' || !validTarget(form.getAttribute('action') ?? ''))) return refuse('wrong-target');
    el.click();
    return { ok: true, advanced: true };
  };
  if (request.action === 'reschedule' || request.action === 'schedule') {
    if (url.pathname !== `${base}/continue_actions` || url.search) return refuse('wrong-stage');
    const all = Array.from(document.querySelectorAll<HTMLElement>('button, a, input[type="submit"]'));
    const labelOf = (el: HTMLElement) => norm(el instanceof HTMLInputElement ? el.value : el.textContent);
    const isGatewayEntryTarget = (el: HTMLElement) => {
      const target = el instanceof HTMLAnchorElement ? el.getAttribute('href') : el.getAttribute('formaction') ?? (el as HTMLButtonElement).form?.getAttribute('action');
      if (!target) return false;
      try {
        const next = new URL(target, url);
        return next.origin === url.origin && !next.username && !next.password && !next.port && !next.hash && !next.search &&
          (next.pathname === `${base}/appointment` ||
            (request.action === 'schedule' && el instanceof HTMLAnchorElement && next.pathname === `${base}/continue`));
      } catch { return false; }
    };
    let toggle: HTMLElement | undefined;
    let entries: HTMLElement[];
    if (request.action === 'reschedule') {
      // Reschedule gateway only: exact Reschedule copy for both the
      // accordion toggle and its entry. Any Schedule copy on the page means
      // the wrong (first-time) gateway, so refuse.
      const toggles = all.filter(el => el.hasAttribute('aria-expanded') && labelOf(el) === 'reschedule appointment');
      if (toggles.length !== 1) return refuse('control-missing');
      toggle = toggles[0];
      entries = all.filter(el => el !== toggle && labelOf(el) === 'reschedule appointment');
      if (entries.length !== 1 || !isGatewayEntryTarget(entries[0])) return refuse('control-missing');
      if (all.some(el => el !== toggle && el !== entries[0] && labelOf(el) === 'schedule appointment')) return refuse('control-missing');
      // Cancellation uses the same appointment URL with data-method=delete.
      // Only eligible GET navigation controls compete with the chosen entry;
      // the selected entry itself must still pass safeNavigation below.
      const allAppointment = all.filter(el => el !== toggle && isGatewayEntryTarget(el) && safeNavigation(el));
      if (allAppointment.length !== 1) return refuse('control-missing');
    } else {
      // First-time gateway only: exact Schedule Appointment copy for both
      // the accordion toggle and its entry, plus href validation of the
      // entry to .../schedule/<id>/continue (observed initial entry) or
      // /appointment. /continue is allowed only for this initial-entry link;
      // subsequent pages must still pass the existing form/roster guards.
      // Any Reschedule copy means
      // the wrong gateway, so refuse. Labels such as "Schedule Appointment
      // Now" or "Continue" never exactly match and refuse.
      const toggles = all.filter(el => el.hasAttribute('aria-expanded') && labelOf(el) === 'schedule appointment');
      if (toggles.length !== 1) return refuse('control-missing');
      toggle = toggles[0];
      entries = all.filter(el => el !== toggle && labelOf(el) === 'schedule appointment' && isGatewayEntryTarget(el));
      if (entries.length !== 1) return refuse('control-missing');
      if ((entries[0] as HTMLButtonElement).form && (entries[0] as HTMLButtonElement).form!.method.toLowerCase() !== 'get') return refuse('wrong-target');
      if (all.some(el => labelOf(el) === 'reschedule appointment')) return refuse('control-missing');
      const allAppointment = all.filter(el => el !== toggle && isGatewayEntryTarget(el) && safeNavigation(el));
      if (allAppointment.length !== 1) return refuse('control-missing');
    }
    if (entries.length !== 1 || !safeNavigation(entries[0])) return refuse('wrong-target');
    if (!toggle) return click(entries[0]);
    if (toggle.getAttribute('aria-expanded') !== 'true') {
      // Accordion links have fragment targets, not navigation destinations.
      const href = toggle.getAttribute('href');
      if (toggle instanceof HTMLAnchorElement && href && !href.startsWith('#')) return refuse('wrong-target');
      if (toggle instanceof HTMLButtonElement && toggle.type !== 'button') return refuse('wrong-target');
      if (!safeNavigation(toggle) || !visible(toggle)) return refuse('control-missing');
      toggle.click();
      return { ok: true, advanced: false };
    }
    const visibleEntries = entries.filter(visible);
    return visibleEntries.length === 1 ? click(visibleEntries[0]) : refuse('control-missing');
  }
  if (url.pathname !== `${base}/appointment`) return refuse('wrong-stage');
  const continueControl = () => {
    // Warning/applicant GET forms advance via Continue only. "Schedule
    // Appointment" (and "Reschedule Appointment") live in the
    // continue_actions gateway, never on these pages, so any such copy
    // here refuses even alongside a Continue control.
    const gated = Array.from(document.querySelectorAll<HTMLElement>('button, input[type="submit"]'));
    const gatedLabel = (el: HTMLElement) => norm(el instanceof HTMLInputElement ? el.value : el.textContent);
    if (gated.some(el => gatedLabel(el) === 'schedule appointment' || gatedLabel(el) === 'reschedule appointment')) return undefined;
    const controls = gated.filter(el => gatedLabel(el) === 'continue' && visible(el));
    return controls.length === 1 && safeNavigation(controls[0]) ? controls[0] : undefined;
  };
  const next = () => click(continueControl());
  if (request.action === 'warning') {
    if (document.getElementById('appointments_submit')) return refuse('wrong-stage');
    if (url.search) return refuse('wrong-stage');
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter(box =>
      (box.id === 'confirmed_limit_message' && box.name === 'confirmed_limit_message' && box.value === '1') ||
      /i understand/i.test([box.getAttribute('aria-label'), ...Array.from(box.labels ?? []).map(label => label.textContent)].join(' ')));
    if (boxes.length !== 1 || boxes[0].disabled) return refuse('control-missing');
    if (!continueControl() || !safeNavigation(boxes[0])) return refuse('wrong-target');
    if (boxes[0].form && (boxes[0].form.method.toLowerCase() !== 'get' || !validTarget(boxes[0].form.getAttribute('action') ?? ''))) return refuse('wrong-target');
    if (!boxes[0].checked) { boxes[0].click(); return { ok: true, advanced: false }; }
    return next();
  }
  if (request.action === 'applicants') {
    if (document.getElementById('appointments_submit')) return refuse('wrong-stage');
    if (url.searchParams.get('confirmed_limit_message') !== '1' || url.searchParams.has('applicants[]')) return refuse('wrong-stage');
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="applicants[]"][type="checkbox"]'));
    if (!sameIds(boxes.map(box => box.value)) || boxes.some(box => !box.checked || box.disabled)) return refuse('applicants-mismatch');
    return next();
  }
  let formIds = url.searchParams.getAll('applicants[]');
  if (!url.search && request.implicitApplicantId && /^[0-9]{1,32}$/.test(request.implicitApplicantId) &&
      sameIds([request.implicitApplicantId]) && !document.querySelector('[name="applicants[]"]')) {
    const forms = document.querySelectorAll<HTMLFormElement>('#appointment-form');
    if (forms.length !== 1) return refuse('form-missing');
    const form = forms[0];
    const target = new URL(form.getAttribute('action') ?? '', url);
    if (form.method.toLowerCase() !== 'post' || target.origin !== url.origin || target.username || target.password || target.port || target.hash ||
        target.search || target.pathname !== `${base}/appointment` ||
        ['appointments_consulate_appointment_facility_id', 'appointments_consulate_appointment_date', 'appointments_consulate_appointment_time'].some(id => {
          const fields = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`#${id}`);
          return fields.length !== 1 || fields[0].form !== form;
        })) return refuse('form-missing');
    formIds = [request.implicitApplicantId];
  }
  if (!sameIds(formIds)) return refuse('applicants-mismatch');
  const facility = document.getElementById('appointments_consulate_appointment_facility_id') as HTMLSelectElement | null;
  const date = document.getElementById('appointments_consulate_appointment_date') as HTMLInputElement | null;
  const time = document.getElementById('appointments_consulate_appointment_time') as HTMLSelectElement | null;
  if (!facility || !date || !time) return refuse('form-missing');
  if (request.action === 'facility') {
    if (facility.disabled) return refuse('control-disabled');
    if (!Number.isInteger(request.facilityId) || !request.date || !/^\d{4}-\d{2}-\d{2}$/.test(request.date) ||
        !Number.isFinite(Date.parse(request.date)) || new Date(request.date).toISOString().slice(0, 10) !== request.date) return refuse('bad-slot');
    const value = String(request.facilityId);
    if (!Array.from(facility.options).some(option => option.value === value && !option.disabled)) return refuse('facility-missing');
    // Run in MAIN to observe the portal's own change-triggered days request.
    // Its success callback updates the private business-day list before
    // ajaxComplete. Merely seeing the select's new value is not readiness.
    type Ajax = { status: number; responseJSON?: unknown };
    type Settings = { url?: string; type?: string; method?: string };
    type Events = { on: (event: string, handler: (event: unknown, xhr: Ajax, settings: Settings) => void) => void;
      off: (event: string, handler: (event: unknown, xhr: Ajax, settings: Settings) => void) => void };
    const jq = (window as unknown as { jQuery?: (node: Document) => Events }).jQuery;
    if (typeof jq !== 'function') return refuse('calendar-missing');
    return new Promise<ActResult>(resolve => {
      const events = jq(document);
      let settled = false;
      let dispatching = false;
      let ownedRequest: Ajax | null = null;
      const matches = (settings: Settings) => {
        let target: URL;
        try { target = new URL(settings.url ?? '', url); } catch { return false; }
        return target.origin === url.origin && !target.username && !target.password && !target.port && !target.hash &&
          target.pathname === `${base}/appointment/days/${request.facilityId}.json` &&
          target.searchParams.get('appointments[expedite]') === 'false' &&
          Array.from(target.searchParams.keys()).join(',') === 'appointments[expedite]' &&
          settings.type?.toUpperCase() === 'GET' && (settings.method === undefined || settings.method.toUpperCase() === 'GET');
      };
      const finish = (result: ActResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        events.off('ajaxSend.usvisaFacility', sent);
        events.off('ajaxComplete.usvisaFacility', completed);
        resolve(result);
      };
      const sent = (_event: unknown, xhr: Ajax, settings: Settings) => {
        if (!dispatching || !matches(settings)) return;
        if (ownedRequest !== null) return finish(refuse('facility-load-ambiguous'));
        ownedRequest = xhr;
      };
      const completed = (_event: unknown, xhr: Ajax, settings: Settings) => {
        if (ownedRequest !== xhr || !matches(settings)) return;
        if (xhr.status !== 200 || location.href !== url.href ||
            ['appointments_consulate_appointment_facility_id', 'appointments_consulate_appointment_date', 'appointments_consulate_appointment_time']
              .some(id => document.querySelectorAll(`[id="${id}"]`).length !== 1) ||
            document.getElementById(facility.id) !== facility || document.getElementById(date.id) !== date || document.getElementById(time.id) !== time ||
            facility.disabled || date.disabled || time.disabled || facility.value !== value || date.value !== '' || time.value !== '') return finish(refuse('facility-load-failed'));
        const days = xhr.responseJSON;
        const validDay = (day: unknown): day is { date: string; business_day: boolean } => {
          if (!day || typeof day !== 'object') return false;
          const item = day as { date?: unknown; business_day?: unknown };
          return typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Number.isFinite(Date.parse(item.date)) &&
            new Date(item.date).toISOString().slice(0, 10) === item.date && typeof item.business_day === 'boolean';
        };
        if (!Array.isArray(days) || days.length > 3660 || !days.every(validDay) ||
            new Set(days.map(day => day.date)).size !== days.length) return finish(refuse('facility-load-failed'));
        if (!days.some(day => day.date === request.date && day.business_day)) return finish(refuse('facility-date-unavailable'));
        return finish({ ok: true });
      };
      const timer = setTimeout(() => finish(refuse('facility-load-timeout')), 15_000);
      try {
        events.on('ajaxSend.usvisaFacility', sent);
        events.on('ajaxComplete.usvisaFacility', completed);
        date.removeAttribute('data-usvisa-calendar-slot');
        facility.value = value;
        dispatching = true;
        facility.dispatchEvent(new Event('change', { bubbles: true }));
        dispatching = false;
      } catch { finish(refuse('facility-load-failed')); }
    });
  } else if (request.action === 'date') {
    if (date.disabled) return refuse('control-disabled');
    if (Number(facility.value) !== request.facilityId || !request.date || !/^\d{4}-\d{2}-\d{2}$/.test(request.date) ||
        !Number.isFinite(Date.parse(request.date)) || new Date(request.date).toISOString().slice(0, 10) !== request.date) return refuse('bad-slot');
    // Calendar actions run in MAIN. A native date change event does not run
    // jQuery UI's onSelect: only the portal callback populates its private
    // business-time list as well as the visible options. setDate alone also
    // does not invoke onSelect. Never write the portal's private cache.
    type Ajax = { status: number; responseJSON?: unknown };
    type JQueryNode = {
      datepicker: (command: string, value: string) => unknown;
      data: (key: string) => unknown;
      on: (event: string, handler: (event: unknown, xhr: Ajax, settings: { url?: string }) => void) => void;
      off: (event: string, handler: (event: unknown, xhr: Ajax, settings: { url?: string }) => void) => void;
    };
    const jq = (window as unknown as { jQuery?: (node: Element | Document) => JQueryNode }).jQuery;
    if (typeof jq !== 'function' || !Number.isInteger(request.facilityId)) return refuse('calendar-missing');
    let picker: JQueryNode;
    let callback: unknown;
    let instance: unknown;
    try {
      picker = jq(date);
      callback = picker.datepicker('option', 'onSelect');
      instance = picker.data('datepicker');
    } catch { return refuse('calendar-missing'); }
    if (typeof callback !== 'function' || !instance || typeof instance !== 'object') return refuse('calendar-missing');
    const sameContext = () => location.href === url.href &&
      document.querySelectorAll('#appointments_consulate_appointment_facility_id').length === 1 &&
      document.querySelectorAll('#appointments_consulate_appointment_date').length === 1 &&
      document.querySelectorAll('#appointments_consulate_appointment_time').length === 1 &&
      document.getElementById(facility.id) === facility && document.getElementById(date.id) === date &&
      document.getElementById(time.id) === time && !facility.disabled && !date.disabled && !time.disabled &&
      Number(facility.value) === request.facilityId && date.value === request.date;
    date.removeAttribute('data-usvisa-calendar-slot');
    return new Promise<ActResult>(resolve => {
      const events = jq(document);
      let settled = false;
      const finish = (result: ActResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        events.off('ajaxComplete.usvisaCalendar', completed);
        resolve(result);
      };
      const completed = (_event: unknown, xhr: Ajax, settings: { url?: string }) => {
        let target: URL;
        try { target = new URL(settings.url ?? '', url); } catch { return; }
        if (target.origin !== url.origin || target.username || target.password || target.port || target.hash ||
            target.pathname !== `${base}/appointment/times/${request.facilityId}.json` ||
            target.searchParams.get('date') !== request.date || target.searchParams.get('appointments[expedite]') !== 'false' ||
            Array.from(target.searchParams.keys()).sort().join(',') !== 'appointments[expedite],date') return;
        if (xhr.status !== 200 || !sameContext()) return finish(refuse('calendar-load-failed'));
        const body = xhr.responseJSON as { available_times?: unknown; business_times?: unknown } | null;
        const validTimes = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1440 &&
          value.every(item => typeof item === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item)) && new Set(value).size === value.length;
        if (!body || !validTimes(body.available_times) || !validTimes(body.business_times)) return finish(refuse('calendar-load-failed'));
        const available = body.available_times;
        const options = Array.from(time.options).filter(option => option.value !== '');
        if (options.length !== available.length || new Set(options.map(option => option.value)).size !== options.length ||
            options.some(option => option.disabled || !available.includes(option.value))) {
          return finish(refuse('calendar-load-failed'));
        }
        // DOM evidence is tied to this document and field pair; a reload
        // drops it. Existing equal dates must still pass through onSelect.
        date.setAttribute('data-usvisa-calendar-slot', `${request.facilityId}|${request.date}`);
        finish({ ok: true });
      };
      const timer = setTimeout(() => finish(refuse('calendar-load-timeout')), 15_000);
      try {
        events.on('ajaxComplete.usvisaCalendar', completed);
        picker.datepicker('setDate', request.date!);
        if (!sameContext()) return finish(refuse('calendar-context-changed'));
        callback.call(date, request.date, instance);
      } catch { finish(refuse('calendar-load-failed')); }
    });
  } else if (request.action === 'time') {
    if (time.disabled) return refuse('control-disabled');
    if (Number(facility.value) !== request.facilityId || date.value !== request.date ||
        date.getAttribute('data-usvisa-calendar-slot') !== `${request.facilityId}|${request.date}` ||
        !request.time || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(request.time)) return refuse('bad-slot');
    // Only select an option loaded by the portal. Inserting an option does
    // not populate its private business-time validation state.
    if (!Array.from(time.options).some(option => option.value === request.time && !option.disabled)) return refuse('bad-slot');
    time.value = request.time;
    time.dispatchEvent(new Event('change', { bubbles: true }));
  } else return refuse('wrong-action');
  return { ok: true };
}
