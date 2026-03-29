---
phase: quick-1
plan: 01
subsystem: electron/setup
tags: [browser, security, oauth, csp, navigation, webview]
dependency_graph:
  requires: []
  provides: [partition-aware-navigation-filtering, safe-navigation-url-util]
  affects: [electron/setup/protocols.ts, shared/utils/urlUtils.ts]
tech_stack:
  added: []
  patterns: [session-singleton-identity-comparison, partition-aware-security-policy]
key_files:
  created: []
  modified:
    - electron/setup/protocols.ts
    - electron/setup/__tests__/protocols.test.ts
    - shared/utils/urlUtils.ts
    - shared/utils/__tests__/urlUtils.test.ts
decisions:
  - "Use contents.session === browserSession identity comparison instead of partitionMap — avoids embedder/guest contents ID mismatch from will-attach-webview"
  - "Remove applyCSP('persist:browser') entirely — browser panels load external sites that must keep their own CSP headers"
  - "isSafeNavigationUrl allows any http/https URL, blocks only dangerous protocols — weaker than isLocalhostUrl by design"
metrics:
  duration: ~15min
  completed: "2026-03-29T13:25:07Z"
  tasks_completed: 2
  files_modified: 4
---

# Quick Task 1: Fix Integrated Browser Blocking Cross-Origin Navigation — Summary

**One-liner:** Partition-aware navigation filtering using session singleton comparison — browser panels now allow cross-origin http/https for OAuth/OIDC flows while dev-preview retains localhost-only lockdown.

## What Was Done

### Task 1: Remove browser CSP, add isSafeNavigationUrl, make navigation filtering partition-aware

**Commit:** a8a6f3b1

**Changes:**

1. `shared/utils/urlUtils.ts` — Added `isSafeNavigationUrl(url: string): boolean` that returns true for http/https URLs and false for all dangerous protocols (javascript:, data:, file:, about:, blob:) and empty strings.

2. `electron/setup/protocols.ts` — Two changes:
   - Removed `applyCSP("persist:browser")` call. Browser panels load external sites (OAuth providers, docs) that need their own CSP. Adding a localhost-only CSP to the browser session was rewriting all response headers on external pages, breaking OAuth provider flows even before the navigation fix was in place.
   - Created `browserSession = session.fromPartition("persist:browser")` singleton at the top of `setupWebviewCSP()`. The `will-navigate` and `will-redirect` handlers now compare `contents.session === browserSession` to distinguish browser panel webviews from dev-preview webviews. Browser panels allow any `isSafeNavigationUrl()` URL; all other partitions retain the existing `isLocalhostUrl()` restriction.

### Task 2: Update tests for partition-aware behavior, CSP scoping, and isSafeNavigationUrl

**Commit:** 719746f3

**Changes:**

1. `electron/setup/__tests__/protocols.test.ts`:
   - Added `MockSession` interface with stable `mockBrowserSession` singleton (same object reference the production code gets from `session.fromPartition("persist:browser")`).
   - Updated `session.fromPartition` mock to return the singleton for `"persist:browser"` and a fresh session for all other partitions.
   - Added `createBrowserWebview()` and `createDevPreviewWebview()` helpers that set `session` appropriately.
   - Updated existing cross-origin block tests to use dev-preview webviews (the behavior is unchanged for those).
   - Added: allows cross-origin navigation in browser partition, allows cross-origin redirect in browser partition, blocks cross-origin in dev-preview partition, blocks dangerous protocols in browser partition.
   - Added `describe("CSP partition scoping")` block: verifies browser session never gets `onHeadersReceived` configured, and dev-preview sessions do.
   - Added static imports (`electronSession`, `isDevPreviewPartitionMock`) to avoid `await import()` inside non-async test bodies.

2. `shared/utils/__tests__/urlUtils.test.ts`:
   - Added `describe("isSafeNavigationUrl")` with 9 test cases covering http/https (true) and dangerous protocols + empty string (false).

## Security Invariants Maintained

- javascript:, data:, file:, about:, blob: protocols blocked in ALL webview partitions
- Dev-preview webviews restricted to localhost only (unchanged)
- Dev-preview webviews get localhost-only CSP via `will-attach-webview` (unchanged)
- Browser partition does NOT get localhost-only CSP (fixed — was the second blocker)
- `setWindowOpenHandler` still denies all popups (unchanged)
- `will-attach-webview` still validates src at attachment (unchanged)
- Permission lockdown for browser session unchanged

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- `electron/setup/protocols.ts` — modified, committed in a8a6f3b1
- `shared/utils/urlUtils.ts` — modified, committed in a8a6f3b1
- `electron/setup/__tests__/protocols.test.ts` — modified, committed in 719746f3
- `shared/utils/__tests__/urlUtils.test.ts` — modified, committed in 719746f3
- All 71 tests pass
- `npm run check` clean (typecheck + lint — format warnings are pre-existing .planning/ files)

## Self-Check: PASSED
