# Manifest Reference

Every plugin has a `plugin.json` at its root. It describes the plugin's identity, its compatibility with Daintree, what it contributes to the UI, and what capabilities it needs.

Daintree reads the manifest eagerly at startup. Contribution points declared here populate the command palette, menus, and toolbars immediately — before any plugin code runs. Plugin code is only imported and executed when something actually triggers it.

## Full schema

```jsonc
{
  // Scoped plugin identifier. Required. Format: "publisher.plugin-name".
  // Must be lowercase, use hyphens (not underscores), and contain exactly one period.
  "name": "acme.linear-planner",

  // Semver version. Required.
  "version": "0.1.0",

  // Human-readable display name. Optional; falls back to `name`.
  "displayName": "Linear Planner",

  // One-sentence description, shown in UI listings.
  "description": "Plan Linear issues as multi-step agent workflows.",

  // Path to the compiled ESM entry, relative to the plugin directory.
  // Optional — plugins with only static contributions (themes, static MCP
  // server configs) don't need one.
  "main": "dist/index.js",

  // Host version compatibility. Optional but strongly recommended.
  // Uses semver range syntax.
  "engines": {
    "daintree": "^0.8.0",
  },

  // Declared capabilities, shown to the user at install time.
  // Disclosure only; not enforced at runtime. See "Capabilities" below.
  "capabilities": ["fs:project-read", "network:fetch"],

  // The plugin's UI and functional contributions.
  "contributes": {
    "commands": [
      /* ... */
    ],
    "panels": [
      /* ... */
    ],
    "toolbarButtons": [
      /* ... */
    ],
    "menuItems": [
      /* ... */
    ],
    "views": [
      /* ... */
    ],
    "mcpServers": [
      /* ... */
    ],
    "skills": [
      /* ... */
    ],
    "keybindings": [
      /* ... */
    ],
    "settings": [
      /* ... */
    ],
    "contextMenus": [
      /* ... */
    ],
  },

  // Explicit activation. Optional. Only "onStartupFinished" is supported.
  // Commands, panels, views etc. are activated implicitly when invoked.
  "activationEvents": ["onStartupFinished"],
}
```

## Required fields

### `name`

Scoped plugin identifier in `publisher.plugin-name` format. Enforced by the regex `^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$` and a 64-character maximum.

- Lowercase only
- Use hyphens, not underscores
- Exactly one period, separating publisher from plugin name
- No spaces, no uppercase

Good: `acme.linear-planner`, `gpriday.cost-management`, `foo.bar-baz`
Bad: `LinearPlanner`, `acme/linear`, `acme.linear.planner`, `Acme.LinearPlanner`

The publisher segment should identify you (GitHub handle, company name, domain prefix). It prevents naming collisions across the ecosystem.

### `version`

Standard semver. `0.1.0`, `1.2.3-beta.1`, etc. Required for update detection.

## Optional fields

### `displayName`

The human-readable name shown in UI listings (plugin palette, installed-plugins list). Falls back to `name` if omitted. Not used for runtime lookups — only display.

### `description`

One-sentence description shown in plugin listings. Keep it short; UI truncates long descriptions.

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

Semver range expressing which Daintree versions the plugin supports. Examples:

- `"^0.8.0"` — 0.8.x or any 0.8+ patch/minor in the 0.x series (semver caret on a 0.x version)
- `">=0.8.0 <2.0.0"` — explicit range
- `"0.8.x"` — any 0.8 release

If the running Daintree version doesn't satisfy the range, the plugin is rejected at load with a user-visible warning toast. If `engines.daintree` is omitted entirely, Daintree warns in the console but loads the plugin anyway.

Daintree is pre-1.0. Pin tightly during this phase — a plugin that works on Daintree 0.8 may not work on 0.9 without changes.

### `capabilities`

Array of capability tokens the plugin wants. This is a **disclosure mechanism** shown to the user at install time, not a runtime sandbox. The plugin is not prevented from doing anything it claims not to need, and is not prevented from doing things it declares.

| Token                | Intent                                                   |
| -------------------- | -------------------------------------------------------- |
| `fs:project-read`    | Read files in the current project worktree               |
| `fs:project-write`   | Modify files in the current project worktree             |
| `fs:user-data-read`  | Read from `~/.daintree/` or elsewhere in the user's home |
| `fs:user-data-write` | Write to `~/.daintree/` or elsewhere in the user's home  |
| `network:fetch`      | Make outbound HTTP requests                              |
| `agent:invoke`       | Send prompts to AI agents from plugin code               |
| `agent:read`         | Observe agent state (token usage, transcripts)           |
| `git:read`           | Read git state (branches, status, log)                   |
| `git:write`          | Make git changes (commits, branches)                     |
| `clipboard:read`     | Read from the system clipboard                           |
| `clipboard:write`    | Write to the system clipboard                            |
| `shell:exec`         | Spawn subprocesses                                       |

Declare honestly even though it's not enforced — the install UI lists what you've declared, and users judge plugins by what they ask for. A plugin declaring `shell:exec` for no obvious reason looks suspicious. A plugin that silently executes shells without declaring it damages the ecosystem.

### `contributes`

Object containing arrays for each contribution type. All fields are optional; unlisted contribution types default to empty arrays. See the full [Contribution points reference](./contribution-points.md) for every type.

### `activationEvents`

Array of explicit activation triggers. Only `onStartupFinished` is supported.

Daintree infers most activation events from contribution points automatically. A plugin declaring `commands[{ name: "foo" }]` implicitly activates when `foo` runs. You don't need to list `onCommand:foo` explicitly — and Daintree will reject it if you try.

Use `onStartupFinished` only for plugins that need to do background work without any user-triggered entry point. Example: a plugin that watches a file and emits notifications. Most plugins don't need this.

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
