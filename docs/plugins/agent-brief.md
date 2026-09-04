# Agent brief: building a project plugin

The one file to hand an AI agent that is about to write a plugin into a project's own `.daintree/plugins/`. It carries the rules that decide whether the plugin loads at all, a working skeleton that needs no build tooling, and a reading order for everything else in this folder.

Everything here is about **project plugins** — committed to a repository, loaded only while that project is open. For a plugin that belongs to you and follows you across every project, start at [Getting started](./getting-started.md) instead.

## Point your agent here

Paste this, with the two placeholders filled in:

> Write a Daintree project plugin for this repository. It goes at `<projectRoot>/.daintree/plugins/<publisher>.<name>/`, is committed like any other source, and loads only while this project is open in Daintree.
>
> Read `docs/plugins/agent-brief.md` from the Daintree repository first — it has the load rules and a zero-build skeleton. If you can't reach that file, ask me to paste it. Then read `docs/plugins/project-local.md` for the full contract, `docs/plugins/patterns.md` for the working patterns, and `docs/plugins/contribution-points.md` for the contribution you're adding.
>
> Write it into the project's registered root checkout, not into a worktree. Only the root's `.daintree/plugins/` is scanned, so a plugin committed in a worktree does not load until that commit reaches the root.
>
> What it should do: **&lt;describe the panel, command, or surface&gt;**

If the agent has no access to the Daintree repository — the normal case, since it is working in _your_ project — paste this file into the conversation. It is written to be self-contained: an agent that reads only this file can produce a plugin that loads.

## What you are building

A directory in your repository holding a `plugin.json` and a committed `dist/`. Daintree scans `<projectRoot>/.daintree/plugins/` when the project opens and asks once whether to run the project's plugins. Answer **Always enable** and the decision persists: from then on the ids it already knows reload silently through branch switches, pulls, rebases, and every rebuild an agent commits. (**Enable for this session** is memory-only and asks again next launch; **Keep disabled** is remembered and runs nothing; dismissing records nothing and may prompt again.)

The whole design exists so that an agent working in a fresh worktree can write a plugin, commit it, and have it load on the next open with no install step and no build step. That is why `dist/` is committed and why the host never compiles anything.

## Read in this order

| When you need to know | Read |
| --- | --- |
| The full contract — layout, trust, binding, hot reload, what a project plugin may and may not contribute | [project-local.md](./project-local.md) |
| Every field `plugin.json` accepts | [manifest.md](./manifest.md) |
| The shape of the contribution you're adding — panels, views, commands, toolbar buttons, context menus, keybindings, settings | [contribution-points.md](./contribution-points.md) |
| What `host` can do inside `activate()`, and the calling conventions | [host-api.md](./host-api.md) |
| What your view gets in the DOM, and how to style it so it reads as native | [views.md](./views.md) |
| Working patterns: pull then push, watch and badge, open files, launch an agent, own the canvas | [patterns.md](./patterns.md) |
| What the capability tokens actually mean, and what they don't | [trust-model.md](./trust-model.md) |
| The watcher loop and the `daintree-plugin` CLI | [dev-loop.md](./dev-loop.md) |

Skip [distribution.md](./distribution.md). A project plugin is distributed by being committed; there is no `.dntr` archive in this workflow.

### If you have the Daintree repo checked out

Prose can drift; these cannot. Read them in preference to any doc that disagrees.

| File | Why it is ground truth |
| --- | --- |
| `electron/schemas/plugin.ts` | The zod schema that actually accepts or rejects your manifest, including the `scope` cross-checks and every refused project contribution, each with the error string you will see |
| `plugins/fixtures/project-local/` | A minimal project plugin at the real path discovery scans. It is a discovery/schema/watcher fixture, not this skeleton: it registers no action and its view returns a plain object rather than rendering React, so do not copy it as a UI starting point |
| `plugins/sample-project/acme.tour/` | **The canonical one to copy.** A zero-build project plugin exercising the whole surface this brief describes: an argument-taking channel, a targeted push, `panel.openPluginPanel` on itself, `file.openPanel`, a `daintree-file://` media fetch, `persistState`, and a badge |
| `plugins/sample/rich-daintree/` | A fuller plugin exercising most contribution points. An _installed_ plugin with a Vite build step — read it for contributions, not for structure |
| `packages/plugin-sdk/` | The real `PluginHostApi` types behind the `host` object |

Run the agent in **your own project**, not in the Daintree checkout, and give it the checkout as a read path. The plugin has to be written into your project, and a Claude Code session started inside the Daintree clone picks up that repo's root `CLAUDE.md` — a contributor guide about gitflow and `npm run check` that has nothing to do with authoring a plugin.

## The rules that decide whether it loads

Sixteen things an agent gets wrong on the first attempt, grouped by how the failure shows up. The middle two groups are the dangerous ones: the plugin loads, looks healthy in the manager, and either does nothing or does the wrong thing.

**Refused at validation — the manager shows `Unreadable` with the first schema issue, prefixed by its field path.**

1. **`"scope": "project"` is required.** A manifest without it, found under `.daintree/plugins/`, is rejected as `project_scope_required`. The same manifest _with_ it, installed into `~/.daintree/plugins/`, is rejected the other way.
2. **Every panel needs `color` as well as `iconId`.** Both are required, and a missing `color` is the single most common reason a hand-written manifest is refused. Any CSS colour works; `var(--theme-category-orange)` is the convention for plugin panels.
3. **A view's `id` must equal a panel's `id`.** The loader attaches a view to a panel kind by matching ids, and a view matching no panel is rejected outright rather than ignored. `surfaces.*.viewId` must likewise name a declared view, and that view's panel must not be `hasPty: true`.
4. **`engines.daintree` must be an open-ended lower bound — never a caret.** `^0.11.0` means `>=0.11.0 <0.12.0` under semver's 0.x rule, so a caret is refused on every release after the one you wrote it against. Write `>=0.11.0`.
5. **Eight contribution types are refused under `scope: "project"`**: `menuItems`, `agents`, `skills`, `recipes`, `fileDecorationProviders`, `processTools`, `mcpServers`, `forgeProviders`. Each error names the structural reason. See the table in [project-local.md](./project-local.md#what-a-project-plugin-may-contribute).

**Loads, and stays inert.**

6. **Activation is lazy.** `activationEvents` defaults to `[]`, so `activate()` does not run at project open — it runs the first time a contribution is _used_. Anything registered imperatively therefore does not exist yet. This is why a command must **also** be declared in `contributes.commands`: the manifest entry is what puts it in the palette and what triggers activation, and the `host.registerAction` call in `activate()` is what gives it a handler with host access. Declare both, with the same id. Use `"activationEvents": ["onStartupFinished"]` only for genuine background work.
7. **The filesystem-convention handler does not exist here.** An installed plugin may drop a handler at `src/<commandId>.js` for the host to import; a project plugin may not, because that would run repository source in the main process, outside the worker every other plugin gets its crash isolation from. Register from `activate()` instead.
8. **Nothing reaches a view on its own.** `window.electron.plugin.on(pluginId, channel, …)` only receives what the worker sends with `host.postToPanel` or `host.broadcastToRenderer`. There is no ambient `"worktree"` channel. Pushes are not buffered either, so a push during `activate()` is gone before the view mounts — have the view pull on mount, then push updates.
9. **`host.registerAction` and `host.registerHandler` return promises.** Await them inside `activate`, or activation can resolve before the registration lands. `activate()` has a 5-second budget: register everything, then start scans and polls without awaiting them.

**Loads, and does the wrong thing.**

10. **A `registerHandler` callback receives the IPC context first and your payload second: `(ctx, args)`.** `ctx` is `{ projectId, worktreeId, webContentsId, pluginId }`. Read the payload from the first parameter and every argument-taking channel receives that object instead, while the argument-less channels keep working, so the panel looks healthy and the buttons do nothing. This is the single most common bug in a first plugin. `registerAction` handlers are different: they receive `(args)` only.
11. **Your runtime id is the instance key, not your manifest name.** `host.pluginId` and `PanelViewProps.pluginId` are `project__{projectId}__{manifestId}`. Manifest `actionId`s in `toolbarButtons`, `keybindings` and `contextMenus` are written as `{manifestId}.{id}` and rewritten to the instance namespace at load, so the manifest stays portable. Your panel kind registers as `project:{projectId}/{manifestId}/{kindId}`, and that is the string `panel.openPluginPanel` wants. Until #12211 adds `host.pluginInfo()`, the only way to build it is from `host.pluginId`.
12. **Declaring `shell:exec` puts a confirm dialog on every command** unless the command narrows it with `"requires": []` (or the capabilities it actually uses). An "open the panel" command should never confirm.
13. **`project`-scope settings are committed to the repository.** They are the right place for team defaults and the wrong place for a machine path such as a Python interpreter. `user` scope is shared across every project. A per-machine scope is tracked in #12213.

**Works for you, broken for everyone who clones.**

14. **`dist/` must be committed, and rebuilt in the same commit as the source change.** This is invisible on the machine that built it. A branch with stale `dist/` is stale for everyone; a branch missing it entirely still shows the panels and commands, because the manifest parses — using them then produces an activation, missing-handler, or view-import error.
15. **The plugin's `.gitignore` needs both `!dist/` and `!dist/**`** — the first so git descends into the directory, the second so the files inside survive a parent rule matching contents. Neither helps if an ancestor rule ignores `.daintree/` or the plugin directory itself: git never reaches a nested `.gitignore` inside an excluded directory, so that rule has to be relaxed at the level that sets it.
16. **Only the registered project root is scanned — never a worktree.** Worktrees are views of the project, not separate scan roots. An agent that writes the plugin inside its own worktree will not see it load until that commit reaches the root checkout Daintree has open. Expect to merge before you can test.

Two more things that are not failures, and get misread as one. A new manifest id in an already-trusted project is **staged**: parsed, announced once, and listed with a one-click **Activate** — it does not run until you click, and that is by design. And the directory name is not compared to the manifest `name`; matching them is convention that every tool assumes, not a load rule.

## The zero-build skeleton

The `daintree-plugin` CLI is not on npm yet, so `npx daintree-plugin new --project` returns E404 outside this repository. That is survivable, because neither half of a plugin has to be compiled: the **view** is imported by the renderer as browser ESM, where a bare `react` specifier resolves through the host's import map, and the **worker entry** is imported by Node in a utility process. Hand-write both and you need no toolchain at all.

Treat this as a load probe — the smallest thing that provably activates and renders. Grow it once it works.

Four files. Replace `acme.dashboard` throughout with your own `<publisher>.<name>`.

```
<projectRoot>/.daintree/plugins/acme.dashboard/
├── plugin.json
├── .gitignore
└── dist/
    ├── index.mjs
    └── panel.js
```

**`plugin.json`** — the command is declared here _and_ registered in `activate()`; see rule 6.

```json
{
  "name": "acme.dashboard",
  "version": "0.1.0",
  "scope": "project",
  "displayName": "Dashboard",
  "description": "A panel for this project.",
  "authors": [{ "name": "Your Name" }],
  "main": "dist/index.mjs",
  "engines": { "daintree": ">=0.11.0" },
  "capabilities": ["fs:project-read"],
  "contributes": {
    "commands": [
      {
        "id": "say-hello",
        "title": "Say Hello",
        "description": "Show a greeting toast.",
        "category": "Dashboard",
        "kind": "command",
        "danger": "safe"
      }
    ],
    "panels": [
      {
        "id": "main",
        "name": "Dashboard",
        "iconId": "gauge",
        "color": "var(--theme-category-orange)"
      }
    ],
    "views": [{ "id": "main", "componentPath": "dist/panel.js", "location": "panel" }]
  }
}
```

**`.gitignore`** — both negations, and check no ancestor ignores `.daintree/`:

```gitignore
node_modules/

# dist/ is the load contract. The repository root very likely ignores dist/,
# and a deeper .gitignore wins, so these two lines are what keep it tracked.
# `!dist/` makes git descend into the directory; `!dist/**` re-includes the
# files a parent rule matching contents would still exclude.
!dist/
!dist/**
```

**`dist/index.mjs`** — the worker entry, run by Node. The `.mjs` extension is not cosmetic: with no `package.json` of its own the file inherits the module type of the nearest enclosing one, and in a repository that is CommonJS (or declares no `type` at all) `export` fails to parse. `.mjs` is ESM regardless of what your project declares.

```js
export async function activate(host) {
  await host.registerAction(
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

  // The view pulls through this on mount. Nothing reaches a panel unless the
  // worker sends it, and a push made here would land before any view exists.
  await host.registerHandler("worktree", async () => await host.getActiveWorktree());

  // Handlers receive the IPC context FIRST and the view's payload second.
  // Reading the payload from the first parameter is the most common first bug.
  await host.registerHandler("read-file", async (_ctx, args) => {
    const { path } = args ?? {};
    if (typeof path !== "string") throw new Error("read-file needs a path");
    return await host.fs.readFile(path); // contained to the project root by default
  });

  return () => {};
}
```

**`dist/panel.js`** — the view, imported by the renderer. Default-exports a React component and receives `PanelViewProps`.

```js
import { createElement, useEffect, useState } from "react";

export default function Panel({ panelId, pluginId }) {
  const [worktree, setWorktree] = useState(null);
  useEffect(() => {
    let live = true;
    void window.electron.plugin.invoke(pluginId, "worktree").then((wt) => {
      if (live) setWorktree(wt);
    });
    return () => {
      live = false;
    };
  }, [pluginId]);
  return createElement("div", { "data-panel-id": panelId }, worktree?.name ?? "No worktree");
}
```

Use the `pluginId` prop rather than hardcoding your manifest name — for a project plugin the runtime id is an instance key, not the manifest id.

What the no-build path costs: the React hooks in `@daintreehq/plugin-sdk/react` resolve only in a bundle built with `@daintreehq/plugin-vite`, so a raw view uses the `window.electron.plugin` bridge directly as above; and the view can import `react` plus its own relative modules, but not arbitrary bare npm specifiers, TypeScript, JSX, or CSS files. If you need those, build inside a Daintree checkout where the workspace packages resolve — outside one there is no published toolchain yet. [dev-loop.md](./dev-loop.md) covers the watcher.

## Styling: use Tailwind

Write Tailwind utility classes. They work in a hand-written `dist/panel.js` exactly as in a bundled view, with no build step and no configuration — Daintree compiles the classes your view uses at runtime, against the host's own Tailwind and theme.

Two things follow from that, and they are the whole contract:

- **You get Daintree's vocabulary, not Tailwind's stock one.** `bg-surface-panel` compiles. `bg-red-500` compiles to _nothing_ — the host's theme deletes the stock palette on purpose, so plugin panels cannot drift out of the design system. If a colour class appears to do nothing, that is why.
- **Generated rules are scoped to your view** and can never restyle host chrome.

Everything ordinary works as Tailwind documents it: layout, spacing, sizing, typography, flexbox, grid, `hover:` / `focus-visible:` / `disabled:` / `group-hover:`, arbitrary values (`w-[327px]`), dynamic scales (`grid-cols-47`), container queries.

**Not available:** stock palette colours; `dark:` (Daintree themes are runtime tokens, not a class — a semantic token is already theme-aware); `prose`; `@apply`.

Prefer container queries (`@container`, `@sm:`) over viewport breakpoints — your panel is one pane in a grid and can be narrow while the window is wide.

### The vocabulary

<!-- BEGIN generated: plugin-style-vocabulary -->

**Surfaces** — `bg-`, `border-`, `text-`

`surface-canvas` `surface-sidebar` `surface-toolbar` `surface-panel` `surface-panel-elevated` `surface-dialog` `surface-grid` `surface-input` `surface-inset` `surface-hover` `surface-active` `surface-disabled` `surface-highlight`

**Text** — `text-`

`text-primary` `text-secondary` `text-muted` `text-placeholder` `text-inverse` `text-link`

**Borders** — `border-`, `divide-`, `ring-`

`border-default` `border-subtle` `border-strong` `border-divider` `border-interactive`

**Status** — `bg-`, `text-`, `border-`

`status-success` `status-warning` `status-danger` `status-info` `status-danger-surface` `status-success-surface` `status-warning-surface` `status-info-surface` `status-error` `status-error-surface`

**Accent** — `bg-`, `text-`, `border-`

`accent-primary` `accent-hover` `accent-foreground` `accent-primary-foreground` `accent-soft` `accent-muted` `accent-secondary` `accent-secondary-soft` `accent-secondary-muted`

**Radii** — `rounded-`

`xs` `sm` `md` `lg` `xl` `2xl` `3xl` `4xl`

**Type scale below Tailwind's floor** — `text-`

`2xs` `3xs` `4xs`

**Durations** — `duration-`

`75` `100` `120` `150` `200` `250` `300`

**Easings** — `ease-`

`snappy` `spring-critical` `out-expo` `exit` `panel-minimize`

**Category hues** — `bg-`, `text-`, `border-`, as `category-<hue>` plus a variant suffix

hues: `blue` `purple` `cyan` `green` `amber` `orange` `teal` `indigo` `rose` `pink` `violet` `slate`

variants: `(bare)` `-subtle` `-text` `-border`

**Custom variants** — write as `variant:utility`

`reduce-motion:`

<!-- END generated: plugin-style-vocabulary -->

Every other non-colour utility Tailwind ships works too.

```jsx
// Panel root — `min-h-0` is what lets an inner scroller own the overflow.
<div className="flex flex-col flex-1 min-h-0 bg-surface-panel text-text-primary">
// Row
<div className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover">
// Subtle button
<button className="rounded-md border border-border-subtle px-3 py-1.5 text-xs hover:bg-surface-hover">
// Badge
<span className="rounded-full bg-surface-inset px-2 py-0.5 text-2xs text-text-muted">
```

**Conditional classes must be complete strings.** `active ? "bg-surface-active" : ""` works; `` `bg-surface-${tone}` `` does not, because a name assembled from fragments never appears in your source or the DOM as a whole class.

**Portals need a marked container.** `createPortal` leaves your style root, so spread `styleRootAttributes` from `PanelViewProps` onto the container: `createPortal(<div {...styleRootAttributes} className="p-4">…</div>, document.body)`.

A `<style>` element still works for what utilities do not cover (keyframes, complex selectors); scope its selectors under a class on your root. Never ship compiled Tailwind CSS — `@daintreehq/plugin-vite` fails the build if you wire Tailwind into it. [views.md](./views.md) has the full rules.

## Owning the project's main surface

If the point is for the project to present as a purpose-built application rather than as Daintree with one extra panel, `contributes.surfaces` lets a project plugin replace the host's own empty canvas — the region the stock launcher draws when no panels are open.

```jsonc
"surfaces": { "emptyCanvas": { "viewId": "main" } }
```

`viewId` must name a declared `contributes.views` entry — a dangling id is a validation error — and that view's panel must not be `hasPty: true`. One slot exists today, it is project-scope only, and the frame keeps a control that swaps back to the stock launcher in both directions. See [Surfaces](./project-local.md#surfaces).

## Verify it loaded

1. Open the project in Daintree. First time, a dialog names the plugins and asks once — **Always enable** persists the decision for this project, in Daintree's own store, never in the repository.
2. Open the plugin manager. The plugin appears under the project section, badged `Project`, with its source path and manifest id.
3. If it says **Staged**, click **Activate plugin** — a manifest id the project has never had does not run until you do.
4. If it says **Unreadable**, the detail pane carries the first schema issue prefixed by its field path — or, for a manifest that never parsed, the JSON/read error. That is the diagnostic; read it rather than guessing.
5. Run **Dashboard: Say Hello** from the palette, or open the panel. Either one activates the plugin — the manifest's `contributes.commands` entry is what makes the command reachable before `activate()` has ever run.

Then check the trap that produces the most convincing false success — it works on the machine that built it whether or not `dist/` is tracked. Prove both halves, because neither implies the other:

```bash
git check-ignore -v --no-index .daintree/plugins/acme.dashboard/dist/index.mjs   # expect: no match
git ls-files --error-unmatch .daintree/plugins/acme.dashboard/dist/index.mjs     # expect: the path
```

## When a button does nothing

The plugin loaded, the panel renders, a command or a button does nothing, or the wrong thing. In order of likelihood:

1. **The handler read `ctx` as its payload** (rule 10). Log the first parameter: if it has `projectId` and `webContentsId`, that is the context, not your args.
2. **`dist/` is stale.** The host runs what is on disk. Check the file's mtime against your edit; if you build, check the watcher is running.
3. **The `actionId` in the manifest is wrong.** It is `{manifestId}.{commandId}`, and the host rewrites it to the instance namespace. `{commandId}` alone or the instance key by hand both resolve to nothing.
4. **The action threw.** A thrown error from a command surfaces as a toast; a thrown render error shows the panel's diagnostics pane, whose "Copy diagnostics" carries the stack. `host.logger` lines are in the plugin manager's detail pane for the plugin.
5. **A capability is missing.** `host.fs`, `host.git`, `host.process` and `sendToActiveAgent` reject with a `PERMISSION_REQUIRED:` prefix when the manifest does not declare the token; `host.process`, `fs.writeFile`, `git` writes and `sendToActiveAgent` also raise a one-time consent dialog on first use, which is easy to miss behind a terminal.

Edits to `plugin.json` or `dist/` reload the plugin live, per plugin directory, about 200 ms after writes stop. Settings and `host.storage` survive a reload; module-scope state in the worker and React state in the views do not. No restart is ever required — anything that genuinely needed one is not offered to project plugins.

## See also

- [project-local.md](./project-local.md) — the full contract this brief compresses
- [patterns.md](./patterns.md) — the working patterns, each with the exact host calls
- [views.md](./views.md) — what a view gets in the DOM and how to style it
- [README.md](./README.md) — the plugin documentation index
- `plugins/fixtures/project-local/` — a discovery/schema/watcher fixture at the real path, not the skeleton above: it registers no action and its view returns a plain object rather than React
- `plugins/sample/rich-daintree/` — a fuller plugin exercising most contribution points
