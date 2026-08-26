# Release Workflow

Automated build and publish workflow for Daintree releases to Cloudflare R2.

## Setup

### 1. Create R2 Bucket

1. Go to Cloudflare dashboard → R2
2. Create a bucket (e.g., `daintree-updates`)
3. Enable **Public Access** on the bucket
4. Note the public URL (e.g., `https://pub-<hash>.r2.dev` or custom domain)

### 2. Create R2 API Token

1. Cloudflare dashboard → R2 → **Manage R2 API Tokens**
2. **Create API token** with **Object Read & Write** permissions
3. Copy the **Access Key ID** and **Secret Access Key** (shown once)

### 3. Configure GitHub Secrets

Add these secrets in **Settings → Secrets and variables → Actions**:

| Secret | Value | Example |
| --- | --- | --- |
| `R2_ENDPOINT` | R2 S3-compatible endpoint | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | Bucket name | `daintree-updates` |
| `R2_ACCESS_KEY_ID` | R2 API token access key | (from step 2) |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | (from step 2) |

### 4. Update the builder config

The `publish` URL must match your R2 public URL. It lives in `electron-builder.config.cjs`, not `package.json`, which carries no top-level electron-builder `build` field — the config is a function, because the nightly channel picks a different URL from the same version string:

```js
const PUBLISH_URL = "https://updates.daintree.org/releases/";
const NIGHTLY_PUBLISH_URL = "https://updates.daintree.org/nightly/";
```

## Releasing

1. Update version in `package.json`
2. Commit: `git commit -am "release: vX.Y.Z"`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push origin main --tags`

The workflow will:

- Run release checks, unit tests, the `core` smoke gate, all seven `full-*` domain buckets in parallel (terminal, worktree, presets, platform, panels, resilience, plugins), and the `online` agent-integration gate before packaging
- Build for macOS, Windows, and Linux in parallel
- Validate update metadata files are present
- Upload binaries to R2 with long cache headers
- Upload metadata files with no-cache headers

## Code Signing

### macOS

macOS builds are signed with a Developer ID Application certificate and notarized by Apple. Signing is mandatory on every `release-macos.yml` path, dry runs included; local packaging is the exception, since `scripts/package-local-dmg.mjs` writes an override with `identity: null` and `forceCodeSigning: false` when no local certificate is available. Notarization is mandatory on a tag push, which cannot set `skip_notarization` — that input exists only under `workflow_dispatch`.

Builder configuration lives in the `mac` block of `electron-builder.config.cjs`:

- `forceCodeSigning: true` — packaging fails rather than emitting an unsigned bundle
- `hardenedRuntime: true`, `gatekeeperAssess: false`, and `entitlements` / `entitlementsInherit` both pointing at `build/entitlements.mac.plist`
- `binaries` lists the nested executables that must be signed in their own right — node-pty's `spawn-helper`, the PTY supervisor, and the vendored `assistant/daintree-assistant` engine. Notarization rejects the whole app if a nested executable is missing the hardened runtime.
- `notarize: false` — electron-builder's built-in notarizer is disabled on purpose, because the `afterSign` hook (`scripts/notarize-macos.cjs`) owns notarization. It drives `xcrun notarytool submit` / `wait` and staples the ticket with `xcrun stapler`, per arch.

Signing and notarization secrets (`release-macos.yml` consumes others for Sentry, publishing and the online E2E gate):

| Secret | Used for |
| --- | --- |
| `MAC_CERTS` | Base64-encoded .p12, imported by `apple-actions/import-codesign-certs` and passed to electron-builder as `CSC_LINK` |
| `MAC_CERTS_PASSWORD` | Certificate password (`CSC_KEY_PASSWORD`) |
| `APPLE_API_KEY` | App Store Connect API key (.p8 contents), written to a temp file whose path becomes the `APPLE_API_KEY` env var |
| `APPLE_API_KEY_ID` | Key ID for `notarytool` |
| `APPLE_API_ISSUER` | Issuer UUID for `notarytool` |
| `APPLE_TEAM_ID` | Expected TeamIdentifier, checked by the signing audit |

Notarization authenticates with an App Store Connect API key, not an Apple ID plus app-specific password.

Three verification steps gate the macOS build, and each one fails the run:

- **Verify macOS notarization staple** — `stapler validate` for the offline ticket, then `codesign -R="notarized" --check-notarization` to ask Apple whether the notarization is still acknowledged. Every nonzero result retries except exit 3 (signature valid, notarization not acknowledged), which is treated as definitive. This is the only verification step that `skip_notarization` turns off.
- **Verify macOS signing audit** — `codesign --verify --deep --strict` plus TeamIdentifier, hardened-runtime, and helper-entitlement checks. Deliberately not gated on `skip_notarization`: signing is a code-signing property that must hold even when notarization is manually disabled.
- **Verify shipped macOS archives** — re-extracts each shipped `.zip` and re-runs the audit on what comes out. The audit above inspects `release/mac*/Daintree.app` on disk, not the bytes users download.

On the default path a missing secret fails the release rather than quietly downgrading it. If the certificate import does not leave a usable identity in the keychain, `forceCodeSigning` fails packaging rather than emitting an unsigned bundle. With `APPLE_TEAM_ID` empty, both signing audits error out before they can vacuously pass. With `APPLE_API_KEY_ID` or `APPLE_API_ISSUER` empty, the notarize hook warns "Apple API credentials not set" and returns without notarizing — and the staple verification then fails the job. `APPLE_API_KEY` is the exception that does not fail early: the workflow writes the secret to a temp file unconditionally, so an empty secret yields an empty key file and a valid-looking path, and the failure surfaces from `notarytool` itself.

`release-macos.yml` takes a `skip_notarization` `workflow_dispatch` input for when Apple's notary service is down. It is the one hole in the above, so use it sparingly: the build is still signed and still audited, but it carries no notarization ticket, and Gatekeeper blocks a downloaded copy of an un-notarized app under default policy. Note that the publish job gates on the **ref**, not the event — `if: startsWith(github.ref, 'refs/tags/v')` — so a manual dispatch against a `v*` tag with `skip_notarization` set will publish a signed but un-notarized release. Dispatching against a branch cannot publish.

### Windows

Every Windows artifact this workflow produces is unsigned — the NSIS installers (`*-setup.exe`, x64 and arm64) and the `.appx` alike. The `win` block of `electron-builder.config.cjs` carries no Authenticode certificate and `release-windows.yml` has no signing step. Users who download an installer directly are likely to hit a SmartScreen warning; how often depends on the file's reputation and the machine's policy.

The AppX takes a different route to users: `release-windows.yml` submits it to Partner Center with `msstore publish`, and Microsoft signs the package it distributes once it passes Store certification, so no Authenticode certificate of ours is involved. The `.appx` archived to R2 alongside the installers is the unsigned input to that submission, not the signed Store artifact. See [`docs/distribution/microsoft-store.md`](../../docs/distribution/microsoft-store.md).

The submission itself is non-gating: it is skipped with a notice when the `PARTNER_CENTER_*` and `STORE_PRODUCT_ID` secrets are unset, and the `Submit to Microsoft Store` step is `continue-on-error`, so a failed submission still lets the R2 publish proceed. The `Install Microsoft Store CLI` step before it is **not** `continue-on-error` — if that action fails while the Store secrets are configured, it fails the job and the release with it.

The full signing and release runbook is [`docs/release.md`](../../docs/release.md).

## Troubleshooting

### Version mismatch error

If you see "Tag version does not match package.json version":

- Ensure `package.json` version matches the git tag (without the `v` prefix)
- Example: tag `v1.2.3` requires `"version": "1.2.3"` in package.json

### Missing metadata files

If builds fail with "Missing release/latest\*.yml":

- Check electron-builder configuration in `electron-builder.config.cjs`
- Ensure targets include both installers and update-friendly formats (zip for macOS, nsis for Windows)

### AWS CLI errors

All GitHub-hosted runners have AWS CLI pre-installed. If you see AWS CLI errors:

- Verify R2 secrets are correctly set
- Check R2 endpoint format: `https://<account-id>.r2.cloudflarestorage.com`
- Ensure bucket name matches exactly

## Architecture

### Release Stages

The workflow gates release packaging before any artifacts are produced:

1. **Quality gate stage**:
   - Checks and unit tests run on Linux
   - `core` smoke, the seven `full-*` domain buckets (terminal, worktree, presets, platform, panels, resilience, plugins) fanned out as a matrix, and the `online` gate run before packaging. Each `full-*` bucket auto-shards inside `e2e.yml` (#8053), so Windows `full-*` gates the Windows release too. Broader pre-release cross-platform validation is the on-demand `stabilize.yml` workflow (driven by the `stabilize` skill), not a scheduled nightly.

2. **Build stage** (parallel matrix):
   - macOS, Windows, Linux build in parallel
   - Each validates its update metadata
   - Uploads to GitHub Actions artifacts

3. **Publish stage** (single job):
   - Runs only after all builds succeed
   - Downloads all artifacts
   - Uploads binaries first (with long cache)
   - Uploads metadata last (no cache)

This ensures users never see incomplete releases or transient 404s.

### Cache Headers

- **Binaries** (`*.dmg`, `*.exe`, etc.): `public, max-age=31536000, immutable`
  - Cached for 1 year (versioned filenames)
- **Metadata** (`latest*.yml`): `no-cache, no-store, must-revalidate`
  - Never cached (checked on every update check)
