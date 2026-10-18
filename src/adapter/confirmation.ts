export type SubmissionRequest = {
  action: 'acknowledge' | 'submit' | 'confirm'; scheduleId: string; applicantIds: string[];
  implicitApplicantId?: string;
  facilityId: number; date: string; time: string; earliest: string; latest: string;
  currentDate: string | null; currentDateTag: 'unbooked' | 'booked'; onlyEarlier: boolean; testMode: boolean;
};

// Serialized read-only readiness wait. Never click inside an asynchronous
// observer: the worker must reread settings/baseline and commit its mutation
// checkpoint after this returns, then the final adapter rechecks actual DOM.
export async function waitForAppointmentDialog(request: SubmissionRequest, timeoutMs: number): Promise<{ ok: boolean }> {
  if (!request || request.action !== 'confirm' || request.testMode !== false ||
      !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 15_000 || !/^[0-9]{1,32}$/.test(request.scheduleId)) return { ok: false };
  const url = new URL(location.href);
  const base = `/en-ca/niv/schedule/${request.scheduleId}/appointment`;
  if (url.origin !== 'https://ais.usvisa-info.com' || url.username || url.password || url.port || url.hash || url.pathname !== base) return { ok: false };
  const forms = document.querySelectorAll<HTMLFormElement>('#appointment-form');
  const submits = document.querySelectorAll<HTMLInputElement>('#appointments_submit');
  if (forms.length !== 1 || submits.length !== 1) return { ok: false };
  const form = forms[0];
  const submit = submits[0];
  const target = new URL(form.getAttribute('action') ?? '', url);
  if (form.method.toLowerCase() !== 'post' || target.origin !== url.origin || target.username || target.password || target.port || target.hash ||
      target.pathname !== base || submit.form !== form || submit.type !== 'submit') return { ok: false };
  const rawGate = submit.getAttribute('data-confirm');
  let title: string;
  let label: string;
  try {
    const gate = JSON.parse(rawGate ?? 'null');
    if (!gate || typeof gate.title !== 'string' || typeof gate.ok !== 'string' || !gate.ok.trim() ||
        typeof gate.cancel !== 'string' || !gate.cancel.trim()) return { ok: false };
    title = new DOMParser().parseFromString(gate.title, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    label = gate.ok.trim();
    if (!title) return { ok: false };
  } catch { return { ok: false }; }
  const visible = (element: Element) => {
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.hasAttribute('hidden') || ancestor.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const inspect = (): 'ready' | 'wait' | 'unsafe' => {
    if (location.href !== url.href || document.querySelectorAll('#appointment-form').length !== 1 || document.getElementById('appointment-form') !== form ||
        document.querySelectorAll('#appointments_submit').length !== 1 || document.getElementById('appointments_submit') !== submit ||
        submit.getAttribute('data-confirm') !== rawGate) return 'unsafe';
    for (const [id, expected] of [
      ['appointments_consulate_appointment_facility_id', String(request.facilityId)],
      ['appointments_consulate_appointment_date', request.date], ['appointments_consulate_appointment_time', request.time],
    ]) {
      const fields = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`#${id}`);
      if (fields.length !== 1 || fields[0].form !== form || fields[0].disabled || fields[0].value !== expected) return 'unsafe';
    }
    if (document.getElementById('appointments_consulate_appointment_date')?.getAttribute('data-usvisa-calendar-slot') !== `${request.facilityId}|${request.date}` ||
        Array.from(document.querySelectorAll('#non-consulate-business-day-message, #non-consulate-business-time-message')).some(visible)) return 'unsafe';
    const dialogs = Array.from(document.querySelectorAll('.reveal-overlay [data-reveal]')).filter(visible);
    if (!dialogs.length) return 'wait';
    if (dialogs.length !== 1 || !dialogs[0].textContent?.replace(/\s+/g, ' ').includes(title)) return 'unsafe';
    const buttons = dialogs[0].querySelectorAll<HTMLElement>('.button.alert');
    if (buttons.length !== 1 || buttons[0].textContent?.trim() !== label || buttons[0].hasAttribute('data-method')) return 'unsafe';
    const button = buttons[0];
    if (button instanceof HTMLAnchorElement) {
      const href = button.getAttribute('href');
      if (href !== null && href !== '' && href !== '#') return 'unsafe';
    } else if (!(button instanceof HTMLButtonElement) || button.form || button.type === 'submit') return 'unsafe';
    return !visible(button) || button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled') ? 'wait' : 'ready';
  };
  const initial = inspect();
  if (initial !== 'wait' || timeoutMs === 0) return { ok: initial === 'ready' };
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      observer.disconnect(); clearTimeout(timer); clearInterval(poll); resolve({ ok });
    };
    const check = () => { const result = inspect(); if (result !== 'wait') finish(result === 'ready'); };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(false), timeoutMs);
    // Also recheck property-only field changes and computed visibility.
    const poll = setInterval(check, 100);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    check();
  });
}

export function performAppointmentSubmission(request: SubmissionRequest): { ok: boolean } {
  // Baseline must be explicit via a transport-safe tag: 'unbooked' means
  // positively unbooked, 'booked' requires a valid ISO string. Measured
  // packaged transport drops null-valued object keys (see
  // tests/browser/booking-direct.spec.ts null-baseline probe: {currentDate:
  // null} arrives without the key), so the tag — a non-null string that
  // survives — carries the meaning while currentDate carries the value.
  // Missing/undefined alone never becomes unbooked: tag 'booked' with a
  // missing/malformed date refuses, tag 'unbooked' with a date refuses, and
  // a missing/invalid tag refuses. Only tag 'unbooked' with null/missing
  // (direct null or transported drop) is unbooked.
  if (!request || typeof request !== 'object' || (request.currentDateTag !== 'unbooked' && request.currentDateTag !== 'booked')) return { ok: false };
  const rawBaseline: unknown = (request as Record<string, unknown>).currentDate;
  let currentDate: string | null;
  if (request.currentDateTag === 'unbooked') {
    if (rawBaseline !== null && rawBaseline !== undefined) return { ok: false };
    currentDate = null;
  } else {
    if (typeof rawBaseline !== 'string') return { ok: false };
    currentDate = rawBaseline;
  }
  const current = new URL(location.href);
  const base = `/en-ca/niv/schedule/${request.scheduleId}/appointment`;
  if (!/^[0-9]{1,32}$/.test(request.scheduleId) || current.origin !== 'https://ais.usvisa-info.com' ||
      current.username || current.password || current.port || current.hash || current.pathname !== base) return { ok: false };
  const validIds = (ids: string[]) => Array.isArray(ids) && ids.length > 0 && ids.length <= 100 &&
    ids.every(id => typeof id === 'string' && /^[0-9]{1,32}$/.test(id)) && new Set(ids).size === ids.length;
  let actualIds = current.searchParams.getAll('applicants[]');
  let implicitRoster = false;
  if (!current.search && request.implicitApplicantId &&
      validIds(request.applicantIds) && request.applicantIds.length === 1 && request.applicantIds[0] === request.implicitApplicantId &&
      !document.querySelector('[name="applicants[]"]')) {
    actualIds = [request.implicitApplicantId];
    implicitRoster = true;
  }
  if (!validIds(request.applicantIds) || !validIds(actualIds) ||
      [...actualIds].sort().join(',') !== [...request.applicantIds].sort().join(',')) return { ok: false };
  const iso = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!iso(request.date) || !iso(request.earliest) || !iso(request.latest) || request.earliest > request.latest ||
      request.date < request.earliest || request.date > request.latest ||
      (currentDate !== null && (typeof currentDate !== 'string' || !iso(currentDate) || (request.onlyEarlier && request.date >= currentDate))) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(request.time) || ![89, 90, 91, 92, 93, 94, 95].includes(request.facilityId)) return { ok: false };
  const forms = document.querySelectorAll<HTMLFormElement>('#appointment-form');
  const submits = document.querySelectorAll<HTMLInputElement>('#appointments_submit');
  if (forms.length !== 1 || submits.length !== 1) return { ok: false };
  const form = forms[0];
  const submit = submits[0];
  const target = new URL(form.getAttribute('action') ?? '', current.href);
  if (form.method.toLowerCase() !== 'post' || target.origin !== current.origin || target.username || target.password || target.port || target.hash ||
      (implicitRoster && target.search) ||
      target.pathname !== base || submit.form !== form || submit.disabled || submit.getAttribute('aria-disabled') === 'true' ||
      submit.hasAttribute('formaction') || submit.hasAttribute('formmethod') || submit.type !== 'submit') return { ok: false };
  const targetIds = target.searchParams.getAll('applicants[]');
  const bodyIds = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="applicants[]"]')).filter(input => input.type !== 'checkbox' || input.checked).map(input => input.disabled ? '' : input.value);
  for (const ids of [targetIds, bodyIds]) {
    if (ids.length && (!validIds(ids) || [...ids].sort().join(',') !== [...request.applicantIds].sort().join(','))) return { ok: false };
  }
  const field = (id: string) => {
    const matches = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    return matches.length === 1 && matches[0].form === form && !matches[0].disabled ? matches[0].value : null;
  };
  if (field('appointments_consulate_appointment_facility_id') !== String(request.facilityId) ||
      field('appointments_consulate_appointment_date') !== request.date || field('appointments_consulate_appointment_time') !== request.time ||
      document.getElementById('appointments_consulate_appointment_date')?.getAttribute('data-usvisa-calendar-slot') !== `${request.facilityId}|${request.date}`) return { ok: false };
  const warnings = form.querySelectorAll<HTMLInputElement>('input[name="confirmed_limit_message"]');
  if (warnings.length > 1 || (request.action !== 'acknowledge' && warnings.length === 1 && (warnings[0].disabled ||
      !(warnings[0].type === 'checkbox' ? warnings[0].checked : warnings[0].type === 'hidden' && warnings[0].value === '1')))) return { ok: false };
  let label: string | null = null;
  let title: string | null = null;
  let gateValid = false;
  const rawGate = submit.getAttribute('data-confirm');
  if (rawGate !== null) {
    try {
      const gate = JSON.parse(rawGate);
      if (gate && typeof gate.title === 'string' && gate.title.trim().length > 0 &&
          typeof gate.ok === 'string' && gate.ok.trim().length > 0 &&
          typeof gate.cancel === 'string' && gate.cancel.trim().length > 0) {
        const parsed = new DOMParser().parseFromString(gate.title, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        if (parsed) { gateValid = true; label = gate.ok.trim(); title = parsed; }
      }
      // A present-but-malformed gate (bad JSON, null, empty/whitespace
      // title, missing/empty ok/cancel, or title that parses to empty)
      // refuses the submit click below: only a fully absent gate permits
      // direct submission (user authorization October 15, 2026 for the
      // no-gate case only). Confirmation always requires a valid gate plus
      // a matching dialog and never blindly confirms an unknown dialog.
    } catch { /* Present-but-malformed gate: refused as a direct submit below. */ }
  }
  const visible = (element: Element) => {
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.hasAttribute('hidden') || ancestor.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  if (Array.from(document.querySelectorAll('#non-consulate-business-day-message, #non-consulate-business-time-message')).some(visible)) return { ok: false };
  const dialogs = Array.from(document.querySelectorAll('.reveal-overlay [data-reveal]')).filter(visible);
  if (request.action === 'acknowledge') {
    if (dialogs.length !== 0 || warnings.length !== 1 || warnings[0].type !== 'checkbox' || warnings[0].id !== 'confirmed_limit_message' ||
        warnings[0].value !== '1' || warnings[0].disabled || warnings[0].checked) return { ok: false };
    warnings[0].click();
    return { ok: warnings[0].checked };
  }
  if (request.action === 'submit') {
    // Auto Mode OFF never clicks the final Schedule/Reschedule submit or
    // opens the portal confirmation dialog, with or without a gate. Live
    // submission (Auto Mode explicitly ON, legacy testMode=false) clicks only
    // with a valid gate (recognized two-step dialog flow, native POST
    // blocked) or with a fully absent gate (direct submission, native POST
    // allowed; user authorization October 15, 2026 for the no-gate case
    // only). A present-but-malformed gate refuses without clicking. Either
    // click can finalize booking, so the worker persists intent plus a
    // mutation checkpoint before this call.
    if (request.testMode !== false) return { ok: false };
    if (dialogs.length !== 0) return { ok: false };
    if (gateValid) {
      const blockNativePost = (event: Event) => { event.preventDefault(); };
      form.addEventListener('submit', blockNativePost, { capture: true });
      try { submit.click(); } finally { form.removeEventListener('submit', blockNativePost, { capture: true }); }
      return { ok: true };
    }
    if (rawGate !== null) return { ok: false };
    submit.click();
    return { ok: true };
  }
  if (request.action !== 'confirm' || request.testMode !== false || !gateValid || label === null || title === null || dialogs.length !== 1) return { ok: false };
  if (!dialogs[0].textContent?.replace(/\s+/g, ' ').includes(title)) return { ok: false };
  const buttons = dialogs[0].querySelectorAll<HTMLElement>('.button.alert');
  if (buttons.length !== 1 || !visible(buttons[0]) || buttons[0].textContent?.trim() !== label ||
      buttons[0].getAttribute('aria-disabled') === 'true' || buttons[0].hasAttribute('disabled') || buttons[0].hasAttribute('data-method')) return { ok: false };
  const button = buttons[0];
  if (button.tagName === 'A') {
    const href = button.getAttribute('href');
    if (href !== null && href !== '' && href !== '#') return { ok: false };
  } else if (!(button instanceof HTMLButtonElement) || button.form || button.type === 'submit') return { ok: false };
  button.click();
  return { ok: true };
}
