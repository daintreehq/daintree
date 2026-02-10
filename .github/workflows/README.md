# Release Workflow

Automated build and publish workflow for Canopy releases to Cloudflare R2.

## Setup

### 1. Create R2 Bucket

1. Go to Cloudflare dashboard → R2
2. Create a bucket (e.g., `canopy-updates`)
3. Enable **Public Access** on the bucket
4. Note the public URL (e.g., `https://pub-<hash>.r2.dev` or custom domain)

### 2. Create R2 API Token

1. Cloudflare dashboard → R2 → **Manage R2 API Tokens**
2. **Create API token** with **Object Read & Write** permissions
3. Copy the **Access Key ID** and **Secret Access Key** (shown once)

### 3. Configure GitHub Secrets

Add these secrets in **Settings → Secrets and variables → Actions**:

| Secret                 | Value                     | Example                                         |
| ---------------------- | ------------------------- | ----------------------------------------------- |
| `R2_ENDPOINT`          | R2 S3-compatible endpoint | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_BUCKET`            | Bucket name               | `canopy-updates`                                |
| `R2_ACCESS_KEY_ID`     | R2 API token access key   | (from step 2)                                   |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret       | (from step 2)                                   |

### 4. Update package.json

Ensure the `publish` URL matches your R2 public URL:

```json
"publish": [
  {
    "provider": "generic",
    "url": "https://your-r2-public-url/releases/"
  }
]
```

## Releasing

1. Update version in `package.json`
2. Commit: `git commit -am "release: vX.Y.Z"`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push origin main --tags`

The workflow will:

- Build for macOS, Windows, and Linux in parallel
- Validate update metadata files are present
- Upload binaries to R2 with long cache headers
- Upload metadata files with no-cache headers

## Known Limitations

### macOS Auto-Updates

**macOS builds are currently unsigned.** macOS auto-updates require:

- Code signing certificate from Apple Developer account
- Notarization with Apple

**What this means:**

- macOS users will see "unidentified developer" warnings
- Auto-updates may not work on macOS until signing is configured

**To enable macOS auto-updates:**

1. Obtain Apple Developer certificates
2. Add secrets to GitHub:
   - `MAC_CERTS` - Base64-encoded .p12 certificate
   - `MAC_CERTS_PASSWORD` - Certificate password
   - `APPLE_ID` - Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD` - App-specific password
   - `APPLE_TEAM_ID` - Team ID from developer account

3. Uncomment the cert import step in `release.yml` (lines 56-62)
4. Set `forceCodeSigning: true` in `package.json`

### Windows Code Signing

Windows builds are also unsigned. Users will see SmartScreen warnings until signing is configured.

## Troubleshooting

### Version mismatch error

If you see "Tag version does not match package.json version":

- Ensure `package.json` version matches the git tag (without the `v` prefix)
- Example: tag `v1.2.3` requires `"version": "1.2.3"` in package.json

### Missing metadata files

If builds fail with "Missing release/latest\*.yml":

- Check electron-builder configuration in `package.json`
- Ensure targets include both installers and update-friendly formats (zip for macOS, nsis for Windows)

### AWS CLI errors

All GitHub-hosted runners have AWS CLI pre-installed. If you see AWS CLI errors:

- Verify R2 secrets are correctly set
- Check R2 endpoint format: `https://<account-id>.r2.cloudflarestorage.com`
- Ensure bucket name matches exactly

## Architecture

### Two-Stage Build

The workflow uses a two-stage approach to prevent partial releases:

1. **Build stage** (parallel matrix):
   - macOS, Windows, Linux build in parallel
   - Each validates its update metadata
   - Uploads to GitHub Actions artifacts

2. **Publish stage** (single job):
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
