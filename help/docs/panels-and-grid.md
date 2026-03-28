# Panels and Grid

## Overview

The panel grid is Canopy's primary workspace. It displays multiple panels in a flexible grid layout, with an optional dock at the bottom for minimized panels.

## Panel Types

Canopy has five built-in panel types:

| Type            | Description                                                  | Has Terminal |
| --------------- | ------------------------------------------------------------ | ------------ |
| **Terminal**    | Standard shell terminal                                      | Yes          |
| **Agent**       | AI agent running in a terminal (Claude, Gemini, Codex, etc.) | Yes          |
| **Browser**     | Embedded web browser for viewing URLs                        | No           |
| **Notes**       | Markdown note editor for annotations alongside agent work    | No           |
| **Dev Preview** | Dev server preview with auto-detected localhost URLs         | No           |

## Creating Panels

- **Cmd+N** — Open the panel palette to create any panel type
- **Cmd+Shift+A** — Open the agent palette to launch a specific agent
- **Cmd+Alt+T** — Open a plain terminal
- **Cmd+T** — Duplicate the focused panel

## Grid Layout

Panels arrange in a responsive grid. Canopy automatically adjusts the grid as you add or remove panels.

- **Cmd+Shift+Alt+Arrow** — Move a panel within the grid (left/right/up/down)
- **Ctrl+Shift+F** — Toggle maximize on the focused panel (fills the entire grid)
- **Cmd+Alt+Z** — Undo the last layout change
- **Cmd+Alt+Shift+Z** — Redo a layout change

## Panel Focus and Navigation

- **Cmd+1** through **Cmd+9** — Focus panel by index
- **Ctrl+Tab** / **Ctrl+Shift+Tab** — Cycle through panels
- **Cmd+Alt+Arrow** — Focus the panel in that direction (up/down/left/right)
- **Cmd+P** — Quick Switcher to find any panel by name

## The Dock

The dock is a collapsed strip at the bottom of the window. Panels in the dock continue running but don't take up grid space. This is useful for agents you want to monitor without dedicating screen real estate.

- **Cmd+Alt+M** — Toggle the focused panel between grid and dock
- **Cmd+Alt+D** — Focus the active dock panel
- **Cmd+Shift+Alt+D** — Move focused panel to dock
- **Cmd+Shift+Alt+G** — Move focused panel to grid
- **Cmd+Alt+Shift+M** — Toggle all panels between grid and dock

## Closing Panels

- **Cmd+W** — Close the focused panel
- **Cmd+K Cmd+W** — Close all panels
- **Cmd+Shift+T** — Reopen the last closed panel

## Panel Tabs

When multiple panels share a grid cell, they display as tabs:

- **Cmd+Shift+]** — Next tab
- **Cmd+Shift+[** — Previous tab

## Panel Context Menu

Right-click a panel header or press **Shift+F10** to access panel-specific actions like restart, duplicate, move to dock, and close.
