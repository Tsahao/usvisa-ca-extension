// @vitest-environment jsdom
// Round-2 booking-recovery regressions: production adapter separation,
// fail-closed guards, queued-policy semantics, lifecycle custody and panel.
// Synthetic only: no real accounts, secrets, page dumps or notifications.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCurrentAppointment } from '../src/adapter/reads';
import { appointmentApplicants, appointmentDateRelaxed } from '../src/domain/appointment';
import {
  VERIFICATION_CONFIG_CHANGED, VERIFICATION_ROSTER_CHANGED,
  bindGroup, emptyEngineState, queueVerificationStart,
  recordIntent, parkForReview, reconcileStartup, startRun, stopRun,
} from '../src/engine/workflow';
import { runVerificationRead } from '../src/engine/verification';
import { runBookingStage, type ExecDeps } from '../src/engine/executor';
import { beginAuthentication, runAuthentication } from '../src/engine/authentication';
import { policyKey } from '../src/engine/lifecycle';
import { panelSnapshot } from '../src/engine/panel';

const NOW = '2026-10-12T00:00:00.000Z';
const ids = ['77777777', '88888888'];
const single = ['77777777'];
const identity = { scheduleId: '11111111', ivr: '22222222' };
const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
  earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false,
  interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
afterEach(() => vi.unstubAllGlobals());

function verifying(applicantIds: string[] | undefined = ids, currentDate: string | null = '2027-06-21', testMode = false) {
  const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
    binding: { ...identity, kind: 'paid', currentDate, ...(applicantIds ? { applicantIds } : {}) } });
  return parkForReview(recordIntent(bound, { ...args, intent: {
    runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
    consulate: 'Vancouver', testMode, createdAt: NOW } }), NOW);
}
async function threeReads(initial: ReturnType<typeof verifying>, raws: unknown[], opts: {
  currentPolicyKey?: string | null; rosterRaws?: (unknown | Error)[]; nowStepS?: number;
} = {}) {
  let state = initial;
  let clock = NOW;
  for (let index = 0; index < raws.length; index++) {
    clock = new Date(Date.parse(clock) + 30_000).toISOString();
    const at = clock;
    const raw = raws[index];
    const rosterRaw = opts.rosterRaws?.[index];
    state = await runVerificationRead(state, { now: () => at,
      read: async () => { if (raw instanceof Error) throw raw; return raw; },
      ...(opts.rosterRaws ? { readRoster: async () => { if (rosterRaw instanceof Error) throw rosterRaw; return rosterRaw; } } : {}),
      ...(opts.currentPolicyKey === undefined ? {} : { currentPolicyKey: opts.currentPolicyKey }) });
  }
  return state;
}
const booked = (text: string, applicantIds: string[] = ids) => ({ ...identity, kind: 'booked', text, applicantIds });

describe('production adapter date/roster separation', () => {
  function dashboardDom(malformedRoster: boolean) {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    const table = malformedRoster ? '' :
      `<table><tbody>${ids.map(id => `<tr><td><a href="https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/applicants/${id}">Details</a></td></tr>`).join('')}</tbody></table>`;
    document.body.innerHTML = `<section><strong>22222222</strong>` +
      `<p class="consular-appt">November 19, 2026<a href="https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment">Appointment</a></p>` +
      table + `</section>`;
  }
  it('reads the target date without applicants while strict roster throws on malformed markup', async () => {
    dashboardDom(true);
    const dateOnly = await readCurrentAppointment('11111111', '22222222', false, false);
    expect(appointmentDateRelaxed(dateOnly, identity)).toBe('2026-11-19');
    expect(() => appointmentApplicants(dateOnly)).toThrow();
    await expect(readCurrentAppointment('11111111', '22222222', false, true)).rejects.toThrow();
  });
  it('target-confirms through verification despite a malformed strict roster, but blocks future continuation', async () => {
    // Date path succeeds (includeApplicants=false equivalent); strict roster fails.
    const dateRaw = { ...identity, kind: 'booked', text: 'November 19, 2026' };
    const success = await threeReads(verifying(), [dateRaw, dateRaw, dateRaw],
      { rosterRaws: [new Error('roster'), new Error('roster'), new Error('roster')] });
    expect(success).toMatchObject({ status: 'stopped', intent: null, verificationError: null });
    // Failed outcome with the same malformed roster must resolve and pause, not continue.
    const prevRaw = { ...identity, kind: 'booked', text: 'June 21, 2027' };
    const blocked = await threeReads(verifying(), [prevRaw, prevRaw, prevRaw],
      { rosterRaws: [new Error('roster'), new Error('roster'), new Error('roster')] });
    expect(blocked).toMatchObject({ status: 'stopped', intent: null, verificationError: VERIFICATION_ROSTER_CHANGED, queuedStart: null });
  });
});

describe('fail-closed continuation guards', () => {
  it('missing original roster never authorizes continuation', async () => {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-06-21' } });
    const missing = parkForReview(recordIntent(bound, { ...args, intent: {
      runId: args.runId, groupId: identity.scheduleId, mode: 'booking', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW } }), NOW);
    const prev = booked('June 21, 2027');
    const blocked = await threeReads(missing, [prev, prev, prev]);
    expect(blocked).toMatchObject({ status: 'stopped', intent: null, verificationError: VERIFICATION_ROSTER_CHANGED });
  });
  it('null current policy (missing/invalid prefs or storage failure) blocks with config reason', async () => {
    const prev = booked('June 21, 2027');
    const blocked = await threeReads(verifying(), [prev, prev, prev], { currentPolicyKey: null });
    expect(blocked).toMatchObject({ status: 'stopped', intent: null, verificationError: VERIFICATION_CONFIG_CHANGED, queuedStart: null });
  });
  it('queued request permits a new valid policy differing from the old run policy', async () => {
    const oldKey = policyKey({ ...prefs, consulate: 'Vancouver' } as unknown as Record<string, unknown>);
    const newKey = policyKey({ ...prefs, consulate: 'Toronto' } as unknown as Record<string, unknown>);
    const base = { ...verifying(), policyKey: oldKey,
      queuedStart: { owner: args.owner, runId: args.runId, mode: 'booking' as const, requestedAt: NOW, policyKey: newKey } };
    const prev = booked('June 21, 2027');
    const allowed = await threeReads(base, [prev, prev, prev], { currentPolicyKey: newKey });
    expect(allowed).toMatchObject({ status: 'running', intent: null });
    const stale = await threeReads(base, [prev, prev, prev], { currentPolicyKey: oldKey });
    expect(stale).toMatchObject({ status: 'stopped', verificationError: VERIFICATION_CONFIG_CHANGED, queuedStart: null });
  });
  it('cross-mode queued requests record their mode without mixing binding kinds', () => {
    const active = { ...verifying(), verification: { reads: [], nextReadAt: NOW } };
    const queued = queueVerificationStart(active, { owner: args.owner, runId: args.runId, mode: 'alerts', policyKey: null, now: NOW });
    expect(queued.queuedStart?.mode).toBe('alerts');
    // Binding kinds stay mode-derived: booking binds paid, alerts binds unpaid.
    // Background rejects the cross-mode restart itself (covered in the packaged
    // recovery spec); the pure queue never mutates the verifying run.
    expect(queued.group?.kind).toBe('paid');
    expect(queued.verification).toEqual(active.verification);
  });
});

describe('lifecycle custody and deadlines', () => {
  it('Stop releases verifier custody while retaining intent and cancelling the request', () => {
    const queued = queueVerificationStart(
      { ...verifying(), verification: { reads: ['2027-06-21'], nextReadAt: NOW }, verificationTabId: 11 },
      { owner: args.owner, runId: args.runId, mode: 'booking', policyKey: null, now: NOW });
    const stopped = stopRun(queued, { ...args, now: '2026-10-12T00:01:00.000Z' });
    expect(stopped).toMatchObject({ status: 'verifying', verification: null, verificationTabId: null, queuedStart: null });
    expect(stopped.intent).toEqual(queued.intent);
  });
  it('pending checkpoint plus browser restart cancels the queued request and releases custody', () => {
    const pending = { ...verifying(), verificationTabId: 11,
      authentication: { tabId: 7, phase: 'prepare' as const, pending: true, startedAt: NOW, purpose: 'verify' as const },
      queuedStart: { owner: args.owner, runId: args.runId, mode: 'booking' as const, requestedAt: NOW, policyKey: null } };
    const restarted = reconcileStartup(pending, NOW, true);
    expect(restarted.queuedStart).toBeNull();
    expect(restarted.verificationTabId).toBeNull();
    expect(restarted.intent).toEqual(pending.intent);
    expect(reconcileStartup(pending, NOW).queuedStart).toEqual(pending.queuedStart);
  });
  it('interrupted checkpoints route into scheduled verification, never a bare park', async () => {
    const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), { ...args,
      binding: { ...identity, kind: 'paid', currentDate: '2027-01-01', applicantIds: ids } });
    const submitted = recordIntent(bound, { ...args, intent: { runId: args.runId, mode: 'booking', groupId: identity.scheduleId,
      targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: NOW, phase: 'submitted' } });
    const interrupted = { ...submitted, stage: 'confirm',
      executor: { tabId: 7, applicantIds: ids, targetTime: '08:00', skippedDates: [], actionPending: true } };
    const deps: ExecDeps = { nowIso: () => NOW, random: () => 0,
      queryTabs: async () => [], getTab: async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' }),
      createTab: async () => { throw new Error('no nav'); }, loadPrefs: async () => ({ ...prefs }),
      saveState: async () => undefined, inject: async () => { throw new Error('no inject'); } };
    const next = await runBookingStage(deps, { ...interrupted, stage: 'confirm' } as never);
    expect(next.status).toBe('verifying');
    expect(next.verification).toMatchObject({ reads: [] });
    expect(Date.parse(next.verification!.nextReadAt!) - Date.parse(NOW)).toBe(30_000);
  });
});

describe('verification login with edited preferences', () => {
  function authHarness(url: string) {
    const deps: ExecDeps = { nowIso: () => NOW, random: () => 0,
      loadPrefs: async () => ({ ...prefs, consulate: 'Toronto', earliest: 'not-a-date', interval: 5, paidIvr: 'not-digits' }),
      queryTabs: async () => [], getTab: async () => ({ id: 7, url }),
      createTab: async () => ({ id: 7, url }),
      saveState: async () => undefined,
      inject: vi.fn(async (_tab, func) => {
        if (func.name === 'readSiteMaintenance') return { maintenance: false };
        if (func.name === 'retryAuthenticationPage') return { ok: true };
        if (func.name === 'readDashboardGroups') return { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] };
        if (func.name === 'performLoginAction') return { ok: true };
        if (func.name === 'probeLoginStatus') return { ok: true };
        throw new Error(`Unexpected ${func.name}`);
      }) };
    return deps;
  }
  it('still verifies the original group when booking fields are invalid but credentials are present', async () => {
    const deps = authHarness('https://ais.usvisa-info.com/en-ca/niv/groups');
    let state = beginAuthentication(verifying(), 'verify', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const next = await runAuthentication(deps, state);
    expect(next.authentication).toBeNull();
    expect(next.verificationTabId).toBe(7);
  });
});

describe('parked verification banner without intent', () => {
  it('displays the fixed roster/config reason even after the outcome resolved', () => {
    const base = { ...verifying(), status: 'stopped' as const, intent: null,
      verification: null, verificationError: VERIFICATION_ROSTER_CHANGED };
    const roster = panelSnapshot(base, null, null);
    expect(roster.reviewRequired).toBe(true);
    expect(roster.reviewMessage).toBe(VERIFICATION_ROSTER_CHANGED);
    const config = panelSnapshot({ ...base, verificationError: VERIFICATION_CONFIG_CHANGED }, null, null);
    expect(config.reviewMessage).toBe(VERIFICATION_CONFIG_CHANGED);
  });
});
