import { describe, expect, it, vi } from 'vitest';
import { beginAuthentication, runAuthentication } from '../src/engine/authentication';
import { bindGroup, emptyEngineState, isAuthenticationFailureReason, reconcileStartup, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
import { policyKey } from '../src/engine/lifecycle';
import { panelSnapshot } from '../src/engine/panel';
import type { ExecDeps } from '../src/engine/executor';

// Login-to-dashboard navigation race (probable October 15 live pause,
// synthetic proof only): a snapshot exact login may auto-navigate toward the
// trusted dashboard before the injection replies. Only independently
// validated progress paces; same-document unknowns stay fail-closed. These
// tests drive true sequences (maintenance succeeds, then the action guard or
// reply races), not just the first maintenance guard.
const NOW = '2026-10-12T00:00:00.000Z';
const singleId = ['77777777'];
const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
  onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
const LOGIN = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
const DASHBOARD = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
function seed() { return { ...startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), policyKey: policyKey(prefs) }; }
function boundSingle() {
  return bindGroup(seed(), { ...args, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid',
    currentDate: '2027-01-01', applicantIds: singleId, dashboardPath: '/en-ca/niv/groups/55555555' } });
}
function harness() {
  let clock = NOW;
  let url = LOGIN;
  const saved: EngineState[] = [];
  const actions: string[] = [];
  const deps: ExecDeps = { nowIso: () => clock, random: () => 0, loadPrefs: async () => ({ ...prefs }),
    queryTabs: async () => [], getTab: async () => ({ id: 7, url }), createTab: vi.fn(async () => ({ id: 7, url })),
    saveState: async checkpoint => { saved.push(validateEngineState(JSON.parse(JSON.stringify(checkpoint)))); },
    navigateTab: vi.fn(async (tabId, target) => {
      expect(tabId).toBe(7);
      expect(saved.at(-1)?.authentication?.pending).toBe(true);
      url = target;
    }),
    inject: vi.fn(async (_tab, func, params) => {
      if (func.name === 'probeLoginStatus') return { ok: true };
      if (func.name === 'readSiteMaintenance') return { maintenance: false };
      if (func.name === 'performLoginAction') {
        expect(saved.at(-1)?.authentication?.pending).toBe(true);
        const action = (params![0] as { action: string }).action;
        actions.push(action);
        if (action === 'submit') url = DASHBOARD;
        return { ok: true };
      }
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
      ] };
      if (func.name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: singleId };
      throw new Error('Unexpected injection');
    }) };
  return { deps, saved, actions, setUrl: (value: string) => { url = value; }, getUrl: () => url,
    tick: (seconds: number) => { clock = new Date(Date.parse(clock) + seconds * 1000).toISOString(); },
    loginActions: () => vi.mocked(deps.inject).mock.calls
      .filter(call => call[1].name === 'performLoginAction').map(call => (call[2]![0] as { action: string }).action) };
}
type TabState = { id: number; url: string; status?: string; pendingUrl?: string };
function scriptTabs(h: ReturnType<typeof harness>, states: TabState[], onRead?: (calls: number) => void) {
  let calls = 0;
  h.deps.getTab = vi.fn(async () => {
    calls++;
    onRead?.(calls);
    return states[Math.min(calls, states.length) - 1];
  });
}
const loginComplete = { id: 7, url: LOGIN, status: 'complete' };
const dashboardLoading = { id: 7, url: DASHBOARD, status: 'loading' };
const dashboardComplete = { id: 7, url: DASHBOARD, status: 'complete' };
const loginPendingDashboard = { id: 7, url: LOGIN, status: 'complete', pendingUrl: DASHBOARD };
const loginLoadingPendingDashboard = { id: 7, url: LOGIN, status: 'loading', pendingUrl: DASHBOARD };

describe('login-to-dashboard navigation race', () => {
  it.each(['prepare', 'wait'] as const)('paces a %s-phase maintenance-guard race with zero injections', async phase => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase } };
    scriptTabs(h, [loginComplete, dashboardLoading, dashboardLoading]);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationFailureReason: null,
      authentication: { tabId: 7, phase, pending: false }, sessionRenewals: 1, consecutiveFailures: 0 });
    expect(state.nextPollAt).toBe('2026-10-12T00:00:02.000Z');
    expect(state.authentication!.cycleDeadline).toBe('2026-10-12T00:01:00.000Z');
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
    expect(h.saved).toHaveLength(0);
    expect(reconcileStartup(state, h.deps.nowIso())).toMatchObject({ status: 'running', authentication: { tabId: 7 } });
  });
  it('paces a true lost submit reply after performLoginAction ran, without replaying the POST', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'submit' } };
    scriptTabs(h, [loginComplete, loginComplete, loginComplete, dashboardComplete, dashboardComplete]);
    let invoked = 0;
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'performLoginAction') {
        invoked++;
        h.actions.push((params![0] as { action: string }).action);
        h.setUrl(DASHBOARD);
        throw new Error('Synthetic lost response after submit');
      }
      return inject(tab, func, params);
    });
    const deadline = state.authentication!.cycleDeadline!;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationFailureReason: null,
      authentication: { tabId: 7, phase: 'wait', pending: false, submittedInCycle: true } });
    expect(state.authentication!.cycleDeadline).toBe(deadline);
    expect(state.consecutiveFailures).toBe(0);
    expect(invoked).toBe(1);
    expect(h.actions).toEqual(['submit']);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(2);
    expect(h.saved[0].authentication).toMatchObject({ pending: true });
    expect(h.saved.at(-1)!.authentication).toMatchObject({ pending: false, submittedInCycle: true, phase: 'wait' });
    expect(reconcileStartup(state, h.deps.nowIso())).toMatchObject({ status: 'running', authentication: { tabId: 7 } });
    scriptTabs(h, [dashboardComplete]);
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, sessionRenewals: 0, consecutiveFailures: 0,
      group: { scheduleId: '11111111', applicantIds: singleId, currentDate: '2027-01-01' }, stage: 'actions',
      executor: { tabId: 7, applicantIds: singleId, actionPending: false } });
    expect(invoked).toBe(1);
    expect(h.actions).toEqual(['submit']);
    expect(JSON.stringify([state, ...h.saved])).not.toContain(prefs.password);
  });
  it('never replays the submit when the tab bounces back to login within the cycle', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'submit' } };
    scriptTabs(h, [loginComplete, loginComplete, loginComplete, dashboardComplete, dashboardComplete]);
    let invoked = 0;
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'performLoginAction') {
        invoked++;
        h.actions.push((params![0] as { action: string }).action);
        throw new Error('Synthetic lost response after submit');
      }
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.authentication).toMatchObject({ phase: 'wait', pending: false, submittedInCycle: true });
    scriptTabs(h, [loginComplete]);
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { phase: 'wait', pending: false } });
    expect(invoked).toBe(1);
    expect(h.actions).toEqual(['submit']);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
  });
  it('paces a true lost probe reply after probeLoginStatus ran, with zero submits', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'wait' } };
    scriptTabs(h, [loginComplete, loginComplete, loginComplete, dashboardLoading, dashboardLoading]);
    let probes = 0;
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'probeLoginStatus') {
        probes++;
        throw new Error('Synthetic lost response after probe');
      }
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, phase: 'wait', pending: false } });
    expect(probes).toBe(1);
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
    expect(h.saved).toHaveLength(0);
    scriptTabs(h, [dashboardComplete]);
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, sessionRenewals: 0,
      group: { scheduleId: '11111111', applicantIds: singleId } });
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
  });
  it('paces a maintenance-to-action checkpoint race without invoking the action', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'submit' } };
    scriptTabs(h, [loginComplete, loginComplete, dashboardLoading, dashboardLoading]);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, phase: 'wait', pending: false, submittedInCycle: true } });
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(2);
    expect(h.saved.at(-1)!.authentication).toMatchObject({ pending: false, submittedInCycle: true, phase: 'wait' });
    scriptTabs(h, [loginComplete]);
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
  });
  it('clears an uncertain prepare checkpoint read-only with no re-fill in cycle', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'prepare' } };
    scriptTabs(h, [loginComplete, loginComplete, dashboardLoading, dashboardComplete]);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, phase: 'wait', pending: false, submittedInCycle: true } });
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
    expect(h.saved.at(-1)!.authentication).toMatchObject({ pending: false, phase: 'wait' });
    scriptTabs(h, [loginComplete]);
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
  });
  it('stops safely when the race checkpoint clear cannot commit', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'submit' } };
    scriptTabs(h, [loginComplete, loginComplete, loginComplete, dashboardComplete, dashboardComplete]);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'performLoginAction') {
        h.actions.push((params![0] as { action: string }).action);
        throw new Error('Synthetic lost response after submit');
      }
      return inject(tab, func, params);
    });
    let saves = 0;
    const save = h.deps.saveState;
    h.deps.saveState = async checkpoint => {
      saves++;
      if (saves > 1) throw new Error('Synthetic storage failure');
      await save(checkpoint);
    };
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(h.actions).toEqual(['submit']);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].authentication).toMatchObject({ pending: true });
    expect(reconcileStartup(h.saved[0], h.deps.nowIso())).toMatchObject(
      { status: 'running', authentication: { pending: false, phase: 'wait', submittedInCycle: true }, nextPollAt: expect.any(String) });
  });
  it('paces an unexpired same-login loading race with trusted dashboard pending', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'wait' } };
    scriptTabs(h, [loginPendingDashboard, loginPendingDashboard, loginLoadingPendingDashboard, loginLoadingPendingDashboard]);
    const deadline = state.authentication!.cycleDeadline!;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 0, authentication: { tabId: 7, pending: false } });
    expect(state.authentication!.cycleDeadline).toBe(deadline);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
  });
  it('counts an expired same-login complete race with a fresh login GET', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'wait' } };
    scriptTabs(h, [loginPendingDashboard, loginPendingDashboard, loginLoadingPendingDashboard,
      loginPendingDashboard, loginPendingDashboard]);
    const deadline = state.authentication!.cycleDeadline!;
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'prepare', pending: false } });
    expect(Date.parse(state.authentication!.cycleDeadline!) > Date.parse(deadline)).toBe(true);
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, LOGIN);
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
    const secondDeadline = state.authentication!.cycleDeadline!;
    scriptTabs(h, [loginPendingDashboard, loginPendingDashboard, loginLoadingPendingDashboard, loginPendingDashboard]);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.consecutiveFailures).toBe(1);
    expect(state.authentication!.cycleDeadline).toBe(secondDeadline);
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
  });
  it('counts an expired same-login loading race via fixed-sign-in stalled recovery', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'wait' } };
    scriptTabs(h, [loginPendingDashboard, loginPendingDashboard, loginLoadingPendingDashboard,
      loginLoadingPendingDashboard, loginLoadingPendingDashboard, loginLoadingPendingDashboard]);
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'prepare', pending: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, LOGIN);
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
  });
  it('counts an expired loading dashboard via fixed sign-in, never a dashboard GET', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'wait' } };
    scriptTabs(h, [loginComplete, loginComplete, dashboardLoading, dashboardLoading, dashboardLoading, dashboardLoading]);
    const deadline = state.authentication!.cycleDeadline!;
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'prepare', pending: false } });
    expect(Date.parse(state.authentication!.cycleDeadline!) > Date.parse(deadline)).toBe(true);
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, LOGIN);
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
    const secondDeadline = state.authentication!.cycleDeadline!;
    scriptTabs(h, [loginComplete, loginComplete, dashboardLoading, dashboardLoading]);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.consecutiveFailures).toBe(1);
    expect(state.authentication!.cycleDeadline).toBe(secondDeadline);
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
  });
  it('cools down after ten expired same-login races without endless pacing', async () => {
    const h = harness();
    // Each cycle reaches the wait-probe race (the post-submit state), so ten
    // consecutive stale-pending expiries share the ten-failure cooldown.
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    for (let count = 1; count <= 10; count++) {
      state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'wait', submittedInCycle: true } };
      scriptTabs(h, [loginPendingDashboard, loginPendingDashboard, loginLoadingPendingDashboard,
        loginPendingDashboard, loginPendingDashboard]);
      h.tick(60);
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.consecutiveFailures).toBe(count);
      expect(state.authentication!.phase).toBe(count < 10 ? 'prepare' : 'retry');
    }
    expect(state).toMatchObject({ cooldownUntil: new Date(Date.parse(h.deps.nowIso()) + 1800_000).toISOString(),
      nextPollAt: null, authentication: { phase: 'retry', pending: false } });
    expect(vi.mocked(h.deps.navigateTab!).mock.calls.length).toBe(9);
    expect(h.loginActions()).toEqual([]);
    expect(h.actions).toEqual([]);
  });
  it('paces a complete dashboard race past expiry once so the next pass binds with zero logins', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'prepare' } };
    scriptTabs(h, [loginComplete, dashboardComplete, dashboardComplete]);
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 0, authentication: { tabId: 7, pending: false } });
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
    scriptTabs(h, [dashboardComplete]);
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, sessionRenewals: 0,
      group: { applicantIds: singleId } });
    expect(h.actions).toEqual([]);
  });
  it('recovers an empty submit reply via validated progress with no replay', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'submit' } };
    scriptTabs(h, [loginComplete, loginComplete, loginComplete, dashboardComplete, dashboardComplete]);
    let invoked = 0;
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'performLoginAction') {
        invoked++;
        h.actions.push((params![0] as { action: string }).action);
        return undefined;
      }
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { phase: 'wait', pending: false, submittedInCycle: true } });
    expect(invoked).toBe(1);
    scriptTabs(h, [loginComplete]);
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(invoked).toBe(1);
    expect(h.actions).toEqual(['submit']);
  });
  it('recovers a reasonless submit refusal via validated progress', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'submit' } };
    scriptTabs(h, [loginComplete, loginComplete, loginComplete, dashboardComplete, dashboardComplete]);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'performLoginAction') {
        h.actions.push((params![0] as { action: string }).action);
        return { ok: false };
      }
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { phase: 'wait', pending: false, submittedInCycle: true } });
    expect(h.actions).toEqual(['submit']);
  });
  it('settles an unknown-reason submit refusal without replaying the POST', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'submit' } };
    scriptTabs(h, [loginComplete, loginComplete, loginComplete, loginComplete]);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'performLoginAction') {
        h.actions.push((params![0] as { action: string }).action);
        return { ok: false, reason: 'bogus-signal' };
      }
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationFailureReason: null,
      authentication: { tabId: 7, phase: 'wait', pending: false, submittedInCycle: true } });
    // The settled cycle continues read-only: the next pass submits nothing.
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(h.actions).toEqual(['submit']);
  });
  it('settles a same-document empty submit reply without replaying the POST', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'submit' } };
    scriptTabs(h, [loginComplete, loginComplete]);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'performLoginAction') {
        h.actions.push((params![0] as { action: string }).action);
        return undefined;
      }
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationFailureReason: null,
      authentication: { tabId: 7, phase: 'wait', pending: false, submittedInCycle: true } });
    expect(h.loginActions()).toEqual(['submit']);
  });
  it('recovers an empty probe reply via validated progress', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'wait' } };
    scriptTabs(h, [loginComplete, loginComplete, loginComplete, dashboardLoading, dashboardLoading]);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'probeLoginStatus') return undefined;
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, phase: 'wait', pending: false } });
    expect(h.loginActions()).toEqual([]);
  });
  it('paces a lost read reply during the probe without clearing rejection state', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'wait' } };
    scriptTabs(h, [loginComplete, loginComplete, dashboardLoading, dashboardLoading]);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, phase: 'wait' } });
    expect(h.actions).toEqual([]);
    scriptTabs(h, [loginComplete]);
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'credential-rejected' }));
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true, authenticationFailureReason: 'credential-rejected' });
    expect(h.actions).toEqual([]);
  });
  it.each([
    ['offsite-dashboard', 'https://example.invalid/en-ca/niv/groups/55555555', undefined],
    ['query-dashboard', `${DASHBOARD}?next=https://example.invalid`, undefined],
    ['hash-dashboard', `${DASHBOARD}#section`, undefined],
    ['wrong-group-dashboard', 'https://ais.usvisa-info.com/en-ca/niv/groups/99999999', undefined],
    ['pending-offsite', DASHBOARD, 'https://example.invalid/'],
    ['pending-query', DASHBOARD, `${DASHBOARD}?next=https://example.invalid`],
  ] as const)('fails closed on unsafe race URLs without reads or navigation (%s)', async (_label, liveUrl, pendingUrl) => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'prepare' } };
    const login = { id: 7, url: LOGIN, status: 'complete' };
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls === 1) return login;
      return { id: 7, url: liveUrl, ...(pendingUrl === undefined ? {} : { pendingUrl }), status: 'complete' };
    });
    const navigate = vi.fn(async () => undefined);
    h.deps.navigateTab = navigate;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true,
      authenticationFailureReason: 'untrusted-navigation' });
    expect(navigate).not.toHaveBeenCalled();
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });
  it('fails closed when settings change mid-race after the maintenance read', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'prepare' } };
    let changed = false;
    h.deps.loadPrefs = async () => changed ? { ...prefs, interval: 600 } : ({ ...prefs });
    scriptTabs(h, [loginComplete, loginComplete, dashboardLoading, dashboardLoading], calls => { if (calls >= 4) changed = true; });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true,
      authenticationFailureReason: 'configuration-changed' });
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).toEqual(['readSiteMaintenance']);
    expect(h.actions).toEqual([]);
  });
  it('fails closed when cancellation arrives mid-race after the maintenance read', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'prepare' } };
    let cancelled = false;
    h.deps.isCancelled = () => cancelled;
    scriptTabs(h, [loginComplete, loginComplete, dashboardLoading, dashboardLoading], calls => { if (calls >= 4) cancelled = true; });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true,
      authenticationFailureReason: 'cancelled' });
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).toEqual(['readSiteMaintenance']);
    expect(h.actions).toEqual([]);
  });
  it('fails closed on a closed tab during recovery', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7, phase: 'prepare' } };
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls === 1) return loginComplete;
      throw new Error('Synthetic closed tab');
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true,
      authenticationFailureReason: 'tab-unavailable' });
    expect(h.actions).toEqual([]);
  });
  it('fails closed on changed-group roster validation without bypassing fresh reads', async () => {
    const h = harness();
    let state = beginAuthentication(boundSingle(), 'renew', NOW);
    state = { ...state, group: { ...state.group!, scheduleId: '99999999' }, authentication: { ...state.authentication!, tabId: 7, phase: 'prepare' } };
    scriptTabs(h, [loginComplete, dashboardLoading, dashboardLoading]);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, pending: false } });
    expect(h.deps.inject).not.toHaveBeenCalled();
    scriptTabs(h, [dashboardComplete]);
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: false });
    expect(state.authenticationError).toBe(
      'The signed-in group, appointment or applicant list changed. Check the dashboard and Settings before pressing Start.');
    expect(state.authenticationFailureReason).toBe('group-identity-changed');
    expect(h.actions).toEqual([]);
  });
  it('records fixed identifier-free failure reasons, migrates old saves and clears on healthy auth', async () => {
    expect(validateEngineState(boundSingle()).authenticationFailureReason).toBeNull();
    expect(() => validateEngineState({ ...boundSingle(), authenticationFailureReason: 'synthetic-secret' }))
      .toThrow('Invalid authentication diagnostic.');
    expect(() => validateEngineState({ ...boundSingle(), authenticationFailureReason: 'https://example.invalid/' }))
      .toThrow('Invalid authentication diagnostic.');
    for (const reason of ['configuration-changed', 'cancelled', 'tab-unavailable', 'untrusted-navigation',
      'context-changed', 'navigation-failed', 'unrecognized-reading', 'credential-rejected',
      'group-identity-changed', 'applicant-roster-changed', 'appointment-date-changed',
      'no-dashboard-group', 'paid-group-not-found', 'unpaid-group-not-found', 'payment-markers-conflict',
      'payment-ineligible', 'group-binding-invalid'] as const) {
      expect(isAuthenticationFailureReason(reason)).toBe(true);
    }
    expect(isAuthenticationFailureReason('synthetic-secret')).toBe(false);
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'credential-rejected' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: true, authenticationFailureReason: 'credential-rejected' });
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', reviewRequired: true });
    expect(JSON.stringify([state, panelSnapshot(state, null, null)])).not.toContain('synthetic-password');
    expect(JSON.stringify(state)).not.toContain('credential-rejected-secret');
    expect(beginAuthentication({ ...state, status: 'running' }, 'start', NOW)).toMatchObject(
      { loginFailed: false, authenticationError: null, authenticationFailureReason: null });
    expect(startRun(state, { ...args, runId: 'fresh-run-0001', mode: 'booking' }).authenticationFailureReason).toBeNull();
    const healthy = harness();
    healthy.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const initial = beginAuthentication(seed(), 'start', NOW);
    const bound = validateEngineState(await runAuthentication(healthy.deps,
      { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(bound.authenticationFailureReason).toBeNull();
    expect(bound.authenticationError).toBeNull();
  });
});

describe('terminal failure telemetry source', () => {
  it.each(['tab', 'navigation', 'save', 'preferences'] as const)('identifies a %s exception in the renewal block without guessing tab loss', async issue => {
    const h = harness();
    h.setUrl(DASHBOARD);
    h.deps.navigateTab = vi.fn(async () => undefined);
    const initial = { ...boundSingle(), executor: { tabId: 7, applicantIds: singleId, targetTime: null, skippedDates: [], actionPending: false } };
    const error = new Error('private@example.invalid https://example.invalid/ synthetic-password');
    if (issue === 'tab') h.deps.getTab = vi.fn(async () => { throw error; });
    if (issue === 'navigation') h.deps.navigateTab = vi.fn(async () => { throw error; });
    if (issue === 'save') h.deps.saveState = vi.fn(async () => { throw error; });
    if (issue === 'preferences') h.deps.loadPrefs = vi.fn().mockResolvedValueOnce({ ...prefs }).mockRejectedValue(error);
    const next = validateEngineState(await runAuthentication(h.deps, beginAuthentication(initial, 'renew', NOW)));
    const code = issue === 'tab' ? 'tab-unavailable' : issue === 'navigation' ? 'navigation-failed' : 'storage-unavailable';
    const step = issue === 'tab' ? 'tab-check' : issue === 'navigation' ? 'navigation' : issue === 'save' ? 'state-save' : 'configuration-check';
    expect(next).toMatchObject({ status: 'stopped', authentication: null, authenticationFailureReason: code,
      failureContext: { category: 'authentication-failed', code, step, authPurpose: 'renew' } });
    expect(JSON.stringify(next.failureContext)).not.toMatch(/private@|https:|synthetic-password/);
    if (issue !== 'navigation') expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.deps.inject).not.toHaveBeenCalled();
  });
  it('retains initial credential rejection context after clearing auth, then clears it on a new Start', async () => {
    const h = harness();
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : { ok: false, reason: 'credential-rejected' });
    const initial = beginAuthentication(seed(), 'start', NOW);
    const next = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(next.failureContext).toEqual({ category: 'authentication-failed', code: 'credential-rejected', step: 'login-prepare', authPurpose: 'start' });
    expect(next.authentication).toBeNull();
    expect(startRun(next, { ...args, runId: 'fresh-run-0001', mode: 'booking' }).failureContext).toBeNull();
    expect(beginAuthentication({ ...next, status: 'running' }, 'start', NOW).failureContext).toBeNull();
  });
  it('drops missing or malformed optional metadata without breaking an otherwise valid checkpoint', () => {
    const state = boundSingle(); delete state.failureContext;
    expect(validateEngineState(state).failureContext).toBeNull();
    for (const context of [{ category: 'authentication-failed', code: 'secret', step: 'tab-check' },
      { category: 'authentication-failed', code: 'tab-unavailable', step: 'tab-check', page: 'private' }]) {
      expect(validateEngineState({ ...state, failureContext: context }).failureContext).toBeNull();
    }
  });
});
