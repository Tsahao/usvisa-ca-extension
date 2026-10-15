// Page-side availability fetches for the polling adapter. These functions run
// inside chrome.scripting.executeScript on a validated same-group appointment
// tab, because only page context carries the visa cookies — worker-side
// fetch would arrive unauthenticated. Dependency-free by construction: no
// imports, no closures, no chrome APIs. They return status plus body and let
// the worker classify (200/304/502/denied) and validate strictly.

export type PollResponse = {
  status: number;
  body: unknown;
};

export async function fetchDaysJson(schedulePath: string, center: number): Promise<PollResponse> {
  const trusted = () => {
    const url = new URL(location.href);
    return /^\/en-ca\/niv\/schedule\/[0-9]{1,32}\/appointment$/.test(schedulePath) &&
      url.origin === 'https://ais.usvisa-info.com' && !url.username && !url.password && !url.port && !url.hash &&
      url.pathname === schedulePath && Number.isInteger(center) && center > 0;
  };
  if (!trusted()) return { status: 0, body: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${schedulePath}/days/${center}.json?appointments[expedite]=false`, {
      headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    return trusted() ? { status: response.status, body } : { status: 0, body: null };
  } catch { return { status: 0, body: null }; }
  finally { clearTimeout(timer); }
}

// Times are only read from the exact bound form and roster. Redirects,
// navigation during the request, and a missing revalidation body fail closed.
export async function fetchTimesJson(schedulePath: string, center: number, date: string, applicantIds: string[], implicitApplicantId: string | null = null): Promise<PollResponse> {
  const trusted = () => {
    const url = new URL(location.href);
    let ids = url.searchParams.getAll('applicants[]');
    if (!url.search && typeof implicitApplicantId === 'string' && /^[0-9]{1,32}$/.test(implicitApplicantId) &&
        Array.isArray(applicantIds) && applicantIds.length === 1 && applicantIds[0] === implicitApplicantId &&
        !document.querySelector('[name="applicants[]"]')) {
      const forms = document.querySelectorAll<HTMLFormElement>('#appointment-form');
      if (forms.length !== 1) return false;
      const form = forms[0];
      const target = new URL(form.getAttribute('action') ?? '', url);
      if (form.method.toLowerCase() !== 'post' || target.origin !== url.origin || target.username || target.password || target.port || target.hash ||
          target.search || target.pathname !== schedulePath ||
          ['appointments_consulate_appointment_facility_id', 'appointments_consulate_appointment_date', 'appointments_consulate_appointment_time'].some(id => {
            const fields = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`#${id}`);
            return fields.length !== 1 || fields[0].form !== form;
          })) return false;
      ids = [implicitApplicantId];
    }
    return /^\/en-ca\/niv\/schedule\/[0-9]{1,32}\/appointment$/.test(schedulePath) &&
      url.origin === 'https://ais.usvisa-info.com' && !url.username && !url.password && !url.port && !url.hash &&
      url.pathname === schedulePath && Number.isInteger(center) && center > 0 &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date &&
      Array.isArray(applicantIds) && applicantIds.length > 0 && new Set(applicantIds).size === applicantIds.length &&
      applicantIds.every(id => /^[0-9]{1,32}$/.test(id)) && new Set(ids).size === ids.length &&
      ids.length === applicantIds.length && ids.every(id => applicantIds.includes(id));
  };
  if (!trusted()) return { status: 0, body: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${schedulePath}/times/${center}.json?date=${date}&appointments[expedite]=false`, {
      headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    return trusted() ? { status: response.status, body } : { status: 0, body: null };
  } catch { return { status: 0, body: null }; }
  finally { clearTimeout(timer); }
}
