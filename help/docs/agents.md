# Agents

## Overview

Canopy orchestrates external AI coding agent CLIs. Agents run in real terminal panels — Canopy wraps them with state intelligence, context injection, and multi-agent coordination.

## Supported Agents

| Agent        | Command        | Shortcut  | Strengths                                |
| ------------ | -------------- | --------- | ---------------------------------------- |
| **Claude**   | `claude`       | Cmd+Alt+C | Refactoring, debugging, code review      |
| **Gemini**   | `gemini`       | Cmd+Alt+G | Architecture, exploration, system design |
| **Codex**    | `codex`        | Cmd+Alt+X | Frontend, testing, methodical execution  |
| **OpenCode** | `opencode`     | Cmd+Alt+O | Provider-agnostic, open source           |
| **Cursor**   | `cursor-agent` | Cmd+Alt+U | General-purpose agentic CLI              |

## Launching Agents

There are several ways to launch an agent:

1. **Agent Palette** (Cmd+Shift+A) — Select from all available agents
2. **Direct shortcut** — Use the agent-specific keyboard shortcut
3. **Panel Palette** (Cmd+N) — Choose "Agent" panel type
4. **Context menu** — Right-click a worktree card to launch an agent in that worktree

Agents launch in the active worktree by default.

## Agent State Detection

Canopy monitors agent terminal output to detect the agent's current state:

| State         | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| **Idle**      | Agent is at its prompt, waiting for input                     |
| **Working**   | Agent is actively processing (generating code, running tools) |
| **Waiting**   | Agent is waiting for user input or confirmation               |
| **Completed** | Agent has finished a task                                     |

State detection drives several features:

- The panel header shows the current state with a colored indicator
- **Cmd+Alt+/** jumps to the next waiting agent (needs your attention)
- **Cmd+Alt+.** jumps to the next working agent
- Completion notifications alert you when an agent finishes

## Agent Navigation

- **Cmd+Alt+K** — Cycle to the next agent panel
- **Cmd+Alt+J** — Cycle to the previous agent panel
- **Cmd+Alt+/** — Jump to the next waiting agent
- **Cmd+Alt+.** — Jump to the next working agent
- **Cmd+Shift+/** — Jump to the next waiting dock agent

## Model Selection

Some agents support model selection at launch time:

- **Claude**: Sonnet 4.6, Opus 4.6, Haiku 4.5
- **Gemini**: Gemini 2.5 Pro, Gemini 2.5 Flash
- **Codex**: GPT-5.4, o3

The model can be selected in the agent palette before launching.

## Session Management

- Agents can be **restarted** (Cmd+K Cmd+R restarts all)
- Agent sessions can be **resumed** if the agent CLI supports it (Claude, Gemini, Codex)
- Panels can be **hibernated** when switching projects and restored later

## Bulk Operations

- **Cmd+Shift+B** — Open Bulk Operations to send commands to multiple agents
- **Cmd+K Cmd+E** — End all sessions in the active worktree
- **Cmd+K Cmd+T** — Restart all sessions in the active worktree
