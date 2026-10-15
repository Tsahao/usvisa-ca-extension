import { describe, expect, it } from 'vitest';
import { CONSULATES, type Consulate, type DatePreferences } from '../src/domain/dates';
import { acceptNotification, initialMonitor, observeSummary, resetBaseline, validateMonitorState } from '../src/domain/monitor';
import { SUMMARY_HEADING } from '../src/domain/summary';

const CITIES = Object.keys(CONSULATES) as Consulate[];
const PREFS: DatePreferences = {
  earliest: '2026-11-01',
  latest: '2026-12-31',
  exclusions: [{ start: '2026-11-10', end: '2026-11-15' }],
  onlyEarlier: false,
};
const NOW = '2026-10-12T00:00:00.000Z';
const LATER = '2026-10-12T00:05:00.000Z';

function reading(dates: Record<string, string | null>, heading = SUMMARY_HEADING) {
  return { heading, rows: CITIES.map(city => ({ city, date: dates[city] ?? null })) };
}

describe('unpaid monitoring', () => {
  it('alerts the initial eligible date and suppresses unchanged repeats', () => {
    let monitor = initialMonitor('scope-1');
    const first = observeSummary(monitor, reading({ Vancouver: '2026-11-19' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: NOW,
    });
    expect(first.alertDue).toBe('2026-11-19');
    monitor = acceptNotification(first.state, '2026-11-19');
    const repeat = observeSummary(monitor, reading({ Vancouver: '2026-11-19' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: LATER,
    });
    expect(repeat.alertDue).toBeNull();
  });

  it('alerts both earlier and later changes', () => {
    let monitor = acceptNotification(
      observeSummary(initialMonitor('scope-1'), reading({ Vancouver: '2026-11-19' }), {
        scopeKey: 'scope-1',
        consulate: 'Vancouver',
        prefs: PREFS,
        rangeOnly: false,
        now: NOW,
      }).state,
      '2026-11-19',
    );
    for (const date of ['2026-11-18', '2026-11-20']) {
      const next = observeSummary(monitor, reading({ Vancouver: date }), {
        scopeKey: 'scope-1',
        consulate: 'Vancouver',
        prefs: PREFS,
        rangeOnly: false,
        now: LATER,
      });
      expect(next.alertDue).toBe(date);
      monitor = acceptNotification(next.state, date);
    }
  });

  it('alerts again when a date reappears after unavailability', () => {
    let monitor = acceptNotification(
      observeSummary(initialMonitor('scope-1'), reading({ Vancouver: '2026-11-19' }), {
        scopeKey: 'scope-1',
        consulate: 'Vancouver',
        prefs: PREFS,
        rangeOnly: false,
        now: NOW,
      }).state,
      '2026-11-19',
    );
    monitor = observeSummary(monitor, reading({ Vancouver: null }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: LATER,
    }).state;
    const back = observeSummary(monitor, reading({ Vancouver: '2026-11-19' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: LATER,
    });
    expect(back.alertDue).toBe('2026-11-19');
  });

  it('records filtered dates without alerting and dues their return', () => {
    let monitor = initialMonitor('scope-1');
    const filtered = observeSummary(monitor, reading({ Vancouver: '2026-11-12' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: true,
      now: NOW,
    });
    expect(filtered.alertDue).toBeNull();
    expect(filtered.state.alert.observed).toBe('2026-11-12');
    monitor = filtered.state;
    const due = observeSummary(monitor, reading({ Vancouver: '2026-11-19' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: true,
      now: LATER,
    });
    expect(due.alertDue).toBe('2026-11-19');
  });

  it('leaves state untouched on malformed readings and scope changes', () => {
    const monitor = observeSummary(initialMonitor('scope-1'), reading({ Vancouver: '2026-11-19' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: NOW,
    }).state;
    const before = JSON.parse(JSON.stringify(monitor));
    expect(() =>
      observeSummary(monitor, reading({}, 'MRV Fee Details'), {
        scopeKey: 'scope-1',
        consulate: 'Vancouver',
        prefs: PREFS,
        rangeOnly: false,
        now: LATER,
      }),
    ).toThrow();
    expect(() =>
      observeSummary(monitor, reading({ Vancouver: '2026-11-20' }), {
        scopeKey: 'scope-2',
        consulate: 'Vancouver',
        prefs: PREFS,
        rangeOnly: false,
        now: LATER,
      }),
    ).toThrow();
    expect(monitor).toEqual(before);
  });

  it('drops obsolete delayed acceptances and restarts fresh on baseline reset', () => {
    let monitor = observeSummary(initialMonitor('scope-1'), reading({ Vancouver: '2026-11-19' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: NOW,
    }).state;
    monitor = observeSummary(monitor, reading({ Vancouver: '2026-11-20' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: LATER,
    }).state;
    // A delayed acceptance for the superseded date changes nothing.
    expect(acceptNotification(monitor, '2026-11-19')).toEqual(monitor);
    // Restart restores every field; the pending alert survives.
    const restarted = JSON.parse(JSON.stringify(monitor));
    expect(observeSummary(restarted, reading({ Vancouver: '2026-11-20' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: LATER,
    }).alertDue).toBe('2026-11-20');
    const reset = resetBaseline(monitor);
    const fresh = observeSummary(reset, reading({ Vancouver: '2026-11-20' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: LATER,
    });
    expect(fresh.alertDue).toBe('2026-11-20');
  });

  it('validates durable monitor shapes before inheriting baselines', () => {
    const monitor = observeSummary(initialMonitor('scope-1'), reading({ Vancouver: '2026-11-19' }), {
      scopeKey: 'scope-1',
      consulate: 'Vancouver',
      prefs: PREFS,
      rangeOnly: false,
      now: NOW,
    }).state;
    expect(validateMonitorState(JSON.parse(JSON.stringify(monitor)))).toEqual(monitor);
    for (const bad of [null, {}, { scopeKey: '', monitor: {} }, { scopeKey: 'scope-1' }, { scopeKey: 'scope-1', monitor: { alert: {} } }])
      expect(() => validateMonitorState(bad)).toThrow();
  });
});
