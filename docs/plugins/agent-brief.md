# Agent brief: building a project plugin

The one file to hand an AI agent that is about to write a plugin into a project's own `.daintree/plugins/`. It carries the rules that decide whether the plugin loads at all, a working skeleton that needs no build tooling, the defaults that make it fast and native — Daintree's own UI kit and the SDK's hooks — and a reading order for everything else in this folder.

Everything here is about **project plugins** — committed to a repository, loaded only while that project is open. For a plugin that belongs to you and follows you across every project, start at [Getting started](./getting-started.md) instead.

## Point your agent here

Paste this, with the two placeholders filled in:

> Write a Daintree project plugin for this repository. It goes at `<projectRoot>/.daintree/plugins/<publisher>.<name>/`, is committed like any other source, and loads only while this project is open in Daintree.
>
> Read `docs/plugins/agent-brief.md` from the Daintree repository first — it has the load rules, a zero-build skeleton, and the UI kit and performance defaults to build with. If you can't reach that file, ask me to paste it. Then read `docs/plugins/project-local.md` for the full contract, `docs/plugins/patterns.md` for the working patterns, and `docs/plugins/contribution-points.md` for the contribution you're adding. If it is an application over data that agents also use — a ledger, a CRM, a board — read `docs/plugins/building-apps.md` and `docs/plugins/agent-extensions.md` as well: agents should reach the data through the plugin's own MCP server (the host's database tools for reads, the plugin's `agentMcp` tools for writes with rules), with `sqlite3` or file edits under the plugin's `AGENTS.md` as the fallback.
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
| What your view gets in the DOM: the UI kit's components, the SDK's hooks, styling, and performance | [views.md](./views.md) |
| Working patterns: subscribe then pull, push deltas, stream progress, large lists, watch and refresh, file UIs, revision-safe edits, a SQLite store, clocks, canvas, hand work to an agent, settings setup, export and backup, own the canvas | [patterns.md](./patterns.md) |
| An application over data agents use: the data contract, the store, agent tools, live refresh, hand-off | [building-apps.md](./building-apps.md) |
| How agents reach the plugin's data: the plugin's MCP server, its database tools and `agentMcp` tools, the access setting, `.daintree/mcp.json`, and why a tool doesn't show up in `/mcp` | [agent-extensions.md](./agent-extensions.md#agent-mcp-endpoints) |
| Frontmatter, JSON Lines and the conflict-checked `editFile` loop, importable with no install | [data-helpers.md](./data-helpers.md) |
| What the capability tokens actually mean, and what they don't | [trust-model.md](./trust-model.md) |
| The watcher loop and the `daintree-plugin` CLI, including `lint` and the `dev` metrics table | [dev-loop.md](./dev-loop.md) |

Skip [distribution.md](./distribution.md). A project plugin is distributed by being committed; there is no `.dntr` archive in this workflow.

### If you have the Daintree repo checked out

Prose can drift; these cannot. Read them in preference to any doc that disagrees.

| File | Why it is ground truth |
| --- | --- |
| `electron/schemas/plugin.ts` | The zod schema that actually accepts or rejects your manifest, including the `scope` cross-checks and every refused project contribution, each with the error string you will see |
| `plugins/fixtures/project-local/` | A minimal project plugin at the real path discovery scans. It is a discovery/schema/watcher fixture, not this skeleton: it registers no action and its view returns a plain object rather than rendering React, so do not copy it as a UI starting point |
| `plugins/sample-project/acme.tour/` | **The canonical one to copy.** A zero-build project plugin with one working example of each thing this brief tells you to build: an Open command that opens its own panel through `host.panelKindId`, an argument-taking channel, a targeted push, `file.openPanel`, a `daintree-file://` media fetch, `persistState`, and a badge |
| `plugins/sample-project/acme.ledger/` | The canonical data plugin: zero build, no view. A SQLite database declared in `contributes.databases` and opened with `host.db`, an `AGENTS.md` data contract, and a `contributes.agentMcp` roster for the writes that have rules. Declaring the database also puts the host's read-only `database_schema` and `database_query` on its MCP server beside those tools, with no code. Copy it for data and agent tools, not for UI |
| `plugins/sample/rich-daintree/` | A fuller plugin exercising most contribution points. An _installed_ plugin with a Vite build step — read it for contributions, not for structure |
| `packages/plugin-sdk/` | The real `PluginHostApi` types behind the `host` object |

Run the agent in **your own project**, not in the Daintree checkout, and give it the checkout as a read path. The plugin has to be written into your project, and a Claude Code session started inside the Daintree clone picks up that repo's root `CLAUDE.md` — a contributor guide about gitflow and `npm run check` that has nothing to do with authoring a plugin.

## The rules that decide whether it loads

Eighteen things an agent gets wrong on the first attempt, grouped by how the failure shows up. The middle two groups are the dangerous ones: the plugin loads, looks healthy in the manager, and either does nothing or does the wrong thing.

**Refused at validation — the manager shows `Unreadable` with the first schema issue, prefixed by its field path.**

1. **`"scope": "project"` is required.** A manifest without it, found under `.daintree/plugins/`, is rejected as `project_scope_required`. The same manifest _with_ it, installed into `~/.daintree/plugins/`, is rejected the other way.
2. **Every panel needs `color` as well as `iconId`.** Both are required, and a missing `color` is the single most common reason a hand-written manifest is refused. Any CSS colour works; `var(--theme-category-orange)` is the convention for plugin panels.
3. **A panel view's `id` must equal a panel's `id`.** The loader attaches a view to a panel kind by matching ids, and a panel view matching no panel is rejected outright rather than ignored. The one exception is a `location: "settings"` view: at most one per plugin, and it must have an id no panel uses. `surfaces.*.viewId` must likewise name a declared view, and that view's panel must not be `hasPty: true`.
4. **`engines.daintree` must be an open-ended lower bound — never a caret.** `^0.11.0` means `>=0.11.0 <0.12.0` under semver's 0.x rule, so a caret draws a compatibility warning on every release after the one you wrote it against. Write `>=` the earliest release that has every API you use — `>=0.39.0` for `host.db`, `renderPdf`, `sendToAgent` or the settings setup strip; `>=0.41.0`, the first release after 0.40, for the UI kit beyond `Markdown`, `@daintreehq/plugin-sdk/react` in a zero-build view, `createSyncedCollection` from the SDK the host serves a zero-build worker, `host.fs.readFiles` and `host.fs.walk`, and `host.hasListeners` / `host.onDidChangeListeners`. The range is advisory — an unmet one draws a warning toast and the plugin loads anyway — so a plugin that should still work on an older release checks at runtime too: `PLUGIN_UI_VERSION` read through a namespace import (`import * as kit from "@daintreehq/plugin-ui"`; `kit.PLUGIN_UI_VERSION` is `undefined` on 0.40, which serves only `Markdown`, where a named import of anything else fails the whole module) and the optional host methods (`typeof host.hasListeners === "function"`, `host.fs.walk?.(root)`), which the SDK types mark optional for exactly this reason.
5. **Nine contribution types are refused under `scope: "project"`**: `menuItems`, `agents`, `skills`, `recipes`, `fileDecorationProviders`, `processTools`, `mcpServers`, `tours`, `forgeProviders` — plus `fileEditors`, `previewTools` and `guestAdapters`, which only a built-in plugin may declare. Each error names the structural reason. See the table in [project-local.md](./project-local.md#what-a-project-plugin-may-contribute). To give agents tools, declare `agentMcp` instead — it is allowed here (see [Agent MCP endpoints](./agent-extensions.md#agent-mcp-endpoints)).

**Loads, and stays inert.**

6. **Activation is lazy.** `activationEvents` defaults to `[]`, so `activate()` does not run at project open — it runs the first time a contribution is _used_. Anything registered imperatively therefore does not exist yet. This is why a command must **also** be declared in `contributes.commands`: the manifest entry is what puts it in the palette and what triggers activation, and the `host.registerAction` call in `activate()` is what gives it a handler with host access. Declare both, with the same id. Use `"activationEvents": ["onStartupFinished"]` only for genuine background work: an eagerly activated plugin's worker starts at boot and runs for the whole session, 70–90 MB in the lab, even if none of its panels is ever opened. Lazy, it starts the first time a panel opens or a command runs.
7. **The filesystem-convention handler does not exist here.** An installed plugin may drop a handler at `src/<commandId>.js` for the host to find; a project plugin may not, because the host reads only your committed `dist/` and never `src/`. Not a trust distinction — an installed plugin's handler runs in that plugin's worker, same as everything else — just the build-output contract, which leaves nothing here to look for. Register from `activate()` instead.
8. **Nothing reaches a view on its own.** `window.electron.plugin.on(pluginId, channel, …)` only receives what the worker sends with `host.postToPanel` or `host.broadcastToRenderer`. There is no ambient `"worktree"` channel. Pushes are not buffered either, so a push during `activate()` is gone before the view mounts, and they are not ordered against `invoke` results — so the view subscribes first, then pulls, and keeps whichever carries the newer revision ([Patterns → Subscribe, then pull](./patterns.md#subscribe-then-pull)).
9. **`host.registerAction` and `host.registerHandler` return promises.** Await them inside `activate`, or activation can resolve before the registration lands. `activate()` has a 5-second budget: register everything, then start scans and polls without awaiting them.

**Loads, and does the wrong thing.**

10. **A `registerHandler` callback receives the IPC context first and your payload second: `(ctx, args)`.** `ctx` is `{ projectId, worktreeId, webContentsId, pluginId }`. Read the payload from the first parameter and every argument-taking channel receives that object instead, while the argument-less channels keep working, so the panel looks healthy and the buttons do nothing. This is the single most common bug in a first plugin. `registerAction` handlers are different: they receive `(args)` only.
11. **Your runtime id is the instance key, not your manifest name.** `host.pluginId` and `PanelViewProps.pluginId` are `project__{projectId}__{manifestId}`. Manifest `actionId`s in `toolbarButtons`, `keybindings`, `contextMenus` and a panel's `menu` are written as `{manifestId}.{id}` and rewritten to the instance namespace at load, so the manifest stays portable. Your panel kind registers as `project:{projectId}/{manifestId}/{kindId}`, and that is the string `panel.openPluginPanel` wants — get it from `host.panelKindId("main")` rather than assembling it. `host.pluginInfo` is your identity as data: `{ instanceId, manifestId, origin, projectId, projectRoot }`, where `projectRoot` is the project's main checkout. Never split `host.pluginId` by hand.
12. **A high-risk capability puts a confirm dialog on every command.** Declaring any of `shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:input`, `agent:invoke` or `agent:register` raises every command the plugin registers to confirm — so a data app that writes files confirms its own Open command. Narrow each command with `"requires": []` (or the capabilities it actually uses), on the `contributes.commands` entry _and_ on the `registerAction` descriptor, which replaces the manifest entry once registered. An "open the panel" command should never confirm.
13. **Give each setting the scope its value belongs in.** `project` scope is committed to the repository (`.daintree/plugin-settings/<manifestId>.json`): team defaults, never a machine path. `local` is per project and per machine and never committed — an interpreter path, a reviewer name. For a project plugin `user` scope stays on this machine too, keyed by your instance, so it does not share a value across projects; say `local` when that is what you mean. A `secret` is never committed whatever its scope, and cannot declare a `default`. Mark what the plugin cannot run without `required: true` — its panels then show a "needs setup" strip and `host.settings.missingRequired()` lists it — and send users to `host.settings.open(key)` rather than building a settings screen. Settings are the user's: the data contract you give agents never includes the settings files. See [Patterns → Gate on setup](./patterns.md#gate-on-setup).
14. **`host.dispatch` resolves `{ ok: false, error }` instead of throwing.** A command that returns the dispatch result unchecked is a button that silently does nothing. Check `result.ok` and throw on failure; `acme.tour`'s `dispatchOrThrow` is the four-line helper.
15. **Branch on `err.code`, never on message text — and expect the first write to ask.** Host errors keep `code` across the worker port (`REVISION_MISMATCH` with its `currentRevision`, `TARGET_EXISTS`, `TARGET_UNAVAILABLE`, `TARGET_IS_SYMLINK`, the `DB_*` codes); `PERMISSION_REQUIRED:` and `host.fs`'s `PATH_NOT_ALLOWED:` carry no `code`, so match those two by their message prefix. A write-class call — `host.fs.writeFile` / `appendFile` / `mkdir`, a writable `host.db` open of a project database, `renderPdf`, `db.backup` — asks the user once for the matching `fs:*-write` grant, and `sendToAgent` and `process.spawn` ask for theirs. A one-time approval and a refusal are not remembered and an unanswered prompt times out, so a refused write must not be retried from a timer or watch callback: show the state and retry on the user's next action. An error a handler throws reaches the view's `invoke` as a message only — return data such as `{ conflict: true }` when the view has to branch.

**Works for you, broken for everyone who clones.**

16. **`dist/` must be committed, and rebuilt in the same commit as the source change.** This is invisible on the machine that built it. A branch with stale `dist/` is stale for everyone; a branch missing it entirely still shows the panels and commands, because the manifest parses — using them then produces an activation, missing-handler, or view-import error.
17. **The plugin's `.gitignore` needs both `!dist/` and `!dist/**`** — the first so git descends into the directory, the second so the files inside survive a parent rule matching contents. Neither helps if an ancestor rule ignores `.daintree/` or the plugin directory itself: git never reaches a nested `.gitignore` inside an excluded directory, so that rule has to be relaxed at the level that sets it.
18. **Only the registered project root is scanned — never a worktree.** Worktrees are views of the project, not separate scan roots. An agent that writes the plugin inside its own worktree will not see it load until that commit reaches the root checkout Daintree has open. Expect to merge before you can test.

Two more things that are not failures, and get misread as one. A new manifest id in an already-trusted project is **staged**: parsed, announced once, and listed with a one-click **Activate** — it does not run until you click, and that is by design. And the directory name is not compared to the manifest `name`; matching them is convention that every tool assumes, not a load rule.

## The zero-build skeleton

`npx daintree-plugin new --project` scaffolds a project plugin with a Vite build, but neither half of a plugin has to be compiled: the **view** is imported by the renderer as browser ESM, where bare `react` and `@daintreehq/plugin-ui` specifiers resolve through the host's import map, and the **worker entry** is imported by Node in a utility process. Hand-write both and you need no toolchain at all.

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

**`plugin.json`** — the command is declared here _and_ registered in `activate()` (rule 6), and `"requires": []` keeps it one click however the capability list grows (rule 12).

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
        "id": "open",
        "title": "Open Dashboard",
        "description": "Open the Dashboard panel for this project.",
        "category": "Dashboard",
        "kind": "command",
        "danger": "safe",
        "requires": []
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

`engines.daintree` here is the floor for the manifest alone. The view below imports kit components beyond `Markdown` and `@daintreehq/plugin-sdk/react`, which Daintree 0.40 and earlier do not serve, so a real plugin with this view declares `>=0.41.0` (rule 4).

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
      id: "open",
      title: "Open Dashboard",
      description: "Open the Dashboard panel for this project.",
      category: "Dashboard",
      kind: "command",
      danger: "safe",
      requires: [],
    },
    async () => {
      // panelKindId qualifies the bare panel id for this project; never build
      // "project:…" by hand. dispatch resolves { ok: false } rather than throwing.
      const result = await host.dispatch("panel.openPluginPanel", {
        kind: host.panelKindId("main"),
      });
      if (!result.ok) throw new Error(`Could not open the panel: ${result.error?.message}`);
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

**`dist/panel.js`** — the view, imported by the renderer. Default-exports a React component and receives `PanelViewProps`. `react`, the UI kit and the SDK's hooks all come from the host's import map, so this runs as written.

```js
import { createElement } from "react";
import { useCachedHostChannel } from "@daintreehq/plugin-sdk/react";
import { EmptyState, PaneState } from "@daintreehq/plugin-ui";

export default function Panel({ panelId, pluginId, disposeSignal }) {
  const {
    data: worktree,
    error,
    updatedAt,
    revalidate,
  } = useCachedHostChannel(pluginId, "worktree", null, {
    signal: disposeSignal,
  });
  if (error && !updatedAt) {
    return createElement(PaneState, {
      kind: "error",
      title: "Couldn't load the worktree",
      onRetry: revalidate,
    });
  }
  if (!updatedAt) return createElement(PaneState, { kind: "loading", title: "Loading worktree" });
  return createElement(
    "div",
    { "data-panel-id": panelId, className: "flex flex-col flex-1 min-h-0 p-4 text-text-primary" },
    worktree ? worktree.name : createElement(EmptyState, { title: "No worktree", scale: "sidebar" })
  );
}
```

Use the `pluginId` prop rather than hardcoding your manifest name — for a project plugin the runtime id is an instance key, not the manifest id. `disposeSignal` stops the hook once the view unmounts; `updatedAt` stays `0` until the first answer lands, which is how the view tells "not loaded yet" from a `null` answer.

What the no-build path costs, and what it doesn't: the worker cannot import npm packages, with one exception — the plugin worker serves `@daintreehq/plugin-sdk`, `/files` and `/data` from a copy that ships with Daintree, so `import { parseFrontmatter, updateFrontmatter, parseJsonl, editFile } from "@daintreehq/plugin-sdk/data";` and `import { createSyncedCollection } from "@daintreehq/plugin-sdk";` work in `dist/index.mjs` with no install. Use them rather than hand-writing a YAML parser, a `writeFile({ expectedRevision })` retry loop or a delta protocol — see [data-helpers.md](./data-helpers.md). The view can import `react`, the host's UI kit from `@daintreehq/plugin-ui`, the SDK's hooks from `@daintreehq/plugin-sdk/react` (served by the host to zero-build views), and its own relative `.js` / `.mjs` modules — but not the SDK's other entries, other bare npm specifiers, TypeScript, JSX, or CSS files. Do data work in the worker and hand the view results over a channel. A pure module with no imports (`dist/core.mjs`: date rules, totals, status order) can be imported by the worker, the view and an agent-facing script alike, so the three never disagree. Rendering Markdown is the case that tempts a hand-rolled parser; don't write one — `createElement(Markdown, { source, basePath })` with `import { Markdown } from "@daintreehq/plugin-ui"` is Daintree's own renderer, raw HTML dropped, styled like the app ([views.md → Host UI components](./views.md#host-ui-components)). If you need more than that — TSX, npm packages, many views — add the toolchain: scaffold with `npx daintree-plugin new --project` (its `tsconfig.json` already lists `@daintreehq/plugin-sdk/view-globals` and `@daintreehq/plugin-sdk/plugin-ui` in `types`, so `window.electron.plugin` and the kit typecheck), or `npm install --save-dev @daintreehq/plugin-sdk @daintreehq/plugin-vite daintree-plugin` and add those two `types` yourself. Build with Vite; a bundled view bundles its own pinned copy of the SDK hooks and never bundles `react` or the kit. [dev-loop.md](./dev-loop.md) covers the watcher.

## Draw with the kit

**Draw with `@daintreehq/plugin-ui` first.** It is Daintree's own UI served to your view like `react` — no install, no bundle cost, themed with the app and keyboard-complete — and it is what makes a plugin look native rather than bolted on. Reach for a kit component before writing markup:

| You need | Use |
| --- | --- |
| A button, an icon button, a menu | `Button` (no `variant` is the accent primary: one per region; `secondary`, `outline`, `ghost`, `subtle` for the rest), `IconButton`, `DropdownMenu` |
| A form | `Input` (including `date`, `time`), `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, `SegmentedControl`, `NumberInput`, `Slider`, `SearchField`, wrapped in `FormField`; `FormFieldGroup` for one label over a set of controls |
| A searchable pick, labels, assignees, tags | `Combobox` (one value; `filter="none"` with `onSearchChange` and `loading` for options you fetch), `MultiSelect` (several, as chips), `TagInput` (free text) |
| Files from the user, an emoji | `FileDropzone` (hands you `File` objects to read in the view, never a path), `EmojiPicker` |
| A list or table of any length | `DataTable`, `VirtualList` with `ListRow`, `LogView` for output |
| A file tree | `FileTree` (takes `host.fs.walk` entries as they come) |
| A headline number, a trend | `StatCard`, `Sparkline` |
| Pane chrome | `PaneHeader`, `Toolbar` with `ToolbarButton`, `Tabs` |
| Loading, empty, error | `PaneState` for the whole pane, `EmptyState`, `Callout` (`severity="error"` with a Retry `action` is the error banner), `Skeleton`, `Spinner`, `ProgressBar` |
| A status chip | `Badge` |
| A confirm or a modal | `ConfirmDialog`, `Dialog` |
| An icon | `Icon` by name (`git-branch`, `folder-open`, `alert-triangle`, `worktree`, …) |
| Rendered Markdown | `Markdown` |
| Relative times, sizes, durations | `formatTimeAgo`, `formatBytes`, `formatDuration`, `formatCount` |
| Colours for a canvas or WebGL | `useDaintreeTheme()` / `onDidChangeDaintreeTheme` |

A settings view builds from `SettingsSection`, `SettingsGroup` and `SettingsRow`. The full list with props is [views.md → Host UI components](./views.md#host-ui-components), and `plugin-ui.d.ts` in `@daintreehq/plugin-sdk` is the authoritative one. Nothing is locked down: for anything the kit has no component for — a chart beyond a sparkline, say — use the token vocabulary below.

Things the lab watched agents get wrong, each of which the kit or the host already covers:

- **An icon copied as inline SVG, or `lucide-react` bundled into the view.** Use `Icon`.
- **`window.confirm` in a view.** It ignores the theme and blocks the whole window. Use `ConfirmDialog`.
- **A second setup banner.** A panel of a plugin with an unset `required` setting already shows the host's "needs setup" strip; render an empty state, not your own warning.
- **A modal with a stock-palette scrim** (`bg-black/40`), which compiles to nothing, so the dialog floats with no dimming. Use `Dialog`.
- **Native `<select>`, checkboxes, radios, ranges and date inputs** beside host-styled text fields. Use `Select`, `Checkbox`, `RadioGroup`, `Slider`, `Input type="date"`.
- **A `PaneHeader` that repeats the panel's name.** The host's panel chrome already shows the panel's title and icon above your view, so `title="Review queue"` under a "Review Queue" tab says it twice. Give `PaneHeader` view-specific context — the filter in effect, the selected item, a count ("4,096 of 5,000") — or leave it out and put the actions in a `Toolbar variant="bar"`. `title` is required, so there is no header that is only actions.
- **A filled button as a status.** A green "✓ Approved" primary button where Approve used to be reads as a control that does something. Show the state with a `Badge` or a `SeverityIcon` beside the title, and keep the button for the action (disabled, or swapped for the next one, such as "Undo").

Kit components load with the kit's one chunk the first time a view in the session imports it, so the very first render can paint a frame late; they validate their props at runtime and ignore a value they don't know. Daintree 0.40 and earlier serve only `Markdown` from the kit and do not serve `@daintreehq/plugin-sdk/react` to zero-build views, so `PLUGIN_UI_VERSION` (`"1.0.0"` today) is the thing to check before relying on the rest.

## Fast by default

A plugin view shares the app's main thread, so a slow panel is a slow Daintree. Ten plugins written the naive way were measured against the same plugins ported to the kit and the SDK's hooks; the numbers below are from one machine, one run each, so read them as orders of magnitude. Every hook named here is in `@daintreehq/plugin-sdk/react`, which a zero-build view imports like `react`.

- **Virtualise any list the user's data sizes.** A 10,000-row table drawn with `rows.map` took 1.5 s to first paint, held 130,027 DOM nodes and took 1.6 s to re-sort; `DataTable` held 490 nodes and sorted in 19 ms. Use `DataTable` or `VirtualList`; `useProgressiveList` for a few hundred rows of your own markup. [Patterns → Large lists](./patterns.md#large-lists).
- **Never push per item.** A job that pushed each of 20,000 progress lines, appended with `setState([...prev, line])`, caused 300 ms frame gaps and left 20,000 rows in the DOM; gathered in the worker and pushed every 50 ms it sent 7 messages. Render streams with `useStreamBuffer` and `LogView`, and throttle a replaceable value (a percentage) with `useThrottledCallback`. [Patterns → Stream progress and logs](./patterns.md#stream-progress-and-logs).
- **Push deltas, not the whole state.** Re-sending a growing list on every change costs the square of its length: 100 tool calls cost 1.1 MB in 200 pushes. `createSyncedCollection` in the worker and `useSyncedCollection` in the view sent 23 KB in 13, and handle the ordering races for you. A delta carries each changed item whole, so a status flip on a large item resends all of it: keep items to what the list shows, and fetch a large field (a body, a diff, a log) with its own `invoke` when a row is opened. [Patterns → Push deltas](./patterns.md#push-deltas-not-the-whole-state).
- **Subscribe first, then pull**, and keep whichever answer carries the newer revision: pushes are not ordered against `invoke` results (rule 8).
- **Refetch once per burst.** For a "this changed" push (a database `onDidChange`, a file watch), use `useCachedHostChannel(pluginId, channel, args, { invalidateOn })`: one refetch after `debounceMs` (default 100) of quiet instead of one per push.
- **Host subscriptions coalesce by default.** `onDidChangeWorktrees`, `onDidChangeActiveWorktree` and `onDidChangeAgentState` deliver one callback per 100 ms burst with the latest state; pass `{ debounceMs: 0 }` only when you need every event. `host.fs.watch` does not — give it `debounceMs`.
- **Stop producing when nobody listens.** A broadcast to a closed panel still crosses to the renderer. Gate a worker ticker on `host.hasListeners?.(channel)` or `host.onDidChangeListeners?.(channel, cb)`, for state a view re-pulls on mount.
- **Batch file reads in the worker.** `host.fs.walk(root, { include, exclude })` lists a tree in one call and `host.fs.readFiles(paths)` reads up to 1,024 files in another; a search built from one `readdir` and one `readFile` per entry took 960 ms where the ported one took 335 ms. A file tree wants `readdir(dir, { detail: true })` for sizes, times and Daintree's own numeric-aware order. [Patterns → Build a file UI](./patterns.md#build-a-file-ui).
- **Activate lazily.** Leave `activationEvents` empty unless the plugin must run with no panel open (rule 6). An `onStartupFinished` worker starts at boot and is exempt from idle disposal, so a dashboard that activates eagerly holds 70–90 MB for the whole session, panel open or not, to save the one activation its first open would cost.
- **`useNow` for clocks, `useAnimationFrame` for canvas.** A `setInterval` per "5m ago" or a bare `requestAnimationFrame` loop keeps running in a project the user switched away from, because the DOM cannot see the switch; both hooks pause while nobody can see the view. A canvas reads colours from `useDaintreeTheme()`, not once from `getComputedStyle`, or it keeps the old theme's colours after a switch. [Patterns → Draw on a canvas](./patterns.md#draw-on-a-canvas).
- **Know the limits.** A push is at most 1 MiB, an `invoke`'s arguments 4 MiB and its result 16 MiB (`PLUGIN_PAYLOAD_TOO_LARGE:` past them). A handler has five minutes by default; `registerHandler(channel, handler, { timeoutMs })` changes it, `0` for none.

## Building an app over data agents use

Most project plugins are a view over data that agents create — "track this expense", "add this lead", "log a 5k run". [building-apps.md](./building-apps.md) is the full walkthrough; these are the decisions that go wrong without it.

- **Give agents tools, not just a file.** Agents reach the data three ways: reads through the host's `database_schema` and `database_query`, which declaring a database in `contributes.databases` adds to the plugin's MCP server with no code; writes that have rules through the plugin's own tools, a `contributes.agentMcp` endpoint (`mcp:expose`) registered with `host.mcp.registerTools`; and `sqlite3` or file edits under the plugin's `AGENTS.md` as the fallback every agent has for data in the project (a `local` database has none). Build all three. Name the server with a short top-level `mcpName` (`"ledger"` → `daintree-ledger`, at most 16 characters), and commit `.daintree/mcp.json` — `{ "plugins": { "<manifest id>": "read-write" } }` — so agents in a fresh clone get the tools once the user trusts the project's plugins. The tools reach only agents launched from a Daintree terminal after the plugin has access, and a reload that changes what the plugin declares for agents revokes them, so an agent started earlier has to be relaunched. See [Agent extensions → Agent MCP endpoints](./agent-extensions.md#agent-mcp-endpoints).

- **Write the data contract down.** The plugin's own `AGENTS.md` holds the paths, the schema, the invariants and one worked example whose values are _not_ your test prompts, and the project's root `AGENTS.md` / `CLAUDE.md` points to it. The agent knows only what those files and the plugin's tool descriptions say, so the contract names the tools as the preferred route and gives the `sqlite3` or file recipe as the fallback. Settings, `plugin-settings/` and `mcp.json` are not part of the contract; a database or data folder under `.daintree/` is, by its path. See [Patterns → Write the data contract down](./patterns.md#write-the-data-contract-down).
- **Files, when each record is a document** a person might read or diff — contacts, posts, a board. Edit them with `editFile` from `@daintreehq/plugin-sdk/data` (or `readFileWithRevision` plus `writeFile(path, text, { expectedRevision })`), never a blind `writeFile`, so a panel edit cannot clobber an agent's. See [Patterns → Edit a file an agent also edits](./patterns.md#edit-a-file-an-agent-also-edits).
- **SQLite, when you need queries, totals or history** — a ledger, stock movements, time entries. Declare it in `contributes.databases` and open it with `host.db`, never with `node:sqlite` directly: the host resolves and contains the path, asks consent before creating a project database, reopens a file `git checkout` replaced, and fires `onDidChange` when an agent writes with the `sqlite3` CLI. Open it lazily, not in `activate()`, because the first open can wait on a consent prompt. Put the rules in the schema — `CHECK` constraints and triggers with `RAISE(ABORT, '<what to do instead>')`, whose message must be a string literal — because the CLI does not enforce foreign keys. See [Patterns → Keep structured data in SQLite](./patterns.md#keep-structured-data-in-sqlite).
- **Refresh live.** Watch the data _directory_, not a file — agents write by rename and create new files, and only a directory watch sees either — with `host.fs.watch(paths, cb, { allowMissing: true, debounceMs: 200 })`: `allowMissing` accepts a folder an agent has not created yet and survives it being deleted and recreated, and `debounceMs` collapses a burst into one refresh. In the view, subscribe then pull; push only what changed (`createSyncedCollection`) or an invalidation the view refetches on once per burst (`useCachedHostChannel`'s `invalidateOn`). See [Patterns → Watch a folder, refresh, badge the tab](./patterns.md#watch-a-folder-refresh-badge-the-tab).
- **Worktrees split committed data.** Your plugin reads the project's main checkout (`host.pluginInfo.projectRoot`); an agent in a linked worktree edits that worktree's own copy of every committed file, and the panel never sees it. If agents should always write the live data, say so in `AGENTS.md` and give them the path from the main checkout's root, which every worktree can find: `"$(git rev-parse --path-format=absolute --git-common-dir)/.."`.
- **Give agents your arithmetic.** When an answer depends on a calculation — a streak, a monthly total, "due this week" — ship a script (`scripts/<name>-report.mjs`) that imports the same pure module the panel uses, and name it in `AGENTS.md`. Agents reading raw data eyeball those numbers and get them wrong.
- **Hand records to agents as drafts.** Make cards draggable with the `application/x-daintree-agent-context` payload, and offer "Send to agent…" through `host.sendToAgent` (`agent:input`). Both land in the agent's draft and never submit, and `drafted` only means the text is there — nothing tells you when the user sends it. See [Patterns → Hand work to an agent](./patterns.md#hand-work-to-an-agent).
- **Use the host's pieces.** App-shaped panel icons (`wallet`, `kanban`, `users`, `calendar`, `database`, … — the list is in [Contribution points → Panels](./contribution-points.md#panels--shipped)); the [UI kit](#draw-with-the-kit) for every control, list, table, dialog and state inside the view, including `Markdown` for rich text; `host.documents.renderPdf` for invoices and reports ([Patterns → Export a document](./patterns.md#export-a-document)); and the **Back up data…** entry every panel of a plugin with declared databases already has ([Patterns → Back up and export data](./patterns.md#back-up-and-export-data)).

## Styling: Tailwind on Daintree's tokens

For everything the kit doesn't draw — layout, spacing, the markup around kit components, bespoke UI — write Tailwind utility classes. They work in a hand-written `dist/panel.js` exactly as in a bundled view, with no build step and no configuration — Daintree compiles the classes your view uses at runtime, against the host's own Tailwind and theme.

Two things follow from that, and they are the whole contract:

- **You get Daintree's vocabulary, not Tailwind's stock one.** `bg-surface-panel` compiles. `bg-red-500` compiles to _nothing_ — the host's theme deletes the stock palette on purpose, so plugin panels cannot drift out of the design system. If a colour class appears to do nothing, that is why.
- **Generated rules are scoped to your view** and can never restyle host chrome.

Everything ordinary works as Tailwind documents it: layout, spacing, sizing, typography, flexbox, grid, `hover:` / `focus-visible:` / `disabled:` / `group-hover:`, arbitrary values (`w-[327px]`), dynamic scales (`grid-cols-47`), container queries.

**Not available:** stock palette colours; `dark:` (Daintree themes are runtime tokens, not a class — a semantic token is already theme-aware); `prose`; `@apply`.

Prefer container queries (`@container`, `@sm:`) over viewport breakpoints — your panel is one pane in a grid and can be narrow while the window is wide. The container must be an **ancestor**: `@md:` never answers to the element that declares `@container`, so `@container @md:grid-cols-4` on one element never applies. Put `@container` on a wrapper.

### The vocabulary

<!-- BEGIN generated: plugin-style-vocabulary -->

**Surfaces** — shown with `bg-`; `border-` and `text-` take the same names

`bg-surface-canvas` `bg-surface-sidebar` `bg-surface-toolbar` `bg-surface-panel` `bg-surface-panel-elevated` `bg-surface-dialog` `bg-surface-grid` `bg-surface-input` `bg-surface-inset` `bg-surface-hover` `bg-surface-active` `bg-surface-disabled` `bg-surface-highlight`

**Text**

`text-text-primary` `text-text-secondary` `text-text-muted` `text-text-placeholder` `text-text-inverse` `text-text-link`

**Borders** — shown with `border-`; `divide-` and `ring-` take the same names

`border-border-default` `border-border-subtle` `border-border-strong` `border-border-divider` `border-border-interactive` `border-border-input`

**Status** — shown with `bg-`; `text-` and `border-` take the same names

`bg-status-success` `bg-status-warning` `bg-status-danger` `bg-status-info` `bg-status-danger-surface` `bg-status-success-surface` `bg-status-warning-surface` `bg-status-info-surface` `bg-status-error` `bg-status-error-surface`

**Accent** — shown with `bg-`; `text-` and `border-` take the same names

`bg-accent-primary` `bg-accent-hover` `bg-accent-foreground` `bg-accent-primary-foreground` `bg-accent-soft` `bg-accent-muted` `bg-accent-secondary` `bg-accent-secondary-soft` `bg-accent-secondary-muted`

**Radii**

`rounded-xs` `rounded-sm` `rounded-md` `rounded-lg` `rounded-xl` `rounded-2xl` `rounded-3xl` `rounded-4xl`

**Type scale below Tailwind's floor**

`text-2xs` `text-3xs` `text-4xs`

**Durations**

`duration-75` `duration-100` `duration-120` `duration-150` `duration-200` `duration-250` `duration-300`

**Easings**

`ease-snappy` `ease-spring-critical` `ease-out-expo` `ease-exit` `ease-panel-minimize`

**Category hues** — `bg-`, `text-` or `border-`, then `category-<hue>` and a variant suffix: `bg-category-blue-subtle`, `text-category-teal-text`

hues: `blue` `purple` `cyan` `green` `amber` `orange` `teal` `indigo` `rose` `pink` `violet` `slate`

variants: `(bare)` `-subtle` `-text` `-border`

**Custom variants** — write as `variant:utility`

`reduce-motion:` `motion-reduce:` `motion-safe:`

<!-- END generated: plugin-style-vocabulary -->

Every other non-colour utility Tailwind ships works too.

```jsx
// Panel root — `min-h-0` is what lets an inner scroller own the overflow.
<div className="flex flex-col flex-1 min-h-0 bg-surface-panel text-text-primary">
// A bespoke row the kit's ListRow doesn't fit
<div className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover">
```

Buttons, badges, inputs and spinners are kit components (`Button`, `Badge`, `Input`, `Spinner`), not class recipes.

**Conditional classes must be complete strings.** `active ? "bg-surface-active" : ""` works; `` `bg-surface-${tone}` `` does not, because a name assembled from fragments never appears in your source or the DOM as a whole class.

**Portals need a marked container.** Kit overlays (`Dialog`, `Popover`, `DropdownMenu`, `Tooltip`) handle this themselves. A `createPortal` of your own leaves your style root, so spread `styleRootAttributes` from `PanelViewProps` onto the container: `createPortal(<div {...styleRootAttributes} className="p-4">…</div>, document.body)`.

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
5. Run **Dashboard: Open Dashboard** from the palette, or open the panel from the panel palette. Either one activates the plugin — the manifest's `contributes.commands` entry is what makes the command reachable before `activate()` has ever run.

Then check the trap that produces the most convincing false success — it works on the machine that built it whether or not `dist/` is tracked. Prove both halves, because neither implies the other:

```bash
git check-ignore --no-index .daintree/plugins/acme.dashboard/dist/index.mjs    # expect: no output, exit 1
git ls-files --error-unmatch .daintree/plugins/acme.dashboard/dist/index.mjs   # expect: the path
```

Leave `-v` off the first one: it also prints a matching _negation_, so a correctly rescued file shows `!dist/**` and exits 0. `npx daintree-plugin doctor .` runs both checks, plus the manifest and ESM parse, for every plugin in the project.

## Before you ship

1. **`npx daintree-plugin lint`** in the plugin folder (`doctor` runs it too). It reads the view and worker source and flags what the rules above describe: interval polling in a view, a growing list re-pushed whole, state set on every event of a high-frequency channel, a subscription never disposed, a bundled copy of React; stock palette colours, `dark:`, raw shadows, radii and text sizes, a hand-rolled button, form control, spinner, badge or icon, a native dialog, a container query on its own container, and classes that compile to nothing. Each finding names the fix. Errors fail the command; `--strict` fails on warnings too.
2. **Open the panel with real data**, at the size the user will have — ten thousand rows, not ten.
3. **Read the measurements.** The plugin's **Performance** section in Project settings → Plugins shows its activation, view load and first paint, invoke latency, push rate and worker memory, each against its budget. (For an installed plugin, `daintree-plugin dev` prints the same table every two seconds while it watches.) They are observations, not a verdict, and Daintree never slows or stops a plugin for going over one — but a view over its first-paint budget or a channel over 60 pushes a second is where to look. See [views.md → Measuring your plugin](./views.md#measuring-your-plugin).

## When a button does nothing

The plugin loaded, the panel renders, a command or a button does nothing, or the wrong thing. In order of likelihood:

1. **The handler read `ctx` as its payload** (rule 10). Log the first parameter: if it has `projectId` and `webContentsId`, that is the context, not your args.
2. **`dist/` is stale.** The host runs what is on disk. Check the file's mtime against your edit; if you build, check the watcher is running.
3. **The action's dispatch failed and nothing checked.** `host.dispatch` resolves `{ ok: false, error }` rather than throwing (rule 14); an Open command that opens nothing usually built its panel kind by hand instead of calling `host.panelKindId`.
4. **The `actionId` in the manifest is wrong.** It is `{manifestId}.{commandId}`, and the host rewrites it to the instance namespace. `{commandId}` alone or the instance key by hand both resolve to nothing.
5. **The action threw.** A thrown error from a command surfaces as a toast; a thrown render error shows the panel's diagnostics pane, whose "Copy diagnostics" carries the stack. `host.logger` lines are in the plugin manager's detail pane for the plugin.
6. **A capability is missing, or its consent was not given.** `host.fs`, `host.git`, `host.process`, `host.db`, `host.documents`, `sendToActiveAgent`, `sendToAgent` and `agents.list` reject with a `PERMISSION_REQUIRED:` prefix when the manifest does not declare the token. The write-class calls, `process.spawn`, `sendToActiveAgent` and `sendToAgent` also wait on a consent dialog on first use, which is easy to miss behind a terminal — a panel that never fills is often a `host.db` open waiting on one. A refused, timed-out or once-only answer is asked again on the next call (rule 15).
7. **The watch never fired.** Without `allowMissing: true`, watching a folder that does not exist yet rejects, and a watched folder that is deleted and recreated stops reporting. A watch on a single file misses the rename an agent's editor writes with; watch its directory.

Edits to `plugin.json` or `dist/` reload the plugin live, per plugin directory, about 200 ms after writes stop. Settings and `host.storage` survive a reload; module-scope state in the worker and React state in the views do not. Daintree never needs a restart — anything that genuinely needed one is not offered to project plugins. Agents are the exception: a CLI takes its MCP servers at launch, so an agent started before the plugin loaded, or before its agent access was given, has to be relaunched to see the plugin's tools. A reload keeps running agents' tools unless it changes what the plugin declares for agents — its capabilities, scopes, `agentMcp` endpoint, databases or `mcpName` — which revokes them and needs a relaunch too. If they are still missing, work through [Agent extensions → Tools don't show up in `/mcp`](./agent-extensions.md#tools-dont-show-up-in-mcp).

## See also

- [project-local.md](./project-local.md) — the full contract this brief compresses
- [patterns.md](./patterns.md) — the working patterns, each with the exact host calls
- [views.md](./views.md) — what a view gets in the DOM and how to style it
- [agent-extensions.md](./agent-extensions.md#agent-mcp-endpoints) — the plugin's MCP server, its access setting and troubleshooting
- [README.md](./README.md) — the plugin documentation index
- `plugins/fixtures/project-local/` — a discovery/schema/watcher fixture at the real path, not the skeleton above: it registers no action and its view returns a plain object rather than React
- `plugins/sample/rich-daintree/` — a fuller plugin exercising most contribution points
