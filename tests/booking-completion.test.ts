// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBookingStage, type ExecDeps } from '../src/engine/executor';
import { bindGroup, emptyEngineState, reconcileStartup, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
import { runVerificationRead } from '../src/engine/verification';
import { readCurrentAppointment } from '../src/adapter/reads';
import { policyKey } from '../src/engine/lifecycle';

const BASE = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111';
const NOW = '2026-10-12T00:00:00.000Z';
const ids = ['77777777', '88888888'];
afterEach(() => vi.unstubAllGlobals());
function harness(testMode: boolean, initial = false, gate: true | false | string = true) {
  let clock = NOW;
  let booked = initial ? null : 'January 1, 2027';
  let cancelled = false;
  const checkpoints: EngineState[] = [];
  const submit = vi.fn(); const confirm = vi.fn();
  const prefs = { consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode };
  vi.stubGlobal('location', { href: `${BASE}/appointment?applicants[]=77777777&applicants[]=88888888` });
  document.body.innerHTML = `<form id="appointment-form" method="post" action="${BASE}/appointment">
    <select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select>
    <input id="appointments_consulate_appointment_date" readonly value="2026-11-19" data-usvisa-calendar-slot="95|2026-11-19">
    <select id="appointments_consulate_appointment_time"><option value="08:00">08:00</option></select>
    <input type="hidden" name="confirmed_limit_message" value="1">
    <input id="appointments_submit" type="submit" value="${initial ? 'Schedule' : 'Reschedule'}"></form>`;
  if (gate === true) document.querySelector('#appointments_submit')!.setAttribute('data-confirm', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', ok: 'Confirm', cancel: 'Cancel' }));
  else if (typeof gate === 'string') document.querySelector('#appointments_submit')!.setAttribute('data-confirm', gate);
  document.querySelector('form')!.onsubmit = event => {
    event.preventDefault(); submit();
    if (gate === false) { booked = 'November 19, 2026'; return; }
    if (gate !== true) return;
    document.body.insertAdjacentHTML('beforeend', '<div class="reveal-overlay"><div data-reveal><h4>Are you sure you want to reschedule the appointment?</h4><a class="button alert" href="#">Confirm</a></div></div>');
    document.querySelector('a')!.onclick = event => { event.preventDefault(); confirm(); booked = 'November 19, 2026'; };
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555', text: async () => `<section><strong>22222222</strong>${booked ? `<p class="consular-appt">${booked}<a href="${BASE}/appointment">Appointment</a></p>` : `<div class="ready_to_schedule"><a href="${BASE}/addresses/delivery">Delivery</a></div>`}<table><tbody>${ids.map(id => `<tr><td><a href="${BASE}/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table></section>` })));
  const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
  const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
    binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: initial ? null : '2027-01-01', applicantIds: ids } });
  const state: EngineState = { ...bound, stage: 'form', lastCandidate: '2026-11-19', policyKey: policyKey(prefs),
    executor: { tabId: 7, applicantIds: ids, targetTime: '08:00', actionPending: false, skippedDates: [] } };
  const deps: ExecDeps = { nowIso: () => clock, random: () => 0, queryTabs: async () => [], getTab: async () => ({ id: 7, url: location.href }),
    createTab: async () => { throw new Error('Unexpected navigation'); }, loadPrefs: async () => ({ ...prefs }),
    saveState: async checkpoint => { checkpoints.push(validateEngineState(JSON.parse(JSON.stringify(checkpoint)))); }, isCancelled: () => cancelled,
    inject: async (_tab, func, params) => {
      if (func.name === 'performAppointmentSubmission') {
        const action = (params![0] as { action: string }).action;
        expect(checkpoints.at(-1)).toMatchObject({ intent: action === 'acknowledge' ? null : { phase: action === 'submit' ? 'prepared' : 'confirming' }, executor: { actionPending: true } });
      }
      return new Function(`return (${func.toString()})`)()(...params ?? []);
    } };
  return { deps, state, prefs, checkpoints, submit, confirm, cancel: () => { cancelled = true; }, tick: () => { clock = new Date(Date.parse(clock) + 30_000).toISOString(); },
    setBooked: (date: string | null) => { booked = date; } };
}

describe('complete synthetic submission, confirmation and recovery', () => {
  it.each([false, true])('records only a dispatched live submission as Attempted, without gating the click (Test Mode=%s)', async testMode => {
    const h = harness(testMode, true, false);
    h.deps.onBookingAttempt = vi.fn(() => { throw new Error('Synthetic history failure'); });
    await runBookingStage(h.deps, h.state);
    if (testMode) {
      expect(h.deps.onBookingAttempt).not.toHaveBeenCalled();
      expect(h.submit).not.toHaveBeenCalled();
    } else {
      expect(h.deps.onBookingAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        intent: expect.objectContaining({ targetDate: '2026-11-19', testMode: false }), executor: expect.objectContaining({ actionPending: true }),
      }));
      expect(h.submit).toHaveBeenCalledOnce();
    }
  });

  it.each(['refused', 'lost-reply'] as const)('distinguishes an explicit zero-click refusal from an uncertain attempt (%s)', async outcome => {
    const h = harness(false, true, outcome === 'refused' ? '{malformed' : false);
    h.deps.onBookingAttempt = vi.fn();
    const original = h.deps.inject;
    h.deps.inject = async (...args) => {
      const response = await original(...args);
      if (outcome === 'lost-reply' && args[1].name === 'performAppointmentSubmission') throw new Error('Synthetic lost reply');
      return response;
    };
    const next = await runBookingStage(h.deps, h.state);
    expect(next.status).toBe('verifying');
    expect(h.deps.onBookingAttempt).toHaveBeenCalledTimes(outcome === 'refused' ? 0 : 1);
    expect(h.submit).toHaveBeenCalledTimes(outcome === 'refused' ? 0 : 1);
  });

  it.each(['stop', 'stop-missing-dialog', 'settings'])('does not confirm when %s arrives during the read-only dialog wait', async change => {
    const h = harness(false);
    const submitted = await runBookingStage(h.deps, h.state);
    const original = h.deps.inject;
    let finish: ((value: { ok: boolean }) => void) | undefined;
    h.deps.inject = async (...args) => args[1].name === 'waitForAppointmentDialog'
      ? new Promise(resolve => { finish = resolve; }) : original(...args);
    const pending = runBookingStage(h.deps, submitted);
    await vi.waitFor(() => expect(finish).toBeDefined());
    if (change.startsWith('stop')) h.cancel(); else h.prefs.testMode = true;
    finish!({ ok: change !== 'stop-missing-dialog' });
    const next = await pending;
    expect(next.status).toBe('verifying');
    expect(next.intent?.phase).toBe('submitted');
    expect(h.submit).toHaveBeenCalledOnce(); expect(h.confirm).not.toHaveBeenCalled();
    expect(h.checkpoints.some(state => state.intent?.phase === 'confirming')).toBe(false);
    if (change.startsWith('stop')) expect(next.verification).toBeNull();
  });
  it('routes a timed-out dialog to settling verification without another submission', async () => {
    const h = harness(false);
    const submitted = await runBookingStage(h.deps, h.state);
    const original = h.deps.inject;
    h.deps.inject = async (...args) => args[1].name === 'waitForAppointmentDialog' ? { ok: false } : original(...args);
    const next = await runBookingStage(h.deps, submitted);
    expect(next).toMatchObject({ status: 'verifying', intent: { phase: 'submitted' } });
    expect(Date.parse(next.verification!.nextReadAt!) - Date.parse(h.deps.nowIso())).toBe(30_000);
    expect(h.submit).toHaveBeenCalledOnce(); expect(h.confirm).not.toHaveBeenCalled();
    await runBookingStage(h.deps, next);
    expect(h.submit).toHaveBeenCalledOnce();
  });
  it('checkpoints optional final warning acknowledgement before arming submission', async () => {
    const h = harness(false);
    document.querySelector('input[name="confirmed_limit_message"]')!.outerHTML = '<input id="confirmed_limit_message" name="confirmed_limit_message" type="checkbox" value="1">';
    let state = await runBookingStage(h.deps, h.state);
    expect(state).toMatchObject({ status: 'running', stage: 'form', intent: null, executor: { actionPending: false } });
    expect(document.querySelector<HTMLInputElement>('#confirmed_limit_message')!.checked).toBe(true);
    expect(h.submit).not.toHaveBeenCalled(); h.tick();
    state = await runBookingStage(h.deps, state);
    expect(state).toMatchObject({ stage: 'confirm', intent: { phase: 'submitted' } });
    expect(h.submit).toHaveBeenCalledOnce(); expect(h.confirm).not.toHaveBeenCalled();
  });
  it.each([false, true])('submits then confirms paid booking with Test Mode off (initial=%s), and requires three fresh reads for success', async initial => {
    const h = harness(false, initial);
    let state = await runBookingStage(h.deps, h.state);
    expect(state).toMatchObject({ status: 'running', stage: 'confirm', intent: { phase: 'submitted', testMode: false } });
    expect(state.nextPollAt).toBe(h.deps.nowIso());
    expect(h.submit).toHaveBeenCalledOnce(); expect(h.confirm).not.toHaveBeenCalled();
    state = reconcileStartup(validateEngineState(JSON.parse(JSON.stringify(state))), h.deps.nowIso());
    expect(state.status).toBe('running');
    state = await runBookingStage(h.deps, state);
    expect(h.confirm).toHaveBeenCalledOnce(); expect(state).toMatchObject({ status: 'verifying', intent: { phase: 'confirming' } });
    expect(Date.parse(state.verification!.nextReadAt!) - Date.parse(h.deps.nowIso())).toBe(30_000);
    for (let read = 0; read < 3; read++) {
      h.tick();
      state = await runVerificationRead(state, { now: h.deps.nowIso, read: () => readCurrentAppointment('11111111', '22222222', true, true) });
      if (read < 2) expect(state).toMatchObject({ status: 'verifying', intent: { targetDate: '2026-11-19' } });
    }
    expect(state).toMatchObject({ status: 'stopped', intent: null, executor: null });
    expect(h.submit).toHaveBeenCalledOnce(); expect(h.confirm).toHaveBeenCalledOnce();
  });
  it('never clicks submit or opens a dialog in Test Mode; the dry run parks without intent or verification', async () => {
    const h = harness(true); let state = await runBookingStage(h.deps, h.state); h.tick();
    expect(state).toMatchObject({ status: 'verifying', stage: 'done', intent: null });
    expect(h.submit).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
    expect(h.checkpoints.filter(entry => entry.intent !== null)).toHaveLength(0);
    // No verification reads are scheduled for a click that never occurred.
    expect(state.verification).toBeNull();
  });
  it('never clicks a gateless direct submit in Test Mode either', async () => {
    const h = harness(true, false, false); let state = await runBookingStage(h.deps, h.state); h.tick();
    expect(state).toMatchObject({ status: 'verifying', stage: 'done', intent: null, verification: null });
    expect(h.submit).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
    expect(h.checkpoints.filter(entry => entry.intent !== null)).toHaveLength(0);
  });
  it('submits an initial booking directly without a gate, then verifies to success with no dialog click', async () => {
    const h = harness(false, true, false);
    let state = await runBookingStage(h.deps, h.state);
    // The durable intent and mutation checkpoint precede the direct click,
    // which books immediately with no recognized dialog to confirm.
    expect(state).toMatchObject({ status: 'running', stage: 'confirm', intent: { phase: 'submitted', testMode: false } });
    expect(h.submit).toHaveBeenCalledOnce(); expect(h.confirm).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
    expect(state.intent).toMatchObject({ phase: 'submitted' });
    expect(h.checkpoints.some(entry => entry.intent?.phase === 'prepared' && entry.executor?.actionPending === true)).toBe(true);
    state = reconcileStartup(validateEngineState(JSON.parse(JSON.stringify(state))), h.deps.nowIso());
    expect(state.status).toBe('running'); h.tick();
    state = await runBookingStage(h.deps, state);
    // No dialog exists for the gateless form, so nothing is confirmed: the
    // changed baseline routes straight into verification without a replay.
    expect(h.confirm).not.toHaveBeenCalled();
    expect(state).toMatchObject({ status: 'verifying', intent: { targetDate: '2026-11-19' } });
    for (let read = 0; read < 3; read++) {
      h.tick();
      state = await runVerificationRead(state, { now: h.deps.nowIso, read: () => readCurrentAppointment('11111111', '22222222', true, true) });
      if (read < 2) expect(state).toMatchObject({ status: 'verifying', intent: { targetDate: '2026-11-19' } });
    }
    expect(state).toMatchObject({ status: 'stopped', intent: null, executor: null });
    expect(h.submit).toHaveBeenCalledOnce(); expect(h.confirm).not.toHaveBeenCalled();
  });
  it('refuses a live submit beneath a pre-existing unrelated dialog without clicking', async () => {
    const h = harness(false, false, false);
    document.body.insertAdjacentHTML('beforeend', '<div class="reveal-overlay"><div data-reveal><h4>Unrelated notice</h4></div></div>');
    const state = await runBookingStage(h.deps, h.state);
    expect(state).toMatchObject({ status: 'verifying', intent: { phase: 'prepared' } });
    expect(h.submit).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
  });
  it.each([
    ['bad-json', '{not-json'],
    ['null', 'null'],
    ['empty-title', JSON.stringify({ title: '', ok: 'Confirm', cancel: 'Cancel' })],
    ['whitespace-title', JSON.stringify({ title: '   ', ok: 'Confirm', cancel: 'Cancel' })],
    ['missing-ok', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', cancel: 'Cancel' })],
    ['empty-cancel', JSON.stringify({ title: 'Are you sure you want to reschedule the appointment?', ok: 'Confirm', cancel: ' ' })],
  ])('refuses a live submit with a present-but-malformed gate (%s) without clicking or posting', async (_label, gate) => {
    const h = harness(false, false, gate);
    const state = await runBookingStage(h.deps, h.state);
    // The adapter refuses before any click, so no POST/dialog occurs. The
    // prepared intent plus checkpoint are already durable, and the run
    // routes into fresh verification without replaying the refused click.
    expect(h.submit).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.reveal-overlay [data-reveal]')).toHaveLength(0);
    expect(state).toMatchObject({ status: 'verifying', intent: { phase: 'prepared' }, verification: { reads: [] } });
    expect(h.checkpoints.some(entry => entry.intent?.phase === 'prepared' && entry.executor?.actionPending === true)).toBe(true);
    const again = await runBookingStage(h.deps, state);
    expect(again).toMatchObject({ status: 'verifying', intent: { phase: 'prepared' } });
    expect(h.submit).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
  });
  it('turns a lost direct-submit reply into verification without replaying the click', async () => {
    const h = harness(false, true, false);
    const original = h.deps.inject;
    let submits = 0;
    h.deps.inject = async (...args) => {
      if (args[1].name === 'performAppointmentSubmission' && (args[2] as { action: string }[])[0].action === 'submit') {
        submits++;
        expect(h.checkpoints.at(-1)).toMatchObject({ intent: { phase: 'prepared' }, executor: { actionPending: true } });
        throw new Error('synthetic lost reply after a possibly final click');
      }
      return original(...args);
    };
    const state = await runBookingStage(h.deps, h.state);
    expect(submits).toBe(1);
    expect(state).toMatchObject({ status: 'verifying', intent: { phase: 'prepared' }, verification: { reads: [] } });
    // A follow-up pass schedules verification, never a second submit click.
    const again = await runBookingStage(h.deps, state);
    expect(again).toMatchObject({ status: 'verifying', intent: { phase: 'prepared' } });
    expect(submits).toBe(1);
    expect(h.submit).not.toHaveBeenCalled();
  });
  it('turns a post-click lost direct-submit reply into verification without a second click', async () => {
    const h = harness(false, true, false);
    const original = h.deps.inject;
    let submits = 0;
    h.deps.inject = async (...args) => {
      if (args[1].name === 'performAppointmentSubmission' && (args[2] as { action: string }[])[0].action === 'submit') {
        submits++;
        expect(h.checkpoints.at(-1)).toMatchObject({ intent: { phase: 'prepared' }, executor: { actionPending: true } });
        // The click already happened inside the page function (native POST
        // dispatched, booking possibly final) before the reply was lost, e.g.
        // navigation racing the executeScript response.
        const result = await original(...args);
        expect(h.submit).toHaveBeenCalledOnce();
        throw new Error('synthetic lost reply after the direct click dispatched');
      }
      return original(...args);
    };
    const state = await runBookingStage(h.deps, h.state);
    expect(submits).toBe(1);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ status: 'verifying', intent: { phase: 'prepared' }, verification: { reads: [] } });
    // A follow-up pass schedules verification, never a second submit click.
    const again = await runBookingStage(h.deps, state);
    expect(again).toMatchObject({ status: 'verifying', intent: { phase: 'prepared' } });
    expect(submits).toBe(1);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it('preserves a legacy persisted Test Mode intent through verification instead of bypassing it', async () => {
    const h = harness(true); let state = await runBookingStage(h.deps, h.state); h.tick();
    expect(state.intent).toBeNull();
    // A stored intent from a previous build (where Test Mode opened the gate)
    // must still resolve through fresh verification, never be cleared or replayed.
    const legacy: EngineState = { ...state, status: 'verifying',
      intent: { runId: 'run-id-0001', mode: 'booking', groupId: '11111111', targetDate: '2026-11-19',
        consulate: 'Vancouver', testMode: true, createdAt: NOW, phase: 'submitted' },
      verification: { reads: [], nextReadAt: h.deps.nowIso() } };
    let verified = legacy;
    for (let read = 0; read < 3; read++) {
      h.tick(); verified = await runVerificationRead(verified, { now: h.deps.nowIso, read: () => readCurrentAppointment('11111111', '22222222', true, true) });
    }
    expect(verified).toMatchObject({ status: 'stopped', intent: null });
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it.each(['settings', 'stop', 'storage', 'form', 'roster', 'baseline'])('prevents confirmation when %s changes after submission', async issue => {
    const h = harness(false); let state = await runBookingStage(h.deps, h.state); h.tick();
    if (issue === 'settings') h.prefs.testMode = true;
    if (issue === 'stop') h.cancel();
    if (issue === 'storage') h.deps.saveState = async () => { throw new Error('synthetic storage failure'); };
    if (issue === 'form') document.querySelector<HTMLInputElement>('#appointments_consulate_appointment_date')!.value = '2026-11-20';
    if (issue === 'roster') vi.stubGlobal('location', { href: `${BASE}/appointment?applicants[]=77777777` });
    if (issue === 'baseline') h.setBooked('December 1, 2026');
    // Submission/confirmation storage-checkpoint exceptions route into
    // automatic verification (30s delay, three paced reads), never a replay.
    // Settings/Stop/form/roster/baseline guards park with intent preserved;
    // manual Stop still parks rather than auto-verifying.
    state = await runBookingStage(h.deps, state);
    expect(state.status).toBe('verifying'); expect(state.intent).not.toBeNull();
    if (issue === 'storage') expect(state.verification).toMatchObject({ reads: [] });
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it('turns an interrupted final click into verification, preserving intent without replay', async () => {
    const h = harness(false); const submitted = await runBookingStage(h.deps, h.state);
    const interrupted: EngineState = { ...submitted, intent: { ...submitted.intent!, phase: 'confirming' }, executor: { ...submitted.executor!, actionPending: true } };
    const restored = reconcileStartup(validateEngineState(JSON.parse(JSON.stringify(interrupted))), NOW);
    expect(restored).toMatchObject({ status: 'verifying', intent: interrupted.intent });
    // An interrupted live mutation keeps the original 30s post-attempt
    // settling delay on worker wake instead of reading immediately.
    expect(restored.verification).toEqual({ reads: [], nextReadAt: '2026-10-12T00:00:30.000Z' });
    expect(await runBookingStage(h.deps, restored)).toEqual(restored);
    expect(h.confirm).not.toHaveBeenCalled();
    // A restart parks the stranded check with no deadline for an explicit
    // Start instead of healing it into an immediate pass.
    expect(reconcileStartup(submitted, NOW, true)).toMatchObject({ status: 'verifying', verification: null });
  });
  it('continues only after repeated old readings; a third date leaves the intent unresolved', async () => {
    for (const unknown of [false, true]) {
      const h = harness(false); let state = await runBookingStage(h.deps, h.state); h.tick();
      state = await runBookingStage(h.deps, state);
      h.setBooked(unknown ? 'December 1, 2026' : 'January 1, 2027');
      for (let read = 0; read < 3; read++) {
        h.tick(); state = await runVerificationRead(state, { now: h.deps.nowIso, read: () => readCurrentAppointment('11111111', '22222222', true, true) });
      }
      expect(state.status).toBe(unknown ? 'verifying' : 'running');
      expect(state.intent === null).toBe(!unknown);
      expect(h.confirm).toHaveBeenCalledOnce();
    }
  });
});
