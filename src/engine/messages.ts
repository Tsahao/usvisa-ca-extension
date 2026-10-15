import type { DashboardSnapshot } from '../domain/groups';
import type { ConfirmationIntent, EngineMode, VerificationOutcome } from './workflow';

export type EngineMessage =
  | { type: 'ENGINE_START'; mode: EngineMode; owner: string; runId: string; now: string; nextPollAt?: string | null }
  | { type: 'ENGINE_STOP'; owner: string; runId: string; now: string }
  | { type: 'ENGINE_INTENT'; owner: string; runId: string; intent: ConfirmationIntent; now: string }
  | { type: 'ENGINE_POLL'; owner: string; runId: string; nextPollAt: string | null; now: string }
  | {
      type: 'ENGINE_VERIFY';
      owner: string;
      runId: string;
      outcome?: VerificationOutcome;
      now: string;
    }
  | {
      type: 'ENGINE_RESOLVE';
      owner: string;
      runId: string;
      mode: EngineMode;
      snapshot: DashboardSnapshot;
      paidIvr: string;
      unpaidIvr: string;
      now: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Typed, validated messages. Anything malformed throws; callers must drop it.
// Messages carry only opaque run/owner/group identifiers and dates — never
// credentials, page text, or URLs.
export function validateEngineMessage(value: unknown): EngineMessage {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('Invalid engine message.');
  switch (value.type) {
    case 'ENGINE_START':
    case 'ENGINE_STOP':
    case 'ENGINE_INTENT':
    case 'ENGINE_POLL':
    case 'ENGINE_VERIFY':
    case 'ENGINE_RESOLVE':
      break;
    default:
      throw new Error('Invalid engine message.');
  }
  if (typeof (value as { owner?: unknown }).owner !== 'string') throw new Error('Invalid engine message.');
  if (typeof (value as { runId?: unknown }).runId !== 'string') throw new Error('Invalid engine message.');
  if (typeof (value as { now?: unknown }).now !== 'string') throw new Error('Invalid engine message.');
  if (value.type === 'ENGINE_START' && (value as { mode?: unknown }).mode !== 'booking' && (value as { mode?: unknown }).mode !== 'alerts')
    throw new Error('Invalid engine message.');
  if (value.type === 'ENGINE_RESOLVE') {
    const resolve = value as { mode?: unknown; snapshot?: unknown; paidIvr?: unknown; unpaidIvr?: unknown };
    if (resolve.mode !== 'booking' && resolve.mode !== 'alerts') throw new Error('Invalid engine message.');
    if (typeof resolve.snapshot !== 'object' || resolve.snapshot === null) throw new Error('Invalid engine message.');
    if (typeof resolve.paidIvr !== 'string' || typeof resolve.unpaidIvr !== 'string')
      throw new Error('Invalid engine message.');
  }
  if (value.type === 'ENGINE_VERIFY') {
    const outcome = (value as { outcome?: unknown }).outcome;
    if (outcome !== undefined && outcome !== 'target-confirmed' && outcome !== 'previous-continue' && outcome !== 'unbooked-continue' && outcome !== 'uncertain-stop')
      throw new Error('Invalid engine message.');
  }
  return value as EngineMessage;
}
