// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSiteMaintenance } from '../src/adapter/reads';
import { recoverMaintenance, runAuthentication } from '../src/engine/authentication';
import { maintenanceUrl, observeMaintenance } from '../src/engine/maintenance';
import { engineAlarmAt } from '../src/engine/poll';
import { bindGroup, emptyEngineState, reconcileStartup, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
import { policyKey } from '../src/engine/lifecycle';
import { runBookingStage, type ExecDeps } from '../src/engine/executor';

const NOW = '2026-10-25T00:00:00.000Z';
const SITE = 'https://ais.usvisa-info.com';
const prefs = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver', earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false, interval: 60, paidIvr: '22222222', unpaidIvr: '' };
function seed(mode: 'booking' | 'alerts' = 'booking'): EngineState {
  const args = { owner: 'owner-token-01', runId: 'run-id-0001', now: NOW };
  return { ...bindGroup(startRun(emptyEngineState(NOW), { ...args, mode }), { ...args,
    binding: { scheduleId: '11111111', ivr: '22222222', kind: mode === 'booking' ? 'paid' : 'unpaid', currentDate: null,
      dashboardPath: '/en-ca/niv/groups', applicantIds: ['77777777'] } }), policyKey: policyKey(prefs),
    executor: mode === 'booking' ? { tabId: 7, applicantIds: ['77777777'], targetTime: '09:00', skippedDates: [], actionPending: false } : null,
    monitorTabId: mode === 'alerts' ? 7 : null };
}
function harness(state = seed(), path = '/en-ca/niv/account') {
  let tab = { id: 7, url: SITE + path, status: 'complete', pendingUrl: '' };
  let now = NOW;
  const saved: EngineState[] = [];
  const deps: ExecDeps = { nowIso: () => now, random: () => 0, loadPrefs: async () => ({ ...prefs }),
    getTab: vi.fn(async () => ({ ...tab })), queryTabs: async () => [tab], createTab: vi.fn(async () => { throw Error('No replacement tabs'); }),
    saveState: vi.fn(async value => { saved.push(validateEngineState(value)); }),
    navigateTab: vi.fn(async (_id, target) => { expect(saved.at(-1)?.authentication?.pending).toBe(true); tab = { ...tab, url: target }; }),
    inject: vi.fn(async (_id, fn) => {
      if (fn.name === 'readSiteMaintenance') return { maintenance: true };
      throw Error('No page action during maintenance');
    }) };
  return { state, deps, saved, tab: () => tab, change: (value: Partial<typeof tab>) => { tab = { ...tab, ...value }; }, tick: (s: number) => { now = new Date(Date.parse(now) + s * 1000).toISOString(); } };
}

describe('shared maintenance document recognition', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });
  it.each(['<h1>Doing Maintenance</h1>', '<div class="construction-background"></div>', '<p>Our website is down for planned maintenance.</p>'])(
    'recognizes the dedicated outage document (%s)', body => {
      vi.stubGlobal('location', { href: SITE + '/en-ca/niv/account' }); document.body.innerHTML = body;
      const serialized = new Function(`return (${readSiteMaintenance.toString()})`)() as typeof readSiteMaintenance;
      expect(serialized(false, location.href)).toEqual({ maintenance: true });
    });
  it.each(['<p>Maintenance is scheduled next week.</p>', '<form id="sign_in_form"></form><p>Our website is down for planned maintenance.</p>', '<form id="appointment-form"></form><h1>Doing Maintenance</h1>'])(
    'does not mistake normal page notices for an outage (%s)', body => {
      vi.stubGlobal('location', { href: SITE + '/en-ca/niv/account' }); document.body.innerHTML = body;
      expect(readSiteMaintenance()).toEqual({ maintenance: false });
    });
  it.each(['https://example.invalid/en-ca/niv/account', SITE + '/en-ca/niv/account#changed', 'http://ais.usvisa-info.com/en-ca/niv/account'])(
    'rejects a changed/untrusted injected document (%s)', href => {
      vi.stubGlobal('location', { href }); document.body.innerHTML = '<h1>Doing Maintenance</h1>';
      expect(readSiteMaintenance(true, SITE + '/en-ca/niv/account')).toEqual({ maintenance: false });
    });
});

describe('outage observation trust and cancellation', () => {
  it.each(['/en-ca/niv/account', '/en-ca/niv/account/', '/en-ca/niv/', '/en-ca/niv/users/sign_in', '/en-ca/niv/groups',
    '/en-ca/niv/schedule/11111111/continue', '/en-ca/niv/schedule/11111111/continue_actions', '/en-ca/niv/schedule/11111111/appointment?applicants[]=77777777'])('allows only read-only observation at %s', async path => {
    const h = harness(seed(), path);
    expect(await observeMaintenance(h.deps, h.state, 7)).toBe(true);
    expect(h.deps.navigateTab).not.toHaveBeenCalled(); expect(h.deps.saveState).not.toHaveBeenCalled();
  });
  it.each(['https://example.invalid/en-ca/niv/account', SITE + '/en-ca/niv/account?next=elsewhere', SITE + '/en-ca/niv/account#changed',
    SITE + '/en-ca/niv/unknown', SITE + '/en-ca/niv/groups/99999999', SITE + '/en-ca/niv/schedule/99999999/appointment',
    SITE + '/en-ca/niv/schedule/11111111/appointment?unexpected=1', 'https://user@ais.usvisa-info.com/en-ca/niv/account'])(
    'never reads an unsupported route (%s)', async url => {
      const h = harness(); h.change({ url });
      expect(maintenanceUrl(h.state, url)).toBe(false);
      expect(await observeMaintenance(h.deps, h.state, 7)).toBe(false); expect(h.deps.inject).not.toHaveBeenCalled();
    });
  it.each(['stopped', 'parked-verification', 'wrong-tab', 'loading', 'pending', 'cancelled', 'worker-restart'])(
    'does not inspect inactive or unsafe custody (%s)', async issue => {
      const h = harness(); let state = h.state;
      if (issue === 'stopped') state = { ...state, status: 'stopped' };
      if (issue === 'parked-verification') state = { ...state, status: 'verifying', verification: null };
      if (issue === 'worker-restart') state = reconcileStartup(state, NOW, true);
      if (issue === 'wrong-tab') state = { ...state, executor: { ...state.executor!, tabId: 8 } };
      if (issue === 'loading') h.change({ status: 'loading' });
      if (issue === 'pending') h.change({ pendingUrl: SITE + '/en-ca/niv/groups' });
      if (issue === 'cancelled') h.deps.isCancelled = () => true;
      expect(await observeMaintenance(h.deps, state, 7)).toBe(false); expect(h.deps.inject).not.toHaveBeenCalled();
    });
  it.each(['settings', 'cancelled', 'url', 'pending', 'loading', 'missing-reply'])(
    'does not recover from stale observation (%s)', async issue => {
      const h = harness(); h.deps.inject = vi.fn(async () => {
        if (issue === 'settings') h.deps.loadPrefs = async () => ({ ...prefs, interval: 600 });
        if (issue === 'cancelled') h.deps.isCancelled = () => true;
        if (issue === 'url') h.change({ url: SITE + '/en-ca/niv/groups' });
        if (issue === 'pending') h.change({ pendingUrl: SITE + '/en-ca/niv/groups' });
        if (issue === 'loading') h.change({ status: 'loading' });
        return issue === 'missing-reply' ? undefined : { maintenance: true };
      });
      expect(await observeMaintenance(h.deps, h.state, 7)).toBe(false); expect(h.deps.navigateTab).not.toHaveBeenCalled();
    });
});

describe('stage-independent outage waits and guarded continuation', () => {
  it.each(['actions', 'warning', 'applicants', 'form'] as const)('abandons stale %s preparation without a click or reload', async stage => {
    const h = harness(seed(), stage === 'actions' ? '/en-ca/niv/groups' : '/en-ca/niv/schedule/11111111/appointment');
    const original = { ...h.state, stage, lastCandidate: { date: '2026-11-19', consulate: 'Vancouver' as const } };
    const next = validateEngineState(await runBookingStage(h.deps, original));
    expect(next).toMatchObject({ status: 'running', stage: null, lastCandidate: null, consecutiveFailures: 1,
      authentication: { purpose: 'renew', tabId: 7, phase: 'retry', maintenanceRecovery: true }, executor: { targetTime: null } });
    expect(next.group).toEqual(original.group); expect(next.nextPollAt).toBe('2026-10-25T00:01:00.000Z');
    expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.every(([, fn]) => fn.name === 'readSiteMaintenance')).toBe(true);
  });
  it.each(['booking', 'alerts'] as const)('keeps a single owned %s workflow through repeated outages and cooldown', async mode => {
    const h = harness(seed(mode));
    let state = validateEngineState(recoverMaintenance(h.state, 7, NOW, () => 0));
    const renewals = state.sessionRenewals;
    for (let count = 1; count < 10; count++) {
      const early = await runAuthentication(h.deps, state); expect(early).toEqual(state);
      h.tick(60); state = validateEngineState(await runAuthentication(h.deps, state));
      expect(h.deps.navigateTab).toHaveBeenLastCalledWith(7, SITE + '/en-ca/niv/users/sign_in');
      h.change({ url: SITE + '/en-ca/niv/account' }); h.tick(2);
      state = validateEngineState(await runAuthentication(h.deps, state));
      expect(state.sessionRenewals).toBe(renewals);
    }
    expect(state.consecutiveFailures).toBe(10); expect(state.cooldownUntil).not.toBeNull();
    expect(engineAlarmAt(reconcileStartup(state, h.deps.nowIso()))).toBe(state.cooldownUntil);
    const calls = vi.mocked(h.deps.inject).mock.calls.length; h.tick(1799);
    expect(await runAuthentication(h.deps, state)).toEqual(state); expect(h.deps.inject).toHaveBeenCalledTimes(calls);
    h.tick(1); state = await runAuthentication(h.deps, state); h.change({ url: SITE + '/en-ca/niv/account' }); h.tick(2);
    state = await runAuthentication(h.deps, state); expect(state.consecutiveFailures).toBe(1); expect(state.status).toBe('running');
    expect(h.deps.createTab).not.toHaveBeenCalled();
  });
  it('sends a potentially submitted booking to verification, preserving its intent', async () => {
    const h = harness(seed(), '/en-ca/niv/schedule/11111111/appointment');
    const state: EngineState = { ...h.state, stage: 'confirm', intent: { runId: h.state.runId!, mode: 'booking', groupId: '11111111',
      targetDate: '2026-11-19', consulate: 'Vancouver', testMode: false, createdAt: NOW, phase: 'submitted' } };
    const next = await runBookingStage(h.deps, state);
    expect(next).toMatchObject({ status: 'verifying', intent: state.intent, verification: { nextReadAt: '2026-10-25T00:00:30.000Z' } });
    expect(next.authentication).toBeNull(); expect(h.deps.navigateTab).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.inject).mock.calls.every(([, fn]) => fn.name === 'readSiteMaintenance')).toBe(true);
  });
  it('does not clear an uncertain field checkpoint under the maintenance label', async () => {
    const h = harness(seed(), '/en-ca/niv/schedule/11111111/appointment');
    const state: EngineState = { ...h.state, stage: 'form', executor: { ...h.state.executor!, actionPending: true } };
    const next = await runBookingStage(h.deps, state);
    expect(next.status).toBe('verifying'); expect(next.executor?.actionPending).toBe(true);
    expect(h.deps.inject).not.toHaveBeenCalled(); expect(h.deps.navigateTab).not.toHaveBeenCalled();
  });
  it('validates its durable marker and preserves restart/Stop behavior', () => {
    const h = harness(); const state = recoverMaintenance(h.state, 7, NOW, () => 0);
    expect(validateEngineState(state).authentication?.maintenanceRecovery).toBe(true);
    expect(() => validateEngineState({ ...state, authentication: { ...state.authentication, maintenanceRecovery: 'yes' } })).toThrow();
    expect(reconcileStartup(state, NOW, true)).toMatchObject({ status: 'verifying', authentication: null, nextPollAt: null });
    expect(recoverMaintenance({ ...h.state, status: 'stopped' }, 7, NOW, () => 0).status).toBe('stopped');
  });
  it.each(['settings', 'Stop', 'offsite', 'pending'])(
    'rechecks maintenance recovery after the navigation checkpoint (%s)', async issue => {
      const h = harness(); const state = recoverMaintenance(h.state, 7, NOW, () => 0);
      const save = h.deps.saveState;
      h.deps.saveState = async checkpoint => {
        await save(checkpoint);
        if (issue === 'settings') h.deps.loadPrefs = async () => ({ ...prefs, interval: 600 });
        if (issue === 'Stop') h.deps.isCancelled = () => true;
        if (issue === 'offsite') h.change({ url: 'https://example.invalid/' });
        if (issue === 'pending') h.change({ pendingUrl: 'https://example.invalid/' });
      };
      h.tick(60); const next = await runAuthentication(h.deps, state);
      expect(next.status).toBe('stopped'); expect(h.deps.navigateTab).not.toHaveBeenCalled(); expect(h.deps.inject).not.toHaveBeenCalled();
    });
  it('holds a failed fixed-GET retry without spending another renewal or replaying a POST', async () => {
    const h = harness(); let state = recoverMaintenance(h.state, 7, NOW, () => 0);
    h.deps.navigateTab = vi.fn(async () => { throw Error('Synthetic browser GET failure'); });
    h.tick(60); state = validateEngineState(await runAuthentication(h.deps, state));
    expect(state).toMatchObject({ status: 'running', consecutiveFailures: 2, sessionRenewals: 1,
      authentication: { phase: 'retry', pending: false, maintenanceRecovery: true } });
    expect(h.deps.inject).not.toHaveBeenCalled();
  });
});
