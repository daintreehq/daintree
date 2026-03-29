# Quick Task 1: Surface Blocked Cross-Origin Browser Navigations

## Objective

Surface blocked cross-origin navigations in the integrated browser to the user with an actionable "Open in Browser" option, instead of silently swallowing them.

## Context

The localhost-only navigation restriction is intentional (TOCTOU security fix from PR #3727) and correct per RFC 8252 (OAuth in embedded webviews is prohibited). The original issue (#4563) reported this as a bug, but the main dev clarified the restriction is by design. The actual problem is the silent failure — blocked navigations produce only a `console.warn` with no user-visible feedback.

## Changes

### Task 1: IPC plumbing + notification dispatch

- **electron/ipc/channels.ts**: Added `WEBVIEW_NAVIGATION_BLOCKED` channel constant
- **shared/types/ipc/maps.ts**: Added event type `{ panelId, url, canOpenExternal }`
- **shared/types/ipc/api.ts**: Added `onNavigationBlocked` to webview API type
- **electron/preload.cts**: Added `onNavigationBlocked` listener + channel constant
- **electron/setup/protocols.ts**: Modified `will-navigate` and `will-redirect` handlers to send IPC notification when blocking, with `canOpenExternal` flag from `canOpenExternalUrl()`

### Task 2: BrowserPane notification bar

- **src/components/Browser/BrowserPane.tsx**: Added `blockedNav` state, IPC listener effect, auto-dismiss timer (10s), and notification bar UI with:
  - Blocked URL display (truncated)
  - "Open in Browser" button (only for http/https URLs)
  - Dismiss button
  - Warning-themed styling

### Task 3: Tests

- **electron/setup/**tests**/protocols.test.ts**: Added 5 new tests for IPC notification:
  - Sends notification with `canOpenExternal: true` for https URLs
  - Sends notification for blocked redirects
  - Does not send for localhost navigations
  - Sends `canOpenExternal: false` for javascript: URLs
  - Does not send when panelId is not found

## Security Invariants Preserved

- Localhost-only navigation restriction unchanged (TOCTOU guard intact)
- All dangerous protocol navigations still blocked
- `setWindowOpenHandler` deny-all unchanged
- `will-attach-webview` localhost src validation unchanged
- CSP unchanged
- Permission lockdown unchanged

## Commits

- `d04e6414` fix(browser): surface blocked cross-origin navigations with Open in Browser action
- `9219d16c` test(browser): add tests for blocked navigation IPC notification

## Test Results

- 21/21 tests passing in protocols.test.ts
- Typecheck clean
- Lint ratchet clean (405 warnings, no increase)
