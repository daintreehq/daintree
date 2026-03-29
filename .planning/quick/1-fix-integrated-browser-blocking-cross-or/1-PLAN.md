---
phase: quick-1
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - electron/setup/protocols.ts
  - electron/setup/__tests__/protocols.test.ts
  - shared/utils/urlUtils.ts
  - shared/utils/__tests__/urlUtils.test.ts
autonomous: true
requirements: [INTENT-01]
formal_artifacts: none

must_haves:
  truths:
    - "OAuth/OIDC redirect flows work in the integrated browser (localhost -> auth provider -> localhost callback)"
    - "Cross-origin navigations are allowed in persist:browser webviews for same-window navigation"
    - "Cross-origin navigations remain blocked in dev-preview webviews"
    - "Dangerous protocols (javascript:, data:, file:, about:) remain blocked in all webviews"
    - "New window/popup cross-origin navigations remain blocked (setWindowOpenHandler unchanged)"
  artifacts:
    - path: "electron/setup/protocols.ts"
      provides: "Partition-aware navigation filtering for webview guests"
      contains: "isBrowserPartition"
    - path: "electron/setup/__tests__/protocols.test.ts"
      provides: "Tests for cross-origin navigation allowance in browser partition"
      contains: "allows cross-origin"
  key_links:
    - from: "electron/setup/protocols.ts"
      to: "shared/utils/urlUtils.ts"
      via: "isLocalhostUrl and isSafeNavigationUrl imports"
      pattern: "isSafeNavigationUrl"
    - from: "electron/setup/protocols.ts"
      to: "electron/utils/webviewCsp.ts"
      via: "classifyPartition for partition detection"
      pattern: "classifyPartition"
---

<objective>
Fix the integrated browser panel blocking cross-origin navigations that break OAuth/OIDC redirect flows.

Purpose: When a localhost app initiates an OAuth flow (e.g., redirecting to accounts.google.com), the webview's will-navigate handler blocks the cross-origin navigation. This makes OAuth flows unusable in the integrated browser. The fix allows same-window cross-origin navigations in persist:browser webviews while maintaining security for dev-preview webviews.

Output: Updated navigation filtering that is partition-aware, with tests proving OAuth-style flows work.
</objective>

<execution_context>
@.planning/quick/1-fix-integrated-browser-blocking-cross-or/scope-contract.json
</execution_context>

<context>
@electron/setup/protocols.ts
@electron/setup/__tests__/protocols.test.ts
@shared/utils/urlUtils.ts
@electron/utils/webviewCsp.ts
@electron/window/createWindow.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add isSafeNavigationUrl utility and make navigation filtering partition-aware</name>
  <files>
    shared/utils/urlUtils.ts
    electron/setup/protocols.ts
  </files>
  <action>
1. In `shared/utils/urlUtils.ts`, add a new exported function `isSafeNavigationUrl(url: string): boolean` that returns true if the URL uses http: or https: protocol (blocking javascript:, data:, file:, about:, blob:, and empty strings). This is a weaker check than `isLocalhostUrl` -- it allows any http/https URL but blocks dangerous protocols.

2. In `electron/setup/protocols.ts`, modify the `will-navigate` and `will-redirect` handlers (lines 173-185) to be partition-aware:
   - Import `classifyPartition` (already imported) and use it to check the webview's session partition.
   - Access the partition via `contents.session.partition` (Electron WebContents exposes this -- but TS types may not expose it, so cast as needed using `(contents.session as { partition?: string }).partition ?? ""`).
   - For `persist:browser` partition webviews: allow cross-origin navigations as long as the URL passes `isSafeNavigationUrl` (http/https only, no dangerous protocols).
   - For all other webview partitions (dev-preview, etc.): keep the existing `isLocalhostUrl` restriction.
   - Update the import to include `isSafeNavigationUrl` from `../../shared/utils/urlUtils.js`.
   - Log allowed cross-origin navigations at debug level: `console.log(\`[MAIN] Allowed cross-origin webview navigation: ${navigationUrl}\`)` only when the URL is not localhost (to avoid log spam for normal navigation).

The key logic change in the will-navigate handler should be:
```typescript
contents.on("will-navigate", (event, navigationUrl) => {
  const partition = (contents.session as { partition?: string }).partition ?? "";
  const isBrowserPanel = classifyPartition(partition) === "browser";

  if (isBrowserPanel) {
    // Browser panels allow cross-origin for OAuth/OIDC flows, but block dangerous protocols
    if (!isSafeNavigationUrl(navigationUrl)) {
      console.warn(`[MAIN] Blocked webview navigation to unsafe URL: ${navigationUrl}`);
      event.preventDefault();
    }
  } else {
    // Dev-preview and other webviews: localhost only
    if (!isLocalhostUrl(navigationUrl)) {
      console.warn(`[MAIN] Blocked webview navigation to non-localhost URL: ${navigationUrl}`);
      event.preventDefault();
    }
  }
});
```

Apply the same pattern to the `will-redirect` handler.
  </action>
  <verify>
    Run `npx vitest run shared/utils/__tests__/urlUtils.test.ts electron/setup/__tests__/protocols.test.ts --reporter=verbose 2>&1 | tail -30` to confirm existing tests still pass (some will fail until Task 2 updates them).
    Run `npx tsc --noEmit 2>&1 | head -20` to confirm no type errors.
  </verify>
  <done>
    - `isSafeNavigationUrl` correctly allows http/https URLs and blocks javascript:, data:, file:, about:, blob:, empty strings
    - `will-navigate` and `will-redirect` handlers in protocols.ts are partition-aware
    - Browser partition webviews allow cross-origin http/https navigations
    - Dev-preview partition webviews still restrict to localhost only
  </done>
</task>

<task type="auto">
  <name>Task 2: Update tests for partition-aware navigation and add isSafeNavigationUrl tests</name>
  <files>
    electron/setup/__tests__/protocols.test.ts
    shared/utils/__tests__/urlUtils.test.ts
  </files>
  <action>
1. In `electron/setup/__tests__/protocols.test.ts`:
   - Update the mock `MockWebContents` interface to include a `session` property with `partition` string.
   - In `createMockWebContents`, add a `session` property: `session: { partition: "" }`. Add an optional parameter to set the partition (default empty string).
   - Create a helper `createBrowserWebview()` that calls `createMockWebContents("webview")` and sets `session.partition = "persist:browser"`.
   - Create a helper `createDevPreviewWebview()` that calls `createMockWebContents("webview")` and sets `session.partition = "persist:dev-preview-abc"`.

   Update existing tests:
   - Tests that previously expected cross-origin URLs like `https://example.com` to be BLOCKED should be split: one test for browser partition (expects ALLOWED) and one for dev-preview partition (expects BLOCKED).
   - The `blocks navigation to https://example.com` test should now test with a dev-preview webview.
   - Add new test: `allows cross-origin navigation in browser partition` that navigates to `https://accounts.google.com/oauth` and verifies `preventDefault` is NOT called.
   - Add new test: `allows cross-origin redirect in browser partition` for will-redirect.
   - Add new test: `blocks cross-origin navigation in dev-preview partition`.
   - Keep the dangerous-protocol tests (javascript:, data:, file:, about:) -- these should still block in BOTH browser and dev-preview partitions. Update these to test both partition types.
   - Keep the localhost tests as-is (localhost should always be allowed in both partitions).
   - Update the `logs blocked navigations` test to use a dev-preview partition since browser partition would allow the navigation.

2. In `shared/utils/__tests__/urlUtils.test.ts` (create if it doesn't exist, or add to existing):
   - Add a `describe("isSafeNavigationUrl")` block with tests:
     - `returns true for http://example.com`
     - `returns true for https://accounts.google.com/oauth`
     - `returns true for http://localhost:3000`
     - `returns false for javascript:alert(1)`
     - `returns false for data:text/html,<h1>XSS</h1>`
     - `returns false for file:///etc/passwd`
     - `returns false for about:blank`
     - `returns false for empty string`
     - `returns false for blob:...`
  </action>
  <verify>
    Run `npx vitest run shared/utils/__tests__/urlUtils.test.ts electron/setup/__tests__/protocols.test.ts --reporter=verbose 2>&1 | tail -40` -- all tests pass.
    Run `npm run check 2>&1 | tail -10` -- typecheck, lint, format all pass.
  </verify>
  <done>
    - All existing security tests still pass (dangerous protocols blocked in all partitions)
    - New tests verify cross-origin http/https navigation is allowed in browser partition
    - New tests verify cross-origin navigation is blocked in dev-preview partition
    - isSafeNavigationUrl has dedicated unit tests
    - npm run check passes clean
  </done>
</task>

</tasks>

<verification>
1. `npm run check` passes (typecheck + lint + format)
2. `npx vitest run shared/utils/__tests__/urlUtils.test.ts electron/setup/__tests__/protocols.test.ts` -- all tests pass
3. Security invariants maintained:
   - javascript:, data:, file:, about: URLs blocked in ALL webviews
   - Dev-preview webviews restricted to localhost only
   - setWindowOpenHandler still denies all popups (unchanged)
   - will-attach-webview still requires localhost src (unchanged)
   - Permission lockdown for browser session still denies all permissions (unchanged)
</verification>

<success_criteria>
- OAuth/OIDC redirect flows (localhost -> external auth provider -> localhost callback) work in browser panel webviews
- Dev-preview webviews remain locked to localhost only
- Dangerous protocol navigations (javascript:, data:, file:) blocked in all webviews
- All tests pass, npm run check clean
</success_criteria>

<output>
After completion, create `.planning/quick/1-fix-integrated-browser-blocking-cross-or/1-SUMMARY.md`
</output>
