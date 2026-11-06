<div align="center">

<img src="https://cdn.daintree.org/readme/v2/icon.png" width="88" height="88" alt="">

# Daintree

**An Electron desktop app that runs coding-agent CLIs in parallel, each in its own terminal and git worktree.**

Claude Code, Codex, Antigravity, OpenCode and [13&nbsp;more](#agent-clis) run as they are, with your existing config and login. Daintree reads each terminal to show which runs are working, waiting or finished, and gives every worktree a diff, commit and pull request view. macOS, Windows and Linux. Apache 2.0, no account, telemetry off by default.

[![Release](https://img.shields.io/github/v/release/daintreehq/daintree?label=release&color=0f7a4a)](https://daintree.org/changelog) [![Build](https://img.shields.io/github/actions/workflow/status/daintreehq/daintree/ci.yml?branch=main&label=build)](https://github.com/daintreehq/daintree/actions/workflows/ci.yml?query=branch%3Amain) [![License](https://img.shields.io/badge/license-Apache%202.0-0f7a4a)](LICENSE)

[Download](#download) · [How&nbsp;it&nbsp;works](#how-it-works) · [Agent&nbsp;CLIs](#agent-clis) · [MCP&nbsp;server](#mcp-server) · [Canopy](#canopy-inbox) · [Decisions](#daintree-decisions) · [Build&nbsp;from&nbsp;source](#build-from-source) · [Docs](#documentation)

<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/shot-hero-daintree--narrow.webp">
  <source media="(prefers-color-scheme: light) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/shot-hero-bondi--narrow.webp">
  <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v1/shot-hero-daintree.webp">
  <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v1/shot-hero-bondi.webp">
  <img alt="Antigravity waiting on a permission prompt to run git mv, in a Daintree window running four agent CLIs on one project, each in its own worktree: Claude Code, Antigravity, OpenCode and Codex." src="https://cdn.daintree.org/readme/v1/shot-hero-daintree.webp" width="896">
</picture>

<sub>Antigravity waiting on a permission prompt, one of four agents in one window, in the <a href="#themes">Daintree</a> theme (<a href="#themes">Bondi&nbsp;Beach</a> when GitHub is light)<br><a href="https://www.youtube.com/watch?v=ev1cbGSmkG0">Watch&nbsp;the&nbsp;five-minute&nbsp;walkthrough</a></sub>

</div>

## Download

Get the latest build at **[daintree.org/download](https://daintree.org/download)**.

| Platform | Package |
| --- | --- |
| **macOS&nbsp;13+** | Signed and notarized `.dmg` for Apple Silicon, Intel or Universal |
| **Windows&nbsp;10+** | Per-user installer for x64 or arm64 that needs no admin rights and updates in place, plus an x64 `.appx` for the Microsoft Store |
| **Linux** | `.AppImage` and `.deb` for x64 or arm64 on glibc 2.34+ (Ubuntu 22.04, Debian 12, Fedora 35, RHEL 9 or later), under X11 or Wayland |

## How it works

Each task gets a git worktree and an agent terminal. Daintree sorts the runs by what they need from you, and you review each worktree's diff before it merges.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/loop-dark-narrow.webp">
    <source media="(prefers-color-scheme: light) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/loop-light-narrow.webp">
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v2/loop-dark-wide.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v2/loop-light-wide.webp">
    <img alt="The Daintree loop in four stages. Delegate: three branches, each with an agent. Monitor: the same branches by state, one waiting on approval, one working, one finished. Review: the diff for session.ts. Merge: pull request 482 from fix/auth-retry to main, four checks passed and ready to merge." src="https://cdn.daintree.org/readme/v2/loop-dark-wide.webp" width="896">
  </picture>
</p>

### One git worktree per task

Create a worktree for each task, by hand or from a GitHub issue, and launch any agent CLI into it. Each agent gets its own branch and checkout, so parallel runs never share a working tree. [Worktree&nbsp;docs&nbsp;→](https://daintree.org/docs/worktrees)

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/shot-worktree-overview-arashiyama--narrow.webp">
    <img alt="The worktree overview in the Arashiyama theme: worktree rows with their agent sessions and states, and on wider screens every worktree in the project with its uncommitted changes and when it was last active." src="https://cdn.daintree.org/readme/v1/shot-worktree-overview-arashiyama.webp" width="896">
  </picture>
  <br><sub>Worktree overview, in the <a href="#themes">Arashiyama</a> theme</sub>
</p>

### State read from the terminal

Daintree watches each agent's terminal output, window title and process tree to tell working, waiting and finished apart, without touching the agent's own config. Detection is heuristic and can be wrong, so the UI shows what it saw rather than a verdict. Pilot, the All agents palette, gathers the runs from every open project and puts the ones blocked on you first. Park what can wait. [Pilot&nbsp;docs&nbsp;→](https://daintree.org/docs/agents/all-agents)

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/shot-pilot-fiordland--narrow.webp">
    <img alt="Pilot in the Fiordland theme: agent runs filtered by state (Attention, Quiet, Working, Finished, Parked), with the run waiting on you at the top." src="https://cdn.daintree.org/readme/v1/shot-pilot-fiordland.webp" width="896">
  </picture>
  <br><sub>Pilot, in the <a href="#themes">Fiordland</a> theme</sub>
</p>

### Review before you merge

Review Hub shows each worktree's diff as uncommitted changes, against `main`, or since your last review. It tracks which files you've viewed, and stages, commits and pushes from the same panel. Once there's a pull request, it shows merge readiness and your forge's CI checks. [Review&nbsp;Hub&nbsp;docs&nbsp;→](https://daintree.org/docs/review-hub)

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/shot-review-hub-hokkaido--narrow.webp">
    <img alt="Review Hub in the Hokkaido theme: a worktree's three staged files, each marked viewed or not, and on wider screens the split diff beside them with the commit message ready to commit and push." src="https://cdn.daintree.org/readme/v1/shot-review-hub-hokkaido.webp" width="896">
  </picture>
  <br><sub>Review Hub, in the <a href="#themes">Hokkaido</a> theme</sub>
</p>

## Agent CLIs

Daintree runs the real agent binaries with your existing config, login and subscription. It doesn't proxy them or bundle its own. Seventeen are built in. State detection uses terminal heuristics, with agent-specific patterns where an agent has them, and a [plugin](https://daintree.org/docs/plugins) can register another.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/agents-dark-narrow.webp">
    <source media="(prefers-color-scheme: light) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/agents-light-narrow.webp">
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v2/agents-dark-wide.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v2/agents-light-wide.webp">
    <img alt="The brand marks of the 17 built-in agents: Claude Code, Codex, Antigravity, OpenCode, Cursor, GitHub Copilot, Gemini CLI, Amp, Aider, Goose, Crush, Grok, Qwen Code, Kimi Code, Kiro, Mistral Vibe and Open Interpreter." src="https://cdn.daintree.org/readme/v2/agents-dark-wide.webp" width="896">
  </picture>
</p>

<details>
<summary>Install an agent CLI</summary>
<br>

**Settings → Agents** has a one-click installer for each, or follow the agent's own guide:

| Agent | Install |
| --- | --- |
| Claude Code | [code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup) |
| Codex | [github.com/openai/codex](https://github.com/openai/codex) |
| Antigravity | [antigravity.google/docs/getting-started](https://antigravity.google/docs/getting-started/) |
| OpenCode | [opencode.ai/install](https://opencode.ai/install) |
| Cursor | [cursor.com/cli](https://cursor.com/cli) |
| GitHub Copilot | [docs.github.com/…/install-copilot-cli](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) |
| Amp | [ampcode.com/manual](https://ampcode.com/manual) |
| Aider | [aider.chat/docs/install.html](https://aider.chat/docs/install.html) |
| Goose | [goose-docs.ai/docs/getting-started/installation](https://goose-docs.ai/docs/getting-started/installation) |
| Crush | [github.com/charmbracelet/crush](https://github.com/charmbracelet/crush) |

Daintree supports OpenCode 1.x; OpenCode 2 uses the same `opencode` command but isn't supported yet. All seventeen, with what Daintree detects for each, are in the [agent docs](https://daintree.org/docs/agents).

</details>

## MCP server

Daintree runs a local MCP server that exposes its own actions as tools. An agent holding them can open a worktree, launch another agent, read a sibling terminal's state or wait for it to finish.

Outside access is off by default. Turn it on and an API-key client gets a fixed set of tools (36 today) for terminals, agents, worktrees, recipes and live IDE context. Set a core or full tier on a project and the agents launched there get that tier's tools. Every call is authorized for its tier and written to a local audit log. [MCP&nbsp;server&nbsp;reference&nbsp;→](docs/architecture/mcp-server.md)

## Daintree Assistant

The Assistant is Claude Code or Codex, signed in the way you already are, running in a terminal in Daintree's help panel on its own MCP session with a wider tier of tools. It plans the work, opens worktrees, launches agents into them and watches their terminals, then brings back the ones that need you. There's no extra subscription. [Read&nbsp;about&nbsp;the&nbsp;Assistant&nbsp;→](https://daintree.org/assistant)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/assistant-dark-narrow.webp">
    <source media="(prefers-color-scheme: light) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/assistant-light-narrow.webp">
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v2/assistant-dark-wide.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v2/assistant-light-wide.webp">
    <img alt="Claude Code running as the Daintree Assistant fans one request out over MCP to five agents in five worktrees. Four are working; feat/billing is waiting on you to approve overwriting a migration." src="https://cdn.daintree.org/readme/v2/assistant-dark-wide.webp" width="896">
  </picture>
</p>

## Canopy inbox

One list of every agent across every open project, ranked by what it needs from you. Permission prompts go to the top, and you can answer them from the list; a risky one takes a second press. A run that went quiet behind a spinner, or has been waiting on you for ten minutes, surfaces instead of hiding in a pane. Every placement quotes the screen it came from, and Canopy never rewrites or hides what Daintree observed.

Canopy reads each agent's screen with a small open model that runs on your computer, downloaded from Hugging Face the first time. Nothing it reads leaves the machine. It's off until you turn it on under **Settings → Integrations → Canopy**, then opens with <kbd>⌘</kbd>&nbsp;<kbd>E</kbd> (<kbd>Ctrl</kbd>&nbsp;<kbd>Shift</kbd>&nbsp;<kbd>O</kbd> on Windows and Linux).

## Daintree Decisions

Answer your agents from your phone. An agent that hits a call it shouldn't make alone asks you through one MCP tool, `ask_human`, and ends its turn. You answer when you get to it, and Daintree types the answer into the terminal that asked once that agent is idle.

Questions travel through a relay you deploy into your own Cloudflare account, end-to-end encrypted between your computer and your phone. Daintree runs no server for it. Set it up under **Settings → Integrations → Decisions**. The relay and the phone app are open source in [daintreehq/decisions](https://github.com/daintreehq/decisions).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/decisions-dark-narrow.webp">
    <source media="(prefers-color-scheme: light) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/decisions-light-narrow.webp">
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v2/decisions-dark-wide.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v2/decisions-light-wide.webp">
    <img alt="Claude Code in a Daintree terminal calls ask_human to ask whether billing should move into its own settings tab, and ends its turn. A rail labelled encrypted carries the question to a phone, which shows the notification and the question with Approve chosen and a note. A rail labelled signed carries the answer back: two hours later the answer block, with the choice and the note, is typed into the same terminal and the agent carries on." src="https://cdn.daintree.org/readme/v2/decisions-dark-wide.webp" width="896">
  </picture>
</p>

## Also in Daintree

- **Fleet broadcast.** One prompt to many agents, with a live preview and per-agent edits before it sends.
- **Remote hosts.** From macOS or Linux, drive Daintree on another Mac or Linux machine over your own SSH, and its agents keep running while your laptop sleeps. From Windows, drive a Linux host in WSL.
- **Plugins.** Panels, actions, agents, forge providers, themes, and project apps with their own storage and MCP tools. See the [plugin docs](docs/plugins/README.md).
- **Context injection.** Pick files and send structured context into any agent's terminal, built on [CopyTree](https://github.com/gregpriday/copytree).
- **Action palette.** More than 500 typed actions sit behind every menu item, shortcut and palette entry.
- **Voice input.** Dictate prompts, with optional AI cleanup. Bring your own key.

## Themes

Fifteen themes, each named for a real place and drawn from it: eight dark and seven light, all tuned for contrast across the whole app.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v1/themes-narrow.webp">
    <source media="(prefers-color-scheme: light) and (max-width: 600px)" srcset="https://cdn.daintree.org/readme/v2/themes-light-narrow.webp">
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v1/themes-wide.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v2/themes-light-wide.webp">
    <img alt="All fifteen Daintree themes as postcards, each showing the landscape it is named for, the app wearing that theme, and the theme's name and place. Dark: Daintree, Arashiyama, Fiordland, Galápagos, Highlands, Namib, Redwoods and Movile. Light: Bondi Beach, Table Mountain, Atacama, Bali, Hokkaido, Serengeti and Svalbard." src="https://cdn.daintree.org/readme/v1/themes-wide.webp" width="896">
  </picture>
</p>

## Build from source

You'll need Node 22 (see `.nvmrc`).

```bash
git clone https://github.com/daintreehq/daintree.git
cd daintree
npm install
npm run dev
```

The `postinstall` step rebuilds `node-pty` for Electron. If you see PTY errors, run `npm run rebuild`.

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary>Package installers</summary>
<br>

Builds land in `release/`. Pass `-c.directories.output=<path>` to electron-builder to put them somewhere else.

| Platform | Command                 | Output                                         |
| -------- | ----------------------- | ---------------------------------------------- |
| macOS    | `npm run package:mac`   | `.dmg` and `.zip` for arm64, x64 and universal |
| Windows  | `npm run package:win`   | NSIS `-setup.exe` and `.appx`                  |
| Linux    | `npm run package:linux` | `.AppImage` and `.deb`                         |

On Windows, `package:win:nsis` and `package:win:appx` build just one of the two.

</details>

## Documentation

User docs live at [daintree.org/docs](https://daintree.org/docs). The `docs/` folder in this repo is the development reference: architecture, not usage.

- [Documentation index](docs/README.md): the full map, with a suggested reading order
- [Development guide](docs/development.md): setup, IPC pattern, debugging, compiler tooling
- [Architecture](docs/architecture/): process model, state, actions, MCP server, terminal lifecycle
- [Plugins](docs/plugins/README.md): manifest, contribution points, host API, dev loop
- [Theme system](docs/themes/theme-system.md): theme pipeline, tokens, component contract
- [E2E testing](docs/e2e-testing.md): Playwright buckets, helpers, CI workflows
- [Release process](docs/release.md): per-OS workflows, signing, notarization

## License

Apache 2.0. See [LICENSE](LICENSE), and [TRADEMARKS.md](TRADEMARKS.md) for the brand and marks policy.

<br>

<p align="center">
  <a href="https://daintree.org">Website</a> · <a href="https://daintree.org/docs">Docs</a> · <a href="https://daintree.org/changelog">Changelog</a> · <a href="https://github.com/daintreehq/daintree/discussions">Discussions</a> · <a href="https://github.com/daintreehq/daintree/issues">Issues</a>
</p>
