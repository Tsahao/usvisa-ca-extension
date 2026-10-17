// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performPaidAction } from '../src/adapter/acts';
import { runBookingStage } from '../src/engine/executor';
import { bindGroup, emptyEngineState, startRun } from '../src/engine/workflow';

const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
const act: typeof performPaidAction = new Function(`return (${performPaidAction.toString()})`)();
afterEach(() => vi.unstubAllGlobals());

describe('gateway mutations stay read-only navigation', () => {
  it('still refuses a second GET entry to the appointment endpoint with different copy', async () => {
    vi.stubGlobal('location', { href: `${base}/continue_actions` });
    document.body.innerHTML = `<a class="accordion-title" aria-expanded="false">Reschedule Appointment</a>
      <a href="${base}/appointment">Reschedule Appointment</a>
      <a href="${base}/appointment">Cancel Appointment</a>`;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll('a').forEach(control => control.addEventListener('click', clicked));
    expect((await act({ action: 'reschedule', scheduleId: '11111111' })).ok).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });
  it.each(['post', 'override', 'data-method', 'new-window'])('rejects an unsafe reschedule entry before even expanding (%s)', async issue => {
    vi.stubGlobal('location', { href: `${base}/continue_actions` });
    const entry = issue === 'data-method' || issue === 'new-window'
      ? `<a href="${base}/appointment" ${issue === 'data-method' ? 'data-method="post"' : 'target="_blank"'}>Reschedule Appointment</a>`
      : `<form method="${issue === 'post' ? 'post' : 'get'}" action="${base}/appointment"><input type="submit" ${issue === 'override' ? 'formmethod="post"' : ''} value="Reschedule Appointment"></form>`;
    document.body.innerHTML = `<button type="button" aria-expanded="false">Reschedule Appointment</button>${entry}`;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll('button, input, a').forEach(control => control.addEventListener('click', clicked));
    expect((await act({ action: 'reschedule', scheduleId: '11111111' })).ok).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });

  it.each(['warning', 'applicants'] as const)('rejects effective POST overrides for %s without ticking anything', async action => {
    vi.stubGlobal('location', { href: `${base}/appointment${action === 'applicants' ? '?confirmed_limit_message=1' : ''}` });
    document.body.innerHTML = `<form method="get" action="${base}/appointment">${action === 'warning'
      ? '<input type="checkbox" name="confirmed_limit_message" id="confirmed_limit_message" value="1">'
      : '<input type="checkbox" name="applicants[]" value="77777777" checked>'}<input type="submit" formmethod="post" value="Continue"></form>`;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll('input').forEach(control => control.addEventListener('click', clicked));
    expect((await act({ action, scheduleId: '11111111', applicantIds: ['77777777'] })).ok).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });

  it('never submits the unexpected gateway POST through the real Test Mode executor', async () => {
    vi.stubGlobal('location', { href: `${base}/continue_actions` });
    document.body.innerHTML = `<button type="button" aria-expanded="true">Reschedule Appointment</button>
      <form method="post" action="${base}/appointment"><input type="submit" value="Reschedule Appointment"></form>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')!.addEventListener('submit', submitted);
    const now = new Date().toISOString();
    const args = { owner: 'owner-token-01', runId: 'run-id-0001', now };
    const state = { ...bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
      binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-06-21', applicantIds: ['77777777'] } }),
      stage: 'actions', executor: { tabId: 7, applicantIds: ['77777777'], targetTime: null, skippedDates: [], actionPending: false } };
    const next = await runBookingStage({ nowIso: () => now, random: () => 0,
      queryTabs: async () => [], createTab: async () => ({}), getTab: async () => ({ id: 7, url: `${base}/continue_actions` }),
      loadPrefs: async () => ({ consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: true }),
      saveState: async () => {}, inject: async (_id, func, args) => func(...args as never[]) }, state);
    expect(submitted).not.toHaveBeenCalled();
    expect(next.status).toBe('verifying');
    expect(next.intent).toBeNull();
  });
});
