import { describe, expect, it } from 'vitest';
import { VERIFICATION_ERRORS } from '../src/engine/workflow';
import { recoveryMessage } from '../src/ui/recovery-messages';
import { panelCommandError, type PanelReadStep } from '../src/engine/start-errors';

describe('workflow banner boundary', () => {
  it.each(VERIFICATION_ERRORS)('preserves actionable guidance: %s', message => {
    expect(recoveryMessage(message)).toBe(message);
    expect(recoveryMessage(`${message} ${panelCommandError(new Error('Authenticated group changed.'), 'groups')}`)).toBe(message);
  });

  it.each(['state', 'dashboard', 'groups', 'selection', 'appointment', 'applicants', 'save'] as PanelReadStep[])(
    'hides technical fallback text for %s', step => {
      expect(recoveryMessage(panelCommandError(new Error('unknown'), step))).toBeUndefined();
    });

  it('hides missing, unknown and obsolete maintenance messages', () => {
    for (const message of [undefined, '', 'private-worker-error',
      'The visa website is under maintenance. Wait for it to recover, then press Start.']) {
      expect(recoveryMessage(message)).toBeUndefined();
    }
  });
});
