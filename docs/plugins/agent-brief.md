# Agent brief: building a project plugin

The one file to hand an AI agent that is about to write a plugin into a project's own `.daintree/plugins/`. It carries the rules that decide whether the plugin loads at all, a working skeleton that needs no build tooling, and a reading order for everything else in this folder.

Everything here is about **project plugins** — committed to a repository, loaded only while that project is open. For a plugin that belongs to you and follows you across every project, start at [Getting started](./getting-started.md) instead.

## Point your agent here

Paste this, with the two placeholders filled in:

> Write a Daintree project plugin for this repository. It goes at `<projectRoot>/.daintree/plugins/<publisher>.<name>/`, is committed like any other source, and loads only while this project is open in Daintree.
>
> Read `docs/plugins/agent-brief.md` from the Daintree repository first — it has the load rules and a zero-build skeleton. If you can't reach that file, ask me to paste it. Then read `docs/plugins/project-local.md` for the full contract, and `docs/plugins/contribution-points.md` for the contribution you're adding.
>
> What it should do: **&lt;describe the panel, command, or surface&gt;**

If the agent has no access to the Daintree repository — the normal case, since it is working in _your_ project — paste this file into the conversation. It is written to be self-contained: an agent that reads only this file can produce a plugin that loads.

## What you are building

A directory in your repository holding a `plugin.json` and a committed `dist/`. Daintree scans `<projectRoot>/.daintree/plugins/` when the project opens, asks you once whether to run the project's plugins, and from then on loads them silently — through branch switches, pulls, rebases, and every rebuild an agent commits.

The whole design exists so that an agent working in a fresh worktree can write a plugin, commit it, and have it load on the next open with no install step and no build step. That is why `dist/` is committed and why the host never compiles anything.

## Read in this order

| When you need to know | Read |
| --- | --- |
| The full contract — layout, trust, binding, hot reload, what a project plugin may and may not contribute | [project-local.md](./project-local.md) |
| Every field `plugin.json` accepts | [manifest.md](./manifest.md) |
| The shape of the contribution you're adding — panels, views, commands, toolbar buttons, context menus, keybindings, settings | [contribution-points.md](./contribution-points.md) |
| What `host` can do inside `activate()` | [host-api.md](./host-api.md) |
| What the capability tokens actually mean, and what they don't | [trust-model.md](./trust-model.md) |
| The watcher loop and the `daintree-plugin` CLI | [dev-loop.md](./dev-loop.md) |

Skip [distribution.md](./distribution.md). A project plugin is distributed by being committed; there is no `.dntr` archive in this workflow.

## The rules that decide whether it loads

Ten things an agent gets wrong on the first attempt. Every one of them is silent — the plugin appears in the manager and does nothing.

1. **`"scope": "project"` is required.** A manifest without it, found under `.daintree/plugins/`, is rejected as `project_scope_required`. The same manifest _with_ it, installed into `~/.daintree/plugins/`, is rejected the other way.
2. **`dist/` must be committed.** Most repositories ignore `dist/` at the root, and that pattern covers this directory too. The plugin's own `.gitignore` needs both `!dist/` and `!dist/**` — the first so git descends into the directory, the second so the files inside survive a parent rule matching contents.
3. **Rebuild and commit `dist/` in the same commit as the source change.** A branch with stale `dist/` is stale for everyone who checks it out. A branch with no `dist/` still shows the panels and commands, because the manifest parses — they just do nothing.
4. **The host never reads `src/`, never runs `package.json`, never compiles.** `plugin.json` and `dist/` are the entire load contract.
5. **Commands are registered from `activate()` with `host.registerAction`.** The filesystem-convention handler (`src/<commandId>.js`) that installed plugins may use does not exist here — it would run repository source in the main process, outside the worker every other plugin gets its crash isolation from.
6. **Eight contribution types are refused under `scope: "project"`**: `menuItems`, `agents`, `skills`, `recipes`, `fileDecorationProviders`, `processTools`, `mcpServers`, `forgeProviders`. Each is rejected at manifest validation with an error naming the structural reason. See the table in [project-local.md](./project-local.md#what-a-project-plugin-may-contribute).
7. **The directory name should equal the manifest `name`.** The host identifies the plugin by the manifest and does not compare the two, but every tool and every doc assumes they match.
8. **Only `plugin.json` and `dist/` are watched.** Editing `src/` reloads nothing. Keep a build watcher running, or hand-write `dist/` (see below).
9. **A new plugin id in an already-trusted project is staged, not run.** It is announced once and listed in the plugin manager with a one-click **Activate**. This is the expected state for a plugin an agent just created — it is not a failure.
10. **`engines.daintree` must match the running app.** A range that doesn't is rejected at load with a user-visible warning.

## The zero-build skeleton

The `daintree-plugin` CLI is not on npm yet, so `npx daintree-plugin new --project` returns E404 outside this repository. That is fine: because the host loads `dist/` verbatim as browser ESM, a plugin can be hand-written with no build step, no `npm install`, and no toolchain. Bare `react` resolves through the host's import map, and `createElement` avoids needing a JSX transform.

Four files. Replace `acme.dashboard` throughout with your own `<publisher>.<name>`.

```
<projectRoot>/.daintree/plugins/acme.dashboard/
├── plugin.json
├── .gitignore
└── dist/
    ├── index.js
    └── panel.js
```

**`plugin.json`**

```json
{
  "name": "acme.dashboard",
  "version": "0.1.0",
  "scope": "project",
  "displayName": "Dashboard",
  "description": "A panel for this project.",
  "main": "dist/index.js",
  "engines": { "daintree": ">=0.34.0" },
  "capabilities": [],
  "contributes": {
    "panels": [{ "id": "main", "name": "Dashboard", "iconId": "gauge" }],
    "views": [{ "id": "main", "componentPath": "dist/panel.js", "location": "panel" }]
  }
}
```

**`.gitignore`** — both negations, always:

```gitignore
node_modules/

# dist/ is the load contract. The repository root very likely ignores dist/,
# and a deeper .gitignore wins, so these two lines are what keep it tracked.
# `!dist/` makes git descend into the directory; `!dist/**` re-includes the
# files a parent rule matching contents would still exclude.
!dist/
!dist/**
```

**`dist/index.js`** — the worker entry. Runs once on load; the returned disposer runs on unload.

```js
export async function activate(host) {
  host.registerAction(
    {
      id: "say-hello",
      title: "Say Hello",
      description: "Show a greeting toast.",
      category: "Dashboard",
      kind: "command",
      danger: "safe",
    },
    async () => {
      await host.showToast({ message: "Hello from the project plugin", type: "success" });
    }
  );

  return () => {};
}
```

**`dist/panel.js`** — the view. Default-exports a React component; receives `PanelViewProps`.

```js
import { createElement, useEffect, useState } from "react";

export default function Panel({ panelId, pluginId }) {
  const [worktree, setWorktree] = useState(null);
  useEffect(() => window.electron.plugin.on(pluginId, "worktree", setWorktree), [pluginId]);
  return createElement("div", { "data-panel-id": panelId }, worktree?.name ?? "No worktree");
}
```

`plugins/fixtures/project-local/` in the Daintree repository is this same skeleton, kept working by the load tests.

Two constraints the zero-build path buys you at a price: the React hooks in `@daintreehq/plugin-sdk/react` (`usePluginEvent`, `usePluginPanelEvent`, `useHostChannel`) resolve only in a bundle built with `@daintreehq/plugin-vite`, so a raw module subscribes through `window.electron.plugin.on(...)` directly as above; and you write ESM by hand rather than TypeScript with JSX. Both stop mattering the moment you add a real build — see [dev-loop.md](./dev-loop.md).

## Owning the project's main surface

If the point is for the project to present as a purpose-built application rather than as Daintree with one extra panel, `contributes.surfaces` lets a project plugin replace the host's own empty canvas — the region the stock launcher draws when no panels are open.

```jsonc
"surfaces": { "emptyCanvas": { "viewId": "main" } }
```

One slot exists today, it is project-scope only, and the frame keeps a control that swaps back to the stock launcher in both directions. See [Surfaces](./project-local.md#surfaces).

## Verify it loaded

1. Open the project in Daintree. First time, a dialog names the plugins and asks once — **Always enable** persists the decision for this project, in Daintree's own store, never in the repository.
2. Open the plugin manager. The plugin appears under the project section, badged `Project`, with its source path and manifest id.
3. If it says **Staged**, click **Activate plugin** — a manifest id the project has never had does not run until you do.
4. If it says **Unreadable**, the detail pane carries the validation error verbatim. That is the diagnostic; read it rather than guessing.
5. Run the command from the palette, or open the panel.

Then check the trap that produces the most convincing false success: `git check-ignore -v .daintree/plugins/acme.dashboard/dist/index.js`. It works on the machine that built it whether or not `dist/` is tracked.

Edits to `plugin.json` or `dist/` reload the plugin live, per plugin directory, about 200 ms after writes stop. Settings and `host.storage` survive a reload; module-scope state in the worker and React state in the views do not. No restart is ever required — anything that genuinely needed one is not offered to project plugins.

## See also

- [project-local.md](./project-local.md) — the full contract this brief compresses
- [README.md](./README.md) — the plugin documentation index
- `plugins/fixtures/project-local/` — the skeleton above, as a test fixture
- `plugins/sample/rich-daintree/` — a fuller plugin exercising most contribution points
