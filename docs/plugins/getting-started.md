# Getting Started

Scaffold your first plugin, package it, and install it in Daintree.

> **This is the path for a plugin that belongs to you** — installed to `~/.daintree/plugins/` and present in every project. If you are writing a plugin that belongs to a **project**, committed to its repository at `<projectRoot>/.daintree/plugins/`, stop here and read the [agent brief](./agent-brief.md) instead. The two differ in ways that matter on the first line of the manifest, and the command-handler convention below is one project plugins reject.

## Prerequisites

- Node.js 22.13 or newer (every published package declares `engines.node` `>=22.13`)
- Daintree installed and running
- Basic familiarity with TypeScript

## Create a plugin

```bash
npm create daintree-plugin@latest my-first-plugin
cd my-first-plugin
```

`npx daintree-plugin new my-first-plugin` is equivalent — `create-daintree-plugin` is the npm-init shim that forwards to the same scaffolder. Through `npm create`, the scaffolder's own flags go after a `--`, or npm keeps them: `npm create daintree-plugin@latest my-first-plugin -- --publisher acme --template command --yes` scaffolds with no prompts.

> **Today's npm release.** The packages on npm are at 0.1.0, and the repository is ahead of them. Every step on this page works with 0.1.0 except three, each marked where it appears (the 0.1.0 CLI also refuses manifests that declare `databases`, `tours` or a settings view, which this page doesn't use): importing the UI kit in a [view](#add-a-view) needs a small stopgap, `daintree-plugin lint` doesn't exist yet (skip it), and `daintree-plugin dev` prints no metrics table.

The scaffolder asks for a publisher segment, a display name, and a template (command, view, mcp, or full) and generates, for the `command` template:

```
my-first-plugin/
├── plugin.json          # manifest
├── package.json         # build, validate and package scripts; npm dev deps (not shipped in the plugin package)
├── tsconfig.json
├── vite.config.ts       # pre-configured with @daintreehq/plugin-vite
├── src/
│   └── index.ts         # activate() entry
├── .claude/
│   └── skills/
│       └── daintree-tour/   # tour-authoring skill for Claude Code: SKILL.md + references/
├── .dntrignore          # files to keep out of the packaged .dntr
└── .gitignore
```

The `view` and `full` templates add `src/panel.tsx`; `mcp` and `full` add `src/server.ts` and `vite.config.server.ts`, the Node-target build for the MCP server. The scaffold also writes `.claude/skills/daintree-tour/`, the tour-authoring skill ([Tours](./tours.md)). Not in the 0.1.0 release on npm; it ships in the next one.

`plugins/sample/hello-daintree/` in the Daintree repository is the host's own reference plugin. Read it for the host API, but don't copy it as a starting point: it is in the reserved `daintree.*` namespace, which `validate` and the installer refuse for a third-party plugin, and it is unbuilt — its `main` names `main/index.js`, and the directory holds only `main/index.ts`. Start from the scaffold.

The scaffolded `command` template already contains a working command: `run`, titled **My First Plugin: Run**, registered in `src/index.ts` and declared in `plugin.json`. This page walks through a `say-hello` command instead, so replace the generated `contributes.commands` entry with the one below and `src/index.ts` with the code in the next section. (Or keep `run` and use it wherever this page says `say-hello`.) After the edit, `plugin.json` looks like:

```json
{
  "$schema": "https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas/plugin.schema.json",
  "name": "acme.my-first-plugin",
  "version": "0.1.0",
  "displayName": "My First Plugin",
  "description": "My First Plugin — a Daintree plugin.",
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

In Daintree, open the command palette and run **Say Hello** (listed under **My First Plugin**). A toast appears.

`daintree-plugin install` needs Daintree running; otherwise it fails with `Daintree isn't running. Start Daintree and try again.` and names the socket it tried. You can also install the `.dntr` from the plugin manager (Settings → Plugins → Plugin manager → Install plugin → Install from file).

To iterate, edit your source, then re-run `npm run package` and `daintree-plugin install` (which replaces the installed copy). For a faster loop, `npx daintree-plugin dev` hot-reloads the plugin on every save — see [Development loop](./dev-loop.md#daintree-plugin-dev). It also prints the plugin's performance measurements against their budgets as it runs; that table is not in the 0.1.0 release on npm; it ships in the next one.

## Add a view

The `view` and `full` templates add `src/panel.tsx`, a React component Daintree mounts in a panel. Build it from `@daintreehq/plugin-ui`, Daintree's own components served to your view by the host — `Button`, `Input`, `Select`, `DataTable` and `VirtualList` for lists, `Dialog` and `ConfirmDialog`, `EmptyState` and `PaneState`, `Icon` — and get data with the hooks in `@daintreehq/plugin-sdk/react`. Style what the kit doesn't draw with Tailwind classes on Daintree's tokens. The scaffolded `tsconfig.json` declares both the kit and `window.electron.plugin` through the SDK's `view-globals` and `plugin-ui` type entries, so the view typechecks. [Views](./views.md) is the reference, and its [Performance](./views.md#performance) section is worth reading before your first list.

The Vite preset keeps the kit external so the host serves it, and the SDK supplies those type declarations. Not in the 0.1.0 release on npm; it ships in the next one. With the 0.1.0 packages, the scaffolded view builds and loads as generated, but importing `@daintreehq/plugin-ui` needs two stopgaps. `@daintreehq/plugin-vite` 0.1.0 externalizes only React, so the kit import fails the build (`Rolldown failed to resolve import "@daintreehq/plugin-ui"`) until you pass it as an extra external in `vite.config.ts`:

```ts
plugins: [daintreePlugin({ externals: [/^@daintreehq\/plugin-ui($|\/)/] })],
```

And SDK 0.1.0 has no `view-globals` or `plugin-ui` type entries, so `tsc` (though not the Vite build, which doesn't typecheck) rejects the kit import and `window.electron.plugin`. A declaration file stands in until the next SDK release, which types both properly:

```ts
// src/daintree-env.d.ts — delete once the SDK ships view-globals and plugin-ui
declare module "@daintreehq/plugin-ui";
interface Window {
  electron: { plugin: any };
}
```

The stopgaps cover the kit import and the bridge types only. The newer SDK hooks (`useCachedHostChannel` and the other performance hooks), synced collections and the database types are not in SDK 0.1.0: Not in the 0.1.0 release on npm; it ships in the next one.

Run `npx daintree-plugin lint` before you package: it flags the patterns that make a view slow or look foreign, and names the fix. Not in the 0.1.0 release on npm; it ships in the next one — skip this step until then.

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
- Compose it into something real — subscribe-then-pull views, pushing deltas, large lists, live refresh, file and SQLite data, handing work to an agent — see [Patterns](./patterns.md)
- Understand what runs when — see [Architecture](./architecture.md)
