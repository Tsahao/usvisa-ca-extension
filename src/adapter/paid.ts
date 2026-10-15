export type PaidPage = {
  scheduleId: string;
  kind: 'actions' | 'warning' | 'applicants' | 'form';
  applicants: { id: string; checked: boolean; disabled: boolean }[];
  applicantIds: string[];
  facilityId: number | null;
  date: string;
  time: string;
  warningAcknowledged?: boolean;
  calendarReady?: boolean;
  slotWarning?: boolean;
};

// Serialized by Chrome: every runtime dependency must be inside this function.
// Applicant-stage controls supply the roster independently of booking URL IDs.
export function readPaidPage(scheduleId: string, implicitApplicantId: string | null = null): PaidPage | null {
  const url = new URL(location.href);
  const base = `/en-ca/niv/schedule/${scheduleId}`;
  if (!/^[0-9]{1,32}$/.test(scheduleId) || url.origin !== 'https://ais.usvisa-info.com' ||
      url.username || url.password || url.port || url.hash ||
      ![`${base}/continue_actions`, `${base}/appointment`].includes(url.pathname)) return null;
  const facility = document.getElementById('appointments_consulate_appointment_facility_id') as HTMLSelectElement | null;
  const date = document.getElementById('appointments_consulate_appointment_date') as HTMLInputElement | null;
  const time = document.getElementById('appointments_consulate_appointment_time') as HTMLSelectElement | null;
  const applicants = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="applicants[]"][type="checkbox"]'));
  let applicantIds = url.searchParams.getAll('applicants[]');
  // A single-applicant paid form may have neither query nor body IDs. The
  // worker supplies a sole applicant only after a fresh complete dashboard
  // roster check; never infer a single applicant from missing controls alone.
  if (!url.search && url.pathname === `${base}/appointment` && typeof implicitApplicantId === 'string' && /^[0-9]{1,32}$/.test(implicitApplicantId) &&
      !document.querySelector('[name="applicants[]"]')) {
    const forms = document.querySelectorAll<HTMLFormElement>('#appointment-form');
    if (forms.length !== 1) return null;
    const form = forms[0];
    const target = new URL(form.getAttribute('action') ?? '', url);
    if (form.method.toLowerCase() !== 'post' || target.origin !== url.origin || target.username || target.password || target.port || target.hash ||
        target.search || target.pathname !== `${base}/appointment` ||
        [facility, date, time].some(field => !field || field.form !== form || document.querySelectorAll(`[id="${field.id}"]`).length !== 1)) return null;
    applicantIds = [implicitApplicantId];
  }
  const warnings = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="confirmed_limit_message"]'));
  let kind: PaidPage['kind'];
  if (url.pathname === `${base}/continue_actions` && !url.search) kind = 'actions';
  else if (facility && date && time && applicantIds.length > 0) kind = 'form';
  else if (url.searchParams.get('confirmed_limit_message') === '1' && !applicantIds.length && applicants.length && !facility && !date && !time) kind = 'applicants';
  else if (!url.search && !facility && !date && !time && document.querySelector('input[type="checkbox"]')) kind = 'warning';
  else return null;
  const visible = (element: HTMLElement) => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  return {
    scheduleId, kind,
    applicants: applicants.map(input => ({ id: input.value, checked: input.checked, disabled: input.disabled })),
    applicantIds, facilityId: facility?.value ? Number(facility.value) : null,
    date: date?.value ?? '', time: time?.value ?? '',
    ...(kind === 'form' ? {
      calendarReady: !!date?.value && date.getAttribute('data-usvisa-calendar-slot') === `${facility!.value}|${date.value}`,
      slotWarning: Array.from(document.querySelectorAll<HTMLElement>('#non-consulate-business-day-message, #non-consulate-business-time-message')).some(visible),
    } : {}),
    ...(warnings.length ? { warningAcknowledged: warnings.length === 1 && !warnings[0].disabled &&
      (warnings[0].type === 'checkbox' ? warnings[0].checked : warnings[0].type === 'hidden' && warnings[0].value === '1') } : {}),
  };
}
