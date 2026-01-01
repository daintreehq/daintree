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

## Notes

- Runtime status is not persisted; it is derived from live events and UI visibility.
- Flow-control events are treated as higher priority than visibility (e.g., `paused-backpressure` overrides `background`).
