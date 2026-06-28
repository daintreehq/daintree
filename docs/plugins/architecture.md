# Architecture

How the plugin system works internally. Most plugin authors don't need this document — it's for people debugging nontrivial plugins, contributing to the plugin system itself, or deciding whether Daintree's model fits their extension.

## Lifecycle

A plugin's life has five phases:

1. **Discovery** — startup scan of `~/.daintree/plugins/`
2. **Manifest validation** — `plugin.json` parsed, validated against the Zod schema
3. **Registration** — eager contribution points (panels, toolbar buttons, menu items) registered in the respective registries
4. **Activation** — plugin's `main` module imported, `activate(host)` called (lazy — triggered by first use)
5. **Disposal** — on unload, the cleanup cascade runs in reverse

### Discovery

At startup, `PluginService.initialize()` scans `~/.daintree/plugins/` for directories. Each directory is parsed independently — one plugin failing to load doesn't block others.

Plugin directory names must match the plugin's `name` field. A plugin named `acme.linear-planner` must live in `~/.daintree/plugins/acme.linear-planner/`. Mismatched names produce a warning and the plugin is skipped.

The `plugins` root is configurable for testing via the `PluginService` constructor argument but otherwise fixed.

### Manifest validation

Validation is strict. The manifest is parsed by `PluginManifestSchema` (Zod) in strict mode, which rejects unknown top-level keys and unknown keys inside `contributes` (both the inner object itself and contributions whose individual entry schemas opt into `.strict()`). The reason is conservative: unknown keys are almost always typos, and silently dropping typo'd contributions is a bad debugging experience.

Validation also runs structural checks across the whole `contributes` block via a `superRefine` pass (#10620), not just per-field shape:

- **Duplicate contribution IDs** within any one array (`panels`, `commands`, `views`, `mcpServers`, `agents`, `settings`, `forgeProviders`, `fileDecorationProviders`, …) are rejected with a `duplicate_contribution_id` error.
- **Dangling cross-references** are rejected: a `forgeProvider`'s `settingsScopeRef` and `viewRefs[]` must resolve to declared settings/views; every `view.id` must match a declared `panels[].id` (an orphaned view that names no panel is now a hard manifest error, not a load-time warning); and `${settings:settingId}` tokens inside an MCP server's `command`/`args`/`env` must reference a declared setting (unknown tokens fail with `settings_token_unknown` / `settings_token_malformed`).

Agent `command`/`args` are the one exception to the token check: the schema does **not** validate their `${settings:*}` tokens at parse time even though the runtime resolves them at spawn (see [Environment variable substitution](#environment-variable-substitution)).

The `engines.daintree` semver range is validated and compared against the running Daintree version. A mismatch produces a user-visible toast and the plugin is skipped.

### Registration

The manifest `contributes` object has 12 contribution points (`electron/schemas/plugin.ts`). Most register eagerly at plugin-load time so the UI reflects them immediately — the command palette, toolbars, menus, keybindings, and context menus populate before any plugin code runs:

- `panels` → `registerPanelKind()` in `shared/config/panelKindRegistry.ts`
- `toolbarButtons` → `registerToolbarButton()` in `shared/config/toolbarButtonRegistry.ts`
- `menuItems` → `registerPluginMenuItem()` in `electron/services/pluginMenuRegistry.ts`
- `keybindings` → `registerPluginKeybinding()` (each entry's `when` expression is tracked so context changes re-evaluate)
- `contextMenus` → `registerPluginContextMenuItem()` (`when`-tracked like keybindings)
- `agents` → `registerPluginAgents()` — gated behind the `agent:register` capability (schema rejects `contributes.agents` without it, #9560)
- `settings` → registered through `PluginSettingsManager`, so a settings form renders whether or not the plugin is running

Commands have two registration paths. They MAY be declared in `contributes.commands` — these are registered eagerly at load as `PluginActionDescriptor`s so they appear in the palette before any plugin code runs, with their handler lazily bound to `src/{id}.{ext}` on first dispatch. Or they register imperatively via `host.registerAction()` during `activate()`. The manifest stays a static shape contract; the action system resolves handlers at runtime.

`forgeProviders` and `fileDecorationProviders` register their manifest-declared descriptors eagerly (`registerForgeProviders` / `registerFileDecorationProviders`), but their runtime implementations bind imperatively in `activate()` via `host.registerForgeProvider()` / `host.registerFileDecorationProvider()` against a declared descriptor id.

Contributions that require code are registered as **resolvers** — thunks that import the actual code when first needed. `views` are resolved lazily when their panel is first opened (#10523), and `mcpServers` are resolved lazily on first tool enumeration (#9235), not at activation. These two are the contribution points whose runtime never loads until used; together with the ten eager points above they make up the 12 entries in `contributes`.

### Activation

A plugin's `activate(host)` function runs when something first needs the plugin's code. Triggers:

- User runs a plugin-registered command
- User opens a plugin-contributed panel (`activatePluginForView` runs before the view module imports — see [Activation failures](#activation-failures))
- A forge operation reaches one of the plugin's declared providers (`activatePluginForForgeProvider`, `forgeRpcServer.ts`)
- A file-decoration pull matches one of the plugin's declared scopes (`activatePluginsForFileDecorationScope`)
- The plugin lists `"onStartupFinished"` in `activationEvents` — the one eager trigger, fired once startup settles rather than on demand

**User-installed plugins activate out-of-process.** Every sideloaded, `.dntr`/URL-installed, or `dev`-linked plugin runs inside a `utilityProcess.fork` worker (#10526): its `main` executes in a child process with its own module realm, and the host bridges every `host.*` call and registration over a MessagePort. This gives clean teardown (unload kills the worker, reclaiming the whole module realm — no ESM-cache leak, no module-scope state surviving a reload) plus OS-level crash isolation. **Built-in plugins are the exception** — they stay on the in-process `import()` loader because they're trusted, app-bundled, and never unloaded, and because the GitHub built-in's forge provider exposes synchronous host methods (`parseRemote`, URL builders) that can't cross the worker's async port.

When triggered, Daintree:

1. Resolves the plugin's `main` file path relative to the plugin directory
2. Loads the module — in the worker for user plugins, or in-process via `pathToFileURL()` + `import()` for built-ins
3. Calls the exported `activate(host)` function
4. Stores the cleanup function (if returned)
5. Enforces a 5-second timeout via `Promise.race` — exceeded activations are marked failed

Handler implementations are bound to the registered action IDs as activation resolves. Users who invoked a command before activation finished see a brief spinner; the handler runs as soon as binding completes.

### Activation failures

Opening a plugin-contributed view activates the owning plugin _before_ the renderer imports the view module. `PluginViewHost` calls `window.electron.plugin.activateForView(kindId)` and awaits it ahead of `import()`, so a failed activation surfaces as the real cause rather than a generic import timeout (#10618). The IPC handler reports every failure mode — manifest collision, an `activate()` throw, the 5-second activation timeout — through one error contract: it throws an `AppError` with code `PLUGIN_ACTIVATION_FAILED` whose `userMessage` carries the specific cause. The awaited rejection propagates to the view's error boundary, which renders the component-variant fallback with a "Try again" button; clicking it bumps the retry counter, mints a fresh `lazy()` reference, and re-runs the whole sequence — activation and import — under a fresh timeout.

When a built-in plugin's `activate()` throws after partially registering listeners, handlers, or actions, the host rolls those registrations back automatically. Before calling `activate()`, `PluginService` pre-registers a synchronous rollback (`removeHandlers`, `unregisterImperativePluginActions`, `flushPluginEventCleanups`) in the cleanup map; if `activate()` throws, the catch path fires it immediately (guarded against a double-fire from a concurrent unload), undoing every partial registration. The plugin author carries no cleanup responsibility for a failed activation. User-installed plugins reach the same guarantee a different way — their worker is torn down on activation failure, reclaiming the whole module realm.

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

For a user-installed plugin the disposal cascade is followed by killing its worker, which reclaims the plugin's entire module realm — module-scope state never survives a reload. For a built-in (which runs in-process) the module is merely orphaned: Node's module cache still holds it but no live references point to it, and since built-ins are never uninstalled that residue never accumulates.

## Renderer host

Plugin views render inside Daintree's existing panel system. They must share Daintree's React 19 instance — two React copies on one page produce "Invalid hook call" errors even if the versions match exactly.

### Sharing strategy

**Import maps + Vite externals.**

- Plugin bundles externalize React via the `@daintreehq/plugin-vite` preset, which sets `build.rollupOptions.external` to `[/^react($|\/)/, /^react-dom($|\/)/]`. The regex form covers every subpath; `external: ["react"]` matches only the literal string `"react"` and silently bundles `react/jsx-runtime` into plugin output.
- Daintree's `index.html` injects a `<script type="importmap">` at build time, mapping `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, and `react-dom/client` to the host's `vendor-react` chunk.
- When the plugin bundle executes in Daintree's renderer, those imports resolve to the host's single React instance.

Chromium (Electron 41) supports import maps natively — no polyfill required.

**`react/jsx-runtime` is not optional.** JSX compiled with the new transform (`jsx: "react-jsx"` in tsconfig) desugars to `jsx()` / `jsxs()` calls imported from `react/jsx-runtime`. If the plugin bundles its own copy of that module, every JSX element creates a React element tied to a different React instance, and hooks inside the plugin view throw at runtime. The `@daintreehq/plugin-vite` preset enforces this externalization automatically — plugin authors don't configure it manually.

**Inline-script CSP gate.** The host CSP forbids `'unsafe-inline'` for `script-src`, so the inline `<script type="importmap">` is gated by an explicit SHA-256 hash. The build emits the hash both into the `<meta http-equiv="Content-Security-Policy">` tag and into a `dist/importmap-meta.json` sidecar that the Electron main process reads at startup to mirror the hash into the HTTP `Content-Security-Policy` header. The hash MUST stay aligned across both layers — Chromium intersects header and meta, and a divergence silently drops the importmap, leaving plugins with unresolvable bare `react` specifiers.

**Integrity attribute is forbidden on the importmap tag** per the HTML spec. Subresource integrity for the importmap's target chunks (when needed) lives as a top-level `"integrity"` block inside the JSON payload, supported in Chromium 127+.

**Why not Module Federation?** Module Federation handles version negotiation between host and plugin, but adds ~30 KB of runtime and significant build complexity. Daintree controls both the host React version and the plugin template, so negotiation isn't needed.

**Why not `window.__REACT__`?** Breaks ESM tree-shaking, doesn't cleanly handle `react/jsx-runtime`, and forces plugins into a non-standard module pattern.

### Version discipline

Plugins declare a `react` peer dependency in their own `package.json`. The host version is canonical. If Daintree bumps React's major version, the plugin template's published peer range is updated and installed plugins are revalidated against the new range as part of the `engines.daintree` compatibility gate.

### Import URL flow

Plugin view modules are loaded via Daintree's `plugin://` privileged protocol. When `PluginService.loadPlugin` matches a `contributes.views` entry to a panel by bare id, it stores the resolved URL — `plugin://{pluginId}/{componentPath}` — on the `PanelKindConfig` and broadcasts it through `plugin:panel-kinds-changed`. The renderer's `PluginViewHost` calls `React.lazy(() => import(componentPath))` against that URL; Chromium 146 resolves the protocol, the response carries the `plugin://` security headers, and the bare `react` / `react/jsx-runtime` specifiers in the bundle resolve through the host import map to Daintree's single React instance.

The resolved URL travels through the renderer over the existing panel-kinds IPC broadcast — no separate channel is required. `location: "sidebar"` and an unsafe `componentPath` (absolute paths, URL schemes, `..` segments) are rejected at manifest validation, so the whole plugin fails to load loudly rather than silently dropping the view. A view that targets a panel id with no matching `contributes.panels` entry is likewise rejected at manifest validation (#10620) — an orphaned view would otherwise never render, so the whole plugin fails to load rather than silently dropping it.

### Hot reload — dev only

In dev, the host can re-evaluate a plugin view's module after the source changes. There is no production hot-reload path. V8 caches ESM module records by URL string and Chromium offers no eviction API (Vite #14438 / Chromium #350426234, unresolved as of 2026). Every cache-busting query string permanently expands the renderer's module map; iterating against a long-lived production renderer would leak memory indefinitely. Treat hot reload as a dev affordance and assume production users reach a clean state by closing and reopening the panel.

### Renderer-first teardown

The renderer is the first surface to know that a plugin's panel kind has been removed: `PluginService.unloadPlugin` fires `plugin:panel-kinds-changed` before it deletes the in-memory plugin entry, so the broadcast crosses the IPC boundary while host APIs are still live. `PluginViewHost` subscribes to that push and aborts its `disposeSignal` synchronously when its kind disappears from the payload — _before_ React unmounts the subtree. Plugin `useEffect` cleanups that listen on `disposeSignal` (fetch aborts, subscription teardown, MessagePort closes) therefore run while the plugin's IPC handlers and host APIs are still answering, instead of racing against the main-side teardown.

### Error boundaries

Every plugin view is wrapped in an error boundary by the host. A crash renders the component-variant fallback with a "Try again" button; the host wires `onReset` to bump a retry counter that produces a fresh `lazy()` reference, so `import()` is re-evaluated rather than returning the cached failed promise. The rest of Daintree is unaffected — the panel grid keeps working, other plugins keep running, the user can close the failing panel normally.

### Trusted-inline → iframe contract

Today's inline host is the right trade for curated trust. The `PluginViewHost` API surface — the `PanelViewProps` shape (`panelId`, `pluginId`, `disposeSignal`) and the broadcast-driven teardown ordering — is intentionally chosen to survive a future cutover to a trusted iframe model. `componentPath` would resolve to a sandboxed frame URL instead of a direct ESM import; the props would marshal over `postMessage`; `disposeSignal` would still abort on the same `panel-kinds-changed` removal event. No manifest change would be required on the plugin author's side.

### Inline, not iframe

Views render inline in Daintree's React tree. Plugins share Daintree's DOM, CSS cascade, and React context. This is optimal for a curated-trust model: richer integration, direct use of host UI components, native React hooks.

An iframe model would isolate plugins behind a `postMessage` bridge at the cost of heavy DX friction and rebuilt UI components per frame. That's the right trade for an untrusted-plugin model — if Daintree ever opens to fully untrusted third-party plugins, iframe isolation via a `plugin://` protocol handler is the upgrade path. Nothing in the current manifest shape needs to change — `componentPath` resolves differently for trusted vs untrusted plugins, but the field is the same.

## MCP supervisor

`PluginMcpSupervisor` (`electron/services/PluginMcpSupervisor.ts`) manages plugin-shipped MCP servers.

### Spawn timing

Servers spawn **on first tool use**, not at plugin activation. Daintree's MCP client maintains a registry of available servers (their stdio command + args + env) but doesn't establish connections until an agent tries to use one.

Rationale: a user with 10 installed plugins, each shipping an MCP server, doesn't pay the startup cost of 10 subprocesses unless they actually use them. Many MCP servers are heavy at startup (loading SDKs, validating credentials, fetching schemas).

### Tool discovery

Tool definitions themselves are fetched lazily. The first time an agent sessions attempts to enumerate available tools, Daintree queries each registered server's `tools/list` and caches the result. Individual tool schemas are only injected into the agent's context when the agent's own discovery query returns a match — inspired by Claude Code's MCP Tool Search pattern.

This matters because tool definitions consume tokens. An MCP server exposing 40 detailed tools can add 30K+ tokens to every turn. Lazy discovery pushes the cost to only the servers and tools the agent actually uses.

### Process lifecycle

- Spawn on first use per session.
- Keep alive for the duration of the agent session.
- On unexpected exit the supervisor transitions the server to `crashed`, records the error, invalidates the cached tool list, and rejects any pending calls. There is **no** automatic retry, backoff, or "degraded" state — the status enum is `spawning | ready | crashed | stopped`. Recovery is an explicit manual restart (the `pluginMcp.restart` IPC, or re-enabling the server from Preferences → Plugins), which also re-runs the trust-on-first-use tool comparison before any tool is re-injected.
- SIGTERM on Daintree quit with a 2-second grace period, then SIGKILL.
- Subprocess `stderr` is captured and logged for debugging but not exposed to agents.

### Environment variable substitution

Plugin manifest `env` values support `${settings:settingId}` syntax. Substitution happens at spawn time, reading the current setting value from the plugin's **user scope** (never project scope). An unset or `null` setting resolves to an empty string; booleans and numbers are stringified, and objects/arrays are JSON-encoded. When a user-scope setting changes, every currently running server (status `ready` or `crashed`) that references it is automatically restarted so the new value is folded in (#10619) — the restart is debounced ~1s so a burst of edits coalesces into one respawn, and a server that was never lazily started is left stopped rather than eagerly booted. See [Agent Extensions → MCP servers → Lifecycle](./agent-extensions.md#lifecycle) for the full behavior.

Plugin-contributed **agent** `command` and `args` get the same `${settings:settingId}` resolution at PTY spawn time (#10619), also against user scope. The agent path differs from MCP `env` in one respect: a referenced setting that is unset throws rather than collapsing to an empty string, so the spawn fails with a clear error instead of silently launching the agent with a blank credential. Built-in agents and plain-shell spawns skip the resolution entirely — only a plugin-contributed agent whose command actually embeds a template pays for the lookup.

### Security

MCP subprocesses run with the full privileges of the Daintree process. There's no sandboxing. The curation model — human review and trusted-source install — is the primary defense; there is no signing or publisher verification (see the [trust model](./trust-model.md)).

An MCP server can do anything the plugin could do: make network requests, read and write files, spawn further processes. The manifest's declared `capabilities` are disclosed in the plugin manager — if a plugin declares `network:fetch` because its MCP server calls Linear's API, the user sees that in the plugin's detail pane after install and decides whether to keep trusting it.

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

Plugin-supplied listeners across the host (`onDidChangeAgentState`, `storage.onDidChange`, `settings.onDidChange`, and the worktree subscriptions above) are dispatched through `invokeTrackedListener`, which quarantines a misbehaving callback. Each throw — synchronous or a rejected async return — increments a per-listener counter that is logged with its position (`1/3`, `2/3`, …); a single successful invocation resets it to zero, so intermittent failures never accumulate. After three consecutive throws the listener is auto-unsubscribed via its own disposer, so a buggy or adversarial plugin can't spam the log with a repeating error on every event.

## Capability disclosure

Capabilities are **disclosure-first with host-side policy effects** — a hybrid model. The host does not sandbox plugin code: a plugin declaring `capabilities: []` can still make network requests and write files via raw Node APIs. But declared capabilities are not purely advisory either. They drive host-side policy, most concretely danger classification on plugin-registered actions. See the [trust model](./trust-model.md) for the full decision record, decision matrix, and capability schema.

What disclosure does:

- An installed plugin's detail view shows the declared capabilities in a humanized list: "This plugin can read your worktree files, make network requests, and spawn subprocesses."
- That detail-pane list is the disclosure surface — it appears in the plugin manager after install, not as a pre-install consent gate. A fresh install runs without enumerating capabilities (see the [trust model](./trust-model.md)).

What the host derives from declared capabilities:

- **Danger classification (live today).** When a manifest holds any high-risk token in `CONFIRM_TRIGGERING_CAPABILITIES` (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`), every action that plugin registers is raised to `effectiveDanger: "confirm"` — gating the renderer's confirm dialog, MRU-rail eligibility, and `repeatLast`. The host may only raise danger, never lower it. This is host-side UX policy on Daintree's own action system; it does **not** block the plugin from executing code or calling IPC directly.
- **Compound-capability lattice (live, #9247).** Single capabilities that aren't individually irreversible can still combine into a threat. `manifestTriggersCompoundElevation()` (`PluginService.ts`) catches two compound classes: exfiltration (a sensitive read in `SENSITIVE_READ_CAPABILITIES` paired with an unconstrained `shell:exec` or `network:fetch` sink) and remote-controlled mutation (`network:fetch` paired with a local write or shell sink). A plugin attenuates the elevation by declaring a tight `scopes.network.allowedUrls` — a scoped `network:fetch` can't be remote-controlled, so the scope removes that class. Wildcard scopes are rejected at the schema boundary.
- **MCP consent tier (live, #9234).** A plugin's declared capabilities cap the danger tier its MCP server's tool surface can reach (`electron/services/plugin-mcp/PluginMcpTierAuth.ts`): a server that didn't declare a high-risk capability can't trigger a D2 confirmation just by advertising `destructiveHint: true` — the call is denied, not silently downgraded. See the trust model for the complete list.

The purpose is to let users judge plugins by what they claim to need and to apply proportional friction at high-risk intent surfaces. A simple theme-packager plugin declaring `shell:exec` looks suspicious; a Linear integration declaring `network:fetch` looks expected. Declaring honestly matters: a plugin that silently makes network requests without declaring `network:fetch` erodes the ecosystem's trust model, even though nothing blocks the call at runtime.

## Host-derived classification

The host is the sole authority on action danger classification. A plugin's self-reported `danger` in `registerPluginAction()` is advisory only — the host computes `effectiveDanger` and the renderer reads only that field for classification decisions.

### Why host-derived

Prior to #8321, the renderer trusted the plugin's self-reported `danger` field. A plugin could declare `danger: "safe"` on a destructive action and bypass the confirm dialog, MRU-rail exclusion, and `repeatLast` eligibility. The host now computes an authoritative `effectiveDanger` so a plugin cannot misclassify.

### Mechanism

The host consults the set `CONFIRM_TRIGGERING_CAPABILITIES` (defined in `shared/config/pluginCapabilities.ts`; `PluginService.ts` imports it):

| Capability           | Effect            |
| -------------------- | ----------------- |
| `shell:exec`         | Raises to confirm |
| `git:write`          | Raises to confirm |
| `fs:project-write`   | Raises to confirm |
| `fs:user-data-write` | Raises to confirm |
| `agent:invoke`       | Raises to confirm |
| `agent:register`     | Raises to confirm |
| `agent:input`        | Raises to confirm |

When a plugin's declared manifest `capabilities` includes any of these tokens, every action that plugin registers gets `effectiveDanger: "confirm"` regardless of the self-reported value. The compound-capability lattice (`manifestTriggersCompoundElevation()`) raises danger for the multi-capability threat classes described under [Capability disclosure](#capability-disclosure).

The rule is one-way: the host **may only raise danger, never lower it**. A plugin that declares `danger: "confirm"` keeps confirm regardless of capabilities; a plugin that declares `danger: "safe"` is raised if it holds a high-risk capability.

The host also computes an aggregate `pluginDanger` (`"safe" | "confirm"`) per plugin via `computePluginDanger()`, surfaced on `LoadedPluginInfo.pluginDanger` so the manager UI can show an effective-danger summary without re-deriving the lattice in the renderer. It reuses the same `CONFIRM_TRIGGERING_CAPABILITIES` set and compound lattice — a single source of truth on main rather than a third copy.

### Renderer contract

The renderer reads `PluginActionDescriptor.effectiveDanger` (not `danger`) for:

- Whether the confirm dialog gates agent-initiated dispatches
- MRU-rail eligibility in the action palette
- `ActionService.repeatLast` eligibility

If `effectiveDanger` is absent (e.g. a stale descriptor from a pre-migration cache), the renderer must fail safe to `"confirm"`.

### Scope

This classification is host-side UX policy on Daintree's own action system. It does not block the plugin from executing code, calling IPC directly, or making network requests — those are gated by the curation trust model, not by runtime enforcement (see [Capability disclosure](#capability-disclosure)).

## Signing and kill-switch

**Signing:** sideloaded and URL-installed plugins aren't signed. Trust is on the user.

**Kill-switch (planned, not yet implemented):** the design is a CDN-hosted blocklist that Daintree polls; plugins matching by `{name, versionRange, jti-if-applicable}` would refuse to load on next startup, with a banner explaining why, reserved for security responses to known-compromised plugins (not normal version deprecation). No blocklist/poll/revocation code exists in the plugin services today — treat this as a forward-looking design, not current behavior.

Detailed infrastructure for signed distribution is planned for the eventual Daintree-authored paid-plugin channel; it does not affect sideload or URL install.

## Why these choices

A short rationale for the decisions most likely to feel arbitrary:

**Why `plugin.json` instead of extending `package.json`?** The VS Code pattern of putting manifest data inside `package.json`'s `contributes` field conflates npm dev dependencies with runtime manifest. For TypeScript plugins built with Vite, the two have genuinely different shapes and lifetimes. Keeping them separate avoids the "why is my build tool looking at my contribution points?" confusion.

**Why scoped names (`publisher.plugin-name`)?** Name collisions are inevitable without a central registry. Scoped names make collisions author-caused (you control your publisher namespace) rather than ecosystem-caused. Matches npm's scoped package convention.

**Why `.dntr` instead of `.zip`?** OS file association. Double-clicking a `.dntr` opens Daintree's install flow; double-clicking a `.zip` opens the OS archiver. Also prevents accidental manual unzipping into the wrong place. The CLI accepts either, so authors who only want to ship `.zip` can.

**Why dual-path action binding (filesystem convention + imperative)?** The filesystem convention (Raycast-style: `commands[].name` → `src/{name}.ts` default export) is delightful for simple cases — zero boilerplate, co-located with declaration. Imperative registration via `host.registerAction` is needed for truly dynamic commands and matches the existing imperative pattern Daintree uses for its own ~340 built-in actions. Supporting both is cheap and handles both ends of the complexity spectrum.

**Why no runtime permission enforcement?** There is no Node sandbox and there can't be one — plugins share the host's V8 + Node process, so a plugin bypasses any custom-API gate by calling `require("fs")` or `child_process.spawn` directly. Full enforcement would require Wasm sandboxing (Zed's approach — great DX cost), iframe isolation (worse DX, breaks React integration), or a prompt on every Node call (unusable). Instead of claiming enforcement we can't deliver, declared capabilities drive host-side policy effects (danger derivation, the compound-capability lattice, and the MCP consent tier) while the model stays honest that it does not sandbox arbitrary code. See the [trust model](./trust-model.md).

**Why no separate hooks contribution point (PreToolUse/PostToolUse)?** An MCP server can act as a proxy in front of other tools, intercepting and modifying tool calls. This uses the ecosystem we're already committed to (MCP) rather than inventing a parallel API. Plugins that genuinely need this can build it cleanly.

## SDK Surface

The `@daintreehq/plugin-sdk` public type surface is defined in `shared/types/plugin-sdk.ts`. This module is the single source of truth — every symbol re-exported there is a frozen contract. Additions are non-breaking; removals are breaking.

Two entry points:

- `@daintreehq/plugin-sdk` — core types (manifest authoring, host API, forge providers, worktree projections)
- `@daintreehq/plugin-sdk/react` — renderer-facing SDK types (`shared/types/plugin-sdk-react.ts`). Currently exposes `UseHostChannelResult` (the return shape of `useHostChannel`); the runtime implementations (`useHostChannel`, `usePluginEvent`) live in `packages/plugin-sdk/src/react/` (the host re-exports them through thin `src/hooks/` shims) and reach plugins by being bundled into the plugin output by `@daintreehq/plugin-vite` — which is how the hooks resolve today. This subpath is **not** in the host import map (which serves only React specifiers), so a raw, un-bundled `plugin://` view cannot bare-import it; those views talk to the host through `window.electron.plugin.on`/`.invoke` directly (see [Host API → React hooks](./host-api.md#react-hooks)). The subpath becomes a published, import-map-served package when the SDK is extracted into its own package (F15/F36).

### Manifest authoring

Types a plugin author uses to write `plugin.json`:

| Export | Source | Notes |
| --- | --- | --- |
| `PluginManifest` | `plugin.ts` | Root manifest shape |
| `PanelContribution` | `plugin.ts` |  |
| `ToolbarButtonContribution` | `plugin.ts` |  |
| `MenuItemContribution` | `plugin.ts` |  |
| `MenuItemLocation` | `plugin.ts` | `"terminal" \| "file" \| "view" \| "help"` |
| `ViewContribution` | `plugin.ts` | Panel location only; sidebar rejected at validation |
| `ViewLocation` | `plugin.ts` | `"panel"` |
| `McpServerContribution` | `plugin.ts` | Wired via `PluginMcpSupervisor` (`experimental_` prefix retained) |
| `PluginCapability` | `plugin.ts` |  |
| `BuiltInPluginCapability` | `plugin.ts` |  |
| `PluginActionContribution` | `plugin.ts` | Shape for `host.registerAction` (F11) |
| `KeybindingContribution` | `plugin.ts` | `contributes.keybindings` entry |
| `ContextMenuContribution` | `plugin.ts` | `contributes.contextMenus` entry |
| `ContextMenuLocation` | `plugin.ts` |  |
| `PluginManifestScopes` | `plugin.ts` | `scopes` block (network/fs attenuation) |
| `PluginNetworkScope` | `plugin.ts` | `scopes.network.allowedUrls` |
| `PluginFsScope` | `plugin.ts` | `scopes.fs` |

### View component props

| Export | Source | Notes |
| --- | --- | --- |
| `PanelViewProps` | `plugin.ts` | Props passed to a plugin view component (`panelId`, `pluginId`, `disposeSignal`) |

### Host API

Types a plugin consumes at runtime via `activate(host)`:

| Export                  | Source      | Notes                                        |
| ----------------------- | ----------- | -------------------------------------------- |
| `PluginActivate`        | `plugin.ts` | Activation entry point signature             |
| `PluginHostApi`         | `plugin.ts` | Host API surface passed to `activate`        |
| `ActionHandler`         | `plugin.ts` | Handler signature for `host.registerAction`  |
| `PluginToastOptions`    | `plugin.ts` | Options for `host.toast`                     |
| `PluginLogger`          | `plugin.ts` | `host.log` logger surface                    |
| `PluginIpcContext`      | `plugin.ts` | Context passed to IPC handlers               |
| `PluginIpcHandler`      | `plugin.ts` | Handler signature for `host.registerHandler` |
| `PluginChannelSchema`   | `plugin.ts` | Typed-IPC channel schema                     |
| `PluginTypedIpcHandler` | `plugin.ts` | Typed-IPC handler signature                  |

### Settings (`host.settings`)

| Export                | Source      | Notes                                 |
| --------------------- | ----------- | ------------------------------------- |
| `SettingsApi`         | `plugin.ts` | `host.settings` surface               |
| `PluginSettingsScope` | `plugin.ts` | Settings scope selector               |
| `SettingDefinition`   | `plugin.ts` | `contributes.settings` entry shape    |
| `SettingFieldType`    | `plugin.ts` | Field-type union for setting controls |

### Worktree projections

Read-only, frozen snapshots exposed to plugins:

| Export                      | Source      | Notes                             |
| --------------------------- | ----------- | --------------------------------- |
| `PluginWorktreeSnapshot`    | `plugin.ts` | Explicit allowlist — no spreading |
| `PluginWorktreeLinked`      | `plugin.ts` | Provider-agnostic forge linkage   |
| `PluginWorktreeLinkedIssue` | `plugin.ts` |                                   |
| `PluginWorktreeLinkedPR`    | `plugin.ts` |                                   |

### Forge provider contract

Types a forge plugin implements and registers:

| Export                      | Source     | Notes                                       |
| --------------------------- | ---------- | ------------------------------------------- |
| `ForgeProviderImpl`         | `forge.ts` | Runtime contract                            |
| `ForgeProviderDescriptor`   | `forge.ts` | Passed to `host.registerForgeProvider`      |
| `ForgeProviderContribution` | `forge.ts` | Manifest `contributes.forgeProviders` entry |

### File decoration provider contract

Types a decoration plugin implements and registers:

| Export | Source | Notes |
| --- | --- | --- |
| `FileDecorationProviderImpl` | `forge.ts` | Runtime contract |
| `FileDecorationProviderDescriptor` | `forge.ts` | Passed to `host.registerFileDecorationProvider` |
| `FileDecorationContribution` | `forge.ts` | Manifest `contributes.fileDecorationProviders` entry |

### Forge projection types

Types appearing in worktree-linked and CI-status projections:

| Export              | Source     | Notes                                          |
| ------------------- | ---------- | ---------------------------------------------- |
| `NormalizedPRState` | `forge.ts` | `"open" \| "merged" \| "closed" \| "declined"` |
| `ResourceRef`       | `forge.ts` | Provider-agnostic reference to an issue or PR  |
| `CIStatus`          | `forge.ts` | CI roll-up used by `PluginWorktreeLinkedPR`    |

### Host-internal (NOT exported from SDK)

These types exist in `shared/types/plugin.ts` but are intentionally excluded from the SDK. Plugin authors should never reference them:

| Symbol | Why internal |
| --- | --- |
| `BUILT_IN_PLUGIN_CAPABILITIES` | Runtime `const` array; host schema only |
| `LoadedPluginInfo` | Host loading lifecycle; `isBuiltin` is host-private |
| `PluginActionDescriptor` | Host-computed fields (`pluginId`, `effectiveDanger`); plugin never constructs one |

### Adding a new export

1. Add the type to `shared/types/plugin.ts` or `shared/types/forge.ts` as appropriate
2. Classify it as SDK-public, SDK-react-public, or host-internal
3. If SDK-public, re-export it from `shared/types/plugin-sdk.ts` and add a row to the table above
4. If it's a new forge.js import in `plugin.ts`, the ESLint guard warns — the re-export in `plugin-sdk.ts` serves as the classification record
5. Update `shared/types/__tests__/plugin-sdk.test.ts` with a type-level assertion

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
