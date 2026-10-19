import { describe, expect, it } from 'vitest';
import { panelSnapshot } from '../src/engine/panel';
import { emptyEngineState, startRun } from '../src/engine/workflow';

const NOW = '2026-10-12T00:00:00.000Z';
const state = startRun(emptyEngineState(NOW), { mode: 'booking', owner: 'owner-token-01', runId: 'run-id-0001', now: NOW });
describe('worker-backed product data', () => {
  it('never displays observations from a different run or a malformed snapshot', () => {
    for (const reading of [undefined, { runId: 'old-run-0001', mode: 'booking', checkedAt: NOW, dates: ['2026-11-19'] }, { runId: state.runId, mode: 'booking', checkedAt: NOW, dates: ['bad-date'] }]) {
      expect(panelSnapshot(state, reading, null)).toMatchObject({ dates: [], checkedAt: null, confirmedDate: null });
    }
  });
  it('exposes only the current run dates without credentials or identifiers', () => {
    const result = panelSnapshot(state, { runId: state.runId, mode: 'booking', checkedAt: NOW, dates: ['2026-11-19'] }, null);
    expect(result).toMatchObject({ dates: ['2026-11-19'], checkedAt: NOW, status: 'running' });
    expect(JSON.stringify(result)).not.toContain(state.runId);
    expect(JSON.stringify(result)).not.toContain(state.owner);
  });
  it('exposes validated per-consulate observations', () => {
    const same = { runId: state.runId, mode: 'booking', checkedAt: NOW, dates: ['2026-11-20'], rows: [] };
    expect(panelSnapshot(state, { ...same, byConsulate: [{ consulate: 'Halifax', dates: ['2026-11-20'] }] }, undefined).byConsulate).toEqual([{ consulate: 'Halifax', dates: ['2026-11-20'] }]);
    expect(panelSnapshot(state, { ...same, byConsulate: [{ consulate: 'Paris', dates: [] }] }, undefined).checkedAt).toBeNull();
    expect(panelSnapshot(state, { ...same, byConsulate: [{ consulate: 'Halifax', dates: ['x'] }] }, undefined).checkedAt).toBeNull();
    expect(panelSnapshot(state, { ...same, byConsulate: [{ consulate: 'Halifax', dates: [] }, { consulate: 'Halifax', dates: [] }] }, undefined).checkedAt).toBeNull();
    expect(panelSnapshot(state, same, undefined).byConsulate).toEqual([]);
  });
  it('reports review without inventing booked success from a dry-run candidate', () => {
    expect(panelSnapshot({ ...state, status: 'verifying', lastCandidate: { date: '2026-11-19', consulate: 'Vancouver' } }, null, null)).toMatchObject({ status: 'idle', reviewRequired: true, confirmedDate: null });
    expect(panelSnapshot({ ...state, status: 'stopped' }, null, { runId: 'old-run-0001', date: '2026-11-19' }).status).toBe('idle');
  });
  it('explains the Start action for unresolved booking attempts without nagging paused runs', () => {
    expect(panelSnapshot({ ...state, status: 'verifying' }, null, null).reviewMessage).toBeUndefined();
    const intent = { runId: state.runId!, groupId: '11111111', mode: 'booking' as const, targetDate: '2026-11-19', consulate: 'Vancouver', testMode: true, createdAt: NOW };
    expect(panelSnapshot({ ...state, status: 'verifying', intent }, null, null).reviewMessage)
      .toBe('The previous booking attempt needs checking. Press Start to verify its result first.');
    expect(panelSnapshot({ ...state, status: 'verifying', intent, verification: { reads: [], nextReadAt: NOW } }, null, null).reviewMessage)
      .toBe('Checking the previous booking attempt. No new booking will start during this check.');
    expect(panelSnapshot({ ...state, status: 'stopped', manualAuthentication: true }, null, null).reviewMessage)
      .toBe('Sign in manually on the official website, then press Start.');
  });
});

describe('stopped failure classification', () => {
  it('marks a real stopped login failure as a generic failure', () => {
    const stopped = { ...state, status: 'stopped' as const, loginFailed: true, authentication: null, nextPollAt: null };
    expect(panelSnapshot(stopped, null, null)).toMatchObject({ status: 'failure', failureKind: 'generic', reviewRequired: true });
  });
  it('classifies stopped selected-group IVR diagnostics without changing the safe message', () => {
    const paid = { ...state, status: 'stopped' as const, loginFailed: false, authentication: null, nextPollAt: null,
      authenticationError: 'No eligible paid group was found on this dashboard. Check the Paid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.' };
    const unpaid = { ...paid,
      authenticationError: 'No eligible unpaid group was found on this dashboard. Check the Unpaid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.' };
    const paidRejected = { ...paid,
      authenticationError: 'The selected booking group is not eligible for paid booking. Check both Visa Group IVRs and payment status in Settings.' };
    const unpaidRejected = { ...paid,
      authenticationError: 'The selected alert group is not eligible for date alerts. Check both Visa Group IVRs and payment status in Settings.' };
    expect(panelSnapshot(paid, null, null)).toMatchObject({ status: 'failure', failureKind: 'paid-ivr-not-found', reviewRequired: true });
    expect(panelSnapshot(unpaid, null, null)).toMatchObject({ status: 'failure', failureKind: 'unpaid-ivr-not-found', reviewRequired: true });
    expect(panelSnapshot(paidRejected, null, null)).toMatchObject({ status: 'failure', failureKind: 'paid-ivr-not-found', reviewRequired: true });
    expect(panelSnapshot(unpaidRejected, null, null)).toMatchObject({ status: 'failure', failureKind: 'unpaid-ivr-not-found', reviewRequired: true });
    expect(panelSnapshot(paid, null, null).reviewMessage).toBe(paid.authenticationError);
    expect(JSON.stringify(panelSnapshot(paid, null, null))).not.toMatch(/[0-9]{8}/);
  });
  it('keeps ambiguous or changed-group diagnostics generic', () => {
    for (const authenticationError of [
      'The extension found conflicting dashboard group identities. Refresh the dashboard; if this repeats, report this message.',
      'The signed-in group, appointment or applicant list changed. Check the dashboard and Settings before pressing Start.',
    ]) {
      const stopped = { ...state, status: 'stopped' as const, loginFailed: false, authentication: null, nextPollAt: null, authenticationError };
      expect(panelSnapshot(stopped, null, null)).toMatchObject({ status: 'failure', failureKind: 'generic' });
    }
  });
  it('never marks parked verifying states or manual handoff as failures', () => {
    const intent = { runId: state.runId!, groupId: '11111111', mode: 'booking' as const, targetDate: '2026-11-19', consulate: 'Vancouver', testMode: true, createdAt: NOW };
    const parked = panelSnapshot({ ...state, status: 'verifying', intent, loginFailed: true,
      authenticationError: 'The extension could not read group identities from this dashboard. Refresh the dashboard; if this repeats, report this message.' }, null, null);
    expect(parked.status).not.toBe('failure');
    expect(parked.failureKind).toBeUndefined();
    expect(parked.reviewMessage).toContain('needs checking');
    const manual = panelSnapshot({ ...state, status: 'stopped', manualAuthentication: true }, null, null);
    expect(manual.status).not.toBe('failure');
    expect(manual.failureKind).toBeUndefined();
    expect(manual.reviewMessage).toBe('Sign in manually on the official website, then press Start.');
  });
  it('keeps quiet maintenance retries running with no failure', () => {
    const retrying = { ...state, authentication: { tabId: 7, phase: 'retry' as const, pending: false, purpose: 'start' as const, startedAt: NOW },
      consecutiveFailures: 3, cooldownUntil: null };
    expect(panelSnapshot(retrying, null, null)).toMatchObject({ status: 'running', reviewRequired: false });
    expect(panelSnapshot(retrying, null, null).failureKind).toBeUndefined();
  });
  it('leaves clean stopped runs without a failure kind', () => {
    expect(panelSnapshot({ ...state, status: 'stopped' }, null, null)).toMatchObject({ status: 'idle', reviewRequired: false });
    expect(panelSnapshot({ ...state, status: 'stopped' }, null, null).failureKind).toBeUndefined();
  });
});
