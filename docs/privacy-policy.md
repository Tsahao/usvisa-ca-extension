# Privacy Policy — US Visa Scheduler for Canada

Effective date: October 23, 2026.

Publisher: loose ends studio.

Privacy contact: [browser.latte.1k@icloud.com](mailto:browser.latte.1k@icloud.com).

This policy explains how US Visa Scheduler for Canada handles information
when you use the Chrome extension. The extension is an independent project
and is not affiliated with the U.S. government or the official visa scheduling
provider.

## Information processed on your device

The extension processes information from the official visa scheduling portal
to carry out workflows you start: sign-in, availability monitoring, selected
group and applicant validation, booking or rescheduling, and verification of
appointment outcomes. This includes portal URLs and page content, account and
group identifiers, applicant details, fee-payment status, consulate preferences,
available dates and appointment details.

Your saved portal email and password, settings, availability observations,
notification history, workflow checkpoints, pending booking verification and
booking-success record are stored locally in your Chrome profile using
`chrome.storage.local`. Temporary window and tab references use
`chrome.storage.session`. Chrome Sync is not used. Storage access is restricted
to trusted extension contexts.

View Logs also stores a local history of selected-consulate earliest-date
changes, check times and booking outcomes. It retains at most 100 rows from
the last 24 hours. Date history rows record which consulate each date was seen at. Internal comparison and attempt references are hashed;
history records contain no credentials, raw visa/applicant identifiers, portal
URLs or page content. History is not sent to analytics or the publisher.

A bounded internal diagnostics log supports reliability analysis of failed or
recovered unattended checks. It keeps up to 1500 fixed developer event codes
for up to 7 days outside the user interface: event code, timestamp, fixed
validation-branch detail, workflow phase, run purpose, run mode, extension version and a failure
count — never credentials, settings, portal URLs or page content, applicant
identifiers, appointment dates or raw errors. It is not sent to analytics or
the publisher automatically, and it is separate from the user-facing View Logs.
On failure screens, **Report a problem** opens an email draft to
browser.latte.1k@icloud.com with extension/browser versions, workflow mode,
Test Mode, status, stage, a fixed failure category and recent sanitized
diagnostics. Older entries may be omitted to fit email-link limits. You can
review, edit or discard the draft; nothing is sent unless you send the email.
Sending shares the report, your email address and any comments you add with
the publisher through your email provider. An email app or configured browser
email handler is required.
Recording is best effort; the entry limit can remove older events sooner,
and storage failures or a full recording queue can result in missing events.

**Local storage is not an encrypted password vault.** Someone with access to
your device or Chrome profile may be able to read it. Protect your device and
browser profile accordingly.

Portal information and credentials are not sent to the publisher or analytics
provider. Credentials are sent over HTTPS to the official scheduling provider
when the extension signs you in. Booking actions send the necessary form data
to that provider. The provider's own privacy policy applies to its services.
The extension does not clear portal cookies or automatically sign you out.

## Limited usage analytics

Configured production builds send five limited usage events to PostHog to
understand adoption and workflow reliability:

- `installation_seen`: once per tracking-enabled installation.
- `workflow_started`: when a new Book or Alerts workflow is accepted.
- `workflow_failed`: when a tracked workflow ends with a terminal failure requiring user action.
- `alerts_monitoring_established`: after a selected unpaid group and its first complete availability summary have been validated.
- `appointment_booked`: after a real booking is verified as successful, once per tracked booking workflow; excludes Test Mode.

Events contain random installation and event identifiers, a timestamp,
extension version and production-environment label. Workflow events also
contain a separate random session identifier, mode and Test Mode flag; failure
events include a fixed failure category and predefined codes for the specific
failure reason and workflow step. When known, they also identify the sign-in
purpose (starting, renewing or verifying a workflow). Unavailable details are
marked unknown or omitted. These are limited status codes, not the internal
diagnostics log, page content or raw error messages. These identifiers are not derived from
your email, visa account or hardware. The installation identifier and a bounded
queue of unsent events are stored locally.

**Analytics excludes passwords, email addresses, visa/group/applicant
identifiers, portal URLs and content, consulate and date preferences,
availability details and appointment dates.** The extension does not use
session replay, heatmaps, autocapture, general browsing surveillance or
automatic exception reporting. Ordinary polling, retries and periods with no
available dates are not usage events.

The current release uses PostHog's U.S. ingestion endpoint at
`https://us.i.posthog.com`. Source builds can instead select PostHog's E.U.
endpoint or disable tracking. Development previews and test-mode builds do not
send analytics. Enabling booking Test Mode in a configured production build
blocks final booking submission; it does not disable that build's analytics.

Requests use HTTPS without cookies or a referrer. The extension sets the
payload's IP field to null and disables GeoIP enrichment and person-profile
processing. PostHog nevertheless receives the network connection's source IP.
The project's **Discard client IP data** setting is currently disabled, so we
do not promise that PostHog discards IP information. PostHog may process or
retain technical connection information under its own policies. This tracking
is pseudonymous, not fully anonymous.

The project currently uses PostHog's **Free plan**, which lists one-year event
retention. PostHog describes this as a retention guarantee and says older data
may be deleted; it is not a promise that every event is automatically erased
exactly one year after collection. Provider logs, backups and other technical
records are subject to PostHog's policies. See
[PostHog's retention information](https://posthog.com/pricing).

To request deletion of identifiable analytics records, contact the privacy
address above. The publisher can seek assistance from PostHog to handle
requests for these events, which are captured without person profiles.
Deletion is not an immediate action available in the extension, and we do not
promise an unverified processing deadline. The random installation identifier
may be needed to locate the relevant events; an email address alone does not
identify them.

For PostHog's own handling of data, see the
[PostHog privacy policy](https://posthog.com/privacy).

## Optional payments

The optional Coffee feature opens Stripe checkout in a separate tab. The
extension supplies only the selected amount in cents through a fixed payment
link. It does not attach portal credentials, applicant or visa identifiers,
appointment details, portal URLs, or analytics identifiers.

Stripe handles payment information and payment completion. The extension does
not collect card details or determine whether you completed a payment. See
[Stripe's privacy policy](https://stripe.com/privacy).

## Retention and your choices

Local settings and workflow records remain in your Chrome profile until they
are overwritten or the extension is uninstalled. You can change saved
credentials in Settings; this does not clear every stored record. There is no
clear-all-data button in the first release. Uninstalling removes this
extension's local storage from that profile and stops future extension
activity. It does not delete records already held by the official portal,
PostHog or Stripe.

View Logs hides rows after 24 hours and prunes expired history on extension
wake, the scheduled cleanup alarm or a history read. Cleanup can wait while
Chrome is closed or suspended; reopening the extension prunes expired rows.
Unchanged availability can remain in the separate current-observation and
workflow records described above.

The extension panel has no analytics opt-out switch. To stop future analytics,
uninstall the extension or use a source build compiled with
`VITE_POSTHOG_ENABLED=false`. A disabled build preserves its existing local
analytics queue without sending it; re-enabling tracking may send those queued
events. Installation tracking in a configured build may occur before you open
the panel or start a workflow.

For privacy, access, correction or deletion requests, contact the privacy
address above. Analytics identifiers are random and are not linked to your
email, so we may be unable to identify records from your email address alone.
The extension has no built-in remote-deletion request or installation-ID
display. Please contact us before sending diagnostic information, and never
send passwords, cookies, browser storage exports, applicant documents or
unredacted appointment confirmations.

## Other disclosures and security

The extension's publisher does not receive your portal credentials or operate
a backend that stores your visa records. Analytics is limited to the events
above. Local portal information is used to provide the monitoring and booking
features you request, including safety checks and recovery after interruption.

The extension uses HTTPS and restricts portal actions to validated official
pages and selected groups. These safeguards do not guarantee security or
successful appointment changes. Always verify appointment outcomes directly
on the official website.

The extension is not directed at children. Use it only with accounts you are
authorized to manage.

## This policy website

This static policy is hosted on GitHub Pages. We add no analytics scripts,
external fonts or cookies to the page. GitHub may process technical information
about visits under its own
[privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Changes and contact

Changes will be posted on this page with an updated effective date. Questions
about the extension's privacy practices should be sent to the privacy contact
listed above.
