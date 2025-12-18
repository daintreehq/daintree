# Canopy Command Center

[![CI](https://github.com/gregpriday/canopy-electron/actions/workflows/ci.yml/badge.svg)](https://github.com/gregpriday/canopy-electron/actions/workflows/ci.yml)

**The AI-Native Mini IDE for Agent Orchestration**

Canopy is a feature-rich, Electron-based command center designed to streamline the workflow of developing with AI coding agents. It bridges the gap between your terminal, your git worktrees, and AI CLI tools like Claude Code, Gemini, and Codex.

Instead of juggling multiple terminal windows and manually copying context, Canopy provides a unified dashboard to monitor worktrees, orchestrate agents, and inject codebase context with a single click.

## Key Features

### Worktree Dashboard

- **Visual Monitoring**: View all git worktrees at a glance with real-time status updates
- **Smart Summaries**: AI-powered summaries of file changes in every branch
- **GitHub Integration**: Auto-detects associated Pull Requests and Issues based on branch names
- **Dev Server Control**: Auto-detects `package.json` scripts and manages dev server lifecycles per worktree

### Agent Orchestration

- **Smart Terminals**: Integrated terminal grid capable of running standard shells or AI agents
- **Lifecycle Tracking**: Automatically detects if an agent is `working`, `waiting` for input, or `completed` based on output heuristics
- **Waiting For You**: A dedicated notification strip that alerts you immediately when an agent needs human input

### Context Injection

- **One-Click Context**: Integrated with [CopyTree](https://github.com/gregpriday/copytree) for intelligent context generation
- **Smart Selection**: Pick specific files or folders to inject into the active agent's terminal
- **Format Optimization**: Automatically selects the best format (XML, Markdown) based on the running agent

## Prerequisites

- **Node.js**: v20+ recommended
- **Git**: v2.30+
- **AI Agents (Optional)**: For the best experience, install the CLIs for the agents you intend to use:

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code

# Codex CLI
npm install -g @openai/codex
```

## Getting Started

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/gregpriday/canopy-electron.git
   cd canopy-electron
   ```

2. **Install dependencies:**

   > **Important:** Use `npm install`, not `npm ci`. This project includes native modules (`node-pty`) that must be built against the Electron runtime.

   ```bash
   npm install
   ```

3. **Rebuild Native Modules (if needed):**

   The post-install script should handle this, but if you see errors regarding `node-pty`, run:

   ```bash
   npm run rebuild
   ```

### Running the App

Start the development environment (runs Vite renderer and Electron main process concurrently):

```bash
npm run dev
```

## Configuration

Canopy works out of the box for local terminal management, but AI features require configuration via the **Settings** icon (bottom left sidebar).

1. **GitHub Token**: Required for fetching PR statuses and issue details without hitting rate limits
2. **Agent Settings**: Configure default models and flags for Claude, Gemini, and Codex

## Architecture

Canopy uses a modern Electron architecture ensuring security and performance:

- **Main Process (`/electron`)**: Built with **TypeScript**, handles native operations (pty management, file system, git) and exposes services via a secure IPC bridge
- **Renderer Process (`/src`)**: Built with **React 19**, **Vite**, and **Tailwind CSS v4**. Uses **Zustand** for state management
- **Communication**: Strictly typed IPC channels defined in `electron/ipc/`

### Key Technologies

| Component          | Technology                         |
| ------------------ | ---------------------------------- |
| Runtime            | Electron 33                        |
| UI Framework       | React 19 + TypeScript              |
| Build              | Vite 6                             |
| State Management   | Zustand                            |
| Terminal Emulation | xterm.js + @xterm/addon-fit/canvas |
| PTY                | node-pty (native module)           |
| Git                | simple-git                         |
| Styling            | Tailwind CSS v4                    |
| AI Integration     | Agent CLIs (Claude, Gemini, Codex) |

## Build & Distribute

To create a production build for your OS:

```bash
# Full production build
npm run build

# Package for distribution (auto-detects platform)
npm run package

# Platform-specific packaging
npm run package:mac
npm run package:win
npm run package:linux
```

## Development Commands

```bash
# Start development (Electron + Vite concurrently)
npm run dev

# Run all checks (typecheck + lint + format) - use before committing
npm run check

# Auto-fix formatting and lint issues
npm run fix

# Run tests
npm run test
```

## Documentation

- [Architecture](docs/architecture.md) - System design, IPC patterns, project structure
- [Development Guide](docs/development.md) - Setup, commands, debugging
- [Services Reference](docs/services.md) - Main process services documentation
- [Contributing](docs/contributing.md) - Contribution guidelines and code style

## License

MIT License
