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

**Handler binding — two ways:**

_Filesystem convention (manifest-declared, lazy import):_ a command with id `plan-from-issue` looks for `src/plan-from-issue.{ts,tsx,js,mjs}` (probed in that order) under your plugin directory. Its default export is the handler. The module is **not** imported until the command is first dispatched — twenty manifest commands cost zero activation time.

```ts
// src/plan-from-issue.ts
export default async function planFromIssue(args: { issue: number }) {
  // handler body
}
```

_Imperative registration (escape hatch for dynamic commands):_

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
| `iconId` | yes | Must match a registered icon ID — see the icon registry in `src/components/icons/`. |
| `color` | yes | HSL string used for the panel tab accent. |
| `hasPty` | no | `false` (default) for UI-only panels. `true` is reserved for PTY-backed panels, not available to plugins in v1. |
| `canRestart` | no | Show a "restart" control in the panel header. |
| `canConvert` | no | Allow conversion between compatible panel kinds. Rarely useful for plugins. |
| `showInPalette` | no | Include in the "New Panel…" palette. Default `true`. |

**Component registration** is covered by the **views** contribution point below — panels declare the slot, views provide the component.

## Views — _Shipped (panel surface; sidebar surface pending)_

Views are the React components that render inside a panel. A view binds to a panel slot declared in `contributes.panels` by matching its bare `id`; at plugin load the matching panel kind gains a `componentPath` resolved to a `plugin://` URL. The renderer host (`PluginViewHost`) lazy-imports the module over Daintree's `plugin://` protocol and mounts it under an `ErrorBoundary` + `Suspense`. `location: "panel"` is wired today; `location: "sidebar"` logs a warning and is skipped until the future sidebar host ships. The contribution key keeps the `experimental_` prefix until the props contract has lived through a release; the shape below is the contract today.

```json
{
  "contributes": {
    "panels": [
      { "id": "dashboard", "name": "Cost Dashboard", "iconId": "gauge", "color": "#5b8def" }
    ],
    "experimental_views": [
      {
        "id": "dashboard",
        "name": "Cost Dashboard",
        "componentPath": "./dist/dashboard.js",
        "location": "panel",
        "iconId": "gauge"
      }
    ]
  }
}
```

**Pairing with `contributes.panels`** — a view binds to a panel by matching its bare `id` (pre-namespace) to a panel `id`. A view with no matching panel logs a warning and is skipped. A view targeting a panel with `hasPty: true` is also skipped — PTY panels render through `TerminalPane` and cannot host a plugin module.

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Matches the panel `id` it provides a component for. Namespaced at runtime as `{pluginId}.{id}`. |
| `name` | yes | Display label, also used in the loading skeleton's accessible label. |
| `componentPath` | yes | POSIX-relative path to an ESM module inside the plugin. The module's default export is a React component. Absolute paths and `..` segments are rejected at load time. |
| `location` | yes | `"panel"` (docked in the grid — wired today) or `"sidebar"` (reserved for a future sidebar host; currently logs a warning and is skipped). |
| `iconId` | no | Override the panel's icon for this view. |
| `description` | no | Surface text for palette/preferences. |

**Bundling** — plugin views ship as **pre-built ESM modules**. You don't compile TypeScript or JSX at plugin-load time. `@daintreehq/plugin-vite` produces the bundle with the correct externals for React 19 sharing. See [Architecture → Renderer host](./architecture.md#renderer-host) for the internals.

**Component contract:**

> **Pseudocode — not yet runnable.** The `useWorktree` import below resolves through `@daintreehq/plugin-sdk/react`, which is **Planned (F15/F36)** and ships no exports in v1 — see [Host API → React hooks](./host-api.md#react-hooks). The example shows the intended surface; in a v1 plugin the subpath resolves to an empty module (no `useWorktree`), so read worktree context through the `host` API passed to `activate()` instead.

```tsx
// src/dashboard.tsx
import { useEffect } from "react";
import type { PanelViewProps } from "@daintreehq/plugin-sdk";
// Planned (F15/F36): @daintreehq/plugin-sdk/react has no exports in v1.
import { useWorktree } from "@daintreehq/plugin-sdk/react";

export default function Dashboard({ panelId, pluginId, disposeSignal }: PanelViewProps) {
  const worktree = useWorktree();

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

  return <div data-panel-id={panelId}>Dashboard for {worktree?.name ?? "no worktree"}</div>;
}
```

| Prop | Type | Notes |
| --- | --- | --- |
| `panelId` | `string` | Opaque runtime id of the panel instance. Useful as a key for plugin-local panel-scoped state. |
| `pluginId` | `string` | The plugin's manifest `name`. Stable for the lifetime of the host — useful for namespacing storage keys and log lines. |
| `disposeSignal` | `AbortSignal` | Aborts on unmount and when the host receives a `plugin:panel-kinds-changed` push that omits this kind. The broadcast fires before main tears down plugin IPC handlers, so signal-driven cleanup runs while host APIs are still live. |

The view is wrapped in an error boundary by the host. An unhandled render error shows an inline "Try again" affordance; clicking it produces a fresh `lazy()` reference so the dynamic import is re-evaluated rather than returning the cached failed promise.

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
| `iconId` | yes | Registered icon ID. |
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

Bindings register when the plugin loads and unregister on unload. Conflicts with user overrides or other plugins' bindings are resolved by Daintree's existing keybinding service — plugin bindings are low-priority and yield to user overrides. See `src/services/KeybindingService.ts:325` for the registration API.

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
| `type` | no | One of `string`, `number`, `boolean`, `enum`, `json`, `secret`. Defaults to `string`. |
| `label` | no | Field label shown in the generated form. |
| `description` | no | Help text shown beneath the field. |
| `default` | no | Default value. |
| `scope` | no | `user` (global) or `project` (per-project). Defaults to `user`. |
| `options` | no | Non-empty string array; required when `type` is `enum`. |
| `min` / `max` | no | Numeric bounds for `number` settings. `min` cannot exceed `max`. |
| `secret` | no | Legacy boolean; `secret: true` normalizes to `type: "secret"`. Prefer `type: "secret"`. |

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

**Locations:** `worktree`, `terminal`, `panel`, `file`. More may be added.

Context menus follow the same `actionId` dispatch pattern as menu items.

## MCP servers — _Planned_

Declares Model Context Protocol servers the plugin ships. The manifest shape is validated but the `experimental_` prefix signals that it may change before the feature ships — use with awareness that the contract is not yet locked. See [Agent extensions → MCP servers](./agent-extensions.md#mcp-servers) for the full story.

```json
{
  "contributes": {
    "experimental_mcpServers": [
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
| `env` | no | Environment variables. Values can reference settings with `${settings:settingId}` syntax. |

Daintree supervises the process: lazy spawn on first tool use, hard kill on Daintree exit, exponential backoff on crash. The plugin's tools are exposed to any agent running in Daintree through the same MCP surface user-configured MCP servers use.

**Intentionally excluded:** remote MCP transports (`url`), explicit transport types, per-server working directories, restart policies. These are deferred until use cases concretely require them.

## Skills — _Planned_

> Not yet present in the manifest schema. Documented here as a design preview; the shape is not yet locked.

Markdown-defined capability snippets that extend Daintree's built-in MCP server. Agents running in Daintree gain access to them through Daintree's MCP connection.

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

The markdown file content is injected into the agent's context when the skill is invoked. See [Agent extensions → Skills](./agent-extensions.md#skills) for the full file format and invocation mechanics.

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
| `settingsScopeRef` | no | ID prefix in this plugin's `settings` contributions, used to group provider settings. |
| `viewRefs` | no | IDs of `views` contributions shown under this provider's panel section. |

The manifest entry is read eagerly so the provider populates Preferences and the remote-routing table before any plugin code runs; the implementation binds lazily in `activate()` via [`registerForgeProvider`](./host-api.md#registerforgeprovider). For the end-to-end walkthrough — implementing `ForgeProviderImpl`, state normalization, capabilities, and tests — see [Implementing a forge provider](./forge-provider.md).

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
        "iconId": "terminal",
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
| `command` | yes | CLI binary to launch. Same safe-id pattern as `id` (no shell metacharacters). |
| `args` | no | Default launch arguments (≤20 entries; no control characters). |
| `color` | yes | Brand color as a 6-digit hex (`#rrggbb`). |
| `iconId` | yes | Icon id used for the agent. |
| `supportsContextInjection` | no | Whether copy-tree context injection targets this agent. Defaults to `false`. |
| `detection` | no | Reserved for the full-tracking tier. The shape (bounded, well-formed detection patterns) is **validated** at manifest-parse time but not yet wired into the live PTY matcher — minimal-tier agents launch as named, untracked terminals. |

The **minimal tier** (shipped) makes the agent launchable and selectable as a named entry in the effective registry; detection is not run, so the agent always launches as a named terminal. The **full tier** (planned) will relax the built-in-only gate in output detection so a plugin-supplied `detection` config drives working/waiting state, resume, and MCP wiring.

A malformed `detection` config (an un-compilable pattern, an over-long or over-numerous pattern set, or a construct prone to catastrophic backtracking) is rejected at manifest validation — the plugin fails to load loudly rather than silently shipping a bad matcher. Once the full tier lands, a _well-formed_ config that simply never matches at runtime leaves the agent launching as a named terminal and never affects detection for other terminals.

## What's missing and why

A few surfaces I've decided **not** to expose as dedicated contribution points:

- **Agent provider SDKs.** Registering a launchable agent CLI is a contribution point (see [Agents](#agents--shipped-minimal-tier)), but a full model-provider SDK is not. Adding a new model backend is handled via OpenAI-compatible base URL configuration in Daintree's settings — the complexity of a full provider SDK isn't justified when 95% of users just need to point Daintree at a different endpoint.
- **Agent lifecycle hooks (PreToolUse, PostToolUse, Stop).** Use an MCP server instead. A plugin that wants to intercept tool calls ships an MCP server that the agent talks to; the server can refuse or annotate tool calls. This is simpler than a dedicated hook API and reuses the MCP ecosystem.
- **Subagents.** Daintree spawns fresh agents natively. Plugins that want to compose agents use skills + MCP to drive the orchestration, not a dedicated subagent contribution.
- **Status bar items, tree views, editor decorations.** Daintree isn't an editor; these surfaces don't map cleanly to what we render. Revisit if a specific need emerges.

If you think a contribution point is missing, open an issue at [daintreehq/daintree](https://github.com/daintreehq/daintree/issues).
