# Hybrid Input Bar (Terminal Output + React Input)

This document describes an experimental UX change: add a persistent HTML input bar at the bottom of each terminal pane that can send text to the underlying PTY, while keeping the terminal (xterm) fully visible and fully interactive.

The goal is to improve typing, pasting, and command ergonomics without attempting to re-render or emulate third-party TUIs in React.

## Why This (And Why Not a Full Wrapper)

### Motivation

Terminals are great for rendering and compatibility, but they’re not ideal for:

- Fast, reliable multi-line editing
- Large pastes with predictable behavior
- IME/composition-heavy input (non-English) in some setups
- Discoverable “mission control” commands (context injection, navigation, actions)

An HTML input provides a stable, high-quality typing surface and lets Canopy add helpful UX (history, autocomplete, paste handling) without breaking the underlying agent CLIs.

### Non-goals

- Do not replace xterm rendering with React.
- Do not scrape terminal output and attempt to rebuild agent UI state.
- Do not attempt to mirror per-agent slash-command/autocomplete logic (Claude/Gemini/Codex) inside Canopy.
- Do not remove or “hide” the agent’s own prompt/input line from the terminal output.

The terminal remains the canonical log and the escape hatch for any TUI interaction.

## Product Principles and Alignment

This approach is intentionally “decorate, don’t replace”:

- The terminal stays visible (output/log).
- Users can still click into the terminal and type normally at any time.
- The input bar is an additive accelerator for common workflows (especially large text entry).

This avoids the maintenance burden and brittleness of UI emulation for third-party CLIs.

## High-Level UX

### Layout

- Terminal pane shows xterm as usual.
- A persistent strip at the bottom contains an HTML input (textarea + “Send”).
- Terminal remains clickable and can be focused for raw typing at any time.

### Input semantics (recommended defaults)

- `Enter`: send current input (append CR/Enter to PTY).
- `Shift+Enter`: insert a newline in the textarea (multi-line composition).
- “Send” button: same as `Enter`.

Optional ergonomics:

- Single-line history navigation with `↑`/`↓` (only when cursor is at start/end and the input is a single line).

### Paste semantics

For better compatibility with agent CLIs and shells, treat large or multi-line sends as “paste-like” input:

- Wrap as bracketed paste when sending:
  - Start: `ESC[200~`
  - End: `ESC[201~`
- Then send a final `CR` to execute (or leave execution as a separate action, if desired later).

Why: several CLIs behave better when they can detect a paste (e.g., “pasted N chars”), and it reduces accidental mid-sequence splitting.

### Focus and escape hatches

A hybrid model must be explicit about focus:

- Default: user types in the bottom input.
- Escape hatch: one action to focus xterm (click in terminal, hotkey, or a toggle).
- Return: one action to refocus the input bar.

Agent TUIs sometimes require raw keys (arrows, tab, ctrl-key combos). The user must always be able to drop into raw terminal mode instantly.

## Compatibility Strategy

### What we support

- Shell terminals and agent terminals (Claude, Gemini, Codex) as-is.
- Sending text via PTY `write()` + enter.
- Bracketed paste wrapping for big or multi-line sends.

### What we do NOT attempt

- Detecting and removing the “input field” prompt output from the terminal.
  - There is no stable prompt region across tools; attempting to “filter” it introduces brittleness.
- Re-creating interactive selection UIs (menus, pickers) in React.

### Slash commands

We split slash commands into two categories:

1. **Canopy-level /commands (Mission Control):** discovery/autocomplete handled by Canopy.
   - Examples (candidates):
     - `/clear`
     - `/copytree` (context injection)
     - `/open <path>`
     - `/worktree <name>`
     - `/restart`

2. **Agent-level /commands:** passed through verbatim to the terminal/agent.

Key rule: do not mirror each agent’s private slash/autocomplete behavior. That drifts with versions and becomes “UI emulation by another name.”

## Implementation Notes (Architecture Fit)

Canopy’s system is already designed around keeping PTY and terminal rendering robust:

- PTY I/O lives in the backend and is optimized for low-latency rendering.
- Headless xterm exists on the backend for serialization/snapshots and resilience.
- Terminal analysis (artifacts/state) runs in a worker and does not depend on UI emulation.

The hybrid input bar should stay within the standard pattern:

```
Service → IPC → Store → UI
```

and should minimize new coupling between the UI and any agent-specific output parsing.

### Where to hook

- UI sends via existing terminal client write path (same path as xterm input).
- Consider piggybacking on existing input tracking (clear command detection, etc.) where appropriate.

## Risks and Mitigations

### 1) “Double input” confusion

Users may see both the agent’s prompt in xterm and the Canopy input bar.

Mitigation:

- Treat xterm as log; users learn input bar is preferred.
- Provide a clear “focus terminal” action for when the agent needs raw TUI interaction.

### 2) TUI interactions that require keys

Some flows require arrow keys, tab completion, or y/n prompts.

Mitigation:

- Keep terminal fully interactive.
- Make focus switching fast and obvious.

### 3) IME/composition correctness

HTML input must handle `compositionstart/update/end` correctly, and “send” should not interrupt composition.

Mitigation:

- Implement composition-aware send behavior.
- Add a small set of IME manual checks (see Testing).

### 4) Large paste performance and safety

Huge pastes can overwhelm CLIs or degrade UI responsiveness.

Mitigation options:

- Soft limit warning (e.g., “You’re about to send 50k chars”).
- Optional max size enforcement per send (configurable later if needed).
- Always use bracketed paste wrapping for large/multi-line sends.

## Phased Plan (GitHub Issues)

Issues were created with the prefix `[Hybrid Input Bar]`:

- Phase 1: Spec and UX decisions
- Phase 2: Add bottom input bar (send-to-PTY)
- Phase 3: Focus/mode switching + IME/paste ergonomics
- Phase 4: Canopy-level /commands + autocomplete

This should be developed on a separate branch and can be dropped cleanly if it degrades UX or introduces maintenance burden.

## Testing Checklist (Manual)

### Shell terminal

- Send single-line command and verify it runs.
- Send multi-line text (Shift+Enter) and verify newlines land correctly.
- Send a large paste and verify it arrives intact.

### Claude / Gemini / Codex

- Send a normal prompt and verify response continues normally.
- Trigger agent-specific prompts (confirmations, menus) and ensure you can switch to raw terminal input.
- Verify paste detection behavior doesn’t regress.

### IME

- Use a composition-based IME (e.g., Japanese kana/kanji) and verify sending doesn’t cut off composition.

## Rollback Strategy

Rollback should be trivial:

- Remove the input bar component from the terminal pane.
- Keep all terminal functionality unchanged.

If the experiment is not a clear win, remove it and preserve any standalone improvements (e.g., bracketed paste robustness) that are generally useful.
