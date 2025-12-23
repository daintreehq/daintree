# Terminal: Modifier-Click Links to Open in Canopy Browser

## Problem
Links in xterm currently always open externally via `system.openExternal` (Terminal link handlers in `src/services/terminal/TerminalInstanceService.ts` and `src/services/terminal/TerminalAddonManager.ts`). This breaks flow when the link is a local dev URL that the user wants to preview inside Canopy.

## Proposal
Add a modifier-click behavior for terminal links:
- Default click: open externally (existing behavior).
- Modifier-click (`Cmd` on macOS, `Ctrl` on Windows/Linux): open in a Canopy Browser panel (existing `browser` panel kind).

## UX
- When a link is clickable, show a subtle hint in the terminal context menu and/or Terminal settings:
  - “Cmd/Ctrl+Click opens in Canopy Browser”
- If a Browser panel already exists for the active worktree, reuse it (navigate it).
- Otherwise create a new Browser panel in the same worktree.

## Safety & URL Policy
- For v1, only allow opening **local** URLs in the iframe browser (`localhost`, `127.0.0.1`, `[::1]`, and optionally `*.local`), and keep everything else external.
- Reject non-http(s) schemes (`file:`, `javascript:`, etc.) and enforce `isValidBrowserUrl`.

## Implementation Notes
- The xterm WebLinks addon supplies `(event, uri)`; use the modifier state from the event to choose target.
- Add a small “open in Canopy browser” helper that:
  - Normalizes URL (`http://` default for bare hosts if needed).
  - Checks `isLocalBrowserUrl(url)` + existing `isValidBrowserUrl`.
  - Uses store actions to open/route the URL:
    - If there is an existing browser terminal in the same `worktreeId`, call `setBrowserUrl(existingId, url)` and focus it.
    - Else `addTerminal({ kind: "browser", browserUrl: url, worktreeId, cwd })`.

## Acceptance Criteria
- Cmd/Ctrl+click on `http://localhost:5173` opens it in a Browser panel scoped to the active worktree.
- Normal click behavior remains unchanged for all links.
- Non-local URLs still open externally unless a future setting enables “Open any URL in Browser panel”.

## Open Questions
- Should there be a settings toggle for “Prefer in-app browser for localhost links” (modifier optional)?
- If multiple Browser panels exist, should we prefer the most recently used, or the one pinned to the worktree?

