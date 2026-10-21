import { platform } from '../platform';
import { useEffect, useState, type UIEvent } from 'react';
import { HISTORY_KEY, HISTORY_TTL_MS, type HistoryRow } from '../domain/history';
import { NO_VALUE, cityLabel, formatDate } from './model';
import local from './History.module.css';
const EMPTY_ROWS: HistoryRow[] = [];

export async function readDateHistory(): Promise<HistoryRow[]> {
  const response = await platform.runtime.sendMessage({ type: 'PANEL_HISTORY' });
  if (!response?.ok || !Array.isArray(response.rows)) throw new Error('Unable to read date history. Reopen View Logs to try again.');
  return response.rows;
}

export function History({ live, previewRows = EMPTY_ROWS, trackScroll }: { live: boolean; previewRows?: HistoryRow[]; trackScroll: (event: UIEvent<HTMLElement>) => void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(live ? null : previewRows);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!live) { setRows(previewRows); setNow(Date.now()); } }, [live, previewRows]);
  useEffect(() => {
    if (!live) return;
    let disposed = false;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void readDateHistory().then(next => {
        if (!disposed && request === revision) { setRows(next); setError(false); setNow(Date.now()); }
      }).catch(() => { if (!disposed && request === revision) setError(true); });
    };
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && HISTORY_KEY in changes) refresh();
    };
    platform.storage.onChanged.addListener(changed);
    refresh();
    return () => { disposed = true; platform.storage.onChanged.removeListener(changed); };
  }, [live]);
  const visible = (rows ?? []).filter(row => Date.parse(row.checkedAt) > now - HISTORY_TTL_MS && Date.parse(row.checkedAt) <= now);
  useEffect(() => {
    if (!visible.length) return;
    const expires = Math.min(...visible.map(row => Date.parse(row.checkedAt) + HISTORY_TTL_MS));
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, expires - Date.now()));
    return () => clearTimeout(timer);
  }, [rows, now]);
  return <section className={local.content} aria-label="Date change history" onScroll={trackScroll}>
    {error ? <p className={local.message} role="alert">Unable to read date history. Reopen View Logs to try again.</p>
      : rows === null ? <p className={local.message} role="status">Loading date history…</p>
      : visible.length === 0 ? <p className={local.message}>No available dates are recorded</p>
      : <table className={local.table} aria-label="Date change history">
        <thead><tr><th scope="col">Checked</th><th scope="col">Earliest Date</th><th scope="col">City</th></tr></thead>
        <tbody>{visible.map(row => <tr key={row.id}>
          <td><time dateTime={row.checkedAt} title={new Date(row.checkedAt).toLocaleString()}>{new Date(row.checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time></td>
          <td>{formatDate(row.earliestDate)}</td><td>{row.consulate ? cityLabel(row.consulate) : NO_VALUE}</td>
        </tr>)}</tbody>
      </table>}
  </section>;
}
