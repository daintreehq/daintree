# Daintree Plugins

Plugins extend Daintree with new panels, actions, keybindings, MCP servers, skills, and more. You can write a plugin for your own workflow and sideload it, share a plugin with your team by distributing a single file or URL, or publish one for others to install.

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

| Doc                                             | What it covers                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| [Getting started](./getting-started.md)         | Scaffold and run your first plugin in 5 minutes                   |
| [Manifest reference](./manifest.md)             | Full `plugin.json` schema                                         |
| [Contribution points](./contribution-points.md) | Every contribution type with examples and current status          |
| [Host API](./host-api.md)                       | The runtime API your plugin code consumes                         |
| [Agent extensions](./agent-extensions.md)       | MCP servers and Skills — how plugins extend Daintree's agent loop |
| [Distribution](./distribution.md)               | Packaging, sharing, installing from file or URL                   |
| [Development loop](./dev-loop.md)               | The `daintree-plugin` CLI, hot reload, debugging                  |
| [Architecture](./architecture.md)               | How the plugin system works under the hood                        |

## Status

The plugin system is under active development. Each contribution point in the [contribution points reference](./contribution-points.md) is labeled **shipped**, **planned**, or **future** so you know what's available today.

## Stability

`@daintreehq/plugin-sdk` follows semver but is pre-1.0 until the SDK stabilizes. Breaking changes may occur between 0.x minor versions. Pin to an exact version during early development and upgrade deliberately.

The `engines.daintree` field in your manifest controls host compatibility. Plugins declaring a range that doesn't match the running Daintree version are rejected at load time with a user-visible warning.

## Security and trust

Plugin code runs with full Node.js privileges. Daintree does not sandbox plugins at runtime. The plugin manifest's `capabilities` field is a **disclosure mechanism** — it tells the user what the plugin can do, but it is not enforced. A plugin that declares `capabilities: ["fs:project-read"]` is not prevented from making network requests.

Install only plugins from sources you trust. For plugins you author yourself, this is trivially true. For plugins you install from URLs or files, inspect the code before running it — especially if it requests broad capabilities like `shell:exec` or `network:fetch`.

Daintree itself may eventually offer some first-party plugins through a separate channel.
