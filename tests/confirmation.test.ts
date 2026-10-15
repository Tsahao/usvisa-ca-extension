// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performAppointmentSubmission, waitForAppointmentDialog, type SubmissionRequest } from '../src/adapter/confirmation';

const BASE = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
const request: SubmissionRequest = { action: 'submit', scheduleId: '11111111', applicantIds: ['77777777', '88888888'], facilityId: 95,
  date: '2026-11-19', time: '08:00', earliest: '2026-11-01', latest: '2026-12-31', currentDate: '2027-01-01', currentDateTag: 'booked', onlyEarlier: true, testMode: true };
const isolated = (args: SubmissionRequest) => new Function(`return (${performAppointmentSubmission.toString()})`)()(args);
let submit = vi.fn<() => void>();
let confirm = vi.fn<() => void>();
let clicked = vi.fn<() => void>();
function dialog() {
  const container = document.createElement('div');
  container.className = 'reveal-overlay';
  container.innerHTML = '<div data-reveal><h4>Are you sure you want to reschedule the appointment?</h4><a class="button alert" href="#">Confirm</a></div>';
  document.body.append(container);
  container.querySelector('a')!.onclick = event => { event.preventDefault(); confirm(); };
}
beforeEach(() => {
  vi.stubGlobal('location', { href: `${BASE}?applicants[]=77777777&applicants[]=88888888` });
  document.body.innerHTML = `<form id="appointment-form" action="${BASE}" method="post">
    <select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select>
    <input id="appointments_consulate_appointment_date" value="2026-11-19" readonly data-usvisa-calendar-slot="95|2026-11-19">
    <select id="appointments_consulate_appointment_time"><option value="08:00">08:00</option></select>
    <input id="appointments_submit" type="submit" value="Reschedule"></form>`;
  document.querySelector('#appointments_submit')!.setAttribute('data-confirm', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', ok: 'Confirm', cancel: 'Cancel' }));
  submit = vi.fn(); confirm = vi.fn(); clicked = vi.fn();
  document.querySelector('#appointments_submit')!.addEventListener('click', clicked);
  document.querySelector('form')!.onsubmit = event => { event.preventDefault(); submit(); dialog(); };
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('read-only confirmation readiness', () => {
  const wait = (timeout = 15_000) => new Function(`return (${waitForAppointmentDialog.toString()})`)()({ ...request, action: 'confirm', testMode: false }, timeout) as Promise<{ ok: boolean }>;
  it('returns immediately for a ready dialog without any click', async () => {
    vi.useFakeTimers(); dialog();
    expect(await wait()).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(clicked).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it('waits for delayed rendering and an enabled positive control, then cleans up', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = wait().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);
    dialog();
    document.querySelector('.button.alert')!.setAttribute('aria-disabled', 'true');
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);
    document.querySelector('.button.alert')!.removeAttribute('aria-disabled');
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(clicked).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it('bounds missing-dialog waiting to the remaining durable budget', async () => {
    vi.useFakeTimers();
    const pending = wait(350);
    await vi.advanceTimersByTimeAsync(350);
    expect(await pending).toEqual({ ok: false });
    expect(vi.getTimerCount()).toBe(0);
    dialog();
    await vi.advanceTimersByTimeAsync(500);
    expect(clicked).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it.each(['field', 'context', 'warning', 'gate', 'duplicate', 'unrelated', 'unsafe-link', 'replaced-form'])('refuses changed/unsafe readiness without clicking (%s)', async issue => {
    vi.useFakeTimers();
    const pending = wait();
    if (issue === 'field') document.querySelector<HTMLInputElement>('#appointments_consulate_appointment_date')!.value = '2026-11-20';
    if (issue === 'context') vi.stubGlobal('location', { href: BASE.replace('11111111', '99999999') });
    if (issue === 'warning') document.body.insertAdjacentHTML('beforeend', '<div id="non-consulate-business-time-message">Warning</div>');
    if (issue === 'gate') document.querySelector('#appointments_submit')!.setAttribute('data-confirm', '{}');
    if (issue === 'duplicate') { dialog(); dialog(); }
    if (issue === 'unrelated') { dialog(); document.querySelector('h4')!.textContent = 'Remove applicant?'; }
    if (issue === 'unsafe-link') { dialog(); document.querySelector('a')!.setAttribute('href', 'https://example.invalid'); }
    if (issue === 'replaced-form') document.querySelector('form')!.outerHTML = document.querySelector('form')!.outerHTML;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ ok: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(clicked).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it('does not wait for a direct or malformed gate and refuses Test Mode', async () => {
    document.querySelector('#appointments_submit')!.removeAttribute('data-confirm');
    expect(await wait()).toEqual({ ok: false });
    document.querySelector('#appointments_submit')!.setAttribute('data-confirm', '{bad-json');
    expect(await wait()).toEqual({ ok: false });
    const isolatedWait = new Function(`return (${waitForAppointmentDialog.toString()})`)();
    expect(await isolatedWait({ ...request, action: 'confirm' }, 15_000)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
  });
});

describe('serialized two-step submission', () => {
  it.each(['submit', 'confirm'] as const)('refuses %s if a portal business-time warning appears immediately before the click', action => {
    if (action === 'confirm') dialog();
    document.body.insertAdjacentHTML('beforeend', '<span id="non-consulate-business-time-message">Non-business time</span>');
    expect(isolated({ ...request, action, testMode: false })).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
  it('blocks native POST during gate opening even when the portal confirmation handler is absent', () => {
    const form = document.querySelector('form')!;
    form.onsubmit = null;
    const attempted = vi.fn((event: Event) => { expect(event.defaultPrevented).toBe(true); });
    form.addEventListener('submit', attempted);
    expect(isolated({ ...request, testMode: false })).toEqual({ ok: true });
    expect(attempted).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
  });
  it('acknowledges an optional final-form warning on a separate guarded action', () => {
    document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input id="confirmed_limit_message" name="confirmed_limit_message" type="checkbox" value="1">');
    expect(isolated({ ...request, testMode: false })).toEqual({ ok: false });
    expect(isolated({ ...request, action: 'acknowledge' })).toEqual({ ok: true });
    expect(submit).not.toHaveBeenCalled();
    expect(isolated({ ...request, testMode: false })).toEqual({ ok: true });
  });
  it('refuses the final submit click in Test Mode and never opens a confirmation dialog', () => {
    expect(isolated(request)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
    expect(isolated({ ...request, action: 'confirm' })).toEqual({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
  });
  it('refuses a direct Test Mode submit bypass with or without the explicit gate', () => {
    document.querySelector('#appointments_submit')!.removeAttribute('data-confirm');
    expect(isolated(request)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    document.querySelector('#appointments_submit')!.setAttribute('data-confirm', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', ok: 'Confirm', cancel: 'Cancel' }));
    expect(isolated(request)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
  });
  it.each(['initial', 'reschedule'])('confirms an eligible %s form only with Test Mode explicitly off', kind => {
    dialog();
    expect(isolated({ ...request, action: 'confirm', testMode: false,
      currentDate: kind === 'initial' ? null : request.currentDate,
      currentDateTag: kind === 'initial' ? 'unbooked' : 'booked' })).toEqual({ ok: true });
    expect(confirm).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'no-calendar', 'offsite-target', 'wrong-group', 'missing-applicant', 'body-subset', 'wrong-facility', 'wrong-date', 'wrong-time', 'out-of-window', 'not-earlier', 'override'])('refuses submit without mutation (%s)', issue => {
    let args = { ...request, testMode: false as const };
    const button = document.querySelector<HTMLInputElement>('#appointments_submit')!;
    if (issue === 'disabled') button.disabled = true;
    if (issue === 'no-calendar') document.querySelector('#appointments_consulate_appointment_date')!.removeAttribute('data-usvisa-calendar-slot');
    if (issue === 'offsite-target') document.querySelector('form')!.action = 'https://example.invalid/login';
    if (issue === 'wrong-group') vi.stubGlobal('location', { href: BASE.replace('11111111', '99999999') });
    if (issue === 'missing-applicant') vi.stubGlobal('location', { href: `${BASE}?applicants[]=77777777` });
    if (issue === 'body-subset') document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input type="hidden" name="applicants[]" value="77777777">');
    if (issue === 'wrong-facility') args.facilityId = 94;
    if (issue === 'wrong-date') args.date = '2026-11-20';
    if (issue === 'wrong-time') args.time = '09:00';
    if (issue === 'out-of-window') args.latest = '2026-11-18';
    if (issue === 'not-earlier') args.currentDate = args.date;
    if (issue === 'override') button.setAttribute('formaction', 'https://example.invalid');
    expect(isolated(args)).toEqual({ ok: false });
    expect(submit).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it.each(['missing', 'duplicate', 'hidden', 'unrelated-title', 'unrelated-label', 'unsafe-link', 'changed-field'])('refuses an uncertain final dialog (%s)', issue => {
    if (issue !== 'missing') dialog();
    if (issue === 'duplicate') dialog();
    if (issue === 'hidden') document.querySelector<HTMLElement>('.reveal-overlay')!.style.display = 'none';
    if (issue === 'unrelated-title') document.querySelector('h4')!.textContent = 'Remove applicant?';
    if (issue === 'unrelated-label') document.querySelector('a')!.textContent = 'Delete';
    if (issue === 'unsafe-link') document.querySelector('a')!.href = 'https://example.invalid';
    if (issue === 'changed-field') document.querySelector<HTMLInputElement>('#appointments_consulate_appointment_date')!.value = '2027-02-01';
    expect(isolated({ ...request, action: 'confirm', testMode: false })).toEqual({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
  });
  it('clicks a validated live submit directly with an absent gate while leaving the native POST unblocked', () => {
    const button = document.querySelector<HTMLInputElement>('#appointments_submit')!;
    button.removeAttribute('data-confirm');
    const form = document.querySelector('form')!;
    form.onsubmit = null;
    const observed = vi.fn((event: Event) => { expect(event.defaultPrevented).toBe(false); });
    form.addEventListener('submit', observed);
    // Keep jsdom quiet after the observation: the native POST proceeds
    // unblocked (observed above), then this second listener cancels the
    // synthetic navigation only.
    form.addEventListener('submit', event => { event.preventDefault(); });
    // jsdom has no navigation: the click still fires and the native submit
    // event proceeds unblocked (no synthetic navigation is asserted here).
    expect(isolated({ ...request, testMode: false })).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalled();
    expect(observed).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
  });
  it.each([
    ['bad-json', '{not-json'],
    ['null', 'null'],
    ['empty-title', JSON.stringify({ title: '', ok: 'Confirm', cancel: 'Cancel' })],
    ['whitespace-title', JSON.stringify({ title: '   ', ok: 'Confirm', cancel: 'Cancel' })],
    ['html-empty-title', JSON.stringify({ title: '<h4>   </h4>', ok: 'Confirm', cancel: 'Cancel' })],
    ['missing-ok', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', cancel: 'Cancel' })],
    ['empty-ok', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', ok: '  ', cancel: 'Cancel' })],
    ['missing-cancel', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', ok: 'Confirm' })],
    ['empty-cancel', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', ok: 'Confirm', cancel: '' })],
  ])('refuses a live submit without clicking when the gate is present-but-malformed (%s)', (_label, gate) => {
    document.querySelector<HTMLInputElement>('#appointments_submit')!.setAttribute('data-confirm', gate);
    const form = document.querySelector('form')!;
    form.onsubmit = null;
    const observed = vi.fn();
    form.addEventListener('submit', observed);
    expect(isolated({ ...request, testMode: false })).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
  });
  it.each(['absent', 'malformed'])('still refuses a direct submit click in Test Mode with a %s gate', gate => {
    const button = document.querySelector<HTMLInputElement>('#appointments_submit')!;
    if (gate === 'absent') button.removeAttribute('data-confirm');
    else button.setAttribute('data-confirm', JSON.stringify({ title: '', ok: 'Confirm', cancel: 'Cancel' }));
    expect(isolated(request)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
  });
  it('never confirms a dialog without a valid gate, even when one is visible', () => {
    document.querySelector('#appointments_submit')!.removeAttribute('data-confirm');
    dialog();
    expect(isolated({ ...request, action: 'confirm', testMode: false })).toEqual({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
  });
  it('clicks a validated unbooked initial submit directly when currentDate is explicit null with an unbooked tag', () => {
    document.querySelector('#appointments_submit')!.removeAttribute('data-confirm');
    const form = document.querySelector('form')!;
    form.onsubmit = null;
    form.addEventListener('submit', event => { event.preventDefault(); });
    expect(isolated({ ...request, testMode: false, currentDate: null, currentDateTag: 'unbooked' })).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it('clicks a transported unbooked submit where the null key was dropped but the unbooked tag survives', () => {
    // Real chrome.scripting.executeScript drops null-valued keys, so
    // {currentDate: null, currentDateTag: 'unbooked'} arrives as
    // {currentDateTag: 'unbooked'} (see packaged null-baseline probe). The
    // explicit tag authorizes the unbooked baseline; missing alone never does.
    document.querySelector('#appointments_submit')!.removeAttribute('data-confirm');
    const form = document.querySelector('form')!;
    form.onsubmit = null;
    form.addEventListener('submit', event => { event.preventDefault(); });
    const transported = { ...request, testMode: false as const, currentDateTag: 'unbooked' as const };
    delete (transported as Record<string, unknown>).currentDate;
    expect(isolated(transported as unknown as SubmissionRequest)).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalled();
  });
  it.each([
    ['missing-tag', { currentDateTag: undefined }, false],
    ['invalid-tag', { currentDateTag: 'maybe' }, false],
    ['booked-tag-missing-date', { currentDateTag: 'booked' }, true],
    ['booked-tag-null-date', { currentDate: null, currentDateTag: 'booked' }, false],
    ['unbooked-tag-with-date', { currentDate: '2027-01-01', currentDateTag: 'unbooked' }, false],
    ['missing-key-booked-tag', {}, true],
    ['undefined-booked-tag', { currentDate: undefined }, false],
    ['null-string', { currentDate: 'null' }, false],
    ['malformed-date', { currentDate: 'not-a-date' }, false],
    ['numeric', { currentDate: 0 }, false],
  ] as const)(
    'refuses a live submit when the baseline/tag is %s instead of explicit tagged null/ISO', (_label, override, deleteKey) => {
      document.querySelector('#appointments_submit')!.removeAttribute('data-confirm');
      const form = document.querySelector('form')!;
      form.onsubmit = null;
      form.addEventListener('submit', event => { event.preventDefault(); });
      const args = { ...request, testMode: false as const, ...override } as unknown as SubmissionRequest;
      if (deleteKey) delete (args as Record<string, unknown>).currentDate;
      if (_label === 'missing-tag') delete (args as Record<string, unknown>).currentDateTag;
      expect(isolated(args)).toEqual({ ok: false });
      expect(clicked).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });
  it('refuses a live submit when an unrelated dialog is already open', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="reveal-overlay"><div data-reveal><h4>Unrelated notice</h4></div></div>');
    expect(isolated({ ...request, testMode: false })).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
