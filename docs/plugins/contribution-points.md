# Contribution Points

A contribution point is a slot in Daintree that a plugin can fill. Contributions are declared in the `contributes` field of `plugin.json`. Daintree reads the manifest eagerly at startup — contributions show up in the command palette and UI before any plugin code runs.

Each section below documents a contribution point, its schema, an example, and current implementation status.

## Status legend

- **Shipped** — available in the current Daintree release
- **Planned** — design locked, implementation in progress
- **Future** — not yet committed

## Commands — _Shipped_

Commands are callable actions that appear in the command palette and can be bound to keybindings, toolbar buttons, or menu items. Declare them in `plugin.json` so the command shows up in the palette before your plugin activates, or register them at runtime via `host.registerAction()` for dynamic cases. See [Host API → registerAction](./host-api.md#registeraction) for the full signature.

```json
{
  "contributes": {
    "commands": [
      {
        "id": "plan-from-issue",
        "title": "Plan From Issue",
        "description": "Turn a Linear issue into a branch and agent session.",
        "category": "Linear Planner",
        "kind": "command",
        "danger": "confirm"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Bare command id. Daintree namespaces it as `{pluginId}.{id}` at runtime — matching every other contribution surface. |
| `title` | yes | Palette entry label. |
| `description` | yes | One-line summary surfaced in the palette description. |
| `category` | yes | Grouping label in the palette. Free-form; mirror your plugin's display name. |
| `kind` | yes | `"command"` or `"query"`. |
| `danger` | yes | `"safe"` or `"confirm"`. `"restricted"` is rejected — plugins cannot self-register restricted actions. The host raises `"safe"` to `"confirm"` automatically when the plugin holds a high-risk capability. |
| `keywords` | no | Extra search terms for the palette. |
| `inputSchema` | no | JSON schema validated against the dispatched `args` payload. |
| `requires` | no | The capabilities _this command_ actually uses — see below. |

**`requires` — per-action capability intent:**

By default the host derives a command's `effectiveDanger` from your plugin's _entire_ `capabilities` list, so declaring `shell:exec` for one command puts a destructive confirmation on all of them — including a no-argument "open the panel" command. Dropping the capability isn't an honest fix; `requires` is:

```json
{
  "id": "open-panel",
  "title": "Open Panel",
  "description": "Opens the tools panel.",
  "category": "Flutter Tools",
  "kind": "command",
  "danger": "safe",
  "requires": []
}
```

- **Omit `requires`** and nothing changes — the whole manifest is consulted, as before. Existing plugins need no migration.
- **`"requires": []`** declares the command exercises no capability, so it stays one click even in a plugin holding `shell:exec`.
- **`"requires": ["git:read"]`** consults only those capabilities, for both the high-risk set and the compound-capability lattice.

Three things it does _not_ do. It grants no access: host APIs still gate on `manifest.capabilities` at call time, so listing a capability here neither adds nor removes runtime authority. It cannot lower a self-declared `"danger": "confirm"`. And every entry must appear in your `capabilities` — naming one you didn't declare fails the command's registration outright rather than falling back, so an author's typo surfaces at load instead of quietly reverting to the old behaviour.

**Handler binding — two ways:**

_Filesystem convention (manifest-declared, lazy import):_ a command with id `plan-from-issue` looks for `src/plan-from-issue.{js,mjs}` (probed in that order) under your plugin directory. Its default export is the handler. The module is **not** imported until the command is first dispatched — twenty manifest commands cost zero activation time. The handler must be shipped as JavaScript: `.ts`/`.tsx` files are not probed (a `.ts` handler appears to work under Node's type-stripping but throws at first dispatch on any non-erasable syntax, and `.tsx` never runs) — author in TypeScript and compile to `src/{id}.js`, or register the command imperatively.

```js
// src/plan-from-issue.js
export default async function planFromIssue(args) {
  // handler body
}
```

> **Lazy handlers receive `args` only — no `host`.** A filesystem-convention handler's single parameter is the dispatched `args` payload. There is no second `host` argument, so a lazy handler **cannot** call `host.showQuickPick`, `host.sendToActiveAgent`, `host.settings.get`, or any other host API. This is structural, not an oversight: the host is scoped to `activate()` and is revoked once activation returns, long before a command is first dispatched, so there is no live host to hand a lazily-imported handler. **If your command needs host APIs, register it imperatively in `activate()`** (next section) — that handler closes over the live `host`. An imperative `registerAction` for the same id supersedes the lazy file, so you can start with a manifest-declared stub and graduate to `registerAction` the moment you need host access.

_Imperative registration (escape hatch for dynamic commands — and the only way to reach host APIs from a command handler):_

> `@daintreehq/plugin-sdk` is the forward-looking published name for the SDK types/runtime (reserved in `shared/types/plugin-sdk.ts`, scaffolded as a dependency by the `daintree-plugin` CLI). It's distinct from the in-repo `daintree-plugin` CLI package — don't conflate the two.

```ts
// src/index.ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi) {
  host.registerAction(
    {
      id: "plan-from-issue",
      title: "Plan From Issue",
      description: "Turn a Linear issue into a branch and agent session.",
      category: "Linear Planner",
      kind: "command",
      danger: "confirm",
    },
    async (args) => {
      // handler body
    }
  );
}
```

If a manifest-declared command has no matching `src/{id}.{ext}` file and no imperative `registerAction` override, running it produces a user-visible toast: `Command "{pluginId}.{id}" has no handler`. The manifest entry alone is enough to make the command appear in the palette so authors can wire it up incrementally.

**Collision rule:** a command whose resolved `{pluginId}.{id}` matches a built-in Daintree action id is rejected at load with a provenance `loadError` — the command does not register. Pick a different id.

**Duplicate ids within an array** are rejected at manifest validation (`duplicate_contribution_id`). The bare `id` is the registry key for every contribution array — `panels`, `toolbarButtons`, `commands`, `views`, `mcpServers`, `forgeProviders`, `fileDecorationProviders`, `agents`, and `settings` — so two entries with the same id in the same array would silently first-win at load. The check is per-array: ids in different arrays are namespaced independently and never collide.

## Panels — _Shipped_

Panels are full-sized workspaces in Daintree's grid (alongside terminal panels, browser panels, etc.). A plugin panel is a React component the user can open, tile, and close like any other panel.

```json
{
  "contributes": {
    "panels": [
      {
        "id": "dashboard",
        "name": "Cost Dashboard",
        "iconId": "gauge",
        "color": "hsl(150 60% 55%)",
        "hasPty": false,
        "canRestart": false,
        "canConvert": false,
        "showInPalette": true
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. |
| `name` | yes | Display label in the panel header and palette. |
| `iconId` | yes | One of the shared plugin icon IDs listed in `shared/config/pluginIconIds.ts`. An unrecognized ID falls back to the generic terminal glyph on panel surfaces; `daintree-plugin validate` warns about it. |
| `color` | yes | HSL string used for the panel tab accent. |
| `hasPty` | no | `false` (default) for UI-only panels. `true` is reserved for PTY-backed panels, not available to plugins in v1. |
| `canRestart` | no | Show a "restart" control in the panel header. |
| `canConvert` | no | Allow conversion between compatible panel kinds. Rarely useful for plugins. |
| `showInPalette` | no | Include in the "New Panel…" palette. Default `true`. |

**Icon IDs** — one shared set backs every surface that renders a plugin icon (the panel palette, panel headers, tabs, the dock, toolbar buttons, and the toolbar overflow menu), so an ID looks the same everywhere it appears:

`terminal`, `package`, `puzzle`, `globe`, `monitor`, `monitor-play`, `file-text`, `file-diff`, `folder-tree`, `git-branch`, `git-pull-request`, `sticky-note`, `gauge`, `list`, `sparkles`, `layout-panel-top`, `daintree`

`shared/config/pluginIconIds.ts` is authoritative — run `daintree-plugin validate` to check a manifest against the set your installed host actually ships. Panel `iconId` also accepts a built-in agent ID (e.g. `claude`) to render that agent's brand mark.

**Component registration** is covered by the **views** contribution point below — panels declare the slot, views provide the component.

## Views — _Shipped (panel surface)_

Views are the React components that render inside a panel. A view binds to a panel slot declared in `contributes.panels` by matching its bare `id`; at plugin load the matching panel kind gains a `componentPath` resolved to a `plugin://` URL. The renderer host (`PluginViewHost`) lazy-imports the module over Daintree's `plugin://` protocol and mounts it under an `ErrorBoundary` + `Suspense`. `location: "panel"` is the only supported value; `"sidebar"` is rejected at manifest validation because the sidebar host does not exist yet. The contribution key is `views` (it was `experimental_views` before the 1.0 freeze — the old key is still accepted as a deprecated alias that logs a warning; the shape below is the frozen contract).

```json
{
  "contributes": {
    "panels": [
      { "id": "dashboard", "name": "Cost Dashboard", "iconId": "gauge", "color": "#5b8def" }
    ],
    "views": [
      {
        "id": "dashboard",
        "componentPath": "./dist/dashboard.js",
        "location": "panel"
      }
    ]
  }
}
```

**Pairing with `contributes.panels`** — a view binds to a panel by matching its bare `id` (pre-namespace) to a panel `id`. A view whose `id` matches no panel is rejected at manifest validation (`view_panel_ref_unknown`) — it would otherwise never render, so it's a hard load error rather than a silent runtime skip. A view targeting a panel with `hasPty: true` is skipped — PTY panels render through `TerminalPane` and cannot host a plugin module.

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Matches the panel `id` it provides a component for. Namespaced at runtime as `{pluginId}.{id}`. |
| `componentPath` | yes | POSIX-relative path to an ESM module inside the plugin. The module's default export is a React component. Absolute paths, URL schemes, and `..` segments are rejected at manifest validation. |
| `location` | yes | `"panel"` (docked in the grid). `"sidebar"` is rejected at manifest validation — the sidebar host does not exist yet. |
| `iconId` | no | Accepted for compatibility but **ignored at runtime** — the matching `contributes.panels` entry owns the rendered icon. Set it there instead. |

The view schema is strict and carries no `name` or `description`: the matching panel is the single source of truth for a view's display metadata, so those fields were removed (#10888) rather than validate values the runtime ignores.

**Bundling** — plugin views ship as **pre-built ESM modules**. You don't compile TypeScript or JSX at plugin-load time. `@daintreehq/plugin-vite` produces the bundle with the correct externals for React 19 sharing. See [Architecture → Renderer host](./architecture.md#renderer-host) for the internals.

**Component contract:**

> **Mixed availability.** `useHostChannel`, `usePluginEvent`, and `usePluginPanelEvent` (see [Host API → React hooks](./host-api.md#react-hooks)) resolve **only when your view is bundled with `@daintreehq/plugin-vite`** — the preset bundles the SDK into your plugin output, so the hooks ship inside your bundle rather than resolving through the host import map. The import map serves only React specifiers; a **raw, un-bundled `plugin://` view** that bare-imports `@daintreehq/plugin-sdk/react` fails at runtime with an unresolved specifier. For a hand-authored view without the build preset, subscribe through the `window.electron.plugin.on(pluginId, channel, cb)` / `.invoke(pluginId, channel, …args)` bridge directly — the same bridge the hooks wrap (the raw-ESM example follows the bundled one below). `useWorktree` / `useWorktrees` / `useSetting` / `useCommand` are still **Planned (F15/F36)** and resolve to nothing in v1; until they ship, read worktree context and settings through the `host` API passed to `activate()` and push it into the panel via `postToPanel`.

```tsx
// src/dashboard.tsx
import { useEffect, useState } from "react";
import type { PanelViewProps } from "@daintreehq/plugin-sdk";
import { usePluginEvent } from "@daintreehq/plugin-sdk/react";

export default function Dashboard({ panelId, pluginId, disposeSignal }: PanelViewProps) {
  const [worktreeName, setWorktreeName] = useState<string | null>(null);
  // The plugin's main side pushes worktree context with host.postToPanel("worktree", …).
  usePluginEvent<{ name: string }>(pluginId, "worktree", (wt) => setWorktreeName(wt.name));

  useEffect(() => {
    const controller = new AbortController();
    // Chain the host signal so the fetch aborts on unmount AND when the
    // host receives a `plugin:panel-kinds-changed` push that no longer
    // contains this kind — before main tears down plugin IPC handlers.
    const onAbort = (): void => controller.abort();
    disposeSignal.addEventListener("abort", onAbort);
    void fetch(`plugin://${pluginId}/api/cost-summary`, { signal: controller.signal });
    return () => {
      disposeSignal.removeEventListener("abort", onAbort);
      controller.abort();
    };
  }, [pluginId, disposeSignal]);

  return <div data-panel-id={panelId}>Dashboard for {worktreeName ?? "no worktree"}</div>;
}
```

The same view as a **raw ESM module** (loaded verbatim by `plugin://`, no `@daintreehq/plugin-vite` bundling) cannot import `usePluginEvent` — subscribe through the host bridge instead. Because nothing transpiles the file, it ships as valid browser ESM: the bare `react` specifier resolves through the host import map, and `createElement` avoids any JSX transform. `window.electron.plugin.on(pluginId, channel, cb)` returns an unsubscribe function; return it from the effect for cleanup.

```js
// src/dashboard.js — raw ESM variant, served as-is over plugin://
import { createElement, useEffect, useState } from "react";

export default function Dashboard(props) {
  const { panelId, pluginId } = props;
  const [worktreeName, setWorktreeName] = useState(null);
  useEffect(() => {
    // Same payload host.postToPanel("worktree", …) pushes; usePluginEvent wraps this.
    const off = window.electron.plugin.on(pluginId, "worktree", (wt) => setWorktreeName(wt.name));
    return off;
  }, [pluginId]);
  return createElement(
    "div",
    { "data-panel-id": panelId },
    `Dashboard for ${worktreeName ?? "no worktree"}`
  );
}
```

| Prop | Type | Notes |
| --- | --- | --- |
| `panelId` | `string` | Runtime id of this panel instance. Useful as a key for plugin-local panel-scoped state, and the routing key for per-instance pushes: the plugin's main side targets one instance with `host.postToPanel(channel, payload, panelId)` (omit or pass `null` to broadcast to every instance of the kind). To receive only the targeted pushes, subscribe with `usePluginPanelEvent(pluginId, channel, panelId, cb)` (or raw `plugin.onPanel(pluginId, channel, panelId, cb)`) and pass this prop. `usePluginEvent` / `plugin.on` receive broadcast pushes, not per-instance ones. |
| `pluginId` | `string` | The plugin's manifest `name`. Stable for the lifetime of the host — useful for namespacing storage keys and log lines. |
| `disposeSignal` | `AbortSignal` | Lifetime of **this mounted view attempt**. Aborts on unmount, on "Try again", and when the host receives a `plugin:panel-kinds-changed` push that omits this kind. The broadcast fires before main tears down plugin IPC handlers, so signal-driven cleanup runs while host APIs are still live. A **temporary** unmount aborts it too — maximizing a sibling pane, leaving a dock tab, or caching a background project view. Tie only view-scoped work to it. |
| `panelRemovedSignal` | `AbortSignal` | Lifetime of **the panel record**. The same object is handed to every mount of a given `panelId`, so it survives remounts, retries, trash-then-restore, and plugin upgrades. Aborts exactly once, when the panel is permanently removed. |
| `initialArgs` | `Record<string, unknown>` \| `undefined` | The argument bag the panel was spawned with — set when the panel is opened via the `panel.openPluginPanel` action's `initialArgs` (e.g. dispatched from a context menu with a file path). It rides the panel's save/restore-surviving extension state, so a restored panel sees the same args it was spawned with. `undefined` when the panel was opened without args. |

The view is wrapped in an error boundary by the host. An unhandled render error shows a diagnostics pane with "Try again" — which produces a fresh `lazy()` reference so the dynamic import is re-evaluated rather than returning the cached failed promise — alongside "Close panel", "Copy diagnostics", and "View logs".

### Which signal to use

A panel outlives its views. Maximizing a different pane unmounts every other grid panel, so `disposeSignal` fires for a teardown the user experiences as "I'll be right back", identically to one they experience as "I'm done with this". Deciding deletion from `disposeSignal` alone is how a plugin ends up killing a running dev-server session because the user maximized a neighbouring pane.

- **View-scoped work** — in-flight `fetch`es, DOM observers, `postToPanel` subscriptions, timers driving the UI → `disposeSignal`.
- **Panel-scoped work** — anything that should survive being backgrounded but not survive the panel itself → `panelRemovedSignal`.
- **Durable resources** — spawned processes, long-lived sessions, anything expensive to restart → keep them in the **worker** and release them from `host.onDidChangePanelLifecycle` on the `"removed"` phase. The worker observes the panel across every remount; the view cannot, because it is gone during exactly the teardown that matters. See [Host API → `onDidChangePanelLifecycle`](./host-api.md#ondidchangepanellifecycle).

### Worker reload vs. view-module replacement

These are two different reloads, and a plugin author debugging "my change didn't show up" is usually confusing them:

- **Worker reload** replaces the plugin's _backend_ Realm. `activate()` runs again against a fresh module graph, so edits to your main entry take effect on the next reload.
- **View-module replacement** is the _renderer_ half. Chromium caches ESM module records by URL with no eviction API, so re-importing the same `plugin://` specifier returns the module already in memory no matter how thoroughly the panel remounts.

Daintree bridges the gap by stamping a per-load generation into the view URL — `plugin://<id>/__dtv-<n>/dist/view.js`. Every time the plugin is **loaded** — an install, a replacement install, an enable, or an app start — it mints a new `<n>`, which is a specifier the renderer has never imported, so the new bundle is genuinely fetched and evaluated. Open panels remount onto it automatically; no Force Reload, and no need to hand-version your bundle filename each release.

The `daintree-plugin dev` hot-reload path is the exception: it respawns the plugin's **worker** without re-registering contributions, so your backend changes take effect but the generation does not advance and open views keep the module already in memory. Reopen the plugin (disable/enable, or reinstall) — or Force Reload the window — to pick up view changes during a dev session.

Two consequences worth knowing. Relative imports inside your entry module inherit the generation namespace (they resolve against the entry's URL), so multi-chunk bundles refresh as a unit — but an **absolute** `plugin://` import you write by hand does not, and will keep resolving to the first version imported in that session. And because each generation is a distinct module record, a long dev session with many reloads accumulates them in the renderer's memory; that is bounded by how many times you reloaded, and a window reload clears it.

The `__dtv-<n>` segment is virtual — it never exists on disk, and the protocol handler strips it before resolving your file. Treat `__dtv-` as a reserved top-level directory name.

## Toolbar buttons — _Shipped_

Toolbar buttons dispatch an existing action from the main toolbar.

```json
{
  "contributes": {
    "toolbarButtons": [
      {
        "id": "plan-button",
        "label": "Plan",
        "iconId": "list",
        "actionId": "acme.linear-planner.plan-from-issue",
        "priority": 3
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}` — matches the convention used by every other contribution surface. |
| `label` | yes | Hover tooltip. |
| `iconId` | yes | One of the shared plugin icon IDs listed in `shared/config/pluginIconIds.ts` — the same set panels use. An unrecognized ID falls back to a generic package glyph; `daintree-plugin validate` warns about it. Agent brand IDs (e.g. `claude`) don't resolve here. |
| `actionId` | yes | Fully-qualified action ID, including plugin namespace. Built-in actions (e.g. `terminal.new`) also work. |
| `priority` | no | `1`–`5`, lower = earlier in sort order. Default `3`. |

## Menu items — _Shipped_

Menu items add entries to Daintree's application menus.

```json
{
  "contributes": {
    "menuItems": [
      {
        "label": "Plan from Linear…",
        "actionId": "acme.linear-planner.plan-from-issue",
        "location": "view",
        "accelerator": "Cmd+Shift+L"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `label` | yes | Menu entry label. |
| `actionId` | yes | Fully-qualified action ID to dispatch. |
| `location` | yes | One of `"terminal"`, `"file"`, `"view"`, `"help"`. Determines which top-level menu the item appears in. |
| `accelerator` | no | Platform-neutral shortcut, e.g. `"Cmd+Shift+L"` (becomes `Ctrl+Shift+L` on Windows/Linux). |

## Keybindings — _Shipped_

Keybindings map a key combination to an action.

```json
{
  "contributes": {
    "keybindings": [
      {
        "actionId": "acme.linear-planner.plan-from-issue",
        "combo": "Cmd+Shift+P",
        "scope": "global",
        "when": "panel.focused"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `actionId` | yes | Fully-qualified action ID, usually one your plugin declared. |
| `combo` | yes | Normalized key combo string, same format as Daintree's default keybindings. Chords (`"Cmd+K Cmd+S"`) supported. |
| `scope` | no | One of `"global"`, `"terminal"`, `"modal"`, `"worktreeList"`, `"portal"`, `"worktreeGrid"`, `"dev-preview"`. Defaults to `"global"`. An unknown scope is rejected at the manifest gate. |
| `description` | no | Human-readable description of what the binding does. |
| `when` | no | Context expression gating when the binding is active. |

Bindings register when the plugin loads and unregister on unload. Conflicts with user overrides or other plugins' bindings are resolved by Daintree's existing keybinding service — plugin bindings are low-priority and yield to user overrides. See `registerBinding` in `src/services/KeybindingService.ts` for the registration API.

## Settings schema — _Shipped_

Declares user-configurable settings for your plugin.

```json
{
  "contributes": {
    "settings": [
      {
        "id": "linear.apiToken",
        "type": "secret",
        "scope": "user",
        "label": "Linear API Token",
        "description": "Personal API token from linear.app/settings/api"
      },
      {
        "id": "linear.defaultTeam",
        "type": "string",
        "scope": "project",
        "label": "Default team",
        "description": "Team slug to use when opening a new planning session",
        "default": ""
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Setting key, used to read/write the value via the host API. |
| `type` | no | One of `string`, `number`, `boolean`, `enum`, `json`, `secret`, `path`, `directory`, `file`. Defaults to `string`. |
| `label` | no | Field label shown in the generated form. |
| `description` | no | Help text shown beneath the field. |
| `default` | no | Default value. |
| `scope` | no | `user` (global) or `project` (per-project). Defaults to `user`. |
| `options` | no | Non-empty string array; required when `type` is `enum`. |
| `min` / `max` | no | Numeric bounds for `number` settings. `min` cannot exceed `max`. |
| `mustExist` | no | For `path` / `directory` / `file`: when `true`, the form flags a stored path that no longer resolves on disk. Advisory — it never blocks saving. |
| `extensions` | no | For `file` only: restrict the native chooser to these extensions (no leading dot, e.g. `["json", "md"]`). Rejected on any other type. |
| `secret` | no | Legacy boolean; `secret: true` normalizes to `type: "secret"`. Prefer `type: "secret"`. |

The `path` and `directory` types render a read-only text input plus a **Browse** button that opens a native folder chooser; `file` opens a single-file chooser narrowed by `extensions`. The stored value is an absolute filesystem path. Plugins read it back through the host settings API like any other setting.

**Scopes:** `user` (global, persisted in Daintree config), `project` (per-project, persisted with project state).

Settings appear in Preferences → Plugins → `{pluginId}` as a generated form. Values are read via the host API:

```ts
const token = await host.settings.get<string>("linear.apiToken");
```

Changes fire a subscription callback, so you don't need to reactivate to pick them up.

## Context menus — _Shipped_

Adds entries to right-click menus on specific UI elements.

```json
{
  "contributes": {
    "contextMenus": [
      {
        "actionId": "acme.linear-planner.link-issue",
        "location": "worktree",
        "label": "Link to Linear issue…",
        "when": "worktree.hasBranch"
      }
    ]
  }
}
```

**Locations:** `worktree`, `terminal`, `file`. More may be added. The `file` location is mounted on the Review Hub's changed-file rows: a contributed `file` item appears in the right-click menu of a changed file, and its action is dispatched with `{ path, worktreePath, status }` for the clicked file (so your handler receives the file, not `undefined`). A changed-file list with no plugin-contributed `file` items keeps its plain rows — the context menu only wraps a row when a plugin contributes to that location.

Context menus follow the same `actionId` dispatch pattern as menu items, but a `file`-location item additionally receives the clicked file's context as dispatch args. Two built-in actions pair well here: `file.openDiff` opens the side-by-side diff for the dispatched `{ path, worktreePath, status }`, and `panel.openPluginPanel` spawns (or focuses) one of your plugin panels, passing `initialArgs` straight through to the view's `initialArgs` prop — so a context-menu item can open your panel scoped to the file the user clicked.

## MCP servers — _Shipped_

Declares Model Context Protocol servers the plugin ships. The manifest key is `mcpServers` (it was `experimental_mcpServers` before the 1.0 freeze — the old key is still accepted as a deprecated alias that logs a warning). The runtime is live: `PluginMcpSupervisor` (`electron/services/PluginMcpSupervisor.ts`) spawns and supervises the stdio subprocess, and IPC handlers in `electron/ipc/handlers/pluginMcp.ts` wire start/restart/listTools/getFullSchema. See [Agent extensions → MCP servers](./agent-extensions.md#mcp-servers) for the full story.

```json
{
  "contributes": {
    "mcpServers": [
      {
        "id": "linear",
        "name": "Linear MCP",
        "command": "node",
        "args": ["./dist/mcp/linear-server.js"],
        "env": { "LINEAR_API_KEY": "${settings:linear.apiToken}" }
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. |
| `name` | yes | Display name. |
| `command` | yes | Executable — `node`, `python`, `npx`, or an absolute path. |
| `args` | no | Argv after the command. |
| `env` | no | Environment variables. Values can reference settings with `${settings:settingId}` syntax — the id must name a declared `contributes.settings[].id`, else the manifest is rejected at parse time (`settings_token_unknown`; a malformed token shape is `settings_token_malformed`). The same validation applies to `${settings:*}` tokens in `command` and `args`. |

Daintree supervises the process: lazy spawn on first tool use, hard kill on Daintree exit, and on an unexpected crash it transitions the server to `crashed` and rejects pending and subsequent tool calls until an explicit manual restart — there is no automatic retry or backoff. The plugin's tools are exposed to any agent running in Daintree through the same MCP surface user-configured MCP servers use.

**Secret rotation auto-restart:** when a **user-scope** setting changes, every currently running server (status `ready` or `crashed`) that references it via `${settings:settingId}` in its `command`, `args`, or `env` is automatically restarted so the new value is folded in at the next spawn. The restart is debounced ~1s, so a burst of edits coalesces into one respawn. Servers that were never lazily started stay stopped — a settings change never eagerly boots a server.

Tool use is gated by a consent/permission/audit subsystem (`electron/services/plugin-mcp/` — `PluginMcpConsentService`, `PluginMcpTierAuth`, `PluginMcpAuditService`, `PluginMcpConsentStore`): inbound tool calls are checked against per-server permission tiers, prompt for consent when required, and are recorded to an audit log. Discovery is lazy and two-tier — a cheap tool list first, full schemas fetched on demand.

**Intentionally excluded:** remote MCP transports (`url`), explicit transport types, per-server working directories, restart policies. These are deferred until use cases concretely require them.

## Skills — _Shipped_

Markdown-defined instruction/knowledge snippets that extend Daintree's built-in MCP server. Agents running in Daintree discover and load them through the `skills.search` / `skills.load` tools on Daintree's MCP connection.

```json
{
  "contributes": {
    "skills": [
      {
        "id": "tdd-workflow",
        "name": "TDD Workflow",
        "path": "./skills/tdd-workflow.md",
        "triggers": ["test-driven", "tdd", "red-green-refactor"]
      }
    ]
  }
}
```

**Fields:**

| Field      | Required | Notes                                               |
| ---------- | -------- | --------------------------------------------------- |
| `id`       | yes      | Namespaced as `{pluginId}.{id}`.                    |
| `name`     | yes      | Human label.                                        |
| `path`     | yes      | Markdown file relative to the plugin directory.     |
| `triggers` | no       | Search terms the agent uses to discover this skill. |

The markdown file content is returned to the agent when it calls `skills.load`, so it can be incorporated into the current task. See [Agent extensions → Skills](./agent-extensions.md#skills) for the full file format and invocation mechanics.

## Themes — _Future_

Ships palette-based themes, following the same `BuiltInThemeSource` shape used by Daintree's built-in themes. See [Theme system](../themes/theme-system.md) for the palette and token model.

```json
{
  "contributes": {
    "themes": [
      {
        "id": "midnight",
        "name": "Midnight",
        "type": "dark",
        "path": "./themes/midnight.json"
      }
    ]
  }
}
```

Theme contribution requires a theme registry surface that doesn't exist yet. Daintree's themes stay free and open-contribution; there is no planned monetization around color schemes.

## Forge providers — _Shipped_

Registers a forge backend — issues, pull/merge requests, reviews, CI roll-up, releases, and auth for a developer platform that sits on top of git. The first-party GitHub plugin (`plugins/builtin/github/`) is a forge provider.

```json
{
  "contributes": {
    "forgeProviders": [
      {
        "id": "gitea",
        "name": "Gitea",
        "matches": ["gitea.io", "gitea.example.com"],
        "capabilities": ["issues", "pulls", "required-checks"]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}` (the built-in GitHub plugin uses bare `github`). Must match the `descriptor.id` passed to `registerForgeProvider`. |
| `name` | yes | Display label in Preferences → Forge Integrations. |
| `matches` | yes | List of exact hostnames. The host extracts the hostname from the project's git remote (HTTPS/SSH/SCP-form URLs handled), lowercases and trims it, then matches for **exact string equality** — no glob, wildcard, or suffix matching. List every distinct hostname your forge serves as a separate entry. First matching provider wins. |
| `capabilities` | no | Informational hints driving the Preferences "supports: …" display only; the host does not interpret them. Behavior gates on whether the runtime capability field is present. |
| `credentialFields` | no | Array of `{ id, label, type, placeholder?, helpText? }` declaring the auth fields this provider needs. Drives the generated credential form in Preferences → Forge Integrations. |
| `settingsScopeRef` | no | A declared `contributes.settings[].id`, used to group provider settings. Validated at manifest parse time — a dangling ref is rejected (`forge_settings_scope_ref_unknown`). |
| `viewRefs` | no | IDs of `views` contributions shown under this provider's panel section. Each must resolve to a declared `contributes.views[].id`, else the manifest is rejected (`forge_view_ref_unknown`). |

The manifest entry is read eagerly so the provider populates Preferences and the remote-routing table before any plugin code runs; the implementation binds lazily in `activate()` via [`registerForgeProvider`](./host-api.md#registerforgeprovider). For the end-to-end walkthrough — implementing `ForgeProviderImpl`, state normalization, capabilities, and tests — see [Implementing a forge provider](./forge-provider.md).

## File decoration providers — _Shipped_

Registers a provider that decorates files (or other scoped resources) with status badges, colors, and tooltips. The manifest declares which **scopes** the provider handles so the renderer can route decoration pulls before the plugin's code has run. The first-party GitHub plugin (`plugins/builtin/github/`) uses one to decorate the worktree diff/review surface.

```json
{
  "contributes": {
    "fileDecorationProviders": [
      {
        "id": "worktree-diff-review",
        "scopes": ["worktree-diff:*"]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. Must match the `id` passed when the provider binds at runtime. |
| `scopes` | yes | Non-empty list of scope patterns the provider answers for. A scope like `worktree-diff:*` matches every resource the host routes under the `worktree-diff` namespace; the host dispatches decoration pulls to the first provider whose scope matches. |

**Host-routed scopes:**

| Scope | Surface | Notes |
| --- | --- | --- |
| `worktree-diff:<worktreePath>` | Review Hub changed-file rows (base-branch diff, linked PR) | Used by the first-party GitHub plugin to badge PR-review state. |
| `worktree-files:<worktreePath>` | Local worktree file-change list (`FileChangeList` in the worktree card) | Local-only — no PR or remote required. Use this to badge a worktree's changed files from a lint/leak/status plugin. |

Keep these scopes distinct: a provider registered for `worktree-diff:*` is **not** invoked on the local `worktree-files:*` list and vice versa, so PR-review badges don't leak onto the plain change list. The path strings the host passes (and that your provider keys its returned map by) are the worktree's changed-file paths as the surface renders them.

The manifest entry is read eagerly so the host's decoration-routing table (`electron/services/fileDecorationRegistry.ts`) knows which provider owns a scope before any plugin code runs; the implementation binds lazily in `activate()`. See [Host API](./host-api.md) for the runtime registration signature.

When two providers declare the **same exact scope string**, their decorations merge first-writer-wins per field in plugin load order — so the second provider's badge for a shared path can be silently dropped. The host emits a `console.warn` at registration time naming both plugins and the duplicated scope so the collision is detectable. (Broad/narrow coexistence — a `worktree-files:*` provider alongside a `worktree-files:/some/path` one — is intentional and not warned.)

From your `activate()` subscriptions and timers, call `host.invalidateFileDecorations(scope, paths?)` to signal that a scope's decorations changed and any renderer showing them should re-pull.

## Agents — _Shipped (minimal tier)_

Teaches Daintree about a launchable agent CLI it doesn't ship in-tree, so the CLI shows up as a named, selectable agent rather than a generic shell. Requires the `agent:register` capability, which is surfaced to the user at install time.

```json
{
  "capabilities": ["agent:register"],
  "contributes": {
    "agents": [
      {
        "id": "acme",
        "name": "Acme Agent",
        "command": "acme",
        "args": ["--interactive"],
        "color": "#3366ff",
        "iconId": "claude",
        "supportsContextInjection": true
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Bare agent id (alphanumerics, `.`, `-`, `_`; ≤64 chars). Additive for **new** IDs only — a collision with a built-in agent id is rejected at the manifest gate, and built-in entries always shadow plugin entries. Cross-plugin id conflicts resolve first-registered-wins. |
| `name` | yes | Display label for the agent. |
| `command` | yes | CLI binary to launch. Same safe-id pattern as `id` (no shell metacharacters). Supports `${settings:settingId}` — see below. |
| `args` | no | Default launch arguments (≤20 entries; no control characters). Supports `${settings:settingId}` — see below. |
| `color` | yes | Brand color as a 6-digit hex (`#rrggbb`). |
| `iconId` | yes | **A different namespace from panel/toolbar icon IDs** — agents render bundled brand marks, so this must name one of Daintree's built-in agent IDs (`claude`, `codex`, `gemini`, …). A panel icon ID like `terminal` doesn't resolve here; unrecognized values silently fall back to the Claude mark. Shipping a custom icon asset isn't supported yet. |
| `supportsContextInjection` | no | Whether copy-tree context injection targets this agent. Defaults to `false`. |

A plugin agent is launchable and selectable as a named entry in the effective registry. It launches as a named terminal. Without a `detection` block it runs as a plain named terminal whose working/waiting state Daintree doesn't track; declare `detection` (below) to wire it into the agent-state UI like a built-in agent.

`command` and `args` support the same `${settings:settingId}` syntax as MCP servers — e.g. `"args": ["--token", "${settings:apiToken}"]`. Templates resolve at spawn time against the plugin's **user-scope** setting with that ID (project scope is never read). If a referenced setting is unset, the launch fails with a clear error rather than spawning the agent with a literal `${settings:…}` (or a silently blanked value) on its command line — so a missing credential surfaces as a spawn error instead of an opaque auth failure inside the agent. Unlike MCP server tokens, `${settings:*}` tokens in agent `command`/`args` are **not** validated at manifest parse time — an undeclared setting id only surfaces as a spawn-time error, not a load error.

**Output-pattern detection** is supported (#10587). An optional `detection` block on an agent contribution lets the plugin describe its working/waiting/completed states with regex patterns and confidence weights, so the agent joins the same agent-state UI as built-in agents instead of running as an untracked named terminal. The block is `strict` — a typo'd field is a loud manifest error.

| Field | Required | Notes |
| --- | --- | --- |
| `primaryPatterns` | yes | Non-empty array of regex strings (each must compile) that mark the agent as working. A `detection` block with no `primaryPatterns` is rejected. |
| `fallbackPatterns` / `bootCompletePatterns` / `promptPatterns` / `promptHintPatterns` / `completionPatterns` | no | Additional regex arrays for the corresponding detection tiers. |
| `scanLineCount` / `promptScanLineCount` | no | Integer line-window bounds (1–1000) for the matcher. |
| `debounceMs` / `promptFastPathMinQuietMs` | no | Integer millisecond timings (0–600000). |
| `primaryConfidence` / `fallbackConfidence` / `promptConfidence` / `completionConfidence` | no | Confidence weights in `[0, 1]` for a matched tier. |
| `titleStatePatterns` | no | `{ working, waiting }` string arrays (≤50 entries, each ≤256 chars) matched against the terminal title. |

## What's missing and why

A few surfaces I've decided **not** to expose as dedicated contribution points:

- **Agent provider SDKs.** Registering a launchable agent CLI is a contribution point (see [Agents](#agents--shipped-minimal-tier)), but a full model-provider SDK is not. Adding a new model backend is handled via OpenAI-compatible base URL configuration in Daintree's settings — the complexity of a full provider SDK isn't justified when 95% of users just need to point Daintree at a different endpoint.
- **Agent lifecycle hooks (PreToolUse, PostToolUse, Stop).** Use an MCP server instead. A plugin that wants to intercept tool calls ships an MCP server that the agent talks to; the server can refuse or annotate tool calls. This is simpler than a dedicated hook API and reuses the MCP ecosystem.
- **Subagents.** Daintree spawns fresh agents natively. Plugins that want to compose agents use skills + MCP to drive the orchestration, not a dedicated subagent contribution.
- **Status bar items, tree views, editor decorations.** Daintree isn't an editor; these surfaces don't map cleanly to what we render. Revisit if a specific need emerges.

If you think a contribution point is missing, open an issue at [daintreehq/daintree](https://github.com/daintreehq/daintree/issues).
