import { NAVIGATION_ROUTE_CLASSES } from '../domain/diagnostics';
import { classifyRoute, SITE_ORIGIN } from '../domain/routes';
import { isNavigationRecoveryUrl } from './navigation-recovery';
import type { ExecTab } from './executor';
import type { EngineState, OwnedGet, LoginActionTransition, AuthenticationTransition } from './workflow';

export const ROOT = `${SITE_ORIGIN}/en-ca/niv/`;
export const SIGN_IN = `${SITE_ORIGIN}/en-ca/niv/users/sign_in`;
export const ROUTE_CLASSES = NAVIGATION_ROUTE_CLASSES;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

export function routeClass(state: EngineState, value: string | undefined): RouteClass {
  if (!value) return 'none';
  if (value === 'about:blank') return 'blank';
  try {
    const url = new URL(value);
    if (url.origin !== SITE_ORIGIN || url.username || url.password || url.port) return 'foreign';
    if (url.hash || (url.search && !['appointment'].includes(classifyRoute(value)))) return 'dirty';
    if (url.pathname === '/en-ca/niv/account' || url.pathname === '/en-ca/niv/account/') return 'account';
    if (url.pathname === '/en-ca/niv/groups' && state.group?.dashboardPath !== '/en-ca/niv/groups') return 'index';
    if (classifyRoute(value) === 'dashboard') return !state.group?.dashboardPath || url.pathname === state.group.dashboardPath ? 'saved-dashboard' : 'foreign-dashboard';
    if (value === SIGN_IN) return 'login';
    if ([ROOT, `${SITE_ORIGIN}/en-ca/niv`].includes(value)) return 'root';
    return isNavigationRecoveryUrl(state, value) ? 'workflow' : url.search ? 'dirty' : 'unknown';
  } catch { return 'unknown'; }
}

function scope(state: EngineState, source: string): Omit<OwnedGet, 'kind' | 'action'> {
  const auth = state.authentication!;
  return { target: 'sign-in', source, originSource: source, tabId: auth.tabId!, owner: state.owner!, runId: state.runId!,
    purpose: auth.purpose, policyKey: state.policyKey, scheduleId: state.group?.scheduleId ?? null,
    dashboardPath: state.group?.dashboardPath ?? null, cycleStartedAt: auth.cycleStartedAt,
    deadline: auth.cycleDeadline!, dispatched: false };
}

export function ownedGet(state: EngineState, source: string, target: OwnedGet['target'], prior?: AuthenticationTransition): OwnedGet {
  return { ...scope(state, source), kind: 'get', target, originSource: prior?.originSource ?? prior?.source ?? source };
}
export function loginTransition(state: EngineState, action: 'prepare' | 'submit'): LoginActionTransition {
  return { ...scope(state, SIGN_IN), kind: 'login-action', target: 'sign-in', action };
}

export function ownedEntry(state: EngineState, value: string | undefined): boolean {
  return ['root', 'login', 'saved-dashboard'].includes(routeClass(state, value)) ||
    (!state.group?.dashboardPath && routeClass(state, value) === 'index');
}

// Distinct scopes for browser GETs and guarded login attempts. Login evidence
// can only hold consumed/read-only work, never authorize another fill/POST.
export function ownedGetScope(state: EngineState, tab: ExecTab): boolean {
  const a = state.authentication, n = a?.navigation;
  if (!a || !n) return false;
  const ownedId = state.mode === 'booking' ? state.executor?.tabId : state.monitorTabId;
  if (!['running', 'verifying'].includes(state.status) || (state.intent && a.purpose !== 'verify') || (state.executor?.actionPending && a.purpose !== 'verify') ||
      n.owner !== state.owner || n.runId !== state.runId || n.policyKey !== state.policyKey ||
      n.scheduleId !== (state.group?.scheduleId ?? null) || n.tabId !== a.tabId || tab.id !== n.tabId ||
      (n.purpose !== undefined && n.purpose !== a.purpose) ||
      (n.dashboardPath !== undefined && n.dashboardPath !== (state.group?.dashboardPath ?? null)) ||
      (n.cycleStartedAt !== undefined && n.cycleStartedAt !== a.cycleStartedAt) || n.deadline !== a.cycleDeadline ||
      (a.purpose === 'renew' && ownedId != null && n.tabId !== ownedId)) return false;
  const original = n.originSource ?? n.source;
  if (n.kind === 'login-action') return original === SIGN_IN && n.source === SIGN_IN &&
    (a.pending && a.checkpoint === 'action' || !!a.submittedInCycle && ['wait', 'cycle-wait', 'retry'].includes(a.phase));
  return !a.submittedInCycle && ['prepare', 'retry', 'cycle-wait'].includes(a.phase) &&
    (ownedEntry(state, original) || isNavigationRecoveryUrl(state, original));
}

export type TransitionDecision = 'none' | 'refuse' | 'wait' | 'committed' | 'maintenance';
export function ownedTransition(state: EngineState, tab: ExecTab): TransitionDecision {
  const n = state.authentication?.navigation;
  if (!n) return 'none';
  if (!ownedGetScope(state, tab)) return 'refuse';
  if (n.kind !== 'login-action' && tab.url === 'about:blank' && tab.pendingUrl === (n.target === 'root' ? ROOT : SIGN_IN)) return 'wait';
  const validTransit = (value: string | undefined) => ownedEntry(state, value) || ['account', 'index'].includes(routeClass(state, value));
  if ((tab.url !== n.source && !validTransit(tab.url)) || (tab.pendingUrl && !validTransit(tab.pendingUrl))) return 'refuse';
  if (tab.status === 'loading' || tab.pendingUrl || (n.kind !== 'login-action' && !n.dispatched && tab.url === n.source)) return 'wait';
  if (routeClass(state, tab.url) === 'account') return 'maintenance';
  if (routeClass(state, tab.url) === 'index' && state.group?.dashboardPath) return 'wait';
  return ownedEntry(state, tab.url) ? 'committed' : 'wait';
}
