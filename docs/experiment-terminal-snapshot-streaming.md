# Experiment: Terminal Snapshot Streaming (Headless Projection)

## Context

Canopy currently runs each terminal session through:

- `node-pty` in the backend (real TTY behavior).
- A backend canonical state machine via `@xterm/headless` + `@xterm/addon-serialize` (`electron/services/pty/TerminalProcess.ts`).
- A high-throughput visual data path to the renderer (SharedArrayBuffer ring buffer + `TerminalDataBuffer`), which streams raw PTY chunks into a renderer `xterm.js` instance.

TUIs (Claude/Gemini, Ink-based UIs, etc.) are not “logs”; they are screen-state protocols. When the renderer consumes every intermediate chunk, it can display transient clear/redraw frames, which reads as flicker. Attempts to “linearize” TUIs by filtering ANSI sequences proved fragile and are being removed.

This experiment pivots away from stream filtering and toward **state projection**:

> Treat the backend headless terminal as the source of truth and periodically project a composed snapshot to the renderer at a human cadence.

## Goals

- Make TUI-heavy agents (Claude/Gemini) stable and readable during redraw-heavy phases (spinners, progress UI, alt-screen UIs).
- Avoid further ANSI stream mutation/hacks in the renderer.
- Preserve interactivity: input still goes to the PTY; snapshot mode is a rendering strategy, not a different process mode.
- Keep a clear rollback path (feature-flag / per-terminal toggle).

## Non-goals (for the first pass)

- Perfect “log linearization” from TUI output.
- Replacing xterm.js everywhere.
- HTML rendering of terminal snapshots (bigger payload + xterm color-manager quirks).
- Multi-terminal snapshot streaming at full frame rates (must be visibility-aware).

## New Angle (Architecture)

### Current "Live Stream" Mode (existing)

PTY bytes → SAB ring buffer → Terminal Output Worker (parsing + coalescing) → renderer xterm writes bytes.

Pros: real terminal behavior; fast; offloaded from main thread via Web Worker.
Cons: flicker for TUIs; frontend sees intermediate states; harder to build clean history.

Note: As of issue #1119, SAB polling and packet parsing have been moved to a dedicated Web Worker using `Atomics.wait` for efficient blocking, reducing idle CPU and eliminating main-thread contention during heavy UI work.

### New “Snapshot Projection” Mode (experiment)

PTY bytes → backend headless xterm (canonical) → periodic snapshot → renderer renders snapshot.

Key property: the snapshot represents the _composed_ state after applying all intervening escape sequences, so the renderer does not see transient frames.

Input path remains unchanged:

Renderer input → existing IPC `terminal.write` / `terminal.submit` → PTY stdin.

## Phased Implementation Plan

### Phase 0 — Decide Snapshot Contract (payload + semantics)

Pick a minimal v1 snapshot shape that is easy to render and diff:

**Option A (recommended v1): “Screen Text Snapshot”**

- `cols`, `rows`
- `buffer`: `"active" | "alt"` (or `"active"` only initially)
- `cursor`: optional `{ x, y, visible }`
- `lines`: `string[]` representing the visible viewport (or the full buffer, but start with viewport)
- `timestamp`: `number`
- `sequence`: `number` (monotonic per terminal)

Semantics to decide:

- Active vs alternate buffer:
  - v1: `active` only is simplest.
  - v2: include `alt` (important for full-screen TUIs).
- Viewport vs full scrollback:
  - v1: viewport lines only (small payload, stable monitoring).
  - v2: add “scrollback window” fetch for history.
- Trimming:
  - v1: keep exact line count (stable layout).
  - v2: optional trimming for “log view”.

### Phase 1 — Backend Snapshot API (IPC pull)

Add a new IPC method: `terminal:get-snapshot`.

Implementation outline:

- In `TerminalProcess`, add something like `getScreenSnapshot({ includeAlt, mode })`.
  - Reads from `terminal.headlessTerminal`.
  - Extracts visible lines and cursor state.
  - Avoids heavy serialization work if the terminal is huge.
- In `electron/services/pty/TerminalRegistry.ts`, add a passthrough `getScreenSnapshot(id)`.
- In `electron/services/PtyClient.ts`, add `getSnapshot` request/response.
- In `electron/ipc/handlers/terminal.ts`, validate input and return the snapshot payload.
- In `electron/preload.cts`, expose `terminal.getSnapshot(...)`.
- In `src/types/electron.d.ts`, add typings.
- In `shared/types/ipc/*`, define snapshot request/response types.

Performance constraints:

- Do not allow snapshot requests to pile up:
  - Add single-flight per terminal (reuse the `TerminalSerializerService` pattern).
  - Optional rate limiting by caller (renderer should already throttle).

### Phase 2 — Renderer Snapshot View + Per-terminal Toggle

Add a per-terminal view mode:

- `viewMode: "live" | "snapshot"`

Renderer behavior:

- **Live**: keep existing SAB/xterm pipeline.
- **Snapshot**:
  - Do not attach or write raw PTY output into a visible xterm instance.
  - Poll `terminal.getSnapshot(id)` on an interval for visible terminals.
  - Render `lines` in a lightweight monospace UI.

Input behavior in Snapshot mode:

- Still send input to the backend PTY (existing APIs).
- Implement key handling in the snapshot component (basic):
  - Characters, Enter, Backspace, arrow keys, escape, Ctrl+C, etc.
  - Route to existing `terminal.sendKey` / `terminal.write` as appropriate.
  - Copy/paste should work via the app input bar (existing) even if selection in snapshot view is basic.

Cadence policy (must be visibility-aware):

- Focused terminal: 20–30Hz (33–50ms).
- Visible but not focused: 5–10Hz.
- Hidden: 0Hz.

### Phase 3 — Add Alt-screen Support (optional but likely necessary)

Many TUIs render exclusively in the alternate buffer. If we only snapshot `active`, snapshot mode may appear blank during TUI phases.

Add:

- `buffer: "active" | "alt"`
- Heuristic: if alt buffer is in use, snapshot alt; else snapshot active.
- Optional: include both and let renderer pick.

### Phase 4 — “Clean Log” as a Parallel Artifact (Hybrid)

Snapshot projection stabilizes the view, but it doesn’t automatically create a good append-only history.

Add a separate bounded “clean log” derived from headless state:

- On each snapshot tick (or at lower cadence), compute a diff against prior lines and append only stable changes.
- Ignore pure `\r` spinner overwrites and transient clears by construction (since headless already resolved them).
- Expose `terminal:get-clean-log({ sinceSequence })` or `terminal:subscribe-clean-log`.

### Phase 5 — Push Streaming (optional upgrade)

If polling works and is stable, consider upgrading to a push model:

- Renderer subscribes/unsubscribes per terminal.
- Backend emits snapshot events at negotiated cadence tiers.
- This reduces IPC call overhead and makes scheduling centralized.

## Experiment Flags / Rollback

Introduce an experiment gate at three levels:

1. Global env/config: `CANOPY_EXPERIMENT_SNAPSHOT_STREAMING=1`
2. Per-agent default: enable for Claude/Gemini first.
3. Per-terminal override: UI toggle.

Rollback is simply setting view mode back to Live and disabling the flag.

## Measurement / Debugging

Add lightweight metrics (loggable only when `CANOPY_VERBOSE`):

- Snapshot payload size (bytes).
- Snapshot latency (request → response).
- Snapshot frame rate (effective).
- Renderer dropped frames (if polling can’t keep up).
- PtyHost backpressure stats correlation (already emits status events).

## Files Likely to Change

Backend:

- `electron/services/pty/TerminalProcess.ts` (snapshot extraction)
- `electron/services/pty/TerminalRegistry.ts` (expose snapshot)
- `electron/services/PtyClient.ts` (API surface)
- `electron/ipc/channels.ts` (new channel)
- `electron/ipc/handlers/terminal.ts` (handler)
- `electron/preload.cts` (bridge)
- `shared/types/ipc/terminal.ts` (types)

Renderer:

- `src/store/terminalStore.ts` or slice (store `viewMode`)
- `src/components/Terminal/*` (new Snapshot view component)
- `src/types/electron.d.ts` (typing)

## Acceptance Criteria (Experiment Success)

- Claude/Gemini in Snapshot mode remains visually stable during spinners/redraw-heavy phases (no obvious flicker).
- Input still works reliably (typing, enter, ctrl-c, basic navigation).
- No sustained PTY stalls/backpressure regressions attributable to snapshot polling.
- Live mode remains unchanged and available.

## Known Risks / Open Questions

- Alt-buffer correctness: without alt snapshots, many TUIs will look blank.
- Snapshot rendering is not a full terminal emulator: selection, search, hyperlinks, and mouse interactions will differ from xterm.
- Cursor position and IME behavior in snapshot view will require careful handling if you want a “native terminal” feel.
- Long-running sessions: must keep payload sizes bounded and avoid per-snapshot full-buffer serialization unless gated.
