import { useEffect, useState, type ReactNode, type UIEvent } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { CITIES, DEFAULT_ADVANCED, cityLabel, preferenceIssues, type Preferences } from './model';
import panel from './Panel.module.css';
import local from './Configuration.module.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <label className={panel.row}><span>{label}</span>{children}</label>;
}

function Toggle({ label, checked, change }: { label: string; checked: boolean; change: (value: boolean) => void }) {
  return <Row label={label}><input className={panel.toggle} type="checkbox" role="switch" aria-label={label} checked={checked} onChange={event => change(event.target.checked)} /></Row>;
}

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
  // including a stale Test Mode position.
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
          <Row label="Email"><input aria-label="Email" type="email" autoComplete="off" value={draft.email} onChange={event => update('email', event.target.value)} /></Row>
          <Row label="Password"><input aria-label="Password" type="password" autoComplete="off" {...validationEvents('password')} value={draft.password} onChange={event => update('password', event.target.value)} /></Row>
          <Row label="Consulate"><select aria-label="Consulate" {...validationEvents('consulate')} value={draft.consulate} onChange={event => update('consulate', event.target.value as Preferences['consulate'])}><option value="">Select Consulate</option>{CITIES.map(city => <option key={city} value={city}>{cityLabel(city)}</option>)}</select></Row>
          <Row label="Earliest Acceptable"><input aria-label="Earliest Acceptable" type="date" {...validationEvents('earliest')} value={draft.earliest} onChange={event => update('earliest', event.target.value)} /></Row>
          <Row label="Latest Acceptable"><input aria-label="Latest Acceptable" type="date" {...validationEvents('latest')} value={draft.latest} onChange={event => update('latest', event.target.value)} /></Row>
        </fieldset>
        <button className={panel.disclosure} type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Advanced {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        {advanced && <fieldset disabled={active || saving} className={panel.advanced}>
          <div className={panel.group}>
            <Toggle label="Test Mode" checked={draft.testMode} change={value => update('testMode', value)} />
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
    <footer className={`${panel.actions}${active ? ` ${local.locked}` : ''}`}><img className={panel.separator} src="assets/footer-line.svg" alt="" /><button type="button" className={panel.secondary} onClick={cancel}>Cancel</button><button type="submit" className={panel.primary} disabled={Boolean(invalid) || active || saving}>{saving ? 'Saving…' : 'Save'}</button></footer>
  </form>;
}
