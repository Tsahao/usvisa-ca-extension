# Release packaging

How the production `dist/` build differs from development/test builds, and how
to produce the clean Web Store ZIP and its corresponding source package for
**US Visa Scheduler for Canada**.

## Build flavors

| Build | Command | Output | Probe page | Analytics |
| --- | --- | --- | --- | --- |
| Production release | `npm run build` | `dist/` | Omitted | Enabled only when `.env.local` holds a valid project token + allowlisted host |
| Packaged-test fixture | `npm run build:test` (via `npm run test:browser`) | `dist-test/` | Included | Always disabled (`--mode test`) |
| Telemetry fixture | telemetry spec only | `dist-analytics-test/` | Included | Synthetic token, mocked transport, DNS-blocked hosts |
| Dev server | `npm run dev` | memory | Included | Disabled (`PROD` false) |

The production build omits `probe.html`/`probe.js` and their styles. The
background worker's `PROBE_*` handlers stay in all builds, but in the release
they are unreachable: every handler requires the bundled `probe.html` sender
URL, which does not exist in `dist/`. The product panel links to the probe
only in non-production builds (`import.meta.env.MODE !== 'production'`), so
the release panel has no dead probe link. The `?preview=1` synthetic panel and
legacy `?embedded=1` frame are developer fixtures exercised by the packaged
suite against `dist-test/`; they are not linked from any product surface.

`ENGINE_*` typed worker messages remain accepted from bundled extension pages
in every build. They are the mechanism the packaged suite uses for synthetic
setup, require an extension-page context (website content can never send
them), and carry no credentials, page text, or URLs.

## Permissions audit (kept narrow, nothing removed)

- `storage`: local preferences/credentials (`TRUSTED_CONTEXTS` only, never Sync) and durable engine checkpoints.
- `alarms`: poll scheduling, durable retry/cooldown deadlines, wake-up recovery.
- `activeTab` + `scripting`: reads and guarded actions on the validated owned official-site tab only; arbitrary URLs are never followed.
- `notifications`: unpaid availability alerts on the selected consulate.
- Host `https://ais.usvisa-info.com/*`: the only always-present host permission.
- Optional PostHog ingestion host (`https://us.i.posthog.com/*` or `https://eu.i.posthog.com/*`): appended at build time only when `.env.local` configures a valid project token and allowlisted host. Portal trust/action guards are unchanged.

Production removes `web_accessible_resources`: the detached product UI does
not need to be exposed to websites. Test/developer builds retain the legacy
iframe fixture's scoped resources.

## Reproducible packaging

```sh
npm run check            # unit tests + tsc + production build + release smoke checks
npm run package:release  # release/…zip + .sha256 (smoke checks run first)
npm run package:source   # release/…-source.zip + .sha256 + version record
```

- `scripts/release-smoke.mjs` asserts the exact product name/version, the
  audited permission set, at most one analytics host, strict runtime file allowlist, no website-accessible developer resources, runtime asset presence, and
  the absence of probe pages, source maps, private config, and test fixtures.
  It never prints bundle contents.
- `scripts/package-release.mjs` zips an explicit runtime allowlist
  (`manifest.json`, `background.js`, `panel.html`, `panel.js`, `assets/`,
  `icons/`, `LICENSE`, generated `SOURCE.txt` and complete
  `THIRD_PARTY_LICENSES.txt`) at the ZIP root. Staging is isolated in a temporary
  directory; no files in `dist/` are overwritten or removed.
- `scripts/package-source.mjs` snapshots only explicit project root files and
  the `src/`, `public/`, `tests/`, `scripts/`, `docs/` trees. Required untracked
  source assets are included; arbitrary root files, build outputs, dependencies,
  private directories, environment files other than `.env.example`, key files
  and symlinks are not accepted. Review the allowlisted source/docs for private
  content before publication; filename filtering is not content-level auditing.
  `SOURCE_VERSION.txt` and complete third-party licenses are inside the archive.
- Both ZIPs sort file entries, fix timestamps and permissions, strip extra ZIP
  metadata, and use UTC. Repeated packaging of unchanged inputs yields identical
  hashes on the same ZIP toolchain. `npm run test:packaging` verifies this and
  synthetic private-file/symlink exclusions. This does not promise byte-identical
  builds across different Node/platform/ZIP versions or analytics configurations.

Host the matching source ZIP publicly and provide download directions alongside
the binary distribution; Web Store submission does not host it automatically.
The source snapshot—not a dirty checkout's HEAD—is the corresponding source.
Use `.env.example` for optional analytics build configuration; actual
`.env.local` is never included. Publisher identity, public source/policy URLs,
analytics retention/consent decisions and asset rights remain publisher
responsibilities. Packaging checks do not establish privacy/legal compliance.

## Clean public repository and privacy site

`npm run prepare:public` creates a new `release/github-public/` directory using
an explicit public-file allowlist. Existing output is never overwritten. Keep
development notes and the original checkout locally; create the public Git
repository from this new directory to avoid publishing earlier working notes
through Git history. Do not push the development checkout's history.

The public snapshot includes source, synthetic tests, build scripts, lockfile,
licenses, this guide and the finished privacy policy. It omits agent
instructions, planning documents, live-validation notes, unfinished legal/store
drafts, secrets, dependencies, test reports and generated extension builds.
The exporter refuses unfinished public documentation.

`npm run build:privacy` generates static HTML from `docs/privacy-policy.md`.
It refuses owner placeholders. Commit the generated HTML and CSS, then configure
GitHub Pages to deploy from the `main` branch's `/docs` folder. The policy URL
is `https://OWNER.github.io/REPOSITORY/privacy-policy.html`. Verify that this URL
loads publicly before entering it in the Chrome Web Store privacy-policy field.
No analytics, scripts, external fonts or cookies are added to the policy site.

`release/` is gitignored. Version `0.1.0` is kept consistent across
`package.json`, `package-lock.json`, and `public/manifest.json`; the owner
chooses the final release version before publication.

The deployed policy for this project is
[Privacy Policy](https://github.tsahaoyu.com/usvisa-ca-extension/privacy-policy.html).
GitHub Pages uses the account’s existing custom domain; HTTPS is enforced for
this project site.
