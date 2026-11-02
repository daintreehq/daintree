<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v1/header-dark.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v1/header-light.webp">
    <img alt="Daintree: a desktop habitat for AI agents." src="https://cdn.daintree.org/readme/v1/header-dark.webp" width="560">
  </picture>
</p>

<p align="center">
  Run coding agents side by side, each in&nbsp;its&nbsp;own&nbsp;Git&nbsp;worktree.<br>
  See where you're needed, and review the diff before you merge.
</p>

<p align="center">
  <a href="https://daintree.org/download"><img alt="Download Daintree for macOS, Windows or Linux" src="https://cdn.daintree.org/readme/v1/download.png" height="44"></a>&nbsp; <a href="https://www.youtube.com/watch?v=ev1cbGSmkG0"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v1/walkthrough-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v1/walkthrough-light.png"><img alt="Watch the five-minute walkthrough" src="https://cdn.daintree.org/readme/v1/walkthrough-dark.png" height="44"></picture></a>
</p>

<p align="center">
  <a href="https://daintree.org/changelog"><img alt="Latest release" src="https://img.shields.io/github/v/release/daintreehq/daintree?style=flat-square&label=release&labelColor=201f1f&color=2b2b2a"></a>
  <a href="https://github.com/daintreehq/daintree/actions/workflows/ci.yml?query=branch%3Amain"><img alt="Build status on main" src="https://img.shields.io/github/actions/workflow/status/daintreehq/daintree/ci.yml?branch=main&style=flat-square&label=build&labelColor=201f1f&color=2b2b2a"></a>
  <a href="#download"><img alt="macOS, Windows and Linux" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-2b2b2a?style=flat-square&labelColor=201f1f"></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache%202.0-2b2b2a?style=flat-square&labelColor=201f1f"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.daintree.org/readme/v1/shot-hero-daintree.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.daintree.org/readme/v1/shot-hero-bondi.webp">
    <img alt="Daintree with four agents working in parallel on one project, each in its own worktree: Claude Code, Antigravity, OpenCode and Codex. The worktree sidebar shows every branch and its state, and one agent is waiting on a permission prompt." src="https://cdn.daintree.org/readme/v1/shot-hero-daintree.webp" width="896">
  </picture>
</p>

<p align="center"><sub>Works with Claude Code, Codex, Antigravity, OpenCode and <a href="#works-with-the-cli-you-already-run">13&nbsp;more</a> · Free and open source · No account · Telemetry&nbsp;off&nbsp;by&nbsp;default</sub></p>

## Generation is cheap. Review is the bottleneck.

Five terminals, three agents, and no idea which one is stuck. Daintree shows you which runs need you, and what each one changed before you merge it.

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v1/loop-narrow.webp">
    <img alt="The Daintree loop. Delegate: each task gets a worktree and an agent. Monitor: runs sorted by what they need from you. Review: the diff for each run. Merge: the pull request to main, checks passed and ready to merge." src="https://cdn.daintree.org/readme/v1/loop-wide.webp" width="896">
  </picture>
  <br><sub>Delegate · Monitor · Review · Merge</sub>
</p>

### Every task in its own worktree

Create a worktree per task, by hand or straight from a GitHub issue, and launch any agent CLI into it. Each one gets its own branch and checkout, so parallel agents never write over each other. [Read about worktrees →](https://daintree.org/docs/worktrees)

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v1/shot-worktree-overview-arashiyama--narrow.webp">
    <img alt="The worktree overview in the Arashiyama theme: every worktree in the project as a row, with its sessions, changes and last activity." src="https://cdn.daintree.org/readme/v1/shot-worktree-overview-arashiyama.webp" width="896">
  </picture>
  <br><sub>Worktree overview, in the <a href="#fifteen-habitats">Arashiyama</a> theme</sub>
</p>

### See which runs need you

Pilot gathers every run across every project and sorts them by what is blocked, waiting and ready. Park what can wait; the list opens on what needs you now. [Read about Pilot →](https://daintree.org/docs/agents/all-agents)

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v1/shot-pilot-fiordland--narrow.webp">
    <img alt="Pilot in the Fiordland theme: agent runs grouped by project and ordered by state, with the ones waiting on approval at the top." src="https://cdn.daintree.org/readme/v1/shot-pilot-fiordland.webp" width="896">
  </picture>
  <br><sub>Pilot, in the <a href="#fifteen-habitats">Fiordland</a> theme</sub>
</p>

### Review before you merge

An agent reporting done is a claim. Review Hub shows each worktree's diff, tracks the files you've viewed, and commits and pushes from the same view. Once there's a pull request, it shows merge readiness and your forge's CI checks too. [Read about Review Hub →](https://daintree.org/docs/review-hub)

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v1/shot-review-hub-hokkaido--narrow.webp">
    <img alt="Review Hub in the Hokkaido theme: a worktree's staged files beside a side-by-side diff, with the commit message written and ready to commit and push." src="https://cdn.daintree.org/readme/v1/shot-review-hub-hokkaido.webp" width="896">
  </picture>
  <br><sub>Review Hub, in the <a href="#fifteen-habitats">Hokkaido</a> theme</sub>
</p>

## Works with the CLI you already run

Daintree launches the real agent binaries with your existing config and subscription, so nothing about how you sign in or what you pay changes. Seventeen agents are built in, each with live state detection, and a [plugin](https://daintree.org/docs/plugins) can add another.

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v1/agents-narrow.webp">
    <img alt="The brand marks of the 17 built-in agents, in their own colours." src="https://cdn.daintree.org/readme/v1/agents-wide.webp" width="896">
  </picture>
  <br><sub>Claude Code · Codex · Antigravity · OpenCode · Cursor · GitHub Copilot · Gemini CLI · Amp · Aider · Goose · Crush · Grok · Qwen Code · Kimi Code · Kiro · Mistral Vibe · Open Interpreter</sub>
</p>

<details>
<summary>Install an agent CLI</summary>
<br>

**Settings → Agents** has a one-click installer for each, or follow the agent's own instructions. The most-used ten:

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

The full list, with what Daintree detects for each, is in the [agent docs](https://daintree.org/docs/agents).

</details>

## Daintree Assistant

An agent that runs your agents. It plans the work, opens worktrees, launches agents into them and watches their terminals, then brings back the ones that need you.

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v1/assistant-narrow.webp">
    <img alt="The Daintree Assistant fanning one request out to five agents in five worktrees. Four are working; feat/billing is waiting on you to approve a migration." src="https://cdn.daintree.org/readme/v1/assistant-wide.webp" width="896">
  </picture>
</p>

It runs on Claude Code or Codex, signed in the way you already are, so there's no extra subscription. Everything it does goes through Daintree's own permissioned actions, with every call in a local audit log. [Meet the Assistant →](https://daintree.org/assistant)

## Fifteen habitats

Every theme is named for a real place and drawn from it: eight dark, seven light, each tuned for contrast across the whole app.

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="https://cdn.daintree.org/readme/v1/themes-narrow.webp">
    <img alt="All fifteen Daintree themes as postcards: each shows the landscape it is named for, the app wearing that theme, and the theme's name and place, in its own colours." src="https://cdn.daintree.org/readme/v1/themes-wide.webp" width="896">
  </picture>
  <br><sub>Dark: Daintree · Arashiyama · Fiordland · Galápagos · Highlands · Namib · Redwoods · Movile<br>Light: Bondi Beach · Table Mountain · Atacama · Bali · Hokkaido · Serengeti · Svalbard</sub>
</p>

<details>
<summary>Also inside: fleet broadcast, remote hosts, an MCP server and more</summary>
<br>

- **Fleet broadcast.** One prompt to many agents, with a live preview and per-agent edits before it sends.
- **Remote hosts.** From macOS or Linux, point a window at another Mac or Linux machine over your own SSH. The agents keep running while the laptop sleeps.
- **MCP server.** Agents call Daintree actions directly, with per-tier authorization. Off until you turn it on.
- **Context injection.** Pick files and send structured context into any agent's terminal, built on [CopyTree](https://github.com/gregpriday/copytree).
- **Action palette.** Over 300 keyboard-first actions, and the same manifest is the MCP server's tool list.
- **Voice input.** Dictate prompts, with optional AI cleanup. Bring your own key.

</details>

## Download

Get the latest build at **[daintree.org/download](https://daintree.org/download)**. The app is free, needs no account, and telemetry is off by default.

| Platform | What you get |
| --- | --- |
| **macOS&nbsp;12+** | A signed and notarized `.dmg` for Apple Silicon, Intel or Universal |
| **Windows&nbsp;10+** | A per-user installer for x64 or arm64: no admin rights, and it updates in place |
| **Linux** | `.AppImage` and `.deb` for x64 or arm64, on glibc 2.34+ (Ubuntu 22.04, Debian 12, Fedora 35, RHEL 9 or later), under X11 or Wayland |

An x64 `.appx` is also built for the Microsoft Store.

## Build from source

You'll need Node 22 (see `.nvmrc`).

```bash
git clone https://github.com/daintreehq/daintree.git
cd daintree
npm install
npm run dev
```

The `postinstall` step rebuilds `node-pty` for Electron. If you see PTY errors, run `npm run rebuild`.

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

Contributions are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [development guide](docs/development.md).

## Documentation

User docs live at [daintree.org/docs](https://daintree.org/docs). `docs/` in this repo is the development reference: architecture, not usage.

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
