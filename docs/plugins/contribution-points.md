# Contribution Points

A contribution point is a slot in Daintree that a plugin can fill. Contributions are declared in the `contributes` field of `plugin.json`. Daintree reads the manifest eagerly at startup — contributions show up in the command palette and UI before any plugin code runs.

Each section below documents a contribution point, its schema, an example, and current implementation status.

## Status legend

- **Shipped** — available in the current Daintree release
- **Planned** — design locked, implementation in progress
- **Future** — not yet committed

## Commands — _Shipped_

Commands are callable actions that appear in the command palette and can be bound to keybindings, toolbar buttons, or menu items.

```json
{
  "contributes": {
    "commands": [
      {
        "name": "plan-from-issue",
        "title": "Plan From Issue",
        "description": "Turn a Linear issue into a branch and agent session.",
        "category": "Linear Planner",
        "danger": "confirm",
        "keywords": ["linear", "plan", "issue"]
      }
    ]
  }
}
```

**Fields:**

| Field         | Required | Notes                                                                                                                                                                                                      |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | Matches `/^[a-z0-9][a-z0-9-]*$/`. Namespaced at runtime as `{pluginId}.{name}`. Also determines the handler file path — see below.                                                                         |
| `title`       | yes      | Palette label.                                                                                                                                                                                             |
| `description` | yes      | Subtitle in the palette and command detail views.                                                                                                                                                          |
| `category`    | yes      | Grouping label; keep consistent across commands in the same plugin.                                                                                                                                        |
| `kind`        | no       | `"command"` (default) or `"query"`. Queries are expected to be read-only and idempotent.                                                                                                                   |
| `danger`      | no       | `"safe"` (default) or `"confirm"`. A `confirm` command requires `{ confirmed: true }` when invoked by an agent. See [action-system](../architecture/action-system.md) for how danger works across the IDE. |
| `keywords`    | no       | Extra search terms for the palette.                                                                                                                                                                        |

**Handler binding** — two ways:

_Filesystem convention (simple case):_ a command named `plan-from-issue` looks for `src/plan-from-issue.ts` (or `.tsx`). Its default export is the handler.

```ts
// src/plan-from-issue.ts
import type { CommandContext } from "@daintreehq/plugin-sdk";

export default async function planFromIssue(ctx: CommandContext) {
  // ctx.args — validated args if the command declares argsSchema
  // ctx.dispatch — call other actions
  // ctx.host — full host API
  await ctx.showToast({ title: "Planning…" });
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

If a command is declared in the manifest but no handler is bound — neither a filesystem file nor an imperative registration — running it produces a user-visible toast: `Command "{pluginId}.{name}" has no handler`. If an imperative registration references a name not in the manifest, it's allowed but the command doesn't appear in the palette or menus until you add it to the manifest.

See the [Host API](./host-api.md#registeraction) reference for the full signature.

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

| Field           | Required | Notes                                                                                                           |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `id`            | yes      | Namespaced at runtime as `{pluginId}.{id}`.                                                                     |
| `name`          | yes      | Display label in the panel header and palette.                                                                  |
| `iconId`        | yes      | Must match a registered icon ID — see the icon registry in `src/components/icons/`.                             |
| `color`         | yes      | HSL string used for the panel tab accent.                                                                       |
| `hasPty`        | no       | `false` (default) for UI-only panels. `true` is reserved for PTY-backed panels, not available to plugins in v1. |
| `canRestart`    | no       | Show a "restart" control in the panel header.                                                                   |
| `canConvert`    | no       | Allow conversion between compatible panel kinds. Rarely useful for plugins.                                     |
| `showInPalette` | no       | Include in the "New Panel…" palette. Default `true`.                                                            |

**Component registration** is covered by the **views** contribution point below — panels declare the slot, views provide the component.

## Views — _Planned_

Views are the React components that render inside a panel. They depend on Daintree's renderer plugin host, which is in active development. The manifest shape is locked and stable; the runtime wiring is landing in the next phase.

```json
{
  "contributes": {
    "views": [
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

**Fields:**

| Field           | Required | Notes                                                                                               |
| --------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `id`            | yes      | Matches the panel `id` it provides a component for. Namespaced at runtime as `{pluginId}.{id}`.     |
| `name`          | yes      | Display label.                                                                                      |
| `componentPath` | yes      | Relative path to an ESM module inside the plugin. The module's default export is a React component. |
| `location`      | yes      | `"panel"` (docked in the grid) or `"sidebar"` (sidebar contribution — future).                      |
| `iconId`        | no       | Override the panel's icon for this view.                                                            |
| `description`   | no       | Surface text for palette/preferences.                                                               |

**Bundling** — plugin views ship as **pre-built ESM modules**. You don't compile TypeScript or JSX at plugin-load time. `@daintreehq/plugin-vite` produces the bundle with the correct externals for React 19 sharing. See [Architecture → Renderer host](./architecture.md#renderer-host) for the internals.

**Component contract:**

```tsx
// src/dashboard.tsx
import type { PanelViewProps } from "@daintreehq/plugin-sdk";
import { useWorktree } from "@daintreehq/plugin-sdk/react";

export default function Dashboard({ panelId, disposeSignal }: PanelViewProps) {
  const worktree = useWorktree();
  return <div>Dashboard for {worktree?.name ?? "no worktree"}</div>;
}
```

The view is wrapped in an error boundary by the host. An unhandled render error shows an inline fallback with the plugin name and a "Reload" button — it does not crash the rest of Daintree.

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

| Field      | Required | Notes                                                                                                    |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `id`       | yes      | Namespaced at runtime as `plugin.{pluginId}.{id}`.                                                       |
| `label`    | yes      | Hover tooltip.                                                                                           |
| `iconId`   | yes      | Registered icon ID.                                                                                      |
| `actionId` | yes      | Fully-qualified action ID, including plugin namespace. Built-in actions (e.g. `terminal.new`) also work. |
| `priority` | no       | `1`–`5`, lower = earlier in sort order. Default `3`.                                                     |

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

| Field         | Required | Notes                                                                                                   |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `label`       | yes      | Menu entry label.                                                                                       |
| `actionId`    | yes      | Fully-qualified action ID to dispatch.                                                                  |
| `location`    | yes      | One of `"terminal"`, `"file"`, `"view"`, `"help"`. Determines which top-level menu the item appears in. |
| `accelerator` | no       | Platform-neutral shortcut, e.g. `"Cmd+Shift+L"` (becomes `Ctrl+Shift+L` on Windows/Linux).              |

## Keybindings — _Planned_

Keybindings map a key combination to an action.

```json
{
  "contributes": {
    "keybindings": [
      {
        "actionId": "acme.linear-planner.plan-from-issue",
        "combo": "Cmd+Shift+P",
        "when": "panel.focused"
      }
    ]
  }
}
```

**Fields:**

| Field      | Required | Notes                                                                                                           |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `actionId` | yes      | Fully-qualified action ID, usually one your plugin declared.                                                    |
| `combo`    | yes      | Normalized key combo string, same format as Daintree's default keybindings. Chords (`"Cmd+K Cmd+S"`) supported. |
| `when`     | no       | Context expression. Future; in v1 always-active bindings only.                                                  |

Conflicts with user overrides or other plugins' bindings are resolved by Daintree's existing keybinding service — plugin bindings are low-priority and yield to user overrides. See `src/services/KeybindingService.ts:325` for the registration API.

## Settings schema — _Planned_

Declares user-configurable settings for your plugin.

```json
{
  "contributes": {
    "settings": [
      {
        "id": "linear.apiToken",
        "type": "secret",
        "scope": "user",
        "title": "Linear API Token",
        "description": "Personal API token from linear.app/settings/api"
      },
      {
        "id": "linear.defaultTeam",
        "type": "string",
        "scope": "project",
        "title": "Default team",
        "description": "Team slug to use when opening a new planning session",
        "default": ""
      }
    ]
  }
}
```

**Field types:** `string`, `number`, `boolean`, `secret`, `enum`, `json`.

**Scopes:** `user` (global, persisted in Daintree config), `project` (per-project, persisted with project state).

Settings appear in Preferences → Plugins → `{pluginId}` as a generated form. Values are read via the host API:

```ts
const token = await host.settings.get<string>("linear.apiToken");
```

Changes fire a subscription callback, so you don't need to reactivate to pick them up.

## Context menus — _Planned_

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

Declares Model Context Protocol servers the plugin ships. See [Agent extensions → MCP servers](./agent-extensions.md#mcp-servers) for the full story.

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

| Field     | Required | Notes                                                                                     |
| --------- | -------- | ----------------------------------------------------------------------------------------- |
| `id`      | yes      | Namespaced at runtime as `{pluginId}.{id}`.                                               |
| `name`    | yes      | Display name.                                                                             |
| `command` | yes      | Executable — `node`, `python`, `npx`, or an absolute path.                                |
| `args`    | no       | Argv after the command.                                                                   |
| `env`     | no       | Environment variables. Values can reference settings with `${settings:settingId}` syntax. |

Daintree supervises the process: lazy spawn on first tool use, hard kill on Daintree exit, exponential backoff on crash. The plugin's tools are exposed to any agent running in Daintree through the same MCP surface user-configured MCP servers use.

**Intentionally excluded:** remote MCP transports (`url`), explicit transport types, per-server working directories, restart policies. These are deferred until use cases concretely require them.

## Skills — _Planned_

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

## What's missing and why

A few surfaces I've decided **not** to expose as dedicated contribution points:

- **Agent provider plugins.** Adding a new model backend is handled via OpenAI-compatible base URL configuration in Daintree's settings, not a plugin API. The complexity of a full provider SDK isn't justified when 95% of users just need to point Daintree at a different endpoint.
- **Agent lifecycle hooks (PreToolUse, PostToolUse, Stop).** Use an MCP server instead. A plugin that wants to intercept tool calls ships an MCP server that the agent talks to; the server can refuse or annotate tool calls. This is simpler than a dedicated hook API and reuses the MCP ecosystem.
- **Subagents.** Daintree spawns fresh agents natively. Plugins that want to compose agents use skills + MCP to drive the orchestration, not a dedicated subagent contribution.
- **Status bar items, tree views, editor decorations.** Daintree isn't an editor; these surfaces don't map cleanly to what we render. Revisit if a specific need emerges.

If you think a contribution point is missing, open an issue at [daintreehq/daintree](https://github.com/daintreehq/daintree/issues).
