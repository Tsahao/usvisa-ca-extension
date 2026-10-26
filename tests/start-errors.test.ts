import { describe, expect, it } from 'vitest';
import { isPanelCommandErrorMessage, panelCommandError, type PanelReadStep } from '../src/engine/start-errors';
import { isPanelFailureKind, panelFailureKind } from '../src/engine/panel-errors';
import { validateGroupBinding } from '../src/domain/groups';

describe('safe Start diagnostics and dashboard custody', () => {
  it.each(['state', 'dashboard', 'groups', 'selection', 'appointment', 'applicants', 'save'] as PanelReadStep[])('reports the failing %s step without echoing private exception text', step => {
    const result = panelCommandError(new Error('synthetic-secret https://example.invalid/private'), step);
    expect(result).not.toContain('synthetic-secret');
    expect(result).not.toContain('https://');
    expect(result).not.toContain('signed-in');
  });
  it('distinguishes multiple tabs, missing configured IVR and incomplete group discovery', () => {
    expect(panelCommandError(new Error('Open one trusted dashboard.'), 'dashboard')).toContain('Close the extra dashboard tabs');
    expect(panelCommandError(new Error('Paid group not found on the dashboard.'), 'selection')).toContain('No eligible paid group');
    expect(panelCommandError(new Error('Invalid dashboard group.'), 'selection')).toContain('schedule or IVR Account Number');
    expect(panelCommandError(new Error('Selected dashboard group is incomplete.'), 'selection')).toContain('selected group’s schedule or IVR');
  });
  it('accepts legacy saved maintenance diagnostics without generating manual retry instructions', () => {
    expect(isPanelCommandErrorMessage('The visa website is under maintenance. Wait for it to recover, then press Start.')).toBe(true);
    expect(panelCommandError(new Error('Site under maintenance.'), 'groups')).not.toContain('press Start');
  });
  it('treats object prototype names as unknown errors', () => {
    for (const message of ['constructor', '__proto__', 'toString'])
      expect(panelCommandError(new Error(message), 'appointment')).toContain('could not refresh');
  });
  it('preserves a canonical dashboard route and accepts legacy bindings without one', () => {
    const binding = { scheduleId: '11111111', ivr: '22222222', kind: 'paid', currentDate: '2027-01-01' };
    expect(validateGroupBinding(binding).dashboardPath).toBeUndefined();
    expect(validateGroupBinding({ ...binding, dashboardPath: '/en-ca/niv/groups/55555555' }).dashboardPath).toBe('/en-ca/niv/groups/55555555');
    for (const dashboardPath of ['https://example.invalid/en-ca/niv/groups', '/en-ca/niv/groups/55555555?other=1', '/en-ca/niv/schedule/11111111/appointment'])
      expect(() => validateGroupBinding({ ...binding, dashboardPath })).toThrow('Invalid dashboard path.');
  });
});

describe('panel failure classification', () => {
  it('validates only the three known failure kinds', () => {
    expect(isPanelFailureKind('generic')).toBe(true);
    expect(isPanelFailureKind('paid-ivr-not-found')).toBe(true);
    expect(isPanelFailureKind('unpaid-ivr-not-found')).toBe(true);
    for (const value of [undefined, null, 0, '', 'paid', 'Paid group not found on the dashboard.', 'GENERIC'])
      expect(isPanelFailureKind(value)).toBe(false);
  });
  it('classifies only the exact known IVR domain errors as specific kinds', () => {
    expect(panelFailureKind(new Error('Paid group not found on the dashboard.'))).toBe('paid-ivr-not-found');
    expect(panelFailureKind(new Error('Unpaid group not found on the dashboard.'))).toBe('unpaid-ivr-not-found');
    expect(panelFailureKind(new Error('Unpaid group rejected for paid booking.'))).toBe('paid-ivr-not-found');
    expect(panelFailureKind(new Error('Paid group rejected for unpaid tracking.'))).toBe('unpaid-ivr-not-found');
    for (const message of ['Authenticated group changed.', 'Ambiguous dashboard group.', 'Ambiguous dashboard groups.',
      'Invalid dashboard group.', 'Unreadable appointment date.', 'No dashboard group to bind.', 'Site under maintenance.',
      'No eligible unpaid group on the dashboard.', 'No eligible paid group on the dashboard.',
      'Paid group not found on the dashboard. ', 'paid group not found on the dashboard.', 'Paid group not found',
      'synthetic-secret', '', 'constructor'])
      expect(panelFailureKind(new Error(message))).toBe('generic');
  });
  it('classifies the exact fixed safe diagnostics the same way, without echoing identifiers', () => {
    const paidSafe = panelCommandError(new Error('Paid group not found on the dashboard.'), 'selection');
    const unpaidSafe = panelCommandError(new Error('Unpaid group not found on the dashboard.'), 'selection');
    const paidRejectedSafe = panelCommandError(new Error('Unpaid group rejected for paid booking.'), 'selection');
    const unpaidRejectedSafe = panelCommandError(new Error('Paid group rejected for unpaid tracking.'), 'selection');
    expect(panelFailureKind(paidSafe)).toBe('paid-ivr-not-found');
    expect(panelFailureKind(unpaidSafe)).toBe('unpaid-ivr-not-found');
    expect(panelFailureKind(paidRejectedSafe)).toBe('paid-ivr-not-found');
    expect(panelFailureKind(unpaidRejectedSafe)).toBe('unpaid-ivr-not-found');
    expect(paidSafe).not.toMatch(/[0-9]{8}/);
    expect(unpaidSafe).not.toMatch(/[0-9]{8}/);
    expect(paidRejectedSafe).not.toMatch(/[0-9]{8}/);
    expect(unpaidRejectedSafe).not.toMatch(/[0-9]{8}/);
    // Fallback diagnostics and non-errors stay generic.
    expect(panelFailureKind(panelCommandError(new Error('synthetic-secret'), 'selection'))).toBe('generic');
    for (const value of [undefined, null, 0, {}, ['Paid group not found on the dashboard.']])
      expect(panelFailureKind(value)).toBe('generic');
  });
});

describe('safe Start failure source context', () => {
  it('preserves exact selection causes and labels unclassified exceptions by their read step', async () => {
    const { startFailureContext } = await import('../src/engine/start-errors');
    expect(startFailureContext(new Error('Paid group not found on the dashboard.'), 'selection')).toEqual({
      category: 'start-failed', code: 'paid-group-not-found', step: 'start-selection' });
    expect(startFailureContext(new Error('private@example.invalid password <html>'), 'appointment')).toEqual({
      category: 'start-failed', code: 'start-baseline-read-failed', step: 'start-baseline' });
  });
});
