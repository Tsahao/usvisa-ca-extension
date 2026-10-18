import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { preferenceIssues, type Preferences } from './model';
import { PreferenceFields } from './PreferenceFields';
import panel from './Panel.module.css';
import styles from './HomeScreen.module.css';

export function HomeScreen({ preferences, signIn, openTerms, active = false }: {
  preferences: Preferences;
  signIn: (value: Preferences) => Promise<void>;
  openTerms: () => void;
  active?: boolean;
}) {
  const [draft, setDraft] = useState(() => structuredClone(preferences));
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<Partial<Record<keyof Preferences, boolean>>>({});
  const [focused, setFocused] = useState<keyof Preferences | null>(null);
  useEffect(() => { setDraft(structuredClone(preferences)); setCompleted({}); setFocused(null); setError(''); }, [preferences]);
  const issues = preferenceIssues(draft);
  const invalid = !draft.email.trim() || issues.length > 0;
  const visibleIssue = issues.find(issue => issue.fields.every(field => completed[field] && focused !== field));
  const validationEvents = (field: keyof Preferences) => ({
    onFocus: () => setFocused(field),
    onBlur: () => { setFocused(null); setCompleted(current => ({ ...current, [field]: true })); },
  });
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setDraft(current => ({ ...current, [key]: value }));
  const submit = async () => {
    if (invalid || active || submitting.current) return;
    submitting.current = true; setSaving(true); setError('');
    try { await signIn({ ...draft, email: draft.email.trim() }); }
    catch { setError('Unable to save preferences. Please try again.'); }
    finally { submitting.current = false; setSaving(false); }
  };
  return <form className={styles.root} noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
    <header className={styles.brand}>
      <div className={styles.logo} aria-hidden>
        <img className={styles.logoArtwork} src="assets/welcome-logo.png" width={70.5} height={70.5} alt="" />
      </div>
      <h2 className={styles.title}>US Visa Scheduler</h2>
      <p className={styles.subtitle}>for consulates in Canada</p>
    </header>
    <fieldset disabled={saving || active} className={`${panel.group} ${styles.fields}`}>
      <PreferenceFields draft={draft} update={update} validationEvents={validationEvents} autoLabel="Auto Book" />
    </fieldset>
    {(error || visibleIssue) && <p className={`${panel.validation} ${styles.validation}`} role="alert">{error || visibleIssue?.message}</p>}
    <div className={styles.footer}>
      <button type="submit" aria-label="Sign in" className={styles.signIn} disabled={invalid || saving || active}><ArrowRight size={28} aria-hidden /></button>
      <a href="#terms" className={styles.termsLink} onClick={event => { event.preventDefault(); openTerms(); }}>Terms & Conditions</a>
    </div>
  </form>;
}
