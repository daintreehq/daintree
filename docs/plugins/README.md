# Daintree Plugins

**Start here.** Two kinds of plugin live in this folder, and building the wrong one is the most common way to waste an afternoon:

- **A plugin for one project**, committed to that project's repository at `<projectRoot>/.daintree/plugins/` and loaded only while it is open — a dashboard over your own build, a panel for your team. Read the [agent brief](./agent-brief.md), then [project-local.md](./project-local.md). The brief is self-contained and is the file to hand an AI agent. When the plugin is really an application — a CRM, a ledger, a board that agents edit and a panel shows — [Building an app as a plugin](./building-apps.md) is the guide.
- **A plugin for you**, installed to `~/.daintree/plugins/` and present in every project. Read [getting-started.md](./getting-started.md).

The two have different manifests, different load contracts, and a different set of things they may contribute.

There is a third kind, which you only write if you are working on Daintree itself: a **built-in plugin** under `plugins/builtin/`, shipped inside the app. Built-ins load in-process, own the reserved `daintree.*` namespace, resolve their panel views without `plugin://`, and need a workspace package for any dependency. [Architecture → Built-in plugins](./architecture.md#built-in-plugins) covers what is different.

> **Status: pre-release, in active development.** The runtime is implemented — discovery, load/activate/unload, manifest validation, every contribution point, host settings and storage, host-managed SQLite (`host.db`), conflict-checked file edits, handing work to agent terminals, HTML-to-PDF export, MCP supervision, worktree observation, the out-of-process plugin worker, and the remote kill-switch. The `daintree-plugin` CLI ships `new`, `validate`, `package`, `install`, `uninstall`, `dev` (hot-reload), `doctor` (checks a project's `.daintree/plugins/` against the working tree and git index — built, ESM, tracked, not gitignored — and reports the running host's trust state) and `schema` (emits the manifest's JSON Schema for editor completion). All four public packages live in-repo under `packages/` (`daintree-plugin`, `create-daintree-plugin`, `@daintreehq/plugin-sdk` — with its `./react`, `./files`, `./data` (not yet in a published release) and `./testing` entries — and `@daintreehq/plugin-vite`) and **are published on npm at 0.1.0**, so `npm create daintree-plugin`, `npx daintree-plugin …` and `npm install --save-dev @daintreehq/plugin-sdk` work from any directory. Inside this repo they are also workspace-linked, so the `@daintreehq/*` imports resolve to the local build. Per-contribution-point status lives in [Contribution points](./contribution-points.md); APIs may still change before 1.0.

Plugins extend Daintree with panels and the React views that fill them, commands, toolbar buttons, menu items, keybindings, context menus, settings, MCP servers Daintree connects to, MCP tools served to the agents in its terminals, SQLite databases, items on a panel's own ⋯ menu, skills, recipes, agents, process-tool detections, forge providers, and file decorations. A project plugin can be a whole application: its data lives in the repository, agents edit it directly, and its panel updates live and hands records back to agents. You can write a plugin for your own workflow and sideload it, share a plugin with your team by distributing a single file or URL, or publish one for others to install.

This section documents the plugin system for plugin authors. If you're looking for Daintree's own internals, see [`../development.md`](../development.md); for how the plugin system itself is built, [Architecture](./architecture.md).

## What a plugin is

A plugin is a directory containing a `plugin.json` manifest and (optionally) a compiled ESM bundle. At minimum:

```
my-plugin/
├── plugin.json
└── dist/
    └── index.js
```

The manifest declares **contribution points** — the things the plugin adds to Daintree (panels, actions, toolbar buttons, MCP servers, etc.). Daintree reads the manifest eagerly at startup so contributions appear in the command palette and UI before any plugin code runs. Plugin code only executes when something actually triggers it (user runs a command, opens a panel, etc.).

**Plugins are not sandboxed.** They run with the same Node.js privileges as Daintree itself, whatever their manifest declares. Only install plugins from sources you trust — see the [trust model](./trust-model.md) for what the declared capabilities do and do not buy you.

## Documentation

The two entry points are at the top of this page. Everything below is reference for both kinds of plugin — read it on demand rather than front to back.

**Writing a plugin**

| Doc | What it covers |
| --- | --- |
| [Getting started](./getting-started.md) | Scaffold, build, and install your first plugin |
| [Manifest reference](./manifest.md) | Every field `plugin.json` accepts, and what the schema rejects |
| [Contribution points](./contribution-points.md) | Every contribution type (three of them built-in only) — shape, example, status, project-scope availability |
| [Host API](./host-api.md) | The runtime `host` object your `activate()` receives — files, SQLite, settings, agent hand-off, PDF export and the rest — the calling conventions, the renderer hooks, and the mock host for tests |
| [Built-in actions](./actions.md) | Every built-in action a plugin may `host.dispatch`, with its danger tier and arguments — generated from the action manifest |
| [Patterns](./patterns.md) | The working patterns a real plugin is made of: pull then push, watch and badge, refresh when the user comes back, open files, export a document, launch an agent or hand it work, own the canvas |
| [Data helpers](./data-helpers.md) | `@daintreehq/plugin-sdk/data`: YAML frontmatter that edits one key without touching the rest, JSON Lines with per-line errors, and the conflict-checked `editFile` loop — importable from a zero-build worker with no install |
| [Document packages](./document-packages.md) | Share npm editor adapters once per document, with exact build matching and explicit trust limits |
| [Views](./views.md) | What a view gets in the DOM, the tokens to style with, settings sections, the host's `Markdown` component, dragging work to an agent, media, knowing when your project is on screen, and what doesn't work inline |
| [Development loop](./dev-loop.md) | The `daintree-plugin` CLI, hot reload, debugging, testing |

**Plugins that belong to a project**

| Doc | What it covers |
| --- | --- |
| [Agent brief](./agent-brief.md) | The one self-contained file to hand an AI agent — load rules, a zero-build skeleton, storing data agents also edit, reading order |
| [Project-local plugins](./project-local.md) | The full contract: layout, the committed `dist/` rule, the trust gate, binding, settings and storage, hot reload |
| [Building an app as a plugin](./building-apps.md) | Replacing a SaaS product with a project plugin: choosing a store, the `AGENTS.md` data contract, live refresh, safe concurrent edits, handing work to agents, settings, backup and export, testing with real agents |

**Specialised contributions**

| Doc | What it covers |
| --- | --- |
| [Agent extensions](./agent-extensions.md) | The two MCP directions — `mcpServers` (Daintree is the client) and `agentMcp` (Daintree serves your tools to terminal agents) — plus skills |
| [Forge providers](./forge-provider.md) | Implementing a code-hosting backend. **Built-in plugins only** — the interface is synchronous and can't cross the plugin worker's port |
| [Tours](./tours.md) | Shipping a narrated welcome tour for a plugin or a panel: manifest entry, narration and cues, scenes from the kit and the mock Daintree window, voicing, previewing, and the house style |

**Contract and internals**

| Doc | What it covers |
| --- | --- |
| [Trust model](./trust-model.md) | What declared capabilities do and don't buy: disclosure, danger derivation, just-in-time consent, agent MCP credentials, the kill-switch, the non-guarantees |
| [Distribution](./distribution.md) | The `.dntr` format, packaging, sideload, file and URL install, updates, uninstall |
| [Architecture](./architecture.md) | Lifecycle, the worker model, the renderer host, the MCP supervisor, the SDK boundary |

## Stability

`@daintreehq/plugin-sdk` is published on npm at 0.1.0 and follows semver, but stays pre-1.0 until the SDK stabilizes. Breaking changes may occur between 0.x minor versions, so pin to an exact version during early development and upgrade deliberately.

The `engines.daintree` field in your manifest controls host compatibility. A plugin declaring a range the running Daintree doesn't satisfy still loads, with a warning toast that it may not work on this version. Declare an **open-ended lower bound** (`">=0.34.0"`), never a caret — under semver's 0.x rule `"^0.34.0"` means `>=0.34.0 <0.35.0`, so it stops matching on the very next minor. See [Manifest → `engines.daintree`](./manifest.md#enginesdaintree).

## Security and trust

Plugin code runs with full Node.js privileges. Daintree does not sandbox plugins at runtime, so a plugin that declares `capabilities: ["fs:project-read"]` is not blocked from making network requests. The declared `capabilities` field is **disclosure-first with host-side policy effects**: it tells the user what the plugin claims to need, and high-risk tokens (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`) raise the plugin's actions to a confirm dialog. It is not an enforcement boundary against malicious code. See the [trust model](./trust-model.md) for the full contract.

Beyond the no-sandbox reality above, two more things Daintree deliberately does **not** do at 1.0: it doesn't sign plugins or verify publisher identity (the SHA-256 archive hash confirms byte integrity, not origin); and it doesn't gate installs behind a capability-consent dialog. What it does have is a **remote kill-switch** — a Daintree-hosted blocklist checked at startup that refuses to load a named plugin at a named version range — and **just-in-time consent** the first time a plugin exercises `shell:exec`, `fs:*-write`, `git:write`, or `agent:input`. Secret settings (`type: "secret"`) are encrypted at rest through the OS keychain and never written into a repository; on a host without a keychain they can't be saved at all, rather than falling back to plaintext. The [trust model](./trust-model.md) is the complete contract, guarantees and non-guarantees together.

Install only plugins from sources you trust. For plugins you author yourself, this is trivially true. For plugins you install from URLs or files, inspect the code before running it — especially if it requests broad capabilities like `shell:exec` or `network:fetch`.

Daintree itself may eventually offer some first-party plugins through a separate channel.
