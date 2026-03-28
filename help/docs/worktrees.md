# Worktrees

## Overview

Canopy uses git worktrees to let you partition work across multiple branches simultaneously. Each worktree is an independent working copy of your repository with its own branch, and Canopy monitors all of them from a single window.

## What Are Git Worktrees?

A git worktree lets you check out multiple branches of a repository at the same time, each in its own directory. Instead of stashing changes and switching branches, you can have `feature-a`, `feature-b`, and `main` all checked out simultaneously.

Canopy adds orchestration on top: monitoring file changes, tracking agent activity, and managing panels per worktree.

## The Worktree Sidebar

The sidebar (toggle with **Cmd+B**) shows all worktrees for the current project. Each worktree card displays:

- Branch name
- File change summary (modified, added, deleted)
- Active agent sessions and their states
- Sync status with remote

## Switching Worktrees

- **Cmd+Alt+1** through **Cmd+Alt+9** — Switch to worktree by index
- **Cmd+Alt+]** / **Cmd+Alt+[** — Next/previous worktree
- **Cmd+K W** — Open the worktree palette for search
- **Cmd+Shift+O** — Toggle the worktrees overview

When you switch worktrees, the panel grid updates to show panels associated with that worktree. Panels from other worktrees continue running in the background.

## Worktree Operations

From the worktree sidebar or overview:

- **Launch agents** in a specific worktree via right-click context menu
- **Open in editor** — Press **E** on a selected worktree card to open it in your code editor
- **Copy tree context** — **Cmd+Shift+C** generates a CopyTree context summary for the active worktree

## Worktree Sessions

Each worktree tracks its own set of panel sessions. Bulk session operations apply to the active worktree:

| Shortcut    | Action                   |
| ----------- | ------------------------ |
| Cmd+K Cmd+M | Dock all sessions        |
| Cmd+K Cmd+X | Maximize all sessions    |
| Cmd+K Cmd+T | Restart all sessions     |
| Cmd+K Cmd+E | End all sessions         |
| Cmd+K Cmd+D | Close completed sessions |
| Cmd+K Cmd+B | Trash all sessions       |

## Git Operations

Canopy provides lightweight git operations per worktree (not a full git GUI — use your editor for complex git work):

| Shortcut    | Action                |
| ----------- | --------------------- |
| Cmd+K Cmd+A | Stage all changes     |
| Cmd+K Cmd+C | Commit staged changes |
| Cmd+K Cmd+P | Push to remote        |

## Project Switching

Canopy supports multiple projects. Press **Cmd+Alt+P** to open the project switcher. Each project has its own set of worktrees and panel sessions.
