import {
  DIAGNOSTICS_KEY,
  appendDiagnostic,
  diagnosticsExpiry,
  diagnosticsSnapshot,
  emptyDiagnostics,
  isExtensionVersion,
  pruneDiagnostics,
  validateDiagnostics,
  type DiagnosticEvent,
  type DiagnosticsLog,
  type DiagnosticsSnapshot,
} from '../domain/diagnostics';
import type { StorageArea } from './storage';

// Diagnostics own queue and own storage key. Recording is best effort: it
// never enters the workflow queue, is never awaited by a checkpoint or page
// action, and can neither block nor alter a booking/engine transition. Writes
// are serialized in order and bounded; excess events are dropped rather than
// growing memory, and a corrupt saved log degrades to an empty log instead of
// throwing into the caller. The log is intentionally never cleared by
// success, Stop/Start or worker suspension — only by retention.
export function createEngineDiagnostics(deps: {
  area: StorageArea;
  now: () => string;
  schedule: (expiry: string | null) => Promise<void>;
  // Bound on queued-but-unwritten events (best effort beyond this).
  maxPending?: number;
  // Validated extension build version recorded with every entry so a long
  // unattended run can be analyzed across an update. Unknown/malformed
  // versions are omitted rather than trusted verbatim.
  extensionVersion?: () => string | undefined;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const maxPending = deps.maxPending ?? 64;
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  }
  function currentVersion(): string | null {
    try {
      const value = deps.extensionVersion?.();
      return isExtensionVersion(value) ? value : null;
    } catch { return null; }
  }
  async function load(): Promise<DiagnosticsLog> {
    const raw = (await deps.area.get([DIAGNOSTICS_KEY]))[DIAGNOSTICS_KEY];
    if (raw === undefined) return emptyDiagnostics();
    try { return validateDiagnostics(raw); } catch { return emptyDiagnostics(); }
  }
  async function write(log: DiagnosticsLog, previous: DiagnosticsLog): Promise<void> {
    if (JSON.stringify(log) !== JSON.stringify(previous)) await deps.area.set({ [DIAGNOSTICS_KEY]: log });
    await deps.schedule(diagnosticsExpiry(log)).catch(() => undefined);
  }
  const bestEffort = (task: () => Promise<void>) => enqueue(task).catch(() => undefined);
  return {
    record(event: DiagnosticEvent): Promise<void> {
      if (pending >= maxPending) return Promise.resolve();
      // The timestamp and version are captured when the event is received,
      // not when the queue drains: a delayed write keeps the observed time.
      const version = currentVersion();
      const stamped = { ...event, at: deps.now(), ...(version === null ? {} : { extensionVersion: version }) };
      pending += 1;
      return bestEffort(async () => {
        const previous = await load();
        await write(appendDiagnostic(previous, stamped, stamped.at), previous);
      }).finally(() => { pending -= 1; });
    },
    prune: () => bestEffort(async () => {
      const previous = await load();
      await write(pruneDiagnostics(previous, deps.now()), previous);
    }),
    read: (): Promise<DiagnosticsSnapshot> => enqueue(async () => {
      const now = deps.now();
      const previous = await load();
      const clean = pruneDiagnostics(previous, now);
      await write(clean, previous);
      return diagnosticsSnapshot(clean, now, currentVersion());
    }),
  };
}
