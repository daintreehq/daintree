# Actions

## Overview

Every operation in Canopy is an **action** — a typed, named command that can be triggered from multiple sources: keyboard shortcuts, menus, the command palette, context menus, or programmatically by the Canopy Assistant.

## The Command Palette

Press **Cmd+Shift+P** to open the command palette. This gives you searchable access to every action in Canopy. Type to filter, then press Enter to execute.

The command palette is the fastest way to discover features you might not know about.

## Action Categories

Actions are organized into categories:

| Category        | Examples                                                   |
| --------------- | ---------------------------------------------------------- |
| **Terminal**    | Close, restart, maximize, inject context, stash input      |
| **Agent**       | Launch agents, focus waiting/working agents, bulk commands |
| **Panel**       | Create panels, toggle dock, move in grid                   |
| **Worktree**    | Switch worktrees, open palette, copy tree                  |
| **Git**         | Stage all, commit, push                                    |
| **Navigation**  | Quick switcher, toggle sidebar, focus regions              |
| **App**         | Settings, zoom, quit                                       |
| **Preferences** | Theme selection, keymap configuration                      |
| **Browser**     | Portal tab management                                      |
| **Notes**       | Open notes palette                                         |
| **Voice**       | Toggle voice input                                         |

## Action Sources

Each action tracks where it was triggered from:

- **User** — Direct invocation from the command palette
- **Keybinding** — Triggered via keyboard shortcut
- **Menu** — Triggered from the application menu
- **Context Menu** — Triggered from a right-click menu
- **Agent** — Triggered by the Canopy Assistant

## Safety Levels

Actions have safety classifications:

- **Safe** — Can be executed without confirmation (most actions)
- **Confirm** — Requires confirmation before executing (destructive operations like ending all sessions)
- **Restricted** — Limited to specific contexts or requires elevated permissions

## Discovering Actions

1. **Command Palette** (Cmd+Shift+P) — Browse and search all actions
2. **Keyboard Shortcuts** (Cmd+K Cmd+S) — See all keybinding assignments
3. **Context Menus** — Right-click panels or worktree cards for contextual actions
4. **Application Menu** — Standard menu bar with categorized actions
