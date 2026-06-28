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

  // Activation triggers. Optional. Plugins are lazy by default — omitting this
  // field (or passing an empty array) defers the `main` import and `activate()`
  // until a contribution is first used. The sole recognised value,
  // "onStartupFinished", is the explicit opt-in for plugins that must run at
  // boot. Contributions are registered eagerly either way.
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

Semver range expressing which Daintree versions the plugin supports. Examples track the latest pre-1.0 minor; the scaffolder (`npx daintree-plugin new`) generates `"^0.11.0"`:

- `"^0.11.0"` — compatible with 0.11 (scaffolder default)
- `">=0.11.0 <0.13.0"` — explicit range
- `"0.11.x"` — any 0.11 release

If the running Daintree version doesn't satisfy the range, the plugin is rejected at load with a user-visible warning toast. If `engines.daintree` is omitted entirely, Daintree warns in the console but loads the plugin anyway.

Daintree is pre-1.0. Pin to a current minor during this phase — a plugin that works on Daintree 0.11 may not work on 0.12 without changes.

### `capabilities`

Array of capability tokens the plugin wants. The model is **disclosure-first with host-side policy effects** — there is no Node sandbox, so a plugin is not blocked from doing anything regardless of what it declares, but declared tokens are not purely advisory. Seven high-risk tokens (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`) currently raise every action the plugin registers to a confirm dialog (`effectiveDanger: "confirm"`) via the host's `CONFIRM_TRIGGERING_CAPABILITIES` set. See the [trust model](./trust-model.md) for the full contract.

| Token | Intent |
| --- | --- |
| `fs:project-read` | Read files in the current project worktree |
| `fs:project-write` | Modify files in the current project worktree |
| `fs:user-data-read` | Read from `~/.daintree/` or elsewhere in the user's home |
| `fs:user-data-write` | Write to `~/.daintree/` or elsewhere in the user's home |
| `network:fetch` | Make outbound HTTP requests |
| `agent:invoke` | Send prompts to AI agents from plugin code |
| `agent:read` | Observe agent state (lifecycle phase, session cost/tokens on completion) |
| `agent:register` | Register a launchable agent CLI as a selectable agent |
| `agent:input` | Send text to the active agent terminal (`host.sendToActiveAgent`; JIT consent on first use) |
| `git:read` | Read git state (branches, status, log) |
| `git:write` | Make git changes (commits, branches) |
| `clipboard:read` | Read from the system clipboard |
| `clipboard:write` | Write to the system clipboard |
| `shell:exec` | Spawn subprocesses (managed via `host.process`) |

Declare honestly. The plugin manager's detail pane lists what you've declared (after install, not as a pre-install consent gate) and users judge plugins by what they ask for; the host also derives policy from the high-risk tokens above. A plugin declaring `shell:exec` for no obvious reason looks suspicious. A plugin that silently executes shells without declaring it damages the ecosystem — and for the most part nothing at runtime stops it, which is exactly why honest declaration matters. The one runtime-enforced exception is `host.process.spawn` (see [host API](./host-api.md#process--managed-child-processes)): the managed-process surface rejects unless the plugin declared `shell:exec`. A plugin can still `require("child_process")` directly to bypass that — the gate is on the managed surface, not a Node sandbox — but the managed surface is the supported, supervised path.

### `scopes`

Per-capability allowlists that declare what a capability intends to reach. Both buckets are schema-validated, but neither is a runtime sandbox — they do not block actual calls or writes. Two buckets, with different runtime weight today:

- `scopes.network.allowedUrls` — outbound request targets the plugin intends to reach under `network:fetch`. Wildcards and private/loopback targets are rejected. **Live but advisory:** a non-empty allowlist suppresses the compound-capability elevation (the host won't force a confirm dialog when `network:fetch` is paired with a sensitive read), proving the fetch is tightly bound rather than a generic exfiltration channel. It does not actually block requests to other URLs.
- `scopes.fs.allowedPaths` — absolute paths the filesystem capabilities may touch. Entries may also use the dynamic tokens `${project}` or `${worktree}` (optionally with a `/sub/path` suffix, e.g. `"${project}/src"`), which expand at call time to the active project root and active worktree path. Wildcards, relative paths, `..` segments, and unknown tokens are rejected by the manifest schema. **Enforced for the host `fs`/`git` API:** every path argument to `host.fs.*` and `host.git.*` is realpath-resolved and contained to one of these roots (traversal and symlink-escape rejected, mirroring the `plugin://` protocol handler); an out-of-scope path rejects with a `PATH_NOT_ALLOWED:` prefix. It still does not attenuate the compound-capability lattice (fs writes elevate unconditionally). **Honest scope limit:** this enforces the sanctioned, audited `host.fs`/`host.git` path only — a plugin's `main` is un-sandboxed Node code (it runs in the plugin worker with full filesystem privileges) and can still call raw `node:fs` directly, which the host cannot intercept until the sandbox/trust model changes (D3). `allowedPaths` contains the host-mediated surface; it does not seal the un-mediated one.

A misspelled bucket (e.g. `networking`) is rejected as a manifest error rather than silently dropped. See the [trust model](./trust-model.md) for the full scopes semantics and how they compose with capabilities.

### `activationEvents`

Activation triggers. The sole supported value is `"onStartupFinished"`, which activates the plugin once the app finishes starting.

Plugins are lazy by default. Omitting `activationEvents` (or passing an empty array) defers the plugin's `main` module import and `activate()` call until one of its contributions is first used — a contributed command is dispatched, a forge provider or file decoration is queried, or a contributed panel view is opened. List `"onStartupFinished"` to opt a plugin into eager activation when it genuinely needs to run at boot. Either way, contributions (commands, panels, keybindings, …) are registered eagerly from the manifest at startup — only the `main` import and `activate()` call are governed by activation, so a lazy plugin's commands and panels still appear in the palette before any of its code runs.

### `contributes`

Object containing arrays for each contribution type. All fields are optional; unlisted contribution types default to empty arrays.

- `views` — `location: "panel"` is wired today (the renderer host mounts the contributed component in a grid panel). `location: "sidebar"` is rejected at manifest validation — the sidebar host does not exist yet, so accepting it would validate a view the runtime cannot render.
- `mcpServers` — the declared `command` is lazily spawned as a real subprocess the first time its tools are enumerated, and is supervised (killed on Daintree exit; on crash it transitions to `crashed` and tool calls reject until an explicit manual restart — there is no automatic retry or backoff). Treat a contributed MCP server as trust-gated, not inert.
- `settings` — beyond `string` / `number` / `boolean` / `enum` / `json` / `secret`, the field `type` accepts `path` / `directory` / `file`, which render a read-only path input plus a native folder/file chooser (`file` narrows the chooser by an `extensions` array; `mustExist` advisory-flags a stored path that no longer resolves). A `secret`-typed setting is encrypted at rest through the OS keychain when one is available, transparently to the plugin. Full field reference in the [Contribution points → Settings schema](./contribution-points.md#settings-schema--shipped).

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
