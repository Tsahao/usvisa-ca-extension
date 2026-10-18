import { useEffect, useState, type UIEvent } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { DEFAULT_ADVANCED, preferenceIssues, type Preferences } from './model';
import panel from './Panel.module.css';
import local from './Configuration.module.css';
import { PreferenceFields, Row, Toggle } from './PreferenceFields';

export function Configuration({ preferences, active, save, cancel, trackScroll, openTerms, openHistory }: {
  preferences: Preferences;
  active: boolean;
  save: (value: Preferences) => Promise<void>;
  cancel: () => void;
  trackScroll: (event: UIEvent<HTMLElement>) => void;
  openTerms: () => void;
  openHistory?: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(preferences));
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<Partial<Record<keyof Preferences, boolean>>>({});
  const [focused, setFocused] = useState<keyof Preferences | null>(null);
  // Preferences arrive asynchronously; without this, a config screen opened
  // before loading finishes would display (and could save) stale values —
  // including a stale Auto Mode position.
  useEffect(() => {
    setDraft(structuredClone(preferences));
    setCompleted({});
    setFocused(null);
    setError('');
  }, [preferences]);
  const issues = preferenceIssues(draft);
  const invalid = issues.length > 0;
  // Full validation still gates Save. Only completed, unfocused fields may
  // explain an error; a date-order error waits for both dates to be completed.
  const visibleIssue = issues.find(issue => issue.fields.every(field => completed[field] && focused !== field));
  const validationEvents = (field: keyof Preferences) => ({
    onFocus: () => setFocused(field),
    onBlur: () => { setFocused(null); setCompleted(current => ({ ...current, [field]: true })); },
  });
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => { setDraft(current => ({ ...current, [key]: value })); };
  const submit = async () => {
    if (invalid || active) return;
    setSaving(true);
    try { await save({ ...draft, email: draft.email.trim() }); } catch { setError('Unable to save preferences. Please try again.'); }
    setSaving(false);
  };
  return <form className={panel.config} onSubmit={event => { event.preventDefault(); void submit(); }}>
    {active && <p className={local.lockedNotice} role="note"><Info size={14} aria-hidden />Stop monitoring to modify settings</p>}
    <div className={`${panel.configScroll} ${local.scroll}`} onScroll={trackScroll}>
      <div className={`${local.content}${active ? ` ${local.locked}` : ''}`}>
        <h2 className={panel.sectionLabel}>Login and preferences</h2>
        <fieldset disabled={active || saving} className={panel.group}>
          <PreferenceFields draft={draft} update={update} validationEvents={validationEvents} />
        </fieldset>
        <button className={panel.disclosure} type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Advanced {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        {advanced && <fieldset disabled={active || saving} className={panel.advanced}>
          <div className={panel.group}>
            <Toggle label="Earlier appointments only" checked={draft.onlyEarlier} change={value => update('onlyEarlier', value)} />
            <Row label="Checking interval (s)"><input className={panel.shortInput} type="number" aria-label="Checking interval (s)" {...validationEvents('interval')} min="60" max="86400" value={draft.interval} onChange={event => update('interval', Number(event.target.value))} /></Row>
            <Row label="Paid IVR Group"><input aria-label="Paid IVR Group" inputMode="numeric" {...validationEvents('paidIvr')} value={draft.paidIvr} onChange={event => update('paidIvr', event.target.value)} /></Row>
            <Row label="Unpaid IVR Group"><input aria-label="Unpaid IVR Group" inputMode="numeric" {...validationEvents('unpaidIvr')} value={draft.unpaidIvr} onChange={event => update('unpaidIvr', event.target.value)} /></Row>
          </div>
        </fieldset>}
        {advanced && <div className={panel.advancedActions}>
          <button type="button" className={panel.secondary} onClick={openHistory}>View Logs</button>
          <button type="button" disabled={active || saving} className={panel.secondary} onClick={() => { setDraft(current => ({ ...current, ...DEFAULT_ADVANCED })); }}>Reset Advanced</button>
        </div>}
        {(error || visibleIssue) && <p className={panel.validation} role="alert">{error || visibleIssue?.message}</p>}
        <a href="#terms" className={local.termsLink} onClick={event => { event.preventDefault(); openTerms(); }}>Terms & Conditions</a>
      </div>
    </div>
    <footer className={panel.actions}><img className={panel.separator} src="assets/footer-line.svg" alt="" /><button type="button" className={panel.secondary} onClick={cancel}>Cancel</button><button type="submit" className={`${panel.primary}${active ? ` ${local.lockedSave}` : ''}`} disabled={Boolean(invalid) || active || saving}>{saving ? 'Saving…' : 'Save'}</button></footer>
  </form>;
}
