<!-- GENERATED FILE — DO NOT EDIT. Regenerate with `npm run codegen:keybindings` (source: shared/config/defaultKeybindings.ts). -->

# Keyboard shortcuts

Default keyboard shortcuts shipped with Daintree. This page lists defaults only — your effective bindings (including any rebinds, plugin contributions, and import profiles) live in the in-app reference: press `⌘+/` (`Ctrl+/`), `⌘+K ⌘+S`, or open Help → Keyboard Shortcuts.

## Conventions

- `Cmd` means ⌘ on macOS and `Ctrl` on Windows/Linux; the tables below show both forms.
- Chords are two keystrokes in sequence: `⌘+K ⌘+S` means press `⌘+K`, release, then `⌘+S`. Press `⌘+K` alone to see every completion in the command HUD; Escape cancels.
- While a terminal has focus, shortcuts without a modifier reach the terminal rather than the app (F6 region cycling is the deliberate exception). The readline keys `Ctrl+A/B/D/E/F/H/J/K/L/N/P/R/T/U/W/Y` and the Windows/Linux clipboard keys `Ctrl+Shift+C`, `Ctrl+Shift+V`, and `Shift+Insert` are reserved for the terminal — unless a chord is already pending, which the user opened deliberately.
- Every shortcut here can be rebound in Settings → Keyboard, which also supports export/import of shortcut profiles and per-row reset.

## Navigation

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open Quick Switcher | `⌘+P` | `Ctrl+P` |
| Focus next region | `F6` | `F6` |
| Focus previous region | `⇧+F6` | `Shift+F6` |
| Open command palette | `⌘+⇧+P` | `Ctrl+Shift+P` |
| Repeat last action | `⌘+⇧+.` | `Ctrl+Shift+.` |
| Toggle sidebar | `⌘+B` | `Ctrl+B` |
| Toggle focus mode (hide sidebar and assistant) | `⌘+K ⌘+F` | `Ctrl+K Ctrl+F` |

## Terminal

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Close focused terminal | `⌘+W` | `Ctrl+W` |
| Duplicate focused panel | `⌘+T` | `Ctrl+T` |
| New terminal | `⌘+⌥+T` | `Ctrl+Alt+T` |
| Reopen last closed terminal | `⌘+⇧+T` | `Ctrl+Shift+T` |
| Resume a closed session | `⌘+K ⌘+R` | `Ctrl+K Ctrl+R` |
| Close all terminals | `⌘+K ⌘+W` | `Ctrl+K Ctrl+W` |
| Restart all terminals | `⌘+K ⌘+A` | `Ctrl+K Ctrl+A` |
| Kill focused terminal | `⌘+K ⌘+Q` | `Ctrl+K Ctrl+Q` |
| Restart focused terminal | `⌘+K ⌘+E` | `Ctrl+K Ctrl+E` |
| Force resume focused terminal | `⌘+K ⌘+U` | `Ctrl+K Ctrl+U` |
| Redraw focused terminal | `⌘+K ⌘+D` | `Ctrl+K Ctrl+D` |
| Rename focused terminal | `⌘+K ⌘+L` | `Ctrl+K Ctrl+L` |
| Toggle watch on focused terminal | `⌘+⇧+W` | `Ctrl+Shift+W` |
| Scroll to last activity | `⌘+⌥+L` | `Ctrl+Alt+L` |
| Stash current input | `⌘+⇧+S` | `Ctrl+Shift+S` |
| Restore stashed input | `⌘+⇧+X` | `Ctrl+Shift+X` |
| Toggle focused terminal dock state | `⌘+⌥+M` | `Ctrl+Alt+M` |
| Toggle all terminals dock state | `⌘+⌥+⇧+M` | `Ctrl+Alt+Shift+M` |
| Focus next terminal | `⌃+Tab` | `Ctrl+Tab` |
| Focus previous terminal | `⌃+⇧+Tab` | `Ctrl+Shift+Tab` |
| Toggle focus between current and previously focused panel | `` ⌘+⌥+` `` | `` Ctrl+Alt+` `` |
| Switch to next tab in focused panel | `⌘+⇧+]` | `Ctrl+Shift+]` |
| Switch to previous tab in focused panel | `⌘+⇧+[` | `Ctrl+Shift+[` |
| Toggle maximize terminal | `⌃+⇧+F` | `Ctrl+Shift+F` |
| Move terminal left in grid | `⌘+⇧+⌥+←` | `Ctrl+Shift+Alt+Left` |
| Move terminal right in grid | `⌘+⇧+⌥+→` | `Ctrl+Shift+Alt+Right` |
| Move terminal up in grid | `⌘+⇧+⌥+↑` | `Ctrl+Shift+Alt+Up` |
| Move terminal down in grid | `⌘+⇧+⌥+↓` | `Ctrl+Shift+Alt+Down` |
| Move terminal to dock | `⌘+⇧+⌥+D` | `Ctrl+Shift+Alt+D` |
| Move terminal to grid | `⌘+⇧+⌥+G` | `Ctrl+Shift+Alt+G` |
| Inject context into focused terminal | `⌘+⇧+I` | `Ctrl+Shift+I` |
| Send selection to another terminal | `⌘+⇧+E` | `Ctrl+Shift+E` |
| Arm all eligible terminals in the current worktree | `⌘+⇧+B` | `Ctrl+Shift+B` |
| Focus terminal above | `⌘+⌥+↑` | `Ctrl+Alt+Up` |
| Focus terminal below | `⌘+⌥+↓` | `Ctrl+Alt+Down` |
| Focus terminal to the left | `⌘+⌥+←` | `Ctrl+Alt+Left` |
| Focus terminal to the right | `⌘+⌥+→` | `Ctrl+Alt+Right` |
| Focus terminal 1 | `⌘+1` | `Ctrl+1` |
| Focus terminal 2 | `⌘+2` | `Ctrl+2` |
| Focus terminal 3 | `⌘+3` | `Ctrl+3` |
| Focus terminal 4 | `⌘+4` | `Ctrl+4` |
| Focus terminal 5 | `⌘+5` | `Ctrl+5` |
| Focus terminal 6 | `⌘+6` | `Ctrl+6` |
| Focus terminal 7 | `⌘+7` | `Ctrl+7` |
| Focus terminal 8 | `⌘+8` | `Ctrl+8` |
| Focus terminal 9 | `⌘+9` | `Ctrl+9` |
| Close focused terminal | — | `Ctrl+F4` (Windows only) |

## Agents

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open quick switcher | `⌘+⇧+A` | `Ctrl+Shift+A` |
| Launch Claude Code agent | `⌘+⌥+C` | `Ctrl+Alt+C` |
| Launch Gemini agent | `⌘+⌥+G` | `Ctrl+Alt+G` |
| Launch Codex agent | `⌘+⌥+X` | `Ctrl+Alt+X` |
| Launch terminal in current worktree | `⌘+⌥+N` | `Ctrl+Alt+N` |
| Launch browser panel in current worktree | `⌘+⌥+B` | `Ctrl+Alt+B` |
| Jump to next waiting agent | `⌘+⌥+/` | `Ctrl+Alt+/` |
| Jump to next waiting agent across all projects | `⌘+⇧+⌥+/` | `Ctrl+Shift+Alt+/` |
| Jump to next working agent | `⌘+⌥+.` | `Ctrl+Alt+.` |
| Cycle to next agent panel | `⌘+⌥+K` | `Ctrl+Alt+K` |
| Cycle to previous agent panel | `⌘+⌥+J` | `Ctrl+Alt+J` |
| Jump to next waiting dock agent | `⌘+⇧+/` | `Ctrl+Shift+/` |

## Fleet

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Toggle arm focused pane (Join the fleet) | `⌘+J` | `Ctrl+J` |
| Toggle arm focused pane (no modifier, grid only) | `X` | `X` |
| Arm all eligible terminals in current worktree | `⌘+⌥+A` | `Ctrl+Alt+A` |
| Accept all armed waiting agents | `⌘+Y` | `Ctrl+Y` |
| Reject all armed waiting agents | `⌘+⇧+Y` | `Ctrl+Shift+Y` |
| Restart all armed agents | `⌘+⇧+R` | `Ctrl+Shift+R` |
| Kill all armed terminals | `⌘+⇧+K` | `Ctrl+Shift+K` |
| Trash all armed terminals | `⌘+⇧+Backspace` | `Ctrl+Shift+Backspace` |

## Worktrees

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Switch to worktree 1 | `⌘+⌥+1` | `Ctrl+Alt+1` |
| Switch to worktree 2 | `⌘+⌥+2` | `Ctrl+Alt+2` |
| Switch to worktree 3 | `⌘+⌥+3` | `Ctrl+Alt+3` |
| Switch to worktree 4 | `⌘+⌥+4` | `Ctrl+Alt+4` |
| Switch to worktree 5 | `⌘+⌥+5` | `Ctrl+Alt+5` |
| Switch to worktree 6 | `⌘+⌥+6` | `Ctrl+Alt+6` |
| Switch to worktree 7 | `⌘+⌥+7` | `Ctrl+Alt+7` |
| Switch to worktree 8 | `⌘+⌥+8` | `Ctrl+Alt+8` |
| Switch to worktree 9 | `⌘+⌥+9` | `Ctrl+Alt+9` |
| Switch to next worktree | `⌘+⌥+]` | `Ctrl+Alt+]` |
| Switch to previous worktree | `⌘+⌥+[` | `Ctrl+Alt+[` |
| Open worktree palette | `⌘+K ⌘+O` | `Ctrl+K Ctrl+O` |
| Create a new worktree | `⌘+K ⌘+N` | `Ctrl+K Ctrl+N` |
| Toggle worktrees overview | `⌘+⇧+O` | `Ctrl+Shift+O` |
| Copy tree context for active worktree | `⌘+⇧+C` | `Ctrl+Shift+C` |
| Open changes for focused worktree | `⌘+⇧+D` | `Ctrl+Shift+D` |
| Open file browser panel for focused worktree | `⌘+⌥+F` | `Ctrl+Alt+F` |

## Worktree Sessions

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Dock all sessions in active worktree | `⌘+K ⌘+M` | `Ctrl+K Ctrl+M` |
| Maximize all sessions in active worktree | `⌘+K ⌘+X` | `Ctrl+K Ctrl+X` |
| Reset renderers for all sessions in active worktree | `⌘+K ⌘+V` | `Ctrl+K Ctrl+V` |

## Panels

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open panel palette | `⌘+N` | `Ctrl+N` |
| Open diagnostics dock to Logs tab | `⌃+⇧+L` | `Ctrl+Shift+L` |
| Open diagnostics dock to Problems tab | `⌃+⇧+M` | `Ctrl+Shift+M` |
| Toggle diagnostics dock | `⌃+⇧+J` | `Ctrl+Shift+J` |
| Toggle notification inbox | `⌘+⇧+N` | `Ctrl+Shift+N` |
| Toggle portal panel | `⌘+\` | `Ctrl+\` |
| Open focused panel context menu | `⇧+F10` | `Shift+F10` |
| Open focused panel context menu | `ContextMenu` | `ContextMenu` |

## Portal

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Close active portal tab | `⌘+W` | `Ctrl+W` |
| Next portal tab | `⌃+Tab` | `Ctrl+Tab` |
| Previous portal tab | `⌃+⇧+Tab` | `Ctrl+Shift+Tab` |
| New portal tab | `⌘+T` | `Ctrl+T` |
| Close active portal tab | — | `Ctrl+F4` (Windows only) |

## Dev Preview

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Reload dev preview | `⌘+R` | `Ctrl+R` |

## Project

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| View all agents | `⌘+⌥+O` | `Ctrl+Alt+O` |
| Open project switcher | `⌘+⌥+P` | `Ctrl+Alt+P` |
| Switch to last project | `⌘+⌥+=` | `Ctrl+Alt+=` |

## Git

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Stage all changes | `⌘+K ⌘+G` | `Ctrl+K Ctrl+G` |
| Commit staged changes | `⌘+K ⌘+C` | `Ctrl+K Ctrl+C` |
| Push to remote | `⌘+K ⌘+P` | `Ctrl+K Ctrl+P` |

## Search

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Find in focused panel | `⌘+F` | `Ctrl+F` |

## View

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Zoom in | `⌘+=` | `Ctrl+=` |
| Zoom in | `⌘+⇧+=` | `Ctrl+Shift+=` |
| Zoom out | `⌘+-` | `Ctrl+-` |
| Reset zoom | `⌘+0` | `Ctrl+0` |

## Layout

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Undo last layout change | `⌘+⌥+Z` | `Ctrl+Alt+Z` |
| Redo last layout change | `⌘+⌥+⇧+Z` | `Ctrl+Alt+Shift+Z` |

## Voice

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Toggle voice dictation | `⌘+⇧+V` | `Ctrl+Shift+V` |
| Toggle voice dictation in Daintree Assistant | `⌘+⇧+⌥+V` | `Ctrl+Shift+Alt+V` |
| Pause or resume voice dictation | `⌃+⇧+Space` | `Ctrl+Shift+Space` |

## Help

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open keyboard shortcuts reference | `⌘+K ⌘+S` | `Ctrl+K Ctrl+S` |
| Open keyboard shortcuts reference | `⌘+/` | `Ctrl+/` |
| Launch help agent | `⌘+⇧+H` | `Ctrl+Shift+H` |
| Toggle Daintree Assistant panel | `⌘+L` | `Ctrl+L` |

## App

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open theme palette | `⌘+K ⌘+T` | `Ctrl+K Ctrl+T` |

## System

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open a new window | `⌘+⇧+⌥+N` | `Ctrl+Shift+Alt+N` |
| Open settings | `⌘+,` | `Ctrl+,` |

## Fixed keys

A few interactions are fixed and not rebindable: worktree-list navigation (arrows or `j`/`k` to move, PageUp/PageDown and Home/End to jump, Space or Enter to open, Enter/ArrowRight to reach a row's toolbar, `Alt+Up`/`Alt+Down` to reorder) and keyboard drag-and-drop reordering (Space to pick up, arrows to move).
