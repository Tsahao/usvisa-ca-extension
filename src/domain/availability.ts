import { isIsoDate } from './dates';

export type DayEntry = {
  date: string;
};

// Strict payload validation for availability reads. Anything malformed
// throws so the caller treats the poll as a failed read — never as empty,
// never as an observation. Empty arrays are valid data and flow to the
// cooldown/budget logic, not to error handling.
export function parseDaysPayload(value: unknown): DayEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid availability payload.');
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid availability payload.');
    const date = (entry as Record<string, unknown>).date;
    if (typeof date !== 'string' || !isIsoDate(date)) throw new Error('Invalid availability payload.');
    return { date };
  });
}

export function parseTimesPayload(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid times payload.');
  const times = (value as Record<string, unknown>).available_times;
  if (!Array.isArray(times)) throw new Error('Invalid times payload.');
  for (const time of times) {
    if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid times payload.');
  }
  return times as string[];
}
