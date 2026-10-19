// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPaidPage } from '../src/adapter/paid';
import { performPaidAction } from '../src/adapter/acts';
import { fetchTimesJson } from '../src/adapter/poll';
import { performAppointmentSubmission } from '../src/adapter/confirmation';
import { installPortalCalendar } from './fixtures/portal-calendar';

const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
const id = '77777777';
const read: typeof readPaidPage = new Function(`return (${readPaidPage.toString()})`)();
const act: typeof performPaidAction = new Function(`return (${performPaidAction.toString()})`)();
const times: typeof fetchTimesJson = new Function(`return (${fetchTimesJson.toString()})`)();
const submit: typeof performAppointmentSubmission = new Function(`return (${performAppointmentSubmission.toString()})`)();
const request = { scheduleId: '11111111', applicantIds: [id], implicitApplicantId: id, facilityId: 95,
  date: '2026-11-19', time: '08:00' };
const fetch = vi.fn(async () => ({ status: 200, json: async () => ({ available_times: ['08:00'] }) }));
const posted = vi.fn();
beforeEach(() => {
  vi.stubGlobal('location', { href: base });
  vi.stubGlobal('fetch', fetch); fetch.mockClear(); posted.mockClear();
  document.body.innerHTML = `<form id="appointment-form" method="post" action="${base}">
    <input type="hidden" id="confirmed_limit_message" name="confirmed_limit_message" value="1">
    <select id="appointments_consulate_appointment_facility_id"><option value="94">Toronto</option><option value="95">Vancouver</option></select>
    <input id="appointments_consulate_appointment_date" readonly>
    <select id="appointments_consulate_appointment_time"><option value=""></option><option value="08:00">08:00</option></select>
    <input type="submit" id="appointments_submit" name="commit" value="Schedule Appointment">
  </form>`;
  document.querySelector('form')!.onsubmit = event => { event.preventDefault(); posted(); };
  installPortalCalendar({ times: ['08:00'] });
});
afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { jQuery?: unknown }).jQuery; });

describe('serialized paid form without applicant query or fields', () => {
  it('requires an explicit independent sole-applicant binding before reading, changing fields or fetching times', async () => {
    expect(read('11111111')).toBeNull();
    expect((await act({ ...request, implicitApplicantId: undefined, action: 'facility' })).ok).toBe(false);
    expect(await times('/en-ca/niv/schedule/11111111/appointment', 95, request.date, [id])).toEqual({ status: 0, body: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(read('11111111', id)).toMatchObject({ kind: 'form', applicantIds: [id], warningAcknowledged: true });
    for (const action of ['facility', 'date', 'time'] as const) expect((await act({ ...request, action })).ok).toBe(true);
    expect(await times('/en-ca/niv/schedule/11111111/appointment', 95, request.date, [id], id)).toMatchObject({ status: 200 });
    expect(read('11111111', id)).toMatchObject({ applicantIds: [id], facilityId: 95, date: request.date, time: request.time });
    expect(posted).not.toHaveBeenCalled();
  });
  it.each(['offsite', 'wrong-group', 'query', 'wrong-target', 'get-form', 'duplicate-form', 'duplicate-field', 'detached-field', 'body-id'])('refuses ambiguous or conflicting bare forms before fields and times (%s)', async issue => {
    if (issue === 'offsite') vi.stubGlobal('location', { href: base.replace('ais.usvisa-info.com', 'example.invalid') });
    if (issue === 'wrong-group') vi.stubGlobal('location', { href: base.replace('11111111', '99999999') });
    if (issue === 'query') vi.stubGlobal('location', { href: base + '?other=1' });
    if (issue === 'wrong-target') document.querySelector('form')!.action = base.replace('11111111', '99999999');
    if (issue === 'get-form') document.querySelector('form')!.method = 'get';
    if (issue === 'duplicate-form') document.body.insertAdjacentHTML('beforeend', '<form id="appointment-form"></form>');
    if (issue === 'duplicate-field') document.body.insertAdjacentHTML('beforeend', '<input id="appointments_consulate_appointment_date">');
    if (issue === 'detached-field') document.body.append(document.querySelector('#appointments_consulate_appointment_time')!);
    if (issue === 'body-id') document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input name="applicants[]" type="hidden" value="88888888">');
    expect(read('11111111', id)).toBeNull();
    expect((await act({ ...request, action: 'facility' })).ok).toBe(false);
    expect(await times('/en-ca/niv/schedule/11111111/appointment', 95, request.date, [id], id)).toEqual({ status: 0, body: null });
    expect(fetch).not.toHaveBeenCalled(); expect(posted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLSelectElement>('#appointments_consulate_appointment_facility_id')!.value).toBe('94');
  });
  it('refuses to apply the implicit binding to multiple or different applicants', async () => {
    for (const applicantIds of [[id, '88888888'], ['88888888']]) {
      expect((await act({ ...request, applicantIds, action: 'facility' })).ok).toBe(false);
      expect(await times('/en-ca/niv/schedule/11111111/appointment', 95, request.date, applicantIds, id)).toEqual({ status: 0, body: null });
    }
    expect(fetch).not.toHaveBeenCalled(); expect(posted).not.toHaveBeenCalled();
  });
  it('revalidates the bare form roster after a times response', async () => {
    fetch.mockImplementationOnce(async () => {
      document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input name="applicants[]" value="88888888">');
      return { status: 200, json: async () => ({ available_times: ['08:00'] }) };
    });
    expect(await times('/en-ca/niv/schedule/11111111/appointment', 95, request.date, [id], id)).toEqual({ status: 0, body: null });
  });
  it('refuses the final submit click in Test Mode on a bare initial form, even with an explicit gate', async () => {
    const clicked = vi.fn();
    document.querySelector('#appointments_submit')!.addEventListener('click', clicked);
    for (const action of ['facility', 'date', 'time'] as const) expect((await act({ ...request, action })).ok).toBe(true);
    const args = { ...request, action: 'submit' as const, earliest: '2026-11-01', latest: '2026-12-31', currentDate: null, currentDateTag: 'unbooked' as const, onlyEarlier: true, testMode: true };
    expect(submit(args)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
    document.querySelector('#appointments_submit')!.setAttribute('data-confirm', JSON.stringify({ title: 'Synthetic initial confirmation', ok: 'Confirm', cancel: 'Cancel' }));
    expect(submit({ ...args, implicitApplicantId: undefined })).toEqual({ ok: false });
    document.querySelector('form')!.action = base + '?other=1';
    expect(submit(args)).toEqual({ ok: false });
    document.querySelector('form')!.action = base;
    // Even with a well-formed gate, Test Mode never clicks the final submit
    // and never opens a confirmation dialog.
    expect(submit(args)).toEqual({ ok: false });
    expect(posted).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
    expect(submit({ ...args, action: 'confirm' })).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    // Live mode retains the guarded gate-opening click for the same form.
    expect(submit({ ...args, testMode: false })).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalledOnce();
    expect(posted).toHaveBeenCalledOnce();
  });
  it('enforces the earlier-only policy and dialog guard for a scheduled bare single-applicant form', async () => {
    for (const action of ['facility', 'date', 'time'] as const) expect((await act({ ...request, action })).ok).toBe(true);
    document.querySelector('#appointments_submit')!.setAttribute('data-confirm', JSON.stringify({ title: 'Synthetic reschedule confirmation', ok: 'Confirm', cancel: 'Cancel' }));
    const args = { ...request, action: 'submit' as const, earliest: '2026-11-01', latest: '2026-12-31', currentDate: '2027-01-01', currentDateTag: 'booked' as const, onlyEarlier: true, testMode: false };
    expect(submit({ ...args, currentDate: request.date })).toEqual({ ok: false });
    expect(submit({ ...args, currentDate: '2026-11-18' })).toEqual({ ok: false });
    expect(posted).not.toHaveBeenCalled();
    expect(submit(args)).toEqual({ ok: true });
    expect(posted).toHaveBeenCalledOnce();
    document.body.insertAdjacentHTML('beforeend', '<div class="reveal-overlay"><div data-reveal><h4>Synthetic reschedule confirmation</h4><a class="button alert" href="#">Confirm</a></div></div>');
    const confirmed = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('.button.alert')!.addEventListener('click', confirmed);
    expect(submit({ ...args, action: 'confirm', testMode: true })).toEqual({ ok: false });
    expect(submit({ ...args, action: 'confirm', currentDate: request.date })).toEqual({ ok: false });
    expect(confirmed).not.toHaveBeenCalled();
    expect(submit({ ...args, action: 'confirm' })).toEqual({ ok: true });
    expect(confirmed).toHaveBeenCalledOnce();
  });
});

describe('sole-applicant form reached through the acknowledged warning', () => {
  // A single-applicant group skips the applicant picker: acknowledging the
  // limit warning submits a GET form that lands on the booking form with only
  // the acknowledgement parameters in the query, never applicants[].
  const acknowledged = base + '?confirmed_limit_message=1&commit=Continue';
  const repeated = ['?confirmed_limit_message=1&confirmed_limit_message=1&commit=Continue', '?confirmed_limit_message=1&commit=Continue&commit=Continue'];
  it('reads, edits and fetches times on the acknowledged bare form with the implicit binding', async () => {
    vi.stubGlobal('location', { href: acknowledged });
    expect(read('11111111')).toBeNull();
    expect(read('11111111', id)).toMatchObject({ kind: 'form', applicantIds: [id], warningAcknowledged: true });
    for (const action of ['facility', 'date', 'time'] as const) expect((await act({ ...request, action })).ok).toBe(true);
    expect(await times('/en-ca/niv/schedule/11111111/appointment', 95, request.date, [id], id)).toMatchObject({ status: 200 });
    expect(read('11111111', id)).toMatchObject({ applicantIds: [id], facilityId: 95, date: request.date, time: request.time });
    expect(posted).not.toHaveBeenCalled();
  });
  it('submits on the acknowledged bare form with the implicit binding', async () => {
    vi.stubGlobal('location', { href: acknowledged });
    const clicked = vi.fn();
    document.querySelector('#appointments_submit')!.addEventListener('click', clicked);
    for (const action of ['facility', 'date', 'time'] as const) expect((await act({ ...request, action })).ok).toBe(true);
    const args = { ...request, action: 'submit' as const, earliest: '2026-11-01', latest: '2026-12-31', currentDate: null, currentDateTag: 'unbooked' as const, onlyEarlier: true, testMode: true };
    document.querySelector('#appointments_submit')!.setAttribute('data-confirm', JSON.stringify({ title: 'Synthetic initial confirmation', ok: 'Confirm', cancel: 'Cancel' }));
    expect(submit({ ...args, implicitApplicantId: undefined })).toEqual({ ok: false });
    // Test Mode never clicks the final submit on the acknowledged form either.
    expect(submit(args)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
    for (const query of repeated) {
      vi.stubGlobal('location', { href: base + query });
      expect(submit({ ...args, testMode: false })).toEqual({ ok: false });
    }
    expect(clicked).not.toHaveBeenCalled();
    vi.stubGlobal('location', { href: acknowledged });
    expect(submit({ ...args, testMode: false })).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalledOnce();
    expect(posted).toHaveBeenCalledOnce();
  });
  it.each(['?confirmed_limit_message=0&commit=Continue', '?confirmed_limit_message=1&other=1', ...repeated])('still refuses any other query on the bare form (%s)', async query => {
    vi.stubGlobal('location', { href: base + query });
    expect(read('11111111', id)).toBeNull();
    expect((await act({ ...request, action: 'facility' })).ok).toBe(false);
    expect(await times('/en-ca/niv/schedule/11111111/appointment', 95, request.date, [id], id)).toEqual({ status: 0, body: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});
