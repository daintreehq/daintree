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
  // "forge", agents/MCP servers/skills/agentMcp ⇒ "ai", panels/views ⇒ "workspace",
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

  // Optional. "unsupported" keeps the plugin from starting for a window
  // attached from another machine. Defaults to "supported". See "remote" below.
  "remote": "unsupported",

  // Optional. The operating systems this package has a build for. Omit it
  // unless the plugin ships native modules for only some. See "platforms" below.
  "platforms": ["darwin"],

  // Path to the compiled ESM entry, relative to the plugin directory.
  // Optional — plugins with only static contributions (a skills-only or
  // recipes-only plugin) don't need one.
  "main": "dist/index.js",

  // Host version compatibility. Optional but strongly recommended.
  // Uses semver range syntax.
  "engines": {
    "daintree": ">=0.11.0",
  },

  // Short name for the plugin's MCP server, the one server agents in
  // Daintree's terminals see for its database tools and agentMcp tools:
  // "planner" → daintree-planner. Optional; without it the name is the last
  // segment of `name`. 1-16 lowercase letters, digits or hyphens; keep it
  // specific. See `mcpName` below and ./agent-extensions.md#one-server-per-plugin.
  "mcpName": "planner",

  // Declared capabilities, listed in the install confirmation for an archive
  // opened from the OS and in the plugin manager after install.
  // Disclosure-first with host-side policy effects (no Node sandbox).
  // See "Capabilities" below and ./trust-model.md.
  "capabilities": ["fs:project-read", "network:fetch"],

  // Per-capability allowlists that attenuate the capability lattice.
  // Optional. scopes.network.allowedUrls and scopes.fs.allowedPaths reject
  // wildcards and private/loopback targets. See ./trust-model.md.
  "scopes": {
    "network": { "allowedUrls": ["https://api.acme.com/v1"] },
    "fs": { "allowedPaths": ["${project}/docs"] },
  },

  // Activation triggers. Optional. Plugins are lazy by default — omitting this
  // field (or passing an empty array) defers the `main` import and `activate()`
  // until a contribution is first used. The sole recognised value,
  // "onStartupFinished", is the explicit opt-in for plugins that must run at
  // boot. Contributions are registered eagerly either way.
  "activationEvents": ["onStartupFinished"],

  // Events that wake the plugin and run one of its own commands. Optional.
  // Each event at most once; "agentWaiting" needs the "agent:read" capability.
  "eventRoutes": [{ "event": "worktreeAdded", "command": "onWorktreeAdded" }],

  // The plugin's UI and functional contributions. Every key is optional.
  "contributes": {
    "commands": [/* palette actions */],
    "panels": [/* panel kinds, each with an optional menu and toolbar of your own actions */],
    "views": [/* the component for a panel, or the plugin's settings section */],
    "settings": [/* values Daintree stores and renders a form for */],
    "databases": [/* SQLite files opened with host.db */],
    "toolbarButtons": [/* ... */],
    "keybindings": [/* ... */],
    "contextMenus": [/* worktree, terminal, file, browser and project menu entries */],
    "menuItems": [/* application menu entries; not under scope: "project" */],
    "agentMcp": [/* tools Daintree serves to terminal agents; requires mcp:expose */],
    "mcpServers": [/* stdio servers Daintree connects to as a client */],
    "skills": [/* markdown knowledge served through Daintree's own MCP server */],
    "recipes": [/* named multi-terminal launch layouts */],
    "promptTemplates": [/* prompts offered in the composer's `/` menu */],
    "worktreeSetupSteps": [/* work done for each new worktree after its setup script */],
    "setup": [/* a short checklist shown until the plugin is set up */],
    "terminalLinks": [/* terminal text and URLs that open with one of the plugin's commands */],
    "contextProviders": [/* @prefix: context the composer resolves at send */],
    "tours": [/* welcome tours for the plugin or one of its panels */],
    "projectTemplates": [
      /* starting files offered in Create project; not under scope: "project" */
    ],
    "agents": [/* requires the agent:register capability */],
    "processTools": [/* command → terminal-tab icon detections */],
    "forgeProviders": [/* ... */],
    "fileDecorationProviders": [/* ... */],
    "surfaces": {/* project-scope only; see "contributes.surfaces" below */},
    "fileEditors": [/* view-backed; a "slot" is built-in only */],
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

The `daintree` publisher is reserved for built-in plugins: a manifest named `daintree.*` anywhere else is rejected (`namespace_reserved`), and at startup Daintree shows an error toast naming the plugin rather than only logging it.

Names are unique per root. Built-ins load first, so an installed plugin that reuses a built-in's name is rejected, and of two installed plugins with the same name the second is rejected and logged. A project plugin is the exception: it may share its name with an installed plugin, and both load as separate instances.

### `version`

Standard semver. `0.1.0`, `1.2.3-beta.1`, etc. Update detection compares archive hashes, not versions ([Distribution → Updating a plugin](./distribution.md#updating-a-plugin)); the version is what the plugin blocklist matches against, what `daintree-plugin package` names the archive after, and what decides whether a remote host is offered **Update on _host_**.

## Optional fields

### `$schema`

The URL of the manifest's JSON Schema, so an editor can complete and check `plugin.json` as you type. The host accepts the key — the manifest is otherwise strict — and never fetches or reads it; its own Zod schema is the authority. `npx daintree-plugin new` writes it for you:

- `https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas/plugin.schema.json` for an installed plugin
- `https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas/plugin.project.schema.json` for a project plugin

Both are generated from the host's schema (`npx daintree-plugin schema [--project]` prints the one your installed `daintree-plugin` was built with) and are structural only: the cross-field rules under [Validation](#validation) are enforced at load, not by the editor.

### `displayName`

The human-readable name shown in UI listings (plugin palette, installed-plugins list). Falls back to `name` if omitted. Not used for runtime lookups — only display.

### `mcpName`

The short name agents see your plugin's MCP server under, as `daintree-<mcpName>` — for example `"ledger"` gives `daintree-ledger`, and Claude names its tools `mcp__daintree-ledger__<tool>`. Lowercase letters, digits and hyphens, 1–16 characters, starting with a letter or digit; `docs` and `runbooks` are taken by the Daintree Assistant's own servers, and `decisions` by the server agents ask the person through (Decisions). Optional: without it Daintree uses the last segment of `name`. It only matters if the plugin declares [databases](./contribution-points.md#databases--shipped) or an [`agentMcp`](./agent-extensions.md#agent-mcp-endpoints) endpoint, and the resulting key is the same in every project; see [Reaching an agent](./agent-extensions.md#reaching-an-agent) for how a clash with another plugin's name is settled.

### `description`

One-sentence description shown in plugin listings. Keep it short; UI truncates long descriptions.

### `tagline`

A one-line value proposition for the plugin catalog. Optional, trimmed, and capped at 120 characters. Distinct from `description`: the tagline is the catalog card's hook, the description is the longer blurb.

### `authors`

Optional attribution credits, surfaced as a "Contributors" block in the plugin detail pane. An array of at most 10 entries; each entry is an object where `name` is required and `url`, `email`, and `role` are optional. Unknown keys on an entry are rejected. `name` is trimmed and must be 1–100 characters. `url` must be `https://` and follows the same rules as `scopes.network.allowedUrls` — no wildcards, no embedded credentials, no private or loopback hosts, and a multi-label hostname — because it surfaces as a user-clickable link; `email` must be a valid address; `role` is a free-form label (e.g. `"Maintainer"`, `"Contributor"`), trimmed and 1–50 characters. The SDK exports the `PluginAuthor` type for authoring against this shape.

```jsonc
"authors": [
  { "name": "Ada Lovelace", "url": "https://ada.example.com", "role": "Maintainer" },
  { "name": "Grace Hopper", "email": "grace@example.com" },
]
```

### `worksWith`

Other plugins this one works with, by manifest id (`publisher.name`), built-ins included. Optional, at most 16 entries, none repeated, and never the plugin's own name. The plugin manager lists them in the detail pane with whether each is installed, installed but turned off, or not installed. It is disclosure and an install hint only: nothing is installed, activated or loaded in any order because of it, and a listed plugin that is missing changes nothing about how this one runs. To work with another plugin at runtime, discover its actions with `host.actions.list()`, which names each one's provider, and call them with `host.dispatch`.

```jsonc
"worksWith": ["acme.linear", "daintree.github"]
```

### `category`

Catalog category for grouping in the plugin manager. Optional enum: `"forge"`, `"ai"`, `"workspace"`, or `"other"`. When omitted, Daintree derives one from what the plugin contributes — forge providers map to `"forge"`; agents, MCP servers, skills or an `agentMcp` endpoint to `"ai"`; panels or views to `"workspace"`; and anything else to `"other"`, checked in that order. Declare it explicitly when a multi-contribution plugin would otherwise be misclassified by derivation.

### `main`

Path to the plugin's compiled ESM entry file, relative to the plugin root. The entry normally exports an `activate` function:

```ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi) {
  // setup code
  return () => {
    // cleanup code (optional)
  };
}
```

Plugins with only static contributions (a skills-only or recipes-only plugin, say) can omit `main` entirely.

- **`activate` is optional.** An entry that exports no `activate` function loads as a contributions-only plugin: the module is imported, and nothing else runs.
- **`activate()` must settle within 5 seconds.** For a plugin running in a worker the budget covers importing the entry as well. A plugin whose activation neither resolves nor rejects in time is recorded as failed and its worker is stopped.
- **Registration closes when `activate()` settles.** The `host.register*` calls work only during activation; after it resolves, rejects or times out they throw. Callbacks that are not registrations, such as toasts, `dispatch` and `settings`, keep working.
- **The entry must stay inside the plugin directory.** A `main` path that escapes the directory is ignored with a warning and the plugin loads without it. For a project plugin the path is also resolved through symlinks, so a `dist/index.js` that is a symlink out of the plugin directory is refused the same way.

### `engines.daintree`

Semver range expressing which Daintree versions the plugin supports. The scaffolder (`npx daintree-plugin new`) generates `">=0.41.0"`, the first release that understands everything a scaffold emits (the 0.1.0 scaffold on npm generates `">=0.11.0"`) — an open-ended lower bound, deliberately not a caret:

- `">=0.41.0"` — 0.41 and every later release (scaffolder default)
- `">=0.11.0"` — 0.11 and every later release
- `">=0.11.0 <0.13.0"` — explicit range
- `"0.11.x"` — any 0.11 release

**Never use a caret on a 0.x range.** `"^0.11.0"` resolves to `>=0.11.0 <0.12.0` under semver's 0.x rule, so it stops matching at the very next minor and the plugin draws a compatibility warning on every release after the one you wrote it against.

If the running Daintree version doesn't satisfy the range, the plugin still installs and loads, and Daintree shows a warning toast (once per session for each plugin version and range) that it may not work on this version. A local dev build such as `0.37.0-dev.<stamp>` is also checked against the release it precedes, so it satisfies `>=0.37.0`. If `engines.daintree` is omitted entirely, Daintree warns in the console but loads the plugin anyway.

Daintree is pre-1.0, and a plugin that works on Daintree 0.11 may not work on 0.12 without changes. Because an unmet range only warns, set the lower bound to the release you tested against and test again when a new minor ships.

`engines` is the one manifest object that is not strict: `daintree` is its only recognised key, and any other key (`"node"`, `"vscode"`) is dropped without an error rather than rejected.

### `scope`

The only accepted value is `"project"`, and it declares that the plugin is a **project-local** plugin — one that lives in a project's own repository at `<projectRoot>/.daintree/plugins/` and loads only while that project is open. Omit the field entirely for a normal, app-wide plugin.

The manifest gate enforces it in both directions, against the root the manifest was discovered under:

- Discovered under a project's `.daintree/plugins/` **without** `"scope": "project"` → rejected (`project_scope_required`). The host will not load a project-local plugin that has not opted in.
- Discovered under the user or builtin plugins root **with** `"scope": "project"` → rejected (`project_scope_not_allowed`).

This is a guardrail against accidental promotion, not a security control — the trust decision is the project folder, not this field. What it prevents is a plugin loading under assumptions its author never made: a project plugin copied into the user directory would go app-wide with project-shaped expectations about its settings tier and its bound project, and a user plugin dropped into `.daintree/plugins/` would load with none of the project-local guarantees. Neither failure is visible at runtime, so both are refused at the gate.

Declaring `"scope": "project"` also changes what the manifest may contribute. `contributes.surfaces` and `"project"` [databases](./contribution-points.md#databases--shipped) become available, and seven contribution groups become unavailable — `menuItems`, `agents`, `processTools`, `mcpServers`, `themes`, `forgeProviders` and `projectTemplates`, each rejected with an error naming the reason (for the first six, the structural reason it cannot yet be narrowed to one project; a template is offered before any project exists). A slot-backed `fileEditors` entry is refused too, as it is for every plugin that is not built in; a view-backed file editor is available, and may also match project-relative `paths`. `agentMcp` stays available, because its credentials are bound to one project. See [Project-local plugins](./project-local.md) and the per-point status in [Contribution points](./contribution-points.md).

### `instanceMode`

`"instanceMode": "project"` opts an **installed** package into running as one independently bound instance per project instead of one app-wide singleton. Absent means singleton, and every existing manifest keeps behaving exactly as before. The package is installed once and admitted to a catalog that runs nothing; each project then enables it separately, and each enabled project gets its own instance keyed `project__{projectId}__installed__{name}` with its own settings, storage, databases, connections and contributions, pinned to that project rather than to whichever project is focused. Closing, disabling or reloading one project leaves the others loaded. An update replaces the package once, purges the instances' capability grants and reloads the still-enabled open projects; an uninstall unloads every instance and forgets where it was enabled.

It is accepted only from the user plugins root, is mutually exclusive with `scope`, and takes the same contribution restrictions as `"scope": "project"` (no forge providers, project templates or other structurally global groups). In exchange an instanced package may declare `"location": "project"` databases.

### `application`

Names a project plugin as its project's application and points at the parts of it the manifest already contributes. Available to `"scope": "project"` plugins only (`application_project_scope_only`), and it requires `engines.daintree` (`application_engine_required`) so the host can check the running version before putting the application in force. It implements nothing: every field is either the application's identity or the bare id of a contribution the same manifest declares.

```json
"application": {
  "name": "Budget",
  "iconId": "wallet",
  "destination": "home",
  "sidebarViewId": "accounts",
  "settingsViewId": "preferences",
  "welcomeTour": { "id": "welcome", "version": 1 },
  "firstWorkflow": "record-transaction",
  "requiredTools": ["ledger"],
  "presentation": { "forgeStats": "hidden", "copyTree": "demoted" }
}
```

| Field | Required | Must name |
| --- | --- | --- |
| `name` | yes | The application's name, 1-64 characters. |
| `iconId` | no | The same vocabulary as a sidebar view's `iconId`. |
| `destination` | yes | `"home"` or `"grid"`. `"home"` needs `contributes.surfaces.projectHome` (`application_home_unclaimed`). |
| `arrangement` | no | `"full"` (the default) or `"beside-grid"`, for a `"home"` destination only (`application_arrangement_needs_home`). `"beside-grid"` opens the project in Split: your Home beside the host's grid, so agents launched and focused there never hide it. The destination and arrangement are a default; the user's own Home, Split or Grid choice always wins. |
| `sidebarViewId` | no | A `contributes.views` entry with `location: "sidebar"` (`application_sidebar_view_unknown`). |
| `settingsViewId` | no | A `contributes.views` entry with `location: "settings"`, the application's settings home (`application_settings_view_unknown`). |
| `welcomeTour` | no | `id`: a `contributes.tours` entry with no `panelKind` (`application_tour_unknown`, `application_tour_panel_scoped`). `version`: a positive integer, raised when the tour is worth offering again. |
| `firstWorkflow` | no | The bare id of a `contributes.commands` entry of kind `"command"` (`application_command_unknown`, `application_command_query`). |
| `requiredTools` | no | `contributes.agentMcp` endpoint ids (`application_tool_unknown`), at most as many as a plugin may declare. Declaring one grants no access. |
| `presentation` | no | Presentation features and levels the host offers (`application_presentation_unknown`, `application_presentation_level`). |
| `navigation` | no | The application's sections, below. Self-contained: it names no view, command or URL. |

The object is strict, so nothing undeclared rides along, and it holds no credentials, settings values or customer data.

At most one plugin in a project declares an application. Cooperating plugins contribute their own parts and are listed in [`worksWith`](#workswith); a second declaration makes the application unavailable rather than picking a winner. An owner whose `engines.daintree` range excludes the running Daintree is not loaded at all, unlike a plugin without an application, for which the range only warns. The host resolves the application each time the project's plugins change and sends it to the project's views with their plugin inventory, as one of:

- `loading` — the owner is trusted and has not finished loading.
- `active` — the owner is loaded and the application is in force.
- `disabled` — the project's plugins are not trusted, or the owner is muted or waiting to be turned on.
- `unavailable` — the owner failed to load, its `engines.daintree` range excludes the running Daintree, or a second plugin also declares an application.
- `replaced` — the owner is loaded, but another plugin holds the project Home it opens on.

Anything but `active` means the standard workspace. The descriptor and its state are a contract for the host's own application features to build on, and resolving the application writes nothing. Its defaults will never outrank the user: an answer the user gave about Home, a surface or the project's presentation profile stands.

While the application is `active`, its `welcomeTour` is offered once per project on each machine: a strip on the project's Home or grid with Start and Skip, shown in the view on screen once the project's first-open layout is done with and no dialog is open. It never plays on its own. Skipping or finishing it is remembered against the declaring plugin, the tour and its `version`, so raising `version` offers it again; the tour stays in Help to replay any time. Once it is answered, `firstWorkflow` is offered as a button on the same strip, and runs only when the user presses it. Nothing in this flow starts an agent, a recipe, an install or any external work.

#### `application.navigation`

The sections the application's views navigate between. The host keeps one location and history per project for them and hands it to every view of the application as [`PanelViewProps.navigation`](./views.md#application-navigation), so the sidebar view, the Home and the panels select the same thing.

```json
"navigation": {
  "version": 1,
  "defaultSectionId": "accounts",
  "sections": [
    { "id": "accounts", "title": "Accounts" },
    {
      "id": "account",
      "title": "Account",
      "params": {
        "accountId": { "type": "string", "required": true, "persist": true, "maxLength": 64 },
        "page": { "type": "integer" }
      }
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | A positive integer. Raising it drops every saved location and history, so a renamed parameter never restores with its old meaning. |
| `defaultSectionId` | yes | A declared section that requires no parameters (`application_navigation_default_unknown`, `application_navigation_default_requires_params`): where navigation starts, and where a location that no longer resolves lands. |
| `sections` | yes | 1-24 sections with unique ids (`application_navigation_section_duplicate`). `title` is 1-64 characters. |
| `sections[].params` | no | At most 8 parameters. `type` is `"string"`, `"integer"` (a safe integer) or `"boolean"`; `maxLength` (strings only, default 64, at most 128); `required` and `persist` default to `false`. |

Parameters are identifiers, not content. A string holds only `A-Z a-z 0-9 . _ -`, so free text, URLs and tokens can't be expressed, and a location carrying anything undeclared is refused. Only parameters marked `persist` are written to disk; the rest last as long as the project's renderer (a remount keeps them, an evicted renderer or a restart doesn't), and an entry whose required parameter isn't persisted restores as the default section. Navigation is local to the project's window: there is no `daintree://` route to a section and it runs no action.

### `remote`

`"supported"` (the default when omitted) or `"unsupported"`. Plugin main code always runs on the machine the project lives on; this field is about windows attached to that machine from another one.

Declare `"remote": "unsupported"` when the plugin only works for a person sitting at the machine it runs on — a view that assumes the renderer's `localhost` is the project's machine, or code that relies on local OS behaviour. The host then never starts the plugin for a window on another machine: that window shows a placeholder naming the machine the plugin needs, calls to it are refused with a `PLUGIN_INCOMPATIBLE` error, and each refusal is logged.

### `platforms`

Optional. A list drawn from `"darwin"`, `"linux"` and `"win32"` (Node's `process.platform` names) naming the operating systems the package has a build for. Omit it for a plugin that runs anywhere, which is nearly all of them.

Declare it when the package carries native modules built for only some systems. It is checked when a plugin is installed on a remote host: a package sent to a host whose OS isn't listed is refused before anything is copied, with a message naming the plugin and the machine. When an installed plugin has native modules (`*.node`) but no `platforms`, Daintree reads the modules' binary headers and treats the plugin as built only for the OSes they name, so **Install on _host_** for another machine is refused before copying. A `.dntr` dropped straight onto a remote window is checked against its declared `platforms` only. An ordinary install on this machine — from a file, a URL or `daintree-plugin install` — does not check `platforms`.

### `capabilities`

Array of capability tokens the plugin wants. The model is **disclosure-first with host-side policy effects** — there is no Node sandbox, so a plugin is not blocked from doing anything regardless of what it declares, but declared tokens are not purely advisory. Seven high-risk tokens (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`) raise the plugin's actions to a confirm dialog (`effectiveDanger: "confirm"`) via the host's `CONFIRM_TRIGGERING_CAPABILITIES` set — by default every action, though a command can narrow which capabilities that derivation consults with [`requires`](./contribution-points.md#commands--shipped). `socket:connect` is deliberately excluded from that set: the host has no interception point for `node:net`, so elevating on a token it cannot enforce would buy friction without buying safety. `mcp:expose` is not in the set either: it gates `host.mcp.registerTools` and the `agentMcp` contribution, and what it would expose is held behind a separate per-project agent access setting instead. See the [trust model](./trust-model.md) for the full contract.

| Token | Intent |
| --- | --- |
| `fs:project-read` | Read project-class paths through `host.fs`, and open or reveal them with `host.system` (see [Filesystem root classes](#filesystem-root-classes)) |
| `fs:project-write` | Write project-class paths through `host.fs` and `host.documents.renderPdf`. Required by a `"project"` database |
| `fs:user-data-read` | Read user-data-class paths: the plugin's own data directory and literal `allowedPaths` under the home directory |
| `fs:user-data-write` | Write user-data-class paths, including the plugin's own data directory |
| `network:fetch` | Make outbound HTTP requests. Disclosure and danger input only — no host API is gated on it |
| `agent:invoke` | Drive AI agents from plugin code. Disclosure and confirm elevation only — no host API is gated on it |
| `agent:read` | Observe agent state (`host.getAgentState`, `host.onDidChangeAgentState`: lifecycle phase, session cost/tokens on completion), observe terminals starting, exiting, being trashed and restored (`host.onDidChangeTerminalLifecycle`: metadata only) and list the project's agent panes (`host.agents.list`); installed and built-in plugins can also list every agent in every open project (`host.agents.listAll`, `host.onDidChangeAllAgents`) |
| `agent:register` | Register a launchable agent CLI as a selectable agent |
| `terminal:read` | Read a terminal's current screen as plain text (`host.terminals.readScreen`). Terminals show secrets, so this is separate from `agent:read` and asks for JIT consent on first use |
| `agent:input` | Send text to the active agent terminal (`host.sendToActiveAgent`) or append it to a chosen agent's draft (`host.sendToAgent`); JIT consent on first use |
| `git:read` | Read git state through `host.git.status` and `host.git.diff` |
| `git:write` | Stage and commit through `host.git.add` and `host.git.commit`; JIT consent on first use |
| `clipboard:read` | Read from the system clipboard |
| `clipboard:write` | Write to the system clipboard (text, and PNG images via `host.clipboard.writeImage`) |
| `shell:exec` | Spawn subprocesses (managed via `host.process`) |
| `socket:connect` | Connect to local Unix-domain sockets or Windows named pipes (e.g. the Docker socket). Disclosure only — no host API is gated on it, and it takes no part in the danger derivation |
| `mcp:expose` | Serve `contributes.agentMcp` tools to agents in Daintree's terminals (`host.mcp.registerTools`). Required by `agentMcp`; exposes nothing until the plugin's agent access is turned on for a project |
| `panel:focus-read` | Observe which kind of panel has focus (`host.onDidChangeFocusedPanel`): a built-in kind (`terminal`, `browser`, `diff`, …), `plugin` for any plugin panel, `portal`, or `null` when Daintree isn't the foreground window or no panel has focus, plus an agent flag and the worktree id. Never a panel's id, title, URL or content. A project plugin sees focus only inside its own project |
| `project:dispatch` | Run actions in a named project with `host.dispatch(actionId, args, { projectId })`; an installed plugin needs it for any explicit `projectId`, even the focused project's. Enables nothing until the user turns on **Allow project targeting** for the plugin, and there is no first-use prompt: the switch is the whole grant. A project plugin can never target another project, whatever it declares; naming its own project needs no capability ([host API → Targeting a project](./host-api.md#targeting-a-project)) |

Declare honestly. A `.dntr` archive opened from the operating system shows a confirmation before anything is installed, listing each declared capability with its severity alongside any contributed recipes; the plugin manager's detail pane lists the same capabilities after install. Installing from the plugin manager itself, from a chosen file or a URL, shows no such list first. Users judge plugins by what they ask for; the host also derives policy from the high-risk tokens above. A plugin declaring `shell:exec` for no obvious reason looks suspicious. A plugin that silently executes shells without declaring it damages the ecosystem — and for the most part nothing at runtime stops it, which is exactly why honest declaration matters. The clearest runtime-enforced exception is `host.process.spawn` (see [host API](./host-api.md#process--managed-child-processes)): the managed-process surface rejects unless the plugin declared `shell:exec`. `host.mcp.registerTools` is gated on `mcp:expose` the same way. A plugin can still `require("child_process")` directly to bypass that — the gate is on the managed surface, not a Node sandbox — but the managed surface is the supported, supervised path. The [trust model](./trust-model.md#host-api-gates) lists every host API a capability gates.

#### Compound danger

Some capabilities are harmless alone and dangerous together, so the host also raises a plugin's actions to confirm when its declared set forms one of two combinations, even if none of the seven high-risk tokens is present:

- **Sensitive read plus an unconstrained sink.** The sensitive reads are `agent:read`, `terminal:read`, `git:read`, `fs:project-read` and `fs:user-data-read`. Any of them paired with `shell:exec`, or with `network:fetch` when `scopes.network.allowedUrls` is not declared, elevates.
- **Unconstrained network plus a local mutation.** `network:fetch` without `scopes.network.allowedUrls`, paired with `fs:project-write`, `fs:user-data-write`, `git:write` or `shell:exec`, elevates.

A non-empty `scopes.network.allowedUrls` takes `network:fetch` out of both rules. `clipboard:read`, `clipboard:write` and `socket:connect` take no part in either. A command's [`requires`](./contribution-points.md#commands--shipped) narrows the set both rules consult, as it does for the high-risk tokens. The same derivation also produces a single verdict for the whole plugin, `"safe"` or `"confirm"`, which the plugin manager shows.

### `scopes`

Per-capability allowlists that declare what a capability intends to reach. Both buckets are schema-validated, but neither is a runtime sandbox — they do not block actual calls or writes. Two buckets, with different runtime weight today:

- `scopes.network.allowedUrls` — outbound request targets the plugin intends to reach under `network:fetch`. Each entry must be an `https://` URL with no wildcard, no embedded credentials, and a multi-label public hostname; private and loopback targets are rejected. **Live but advisory:** a non-empty allowlist suppresses the compound-capability elevation (the host won't force a confirm dialog when `network:fetch` is paired with a sensitive read), proving the fetch is tightly bound rather than a generic exfiltration channel. It does not actually block requests to other URLs.
- `scopes.fs.allowedPaths` — absolute paths the filesystem capabilities may touch. Entries may also use the dynamic tokens `${project}` or `${worktree}` (optionally with a `/sub/path` suffix, e.g. `"${project}/src"`), which expand at call time: `${project}` to the project's main worktree, `${worktree}` to the current worktree. Wildcards, relative paths, `..` segments, and unknown tokens are rejected by the manifest schema. Whether a literal path is absolute is checked with the platform's own rules, so a Windows entry such as `C:\data` fails validation on macOS and Linux. **Enforced for the host-mediated surface:** every path argument to `host.fs.*`, `host.git.*`, `host.system.openPath` / `showItemInFolder` and `host.documents.renderPdf` is realpath-resolved and contained to one of these roots (traversal and symlink-escape rejected, mirroring the `plugin://` protocol handler); an out-of-scope path rejects with a `PATH_NOT_ALLOWED:` prefix. It still does not attenuate the compound-capability lattice (fs writes elevate unconditionally). **Honest scope limit:** this enforces the sanctioned, audited `host.fs`/`host.git` path only — a plugin's `main` is un-sandboxed Node code (it runs in the plugin worker with full filesystem privileges) and can still call raw `node:fs` directly, which the host cannot intercept without a real sandbox. `allowedPaths` contains the host-mediated surface; it does not seal the un-mediated one.
- `scopes.socket.allowedPaths` — local endpoints the plugin intends to connect to under `socket:connect`: absolute Unix-domain socket paths (`/var/run/docker.sock`) and/or Windows named pipes (`\\.\pipe\docker_engine`). Both forms are accepted on every platform, so a cross-platform manifest parses everywhere it's read. Wildcards, relative paths, and `..` segments are rejected. **Purely advisory:** nothing enforces this, because a plugin's `main` reaches `node:net` directly and the host has no interception point. It exists so the plugin manager can render "connects to `/var/run/docker.sock`" instead of the bare capability — which is the entire value of the disclosure. Optional; declare `socket:connect` without it if the endpoint varies.

A misspelled bucket (e.g. `networking`) is rejected as a manifest error rather than silently dropped, and a bucket that is present must list at least one entry. See the [trust model](./trust-model.md) for the full scopes semantics and how they compose with capabilities.

#### Filesystem root classes

The roots a plugin's host-mediated filesystem calls are contained to, and the capability each one needs:

- **The plugin's data directory**, `~/.daintree/plugin-data/<pluginId>/`, is always an allowed root, declared or not. It is user-data class. `host.git` does not treat it as a root.
- **A project plugin's own project root** is allowed implicitly while `allowedPaths` is absent, as project class. Declaring `allowedPaths` replaces it rather than adding to it, so a project plugin that declares a list and still wants its root lists `${project}`. An installed plugin gets no implicit root.
- **`${project}` and `${worktree}` entries** are project class. A project plugin's tokens expand only against its own project, never the one in focus. A token with no live worktree to expand to is dropped for that call, so a path that only it would have matched is refused rather than allowed.
- **Literal paths** are classed by location: under the home directory they are user-data class, anywhere else project class. Most projects live under the home directory, so a literal `/Users/me/proj` needs `fs:user-data-read` or `fs:user-data-write`, not the `fs:project-*` pair; use a token to reach a project as project class.

A read needs the read capability for the class of the root the path resolves into, and a write the write capability for that class. `host.system.openPath` and `showItemInFolder` accept either. A path outside every root rejects with `PATH_NOT_ALLOWED:`, and a missing capability with `PERMISSION_REQUIRED:`.

### `activationEvents`

Activation triggers. The sole supported value is `"onStartupFinished"`, which activates the plugin once the app finishes starting. Any other value, such as a VS Code-style `"onCommand:…"`, is a validation error.

Plugins are lazy by default. Omitting `activationEvents` (or passing an empty array) defers the plugin's `main` module import and `activate()` call until something first needs it:

- a contributed command is dispatched;
- a forge provider or file decoration is queried;
- a contributed panel view is opened, or the plugin's `location: "settings"` or `location: "sidebar"` view is mounted;
- a view calls into one of the plugin's channels with `window.electron.plugin.invoke`;
- an agent's MCP session reaches the plugin's server.

Some user actions activate a plugin at once whatever it declares: installing or updating it, re-enabling it, and linking it with `daintree-plugin dev`.

List `"onStartupFinished"` to opt a plugin into eager activation when it genuinely needs to run at boot. Either way, contributions (commands, panels, keybindings, …) are registered eagerly from the manifest at startup — only the `main` import and `activate()` call are governed by activation, so a lazy plugin's commands and panels still appear in the palette before any of its code runs.

A plugin that only needs to react to something happening should use [`eventRoutes`](#eventroutes) instead of activating at startup to subscribe.

### `eventRoutes`

Events that wake the plugin and run one of its own commands. The host listens on the plugin's behalf: when an event happens it activates the plugin if it is not running and runs the command with the event's payload. A route is not a live subscription, so a plugin that reacts only through routes stays eligible for [idle disposal](./architecture.md#worker-crashes-and-idle-disposal) and is woken again by its next event.

```json
"eventRoutes": [
  { "event": "agentWaiting", "command": "onAgentWaiting" },
  { "event": "worktreeAdded", "command": "onWorktreeChange" },
  { "event": "worktreeRemoved", "command": "onWorktreeChange" }
]
```

`command` is the bare `id` of a `contributes.commands` entry in the same manifest; a route cannot name an imperative `host.registerAction` action, which would not exist once the worker is disposed, or a command declared `danger: "confirm"`, since nobody is there to confirm it. Each event may be routed once, and several events may share a command.

The events are a closed list. Each fires on the transition only, and its payload is what the matching live subscription delivers, under the same capability and project rules:

| `event` | Fires when | The command's argument | Needs |
| --- | --- | --- | --- |
| `agentWaiting` | an agent moves into `waiting` | `{ event, agent }`, `agent` as `onDidChangeAgentState` delivers it | `agent:read` |
| `worktreeAdded` | the worktree set gains a worktree | `{ event, worktrees, change }`, as `onDidChangeWorktrees` delivers them | — |
| `worktreeRemoved` | the worktree set loses a worktree | `{ event, worktrees, change }` | — |
| `projectForeground` | a project comes to the foreground | `{ event, presence }`, as `onDidChangeProjectPresence` delivers it | — |

The argument's type is `PluginEventRouteWake` in `@daintreehq/plugin-sdk`; narrow it on `event`. A worktree route's `change` is what changed since the read before, or the net of every read while the wake waited its turn. A project plugin hears about its own project only, as its subscriptions do.

Wakes are best effort, not a log:

- Nothing is replayed when the plugin loads: an agent already waiting or a project already in front does not wake it.
- A burst coalesces to the latest value per terminal, per project or per worktree route, and a plugin is woken at most about once a second. Wakes waiting their turn are held, not queued without bound.
- A transition that reverses before its wake runs cancels it: an agent that stopped waiting, a project sent back, a worktree removed again.
- Nothing is delivered while the plugin's worker has failed, including its crash loop, and events missed meanwhile are not replayed. Routes resume once the plugin is restarted or used again.
- The command runs with no view behind it: `when` and `enablement` clauses are not consulted, and a declared `inputSchema` must accept the wake object.
- A failed wake is not retried, whether the command threw or the wake was too large to send (the 4 MiB argument cap of any invoke). The failure is logged and audited.

### `contributes`

Object containing an array per contribution type (`panels`, `toolbarButtons`, `menuItems`, `keybindings`, `contextMenus`, `commands`, `views`, `mcpServers`, `agentMcp`, `databases`, `tours`, `skills`, `forgeProviders`, `fileDecorationProviders`, `worktreeDeleteNotes`, `agents`, `processTools`, `settings`, `recipes`, `promptTemplates`, `worktreeSetupSteps`, `setup`, `terminalLinks`, `contextProviders`, and `fileEditors`, whose slot-backed entries are built-in only) — plus the non-array `surfaces`, `services`, `account` and `assistantKnowledge` objects and the optional `connections` array. All are optional; unlisted types default to empty. Each array has an upper bound (`MANIFEST_CONTRIBUTION_CAPS` in `electron/schemas/plugin.ts`) generous for any real plugin and there to reject pathological manifests:

| Contribution              | Max entries                               |
| ------------------------- | ----------------------------------------- |
| `panels`                  | 50 (each panel's `menu`: 5, `toolbar`: 3) |
| `toolbarButtons`          | 100                                       |
| `menuItems`               | 200                                       |
| `keybindings`             | 200                                       |
| `contextMenus`            | 200                                       |
| `commands`                | 200                                       |
| `views`                   | 50                                        |
| `mcpServers`              | 20                                        |
| `agentMcp`                | 1                                         |
| `databases`               | 16                                        |
| `skills`                  | 50                                        |
| `recipes`                 | 50                                        |
| `promptTemplates`         | 50                                        |
| `worktreeSetupSteps`      | 10                                        |
| `setup`                   | 10                                        |
| `terminalLinks`           | 20                                        |
| `contextProviders`        | 10                                        |
| `tours`                   | 10                                        |
| `forgeProviders`          | 20                                        |
| `fileDecorationProviders` | 50                                        |
| `worktreeDeleteNotes`     | 1                                         |
| `agents`                  | 50                                        |
| `processTools`            | 100                                       |
| `settings`                | 200                                       |
| `fileEditors`             | 10                                        |

Validation is structural as well as per-field: duplicate ids within one array are rejected (`duplicate_contribution_id`), and cross-references have to resolve — a panel view's `id` must name a declared panel (a settings view must not), a panel `menu` or `toolbar` entry, toolbar button, menu item, keybinding or context menu naming an action in your own namespace must match a declared command when you declare any, a tour's `panelKind` must name a declared panel, a forge provider's `settingsScopeRef` / `viewRefs` must name declared settings / views, a `surfaces` slot's `viewId` must name a declared panel view, and a `${settings:…}` token in an MCP server's `command` / `args` / `env` must name a declared setting. Capability rules are checked too: `agents` needs `agent:register`, `agentMcp` needs `mcp:expose`, and a `"project"` database needs `scope: "project"` and `fs:project-write`.

A few notes on individual points; the [Contribution points reference](./contribution-points.md) has the full shape and per-point status for every one, and marks what only a built-in plugin may declare.

- `views` — a `location: "panel"` view is the component for the panel with the same `id`, wherever that panel sits. A `location: "settings"` view is the plugin's one custom settings section, mounted below its generated settings fields; it names no panel. A `location: "sidebar"` view is a sidebar view, chosen from the sidebar header's switcher beside the worktree list; it names no panel either, and carries its own `name`, `iconId`, `priority` and `when`. See [Views](./contribution-points.md#views--shipped).
- `mcpServers` — the declared `command` is lazily spawned as a real subprocess the first time its tools are listed or called, and is supervised (killed on Daintree exit; on crash it transitions to `crashed`, the calls in flight reject, and the next listing or call spawns it again — there is no automatic retry or backoff). Treat a contributed MCP server as trust-gated, not inert. Daintree is the server's client: the plugin manager lists and restarts it, nothing in Daintree calls its tools today, and agents running in terminals never see them.
- `panels` — a panel's optional `menu` offers up to five of the plugin's own actions in that panel's ⋯ and right-click menus (on a `hasPty: true` panel, the right-click menu only), each `{ actionId, label? }` and dispatched with `{ panelId }`; a built-in or another plugin's action is refused. The host adds its own entries for the plugin below them. An optional `toolbar` draws up to three of the plugin's own actions as buttons in the panel header, each `{ actionId, label?, iconId?, status? }`, under the same namespace rule; a `toolbar` on a `hasPty: true` panel is refused. See [Panel menu](./contribution-points.md#panel-menu) and [Panel toolbar](./contribution-points.md#panel-toolbar). A panel declaring `reportsActivity: true` lets the plugin report its own work on that kind's panels with [`host.setPanelActivity`](./host-api.md#setpanelactivity), and the plugin manager says so.
- `databases` — SQLite files the plugin opens with `host.db`. A `"project"` database (the default) lives in the repository, at `path` relative to the project root or `.daintree/data/<manifestId>/<id>.db`, and needs `scope: "project"` plus `fs:project-write`; a `"local"` one lives in the plugin's own data directory and needs no capability. Declaring one also puts the host's read-only `database_schema` and `database_query` on the plugin's MCP server for agents, plus a tool for each of its declared `queries`, and gives every panel of the plugin a **Back up data…** menu entry. See [Databases](./contribution-points.md#databases--shipped).
- `tours` — welcome tours that play in Daintree's tour dialog, offered from Help and the palette, or from one panel's menus when `panelKind` names it. See [Tours](./contribution-points.md#tours--shipped).
- `agentMcp` — the inbound direction: an MCP tools endpoint Daintree hosts for agents in its terminals, with the tools registered from `activate()` through `host.mcp.registerTools`. Requires the `mcp:expose` capability; one endpoint per plugin, served on the plugin's one MCP server beside the host's database tools; allowed under `scope: "project"`. See [Agent MCP endpoints](./contribution-points.md#agent-mcp-endpoints--shipped).
- `settings` — each entry is a value Daintree stores and renders a form field for. `type` is `string` (default), `number`, `boolean`, `enum`, `json`, `secret`, `path`, `directory` or `file`; `scope` is `user` (default, app-wide), `project` (committed under the project's `.daintree/plugin-settings/`) or `local` (per project, this machine only). `required: true` puts a "needs setup" strip on the plugin's panels until the value is stored; `editor: "view"` hands the field to the plugin's settings view instead of the generated form. A `secret` is encrypted at rest through the OS keychain, never written into the repository even in `project` scope, and may not declare a `default`. Declaring any setting, or a settings view, gives every panel of the plugin a **Plugin settings…** menu entry. Full field reference in [Contribution points → Settings schema](./contribution-points.md#settings-schema--shipped).
- `account` — one online account the host signs in to for the plugin. `kind: "oauth2"` declares `authorizeUrl`, `tokenUrl`, `clientId` and optional `scopes`, and the host runs an authorization-code flow with PKCE (S256) as a public client through a `127.0.0.1` loopback redirect, so the service must accept `http://127.0.0.1:<any port>/oauth/callback`. `kind: "token"` asks the user to paste an API token. Both take a `label`, an optional `description`, and an optional `identity: { url, field }`: a GET with the access token as a bearer whose JSON response names the account at the dotted `field` ("Connected as …"); for a pasted token, a 401 or 403 there refuses the token. Every URL must be public `https:` with no credentials or fragment, and requests to them refuse redirects. Requires the `network:fetch` capability. The host draws the Connect / Disconnect row in the plugin's settings (the plugin manager for an installed plugin, Project settings for a project plugin, whose account is per project), keeps the tokens in the OS keychain, and gives the plugin only a current access token through [`host.account`](./host-api.md#account--host-managed-sign-in). From a window attached to another machine the browser opens on that machine and its own loopback catches the redirect, while the host exchanges the code and keeps the tokens; see [Host API → `account`](./host-api.md#account--host-managed-sign-in).
- `connections` — named accounts (#14102), for a plugin that talks to several services or lets the user keep several accounts of one ("work", "personal"). Up to 8 entries, each an `account` declaration plus an `id` of 1–32 lowercase letters, digits or dashes starting with a letter; ids are unique. Declare `account` or `connections`, never both: `account` is shorthand for one connection named `"default"`, and an account already stored under it keeps working if you later write the same declaration as `connections: [{ "id": "default", … }]`. Either form also takes an optional `test: { url }`, a bearer GET the settings row's **Test** runs (2xx accepted, 401/403 refused); without it Test asks `identity.url`. Each connection gets its own row with Connect, Test, Reconnect and Disconnect, and Project settings offers a picker for which connection the project uses. See [`host.account`](./host-api.md#account--host-managed-sign-in) for selection, bindings, and machine-shared versus project-private connections.
- `services` — an object of two lists for cooperating plugins (#14105). `provides` (up to 16) declares services other plugins may call, each `{ name, version, methods }`: `name` is `{this plugin's id}.{name}`, `version` a strict semver version, and `methods` 1–32 identifier-shaped method names bound with `host.registerService`. `requires` (up to 16) declares the services this plugin calls, each `{ name, range, optional? }` with a semver `range`; a plugin can't import its own. Nothing is installed or ordered from either list: imports resolve when called. See [Services between plugins](./host-api.md#registerservice-and-services--services-between-plugins).
- `promptTemplates` — declarative prompts for the composer's `/` menu, requiring no capability. See [Prompt templates](./contribution-points.md#prompt-templates--shipped).
- `worktreeSetupSteps` — steps the plugin runs for each worktree Daintree creates, after the project's setup script, once the user allows them for the project. The handler is bound in `activate()` with `host.registerWorktreeSetupStep`. See [Worktree setup steps](./contribution-points.md#worktree-setup-steps--shipped).
- `setup` — a short checklist of what the plugin needs before it's useful. Each step says how the host tells it's done (a setting is stored, the account is connected, a `when` clause over your context keys holds) and what clicking it does (open a setting, run one of your own commands). The host works the progress out itself and shows it on the plugin's panels ("Acme setup · 1 of 3") and at the top of its settings; only the user's **Skip** is remembered, per project. See [Setup checklist](./contribution-points.md#setup-checklist--shipped).
- `terminalLinks` — bounded patterns and URL hosts the host makes clickable in terminals, each dispatching one of the plugin's own commands, requiring no capability. See [Terminal links](./contribution-points.md#terminal-links--shipped).
- `contextProviders` — an `@{prefix}:` the agent composer offers, answered by `host.registerContextProvider` from `activate()` and read when the user sends. No capability. See [Context providers](./contribution-points.md#context-providers--shipped).
- `skills` and `recipes` — declarative content, requiring no capability. Skills are markdown served to agents through Daintree's own MCP server; recipes are named multi-terminal launch layouts, registered app-wide and immutable to the user. See [Skills](./contribution-points.md#skills--shipped) and [Recipes](./contribution-points.md#recipes--shipped).
- `assistantKnowledge` — Markdown for the Daintree Assistant about the plugin's agent tools: `instructions`, `skills` and `references`, delivered only while the user has given the Assistant those tools. No capability, but the plugin must declare `agentMcp` or `databases`. See [Agent extensions → Knowledge for the Assistant](./agent-extensions.md#knowledge-for-the-assistant).
- `agents` — registers a launchable agent CLI as a selectable agent. Requires the `agent:register` capability; the schema rejects the contribution without it. An optional `detection` block wires it into the same agent-state UI built-in agents use.
- `worktreeDeleteNotes` — one check that adds the plugin's notes to a worktree's delete confirmation, bound in `activate()` through [`host.registerWorktreeDeleteNotesProvider`](./host-api.md#registerworktreedeletenotesprovider). Declaring it is what lets a confirmation find, and activate, the plugin. Notes only annotate; they never change the delete. Requires no capability; allowed under `scope: "project"`. See [Worktree delete notes](./contribution-points.md#worktree-delete-notes--shipped).
- `forgeProviders` and `fileDecorationProviders` — the manifest entry is read eagerly so the host's routing tables are populated before any plugin code runs; the implementation binds lazily in `activate()`. Forge providers are **built-in plugins only** — their host methods are synchronous and cannot cross the plugin worker's message port.
- `surfaces` — **project-scope only.** An object, not an array: fixed slots a project-local plugin claims to replace one of the host's own surfaces for its own project. `emptyCanvas`, `projectHome` and `worktreeCreate` (each `{ "viewId": "..." }`) are the slots accepted today; `viewId` must name a declared `contributes.views` entry, and at most one plugin holds a slot per project: project plugins first, then the lower manifest id, whatever order they load in. A manifest without `"scope": "project"` that declares any surface is rejected. See [Project-local plugins → Surfaces](./project-local.md#surfaces).

> `views` and `mcpServers` were named `experimental_views` and `experimental_mcpServers` until #10466. The old keys are still accepted as deprecated aliases — a manifest using them parses and runs identically, but logs a one-time deprecation warning naming the stable replacement. Rename to `views` / `mcpServers`; the aliases may be removed in a future major.

## An app-style project plugin

A project plugin that is really an application — here a household budget committed to the project's own repository at `.daintree/plugins/acme.budget/` — typically combines a database, settings, a panel with its own menu, and a command to open it:

```json
{
  "$schema": "https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas/plugin.project.schema.json",
  "name": "acme.budget",
  "version": "0.1.0",
  "displayName": "Budget",
  "description": "Household budget: transactions, categories and budgets.",
  "scope": "project",
  "main": "dist/index.mjs",
  "engines": { "daintree": ">=0.39.0" },
  "capabilities": ["fs:project-write", "agent:input"],
  "contributes": {
    "databases": [
      {
        "id": "ledger",
        "description": "Transactions, categories and budgets.",
        "path": "data/budget.db"
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
        "title": "Open budget",
        "description": "Open the budget panel.",
        "category": "Budget",
        "kind": "command",
        "danger": "safe",
        "requires": []
      },
      {
        "id": "send-uncategorised",
        "title": "Send uncategorised transactions to an agent",
        "description": "Draft the uncategorised transactions into an agent's input for review.",
        "category": "Budget",
        "kind": "command",
        "danger": "safe",
        "requires": ["agent:input"]
      }
    ],
    "panels": [
      {
        "id": "main",
        "name": "Budget",
        "iconId": "wallet",
        "color": "var(--theme-category-green)",
        "stateVersion": 1,
        "menu": [
          { "actionId": "acme.budget.send-uncategorised", "label": "Send uncategorised to agent…" }
        ]
      }
    ],
    "views": [
      { "id": "main", "componentPath": "dist/panel.js", "location": "panel" },
      { "id": "connection", "componentPath": "dist/settings.js", "location": "settings" }
    ],
    "toolbarButtons": [
      { "id": "open-budget", "label": "Budget", "iconId": "wallet", "actionId": "acme.budget.open" }
    ]
  }
}
```

What each part buys:

- **`scope: "project"`** makes it a project plugin, loaded only while this project is open. It is what allows a `"project"` database, and why `$schema` names the project variant.
- **`databases`** declares `data/budget.db`, a file in the repository. Once the plugin's agent access is on, agents in the project's terminals read it through the host's `database_query` on the plugin's MCP server; any agent can also open it with `sqlite3`. Writes with rules belong in an `agentMcp` endpoint ([Building apps → Choosing a store](./building-apps.md#choosing-a-store)). A project database needs `fs:project-write`; the worker opens it with `host.db.open("ledger", { migrations })`. Every panel of the plugin gets **Back up data…**.
- **`settings`** declares a committed `currency` shared by everyone who clones the project, and a `bankToken` secret each collaborator enters on their own machine. Both are `required`, so the panel shows a "Budget needs setup" strip until they are stored; `editor: "view"` leaves the token to the plugin's own settings view rather than a generated field. Every panel gets **Plugin settings…**.
- **`views`** pairs `dist/panel.js` with the `main` panel, and declares `dist/settings.js` as the custom settings section, which mounts in Project settings → Plugins.
- **`panels[].menu`** puts **Send uncategorised to agent…** on the panel's ⋯ and right-click menus, dispatched with `{ panelId }`.
- **`commands`** puts both actions in the palette. `agent:input` and `fs:project-write` are high-risk, so without `requires` every action would ask for confirmation; `"requires": []` keeps **Open budget** one click, while `send-uncategorised` names the capability it actually uses and asks first. A project plugin has no other way to bind a handler — the `src/<id>.js` [file convention](./contribution-points.md#commands--shipped) is not probed for project plugins — so the worker (`main`) registers both with `host.registerAction` in `activate()`, passing the same descriptor, `requires` included — the imperative registration replaces the manifest one. The send handler calls `host.sendToAgent`, which drafts into an agent the user picks and never submits.
- **`toolbarButtons`** puts a **Budget** button in the plugin tray that runs `acme.budget.open`.

[Building apps](./building-apps.md) walks through writing the worker and views behind a manifest like this.

## Validation

The manifest is validated by Zod schemas at load time. Common causes of a rejection:

- Plugin name missing the period (`acmelinearplanner`)
- Uppercase in name (`Acme.LinearPlanner`)
- `engines.daintree` isn't a valid semver range
- Capability token not in the allowlist
- Unknown field at the top level (the manifest uses strict validation; typos are rejected)

Where a rejection shows up depends on how the plugin reached Daintree:

- **Installing an archive** fails with one error per issue, each carrying the path that failed; the plugin manager shows the first.
- **A project plugin** that fails validation is listed in the plugin manager with a one-line reason.
- **A `daintree-plugin dev` session** reports the same one-line reason to the CLI.
- **An installed plugin at startup** is skipped, and the issues go to the console log only. The one exception is a reserved `daintree.*` name, which also shows an error toast and records a load error on the plugin.
- **A malformed `contributes.tours` entry** is the one issue the load forgives: at startup and in a dev session that tour is dropped with a console warning and the rest of the plugin loads. Installing an archive and `daintree-plugin validate` still reject the manifest for it.

Run `npx daintree-plugin validate` in your plugin directory to check the manifest locally before packaging.

### What validation does not catch

A few rules are only known when the plugin loads, so a manifest that passes the schema and `daintree-plugin validate` can still fail there:

- **A command id that collides with a built-in action.** The colliding command is not registered and the plugin records a load error, as described under [Commands](./contribution-points.md#commands--shipped).

## Unknown fields

The manifest schema is strict — unknown top-level keys and unknown keys inside `contributes` are rejected. This prevents typos from silently dropping contributions. `engines` is the one exception, as noted [above](#enginesdaintree).

A mistyped top-level key fails with `Unrecognized key: "contribute"`. Where Daintree reports the reason in one line (a project plugin, a dev session), it adds a suggestion when a known key is close: `Unrecognized key: "contribute" — did you mean "contributes" instead of "contribute"?`. `daintree-plugin validate` prints the message as Zod reports it, prefixed with the path, without the suggestion.
