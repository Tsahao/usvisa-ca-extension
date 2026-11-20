import { describe, expect, it, vi } from 'vitest';
import { beginAuthentication, runAuthentication } from '../src/engine/authentication';
import { bindGroup, emptyEngineState, reconcileStartup, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
import { ownedTransition } from '../src/engine/owned-navigation';
import { diagnosticsSnapshot } from '../src/domain/diagnostics';
import { policyKey } from '../src/engine/lifecycle';
import type { ExecDeps, ExecTab } from '../src/engine/executor';
import type { DiagnosticEvent } from '../src/domain/diagnostics';
import { appendDiagnostic, emptyDiagnostics } from '../src/domain/diagnostics';

// Synthetic tabs.update acknowledges dispatch while the original document
// remains visible. Neither the real browser nor the portal is accessed.
const NOW = '2026-11-09T00:00:00.000Z';
const SITE = 'https://ais.usvisa-info.com';
const LOGIN = `${SITE}/en-ca/niv/users/sign_in`;
const ROOT = `${SITE}/en-ca/niv/`;
const DASHBOARD = `${SITE}/en-ca/niv/groups/55555555`;
const BASE = `${SITE}/en-ca/niv/schedule/11111111`;
const APPLICANTS = ['77777777', '88888888'];
const PREFS = { email: 'fixture@example.invalid', password: 'synthetic-password', consulate: 'Vancouver',
  earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, testMode: false, interval: 60,
  paidIvr: '22222222', unpaidIvr: '' };

function harness(mode: 'booking' | 'alerts' = 'booking', source = `${BASE}/${mode === 'booking' ? 'appointment' : 'payment'}`) {
  let clock = NOW;
  const tab: ExecTab = { id: 7, url: source, status: 'complete' };
  const saved: EngineState[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const settings = { ...PREFS, paidIvr: mode === 'booking' ? '22222222' : '', unpaidIvr: mode === 'alerts' ? '22222222' : '' };
  let preferences = { ...settings };
  let cancelled = false;
  const hooks: { save?: (s: EngineState) => void; get?: () => void; prefs?: () => void; navigate?: () => void } = {};
  const deps: ExecDeps = {
    nowIso: () => clock, random: () => 0, queryTabs: async () => [], createTab: vi.fn(async () => { throw new Error('No replacement tabs'); }),
    getTab: vi.fn(async () => { hooks.get?.(); return { ...tab }; }),
    loadPrefs: async () => { hooks.prefs?.(); return { ...preferences }; }, isCancelled: () => cancelled,
    saveState: async s => { saved.push(validateEngineState(structuredClone(s))); hooks.save?.(s); },
    recordDiagnostic: e => { diagnostics.push(e); },
    navigateTab: vi.fn(async (id, target) => {
      expect(id).toBe(7); expect([LOGIN, ROOT]).toContain(target);
      expect(saved.at(-1)?.authentication).toMatchObject({ pending: true, checkpoint: 'navigation' });
      tab.pendingUrl = target;
      hooks.navigate?.();
    }),
    inject: vi.fn(async (_id, fn) => {
      if (fn.name === 'readSiteMaintenance') return { maintenance: false };
      if (fn.name === 'readDashboardGroups') return { groups: [{ scheduleId: '11111111', ivr: '22222222', paymentStatus: mode === 'booking' ? 'paid' : 'unpaid' }] };
      if (fn.name === 'readCurrentAppointment') return { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: APPLICANTS };
      if (fn.name === 'performLoginAction' || fn.name === 'probeLoginStatus') return { ok: true };
      throw new Error('Unexpected injection');
    }),
  };
  const args = { now: NOW, owner: 'renewal-owner-01', runId: 'renewal-run-0001' };
  const bound = bindGroup(startRun(emptyEngineState(NOW), { ...args, mode }), { ...args, binding: {
    scheduleId: '11111111', ivr: '22222222', kind: mode === 'booking' ? 'paid' : 'unpaid',
    currentDate: mode === 'booking' ? '2027-01-01' : null, dashboardPath: '/en-ca/niv/groups/55555555',
    ...(mode === 'booking' ? { applicantIds: APPLICANTS } : {}),
  } });
  const initial = beginAuthentication({ ...bound, policyKey: policyKey(settings), monitorTabId: mode === 'alerts' ? 7 : null,
    executor: mode === 'booking' ? { tabId: 7, applicantIds: APPLICANTS, targetTime: null, skippedDates: [], actionPending: false } : null }, 'renew', NOW);
  const run = async (s: EngineState) => validateEngineState(await runAuthentication(deps, s));
  return { deps, tab, saved, diagnostics, hooks, initial, run,
    tick: (seconds: number) => { clock = new Date(Date.parse(clock) + seconds * 1000).toISOString(); },
    cancel: () => { cancelled = true; }, edit: () => { preferences = { ...preferences, interval: 90, password: 'changed-synthetic-password' }; },
    commit: (url = LOGIN) => { tab.url = url; tab.status = 'complete'; delete tab.pendingUrl; },
  };
}


const ACCOUNT = `${SITE}/en-ca/niv/account`;
const INDEX = `${SITE}/en-ca/niv/groups`;

describe('bounded authentication intermediaries', () => {
  for (const mode of ['booking', 'alerts'] as const) for (const target of ['root', 'sign-in'] as const) {
    for (const status of ['loading', 'complete'] as const) for (const destination of [ACCOUNT, INDEX]) {
      it.each([2, 60, 900])(`${mode} ${target} ${status} intermediary ${destination.split('/').at(-1)} at +%ss`, async seconds => {
        const h = harness(mode);
        let s = await h.run({ ...h.initial, authentication: { ...h.initial.authentication!, ...(target === 'root' ? { dashboardFirst: true as const } : {}) } });
        const origin = s.authentication!.navigation!.originSource;
        h.tab.status = status; h.tab.pendingUrl = destination; h.tick(seconds);
        s = await h.run(s);
        expect(s).toMatchObject({ status: 'running', intent: null, consecutiveFailures: seconds >= 60 ? 1 : 0 });
        expect(h.deps.inject).not.toHaveBeenCalled();
        expect(h.deps.navigateTab).toHaveBeenCalledTimes(seconds >= 60 ? 2 : 1);
        expect(s.authentication?.navigation?.originSource).toBe(origin);
        h.commit(DASHBOARD); s = await h.run(s);
        expect(s).toMatchObject({ status: 'running', authentication: null, sessionRenewals: 0 });
      });
    }
  }

  it.each([ACCOUNT, INDEX])('recovers quiet intermediary %s at expiry under original source authority', async destination => {
    const h = harness(); let s = await h.run(h.initial); const origin = s.authentication!.navigation!.originSource;
    h.commit(destination); s = await h.run(s);
    expect(s.authentication).not.toBeNull();
    expect(vi.mocked(h.deps.inject).mock.calls.every(c => c[1].name === 'readSiteMaintenance')).toBe(true);
    h.tick(60); s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { navigation: { source: destination, originSource: origin, kind: 'get' } } });
    expect(h.deps.navigateTab).toHaveBeenCalledTimes(2);
    h.commit(DASHBOARD); s = await h.run(s); expect(s.authentication).toBeNull();
  });

  for (const action of ['prepare', 'submit'] as const) for (const response of ['ok', 'lost', 'throw'] as const) {
    it(`${action} ${response} retains attempted action provenance and never replays on intermediary/wake`, async () => {
      const h = harness(); let s = await h.run(h.initial); h.commit(LOGIN);
      if (action === 'submit') s = await h.run(s);
      const inject = h.deps.inject;
      let mutations = 0;
      h.deps.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => {
        if (args[1].name === 'performLoginAction') {
          mutations++; h.tab.pendingUrl = ACCOUNT;
          if (response === 'throw') throw new Error('Synthetic lost action reply');
          if (response === 'lost') return undefined;
        }
        return inject(...args);
      });
      s = await h.run(s);
      expect(s.status).toBe('running');
      expect(s.authentication?.navigation).toMatchObject({ kind: 'login-action', action });
      s = reconcileStartup(validateEngineState(structuredClone(s)), h.deps.nowIso());
      s = await h.run(s);
      expect(s.status).toBe('running'); expect(mutations).toBe(1);
      h.commit(ACCOUNT); h.tick(60); s = await h.run(s);
      expect(s.status).toBe('running'); expect(mutations).toBe(1);
      expect(s.authentication?.navigation?.kind).toBe('get');
      h.commit(DASHBOARD); s = await h.run(s);
      expect(s.authentication).toBeNull(); expect(mutations).toBe(1);
    });
  }

  it.each([INDEX, `${SITE}/en-ca/niv/groups/99999999`])('does not bind an unmarked quiet noncanonical dashboard %s', async url => {
    const h = harness(); const s = { ...h.initial, authentication: { ...h.initial.authentication!, tabId: 7 } };
    h.commit(url); const result = await h.run(s);
    expect(result.status).toBe('stopped');
    expect(vi.mocked(h.deps.inject).mock.calls.some(c => c[1].name === 'readDashboardGroups')).toBe(false);
    expect(result.group?.dashboardPath).toBe('/en-ca/niv/groups/55555555');
  });

  it('stores local fixed refusal attribution without exporting it', async () => {
    const h = harness(); let s = await h.run(h.initial); h.tab.pendingUrl = 'https://example.invalid/';
    s = await h.run(s); const e = h.diagnostics.at(-1)!;
    expect(e).toMatchObject({ navigation: { guard: 'transition', live: 'workflow', pending: 'foreign', transition: 'get-acknowledged' } });
    const log = appendDiagnostic(emptyDiagnostics(), e, NOW);
    expect(JSON.stringify(log)).not.toContain(SITE); expect(JSON.stringify(log)).not.toContain(PREFS.password);
    expect(diagnosticsSnapshot(log, NOW).entries[0].navigation).toBeUndefined();
  });
});

describe('intermediary interruption safeguards', () => {
  for (const phase of ['wait', 'retry'] as const) for (const outcome of ['credential-rejected', 'manual-authentication'] as const) {
    it(`${phase} login bounce classifies ${outcome} before expiry GET`, async () => {
      const h = harness(); let s = await h.run(h.initial); h.commit(LOGIN);
      s = await h.run(s); s = await h.run(s); h.tick(60);
      s = { ...s, nextPollAt: h.deps.nowIso(), authentication: { ...s.authentication!, phase } };
      const inject = h.deps.inject;
      h.deps.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'probeLoginStatus'
        ? { ok: false, reason: outcome } : inject(...args));
      s = await h.run(s);
      expect(s.status).toBe('stopped');
      expect(s.manualAuthentication).toBe(outcome === 'manual-authentication');
      expect(h.deps.navigateTab).toHaveBeenCalledOnce();
      expect(vi.mocked(h.deps.inject).mock.calls.filter(c => c[1].name === 'performLoginAction')).toHaveLength(0);
    });
  }

  it.each(['credential-rejected', 'manual-authentication'])('does not mask an explicit %s action reply with navigation', async reason => {
    const h = harness(); let s = await h.run(h.initial); h.commit(LOGIN); s = await h.run(s);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => {
      if (args[1].name === 'performLoginAction') { h.tab.pendingUrl = ACCOUNT; return { ok: false, reason }; }
      return inject(...args);
    });
    s = await h.run(s); expect(s.status).toBe('stopped'); expect(s.authentication).toBeNull();
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
  });

  it('fails checkpoint creation before dispatching credentials and wake consumes an interrupted action allowance', async () => {
    const h = harness(); let s = await h.run(h.initial); h.commit(LOGIN); s = await h.run(s);
    vi.mocked(h.deps.inject).mockClear();
    h.hooks.save = checkpoint => { if (checkpoint.authentication?.checkpoint === 'action') throw Error('Synthetic unavailable storage'); };
    await expect(h.run(s)).rejects.toThrow('Synthetic unavailable storage');
    expect(vi.mocked(h.deps.inject).mock.calls.some(c => c[1].name === 'performLoginAction')).toBe(false);
    const wake = reconcileStartup(h.saved.at(-1)!, h.deps.nowIso());
    expect(wake.authentication).toMatchObject({ submittedInCycle: true, phase: 'wait', navigation: { kind: 'login-action', action: 'submit' } });
  });

  it('lost GET acknowledgement at an intermediary holds paced recovery instead of dropping source custody', async () => {
    const h = harness(); h.deps.navigateTab = vi.fn(async () => { h.tab.pendingUrl = ACCOUNT; throw Error('Synthetic lost GET acknowledgement'); });
    let s = await h.run(h.initial);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'retry', navigation: { kind: 'get' } } });
    h.tick(60); h.deps.navigateTab = vi.fn(async () => { h.tab.pendingUrl = LOGIN; });
    s = await h.run(s); expect(s.status).toBe('running'); expect(s.consecutiveFailures).toBe(1);
    h.commit(DASHBOARD); s = await h.run(s); expect(s.authentication).toBeNull();
  });

  it('quiet account maintenance keeps its counted wait; unknown account never proves success', async () => {
    const h = harness(); let s = await h.run(h.initial); h.commit(ACCOUNT);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => args[1].name === 'readSiteMaintenance' ? { maintenance: true } : inject(...args));
    s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'retry', maintenanceRecovery: true } });
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
  });

  it('refuses storage failure during account observation without injecting or navigating', async () => {
    const h = harness(); let s = await h.run(h.initial); h.commit(ACCOUNT);
    // Force the wrapped detector load (after initial configuration validation)
    // to fail deterministically.
    let reads = 0; const load = h.deps.loadPrefs;
    h.deps.loadPrefs = async () => { if (++reads === 3) throw Error('Synthetic storage unavailable'); return load(); };
    vi.mocked(h.deps.inject).mockClear(); s = await h.run(s);
    expect(s).toMatchObject({ status: 'stopped', authenticationFailureReason: 'storage-unavailable' });
    expect(h.deps.inject).not.toHaveBeenCalled(); expect(h.deps.navigateTab).toHaveBeenCalledOnce();
  });

  it.each(['purpose', 'canonical', 'cycle'])('refuses changed durable %s binding', async change => {
    const h = harness(); let s = await h.run(h.initial);
    const n = { ...s.authentication!.navigation! };
    if (change === 'purpose') n.purpose = 'verify';
    if (change === 'canonical') n.dashboardPath = '/en-ca/niv/groups/99999999';
    if (change === 'cycle') n.cycleStartedAt = '2026-11-08T00:00:00.000Z';
    s = await h.run({ ...s, authentication: { ...s.authentication!, navigation: n } });
    expect(s.status).toBe('stopped'); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('verification login keeps the original uncertain booking verification-only through intermediaries', async () => {
    const h = harness(); let s = { ...h.initial, status: 'verifying' as const,
      intent: { runId: h.initial.runId!, mode: 'booking' as const, groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver' as const, testMode: false, createdAt: NOW },
      executor: { ...h.initial.executor!, actionPending: true },
      authentication: { ...h.initial.authentication!, purpose: 'verify' as const, tabId: 7 } };
    h.commit(LOGIN); s = await h.run(s) as typeof s; s = await h.run(s) as typeof s;
    h.tab.pendingUrl = ACCOUNT; s = await h.run(s) as typeof s;
    expect(s.status).toBe('verifying'); expect(s.intent).not.toBeNull();
    h.commit(DASHBOARD); const next = await h.run(s);
    expect(next).toMatchObject({ status: 'verifying', authentication: null, intent: s.intent, verificationTabId: 7 });
    expect(vi.mocked(h.deps.inject).mock.calls.every(c => ['readSiteMaintenance', 'readDashboardGroups', 'performLoginAction'].includes(c[1].name))).toBe(true);
  });
});

it('fresh verification GET retains fixed-entry evidence before any login action or account binding', async () => {
  const h = harness();
  const intent = { runId: h.initial.runId!, mode: 'booking' as const, groupId: '11111111', targetDate: '2026-11-19', consulate: 'Vancouver' as const, testMode: false, createdAt: NOW };
  const original = { ...h.initial, status: 'verifying' as const, intent, authentication: null,
    executor: { ...h.initial.executor!, actionPending: true } };
  let s = beginAuthentication(original, 'verify', NOW);
  h.deps.createTab = vi.fn(async () => ({ id: 7, url: 'about:blank', pendingUrl: LOGIN }));
  s = await h.run(s);
  expect(s.authentication?.navigation).toMatchObject({ kind: 'get', purpose: 'verify', source: LOGIN });
  h.tab.url = 'about:blank'; h.tab.pendingUrl = LOGIN; h.tab.status = 'loading';
  s = await h.run(s); expect(s.status).toBe('verifying'); expect(h.deps.inject).not.toHaveBeenCalled();
  h.tab.url = LOGIN; h.tab.pendingUrl = ACCOUNT;
  s = await h.run(s); expect(s.status).toBe('verifying'); expect(h.deps.inject).not.toHaveBeenCalled();
  h.commit(ACCOUNT); h.tick(60); s = await h.run(s);
  expect(s.status).toBe('verifying'); expect(s.authentication?.navigation?.originSource).toBe(LOGIN);
  h.commit(DASHBOARD); s = await h.run(s);
  expect(s).toMatchObject({ status: 'verifying', authentication: null, intent, verificationTabId: 7 });
  expect(vi.mocked(h.deps.inject).mock.calls.every(c => ['readSiteMaintenance', 'readDashboardGroups'].includes(c[1].name))).toBe(true);
});

it('repeated quiet intermediaries retain one-expiry accounting and the tenth-failure cooldown', async () => {
  const h = harness(); let s = await h.run(h.initial); h.commit(ACCOUNT);
  for (let failures = 1; failures <= 10; failures++) {
    h.tick(60); s = await h.run(s);
    expect(s.status).toBe('running'); expect(s.consecutiveFailures).toBe(failures);
    h.commit(ACCOUNT);
    const unchanged = await h.run(s);
    expect(unchanged.consecutiveFailures).toBe(failures);
  }
  expect(s.cooldownUntil).not.toBeNull(); expect(h.deps.navigateTab).toHaveBeenCalledTimes(10);
  h.tick(1800); s = await h.run(s);
  expect(s).toMatchObject({ status: 'running', consecutiveFailures: 0, cooldownUntil: null, authentication: { phase: 'prepare' } });
  expect(h.deps.navigateTab).toHaveBeenCalledTimes(11);
});
