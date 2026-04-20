# Plugin Views and MCP Servers (RFC)

**Status:** RFC — reservation only. The manifest schema accepts both contribution points; `PluginService` logs a "not yet implemented" warning at load time and ignores the entries. Nothing in this document is a commitment to ship.

**Tracking:** issue #5581 (reservation). Full implementations will be tracked under separate issues once the design questions below are resolved. Plugin epic: #4458.

## Why reserve these now

Both contribution points are visible on the medium-term roadmap and both have open design questions that shouldn't block authors who want to experiment today. Adding the fields with a "validated but ignored" treatment prevents two failure modes:

- Plugin authors invent their own ad-hoc field names, producing migration churn when the real implementation lands.
- The final field shape drifts away from established conventions (VS Code's views, Claude Desktop's MCP config) for no principled reason.

By locking in the names and shapes now — even without behaviour — plugins authored in the interim can forward-declare their intent, and the implementations that land later pick up ready-made manifests.

## Part 1 — Plugin-Contributed Views

### Manifest shape

```jsonc
{
  "contributes": {
    "views": [
      {
        "id": "main",
        "name": "Main",
        "componentPath": "./dist/view.js",
        "location": "panel",
        "iconId": "layout",
        "description": "Primary plugin view.",
      },
    ],
  },
}
```

| Field           | Required | Notes                                                                                                       |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `id`            | yes      | `SAFE_ID_PATTERN`, max 64 chars. Namespaced at runtime as `{pluginId}.{viewId}`.                            |
| `name`          | yes      | Display label.                                                                                              |
| `componentPath` | yes      | Relative path inside the plugin directory. Resolves to an ESM module with a default React component export. |
| `location`      | yes      | `"panel"` \| `"sidebar"`. Determines where the view renders in the host chrome.                             |
| `iconId`        | no       | Matches the registered icon set used by panel kinds and toolbar buttons.                                    |
| `description`   | no       | Surface text for the command palette / preferences.                                                         |

`componentPath` carries most of the unresolved design weight. Its semantics depend on the iframe-vs-inline choice discussed below, but the **field name and string type are the same in both cases** — so authors can declare it today and the future runtime decides how to resolve it.

### Bundling strategy

Plugins ship a **pre-built ESM bundle** (Vite `lib` mode or equivalent). The host does not run a bundler at plugin load time — Electron renderer is not a build context, and on-the-fly transpilation of third-party code creates a supply-chain surface we do not want.

- Plugin authors produce `dist/view.js` (or similar) as a single ESM module with a default export.
- The host resolves `componentPath` relative to the plugin directory and loads the module via dynamic `import()`.
- Source maps are optional but recommended for debuggability.

### React 19 sharing

This is the highest-stakes implementation detail. The plugin component must use the **same React instance** as the host — mixing two copies of React in one page produces the "Invalid hook call" error even when the versions are identical.

**Recommended approach: Vite externals + importmap.**

- Plugin bundles declare `external: ["react", "react-dom", "react/jsx-runtime"]`. This strips the shared dependencies from the bundle.
- The host `index.html` injects `<script type="importmap">` mapping those bare specifiers to pre-bundled vendor chunks shipped with the app.
- Chromium (Electron 41) supports importmap natively — no polyfill required.

**`react/jsx-runtime` is not optional.** JSX authored with the new transform desugars to `jsx()` / `jsxs()` calls imported from `react/jsx-runtime`. If the plugin bundles its own copy of that module, every JSX element creates a React element tied to a different React instance, and hooks inside the plugin component throw at runtime.

**Why not Module Federation?** `@module-federation/vite` handles version negotiation between host and plugin, but adds ~30KB of runtime and significant build complexity. Daintree controls both the host React version and the plugins' build tooling (via a published template), so negotiation isn't needed — the host's React is the only React, full stop.

**Why not `window.__REACT__`?** Breaks ESM tree-shaking, doesn't cleanly handle `react/jsx-runtime`, and forces plugins into a non-standard module pattern.

**Version discipline.** Plugins declare a `react` peer dependency. The host version is canonical; the plugin's declared version is enforced at publish time (by the plugin template / CI), not at runtime. If the host ever bumps React's major version, all installed plugins are re-validated against the new range as part of the `engines.daintree` compatibility gate.

### Panel kind registry integration

Daintree's panel system is driven by the panel kind registry (`shared/config/panelKindRegistry.ts` and `src/panels/registry.tsx`). Each kind contributes a component, a serializer, and a defaults factory. Plugin-contributed views plug in via the same registry:

- At plugin load, the future runtime calls `registerPanelKind` with `{ id: "{pluginId}.{viewId}", ..., component: () => resolve(componentPath) }`.
- The component entry is a **resolver** (thunk), not an eager reference — we don't want to pay the import cost for every declared view at boot, only the ones the user actually opens.
- `extensionId` is already a field on `PanelKindDefinition`, so the existing unregister-on-unload path (`unregisterPluginPanelKinds`) covers cleanup with no registry changes.
- Views with `location: "sidebar"` register against a parallel sidebar registry (out of scope for this RFC — a separate sidebar contribution infrastructure is required first).

Serializer and defaults factory for plugin views will use a shared "generic plugin view" implementation — plugin components are treated as opaque from the host's perspective, so the serializer stores no custom state and the defaults factory produces an empty state.

### Iframe vs inline

The single largest open question.

| Criterion          | Inline (dynamic import)              | Iframe                                       |
| ------------------ | ------------------------------------ | -------------------------------------------- |
| Isolation          | None — full access to host DOM/state | Strong — separate frame context              |
| Crash containment  | Plugin crash can freeze the host     | Contained to the frame                       |
| React context      | Same tree — hooks work natively      | Blocked — requires `postMessage` bridging    |
| Host UI components | Usable directly                      | Not usable without re-implementing per-frame |
| Performance        | Low overhead                         | Separate frame context, higher memory        |
| CSP / origin       | Shares host origin                   | Needs custom protocol (`plugin://`) for CSP  |

**Recommendation.** Start with **inline dynamic import** for first-party and explicitly-trusted plugins. The implementation is simpler, DX is better, and crash containment can be retrofitted via error boundaries around each view. Treat **iframe** as the upgrade path once third-party untrusted plugins enter scope — at that point, a trust tier in the manifest (or permission system) determines which loader is used, and the field shape in this RFC doesn't change.

**Why not iframe first?** The `file://` iframe origin behaviour in Electron (`event.origin === "null"`) makes `postMessage` validation awkward, and solving that requires a custom `protocol.handle` path (`plugin://publisher.name/`) which is its own infrastructure task. Deferring that work until the trust model demands it keeps this phase scoped.

### Current behaviour

When a plugin declares `contributes.views`:

- `PluginManifestSchema` validates each entry against `ViewContributionSchema`.
- `PluginService.loadPlugin` logs `[PluginService] Plugin "<id>": contributes.views is not yet implemented and will be ignored`.
- Nothing else happens — no panel kinds are registered, no components are loaded.
- Other contributions in the same manifest (panels, toolbar buttons, menu items) continue to work unchanged.

### Open questions

- Trust tiers: manifest-declared (`"trusted": true`) vs. signature-based vs. permission-gated?
- Sidebar views: separate contribution point (`contributes.sidebarViews`) or shared with `location: "sidebar"` plus a parallel sidebar registry? Current RFC assumes the latter.
- Plugin component API surface: can a plugin view receive host props (current worktree, panel instance id, dispose signal)? What shape?
- HMR in dev: the plugin template's dev mode probably wants to wire Vite HMR through the host — separate track.
- Remote-bundle plugins (components loaded from a URL, not disk): likely disallowed for security, but worth a deliberate "no" in the implementation issue rather than an implicit one.

## Part 2 — Plugin-Shipped MCP Servers

### Manifest shape

```jsonc
{
  "contributes": {
    "mcpServers": [
      {
        "id": "linear",
        "name": "Linear MCP",
        "command": "node",
        "args": ["./server.js"],
        "env": { "LINEAR_API_KEY": "${env:LINEAR_API_KEY}" },
      },
    ],
  },
}
```

| Field     | Required | Notes                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------- |
| `id`      | yes      | `SAFE_ID_PATTERN`, max 64 chars. Namespaced at runtime as `{pluginId}.{mcpId}`. |
| `name`    | yes      | Display name in the MCP server list UI.                                         |
| `command` | yes      | Executable (`node`, `python`, `npx`, or a path).                                |
| `args`    | no       | Argv after the command. Validated as `string[]`.                                |
| `env`     | no       | Environment variables. Validated as `Record<string, string>`.                   |

The shape is deliberately identical to the Claude Desktop / Cursor / GitHub Copilot CLI config format. Plugin authors copy their existing MCP server definition nearly verbatim.

### What is intentionally excluded

- **`url` / remote MCP servers.** Remote MCP is separate infrastructure: transport (HTTP/SSE), auth, CORS, and network policy all live elsewhere. Reserving a `url` field now would lock in decisions we haven't made. A plugin that needs remote MCP will gain a separate contribution point once that work lands.
- **`type` / explicit transport.** The stdio transport is inferred from the presence of `command`. When remote support arrives, the alternative contribution point will declare transport explicitly rather than overloading this one.
- **Per-server cwd, stdio piping flags, restart policy.** Future refinements. Adding them now without a concrete use case is speculative.

### What implementation would cover

Not in scope for this RFC — called out so the reservation's scope is explicit:

- **Subprocess supervision.** Spawn, restart on crash, backoff, resource limits. Daintree's existing PTY / utility-process infrastructure is the likely foundation but not a drop-in fit — MCP servers are long-lived, stdio-based, and need structured message framing.
- **Agent wiring.** How an agent (Claude, Codex, Gemini) sees and invokes plugin-shipped MCP servers. Cross-IDE MCP has an emerging config convention (`claude mcp add`, Cursor's `.cursor/mcp.json`); Daintree's wiring needs to surface plugin servers in the same list as user-configured servers without collision.
- **Argument and env validation at runtime.** Schema validation at manifest time is not enough — `command` must be checked against an allowlist or permission grant before spawn.
- **Secret handling.** `env` values for MCP servers routinely include API keys. Substitution from secure storage (`${env:LINEAR_API_KEY}` or equivalent) is a cross-cutting concern with the broader secrets story.

### Relationship to cross-IDE MCP config

Claude Desktop, Cursor, GitHub Copilot CLI, and Zed all converge on the same entry shape (`command` / `args` / `env`) even though the top-level key varies (`mcpServers` vs. `context_servers`). Daintree uses `mcpServers` to match Claude Desktop and Cursor — the IDEs most likely to share plugin authors with Daintree.

Zed ships MCP servers as part of its extension package: the extension contributes `context_servers` in the manifest, and Zed spawns them when the extension activates. The Daintree design treats plugins and MCP servers the same way — one plugin, one manifest, any number of contributions. Plugin authors don't ship two separate packages for "a plugin" and "an MCP server it includes."

### Current behaviour

When a plugin declares `contributes.mcpServers`:

- `PluginManifestSchema` validates each entry against `McpServerContributionSchema`.
- `PluginService.loadPlugin` logs `[PluginService] Plugin "<id>": contributes.mcpServers is not yet implemented and will be ignored`.
- No subprocess is spawned, no agent wiring is performed, no UI is populated.
- Other contributions in the same manifest continue to work unchanged.

### Open questions

- Collision semantics with user-configured MCP servers at the same `id` — plugin wins, user wins, or rename prompt?
- UI surface: do plugin-shipped servers appear alongside user servers in the same list, with a "from plugin" indicator, or in a separate section?
- Lifecycle: does the MCP server start when the plugin loads, when the first agent attaches, or on explicit opt-in per project?
- Permission model: does launching a subprocess require a declared permission beyond `shell:exec`?

## What is implemented today

- `ViewContribution` and `McpServerContribution` are types in `shared/types/plugin.ts`.
- `ViewContributionSchema` and `McpServerContributionSchema` are Zod schemas in `electron/schemas/plugin.ts`, wired into `PluginManifestSchema.contributes` with `.default([])`.
- `PluginService.loadPlugin` emits one warning per category (not per entry) when either field is non-empty.
- Schema and service tests in `electron/services/__tests__/PluginService.test.ts` cover the accept, warn, and reject paths.

No runtime behaviour. No UI. No subprocess supervision. No component loading. Those are future work.
