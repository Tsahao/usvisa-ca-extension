import { CONSULATES, type Consulate } from '../domain/dates';
import { HISTORY_KEY, emptyHistory, validateHistory, pruneHistory, observeHistory, markHistoryBooking,
  historyRows, historyExpiry, type DateHistory } from '../domain/history';
import type { StorageArea } from './storage';
import type { EngineState } from './workflow';

type Scope = { mode: 'booking' | 'alerts'; scheduleId: string; ivr: string | null; consulate: Consulate };
async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Own queue and own storage key: recording/display failures never enter the
// workflow queue, alter safety checkpoints, or hold up a time-sensitive click.
export function createDateHistory(deps: { area: StorageArea; now: () => string; schedule: (expiry: string | null) => Promise<void> }) {
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const pending = queue.then(task);
    queue = pending.catch(() => undefined);
    return pending;
  }
  async function load(): Promise<DateHistory> {
    const raw = (await deps.area.get([HISTORY_KEY]))[HISTORY_KEY];
    if (raw === undefined) return emptyHistory();
    return validateHistory(raw);
  }
  async function write(history: DateHistory, previous: DateHistory): Promise<void> {
    if (JSON.stringify(history) !== JSON.stringify(previous)) await deps.area.set({ [HISTORY_KEY]: history });
    await deps.schedule(historyExpiry(history)).catch(() => undefined);
  }
  const bestEffort = (task: () => Promise<void>) => enqueue(task).catch(() => undefined);
  const scopeFor = (state: EngineState, consulate: string): Scope | null => {
    if (!state.group || !state.runId || !Object.hasOwn(CONSULATES, consulate)) return null;
    return { mode: state.mode, scheduleId: state.group.scheduleId, ivr: state.group.ivr, consulate: consulate as Consulate };
  };
  function booking(state: EngineState, result: 'Attempted' | 'Yes'): Promise<void> {
    const intent = state.intent;
    const scope = intent && scopeFor(state, intent.consulate);
    if (!scope || !intent || state.mode !== 'booking' || state.group?.kind !== 'paid' || intent.testMode ||
        intent.mode !== 'booking' || intent.runId !== state.runId || intent.groupId !== state.group.scheduleId) return Promise.resolve();
    const event = { targetDate: intent.targetDate, createdAt: intent.createdAt, runId: intent.runId };
    return bestEffort(async () => {
      const [scopeHash, attempt] = await Promise.all([hash(scope), hash(event)]);
      const previous = await load();
      await write(markHistoryBooking(previous, { ...event, scope: scopeHash, attempt }, result, deps.now()), previous);
    });
  }
  return {
    observe(state: EngineState, consulate: string, earliestDate: string | null, checkedAt: string): Promise<void> {
      const scope = scopeFor(state, consulate);
      if (!scope || state.status !== 'running' || (state.mode === 'booking' ? state.group?.kind !== 'paid' : state.group?.kind !== 'unpaid')) return Promise.resolve();
      return bestEffort(async () => {
        const scopeHash = await hash(scope);
        const previous = await load();
        await write(observeHistory(previous, { scope: scopeHash, earliestDate, checkedAt, consulate: scope.consulate }, deps.now()), previous);
      });
    },
    attempted: (state: EngineState) => booking(state, 'Attempted'),
    confirmed: (state: EngineState) => booking(state, 'Yes'),
    prune: () => bestEffort(async () => {
      const previous = await load();
      if (!previous.entries.length && !previous.baselines.length) return;
      await write(pruneHistory(previous, deps.now()), previous);
    }),
    read: () => enqueue(async () => {
      const now = deps.now();
      const previous = await load();
      const clean = pruneHistory(previous, now);
      await write(clean, previous);
      return historyRows(clean, now);
    }),
  };
}
