# Getting Started

## What is Canopy?

Canopy is a desktop application for orchestrating AI coding agents. Think of it as mission control for your AI-assisted development workflow. Agents like Claude, Gemini, and Codex run in real terminals inside Canopy, and you manage them through a panel grid with state intelligence, context injection, and automation.

Canopy is **not** a code editor (use VS Code for that) and **not** a chat UI (agents run in actual terminals). It's the orchestration layer where you direct work, monitor progress, and intervene when agents need help.

## Installation

Download Canopy from the [GitHub releases page](https://github.com/canopyide/canopy/releases) for your platform (macOS, Windows, or Linux).

## First Launch

When you first open Canopy:

1. **Project Setup** — Canopy will prompt you to open a project directory. This should be a git repository where you want to run agents.
2. **Agent Detection** — Canopy checks which agent CLIs are installed on your system (Claude, Gemini, Codex, OpenCode, Cursor). Install any you want to use before starting.
3. **Panel Grid** — You'll see the main panel grid where your terminals and agents live.

## Installing Agents

Canopy orchestrates external CLI agents. You need to install them separately:

| Agent        | Install Command                                | Auth                   |
| ------------ | ---------------------------------------------- | ---------------------- |
| Claude Code  | `npm install -g @anthropic-ai/claude-code`     | `claude auth login`    |
| Gemini CLI   | `npm install -g @google/gemini-cli`            | `gemini auth login`    |
| Codex CLI    | `npm install -g @openai/codex`                 | `codex auth login`     |
| OpenCode     | `npm install -g opencode-ai`                   | `/connect` in OpenCode |
| Cursor Agent | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login`   |

After installing an agent, restart Canopy to update the PATH.

## Launching Your First Agent

1. Press **Cmd+Shift+A** to open the agent palette
2. Select an agent (e.g., Claude)
3. The agent launches in a new panel in the grid
4. Type your prompt and press Enter

You can also use direct shortcuts:

- **Cmd+Alt+C** — Launch Claude
- **Cmd+Alt+G** — Launch Gemini
- **Cmd+Alt+X** — Launch Codex
- **Cmd+Alt+O** — Launch OpenCode
- **Cmd+Alt+U** — Launch Cursor

## Key Concepts

- **Panels** — The visual units in the grid. Each panel runs a terminal, agent, browser, notes editor, or dev preview.
- **Worktrees** — Git worktrees let you partition work across branches. Canopy monitors each worktree independently.
- **Context Injection** — Feed your agents the right codebase context using CopyTree.
- **Actions** — Every operation in Canopy is an action that can be triggered via keybinding, menu, or command palette.
- **Dock** — A collapsed area at the bottom for panels you want running but not occupying grid space.

## Platform Notes

Canopy runs on macOS, Windows, and Linux. Keybindings shown in this documentation use macOS notation:

- **Cmd** on macOS = **Ctrl** on Windows/Linux
- **Alt/Option** is the same across platforms
