import { describe, expect, it } from 'vitest';
import { CONSULATE_ORDER } from '../src/domain/dates';
import { policyKey } from '../src/engine/lifecycle';
import { DEFAULT_ADVANCED, DEMO_PREFERENCES, intervalBaseline, updatePreference, withMinimumInterval, type Preferences } from '../src/ui/model';

const select = (prefs: Preferences, count: number) => updatePreference(prefs, 'consulates', CONSULATE_ORDER.slice(0, count));

describe('reversible interval minimums', () => {
  it.each([30, 60, 75, 120, 300])('restores the chosen %s-second interval over repeated selection changes', interval => {
    let prefs: Preferences = { ...DEMO_PREFERENCES, interval };
    for (const count of [2, 5, 7, 4, 6, 3, 2, 1]) {
      prefs = select(prefs, count);
      expect(prefs.interval).toBe(Math.max(interval, count * 30));
      expect(intervalBaseline(prefs)).toBe(interval);
      if (prefs.interval === interval) expect(prefs).not.toHaveProperty('intervalBeforeAutoIncrease');
      else expect(prefs.intervalBeforeAutoIncrease).toBe(interval);
    }
  });

  it('keeps a manual override on decreases but reverses later automatic increases back to that override', () => {
    let prefs = select(DEMO_PREFERENCES, 3);
    expect(prefs.interval).toBe(90);
    prefs = updatePreference(prefs, 'interval', 120);
    expect(prefs).not.toHaveProperty('intervalBeforeAutoIncrease');
    prefs = select(prefs, 2);
    expect(prefs.interval).toBe(120);
    prefs = select(prefs, 7);
    expect(prefs).toMatchObject({ interval: 210, intervalBeforeAutoIncrease: 120 });
    prefs = select(prefs, 5);
    expect(prefs).toMatchObject({ interval: 150, intervalBeforeAutoIncrease: 120 });
    prefs = select(prefs, 1);
    expect(prefs.interval).toBe(120);
    expect(prefs).not.toHaveProperty('intervalBeforeAutoIncrease');
  });

  it('treats an explicit write of the same auto-raised number as a manual override', () => {
    const raised = select(DEMO_PREFERENCES, 3);
    const manual = updatePreference(raised, 'interval', 90);
    expect(select(manual, 1).interval).toBe(90);
  });

  it('preserves memory through unrelated edits and serialization without mutating the original', () => {
    const raised = select(DEMO_PREFERENCES, 7);
    const edited = updatePreference(raised, 'email', 'other@example.invalid');
    const reopened = withMinimumInterval(JSON.parse(JSON.stringify(edited)));
    expect(select(reopened, 1)).toMatchObject({ interval: 60, email: 'other@example.invalid' });
    expect(raised).toMatchObject({ interval: 210, intervalBeforeAutoIncrease: 60 });
    expect(DEMO_PREFERENCES.interval).toBe(60);
  });

  it('does not infer rollback history for legacy saves without metadata', () => {
    const saved = { ...DEMO_PREFERENCES, consulates: [...CONSULATE_ORDER], interval: 210 };
    expect(select(saved, 1).interval).toBe(210);
  });

  it.each([undefined, null, '60', NaN, Infinity, -1, 29, 30.5, 211, 86401])('ignores malformed or stale rollback metadata %s', remembered => {
    const saved = { ...DEMO_PREFERENCES, interval: 210, intervalBeforeAutoIncrease: remembered } as Preferences;
    expect(intervalBaseline(saved)).toBe(210);
    expect(select(saved, 1).interval).toBe(210);
  });

  it('keeps invalid manual input visible for validation rather than silently undoing it', () => {
    const raised = select(DEMO_PREFERENCES, 3);
    expect(updatePreference(raised, 'interval', 89).interval).toBe(89);
    expect(updatePreference(raised, 'interval', 89)).not.toHaveProperty('intervalBeforeAutoIncrease');
  });

  it('starts new rollback memory at the default when Advanced is reset', () => {
    const manual = updatePreference(select(DEMO_PREFERENCES, 3), 'interval', 120);
    const reset = withMinimumInterval({ ...manual, ...DEFAULT_ADVANCED, intervalBeforeAutoIncrease: undefined });
    expect(reset).toMatchObject({ interval: 90, intervalBeforeAutoIncrease: 60 });
    expect(select(reset, 1).interval).toBe(60);
  });

  it('does not change the worker policy when only UI rollback memory changes', () => {
    const prefs = select(DEMO_PREFERENCES, 3);
    expect(policyKey(prefs)).toBe(policyKey({ ...prefs, intervalBeforeAutoIncrease: undefined }));
  });
});
