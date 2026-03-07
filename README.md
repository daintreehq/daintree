# Canopy

**A habitat for your AI coding agents.**

Canopy is a desktop environment where multiple AI agents work side by side — isolated, observable, and under your control. Instead of juggling terminal windows and manually wiring context between tools, Canopy gives your agents a stable place to run while you focus on reviewing their work.

It works with any CLI agent — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Codex](https://github.com/openai/codex), [OpenCode](https://github.com/opencode-ai/opencode) — and stays out of the way.

---

## Why Canopy

Running AI agents in parallel is becoming the standard workflow. But the tooling around it hasn't caught up. You end up with a dozen terminal tabs, no visibility into what each agent is doing, and no clean way to review or merge the results.

Canopy solves this by providing:

- **Automatic isolation** — Each task gets its own git worktree. Agents never collide.
- **Visibility at a glance** — See what every agent is doing, which ones need input, and what's changed across all branches.
- **Review-first workflows** — The bottleneck isn't generation speed, it's reviewing what agents produce. Canopy is built around making that fast.
- **Zero lock-in** — Your machine, your keys, your choice of agents. Canopy is agent-agnostic by design.

---

## Features

### Worktree Dashboard

View all git worktrees in a single dashboard with real-time status. Canopy auto-detects associated Pull Requests and Issues from branch names, shows commit-based summaries of changes, and manages dev server lifecycles per worktree.

### Agent Orchestration

Run multiple agents in a panel grid. Canopy tracks agent state automatically — `idle`, `working`, `waiting`, `completed`, `failed` — via output analysis. A notification strip alerts you the moment any agent needs human input, so you can walk away and come back when there's something to review.

### Context Injection

Inject codebase context into any agent's terminal with a single click. Built on [CopyTree](https://github.com/gregpriday/copytree), Canopy generates structured context in a format optimized for AI consumption. Select specific files or folders, and the context flows directly into the active session.

### Multi-Panel Environment

Drag-and-drop panel grid with dock and trash. Panels can be terminals, agent sessions, browser previews, or notes. The layout persists across sessions, and inactive projects auto-hibernate to keep things responsive.

### GitHub Integration

Automatic PR and issue detection from branch names. Repository statistics, commit history, and secure token-based authentication — all built in.

---

## Getting Started

### Prerequisites

- **Node.js** v22+
- **Git** v2.30+

### Install

```bash
git clone https://github.com/gregpriday/canopy-electron.git
cd canopy-electron
npm install
```

> The `postinstall` script rebuilds native modules (`node-pty`) for Electron automatically. If you see PTY errors, run `npm run rebuild`.

### Run

```bash
npm run dev
```

This starts both the Vite renderer and Electron main process.

### Configure

Canopy works immediately for terminal management. For AI features, open **Settings** (bottom-left sidebar):

1. **GitHub Token** — Enables PR/issue detection without rate limits
2. **Agent Settings** — Configure default models and flags for each agent CLI

### Install Agent CLIs

Canopy works with any agent you have installed:

```bash
npm install -g @anthropic-ai/claude-code    # Claude Code
npm install -g @openai/codex                # Codex CLI
npm install -g opencode-ai@latest           # OpenCode
```

---

## Architecture

Canopy uses a three-process Electron architecture:

```
Main Process (electron/)            Renderer (src/)
├── PTY Management                  ├── React 19 + TypeScript
├── Git Operations                  ├── Zustand State Management
├── IPC Handlers                    ├── xterm.js Terminal Grid
└── Utility Processes               └── Action System
     ├── PTY Host (SharedRingBuffer)
     └── Workspace Host (Worktree Monitor)
```

- **Main Process** — Native operations (PTY, filesystem, git) exposed through a typed IPC bridge with 36 namespaces.
- **Renderer** — React 19 UI with Vite HMR. Zustand stores with atomic selectors for performance across many simultaneous panels.
- **Utility Processes** — Isolated PTY Host with lock-free SharedRingBuffer flow control, and Workspace Host for continuous worktree monitoring.

### Tech Stack

| Layer       | Technology                            |
| ----------- | ------------------------------------- |
| Runtime     | Electron 40                           |
| UI          | React 19, TypeScript, Tailwind CSS v4 |
| Build       | Vite 6                                |
| State       | Zustand v5                            |
| Terminal    | @xterm/xterm 6.0, node-pty 1.0        |
| Git         | simple-git 3.30                       |
| Drag & Drop | dnd-kit                               |
| Validation  | Zod                                   |

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
npm run package:mac  # macOS
npm run package:win  # Windows
npm run package:linux
```

---

## Project Structure

```
canopy-electron/
├── electron/                # Main process
│   ├── main.ts              # Entry point
│   ├── preload.cts          # IPC bridge (contextBridge)
│   ├── ipc/handlers/        # Domain-specific IPC handlers
│   └── services/            # PTY, workspace, GitHub services
│
├── src/                     # Renderer (React)
│   ├── components/          # UI components
│   ├── store/               # Zustand stores and slices
│   ├── services/actions/    # Action system (20 definition files)
│   ├── hooks/               # React hooks
│   └── clients/             # IPC client wrappers
│
├── shared/                  # Types and config (main + renderer)
│   ├── types/               # Domain, action, keymap types
│   └── config/              # Panel and agent registries
│
└── docs/                    # Architecture and development docs
```

---

## Documentation

- [Architecture](docs/architecture/) — System design, IPC patterns, terminal lifecycle
- [Development Guide](docs/development.md) — Setup, debugging, contribution workflow
- [E2E Testing](docs/e2e-testing.md) — Playwright testing setup and patterns
- [Feature Curation](docs/feature-curation.md) — How we evaluate new features

---

## License

MIT
