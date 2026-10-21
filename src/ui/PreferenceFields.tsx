import type { ReactNode } from 'react';
import type { Preferences } from './model';
import { ConsulateSelect } from './ConsulateSelect';
import { Toggle } from './Toggle';
import panel from './Panel.module.css';

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return <label className={panel.row}><span>{label}</span>{children}</label>;
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
    <ConsulateSelect value={draft.consulates} change={value => update('consulates', value)} {...validationEvents('consulates')} />
    <Row label="Earliest Acceptable"><input aria-label="Earliest Acceptable" type="date" {...validationEvents('earliest')} value={draft.earliest} onChange={event => update('earliest', event.target.value)} /></Row>
    <Row label="Latest Acceptable"><input aria-label="Latest Acceptable" type="date" {...validationEvents('latest')} value={draft.latest} onChange={event => update('latest', event.target.value)} /></Row>
    <Toggle label={autoLabel} checked={draft.autoMode} change={value => update('autoMode', value)} />
  </>;
}
