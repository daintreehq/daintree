# Canopy Help System

This directory is a self-contained workspace for running an AI coding agent as an interactive Canopy help assistant. Start any supported CLI agent here and it will automatically pick up the instruction files and documentation.

## Quick Start

```bash
cd help

# Use any of these:
claude          # Claude Code
gemini          # Gemini CLI
codex           # Codex CLI
```

The agent will identify itself as a Canopy help assistant and answer questions about features, keybindings, workflows, and configuration using the bundled documentation.

## Supported Agents

| Agent       | Command  | Instruction File | Config                  |
| ----------- | -------- | ---------------- | ----------------------- |
| Claude Code | `claude` | `CLAUDE.md`      | `.claude/settings.json` |
| Gemini CLI  | `gemini` | `GEMINI.md`      | `.gemini/settings.json` |
| Codex CLI   | `codex`  | `AGENTS.md`      | —                       |

## Documentation

The `docs/` directory contains user-facing documentation covering all major Canopy features:

| File                        | Topic                                     |
| --------------------------- | ----------------------------------------- |
| `getting-started.md`        | Onboarding, installation, first project   |
| `panels-and-grid.md`        | Panel types, grid layout, dock            |
| `agents.md`                 | Agent support, launching, state detection |
| `worktrees.md`              | Git worktree orchestration                |
| `keybindings.md`            | Keyboard shortcuts reference              |
| `actions.md`                | Action system and command palette         |
| `context-injection.md`      | CopyTree and context workflows            |
| `recipes.md`                | Terminal recipes                          |
| `themes.md`                 | Theme system and customization            |
| `browser-and-devpreview.md` | Embedded browser and dev preview          |
| `workflows.md`              | Workflow engine and automation            |

## How It Works

Each agent CLI looks for instruction files in its working directory:

- **Claude Code** reads `CLAUDE.md` and `.claude/settings.json`
- **Gemini CLI** reads `GEMINI.md` and `.gemini/settings.json`
- **Codex CLI** reads `AGENTS.md`

The instruction files tell the agent to act as a help assistant rather than a general-purpose coding agent. Permission configs restrict agents to read-only access — they can read the documentation but cannot modify files or run commands.

## Future

A docs API from the Canopy website will provide richer search capabilities (see canopyide/canopy-website#3). When available, MCP server configuration can be added to the agent settings files for live documentation search.
