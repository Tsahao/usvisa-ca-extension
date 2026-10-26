// @vitest-environment jsdom
// Synthetic DOM only; no live portal data or external analytics transport.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCurrentAppointment } from '../src/adapter/reads';
import { appointmentVisaClasses } from '../src/domain/appointment';
import { isVisaClasses, normalizeVisaClassLabels, safeVisaClasses } from '../src/domain/visa-classes';
import { bindGroup, emptyEngineState, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
import { runVerificationRead } from '../src/engine/verification';

const now = '2026-10-25T12:00:00.000Z';
const identity = { scheduleId: '11111111', ivr: '22222222' };
const applicantIds = ['77777777', '88888888'];
const base = `/en-ca/niv/schedule/${identity.scheduleId}`;
const serialized: typeof readCurrentAppointment = new Function(`return (${readCurrentAppointment.toString()})`)();
const raw = (labels: unknown = ['L1 Intra-company Transferee', 'L2 Spouse or Child of an L1']) => ({
  ...identity, kind: 'booked', text: 'November 19, 2026 at 09:15', applicantIds,
  visaClassSnapshot: { applicantIds, labels },
});
function state(): EngineState {
  const args = { owner: 'product-panel-owner', runId: 'visa-class-run-0001', now };
  return bindGroup(startRun(emptyEngineState(now), { ...args, mode: 'booking' }), { ...args,
    binding: { ...identity, kind: 'paid', currentDate: '2027-01-01', applicantIds, visaClasses: ['L1', 'L2'] } });
}
afterEach(() => vi.unstubAllGlobals());

describe('bounded visa-class normalization', () => {
  it('normalizes only leading allowlisted class tokens, retaining mixed groups without counts', () => {
    expect(normalizeVisaClassLabels(['L2 Spouse or Child of an L1', 'L1 Intra-company Transferee', 'L1 Intra-company Transferee']))
      .toEqual(['L1', 'L2']);
    expect(normalizeVisaClassLabels(['B1/B2 Business & Tourism (Temporary visitor)', 'H-1B Specialty Occupation', 'F1 Student']))
      .toEqual(['B1/B2', 'F1', 'H1B']);
    expect(normalizeVisaClassLabels(['B-1/B-2 Business & Tourism', 'h1b', 'NATO-1 Representative']))
      .toEqual(['B1/B2', 'H1B', 'NATO1']);
  });
  it.each([undefined, null, [], ['private@example.invalid'], ['Applicant has H1B'], ['NEWCLASS future description'], ['H1B@example.invalid'], ['H1B: unsafe suffix'], ['L1'.repeat(100)]])('never emits arbitrary labels (%j)', value => {
    expect(normalizeVisaClassLabels(value)).toEqual(['unknown']);
  });
  it('retains unknown alongside known classes for a partially readable group', () => {
    expect(normalizeVisaClassLabels(['L1 Intra-company Transferee', null])).toEqual(['L1', 'unknown']);
    expect(normalizeVisaClassLabels(Array.from({ length: 101 }, () => 'L1'))).toEqual(['unknown']);
    expect(isVisaClasses(['L2', 'L1'])).toBe(false);
    expect(isVisaClasses(['L1', 'L1'])).toBe(false);
    expect(safeVisaClasses(['L1 description'])).toEqual(['unknown']);
  });
  it('rejects sparse saved arrays rather than treating holes as allowlisted codes', () => {
    expect(isVisaClasses(Array(1))).toBe(false);
    expect(safeVisaClasses(Array(1))).toEqual(['unknown']);
    expect(normalizeVisaClassLabels(Array(1))).toEqual(['unknown']);
  });
  it.each(['wrong-group', 'wrong-ivr', 'wrong-roster', 'duplicate-id', 'wrong-count', 'missing-roster', 'missing-snapshot', 'read-failure'])('requires scoped same-complete-roster metadata (%s)', issue => {
    const reading: any = raw();
    if (issue === 'wrong-group') reading.scheduleId = '99999999';
    if (issue === 'wrong-ivr') reading.ivr = '99999999';
    if (issue === 'wrong-roster') reading.visaClassSnapshot.applicantIds = ['77777777', '99999999'];
    if (issue === 'duplicate-id') reading.visaClassSnapshot.applicantIds = ['77777777', '77777777'];
    if (issue === 'wrong-count') reading.visaClassSnapshot.labels = ['L1'];
    if (issue === 'missing-snapshot') delete reading.visaClassSnapshot;
    if (issue === 'read-failure') reading.kind = 'read-failure';
    expect(appointmentVisaClasses(reading, { ...identity, ...(issue === 'missing-roster' ? {} : { applicantIds }) })).toEqual(['unknown']);
  });
  it('persists normalized metadata across suspension, resets it on new runs and tolerates missing/corrupt legacy metadata', () => {
    expect(validateEngineState(JSON.parse(JSON.stringify(state()))).group!.visaClasses).toEqual(['L1', 'L2']);
    expect(startRun({ ...state(), status: 'stopped' }, { mode: 'booking', owner: state().owner!, runId: 'next-visa-run-0002', now }).group).toBeNull();
    const legacy = state(); delete legacy.group!.visaClasses;
    expect(validateEngineState(legacy).group!.visaClasses).toBeUndefined();
    const corrupt: any = state(); corrupt.group.visaClasses = ['private@example.invalid'];
    expect(validateEngineState(corrupt).group!.visaClasses).toEqual(['unknown']);
  });
});

describe('dashboard Visa Class column reader', () => {
  function dashboard(withPetition = false) {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    const header = `<thead><tr><th>Applicant Name</th>${withPetition ? '<th>Petition</th>' : ''}<th>Visa Class</th><th></th></tr></thead>`;
    const rows = applicantIds.map((id, index) => `<tr><td>Synthetic private name</td>${withPetition ? '<td>Synthetic private petition</td>' : ''}<td>${index ? 'L2 Spouse or Child of an L1' : 'L1 Intra-company Transferee'}</td><td><a href="${base}/applicants/${id}">Details</a></td></tr>`).join('');
    document.body.innerHTML = `<section class="application card ready_to_schedule"><strong>${identity.ivr}</strong>
      <ul class="actions"><li><a href="${base}/continue_actions">Continue</a></li></ul><table>${header}<tbody>${rows}</tbody></table></section>`;
  }
  it.each([false, true])('finds classes by header with optional Petition column (%s)', async withPetition => {
    dashboard(withPetition);
    const reading = await serialized(identity.scheduleId, identity.ivr, false, true);
    expect(reading.applicantIds).toEqual(applicantIds);
    expect(appointmentVisaClasses(reading, { ...identity, applicantIds })).toEqual(['L1', 'L2']);
    expect(JSON.stringify(reading)).not.toMatch(/Synthetic private|petition|Details/);
  });
  it('uses fresh dashboard HTML rather than stale form content and does not require classes on the booking form', async () => {
    dashboard();
    const html = document.body.innerHTML;
    document.body.innerHTML = '<form>Appointment form without visa class</form>';
    vi.stubGlobal('location', { href: `https://ais.usvisa-info.com${base}/appointment` });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => html })));
    const reading = await serialized(identity.scheduleId, identity.ivr, true, true, '/en-ca/niv/groups/55555555');
    expect(appointmentVisaClasses(reading, { ...identity, applicantIds })).toEqual(['L1', 'L2']);
  });
  it.each(['missing-header', 'duplicate-header', 'colspan', 'rowspan', 'nested-table', 'incomplete-cell', 'oversized-cell'])('never gates a valid roster on optional class markup (%s)', async issue => {
    dashboard();
    const header = document.querySelectorAll('th')[1];
    const cell = document.querySelectorAll('tbody tr')[1].children[1];
    if (issue === 'missing-header') header.textContent = 'Other field';
    if (issue === 'duplicate-header') document.querySelector('th')!.textContent = 'Visa Class';
    if (issue === 'colspan') header.setAttribute('colspan', '2');
    if (issue === 'rowspan') cell.setAttribute('rowspan', '2');
    if (issue === 'nested-table') cell.innerHTML = '<table><tr><td>L2</td></tr></table>';
    if (issue === 'incomplete-cell') cell.remove();
    if (issue === 'oversized-cell') cell.textContent = 'L2 '.repeat(100);
    const reading = await serialized(identity.scheduleId, identity.ivr, false, true);
    expect(reading.applicantIds).toEqual(applicantIds);
    const classes = appointmentVisaClasses(reading, { ...identity, applicantIds });
    expect(classes).toContain('unknown');
  });
  it('never borrows classes from a sibling or historical card', async () => {
    dashboard();
    document.querySelectorAll('th')[1].textContent = 'Other field';
    document.body.insertAdjacentHTML('beforeend', `<section class="application card ready_to_schedule"><strong>44444444</strong>
      <ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul>
      <table><tr><th>Visa Class</th><th></th></tr><tr><td>B1/B2 Business & Tourism</td><td><a href="/en-ca/niv/schedule/33333333/applicants/99999999">Details</a></td></tr></table></section>`);
    expect(appointmentVisaClasses(await serialized(identity.scheduleId, identity.ivr, false, true), { ...identity, applicantIds })).toEqual(['unknown']);
  });
  it('supplies optional same-roster metadata on relaxed reads, but never blocks target date reads on malformed roster', async () => {
    dashboard();
    const relaxed = await serialized(identity.scheduleId, identity.ivr);
    expect(relaxed.applicantIds).toBeUndefined();
    expect(appointmentVisaClasses(relaxed, { ...identity, applicantIds })).toEqual(['L1', 'L2']);
    document.querySelector('a[href*="/applicants/"]')!.remove();
    expect(await serialized(identity.scheduleId, identity.ivr)).toMatchObject({ kind: 'unbooked', text: null });
    await expect(serialized(identity.scheduleId, identity.ivr, false, true)).rejects.toThrow();
  });
});

describe('successful verification visa-class cross-check', () => {
  it.each(['matching', 'missing', 'changed-class', 'changed-roster', 'legacy'] as const)('resolves success independently of optional metadata (%s)', async issue => {
    const initial: EngineState = { ...state(), status: 'verifying', verification: { reads: ['2026-11-19', '2026-11-19'], nextReadAt: now },
      intent: { runId: state().runId!, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
        consulate: 'Vancouver', testMode: false, createdAt: now } };
    const reading: any = raw();
    if (issue === 'legacy') delete initial.group!.visaClasses;
    if (issue === 'missing') delete reading.visaClassSnapshot;
    if (issue === 'changed-class') reading.visaClassSnapshot.labels = ['H1B Specialty Occupation', 'H4 Dependent'];
    if (issue === 'changed-roster') reading.visaClassSnapshot.applicantIds = ['77777777'];
    const resolved = await runVerificationRead(validateEngineState(initial), { now: () => now, read: async () => reading });
    expect(resolved).toMatchObject({ status: 'stopped', intent: null, verificationError: null,
      group: { currentDate: '2027-01-01', visaClasses: issue === 'matching' || issue === 'legacy' ? ['L1', 'L2'] : ['unknown'] } });
  });
});
