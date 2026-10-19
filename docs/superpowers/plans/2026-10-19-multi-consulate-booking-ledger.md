# SDD ledger — plan: docs/superpowers/plans/2026-10-19-multi-consulate-booking.md

Spec: docs/superpowers/specs/2026-10-19-multi-consulate-booking-design.md
Branch: fix/sole-applicant-acknowledged-query (feature branch; merge base main = 269fafe)
Workspace ruling: Ruling: implement in the existing checkout on the feature branch instead of a new worktree — the clone is already isolated from the user's other work, a worktree would need a second `npm ci`, and the user's Chrome loads `dist/` from this checkout for manual verification — costs nothing if wrong beyond a dirty tree the branch already owns.
Todo ruling: Ruling: this ledger is the task tracker; no separate todo list — costs nothing if wrong.

## Preflight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 → T2,T5,T6,T8 | `selectedConsulates(raw): Consulate[] \| null`; T2 policyKey, T5 readPrefs, T6/T8 loops all call it with the raw prefs object | consistent |
| T1 → T4,T5,T6 | `ConsulateCandidate {date, consulate}`; T4 `lastCandidate`, T5 executor reads `.consulate`, T6 `earliestCandidateAcross` returns it | consistent |
| T1 → T3 | `CITIES = [...CONSULATE_ORDER]` in model.ts; T3 iterates `CITIES` | consistent |
| T2 → T3 | `Preferences.consulates`, `validationEvents('consulates')` | consistent; T2 step 3 leaves `consulates[0]` stand-ins that T5/T7/T9 replace — acceptable interim |
| T2 → T5,T6,T8 | `policyKey` keys `consulates` array | `prepareAlertScope` compares policyKey; T8 scope key uses the same ordered array | consistent |
| T4 → T5 | `skippedDates: {consulate,date}[]`; T5 pushes pairs; T6 filters per consulate | consistent |
| T4 → T6 | `recordCandidate(state, ConsulateCandidate\|null, now)` | consistent |
| T5 → T6 | T6 sets stage after candidate (existing code) — unchanged | consistent |
| T6 → T7 | `engineObservationV1.byConsulate` validated by `panelSnapshot` | consistent |
| T8 → T9 | T9 only reads `rows` + `preferences.consulates` | consistent |
| T10 → T6,T8 | `observe(state, consulate, date, checkedAt)` signature unchanged; T10 passes consulate into `observeHistory` reading internally | consistent |
| T7 ui test | literal `'Nov 20, 2026 · Halifax'` depends on `formatDate` output; plan says adjust | self-consistent with caveat |
| T9 ui test | DEMO_DATES Toronto 2026-11-26 < Halifax 2027-01-22, header value expects Toronto | consistent |
| T11 | version bump to 0.3.0 in manifest + package.json; `test:packaging` may assert version parity | implementer must run `npm run check` |
| Global | reviewer rubric vs plan: no asserted-nothing tests, no mandated duplication; adapter inlining is pre-existing rule | clean |

No conflicts requiring rulings beyond the two above.

## Model plan
Implementers: sonnet (T1–T4, T7, T9, T10, T11), opus (T5, T6, T8 — multi-file booking/polling/alerts integration). Reviewers: sonnet for T1–T4, T7, T9–T11; opus for T5, T6, T8. Final review: opus.

## Progress
- Task 1: dispatched (base 077f619, implementer sonnet)
- Task 1: minor (deferred): CONSULATE_ORDER duplicates CONSULATES keys with no parity test; non-array `consulates` falls through to legacy field; CITIES==CONSULATE_ORDER untested.
- Task 1: complete (commits 077f619..6bc92c9, review clean)
- Task 2: dispatched (base 6bc92c9, implementer sonnet)
- Task 2: minor (deferred): readPrefs dropped explicit CONSULATES check (covered via selectedConsulates); background still uses `in CONSULATES` — inconsistent; legacy `consulate:` fixtures dominate tests (later tasks convert); migration test lacks already-`consulates` case.
- Task 2: complete (commits 6bc92c9..294d44c, review clean)
- Task 3: dispatched (base 294d44c, implementer sonnet)
- Task 3: minor (deferred): fieldset validationEvents may flash the alert when tabbing between checkboxes (no relatedTarget guard, untested); replacement validation-timing test narrower than removed row; aria-label+aria-hidden span instead of <legend>.
- Task 3: complete (commits 294d44c..15ac643, review clean)
- Task 4: dispatched (base 15ac643, implementer sonnet)
- Task 4: minor (deferred): probe response now returns the candidate object incl. consulate (developer probe, not diagnostics); no-op `else if typeof string` branch in validateEngineState; skippedDates validation casts before checking; no tests for null/non-object skipped entries or >3660.
- Task 4: complete (commits 15ac643..2ca31a3, review clean)
- Task 5: dispatched (base 2ca31a3, implementer opus)
- Task 5: implementer DONE_WITH_CONCERNS (f92b30b, trailer amended to 7245204 for session attribution); concerns: pre-guard field filling for unselected candidate (parks, never submits); brief's test strengthened
- Task 5: minor (deferred): form fields filled before guardBooking refuses an unselected candidate (never submits; cheap `prefs.consulates.includes` check at executor.ts:394 would close it); confirm stage does not re-check selection; redundant assertion executor.test.ts:508; `in CONSULATES` vs Object.hasOwn style mismatch in booking.ts:51-52.
- Task 5: complete (commits 2ca31a3..7245204, review clean)
- Task 6: dispatched (base 7245204, implementer opus)
- Task 6: implementer DONE_WITH_CONCERNS (6de920f); concerns: all-304 cycle keeps old not-modified path (nothing written); retried older pending alert notification lacks consulate; background.ts size untouched
- Task 6: minor (deferred): 304 consulate alongside a 200 writes a null history observation; Stop not checked inside the fetch loop (only before writes); mapHttpStatus called up to 4x per reply; reduction could be a tested helper `reduceDaysReplies`; mixed 304+[] counts empty vs all-304 not-modified (asymmetric, untested); skipped-date test mutates stored object by reference.
- Task 6: complete (commits 7245204..6de920f, review clean)
- Task 7: dispatched (base 6de920f, implementer sonnet)
- Task 7: implementer DONE (d9cd25a); observation without byConsulate accepted as empty list; UI test uses demo path with Toronto+Halifax
- Task 7: ⚠️ resolved by controller: Task 6 review confirmed byConsulate shape `[{consulate,dates}]`; earliestObserved([]) already used with empty availability on the existing path.
- Task 7: minor (deferred): headline iterates byConsulate incl. deselected consulates (live path only); tie by byConsulate order not CITIES order; inline earliest-across logic in Workflow; no live-path UI test for byConsulate rendering.
- Task 7: complete (commits 6de920f..d9cd25a, review clean)
- Task 8: dispatched (base d9cd25a, implementer opus)
- Task 8: implementer DONE_WITH_CONCERNS (35920d9); observe-all-then-save-then-notify ordering; review-background.test.ts updated; background.ts 2168 lines
- Task 8: review: 1 Important (notifications.create throw for one consulate aborts later consulates' notifications in that cycle; no test); minors: malformed legacy slot passes on Start; non-selected monitors dropped silently; brief's first test alone wouldn't prove multi-observation; background.ts 2168 lines.
- Task 8: fix round 1/5 started (fix base 35920d9, resuming implementer)
- Task 8: fix round 1/5 fix landed (f46d5bb), scoped re-review dispatched
- Task 8: fix round 1/5 (1 addressed, 0 open — per-consulate notification isolation; commits 35920d9..f46d5bb)
- Task 8: complete (commits d9cd25a..f46d5bb, review clean after 1 fix round)
- Task 9: dispatched (base f46d5bb, implementer sonnet)
- Task 9: implementer DONE (17e0ab8); shared earliestAcross helper for both modes
- Task 9: minor (deferred): Alerts test asserts counts/headline but not selected rows' text; no null-date/tie test in Alerts; empty "Other" list box renders when all seven selected; helpers defined inside Workflow.
- Task 9: complete (commits f46d5bb..17e0ab8, review clean)
- Task 10: dispatched (base 17e0ab8, implementer sonnet)
- Task 10: implementer DONE (96e8b69); regenerated docs/privacy-policy.html + docs/index.html via build:privacy; README sentence in View Logs bullet
- Task 10: minor (deferred): "no portal identity" test no longer proves Vancouver absent from hash input; no direct test that markHistoryBooking/pruneHistory preserve consulate; privacy-policy.md line exceeds hard-wrap width.
- Task 10: complete (commits 17e0ab8..96e8b69, review clean)
- Task 11: dispatched (base 96e8b69, implementer sonnet) — manual Chrome step (plan step 3) is the controller's/user's, not the implementer's
- Task 11: implementer DONE (acde197); npm run check green; manual Chrome step deferred to controller
- Task 11: ⚠️ resolved by controller: notification text confirmed by Task 6/8 reviews; "View Logs" is the History screen (README line 38 names it so; Task 10 added the column there).
- Task 11: minor (deferred): README binds to exact notification wording; "View Logs history names the consulate" could say "date history".
- Task 11: complete (commits 96e8b69..acde197, review clean)
- All 11 tasks complete. Final whole-branch review dispatched (opus) on 269fafe..acde197 (17 commits incl. pre-plan sole-applicant fix 71b0ebf).
- Final review (opus): Ready with fixes. Important #1 malformed 200 from one consulate discards the cycle; Important #2 facility-date-unavailable refusal parks instead of skipping the date. Minors #1-#7. Deferred-minor triage: none blocking; T5 pre-check, T1 parity test, T10 mark test recommended.
- Ruling: final fix wave includes Important #1, #2, Minor #3 (align adapter copies with isBareAppointmentQuery), Minor #4 (unit tests for isBareAppointmentQuery + acknowledged-query submission), Minor #2 (reject same-date candidates in canBook), Minor #1 (correct the spec's verification sentence), and the three recommended deferred items (T5 pre-check, T1 parity test, T10 mark test) — all small and local; costs one larger fix diff if wrong.
- Ruling: Minor #5 (interval note also shown in Alerts) and Minor #6 (stale observation lacks byConsulate until next poll) deferred — the shared form has no mode, and the next poll fills the panel; costs a slightly misleading note / one blank cycle if wrong.
- Ruling: "Declined to judge" items accepted as out of scope (rate-limit risk, facility-missing park, one-time Auto-Mode-OFF re-notify, dropped consulate on retried alert text, sequential fetch worker time, onlyEarlier=false semantics).
- Final fix wave dispatched (fix base acde197, opus)
- Final fix wave landed (acde197..7af5dec, 5 commits: A d3d8238, B+F 9c15916, C+D 0233111, E+D+G 0c70e40, H+I 7af5dec); 1502 tests; scoped re-review dispatched (opus)
- Final re-review: all A–I addressed, no new breakage. Branch review clean.
