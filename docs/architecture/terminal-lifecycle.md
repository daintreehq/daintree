# Terminal Lifecycle

This document describes the runtime lifecycle state for terminals across renderer, main, and PTY host.

## Lifecycle ledger (generation safety)

`AgentTerminalLifecycleLedger` (`shared/utils/agentLifecycleLedger.ts`) is a bounded, in-memory audit ledger instantiated once per process: main (`electron/services/pty/lifecycleLedger.ts`, the authority), the pty-host (a `PtyManager` member), and the renderer (`src/services/terminal/lifecycleLedger.ts`). Main mints a monotonic `launchGeneration` per terminal id in `PtyClient.spawn` — every spawn path (fresh, restart, resume, respawn-after-host-crash) funnels through it — and stamps it on the spawn options; the pty-host adopts it and echoes it on `exit` and `agent-session-captured` events so cross-process completions key to the same incarnation.

The ledger records immutable launch facts per generation (launch/detected agent ids, cwd/project/worktree attribution with explicit-vs-inferred provenance, model/preset/flags, env provenance as sorted key names + content hash — never values — and initial/first-attach geometry) and validates lifecycle operations in two regimes: live-state ops (resize, restore, attach, detection) apply only to the CURRENT generation, while terminal-final ops (close, journal) are exactly-once PER generation and tolerate past generations, so a kill's journal write landing after a same-id respawn is neither dropped nor attributed to the successor.

Load-bearing gates wired on it: `journalAgentSession` (`electron/services/pty/agentSessionJournal.ts`) is the single funnel for all four session-journal close paths (trash expiry, kill, gracefulKill, shutdown) and drops duplicate records per (terminalId, generation); `PtyManager` stamps buffered pre-spawn resizes with the generation current at buffering time and drops stale ones at the next spawn instead of booting the successor at dead geometry; the renderer's `addPanel` rejects spawn resolutions and hydration/reconnect merges that no longer belong to the live incarnation (stale persisted snapshots must not overwrite fresh launch metadata); and inferred (cwd-derived) worktree attribution never overwrites a differing explicit one. Rejections land in a bounded anomaly ring surfaced as the `lifecycleLedger` section of the diagnostics bundle (`DiagnosticsCollector`). The ledger is diagnostic-grade and never persisted — it is not a user-facing history.

## Runtime status model

`TerminalRuntimeStatus` is a lightweight, runtime-only view used by the renderer store:

- `running`: terminal is active and visible.
- `background`: terminal is alive but not visible (dock or inactive worktree).
- `paused-backpressure`: PTY host paused output due to SAB backpressure.
- `paused-resource-governor`: PTY host paused output under memory/resource-governor pressure (auto-recovers when pressure eases).
- `paused-user` (**FUTURE_SAB skeleton**, #9900): declared in the type union but has no producer. Kept as a forward-looking value; the listener at `src/store/listeners/panel/lifecycle.ts` drops it at the boundary so the buffer never persists it.
- `suspended` (**FUTURE_SAB skeleton**, #9900): only emitted by the SharedArrayBuffer transport path (`BackpressureManager.suspendVisualStream`, `electron/pty-host/backpressure.ts`). The SAB path is disabled in production (SharedArrayBuffer is not supported in Electron UtilityProcess — see PR #7724 / issue #7653). The renderer-side Suspended pill and a11y formatter in `src/components/Terminal/TerminalHeaderContent.tsx` and `src/hooks/app/useAccessibilityAnnouncements.ts` remain as forward-looking code, but the status is never produced in production.
- `exited`: terminal process exited (used for post-mortem review).
- `error`: terminal hit a terminal-level error (future use).

`TerminalFlowStatus` is a subset of the above that comes from PTY host flow-control events. The `FutureSABFlowStatus` set (`suspended` | `paused-user`) is carved out of `PersistableFlowStatus` at the type level (`shared/types/panel.ts`) so the buffer and store paths cannot persist a skeleton value as durable state.

## Transition sources

- PTY host emits `terminal-status` for flow control (`running`, `paused-backpressure`, `paused-resource-governor`; the `suspended` and `paused-user` members of the union are FUTURE_SAB and not emitted in production — see #9900).
- Renderer visibility updates (`isVisible`) convert `running` to `background` when a terminal is not visible.
- PTY exit events set `runtimeStatus` to `exited` before trashing or preserving the terminal.

## Data-loss pulse

`data-loss` is a **transient pulse**, not a durable runtime state. The PTY host emits it when the IPC fallback queue discards bytes during a heavy-output burst. The host policy is **drop-don't-block**: blocking the producer to guarantee delivery risks freezing the main process under a runaway flood, so bytes are intentionally discarded and the gap is surfaced instead of hidden.

Because it is a pulse, it is excluded from persistence at the type level: `PersistableFlowStatus = Exclude<TerminalFlowStatus, "data-loss">` (`shared/types/panel.ts`). The renderer store never freezes the terminal on `data-loss`; it fires the marker and immediately resumes the prior status.

### Recovery contract

- The dropped bytes are **not replayed** — there is no retransmit path. The signal is informational.
- The pty-host carries the signal in-band as a structured private-use **OSC 57301** sequence (wire format `ESC ] 57301 ; <droppedBytes> ; <reasonCode> BEL`), written via `injectDataLossMarker` in `TerminalInstanceService`. Presentation is kept off the wire.
- The OSC handler registered in `TerminalParserHandler` parses the payload, consumes the sequence (it never reaches the buffer as text), and fires an `onDataLoss` callback. The callback draws the user-visible yellow `⚠ Output dropped` line into xterm scrollback, deferred via `queueMicrotask` to avoid write-during-parse reentrancy.
- The marker is a gap indicator only. Recovery is the xterm scrollback above and below it; the user sees a clearly-marked discontinuity rather than a silent corruption.
- Every drop site (saturated-window port drop, IPC-cap drop, batched bytes discarded with a closing port) also records into a bounded per-terminal drop tally in the pty-host, surfaced as `droppedBytes`/`dropCount`/`lastDropAt` on each terminal in the on-demand flow-control snapshot (`get-flow-control-snapshot`) — so a support bundle can attribute WHOSE scrollback has a gap, not just that bytes were dropped process-wide. Entries are cleared on terminal exit.

## Notes

- Runtime status is not persisted; it is derived from live events and UI visibility.
- Flow-control events are treated as higher priority than visibility (e.g., `paused-backpressure` overrides `background`).
