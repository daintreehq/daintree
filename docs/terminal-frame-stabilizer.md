# Terminal Frame Stabilizer

## Problem

Agent terminals (Claude Code, Gemini, Codex) experienced visual flashing during TUI redraws. The terminal would briefly show partial content or blank screens before displaying the complete frame.

## Root Cause

Modern TUIs use **DEC private mode 2026** (synchronized output) for atomic screen updates:

- `\x1b[?2026h` - Start synchronized output (terminal should buffer)
- `\x1b[?2026l` - End synchronized output (terminal should render)

The problem: xterm.js doesn't support this protocol. It renders immediately as data arrives, so users see the intermediate states (line clearing, partial content) that should be invisible.

## Solution

`TerminalFrameStabilizer` intercepts PTY output and buffers it according to the sync protocol:

1. **Sync Mode Detection** - When `\x1b[?2026h` is seen, buffer all output until `\x1b[?2026l`
2. **Traditional Boundaries** - For TUIs without sync mode, emit on `\x1b[2J` (clear screen) or `\x1b[?1049h` (alt buffer)
3. **Stability Fallback** - If no boundaries detected, emit after 100ms of quiet or 200ms max hold

## File

`electron/services/pty/TerminalFrameStabilizer.ts`

Only enabled for agent terminals (`isAgentTerminal`). Normal shell terminals bypass the stabilizer entirely.
