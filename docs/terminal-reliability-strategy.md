# Terminal Reliability Strategy (Grounded in Current Code)

## Goals

- Preserve fidelity (state correctness, minimal output loss, predictable resize semantics) across:
  - Grid ↔ Dock transitions
  - Worktree switches (terminals “backgrounded” by UI filtering)
  - App reloads / renderer refreshes
  - Pty Host restarts/crashes
- Keep the high-performance SharedArrayBuffer (SAB) `SharedRingBuffer` path.
- Reduce “optimistic drift” between renderer state and backend reality.

## Ground Truth: How Terminals Work Today

**Backend (UtilityProcess):**

- `electron/pty-host.ts` runs `electron/services/PtyManager.ts` inside a UtilityProcess.
- Terminal output flow:
  - `TerminalProcess` (in `electron/services/pty/TerminalProcess.ts`) listens to `node-pty` `onData`.
  - Data is emitted through `PtyManager` → `pty-host` listener.
  - `pty-host` writes framed packets into SAB `SharedRingBuffer` when available; otherwise emits IPC `TERMINAL_DATA`.
- Backpressure:
  - In SAB mode, `pty-host` pauses a PTY when the visual ring buffer is full and resumes when utilization drops, with a forced resume safety timeout (`BACKPRESSURE_MAX_PAUSE_MS`).
  - In IPC mode, `TerminalProcess` uses per-terminal ack-based flow control (`acknowledgeData` / `_unacknowledgedCharCount`).
- Terminal “state persistence”:
  - Agent terminals create `@xterm/headless` + `@xterm/addon-serialize` eagerly.
  - Non-agent terminals create headless+serialize lazily only when serialization is requested; until then they keep a bounded raw output string buffer.

**Renderer:**

- `src/services/terminal/TerminalDataBuffer.ts` polls SAB continuously (when enabled) and fan-outs packets per terminal ID.
- `src/services/terminal/TerminalInstanceService.ts` owns renderer-side xterm instances and keeps them alive across detach by reparenting into an offscreen container (“Always Attached” behavior).
- `src/components/Terminal/XtermAdapter.tsx` attaches/detaches xterm instances to DOM containers and drives resize via `ResizeObserver`.
- UI state (location, worktree association, etc.) is primarily renderer-owned in `src/store/terminalStore.ts` and `src/store/slices/terminalRegistrySlice.ts`.
- Hydration (`src/utils/stateHydration.ts`) uses persisted app state but queries backend terminals via `terminalClient.getForProject()` and attempts `terminalClient.reconnect()` before spawning new terminals.

**Important mismatch to fix:**

- `electron/services/PtyManager.ts` contains project filtering (`setActiveProject`) and backgrounding behavior (`onProjectSwitch`), but `electron/pty-host.ts` currently has no message to set this state in the UtilityProcess.
- `electron/ipc/handlers/project.ts` calls `getPtyManager()` (a main-process singleton) instead of instructing `pty-host`/`PtyClient`, so “project switch” terminal filtering/backgrounding is effectively a no-op for the actual running terminals.

## The Three Model Proposals as “Votes” (Verified Against Code)

Below, “Status” is what exists in the current codebase; “Agree” is whether it should be in the reliability plan.

### Backend authority + reconciliation (3/3 votes)

- **Proposal:** Treat backend as source of truth; renderer sends intents and waits for backend confirmation; add reconciliation on hydration and periodically.
- **Status:** Partially present.
  - Backend is authoritative for process existence, but renderer store still “decides” a lot (dock/grid/worktree).
  - Hydration already queries backend via `terminalClient.getForProject()` and uses `terminalClient.reconnect()`, but it still uses persisted state as the starting list.
- **Agree:** Yes.
  - Reliability needs a “truth and reconciliation” loop, especially after host restart, renderer refresh, or drag/worktree churn.

### Unified background/active lifecycle + wake/flush semantics (2/3 votes)

- **Proposal:** Unify “dock” and “background worktree” as lifecycle tiers; provide explicit wake/restore handshake.
- **Status:** Incomplete / inconsistent.
  - Renderer has tiering (`TerminalRefreshTier`) and offscreen attachment.
  - Backend has `flush-buffer` IPC, but it currently maps to `TerminalProcess.flushBuffer()` which is a no-op.
- **Agree:** Yes.
  - Today the app calls `terminalClient.flush()` in several places, but it can’t actually guarantee any catch-up semantics.

### SAB buffer hardening (3/3 votes)

- **Proposal:** Watchdog for stalled ring buffer; avoid “permanent pause” if renderer stalls; consider fallback modes.
- **Status:** Mostly present.
  - `pty-host` pauses on full ring buffer and force-resumes after a timeout.
  - Renderer reads SAB continuously, so the common “consumer disappeared” case is mostly “renderer crashed/hung”.
- **Agree:** Yes, but adjust the action.
  - “Force resume and keep trying” prevents permanent pause but can turn into thrash and/or implicit data loss.
  - Better reliability is: detect stall and switch that terminal to a safe mode (IPC stream or “headless-only until wake”), with an explicit warning event.

### Universal headless terminal state (1/3 votes)

- **Proposal:** Always instantiate `@xterm/headless` for all terminals and treat it as canonical state; renderer becomes a disposable view.
- **Status:** Not true today (agents only eager; non-agents lazy).
- **Agree:** Yes as a medium-term foundation (not necessarily first patch).
  - This is the cleanest way to guarantee fidelity across worktree switching/unmounts and renderer resets without relying on “renderer always keeps up”.

### Resize locking / freeze dimensions during transitions (2/3 votes)

- **Proposal:** Lock/freeze PTY dimensions during drag/dock/worktree transitions to avoid destructive reflow; ignore collapsed (0/near-0) resizes.
- **Status:** Partially present.
  - There are guards against tiny sizes in `XtermAdapter` and debounce logic in `TerminalInstanceService`.
  - There is no explicit “freeze PTY dims while backgrounded/dragging” contract.
- **Agree:** Yes.
  - This directly addresses “accordion effect” failures that look like terminal corruption.

### Worktree context integrity (1/3 votes)

- **Proposal:** Validate terminal CWD / worktree path; warn or block input if the worktree disappears; support migration.
- **Status:** Partial.
  - Restart validation (`validateTerminalConfig`) exists; runtime CWD checks do not.
- **Agree:** Yes, but keep it minimal and non-invasive (warnings + guided recovery, not aggressive input blocking by default).

## Strategy: Reliability-First, Hack-Preserving

### Keep (these are already good)

- **SAB `SharedRingBuffer` fast path** (`shared/utils/SharedRingBuffer.ts`, `electron/pty-host.ts`, `src/services/terminal/TerminalDataBuffer.ts`).
- **Renderer prewarm + offscreen attachment** to avoid losing startup output and to preserve xterm state across detach (`TerminalInstanceService.prewarmTerminal()` + offscreen slots).
- **Input chunking + bracketed paste atomicity** in `electron/services/pty/TerminalProcess.ts`.
- **Host resilience**: `PtyClient` watchdog/restart, `pty-host` emergency logging, `ResourceGovernor`, renderer “backend recovery” renderer reset path.

### Phase 0 (Fix correctness bugs / dead paths)

1. **Make “project switch” affect the actual backend that runs terminals.**
   - Replace main-process `getPtyManager()` usage in `electron/ipc/handlers/project.ts` with `PtyClient`→`pty-host` messages.
   - Add explicit `pty-host` requests/events for:
     - `set-active-project` (controls filtering)
     - `on-project-switch` (background/foreground semantics if still needed)
2. **Define real semantics for `terminalClient.flush()` or stop calling it.**
   - If “flush” is intended to mean “make the next attach faithful”, the backend needs an actual catch-up mechanism (see Phase 1/2).

### Phase 1 (Define a single lifecycle policy and remove drift)

1. **Introduce backend lifecycle tiers per terminal (authoritative, not UI-only).**
   - `ACTIVE`: visible on screen (grid focused/visible, dock open)
   - `BACKGROUND`: not currently visible (inactive worktree, dock closed)
   - `TRASHED`: pending TTL expiry
2. **Add renderer → backend lifecycle intents (idempotent).**
   - `terminal:set-activity-tier(id, tier)`
   - `terminal:wake(id, reason)` (used on attach/worktree activation/dock open)
3. **Renderer store becomes “projection + UI metadata”, not “process truth”.**
   - Spawn/kill/trash/restore should be “intent + pending UI state”, finalized by backend-confirmed events.
   - Add a periodic reconciliation: renderer sends its known IDs; backend replies with live IDs + metadata; renderer adopts or marks dead.

### Phase 2 (Make wake/restore actually faithful)

Choose one of these (they’re compatible; you can phase them):

**Option A (smaller change, still renderer-driven):**

- Keep streaming output to renderer for all terminals, but on wake:
  - request `terminalClient.getSerializedState(id)` and `TerminalInstanceService.restoreFromSerialized`.
  - do a forced `terminal.refresh(0, rows-1)` after restore to correct visual glitches.
- Benefit: leverages existing serialize plumbing.
- Cost: still depends on renderer-side xterm consuming output for correctness between wakes.

**Option B (backend-driven fidelity, recommended):**

- Make `@xterm/headless` + `SerializeAddon` universal in `TerminalProcess`.
- When a terminal is `BACKGROUND`, stop streaming data to the renderer transport:
  - PTY output continues to feed the headless terminal (canonical state).
  - No ring-buffer packets are produced for that terminal while backgrounded.
- On `terminal:wake`, backend sends one snapshot (serialized state) then resumes streaming.
- Benefit: background terminals become cheap and reliable; renderer can unmount freely without losing correctness.

### Phase 3 (Transport hardening + resize correctness)

1. **Ring-buffer stall policy (per terminal).**
   - Keep the existing pause/resume safety net, but when stalls persist:
     - emit a `terminal:warning` event
     - switch that terminal to a safe mode (IPC stream or headless-only until wake)
2. **Resize correctness contract.**
   - Do not resize PTY on collapsed layouts (already partially guarded).
   - Add a “resize lock” for drag/dock transitions so the PTY dims don’t flap.
   - Optionally: backend echoes accepted `cols/rows` so renderer applies xterm resize only after confirmation.

### Phase 4 (Observability + regression harness)

- Add a repeatable “terminal torture test” that exercises:
  - rapid worktree switching with high output
  - grid↔dock drag with animated resizing
  - host crash/restart recovery
  - multiple concurrent terminals (max grid + dock)
- Treat `terminal-status` events and “warning” events as part of the reliability surface (debuggable by users).

## Immediate Recommendations (High ROI)

- Fix the project-switch mismatch so backend filtering/backgrounding is real.
- Make `flush`/`wake` meaningful (either via serialized snapshot on wake, or universal headless + snapshot).
- Add backend-driven reconciliation on hydration and after backend restarts (eliminate “ghost terminal” drift).
- Add explicit resize locking during drag/dock/worktree transitions to stop destructive reflow.
