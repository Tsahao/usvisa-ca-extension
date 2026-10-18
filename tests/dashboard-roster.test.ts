// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCurrentAppointment, readDashboardGroups } from '../src/adapter/reads';
import { resolveGroup } from '../src/domain/groups';

const base = '/en-ca/niv/schedule/11111111';
const ids = ['77777777', '88888888'];
const serialized: typeof readCurrentAppointment = new Function(`return (${readCurrentAppointment.toString()})`)();
const row = (id: string) => `<tr><td>Synthetic applicant</td><td><a href="${base}/applicants/${id}">Details</a>
  <a href="${base}/applicants/${id}/edit">Edit</a><a data-method="delete" href="${base}/applicants/${id}">Remove</a></td></tr>`;
const dashboard = (rows: string, booked = true) => {
  vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
  document.body.innerHTML = `<section><div><strong>22222222</strong><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul></div>
    ${booked ? `<p class="consular-appt">January 1, 2027 <a href="${base}/appointment">Reschedule</a></p>` : `<div class="ready_to_schedule"><p class="delivery"><a href="${base}/addresses/delivery">Delivery</a></p></div>`}
    <table><thead><tr><th>Applicants</th></tr></thead><tbody>${rows}</tbody></table></section>`;
};
afterEach(() => vi.unstubAllGlobals());

describe('independent dashboard applicant roster', () => {
  it('discovers an archived applicant-only card without blocking default rescheduling', async () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    document.body.innerHTML = `<div class="application attend_appointment card success">
      <ul class="actions"><a href="${base}/continue_actions">Continue</a></ul>
      <p class="consular-appt">January 1, 2027 <a href="${base}/addresses/consulate">view map</a></p>
      <table><tbody>${ids.map(row).join('')}</tbody></table>
      <div>IVR Account Number: <strong>22222222</strong></div>
    </div><div class="alert application card needs_payment">
      <h4 class="status"><small>Current Status</small><br>Pay Visa Fee</h4>
      <ul class="actions"><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></ul>
      <strong>44444444</strong>
    </div><div class="application card needs_courier_in success">
      <ul class="actions"><a href="/en-ca/niv/schedule/55555555/continue_actions">Continue</a></ul>
      <strong>66666666</strong>
    </div><div class="application archived card">
      <table><tbody><tr><td><a href="/en-ca/niv/schedule/99999999/applicants/12345678">Details</a></td></tr></tbody></table>
      <div>IVR Account Number: <strong>87654321</strong></div>
    </div>`;
    const readGroups: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    const snapshot = readGroups();
    expect(snapshot.groups).toEqual([
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid', continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentConflict: false },
      { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid', continuePath: '/en-ca/niv/schedule/33333333/continue_actions', paymentConflict: false },
      { scheduleId: '55555555', ivr: '66666666', paymentStatus: 'unknown', continuePath: '/en-ca/niv/schedule/55555555/continue_actions', paymentConflict: false },
      { scheduleId: '99999999', ivr: '87654321', paymentStatus: 'unknown', continuePath: null, paymentConflict: false },
    ]);
    expect(resolveGroup(snapshot, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid', inspectionRequired: false });
    expect(resolveGroup(snapshot, { mode: 'alerts', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid', inspectionRequired: false });
    expect(await serialized('11111111', '22222222', false, true))
      .toMatchObject({ kind: 'booked', text: 'January 1, 2027 view map', applicantIds: ids });
  });
  it.each([false, true])('reads a booked card whose appointment link is a consulate map (%s)', async fresh => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    const html = `<div class="application appointment card">
      <p class="consular-appt">January 1, 2027 <a href="${base}/addresses/consulate">view map</a></p>
      <table><tbody>${ids.map(row).join('')}</tbody></table>
      <div>IVR Account Number: <strong>22222222</strong></div>
    </div><div class="application card needs_payment">
      <h4 class="status"><small>Current Status</small><br>Pay Visa Fee</h4>
      <ul class="actions"><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></ul>
      <strong>44444444</strong>
    </div>`;
    document.body.innerHTML = html;
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => html })));
    const readGroups: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    expect(readGroups()).toEqual({ groups: [
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid', continuePath: null, paymentConflict: false },
      { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid', continuePath: '/en-ca/niv/schedule/33333333/continue_actions', paymentConflict: false },
    ] });
    expect(await serialized('11111111', '22222222', fresh, true, '/en-ca/niv/groups/55555555'))
      .toEqual({ scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027 view map', applicantIds: ids });
  });
  it.each([true, false])('retains all Details identities for booked or explicitly unbooked groups (%s)', async booked => {
    dashboard(ids.map(row).join(''), booked);
    const reading = await serialized('11111111', '22222222', false, true);
    expect(reading).toMatchObject({ applicantIds: ids, kind: booked ? 'booked' : 'unbooked' });
    expect(reading.text === null).toBe(!booked);
    expect(readDashboardGroups()).toEqual({ groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'unknown', continuePath: null, paymentConflict: false }] });
  });
  it('recognizes the selected card itself as explicitly unscheduled beside a historical appointment', async () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    document.body.innerHTML = `<div class="row"><div class="medium-12 column">
      <div class="alert application card ready_to_schedule">
        <div class="row"><div><h4>Current Status Schedule Appointment</h4></div>
          <div><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul></div></div>
        <p class="delivery"><a href="${base}/addresses/delivery">Delivery</a></p>
        <table><tbody>${row(ids[0])}</tbody></table><div>IVR Account Number: <strong>22222222</strong></div>
      </div>
      <div class="application appointment card secondary"><strong>44444444</strong>
        <ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul>
        <p class="consular-appt">September 22, 2025 <a href="/en-ca/niv/schedule/33333333/addresses/consulate">Directions</a></p>
        <table><tbody><tr><td>Historical synthetic applicant</td><td><a href="/en-ca/niv/schedule/33333333/applicants/99999999">Details</a></td></tr></tbody></table>
      </div></div></div>`;
    expect(await serialized('11111111', '22222222', false, true)).toEqual({ scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: [ids[0]] });
    expect(readDashboardGroups()).toEqual({ groups: [
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid', continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentConflict: false },
      { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'paid', continuePath: '/en-ca/niv/schedule/33333333/continue_actions', paymentConflict: false },
    ] });
    document.querySelector('.ready_to_schedule')!.classList.remove('ready_to_schedule');
    document.querySelector('.secondary')!.classList.add('ready_to_schedule');
    await expect(serialized('11111111', '22222222', false, true)).rejects.toThrow('Unknown appointment state.');
  });
  it('establishes a single applicant independently of a booking-form URL', async () => {
    dashboard(row(ids[0]));
    expect((await serialized('11111111', '22222222', false, true)).applicantIds).toEqual([ids[0]]);
  });
  it.each([false, true])('keeps a deeply nested unscheduled card as the boundary for live and fresh reads (%s)', async fresh => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    const nested = (html: string) => '<div>'.repeat(6) + html + '</div>'.repeat(6);
    const html = nested(`<section class="application card ready_to_schedule"><strong>22222222</strong>
      ${nested(`<ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul>`)}
      <p class="delivery"><a href="${base}/addresses/delivery">Delivery</a></p>
      <table><tbody>${row(ids[0])}</tbody></table></section>`);
    document.body.innerHTML = html;
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => html })));
    expect(await serialized('11111111', '22222222', fresh, true, '/en-ca/niv/groups/55555555'))
      .toEqual({ scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: [ids[0]] });
  });
  it('does not borrow an unscheduled marker from another card with the same identity', async () => {
    dashboard(row(ids[0]), false);
    document.body.innerHTML = `<div>
      <section class="application card"><strong>22222222</strong><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><table><tbody>${row(ids[0])}</tbody></table></section>
      <section class="application card ready_to_schedule"><strong>22222222</strong><ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><table><tbody>${row(ids[0])}</tbody></table></section>
    </div>`;
    await expect(serialized('11111111', '22222222', false, true)).rejects.toThrow('Ambiguous appointment group.');
  });
  it.each(['missing-details', 'duplicate-person', 'wrong-group', 'offsite', 'second-table', 'remove-only'])('refuses incomplete or ambiguous roster markup (%s)', async issue => {
    dashboard(ids.map(row).join(''));
    const table = document.querySelector('table')!;
    if (issue === 'missing-details') table.querySelectorAll('tr')[2].innerHTML = '<td>Synthetic applicant without identity</td>';
    if (issue === 'duplicate-person') table.querySelector('tbody')!.innerHTML = row(ids[0]) + row(ids[0]);
    if (issue === 'wrong-group') table.querySelector('a')!.href = '/en-ca/niv/schedule/33333333/applicants/77777777';
    if (issue === 'offsite') table.querySelector('a')!.href = `https://example.invalid${base}/applicants/77777777`;
    if (issue === 'second-table') table.insertAdjacentHTML('afterend', `<table>${row('99999999')}</table>`);
    if (issue === 'remove-only') table.querySelectorAll('a:not([data-method])').forEach(link => link.remove());
    await expect(serialized('11111111', '22222222', false, true)).rejects.toThrow();
  });
  it('keeps neighboring groups out of the selected roster', async () => {
    dashboard(ids.map(row).join(''));
    document.body.insertAdjacentHTML('afterbegin', `<section><strong>44444444</strong><ul class="actions"><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></ul>
      <table><tr><td>Other synthetic applicant</td><td><a href="/en-ca/niv/schedule/33333333/applicants/99999999">Details</a></td></tr></table></section>`);
    expect((await serialized('11111111', '22222222', false, true)).applicantIds).toEqual(ids);
  });
});
