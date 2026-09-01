# Getting Started

Scaffold your first plugin, package it, and install it in Daintree.

> **This is the path for a plugin that belongs to you** — installed to `~/.daintree/plugins/` and present in every project. If you are writing a plugin that belongs to a **project**, committed to its repository at `<projectRoot>/.daintree/plugins/`, stop here and read the [agent brief](./agent-brief.md) instead. The two differ in ways that matter on the first line of the manifest, and the command-handler convention below is one project plugins reject.

## Prerequisites

- Node.js 22 or newer
- Daintree installed and running
- Basic familiarity with TypeScript

## Create a plugin

> The `daintree-plugin` and `create-daintree-plugin` packages are not yet published on npm — the `npx` commands below return E404 today. Until they ship, create the structure by hand following the [Manifest reference](./manifest.md), and read `plugins/sample/hello-daintree/` in the repo as a working example. The commands below show the intended workflow once the CLI is on npm.

```bash
npx daintree-plugin new my-first-plugin
cd my-first-plugin
```

`npx create-daintree-plugin my-first-plugin` is an equivalent npm-init shim that forwards to the same scaffolder.

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
  "engines": { "daintree": "^0.11.0" },
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

The `commands[].id` maps to `src/say-hello.{ts,tsx,js,mjs}` by filesystem convention. Its default export becomes the command handler. See [Contribution points → Commands](./contribution-points.md#commands--shipped) for full details.

## Write the command

The filesystem-convention handler is a default export that receives the action args only — it has no `host`. To call host APIs like `showToast`, register the command imperatively from `activate` instead:

> `@daintreehq/plugin-sdk` now exists in-repo at `packages/plugin-sdk` and is workspace-linked, so this import resolves and builds when you develop inside the Daintree repo. It is not yet published to public npm, so the bare `@daintreehq/plugin-sdk` specifier won't install from the registry outside the workspace — until it ships, point your `tsconfig.json` `paths` at the in-repo package (it re-exports the types from `shared/types/plugin-sdk.ts`).

```ts
// src/index.ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi): Promise<() => void> {
  host.registerAction(
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

`activate` runs once when the plugin loads; the returned disposer cleans up on unload. Actions registered through `host.registerAction` are unregistered automatically, so this disposer is a no-op. When you register a command this way, drop the matching `contributes.commands` entry from `plugin.json` — keep either the manifest entry plus a `src/say-hello.ts` handler, or the imperative registration above, not both.

## Run it

Build, package, and install the plugin into your running Daintree:

> `daintree-plugin install` depends on the CLI, which is not yet published on npm. Until it ships, sideload manually by placing the built plugin directory (not the `.dntr` file) at `~/.daintree/plugins/{publisher}.{name}/` and restarting Daintree (see [Distribution → Sideload](./distribution.md#sideload)).

```bash
npm run package
npx daintree-plugin install ./acme.my-first-plugin-0.1.0.dntr
```

`npm run package` produces `acme.my-first-plugin-0.1.0.dntr` in the project root — a zip file containing the manifest and compiled bundle. `daintree-plugin install` loads it into the running app.

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
- Register an MCP server or Skill so Daintree's agents can use your plugin — see [Agent extensions](./agent-extensions.md)
- Explore the host API — see [Host API](./host-api.md)
- Understand what runs when — see [Architecture](./architecture.md)
