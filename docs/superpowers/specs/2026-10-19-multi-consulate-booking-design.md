# Multi-consulate booking

Date: 2026-10-19. Status: draft for builder review.

## Intent

Book mode today watches one consulate. The owner of a paid group who can
travel to several Canadian consulates wants the extension to watch all of
them and reschedule to whichever one first shows a date inside the chosen
window. The motivating case: the user has Toronto selected, Halifax releases
a November slot inside the window, and nothing happens. After this change the
extension books Halifax.

## Goals

- Book mode accepts a set of consulates (one to seven) instead of exactly one.
- Each poll cycle reads availability for every selected consulate.
- Across all selected consulates, the earliest date that the existing booking
  policy accepts (window, earlier-only, exclusions) is the candidate. Ties on
  the same date go to the consulate listed first in the selection order.
- The booking executor fills the form with the candidate's consulate, not a
  preference, and every downstream guard (form read, times fetch, submission
  guard, confirmation intent, verification) agrees on that consulate.
- Existing installs keep working with no re-entry: the saved single consulate
  becomes a one-element selection.
- The panel shows what was found per consulate and which one is being booked.

## Non-goals

- Alerts mode gets no multi-consulate behaviour. It already reads the
  seven-city summary for unpaid groups and notifies on one city. See
  "Alerts mode" below for how it reads the new preference shape.
- No preference ordering among consulates beyond the tie-break. The user asked
  for "earliest wins".
- No change to the warning, applicants or dashboard stages. They are
  consulate-independent.
- No change to the session, retry, cooldown or authentication machinery beyond
  what the cycle definition below requires.

## Anti-goals

- Booking a consulate the user did not select. Every submission guard must
  reject a facility outside the selection, exactly as it rejects a date
  outside the window today.
- Sending more requests per cycle than selected consulates. One `days.json`
  fetch per selected consulate per cycle, nothing speculative.
- Losing the single-consulate behaviour for existing users during migration.

## Constraints from the codebase

- Page adapters (`src/adapter/*.ts`) are serialized into the page by
  `chrome.scripting.executeScript`: no imports, no closures. Any new rule they
  need is inlined.
- `policyKey` (`src/engine/lifecycle.ts`) is the fingerprint that parks a run
  when preferences change mid-run. The consulate selection is part of it.
- `EngineState.lastCandidate` is persisted and validated by
  `validateEngineState` (`src/engine/workflow.ts`). Old saves must still load.
- `ConfirmationIntent.consulate` already exists and is checked during
  verification (`src/engine/verification.ts`) and history
  (`src/engine/history.ts`).
- `PAID_EMPTY_COOLDOWN_AFTER = 4` empty results trigger a 30-minute cooldown
  (`src/domain/timing.ts`, `applyPollResult` in `src/engine/poll.ts`).

## Design

### Preferences

`Preferences.consulate: Consulate | ''` becomes
`Preferences.consulates: Consulate[]` (ordered, no duplicates, 1 to 7).

- Validation (`preferenceIssues`): at least one consulate, all valid names,
  no duplicates.
- Migration: a stored object with a string `consulate` and no `consulates`
  loads as `{ consulates: [consulate] }`. The migration lives in the UI
  storage read (`src/ui/storage.ts`) and in every background `loadPrefs` /
  `readPrefs` path, through one shared helper `selectedConsulates(raw)` in
  `src/domain/dates.ts` that returns the ordered array or `null` when the
  value is unusable. Both shapes are accepted on read; writes always use
  `consulates`.
- `policyKey` replaces the `consulate` entry with the ordered `consulates`
  array (serialized by `JSON.stringify` so order matters). Changing the
  selection mid-run parks the run as a config change, like today.
- UI (`src/ui/PreferenceFields.tsx`): the single consulate select becomes a
  checkbox group over `CITIES` in fixed display order. Selection order for the
  tie-break is the fixed `CITIES` order, not click order; this keeps the key
  stable and the UI simple. The field shows a one-line note when more than two
  are selected: "Each check reads every selected consulate. Consider a longer
  checking interval." Nothing is enforced.

### Candidate

`EngineState.lastCandidate` changes from `string | null` to
`{ date: string; consulate: Consulate } | null`.

- `validateEngineState` accepts the old string form and clears it to `null`
  (the next poll recomputes; an extension update already parks running runs
  because `chrome.storage.session` is cleared, so nothing in flight is
  lost). It rejects an object with an invalid date or a consulate not in
  `CONSULATES`.
- `recordCandidate` takes the object.
- A new pure function in `src/domain/dates.ts`:
  `earliestCandidateAcross(byConsulate: { consulate; dates }[], currentDate, prefs)`
  returns `{ date, consulate } | null`. It applies `canBook` per date, picks the
  minimum date, ties broken by input order. The existing `earliestCandidate`
  stays for Alerts and the panel.

### Polling cycle (background `days.json` loop)

Where the loop currently fetches one `days.json` for `prefs.consulate`, it
iterates the selection in order, calling `fetchDaysJson` once per consulate on
the same owned tab, sequentially, with no delay between them (they are cheap
JSON GETs on an already-authenticated page).

Per-consulate outcomes feed one cycle outcome:

- Any `denied` (401/403): stop the cycle immediately and re-authenticate,
  exactly as today. Later consulates are not fetched.
- All selected consulates failed with a transport error: the cycle is
  `retryable`, handled exactly as a single failed poll is today (no
  observation, no candidate, one failure counted).
- At least one consulate returned 200: the cycle proceeds on the consulates
  that answered. Failed consulates are absent from `byConsulate` (the panel
  shows the empty marker for them) and are not counted as a failure; the
  next cycle reads them again. The cycle is `healthy` if any answering
  consulate returned dates, else `empty`. `applyPollResult` is called once
  per cycle, so the four-empties cooldown now means four cycles in which no
  answering consulate had any date.

Rationale: the motivating case is time-sensitive. A Toronto timeout must not
delay booking a Halifax slot that was read successfully in the same cycle.
This keeps one code path per outcome: a cycle either retries or proceeds,
never both.

The observation record (`engineObservationV1`) gains `byConsulate:
{ consulate, dates }[]` and keeps `dates` as the union, so the panel calendar
and `Earliest Available` still work. `lastPollV1` keeps `status` and
`dayCount` as the union count. `dateHistory.observe` is called once per
consulate with that consulate's earliest date; it is already keyed by
consulate.

The candidate is `earliestCandidateAcross` over the per-consulate results
after removing each consulate's `skippedDates` (see below). Auto Mode OFF
notification text becomes "New date available: {date} ({consulate})".

### Executor (form stage)

`facilityId` comes from `CONSULATES[state.lastCandidate.consulate]`; the
preference is no longer read for it. The `facility` action, `date` action,
`fetchTimesJson`, `submission(...)`, `guardBooking`'s `expected.consulate`
and the `ConfirmationIntent.consulate` all use the candidate's consulate.

`guardBooking` additionally receives the selection and refuses a form whose
facility is not in it. This is the anti-goal guard: even a stale candidate
cannot book an unselected consulate.

`skippedDates` (dates whose times came back empty) become
`{ consulate, date }[]` so a Halifax date with no times does not hide the same
date in Toronto. `validateEngineState` drops old string entries (they only
ever shorten one sweep).

### Verification and history

`verification.ts` compares the confirmed appointment against
`intent.consulate`; no change beyond the candidate now carrying the consulate.

`history.ts` already stores one scope per consulate, but the rows it sends
to the History screen carry no city, so with two or more consulates the
rows would interleave unlabelled. Each stored history entry gains a plain
`consulate` field (a `CONSULATES` key) and `HistoryRow` carries it; the
History screen shows it as a short label on each row. Entries written before
this change have no field and render without a label; no backfill. The
"never carry consulate names" rule applies to diagnostics
(`engineDiagnosticsV1`), not to history, which already holds appointment
dates; the privacy policy text in `README.md` and `docs/privacy-policy.md`
is updated to say history rows name the consulate.

### Alerts mode

Alerts keeps single-city semantics. Everywhere Alerts reads
`prefs.consulate` today (the alerts loop's park check, the unpaid monitor
scope key, `observeSummary`, `dateHistory.observe`, the Alerts panel header
and its "Other consulate dates" list), it uses
`selectedConsulates(prefs)[0]`, the first selected consulate in `CITIES`
order. The shared preference form therefore serves both modes with one
checkbox group; `preferenceIssues` requires at least one consulate for both.
`monitor.ts`, `unpaidMonitorV1` and the alerts scope key shape are unchanged.

### Panel

Book mode's stats block shows:

- `Earliest Available`: the overall earliest observed date and its consulate,
  e.g. "Nov 20, 2026 · Halifax".
- A per-consulate list under the calendar, one row per selected consulate
  with its earliest observed date or the empty marker, in `CITIES` order.
  Unselected consulates are not shown.
- The calendar highlights the union of dates.

`PanelSnapshot` gains `byConsulate` (validated like `dates`). The demo
(`simulated`) path uses `DEMO_DATES` for the selected consulates.

### Analytics and diagnostics

No new events. `poll-empty` and `poll-cooldown-entered` keep their meaning at
cycle level. Diagnostics must never carry consulate names (existing rule).

## Builder's choices

- Exact checkbox group markup and spacing, within the existing panel styles.
- Whether `fetchDaysJson` is injected once per consulate or once with an array
  argument; the latter saves executeScript round-trips but the function must
  stay dependency-free and must not change its per-request behaviour. Either
  is acceptable; one injection per consulate is the simpler default.
- Test fixture shapes.

## Decisions made by Claude, not the user

- Tie-break by fixed `CITIES` order rather than click order.
- A cycle proceeds on the consulates that answered; only an all-failed cycle
  retries.
- Empty-cooldown counting at cycle level.
- Per-consulate `skippedDates`.
- Panel layout for the per-consulate rows.
- Alerts mode uses the first selected consulate rather than its own field.
- History rows gain a consulate label, with the privacy text updated.
- Old string candidates and skipped dates are cleared, not migrated.

## Acceptance

- Unit tests: `earliestCandidateAcross` ordering and tie-break; preference
  migration both shapes; `policyKey` changes when the selection changes;
  `validateEngineState` migrates string candidates and skipped dates; the
  poll cycle outcome table above; executor books the candidate's consulate
  and refuses an unselected facility.
- Existing suite stays green.
- Manual: with Toronto and Halifax selected and a window that only Halifax
  satisfies in the demo data, the panel shows Halifax as the candidate and the
  executor's first form action is `facility` with Halifax's id.
