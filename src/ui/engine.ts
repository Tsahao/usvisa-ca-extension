import { platform } from '../platform';
import { isPanelFailureKind, type PanelFailureKind } from '../engine/panel-errors';
import type { PanelSnapshot } from '../engine/panel';
import type { Mode } from './model';
import { pollDelaySeconds, SETUP_FAILURE_COOLDOWN_AFTER } from '../domain/timing';

export class PanelCommandError extends Error {
  readonly failureKind: PanelFailureKind;
  constructor(message: string, failureKind: PanelFailureKind) {
    super(message);
    this.name = 'PanelCommandError';
    this.failureKind = failureKind;
  }
}

export async function panelCommand(action: 'STATE' | 'START' | 'STOP', mode?: Mode, restart = false, discover = false): Promise<PanelSnapshot> {
  const response = await platform.runtime.sendMessage({ type: `PANEL_${action}`, ...(mode ? { mode } : {}), ...(action === 'START' && restart ? { restart: true } : {}), ...(action === 'START' && discover ? { discover: true } : {}) });
  if (!response?.ok || !response.snapshot) {
    // Worker replies carry fixed safe diagnostics beside validated failure
    // metadata. Unknown metadata falls back to the catch-all kind; the
    // worker's safe text (or the contact fallback) is preserved unchanged.
    const message = typeof response?.error === 'string' && response.error
      ? response.error
      : 'Unable to contact the scheduling worker.';
    const failureKind = isPanelFailureKind((response as { failureKind?: unknown } | undefined)?.failureKind)
      ? (response as { failureKind: PanelFailureKind }).failureKind
      : 'generic';
    throw new PanelCommandError(message, failureKind);
  }
  return response.snapshot as PanelSnapshot;
}

export async function focusVisaTab(): Promise<void> {
  const response = await platform.runtime.sendMessage({ type: 'PANEL_FOCUS_TAB' });
  if (!response?.ok) throw new Error(typeof response?.error === 'string' ? response.error : 'Unable to show the Visa tab. Try again.');
}

// Only transport failures need panel-side retry: once the worker accepts Start,
// its durable setup state owns retries even if this window closes. Repeated
// requests after a lost response are idempotent in the worker.
export async function retryRestartCommand(mode: Mode, interval: number, deps: {
  wait: (milliseconds: number) => Promise<void>; cancelled: () => boolean;
}): Promise<PanelSnapshot | null> {
  for (let attempt = 0; attempt < SETUP_FAILURE_COOLDOWN_AFTER; attempt++) {
    if (deps.cancelled()) return null;
    try { return await panelCommand('START', mode, true); }
    catch {
      if (deps.cancelled()) return null;
      if (attempt + 1 === SETUP_FAILURE_COOLDOWN_AFTER) throw new PanelCommandError('Unable to restart the scheduling worker.', 'generic');
      await deps.wait(pollDelaySeconds(Math.random, interval) * 1000);
    }
  }
  return null;
}
