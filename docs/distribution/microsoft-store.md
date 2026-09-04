# Microsoft Store distribution

## Overview

The Microsoft Store is one of two Windows distribution channels. The `.github/workflows/release-windows.yml` workflow (one of the three per-OS app-release workflows — #8052; `release-packages.yml` is a fourth workflow but publishes the plugin npm packages on their own tags, not the app) builds an x64 `.appx` package for the Store on tag push, archives it to Cloudflare R2 (the macOS / Linux binaries land there independently from their own workflows), and submits it to Microsoft Store certification via the [`msstore`](https://github.com/microsoft/msstore-cli) CLI — provided in-workflow by the `microsoft/microsoft-store-apppublisher@v1.3` action, not a manual download. The submission step runs `msstore reconfigure` with the four Entra credential flags, then `msstore publish . --appId <productId> --inputDirectory .\release`.

Alongside the Store `.appx`, the same workflow also ships NSIS `.exe` installers — x64 (built on `windows-latest`) and native arm64 (built on `windows-11-arm`) — which are the non-Store Windows distribution path, auto-updated via electron-updater. The `.appx` is x64-only. So the Store package is one of several Windows release artifacts, not the sole output.

Microsoft re-signs the package after certification with a Microsoft-issued certificate, so no Authenticode certificate is needed. End-user updates are delivered through the Store, not electron-updater. Mac and Linux distribution paths are unchanged.

The release pipeline degrades gracefully when the Store secrets are not yet configured: the `.appx` is still built and archived to R2, the submission step is skipped with a `::notice::` line, and the rest of the release proceeds. This lets the engineering land before the Partner Center account finishes verification.

## One-time Partner Center setup

Manual setup is unavoidable — Microsoft does not allow programmatic creation of new app listings. The first submission must happen by hand before the API can drive subsequent updates.

1. **Sign up** at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com) as an individual (free for individual and company accounts as of 2026). Identity verification is selfie + government-issued ID.
2. **Reserve the app name** "Daintree" in Partner Center.
3. **Note the assigned Identity Name and Publisher** (Publisher is a `CN=…GUID` string). These get pasted into `electron-builder.config.cjs` as `appx.identityName` and `appx.publisher`.
4. **Complete the IARC age-rating questionnaire**, privacy policy URL, screenshots, and store listing copy. Submission notes should disclose that the app executes user-initiated commands via an integrated terminal and that AI-agent recipes can drive shell commands with explicit user confirmation (see [Listing copy](#listing-copy) below).
5. **Submit one initial placeholder MSIX** by hand. Wait for it to certify — this moves the app out of "Draft" state and unlocks the submission API.
6. **Fill out the W-8BEN tax form** in Partner Center (US-Australia tax treaty). Required even for free apps if there's any chance of monetization later. AU developers can also add an ABN under Payout and tax profile for cleaner GST handling.

## Microsoft Entra app registration (for automation)

The msstore CLI (installed in-workflow by the `microsoft/microsoft-store-apppublisher@v1.3` action) authenticates against Partner Center using a Microsoft Entra (Azure AD) service principal — not personal credentials.

1. In the Microsoft Entra admin center, **register a new application** (single-tenant is fine).
2. **Generate a client secret** under Certificates & secrets. Copy the value immediately — it is only shown once.
3. In Partner Center, **assign the Entra application** the Manager or Developer role under Account settings → User management.
4. Copy the four values you'll need:
   - **Tenant ID** (Microsoft Entra Overview)
   - **Client ID** (the registered app's Application ID)
   - **Client secret** (the value from step 2)
   - **Seller ID** (Partner Center → Account settings → identifiers)
5. Note the **Store Product ID** for Daintree (Partner Center → Daintree → Product Identity). This identifies the app the submission targets.

## GitHub secrets

Add the following to the GitHub repository under Settings → Secrets and variables → Actions. Until all five exist, the release workflow builds the `.appx` and archives it to R2 but skips Store submission.

| Secret | Description |
| --- | --- |
| `PARTNER_CENTER_TENANT_ID` | Microsoft Entra tenant ID of the directory that owns the Entra app registration |
| `PARTNER_CENTER_SELLER_ID` | Partner Center Seller ID (Account settings → Identifiers) |
| `PARTNER_CENTER_CLIENT_ID` | Application (client) ID of the Entra app registration |
| `PARTNER_CENTER_CLIENT_SECRET` | Client secret value from the Entra app registration |
| `STORE_PRODUCT_ID` | Partner Center Product ID for Daintree |

The existing R2 secrets (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `DAINTREE_R2_BUCKET`) are still used to archive the `.appx` artifact alongside macOS / Linux binaries.

## Release flow

On a `v*` tag push:

1. The Windows workflow builds on `windows-latest` (x64) and `windows-11-arm` (arm64); macOS and Linux build in their own per-OS workflows.
2. The x64 build runs `electron-builder --config electron-builder.config.cjs --win appx nsis --x64`, producing both the Store `.appx` and an NSIS `.exe`. The arm64 build runs `--win nsis --arm64`, producing only the native arm64 NSIS `.exe`.
3. WACK runs against the `.appx` as a best-effort smoke test (does not fail the build — Microsoft re-runs WACK during certification).
4. The `.appx`, the NSIS `.exe` installers, and update metadata are uploaded as workflow artifacts and synced to R2 alongside `*.dmg`, `*.zip`, `*.AppImage`, `*.deb`.
5. **If all five PARTNER*CENTER*\*/STORE_PRODUCT_ID secrets are present**: the workflow runs `msstore reconfigure` (with the four credential flags) then `msstore publish . --appId <productId> --inputDirectory .\release`. The submit step is `continue-on-error` — a failed submission warns in the step summary but doesn't fail the release. Store certification typically takes 2–24 hours.
6. **If any of the five secrets is missing**: the submission step is skipped with a `::notice::` log line and the release otherwise completes normally. R2 sync still happens.

This means the migration code can be merged before the Partner Center account is verified — releases continue to function, the `.appx` artifact lives on R2, and Store submission auto-engages the moment the secrets are added.

## Local packaging

To produce a `.appx` locally (e.g. for the initial manual Partner Center submission):

```bash
npm run build && npx electron-builder --win appx --publish never
```

The output lands in `release/`. To upload it manually to Partner Center:

1. Sign into Partner Center.
2. Navigate to Daintree → Submissions → New submission → Packages.
3. Drag the `.appx` into the package upload area. The first submission requires a real package, not a placeholder — but a development build with a placeholder description is fine for the gate-clearing submission.

## electron-builder appx config

The `appx` block in `electron-builder.config.cjs` carries identity values that must match Partner Center exactly:

```js
appx: {
  identityName: "GregPriday.Daintree",          // from Partner Center Product Identity
  publisher: "CN=<publisher GUID>",             // from Partner Center Product Identity
  publisherDisplayName: "Greg Priday",
  applicationId: "Daintree",
  displayName: "Daintree",
  languages: ["en-US"],
  setBuildNumber: true,                          // electron-builder stamps the MSIX build number
}
```

The identity values are populated in `electron-builder.config.cjs` today — the real `publisher` GUID is in the file; it is elided here rather than duplicated, since a copy in prose is one more place to drift.

A mismatch between `identityName` / `publisher` and the Partner Center values fails `msstore submission update` with `Invalid Identity` / `package publisher must match the developer account's publisher identity`. Update the config in lockstep if Partner Center ever reissues the identity.

`electron-builder` automatically declares the `runFullTrust` restricted capability and defaults the entry point to `Windows.FullTrustApplication`, which is correct for Daintree (full-trust Win32 desktop app spawning shell processes via node-pty). No extra capability declarations are needed for the integrated terminal.

## Listing copy

Recommended submission notes / listing description, calibrated to the Microsoft Store developer-tools carve-out and the late-2025 generative-AI policy:

> Daintree is an Electron-based IDE for orchestrating AI coding agents. It includes an integrated terminal powered by xterm.js plus node-pty that runs the user's local shell (cmd.exe, PowerShell, pwsh) for user-initiated commands. Daintree includes optional AI-coding-agent recipes that can drive shell commands; agent execution is opt-in, scoped to the current worktree, and surfaces every command before running. The app does not execute shell commands in the background without explicit user action.

This framing is the difference between a clean review and a back-and-forth on the "apps that ship interpreters or shells" and "live generative AI technologies" policies.

## Troubleshooting

**`Invalid Identity` / `package publisher must match` on `msstore submission update`** — the `appx.identityName` or `appx.publisher` in `electron-builder.config.cjs` does not match Partner Center's Product Identity. Copy them verbatim from Partner Center → Daintree → Product Management → Product Identity.

**WACK fails on the hosted runner** — the WACK step is best-effort and uses `|| $true` to swallow failures. If WACK is consistently broken on `windows-latest`, drop the step. Microsoft re-runs WACK during certification, so the local check is convenience rather than load-bearing.

**ASAR integrity check fails after Store re-sign** — the Store re-signs the outer MSIX without modifying `app.asar`, so `enableEmbeddedAsarIntegrityValidation=true` should continue to work. If the first end-to-end Store-certified build fails the integrity check at runtime, set the fuse to `false` only for the Windows-Store build (electron-builder allows per-platform fuse overrides via the `electronFuses` config block).

**Certification rejection on policy 10.x (developer tools)** — usually means the listing description didn't disclose user-initiated command execution clearly enough. Reuse the [Listing copy](#listing-copy) boilerplate verbatim.

**`msstore` CLI subcommand grammar drift** — the CLI is in preview as of 2026 and command names have moved between releases. If the workflow's `msstore submission update / publish` calls fail with "unknown command," run `msstore --help` on the runner output to see the current grammar and update the workflow.

## Screenshots

Microsoft Store screenshots and the website hero are produced by the [`Marketing Screenshots`](../../.github/workflows/screenshots.yml) workflow on a `macos-14` GitHub-hosted runner. The capture spec is [`e2e/screenshots/store-reel.spec.ts`](../../e2e/screenshots/store-reel.spec.ts) — it boots Daintree against a different demo repo per scene (surge-checkout, brush-cms, daintree-site, launchpad-analytics, orbital-sync, mise-en-place) so each shot has its own title-bar identity.

**Capture pipeline.** Electron launches with `--force-device-scale-factor=2` (configurable via the workflow's `scale` input). The renderer paints at 2× device pixels, Playwright's `page.screenshot()` captures the framebuffer, and each PNG lands at `3840×1940` — at the Microsoft Store maximum. Scale `3` is also wired and produces a tighter zoom; use it when the UI fits the smaller logical viewport.

macOS is the only GitHub-hosted runner OS whose virtual display honors the scale flag (Windows + Linux runners cap at the OS display's physical pixels, ~1080p). Since Daintree's window is frameless, no OS chrome is captured — screenshots are content-identical across platforms, only resolution differs — so we capture only on macOS.

**Outputs.** PNGs land at `screenshots/<version>/` (e.g. `screenshots/0.9.2/01-hero-surge-checkout.png`) for tagged releases. Re-runs of the same version overwrite. The same set mirrors to `screenshots/latest/` on every push — the website pins to the `latest/` URLs and never needs to know the current version. PNGs are also attached as a workflow artifact for 90 days. The workflow fires automatically on every `v*` tag push (same trigger as the per-OS release workflows).

Stable URLs:

- Versioned: `https://updates.daintree.org/screenshots/<version>/<scene>.png`
- Latest: `https://updates.daintree.org/screenshots/latest/<scene>.png`

**Submission requirements (recap).** PNG only; sRGB; 16:9 landscape preferred; 1 minimum and 10 maximum per submission; 6–9 is typical for the developer-tools category. The reel ships exactly 6 scenes (scene 1 doubles as the Microsoft Store hero — earlier 7-shot attempts hit resource exhaustion on the cold 7th launch).

**Sanitization rules** that the demo repos enforce automatically:

- No API-key-shaped strings anywhere in the rendered window (`ANTHROPIC_API_KEY` is set via IPC and never appears in UI).
- No real-user paths — folder basenames are the project slugs, not tmpdir randomness.
- No third-party code excerpts — all demo content is original.

Pair the screenshots with the Policy 11.16 AI disclosure in the listing metadata; the listing copy in [`docs/distribution/microsoft-store.md#listing-copy`](#listing-copy) already covers it.

**Local iteration.** `npm run screenshots:dev` runs the same spec locally (on macOS or Linux). The PNGs land in `artifacts/screenshots/`. Local output is for layout iteration only — the canonical store assets are always the `macos-14` `Marketing Screenshots` workflow's output.

## References

- [Open a developer account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)
- [Create an app submission for your MSIX app](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission)
- [Microsoft Store Developer CLI](https://github.com/microsoft/msstore-cli) and its [GitHub Actions integration](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/github-actions)
- [Windows App Certification Kit](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-app-certification-kit)
- [Microsoft Store Policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)
- Internal: [`docs/release.md`](../release.md) (macOS signing, R2 publishing, the rest of the release pipeline)
- Internal: [`asar-integrity.md`](./asar-integrity.md) (the fuse the Store re-sign has to survive)
