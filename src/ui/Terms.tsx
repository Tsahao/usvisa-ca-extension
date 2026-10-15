import type { UIEvent } from 'react';
import panel from './Panel.module.css';
import local from './Terms.module.css';

export function Terms({ trackScroll, testMode }: { trackScroll: (event: UIEvent<HTMLElement>) => void; testMode?: boolean }) {
  return <article className={`${panel.terms} ${local.terms}`} onScroll={trackScroll}>
    <h2>Terms & conditions</h2>
    <h3>Independent tool</h3><p>US Visa Scheduler for Canada is an independent tool and is not affiliated with the U.S. government or the official visa scheduling provider.</p>
    <h3>Use at your own risk</h3><p>Automatic booking can change an existing appointment. Errors or unexpected behavior may result in an unintended rescheduling, and your previous appointment may no longer be available.</p>
    <h3>Your responsibility</h3><p>Use only accounts you are authorized to manage. Review your settings before starting and verify every attempted booking or change on the official scheduling website.</p>
    <h3>No guarantees and limited liability</h3><p>The software is provided “as is,” without guarantees of availability, accuracy, successful booking, or continued support. To the extent permitted by applicable law, the developer is not liable for losses arising from its use, including unintended appointment changes. This does not exclude liability that cannot lawfully be excluded or limit your non-waivable rights.</p>
    <h3>Usage data</h3><p>Your appointment-site login details are stored locally on your device and used by the extension to access the appointment website. We use PostHog with random identifiers to count installations, workflow sessions, failures and date-alert activations. Login details, visa identifiers, appointment dates and page contents are never sent to PostHog.</p>
    <div className={local.spacer} style={testMode ? { height: 40 } : undefined} aria-hidden="true" />
  </article>;
}
