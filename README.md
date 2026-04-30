# Daintree

**A habitat for your AI coding agents.**

> **Previously known as Canopy.** Same project, new name, new home at [daintree.org](https://daintree.org).

Daintree is a desktop environment where multiple AI agents work side by side — isolated, observable, and under your control. Instead of juggling terminal windows and manually wiring context between tools, Daintree gives your agents a stable place to run while you focus on reviewing their work.

It ships with deep, opinionated support for 15 CLI agents — [Claude Code](https://github.com/anthropics/claude-code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Codex](https://github.com/openai/codex), [OpenCode](https://opencode.ai/docs/), [Cursor Agent](https://cursor.com/features/cursor-agent), [Kiro](https://kiro.dev/cli/), [GitHub Copilot CLI](https://github.com/github/copilot-cli), [Goose](https://block.github.io/goose/), [Crush](https://github.com/charmbracelet/crush), [Qwen Code](https://github.com/QwenLM/qwen-code), [Open Interpreter](https://docs.openinterpreter.com/), [Mistral Vibe](https://github.com/mistralai/mistral-vibe), [Kimi Code](https://github.com/MoonshotAI/kimi-cli), [Amp](https://ampcode.com/manual), and [Aider](https://aider.chat/) — and stays out of the way.

---

## Why Daintree

The way developers work is changing. Running multiple AI coding agents in parallel across git worktrees is becoming the standard workflow, and the developer's role is shifting from writing code to supervising agent fleets: specifying tasks, dispatching agents, monitoring progress, reviewing output, and shipping results. But the tooling hasn't caught up. You end up with a dozen terminal tabs, no visibility into what each agent is doing, and no clean way to review or merge the results.

Daintree is the **macro-orchestration layer** for this workflow. It handles the infrastructure concerns that agents can't provide for themselves: worktree lifecycle, dev server management, resource governance, cross-agent state aggregation, and human review workflows.

- **Automatic isolation** — Each task gets its own git worktree. Agents never collide.
- **Visibility at a glance** — See what every agent is doing, which ones need input, and what's changed across all branches.
- **Review-first workflows** — The bottleneck isn't generation speed, it's reviewing what agents produce. Daintree is built around making that fast.
- **Zero lock-in** — Your machine, your keys, your choice of agents. Daintree is agent-agnostic by design.

---

## Features

### Worktree Dashboard

View all git worktrees in a single dashboard with real-time status. Daintree auto-detects associated Pull Requests and Issues from branch names, shows commit-based summaries of changes, and manages dev server lifecycles per worktree.

### Agent Orchestration

Run multiple agents in a panel grid. Daintree tracks agent state automatically — `idle`, `working`, `waiting`, `completed`, `failed` — via output analysis. A notification strip alerts you the moment any agent needs human input, so you can walk away and come back when there's something to review.

### Context Injection

Inject codebase context into any agent's terminal with a single click. Built on [CopyTree](https://github.com/gregpriday/copytree), Daintree generates structured context in a format optimized for AI consumption. Select specific files or folders, and the context flows directly into the active session.

### Multi-Panel Environment

Drag-and-drop panel grid with dock and trash. Panels can be terminals, agent sessions, browser previews, dev server previews, or notes. The layout persists across sessions, and inactive projects auto-hibernate to keep things responsive.

### Recipes

Configurable multi-terminal launch presets. Define a recipe with any combination of agents, terminals, and dev previews — then launch them all at once. Recipes support variable substitution (issue number, branch name, worktree path) and can be scoped to a project or shared globally.

### MCP Server

Daintree exposes all of its actions as tools via the [Model Context Protocol](https://modelcontextprotocol.io/). Any MCP-compatible agent can discover and invoke Daintree actions — creating worktrees, spawning terminals, injecting context, or running git operations — without leaving their session.

### GitHub Integration

Automatic PR and issue detection from branch names. Repository statistics, commit history, and secure token-based authentication — all built in.

### Themes

14 built-in themes with dark and light modes. The theme system supports palette-based colour derivation, semantic tokens, terminal colour mapping, and colour-vision accessibility modes.

### Resource Profiles

Adaptive performance management with three profiles — Performance, Balanced, and Efficiency — that adjust polling intervals, WebGL context limits, and memory pressure thresholds based on system state.

---

## Vision

Daintree exists because the developer's job is changing. The inner loop used to be write, compile, test, iterate. Now it's specify, dispatch, monitor, review, merge. Most of a developer's time goes to writing good specs, reviewing agent output, and unblocking stuck agents. Almost none of it goes to typing code.

This shift creates a real gap in tooling. IDEs are built for writing code. Terminals are built for running commands. Neither is built for supervising a fleet of concurrent agents across isolated worktrees.

That's where Daintree fits. It's the local control plane for this new workflow.

### Where Daintree sits

The AI coding agent space has settled into clear layers. CLI agents (Claude Code, Gemini CLI, Codex, Aider) handle execution. Cloud platforms (Devin, Factory) handle long-running autonomous tasks in remote VMs. IDEs (Cursor, Windsurf, Zed) handle single-agent pair programming tied to one branch.

Daintree occupies the space between these: a local desktop environment for supervising 3 to 10 concurrent CLI agents, each running in its own worktree, with the infrastructure and visibility that terminals can't provide. It's agent-agnostic, cross-platform, and entirely local-first. Your machine, your keys, your code.

### What we're building toward

The core pillars are stable: panel grid, agent state intelligence, worktree orchestration, context injection, review workflows, dev server management. These aren't changing.

What's evolving is how deeply Daintree integrates with the agents it orchestrates. Through MCP (Model Context Protocol), Daintree exposes its entire action system as tools that agents can discover and invoke programmatically. An agent can request a worktree, read the state of sibling panels, subscribe to completion notifications from peers, or pull aggregated diffs, all without the developer manually bridging the gap. This bidirectional integration is Daintree's deepest technical moat.

The other frontier is resource governance. Running 5 to 10 agents, each with its own dev server and terminal, puts real pressure on a developer's machine. Daintree's adaptive resource profile system (Performance, Balanced, Efficiency) already throttles based on memory pressure, event loop lag, and battery state. As agent counts grow, this infrastructure becomes more important, not less.

The goal isn't to become an IDE or a cloud platform. It's to be the best possible local supervision layer for the developer who's managing a small fleet of agents every day, and to stay focused on that.

---

## Getting Started

### Prerequisites

- **Node.js** v22+
- **Git** v2.30+

### Install

```bash
git clone https://github.com/daintreehq/daintree.git
cd daintree
npm install
```

> The `postinstall` script rebuilds native modules (`node-pty`) for Electron automatically. If you see PTY errors, run `npm run rebuild`.

### Run

```bash
npm run dev
```

This starts both the Vite renderer and Electron main process.

### Configure

Daintree works immediately for terminal management. For AI features, open **Settings** (bottom-left sidebar):

1. **GitHub Token** — Enables PR/issue detection without rate limits
2. **Agent Settings** — Configure default models and flags for each agent CLI

### Install Agent CLIs

Daintree works with any agent you have installed. The Settings → Agents tab lists every supported agent with a one-click installer for your platform; the commands below are the canonical recipes for reference.

**npm (cross-platform):**

```bash
npm install -g @anthropic-ai/claude-code    # Claude Code
npm install -g @google/gemini-cli           # Gemini CLI
npm install -g @openai/codex                # Codex
npm install -g opencode-ai@latest           # OpenCode
npm install -g @github/copilot              # GitHub Copilot CLI
npm install -g @qwen-code/qwen-code         # Qwen Code
npm install -g @sourcegraph/amp             # Amp
```

**Shell installer (macOS/Linux):**

```bash
curl https://cursor.com/install -fsS | bash                                                     # Cursor Agent
curl -fsSL https://cli.kiro.dev/install | bash                                                  # Kiro
curl -fsSL https://opencode.ai/install | bash                                                   # OpenCode
curl -fsSL https://ampcode.com/install.sh | bash                                                # Amp
curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash       # Goose
curl -LsSf https://mistral.ai/vibe/install.sh | bash                                            # Mistral Vibe
curl -LsSf https://aider.chat/install.sh | sh                                                   # Aider
```

**Other ecosystems:**

```bash
brew install charmbracelet/tap/crush        # Crush (Homebrew)
go install github.com/charmbracelet/crush@latest  # Crush (Go)
uv tool install kimi-cli                    # Kimi Code (uv)
uv tool install open-interpreter            # Open Interpreter (uv)
pipx install aider-chat                     # Aider (pipx)
```

---

## Architecture

Daintree uses a three-process Electron architecture:

```
Main Process (electron/)            Renderer (src/)
├── PTY Management                  ├── React 19 + TypeScript
├── Git Operations                  ├── Zustand State Management
├── IPC Handlers                    ├── xterm.js Terminal Grid
└── Utility Processes               └── Action System (265 actions)
     ├── PTY Host (SharedRingBuffer)
     └── Workspace Host (Worktree Monitor)
```

- **Main Process** — Native operations (PTY, filesystem, git) exposed through a typed IPC bridge with 56 namespaces.
- **Renderer** — React 19 UI with Vite HMR. Zustand stores with atomic selectors for performance across many simultaneous panels.
- **Utility Processes** — Isolated PTY Host with lock-free SharedRingBuffer flow control, and Workspace Host for continuous worktree monitoring.

### Tech Stack

| Layer       | Technology                            |
| ----------- | ------------------------------------- |
| Runtime     | Electron 41                           |
| UI          | React 19, TypeScript, Tailwind CSS v4 |
| Build       | Vite 8                                |
| State       | Zustand v5                            |
| Terminal    | @xterm/xterm 6.0, node-pty 1.2        |
| Git         | simple-git 3.33                       |
| Database    | better-sqlite3, Drizzle ORM           |
| Drag & Drop | dnd-kit                               |
| Validation  | Zod v4                                |
| AI/MCP      | @modelcontextprotocol/sdk, OpenAI SDK |
| Testing     | Vitest, Playwright                    |

---

## Development

```bash
npm run dev          # Start Electron + Vite
npm run check        # Typecheck + lint + format
npm run fix          # Auto-fix lint and formatting
npm run test         # Run tests
npm run test:watch   # Watch mode
npm run rebuild      # Rebuild native modules
```

### Build & Package

```bash
npm run build        # Production build
npm run package      # Package for current platform
npm run package:mac  # macOS (DMG, ZIP — arm64, x64, universal)
npm run package:win  # Windows (NSIS, portable)
npm run package:linux # Linux (AppImage, deb)
```

---

## Project Structure

```
daintree/
├── electron/                # Main process
│   ├── main.ts              # Entry point
│   ├── preload.cts          # IPC bridge (contextBridge, 56 namespaces)
│   ├── pty-host.ts          # Isolated PTY host process
│   ├── workspace-host.ts    # Worktree monitoring process
│   ├── ipc/handlers/        # ~107 IPC handler files
│   └── services/            # ~93 backend services
│
├── src/                     # Renderer (React)
│   ├── components/          # 42 component directories
│   ├── store/               # 59 Zustand stores
│   ├── services/actions/    # 29 action definition files
│   ├── hooks/               # 87 React hooks
│   ├── panels/              # Panel kind modules (5 types)
│   └── clients/             # IPC client wrappers
│
├── shared/                  # Types and config (main + renderer)
│   ├── types/               # 35 type files + 21 IPC type files
│   ├── config/              # Panel, agent, and feature registries
│   └── theme/               # 14 built-in themes, token system
│
├── e2e/                     # Playwright E2E tests
│   ├── core/                # 13 tests — gates releases
│   ├── full/                # 61 tests — nightly
│   ├── online/              # 2 tests — agent integration
│   └── nightly/             # Memory leak detection
│
├── scripts/                 # Build, dev, and perf scripts
├── help/                    # Embedded help documentation
└── docs/                    # Architecture and development docs
```

---

## Documentation

- [Architecture](docs/architecture/) — System design, IPC patterns, terminal lifecycle
- [Development Guide](docs/development.md) — Setup, debugging, contribution workflow
- [Theme System](docs/themes/theme-system.md) — Theme pipeline, tokens, and runtime
- [E2E Testing](docs/e2e-testing.md) — Playwright testing setup and patterns
- [Feature Curation](docs/feature-curation.md) — How we evaluate new features
- [Sound Design](docs/sound-design.md) — Audio and notification guidelines
- [Release Process](docs/release.md) — Versioning and release workflow

---

## License

Daintree is released under the [Apache License 2.0](LICENSE).

The Daintree name and logo are not covered by that license. See [TRADEMARKS.md](TRADEMARKS.md) for the brand and marks policy.
