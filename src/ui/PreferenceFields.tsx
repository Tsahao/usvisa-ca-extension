import type { ReactNode } from 'react';
import { CITIES, cityLabel, type Preferences } from './model';
import panel from './Panel.module.css';

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return <label className={panel.row}><span>{label}</span>{children}</label>;
}

export function Toggle({ label, checked, change }: { label: string; checked: boolean; change: (value: boolean) => void }) {
  return <Row label={label}><input className={panel.toggle} type="checkbox" role="switch" aria-label={label} checked={checked} onChange={event => change(event.target.checked)} /></Row>;
}

export function PreferenceFields({ draft, update, validationEvents, autoLabel = 'Auto Mode' }: {
  draft: Preferences;
  update: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  validationEvents: (field: keyof Preferences) => { onFocus: () => void; onBlur: () => void };
  autoLabel?: string;
}) {
  return <>
    <Row label="Email"><input aria-label="Email" type="email" autoComplete="off" value={draft.email} onChange={event => update('email', event.target.value)} /></Row>
    <Row label="Password"><input aria-label="Password" type="password" autoComplete="off" {...validationEvents('password')} value={draft.password} onChange={event => update('password', event.target.value)} /></Row>
    <Row label="Consulate"><select aria-label="Consulate" {...validationEvents('consulate')} value={draft.consulate} onChange={event => update('consulate', event.target.value as Preferences['consulate'])}><option value="">Select Consulate</option>{CITIES.map(city => <option key={city} value={city}>{cityLabel(city)}</option>)}</select></Row>
    <Row label="Earliest Acceptable"><input aria-label="Earliest Acceptable" type="date" {...validationEvents('earliest')} value={draft.earliest} onChange={event => update('earliest', event.target.value)} /></Row>
    <Row label="Latest Acceptable"><input aria-label="Latest Acceptable" type="date" {...validationEvents('latest')} value={draft.latest} onChange={event => update('latest', event.target.value)} /></Row>
    <Toggle label={autoLabel} checked={draft.autoMode} change={value => update('autoMode', value)} />
  </>;
}
