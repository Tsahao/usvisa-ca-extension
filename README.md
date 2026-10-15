# US Visa Scheduler for Canada

A Chrome extension for monitoring U.S. visa appointment availability in Canada
and booking or rescheduling an eligible appointment within your chosen date
range. This is an independent project, unaffiliated with the U.S. government
or the official scheduling provider.

## Features

- **Book:** monitor a paid group's availability and book an eligible appointment
  using your selected consulate, date window and earlier-only preference.
- **Alerts:** monitor an unpaid group's availability across seven consulates;
  desktop notifications apply to the selected consulate. This mode never pays
  or books.
- **Test Mode:** prepare the booking form without clicking the final submit or
  opening its confirmation dialog. Test Mode defaults **OFF**; enable it before
  starting if you want a dry run.
- Automatic sign-in and bounded session renewal, with manual handling of
  CAPTCHA and second-factor challenges.
- A detached panel that can close while monitoring continues. Press **Stop** to
  stop a workflow. Browser restart parks existing work for review; interrupted
  booking attempts require fresh verification before another attempt.
- Optional tips through a separate Stripe checkout.

Automation can change an existing appointment and may be restricted by the
portal's terms. Availability, booking and notification delivery are not
promised. Always check appointment results on the official website yourself.

## Build and install

Requires Node.js 22.12+ on a supported Node release and Chrome 120+.

```sh
npm ci
npm run check
```

Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**,
and choose `dist/`. Click the extension toolbar icon to open the panel and save
your configuration before starting Book or Alerts.

## Privacy

Read the [published privacy policy](https://tsahao.github.io/usvisa-ca-extension/privacy-policy.html)
([source](docs/privacy-policy.md)). Credentials and settings
persist in `chrome.storage.local`, restricted to trusted extension contexts;
Chrome Sync is not used. Local storage is **not an encrypted password vault**.
Credentials are sent only to the official portal for sign-in, never to the
publisher or analytics. Uninstalling removes the extension's local data.

Configured production builds send four limited, pseudonymous PostHog usage
events: installation, accepted workflow Start, terminal workflow failure, and
validated unpaid-alert activation. Payloads exclude credentials, visa and
applicant identifiers, portal content, URLs, consulates and appointment dates.
No autocapture, heatmaps or session replay is used. The first release has no
analytics opt-out switch in its panel.

Production tracking is disabled unless valid build configuration is supplied.
Copy `.env.example` to `.env.local` to configure it, or set
`VITE_POSTHOG_ENABLED=false` for a build that does not send analytics. Never
commit `.env.local`. Test builds always disable analytics; analytics tests use
synthetic tokens and mocked transport.

## Development and verification

```sh
npm run dev                 # synthetic browser preview; no account required
npm run check               # unit tests, packaging tests, types, build, smoke checks
npx playwright install chromium
npm run test:browser        # synthetic packaged-extension and UI tests
```

Browser tests need Google Chrome for UI checks and Playwright Chromium for an
isolated extension profile. They use synthetic fixtures and do not make live
bookings, send external notifications, or deliver analytics to a real project.

The development preview and probe are test tools; the production build omits
the probe. Automated verification is synthetic. The owner also reports
successful live initial-booking and rescheduling checks with Test Mode ON and
OFF; this is user-reported evidence, not an independent live retest.

## Release packages

```sh
npm run check
npm run package:release
npm run package:source
```

Packages and SHA-256 sidecars are written to ignored `release/`. The runtime
ZIP is the Chrome Web Store upload; publish its matching source ZIP alongside
the distribution. See [release packaging](docs/release-packaging.md).

`npm run prepare:public` creates a separate, allowlisted public source folder
under `release/github-public/`. It includes source, tests, build scripts,
licenses and public documentation. It excludes local development notes,
agent instructions, unfinished release documents, existing Git history,
credentials, dependencies, test reports and build outputs. Your original
working files stay in this checkout. Start the public repository from that
folder so omitted files are also absent from public Git history.

## License

[GNU GPL version 3](LICENSE) (`GPL-3.0-only`). Complete bundled dependency
licenses are included in release packages and the prepared public repository.
The TypeScript implementation was newly written, using the GPL-3.0 Python
project as a behavioral reference (commit
`5e2f37e0a0ef2ac72587d9cf3556f655855a571e`). No Python secrets, private
configuration or browser profiles are included.
