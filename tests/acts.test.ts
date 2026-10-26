// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performPaidAction, type PaidAction } from '../src/adapter/acts';
import { readPaidPage } from '../src/adapter/paid';
import { installPortalCalendar } from './fixtures/portal-calendar';

// Exercise Chrome's serialization boundary: imported helpers are unavailable.
const act: typeof performPaidAction = new Function(`return (${performPaidAction.toString()})`)();
const read: typeof readPaidPage = new Function(`return (${readPaidPage.toString()})`)();
const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
const ids = ['77777777', '88888888'];
const formQuery = '?applicants[]=77777777&applicants[]=88888888';
const request = { scheduleId: '11111111', applicantIds: ids, facilityId: 95, date: '2026-11-19', time: '09:15' };
const locate = (path: string) => vi.stubGlobal('location', { href: `${base}/${path}` });
const form = () => {
  locate(`appointment${formQuery}`);
  document.body.innerHTML = `
    <select id="appointments_consulate_appointment_facility_id"><option value="94">Toronto</option><option value="95">Vancouver</option></select>
    <input id="appointments_consulate_appointment_date">
    <select id="appointments_consulate_appointment_time"><option value="">Select</option><option value="09:15">09:15</option></select>
    <button id="appointments_submit">Submit</button><button>Confirm</button>`;
  installPortalCalendar();
};
afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { jQuery?: unknown }).jQuery; vi.useRealTimers(); });

describe('serialized paid adapters', () => {
  it.each(['plain', 'applicant-query', 'disabled-until-date'])(
    'recognizes real booking capability when payment markup is unknown (%s)', variant => {
      form();
      document.body.innerHTML = `<form id="appointment-form" method="post" action="${base}/appointment${variant === 'applicant-query' ? formQuery : ''}">${document.body.innerHTML}</form>`;
      if (variant === 'disabled-until-date') document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_time')!.disabled = true;
      expect(read(request.scheduleId, null, true)).toMatchObject({ kind: 'form', applicantIds: ids });
    });
  it.each(['detached', 'foreign-action', 'other-schedule', 'wrong-applicants', 'get-form', 'duplicate-control'])(
    'refuses unsupported booking capability without mutating the page (%s)', variant => {
      form();
      if (variant !== 'detached') {
        const action = variant === 'foreign-action' ? 'https://example.invalid/appointment' :
          variant === 'other-schedule' ? base.replace('11111111', '99999999') + '/appointment' :
          base + '/appointment' + (variant === 'wrong-applicants' ? '?applicants[]=99999999' : '');
        document.body.innerHTML = `<form id="appointment-form" method="${variant === 'get-form' ? 'get' : 'post'}" action="${action}">${document.body.innerHTML}</form>`;
      }
      if (variant === 'duplicate-control') document.body.insertAdjacentHTML('beforeend', '<input id="appointments_consulate_appointment_date">');
      const before = document.body.innerHTML;
      expect(read(request.scheduleId, null, true)).toBeNull();
      expect(document.body.innerHTML).toBe(before);
    });
  it('continues immediately after a synchronous successful facility days callback', async () => {
    vi.useFakeTimers(); form();
    const calendar = installPortalCalendar();
    expect(await act({ ...request, action: 'facility' })).toEqual({ ok: true });
    expect(calendar.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(calendar.calls).toBe(0);
  });
  it.each([250, 3200])('waits for actual facility completion (%sms), without assuming the new select value is ready', async delay => {
    vi.useFakeTimers(); form();
    const calendar = installPortalCalendar({ facilityDelay: delay });
    document.querySelector('#appointments_consulate_appointment_date')!.setAttribute('data-usvisa-calendar-slot', '94|2026-11-19');
    let settled = false;
    const pending = act({ ...request, action: 'facility' }).then(result => { settled = true; return result; });
    expect(document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!.value).toBe('95');
    expect(read(request.scheduleId)?.calendarReady).toBe(false);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(settled).toBe(false);
    expect(calendar.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true });
    expect(calendar.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await act({ ...request, action: 'date' })).toEqual({ ok: true });
  });
  it('ignores unrelated completions and an older same-URL request', async () => {
    vi.useFakeTimers(); form();
    const calendar = installPortalCalendar({ facilityDelay: 500 });
    let settled = false;
    const pending = act({ ...request, action: 'facility' }).then(result => { settled = true; return result; });
    const body = [{ date: request.date, business_day: true }];
    calendar.complete({ status: 200, responseJSON: body }, `${base}/appointment/days/95.json?appointments[expedite]=false`);
    const owned = calendar.facilityRequest!;
    owned.status = 200; owned.responseJSON = body;
    for (const target of [
      `${base}/appointment/days/94.json?appointments[expedite]=false`,
      `${base.replace('11111111', '99999999')}/appointment/days/95.json?appointments[expedite]=false`,
      `${base}/appointment/days/95.json?appointments[expedite]=true`,
      `${base}/appointment/days/95.json?appointments[expedite]=false&extra=1`,
      'https://example.invalid/en-ca/niv/schedule/11111111/appointment/days/95.json?appointments[expedite]=false',
    ]) calendar.complete(owned, target);
    calendar.complete(owned, `${base}/appointment/days/95.json?appointments[expedite]=false`, 'POST');
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toEqual({ ok: true });
    expect(calendar.listenerCount).toBe(0);
  });
  it.each([
    { label: 'empty', days: [], reason: 'facility-date-unavailable' },
    { label: 'missing candidate', days: [{ date: '2026-11-20', business_day: true }], reason: 'facility-date-unavailable' },
    { label: 'non-business day', days: [{ date: request.date, business_day: false }], reason: 'facility-date-unavailable' },
    { label: 'missing business marker', days: [{ date: request.date }], reason: 'facility-response-invalid' },
    { label: 'malformed', days: { error: 'synthetic' }, reason: 'facility-response-invalid' },
    { label: 'invalid day', days: [{ date: '2026-02-30', business_day: true }], reason: 'facility-response-invalid' },
    { label: 'duplicates', days: [{ date: request.date, business_day: true }, { date: request.date, business_day: true }], reason: 'facility-response-invalid' },
  ])('refuses unsafe facility days (%s)', async ({ days, reason }) => {
    vi.useFakeTimers(); form();
    const calendar = installPortalCalendar({ facilityDays: days });
    expect(await act({ ...request, action: 'facility' })).toEqual({ ok: false, reason });
    expect(calendar.listenerCount).toBe(0);
    expect(calendar.calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['timeout', 'failed-response', 'context-change', 'replaced-field', 'disabled-field', 'changed-facility', 'ambiguous-request', 'missing-jquery'])('refuses unsafe facility loading (%s)', async issue => {
    vi.useFakeTimers(); form();
    const calendar = installPortalCalendar({ facilityDelay: 500 });
    if (issue === 'timeout') document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!.onchange = null;
    if (issue === 'ambiguous-request') {
      const facility = document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!;
      const change = facility.onchange!;
      facility.onchange = event => {
        change.call(facility, event);
        calendar.send({ status: 0 }, `${base}/appointment/days/95.json?appointments[expedite]=false`);
      };
    }
    if (issue === 'missing-jquery') delete (window as unknown as { jQuery?: unknown }).jQuery;
    const pending = act({ ...request, action: 'facility' });
    if (issue === 'failed-response') {
      const xhr = calendar.facilityRequest!; xhr.status = 503;
      calendar.complete(xhr, `${base}/appointment/days/95.json?appointments[expedite]=false`);
    }
    if (issue === 'context-change') vi.stubGlobal('location', { href: `${base.replace('11111111', '99999999')}/appointment` });
    if (issue === 'replaced-field') document.querySelector('#appointments_consulate_appointment_date')!.outerHTML = '<input id="appointments_consulate_appointment_date">';
    if (issue === 'disabled-field') document.querySelector<HTMLInputElement>('#appointments_consulate_appointment_date')!.disabled = true;
    if (issue === 'changed-facility') document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!.value = '94';
    await vi.advanceTimersByTimeAsync(issue === 'timeout' ? 15_000 : 500);
    expect((await pending).ok).toBe(false);
    expect(calendar.listenerCount).toBe(0);
    expect(calendar.calls).toBe(0);
  });
  it('refreshes a prefilled date through calendar onSelect before selecting its time', async () => {
    form();
    const facility = document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!;
    const date = document.querySelector<HTMLInputElement>('#appointments_consulate_appointment_date')!;
    const time = document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_time')!;
    facility.value = '95'; date.value = request.date;
    document.body.insertAdjacentHTML('beforeend', '<span id="non-consulate-business-time-message" hidden>Non-business time</span>');
    const calendar = installPortalCalendar();
    const warning = document.getElementById('non-consulate-business-time-message')!;
    // Old path: a valid-looking option with no matching portal cache.
    time.value = request.time; time.dispatchEvent(new Event('change'));
    expect(warning.hidden).toBe(false);
    expect((await act({ ...request, action: 'time' })).ok).toBe(false);
    time.value = ''; time.dispatchEvent(new Event('change'));
    expect(warning.hidden).toBe(true);
    time.value = request.time; time.dispatchEvent(new Event('change'));
    expect(warning.hidden).toBe(false);
    expect(read(request.scheduleId)?.calendarReady).toBe(false);
    expect(await act({ ...request, action: 'date' })).toEqual({ ok: true });
    expect(calendar.calls).toBe(1);
    expect(calendar.listenerCount).toBe(0);
    expect(read(request.scheduleId)?.calendarReady).toBe(true);
    expect(await act({ ...request, action: 'time' })).toEqual({ ok: true });
    expect(warning.hidden).toBe(true);
    expect(read(request.scheduleId)?.slotWarning).toBe(false);
  });
  it('awaits the matching portal response instead of proceeding after the date value changes', async () => {
    vi.useFakeTimers(); form();
    await act({ ...request, action: 'facility' });
    const calendar = installPortalCalendar({ delay: 4_000 });
    let settled = false;
    const pending = act({ ...request, action: 'date' }).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);
    expect(read(request.scheduleId)?.calendarReady).toBe(false);
    calendar.complete({ status: 200, responseJSON: { available_times: [], business_times: [] } },
      `${base}/appointment/times/94.json?date=${request.date}&appointments[expedite]=false`);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual({ ok: true });
    expect(calendar.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['missing-picker', 'timeout', 'malformed', 'context-change'] as const)('fails closed when calendar loading is unsafe (%s)', async issue => {
    vi.useFakeTimers(); form();
    await act({ ...request, action: 'facility' });
    const calendar = installPortalCalendar({ delay: 20_000 });
    if (issue === 'missing-picker') delete (window as unknown as { jQuery?: unknown }).jQuery;
    const pending = act({ ...request, action: 'date' });
    if (issue === 'malformed') calendar.complete(Object.assign(calendar.calendarRequest!, { status: 200, responseJSON: { available_times: ['09:15'] } }),
      `${base}/appointment/times/95.json?date=${request.date}&appointments[expedite]=false`);
    if (issue === 'context-change') document.querySelector<HTMLInputElement>('#appointments_consulate_appointment_date')!.value = '2026-11-20';
    await vi.advanceTimersByTimeAsync(issue === 'context-change' ? 20_000 : 15_000);
    expect((await pending).ok).toBe(false);
    expect(read(request.scheduleId)?.calendarReady).toBe(false);
    expect(calendar.listenerCount).toBe(0);
  });
  it('expands the observed initial gateway and follows its same-group continue link separately', async () => {
    locate('continue_actions');
    document.body.innerHTML = `<a class="accordion-title" role="tab" aria-expanded="false" aria-controls="entry"><h5><i class="fas fa-calendar"></i>Schedule Appointment</h5></a>
      <div id="entry" hidden><a class="button small primary small-only-expanded" href="${base}/continue">Schedule Appointment</a></div>`;
    const toggle = document.querySelector<HTMLAnchorElement>('.accordion-title')!;
    const link = document.querySelector<HTMLAnchorElement>('#entry a')!;
    const entered = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', entered);
    toggle.onclick = () => { toggle.setAttribute('aria-expanded', 'true'); document.querySelector<HTMLElement>('#entry')!.hidden = false; };
    expect(await act({ ...request, action: 'schedule' })).toEqual({ ok: true, advanced: false });
    expect(entered).not.toHaveBeenCalled();
    expect(await act({ ...request, action: 'schedule' })).toEqual({ ok: true, advanced: true });
    expect(entered).toHaveBeenCalledOnce();
  });
  it.each(['offsite', 'wrong-group', 'query', 'fragment', 'wrong-label', 'reschedule', 'duplicate', 'mixed-targets', 'form'])('refuses an unsafe or ambiguous initial continue entry (%s)', async issue => {
    locate('continue_actions');
    const label = issue === 'reschedule' ? 'Reschedule Appointment' : 'Schedule Appointment';
    document.body.innerHTML = `<button type="button" aria-expanded="false">${label}</button><a href="${base}/continue">${label}</a>`;
    const link = document.querySelector('a')!;
    if (issue === 'offsite') link.href = 'https://example.invalid/en-ca/niv/schedule/11111111/continue';
    if (issue === 'wrong-group') link.href = base.replace('11111111', '99999999') + '/continue';
    if (issue === 'query') link.href += '?next=appointment';
    if (issue === 'fragment') link.href += '#appointment';
    if (issue === 'wrong-label') link.textContent = 'Continue';
    if (issue === 'duplicate') document.body.insertAdjacentHTML('beforeend', `<a href="${base}/continue">Schedule Appointment</a>`);
    if (issue === 'mixed-targets') document.body.insertAdjacentHTML('beforeend', `<a href="${base}/appointment">Schedule Appointment</a>`);
    if (issue === 'form') link.outerHTML = `<form method="get" action="${base}/continue"><input type="submit" value="Schedule Appointment"></form>`;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll('button, a, input').forEach(el => el.addEventListener('click', clicked));
    expect((await act({ ...request, action: issue === 'reschedule' ? 'reschedule' : 'schedule' })).ok).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });
  it.each(['post', 'wrong-target'])('refuses an unexpected warning form before changing its checkbox (%s)', async issue => {
    locate('appointment');
    document.body.innerHTML = `<form method="${issue === 'post' ? 'post' : 'get'}" action="${issue === 'wrong-target' ? 'https://example.invalid/' : `${base}/appointment`}">
      <input type="checkbox" id="confirmed_limit_message" name="confirmed_limit_message" value="1"><input type="submit" value="Continue"></form>`;
    expect((await act({ ...request, action: 'warning' })).ok).toBe(false);
    expect(document.querySelector('input')!.checked).toBe(false);
  });
  it.each(['reschedule', 'schedule'] as const)('handles a no-href portal accordion and its separate %s entry', async action => {
    locate('continue_actions');
    const label = action === 'reschedule' ? 'Reschedule Appointment' : 'Schedule Appointment';
    document.body.innerHTML = `<a class="accordion-title" role="tab" aria-expanded="false" aria-controls="synthetic-content"><h5>${label}</h5></a>
      <div id="synthetic-content" hidden><a class="button primary" href="${base}/appointment">${label}</a></div>`;
    const controls = document.querySelectorAll('a');
    const clicked = vi.fn((event: Event) => event.preventDefault());
    controls[1].addEventListener('click', clicked);
    controls[0].onclick = () => { controls[0].setAttribute('aria-expanded', 'true'); document.querySelector('div')!.hidden = false; };
    expect(await act({ ...request, action })).toEqual({ ok: true, advanced: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(await act({ ...request, action })).toEqual({ ok: true, advanced: true });
    expect(clicked).toHaveBeenCalledOnce();
  });
  it('enters initial booking only from the exact Schedule Appointment copy with a validated target', async () => {
    locate('continue_actions');
    document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/appointment">Schedule Appointment</a><a href="${base}/payment">Pay fee</a>`;
    const toggle = document.querySelector('button')!;
    toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', 'true'));
    // Collapsed toggle expands first without navigating.
    expect(await act({ ...request, action: 'schedule' })).toEqual({ ok: true, advanced: false });
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll('a')[0].addEventListener('click', clicked);
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
    // Duplicate appointment entries stay ambiguous.
    document.body.insertAdjacentHTML('beforeend', `<a href="${base}/appointment">Schedule Appointment</a>`);
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    // Wrong gateway copy never satisfies an initial booking, even with a valid target.
    document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/appointment">Schedule an interview</a>`;
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/appointment">Continue</a>`;
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/appointment">Schedule Appointment Now</a>`;
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    document.body.innerHTML = `<button type="button" aria-expanded="false">Book Appointment</button>
      <a href="${base}/appointment">Book Appointment</a>`;
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
  });
  it.each(['Schedule Appointment', '  SCHEDULE   Appointment  ', 'schedule appointment'])('expands a first-time Schedule Appointment toggle without containment (%s)', async label => {
    locate('continue_actions');
    document.body.innerHTML = `<button type="button" aria-expanded="false">${label}</button>
      <a href="${base}/appointment">${label}</a>`;
    const toggle = document.querySelector('button')!;
    const enter = document.querySelector('a')!;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    enter.addEventListener('click', clicked);
    toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', 'true'));
    expect(await act({ ...request, action: 'schedule' })).toEqual({ ok: true, advanced: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(await act({ ...request, action: 'schedule' })).toEqual({ ok: true, advanced: true });
    expect(clicked).toHaveBeenCalledOnce();
  });
  it.each(['warning', 'applicants'] as const)('advances %s GET forms via Continue only and refuses gateway copy', async action => {
    locate(action === 'warning' ? 'appointment' : 'appointment?confirmed_limit_message=1');
    const markupFor = (label: string) => action === 'warning'
      ? `<form method="get" action="${base}/appointment"><input type="checkbox" id="confirmed_limit_message" name="confirmed_limit_message" value="1" checked><button>${label}</button></form>`
      : `<form method="get" action="${base}/appointment">${ids.map(id => `<input type="checkbox" name="applicants[]" value="${id}" checked>`).join('')}<input type="submit" name="commit" value="${label}"></form>`;
    // "Schedule Appointment" replaces "Reschedule Appointment" in the
    // continue_actions gateway, never the Continue control here.
    for (const label of ['Continue', '  CONTINUE  ', 'continue']) {
      document.body.innerHTML = markupFor(label);
      expect((await act({ ...request, action })).ok).toBe(true);
    }
    for (const label of ['Schedule Appointment', '  schedule   APPOINTMENT  ', 'Reschedule Appointment', 'Schedule Appointment Now', 'Continue to Payment']) {
      document.body.innerHTML = markupFor(label);
      expect((await act({ ...request, action })).ok).toBe(false);
    }
  });
  it('normalizes gateway copy but refuses cross-action and over-matching labels', async () => {
    locate('continue_actions');
    document.body.innerHTML = `<button type="button" aria-expanded="false">  reschedule   APPOINTMENT </button>
      <a href="${base}/appointment">  reschedule   APPOINTMENT </a>`;
    const toggle = document.querySelector('button')!;
    toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', 'true'));
    expect(await act({ ...request, action: 'reschedule' })).toEqual({ ok: true, advanced: false });
    // A reschedule-labeled gateway must never advance an initial booking.
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    // A schedule-labeled gateway must never satisfy a reschedule action.
    document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/appointment">Schedule Appointment</a>`;
    expect((await act({ ...request, action: 'reschedule' })).ok).toBe(false);
    // Mixed gateways with both copies refuse for either action.
    document.body.innerHTML = `<button type="button" aria-expanded="false">Reschedule Appointment</button>
      <a href="${base}/appointment">Reschedule Appointment</a>
      <button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/appointment">Schedule Appointment</a>`;
    expect((await act({ ...request, action: 'reschedule' })).ok).toBe(false);
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    // Duplicate Schedule Appointment toggles stay ambiguous.
    document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
      <button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/appointment">Schedule Appointment</a>`;
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    // Duplicate appointment entries stay ambiguous even with the exact copy.
    document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/appointment">Schedule Appointment</a><a href="${base}/appointment">Schedule Appointment</a>`;
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    // Over-matching gateway labels never satisfy the schedule action.
    for (const label of ['Schedule Appointment Now', 'Continue', 'Book Appointment', 'Schedule an interview']) {
      document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
        <a href="${base}/appointment">${label}</a>`;
      expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    }
    // A schedule entry with the wrong target refuses.
    document.body.innerHTML = `<button type="button" aria-expanded="false">Schedule Appointment</button>
      <a href="${base}/payment">Schedule Appointment</a>`;
    expect((await act({ ...request, action: 'schedule' })).ok).toBe(false);
    locate('appointment?confirmed_limit_message=1');
    document.body.innerHTML = `<input name="applicants[]" type="checkbox" value="77777777" checked>
      <input name="applicants[]" type="checkbox" value="88888888" checked><button>Continue to Payment</button>`;
    expect((await act({ ...request, action: 'applicants' })).ok).toBe(false);
    document.body.innerHTML = `<input name="applicants[]" type="checkbox" value="77777777" checked>
      <input name="applicants[]" type="checkbox" value="88888888" checked><button>Continue</button><button>Schedule Appointment</button>`;
    expect((await act({ ...request, action: 'applicants' })).ok).toBe(false);
    document.body.innerHTML = `<input name="applicants[]" type="checkbox" value="77777777" checked>
      <input name="applicants[]" type="checkbox" value="88888888" checked><button>Schedule Appointment Now</button>`;
    expect((await act({ ...request, action: 'applicants' })).ok).toBe(false);
  });
  it('uses the stable warning ID and GET Continue without toggling applicant checkboxes', async () => {
    locate('appointment');
    document.body.innerHTML = `<form method="get" action="${base}/appointment"><div class="icheckbox"><input type="checkbox" id="confirmed_limit_message" name="confirmed_limit_message" value="1"></div>
      <input type="submit" name="commit" value="Continue"></form>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')!.addEventListener('submit', submitted);
    expect(await act({ ...request, action: 'warning' })).toEqual({ ok: true, advanced: false });
    expect(submitted).not.toHaveBeenCalled();
    expect((await act({ ...request, action: 'warning' })).ok).toBe(true);
    expect(submitted).toHaveBeenCalledOnce();
  });
  it('never inserts a time into a blank dropdown, even with a separately fetched response', async () => {
    form();
    await act({ ...request, action: 'facility' });
    await act({ ...request, action: 'date' });
    const time = document.querySelectorAll('select')[1];
    time.innerHTML = '<option value=""></option>';
    expect((await act({ ...request, action: 'time' })).ok).toBe(false);
    expect((await act({ ...request, action: 'time', availableTimes: ['10:30'] })).ok).toBe(false);
    expect((await act({ ...request, action: 'time', availableTimes: [request.time] })).ok).toBe(false);
    expect(time.value).toBe('');
    time.innerHTML = '<option value="10:30">10:30</option>';
    expect((await act({ ...request, action: 'time', availableTimes: [request.time] })).ok).toBe(false);
    expect(time.value).toBe('10:30');
  });
  it('expands then enters a validated gateway in separate mutations', async () => {
    locate('continue_actions');
    document.body.innerHTML = `<button type="button" aria-expanded="false">Reschedule Appointment</button>
      <a href="${base}/appointment">Reschedule Appointment</a>`;
    const toggle = document.querySelector('button')!;
    const enter = document.querySelector('a')!;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    enter.addEventListener('click', clicked);
    toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', 'true'));
    expect(await act({ ...request, action: 'reschedule' })).toEqual({ ok: true, advanced: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(await act({ ...request, action: 'reschedule' })).toEqual({ ok: true, advanced: true });
    expect(clicked).toHaveBeenCalledOnce();
    enter.href = 'https://example.invalid/';
    expect((await act({ ...request, action: 'reschedule' })).ok).toBe(false);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('reschedules when a separate Cancel DELETE control shares the appointment endpoint', async () => {
    locate('continue_actions');
    document.body.innerHTML = `<a class="accordion-title" aria-expanded="false" aria-controls="reschedule">Reschedule Appointment</a>
      <div id="reschedule" hidden><a class="button small primary small-only-expanded" href="${base}/appointment">Reschedule Appointment</a></div>
      <a class="accordion-title" aria-expanded="false" aria-controls="cancel">Cancel Appointment</a>
      <div id="cancel" hidden><a class="button small primary small-only-expanded" data-method="delete" href="${base}/appointment">Cancel Appointment</a></div>`;
    const toggles = document.querySelectorAll<HTMLAnchorElement>('.accordion-title');
    const entered = vi.fn((event: Event) => event.preventDefault());
    const cancelled = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('#reschedule a')!.addEventListener('click', entered);
    document.querySelector('#cancel a')!.addEventListener('click', cancelled);
    toggles[1].addEventListener('click', cancelled);
    toggles[0].onclick = () => {
      toggles[0].setAttribute('aria-expanded', 'true');
      document.querySelector<HTMLElement>('#reschedule')!.hidden = false;
    };
    expect(await act({ ...request, action: 'reschedule' })).toEqual({ ok: true, advanced: false });
    expect(entered).not.toHaveBeenCalled();
    expect(await act({ ...request, action: 'reschedule' })).toEqual({ ok: true, advanced: true });
    expect(entered).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    expect(toggles[1].getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector<HTMLElement>('#cancel')!.hidden).toBe(true);
  });

  it('acknowledges the exact warning before a later Continue', async () => {
    locate('appointment');
    document.body.innerHTML = '<label><input type="checkbox">I understand</label><button>Continue</button>';
    const click = vi.fn();
    document.querySelector('button')!.addEventListener('click', click);
    expect(await act({ ...request, action: 'warning' })).toEqual({ ok: true, advanced: false });
    expect(click).not.toHaveBeenCalled();
    expect(await act({ ...request, action: 'warning' })).toEqual({ ok: true, advanced: true });
    expect(click).toHaveBeenCalledOnce();
    locate('appointment?confirmed_limit_message=1');
    expect((await act({ ...request, action: 'warning' })).ok).toBe(false);
  });

  it('captures every applicant control and refuses dropped, unchecked, disabled or duplicate IDs', async () => {
    locate('appointment?confirmed_limit_message=1');
    const markup = `<input name="applicants[]" type="checkbox" value="77777777" checked>
      <input name="applicants[]" type="checkbox" value="88888888" checked><button>Continue</button>`;
    document.body.innerHTML = markup;
    expect(read('11111111')).toMatchObject({ kind: 'applicants', applicantIds: [], applicants: [
      { id: ids[0], checked: true, disabled: false }, { id: ids[1], checked: true, disabled: false },
    ] });
    expect((await act({ ...request, action: 'applicants' })).ok).toBe(true);
    for (const mutation of ['remove', 'unchecked', 'disabled', 'duplicate']) {
      document.body.innerHTML = markup;
      const second = document.querySelectorAll('input')[1];
      if (mutation === 'remove') second.remove();
      if (mutation === 'unchecked') second.checked = false;
      if (mutation === 'disabled') second.disabled = true;
      if (mutation === 'duplicate') second.value = ids[0];
      const click = vi.fn();
      document.querySelector('button')!.addEventListener('click', click);
      expect((await act({ ...request, action: 'applicants' })).ok).toBe(false);
      expect(click).not.toHaveBeenCalled();
    }
  });

  it('fills each field separately and never submits or confirms', async () => {
    form();
    const submit = vi.fn();
    document.querySelectorAll('button').forEach(button => button.addEventListener('click', submit));
    for (const action of ['facility', 'date', 'time'] as const) expect((await act({ ...request, action })).ok).toBe(true);
    expect(read('11111111')).toMatchObject({ kind: 'form', applicantIds: ids, facilityId: 95, date: request.date, time: request.time });
    expect(submit).not.toHaveBeenCalled();
    expect((await act({ ...request, action: 'submit' as PaidAction['action'] })).ok).toBe(false);
  });

  it.each(['https://example.invalid/en-ca/niv/schedule/11111111/appointment',
    `${base.replace('11111111', '99999999')}/appointment`,
    `http://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment`,
    `${base}/payment`, `${base}/appointment?applicants[]=77777777`,
    `${base}/appointment?applicants[]=77777777&applicants[]=77777777`,
  ])('refuses a changed context before touching fields: %s', async href => {
    form();
    vi.stubGlobal('location', { href });
    expect((await act({ ...request, action: 'facility' })).ok).toBe(false);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('94');
  });

  it('rejects off-origin reads and changed facility/date before setting time', async () => {
    form();
    expect((await act({ ...request, action: 'time' })).ok).toBe(false);
    await act({ ...request, action: 'facility' });
    await act({ ...request, action: 'date' });
    expect((await act({ ...request, time: '25:90', action: 'time' })).ok).toBe(false);
    vi.stubGlobal('location', { href: `https://example.invalid/appointment${formQuery}` });
    expect(read('11111111')).toBeNull();
  });
});

describe('serialized calendar HTTP failure attribution', () => {
  it.each([
    [0, 'network-failed'], [401, 'request-denied'], [403, 'request-denied'], [503, 'server-error'], [408, 'request-retryable'], [429, 'request-retryable'], [404, 'http-error'],
  ] as const)('separates status %s for facility and date requests', async (status, suffix) => {
    vi.useFakeTimers(); form();
    const calendar = installPortalCalendar({ facilityDelay: 1000, delay: 1000 });
    const facility = act({ ...request, action: 'facility' });
    const xhr = calendar.facilityRequest!; xhr.status = status;
    calendar.complete(xhr, `${base}/appointment/days/95.json?appointments[expedite]=false`);
    expect(await facility).toEqual({ ok: false, reason: `facility-${suffix}` });
    const selectingDate = act({ ...request, action: 'date' });
    const dateXhr = calendar.calendarRequest!; dateXhr.status = status;
    calendar.complete(dateXhr, `${base}/appointment/times/95.json?date=${request.date}&appointments[expedite]=false`);
    expect(await selectingDate).toEqual({ ok: false, reason: `calendar-${suffix}` });
    expect(calendar.listenerCount).toBe(0);
  });
});

describe('calendar request ownership', () => {
  const endpoint = `${base}/appointment/times/95.json?date=${request.date}&appointments[expedite]=false`;
  it('ignores an old same-date completion and wrong-method completions until its exact GET finishes', async () => {
    vi.useFakeTimers(); form();
    document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!.value = '95';
    const calendar = installPortalCalendar({ delay: 500 });
    let done = false;
    const pending = act({ ...request, action: 'date' }).then(reply => { done = true; return reply; });
    calendar.complete({ status: 200, responseJSON: { available_times: ['09:15'], business_times: ['09:15'] } }, endpoint);
    calendar.complete(calendar.calendarRequest!, endpoint, 'POST');
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    expect(read(request.scheduleId)?.calendarReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true });
    expect(read(request.scheduleId)?.calendarReady).toBe(true);
    expect(calendar.listenerCount).toBe(0);
  });
  it('rejects overlapping matching GETs initiated by one date callback', async () => {
    vi.useFakeTimers(); form();
    document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!.value = '95';
    const calendar = installPortalCalendar({ delay: 500 });
    const jq = (window as any).jQuery;
    (window as any).jQuery = (node: Element | Document) => {
      const value = jq(node);
      if (node !== document.getElementById('appointments_consulate_appointment_date')) return value;
      return { ...value, datepicker: (command: string, key: string) => command === 'option' ? function () {
        const callback = value.datepicker(command, key); callback();
        calendar.send({ status: 0 }, endpoint);
      } : value.datepicker(command, key) };
    };
    expect(await act({ ...request, action: 'date' })).toEqual({ ok: false, reason: 'calendar-load-ambiguous' });
    await vi.advanceTimersByTimeAsync(500);
    expect(read(request.scheduleId)?.calendarReady).toBe(false);
    expect(calendar.listenerCount).toBe(0);
  });
  it('does not accept a late completion after timeout, including during a new same-date attempt', async () => {
    vi.useFakeTimers(); form();
    document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!.value = '95';
    const calendar = installPortalCalendar({ delay: 20_000 });
    const first = act({ ...request, action: 'date' }); const old = calendar.calendarRequest!;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toEqual({ ok: false, reason: 'calendar-load-timeout' });
    const second = act({ ...request, action: 'date' });
    expect(calendar.calendarRequest).not.toBe(old);
    await vi.advanceTimersByTimeAsync(5_000); // old XHR's real same-date completion
    expect(read(request.scheduleId)?.calendarReady).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await second).toEqual({ ok: false, reason: 'calendar-load-timeout' });
    expect(calendar.listenerCount).toBe(0);
    expect(read(request.scheduleId)?.calendarReady).toBe(false);
  });
});
