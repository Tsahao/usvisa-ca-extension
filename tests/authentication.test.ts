import { describe, expect, it, vi } from 'vitest';
import { beginAuthentication, runAuthentication } from '../src/engine/authentication';
import { bindGroup, emptyEngineState, reconcileStartup, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
import { policyKey } from '../src/engine/lifecycle';
import { panelSnapshot } from '../src/engine/panel';
import { engineAlarmAt } from '../src/engine/poll';
import type { DiagnosticEvent } from '../src/domain/diagnostics';
import type { ExecDeps } from '../src/engine/executor';
import { isNavigationRecoveryUrl, needsNavigationRecovery } from '../src/engine/navigation-recovery';

const NOW = '2026-10-12T00:00:00.000Z';
const ids = ['77777777', '88888888'];
const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31',
  onlyEarlier: true, testMode: true, interval: 60, paidIvr: '22222222', unpaidIvr: '44444444' };
const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
function seed() { return { ...startRun(emptyEngineState(NOW), { ...args, mode: 'booking' }), policyKey: policyKey(prefs) }; }
function bound() { return bindGroup(seed(), { ...args, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01', applicantIds: ids } }); }
function harness() {
  let clock = NOW;
  let url = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
  const saved: EngineState[] = [];
  const actions: string[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const deps: ExecDeps = { nowIso: () => clock, random: () => 0, loadPrefs: async () => ({ ...prefs }),
    queryTabs: async () => [], getTab: async () => ({ id: 7, url }), createTab: vi.fn(async () => ({ id: 7, url })),
    saveState: async checkpoint => { saved.push(validateEngineState(JSON.parse(JSON.stringify(checkpoint)))); },
    recordDiagnostic: event => { diagnostics.push(event); },
    navigateTab: vi.fn(async (tabId, target) => {
      expect(tabId).toBe(7);
      expect(saved.at(-1)?.authentication?.pending).toBe(true);
      url = target;
    }),
    inject: vi.fn(async (_tab, func, params) => {
      if (func.name === 'probeLoginStatus') return { ok: true };
      if (func.name === 'readSiteMaintenance') return { maintenance: false };
      if (func.name === 'retryAuthenticationPage') {
        expect(saved.at(-1)?.authentication?.pending).toBe(true);
        return { ok: true };
      }
      if (func.name === 'goToLoginFromLanding') {
        url = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
        return { ok: true };
      }
      if (func.name === 'performLoginAction') {
        expect(saved.at(-1)?.authentication?.pending).toBe(true);
        const action = (params![0] as { action: string }).action;
        actions.push(action);
        if (action === 'submit') url = 'https://ais.usvisa-info.com/en-ca/niv/groups';
        return { ok: true };
      }
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
        { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' },
      ] };
      if (func.name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: ids };
      throw new Error('Unexpected injection');
    }) };
  return { deps, saved, actions, diagnostics, setUrl: (value: string) => { url = value; }, getUrl: () => url, tick: (seconds: number) => { clock = new Date(Date.parse(clock) + seconds * 1000).toISOString(); } };
}

describe('durable automatic authentication', () => {
  const recoveryState = (): EngineState => ({ ...bound(), stage: null, lastCandidate: '2026-11-19',
    group: { ...bound().group!, dashboardPath: '/en-ca/niv/groups' },
    executor: { tabId: 7, applicantIds: ids, targetTime: '09:00', skippedDates: [], actionPending: false } });
  const site = 'https://ais.usvisa-info.com';

  it.each(['/en-ca/niv/groups', '/en-ca/niv/users/edit', '/en-ca/niv/schedule/11111111/continue',
    '/en-ca/niv/schedule/11111111/continue_actions', '/en-ca/niv/users/sign_in',
    '/en-ca/niv/schedule/99999999/appointment', '/en-ca/niv/schedule/99999999/payment',
    '/en-ca/niv/schedule/99999999/appointment?applicants[]=12345678&commit=Continue',
    '/en-ca/niv/groups/99999999'])('recovers manual navigation at %s through existing renewal and fresh validation', async path => {
    const h = harness();
    const original = recoveryState();
    h.setUrl(site + path);
    expect(needsNavigationRecovery(original, { id: 7, url: h.getUrl() })).toBe(true);
    let state = validateEngineState(beginAuthentication(original, 'renew', NOW, () => 0, true));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, site + '/en-ca/niv/');
    expect(h.saved[0]?.authentication).toMatchObject({ tabId: 7, pending: true, checkpoint: 'navigation', dashboardFirst: true });
    expect(state.lastCandidate).toBeNull();
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.deps.createTab).not.toHaveBeenCalled();
    // A valid session returns directly to the dashboard without credential actions.
    h.setUrl(site + '/en-ca/niv/groups');
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', runId: original.runId, authentication: null,
      stage: 'actions', sessionRenewals: 0, lastCandidate: null, executor: { tabId: 7, targetTime: null } });
    expect(h.actions).toEqual([]);
    expect(state.group).toEqual(original.group);
  });

  it('falls through the existing signed-out landing and login flow', async () => {
    const h = harness();
    h.setUrl(site + '/en-ca/niv/users/edit');
    let state = await runAuthentication(h.deps, beginAuthentication(recoveryState(), 'renew', NOW, () => 0, true));
    for (let i = 0; i < 5 && state.authentication; i++) { h.tick(2); state = await runAuthentication(h.deps, state); }
    expect(state).toMatchObject({ status: 'running', authentication: null, stage: 'actions' });
    expect(h.actions).toEqual(['prepare', 'submit']);
    expect(h.deps.createTab).not.toHaveBeenCalled();
  });

  it('treats a foreign-group pending URL as recovery-only, even at an expected route', async () => {
    const state = recoveryState();
    const tab = { id: 7, url: site + '/en-ca/niv/schedule/11111111/appointment',
      pendingUrl: site + '/en-ca/niv/schedule/99999999/appointment' };
    expect(needsNavigationRecovery(state, tab)).toBe(true);
    const h = harness(); h.deps.getTab = async () => tab;
    const next = await runAuthentication(h.deps, beginAuthentication(state, 'renew', NOW, () => 0, true));
    expect(next.group).toEqual(state.group);
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, site + '/en-ca/niv/');
  });

  it('does not broaden ordinary renewal or bind a foreign group during recovery', async () => {
    const h = harness(); h.setUrl(site + '/en-ca/niv/schedule/99999999/appointment');
    const initial = recoveryState();
    expect(await runAuthentication(h.deps, beginAuthentication(initial, 'renew', NOW)))
      .toMatchObject({ status: 'stopped', authenticationFailureReason: 'untrusted-navigation' });
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    const recovery = await runAuthentication(h.deps, beginAuthentication(initial, 'renew', NOW, () => 0, true));
    h.setUrl(site + '/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = async (tab, func, params) => func.name === 'readDashboardGroups'
      ? { groups: [{ scheduleId: '99999999', ivr: '22222222', paymentStatus: 'paid' }] } : inject(tab, func, params);
    const next = await runAuthentication(h.deps, recovery);
    expect(next).toMatchObject({ status: 'stopped', authentication: null, group: initial.group });
    expect(h.actions).toEqual([]);
  });

  it.each(['https://example.invalid/en-ca/niv/users/edit', site + '/en-ca/niv/schedule/not-a-group/appointment',
    site + '/en-ca/niv/groups/invalid', site + '/en-ca/niv/users/edit?next=unsafe',
    site + '/en-ca/niv/schedule/99999999/appointment?next=unsafe',
    site + '/en-ca/niv/users/edit#unsafe', site + '/en-us/niv/users/edit', 'about:blank'])('refuses navigation recovery from %s', async url => {
    const state = recoveryState();
    expect(isNavigationRecoveryUrl(state, url)).toBe(false);
    expect(needsNavigationRecovery(state, { id: 7, url })).toBe(false);
    const h = harness(); h.setUrl(url);
    expect(await runAuthentication(h.deps, beginAuthentication(state, 'renew', NOW, () => 0, true)))
      .toMatchObject({ status: 'stopped', authenticationFailureReason: 'untrusted-navigation' });
    expect(h.deps.navigateTab).not.toHaveBeenCalled(); expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.deps.createTab).not.toHaveBeenCalled();
  });

  it('does not recover an expected form, another tab, stopped work, or unsafe mutations', () => {
    const state = recoveryState(); const tab = { id: 7, url: site + '/en-ca/niv/users/edit' };
    expect(needsNavigationRecovery(state, { id: 7, url: site + '/en-ca/niv/schedule/11111111/appointment' })).toBe(false);
    expect(needsNavigationRecovery(state, { id: 7, url: site + '/en-ca/niv/schedule/11111111/appointment?applicants[]=77777777&applicants[]=88888888&commit=Continue' })).toBe(false);
    expect(needsNavigationRecovery(state, { ...tab, id: 8 })).toBe(false);
    expect(needsNavigationRecovery({ ...state, status: 'stopped' }, tab)).toBe(false);
    expect(needsNavigationRecovery({ ...state, executor: { ...state.executor!, actionPending: true } }, tab)).toBe(false);
    const intent = { runId: args.runId, mode: 'booking' as const, groupId: '11111111', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW };
    expect(needsNavigationRecovery({ ...state, intent }, tab)).toBe(false);
    expect(beginAuthentication({ ...state, intent }, 'renew', NOW, () => 0, true).authentication).toBeNull();
  });

  it.each(['cancel', 'settings', 'offsite', 'group', 'closed', 'storage'] as const)('rechecks %s after checkpoint before navigating', async change => {
    const h = harness(); h.setUrl(site + '/en-ca/niv/users/edit');
    const save = h.deps.saveState;
    h.deps.saveState = async state => {
      await save(state);
      if (change === 'cancel') h.deps.isCancelled = () => true;
      if (change === 'settings') h.deps.loadPrefs = async () => ({ ...prefs, password: 'changed-synthetic-password' });
      if (change === 'offsite') h.setUrl('https://example.invalid/');
      if (change === 'group') h.setUrl(site + '/en-ca/niv/schedule/99999999/appointment');
      if (change === 'closed') h.deps.getTab = async () => { throw new Error('closed'); };
      if (change === 'storage') throw new Error('storage');
    };
    const state = await runAuthentication(h.deps, beginAuthentication(recoveryState(), 'renew', NOW, () => 0, true));
    expect(state.status).toBe(change === 'group' ? 'running' : 'stopped');
    if (change === 'group') expect(state).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'retry', dashboardFirst: true } });
    expect(h.deps.navigateTab).not.toHaveBeenCalled(); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('recovers a suspended GET checkpoint on budget, but never a browser restart', async () => {
    const h = harness(); h.setUrl(site + '/en-ca/niv/users/edit');
    await runAuthentication(h.deps, beginAuthentication(recoveryState(), 'renew', NOW, () => 0, true));
    const pending = h.saved[0]!;
    h.setUrl(site + '/en-ca/niv/users/edit'); // worker died before its GET
    const resumed = validateEngineState(reconcileStartup(pending, NOW));
    expect(await runAuthentication(h.deps, resumed)).toEqual(resumed);
    vi.mocked(h.deps.navigateTab!).mockClear();
    h.tick(60);
    expect(await runAuthentication(h.deps, resumed)).toMatchObject({ status: 'running', authentication: { pending: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, site + '/en-ca/niv/');
    expect(reconcileStartup(pending, NOW, true)).toMatchObject({ status: 'verifying', authentication: null });
  });

  it.each(['roster', 'baseline', 'group'] as const)('keeps existing %s-change refusal after dashboard recovery', async change => {
    const h = harness(); h.setUrl(site + '/en-ca/niv/users/edit');
    let state = await runAuthentication(h.deps, beginAuthentication(recoveryState(), 'renew', NOW, () => 0, true));
    h.setUrl(site + '/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = async (tab, func, params) => {
      if (func.name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: '22222222', kind: 'booked',
        text: change === 'baseline' ? 'January 2, 2027' : 'January 1, 2027', applicantIds: change === 'roster' ? [ids[0]] : ids };
      if (func.name === 'readDashboardGroups' && change === 'group') return { groups: [{ scheduleId: '99999999', ivr: '22222222', paymentStatus: 'paid' }] };
      return inject(tab, func, params);
    };
    state = await runAuthentication(h.deps, state);
    expect(state.status).toBe('stopped'); expect(state.authentication).toBeNull(); expect(h.actions).toEqual([]);
  });

  it('recovers the owned unpaid tab without booking actions or replacing notification history', async () => {
    const h = harness(); const original = recoveryState();
    const state: EngineState = { ...original, mode: 'alerts', stage: null, executor: null, monitorTabId: 7,
      group: { scheduleId: '33333333', ivr: '44444444', kind: 'unpaid', currentDate: null, dashboardPath: '/en-ca/niv/groups' } };
    h.setUrl(site + '/en-ca/niv/groups');
    expect(needsNavigationRecovery(state, { id: 7, url: h.getUrl() })).toBe(true);
    let next = await runAuthentication(h.deps, beginAuthentication(state, 'renew', NOW, () => 0, true));
    h.setUrl(site + '/en-ca/niv/groups');
    next = await runAuthentication(h.deps, next);
    expect(next).toMatchObject({ status: 'running', authentication: null, monitorTabId: 7, executor: null, group: state.group });
    expect(h.actions).toEqual([]);
    expect(vi.mocked(h.deps.inject).mock.calls.some(call => call[1].name === 'readCurrentAppointment')).toBe(false);
  });

  it.each(['navigation', 'action'] as const)('recovers an interrupted typed login %s checkpoint on worker wake without replay', async checkpoint => {
    const h = harness();
    const started = beginAuthentication(seed(), 'start', NOW);
    const pending = validateEngineState({ ...started, authentication: { ...started.authentication!, tabId: 7,
      pending: true, checkpoint, phase: 'submit' } });
    const resumed = validateEngineState(reconcileStartup(pending, NOW));
    expect(resumed).toMatchObject({ status: 'running', authentication: { pending: false,
      phase: checkpoint === 'action' ? 'wait' : 'retry' } });
    if (checkpoint === 'action') expect(resumed.authentication!.submittedInCycle).toBe(true);
    const early = await runAuthentication(h.deps, resumed);
    expect(early.authentication?.phase).toBe(checkpoint === 'action' ? 'wait' : 'retry');
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
    h.tick(60);
    const next = await runAuthentication(h.deps, resumed);
    expect(next).toMatchObject({ status: 'running', authentication: { pending: false, phase: 'prepare', submittedInCycle: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
    expect(h.actions).toEqual([]);
    expect(reconcileStartup(pending, NOW, true)).toMatchObject({ status: 'verifying', authentication: null, nextPollAt: null });
    const { checkpoint: _kind, ...legacy } = pending.authentication!;
    expect(reconcileStartup({ ...pending, authentication: legacy }, NOW)).toMatchObject({ status: 'verifying', authentication: null });
  });
  it.each(['retry', 'wait', 'cycle-wait'] as const)('uses a checkpointed browser GET when the %s document cannot return a navigation reply', async phase => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    state = { ...state, consecutiveFailures: 1, nextPollAt: NOW,
      authentication: { ...state.authentication!, phase, submittedInCycle: phase === 'wait' } };
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'retryAuthenticationPage' ? null : inject(tab, func, params));
    h.deps.navigateTab = vi.fn(async (tabId, url) => {
      expect(h.saved.at(-1)?.authentication?.pending).toBe(true);
      expect(tabId).toBe(7);
      expect(url).toBe(h.getUrl());
    });
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false,
      authentication: { phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('retryAuthenticationPage');
    expect(h.actions).toEqual([]);
  });

  it.each([60, 600, 86400])('quietly retries maintenance at the configured %s-second interval and recovers', async interval => {
    const h = harness();
    const settings = { ...prefs, interval };
    h.deps.loadPrefs = async () => settings;
    let state = await runAuthentication(h.deps, beginAuthentication({ ...seed(), pollIntervalS: interval, policyKey: policyKey(settings) }, 'start', NOW));
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'readSiteMaintenance' ? { maintenance: true } : inject(tab, func, params));
    state = validateEngineState(await runAuthentication(h.deps, state));
    const deadline = new Date(Date.parse(NOW) + interval * 1000).toISOString();
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationError: null, manualAuthentication: false,
      consecutiveFailures: 1, cooldownUntil: null, nextPollAt: deadline, authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'running', reviewRequired: false });
    expect(h.saved).toHaveLength(0); expect(h.actions).toEqual([]);
    expect(await runAuthentication(h.deps, state)).toEqual(state);
    expect(h.deps.inject).toHaveBeenCalledOnce();
    h.tick(interval);
    // A reconstructed worker retains the wait and tab, then checkpoints the GET.
    state = reconcileStartup(state, h.deps.nowIso());
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, phase: 'prepare', pending: false, startedAt: deadline } });
    expect(h.saved.at(-1)?.authentication).toMatchObject({ pending: true, startedAt: deadline });
    h.deps.inject = inject;
    for (let step = 0; step < 3; step++) { h.tick(2); state = await runAuthentication(h.deps, state); }
    expect(state).toMatchObject({ status: 'running', authentication: null, consecutiveFailures: 0, cooldownUntil: null, loginFailed: false });
    expect(h.actions).toEqual(['prepare', 'submit']);
    expect(JSON.stringify([state, ...h.saved])).not.toContain(prefs.password);
  });
  it.each(['start', 'renew', 'verify'] as const)('retries the canonical dashboard with a browser GET for %s while preserving custody and intent', async purpose => {
    const h = harness();
    const initial: EngineState = purpose === 'start' ? seed() : purpose === 'renew' ? bound() : { ...bound(), status: 'verifying', intent: {
      runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: NOW,
    } };
    let state = await runAuthentication(h.deps, beginAuthentication(initial, purpose, NOW));
    const dashboard = 'https://ais.usvisa-info.com/en-ca/niv/groups/99999999';
    h.setUrl(dashboard);
    state = { ...state, consecutiveFailures: 1, authentication: { ...state.authentication!, phase: 'retry' }, nextPollAt: NOW };
    h.deps.inject = vi.fn(async () => null);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: initial.status, intent: initial.intent, group: initial.group, consecutiveFailures: 1,
      loginFailed: false, authentication: { tabId: 7, phase: 'prepare', pending: false }, sessionRenewals: purpose === 'renew' ? 1 : 0 });
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, dashboard);
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
    const interrupted = reconcileStartup(h.saved.at(-1)!, h.deps.nowIso());
    // A worker-wake interruption of a browser-side GET checkpoint is provably
    // safe to recover: the held cycle deadline is respected and the resumed
    // pass revalidates before any action. A real browser restart still parks.
    expect(interrupted).toMatchObject({ status: initial.status, intent: initial.intent,
      authentication: { tabId: 7, phase: 'retry', pending: false }, nextPollAt: interrupted.authentication!.cycleDeadline });
    expect(reconcileStartup(h.saved.at(-1)!, h.deps.nowIso(), true))
      .toMatchObject({ status: 'verifying', authentication: null, nextPollAt: null });
  });

  it('holds a counted retry without double-counting when the retry GET races to another trusted route', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    state = { ...state, consecutiveFailures: 2, authentication: { ...state.authentication!, phase: 'retry' }, nextPollAt: NOW };
    const save = h.deps.saveState;
    h.deps.saveState = async checkpoint => {
      await save(checkpoint);
      // The tab completes a trusted dashboard redirect between the durable
      // checkpoint and the fresh GET: a benign race, never a terminal failure.
      h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups/99999999');
    };
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false, consecutiveFailures: 2, cooldownUntil: null,
      authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(state.nextPollAt).toBe(state.authentication!.cycleDeadline);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });

  it.each(['missing-api', 'navigation-failure', 'pending-offsite', 'settings-change', 'cancelled'] as const)('refuses unsafe browser GET recovery without DOM fallback (%s)', async issue => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    state = { ...state, authentication: { ...state.authentication!, phase: 'retry' }, nextPollAt: NOW };
    const navigate = h.deps.navigateTab!;
    if (issue === 'missing-api') h.deps.navigateTab = undefined;
    if (issue === 'navigation-failure') h.deps.navigateTab = vi.fn(async () => { throw new Error('synthetic navigation failure'); });
    if (issue === 'pending-offsite') h.deps.getTab = async () => ({ id: 7, url: h.getUrl(), pendingUrl: 'https://example.invalid/' });
    if (issue === 'settings-change' || issue === 'cancelled') {
      const save = h.deps.saveState;
      h.deps.saveState = async checkpoint => {
        await save(checkpoint);
        if (issue === 'settings-change') h.deps.loadPrefs = async () => ({ ...prefs, interval: 600 });
        if (issue === 'cancelled') h.deps.isCancelled = () => true;
      };
    }
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    if (issue === 'navigation-failure') expect(h.deps.navigateTab).toHaveBeenCalledOnce();
    else expect(navigate).not.toHaveBeenCalled();
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });
  it.each(['start', 'renew', 'verify'] as const)('keeps %s maintenance on budget through cooldown without consuming renewals or losing intent', async purpose => {
    const h = harness();
    const initial: EngineState = purpose === 'start' ? seed() : purpose === 'renew' ? bound() : { ...bound(), status: 'verifying', intent: {
      runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: NOW,
    } };
    let state = await runAuthentication(h.deps, beginAuthentication(initial, purpose, NOW));
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'readSiteMaintenance' ? { maintenance: true } : inject(tab, func, params));
    for (let count = 1; count <= 10; count++) {
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.consecutiveFailures).toBe(count);
      expect(state.intent).toEqual(initial.intent);
      expect(state.group).toEqual(initial.group);
      expect(state.sessionRenewals).toBe(purpose === 'renew' ? 1 : 0);
      expect(state.loginFailed).toBe(false);
      if (count < 10) { h.tick(60); state = await runAuthentication(h.deps, state); h.tick(2); }
    }
    const cooldown = new Date(Date.parse(h.deps.nowIso()) + 1800_000).toISOString();
    expect(state).toMatchObject({ cooldownUntil: cooldown, nextPollAt: null, authentication: { phase: 'retry' } });
    expect(engineAlarmAt(state)).toBe(cooldown);
    state = reconcileStartup(validateEngineState(JSON.parse(JSON.stringify(state))), h.deps.nowIso());
    expect(engineAlarmAt(state)).toBe(cooldown);
    const calls = vi.mocked(h.deps.inject).mock.calls.length;
    h.tick(1799); expect(await runAuthentication(h.deps, state)).toEqual(state);
    expect(h.deps.inject).toHaveBeenCalledTimes(calls);
    h.tick(1); state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ consecutiveFailures: 1, cooldownUntil: null, authentication: { phase: 'retry' }, intent: initial.intent });
    expect(h.actions).toEqual([]);
  });
  it.each(['prepare', 'submit', 'wait'] as const)('recognizes maintenance during %s before the ordinary timeout', async phase => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    state = { ...state, authentication: { ...state.authentication!, phase } };
    h.tick(120);
    h.deps.inject = vi.fn(async () => ({ maintenance: true }));
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authentication: { phase: 'retry' }, consecutiveFailures: 1 });
    expect(h.actions).toEqual([]);
  });
  it.each(['offsite', 'query', 'fragment', 'cancelled', 'checkpoint'])('refuses unsafe maintenance retries (%s)', async issue => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    state = { ...state, authentication: { ...state.authentication!, phase: 'retry' }, nextPollAt: NOW };
    if (issue === 'offsite') h.setUrl('https://example.invalid/en-ca/niv/users/sign_in');
    if (issue === 'query') h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in?next=https://example.invalid');
    if (issue === 'fragment') h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in#other');
    if (issue === 'cancelled') h.deps.isCancelled = () => true;
    if (issue === 'checkpoint') h.deps.saveState = async () => { throw new Error('synthetic storage failure'); };
    if (issue === 'checkpoint') await expect(runAuthentication(h.deps, state)).rejects.toThrow('synthetic storage failure');
    else expect(await runAuthentication(h.deps, state)).toMatchObject({ authentication: null });
    expect(h.deps.inject).not.toHaveBeenCalled(); expect(h.actions).toEqual([]);
  });
  it('recovers a transient maintenance-read failure on the same trusted login with a counted retry', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 }, consecutiveFailures: 1, nextPollAt: NOW };
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readSiteMaintenance') throw new Error('synthetic interruption');
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    // The exact login is independently revalidated: the transient read
    // failure counts exactly once on the shared budget, clears the pending
    // checkpoint and holds a fresh-GET retry without navigating or mutating.
    expect(state).toMatchObject({ status: 'running', loginFailed: false, consecutiveFailures: 2, cooldownUntil: null,
      authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(state.nextPollAt).toBe(state.authentication!.cycleDeadline);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });
  it('recovers a transient maintenance-read failure on the clean landing root', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/');
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 }, nextPollAt: NOW };
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readSiteMaintenance') throw new Error('synthetic interruption');
      return inject(tab, func, params);
    });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false, consecutiveFailures: 1,
      authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });
  it('refuses a maintenance-read failure when the live document left the trusted login', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 }, nextPollAt: NOW };
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readSiteMaintenance') throw new Error('synthetic interruption');
      return inject(tab, func, params);
    });
    h.deps.getTab = vi.fn()
      .mockResolvedValueOnce({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in' })
      .mockResolvedValue({ id: 7, url: 'https://example.invalid/en-ca/niv/users/sign_in' });
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true,
      authenticationFailureReason: 'untrusted-navigation' });
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });
  it('waits out an identifiable transient login gap and lets an expired cycle validate the dashboard', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false }
      : ({ ok: false, reason: 'retryable' }));
    // Identifiable transient incompleteness waits the remaining cycle without
    // counting a failure yet.
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 0,
      authentication: { phase: 'cycle-wait', pending: false }, nextPollAt: '2026-10-12T00:01:00.000Z' });
    expect(h.actions).toEqual([]);
    // Early alarms hold the wait without extra injections.
    expect(await runAuthentication(h.deps, state)).toEqual(state);
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(2);
    // At expiry a trustworthy dashboard still wins over counting a failure.
    h.deps.inject = inject;
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, consecutiveFailures: 0,
      group: { scheduleId: '11111111', applicantIds: ids } });
    expect(h.actions).toEqual([]);
  });
  it('stops on explicit credential rejection without an automatic retry', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false }
      : ({ ok: false, reason: 'credential-rejected' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true, consecutiveFailures: 0 });
    expect(h.actions).toEqual([]);
  });
  it('migrates legacy authentication saves to a deterministic cycle deadline', () => {
    const legacy = beginAuthentication(seed(), 'start', NOW);
    const { cycleStartedAt, cycleDeadline, submittedInCycle, ...rest } = legacy.authentication!;
    expect([cycleStartedAt, cycleDeadline, submittedInCycle]).toEqual([NOW, '2026-10-12T00:01:00.000Z', false]);
    const prepared = validateEngineState({ ...legacy, authentication: { ...rest, phase: 'prepare' as const } });
    expect(prepared.authentication).toMatchObject({ cycleStartedAt: NOW,
      cycleDeadline: '2026-10-12T00:01:00.000Z', submittedInCycle: false });
    const waited = validateEngineState({ ...legacy, authentication: { ...rest, phase: 'wait' as const } });
    expect(waited.authentication).toMatchObject({ submittedInCycle: true });
    expect(() => validateEngineState({ ...legacy,
      authentication: { ...rest, phase: 'cycle-wait' as const, cycleDeadline: 'not-a-date' } })).toThrow();
  });
  it.each(['prepare', 'submit'] as const)('keeps the %s phase after notice dismissal and submits only once', async phase => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    if (phase === 'submit') state = await runAuthentication(h.deps, state);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async () => ({ ok: false, reason: 'sign-in-notice-dismissed' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false, manualAuthentication: false,
      authentication: { phase, pending: false, startedAt: NOW }, nextPollAt: '2026-10-12T00:00:02.000Z' });
    expect(h.actions).toEqual(phase === 'prepare' ? [] : ['prepare']);
    h.deps.inject = inject;
    for (let cycle = 0; cycle < (phase === 'prepare' ? 3 : 2); cycle++) { h.tick(2); state = await runAuthentication(h.deps, state); }
    expect(h.actions).toEqual(['prepare', 'submit']);
    expect(state).toMatchObject({ status: 'running', authentication: null, loginFailed: false });
  });
  it('recycles an expired notice-dismissal cycle without losing verification intent', async () => {
    const h = harness();
    const initial: EngineState = { ...bound(), status: 'verifying', intent: {
      runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: true, createdAt: NOW,
    } };
    let state = await runAuthentication(h.deps, beginAuthentication(initial, 'verify', NOW));
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'retryAuthenticationPage'
      ? { ok: true }
      : ({ ok: false, reason: 'sign-in-notice-dismissed' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'verifying', intent: initial.intent, authentication: { phase: 'prepare', pending: false, startedAt: NOW } });
    // Past the configured cycle the worker counts exactly one failure and opens
    // a fresh GET cycle immediately instead of stopping; intent is preserved.
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'verifying', intent: initial.intent, consecutiveFailures: 1, cooldownUntil: null,
      authentication: { phase: 'prepare', pending: false } });
    expect(state.authentication!.cycleStartedAt).not.toBe(NOW);
    expect(h.actions).toEqual([]);
    // Ten expired cycles earn the shared 30-minute cooldown with intent intact.
    for (let count = 2; count <= 10; count++) {
      h.tick(60);
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.consecutiveFailures).toBe(count);
      expect(state.intent).toEqual(initial.intent);
    }
    const cooldown = new Date(Date.parse(h.deps.nowIso()) + 1800_000).toISOString();
    expect(state).toMatchObject({ cooldownUntil: cooldown, nextPollAt: null,
      authentication: { phase: 'retry', pending: false }, intent: initial.intent });
    // The cooldown resumes automatically with a fresh GET and kept intent.
    h.tick(1800);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ authentication: { phase: 'prepare', pending: false }, intent: initial.intent });
    expect(h.actions).toEqual([]);
  });
  it.each(['start', 'verify'] as const)('hands %s authentication to the user without a credential-failure claim or automatic retry', async purpose => {
    const h = harness();
    const initial: EngineState = purpose === 'start' ? seed() : { ...bound(), status: 'verifying', intent: {
      runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: true, createdAt: NOW,
    } };
    let state = await runAuthentication(h.deps, beginAuthentication(initial, purpose, NOW));
    h.deps.inject = vi.fn(async () => ({ ok: false, reason: 'manual-authentication' }));
    state = validateEngineState(JSON.parse(JSON.stringify(await runAuthentication(h.deps, state))));
    expect(state).toMatchObject({ status: purpose === 'start' ? 'stopped' : 'verifying', authentication: null, nextPollAt: null,
      loginFailed: false, manualAuthentication: true, intent: initial.intent });
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'idle', reviewRequired: true, manualAuthentication: true });
    expect(await runAuthentication(h.deps, state)).toEqual(state);
    expect(h.deps.inject).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state)).not.toContain(prefs.password);
    if (purpose === 'start') expect(startRun(state, { ...args, runId: 'fresh-run-0001', mode: 'booking' }).manualAuthentication).toBe(false);
    else expect(startRun(state, { ...args, runId: 'fresh-run-0001', mode: 'booking' }).intent).toEqual(initial.intent);
  });
  it('signs in once across paced steps, binds the selected group and independent roster, and excludes credentials from saved state', async () => {
    const h = harness(); let state = beginAuthentication(seed(), 'start', NOW);
    for (let cycle = 0; cycle < 4; cycle++) {
      state = await runAuthentication(h.deps, state);
      expect(Date.parse(state.nextPollAt!) - Date.parse(h.deps.nowIso())).toBe(2_000);
      h.tick(2);
    }
    expect(h.actions).toEqual(['prepare', 'submit']);
    expect(state).toMatchObject({ status: 'running', authentication: null, group: { scheduleId: '11111111', applicantIds: ids }, stage: 'actions', executor: { tabId: 7, applicantIds: ids }, nextPollAt: '2026-10-12T00:00:08.000Z' });
    expect(JSON.stringify([state, ...h.saved])).not.toContain(prefs.password);
    expect(JSON.stringify([state, ...h.saved])).not.toContain(prefs.email);
  });
  it('binds a paid unscheduled single applicant after successful sign-in', async () => {
    const h = harness();
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'readCurrentAppointment'
      ? { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null, applicantIds: [ids[0]] }
      : inject(tab, func, params));
    let state = beginAuthentication(seed(), 'start', NOW);
    for (let cycle = 0; cycle < 4; cycle++) { state = await runAuthentication(h.deps, state); h.tick(2); }
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationError: null,
      group: { currentDate: null, applicantIds: [ids[0]] }, executor: { tabId: 7, applicantIds: [ids[0]] } });
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it('reports post-login selection failures in the existing banner, without claiming login failed', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] };
      return inject(tab, func, params);
    });
    const initial = beginAuthentication(seed(), 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: false, authentication: null, nextPollAt: null });
    expect(state.authenticationError).toBeTruthy();
    expect(JSON.stringify(state)).not.toContain('synthetic-secret');
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', reviewRequired: true, reviewMessage: state.authenticationError,
      failureKind: 'paid-ivr-not-found' });
    expect(JSON.stringify(panelSnapshot(state, null, null))).not.toContain('synthetic-secret');
    expect(h.actions).toEqual([]);
    expect(beginAuthentication({ ...state, status: 'running' }, 'start', NOW).authenticationError).toBeNull();
    expect(startRun(state, { ...args, runId: 'fresh-run-0001', mode: 'booking' }).authenticationError).toBeNull();
  });
  it.each(['groups', 'appointment', 'applicants'] as const)('recovers a post-login %s reading failure on the counted retry budget instead of stopping', async step => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') {
        if (step === 'groups') throw new Error('synthetic-secret');
      }
      if (func.name === 'readCurrentAppointment') {
        if (step === 'appointment') throw new Error('synthetic-secret');
        if (step === 'applicants') return { scheduleId: '11111111', ivr: '22222222', kind: 'unbooked', text: null };
      }
      return inject(tab, func, params);
    });
    const initial = beginAuthentication(seed(), 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    // A transient reading failure in a still-trusted dashboard counts exactly
    // one failure and holds a durable retry deadline without mutating the page,
    // opening a banner or claiming a login failure; the next wake revalidates
    // trust, group, baseline/roster and configuration before any action.
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationError: null, authenticationFailureReason: null,
      consecutiveFailures: 1, cooldownUntil: null, authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(state.nextPollAt).toBe(state.authentication!.cycleDeadline);
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'running', reviewRequired: false });
    expect(JSON.stringify([state, panelSnapshot(state, null, null)])).not.toContain('synthetic-secret');
    expect(h.actions).toEqual([]);
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('performLoginAction');
  });
  it('classifies a post-login unpaid IVR mismatch without claiming login failed', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] };
      return inject(tab, func, params);
    });
    const alerts = { ...prefs, interval: 60 };
    h.deps.loadPrefs = async () => alerts;
    const initial = beginAuthentication({ ...seed(), mode: 'alerts', policyKey: policyKey(alerts) }, 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: false, authentication: null, nextPollAt: null,
      authenticationError: 'No eligible unpaid group was found on this dashboard. Check the Unpaid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.' });
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', failureKind: 'unpaid-ivr-not-found', reviewRequired: true });
    expect(JSON.stringify(panelSnapshot(state, null, null))).not.toContain('22222222');
    expect(JSON.stringify(panelSnapshot(state, null, null))).not.toContain('44444444');
    expect(h.actions).toEqual([]);
  });
  it('keeps post-login ambiguous and changed-group diagnostics generic', async () => {
    // Ambiguous duplicate dashboard cards are a malformed reading: recover on
    // the counted retry budget with no identifiers or banner leaked.
    {
      const h = harness();
      h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
      const inject = h.deps.inject;
      h.deps.inject = vi.fn(async (tab, func, params) => {
        if (func.name === 'readDashboardGroups') return { groups: [
          { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
          { scheduleId: '11111111', ivr: '99999999' },
        ] };
        return inject(tab, func, params);
      });
      const initial = beginAuthentication(seed(), 'start', NOW);
      const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
      expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationError: null, consecutiveFailures: 1,
        authentication: { phase: 'retry', pending: false } });
      expect(JSON.stringify(state)).not.toContain('99999999');
      expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'running', reviewRequired: false });
    }
    // A changed bound group stays terminal with a generic banner and no leak.
    {
      const h = harness();
      h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
      const inject = h.deps.inject;
      h.deps.inject = vi.fn(async (tab, func, params) => {
        if (func.name === 'readDashboardGroups') return { groups: [{ scheduleId: '33333333', ivr: '22222222', paymentStatus: 'paid' }] };
        if (func.name === 'readCurrentAppointment') return { scheduleId: '33333333', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: ids };
        return inject(tab, func, params);
      });
      const initial = beginAuthentication(bound(), 'start', NOW);
      const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
      expect(state).toMatchObject({ status: 'stopped', loginFailed: false });
      expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', failureKind: 'generic' });
      expect(JSON.stringify(panelSnapshot(state, null, null))).not.toContain('33333333');
      expect(JSON.stringify(panelSnapshot(state, null, null))).not.toContain('22222222');
    }
  });
  it('rejects arbitrary persisted authentication diagnostics and migrates older saves', () => {
    expect(validateEngineState(seed()).authenticationError).toBeNull();
    expect(() => validateEngineState({ ...seed(), authenticationError: 'synthetic-secret' })).toThrow('Invalid authentication diagnostic.');
  });
  it('waits on a reused payment tab en route to the dashboard instead of failing Start', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'alerts' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment');
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'running', loginFailed: false, nextPollAt: '2026-10-12T00:00:02.000Z' });
    expect(state.authentication).not.toBeNull();
  });
  it('reuses a same-origin account maintenance page for Start instead of opening a login tab', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/account');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'readSiteMaintenance' ? { maintenance: true } : inject(tab, func, params));
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'running', loginFailed: false, authenticationError: null, manualAuthentication: false,
      consecutiveFailures: 1, authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(h.deps.createTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
    // The retry reloads the same account URL instead of failing.
    h.tick(60);
    state = await runAuthentication(h.deps, state);
    expect(state.authentication).toMatchObject({ tabId: 7, phase: 'prepare', pending: false });
    expect(h.deps.createTab).not.toHaveBeenCalled();
  });
  it('waits on a same-origin account page en route to identity resolution instead of failing Start', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/account');
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'running', loginFailed: false, nextPollAt: '2026-10-12T00:00:02.000Z' });
    expect(state.authentication).not.toBeNull();
    expect(h.deps.createTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });
  it('keeps renewal strict on an unexpected account page', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/account');
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'stopped', loginFailed: true, authentication: null });
  });
  it('keeps renewal strict on unexpected payment pages', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/payment');
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'stopped', loginFailed: true, authentication: null });
  });
  it('leaves a landing page for sign-in in the same tab instead of opening one', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'alerts' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/');
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'running', loginFailed: false, nextPollAt: '2026-10-12T00:00:02.000Z' });
    expect(state.authentication).not.toBeNull();
    expect(h.deps.createTab).not.toHaveBeenCalled();
    // Clean landing means signed out: checkpointed browser navigation to the
    // fixed sign-in URL (no page-side script reply to lose, no manual click).
    expect(h.getUrl()).toBe('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.saved.at(-1)?.authentication).toMatchObject({ pending: true });
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('goToLoginFromLanding');
    expect(h.actions).toEqual([]);
  });
  it('leaves a clean verification landing page for sign-in promptly instead of parking on it', async () => {
    const h = harness();
    const initial: EngineState = { ...bound(), status: 'verifying', intent: {
      runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: true, createdAt: NOW,
    } };
    let state = beginAuthentication(initial, 'verify', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/');
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ nextPollAt: '2026-10-12T00:00:02.000Z' });
    expect(state.authentication).not.toBeNull();
    // A fully loaded landing page means signed out (an in-flight redirect
    // would still be loading), so verification proceeds to the fixed
    // sign-in URL immediately without parking on the public welcome page.
    expect(h.getUrl()).toBe('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.saved.at(-1)?.authentication).toMatchObject({ pending: true });
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('goToLoginFromLanding');
    expect(h.deps.createTab).not.toHaveBeenCalled();
    expect(state.intent).toEqual(initial.intent);
    expect(state.consecutiveFailures).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('waits for actual tab loading without filling or submitting and holds the cycle', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const complete = h.deps.getTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'about:blank', status: 'loading' }));
    h.tick(2);
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'running', nextPollAt: '2026-10-12T00:00:04.000Z', authentication: { phase: 'prepare', pending: false } });
    expect(h.deps.inject).not.toHaveBeenCalled();
    // A loading tab near the cycle boundary still neither fails nor submits; the
    // durable deadline is preserved and no login action runs on load alone.
    h.tick(56);
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ status: 'running', authentication: { phase: 'prepare', pending: false } });
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
    h.deps.getTab = complete;
    state = await runAuthentication(h.deps, state);
    expect(h.actions).toEqual(['prepare']);
  });
  it('holds a counted read-only retry when the owned login tab starts loading mid-read', async () => {
    const h = harness();
    const state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.getTab = vi.fn()
      .mockResolvedValueOnce({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'complete' })
      .mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' });
    const next = validateEngineState(await runAuthentication(h.deps, state));
    // Loading at the still-trusted exact login is recoverable: the injection
    // is refused, nothing is mutated, and the counted read-only retry holds
    // the observed failure with the context preserved.
    expect(next).toMatchObject({ status: 'running', loginFailed: false, consecutiveFailures: 1, cooldownUntil: null,
      authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(h.actions).toEqual([]);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
  });
  it('authenticates an unpaid workflow without reading or entering paid booking controls', async () => {
    const h = harness(); let state = beginAuthentication({ ...seed(), mode: 'alerts' }, 'start', NOW);
    for (let cycle = 0; cycle < 4; cycle++) { state = await runAuthentication(h.deps, state); h.tick(2); }
    expect(state).toMatchObject({ status: 'running', mode: 'alerts', group: { scheduleId: '33333333', kind: 'unpaid', currentDate: null }, executor: null, stage: null });
    expect(vi.mocked(h.deps.inject).mock.calls.filter(call => call[1].name !== 'readSiteMaintenance').map(call => call[1].name)).toEqual(['performLoginAction', 'performLoginAction', 'readDashboardGroups']);
  });
  it('rejects a paid-only dashboard for blank unpaid Start with the known kind', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
      ] };
      return inject(tab, func, params);
    });
    const alerts = { ...prefs, unpaidIvr: '', interval: 60 };
    h.deps.loadPrefs = async () => alerts;
    const initial = beginAuthentication({ ...seed(), mode: 'alerts', policyKey: policyKey(alerts) }, 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: false,
      authenticationError: 'No eligible unpaid group was found on this dashboard. Check the Unpaid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.' });
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', failureKind: 'unpaid-ivr-not-found' });
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('readCurrentAppointment');
  });
  it('uses the catch-all for blank unpaid Start on an unknown dashboard', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'unknown' },
      ] };
      return inject(tab, func, params);
    });
    const alerts = { ...prefs, unpaidIvr: '', interval: 60 };
    h.deps.loadPrefs = async () => alerts;
    const initial = beginAuthentication({ ...seed(), mode: 'alerts', policyKey: policyKey(alerts) }, 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: false });
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', failureKind: 'generic' });
  });
  it('rejects an explicitly selected paid group for alerts renewal with the known kind', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
        { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' },
      ] };
      if (func.name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: ids };
      return inject(tab, func, params);
    });
    const alerts = { ...prefs, paidIvr: '', unpaidIvr: '22222222', interval: 60 };
    h.deps.loadPrefs = async () => alerts;
    const initial = beginAuthentication({ ...seed(), mode: 'alerts', policyKey: policyKey(alerts) }, 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state.authenticationError).toBe('The selected alert group is not eligible for date alerts. Check both Visa Group IVRs and payment status in Settings.');
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', failureKind: 'unpaid-ivr-not-found' });
  });
  it('rejects a positively unpaid group for paid booking before any baseline read', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' },
      ] };
      return inject(tab, func, params);
    });
    const booking = { ...prefs, paidIvr: '', unpaidIvr: '', interval: 60 };
    h.deps.loadPrefs = async () => booking;
    const initial = beginAuthentication({ ...seed(), mode: 'booking', policyKey: policyKey(booking) }, 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: false });
    expect(state.authenticationError).toBe('The selected booking group is not eligible for paid booking. Check both Visa Group IVRs and payment status in Settings.');
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', failureKind: 'paid-ivr-not-found' });
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('readCurrentAppointment');
  });
  it('does not re-submit while awaiting a dashboard; the next cycle revalidates with a fresh GET', async () => {
    const h = harness(); let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    expect(h.actions).toEqual(['prepare']);
    state = await runAuthentication(h.deps, state);
    expect(h.actions).toEqual(['prepare', 'submit']);
    // The submit did not redirect yet: staying on the login page never replays
    // the POST within the same cycle.
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    state = await runAuthentication(h.deps, state);
    expect(state).toMatchObject({ authentication: { phase: 'wait', pending: false } });
    expect(h.actions).toEqual(['prepare', 'submit']);
    // The expired cycle counts one failure and opens a fresh GET cycle; only
    // the new cycle may submit again.
    h.tick(56);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    expect(h.actions).toEqual(['prepare', 'submit', 'prepare', 'submit']);
    expect(state).toMatchObject({ status: 'running', authentication: { phase: 'wait', submittedInCycle: true } });
  });
  it('does not mutate after a checkpoint failure or a Stop arriving during checkpoint', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.saveState = async () => { throw new Error('synthetic storage failure'); };
    await expect(runAuthentication(h.deps, state)).rejects.toThrow('synthetic storage failure');
    expect(h.actions).toEqual([]);
    let cancelled = false; h.deps.isCancelled = () => cancelled; h.deps.saveState = async () => { cancelled = true; };
    state = await runAuthentication(h.deps, state);
    expect(state.authentication).toBeNull(); expect(h.actions).toEqual([]);
  });
  it('parks interrupted credentials/submission on worker wake and browser restart', () => {
    const initial = beginAuthentication(seed(), 'start', NOW);
    const pending = { ...initial, authentication: { ...initial.authentication!, tabId: 7, pending: true } };
    expect(reconcileStartup(pending, NOW)).toMatchObject({ status: 'verifying', authentication: null, nextPollAt: null });
    expect(reconcileStartup(initial, NOW, true).status).toBe('verifying');
    expect(reconcileStartup({ ...initial, status: 'verifying', authentication: { ...initial.authentication!, purpose: 'verify' } }, NOW, true)).toMatchObject({ status: 'verifying', authentication: null, nextPollAt: null });
  });
  it('drops unknown secret fields from authentication saves and rejects malformed preferences before mutation', async () => {
    const h = harness(); const initial = beginAuthentication(seed(), 'start', NOW);
    const restored = validateEngineState({ ...initial, authentication: { ...initial.authentication!, password: 'synthetic-legacy-secret' } });
    expect(JSON.stringify(restored)).not.toContain('synthetic-legacy-secret');
    h.deps.loadPrefs = async () => ({ consulate: 'Vancouver' });
    expect(await runAuthentication(h.deps, initial)).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(h.actions).toEqual([]);
  });
  it.each(['changed-roster', 'changed-date', 'changed-group', 'offsite', 'closed'])('refuses renewal without trusted unchanged binding (%s)', async issue => {
    const h = harness();
    let state = beginAuthentication(bound(), 'renew', NOW);
    state = await runAuthentication(h.deps, state);
    h.setUrl(issue === 'offsite' ? 'https://example.invalid' : 'https://ais.usvisa-info.com/en-ca/niv/groups');
    if (issue === 'closed') h.deps.getTab = async () => { throw new Error('Synthetic closed tab'); };
    if (issue === 'changed-roster') state.group!.applicantIds = ids.slice(0, 1);
    if (issue === 'changed-date') state.group!.currentDate = '2026-12-01';
    if (issue === 'changed-group') state.group!.scheduleId = '99999999';
    const result = await runAuthentication(h.deps, state);
    if (issue.startsWith('changed-')) {
      expect(result).toMatchObject({ status: 'stopped', loginFailed: false,
        authenticationError: 'The signed-in group, appointment or applicant list changed. Check the dashboard and Settings before pressing Start.' });
    } else {
      expect(result).toMatchObject({ status: 'stopped', loginFailed: true });
    }
    expect(h.actions).toEqual([]);
  });
  it('keeps successful renewals running beyond four hours and retains alert history', async () => {
    const h = harness(); h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    let state: EngineState = { ...bound(), alert: { observed: '2026-11-19', delivered: '2026-11-19', pending: false } };
    for (let attempt = 0; attempt < 8; attempt++) {
      h.tick(3600);
      state = beginAuthentication(state, 'renew', h.deps.nowIso());
      state = await runAuthentication(h.deps, state);
      h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups'); h.tick(2);
      state = await runAuthentication(h.deps, state);
      expect(validateEngineState(state)).toMatchObject({ status: 'running', authentication: null, sessionRenewals: 0,
        alert: { observed: '2026-11-19', delivered: '2026-11-19', pending: false } });
    }
    expect(h.deps.createTab).toHaveBeenCalledTimes(1); // legacy unbound first renewal only
    expect(h.deps.navigateTab).toHaveBeenCalledTimes(7);
  });
  it('still bounds renewals which have not reached a validated dashboard', () => {
    let state = bound();
    for (let attempt = 0; attempt < 3; attempt++) {
      state = beginAuthentication(state, 'renew', NOW);
      state = { ...state, authentication: null };
    }
    expect(beginAuthentication(state, 'renew', NOW)).toMatchObject({ status: 'verifying', sessionRenewals: 3 });
  });
  it.each(['booking', 'alerts'] as const)('renews %s in its owned tab with a durable GET checkpoint', async mode => {
    const h = harness();
    h.setUrl(`https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/${mode === 'booking' ? 'appointment?applicants[]=77777777&applicants[]=88888888' : 'payment'}`);
    const state: EngineState = { ...bound(), mode, monitorTabId: mode === 'alerts' ? 7 : null,
      executor: mode === 'booking' ? { tabId: 7, applicantIds: ids, targetTime: null, skippedDates: [], actionPending: false } : null };
    const result = await runAuthentication(h.deps, beginAuthentication(state, 'renew', NOW));
    expect(result).toMatchObject({ status: 'running', authentication: { tabId: 7, purpose: 'renew', pending: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.deps.createTab).not.toHaveBeenCalled(); expect(h.deps.inject).not.toHaveBeenCalled();
    expect(reconcileStartup(h.saved.at(-1)!, NOW)).toMatchObject({ status: 'running',
      authentication: { tabId: 7, purpose: 'renew', phase: 'retry', pending: false } });
  });
  it.each(['wrong-group', 'offsite', 'unknown-route', 'query', 'fragment', 'pending-offsite', 'closed', 'changed-after-save', 'settings-change', 'cancelled', 'storage-failure'])(
    'refuses unsafe owned-tab renewal without opening a replacement (%s)', async issue => {
      const h = harness(); const base = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
      h.setUrl(base);
      const initial: EngineState = { ...bound(), executor: { tabId: 7, applicantIds: ids, targetTime: null, skippedDates: [], actionPending: false } };
      if (issue === 'wrong-group') h.setUrl(base.replace('11111111', '99999999'));
      if (issue === 'offsite') h.setUrl(base.replace('ais.usvisa-info.com', 'example.invalid'));
      if (issue === 'unknown-route') h.setUrl(base + '/other');
      if (issue === 'query') h.setUrl(base + '?next=other');
      if (issue === 'fragment') h.setUrl(base + '#other');
      if (issue === 'pending-offsite') h.deps.getTab = async () => ({ id: 7, url: base, pendingUrl: 'https://example.invalid/' });
      if (issue === 'closed') h.deps.getTab = async () => { throw new Error('synthetic closed tab'); };
      const save = h.deps.saveState;
      h.deps.saveState = async checkpoint => {
        if (issue === 'storage-failure') throw new Error('synthetic storage failure');
        await save(checkpoint);
        if (issue === 'changed-after-save') h.setUrl('https://example.invalid/');
        if (issue === 'settings-change') h.deps.loadPrefs = async () => ({ ...prefs, interval: 600 });
        if (issue === 'cancelled') h.deps.isCancelled = () => true;
      };
      expect(await runAuthentication(h.deps, beginAuthentication(initial, 'renew', NOW))).toMatchObject({ status: 'stopped', authentication: null });
      expect(h.deps.navigateTab).not.toHaveBeenCalled(); expect(h.deps.createTab).not.toHaveBeenCalled(); expect(h.deps.inject).not.toHaveBeenCalled();
    });
  it('logs in for verification without resetting the baseline or arming another booking', async () => {
    const h = harness();
    const initial: EngineState = { ...bound(), status: 'verifying', intent: { runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: NOW } };
    expect(beginAuthentication({ ...initial, status: 'running' }, 'renew', NOW).authentication).toBeNull();
    let state = beginAuthentication(initial, 'verify', NOW);
    for (let cycle = 0; cycle < 4; cycle++) { state = await runAuthentication(h.deps, state); h.tick(2); }
    expect(state).toMatchObject({ status: 'verifying', intent: initial.intent, group: initial.group, verificationTabId: 7, verification: { reads: [] } });
    expect(h.deps.createTab).toHaveBeenCalledWith('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
  });
  it('counts a stalled load once per cycle without DOM injection and advances the deadline', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(61);
    const calls = vi.mocked(h.deps.inject).mock.calls.length;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, cooldownUntil: null,
      authentication: { phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(state.authentication!.cycleStartedAt).toBe(h.deps.nowIso());
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(calls);
    expect(h.actions).toEqual([]);
    expect(h.saved.at(-1)).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'prepare', pending: true } });
    // Still loading inside the fresh cycle: no second count, no deadline reset.
    const deadline = state.authentication!.cycleDeadline!;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.consecutiveFailures).toBe(1);
    expect(state.authentication!.cycleDeadline).toBe(deadline);
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(calls);
    expect(h.actions).toEqual([]);
  });
  it('advances an overdue cycle-wait while loading instead of returning stale state', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false }
      : ({ ok: false, reason: 'retryable' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.authentication!.phase).toBe('cycle-wait');
    const overdue = state.nextPollAt!;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'prepare', pending: false } });
    expect(state.nextPollAt).not.toBe(overdue);
    expect(Date.parse(state.authentication!.cycleDeadline!) > Date.parse(overdue)).toBe(true);
    const again = validateEngineState(await runAuthentication(h.deps, state));
    expect(again.consecutiveFailures).toBe(1);
    expect(again.authentication!.cycleDeadline).toBe(state.authentication!.cycleDeadline);
    expect(h.actions).toEqual([]);
  });
  it('counts a stalled load after submit once without replaying the submit', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    expect(h.actions).toEqual(['prepare', 'submit']);
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1,
      authentication: { phase: 'prepare', submittedInCycle: false } });
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it('holds a counted retry wait while loading without counting or resetting the cycle', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'readSiteMaintenance' ? { maintenance: true } : inject(tab, func, params));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'retry' } });
    const cycleDeadline = state.authentication!.cycleDeadline!;
    const calls = vi.mocked(h.deps.inject).mock.calls.length;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(30);
    const held = validateEngineState(await runAuthentication(h.deps, state));
    expect(held).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'retry' } });
    expect(held.authentication!.cycleDeadline).toBe(cycleDeadline);
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(calls);
    expect(h.actions).toEqual([]);
  });
  it('cools down after ten stalled loads and resumes automatically', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    for (let count = 1; count <= 10; count++) {
      h.tick(60);
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.consecutiveFailures).toBe(count);
      expect(state.authentication!.phase).toBe(count < 10 ? 'prepare' : 'retry');
    }
    expect(state).toMatchObject({ cooldownUntil: new Date(Date.parse(h.deps.nowIso()) + 1800_000).toISOString(),
      nextPollAt: null, authentication: { phase: 'retry', pending: false } });
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    // Loading during the cooldown holds without an eleventh count.
    h.tick(30);
    expect((await runAuthentication(h.deps, state)).consecutiveFailures).toBe(10);
    // Past the cooldown the worker resumes with a fresh GET once the tab completes.
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'complete' }));
    h.tick(1770);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ authentication: { phase: 'prepare', pending: false } });
    expect(h.actions).toEqual([]);
  });
  it.each(['start', 'renew'] as const)('navigates a stalled %s load to the fixed sign-in page, never into the loading document', async purpose => {
    const h = harness();
    const initial = purpose === 'start' ? seed() : bound();
    let state = await runAuthentication(h.deps, beginAuthentication(initial, purpose, NOW));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.consecutiveFailures).toBe(1);
    expect(navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('navigates a stalled verification load to the fixed sign-in page, never into the loading document', async () => {
    const h = harness();
    const initial: EngineState = { ...bound(), status: 'verifying', intent: {
      runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: true, createdAt: NOW,
    } };
    let state = await runAuthentication(h.deps, beginAuthentication(initial, 'verify', NOW));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.consecutiveFailures).toBe(1);
    expect(state.intent).toEqual(initial.intent);
    expect(navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
  });
  it('parks a stalled load that left the official origin instead of navigating it', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://example.invalid/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
  });
  it('stops on a post-submit credential rejection without another submission', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    expect(h.actions).toEqual(['prepare', 'submit']);
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'credential-rejected' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true, consecutiveFailures: 0 });
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it('hands a post-submit challenge to the user without another submission', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'manual-authentication' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: false, manualAuthentication: true });
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it('waits out a post-submit transient gap without another submission', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'retryable' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { phase: 'cycle-wait' } });
    expect(state.nextPollAt).toBe(state.authentication!.cycleDeadline);
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it('never replays a submit after an unrecognized post-submit reading; expiry counts one fresh GET', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance' ? { maintenance: false } : ({ ok: false }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    // An unrecognized post-submit reading holds the durable cycle deadline
    // read-only (no stop, no banner) and never replays the submit.
    expect(state).toMatchObject({ status: 'running', loginFailed: false, consecutiveFailures: 0,
      authentication: { phase: 'cycle-wait', tabId: 7 } });
    expect(state.nextPollAt).toBe(state.authentication!.cycleDeadline);
    expect(h.actions).toEqual(['prepare', 'submit']);
    // At expiry the counted fresh-GET cycle starts; still zero extra submits.
    h.tick(56);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1,
      authentication: { phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it.each([
    'https://ais.usvisa-info.com/en-ca/niv/account?next=https://example.invalid',
    'https://ais.usvisa-info.com/en-ca/niv/account#section',
    'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/payment?next=https://example.invalid',
    'https://ais.usvisa-info.com/en-ca/niv/supporting-documents',
  ])('injects nothing into an unevidenced same-origin page (%s)', async url => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl(url);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });
  it('resumes a due counted retry while loading without recounting and checkpoints pending', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'readSiteMaintenance' ? { maintenance: true } : inject(tab, func, params));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'retry' } });
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(60);
    const calls = vi.mocked(h.deps.inject).mock.calls.length;
    state = validateEngineState(await runAuthentication(h.deps, state));
    // Due retry resumes with a fresh GET cycle WITHOUT recounting the failure.
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, cooldownUntil: null,
      authentication: { phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(Date.parse(state.authentication!.cycleDeadline!) > Date.parse(NOW)).toBe(true);
    // Durable checkpoint committed pending=true before navigation; memory clears after.
    expect(h.saved.at(-1)).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'prepare', pending: true } });
    expect(navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(calls);
    expect(h.actions).toEqual([]);
  });
  it('resumes an expired cooldown while still loading and counts a fresh budget afterwards', async () => {
    const h = harness();
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    // Tab stays loading continuously: never secretly set complete.
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    for (let count = 1; count <= 10; count++) {
      h.tick(60);
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.consecutiveFailures).toBe(count);
      expect(state.authentication!.phase).toBe(count < 10 ? 'prepare' : 'retry');
    }
    expect(state).toMatchObject({ cooldownUntil: new Date(Date.parse(h.deps.nowIso()) + 1800_000).toISOString(),
      nextPollAt: null, authentication: { phase: 'retry', pending: false } });
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    // Loading during the cooldown holds without an eleventh count.
    h.tick(30);
    expect((await runAuthentication(h.deps, state)).consecutiveFailures).toBe(10);
    // Past the cooldown the worker resumes with a checkpointed fresh GET even
    // though the tab is still loading: budget reset, no recount.
    h.tick(1770);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ consecutiveFailures: 0, cooldownUntil: null,
      authentication: { phase: 'prepare', pending: false } });
    expect(h.saved.at(-1)).toMatchObject({ consecutiveFailures: 0, authentication: { phase: 'prepare', pending: true } });
    // Still loading on the subsequent full cycle deadline counts once...
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'prepare', pending: false } });
    // ...and nine more stalled cycles earn a fresh cooldown.
    for (let count = 2; count <= 10; count++) {
      h.tick(60);
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.consecutiveFailures).toBe(count);
    }
    expect(state).toMatchObject({ cooldownUntil: new Date(Date.parse(h.deps.nowIso()) + 1800_000).toISOString(),
      nextPollAt: null, authentication: { phase: 'retry' } });
    for (const call of navigateTab.mock.calls) expect(call).toEqual([7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in']);
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it.each([60, 61])('stops on a wait-phase credential rejection at %s seconds without counting or navigating', async elapsed => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    expect(h.actions).toEqual(['prepare', 'submit']);
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'credential-rejected' }));
    h.tick(elapsed - 4);
    state = validateEngineState(await runAuthentication(h.deps, state));
    // Rejection wins over expiry: immediate stop, budget untouched, no GET, no resubmit.
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true, consecutiveFailures: 0 });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it.each([60, 61])('hands a wait-phase challenge at %s seconds to the user without counting', async elapsed => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'manual-authentication' }));
    h.tick(elapsed - 4);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: false,
      manualAuthentication: true, consecutiveFailures: 0 });
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it('counts an unrecognized wait-phase reading exactly at expiry with a fresh GET', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance' ? { maintenance: false } : ({ ok: false }));
    h.tick(56);
    state = validateEngineState(await runAuthentication(h.deps, state));
    // An unrecognized reading at expiry is counted once and recovered with the
    // fixed fresh GET instead of a terminal stop; no extra submit is replayed.
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, loginFailed: false,
      authentication: { phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it('counts a clean wait-phase reading at expiry with a fresh GET instead of pacing', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    h.tick(56);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1,
      authentication: { phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it.each(['credential-rejected', 'manual-authentication'] as const)('resolves an expired cycle-wait %s without counting', async reason => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'retryable' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.authentication!.phase).toBe('cycle-wait');
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason }));
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.authentication).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
    expect(h.actions).toEqual([]);
    if (reason === 'credential-rejected') expect(state.loginFailed).toBe(true);
    else expect(state.manualAuthentication).toBe(true);
  });
  it('counts an unrecognized cycle-wait reading after expiry with a fresh GET', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'retryable' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.authentication!.phase).toBe('cycle-wait');
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance' ? { maintenance: false } : ({ ok: false }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1,
      authentication: { phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.actions).toEqual([]);
  });
  it('counts an expired cycle-wait transient gap with a fresh GET', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    h.deps.inject = vi.fn(async (_tab, func) => func.name === 'readSiteMaintenance'
      ? { maintenance: false } : ({ ok: false, reason: 'retryable' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.authentication!.phase).toBe('cycle-wait');
    h.deps.inject = vi.fn(async (_tab, func) => {
      if (func.name === 'readSiteMaintenance') return { maintenance: false };
      if (func.name === 'retryAuthenticationPage') return { ok: true };
      return { ok: false, reason: 'retryable' };
    });
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ consecutiveFailures: 1, authentication: { phase: 'prepare', pending: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
  });
  it.each([
    'https://ais.usvisa-info.com/en-ca/niv/users/sign_in?next=https://example.invalid',
    'https://ais.usvisa-info.com/en-ca/niv/users/sign_in#section',
    'https://ais.usvisa-info.com/en-ca/niv/supporting-documents',
    'https://ais.usvisa-info.com/en-ca/niv/groups/11111111?next=https://example.invalid',
  ])('parks a stalled load on an untrusted URL without injection or navigation (%s)', async url => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url, status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it.each([
    'https://example.invalid/en-ca/niv/users/sign_in',
    'https://ais.usvisa-info.com/en-ca/niv/users/sign_in?next=https://example.invalid',
    'https://ais.usvisa-info.com/en-ca/niv/supporting-documents',
  ])('parks a stalled load on an untrusted pending destination without navigation (%s)', async pendingUrl => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7,
      url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', pendingUrl, status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('parks a stalled blank tab without a trusted pending destination', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'about:blank', status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
  });
  it('recovers a stalled blank tab already navigating to the fixed target', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'about:blank',
      pendingUrl: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1,
      authentication: { phase: 'prepare', pending: false } });
    for (const call of navigateTab.mock.calls) expect(call).toEqual([7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in']);
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('navigates nowhere when the owned tab changes between checkpoint and navigation', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    const loading = { id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' };
    h.deps.getTab = vi.fn()
      .mockResolvedValueOnce(loading)
      .mockResolvedValueOnce(loading)
      .mockResolvedValue({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups', status: 'complete' });
    h.tick(61);
    await runAuthentication(h.deps, state);
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('stays safe when browser navigation fails without replaying a submit', async () => {
    const h = harness();
    let state = beginAuthentication(seed(), 'start', NOW);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state); h.tick(2);
    state = await runAuthentication(h.deps, state);
    expect(h.actions).toEqual(['prepare', 'submit']);
    h.deps.navigateTab = vi.fn(async () => { throw new Error('synthetic navigation failure'); });
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', status: 'loading' }));
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(h.actions).toEqual(['prepare', 'submit']);
  });
  it('opens a fresh Start tab at the site root while renew and verify keep direct sign-in', async () => {
    const startHarness = harness();
    let startState = await runAuthentication(startHarness.deps, beginAuthentication(seed(), 'start', NOW));
    expect(startHarness.deps.createTab).toHaveBeenCalledExactlyOnceWith('https://ais.usvisa-info.com/en-ca/niv/');
    expect(startState).toMatchObject({ status: 'running', authentication: { tabId: 7, purpose: 'start' } });
    expect(startHarness.actions).toEqual([]);
    for (const purpose of ['renew', 'verify'] as const) {
      const other = harness();
      const initial: EngineState = purpose === 'renew' ? bound() : { ...bound(), status: 'verifying', intent: {
        runId: args.runId, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: NOW,
      } };
      await runAuthentication(other.deps, beginAuthentication(initial, purpose, NOW));
      expect(other.deps.createTab).toHaveBeenCalledExactlyOnceWith('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
      expect(other.actions).toEqual([]);
    }
  });
  it('reuses an existing login tab for Start instead of opening a root tab', async () => {
    const h = harness();
    h.deps.queryTabs = async () => [{ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in' }];
    const state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    expect(h.deps.createTab).not.toHaveBeenCalled();
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, purpose: 'start' } });
    expect(h.actions).toEqual([]);
  });
  it('recovers a stalled blank Start tab already navigating to the site root', async () => {
    const h = harness();
    let state = await runAuthentication(h.deps, beginAuthentication(seed(), 'start', NOW));
    expect(h.deps.createTab).toHaveBeenCalledWith('https://ais.usvisa-info.com/en-ca/niv/');
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'about:blank',
      pendingUrl: 'https://ais.usvisa-info.com/en-ca/niv/', status: 'loading' }));
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1,
      authentication: { phase: 'prepare', pending: false } });
    // Intentionally unchanged fallback policy: stalled-load recovery still
    // targets the fixed official sign-in page (AGENTS), not the site root.
    expect(navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it.each(['booking', 'alerts'] as const)('binds a %s Start from a valid-session dashboard redirect with zero login submissions', async mode => {
    const h = harness();
    const settings = { ...prefs, interval: 60 };
    h.deps.loadPrefs = async () => settings;
    // The reused flow tab went to the site root first; a valid cookie
    // redirected it to the exact dashboard before this read.
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const initial = beginAuthentication({ ...seed(), mode, policyKey: policyKey(settings) }, 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'running', authentication: null, loginFailed: false,
      group: mode === 'booking' ? { scheduleId: '11111111', applicantIds: ids } : { scheduleId: '33333333', kind: 'unpaid' } });
    expect(h.actions).toEqual([]);
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('performLoginAction');
  });
  it('prompts a signed-out root landing to sign-in via browser navigation, then signs in once', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/');
    state = await runAuthentication(h.deps, state);
    expect(h.getUrl()).toBe('https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(h.actions).toEqual([]);
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7 }, consecutiveFailures: 0 });
    // Normal authentication follows in the same tab with a single submission.
    for (let cycle = 0; cycle < 3; cycle++) { h.tick(2); state = await runAuthentication(h.deps, state); }
    expect(h.actions).toEqual(['prepare', 'submit']);
    expect(state).toMatchObject({ status: 'running', authentication: null, group: { scheduleId: '11111111' } });
  });
  it('defers a Start site-root maintenance document on the paced budget without submitting', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'readSiteMaintenance' ? { maintenance: true } : inject(tab, func, params));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', loginFailed: false, consecutiveFailures: 1,
      authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(h.actions).toEqual([]);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
  });
  it('paces a landing-to-dashboard redirect before the maintenance read without injection or navigation', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups';
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls === 1) return { id: 7, url: root, status: 'complete' };
      return { id: 7, url: dash, status: 'complete' };
    });
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, pending: false } });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('waits on a trusted dashboard pending redirect instead of navigating a complete root to login', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls === 1) return { id: 7, url: root, status: 'complete' };
      return { id: 7, url: root, pendingUrl: dash, status: 'complete' };
    });
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, pending: false } });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('paces a completed dashboard redirect between the maintenance read and login navigation with checkpoint cleared', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups';
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      // Snapshot, maintenance pre-check and maintenance injection all observe
      // the complete root; the redirect completes before login navigation.
      if (calls <= 3) return { id: 7, url: root, status: 'complete' };
      return { id: 7, url: dash, status: 'complete' };
    });
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, pending: false } });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
    // Maintenance ran once before the redirect; no login submission follows.
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).toEqual(['readSiteMaintenance']);
    // Checkpoint interruption protection is retained but cleared: the pending
    // save committed, then durably and in-memory cleared for the paced wait.
    expect(h.saved.length).toBeGreaterThanOrEqual(2);
    expect(h.saved.at(0)?.authentication).toMatchObject({ pending: true });
    expect(h.saved.at(-1)?.authentication).toMatchObject({ pending: false });
    expect(reconcileStartup(state, h.deps.nowIso())).toMatchObject({ status: 'running', authentication: { tabId: 7 } });
  });
  it.each([
    'https://example.invalid/',
    'https://ais.usvisa-info.com/en-ca/niv/groups?next=https://example.invalid',
    'https://ais.usvisa-info.com/en-ca/niv/supporting-documents',
  ])('refuses an untrusted landing pending redirect without reads or navigation (%s)', async pendingUrl => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls === 1) return { id: 7, url: root, status: 'complete' };
      return { id: 7, url: root, pendingUrl, status: 'complete' };
    });
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('paces a loading trusted redirect from a complete root snapshot without failing', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls === 1) return { id: 7, url: root, status: 'complete' };
      return { id: 7, url: root, pendingUrl: 'https://ais.usvisa-info.com/en-ca/niv/groups', status: 'loading' };
    });
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, pending: false } });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('waits en-route on a completed appointment with exact pending root without reads, then binds after redirect', async () => {
    const h = harness();
    const settings = { ...prefs, interval: 60 };
    h.deps.loadPrefs = async () => settings;
    let state = beginAuthentication({ ...seed(), mode: 'booking', policyKey: policyKey(settings) }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const flow = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: flow, pendingUrl: root, status: 'complete' }));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, pending: false } });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
    // Navigation commits to the trusted dashboard: the next cycle binds with
    // zero credential fills or login submissions.
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: 'https://ais.usvisa-info.com/en-ca/niv/groups', status: 'complete' }));
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, group: { scheduleId: '11111111', applicantIds: ids } });
    expect(h.actions).toEqual([]);
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('performLoginAction');
  });
  it('holds a counted retry when an expired en-route appointment cannot run the fixed GET', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const flow = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: flow, pendingUrl: root, status: 'complete' }));
    h.deps.navigateTab = vi.fn(async () => undefined);
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    // The expiry counts exactly one failure; the live appointment path is not
    // an approved recovery target, so the cycle holds its durable retry
    // deadline instead of stopping, navigating or injecting. The next wake
    // revalidates everything before any action.
    expect(state).toMatchObject({ status: 'running', loginFailed: false, consecutiveFailures: 1, cooldownUntil: null,
      authentication: { tabId: 7, phase: 'retry', pending: false } });
    expect(state.nextPollAt).toBe(state.authentication!.cycleDeadline);
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('refuses en-route Start with untrusted pending without reads or navigation', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const flow = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: flow, pendingUrl: 'https://example.invalid/', status: 'complete' }));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('counts a completed root with trusted dashboard pending past expiry instead of pacing forever', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: root, pendingUrl: dash, status: 'complete' }));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    const deadlineBefore = state.authentication!.cycleDeadline!;
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, cooldownUntil: null,
      authentication: { tabId: 7, phase: 'prepare', pending: false, submittedInCycle: false } });
    expect(Date.parse(state.authentication!.cycleDeadline!) > Date.parse(deadlineBefore)).toBe(true);
    expect(Date.parse(state.authentication!.cycleDeadline!) > Date.parse(h.deps.nowIso())).toBe(true);
    expect(navigateTab).toHaveBeenCalledExactlyOnceWith(7, root);
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
    // A second immediate pass with the same stuck pending does not recount:
    // bounded expiry, no endless 2s pacing loop and no endless counting loop.
    const failures = state.consecutiveFailures;
    const deadline = state.authentication!.cycleDeadline!;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.consecutiveFailures).toBe(failures);
    expect(state.authentication!.cycleDeadline).toBe(deadline);
    expect(navigateTab).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ status: 'running', authentication: { tabId: 7, pending: false } });
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
  });
  it('cools down after ten stuck root pending redirects without endless pacing', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555';
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: root, pendingUrl: dash, status: 'complete' }));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    for (let count = 1; count <= 10; count++) {
      h.tick(60);
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.consecutiveFailures).toBe(count);
      expect(state.authentication!.phase).toBe(count < 10 ? 'prepare' : 'retry');
    }
    expect(state).toMatchObject({ cooldownUntil: new Date(Date.parse(h.deps.nowIso()) + 1800_000).toISOString(),
      nextPollAt: null, authentication: { phase: 'retry', pending: false } });
    expect(navigateTab.mock.calls.length).toBe(9);
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
  });
  it('paces a checkpoint dashboard race past expiry with pending cleared and binds next pass with zero logins', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups';
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls <= 3) return { id: 7, url: root, status: 'complete' };
      return { id: 7, url: dash, status: 'complete' };
    });
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 0, authentication: { tabId: 7, pending: false } });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).toEqual(['readSiteMaintenance']);
    expect(h.saved.length).toBeGreaterThanOrEqual(2);
    expect(h.saved.at(0)?.authentication).toMatchObject({ pending: true });
    expect(h.saved.at(-1)?.authentication).toMatchObject({ pending: false });
    expect(reconcileStartup(state, h.deps.nowIso())).toMatchObject({ status: 'running', authentication: { tabId: 7 } });
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: dash, status: 'complete' }));
    h.tick(2);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, group: { scheduleId: '11111111', applicantIds: ids } });
    expect(h.actions).toEqual([]);
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('performLoginAction');
  });
  it('paces an injection-time dashboard race past expiry without counting', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups';
    let calls = 0;
    h.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls <= 2) return { id: 7, url: root, status: 'complete' };
      return { id: 7, url: dash, status: 'complete' };
    });
    h.deps.navigateTab = vi.fn(async () => undefined);
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 0, authentication: { tabId: 7, pending: false } });
    expect(h.actions).toEqual([]);
  });
  it('counts a loading trusted dashboard redirect past expiry via stalled recovery', async () => {
    const h = harness();
    let state = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups';
    h.deps.getTab = vi.fn(async () => ({ id: 7, url: root, pendingUrl: dash, status: 'loading' }));
    const navigateTab = vi.fn(async () => undefined);
    h.deps.navigateTab = navigateTab;
    h.tick(61);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1,
      authentication: { phase: 'prepare', pending: false } });
    expect(navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in');
    expect(vi.mocked(h.deps.inject).mock.calls.length).toBe(0);
    expect(h.actions).toEqual([]);
    const deadline = state.authentication!.cycleDeadline!;
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state.consecutiveFailures).toBe(1);
    expect(state.authentication!.cycleDeadline).toBe(deadline);
    expect(navigateTab).toHaveBeenCalledOnce();
  });
  it('paces trusted landing redirect progress without navigation support, but fails clean landing', async () => {
    const root = 'https://ais.usvisa-info.com/en-ca/niv/';
    const dash = 'https://ais.usvisa-info.com/en-ca/niv/groups';
    const waiting = harness();
    let waitState = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    waitState = { ...waitState, authentication: { ...waitState.authentication!, tabId: 7 } };
    let calls = 0;
    waiting.deps.getTab = vi.fn(async () => {
      calls++;
      if (calls === 1) return { id: 7, url: root, status: 'complete' };
      return { id: 7, url: dash, status: 'complete' };
    });
    waiting.deps.navigateTab = undefined;
    waitState = validateEngineState(await runAuthentication(waiting.deps, waitState));
    expect(waitState).toMatchObject({ status: 'running', authentication: { tabId: 7, pending: false } });
    expect(waiting.actions).toEqual([]);
    const failing = harness();
    let failState = beginAuthentication({ ...seed(), mode: 'booking' }, 'start', NOW);
    failState = { ...failState, authentication: { ...failState.authentication!, tabId: 7 } };
    failing.setUrl(root);
    failing.deps.navigateTab = undefined;
    failState = validateEngineState(await runAuthentication(failing.deps, failState));
    expect(failState).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true });
    expect(failing.actions).toEqual([]);
  });
  it('recovers a deferred dashboard read failure with a fresh GET and resets the budget only on validated binding', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    let failing = true;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups' && failing) throw new Error('synthetic-secret');
      return inject(tab, func, params);
    });
    let state = beginAuthentication(seed(), 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    // First failure: one counted retry scheduled, no mutation, fixed-code log.
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'retry', pending: false } });
    expect(h.diagnostics).toEqual([{ code: 'auth-retry-scheduled', detail: 'reply-malformed', purpose: 'start', mode: 'booking', phase: 'prepare', failures: 1 }]);
    expect(JSON.stringify(h.diagnostics)).not.toContain('synthetic-secret');
    // The retry wake runs the checkpointed fresh GET of the same trusted
    // dashboard; barely navigating never resets the failure budget.
    failing = false;
    h.tick(60);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'prepare', pending: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledExactlyOnceWith(7, 'https://ais.usvisa-info.com/en-ca/niv/groups');
    expect(h.saved.at(-1)?.authentication).toMatchObject({ pending: true });
    // The next fully validated read binds and records recovery; prior entries survive.
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, consecutiveFailures: 0, cooldownUntil: null,
      group: { scheduleId: '11111111', currentDate: '2027-01-01', applicantIds: ids } });
    expect(h.diagnostics.map(event => event.code)).toEqual(['auth-retry-scheduled', 'auth-recovered']);
    expect(h.diagnostics.at(-1)).toMatchObject({ code: 'auth-recovered', outcome: 'healthy', purpose: 'start', mode: 'booking', phase: 'prepare' });
    // Every event carries the cycle phase context (fixed allowlisted value).
    expect(h.diagnostics.every(event => event.phase === 'prepare')).toBe(true);
    expect(h.actions).toEqual([]);
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('performLoginAction');
  });
  it('cools down after ten deferred dashboard failures and auto-resumes into a fresh validated bind', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    let failing = true;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups' && failing) throw new Error('synthetic-secret');
      return inject(tab, func, params);
    });
    let state = beginAuthentication(seed(), 'start', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    for (let count = 1; count <= 10; count++) {
      if (count > 1) {
        // The held retry wake consumes its durable deadline first.
        h.tick(60);
        state = validateEngineState(await runAuthentication(h.deps, state));
        expect(state.authentication).toMatchObject({ phase: 'prepare', pending: false });
      }
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.consecutiveFailures).toBe(count);
      expect(state.authentication).toMatchObject({ phase: 'retry', pending: false });
    }
    expect(state).toMatchObject({ status: 'running', cooldownUntil: new Date(Date.parse(h.deps.nowIso()) + 1800_000).toISOString(),
      nextPollAt: null, authentication: { phase: 'retry', pending: false } });
    expect(h.diagnostics.filter(event => event.code === 'auth-retry-scheduled')).toHaveLength(9);
    expect(h.diagnostics.filter(event => event.code === 'auth-cooldown-entered')).toHaveLength(1);
    expect(h.diagnostics.every(event => event.phase === 'prepare')).toBe(true);
    // Past the cooldown the worker auto-resumes; only validated progress resets.
    failing = false;
    h.tick(1800);
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ authentication: { phase: 'prepare', pending: false }, consecutiveFailures: 10 });
    expect(h.deps.navigateTab).toHaveBeenCalledWith(7, 'https://ais.usvisa-info.com/en-ca/niv/groups');
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, consecutiveFailures: 0, cooldownUntil: null,
      group: { scheduleId: '11111111', currentDate: '2027-01-01', applicantIds: ids } });
    expect(h.diagnostics.at(-1)).toMatchObject({ code: 'auth-recovered', outcome: 'healthy' });
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('performLoginAction');
  });
  it('keeps Stop and configuration changes terminal ahead of a deferred retry', async () => {
    const deferToRetry = async (mutate: (h: ReturnType<typeof harness>) => void) => {
      const h = harness();
      h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
      const inject = h.deps.inject;
      h.deps.inject = vi.fn(async (tab, func, params) => {
        if (func.name === 'readDashboardGroups') throw new Error('synthetic-secret');
        return inject(tab, func, params);
      });
      let state = beginAuthentication(seed(), 'start', NOW);
      state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'retry', pending: false } });
      mutate(h);
      h.tick(60);
      return validateEngineState(await runAuthentication(h.deps, state));
    };
    // A Stop between the deferred failure and the retry is still honoured.
    const cancelled = await deferToRetry(h => { h.deps.isCancelled = () => true; });
    expect(cancelled).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true, authenticationFailureReason: 'cancelled' });
    // A settings change between the deferred failure and the retry fails closed.
    const changed = await deferToRetry(h => { h.deps.loadPrefs = async () => ({ ...prefs, interval: 600 }); });
    expect(changed).toMatchObject({ status: 'stopped', authentication: null, loginFailed: true, authenticationFailureReason: 'configuration-changed' });
  });
  it('binds a blank-preference Start on an unreadable-IVR card through its trusted Continue link without fabricating an IVR', async () => {
    const h = harness();
    const settings = { ...prefs, paidIvr: '', unpaidIvr: '', interval: 60 };
    h.deps.loadPrefs = async () => settings;
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: null, continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentStatus: 'paid' },
      ] };
      return inject(tab, func, params);
    });
    const initial = beginAuthentication({ ...seed(), mode: 'booking', policyKey: policyKey(settings) }, 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'running', authentication: null, loginFailed: false, authenticationError: null,
      stage: 'actions', executor: { tabId: 7, applicantIds: ids },
      group: { scheduleId: '11111111', ivr: null, kind: 'paid', currentDate: '2027-01-01', applicantIds: ids } });
    // The fallback binds the stable schedule with a null IVR; it never invents
    // an IVR value, and the null survives the durable save round trip.
    expect(state.group!.ivr).toBeNull();
    expect(validateEngineState(JSON.parse(JSON.stringify(state))).group!.ivr).toBeNull();
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'ivr-unreadable-proceeded', purpose: 'start', mode: 'booking' }));
    expect(h.diagnostics.map(event => event.code)).not.toContain('payment-unknown-proceeded');
    expect(h.actions).toEqual([]);
  });
  it('binds a blank-preference Start on an unknown-payment card as a pending inspection', async () => {
    const h = harness();
    const settings = { ...prefs, paidIvr: '', unpaidIvr: '', interval: 60 };
    h.deps.loadPrefs = async () => settings;
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentStatus: 'unknown' },
      ] };
      return inject(tab, func, params);
    });
    const initial = beginAuthentication({ ...seed(), mode: 'booking', policyKey: policyKey(settings) }, 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'running', authentication: null, loginFailed: false, authenticationError: null,
      group: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', pendingInspection: true } });
    // Unknown payment classification proceeds provisionally with the durable
    // inspection flag; it is never silently treated as eligible-or-not.
    expect(validateEngineState(JSON.parse(JSON.stringify(state))).group!.pendingInspection).toBe(true);
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'payment-unknown-proceeded', purpose: 'start', mode: 'booking' }));
    expect(h.diagnostics.map(event => event.code)).not.toContain('ivr-unreadable-proceeded');
    expect(h.actions).toEqual([]);
  });
  it.each(['booking', 'alerts'] as const)('renews a null-IVR fallback binding from blank settings while recording the degraded read (%s)', async mode => {
    const h = harness();
    const settings = { ...prefs, paidIvr: '', unpaidIvr: '', interval: 60 };
    h.deps.loadPrefs = async () => settings;
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: null, continuePath: '/en-ca/niv/schedule/11111111/continue_actions',
          paymentStatus: mode === 'booking' ? 'paid' : 'unpaid' },
      ] };
      if (func.name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: null, kind: 'booked', text: 'January 1, 2027', applicantIds: ids };
      return inject(tab, func, params);
    });
    const boundState = bindGroup({ ...seed(), mode, policyKey: policyKey(settings) }, { ...args, binding: {
      scheduleId: '11111111', ivr: null, kind: mode === 'booking' ? 'paid' : 'unpaid',
      currentDate: mode === 'booking' ? '2027-01-01' : null,
      ...(mode === 'booking' ? { applicantIds: ids } : {}) } });
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    let state = beginAuthentication(boundState, 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, loginFailed: false, authenticationError: null,
      authenticationFailureReason: null, group: { scheduleId: '11111111', ivr: null } });
    expect(state.group!.ivr).toBeNull();
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'ivr-unreadable-proceeded', purpose: 'renew', mode }));
    expect(h.diagnostics.map(event => event.code)).not.toContain('auth-terminal');
    expect(h.actions).toEqual([]);
    if (mode === 'alerts') expect(state.executor).toBeNull();
  });
  it('refuses a null-IVR-only dashboard when an explicit paid IVR is configured instead of silently binding', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: null, continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentStatus: 'paid' },
      ] };
      return inject(tab, func, params);
    });
    const initial = beginAuthentication(seed(), 'start', NOW);
    const state = validateEngineState(await runAuthentication(h.deps, { ...initial, authentication: { ...initial.authentication!, tabId: 7 } }));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: false, authentication: null, nextPollAt: null,
      authenticationFailureReason: 'paid-group-unavailable' });
    expect(state.group).toBeNull();
    expect(state.authenticationError).toBe('The extension could not match the selected IVR to a dashboard group. Check the IVR in Settings; if it matches, report this message.');
    expect(panelSnapshot(state, null, null)).toMatchObject({ status: 'failure', reviewRequired: true, failureKind: 'generic' });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'auth-terminal', reason: 'paid-group-unavailable', detail: 'paid-group-unavailable' }));
    expect(h.diagnostics.map(event => event.code)).not.toContain('ivr-unreadable-proceeded');
    expect(h.actions).toEqual([]);
  });
  it.each(['booking', 'alerts'] as const)('blocks a pending-inspection renewal on a confirmed incompatible payment status (%s)', async mode => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', continuePath: '/en-ca/niv/schedule/11111111/continue_actions',
          paymentStatus: mode === 'booking' ? 'unpaid' : 'paid' },
      ] };
      return inject(tab, func, params);
    });
    const provisional = bindGroup({ ...seed(), mode }, { ...args, binding: { scheduleId: '11111111', ivr: '22222222',
      kind: mode === 'booking' ? 'paid' : 'unpaid', currentDate: mode === 'booking' ? '2027-01-01' : null, applicantIds: ids, pendingInspection: true } });
    let state = beginAuthentication(provisional, 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: false, authentication: null, nextPollAt: null,
      authenticationFailureReason: 'payment-ineligible', group: { scheduleId: '11111111', pendingInspection: true } });
    expect(state.authenticationError).toBe('The selected visa group is not eligible for this workflow. Check the group IVR Account Number and payment status in Settings.');
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'auth-terminal', reason: 'payment-ineligible', detail: 'payment-ineligible' }));
    expect(vi.mocked(h.deps.inject).mock.calls.map(call => call[1].name)).not.toContain('readCurrentAppointment');
    expect(h.actions).toEqual([]);
  });
  it('blocks a pending-inspection renewal on contradictory dashboard payment markers', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', continuePath: '/en-ca/niv/schedule/11111111/continue_actions',
          paymentStatus: 'paid', paymentConflict: true },
      ] };
      return inject(tab, func, params);
    });
    const provisional = bindGroup(seed(), { ...args, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid',
      currentDate: '2027-01-01', applicantIds: ids, pendingInspection: true } });
    let state = beginAuthentication(provisional, 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'stopped', loginFailed: false, authentication: null,
      authenticationFailureReason: 'payment-markers-conflict', group: { scheduleId: '11111111', pendingInspection: true } });
    // The panel stays on the simple fixed eligibility copy; the precise
    // contradictory-marker cause is retained for the problem report.
    expect(state.authenticationError).toBe('The selected visa group is not eligible for this workflow. Check the group IVR Account Number and payment status in Settings.');
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'auth-terminal', reason: 'payment-markers-conflict', detail: 'payment-markers-conflict' }));
    expect(h.actions).toEqual([]);
  });
  it('clears the pending-inspection flag after a confirmed compatible renewal reading', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentStatus: 'paid' },
      ] };
      return inject(tab, func, params);
    });
    const provisional = bindGroup(seed(), { ...args, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid',
      currentDate: '2027-01-01', applicantIds: ids, pendingInspection: true } });
    let state = beginAuthentication(provisional, 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, loginFailed: false, authenticationError: null,
      group: { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01' } });
    expect(state.group!.pendingInspection).toBeUndefined();
    expect(validateEngineState(JSON.parse(JSON.stringify(state))).group!.pendingInspection).toBeUndefined();
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'payment-inspection-resolved', purpose: 'renew', mode: 'booking' }));
    expect(h.diagnostics.map(event => event.code)).not.toContain('payment-unknown-proceeded');
  });
  it('keeps a pending-inspection renewal provisional while the payment classification stays unknown', async () => {
    const h = harness();
    h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        { scheduleId: '11111111', ivr: '22222222', continuePath: '/en-ca/niv/schedule/11111111/continue_actions', paymentStatus: 'unknown' },
      ] };
      return inject(tab, func, params);
    });
    const provisional = bindGroup(seed(), { ...args, binding: { scheduleId: '11111111', ivr: '22222222', kind: 'paid',
      currentDate: '2027-01-01', applicantIds: ids, pendingInspection: true } });
    let state = beginAuthentication(provisional, 'renew', NOW);
    state = { ...state, authentication: { ...state.authentication!, tabId: 7 } };
    state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', authentication: null, authenticationError: null,
      group: { scheduleId: '11111111', pendingInspection: true } });
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'payment-unknown-proceeded', purpose: 'renew', mode: 'booking' }));
    expect(h.diagnostics.map(event => event.code)).not.toContain('payment-inspection-resolved');
  });
});

describe('first sign-in dashboard discovery', () => {
  it.each(['booking', 'alerts', 'both'] as const)('selects %s after login without acting from discovery alone', async feature => {
    const h = harness(); h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const initial: EngineState = { ...seed(), discovery: { features: null, requested: true, choosing: false } };
    const auth = beginAuthentication(initial, 'start', NOW);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      if (func.name === 'readDashboardGroups') return { groups: [
        ...(feature !== 'booking' ? [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] : []),
        ...(feature !== 'alerts' ? [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }] : []),
      ] };
      return inject(tab, func, params);
    });
    const result = validateEngineState(await runAuthentication(h.deps, { ...auth, authentication: { ...auth.authentication!, tabId: 7 } }));
    expect(result.discovery).toEqual({ features: feature, requested: false, choosing: feature === 'both' });
    expect(h.actions).toEqual([]); expect(h.deps.navigateTab).not.toHaveBeenCalled();
    if (feature === 'both') expect(result).toMatchObject({ status: 'stopped', nextPollAt: null, group: null, executor: null });
    else expect(result).toMatchObject({ status: 'running', mode: feature, group: { kind: feature === 'booking' ? 'paid' : 'unpaid' } });
    const baselineReads = vi.mocked(h.deps.inject).mock.calls.filter(call => call[1].name === 'readCurrentAppointment');
    expect(baselineReads).toHaveLength(feature === 'booking' ? 1 : 0);
    if (feature === 'booking') expect(result.group?.applicantIds).toEqual(ids);
  });

  it.each(['navigation', 'pending', 'settings', 'cancelled'])('refuses a changed %s before surfacing mixed features', async issue => {
    const h = harness(); h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    let cancelled = false;
    h.deps.isCancelled = () => cancelled;
    const initial: EngineState = { ...seed(), discovery: { features: null, requested: true, choosing: false } };
    const auth = beginAuthentication(initial, 'start', NOW);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => {
      const raw = await inject(tab, func, params);
      if (func.name === 'readDashboardGroups') {
        if (issue === 'navigation') h.setUrl('https://example.invalid/');
        if (issue === 'pending') h.deps.getTab = async () => ({ id: 7, url: h.getUrl(), pendingUrl: 'https://example.invalid/' });
        if (issue === 'settings') h.deps.loadPrefs = async () => ({ ...prefs, consulate: 'Toronto' });
        if (issue === 'cancelled') cancelled = true;
      }
      return raw;
    });
    const result = await runAuthentication(h.deps, { ...auth, authentication: { ...auth.authentication!, tabId: 7 } });
    expect(result.discovery?.choosing).toBe(false);
    expect(result.status).not.toBe('running');
    expect(result.group).toBeNull(); expect(h.actions).toEqual([]);
  });
});

describe('feature changes during an active renewal', () => {
  it.each(['booking', 'alerts'] as const)('rebinds a new %s feature only after its normal group and roster checks', async target => {
    const h = harness(); h.setUrl('https://ais.usvisa-info.com/en-ca/niv/groups');
    const old: EngineState = target === 'alerts' ? { ...bound(), discovery: { features: 'booking', requested: false, choosing: false } }
      : { ...seed(), mode: 'alerts', group: { kind: 'unpaid', scheduleId: '33333333', ivr: '44444444', currentDate: null },
        discovery: { features: 'alerts', requested: false, choosing: false } };
    const auth = beginAuthentication(old, 'renew', NOW);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (tab, func, params) => func.name === 'readDashboardGroups' ? { groups: [target === 'booking'
      ? { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' }
      : { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }] } : inject(tab, func, params));
    const result = validateEngineState(await runAuthentication(h.deps, { ...auth, authentication: { ...auth.authentication!, tabId: 7 } }));
    expect(result).toMatchObject({ mode: target, status: 'running', intent: null, authentication: null, sessionRenewals: 0,
      discovery: { features: target, requested: false, choosing: false } });
    expect(result.group?.kind).toBe(target === 'booking' ? 'paid' : 'unpaid');
    if (target === 'booking') expect(result.group?.applicantIds).toEqual(ids);
    expect(h.actions).toEqual([]); expect(h.deps.navigateTab).not.toHaveBeenCalled();
  });
});
