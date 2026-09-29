# Getting Started

Scaffold your first plugin, package it, and install it in Daintree.

> **This is the path for a plugin that belongs to you** — installed to `~/.daintree/plugins/` and present in every project. If you are writing a plugin that belongs to a **project**, committed to its repository at `<projectRoot>/.daintree/plugins/`, stop here and read the [agent brief](./agent-brief.md) instead. The two differ in ways that matter on the first line of the manifest, and the command-handler convention below is one project plugins reject.

## Prerequisites

- Node.js 22 or newer
- Daintree installed and running
- Basic familiarity with TypeScript

## Create a plugin

```bash
npm create daintree-plugin@latest my-first-plugin
cd my-first-plugin
```

`npx daintree-plugin new my-first-plugin` is equivalent — `create-daintree-plugin` is the npm-init shim that forwards to the same scaffolder. `plugins/sample/hello-daintree/` in the Daintree repository is a complete working plugin to read alongside this page.

The scaffolder asks for a publisher segment, a display name, and a template (command, view, mcp, or full) and generates:

```
my-first-plugin/
├── plugin.json          # manifest
├── package.json         # npm dev deps (not shipped in the plugin package)
├── tsconfig.json
├── vite.config.ts       # pre-configured with @daintreehq/plugin-vite
├── src/
│   └── index.ts         # activate() entry
└── .gitignore
```

A minimal `plugin.json` looks like:

```json
{
  "name": "acme.my-first-plugin",
  "version": "0.1.0",
  "displayName": "My First Plugin",
  "description": "An example Daintree plugin.",
  "main": "dist/index.js",
  "engines": { "daintree": ">=0.11.0" },
  "capabilities": [],
  "contributes": {
    "commands": [
      {
        "id": "say-hello",
        "title": "Say Hello",
        "description": "Show a greeting toast.",
        "category": "My First Plugin",
        "kind": "command",
        "danger": "safe"
      }
    ]
  }
}
```

The `commands[].id` maps to a **compiled** `src/say-hello.js` (or `.mjs`) by filesystem convention — its default export becomes the command handler. `.ts` and `.tsx` are not probed, so author in TypeScript and build to `src/{id}.js`. See [Contribution points → Commands](./contribution-points.md#commands--shipped) for the full rules, including why a filesystem-convention handler gets `args` but no `host`.

## Write the command

The filesystem-convention handler is a default export that receives the action args only — it has no `host`. To call host APIs like `showToast`, register the command imperatively from `activate` instead:

```ts
// src/index.ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi): Promise<() => void> {
  await host.registerAction(
    {
      id: "say-hello",
      title: "Say Hello",
      description: "Show a greeting toast.",
      category: "My First Plugin",
      kind: "command",
      danger: "safe",
    },
    async () => {
      await host.showToast({ message: "Hello from my plugin", type: "success" });
    }
  );

  return () => {};
}
```

`activate` runs the first time something needs the plugin — here, the first run of the command — and the returned disposer cleans up on unload. Await `registerAction`: it returns a promise, and an unawaited one can let activation finish before the registration lands. Actions registered through `host.registerAction` are unregistered automatically, so this disposer is a no-op. Keep the `contributes.commands` entry in `plugin.json` alongside the imperative registration: the manifest entry is what puts the command in the palette before your code has run, and dispatching it is what triggers activation. An imperative `registerAction` for the same id supersedes any `src/{id}.js` file, so the two paths don't fight — what you should not do is ship both a compiled `src/say-hello.js` handler and an imperative registration and expect the file to win.

## Run it

Install the dev dependencies, then build, package, and install the plugin into your running Daintree:

```bash
npm install
npm run package
npx daintree-plugin install ./acme.my-first-plugin-0.1.0.dntr
```

The generated `package.json` lists `daintree-plugin` as a devDependency alongside the SDK and the Vite preset, so `npm install` brings the CLI in and the `package` and `validate` scripts run it from `node_modules` — nothing to install globally. `npm run package` produces `acme.my-first-plugin-0.1.0.dntr` in the project root — a zip file containing the manifest and compiled bundle. `daintree-plugin install` loads it into the running app.

In Daintree, open the command palette and run **My First Plugin: Say Hello**. A toast appears.

To iterate, edit your source, then re-run `npm run package` and `daintree-plugin install` (which replaces the installed copy). For a faster loop, `daintree-plugin dev` hot-reloads the plugin on every save — see [Development loop](./dev-loop.md#daintree-plugin-dev).

## Package for distribution

The same `.dntr` you installed above is the distributable artifact. Share it directly, or rebuild with:

```bash
npm run package
```

See [Distribution](./distribution.md) for how users install it.

## Next steps

- Add more contribution points — see [Contribution points](./contribution-points.md)
- Serve tools to the agents in Daintree's terminals with an agent MCP endpoint, or ship a skill — see [Agent extensions](./agent-extensions.md)
- Explore the host API — see [Host API](./host-api.md)
- Compose it into something real — pull-then-push views, live refresh, file and SQLite data, handing work to an agent — see [Patterns](./patterns.md)
- Understand what runs when — see [Architecture](./architecture.md)
