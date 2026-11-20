import { describe, expect, it, vi } from 'vitest';
import { beginAuthentication, runAuthentication } from '../src/engine/authentication';
import { bindGroup, emptyEngineState, reconcileStartup, startRun, validateEngineState, type EngineState } from '../src/engine/workflow';
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

describe('owned renewal navigation before sign-in commits', () => {
  for (const [mode, source] of [
    ['booking', `${BASE}/appointment`],
    ['booking', `${BASE}/appointment?applicants[]=77777777&applicants[]=88888888&confirmed_limit_message=1&commit=Continue`],
    ['booking', `${BASE}/continue_actions`],
    ['alerts', `${BASE}/payment`],
  ] as const) {
    for (const status of ['loading', 'complete']) {
      it.each([0, 59, 60, 61, 900])(`${mode} ${source.slice(BASE.length)} (${status}) waits or counts one expired cycle at +%ss without DOM access`, async seconds => {
        const h = harness(mode, source);
        let s = await h.run(h.initial);
        const deadline = s.authentication!.cycleDeadline;
        h.tab.status = status; h.tick(seconds);
        s = await h.run(s);
        expect(s).toMatchObject({ status: 'running', loginFailed: false, authentication: { tabId: 7, phase: 'prepare', pending: false },
          group: h.initial.group, consecutiveFailures: seconds >= 60 ? 1 : 0 });
        expect(h.deps.navigateTab).toHaveBeenCalledTimes(seconds >= 60 ? 2 : 1);
        if (seconds < 60) expect(s.authentication!.cycleDeadline).toBe(deadline);
        else expect(s.authentication!.cycleStartedAt).toBe(h.deps.nowIso());
        const after = s.authentication!.cycleDeadline;
        const again = await h.run(s);
        expect(again.consecutiveFailures).toBe(s.consecutiveFailures);
        expect(again.authentication!.cycleDeadline).toBe(after);
        expect(h.deps.inject).not.toHaveBeenCalled();
        expect(h.deps.createTab).not.toHaveBeenCalled();
        expect(JSON.stringify([s, ...h.saved, ...h.diagnostics])).not.toContain(PREFS.password);
      });
    }
  }

  it.each(['preferences', 'checkpoint'] as const)('anchors the first GET after delayed %s setup, not the original start', async delay => {
    const h = harness();
    let delayed = false;
    const pause = () => { if (!delayed) { delayed = true; h.tick(900); } };
    if (delay === 'preferences') h.hooks.prefs = pause;
    else h.hooks.save = pause;
    const s = await h.run(h.initial);
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 0, authentication: { pending: false,
      cycleStartedAt: '2026-11-09T00:15:00.000Z', cycleDeadline: '2026-11-09T00:16:00.000Z' } });
    expect(h.saved.at(-1)?.authentication?.cycleDeadline).toBe(s.authentication!.cycleDeadline);
    expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('bounds repeated checkpoint delays without issuing a GET with an expired initial budget', async () => {
    const h = harness(); h.hooks.save = s => { if (s.authentication?.pending) h.tick(90); };
    const s = await h.run(h.initial);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { phase: 'retry', pending: false } });
    expect(Date.parse(s.nextPollAt!)).toBeGreaterThan(Date.parse(h.deps.nowIso()));
    expect(h.deps.navigateTab).not.toHaveBeenCalled(); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('retains time actually spent after dispatch rather than resetting on a late navigation acknowledgement', async () => {
    const h = harness(); h.hooks.navigate = () => h.tick(900);
    let s = await h.run(h.initial);
    expect(s.authentication!.cycleDeadline).toBe('2026-11-09T00:01:00.000Z');
    delete h.hooks.navigate;
    s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { cycleStartedAt: '2026-11-09T00:15:00.000Z' } });
    expect(h.deps.navigateTab).toHaveBeenCalledTimes(2); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('uses the current clock when a tab lookup crosses the deadline', async () => {
    const h = harness(); let s = await h.run(h.initial);
    h.hooks.get = () => { delete h.hooks.get; h.tick(60); };
    s = await h.run(s);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.authentication!.cycleStartedAt).toBe('2026-11-09T00:01:00.000Z');
    expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it.each(['loading', 'complete'])('holds %s navigation through ten failures/cooldown and resumes a due retry without recounting', async status => {
    const h = harness(); let s = await h.run(h.initial); h.tab.status = status;
    for (let failures = 1; failures <= 10; failures++) {
      h.tick(60); s = await h.run(s); expect(s.consecutiveFailures).toBe(failures);
    }
    expect(s).toMatchObject({ status: 'running', authentication: { phase: 'retry', pending: false }, nextPollAt: null });
    expect(s.cooldownUntil).not.toBeNull();
    const calls = vi.mocked(h.deps.navigateTab!).mock.calls.length;
    h.tick(30); expect(await h.run(s)).toEqual(s);
    expect(h.deps.navigateTab).toHaveBeenCalledTimes(calls);
    h.tick(1770); s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 0, cooldownUntil: null, authentication: { phase: 'prepare' } });
    expect(h.deps.navigateTab).toHaveBeenCalledTimes(calls + 1);
    h.tick(60); s = await h.run(s); expect(s.consecutiveFailures).toBe(1);
    expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('preserves a counted retry deadline across worker wake and early load events', async () => {
    const h = harness(); const dispatched = await h.run(h.initial);
    const pending = h.saved[0];
    let s = validateEngineState(reconcileStartup(pending, h.deps.nowIso()));
    expect(s.authentication!.phase).toBe('retry');
    h.tick(30); expect(await h.run(s)).toEqual(s);
    h.tick(30); s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 0, authentication: { phase: 'prepare', pending: false } });
    expect(s.group).toEqual(dispatched.group); expect(h.deps.navigateTab).toHaveBeenCalledTimes(2);
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(reconcileStartup(pending, h.deps.nowIso(), true)).toMatchObject({ status: 'verifying', authentication: null });
    const legacy = { ...pending, authentication: { ...pending.authentication!, checkpoint: undefined } };
    expect(reconcileStartup(legacy, h.deps.nowIso())).toMatchObject({ status: 'verifying', authentication: null });
  });

  it('resumes a due non-cooldown retry without counting it twice or shortening its wait', async () => {
    const h = harness(); let s = await h.run(h.initial);
    s = { ...s, consecutiveFailures: 3, nextPollAt: s.authentication!.cycleDeadline!, authentication: { ...s.authentication!, phase: 'retry' } };
    h.tick(59); expect(await h.run(s)).toEqual(s);
    h.tick(1); s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 3, authentication: { phase: 'prepare', pending: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledTimes(2); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('counts a new browser-GET failure on a due retry, while an already-counted expiry stays counted once', async () => {
    for (const phase of ['prepare', 'retry'] as const) {
      const h = harness(); let s = await h.run(h.initial); h.tick(60);
      s = { ...s, consecutiveFailures: 3, authentication: { ...s.authentication!, phase } };
      h.deps.navigateTab = vi.fn(async () => { throw new Error('Synthetic browser GET failure'); });
      s = await h.run(s);
      expect(s).toMatchObject({ status: 'running', consecutiveFailures: 4, authentication: { phase: 'retry', pending: false } });
      expect(Date.parse(s.nextPollAt!)).toBeGreaterThan(Date.parse(h.deps.nowIso()));
      expect(h.deps.inject).not.toHaveBeenCalled();
    }
  });

  for (const phase of ['prepare', 'retry'] as const) {
    it.each([LOGIN, DASHBOARD])(`settles %s committing during a ${phase} GET checkpoint without duplicate navigation`, async target => {
      const h = harness(); let s = await h.run(h.initial); h.tick(60);
      if (phase === 'retry') s = { ...s, consecutiveFailures: 1, authentication: { ...s.authentication!, phase } };
      h.hooks.save = pending => { if (pending.authentication?.pending) h.commit(target); };
      s = await h.run(s);
      expect(s).toMatchObject({ status: 'running', authentication: { pending: false }, consecutiveFailures: 1 });
      expect(h.saved.at(-1)?.authentication).toMatchObject({ pending: false });
      expect(h.deps.navigateTab).toHaveBeenCalledOnce(); expect(h.deps.inject).not.toHaveBeenCalled();
      expect(reconcileStartup(h.saved.at(-1)!, h.deps.nowIso()).authentication?.pending).toBe(false);
      if (target === DASHBOARD) {
        h.tick(2); s = await h.run(s);
        expect(s).toMatchObject({ status: 'running', authentication: null, group: h.initial.group, sessionRenewals: 0 });
        expect(vi.mocked(h.deps.inject).mock.calls.map(c => c[1].name)).toContain('readCurrentAppointment');
        expect(vi.mocked(h.deps.inject).mock.calls.map(c => c[1].name)).not.toContain('performLoginAction');
      }
    });
  }

  it.each(['loading', 'complete'])('keeps pending sign-in read-only when status changes to %s during a checkpoint', async status => {
    const h = harness(); let s = await h.run(h.initial); h.tab.status = status === 'loading' ? 'complete' : 'loading'; h.tick(60);
    h.hooks.save = () => { h.tab.status = status; };
    s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 1, authentication: { pending: false } });
    expect(h.deps.navigateTab).toHaveBeenCalledTimes(2); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('does not navigate when Stop arrives during the final post-checkpoint tab lookup', async () => {
    const h = harness(); let s = await h.run(h.initial); h.tick(60);
    h.hooks.save = () => { h.hooks.get = h.cancel; };
    s = await h.run(s);
    expect(s).toMatchObject({ status: 'stopped', authenticationFailureReason: 'cancelled' });
    expect(h.deps.navigateTab).toHaveBeenCalledOnce(); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('fails closed if checkpoint clearing fails after the dashboard commits', async () => {
    const h = harness(); let s = await h.run(h.initial); h.tick(60);
    h.hooks.save = pending => {
      if (pending.authentication?.pending) h.commit(DASHBOARD);
      else throw new Error('Synthetic failed checkpoint clearing');
    };
    s = await h.run(s);
    expect(s).toMatchObject({ status: 'stopped', authenticationFailureReason: 'storage-unavailable' });
    expect(h.deps.navigateTab).toHaveBeenCalledOnce(); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('revalidates the full roster after pending navigation commits to dashboard', async () => {
    const h = harness(); let s = await h.run(h.initial); h.commit(DASHBOARD);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (...a: Parameters<ExecDeps['inject']>) => a[1].name === 'readCurrentAppointment'
      ? { scheduleId: '11111111', ivr: '22222222', kind: 'booked', text: 'January 1, 2027', applicantIds: [APPLICANTS[0]] }
      : inject(...a));
    s = await h.run(s);
    expect(s).toMatchObject({ status: 'stopped', authenticationFailureReason: 'applicant-roster-changed' });
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.inject).mock.calls.some(c => c[1].name === 'performLoginAction')).toBe(false);
  });
});

describe('renewal navigation custody and cancellation', () => {
  it.each([
    [`${SITE}/en-ca/niv/schedule/99999999/appointment`, LOGIN, 'navigation-source-rejected'],
    [`${BASE}/appointment?applicants[]=99999999`, LOGIN, 'navigation-source-rejected'],
    [`${BASE}/appointment?applicants[]=77777777&applicants[]=77777777`, LOGIN, 'navigation-source-rejected'],
    [`${BASE}/appointment?redirect=1`, LOGIN, 'navigation-source-rejected'],
    [`${BASE}/appointment#other`, LOGIN, 'navigation-source-rejected'],
    [`${BASE}/appointment`, `${LOGIN}?next=1`, 'navigation-pending-rejected'],
    [`${BASE}/appointment`, `${LOGIN}#other`, 'navigation-pending-rejected'],
    [`${BASE}/appointment`, `${SITE}/en-us/niv/users/sign_in`, 'navigation-pending-rejected'],
    [`${BASE}/appointment`, 'https://example.invalid/en-ca/niv/users/sign_in', 'navigation-pending-rejected'],
    [`${BASE}/appointment`, 'https://user@ais.usvisa-info.com/en-ca/niv/users/sign_in', 'navigation-pending-rejected'],
    [`${BASE}/appointment`, `${SITE}/en-ca/niv/groups/99999999`, 'navigation-pending-rejected'],
  ])('refuses unsupported source/pending pair %s -> %s with only fixed diagnostics', async (url, pendingUrl, detail) => {
    const h = harness(); let s = await h.run(h.initial);
    h.tab.url = url; h.tab.pendingUrl = pendingUrl; h.tick(60);
    s = await h.run(s);
    expect(s).toMatchObject({ status: 'stopped', authenticationFailureReason: 'untrusted-navigation' });
    expect(h.diagnostics.at(-1)).toMatchObject({ code: 'auth-terminal', detail });
    expect(h.deps.navigateTab).toHaveBeenCalledOnce(); expect(h.deps.inject).not.toHaveBeenCalled();
    const log = appendDiagnostic(emptyDiagnostics(), h.diagnostics.at(-1)!, h.deps.nowIso());
    expect(JSON.stringify(log)).not.toContain(SITE); expect(JSON.stringify(log)).not.toContain('11111111');
  });

  it.each(['offsite', 'locale', 'authority'] as const)('refuses an untrusted %s source at expiry', async change => {
    const h = harness(); let s = await h.run(h.initial); h.tick(60); h.tab.status = 'loading';
    h.tab.url = change === 'offsite' ? 'https://example.invalid/appointment' : change === 'locale'
      ? `${SITE}/en-us/niv/schedule/11111111/appointment` : 'https://user@ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
    s = await h.run(s);
    expect(s.status).toBe('stopped'); expect(h.deps.navigateTab).toHaveBeenCalledOnce(); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'about:blank'])('does not treat missing/blank pending destination (%s) as proof of a renewal GET', async pendingUrl => {
    const h = harness(); let s = await h.run(h.initial); s = { ...s, authentication: { ...s.authentication!, navigation: undefined } }; h.tab.pendingUrl = pendingUrl; h.tab.status = 'loading'; h.tick(60);
    s = await h.run(s);
    expect(s.status).toBe('stopped'); expect(h.deps.navigateTab).toHaveBeenCalledOnce(); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it.each(['returned-tab', 'authentication-tab', 'executor-tab', 'mutation', 'intent', 'uncertain-login'] as const)('refuses lost or unsafe custody: %s', async change => {
    const h = harness(); let s = await h.run(h.initial); h.tick(60);
    if (change === 'returned-tab') h.tab.id = 8;
    if (change === 'authentication-tab') s = { ...s, authentication: { ...s.authentication!, tabId: 8 } };
    if (change === 'executor-tab') s = { ...s, executor: { ...s.executor!, tabId: 8 } };
    if (change === 'mutation') s = { ...s, executor: { ...s.executor!, actionPending: true } };
    if (change === 'intent') s = { ...s, intent: { runId: s.runId!, mode: 'booking', groupId: '11111111', targetDate: '2026-11-19',
      consulate: 'Vancouver', testMode: false, createdAt: NOW } };
    if (change === 'uncertain-login') s = { ...s, authentication: { ...s.authentication!, phase: 'wait', submittedInCycle: true } };
    s = await h.run(s);
    expect(s.status).toBe(change === 'intent' ? 'verifying' : 'stopped');
    expect(h.deps.navigateTab).toHaveBeenCalledOnce(); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  for (const at of ['preferences', 'lookup', 'checkpoint', 'navigation'] as const) {
    it.each(['Stop', 'settings'] as const)(`honors %s during ${at}`, async change => {
      const h = harness(); let s = await h.run(h.initial); h.tick(60);
      const mutate = () => { if (change === 'Stop') h.cancel(); else h.edit(); };
      if (at === 'preferences') h.hooks.prefs = mutate;
      if (at === 'lookup') h.hooks.get = mutate;
      if (at === 'checkpoint') h.hooks.save = mutate;
      if (at === 'navigation') h.hooks.navigate = mutate;
      s = await h.run(s);
      expect(s).toMatchObject({ status: 'stopped', authenticationFailureReason: change === 'Stop' ? 'cancelled' : 'configuration-changed' });
      expect(h.deps.navigateTab).toHaveBeenCalledTimes(at === 'navigation' ? 2 : 1);
      expect(h.deps.inject).not.toHaveBeenCalled();
    });
  }

  it.each(['offsite', 'other-group', 'pending', 'closed', 'storage'] as const)('refuses %s changes during a saved GET checkpoint', async change => {
    const h = harness(); let s = await h.run(h.initial); h.tick(60);
    h.hooks.save = () => {
      if (change === 'offsite') h.commit('https://example.invalid/');
      if (change === 'other-group') h.tab.url = `${SITE}/en-ca/niv/schedule/99999999/appointment`;
      if (change === 'pending') h.tab.pendingUrl = `${LOGIN}?next=1`;
      if (change === 'closed') h.deps.getTab = async () => { throw new Error('Synthetic tab closure'); };
      if (change === 'storage') throw new Error('Synthetic storage failure');
    };
    s = await h.run(s);
    expect(s.status).toBe('stopped'); expect(h.deps.navigateTab).toHaveBeenCalledOnce(); expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it('blocks page inspection if pending navigation appears after the initial complete-page snapshot', async () => {
    const h = harness(); let s = await h.run(h.initial); delete h.tab.pendingUrl;
    let gets = 0;
    h.hooks.get = () => { if (++gets === 2) h.tab.pendingUrl = LOGIN; };
    s = await h.run(s);
    expect(h.deps.inject).not.toHaveBeenCalled();
    expect(s.status).toBe('running');
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
  });
});


describe('durable owned GET redirect sequences', () => {
  for (const mode of ['booking', 'alerts'] as const) {
    for (const target of ['root', 'sign-in'] as const) {
      for (const status of ['loading', 'complete'] as const) {
        it.each([ROOT, LOGIN, DASHBOARD, undefined])(`${mode} ${target} ${status} safely waits through pending %s`, async pending => {
          const h = harness(mode);
          const initial = target === 'root' ? { ...h.initial, authentication: { ...h.initial.authentication!, dashboardFirst: true as const } } : h.initial;
          let s = await h.run(initial);
          expect(s.authentication!.navigation).toMatchObject({ target, source: h.tab.url, runId: s.runId, tabId: 7 });
          const deadline = s.authentication!.cycleDeadline;
          h.tab.pendingUrl = pending; h.tab.status = status; h.tick(2);
          s = await h.run(s);
          expect(s.status).toBe('running'); expect(s.authentication!.cycleDeadline).toBe(deadline);
          expect(h.deps.inject).not.toHaveBeenCalled(); expect(h.deps.navigateTab).toHaveBeenCalledOnce();
          h.commit(DASHBOARD); h.tick(2); s = await h.run(s);
          expect(s).toMatchObject({ status: 'running', authentication: null, sessionRenewals: 0, group: h.initial.group });
          expect(h.saved.some(v => v.authentication?.navigation === undefined && !v.authentication?.pending)).toBe(true);
          expect(vi.mocked(h.deps.inject).mock.calls.some(c => c[1].name === 'performLoginAction')).toBe(false);
        });
      }
    }
  }

  it('retains provenance on worker wake before dispatch and bounds a missing pending destination', async () => {
    const h = harness(); await h.run(h.initial);
    let s = reconcileStartup(h.saved[0], h.deps.nowIso());
    expect(s.authentication?.navigation).toBeDefined();
    delete h.tab.pendingUrl; h.tab.status = 'complete';
    h.tick(59); expect(await h.run(s)).toEqual(s);
    h.tick(1); s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', consecutiveFailures: 0, authentication: { pending: false, phase: 'prepare' } });
    expect(h.deps.inject).not.toHaveBeenCalled(); expect(h.deps.navigateTab).toHaveBeenCalledTimes(2);
    const restarted = reconcileStartup(h.saved[0], h.deps.nowIso(), true);
    expect(restarted.status).toBe('verifying'); expect(restarted.authentication).toBeNull();
  });

  it.each(['run', 'owner', 'policy', 'group', 'deadline'])('refuses mismatched durable %s scope', async field => {
    const h = harness(); let s = await h.run(h.initial);
    const n = { ...s.authentication!.navigation! };
    if (field === 'run') n.runId = 'different-run-id';
    if (field === 'owner') n.owner = 'different-owner-id';
    if (field === 'policy') n.policyKey = 'different-policy';
    if (field === 'group') n.scheduleId = '99999999';
    if (field === 'deadline') n.deadline = NOW;
    s = await h.run({ ...s, authentication: { ...s.authentication!, navigation: n } });
    expect(s.status).toBe('stopped'); expect(h.deps.inject).not.toHaveBeenCalled(); expect(h.deps.navigateTab).toHaveBeenCalledOnce();
  });

  it('does not accept a dashboard whose pending navigation appears during the last baseline read', async () => {
    const h = harness(); let s = await h.run(h.initial); h.commit(DASHBOARD);
    const inject = h.deps.inject;
    h.deps.inject = vi.fn(async (...args: Parameters<ExecDeps['inject']>) => {
      const result = await inject(...args);
      if (args[1].name === 'readCurrentAppointment') h.tab.pendingUrl = LOGIN;
      return result;
    });
    s = await h.run(s);
    expect(s.authentication).not.toBeNull(); expect(s.sessionRenewals).toBe(1);
    expect(h.deps.navigateTab).toHaveBeenCalledOnce();
  });
});

describe('owned navigation persistence and legacy bindings', () => {
  it('establishes the missing canonical dashboard of an older binding only after fresh full validation', async () => {
    const h = harness(); const initial = { ...h.initial, group: { ...h.initial.group!, dashboardPath: undefined } };
    let s = await h.run(initial); h.commit(DASHBOARD); s = await h.run(s);
    expect(s).toMatchObject({ status: 'running', authentication: null, group: { dashboardPath: '/en-ca/niv/groups/55555555', applicantIds: APPLICANTS } });
    expect(vi.mocked(h.deps.inject).mock.calls.map(c => c[1].name)).toContain('readCurrentAppointment');
  });

  it('fails closed when durably clearing a committed navigation fails', async () => {
    const h = harness(); let s = await h.run(h.initial); h.commit(DASHBOARD);
    h.hooks.save = () => { throw new Error('Synthetic storage failure'); };
    s = await h.run(s);
    expect(s).toMatchObject({ status: 'stopped', authenticationFailureReason: 'storage-unavailable' });
    expect(h.deps.inject).not.toHaveBeenCalled();
  });

  it.each(['target', 'dispatched', 'deadline', 'tab'])('rejects corrupt privileged persisted navigation %s', async field => {
    const h = harness(); const s = await h.run(h.initial);
    const n = { ...s.authentication!.navigation! } as Record<string, unknown>;
    n[field === 'tab' ? 'tabId' : field] = field === 'target' ? 'https://example.invalid' : field === 'tab' ? -1 : 'invalid';
    expect(() => validateEngineState({ ...s, authentication: { ...s.authentication!, navigation: n } })).toThrow();
  });
});
