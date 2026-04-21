# Architecture

How the plugin system works internally. Most plugin authors don't need this document — it's for people debugging nontrivial plugins, contributing to the plugin system itself, or deciding whether Daintree's model fits their extension.

## Lifecycle

A plugin's life has five phases:

1. **Discovery** — startup scan of `~/.daintree/plugins/`
2. **Manifest validation** — `plugin.json` parsed, validated against the Zod schema
3. **Registration** — eager contribution points (panels, toolbar buttons, menu items, manifest-declared commands) registered in the respective registries
4. **Activation** — plugin's `main` module imported, `activate(host)` called (lazy — triggered by first use)
5. **Disposal** — on unload, the cleanup cascade runs in reverse

### Discovery

At startup, `PluginService.initialize()` scans `~/.daintree/plugins/` for directories. Each directory is parsed independently — one plugin failing to load doesn't block others.

Plugin directory names must match the plugin's `name` field. A plugin named `acme.linear-planner` must live in `~/.daintree/plugins/acme.linear-planner/`. Mismatched names produce a warning and the plugin is skipped.

The `plugins` root is configurable for testing via the `PluginService` constructor argument but otherwise fixed.

### Manifest validation

Validation is strict. The manifest is parsed by `PluginManifestSchema` (Zod) in strict mode, which rejects unknown top-level keys and unknown keys inside `contributes`. The reason is conservative: unknown keys are almost always typos, and silently dropping typo'd contributions is a bad debugging experience.

The `engines.daintree` semver range is validated and compared against the running Daintree version. A mismatch produces a user-visible toast and the plugin is skipped.

### Registration

Most contributions register eagerly at plugin-load time so the UI reflects them immediately — the command palette, toolbars, menus populate before any plugin code runs:

- `panels` → `registerPanelKind()` in `shared/config/panelKindRegistry.ts`
- `toolbarButtons` → `registerToolbarButton()` in `shared/config/toolbarButtonRegistry.ts`
- `menuItems` → `registerPluginMenuItem()` in `electron/services/pluginMenuRegistry.ts`
- `commands` → registered as synthetic action definitions in the `ActionService`; handler is resolved lazily

Contributions that require code (e.g., a command handler, a view component, an MCP server's runtime) are registered as **resolvers** — thunks that import the actual code when first needed.

### Activation

A plugin's `activate(host)` function runs when something first needs the plugin's code. Triggers:

- User runs a manifest-declared command
- User opens a plugin-contributed panel
- An agent calls a tool from a plugin-shipped MCP server (MCP servers themselves are supervised separately — see below)
- `onStartupFinished` activation event (only explicit event supported)

When triggered, Daintree:

1. Resolves the plugin's `main` file path relative to the plugin directory
2. Imports it via `pathToFileURL()` + `import()` with a cache-busting query string (for hot reload)
3. Calls the exported `activate(host)` function
4. Stores the cleanup function (if returned)
5. Enforces a 5-second timeout via `Promise.race` — exceeded activations are marked failed

Handler implementations are bound to the registered action IDs as activation resolves. Users who invoked a command before activation finished see a brief spinner; the handler runs as soon as binding completes.

### Disposal

Disposal is a LIFO cascade, matching VS Code's Disposable pattern. `src/utils/disposable.ts` implements the core:

```ts
const store = new DisposableStore();
store.add(() => subscription.unsubscribe());
store.add(someResource);
// ... later:
store.dispose(); // runs cleanups in reverse order
```

On plugin unload, `PluginService.unloadPlugin()` runs these cleanups in order:

1. Plugin-returned cleanup function (if any)
2. Worktree event subscriptions registered during activate
3. IPC handlers registered via `host.registerHandler`
4. Actions registered via `host.registerAction`
5. Menu items contributed via manifest
6. Toolbar buttons contributed via manifest
7. Panel kinds contributed via manifest
8. MCP subprocess lifecycle (sent SIGTERM, then SIGKILL after grace period)

After disposal, the plugin's module is orphaned. Node's module cache still holds it but no live references point to it — garbage collection claims it eventually.

## Renderer host

Plugin views render inside Daintree's existing panel system. They must share Daintree's React 19 instance — two React copies on one page produce "Invalid hook call" errors even if the versions match exactly.

### Sharing strategy

**Import maps + Vite externals.**

- Plugin bundles declare `external: ["react", "react-dom", "react/jsx-runtime"]`. This strips these modules from the bundle.
- Daintree's `index.html` injects `<script type="importmap">` mapping the bare specifiers to vendor chunks shipped with Daintree.
- When the plugin bundle executes in Daintree's renderer, those imports resolve to Daintree's copy.

Chromium (Electron 41) supports import maps natively — no polyfill required.

**`react/jsx-runtime` is not optional.** JSX compiled with the new transform (`jsx: "react-jsx"` in tsconfig) desugars to `jsx()` / `jsxs()` calls imported from `react/jsx-runtime`. If the plugin bundles its own copy of that module, every JSX element creates a React element tied to a different React instance, and hooks inside the plugin view throw at runtime. The `@daintreehq/plugin-vite` config enforces this externalization automatically — plugin authors don't configure it manually.

**Why not Module Federation?** Module Federation handles version negotiation between host and plugin, but adds ~30 KB of runtime and significant build complexity. Daintree controls both the host React version and the plugin template, so negotiation isn't needed.

**Why not `window.__REACT__`?** Breaks ESM tree-shaking, doesn't cleanly handle `react/jsx-runtime`, and forces plugins into a non-standard module pattern.

### Version discipline

Plugins declare a `react` peer dependency in their own `package.json`. The host version is canonical. If Daintree bumps React's major version, the plugin template's published peer range is updated and installed plugins are revalidated against the new range as part of the `engines.daintree` compatibility gate.

### Error boundaries

Every plugin view is wrapped in an error boundary by the host. A crash renders a fallback with the plugin name, error message, and a Reload button. The rest of Daintree is unaffected — the panel grid keeps working, other plugins keep running, the user can close the failing panel normally.

### Inline, not iframe

Views render inline in Daintree's React tree. Plugins share Daintree's DOM, CSS cascade, and React context. This is optimal for a curated-trust model: richer integration, direct use of host UI components, native React hooks.

An iframe model would isolate plugins behind a `postMessage` bridge at the cost of heavy DX friction and rebuilt UI components per frame. That's the right trade for an untrusted-plugin model — if Daintree ever opens to fully untrusted third-party plugins, iframe isolation via a `plugin://` protocol handler is the upgrade path. Nothing in the current manifest shape needs to change — `componentPath` resolves differently for trusted vs untrusted plugins, but the field is the same.

## MCP supervisor

`PluginMcpSupervisor` (planned — lives in the same area as existing MCP infrastructure in `electron/services/`) manages plugin-shipped MCP servers.

### Spawn timing

Servers spawn **on first tool use**, not at plugin activation. Daintree's MCP client maintains a registry of available servers (their stdio command + args + env) but doesn't establish connections until an agent tries to use one.

Rationale: a user with 10 installed plugins, each shipping an MCP server, doesn't pay the startup cost of 10 subprocesses unless they actually use them. Many MCP servers are heavy at startup (loading SDKs, validating credentials, fetching schemas).

### Tool discovery

Tool definitions themselves are fetched lazily. The first time an agent sessions attempts to enumerate available tools, Daintree queries each registered server's `tools/list` and caches the result. Individual tool schemas are only injected into the agent's context when the agent's own discovery query returns a match — inspired by Claude Code's MCP Tool Search pattern.

This matters because tool definitions consume tokens. An MCP server exposing 40 detailed tools can add 30K+ tokens to every turn. Lazy discovery pushes the cost to only the servers and tools the agent actually uses.

### Process lifecycle

- Spawn on first use per session.
- Keep alive for the duration of the agent session.
- Exponential backoff on crash (1s, 2s, 4s, 8s up to 30s). After 3 failures in 60 seconds, the server is marked degraded; tool calls return a structured error until manual restart.
- SIGTERM on Daintree quit with a 2-second grace period, then SIGKILL.
- Subprocess `stderr` is captured and logged for debugging but not exposed to agents.

### Environment variable substitution

Plugin manifest `env` values support `${settings:settingId}` syntax. Substitution happens at spawn time, reading the current setting value from the plugin's settings scope. Changes to secret settings cause the server to restart with the new value on its next spawn.

### Security

MCP subprocesses run with the full privileges of the Daintree process. There's no sandboxing. The curation model (review by human, trusted source, signed distribution) is the primary defense.

An MCP server can do anything the plugin could do: make network requests, read and write files, spawn further processes. The manifest's `capabilities` array is disclosed to the user at install — if a plugin declares `network:fetch` because its MCP server calls Linear's API, the user sees that during install and decides whether to trust it.

## Worktree observability

Plugins observe Daintree's worktree state through an allowlisted, frozen projection:

```ts
// shared/utils/pluginWorktreeSnapshot.ts
export function toPluginWorktreeSnapshot(worktree: WorktreeSnapshot): PluginWorktreeSnapshot {
  const snapshot: PluginWorktreeSnapshot = {
    id: worktree.id,
    worktreeId: worktree.worktreeId,
    // ...explicit allowlist, no spreading
  };
  return Object.freeze(snapshot);
}
```

The projection is deliberately explicit — no spreading of the internal `WorktreeSnapshot` shape. This prevents internal field additions from automatically leaking to plugins, which would tie us to internal shape stability.

Adding a field to the plugin snapshot requires:

1. Updating `PluginWorktreeSnapshot` type in `shared/types/plugin.ts`
2. Updating `toPluginWorktreeSnapshot()` to copy the field
3. Releasing a new `@daintreehq/plugin-sdk` minor version

Plugins consuming worktree events during `activate()` — before the WorkspaceClient is fully initialized — get their subscriptions queued in `pendingWorktreeSubs` and replayed once the client connects. Your callback never misses the early events.

## Capability disclosure

The `capabilities` field in the manifest is a **disclosure mechanism**, not a runtime sandbox. Daintree does not prevent a plugin from doing anything — a plugin declaring `capabilities: []` can still make network requests and write files.

What disclosure does:

- During install, Daintree shows the declared capabilities in a humanized list: "This plugin can read your worktree files, make network requests, and spawn subprocesses."
- Installed plugins' detail views show the same list.
- The install dialog shows the list in large, clear text before the user confirms.

The purpose is to let users judge plugins by what they claim to need. A simple theme-packager plugin declaring `shell:exec` looks suspicious; a Linear integration declaring `network:fetch` looks expected. This is the same reasoning Chrome extension permissions use — informational, pre-install, not post-install runtime gates.

Declaring honestly matters. A plugin that silently makes network requests without declaring `network:fetch` erodes the ecosystem's trust model, even though nothing blocks the call at runtime.

## Signing and kill-switch

**Signing:** sideloaded and URL-installed plugins aren't signed. Trust is on the user.

**Kill-switch:** Daintree polls a blocklist hosted on a CDN. Plugins matching the blocklist by `{name, versionRange, jti-if-applicable}` refuse to load on next startup. The user sees a banner explaining why. This mechanism is reserved for security responses to known-compromised plugins and is not used for normal version deprecation.

Detailed infrastructure for signed distribution is planned for the eventual Daintree-authored paid-plugin channel; it does not affect sideload or URL install.

## Why these choices

A short rationale for the decisions most likely to feel arbitrary:

**Why `plugin.json` instead of extending `package.json`?** The VS Code pattern of putting manifest data inside `package.json`'s `contributes` field conflates npm dev dependencies with runtime manifest. For TypeScript plugins built with Vite, the two have genuinely different shapes and lifetimes. Keeping them separate avoids the "why is my build tool looking at my contribution points?" confusion.

**Why scoped names (`publisher.plugin-name`)?** Name collisions are inevitable without a central registry. Scoped names make collisions author-caused (you control your publisher namespace) rather than ecosystem-caused. Matches npm's scoped package convention.

**Why `.dntr` instead of `.zip`?** OS file association. Double-clicking a `.dntr` opens Daintree's install flow; double-clicking a `.zip` opens the OS archiver. Also prevents accidental manual unzipping into the wrong place. The CLI accepts either, so authors who only want to ship `.zip` can.

**Why dual-path action binding (filesystem convention + imperative)?** The filesystem convention (Raycast-style: `commands[].name` → `src/{name}.ts` default export) is delightful for simple cases — zero boilerplate, co-located with declaration. Imperative registration via `host.registerAction` is needed for truly dynamic commands and matches the existing imperative pattern Daintree uses for its own ~258 built-in actions. Supporting both is cheap and handles both ends of the complexity spectrum.

**Why no runtime permission enforcement?** The audience is power users who write their own plugins and trusted Daintree-authored plugins. Enforcing runtime permissions requires either Wasm sandboxing (Zed's approach — great DX cost) or iframe isolation (worse DX, breaks React integration) or permission prompts for every Node API call (unusable). For a curated-trust model, disclosure is the right fidelity.

**Why no separate hooks contribution point (PreToolUse/PostToolUse)?** An MCP server can act as a proxy in front of other tools, intercepting and modifying tool calls. This uses the ecosystem we're already committed to (MCP) rather than inventing a parallel API. Plugins that genuinely need this can build it cleanly.

## Reference

Key source locations for contributors:

- `electron/services/PluginService.ts` — plugin discovery, load, activate, unload
- `shared/types/plugin.ts` — public types (`PluginManifest`, `PluginHostApi`, etc.)
- `electron/schemas/plugin.ts` — Zod schema that validates manifests
- `electron/ipc/handlers/plugin.ts` — IPC handlers for plugin-invoked methods
- `src/hooks/usePluginActions.ts` — renderer-side action sync
- `src/utils/disposable.ts` — disposable pattern implementation
- `shared/utils/pluginWorktreeSnapshot.ts` — worktree projection for plugin exposure
- `shared/config/panelKindRegistry.ts` — panel kinds registry with plugin-scoped unregister
- `shared/config/toolbarButtonRegistry.ts` — toolbar buttons with plugin-scoped unregister
- `electron/services/pluginMenuRegistry.ts` — menu items
- `electron/services/__tests__/PluginService.test.ts` — unit tests
- `electron/services/__tests__/PluginService.integration.test.ts` — integration tests

Tests are comprehensive — use them as the living reference when source comments don't answer the question.
