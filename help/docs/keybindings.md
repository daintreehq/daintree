# Keybindings

All keybindings use macOS notation. On Windows/Linux, substitute **Ctrl** for **Cmd**.

## Navigation

| Shortcut    | Action                |
| ----------- | --------------------- |
| Cmd+P       | Quick Switcher        |
| Cmd+Shift+P | Command palette       |
| Cmd+B       | Toggle sidebar        |
| Cmd+F       | Find in focused panel |
| F6          | Focus next region     |
| Shift+F6    | Focus previous region |

## Panels

| Shortcut     | Action                           |
| ------------ | -------------------------------- |
| Cmd+N        | Panel palette (create any panel) |
| Cmd+T        | Duplicate focused panel          |
| Cmd+Alt+T    | New terminal                     |
| Cmd+W        | Close focused panel              |
| Cmd+K Cmd+W  | Close all panels                 |
| Cmd+Shift+T  | Reopen last closed panel         |
| Ctrl+Shift+F | Toggle maximize                  |
| Shift+F10    | Panel context menu               |

## Panel Focus

| Shortcut            | Action                   |
| ------------------- | ------------------------ |
| Cmd+1 through Cmd+9 | Focus panel by index     |
| Ctrl+Tab            | Focus next panel         |
| Ctrl+Shift+Tab      | Focus previous panel     |
| Cmd+Alt+Arrow       | Focus panel in direction |
| Cmd+Shift+]         | Next tab                 |
| Cmd+Shift+[         | Previous tab             |

## Panel Movement

| Shortcut            | Action               |
| ------------------- | -------------------- |
| Cmd+Shift+Alt+Arrow | Move panel in grid   |
| Cmd+Shift+Alt+D     | Move to dock         |
| Cmd+Shift+Alt+G     | Move to grid         |
| Cmd+Alt+M           | Toggle dock/grid     |
| Cmd+Alt+Shift+M     | Toggle all dock/grid |
| Cmd+Alt+D           | Focus dock panel     |

## Agents

| Shortcut    | Action                          |
| ----------- | ------------------------------- |
| Cmd+Shift+A | Agent palette                   |
| Cmd+Alt+C   | Launch Claude                   |
| Cmd+Alt+G   | Launch Gemini                   |
| Cmd+Alt+X   | Launch Codex                    |
| Cmd+Alt+O   | Launch OpenCode                 |
| Cmd+Alt+U   | Launch Cursor                   |
| Cmd+Alt+N   | Terminal in current worktree    |
| Cmd+Alt+K   | Next agent panel                |
| Cmd+Alt+J   | Previous agent panel            |
| Cmd+Alt+/   | Jump to next waiting agent      |
| Cmd+Alt+.   | Jump to next working agent      |
| Cmd+Shift+/ | Jump to next waiting dock agent |

## Terminal

| Shortcut    | Action                             |
| ----------- | ---------------------------------- |
| Cmd+K Cmd+K | End all terminals                  |
| Cmd+K Cmd+R | Restart all terminals              |
| Cmd+Shift+W | Toggle watch on terminal           |
| Cmd+Alt+L   | Scroll to last activity            |
| Cmd+Shift+I | Inject context                     |
| Cmd+Shift+E | Send selection to another terminal |
| Cmd+Shift+B | Bulk Operations                   |
| Cmd+Shift+S | Stash current input                |
| Cmd+Shift+X | Restore stashed input              |

## Worktrees

| Shortcut                    | Action                      |
| --------------------------- | --------------------------- |
| Cmd+Alt+1 through Cmd+Alt+9 | Switch to worktree by index |
| Cmd+Alt+]                   | Next worktree               |
| Cmd+Alt+[                   | Previous worktree           |
| Cmd+K W                     | Worktree palette            |
| Cmd+Shift+O                 | Toggle worktrees overview   |
| Cmd+Shift+C                 | Copy tree context           |

## Worktree Sessions

| Shortcut    | Action                   |
| ----------- | ------------------------ |
| Cmd+K Cmd+M | Dock all sessions        |
| Cmd+K Cmd+X | Maximize all sessions    |
| Cmd+K Cmd+T | Restart all sessions     |
| Cmd+K Cmd+E | End all sessions         |
| Cmd+K Cmd+D | Close completed sessions |
| Cmd+K Cmd+B | Trash all sessions       |
| Cmd+K Cmd+N | Reset all renderers      |

## Git

| Shortcut    | Action                |
| ----------- | --------------------- |
| Cmd+K Cmd+A | Stage all changes     |
| Cmd+K Cmd+C | Commit staged changes |
| Cmd+K Cmd+P | Push to remote        |

## Other

| Shortcut              | Action                       |
| --------------------- | ---------------------------- |
| Cmd+Shift+D           | Toggle diagnostics dock      |
| Cmd+\                 | Toggle portal panel          |
| Cmd+Shift+N           | Notes palette                |
| Cmd+Alt+P             | Project switcher             |
| Cmd+K Cmd+S           | Keyboard shortcuts reference |
| Cmd+/                 | Keyboard shortcuts (alt)     |
| Cmd+,                 | Settings                     |
| Cmd+Shift+V           | Toggle voice input           |
| Cmd+= / Cmd+- / Cmd+0 | Zoom in / out / reset        |
| Cmd+Alt+Z             | Undo layout                  |
| Cmd+Alt+Shift+Z       | Redo layout                  |

## Portal (when focused)

| Shortcut       | Action       |
| -------------- | ------------ |
| Cmd+T          | New tab      |
| Cmd+W          | Close tab    |
| Ctrl+Tab       | Next tab     |
| Ctrl+Shift+Tab | Previous tab |

## Keymap Presets

Canopy supports two keymap presets:

- **Standard** — Default keybindings (arrow keys for navigation)
- **Vim** — Vim-style navigation (hjkl) in the worktree list

You can switch presets and customize individual bindings in Settings (Cmd+,).
