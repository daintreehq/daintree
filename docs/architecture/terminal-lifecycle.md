# Terminal Lifecycle

This document describes the runtime lifecycle state for terminals across renderer, main, and PTY host.

## Runtime status model

`TerminalRuntimeStatus` is a lightweight, runtime-only view used by the renderer store:

- `running`: terminal is active and visible.
- `background`: terminal is alive but not visible (dock or inactive worktree).
- `paused-backpressure`: PTY host paused output due to SAB backpressure.
- `paused-user`: user-initiated pause.
- `suspended`: PTY host suspended visual streaming after a stall.
- `exited`: terminal process exited (used for post-mortem review).
- `error`: terminal hit a terminal-level error (future use).

`TerminalFlowStatus` is a subset of the above that comes from PTY host flow-control events.

## Transition sources

- PTY host emits `terminal-status` for flow control (`running`, `paused-backpressure`, `paused-user`, `suspended`).
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

## Notes

- Runtime status is not persisted; it is derived from live events and UI visibility.
- Flow-control events are treated as higher priority than visibility (e.g., `paused-backpressure` overrides `background`).
