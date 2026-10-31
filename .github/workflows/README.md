# Workflows

The release runbook is [`docs/release.md`](../../docs/release.md): signing, notarization, dry runs, R2 publishing and recovery. This file maps the workflow files and lists the one-time repository setup they depend on. To ship a release, use the `release` skill (`.claude/skills/release/`).

## Workflow files

| File | Purpose |
| --- | --- |
| `release-macos.yml` | App release for macOS (universal build, Developer ID signing, notarization, R2 publish) |
| `release-linux.yml` | App release for Linux (x64 and arm64, R2 publish) |
| `release-windows.yml` | App release for Windows (x64 and arm64 NSIS installers, x64 Store package, R2 publish, Microsoft Store submission) |
| `release-packages.yml` | npm publish for the plugin-ecosystem packages, triggered by per-package tags (not `v*`) |
| `nightly-publish.yml` | Nightly macOS and Linux builds published to the nightly update channel; no unit or E2E suites, launch smoke tests still run |
| `ci.yml` | Checks and tests on pushes and pull requests to `main` and `develop` |
| `e2e.yml`, `e2e-single.yml` | Reusable E2E runner (core smoke and the `full-*` buckets) and the single-spec runner |
| `stabilize.yml` | On-demand cross-platform validation, driven by the `stabilize` skill |
| `perf-ab.yml`, `pattern-discovery.yml`, `stale-quarantine.yml`, `test-ratio.yml` | Supporting automation; each file's header says what it does |

## Release shape

Pushing a `v*` tag starts `release-macos.yml`, `release-linux.yml` and `release-windows.yml` as three independent runs. Each runs its own checks, unit tests, E2E buckets and build, then publishes to R2 as soon as its own pipeline is green. There is no cross-OS gate: one OS can ship while another has failed, and a failed OS delays only itself.

Within one OS, `publish-daintree` (the shared `.github/actions/publish-daintree` action) uploads binaries first with `public, max-age=31536000, immutable`, verifies they are reachable, then uploads the channel metadata (`latest*.yml`, or `rc*` / `beta*` for prereleases) last with `no-cache, no-store, must-revalidate`, so clients never see metadata pointing at missing binaries.

To recover one OS, wait for its run to finish and re-run only that run's failed jobs (`gh run rerun <run-id> --failed`). A re-run keeps its original commit, and an OS that already published a version never republishes it. `docs/release.md` and `.claude/skills/release/references/ci-and-recovery.md` cover when to re-run, re-tag or cut a patch.

Manual dispatch inputs:

| Input | Workflows | Effect |
| --- | --- | --- |
| `dry_run` | macOS, Linux, Windows, `release-packages.yml` | Runs the pipeline without publishing to R2, the website, the Microsoft Store or npm |
| `skip_notarization` | macOS | Skips notarization (helper re-signing still runs in the `afterSign` hook), for when Apple's service is down |
| `smoke_artifact_run_id` | Windows | Smoke-tests the artifact of an earlier Windows run without rebuilding |
| `force_publish` | Windows | Publishes from a branch dispatch; see `ci-and-recovery.md` before using it |

## Setup

### 1. Create the R2 bucket

1. Go to Cloudflare dashboard → R2
2. Create a bucket (e.g., `daintree-updates`)
3. Enable **Public Access** on the bucket
4. Note the public URL (e.g., `https://pub-<hash>.r2.dev` or a custom domain)

### 2. Create an R2 API token

1. Cloudflare dashboard → R2 → **Manage R2 API Tokens**
2. **Create API token** with **Object Read & Write** permissions
3. Copy the **Access Key ID** and **Secret Access Key** (shown once)

### 3. Configure GitHub secrets

Add these in **Settings → Secrets and variables → Actions**.

R2 (read by the three per-OS release workflows and `nightly-publish.yml`):

| Secret                 | Value                                           |
| ---------------------- | ----------------------------------------------- |
| `R2_ENDPOINT`          | `https://<account-id>.r2.cloudflarestorage.com` |
| `DAINTREE_R2_BUCKET`   | Bucket name, e.g. `daintree-updates`            |
| `R2_ACCESS_KEY_ID`     | R2 API token access key                         |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret                             |

Other secrets the release and nightly workflows read:

| Secret | Used by | Purpose |
| --- | --- | --- |
| `MAC_CERTS`, `MAC_CERTS_PASSWORD` | macOS release, nightly | Developer ID Application certificate (base64 .p12) and its password |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | macOS release, nightly | App Store Connect API key for notarization |
| `APPLE_TEAM_ID` | macOS release, nightly | Apple Team ID |
| `WEBSITE_WEBHOOK_SECRET` | Release publish jobs | Notifies the website of a new release |
| `SENTRY_DSN` | Release builds | Error reporting DSN baked into the build |
| `PARTNER_CENTER_TENANT_ID`, `PARTNER_CENTER_SELLER_ID`, `PARTNER_CENTER_CLIENT_ID`, `PARTNER_CENTER_CLIENT_SECRET`, `STORE_PRODUCT_ID` | Windows release | Microsoft Store submission; skipped with a notice unless all five exist (see [`docs/distribution/microsoft-store.md`](../../docs/distribution/microsoft-store.md)) |

### 4. Publish URL

The auto-update feed is configured in [`electron-builder.config.cjs`](../../electron-builder.config.cjs), not `package.json`. It publishes to `https://updates.daintree.org/releases/` for stable builds and `https://updates.daintree.org/nightly/` when the version contains `-nightly`, and sets the `rc` or `beta` channel from the version string. To publish elsewhere, change the URL constants in that file, and the hardcoded live-feed URLs in `.github/actions/publish-daintree/action.yml`, `scripts/ci/check-version-monotonic.mjs` and `nightly-publish.yml`, so they all match the public URL of your bucket.

## Code signing

- **macOS** builds are signed with a Developer ID Application certificate and notarized on every release and nightly build unless the macOS `skip_notarization` input is set. `forceCodeSigning` is already `true` in `electron-builder.config.cjs`. Notarization runs through the `afterSign` hook `scripts/notarize-macos.cjs` using the App Store Connect API key secrets, not an Apple ID password. Details are in `docs/release.md`.
- **Windows** installers are not Authenticode-signed: neither `release-windows.yml` nor `electron-builder.config.cjs` configures a certificate, so the NSIS installers can trigger SmartScreen warnings. Microsoft re-signs the Store package after certification (`docs/distribution/microsoft-store.md`).

## Troubleshooting

### Version mismatch error

If a build fails with "Tag version (<tag version>) does not match package.json version (<package version>)":

- Ensure `package.json` version matches the git tag (without the `v` prefix)
- Example: tag `v1.2.3` requires `"version": "1.2.3"` in `package.json`

### Missing update metadata

If a build fails with "Missing release/latest\*.yml" (or `latest-mac.yml`, `latest-linux*.yml`):

- Check the `mac`, `win`, `linux` and `nsis` targets in `electron-builder.config.cjs`
- Ensure targets include both installers and update-friendly formats (zip for macOS, nsis for Windows)

### AWS CLI errors

All GitHub-hosted runners have the AWS CLI installed. If a publish step reports AWS CLI errors:

- Verify the R2 secrets are set, including `DAINTREE_R2_BUCKET`
- Check the endpoint format: `https://<account-id>.r2.cloudflarestorage.com`
- Ensure the bucket name matches exactly
