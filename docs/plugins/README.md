# Daintree Plugins

**Start here.** Two kinds of plugin live in this folder, and building the wrong one is the most common way to waste an afternoon:

- **A plugin for one project**, committed to that project's repository at `<projectRoot>/.daintree/plugins/` and loaded only while it is open — a dashboard over your own build, a panel for your team. Read the [agent brief](./agent-brief.md), then [project-local.md](./project-local.md). The brief is self-contained and is the file to hand an AI agent.
- **A plugin for you**, installed to `~/.daintree/plugins/` and present in every project. Read [getting-started.md](./getting-started.md).

The two have different manifests, different load contracts, and a different set of things they may contribute. Everything else in this folder is reference for both — read it on demand rather than front to back.

> **Status: pre-release, in active development.** The runtime (`PluginService`: load/activate/unload, manifest validation, panel/toolbar/menu/keybinding/context-menu registration, host settings, MCP supervision, worktree observation) is implemented, and the `daintree-plugin` CLI ships `new`, `validate`, `package`, `install`, `uninstall`, and `dev` (hot-reload). All five packages exist in-repo under `packages/` (`daintree-plugin`, `create-daintree-plugin`, `@daintreehq/plugin-sdk`, `@daintreehq/plugin-vite`, `@daintreehq/plugin-testing`) and are workspace-linked, so the `@daintreehq/*` imports resolve and build from within this repo. None are published to public npm yet, so `npx daintree-plugin …` / `npm install @daintreehq/plugin-sdk` returns E404 outside the workspace. Per-contribution-point status lives in [Contribution points](./contribution-points.md); APIs may still change before 1.0.

Plugins extend Daintree with new panels, actions, keybindings, MCP servers, agents, and — planned — skills. You can write a plugin for your own workflow and sideload it, share a plugin with your team by distributing a single file or URL, or publish one for others to install.

A plugin can also belong to a **project** rather than to you: committed to a repository at `<projectRoot>/.daintree/plugins/`, gated by one trust decision, and loaded only while that project is open. See [Project-local plugins](./project-local.md), or hand [the agent brief](./agent-brief.md) to the agent that is going to write it.

This section documents the plugin system for plugin authors. If you're looking for information on Daintree's internals, see [`../development.md`](../development.md).

## What a plugin is

A plugin is a directory containing a `plugin.json` manifest and (optionally) a compiled ESM bundle. At minimum:

```
my-plugin/
├── plugin.json
└── dist/
    └── index.js
```

The manifest declares **contribution points** — the things the plugin adds to Daintree (panels, actions, toolbar buttons, MCP servers, etc.). Daintree reads the manifest eagerly at startup so contributions appear in the command palette and UI before any plugin code runs. Plugin code only executes when something actually triggers it (user runs a command, opens a panel, etc.).

Plugins are **sandboxed by convention, not by runtime enforcement.** They run with the same Node.js privileges as Daintree itself. Only install plugins from sources you trust.

## Documentation

| Doc | What it covers |
| --- | --- |
| [Agent brief](./agent-brief.md) | The one file to hand an AI agent writing a plugin into a project's own repo — load rules, a zero-build skeleton, reading order |
| [Project-local plugins](./project-local.md) | Plugins a project ships in its own repo — layout, the committed `dist/` contract, trust, hot reload |
| [Getting started](./getting-started.md) | Scaffold and run your first plugin in 5 minutes |
| [Manifest reference](./manifest.md) | Full `plugin.json` schema |
| [Contribution points](./contribution-points.md) | Every contribution type with examples and current status |
| [Host API](./host-api.md) | The runtime API your plugin code consumes |
| [Agent extensions](./agent-extensions.md) | MCP servers and Skills — how plugins extend Daintree's agent loop |
| [Forge providers](./forge-provider.md) | The `forgeProviders` contribution type for code-hosting integrations |
| [Distribution](./distribution.md) | Packaging, sharing, installing from file or URL |
| [Development loop](./dev-loop.md) | The `daintree-plugin` CLI, hot reload, debugging |
| [Trust model](./trust-model.md) | Capability disclosure, confirm-dialog policy, the security contract |
| [Architecture](./architecture.md) | How the plugin system works under the hood |
| [1.0 freeze plan](./freeze-plan.md) | Planning: the path to a frozen/stable 1.0 plugin API — root decisions, freeze roadmap, and rationale of record |

## Status

The plugin system is under active development. Each contribution point in the [contribution points reference](./contribution-points.md) is labeled **shipped**, **planned**, or **future** so you know what's available today.

## Stability

`@daintreehq/plugin-sdk` is not yet published on npm (see the [status banner](#daintree-plugins) above); once it ships it will follow semver but stay pre-1.0 until the SDK stabilizes. Breaking changes may occur between 0.x minor versions, so pin to an exact version during early development and upgrade deliberately.

The `engines.daintree` field in your manifest controls host compatibility. Plugins declaring a range that doesn't match the running Daintree version are rejected at load time with a user-visible warning.

## Security and trust

Plugin code runs with full Node.js privileges. Daintree does not sandbox plugins at runtime, so a plugin that declares `capabilities: ["fs:project-read"]` is not blocked from making network requests. The declared `capabilities` field is **disclosure-first with host-side policy effects**: it tells the user what the plugin claims to need, and high-risk tokens (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`) raise the plugin's actions to a confirm dialog. It is not an enforcement boundary against malicious code. See the [trust model](./trust-model.md) for the full contract.

Beyond the no-sandbox reality above, two more things Daintree deliberately does **not** do at 1.0: it doesn't sign plugins or verify publisher identity (the SHA-256 archive hash confirms byte integrity, not origin); and it doesn't gate installs behind a capability-consent dialog (capabilities are surfaced after install, in the plugin manager's detail pane). Secret settings (`type: "secret"`) are encrypted at rest through the OS keychain when one is available, with an honest plaintext fallback on hosts without a keychain — see the [trust model](./trust-model.md), which documents all three as the complete 1.0 non-guarantee contract.

Install only plugins from sources you trust. For plugins you author yourself, this is trivially true. For plugins you install from URLs or files, inspect the code before running it — especially if it requests broad capabilities like `shell:exec` or `network:fetch`.

Daintree itself may eventually offer some first-party plugins through a separate channel.
