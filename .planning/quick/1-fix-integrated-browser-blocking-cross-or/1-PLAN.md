---
phase: quick-1
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - electron/setup/protocols.ts
  - electron/setup/__tests__/protocols.test.ts
  - electron/ipc/channels.ts
  - shared/types/ipc/maps.ts
  - shared/types/ipc/api.ts
  - electron/preload.cts
  - src/components/Browser/BrowserPane.tsx
autonomous: true
requirements: [INTENT-01]
formal_artifacts: none

must_haves:
  truths:
    - "Blocked cross-origin navigations in webview guests are surfaced to the user via IPC notification"
    - "User is offered the option to open the blocked URL in the system browser"
    - "The localhost-only navigation restriction remains intact (TOCTOU guard preserved)"
    - "Dangerous protocols (javascript:, data:, file:, about:) are blocked silently (no offer to open externally)"
    - "Only http/https blocked URLs are offered for external opening (safe protocols)"
  artifacts:
    - path: "electron/setup/protocols.ts"
      provides: "IPC notification when cross-origin navigation is blocked in webview"
      contains: "WEBVIEW_NAVIGATION_BLOCKED"
    - path: "src/components/Browser/BrowserPane.tsx"
      provides: "UI handling for blocked navigation notification with open-external action"
      contains: "navigation-blocked"
  key_links:
    - from: "electron/setup/protocols.ts"
      to: "electron/ipc/channels.ts"
      via: "WEBVIEW_NAVIGATION_BLOCKED channel constant"
      pattern: "WEBVIEW_NAVIGATION_BLOCKED"
    - from: "src/components/Browser/BrowserPane.tsx"
      to: "electron/utils/openExternal.ts"
      via: "window.electron IPC to open URL externally"
      pattern: "openExternal"
---

<objective>
Surface blocked cross-origin navigations to the user instead of silently swallowing them.

Purpose: The localhost-only navigation restriction is intentional (TOCTOU security fix from PR #3727) and correct per RFC 8252 (OAuth in embedded webviews is prohibited). However, blocked navigations currently fail silently with only a console.warn. The fix surfaces these blocks to the user with an offer to open the URL in the system browser, where OAuth/SSO sessions, cookies, and password managers work properly.

Output: When a webview navigation is blocked, the renderer receives an IPC message and shows a notification bar in the browser panel offering to open the URL externally.
</objective>

<execution_context>
@.planning/quick/1-fix-integrated-browser-blocking-cross-or/scope-contract.json
</execution_context>

<context>
@electron/setup/protocols.ts
@electron/setup/__tests__/protocols.test.ts
@electron/ipc/channels.ts
@shared/types/ipc/maps.ts
@electron/preload.cts
@src/types/electron.d.ts
@src/components/Browser/BrowserPane.tsx
@electron/utils/openExternal.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add IPC channel and send blocked-navigation notifications from main process</name>
  <files>
    electron/ipc/channels.ts
    shared/types/ipc/maps.ts
    shared/types/ipc/api.ts
    electron/setup/protocols.ts
    electron/preload.cts
  </files>
  <action>
1. In `electron/ipc/channels.ts`, add a new channel constant in the WEBVIEW section:
   ```
   WEBVIEW_NAVIGATION_BLOCKED: "webview:navigation-blocked",
   ```

2. In `shared/types/ipc/maps.ts`, add the event type in the appropriate map (near the other webview events):

   ```typescript
   "webview:navigation-blocked": {
     panelId: string;
     url: string;
     canOpenExternal: boolean;
   };
   ```

   `canOpenExternal` is true only for http/https URLs (safe to open in system browser). False for dangerous protocols like javascript:, data:, etc.

3. In `electron/setup/protocols.ts`, modify the `will-navigate` handler (lines 173-178):
   - Import `canOpenExternalUrl` from `../utils/openExternal.js` (add to existing imports).
   - Import `getMainWindow` (already imported) and `CHANNELS` (already imported).
   - `getWebviewDialogService` is already imported — use `getPanelId(contents.id)` to resolve the panelId for the webview.
   - When a non-localhost navigation is blocked, after `event.preventDefault()`, also send an IPC message to the renderer:

   ```typescript
   contents.on("will-navigate", (event, navigationUrl) => {
     if (!isLocalhostUrl(navigationUrl)) {
       console.warn(`[MAIN] Blocked webview navigation to non-localhost URL: ${navigationUrl}`);
       event.preventDefault();

       // Notify renderer so the user can choose to open in system browser
       const panelId = getWebviewDialogService().getPanelId(contents.id);
       if (panelId) {
         const mainWindow = getMainWindow();
         if (mainWindow && !mainWindow.isDestroyed()) {
           mainWindow.webContents.send(CHANNELS.WEBVIEW_NAVIGATION_BLOCKED, {
             panelId,
             url: navigationUrl,
             canOpenExternal: canOpenExternalUrl(navigationUrl),
           });
         }
       }
     }
   });
   ```

   Apply the same pattern to the `will-redirect` handler.

4. In `electron/preload.cts`, add a listener registration for the new channel in the `webview` namespace (where other webview IPC listeners like `onDialogRequest` and `onFindShortcut` live). Add an `onNavigationBlocked` method following the same pattern:

   ```typescript
   onNavigationBlocked: (callback: (data: { panelId: string; url: string; canOpenExternal: boolean }) => void) => {
     const listener = (_event: IpcRendererEvent, data: { panelId: string; url: string; canOpenExternal: boolean }) => callback(data);
     ipcRenderer.on("webview:navigation-blocked", listener);
     return () => { ipcRenderer.removeListener("webview:navigation-blocked", listener); };
   },
   ```

5. In `shared/types/ipc/api.ts` (line ~795, in the `webview` namespace — NOT in `src/types/electron.d.ts`), add the type declaration:

   ```typescript
   /** Subscribe to blocked navigation events from webview guests */
   onNavigationBlocked(
     callback: (payload: { panelId: string; url: string; canOpenExternal: boolean }) => void
   ): () => void;
   ```

   IMPORTANT: The API types for `window.electron` live in `shared/types/ipc/api.ts`, not `src/types/electron.d.ts`. Follow the existing pattern used by `onDialogRequest`, `onFindShortcut`, etc.

6. Handle the pre-registration race: `WebviewDialogService.panelMap` is populated from the renderer via `registerPanel()` after the webview is ready (`useWebviewDialog.ts`). An early blocked redirect before registration completes would have no panelId — the `if (panelId)` guard already handles this gracefully (no IPC sent). This is acceptable: early redirects during webview initialization are rare, and the silent fallback matches the existing dialog behavior. No special handling needed.
   </action>
   <verify>
   Run `npx tsc --noEmit 2>&1 | head -20` to confirm no type errors.
   </verify>
   <done> - WEBVIEW_NAVIGATION_BLOCKED channel defined - IPC type map includes the event shape - will-navigate and will-redirect handlers send IPC notification on block - Preload bridge exposes onNavigationBlocked listener - Type declarations updated
   </done>
   </task>

<task type="auto">
  <name>Task 2: Handle blocked-navigation notification in BrowserPane with notification bar</name>
  <files>
    src/components/Browser/BrowserPane.tsx
  </files>
  <action>
1. In `BrowserPane.tsx`, add state for a blocked navigation notification:
   ```typescript
   const [blockedNav, setBlockedNav] = useState<{ url: string; canOpenExternal: boolean } | null>(null);
   ```

2. Add a useEffect that listens for the `onNavigationBlocked` IPC event, filtered to this panel's ID:

   ```typescript
   useEffect(() => {
     const cleanup = window.electron.webview.onNavigationBlocked((data) => {
       if (data.panelId === panelId) {
         setBlockedNav({ url: data.url, canOpenExternal: data.canOpenExternal });
       }
     });
     return cleanup;
   }, [panelId]);
   ```

3. Add a notification bar UI element that appears when `blockedNav` is non-null. Position it at the top of the browser content area (below any existing toolbar/URL bar). Style it as a subtle info bar:
   - Background: use a warning/info semantic color from the theme (e.g., `bg-yellow-900/20` or similar Tailwind class that works with dark theme)
   - Show a truncated version of the blocked URL
   - If `canOpenExternal` is true: show an "Open in Browser" button that calls `window.electron.system.openExternal(blockedNav.url)` (or however the existing open-external IPC works in the renderer)
   - Show a dismiss "×" button that sets `blockedNav` to null
   - Auto-dismiss after ~10 seconds using a timeout (clear on unmount or new notification)

   Example UI structure:

   ```tsx
   {
     blockedNav && (
       <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-200">
         <span className="truncate flex-1">Navigation blocked: {blockedNav.url}</span>
         {blockedNav.canOpenExternal && (
           <button
             onClick={() => {
               window.electron.system.openExternal(blockedNav.url);
               setBlockedNav(null);
             }}
             className="shrink-0 px-2 py-0.5 rounded bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-100"
           >
             Open in Browser
           </button>
         )}
         <button
           onClick={() => setBlockedNav(null)}
           className="shrink-0 text-yellow-400 hover:text-yellow-200"
         >
           ×
         </button>
       </div>
     );
   }
   ```

4. Look at the existing `openExternal` pattern in the codebase — check `window.electron.system.openExternal` or `window.electron.browser.openExternal` and use whichever exists. If neither exists, use the IPC channel for opening external URLs that the portal/browser already uses.
   </action>
   <verify>
   Run `npx tsc --noEmit 2>&1 | head -20` — no type errors.
   Run `npm run check 2>&1 | tail -10` — typecheck + lint + format pass.
   </verify>
   <done> - BrowserPane shows a notification bar when a cross-origin navigation is blocked - User can click "Open in Browser" to open the URL in system browser - Notification auto-dismisses after 10 seconds - Notification can be manually dismissed - Only shows "Open in Browser" for safe (http/https) URLs
   </done>
   </task>

<task type="auto">
  <name>Task 3: Update tests for blocked-navigation IPC notification</name>
  <files>
    electron/setup/__tests__/protocols.test.ts
  </files>
  <action>
1. In `electron/setup/__tests__/protocols.test.ts`, update existing tests and add new ones:

**Update mocks:**

- Ensure the `getMainWindow` mock returns a window with `webContents.send` that can be spied on.
- Ensure the `getWebviewDialogService().getPanelId` mock returns a panelId for the webview contents.

**Update existing blocked navigation test:**

- The existing test that verifies `https://example.com` is blocked should additionally verify that `mainWindow.webContents.send` was called with `"webview:navigation-blocked"` and the correct payload `{ panelId, url: "https://example.com", canOpenExternal: true }`.

**Add new tests:**

- `sends navigation-blocked IPC when cross-origin navigation is blocked`: Block a navigation to `https://accounts.google.com`, verify IPC sent with `canOpenExternal: true`.
- `sends navigation-blocked IPC when cross-origin redirect is blocked`: Block a redirect, verify IPC sent.
- `does not send navigation-blocked IPC for localhost navigations`: Navigate to `http://localhost:3000`, verify NO IPC sent (navigation allowed).
- `sends canOpenExternal false for javascript: URLs`: Block `javascript:alert(1)`, verify IPC sent with `canOpenExternal: false`.
- `does not send navigation-blocked IPC when panelId is not found`: Mock `getPanelId` to return undefined, verify no IPC sent (but navigation still blocked).
  </action>
  <verify>
  Run `npx vitest run electron/setup/__tests__/protocols.test.ts --reporter=verbose 2>&1 | tail -30` — all tests pass.
  Run `npm run check 2>&1 | tail -10` — all checks pass.
  </verify>
  <done>
- Existing blocked-navigation tests updated to verify IPC notification
- New tests cover IPC payload correctness
- Tests verify canOpenExternal flag logic
- Tests verify no notification when panelId not found
- All tests pass, npm run check clean
  </done>
  </task>

</tasks>

<verification>
1. `npm run check` passes (typecheck + lint + format)
2. `npx vitest run electron/setup/__tests__/protocols.test.ts` -- all tests pass
3. Security invariants maintained:
   - Localhost-only navigation restriction PRESERVED (TOCTOU guard intact)
   - All dangerous protocol navigations still blocked
   - setWindowOpenHandler still denies all popups (unchanged)
   - will-attach-webview still requires localhost src (unchanged)
   - CSP unchanged
4. UX improvement: blocked navigations surface to user with actionable "Open in Browser" option
</verification>

<success_criteria>

- Blocked cross-origin navigations show a notification bar in the browser panel
- User can open blocked URL in system browser with one click
- Dangerous protocol URLs (javascript:, data:) are blocked without offering external open
- Notification auto-dismisses and can be manually dismissed
- All existing security restrictions remain intact
- All tests pass, npm run check clean
  </success_criteria>

<output>
After completion, create `.planning/quick/1-fix-integrated-browser-blocking-cross-or/1-SUMMARY.md`
</output>
