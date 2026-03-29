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
    - "Browser partition does not apply localhost-only CSP to external page responses"
    - "Dev-preview partitions still get localhost-only CSP via onHeadersReceived"
  artifacts:
    - path: "electron/setup/protocols.ts"
      provides: "Partition-aware navigation filtering and CSP scoping for webview guests"
      contains: "isBrowserPartition"
    - path: "electron/setup/__tests__/protocols.test.ts"
      provides: "Tests for cross-origin navigation allowance in browser partition and CSP scoping"
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

Purpose: When a localhost app initiates an OAuth flow (e.g., redirecting to accounts.google.com), the webview's will-navigate handler blocks the cross-origin navigation. Additionally, the persist:browser session applies a localhost-only CSP via onHeadersReceived, which rewrites response headers on external pages — breaking OAuth provider pages even if navigation were allowed. The fix: (1) allows same-window cross-origin navigations in persist:browser webviews while maintaining security for dev-preview webviews, and (2) removes CSP header rewriting from the browser partition so external sites keep their own CSP.

Output: Updated navigation filtering that is partition-aware, CSP scoped to dev-preview only, with tests proving OAuth-style flows work.
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
  <name>Task 1: Remove browser CSP, add isSafeNavigationUrl, make navigation filtering partition-aware</name>
  <files>
    shared/utils/urlUtils.ts
    electron/setup/protocols.ts
  </files>
  <action>
1. In `shared/utils/urlUtils.ts`, add a new exported function `isSafeNavigationUrl(url: string): boolean` that returns true if the URL uses http: or https: protocol (blocking javascript:, data:, file:, about:, blob:, and empty strings). This is a weaker check than `isLocalhostUrl` -- it allows any http/https URL but blocks dangerous protocols.

2. In `electron/setup/protocols.ts`, make TWO changes:

**Change A — Remove CSP for browser partition (BLOCKER FIX):**
The `applyCSP("persist:browser")` call at line 146 applies `getLocalhostDevCSP()` to the browser session's `onHeadersReceived`. This rewrites CSP headers on ALL responses — including external OAuth pages — with a localhost-only policy, breaking them. Remove this line entirely. Browser panels should behave like a real browser where external sites keep their own CSP headers. Dev-preview partitions still get the localhost CSP via the dynamic `will-attach-webview` path. Add a comment explaining why browser is excluded:

```typescript
// Browser partition intentionally excluded from CSP rewriting.
// Browser panels load external sites (OAuth, docs, etc.) that need their own CSP.
// Dev-preview partitions get localhost-only CSP via will-attach-webview below.
```

**Change B — Partition-aware navigation filtering (session comparison approach):**
Modify the `will-navigate` and `will-redirect` handlers (lines 173-185) to be partition-aware:

- Import `isSafeNavigationUrl` from `../../shared/utils/urlUtils.js`.
- At the top of `setupWebviewCSP()`, create a reference to the browser session singleton: `const browserSession = session.fromPartition("persist:browser")`. Electron's `session.fromPartition()` returns the same singleton for each partition, so object identity comparison (`===`) works.
- In the `will-navigate` handler (which fires on the **guest** webview contents), compare `contents.session === browserSession` to determine if this is a browser panel. This avoids the partitionMap approach which had a contents identity mismatch (will-attach-webview fires on the embedder, not the guest).
- For browser panel webviews (`contents.session === browserSession`): allow cross-origin navigations as long as the URL passes `isSafeNavigationUrl` (http/https only, no dangerous protocols).
- For all other webview partitions (dev-preview, etc.): keep the existing `isLocalhostUrl` restriction.
- Log allowed cross-origin navigations at debug level only when the URL is not localhost (to avoid log spam).

The key logic change in the will-navigate handler should be:

```typescript
// At the top of setupWebviewCSP():
const browserSession = session.fromPartition("persist:browser");

// Updated will-navigate handler (on guest webview contents):
contents.on("will-navigate", (event, navigationUrl) => {
  const isBrowserPanel = contents.session === browserSession;

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

NOTE: Session singleton comparison (`contents.session === browserSession`) is used instead of a partitionMap because `will-attach-webview` fires on the embedder contents while navigation handlers fire on the guest webview contents — they have different `contents.id` values. The session comparison works directly on the guest because `contents.session` returns the session the webview was created with, and `session.fromPartition()` returns the same singleton object.
</action>
<verify>
Run `npx vitest run shared/utils/__tests__/urlUtils.test.ts electron/setup/__tests__/protocols.test.ts --reporter=verbose 2>&1 | tail -30` to confirm existing tests still pass (some will fail until Task 2 updates them).
Run `npx tsc --noEmit 2>&1 | head -20` to confirm no type errors.
</verify>
<done> - `applyCSP("persist:browser")` removed — browser session no longer rewrites CSP headers on responses - `isSafeNavigationUrl` correctly allows http/https URLs and blocks javascript:, data:, file:, about:, blob:, empty strings - `will-navigate` and `will-redirect` handlers in protocols.ts are partition-aware using session singleton comparison - Browser partition webviews allow cross-origin http/https navigations - Dev-preview partition webviews still restrict to localhost only and still get localhost CSP - Session comparison (`contents.session === browserSession`) used — no partitionMap needed
</done>
</task>

<task type="auto">
  <name>Task 2: Update tests for partition-aware navigation, CSP scoping, and isSafeNavigationUrl</name>
  <files>
    electron/setup/__tests__/protocols.test.ts
    shared/utils/__tests__/urlUtils.test.ts
  </files>
  <action>
1. In `electron/setup/__tests__/protocols.test.ts`:

**Mock and helper updates:**

- Update the `MockWebContents` interface to include a `session` property with a mock session object, and an `id` field.
- In `createMockWebContents`, add a `session` parameter that defaults to a generic session mock. The session mock should be an object that can be compared by identity.
- Create `createBrowserWebview()` that calls `createMockWebContents("webview")` and sets its `session` to the mock browser session (matching what `session.fromPartition("persist:browser")` returns in the test mock — same object reference).
- Create `createDevPreviewWebview()` that calls `createMockWebContents("webview")` and sets its `session` to a DIFFERENT mock session object (simulating a dev-preview partition session).
- Ensure the `session.fromPartition` mock returns the browser session mock when called with `"persist:browser"` so the singleton comparison in the production code works.

**Update existing tests:**

- The `blocks navigation to https://example.com` test should now use a dev-preview webview (since browser partition would allow it).
- Add new test: `allows cross-origin navigation in browser partition` that creates a browser webview, navigates to `https://accounts.google.com/oauth`, and verifies `preventDefault` is NOT called.
- Add new test: `allows cross-origin redirect in browser partition` for will-redirect with `https://auth.provider.com/callback`.
- Add new test: `blocks cross-origin navigation in dev-preview partition` that creates a dev-preview webview, navigates to `https://example.com`, and verifies `preventDefault` IS called.
- Dangerous-protocol tests (javascript:, data:, file:, about:, empty string) should still pass — these block in BOTH partitions. For thoroughness, add a test that dangerous protocols are also blocked in browser partition.
- Keep localhost tests as-is (localhost always allowed in both partitions).
- Update the `logs blocked navigations` test to use a dev-preview partition since browser partition would allow the navigation.
- Update the `blocks non-localhost redirects` and `logs blocked redirects` tests to use dev-preview partition.

**Add CSP scoping tests:**

- Add a new `describe("CSP partition scoping")` block:
  - Test: `does not apply CSP to persist:browser session` — call `setupWebviewCSP()`, then verify that `session.fromPartition` was NOT called with `"persist:browser"` (or if called, that `onHeadersReceived` was not set on the browser session). The mock for `session.fromPartition` should track calls.
  - Test: `applies CSP to dev-preview partitions via will-attach-webview` — simulate a webview attachment with a dev-preview partition and verify `session.fromPartition` is called with that partition and `onHeadersReceived` is configured.

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
   - New tests verify CSP is NOT applied to persist:browser session
   - New tests verify CSP IS applied to dev-preview sessions
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
   - Dev-preview webviews get localhost-only CSP via onHeadersReceived
   - Browser partition does NOT get localhost-only CSP (external pages keep their own CSP)
   - setWindowOpenHandler still denies all popups (unchanged)
   - will-attach-webview still requires localhost src (unchanged)
   - Permission lockdown for browser session still denies all permissions (unchanged)
</verification>

<success_criteria>

- OAuth/OIDC redirect flows (localhost -> external auth provider -> localhost callback) work in browser panel webviews
- External pages in browser panel are not broken by localhost-only CSP rewriting
- Dev-preview webviews remain locked to localhost only with localhost CSP
- Dangerous protocol navigations (javascript:, data:, file:) blocked in all webviews
- All tests pass, npm run check clean
  </success_criteria>

<output>
After completion, create `.planning/quick/1-fix-integrated-browser-blocking-cross-or/1-SUMMARY.md`
</output>
