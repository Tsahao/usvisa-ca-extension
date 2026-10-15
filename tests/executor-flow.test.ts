// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBookingStage, type ExecDeps } from '../src/engine/executor';
import { bindGroup, emptyEngineState, startRun, validateEngineState } from '../src/engine/workflow';
import { recordCandidate, setStage } from '../src/engine/poll';
import { installPortalCalendar } from './fixtures/portal-calendar';

const NOW = '2026-10-12T00:00:00.000Z';
const BASE = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
const ids = ['77777777', '88888888'];
afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { jQuery?: unknown }).jQuery; });

describe('synthetic paid flow with serialized page adapters', () => {
  it.each([
    { initial: false, single: false, skipWarning: false, drop: false, blankTimes: false },
    { initial: false, single: false, skipWarning: false, drop: true, blankTimes: false },
    { initial: true, single: false, skipWarning: true, drop: false, blankTimes: true },
    { initial: false, single: true, skipWarning: false, drop: false, blankTimes: true },
    { initial: true, single: true, skipWarning: true, drop: false, blankTimes: true },
    { initial: true, single: true, skipWarning: true, drop: false, blankTimes: true, bare: true },
    { initial: true, single: true, skipWarning: true, drop: false, blankTimes: true, bare: true, changedRoster: true },
    { initial: false, single: true, skipWarning: false, drop: false, blankTimes: true, bare: true },
    { initial: false, single: true, skipWarning: false, drop: false, blankTimes: true, bare: true, changedRoster: true },
    { initial: false, single: true, skipWarning: false, drop: false, blankTimes: true, bare: true, changedDate: true },
  ])('shares the guarded form flow across paid entry variants (%j)', async ({ initial, single, skipWarning, drop, blankTimes, bare = false, changedRoster = false, changedDate = false }) => {
    const roster = single ? ids.slice(0, 1) : ids;
    const submit = vi.fn();
    const applicantChanged = vi.fn();
    const render = (stage: string) => {
      let query = '';
      if (stage === 'applicants') query = '?confirmed_limit_message=1';
      if (stage === 'form' && !bare) query = `?${(drop ? roster.slice(0, 1) : roster).map(id => `applicants[]=${id}`).join('&')}`;
      vi.stubGlobal('location', { href: `${BASE}/${stage === 'actions' ? 'continue_actions' : 'appointment'}${query}` });
      if (stage === 'actions') {
        const label = initial ? 'Schedule Appointment' : 'Reschedule Appointment';
        document.body.innerHTML = `<a class="accordion-title" role="tab" aria-expanded="false" aria-controls="gateway-content"><h5>${label}</h5></a>
          <div id="gateway-content" hidden><a href="${BASE}/appointment">${label}</a></div>`;
        document.querySelector('a')!.onclick = event => { (event.currentTarget as HTMLElement).setAttribute('aria-expanded', 'true'); document.querySelector('div')!.hidden = false; };
        document.querySelectorAll('a')[1].onclick = event => { event.preventDefault(); render(skipWarning ? single ? 'form' : 'applicants' : 'warning'); };
      } else if (stage === 'warning') {
        document.body.innerHTML = `<form method="get" action="${BASE}/appointment"><input type="checkbox" id="confirmed_limit_message" name="confirmed_limit_message" value="1">
          <input type="submit" name="commit" value="Continue"></form>`;
        document.querySelector('form')!.onsubmit = event => { event.preventDefault(); render(single ? 'form' : 'applicants'); };
      } else if (stage === 'applicants') {
        document.body.innerHTML = `<form method="get" action="${BASE}/appointment">${roster.map(id => `<input type="checkbox" name="applicants[]" value="${id}" checked>`).join('')}<input type="submit" name="commit" value="Continue"></form>`;
        document.querySelectorAll('input[type="checkbox"]').forEach(box => { box.addEventListener('click', applicantChanged); box.addEventListener('change', applicantChanged); });
        document.querySelector('form')!.onsubmit = event => { event.preventDefault(); render('form'); };
      } else {
        document.body.innerHTML = `${bare ? `<form id="appointment-form" action="${BASE}/appointment" method="post"><input name="confirmed_limit_message" type="hidden" value="1">` : ''}<select id="appointments_consulate_appointment_facility_id"><option value="94">Toronto</option><option value="95">Vancouver</option></select>
          <input id="appointments_consulate_appointment_date" type="text" readonly>
          <select id="appointments_consulate_appointment_time"><option value="">Select</option></select>
          <button id="appointments_submit">Submit</button><button id="final-confirm">Confirm</button>${bare ? '</form>' : ''}`;
        installPortalCalendar();
        document.querySelectorAll('button').forEach(button => button.onclick = submit);
      }
    };
    render('actions');
    const fetch = vi.fn(async (url: string) => ({ status: 200, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555', json: async () => ({ available_times: ['10:30', '09:15'] }),
      text: async () => `<section><strong>22222222</strong>${initial ? `<div class="ready_to_schedule"><a href="${BASE}/addresses/delivery">Delivery</a></div>` : `<p class="consular-appt">${changedDate ? 'December 1, 2026' : 'January 1, 2027'} <a href="${BASE}/appointment">Reschedule</a></p>`}
      <table><tbody>${(changedRoster ? ids : roster).map(id => `<tr><td>Synthetic applicant</td><td><a href="${BASE}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>` }));
    vi.stubGlobal('fetch', fetch);
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
    let state = setStage(bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), {
      ...args, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: initial ? null : '2027-01-01', applicantIds: roster,
        ...(bare ? { dashboardPath: '/en-ca/niv/groups/55555555' } : {}) },
    }), 'actions', NOW);
    const d: ExecDeps = {
      nowIso: () => NOW, random: () => 0,
      queryTabs: async () => [{ id: 7, url: location.href }], getTab: async () => ({ id: 7, url: location.href }),
      createTab: async () => { throw new Error('Unexpected navigation'); },
      loadPrefs: async () => ({ consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: true }),
      saveState: async checkpoint => { state = validateEngineState(JSON.parse(JSON.stringify(checkpoint))); },
      inject: async (_tab, func, parameters) => {
        if (func.name === 'performPaidAction') expect(state.executor?.actionPending).toBe(true);
        const isolated = new Function(`return (${func.toString()})`)();
        return isolated(...parameters ?? []);
      },
    };
    let cycles = 0;
    while (state.status === 'running' && cycles++ < 12) {
      state = validateEngineState(JSON.parse(JSON.stringify(await runBookingStage(d, state))));
      if (state.status === 'running' && state.stage === null) {
        expect(state.lastCandidate).toBeNull();
        if (!bare) expect(fetch).not.toHaveBeenCalled();
        expect(document.querySelector<HTMLInputElement>('#appointments_consulate_appointment_date')!.value).toBe('');
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('94');
        state = setStage(recordCandidate(state, '2026-11-19', NOW), 'form', NOW);
      }
    }
    expect(cycles).toBeLessThan(12);
    expect(state.status).toBe('verifying');
    expect(state.executor?.applicantIds).toEqual(roster);
    expect(submit).not.toHaveBeenCalled();
    expect(applicantChanged).not.toHaveBeenCalled();
    // Test Mode never clicks the final submit and never opens a dialog, with
    // or without a data-confirm gate, so no booking intent is recorded.
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
    if (drop || changedRoster || changedDate) {
      expect(state.intent).toBeNull();
      if (drop) expect(fetch).not.toHaveBeenCalled();
      else expect(fetch.mock.calls.every(([url]) => !url.includes('/times/'))).toBe(true);
      expect((document.querySelector('select') as HTMLSelectElement).value).toBe('94');
    } else {
      expect(state.stage).toBe('done');
      expect(state.intent).toBeNull();
      expect(state.verification).toBeNull();
      expect(state.executor?.targetTime).toBe('09:15');
      if (bare) expect(fetch.mock.calls.filter(([url]) => url.includes('/times/'))).toHaveLength(1);
      else expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
});
