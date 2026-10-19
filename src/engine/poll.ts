import { CONSULATES, isIsoDate, type ConsulateCandidate } from '../domain/dates';
import {
  countFailure,
  PAID_EMPTY_COOLDOWN_AFTER,
  pollDelaySeconds,
  refundFailures,
  SETUP_FAILURE_COOLDOWN_AFTER,
  shouldCooldown,
  cooldownUntilSeconds,
} from '../domain/timing';
import type { EngineState } from './workflow';

export type PollPlan =
  | { action: 'poll-now' }
  | { action: 'wait'; until: string }
  | { action: 'none'; reason: 'not-running' | 'unbound' };

export type PollOutcome = 'healthy' | 'not-modified' | 'empty' | 'retryable' | 'maintenance' | 'denied';

function epochOf(value: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error('Invalid poll timestamp.');
  return epoch;
}

function atEpoch(nowEpoch: number, delayS: number): string {
  return new Date(nowEpoch + delayS * 1000).toISOString();
}

// Alarms are disposable; both kinds of deadline live in durable state.
// A short poll kick must never bypass a longer cooldown.
export function engineAlarmAt(state: EngineState): string | null {
  if (state.status === 'verifying' && !state.authentication) return state.verification?.nextReadAt ?? null;
  if (state.status !== 'running' && !(state.status === 'verifying' && state.authentication)) return null;
  const deadlines = [state.nextPollAt, state.cooldownUntil].filter((value): value is string => value !== null);
  return deadlines.sort((a, b) => epochOf(b) - epochOf(a))[0] ?? null;
}

// Decides the next poll move from durable budgets only. Never triggers work
// itself; the worker executes exactly one poll per 'poll-now'.
export function planPollStep(state: EngineState, now: string): PollPlan {
  const at = epochOf(now);
  if (state.status !== 'running') return { action: 'none', reason: 'not-running' };
  if (!state.group) return { action: 'none', reason: 'unbound' };
  const deadline = engineAlarmAt(state);
  if (deadline && epochOf(deadline) > at) return { action: 'wait', until: deadline };
  return { action: 'poll-now' };
}

// Folds one poll result into budgets and deadlines. Unpaid emptiness is
// healthy data and must never be routed here as 'empty' — as a backstop,
// alerts-mode emptiness takes the healthy path. Denied stops this transport
// state; the worker may separately start bounded authentication recovery.
export function applyPollResult(
  state: EngineState,
  args: { outcome: PollOutcome; now: string; random: () => number },
): EngineState {
  const at = epochOf(args.now);
  if (state.status !== 'running' && !((args.outcome === 'maintenance' || args.outcome === 'retryable') && state.status === 'verifying' && state.authentication)) return state;
  if (args.outcome === 'denied') {
    return { ...state, status: 'stopped', nextPollAt: null, updatedAt: args.now };
  }
  if (args.outcome === 'healthy' || args.outcome === 'not-modified' || (args.outcome === 'empty' && state.mode === 'alerts')) {
    return {
      ...state,
      consecutiveFailures: refundFailures(),
      cooldownUntil: null,
      nextPollAt: atEpoch(at, pollDelaySeconds(args.random, state.pollIntervalS)),
      updatedAt: args.now,
    };
  }
  // Completion of a cooldown starts a fresh consecutive-failure budget.
  const cooled = state.cooldownUntil !== null && epochOf(state.cooldownUntil) <= at;
  const failures = countFailure(cooled ? 0 : state.consecutiveFailures);
  const threshold = args.outcome === 'empty' ? PAID_EMPTY_COOLDOWN_AFTER : SETUP_FAILURE_COOLDOWN_AFTER;
  if (shouldCooldown(failures, threshold)) {
    return {
      ...state,
      consecutiveFailures: failures,
      cooldownUntil: new Date(cooldownUntilSeconds(Math.floor(at / 1000)) * 1000).toISOString(),
      nextPollAt: null,
      updatedAt: args.now,
    };
  }
  return {
    ...state,
    consecutiveFailures: failures,
    cooldownUntil: null,
    nextPollAt: atEpoch(at, pollDelaySeconds(args.random, state.pollIntervalS)),
    updatedAt: args.now,
  };
}

// Records the latest eligible candidate without acting on it. Advancement
// decisions read this field alongside a reread guard; never navigate here.
export function recordCandidate(state: EngineState, candidate: ConsulateCandidate | null, now: string): EngineState {
  if (candidate !== null && !isIsoDate(candidate.date)) throw new Error('Invalid candidate date.');
  if (candidate !== null && !Object.hasOwn(CONSULATES, candidate.consulate)) throw new Error('Invalid candidate consulate.');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid poll timestamp.');
  if (state.status !== 'running') return state;
  return { ...state, lastCandidate: candidate, updatedAt: now };
}

export type BookingStage = 'actions' | 'warning' | 'applicants' | 'form' | 'confirm' | 'done';

// Moves a running bound run between booking executor stages. Returning to a
// polling posture clears the stage; anything else preserves it. The worker,
// never the page, owns stage transitions.
export function setStage(state: EngineState, stage: BookingStage | null, now: string): EngineState {
  if (stage !== null && !['actions', 'warning', 'applicants', 'form', 'confirm', 'done'].includes(stage))
    throw new Error('Invalid booking stage.');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid poll timestamp.');
  if (state.status !== 'running') return state;
  if (!state.group) return state;
  return { ...state, stage, updatedAt: now };
}
