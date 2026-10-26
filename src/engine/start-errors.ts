import { selectionFailureCode } from '../domain/groups';
import type { FailureCode, FailureContext, FailureStep } from '../domain/failure-context';
export type PanelReadStep = 'state' | 'dashboard' | 'groups' | 'selection' | 'appointment' | 'applicants' | 'save';

const known: Record<string, string> = {
  'Invalid workflow.': 'Invalid workflow.',
  'Save valid configurations before starting.': 'Save valid configurations before starting.',
  'Open one trusted dashboard.': 'More than one visa dashboard is open. Close the extra dashboard tabs, then press Start.',
  'Paid group not found on the dashboard.': 'No eligible paid group was found on this dashboard. Check the Paid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.',
  'Unpaid group not found on the dashboard.': 'No eligible unpaid group was found on this dashboard. Check the Unpaid Visa Group IVR in Settings against the dashboard IVR Account Number and payment status.',
  'Several groups need explicit selection.': 'Several visa groups are on this dashboard. Enter the correct group IVR Account Number in Settings, then press Start.',
  'Unpaid group rejected for paid booking.': 'The selected booking group is not eligible for paid booking. Check both Visa Group IVRs and payment status in Settings.',
  'Paid group rejected for unpaid tracking.': 'The selected alert group is not eligible for date alerts. Check both Visa Group IVRs and payment status in Settings.',
  'Conflicting dashboard payment markers.': 'The dashboard shows conflicting payment information for the selected visa group. Refresh the dashboard; if this repeats, check the payment status on the website.',
  'Selected group is not eligible for this workflow.': 'The selected visa group is not eligible for this workflow. Check the group IVR Account Number and payment status in Settings.',
  'No dashboard group to bind.': 'The extension found no visa groups on this dashboard. Refresh the dashboard; if this repeats, report this message.',
  'Invalid dashboard group.': 'The extension could not read a dashboard group’s schedule or IVR Account Number. Refresh the dashboard; if this repeats, report this message.',
  'Selected dashboard group is incomplete.': 'The extension could not read the selected group’s schedule or IVR Account Number. Refresh the dashboard; if this repeats, report this message.',
  'Ambiguous dashboard groups.': 'The extension found conflicting dashboard group identities. Refresh the dashboard; if this repeats, report this message.',
  'Ambiguous dashboard group.': 'The extension found conflicting dashboard group identities. Refresh the dashboard; if this repeats, report this message.',
  'Unreadable appointment date.': 'The extension could not read the selected group’s appointment date. If the date is visible on the dashboard, report this message.',
  'Authenticated group changed.': 'The signed-in group, appointment or applicant list changed. Check the dashboard and Settings before pressing Start.',
};
const fallback: Record<PanelReadStep, string> = {
  state: 'Unable to read the extension’s saved state. Reopen the extension; if this repeats, report this message.',
  dashboard: 'Unable to inspect the open visa dashboard tabs. Reopen the extension; if this repeats, report this message.',
  groups: 'The extension could not read group identities from this dashboard. Refresh the dashboard; if this repeats, report this message.',
  selection: 'The extension could not match the selected IVR to a dashboard group. Check the IVR in Settings; if it matches, report this message.',
  appointment: 'The extension could not refresh the selected group’s appointment and applicant details. Refresh the dashboard; if this repeats, report this message.',
  applicants: 'The extension could not read the complete applicant list for the selected group. If all applicants are visible, report this message.',
  save: 'Unable to save the new extension run. Reopen the extension; if this repeats, report this message.',
};

export function isPanelCommandErrorMessage(value: unknown): value is string {
  // Accept old saved diagnostics without regenerating their obsolete manual
  // maintenance instructions. Maintenance now stays active and retries quietly.
  return typeof value === 'string' && [...Object.values(known), ...Object.values(fallback),
    'The visa website is under maintenance. Wait for it to recover, then press Start.',
  ].includes(value);
}

export function panelCommandError(error: unknown, step: PanelReadStep): string {
  const message = error instanceof Error ? error.message : '';
  return Object.hasOwn(known, message) ? known[message] : fallback[step];
}

// Error text is compared only to fixed engine sentinels. Arbitrary exception
// messages never become telemetry; fallback identifies the operation instead.
export function startFailureContext(error: unknown, step: PanelReadStep): FailureContext {
  const steps: Record<PanelReadStep, FailureStep> = { state: 'start-state', dashboard: 'start-dashboard',
    groups: 'start-groups', selection: 'start-selection', appointment: 'start-baseline', applicants: 'start-roster', save: 'start-save' };
  const fallbackCodes: Record<PanelReadStep, FailureCode> = { state: 'start-state-read-failed', dashboard: 'start-dashboard-inspection-failed',
    groups: 'start-groups-read-failed', selection: 'start-selection-failed', appointment: 'start-baseline-read-failed',
    applicants: 'start-roster-read-failed', save: 'start-save-failed' };
  const knownCodes: Record<string, FailureCode> = {
    'Save valid configurations before starting.': 'start-configuration-invalid', 'Invalid workflow.': 'start-mode-invalid',
    'Open one trusted dashboard.': 'start-dashboard-ambiguous', 'Dashboard unavailable.': 'start-dashboard-tab-missing',
    'Dashboard context changed.': 'start-context-changed', 'Appointment identity changed.': 'group-identity-changed',
    'Applicant roster changed.': 'applicant-roster-changed', 'Configuration changed.': 'configuration-changed',
  };
  const message = error instanceof Error ? error.message : '';
  const code = selectionFailureCode(message) ?? (Object.hasOwn(knownCodes, message) ? knownCodes[message] : fallbackCodes[step]);
  return { category: 'start-failed', code, step: steps[step] };
}
