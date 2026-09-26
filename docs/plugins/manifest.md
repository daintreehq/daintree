# Manifest Reference

Every plugin has a `plugin.json` at its root. It describes the plugin's identity, its compatibility with Daintree, what it contributes to the UI, and what capabilities it needs.

Daintree reads the manifest eagerly at startup. Contribution points declared here populate the command palette, menus, and toolbars immediately — before any plugin code runs. Plugin code is only imported and executed when something actually triggers it.

## Full schema

```jsonc
{
  // The generated JSON Schema, for editor completion. Optional; accepted and
  // never read. Use plugin.project.schema.json for a project plugin.
  "$schema": "https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas/plugin.schema.json",

  // Scoped plugin identifier. Required. Format: "publisher.plugin-name".
  // Must be lowercase, use hyphens (not underscores), and contain exactly one period.
  "name": "acme.linear-planner",

  // Semver version. Required.
  "version": "0.1.0",

  // Human-readable display name. Optional; falls back to `name`.
  "displayName": "Linear Planner",

  // One-sentence description, shown in UI listings.
  "description": "Plan Linear issues as multi-step agent workflows.",

  // One-line value proposition for the plugin catalog. Optional, max 120
  // characters.
  "tagline": "Turn Linear issues into agent workflows.",

  // Catalog category. Optional enum: "forge" | "ai" | "workspace" | "other".
  // Omit it and Daintree derives one from `contributes` (forge providers ⇒
  // "forge", agents/MCP servers ⇒ "ai", panels/views ⇒ "workspace",
  // else "other").
  "category": "ai",

  // Attribution credits, shown in the plugin detail pane's "Contributors"
  // block. Optional. Up to 10 entries; each needs a `name`, plus optional
  // `url` (https-only, same private-host/credential discipline as
  // scopes.network.allowedUrls), `email`, and free-form `role`.
  "authors": [
    { "name": "Ada Lovelace", "url": "https://ada.example.com", "role": "Maintainer" },
    { "name": "Grace Hopper", "email": "grace@example.com" },
  ],

  // Declares the plugin is only ever loaded from a project's own
  // .daintree/plugins/. REQUIRED there, REJECTED under the user and builtin
  // roots. Omit it for a normal, app-wide plugin. See "scope" below.
  "scope": "project",

  // Path to the compiled ESM entry, relative to the plugin directory.
  // Optional — plugins with only static contributions (themes, static MCP
  // server configs) don't need one.
  "main": "dist/index.js",

  // Host version compatibility. Optional but strongly recommended.
  // Uses semver range syntax.
  "engines": {
    "daintree": ">=0.11.0",
  },

  // Declared capabilities, surfaced in the plugin manager after install.
  // Disclosure-first with host-side policy effects (no Node sandbox).
  // See "Capabilities" below and ./trust-model.md.
  "capabilities": ["fs:project-read", "network:fetch"],

  // Per-capability allowlists that attenuate the capability lattice.
  // Optional. scopes.network.allowedUrls and scopes.fs.allowedPaths reject
  // wildcards and private/loopback targets. See ./trust-model.md.
  "scopes": {
    "network": { "allowedUrls": ["https://api.acme.com/v1"] },
    "fs": { "allowedPaths": ["/Users/me/.acme/data"] },
  },

  // Activation triggers. Optional. Plugins are lazy by default — omitting this
  // field (or passing an empty array) defers the `main` import and `activate()`
  // until a contribution is first used. The sole recognised value,
  // "onStartupFinished", is the explicit opt-in for plugins that must run at
  // boot. Contributions are registered eagerly either way.
  "activationEvents": ["onStartupFinished"],

  // The plugin's UI and functional contributions. Every key is optional.
  "contributes": {
    "commands": [/* palette actions */],
    "panels": [/* panel kinds, each with an optional menu of your own actions */],
    "views": [/* the component for a panel, or the plugin's settings section */],
    "settings": [/* values Daintree stores and renders a form for */],
    "databases": [/* SQLite files opened with host.db */],
    "toolbarButtons": [/* ... */],
    "keybindings": [/* ... */],
    "contextMenus": [/* worktree, terminal and file right-click entries */],
    "menuItems": [/* application menu entries; not under scope: "project" */],
    "agentMcp": [/* tools Daintree serves to terminal agents; requires mcp:expose */],
    "mcpServers": [/* stdio servers Daintree connects to as a client */],
    "skills": [/* markdown knowledge served through Daintree's own MCP server */],
    "recipes": [/* named multi-terminal launch layouts */],
    "tours": [/* welcome tours for the plugin or one of its panels */],
    "agents": [/* requires the agent:register capability */],
    "processTools": [/* command → terminal-tab icon detections */],
    "forgeProviders": [/* ... */],
    "fileDecorationProviders": [/* ... */],
    "surfaces": {/* project-scope only; see "contributes.surfaces" below */},
    // Built-in plugins only: "fileEditors", "previewTools", "guestAdapters".
  },
}
```

Every field is listed below; [An app-style project plugin](#an-app-style-project-plugin) is a complete manifest that uses the newer ones together.

## Required fields

### `name`

Scoped plugin identifier in `publisher.plugin-name` format. Enforced by the regex `^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$` and a 64-character maximum.

- Lowercase only
- Use hyphens, not underscores
- Exactly one period, separating publisher from plugin name
- No spaces, no uppercase

Good: `acme.linear-planner`, `gpriday.cost-management`, `foo.bar-baz` Bad: `LinearPlanner`, `acme/linear`, `acme.linear.planner`, `Acme.LinearPlanner`

The publisher segment should identify you (GitHub handle, company name, domain prefix). It prevents naming collisions across the ecosystem.

### `version`

Standard semver. `0.1.0`, `1.2.3-beta.1`, etc. Required for update detection.

## Optional fields

### `$schema`

The URL of the manifest's JSON Schema, so an editor can complete and check `plugin.json` as you type. The host accepts the key — the manifest is otherwise strict — and never fetches or reads it; its own Zod schema is the authority. `npx daintree-plugin new` writes it for you:

- `https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas/plugin.schema.json` for an installed plugin
- `https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas/plugin.project.schema.json` for a project plugin

Both are generated from the host's schema (`npx daintree-plugin schema [--project]` prints the one your installed SDK was built with) and are structural only: the cross-field rules under [Validation](#validation) are enforced at load, not by the editor.

### `displayName`

The human-readable name shown in UI listings (plugin palette, installed-plugins list). Falls back to `name` if omitted. Not used for runtime lookups — only display.

### `description`

One-sentence description shown in plugin listings. Keep it short; UI truncates long descriptions.

### `tagline`

A one-line value proposition for the plugin catalog. Optional, trimmed, and capped at 120 characters. Distinct from `description`: the tagline is the catalog card's hook, the description is the longer blurb.

### `authors`

Optional attribution credits, surfaced as a "Contributors" block in the plugin detail pane. An array of up to 10 entries; each entry is an object where `name` is required and `url`, `email`, and `role` are optional. Unknown keys on an entry are rejected. `url` must be `https://` and follows the same discipline as `scopes.network.allowedUrls` — no wildcards, embedded credentials, or private/loopback hosts — because it surfaces as a user-clickable link; `email` must be a valid address; `role` is a free-form label (e.g. `"Maintainer"`, `"Contributor"`). The SDK exports the `PluginAuthor` type for authoring against this shape.

```jsonc
"authors": [
  { "name": "Ada Lovelace", "url": "https://ada.example.com", "role": "Maintainer" },
  { "name": "Grace Hopper", "email": "grace@example.com" },
]
```

### `category`

Catalog category for grouping in the plugin manager. Optional enum: `"forge"`, `"ai"`, `"workspace"`, or `"other"`. When omitted, Daintree derives one from what the plugin contributes — forge providers map to `"forge"`, agents or MCP servers to `"ai"`, panels or views to `"workspace"`, and anything else to `"other"`. Declare it explicitly when a multi-contribution plugin would otherwise be misclassified by derivation.

### `main`

Path to the plugin's compiled ESM entry file, relative to the plugin root. The file must export an `activate` function:

```ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi) {
  // setup code
  return () => {
    // cleanup code (optional)
  };
}
```

Plugins with only static contributions (a theme pack, a standalone MCP server config) can omit `main` entirely.

### `engines.daintree`

Semver range expressing which Daintree versions the plugin supports. The scaffolder (`npx daintree-plugin new`) generates `">=0.11.0"` — an open-ended lower bound, deliberately not a caret:

- `">=0.11.0"` — 0.11 and every later release (scaffolder default)
- `">=0.11.0 <0.13.0"` — explicit range
- `"0.11.x"` — any 0.11 release

**Never use a caret on a 0.x range.** `"^0.11.0"` resolves to `>=0.11.0 <0.12.0` under semver's 0.x rule, so it stops matching at the very next minor and the plugin draws a compatibility warning on every release after the one you wrote it against.

If the running Daintree version doesn't satisfy the range, the plugin still installs and loads, and Daintree shows a warning toast (once per session for each plugin version and range) that it may not work on this version. A local dev build such as `0.37.0-dev.<stamp>` is also checked against the release it precedes, so it satisfies `>=0.37.0`. If `engines.daintree` is omitted entirely, Daintree warns in the console but loads the plugin anyway.

Daintree is pre-1.0. Pin to a current minor during this phase — a plugin that works on Daintree 0.11 may not work on 0.12 without changes.

### `scope`

The only accepted value is `"project"`, and it declares that the plugin is a **project-local** plugin — one that lives in a project's own repository at `<projectRoot>/.daintree/plugins/` and loads only while that project is open. Omit the field entirely for a normal, app-wide plugin.

The manifest gate enforces it in both directions, against the root the manifest was discovered under:

- Discovered under a project's `.daintree/plugins/` **without** `"scope": "project"` → rejected (`project_scope_required`). The host will not load a project-local plugin that has not opted in.
- Discovered under the user or builtin plugins root **with** `"scope": "project"` → rejected (`project_scope_not_allowed`).

This is a guardrail against accidental promotion, not a security control — the trust decision is the project folder, not this field. What it prevents is a plugin loading under assumptions its author never made: a project plugin copied into the user directory would go app-wide with project-shaped expectations about its settings tier and its bound project, and a user plugin dropped into `.daintree/plugins/` would load with none of the project-local guarantees. Neither failure is visible at runtime, so both are refused at the gate.

Declaring `"scope": "project"` also changes what the manifest may contribute. `contributes.surfaces` and `"project"` [databases](./contribution-points.md#databases--shipped) become available, and ten contribution groups become unavailable — `menuItems`, `agents`, `skills`, `recipes`, `fileDecorationProviders`, `fileEditors`, `processTools`, `mcpServers`, `tours` and `forgeProviders`, each rejected with an error naming the structural reason it cannot yet be narrowed to one project. `agentMcp` stays available, because its credentials are bound to one project. See [Project-local plugins](./project-local.md) and the per-point status in [Contribution points](./contribution-points.md).

### `capabilities`

Array of capability tokens the plugin wants. The model is **disclosure-first with host-side policy effects** — there is no Node sandbox, so a plugin is not blocked from doing anything regardless of what it declares, but declared tokens are not purely advisory. Seven high-risk tokens (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`) raise the plugin's actions to a confirm dialog (`effectiveDanger: "confirm"`) via the host's `CONFIRM_TRIGGERING_CAPABILITIES` set — by default every action, though a command can narrow which capabilities that derivation consults with [`requires`](./contribution-points.md#commands--shipped). `socket:connect` is deliberately excluded from that set: the host has no interception point for `node:net`, so elevating on a token it cannot enforce would buy friction without buying safety. `mcp:expose` is not in the set either: it gates `host.mcp.registerTools` and the `agentMcp` contribution, and what it would expose is held behind a separate per-project decision instead. See the [trust model](./trust-model.md) for the full contract.

| Token | Intent |
| --- | --- |
| `fs:project-read` | Read files in the current project worktree |
| `fs:project-write` | Modify files in the current project worktree. Required by a `"project"` database |
| `fs:user-data-read` | Read from `~/.daintree/` or elsewhere in the user's home |
| `fs:user-data-write` | Write to `~/.daintree/` or elsewhere in the user's home |
| `network:fetch` | Make outbound HTTP requests |
| `agent:invoke` | Drive AI agents from plugin code. Disclosure and confirm elevation only — no host API is gated on it |
| `agent:read` | Observe agent state (`host.getAgentState`, `host.onDidChangeAgentState`: lifecycle phase, session cost/tokens on completion) and list the project's agent panes (`host.agents.list`) |
| `agent:register` | Register a launchable agent CLI as a selectable agent |
| `agent:input` | Send text to the active agent terminal (`host.sendToActiveAgent`) or append it to a chosen agent's draft (`host.sendToAgent`); JIT consent on first use |
| `git:read` | Read git state (branches, status, log) |
| `git:write` | Make git changes (commits, branches) |
| `clipboard:read` | Read from the system clipboard |
| `clipboard:write` | Write to the system clipboard (text, and PNG images via `host.clipboard.writeImage`) |
| `shell:exec` | Spawn subprocesses (managed via `host.process`) |
| `socket:connect` | Connect to local Unix-domain sockets or Windows named pipes (e.g. the Docker socket) |
| `mcp:expose` | Serve `contributes.agentMcp` tools to agents in Daintree's terminals (`host.mcp.registerTools`). Required by `agentMcp`; exposes nothing until an endpoint is enabled for a project |

Declare honestly. The plugin manager's detail pane lists what you've declared (after install, not as a pre-install consent gate) and users judge plugins by what they ask for; the host also derives policy from the high-risk tokens above. A plugin declaring `shell:exec` for no obvious reason looks suspicious. A plugin that silently executes shells without declaring it damages the ecosystem — and for the most part nothing at runtime stops it, which is exactly why honest declaration matters. The clearest runtime-enforced exception is `host.process.spawn` (see [host API](./host-api.md#process--managed-child-processes)): the managed-process surface rejects unless the plugin declared `shell:exec`. `host.mcp.registerTools` is gated on `mcp:expose` the same way. A plugin can still `require("child_process")` directly to bypass that — the gate is on the managed surface, not a Node sandbox — but the managed surface is the supported, supervised path.

### `scopes`

Per-capability allowlists that declare what a capability intends to reach. Both buckets are schema-validated, but neither is a runtime sandbox — they do not block actual calls or writes. Two buckets, with different runtime weight today:

- `scopes.network.allowedUrls` — outbound request targets the plugin intends to reach under `network:fetch`. Wildcards and private/loopback targets are rejected. **Live but advisory:** a non-empty allowlist suppresses the compound-capability elevation (the host won't force a confirm dialog when `network:fetch` is paired with a sensitive read), proving the fetch is tightly bound rather than a generic exfiltration channel. It does not actually block requests to other URLs.
- `scopes.fs.allowedPaths` — absolute paths the filesystem capabilities may touch. Entries may also use the dynamic tokens `${project}` or `${worktree}` (optionally with a `/sub/path` suffix, e.g. `"${project}/src"`), which expand at call time to the active project root and active worktree path. Wildcards, relative paths, `..` segments, and unknown tokens are rejected by the manifest schema. **Enforced for the host `fs`/`git` API:** every path argument to `host.fs.*` and `host.git.*` is realpath-resolved and contained to one of these roots (traversal and symlink-escape rejected, mirroring the `plugin://` protocol handler); an out-of-scope path rejects with a `PATH_NOT_ALLOWED:` prefix. It still does not attenuate the compound-capability lattice (fs writes elevate unconditionally). **Honest scope limit:** this enforces the sanctioned, audited `host.fs`/`host.git` path only — a plugin's `main` is un-sandboxed Node code (it runs in the plugin worker with full filesystem privileges) and can still call raw `node:fs` directly, which the host cannot intercept without a real sandbox. `allowedPaths` contains the host-mediated surface; it does not seal the un-mediated one.
- `scopes.socket.allowedPaths` — local endpoints the plugin intends to connect to under `socket:connect`: absolute Unix-domain socket paths (`/var/run/docker.sock`) and/or Windows named pipes (`\\.\pipe\docker_engine`). Both forms are accepted on every platform, so a cross-platform manifest parses everywhere it's read. Wildcards, relative paths, and `..` segments are rejected. **Purely advisory:** nothing enforces this, because a plugin's `main` reaches `node:net` directly and the host has no interception point. It exists so the plugin manager can render "connects to `/var/run/docker.sock`" instead of the bare capability — which is the entire value of the disclosure. Optional; declare `socket:connect` without it if the endpoint varies.

A misspelled bucket (e.g. `networking`) is rejected as a manifest error rather than silently dropped. See the [trust model](./trust-model.md) for the full scopes semantics and how they compose with capabilities.

### `activationEvents`

Activation triggers. The sole supported value is `"onStartupFinished"`, which activates the plugin once the app finishes starting.

Plugins are lazy by default. Omitting `activationEvents` (or passing an empty array) defers the plugin's `main` module import and `activate()` call until one of its contributions is first used — a contributed command is dispatched, a forge provider or file decoration is queried, or a contributed panel view is opened. List `"onStartupFinished"` to opt a plugin into eager activation when it genuinely needs to run at boot. Either way, contributions (commands, panels, keybindings, …) are registered eagerly from the manifest at startup — only the `main` import and `activate()` call are governed by activation, so a lazy plugin's commands and panels still appear in the palette before any of its code runs.

### `contributes`

Object containing an array per contribution type (`panels`, `toolbarButtons`, `menuItems`, `keybindings`, `contextMenus`, `commands`, `views`, `mcpServers`, `agentMcp`, `databases`, `tours`, `skills`, `forgeProviders`, `fileDecorationProviders`, `agents`, `processTools`, `settings`, `recipes`, and the built-in-only `fileEditors`, `previewTools`, `guestAdapters`) — plus the non-array `surfaces` object. All are optional; unlisted types default to empty. Each array has an upper bound (`MANIFEST_CONTRIBUTION_CAPS` in `electron/schemas/plugin.ts`) generous for any real plugin and there to reject pathological manifests.

Validation is structural as well as per-field: duplicate ids within one array are rejected (`duplicate_contribution_id`), and cross-references have to resolve — a panel view's `id` must name a declared panel (a settings view must not), a panel `menu` entry, toolbar button, menu item, keybinding or context menu naming an action in your own namespace must match a declared command when you declare any, a tour's `panelKind` must name a declared panel, a forge provider's `settingsScopeRef` / `viewRefs` must name declared settings / views, a `surfaces` slot's `viewId` must name a declared panel view, and a `${settings:…}` token in an MCP server's `command` / `args` / `env` must name a declared setting. Capability rules are checked too: `agents` needs `agent:register`, `agentMcp` needs `mcp:expose`, and a `"project"` database needs `scope: "project"` and `fs:project-write`.

A few notes on individual points; the [Contribution points reference](./contribution-points.md) has the full shape and per-point status for every one, and marks the three only a built-in plugin may declare.

- `views` — a `location: "panel"` view is the component for the panel with the same `id`, wherever that panel sits. A `location: "settings"` view is the plugin's one custom settings section, mounted below its generated settings fields; it names no panel. `location: "sidebar"` is rejected at manifest validation — the sidebar host does not exist yet, so accepting it would validate a view the runtime cannot render. See [Views](./contribution-points.md#views--shipped).
- `mcpServers` — the declared `command` is lazily spawned as a real subprocess the first time its tools are enumerated, and is supervised (killed on Daintree exit; on crash it transitions to `crashed` and tool calls reject until an explicit manual restart — there is no automatic retry or backoff). Treat a contributed MCP server as trust-gated, not inert. Daintree is the server's client: its tools reach Daintree's own UI and the in-app Assistant, not agents running in terminals.
- `panels` — a panel's optional `menu` offers up to five of the plugin's own actions in that panel's ⋯ and right-click menus, each `{ actionId, label? }` and dispatched with `{ panelId }`; a built-in or another plugin's action is refused, and so are menu entries on a `hasPty: true` panel. The host adds its own entries for the plugin below them. See [Panel menu](./contribution-points.md#panel-menu).
- `databases` — SQLite files the plugin opens with `host.db`. A `"project"` database (the default) lives in the repository, at `path` relative to the project root or `.daintree/data/<manifestId>/<id>.db`, and needs `scope: "project"` plus `fs:project-write`; a `"local"` one lives in the plugin's own data directory and needs no capability. Declaring one also gives every panel of the plugin a **Back up data…** menu entry. See [Databases](./contribution-points.md#databases--shipped).
- `tours` — welcome tours that play in Daintree's tour dialog, offered from Help and the palette, or from one panel's menus when `panelKind` names it. Installed plugins only. See [Tours](./contribution-points.md#tours--shipped-installed-plugins).
- `agentMcp` — the inbound direction: an MCP tools endpoint Daintree hosts for agents in its terminals, with the tools registered from `activate()` through `host.mcp.registerTools`. Requires the `mcp:expose` capability; one endpoint per plugin; allowed under `scope: "project"`. See [Agent MCP endpoints](./contribution-points.md#agent-mcp-endpoints--shipped).
- `settings` — each entry is a value Daintree stores and renders a form field for. `type` is `string` (default), `number`, `boolean`, `enum`, `json`, `secret`, `path`, `directory` or `file`; `scope` is `user` (default, app-wide), `project` (committed under the project's `.daintree/plugin-settings/`) or `local` (per project, this machine only). `required: true` puts a "needs setup" strip on the plugin's panels until the value is stored; `editor: "view"` hands the field to the plugin's settings view instead of the generated form. A `secret` is encrypted at rest through the OS keychain, never written into the repository even in `project` scope, and may not declare a `default`. Declaring any setting, or a settings view, gives every panel of the plugin a **Plugin settings…** menu entry. Full field reference in [Contribution points → Settings schema](./contribution-points.md#settings-schema--shipped).
- `skills` and `recipes` — declarative content, requiring no capability. Skills are markdown served to agents through Daintree's own MCP server; recipes are named multi-terminal launch layouts, registered app-wide and immutable to the user. See [Skills](./contribution-points.md#skills--shipped) and [Recipes](./contribution-points.md#recipes--shipped).
- `agents` — registers a launchable agent CLI as a selectable agent. Requires the `agent:register` capability; the schema rejects the contribution without it. An optional `detection` block wires it into the same agent-state UI built-in agents use.
- `forgeProviders` and `fileDecorationProviders` — the manifest entry is read eagerly so the host's routing tables are populated before any plugin code runs; the implementation binds lazily in `activate()`. Forge providers are **built-in plugins only** — their host methods are synchronous and cannot cross the plugin worker's message port.
- `surfaces` — **project-scope only.** An object, not an array: fixed slots a project-local plugin claims to replace one of the host's own surfaces for its own project. `emptyCanvas` (`{ "viewId": "..." }`) is the only slot accepted today; `viewId` must name a declared `contributes.views` entry, and at most one plugin may claim a slot per project. A manifest without `"scope": "project"` that declares any surface is rejected. See [Project-local plugins → Surfaces](./project-local.md#surfaces).

> `views` and `mcpServers` were named `experimental_views` and `experimental_mcpServers` until #10466. The old keys are still accepted as deprecated aliases — a manifest using them parses and runs identically, but logs a one-time deprecation warning naming the stable replacement. Rename to `views` / `mcpServers`; the aliases may be removed in a future major.

## An app-style project plugin

A project plugin that is really an application — here a household ledger committed to the project's own repository at `.daintree/plugins/acme.ledger/` — typically combines a database, settings, a panel with its own menu, and a command to open it:

```json
{
  "$schema": "https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas/plugin.project.schema.json",
  "name": "acme.ledger",
  "version": "0.1.0",
  "displayName": "Ledger",
  "description": "Household ledger: transactions, categories and budgets.",
  "scope": "project",
  "main": "dist/index.mjs",
  "engines": { "daintree": ">=0.39.0" },
  "capabilities": ["fs:project-write", "agent:input"],
  "contributes": {
    "databases": [
      {
        "id": "ledger",
        "description": "Transactions, categories and budgets.",
        "path": "data/ledger.db"
      }
    ],
    "settings": [
      {
        "id": "currency",
        "type": "enum",
        "options": ["EUR", "GBP", "USD"],
        "default": "EUR",
        "scope": "project",
        "label": "Currency",
        "description": "Currency amounts are recorded and shown in.",
        "required": true
      },
      {
        "id": "bankToken",
        "type": "secret",
        "scope": "local",
        "label": "Bank API token",
        "description": "Read-only token used to import transactions.",
        "required": true,
        "editor": "view"
      }
    ],
    "commands": [
      {
        "id": "open",
        "title": "Open ledger",
        "description": "Open the ledger panel.",
        "category": "Ledger",
        "kind": "command",
        "danger": "safe",
        "requires": []
      },
      {
        "id": "send-uncategorised",
        "title": "Send uncategorised transactions to an agent",
        "description": "Draft the uncategorised transactions into an agent's input for review.",
        "category": "Ledger",
        "kind": "command",
        "danger": "safe",
        "requires": ["agent:input"]
      }
    ],
    "panels": [
      {
        "id": "ledger",
        "name": "Ledger",
        "iconId": "wallet",
        "color": "var(--theme-category-green)",
        "stateVersion": 1,
        "menu": [
          { "actionId": "acme.ledger.send-uncategorised", "label": "Send uncategorised to agent…" }
        ]
      }
    ],
    "views": [
      { "id": "ledger", "componentPath": "dist/panel.js", "location": "panel" },
      { "id": "connection", "componentPath": "dist/settings.js", "location": "settings" }
    ],
    "toolbarButtons": [
      { "id": "open-ledger", "label": "Ledger", "iconId": "wallet", "actionId": "acme.ledger.open" }
    ]
  }
}
```

What each part buys:

- **`scope: "project"`** makes it a project plugin, loaded only while this project is open. It is what allows a `"project"` database, and why `$schema` names the project variant.
- **`databases`** declares `data/ledger.db`, a file in the repository that agents in the project's terminals can open with `sqlite3`. A project database needs `fs:project-write`; the worker opens it with `host.db.open("ledger", { migrations })`. Every panel of the plugin gets **Back up data…**.
- **`settings`** declares a committed `currency` shared by everyone who clones the project, and a `bankToken` secret each collaborator enters on their own machine. Both are `required`, so the panel shows a "Ledger needs setup" strip until they are stored; `editor: "view"` leaves the token to the plugin's own settings view rather than a generated field. Every panel gets **Plugin settings…**.
- **`views`** pairs `dist/panel.js` with the `ledger` panel, and declares `dist/settings.js` as the custom settings section, which mounts in Project settings → Plugins.
- **`panels[].menu`** puts **Send uncategorised to agent…** on the panel's ⋯ and right-click menus, dispatched with `{ panelId }`.
- **`commands`** puts both actions in the palette. `agent:input` and `fs:project-write` are high-risk, so without `requires` every action would ask for confirmation; `"requires": []` keeps **Open ledger** one click, while `send-uncategorised` names the capability it actually uses and asks first. Both handlers need the host, so the worker (`main`) registers them with `host.registerAction` in `activate()`, passing the same descriptor, `requires` included — the imperative registration replaces the manifest one. The send handler calls `host.sendToAgent`, which drafts into an agent the user picks and never submits.
- **`toolbarButtons`** puts a **Ledger** button in the plugin tray that runs `acme.ledger.open`.

[Building apps](./building-apps.md) walks through writing the worker and views behind a manifest like this.

## Validation

The manifest is validated by Zod schemas at load time. Violations surface as user-visible toast errors with the specific schema path that failed. Common causes:

- Plugin name missing the period (`acmelinearplanner`)
- Uppercase in name (`Acme.LinearPlanner`)
- `engines.daintree` isn't a valid semver range
- Capability token not in the allowlist
- Unknown field at the top level (the manifest uses strict validation; typos are rejected)

Run `npx daintree-plugin validate` in your plugin directory to check the manifest locally before packaging.

## Unknown fields

The manifest schema is strict — unknown top-level keys and unknown keys inside `contributes` are rejected. This prevents typos from silently dropping contributions.

If you see an error like `Unrecognized key "contribute"`, you mistyped a field name. The expected key is `contributes` (plural).
