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
    "daintree": "^0.11.0",
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

  // Activation triggers. Optional. Currently only "onStartupFinished" is
  // recognised. In v1 every plugin with a `main` entry activates at startup —
  // omitting this field (or passing an empty array) is treated the same as
  // ["onStartupFinished"]. Lazy first-use activation is planned but not wired
  // yet, so there is no way to opt out of startup activation today.
  "activationEvents": ["onStartupFinished"],

  // The plugin's UI and functional contributions.
  "contributes": {
    "agents": [
      /* requires the agent:register capability */
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
    "keybindings": [
      /* ... */
    ],
    "contextMenus": [
      /* ... */
    ],
    "commands": [
      /* ... */
    ],
    "settings": [
      /* ... */
    ],
    "views": [
      /* ... */
    ],
    "mcpServers": [
      /* ... */
    ],
    "forgeProviders": [
      /* ... */
    ],
    "fileDecorationProviders": [
      /* ... */
    ],
  },
}
```

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

Semver range expressing which Daintree versions the plugin supports. Examples track the latest pre-1.0 minor; the scaffolder (`npx daintree-plugin new`) generates `"^0.11.0"`:

- `"^0.11.0"` — compatible with 0.11 (scaffolder default)
- `">=0.11.0 <0.13.0"` — explicit range
- `"0.11.x"` — any 0.11 release

If the running Daintree version doesn't satisfy the range, the plugin is rejected at load with a user-visible warning toast. If `engines.daintree` is omitted entirely, Daintree warns in the console but loads the plugin anyway.

Daintree is pre-1.0. Pin to a current minor during this phase — a plugin that works on Daintree 0.11 may not work on 0.12 without changes.

### `capabilities`

Array of capability tokens the plugin wants. The model is **disclosure-first with host-side policy effects** — there is no Node sandbox, so a plugin is not blocked from doing anything regardless of what it declares, but declared tokens are not purely advisory. Six high-risk tokens (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`) currently raise every action the plugin registers to a confirm dialog (`effectiveDanger: "confirm"`) via the host's `CONFIRM_TRIGGERING_CAPABILITIES` set. See the [trust model](./trust-model.md) for the full contract.

| Token                | Intent                                                   |
| -------------------- | -------------------------------------------------------- |
| `fs:project-read`    | Read files in the current project worktree               |
| `fs:project-write`   | Modify files in the current project worktree             |
| `fs:user-data-read`  | Read from `~/.daintree/` or elsewhere in the user's home |
| `fs:user-data-write` | Write to `~/.daintree/` or elsewhere in the user's home  |
| `network:fetch`      | Make outbound HTTP requests                              |
| `agent:invoke`       | Send prompts to AI agents from plugin code               |
| `agent:read`         | Observe agent state (token usage, transcripts)           |
| `agent:register`     | Register a launchable agent CLI as a selectable agent    |
| `git:read`           | Read git state (branches, status, log)                   |
| `git:write`          | Make git changes (commits, branches)                     |
| `clipboard:read`     | Read from the system clipboard                           |
| `clipboard:write`    | Write to the system clipboard                            |
| `shell:exec`         | Spawn subprocesses                                       |

Declare honestly. The plugin manager's detail pane lists what you've declared (after install, not as a pre-install consent gate) and users judge plugins by what they ask for; the host also derives policy from the high-risk tokens above. A plugin declaring `shell:exec` for no obvious reason looks suspicious. A plugin that silently executes shells without declaring it damages the ecosystem — and nothing at runtime stops it, which is exactly why honest declaration matters.

### `scopes`

Per-capability allowlists that declare what a capability intends to reach. Both buckets are schema-validated, but neither is a runtime sandbox — they do not block actual calls or writes. Two buckets, with different runtime weight today:

- `scopes.network.allowedUrls` — outbound request targets the plugin intends to reach under `network:fetch`. Wildcards and private/loopback targets are rejected. **Live but advisory:** a non-empty allowlist suppresses the compound-capability elevation (the host won't force a confirm dialog when `network:fetch` is paired with a sensitive read), proving the fetch is tightly bound rather than a generic exfiltration channel. It does not actually block requests to other URLs.
- `scopes.fs.allowedPaths` — absolute paths the filesystem capabilities intend to touch. Wildcards, relative paths, and `..` segments are rejected. **Advisory only:** the value is schema-validated but not consulted at runtime — it neither gates filesystem access nor attenuates the lattice (fs writes already elevate unconditionally).

A misspelled bucket (e.g. `networking`) is rejected as a manifest error rather than silently dropped. See the [trust model](./trust-model.md) for the full scopes semantics and how they compose with capabilities.

### `activationEvents`

Activation triggers. The sole supported value is `"onStartupFinished"`, which activates the plugin once the app finishes starting.

In v1, startup activation is the only behavior: any plugin with a `main` entry activates once the app finishes starting. Omitting `activationEvents` (or passing an empty array) is treated identically to `["onStartupFinished"]` — there is no way to opt out of startup activation yet. Lazy first-use triggers (`onCommand:*`, `onView:*`, …) are planned; once they land, a plugin will be able to drop `"onStartupFinished"` from a non-empty list to defer activation until a contribution is first used. Note that contributions (commands, panels, keybindings) are still registered eagerly from the manifest at startup regardless — only the plugin's `main` module import and `activate()` call are governed by activation.

### `contributes`

Object containing arrays for each contribution type. All fields are optional; unlisted contribution types default to empty arrays.

- `views` — `location: "panel"` is wired today (the renderer host mounts the contributed component in a grid panel). `location: "sidebar"` is rejected at manifest validation — the sidebar host does not exist yet, so accepting it would validate a view the runtime cannot render.
- `mcpServers` — the declared `command` is lazily spawned as a real subprocess the first time its tools are enumerated, and is supervised (restart-on-crash, killed on exit). Treat a contributed MCP server as trust-gated, not inert.

> These two points were named `experimental_views` and `experimental_mcpServers` before the 1.0 freeze. The old keys are still accepted as deprecated aliases — a manifest using them parses and runs identically, but logs a one-time deprecation warning naming the stable replacement. Rename to `views` / `mcpServers`; the aliases may be removed in a future major.

The `forgeProviders` and `fileDecorationProviders` contributions are also live at runtime. `agents` registers a launchable agent CLI as a selectable agent and requires the `agent:register` capability — see the [Contribution points reference](./contribution-points.md) for its shape. That reference also lists the per-point status of every type.

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
