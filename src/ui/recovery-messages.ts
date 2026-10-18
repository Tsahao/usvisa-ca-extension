import { VERIFICATION_ERRORS } from '../engine/workflow';

// Only actionable recovery guidance belongs in workflow banners. Technical
// command errors stay in worker state/diagnostics, including in older saves
// where they were appended to a recovery message.
const RECOVERY_MESSAGES = [
  'Sign in manually on the official website, then press Start.',
  'Checking the previous booking attempt. No new booking will start during this check.',
  'The previous booking attempt needs checking. Press Start to verify its result first.',
  ...VERIFICATION_ERRORS,
];

export function recoveryMessage(message: string | undefined): string | undefined {
  const guidance = RECOVERY_MESSAGES.filter(value => message?.includes(value)).join(' ');
  return guidance || undefined;
}
