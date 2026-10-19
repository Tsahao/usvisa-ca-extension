# Multi-consulate booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Book and Alerts modes watch a set of Canadian consulates and, in Book mode, reschedule to the earliest eligible date across them.

**Architecture:** The single `consulate` preference becomes an ordered `consulates` array with a migration helper used by every reader. The booking poll loop fetches `days.json` once per selected consulate and reduces the results to one cycle outcome and one `{ date, consulate }` candidate that the executor then books. Alerts keeps one `MonitorState` per selected consulate in the existing storage slot. History rows and the panel gain the consulate.

**Tech Stack:** TypeScript, React 19, Vite 8, Vitest 5 (jsdom for UI tests), Chrome MV3 APIs behind `src/platform.ts`.

**Spec:** `docs/superpowers/specs/2026-10-19-multi-consulate-booking-design.md`

## Global Constraints

- Node 22.12+, Chrome 120+ (`README.md`).
- Page adapters in `src/adapter/*.ts` are serialized by `chrome.scripting.executeScript`: no imports, no closures.
- Diagnostics (`engineDiagnosticsV1`) never carry consulate names, dates, URLs or identifiers.
- Consulate order everywhere is the `CITIES` order from `src/ui/model.ts`: Calgary, Halifax, Montreal, Ottawa, Quebec, Toronto, Vancouver.
- Selection size 1 to 7, no duplicates.
- Cooldown constants unchanged: `PAID_EMPTY_COOLDOWN_AFTER = 4`, `COOLDOWN_S = 1800`.
- Run `npm test`, `npx tsc --noEmit -p tsconfig.json` and `npm run build` before each commit; the full `npm run check` at the end.
- Commit messages end with the attribution lines used on this branch (`git log -1 --format=%B` shows them).

## Review Focus

1. A saved preference object with `consulate: ''` (never configured) must migrate to `consulates: []` and fail validation with "Select at least one consulate", not crash `loadUiState`. Pinned in Task 2.
2. A stored `lastCandidate` string from the previous version must load as `null`, never throw and never book. Pinned in Task 4.
3. A candidate whose consulate is no longer selected (preferences changed between poll and form stage, with policyKey somehow equal) must be refused by `guardBooking`, not booked. Pinned in Task 5.
4. A cycle where every selected consulate times out must count exactly one failure, not one per consulate. Pinned in Task 6.
5. An old `unpaidMonitorV1` slot with the single `monitor` shape must behave like a changed scope: fresh on Start, park otherwise. Pinned in Task 8.

---

### Task 1: Domain helpers for selections and cross-consulate candidates

**Files:**
- Modify: `src/domain/dates.ts`
- Test: `tests/domain.test.ts`

**Interfaces:**
- Produces:
  - `export const CONSULATE_ORDER: readonly Consulate[]` = `['Calgary','Halifax','Montreal','Ottawa','Quebec','Toronto','Vancouver']` (same order as `CITIES`; `CITIES` in `src/ui/model.ts` becomes `[...CONSULATE_ORDER]`).
  - `export function selectedConsulates(raw: unknown): Consulate[] | null` — accepts `{ consulates: string[] }` or legacy `{ consulate: string }`; returns the selection sorted into `CONSULATE_ORDER`, deduplicated; returns `[]` for `consulate: ''` or `consulates: []`; returns `null` when the value is not an object, has neither field, or contains a non-consulate name.
  - `export type ConsulateCandidate = { date: string; consulate: Consulate }`
  - `export function earliestCandidateAcross(byConsulate: { consulate: Consulate; dates: string[] }[], currentDate: string | null, prefs: DatePreferences): ConsulateCandidate | null` — applies `canBook` per date; minimum date wins; ties go to the earlier input position.

- [ ] **Step 1: Write the failing tests** in `tests/domain.test.ts`, new `describe('consulate selections')`:

```ts
it('orders, dedupes and migrates selections', () => {
  expect(selectedConsulates({ consulates: ['Toronto', 'Halifax', 'Toronto'] })).toEqual(['Halifax', 'Toronto']);
  expect(selectedConsulates({ consulate: 'Toronto' })).toEqual(['Toronto']);
  expect(selectedConsulates({ consulate: '' })).toEqual([]);
  expect(selectedConsulates({ consulates: [] })).toEqual([]);
  expect(selectedConsulates({ consulates: ['Paris'] })).toBeNull();
  expect(selectedConsulates({})).toBeNull();
  expect(selectedConsulates(undefined)).toBeNull();
});
it('picks the earliest eligible date across consulates, ties by order', () => {
  const prefs = { earliest: '2026-11-01', latest: '2026-12-31', exclusions: [], onlyEarlier: true };
  expect(earliestCandidateAcross([
    { consulate: 'Toronto', dates: ['2026-12-03', '2027-01-04'] },
    { consulate: 'Halifax', dates: ['2026-11-20'] },
  ], '2028-04-18', prefs)).toEqual({ date: '2026-11-20', consulate: 'Halifax' });
  expect(earliestCandidateAcross([
    { consulate: 'Toronto', dates: ['2026-11-20'] },
    { consulate: 'Halifax', dates: ['2026-11-20'] },
  ], '2028-04-18', prefs)).toEqual({ date: '2026-11-20', consulate: 'Toronto' });
  expect(earliestCandidateAcross([{ consulate: 'Toronto', dates: ['2027-01-04'] }], '2028-04-18', prefs)).toBeNull();
  expect(earliestCandidateAcross([], '2028-04-18', prefs)).toBeNull();
});
```

- [ ] **Step 2: Run** `npx vitest run tests/domain.test.ts` — expected: FAIL, exports not found.
- [ ] **Step 3: Implement** the three exports in `src/domain/dates.ts`; replace the `CITIES` literal in `src/ui/model.ts` with `[...CONSULATE_ORDER]`.
- [ ] **Step 4: Run** `npx vitest run tests/domain.test.ts` — expected: PASS.
- [ ] **Step 5: Commit** `feat: add consulate selection and cross-consulate candidate helpers`.

### Task 2: Preferences model, storage migration, policy key

**Files:**
- Modify: `src/ui/model.ts` (`Preferences`, `EMPTY_PREFERENCES`, `DEMO_PREFERENCES`, `preferenceIssues`)
- Modify: `src/ui/storage.ts:14-26` (`loadUiState`)
- Modify: `src/engine/lifecycle.ts:5-13` (`policyKey`)
- Test: `tests/configuration-validation.test.tsx` (`describe('shared preference validation')`), `tests/ui-restore.test.tsx`, `tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `selectedConsulates`, `CONSULATE_ORDER` (Task 1).
- Produces:
  - `Preferences.consulates: Consulate[]` replaces `Preferences.consulate`. `EMPTY_PREFERENCES.consulates = []`, `DEMO_PREFERENCES.consulates = ['Vancouver']`.
  - `preferenceIssues` emits `{ fields: ['consulates'], message: 'Select at least one consulate.' }` when `selectedConsulates(prefs)` is `null` or empty.
  - `loadUiState` migrates: before the type check, if `raw.consulates` is absent, set `consulates = selectedConsulates(raw) ?? []` and delete `consulate`.
  - `policyKey` key list: `['consulates', 'earliest', 'latest', 'onlyEarlier', 'testMode', 'interval', 'paidIvr', 'unpaidIvr']`, where the `consulates` entry is `selectedConsulates(preferences)` (ordered array or `null`).

- [ ] **Step 1: Write failing tests**

`tests/configuration-validation.test.tsx` (shared preference validation):
```ts
it('requires at least one consulate', () => {
  expect(preferenceIssues({ ...DEMO_PREFERENCES, consulates: [] })).toContainEqual({ fields: ['consulates'], message: 'Select at least one consulate.' });
  expect(preferenceIssues({ ...DEMO_PREFERENCES, consulates: ['Toronto', 'Halifax'] }).some(issue => issue.fields.includes('consulates'))).toBe(false);
});
```
`tests/ui-restore.test.tsx` (use the file's existing chrome storage stub):
```ts
it('migrates a saved single consulate and an unconfigured one', async () => {
  // stored uiPreferencesV1 = { ...DEMO_PREFERENCES minus consulates, consulate: 'Toronto' }
  expect((await loadUiState()).preferences.consulates).toEqual(['Toronto']);
  // stored uiPreferencesV1 = { ...same, consulate: '' }
  expect((await loadUiState()).preferences.consulates).toEqual([]);
});
```
`tests/lifecycle.test.ts`:
```ts
it('keys the policy on the ordered selection', () => {
  const base = { earliest: '2026-11-01', latest: '2026-12-31', onlyEarlier: true, autoMode: true, interval: 60, paidIvr: '', unpaidIvr: '' };
  expect(policyKey({ ...base, consulates: ['Toronto', 'Halifax'] })).toBe(policyKey({ ...base, consulates: ['Halifax', 'Toronto'] }));
  expect(policyKey({ ...base, consulates: ['Toronto'] })).not.toBe(policyKey({ ...base, consulates: ['Toronto', 'Halifax'] }));
  expect(policyKey({ ...base, consulate: 'Toronto' })).toBe(policyKey({ ...base, consulates: ['Toronto'] }));
});
```

- [ ] **Step 2: Run** the three files — expected: FAIL (type errors / missing message).
- [ ] **Step 3: Implement** as in Interfaces. Fix every compile error from the rename across `src/` (`tsc` lists them); in `src/ui/App.tsx` and `src/engine/executor.ts` leave `// TODO(task N)` only where a later task owns the behaviour, otherwise use `preferences.consulates[0]` as a temporary stand-in.
- [ ] **Step 4: Run** `npx tsc --noEmit -p tsconfig.json && npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: store an ordered consulate selection in preferences`.

### Task 3: Consulate checkbox group in the preference form

**Files:**
- Modify: `src/ui/PreferenceFields.tsx:22`
- Modify: `src/ui/panel.module.css` (or the module `PreferenceFields` already imports) for the group layout
- Test: `tests/ui.test.tsx` or `tests/onboarding-ui.test.tsx` (whichever renders `PreferenceFields`)

**Interfaces:**
- Consumes: `Preferences.consulates`, `CITIES`, `cityLabel`.
- Produces: a `fieldset` with `aria-label="Consulates"` containing one checkbox per `CITIES` entry labelled with `cityLabel(city)`; toggling updates `draft.consulates` via `update('consulates', ...)` keeping `CITIES` order; a `<p>` with text exactly `Each check reads every selected consulate. Consider a longer checking interval.` rendered only when `draft.consulates.length > 2`; validation styling from `validationEvents('consulates')` on the fieldset.

- [ ] **Step 1: Write failing test** (Testing Library):
```ts
it('selects consulates with checkboxes in fixed order and warns above two', async () => {
  // render the form with DEMO_PREFERENCES minus consulates
  await user.click(screen.getByRole('checkbox', { name: 'Toronto' }));
  await user.click(screen.getByRole('checkbox', { name: 'Halifax' }));
  expect(latestDraft.consulates).toEqual(['Halifax', 'Toronto']);
  expect(screen.queryByText(/Consider a longer checking interval/)).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'Vancouver' }));
  expect(screen.getByText('Each check reads every selected consulate. Consider a longer checking interval.')).toBeInTheDocument();
});
```
- [ ] **Step 2: Run** — expected: FAIL (no checkbox role).
- [ ] **Step 3: Implement** the fieldset; remove the `<select>`.
- [ ] **Step 4: Run** `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: pick consulates with a checkbox group`.

### Task 4: Engine state carries the candidate's consulate

**Files:**
- Modify: `src/engine/workflow.ts` (`EngineState.lastCandidate`, `ExecutorState.skippedDates`, `validateEngineState:278-295`)
- Modify: `src/engine/poll.ts:96-101` (`recordCandidate`)
- Test: `tests/engine.test.ts`, `tests/poll.test.ts`

**Interfaces:**
- Consumes: `ConsulateCandidate` (Task 1).
- Produces:
  - `EngineState.lastCandidate: ConsulateCandidate | null`.
  - `ExecutorState.skippedDates: { consulate: Consulate; date: string }[]` (unique pairs, max 3660).
  - `validateEngineState`: a string `lastCandidate` becomes `null`; an object with non-ISO `date` or unknown `consulate` throws `'Invalid engine state.'`; string entries in `skippedDates` are dropped; object entries validated as above, else `'Invalid executor state.'`.
  - `recordCandidate(state, candidate: ConsulateCandidate | null, now)`; throws `'Invalid candidate date.'` on a bad date, `'Invalid candidate consulate.'` on a bad consulate.

- [ ] **Step 1: Write failing tests**
```ts
it('clears legacy string candidates and validates consulate candidates', () => {
  expect(validateEngineState({ ...saved, lastCandidate: '2026-11-19' }).lastCandidate).toBeNull();
  expect(validateEngineState({ ...saved, lastCandidate: { date: '2026-11-19', consulate: 'Halifax' } }).lastCandidate).toEqual({ date: '2026-11-19', consulate: 'Halifax' });
  expect(() => validateEngineState({ ...saved, lastCandidate: { date: '2026-11-19', consulate: 'Paris' } })).toThrow('Invalid engine state.');
  expect(validateEngineState({ ...saved, executor: { ...executor, skippedDates: ['2026-11-19', { consulate: 'Toronto', date: '2026-11-20' }] } }).executor!.skippedDates).toEqual([{ consulate: 'Toronto', date: '2026-11-20' }]);
});
it('records consulate candidates only while running', () => {
  expect(recordCandidate(running, { date: '2026-11-19', consulate: 'Halifax' }, NOW).lastCandidate).toEqual({ date: '2026-11-19', consulate: 'Halifax' });
  expect(() => recordCandidate(running, { date: '2026-11-19', consulate: 'Paris' as never }, NOW)).toThrow('Invalid candidate consulate.');
});
```
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement**; update every existing test fixture that sets `lastCandidate` or `skippedDates` to the new shapes (`tests/executor*.test.ts`, `tests/booking-recovery*.test.ts`, `tests/background*.test.ts`); `tsc` lists the rest.
- [ ] **Step 4: Run** `npx tsc --noEmit -p tsconfig.json && npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: carry the consulate on booking candidates and skipped dates`.

### Task 5: Executor books the candidate's consulate

**Files:**
- Modify: `src/engine/executor.ts:50-66` (`Prefs`, `readPrefs`), `:300-310` (`submission`), `:393-440` (form stage), `:419` (skipped dates)
- Modify: `src/domain/booking.ts:14-56` (`BookingExpectation`, `guardBooking`)
- Test: `tests/executor.test.ts`, `tests/booking.test.ts`

**Interfaces:**
- Consumes: `selectedConsulates`, `ConsulateCandidate`, `ExecutorState.skippedDates` (Tasks 1, 4).
- Produces:
  - `Prefs.consulates: Consulate[]` (from `selectedConsulates(raw)`, `null`/empty → `readPrefs` returns `null`).
  - `BookingExpectation.selected: Consulate[]`; `guardBooking` returns `{ allowed: false, reason: 'consulate-unselected' }` when `expected.consulate` is not in `expected.selected` (checked before the facility comparison); `GuardDenial` gains `'consulate-unselected'`.
  - Form stage: `facilityId = CONSULATES[state.lastCandidate.consulate]`; `submission()` and `expected.consulate` use `state.lastCandidate.consulate`; `expected.selected = prefs.consulates`; `ConfirmationIntent.consulate` is the candidate's.
  - Empty times push `{ consulate, date }` onto `skippedDates`.

- [ ] **Step 1: Write failing tests**

`tests/booking.test.ts`:
```ts
it('refuses a consulate outside the selection before comparing the facility', () => {
  expect(guardBooking(form95, { ...expected, consulate: 'Vancouver', selected: ['Toronto'] })).toEqual({ allowed: false, reason: 'consulate-unselected' });
  expect(guardBooking(form95, { ...expected, consulate: 'Vancouver', selected: ['Toronto', 'Vancouver'] })).toEqual({ allowed: true });
});
```
`tests/executor.test.ts` (harness from the file; `PREFS.consulates = ['Toronto', 'Vancouver']`, candidate `{ date: '2026-11-19', consulate: 'Vancouver' }`):
```ts
it('books the candidate consulate, not the first selected one', async () => {
  const h = harness('form'); h.page.facilityId = 94;
  const next = await runBookingStage(h.d, seeded('form'));
  expect(h.mutations[0]).toMatchObject({ action: 'facility', facilityId: 95 });
});
it('skips a date per consulate when its times are empty', async () => {
  // fetchTimesJson mock returns { status: 200, body: { available_times: [] } }
  expect(next.executor!.skippedDates).toEqual([{ consulate: 'Vancouver', date: '2026-11-19' }]);
});
it('parks instead of booking a candidate whose consulate is unselected', async () => {
  // PREFS.consulates = ['Toronto'], candidate Vancouver, page already on 95/date/time
  expect(await runBookingStage(h.d, state)).toMatchObject({ status: 'verifying' });
  expect(h.mutations.filter(m => m.action === 'submit' || m.action === 'confirm')).toEqual([]);
});
```
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: book the candidate's consulate and refuse unselected facilities`.

### Task 6: Booking poll cycle across consulates

**Files:**
- Modify: `src/background.ts:1794` (consulate read), `:1900-1990` (days fetch, outcome, observation, history, candidate), `:2000-2010` (notification text)
- Test: `tests/background.test.ts` (the `fetchDaysJson` cases near lines 1600-1770)

**Interfaces:**
- Consumes: `selectedConsulates`, `earliestCandidateAcross`, `recordCandidate` (Tasks 1, 4, 5).
- Produces:
  - One `fetchDaysJson` injection per selected consulate, in order, on the same reader tab.
  - Cycle outcome: first `denied` → re-authenticate immediately, remaining consulates not fetched; all transport failures → `pollRetry(state, 'transport')` once, nothing written; otherwise proceed with answering consulates.
  - `engineObservationV1 = { runId, mode, checkedAt, dates: union, rows: [], byConsulate: { consulate, dates }[] }` (answering consulates only, in order).
  - `lastPollV1 = { status: 200, dayCount: union.length, at }`.
  - `dateHistory.observe(state, consulate, earliestOfThatConsulate, stamped)` once per answering consulate.
  - Candidate = `earliestCandidateAcross(byConsulate with that consulate's skippedDates removed, currentDate, windowPrefs)`.
  - Auto Mode OFF notification message: `` `New date available: ${date} (${consulate})` ``.
  - A cycle outcome `'empty'` only when no answering consulate had dates; a candidate `null` with any dates is `'healthy'`.

- [ ] **Step 1: Write failing tests** (clone the existing `fetchDaysJson` harness; mock returns keyed by the `args[1]` facility id; `uiPreferencesV1.consulates = ['Halifax', 'Toronto']`):
```ts
it('polls every selected consulate and books the earliest across them', async () => {
  // 90 → [{date:'2026-11-20'}], 94 → [{date:'2026-12-03'}]
  expect(daysCalls.map(call => call[0].args[1])).toEqual([90, 94]);
  expect(stored.engineObservationV1).toMatchObject({ dates: ['2026-11-20', '2026-12-03'], byConsulate: [{ consulate: 'Halifax', dates: ['2026-11-20'] }, { consulate: 'Toronto', dates: ['2026-12-03'] }] });
  expect(stored[ENGINE_KEY].lastCandidate).toEqual({ date: '2026-11-20', consulate: 'Halifax' });
});
it('proceeds on answering consulates when one times out', async () => {
  // 90 → { status: 0 }, 94 → [{date:'2026-12-03'}]
  expect(stored[ENGINE_KEY]).toMatchObject({ consecutiveFailures: 0, lastCandidate: { date: '2026-12-03', consulate: 'Toronto' } });
  expect(stored.engineObservationV1.byConsulate).toEqual([{ consulate: 'Toronto', dates: ['2026-12-03'] }]);
});
it('counts one failure when every consulate fails', async () => {
  // both → { status: 0 }
  expect(stored[ENGINE_KEY].consecutiveFailures).toBe(1);
  expect(stored.engineObservationV1).toBeUndefined();
});
it('stops at the first denied consulate and re-authenticates', async () => {
  // 90 → { status: 401 }
  expect(daysCalls).toHaveLength(1);
  expect(stored[ENGINE_KEY].authentication).toMatchObject({ purpose: 'renew' });
});
it('treats a cycle as empty only when no consulate has dates', async () => {
  // both → []
  expect(stored[ENGINE_KEY].consecutiveFailures).toBe(1); // poll-empty counts toward PAID_EMPTY_COOLDOWN_AFTER
});
```
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement**; keep `parseDaysPayload` per response; collect `{ consulate, status, dates }` then reduce.
- [ ] **Step 4: Run** `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: poll every selected consulate in one booking cycle`.

### Task 7: Panel shows per-consulate availability (Book mode)

**Files:**
- Modify: `src/engine/panel.ts:9-10,50-56` (`PanelSnapshot.byConsulate`)
- Modify: `src/ui/App.tsx:55-80` (Workflow stats block)
- Test: `tests/panel-engine.test.ts`, `tests/ui.test.tsx`

**Interfaces:**
- Consumes: `engineObservationV1.byConsulate` (Task 6), `Preferences.consulates`.
- Produces:
  - `PanelSnapshot.byConsulate: { consulate: Consulate; dates: string[] }[]` (validated: known consulate, ISO dates, unique; invalid → snapshot returned without observation, as `dates` does today).
  - Book stats: `Earliest Available` value is `formatDate(earliest) + ' · ' + cityLabel(consulate)` for the earliest observed date across `byConsulate`, else `NO_VALUE`; below the calendar, a list with `aria-label="Selected consulate dates"`, one row per `preferences.consulates` entry showing its earliest date or `NO_VALUE`.
  - Demo path: `byConsulate` built from `DEMO_DATES` for the selected consulates.

- [ ] **Step 1: Write failing tests**
```ts
// panel-engine.test.ts
it('exposes validated per-consulate observations', () => {
  expect(panelSnapshot(state, { runId, mode: 'booking', checkedAt, dates: ['2026-11-20'], rows: [], byConsulate: [{ consulate: 'Halifax', dates: ['2026-11-20'] }] }, undefined).byConsulate).toEqual([{ consulate: 'Halifax', dates: ['2026-11-20'] }]);
  expect(panelSnapshot(state, { ...same, byConsulate: [{ consulate: 'Paris', dates: [] }] }, undefined).checkedAt).toBeNull();
});
// ui.test.tsx
it('labels the earliest date with its consulate and lists selected consulates', () => {
  expect(screen.getByText('Nov 20, 2026 · Halifax')).toBeInTheDocument();
  const list = screen.getByLabelText('Selected consulate dates');
  expect(within(list).getAllByRole('listitem').map(li => li.textContent)).toEqual(['HalifaxNov 20, 2026', 'TorontoDec 3, 2026']);
});
```
(Use the date format `formatDate` already produces; adjust the literal to it.)
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: show per-consulate dates in the booking panel`.

### Task 8: Alerts monitors every selected consulate

**Files:**
- Modify: `src/domain/monitor.ts` (add `monitorsForScope`)
- Modify: `src/background.ts:557-566` (`prepareAlertScope`), `:1641-1645` (park check), `:1723-1752` (observe + notify + history), `:1357-1385` (probe response)
- Test: `tests/monitor-scope.test.ts`, `tests/monitor.test.ts`, `tests/background.test.ts` (alerts cases)

**Interfaces:**
- Consumes: `selectedConsulates` (Task 1); existing `observeSummary`, `acceptNotification`, `initialMonitor`, `validateMonitorState`.
- Produces:
  - `export type MonitorSlot = { scopeKey: string; monitors: Partial<Record<Consulate, MonitorState>> }`
  - `export function monitorsForScope(saved: unknown, scopeKey: string, consulates: Consulate[], freshStart = false): Partial<Record<Consulate, MonitorState>>` — `undefined` → fresh monitors (`initialMonitor(`${scopeKey}:${consulate}`)` each); a slot whose `scopeKey` matches returns its monitors, creating missing ones fresh; a slot with a different `scopeKey`, or the legacy `{ scopeKey, monitor }` shape, throws `'Monitor scope changed.'` unless `freshStart`, in which case fresh monitors; malformed → `'Invalid monitor slot.'`.
  - Alerts scope key: `` `alerts:${scheduleId}:${consulates.join(',')}:any:${earliest}:${latest}` ``.
  - Per cycle, for each selected consulate in order: `observeSummary(monitors[c], reading, { scopeKey: `${scopeKey}:${c}`, consulate: c, prefs, rangeOnly: false, now })`; `dateHistory.observe(state, c, rowDate, stamped)`; if `alertDue`, `notifications.create` with message `` `New date available: ${alertDue} (${c})` `` then `acceptNotification`. Save the slot once after the loop (and again after each accepted notification, as today).
  - Probe response fields read `monitors[consulates[0]]`.

- [ ] **Step 1: Write failing tests**
```ts
// monitor-scope.test.ts
it('keeps one monitor per consulate under one scope and rejects the legacy slot', () => {
  const fresh = monitorsForScope(undefined, 'k', ['Halifax', 'Toronto']);
  expect(Object.keys(fresh)).toEqual(['Halifax', 'Toronto']);
  expect(fresh.Halifax!.scopeKey).toBe('k:Halifax');
  expect(() => monitorsForScope({ scopeKey: 'k', monitor: initialMonitor('k') }, 'k', ['Halifax'])).toThrow('Monitor scope changed.');
  expect(monitorsForScope({ scopeKey: 'k', monitor: initialMonitor('k') }, 'k', ['Halifax'], true).Halifax!.scopeKey).toBe('k:Halifax');
  expect(() => monitorsForScope({ scopeKey: 'other', monitors: {} }, 'k', ['Halifax'])).toThrow('Monitor scope changed.');
});
// background.test.ts (alerts harness; summary rows Halifax 2026-11-20 → 2026-11-18, Toronto unchanged)
it('notifies per consulate whose summary date changed', async () => {
  expect(notificationsCreate.mock.calls.map(call => call[0].message)).toEqual(['New date available: 2026-11-18 (Halifax)']);
  expect(stored.unpaidMonitorV1.monitors.Halifax.alert.delivered).toBe('2026-11-18');
  expect(stored.unpaidMonitorV1.monitors.Toronto.alert.delivered).toBeNull();
});
```
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: monitor every selected consulate in Alerts`.

### Task 9: Alerts panel lists selected and other consulates

**Files:**
- Modify: `src/ui/App.tsx:79-80`
- Test: `tests/ui.test.tsx`

**Interfaces:**
- Consumes: `PanelSnapshot.rows`, `Preferences.consulates`.
- Produces: Alerts stats header `Selected consulates`; value = earliest date among selected rows formatted as `formatDate(date) + ' · ' + cityLabel(consulate)` or `NO_VALUE`; a list `aria-label="Selected consulate dates"` with one row per selected consulate; the existing `aria-label="Other consulate dates"` list shows `CITIES` minus the selection.

- [ ] **Step 1: Write failing test**
```ts
it('splits alerts rows into selected and other consulates', () => {
  // preferences.consulates = ['Halifax', 'Toronto'], mode alerts, rows from DEMO_DATES
  expect(within(screen.getByLabelText('Selected consulate dates')).getAllByRole('listitem')).toHaveLength(2);
  expect(within(screen.getByLabelText('Other consulate dates')).getAllByRole('listitem')).toHaveLength(5);
  expect(screen.getByText('Nov 26, 2026 · Toronto')).toBeInTheDocument(); // DEMO_DATES: Toronto 2026-11-26 < Halifax 2027-01-22
});
```
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: show selected consulates in the alerts panel`.

### Task 10: History rows name their consulate

**Files:**
- Modify: `src/domain/history.ts:8-9,21-32,53-66` (`HistoryRow.consulate`, validation, `observeHistory`)
- Modify: `src/engine/history.ts:49-56` (`observe` passes consulate), `historyRows`
- Modify: `src/ui/History.tsx:48-52` (column)
- Modify: `README.md` (Privacy), `docs/privacy-policy.md`
- Test: `tests/history.test.ts`, `tests/history-ui.test.tsx`

**Interfaces:**
- Produces:
  - `HistoryRow.consulate?: Consulate` (absent on entries written before this change); `validateHistory` accepts absent or a `CONSULATES` key, rejects anything else.
  - `observeHistory(history, reading: { scope; earliestDate; checkedAt; consulate: Consulate }, now)` stores it.
  - History table gains a `Consulate` column between `Checked` and `Earliest Date`; missing value renders `NO_VALUE`.
  - Privacy text: add one sentence to both files: "Date history rows record which consulate each date was seen at."

- [ ] **Step 1: Write failing tests**
```ts
// history.test.ts
it('stores and validates the consulate on history rows', () => {
  const next = observeHistory(emptyHistory(), { scope, earliestDate: '2026-11-20', checkedAt: NOW, consulate: 'Halifax' }, NOW);
  expect(next.entries[0].consulate).toBe('Halifax');
  expect(validateHistory({ ...next, entries: [{ ...next.entries[0], consulate: undefined }] }).entries[0].consulate).toBeUndefined();
  expect(() => validateHistory({ ...next, entries: [{ ...next.entries[0], consulate: 'Paris' }] })).toThrow();
});
// history-ui.test.tsx
it('shows the consulate column', () => {
  expect(screen.getByRole('columnheader', { name: 'Consulate' })).toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'Halifax' })).toBeInTheDocument();
});
```
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement**, including the two privacy sentences.
- [ ] **Step 4: Run** `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat: label date history rows with their consulate`.

### Task 11: Documentation and full check

**Files:**
- Modify: `README.md` (Features: Book watches a set of consulates; Alerts notifies per selected consulate; the interval note)
- Modify: `public/manifest.json` and `package.json` version `0.2.4` → `0.3.0`

- [ ] **Step 1:** Update the README feature bullets and bump the version.
- [ ] **Step 2: Run** `npm run check` — expected: all green (unit tests, packaging tests, build, release smoke).
- [ ] **Step 3:** Load `dist/` unpacked, select Toronto and Halifax, Start; confirm the panel lists both consulates and `Last Checked` fills; confirm the diagnostics log contains no consulate names (`grep -c Halifax` on the storage dump is 0 outside `dateHistoryV1`).
- [ ] **Step 4: Commit** `docs: describe multi-consulate booking and alerts; bump to 0.3.0`.
