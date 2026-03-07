# Release & Code Signing

## Overview

Releases are built by the `.github/workflows/release.yml` workflow, triggered by `v*` tags or manual `workflow_dispatch`. The workflow builds for macOS (universal), Windows (x64), and Linux (x64), then publishes artifacts to Cloudflare R2.

Use the `/release` command to execute a full gitflow release.

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

1. `apple-actions/import-codesign-certs@v3` imports the .p12 into a temp keychain
2. The .p8 key content is written from `APPLE_API_KEY` secret to a temp file
3. `APPLE_API_KEY` env var is set to the **file path** (not content) for `notarytool --key`
4. electron-builder signs the app, then submits to Apple for notarization via `notarytool`

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

- electron-builder 26.8.1 + @electron/notarize 2.5.0
- `APPLE_API_KEY` env var = **file path** to .p8 (not content, not Key ID)
- `APPLE_API_KEY_ID` = 10-character Key ID
- `APPLE_API_ISSUER` = Issuer UUID
- `mac.notarize` in package.json only accepts `true` or `false` (not an object) in electron-builder 26.8.1
- `@electron/notarize` calls `notarytool submit --wait` with no timeout — Apple delays can block CI indefinitely

### Skip notarization flag

The workflow has a `skip_notarization` input for manual dispatches. This passes `-c.mac.notarize=false` to electron-builder at build time, overriding whatever is in `package.json`.

### Debug logging

The workflow sets `DEBUG=electron-builder,electron-notarize*,electron-osx-sign*` for verbose signing/notarization output.

## R2 Publishing

Artifacts are uploaded to Cloudflare R2 via AWS CLI:

- Binaries (dmg, zip, exe, AppImage, deb, blockmap) → `s3://<bucket>/releases/` with immutable caching
- Metadata (latest\*.yml) → `s3://<bucket>/releases/` with no-cache headers

### R2 Secrets

| Secret                 | Description                    |
| ---------------------- | ------------------------------ |
| `R2_ACCESS_KEY_ID`     | R2 access key                  |
| `R2_SECRET_ACCESS_KEY` | R2 secret key                  |
| `R2_ENDPOINT`          | R2 endpoint URL                |
| `R2_BUCKET`            | Bucket name (`canopy-updates`) |

## Entitlements

The hardened runtime entitlements are in `build/entitlements.mac.plist`:

- `com.apple.security.cs.allow-jit` — required for Electron with hardened runtime
- `com.apple.security.cs.allow-unsigned-executable-memory` — may not be needed for Electron 40+, review when re-enabling notarization
- `com.apple.security.cs.disable-library-validation` — allows loading node-pty native module

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
