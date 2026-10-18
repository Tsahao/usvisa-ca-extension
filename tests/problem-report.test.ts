import { describe, expect, it } from 'vitest';
import { buildProblemEmail, problemContext, REPORT_URL_LIMIT } from '../src/domain/problem-report';
import { emptyEngineState } from '../src/engine/workflow';

const now = '2026-10-17T12:00:00.000Z';
const args = { now, version: '0.2.2', userAgent: 'Private device Chrome/140.0.0.0', mode: 'booking' as const,
  autoMode: true, status: 'failure', failureKind: 'generic' };
const body = (url: string) => new URL(url).searchParams.get('body')!;

describe('problem email draft', () => {
  it('uses the approved recipient and format, without required user questions', () => {
    const url = buildProblemEmail({ ...args, context: { status: 'stopped', stage: 'form' },
      diagnostics: { version: 1, entries: [{ at: now, code: 'auth-terminal', reason: 'credential-rejected', count: 2 }] } });
    expect(url).toMatch(/^mailto:browser\.latte\.1k@icloud\.com\?/);
    expect(new URL(url).searchParams.get('subject')).toBe('[Visa Extension] Problem report — v0.2.2');
    expect(body(url)).toBe(`Optionally, you can add anything you think is helpful to pinpoint the issue.\n\n\n--- Technical details ---\nReport generated: ${now}\nExtension version: 0.2.2\nBrowser version: Chrome/140.0.0.0\nWorkflow mode: Book\nAuto Mode: On\nWorkflow status: stopped\nWorkflow stage: form\nFailure reason: generic\nFailure code: none\n\n--- Recent diagnostics ---\n${now} auth-terminal reason=credential-rejected count=2`);
  });
  it('exports only allowlisted fields, never arbitrary replies, UA, or workflow data', () => {
    const privateText = 'private@example.invalid';
    const url = buildProblemEmail({ ...args, version: privateText, failureKind: privateText,
      context: { status: privateText, stage: privateText, password: privateText, failureCode: privateText },
      diagnostics: { version: 1, entries: [{ at: now, code: 'poll-park', email: privateText }] } });
    expect(body(url)).not.toContain(privateText);
    expect(body(url)).not.toContain('Private device');
    expect(body(url)).toContain('poll-park');
    const state = { ...emptyEngineState(now), stage: privateText, runId: privateText };
    expect(problemContext(state)).toEqual({ status: 'idle', stage: 'unknown', failureCode: null });
    expect(body(url)).toContain('Failure code: none');
  });
  it('includes the specific internal failure code without exposing technical prose in the UI category', () => {
    const context = problemContext({ ...emptyEngineState(now), status: 'stopped', authenticationFailureReason: 'unpaid-group-unavailable' });
    expect(body(buildProblemEmail({ ...args, context }))).toContain('Failure reason: generic\nFailure code: unpaid-group-unavailable');
  });
  it('reports a direct Start refusal even when no engine run was created', () => {
    const diagnostics = { version: 1, entries: [{ at: now, code: 'auth-terminal', reason: 'dashboard-group-invalid' }] };
    const context = problemContext(null, diagnostics);
    expect(context).toEqual({ status: 'stopped', stage: 'none', failureCode: 'dashboard-group-invalid' });
    expect(body(buildProblemEmail({ ...args, context, diagnostics }))).toContain('Failure code: dashboard-group-invalid');
    expect(problemContext(null, { version: 1, entries: [{ at: now, code: 'auth-started' }, ...diagnostics.entries] }).failureCode).toBeNull();
    expect(problemContext(emptyEngineState(now), diagnostics).failureCode).toBeNull();
    expect(problemContext(null, { version: 1, entries: [{ at: now, code: 'auth-terminal', reason: 'private@example.invalid' }] }).failureCode).toBeNull();
  });
  it('bounds encoded URL length, keeps newest diagnostics and marks omitted entries', () => {
    const url = buildProblemEmail({ ...args, diagnostics: { version: 1,
      entries: Array.from({ length: 1500 }, (_, index) => ({ at: new Date(Date.parse(now) - index * 1000).toISOString(),
        code: index === 0 ? 'auth-terminal' : 'poll-retry', failures: index, count: 1 })) } });
    expect(url.length).toBeLessThanOrEqual(REPORT_URL_LIMIT);
    expect(body(url)).toContain('auth-terminal');
    expect(body(url)).toContain('Older entries omitted');
  });
  it.each([undefined, { version: 1, entries: [{ at: now, code: 'private error text' }] }])('handles unavailable/corrupt diagnostics', diagnostics => {
    expect(body(buildProblemEmail({ ...args, mode: 'alerts', autoMode: false, diagnostics }))).toContain('Diagnostics unavailable.');
    expect(body(buildProblemEmail({ ...args, mode: 'alerts', autoMode: false, diagnostics }))).toContain('Workflow mode: Alerts\nAuto Mode: Off');
  });
  it('prunes stale diagnostics', () => {
    expect(body(buildProblemEmail({ ...args, diagnostics: { version: 1,
      entries: [{ at: '2026-01-01T00:00:00.000Z', code: 'auth-terminal' }] } }))).toContain('No recent diagnostic entries.');
  });
});
