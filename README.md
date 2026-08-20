<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/brand/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/brand/wordmark-light.svg">
    <img alt="Daintree" src="https://cdn.daintree.org/brand/wordmark-dark.svg" width="280">
  </picture>
</p>

<p align="center"><strong>A habitat for your AI coding agents.</strong></p>

<p align="center">
  Run several agents in parallel, each in its own worktree, isolated and observable, with you still in the loop.
</p>

<p align="center">
  <a href="https://github.com/daintreehq/daintree/releases"><img alt="Release" src="https://img.shields.io/github/v/release/daintreehq/daintree?style=flat-square"></a>&nbsp;
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>&nbsp;
  <a href="https://github.com/daintreehq/daintree/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/daintreehq/daintree/ci.yml?branch=develop&style=flat-square"></a>&nbsp;
  <a href="https://github.com/daintreehq/daintree/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/daintreehq/daintree?style=social"></a>
</p>

<p align="center">
  <img alt="Daintree desktop: four agents working in parallel, Daintree theme on the left half and Hokkaido on the right" src="https://cdn.daintree.org/screenshots/latest/hero-v2.webp">
</p>

## Install

Builds for macOS, Windows, and Linux live at [daintree.org/download](https://daintree.org/download). macOS ships as a signed-and-notarized DMG in `arm64`, `x64`, and universal variants. Linux ships as `AppImage` and `.deb`. Windows ships as a sideloadable `.appx` while the Microsoft Store listing is in review. Homebrew and winget recipes are coming.

<p align="center">
  <a href="https://daintree.org/download"><img alt="Download Daintree for macOS, Windows, or Linux" src="https://cdn.daintree.org/brand/download-button-v3.svg" width="340"></a>
</p>

## The problem

- **Agent fatigue.** Five terminals, three agents, no clue who's stuck.
- **Worktree sprawl.** Every agent wants its own branch. Managing five at once is its own job.
- **Review is the bottleneck.** Generation is fast. Supervising what came back is what eats the day.

Daintree is the macro-orchestration layer for this workflow. The longer version of the pitch is in [docs/vision.md](docs/vision.md).

## Daintree Assistant

<p align="center">
  <img alt="Daintree Assistant connecting to six agent terminals: Claude Code, Gemini CLI, Codex, Cursor, GitHub Copilot CLI, and Crush" src="https://cdn.daintree.org/brand/assistant-diagram-v3.svg" width="900">

</p>

Daintree is built for running a large number of AI coding agent terminals in parallel across many git worktrees. That's the main job of the app. The **Daintree Assistant** sits on top of that and drives it for you. It runs on the agent CLI you already have, whether that's Claude Code, Gemini CLI, Codex, or GitHub Copilot CLI, so there's no extra subscription. From there it can spawn new agent terminals in any worktree, broadcast a single prompt to many at once, watch their progress, inject context, run git operations, and report back. Anything you can trigger from Daintree's action palette, the Assistant can trigger too.

Under the hood it's a sandboxed agent session. When the backend is Claude Code, it attaches to a local `daintree` MCP server that exposes the action system at the authorization tier you grant. It also connects to a live `daintree-docs` server so it can answer how-to questions about Daintree on the side.

What that looks like in practice:

- Spawn six Claude Code terminals across six worktrees and broadcast the same prompt to all of them.
- Watch every agent panel and tell you which ones are waiting on input and which finished.
- Run any Daintree action by name: switch projects, dock panels, kick off a dev server, run a git op.
- Subscribe to events so it pings you when the agent in `bugfix/foo` stops responding.

## Features

- **Fleet Broadcasting.** One prompt fans out to N agents. Target filtering, live draft preview, per-agent edits before send.
- **Worktree Dashboard.** Every branch in one view. Auto PR and issue detection, dev-server lifecycle, commit composer.
- **Context Injection.** Select files, ship structured context into any agent's terminal. Built on [CopyTree](https://github.com/gregpriday/copytree).
- **MCP Server.** Agents call Daintree actions directly. Per-tier authorization, audit log, idempotency.
- **Action Palette + 15 themes.** Over 300 keyboard-first actions and a palette-based theme system with accessibility tokens.
- **Notification Center.** Agents run unattended. The inbox tells you what needs you and what can wait.
- **Voice input.** OpenAI Realtime dictation for quick prompts. Optional, needs an API key.

A screenshot-driven feature grid lands in the next pass.

## Works with

Claude Code, Gemini CLI, Codex, GitHub Copilot CLI, Cursor, Aider, OpenCode, Goose, Crush, Qwen Code, Open Interpreter, Mistral Vibe, Kimi Code, Kiro, and Amp.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/brand/agents-row-dark-v2.png">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/brand/agents-row-light-v2.png">
    <img alt="Supported agents" src="https://cdn.daintree.org/brand/agents-row-dark-v2.png" width="900">
  </picture>
</p>

## Build from source

Clone, install, then run the package command for your platform. Builds land in `release/` by default; pass `-c.directories.output=<path>` to electron-builder if you want them somewhere else.

```bash
git clone https://github.com/daintreehq/daintree.git
cd daintree
npm install
```

| Platform | Command                 | Output                                 |
| -------- | ----------------------- | -------------------------------------- |
| macOS    | `npm run package:mac`   | `.dmg`, `.zip` (arm64, x64, universal) |
| Windows  | `npm run package:win`   | `.appx`, `.msix`                       |
| Linux    | `npm run package:linux` | `.AppImage`, `.deb`                    |

The `postinstall` step rebuilds `node-pty` for Electron automatically. If you see PTY errors, run `npm run rebuild`.

Performance benchmarks live in `scripts/perf/` and run through one command — `npm run perf list` shows every benchmark and how to invoke it.

For AI features, open **Settings** (bottom-left sidebar) and configure your GitHub token and per-agent defaults.

## Install agent CLIs

Daintree works with whatever agent you've already installed. **Settings → Agents** has a one-click installer for each platform — or follow the canonical install docs:

| Agent | Install docs |
| --- | --- |
| Claude Code | [code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup) |
| Gemini CLI | [geminicli.com/docs](https://geminicli.com/docs) |
| Codex CLI | [github.com/openai/codex](https://github.com/openai/codex) |
| Cursor Agent | [cursor.com/cli](https://cursor.com/cli) |
| GitHub Copilot CLI | [docs.github.com/…/install-copilot-cli](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) |
| Crush | [github.com/charmbracelet/crush](https://github.com/charmbracelet/crush) |
| Amp | [ampcode.com/manual](https://ampcode.com/manual) |
| OpenCode | [opencode.ai/install](https://opencode.ai/install) |
| Aider | [aider.chat/docs/install.html](https://aider.chat/docs/install.html) |
| Goose | [goose-docs.ai/docs/getting-started/installation](https://goose-docs.ai/docs/getting-started/installation) |

See [Works with](#works-with) for the full list of agents Daintree can launch.

## Documentation

- [Architecture](docs/architecture/): system design, IPC patterns, terminal lifecycle
- [Development guide](docs/development.md): setup, debugging, contribution workflow
- [Theme system](docs/themes/theme-system.md): theme pipeline, tokens, runtime
- [E2E testing](docs/e2e-testing.md): Playwright setup and patterns
- [Release process](docs/release.md): versioning and release workflow

## License

Apache 2.0. See [LICENSE](LICENSE) and [TRADEMARKS.md](TRADEMARKS.md) for the brand and marks policy.

<p align="center">
  <a href="https://daintree.org">Website</a>  ·  
  <a href="docs/architecture/">Architecture</a>  ·  
  <a href="https://github.com/daintreehq/daintree/issues">Issues</a>
</p>
