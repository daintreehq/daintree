# Release & Code Signing

## Overview

Releases are built by **three per-OS workflows** — `.github/workflows/release-macos.yml`, `release-linux.yml`, and `release-windows.yml` (#8052) — each triggered independently by the same `v*` tag (or manual `workflow_dispatch`). Each workflow runs a full vertical slice for its OS (checks → unit tests → e2e → build → R2 upload → website notify) and publishes to Cloudflare R2 the moment its own pipeline is green. A failure or hang in one OS only delays that OS; the other two ship unaffected, and re-running a failed OS is a single-workflow re-trigger. macOS builds universal, Windows x64+arm64, Linux x64.

Use the `/release` command to execute a full gitflow release.

## Release Notes Format

Two surfaces, slightly different conventions. The `/release` command treats this section as the source of truth.

### `CHANGELOG.md`

`CHANGELOG.md` is the chronological record. Every release prepends a new section anchored by version and date:

```markdown
## [X.Y.Z] - YYYY-MM-DD

[1-2 sentence summary of the release theme.]

### Features

- Entry (#issue)

### Bug Fixes

- Entry (#issue)
```

- The `## [X.Y.Z] - YYYY-MM-DD` heading is required — it's the chronological anchor.
- Section headings (`### Features`, `### Bug Fixes`, `### Performance`, `### Breaking Changes`, `### Other Changes`) are all `###`.
- For releases with many entries, group within a section using a bold paragraph: `**Daintree Assistant**`, `**MCP Server**`, etc.
- Issue references as `#NNN` — they auto-link on GitHub.
- Omit `### Other Changes` entirely if there's nothing user-relevant.

### GitHub Release notes

GitHub's release UI already renders the version and date as the page header, so the release body skips both:

```markdown
[1-2 sentence summary of the release theme.]

### Features

- Entry (#issue)

### Bug Fixes

- Entry (#issue)
```

- **No version or date heading** at the top — GitHub shows that already.
- **A 1-2 sentence intro paragraph is required on every release.** State the theme: what landed, what the focus was, or — for patch releases — what was wrong with the previous version. Match the existing 0.9.1 / 0.9.0 / 0.8.0 entries: fragment-style, technical, no marketing tone.
- Section headings (`###`), bold-paragraph grouping, and issue references match the changelog.
- No trailing `---` or manual "Full Changelog" link — GitHub provides the compare link in the release header automatically.

The `/release` command produces the GitHub release body from the `CHANGELOG.md` section by stripping the `## [X.Y.Z] - YYYY-MM-DD` line. Everything else (summary, sections, entries) is identical between the two surfaces.

## Dry Runs

Before tagging a real release, run the workflow in dry-run mode to validate the full pipeline against the current `develop` head. The `/release` command prompts for this between preflight and the changelog work — it's the recommended way to avoid the "tag → CI fails → re-tag" loop.

```bash
# Each OS is its own workflow now — dry-run the one(s) you want, or all three.
gh workflow run release-macos.yml   --ref develop -f dry_run=true
gh workflow run release-linux.yml   --ref develop -f dry_run=true
gh workflow run release-windows.yml --ref develop -f dry_run=true
```

Each dry run executes every gate and build job for its OS — checks, unit tests, that OS's E2E buckets (`core`, `online`, and all seven auto-sharded `full-*` buckets — see #8053), and that OS's `build-daintree` job (macOS sign + notarize; Linux; Windows including Store package + WACK) — but **skips** the side effects that matter for an actual release:

- No R2 upload (binaries or metadata)
- No Microsoft Store submission (`Submit to Microsoft Store` is gated by `inputs.dry_run != true`)
- No website refresh webhook
- `publish-daintree` doesn't run at all (its `if:` requires both a `v*` tag ref and `dry_run != true`)

macOS signing and notarization still execute — that's intentional, because Apple notarization is one of the most common reasons a tag-triggered release fails late. The stapler validation step runs against the resulting `.app` bundles.

A dry run typically takes **30–40 minutes** end-to-end. Watch it with `gh run watch <RUN_ID> --exit-status`. If it goes green, you can tag with high confidence the real release will succeed; if it fails, fix on `develop` and re-run before doing any of the changelog / version-bump work.

## macOS Code Signing

macOS builds are signed with a Developer ID Application certificate. The signing identity and certificate are stored as GitHub secrets.

### Secrets

| Secret               | Description                                               |
| -------------------- | --------------------------------------------------------- |
| `MAC_CERTS`          | Base64-encoded .p12 signing certificate                   |
| `MAC_CERTS_PASSWORD` | Password for the .p12 certificate                         |
| `APPLE_API_KEY`      | App Store Connect API key (.p8 file content)              |
| `APPLE_API_KEY_ID`   | 10-character Key ID from App Store Connect (`3NFG76895G`) |
| `APPLE_API_ISSUER`   | Issuer UUID from App Store Connect                        |
| `APPLE_TEAM_ID`      | Apple Team ID (`D9674SJ8J4`)                              |

### How signing works in CI

1. `apple-actions/import-codesign-certs@v6` imports the .p12 into a temp keychain
2. The .p8 key content is written from `APPLE_API_KEY` secret to a temp file
3. `APPLE_API_KEY` env var is set to the **file path** (not content) for `notarytool --key`
4. electron-builder signs the app, then the `afterSign` hook (`scripts/notarize-macos.cjs`) submits to Apple for notarization via `notarytool`

### Local signing keys

Local copies of signing keys are stored in the `keys/` directory (gitignored):

- `keys/AuthKey_3NFG76895G.p8` — App Store Connect API key

The `.env` file (also gitignored) stores credentials for local builds. See `.env` for the current values.

To check notarization status locally:

```bash
xcrun notarytool history \
  --key keys/AuthKey_3NFG76895G.p8 \
  --key-id 3NFG76895G \
  --issuer 193e486e-1945-4dcd-9bb5-ae68d41441ef
```

## macOS Notarization

Notarization is enabled. All CI builds are signed and submitted to Apple's notarization service automatically.

### Key technical details

- electron-builder 26.8.1. Notarization is **not** driven by electron-builder's built-in `@electron/notarize` integration (that package is only a transitive dep now). Instead a custom `afterSign` hook runs — `scripts/notarize-macos.cjs`, wired via the `afterSign` key in `electron-builder.config.cjs`.
- `mac.notarize` is set to `false` in `electron-builder.config.cjs`; the custom `afterSign` hook performs notarization itself, so the built-in path is intentionally disabled.
- `APPLE_API_KEY` env var = **file path** to .p8 (not content, not Key ID)
- `APPLE_API_KEY_ID` = 10-character Key ID
- `APPLE_API_ISSUER` = Issuer UUID
- The hook submits and waits as **two separate steps**: `notarytool submit` (120s exec timeout) then `notarytool wait --timeout 1800` (`WAIT_TIMEOUT_SECONDS`), bounded so an Apple delay can't block CI indefinitely. It persists a resumable `.notarization-state.json` in the out dir, so a re-run can reattach to an in-flight submission instead of resubmitting, and staples each arch on success.

### Skip notarization flag

There are two skip paths:

- The `skip_notarization` workflow input (manual dispatch). `release-macos.yml` sets `EXTRA_ARGS="-c.mac.notarize=false"` for electron-builder when it's true — though `notarize` is already `false` in `electron-builder.config.cjs`, so this is belt-and-suspenders.
- The actual `afterSign` hook is gated by the `DAINTREE_SKIP_NOTARIZATION=true` env var (`scripts/notarize-macos.cjs`); when set, the hook returns immediately without submitting.

### Debug logging

The workflow sets `DEBUG=electron-builder,electron-notarize*,electron-osx-sign*` for verbose signing/notarization output.

## R2 Publishing

Artifacts are uploaded to Cloudflare R2 via AWS CLI:

- Binaries (dmg, zip, exe, AppImage, deb, blockmap) → `s3://<bucket>/releases/` with immutable caching
- Metadata (latest\*.yml) → `s3://<bucket>/releases/` with no-cache headers

### R2 Secrets

| Secret                 | Description                      |
| ---------------------- | -------------------------------- |
| `R2_ACCESS_KEY_ID`     | R2 access key                    |
| `R2_SECRET_ACCESS_KEY` | R2 secret key                    |
| `R2_ENDPOINT`          | R2 endpoint URL                  |
| `DAINTREE_R2_BUCKET`   | Bucket name (`daintree-updates`) |

## Entitlements

The hardened runtime entitlements are in `build/entitlements.mac.plist`:

- `com.apple.security.cs.allow-jit` — required for V8 JIT in Electron 42 (no longer requires `allow-unsigned-executable-memory`, dropped in Electron 12)
- `com.apple.security.cs.disable-library-validation` — allows loading native .node modules at runtime (pty.node, better_sqlite3.node). Retained until the CI TeamIdentifier audit (`scripts/ci/verify-team-identifier.sh`) confirms every Mach-O in the bundle shares the expected Team ID
- `com.apple.security.device.audio-input` (`true`) — microphone access for the voice dictation feature. `com.apple.security.device.camera` is explicitly `false`.

## Local Development Builds

To build locally without Developer ID signing or notarization (e.g. for testing), first compile the app then package it with signing disabled. On macOS (Unix shell only):

```bash
npm run build && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --publish never -c.mac.notarize=false -c.mac.forceCodeSigning=false
```

Notes:

- `npm run build` is required first — electron-builder packages whatever is in `dist/` and `dist-electron/`, so skipping it produces a stale or broken bundle.
- `CSC_IDENTITY_AUTO_DISCOVERY=false` suppresses auto-discovery of local Developer ID certificates. If `CSC_LINK`, `CSC_NAME`, or `APPLE_*` variables are exported in your shell, unset them as well.
- The `CSC_IDENTITY_AUTO_DISCOVERY=false` inline syntax is POSIX-only (bash/zsh). On Windows use `set CSC_IDENTITY_AUTO_DISCOVERY=false` (cmd) or `$env:CSC_IDENTITY_AUTO_DISCOVERY='false'` (PowerShell) before the build command.
- On macOS, universal and arm64 builds still apply ad-hoc signing even with these flags — the resulting app will not be Gatekeeper-trusted, but it will launch on the machine it was built on.
