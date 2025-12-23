# Dev Preview Panel (Spec)

## Summary

**Dev Preview** is a single panel that:

1. Automatically installs dependencies (when needed)
2. Runs a dev server in the selected worktree
3. Auto-detects the dev server URL/port
4. Shows a live localhost preview by default (hides the terminal)
5. Allows instant toggling to a terminal/logs view, plus “copy logs”
6. Supports restart (re-run dev command and refresh preview after detecting the new URL)

This is explicitly a Canopy “Mission Control” feature: it bridges the gap between running dev commands and seeing results, without becoming a full IDE.

## Motivation / User Story

Web designers and frontend engineers working with agents want to:

- Ask an agent to change UI code
- See those changes reflected in a browser view in real time
- Avoid manual setup friction (install deps, figure out which command, find port)
- Access terminal output and logs when something fails, but not have to live in the terminal

The typical Canopy workflow: create a worktree → start agent work → validate UI changes quickly.

## Goals

- **Opinionated zero-config** for common web frameworks and monorepos.
- **Auto-detect**: package manager, install needs, dev command, and preview URL.
- **Preview-first UI**: browser is primary; terminal is secondary but one click away.
- **Fast recovery**: restart command and re-sync preview URL.
- **Copyable logs**: export terminal output for debugging / context injection.
- **Localhost-only security**: preview is restricted to loopback URLs.

## Non-goals

- Becoming a full browser (no bookmarks, extensions, general-purpose navigation).
- Supporting arbitrary remote URLs (preview is localhost only).
- Managing production deployments.
- Deep per-framework configuration UI (“10 toggles” anti-pattern).
- Multiple dev servers per single Dev Preview panel (one panel = one managed server/session).

## Existing System Context (What’s already in the codebase)

### Panels

- Panel kinds are defined in `shared/types/domain.ts` and configured in
  `shared/config/panelKindRegistry.ts` (`terminal`, `agent`, `browser`).
- Panel components are registered in `src/registry/builtInPanelRegistrations.ts`.
- Non-PTY panels are supported today (`browser` kind) via the existing terminal/panel registry
  path in `src/store/slices/terminalRegistrySlice.ts` (it creates a panel instance without spawning PTY).

### Current “Browser” Panel

- `browser` panel renders an **iframe** preview in `src/components/Browser/BrowserPane.tsx`.
- URL normalization and validation is **localhost-restricted** in `src/components/Browser/browserUtils.ts`.
- The `browser` panel is currently “just a viewer”; it does not manage servers.

### Sidecar

- There is also a separate “Sidecar” feature that uses **Electron WebContentsView**
  (`electron/services/SidecarManager.ts`) with navigation events and a richer embedded browsing surface.
- Sidecar can, in principle, expose webcontents-level events (like console messages), whereas the iframe approach generally cannot.

### Terminal Output / Logs

- PTY output is already streamed to the renderer and rendered via xterm.
- Addons include `SerializeAddon` (`src/services/terminal/TerminalAddonManager.ts`), which can be used to implement “Copy logs”.
- Main process styles URLs in terminal output with OSC-8 hyperlinks (`electron/services/pty/UrlStyler.ts`), which helps discovery and clickability.

## Proposed UX

### Where Dev Preview lives

Dev Preview is a **panel kind** that lives in the existing panel grid/dock model, like terminals.

### Default view: Preview

- The panel opens in **Preview mode** by default.
- The preview surface shows the detected `http://localhost:<port>/...` URL.
- A minimal status strip is visible (e.g. “Starting…”, “Running on localhost:5173”, “Error”, etc).

### Secondary view: Terminal

- A single toggle switches between:
  - **Preview**
  - **Terminal**
- Terminal mode shows the managed PTY session (install + dev server output).
- A **Copy logs** action copies terminal output to clipboard for sharing with agents/issues.
- Optional: “Open in external browser” action for the preview URL.

### Restart behavior

Restart:

1. Restarts the underlying dev process (re-run command).
2. Clears any stale URL state.
3. Watches output for the next valid localhost URL and updates the preview to it.

### Failure states

- If install fails: show error state; terminal view is emphasized (auto-switch or prompt).
- If dev server fails: show error state; provide restart and copy logs.
- If URL cannot be detected: show “waiting for URL” with a manual “set URL” override (optional).

## Naming

- User-facing name: **Dev Preview**
- Panel kind id (internal): recommended `dev-preview` (or `devPreview` if that’s preferred in code).

## Architecture Overview

Dev Preview should follow Canopy’s 4-layer pattern:

`Service → IPC → Store → UI`

### High-level data model

A Dev Preview panel instance owns:

- A PTY terminal session id (for install/dev process)
- Detected preview URL (localhost only)
- Status state machine (installing, starting, running, error, stopped)
- Detected framework/package manager/command metadata (for display + diagnostics)

## Main Process (electron/)

### New service: DevServerManager (or DevPreviewService)

Responsibilities:

- Decide **install command** (if needed) and **dev command** (script detection)
- Start/stop/restart the PTY session for a given worktree/panel
- Parse terminal output to detect localhost URLs
- Emit typed events to the renderer:
  - status changes
  - url discovered/changed
  - error states

#### Suggested detection rules (v1)

**Project detection:**

- Determine if the worktree is a “node project” by presence of `package.json`.
- Prefer worktree root (panel cwd), but allow monorepo packages by scanning up to a small depth if needed (keep bounded).

**Package manager selection:**

- If `pnpm-lock.yaml` → `pnpm`
- Else if `yarn.lock` → `yarn`
- Else if `bun.lockb` → `bun`
- Else → `npm`

**Dependency install decision:**

- If `node_modules/` missing → install.
- Else skip.

**Install commands:**

- `pnpm install`
- `yarn` (or `yarn install`)
- `bun install`
- `npm install` (explicitly never `npm ci`)

**Dev command selection:**

- If `package.json` has `scripts.dev` → run it:
  - `pnpm run dev` / `yarn dev` / `bun run dev` / `npm run dev`
- Else fall back:
  - `scripts.start` if present (only if dev absent)
- Otherwise: show “No dev script found” error with copy logs and guidance.

**URL detection from output:**

- Scan stdout/stderr chunks for URLs matching:
  - `http://localhost:<port>`
  - `http://127.0.0.1:<port>`
  - `http://0.0.0.0:<port>` → normalize to `localhost`
  - `https://` variants where printed by tooling
- Prefer URLs that look like “local” endpoints when multiple are printed (many tools also print “Network” URLs).
- Validate with the same constraints as `normalizeBrowserUrl` / localhost-only logic.

**Port changes:**

- On restart, treat first discovered URL after restart as authoritative.

#### IPC

Add a small Dev Preview IPC contract:

- `dev-preview:start` (panelId, worktreeId/cwd)
- `dev-preview:stop`
- `dev-preview:restart`
- `dev-preview:set-url` (manual override; optional)
- Events:
  - `dev-preview:status` (installing/starting/running/error/stopped + message + timestamps)
  - `dev-preview:url` (updated url)

Inputs validated with Zod, consistent with existing IPC patterns.

## Renderer (src/)

### Store changes

Add a small Zustand store (e.g. `src/store/devPreviewStore.ts`) keyed by panel id:

- `status`: `{ state, message, timestamp, error? }`
- `url`: string | null
- `detected`: `{ packageManager?, devCommand?, projectRoot? }`
- UI state: `viewMode: "preview" | "terminal"` (persisted)

Also store the `browserUrl` on the panel instance so it keeps working with existing persistence patterns (`terminalRegistrySlice` already supports `browserUrl` for non-PTY browser panels; Dev Preview will need an equivalent field and/or store state).

### New panel kind + component

- Register a new panel kind in `shared/config/panelKindRegistry.ts`:
  - `hasPty: true`
  - `canRestart: true`
  - `iconId: "globe" | "sparkles" | "monitor"` (TBD)
- Register a component in `src/registry/builtInPanelRegistrations.ts`, e.g. `DevPreviewPane`.

### DevPreviewPane UI

Layout:

- Top: existing `ContentPanel` header, with restart support (like terminals).
- Body:
  - Preview surface (default): either iframe-based or sidecar-based (see below).
  - Terminal surface: reuse `XtermAdapter` with the panel’s terminal id.
- Bottom/status strip:
  - Show `Installing…`, `Starting…`, `Running`, `Error` with appropriate semantic colors.
  - Show detected host:port.
  - Actions: Toggle view, Copy logs, Open external, Restart.

### Preview rendering choice (iframe vs sidecar)

**Option A (v1): iframe preview**

- Fastest to ship: reuse `BrowserPane` ideas directly inside Dev Preview.
- Security is simpler: rely on strict localhost URL validation.
- Limitation: browser console logs are generally not capturable.

**Option B (v2+): Electron WebContentsView-backed preview**

- Uses main process webcontents (like `SidecarManager`) to render the preview.
- Can forward webcontents events (including console messages) to Dev Preview store for a built-in console viewer.
- Higher implementation complexity: lifecycle, bounds syncing, tab/view management within a panel, and stricter isolation rules.

Recommendation:

- Ship v1 with iframe preview + terminal logs + copy logs (covers most value).
- Add v2 webcontents console capture later if demand is strong.

## Console Logs (Feasibility)

### Terminal logs

Yes. Terminal output is already captured and rendered; copying it can be implemented via xterm `SerializeAddon`.

### Browser console logs

- **Not reliable with iframe preview** (cross-origin restrictions and no direct access to console events).
- **Feasible with WebContentsView**: Electron can emit console events from webcontents and forward them to the renderer.

Spec decision:

- v1: terminal logs only.
- v2: optional web console capture if preview is webcontents-based.

## Security & Safety

- Preview URLs must be restricted to localhost variants:
  - `localhost`, `127.0.0.1`, `::1` (and normalize `0.0.0.0 → localhost`)
- Do not allow navigation to non-localhost URLs by default.
- Dev Preview commands run in the worktree directory (no elevated privileges).
- IPC:
  - Validate all inputs with Zod.
  - Prevent arbitrary command injection; only run resolved install/dev commands from known heuristics (or `package.json` scripts).

## Persistence

Persist per-panel:

- Last known preview URL (optional; but treat as stale until confirmed)
- View mode preference (preview vs terminal)
- Detected metadata for diagnostics

Do not persist:

- Raw terminal output (too large; but allow user to copy).

## Edge Cases / Compatibility

- **Monorepos**:
  - Worktree root may not contain the target package; detection should either:
    - use panel cwd as user-chosen root, or
    - scan a small depth for a `package.json` with a `dev` script (bounded).
- **Multiple URLs printed**:
  - Prefer localhost URL marked as “Local” / “localhost” when present.
- **Framework port switching**:
  - Restart should always re-detect.
- **Dev server that refuses iframes**:
  - Some apps set `X-Frame-Options` or CSP; iframe preview may fail.
  - Provide “Open external browser” fallback and/or move to webcontents-based preview in v2.
- **HTTPS self-signed**:
  - Many local dev servers are HTTP; if HTTPS appears, iframe may be blocked or show errors.
- **Long install times**:
  - Status strip should reflect “Installing dependencies…” and allow “Show terminal”.

## Telemetry / Diagnostics (Optional)

For troubleshooting (especially during early rollout), keep internal diagnostics visible in the panel:

- Selected package manager
- Selected commands
- Detected project root
- Last detected URL

## Implementation Plan (Phased)

### Phase 1 (MVP): Preview + Terminal, auto-detect URL

- New panel kind `dev-preview` (PTY-backed).
- Start flow: install-if-needed → run dev script.
- Parse terminal output for localhost URL and set preview URL.
- UI: preview-first toggle + restart + copy logs + open external.

### Phase 2: Quality + Monorepo heuristics

- Improve package root detection.
- Better URL selection when multiple printed.
- Better failure UX and actionable errors.

### Phase 3 (Optional): Web console capture

- Switch preview implementation to WebContentsView (Sidecar-like) or embed a mini sidecar per panel.
- Forward `console-message` events to the renderer for display/filtering/copy.

