import { isExtensionVersion, pruneDiagnostics, validateDiagnostics } from './diagnostics';
import { isPanelFailureKind } from '../engine/panel-errors';
import type { EngineState } from '../engine/workflow';

export const REPORT_EMAIL = 'browser.latte.1k@icloud.com';
export const REPORT_URL_LIMIT = 2000;
const REPORT_STAGES = ['authentication', 'actions', 'warning', 'applicants', 'form', 'confirm', 'done', 'none'] as const;

// Project only fixed fields, never serialize the workflow or preferences.
export function problemContext(state: EngineState | null) {
  return {
    status: state?.status ?? 'idle',
    stage: state?.authentication ? 'authentication' : REPORT_STAGES.find(value => value === (state?.stage ?? 'none')) ?? 'unknown',
  };
}

export function buildProblemEmail(args: {
  now: string; version: unknown; userAgent: string; mode: 'booking' | 'alerts';
  autoMode: boolean; status: string; failureKind: unknown; diagnostics?: unknown; context?: unknown;
}): string {
  const version = isExtensionVersion(args.version) ? args.version : 'unknown';
  // Never include raw user-agent, error messages, or worker replies.
  const browser = args.userAgent.match(/(?:Edg|Chrome|Chromium)\/[\d.]{1,32}/)?.[0] ?? 'unknown';
  const context = args.context as { status?: unknown; stage?: unknown } | undefined;
  const status = ['idle', 'running', 'verifying', 'stopped'].find(value => value === context?.status) ??
    ['idle', 'running', 'success', 'failure'].find(value => value === args.status) ?? 'unknown';
  const stage = REPORT_STAGES.find(value => value === context?.stage) ?? 'unknown';
  const failure = isPanelFailureKind(args.failureKind) ? args.failureKind : 'generic';
  let lines: string[] = [];
  let available = false;
  try {
    const log = pruneDiagnostics(validateDiagnostics(args.diagnostics), args.now);
    available = true;
    lines = log.entries.map(entry => `${entry.at} ${entry.code}` +
      Object.entries(entry).filter(([key]) => key !== 'at' && key !== 'code')
        .map(([key, value]) => ` ${key}=${value}`).join(''));
  } catch { /* Missing or corrupt diagnostics must not prevent a draft. */ }
  const body = [
    'Optionally, you can add anything you think is helpful to pinpoint the issue.', '', '',
    '--- Technical details ---', `Report generated: ${args.now}`, `Extension version: ${version}`,
    `Browser version: ${browser}`, `Workflow mode: ${args.mode === 'booking' ? 'Book' : 'Alerts'}`,
    `Auto Mode: ${args.autoMode ? 'On' : 'Off'}`, `Workflow status: ${status}`,
    `Workflow stage: ${stage}`, `Failure reason: ${failure}`, '', '--- Recent diagnostics ---',
  ].join('\n') + '\n';
  const prefix = `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(`[Visa Extension] Problem report — v${version}`)}&body=`;
  const url = (text: string) => prefix + encodeURIComponent(body + text);
  let included: string[] = [];
  for (const line of lines) {
    if (url([...included, line, '(Older entries omitted to fit email link.)'].join('\n')).length > REPORT_URL_LIMIT) break;
    included.push(line);
  }
  if (!available) included = ['Diagnostics unavailable.'];
  else if (!lines.length) included = ['No recent diagnostic entries.'];
  else if (included.length < lines.length) included.push('(Older entries omitted to fit email link.)');
  return url(included.join('\n'));
}
