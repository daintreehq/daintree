# Architecture

How the plugin system works internally. Most plugin authors don't need this document — it's for people debugging nontrivial plugins, contributing to the plugin system itself, or deciding whether Daintree's model fits their extension.

## Lifecycle

A plugin's life has five phases:

1. **Discovery** — startup scan of `~/.daintree/plugins/`, plus a per-project scan of `<projectRoot>/.daintree/plugins/` on project open
2. **Manifest validation** — `plugin.json` parsed, validated against the Zod schema
3. **Registration** — eager contribution points (panels, toolbar buttons, menu items) registered in the respective registries
4. **Activation** — plugin's `main` module imported, `activate(host)` called (lazy — triggered by first use)
5. **Disposal** — on unload, the cleanup cascade runs in reverse

### Discovery

At startup, `PluginService.initialize()` scans `~/.daintree/plugins/` for directories. Each directory is parsed independently — one plugin failing to load doesn't block others.

A plugin's identity comes from its manifest `name`, never from its directory name; no root compares the two. The installer names the directory after the id it installs (`PluginInstaller.ts` moves an archive into `~/.daintree/plugins/<manifest.name>/`), so an installed plugin's folder and id agree by construction, but a sideloaded folder can be named anything. Anything that maps directories back to ids has to allow for the difference — `reconcilePluginRecipeMetadata` in `PluginService.ts` unions the scanned directory names with every id the service knows for exactly this reason.

The `plugins` root is configurable for testing via the `PluginService` constructor argument but otherwise fixed.

There are three discovery roots, and which one a manifest was found under is its **origin** (`PluginOrigin = "builtin" | "user" | "project"` in `shared/types/plugin.ts`). The origin is what the manifest gate keys its three-way rules off, and it replaced the older `isBuiltin` boolean, which could only say "first-party or not":

- `"builtin"` — shipped inside the app bundle (`plugins/builtin/`), plus the E2E sideload root, loaded on the same trust footing.
- `"user"` — the startup scan of `~/.daintree/plugins/`.
- `"project"` — `<projectRoot>/.daintree/plugins/`, scanned per project on open rather than once at startup. Unlike the other two this root is plural and dynamic: one per open project. See [Project-local plugins](#project-local-plugins).

`discoverProjectPlugins` (`electron/services/plugin/projectPluginDiscovery.ts`) is the project-root scan. It deliberately does not compare the directory name against the manifest `name`: identity comes from the manifest, and the shipping `plugins/builtin/github` directory already declares `daintree.github`, so making the rule hard for one root alone would leave the roots disagreeing about what a plugin folder is.

### Built-in plugins

A built-in plugin is Daintree code that happens to use the plugin contract. It differs from an installed plugin in ways that decide what it can do:

- **Discovery is a build-time glob, not a registry.** `scripts/build-main.mjs` bundles every `plugins/builtin/*/main/index.ts`, and `src/registry/builtinPluginRenderers.ts` eagerly globs every `plugins/builtin/*/renderer/index.{ts,tsx}` for its registration side effects. The renderer glob only survives tree-shaking because `package.json` lists that path under `sideEffects`. Adding a built-in needs no registry edit.
- **It loads in-process.** Main code runs inside Electron main, not in a worker. That is why built-ins can offer synchronous host methods, and why a built-in must never execute code it did not ship — see [Dependencies a built-in plugin owns](#dependencies-a-built-in-plugin-owns).
- **The `daintree.*` namespace is reserved to it.** A manifest outside `plugins/builtin/` may not claim that namespace. There is currently no shipping path for a first-party _installed_ plugin, so a plugin Daintree ships is a built-in.
- **It can be off by default.** `DEFAULT_DISABLED_PLUGIN_IDS` in `shared/config/pluginDefaults.ts` lists built-ins that need an explicit enable choice before their first activation.
- **It is never uninstalled, but it can be disabled live.** Disabling a built-in runs the same `unloadPlugin` cascade as any other plugin, and enabling it again reloads and activates it (`_applyEnabledToggle` in `PluginService.ts`).
- **Its renderer lives in the host bundle.** There is no `plugin://` module for it, which changes how its panel views resolve — see [Built-in plugin views](#built-in-plugin-views).
- **Activation failures are swallowed.** Main reports a built-in's activation as successful even when `activate()` throws, so a built-in's panel can still render against handlers that never registered. Handle missing handlers in the view rather than assuming activation succeeded.

Four built-ins ship today, one directory each under `plugins/builtin/`:

| Plugin                       | Contributes                                 | Default |
| ---------------------------- | ------------------------------------------- | ------- |
| `daintree.github`            | `forgeProviders`, `fileDecorationProviders` | On      |
| `daintree.gitlab`            | `forgeProviders`, `settings`                | On      |
| `daintree.markdown-editor`   | `fileEditors`, `commands`                   | Off     |
| `daintree.sveltekit-builder` | `previewTools`, `guestAdapters`, `commands` | Off     |

### Manifest validation

Validation is strict. The manifest is parsed by `PluginManifestSchema` (Zod) in strict mode, which rejects unknown top-level keys and unknown keys inside `contributes` (both the inner object itself and contributions whose individual entry schemas opt into `.strict()`). The reason is conservative: unknown keys are almost always typos, and silently dropping typo'd contributions is a bad debugging experience.

Validation also runs structural checks across the whole `contributes` block via a `superRefine` pass (#10620), not just per-field shape:

- **Duplicate contribution IDs** within any one array (`panels`, `commands`, `views`, `mcpServers`, `agents`, `settings`, `forgeProviders`, `fileDecorationProviders`, …) are rejected with a `duplicate_contribution_id` error.
- **Dangling cross-references** are rejected: a `forgeProvider`'s `settingsScopeRef` and `viewRefs[]` must resolve to declared settings/views; every `location: "panel"` view's `id` must match a declared `panels[].id` (an orphaned view that names no panel is now a hard manifest error, `view_panel_ref_unknown`, not a load-time warning), while a `location: "settings"` view must _not_ share an id with a panel (`settings_view_panel_id_collision`) and a plugin may declare at most one (`settings_view_duplicate`); and `${settings:settingId}` tokens inside an MCP server's `command`/`args`/`env` must reference a declared setting (unknown tokens fail with `settings_token_unknown` / `settings_token_malformed`).

The schema is built per origin — `getPluginManifestSchema(origin)` — so a handful of rules differ by discovery root. The reserved `daintree.*` namespace is builtin-only, and `scope: "project"` is enforced in both directions: required under the project root (`project_scope_required`), rejected under the user and builtin roots (`project_scope_not_allowed`). A project-scoped manifest additionally may not declare the contribution groups that are still structurally app-wide, or claim `contributes.surfaces` unless it is project-scoped — see [Project-local plugins](#project-local-plugins).

Agent `command`/`args` are the one exception to the token check: the schema does **not** validate their `${settings:*}` tokens at parse time even though the runtime resolves them at spawn (see [Environment variable substitution](#environment-variable-substitution)).

The `engines.daintree` semver range is validated and compared against the running Daintree version. A mismatch still loads the plugin and shows a warning toast that it may not work on this version. A local dev build (`0.37.0-dev.<stamp>`) that misses the range is also checked against the release it precedes.

### Registration

The manifest `contributes` object's contribution points (`electron/schemas/plugin.ts`) are arrays — `panels`, `toolbarButtons`, `menuItems`, `keybindings`, `contextMenus`, `commands`, `views`, `mcpServers`, `agentMcp`, `databases`, `tours`, `skills`, `forgeProviders`, `fileDecorationProviders`, `agents`, `processTools`, `settings`, `recipes`, plus the built-in-only `fileEditors`, `previewTools` and `guestAdapters` — each with a per-array cap in `MANIFEST_CONTRIBUTION_CAPS`, plus the non-array `surfaces` object. Most register eagerly at plugin-load time so the UI reflects them immediately — the command palette, toolbars, menus, keybindings, and context menus populate before any plugin code runs:

- `panels` → `registerPanelKind()` in `shared/config/panelKindRegistry.ts`
- `toolbarButtons` → `registerToolbarButton()` in `shared/config/toolbarButtonRegistry.ts`
- `menuItems` → `registerPluginMenuItem()` in `electron/services/pluginMenuRegistry.ts`
- `keybindings` → `registerPluginKeybinding()` (each entry's `when` expression is tracked so context changes re-evaluate)
- `contextMenus` → `registerPluginContextMenuItem()` (`when`-tracked like keybindings)
- `agents` → `registerPluginAgents()` — gated behind the `agent:register` capability (schema rejects `contributes.agents` without it, #9560)
- `settings` → registered through `PluginSettingsManager`, so a settings form renders whether or not the plugin is running

Commands have two registration paths. They MAY be declared in `contributes.commands` — these are registered eagerly at load as `PluginActionDescriptor`s so they appear in the palette before any plugin code runs, with their handler lazily bound to `src/{id}.{ext}` on first dispatch. Or they register imperatively via `host.registerAction()` during `activate()`. The manifest stays a static shape contract; the action system resolves handlers at runtime.

`forgeProviders` and `fileDecorationProviders` register their manifest-declared descriptors eagerly (`registerForgeProviders` / `registerFileDecorationProviders`), but their runtime implementations bind imperatively in `activate()` via `host.registerForgeProvider()` / `host.registerFileDecorationProvider()` against a declared descriptor id. `agentMcp` follows the same split with nothing registered at load: the manifest entry is what per-project enablement, launch grants and the route read, and the tool roster binds in `activate()` via `host.mcp.registerTools()` against a declared endpoint id (see [Agent MCP endpoints](#agent-mcp-endpoints)).

Contributions that require code are registered as **resolvers** — thunks that import the actual code when first needed. `views` are resolved lazily when their panel is first opened (#10523), and `mcpServers` are resolved lazily on first tool enumeration (#9235), not at activation. These two are the contribution points whose runtime never loads until used.

### Activation

A plugin's `activate(host)` function runs when something first needs the plugin's code. Triggers:

- User runs a plugin-registered command
- User opens a plugin-contributed panel (`activatePluginForView` runs before the view module imports — see [Activation failures](#activation-failures))
- A settings home mounts the plugin's `location: "settings"` view (the same `activatePluginForView` path, keyed by the synthetic `plugin-settings-view:{pluginId}` kind — see [Settings views](#settings-views))
- A forge operation reaches one of the plugin's declared providers (`activatePluginForForgeProvider`, `forgeRpcServer.ts`)
- A file-decoration pull matches one of the plugin's declared scopes (`activatePluginsForFileDecorationScope`)
- An agent lists or calls tools on one of the plugin's `agentMcp` endpoints (the plugin route calls `PluginService.activatePlugin`)
- A view's first `plugin:invoke` into one of the plugin's channels (`dispatchHandler` in `PluginService.ts` activates before routing, so handlers registered in `activate()` answer the very first call)
- The plugin lists `"onStartupFinished"` in `activationEvents` — the one eager trigger in the manifest, fired once startup settles rather than on demand

Some host-side events activate a plugin whatever its `activationEvents` say:

- A successful install or update activates the new version immediately (`PluginInstaller.ts`), as does restoring the previous version after a failed swap.
- Re-enabling a disabled plugin reloads and activates it (`_applyEnabledToggle` in `PluginService.ts`).
- Linking a plugin with `daintree-plugin dev` loads and activates it, and each settled rebuild does so again.
- Restarting a stopped or failed backend from a plugin panel (`plugin:restart-worker`, `restartPluginWorker`) retires the worker and activates a fresh one.

**User-installed plugins activate out-of-process.** Every sideloaded, `.dntr`/URL-installed, or `dev`-linked plugin runs inside a `utilityProcess.fork` worker (#10526): its `main` executes in a child process with its own module realm, and the host bridges every `host.*` call and registration over a MessagePort. This gives clean teardown (unload kills the worker, reclaiming the whole module realm — no ESM-cache leak, no module-scope state surviving a reload) plus OS-level crash isolation. **Built-in plugins are the exception** — they stay on the in-process `import()` loader because they're trusted, app-bundled, and never uninstalled (disabling one still unloads it live), and because the GitHub built-in's forge provider exposes synchronous host methods (`parseRemote`, URL builders) that can't cross the worker's async port.

When triggered, Daintree:

1. Resolves the plugin's `main` file path relative to the plugin directory
2. Loads the module — in the worker for user plugins, or in-process via `pathToFileURL()` + `import()` for built-ins
3. Calls the exported `activate(host)` function
4. Stores the cleanup function (if returned)
5. Enforces a 5-second timeout via `Promise.race` — exceeded activations are marked failed

A built-in's `import()` has a budget of its own, `IMPORT_TIMEOUT_MS` (also 5 seconds, `PluginService.ts`), separate from the `activate()` budget so a module with a hanging top-level `await` cannot pin an activation promise and stall the `Promise.allSettled` fan-outs that wait on it. A worker plugin's import happens inside the worker after its bootstrap handshake, so it counts against the activation deadline described in [Activation failures](#activation-failures).

Handler implementations are bound to the registered action IDs as activation resolves. Users who invoked a command before activation finished see a brief spinner; the handler runs as soon as binding completes.

### The worker port

A worker plugin's `host` is `PluginDevWorkerHostProxy` (`electron/services/plugin/pluginDevWorkerHostProxy.ts`): every `host.*` call becomes a `host-call` message and `PluginDevWorkerMainBridge` runs it against the real bound host in main, answering with a `host-result`. Three details of that round trip are contract:

- **Errors keep their machine-readable fields.** A failed call carries the message plus an `errorFields` bag built by `serializableErrorFields` (`pluginHostErrorFields.ts`) from an allowlist — `code` and `currentRevision` today, primitives only, oversized strings dropped, a throwing getter tolerated — and the proxy rebuilds an `Error` with those fields, never letting one overwrite `message`. That is what lets a worker plugin branch on `err.code === "REVISION_MISMATCH"` and retry against `err.currentRevision` exactly as a built-in does in process. The allowlist is deliberate: a host error can carry a path or a token as an own property, and nothing beyond the contract crosses. Messages still start with the code token (`PERMISSION_REQUIRED:`, `PATH_NOT_ALLOWED:`) for the errors that carry no `code`.
- **Cancellation crosses too.** A call made with an `AbortSignal` sends `host-cancel` when it aborts, and the bridge aborts the matching in-flight call; a worker going away aborts all of them.
- **Some capabilities never ride on the object.** A built-in plugin holds `host.fs` and `host.db` in process, so anything reachable as a property there is reachable by plugin code. The host-internal approvals — "may another host component write this file through the `host.fs` gate", "may this database be backed up to this path" — therefore live in `WeakMap`s keyed by those objects (`pluginInternalApprovers.ts`), and the worker bridge reaches the backup approver over its own `db.prepareBackup` message rather than through anything a plugin can call.

`host.db` is split across the port the other way. Main resolves and contains a declared database's location (`pluginDatabase.ts`) — including the consent prompt for a project database and the backup destination check — and the connection itself is opened by `shared/utils/pluginDatabaseHandle.ts` wherever the plugin's code runs, over that runtime's `node:sqlite`. Queries therefore never cross the port, and a slow one stalls only its own worker. The handle is bound to the plugin instance that opened it and is closed on unload.

Zero-build workers get the SDK the same way the worker gets everything else: before any plugin code loads, the bootstrap installs a resolve hook that serves `@daintreehq/plugin-sdk`, `/files` and `/data` from a copy shipped with the app when the plugin has none of its own (see [SDK surface](#sdk-surface)).

### Worker crashes and idle disposal

`PluginDevWorkerHost` (`electron/services/plugin/PluginDevWorkerHost.ts`) forks each worker with `--max-old-space-size=256`, so a plugin's main-side heap is capped at 256 MB.

**Crash respawn.** An unintended worker exit — a bootstrap throw, a segfault, an out-of-memory kill — is respawned immediately, and the replacement re-runs `activate()` from a fresh module realm; the bridge retires everything the outgoing generation registered first, so nothing is duplicated. Three unintended exits within 30 minutes (`CRASH_THRESHOLD`, `CRASH_WINDOW_MS`) trip the crash-loop guard: the host stops respawning and `PluginService` publishes the runtime status `failed` with reason `crash-loop`. Nothing restarts it automatically after that; the user restarts it from the panel, re-enables the plugin, or — under `daintree-plugin dev` — saves a fix. A dev rebuild never counts toward the cap: it replaces the whole plugin with a fresh host and an empty crash window rather than respawning the old one. A deliberate dispose is not a crash either.

**Idle disposal.** When the app enters the efficiency resource profile, worker governance asks `PluginService.disposeIdlePluginWorkers()` to dispose workers that have been idle for at least `WORKER_IDLE_DISPOSE_MS` (30 minutes, `shared/utils/workerGovernancePolicy.ts`). Idle is measured from the last `activatePlugin` call, which every lazy trigger and every `plugin:invoke` passes through. Disposal is the narrow `deactivateWorker` teardown: the worker, its bridge and its activate-time registrations go, while the plugin, its manifest contributions and its agent MCP grants stay, and the next trigger forks a fresh worker. It is deliberately conservative, so most plugins are never eligible. `canDisposeIdlePluginWorker` refuses when the plugin:

- is a built-in (it runs in process) or is linked by `daintree-plugin dev`
- contributes any `panels` or `mcpServers`
- activates on `onStartupFinished`
- holds a live event subscription, or registered an action with `host.registerAction` that has no matching manifest command (with no manifest descriptor to re-fork through, it could not come back); an imperative handler for a declared command does not block disposal
- has an invoke or a host call in flight
- has a managed process running or a `host.fs` watcher open
- has no recorded activity, or has an enable/disable transition or an activation in flight

### Activation failures

Opening a plugin-contributed view activates the owning plugin _before_ the renderer imports the view module. `PluginViewHost` calls `window.electron.plugin.activateForView(kindId)` and awaits it ahead of `import()`, so a failed activation surfaces as the real cause rather than a generic import timeout (#10618). The IPC handler reports every failure mode — manifest collision, an `activate()` throw, the 5-second activation timeout — through one error contract: it throws an `AppError` with code `PLUGIN_ACTIVATION_FAILED` whose `userMessage` carries the specific cause. The awaited rejection propagates to the view's error boundary, which renders the component-variant fallback with a "Try again" button; clicking it starts a fresh load attempt that re-runs the whole sequence — activation and import — under a fresh timeout, on a fresh view generation when it was the import that failed (see [The plugin view load path](#the-plugin-view-load-path)).

When a built-in plugin's `activate()` throws after partially registering listeners, handlers, or actions, the host rolls those registrations back automatically. Before calling `activate()`, `PluginService` pre-registers a synchronous rollback (`removeHandlers`, `unregisterImperativePluginActions`, `flushPluginEventCleanups`) in the cleanup map; if `activate()` throws, the catch path fires it immediately (guarded against a double-fire from a concurrent unload), undoing every partial registration. The plugin author carries no cleanup responsibility for a failed activation. User-installed plugins reach the same guarantee through their worker bridge: an unsuccessful activation retires that worker generation, which clears its imperative registrations and disposes the subscriptions, decoration providers and spawned processes it had acquired. Two deadlines bound the path — a fork-to-ready budget in `PluginDevWorkerHost`, so a worker that forks but never completes its bootstrap handshake is killed rather than left pending forever, and the 5-second `activate()` budget in `PluginService`. Blowing either is terminal for that generation: the plugin id is never cached as activated, so a re-open or Settings → Retry genuinely re-runs activation instead of short-circuiting on a cached success. A packaged plugin's worker is torn down outright and the next trigger forks a fresh one; a dev plugin's is left alive because its recovery path is `PluginDevArtifactWatcher` reconciling the whole plugin on the next rebuild. Startup work that is legitimately slow belongs behind activation as cancellable work — `activate()` should return promptly and let the deadline guard genuine hangs.

### Disposal

`PluginService.unloadPlugin()` (`electron/services/PluginService.ts`) is a fixed forward sequence, not a LIFO stack. Each registry step runs inside its own `runUnloadStep`, which catches and logs a throw, so one failing step never strands the steps after it — a partial unload would otherwise resurface as duplicate-id errors on the next load. `src/utils/disposable.ts` (`DisposableStore`, `toDisposable`) is the renderer's LIFO disposable pattern; the unload cascade does not use it. Its `add()` takes an `IDisposable`, so a plain cleanup function is wrapped first:

```ts
const store = new DisposableStore();
store.add(toDisposable(() => subscription.unsubscribe()));
store.add(someResource); // anything with a dispose() method
// ... later:
store.dispose(); // disposes entries in reverse order
```

The unload order:

1. **Agent MCP credentials, then rosters.** Every grant for the instance is revoked — or, on a reload, held (see [Agent MCP endpoints](#agent-mcp-endpoints)) — and only then are its tool rosters dropped, so no live grant can resolve to an empty endpoint or to the next generation's tools.
2. **Activation state and the cleanup entry.** The activation cache is cleared and the instance's `cleanupMap` entry runs. For a worker plugin that entry disposes the worker; for a built-in it is the function `activate()` returned, if any.
3. **Event cleanups** (`flushPluginEventCleanups`): worktree, agent-state and other host subscriptions, listener watchers, per-provider forge and decoration disposers, in-flight `host.documents.renderPdf` calls (rejected with `RENDER_CANCELLED:`), and a built-in's open `host.db` handles.
4. **Contributions**, one step each: site-preview guest bindings, IPC handlers, actions, menu items, keybindings, context menu items, `when`-clause tracking, toolbar buttons, panel kinds, panel lifecycle listeners and queued panel reloads, forge providers (descriptors, implementations, then a workspace-host notify), file decoration providers, skills, recipes, tours, agents and process tools (each re-mirrored to the pty-host), settings and storage caches. The registries whose snapshots the renderer holds schedule their broadcasts as they go.
5. **Host-owned resources**: managed processes are killed, `host.fs` watchers closed, and `PluginMcpSupervisor.shutdown({ pluginId })` stops the plugin's MCP servers with execa's kill escalation (see [MCP supervisor → Process lifecycle](#process-lifecycle)).
6. **Bookkeeping and UI**: load-error markers, runtime status and the log ring buffer are dropped, open UI prompts resolve as dismissed (`undefined`/`false`, never a throw), the `plugin://` authority is invalidated, the plugin entry, activity record, metrics and host binding are deleted, and the runtime status is emitted as `null` so a renderer holding a settings view retires it.
7. **Last**: the contribution scope index entry, surface claims, panel badges (cleared in the renderer when there were any) and, when the plugin declared decoration scopes, a `plugin:decorations-changed` push per scope so renderers drop its decorations.

A worker plugin's `host.db` handles are opened inside the worker and die with it.

**The worker goes first.** For a user-installed plugin, step 2 disposes the worker before any registry step runs: the host posts `dispose`, the worker calls the cleanup function `activate()` returned (synchronously; a returned promise is not awaited) and exits, and the host kills it if it is still running after `DISPOSE_TIMEOUT_MS` (1 second, `PluginDevWorkerHost.ts`). Exiting reclaims the plugin's entire module realm, so module-scope state never survives a reload. For a built-in (which runs in-process) the module is merely orphaned: Node's module cache still holds it, and re-enabling imports that same cached module and calls `activate()` again — so a built-in's module-scope state does survive a disable and re-enable.

## Dependencies a built-in plugin owns

An installed plugin is its own npm package: it declares dependencies in its own `package.json` and `@daintreehq/plugin-vite` bundles them into a self-contained `dist/`. A built-in plugin has no such boundary — its main code is bundled by `scripts/build-main.mjs` and its renderer by the host Vite build — so where a dependency lives needs a deliberate choice.

**Put it in a workspace package under `packages/`.** The package declares the dependency; the built-in imports the package. This is the repo's existing mechanism, and it keeps the dependency out of Daintree's root manifest. Adding a package means appending it to `typecheck:projects` and `packages:build` in the root `package.json`, and giving it the house `tsconfig.json` and `tsup.config.ts`. Mark a large dependency `external` in the package's `tsup` config and `await import()` it from the plugin, so it never sits on the eager main-process path — activation has a 5-second budget. npm still hoists the dependency physically into the root `node_modules` and records it in the root lockfile; what moves is ownership of the declaration.

Two approaches that look reasonable and are not:

- **A `package.json` directly under `plugins/builtin/<name>/`.** The root `workspaces` array does not include it, so a root `npm install` — and CI's `npm ci` — never installs it, and tests that depend on it cannot run in CI. Worse, `build-main.mjs` copies the built-in's directory into the app, `node_modules` included, and the packaging allowlist lets it through: the dependency ships inside the packaged app by accident.
- **Resolving the user's own copy at runtime** — for example `createRequire(projectRoot)("svelte/compiler")` to parse a project with the exact compiler it uses. Built-ins run in-process in Electron main, so this executes project-controlled JavaScript inside the trusted process. Pin and bundle your own copy, and handle version skew with an explicit support check against the project's installed version instead.

**A workspace package's `dist/` goes stale locally.** Its `prepare` script builds `dist/` when `npm install` runs, and imports by package name resolve to that `dist/`. After that the build does not track `src/`, so code importing the package by name can load an old build — including throwing stubs from before the implementation existed. CI's fresh install hides this entirely. Rebuild with `npm run build --workspace=packages/<name>` after changing the package, before testing anything that imports it by name.

## Project-local plugins

A project can ship plugins in its own repository at `<projectRoot>/.daintree/plugins/`. The author-facing guide is [Project-local plugins](./project-local.md); this section is the internal shape.

`ProjectPluginController` (`electron/services/plugin/ProjectPluginController.ts`) is a `PluginService` collaborator in the same injected-callback-bag shape as `PluginInstaller` and `PluginSettingsManager` — it never imports the facade back. It owns one entry per open project: the trust decision, the last discovery result, the set of manifest ids the project has ever had (`known`), the set staged but not run (`staged`), and the map of what is loaded. Every mutation runs on a per-project serialization chain behind a generation counter, so a close or a revoke landing mid-scan cancels the load that was already in flight rather than being undone by a teardown queued behind it.

### Discovery executes nothing

`discoverProjectPlugins` reads and parses `plugin.json` and stops there. It never stats `dist/`, resolves `main`, imports a module or forks a worker. This is a hard property, not an implementation detail: discovery runs _before_ the trust gate on a folder anyone who can push to the repository can write, so a project the user has never trusted must be fully describable without a line of its code having run. Symlink containment matches the `plugin://` handler — every candidate directory and `plugin.json` is realpath-resolved and checked against the realpath-resolved project root — and a manifest over 512 KB is refused outright.

### Trust

One gate, at the project folder, once. `ProjectPluginController` emits a trust prompt only when the folder holds at least one valid manifest and no decision is on record; the three outcomes are `"disabled"` (persisted, never re-prompts), `"session"` (memory only, written nowhere) and `"enabled"` (persisted). The record lives under `projectPluginTrust` in `electron/store.ts`, keyed by `projectId` — deliberately in Daintree's own store and never in the repository, because a decision a repository could carry would be a decision the repository makes for you.

Content changes never re-prompt. The one content signal kept is a manifest id the project has **never had**: it is parsed, listed as `staged`, announced once, and not activated until the user clicks through. A revoke unloads everything the project owns, invalidates its authorities, and purges its capability grants; a close unloads but keeps the decision.

Only the project root is scanned, so worktrees inherit the project's decision by construction rather than by a special case.

### Identity

Four keys, and collapsing any two is where the model breaks:

| Key | Shape | Lifetime |
| --- | --- | --- |
| Manifest id | `acme.dashboard` | Source-controlled |
| Instance key | `project__{projectId}__{acme.dashboard}` | While loaded, and in every durable record |
| Runtime panel kind id | `project:{projectId}/{manifestId}/{kindId}` | While loaded |
| Protocol authority | `pi-` + 32 hex | While loaded |

The instance key is what `PluginService.plugins`, the contribution registries, the `plugin://` resolver map, the capability-consent subject and the **user-scope** settings/storage filenames all index on, which is what keeps two projects shipping the same manifest id genuinely separate. The separator is `__` rather than `/` or `:` because the key is joined onto filesystem paths, and neither half can contain it (a project id is lowercase hex, a manifest id is `publisher.name`). Two things deliberately do not use it: the trust record is keyed by `projectId` alone, and files written into the git-tracked `<projectRoot>/.daintree/` are named by the bare manifest id, because an instance key embeds this machine's project id and committing that would make every other checkout read nothing.

Panel kinds are the subtle one, because `PanelKindConfig.id` is persisted inside saved layouts. The intent is that the qualified runtime id never reaches persistence: layouts should store `PersistedPanelKindRef` (`{ origin, pluginId, kindId }`, no project id — layouts are already project-associated) and re-qualify against the owning project at restore, through `toRuntimePanelKindId` / `toPersistedPanelKindRef` in `shared/config/panelKindRegistry.ts`. **Only the qualifying half is wired.** `PluginService` builds the runtime id through `toRuntimePanelKindId`, but `panelPersistence.ts` still writes `kind: t.kind` verbatim and nothing on the save or restore path calls `toPersistedPanelKindRef` — today it has one caller, `PluginMissingPanel`, which uses it to name the missing plugin. So a project-qualified kind currently does reach saved layouts, and a re-clone at a different path would orphan those panels. The unqualification is the piece still to land. A panel whose kind no longer resolves renders `PluginMissingPanel` and is retained, never deleted.

### Contribution scoping

Every registration is tagged with a scope and filtered at broadcast and query time (`PluginContributionBroadcaster`). Global mutations broadcast as before; project-scoped mutations go to that project's renderers only, and the cold-start replay (`pushSnapshotTo`) takes the target view's `projectId` and pushes `global ∪ that project`. Getting that replay wrong is invisible until a project view is recreated after LRU eviction and suddenly sees another project's panels, which is why it takes the project explicitly rather than inferring one.

Panels, commands/actions, toolbar buttons, keybindings, context menus and settings scope cleanly. The groups that register into a registry with no project axis at all — `menuItems`, `agents`, `skills`, `recipes`, `fileDecorationProviders`, `processTools`, `mcpServers`, `tours` — are rejected at manifest validation for `scope: "project"`, each with an error (`<group>_project_scope_forbidden`) naming its structural obstacle, rather than accepted and silently over-published. `fileEditors` is in the same list because its slot resolves through the host-bundled builtin view registry, which no project plugin's renderer can register into. `previewTools` and `guestAdapters` never reach this check: they are built-in-only under every scope (`<group>_builtin_only`). `forgeProviders` is rejected for a different reason (`forge_provider_project_scope_forbidden`): its host methods are synchronous and cannot cross the worker's message port. `PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS` in `electron/schemas/plugin.ts` is the enumerated set of nine, so a group that later grows a project axis is removed in one place. `agentMcp` is allowed: its credentials are minted per terminal launch and bound to one project, and the grant registry refuses to pair a project plugin's instance with any project but its own.

### Host binding

`createPluginHost` takes a `PluginHostBinding` (`{ projectId, projectRoot }`) and captures it **once, at construction**. Every closure reads the captured values; no bound host method resolves a project, worktree, or renderer from focus. That covers renderer dispatch and `host.actions.*`, the UI prompts, worktree getters and events, agent-state events, `sendToActiveAgent`, `sendToAgent` and `agents.list` (and the picker `sendToAgent` opens, which is drawn in the bound project's view), `host.db` location resolution, `settings.open`, toasts and renderer pushes, and settings and storage `"project"` scope resolution. `host.storage` at `scope: "worktree"` is bound too: `storageTargetFor` passes an explicit `worktreePath` from `resolveBoundWorktreeTarget`, selected on each call from the bound project's own worktree snapshot, so it never reads the app-global focused worktree. If that project has no resolvable current worktree the call fails closed with no storage target rather than falling back; only a genuinely unbound host still resolves worktree scope ambiently.

A bound round-trip with no live renderer for its own project throws `PROJECT_VIEW_UNAVAILABLE` (`shared/types/appError.ts`) rather than falling back — the fallback _is_ the confused-deputy bug. `resolveTargetWebContents` in `electron/services/plugin/rendererTargeting.ts` is the single decision point: nullish `projectId` means unbound and resolves ambiently, anything else resolves that project or throws. The throw reaches the plugin as a rejection from `host.dispatch` and the UI prompts; the read-only catalog surfaces (`host.actions.list` / `get` / `canDispatch`) are documented never to throw, so they catch exactly this code and answer empty. A cached (backgrounded but retained) view still counts as live; a visible view wins when the project is open in more than one window.

Installed and builtin plugins keep an unbound binding (`UNBOUND_PLUGIN_HOST_BINDING`) and the ambient behaviour they always had. Making them project-bound is a separate product decision; what this feature delivers is that the binding exists, project plugins always have one, and a bound plugin's resolution path never consults focus. The one exception is opt-in per call: an installed plugin that declares `project:dispatch` and has the user's **Allow project targeting** grant (a `"global"`-scope record in the capability consent store, written only by the Plugin Manager switch) can pass `{ projectId }` to `host.dispatch`, which resolves through the same strict path. A bound plugin passing any other project's id is refused before the grant is consulted. Every dispatch — bound, targeted or ambient — thaws a CDP-frozen view before sending (`electron/utils/thawThenSend.ts`, shared with the MCP bridge), so a cached target answers instead of stranding the request until its timeout.

### Execution

Project plugins load with `origin: "project"` and `isBuiltin: false`, so they always activate through `activateViaWorker` — the in-process builtin loader is never used for them. One worker per plugin _instance_, keyed by the instance key, so a crash in one project plugin does not take out its siblings. `main` is realpath-contained to the plugin directory before it is imported: a `dist/index.js` that symlinks out of the plugin is ignored rather than executed. Activation still obeys the manifest's own activation events — a trusted project plugin without `onStartupFinished` does not run until one of its contributions is used.

Project open and close are wired through `electron/window/projectPluginLifecycle.ts`, both as fire-and-forget dynamic imports so neither path blocks on plugin work. "Opened" hangs off the project switch (where the project actually comes into use) and "closed" off `project:close` (where the user says so). **LRU eviction is not a close**: the project is still open, its terminals still run, and its plugins survive the renderer being reclaimed — the recreated view gets a full project-aware snapshot push.

### Hot reload for project plugins

`ProjectPluginWatcher` holds one `@parcel/watcher` subscription per trusted project over `<projectRoot>/.daintree/plugins`. `plugin.json` and `dist/` are the only paths that count; `src/`, `node_modules/` and `.git/` are ignored, because the host does not know how a given plugin builds and a source write says nothing about whether a loadable artifact exists yet.

A settled burst is treated as "rescan that plugin directory", never as "these exact files changed" — FSEvents coalesces a mass rewrite into a directory-level flag — and the rescan is handed back to the ordinary project-open reconcile rather than to a second loader, which is what makes the trust gate, the staging rules, the serialization chain and the generation guard apply to a reload for free. Four properties are the watcher's own:

- **A ~200 ms trailing debounce.** Rebuilds and branch switches arrive as storms.
- **Deferral behind `.git/index.lock`.** While the lock exists the tree is mid-rewrite and any scan of it is a scan of a half-applied state. The wait is capped at 30 seconds so a crashed `git` cannot silently stop the watcher.
- **A per-directory artifact fingerprint** over `plugin.json` + `dist/` (path, size, nanosecond mtime per file). Without it, FSEvents replaying pre-subscribe history would make every project open immediately reload everything it had just loaded.
- **An invalid manifest keeps the running version.** The rescan happens before anything is unloaded; a currently-active plugin whose `plugin.json` stops parsing is retried with a short backoff, and only a manifest still broken afterwards falls through to the reconcile that disables it. A directory that has vanished is a different signal and unloads immediately.

Reloads are per plugin directory, not per project. Each one mints a fresh `__dtv-` view generation, which is what makes the renderer re-import the bundle; the watcher reports the session's generation count so the accumulation is measured rather than assumed. Settings and `host.storage` survive a reload because both are files keyed by identity; module-scope state and React state do not.

### Surfaces

`contributes.surfaces` is the one contribution that _replaces_ something the host already draws, so it needs an arbiter the other points do not — two panels of the same name coexist, two empty canvases cannot. `PluginSurfaceRegistry` is that arbiter: one owner per `(projectId, slot)`, first claim wins, and a second claimant is refused with both names logged rather than silently overwriting. The refusal is a diagnostic, not a load failure — the second plugin still loads and its other contributions register. A refused claimant is remembered rather than discarded, so it inherits the slot if the incumbent unloads — nothing would ever retry it otherwise, because a loaded plugin is not scanned again.

`emptyCanvas` is the only slot the schema accepts. A claim is only published when the named view actually registered a panel kind with a resolvable `componentPath`; a claim that would hold the slot and render nothing is dropped with a warning and the slot keeps its stock content. The renderer wraps the region in `ProjectSurfaceFrame`, which always offers a way back to the stock launcher — nothing here can remove host chrome, which is the boundary that keeps a broken plugin from stranding the user.

`projectHome` and `defaultLayout` are described in the design notes and are deliberately not implemented: this renderer has no per-project routing a persistent home surface could live at, and a recipe is launched against a worktree rather than against a project cold open. Accepting either now would put a field in a frozen public contract that nothing reads.

### Settings views

A plugin may declare one `location: "settings"` view. It names no panel kind, so it is activated and keyed by a synthetic kind id, `plugin-settings-view:{instanceKey}` (`pluginSettingsViewKindId` in `shared/types/plugin.ts`), which `activatePluginForView` recognises. `PluginSettingsView` mounts it in the plugin's one settings home — the plugin manager for an installed plugin's `user` fields, Project settings → Plugins for everything project-bound — inside the same contained plugin surface a project surface gets, and hands it `settingsContext: { scope, projectId }`.

The renderer caches one runtime per instance: the content factory for the view's module URL and an `AbortController` standing in for a panel record's removal signal. A settings view has no panel whose removal broadcast would tell it the plugin is gone, and the settings pages mount only while shown, so retirement hangs off main's app-wide `plugin:runtime-status-changed` push instead: a `null` status (disabled, muted, uninstalled, trust withdrawn) or a new view generation (a reload) aborts the removal signal and drops the factory, whether or not a settings page is open. A stopped plugin's section is drawn from its declarations as unavailable rather than mounted. Fields a settings view owns are declared `editor: "view"`, and the generated form omits them only while such a view exists.

## Renderer host

Plugin views render inside Daintree's existing panel system. They must share Daintree's React 19 instance — two React copies on one page produce "Invalid hook call" errors even if the versions match exactly.

### Sharing strategy

**Import maps + Vite externals.**

- Plugin bundles externalize React via the `@daintreehq/plugin-vite` preset, which sets `build.rollupOptions.external` to a function matching `/^react($|\/)/`, `/^react-dom($|\/)/`, `/^@daintreehq\/tour($|\/)/` and `/^@daintreehq\/plugin-ui($|\/)/` (and rejecting any React, tour or plugin-ui subpath the host import map does not serve). The pattern form covers every subpath; `external: ["react"]` matches only the literal string `"react"` and silently bundles `react/jsx-runtime` into plugin output.
- Daintree's `index.html` injects a `<script type="importmap">` at build time, mapping each of `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, and `react-dom/client` to its own facade module — a small chunk that re-exports only that specifier's public surface. Every facade is backed by the host's single `vendor-react` chunk. `@daintreehq/tour`, `@daintreehq/tour/react`, `@daintreehq/tour/kit` and `@daintreehq/tour/mock-app` get facades too, backed by the host's single `tour` chunk, which loads only when a tour or a plugin scene first imports it. `@daintreehq/plugin-ui` (the [UI kit](./ui-kit.md), compiled from `src/pluginUi`) gets one backed by the `plugin-ui` chunk; the facade itself is small, and it requests the chunk holding every kit adapter the moment a view imports it.
- The map also serves one **raw-only** specifier, `@daintreehq/plugin-sdk/react`, backed by a `plugin-sdk-react` chunk compiled from the SDK's own source. `HOST_IMPORTMAP_RAW_ONLY_SPECIFIERS` in `packages/plugin-vite/src/hostImportMap.ts` keeps it apart from `HOST_IMPORTMAP_SPECIFIERS`, the externals contract: the preset deliberately does not externalize it, so a bundled view keeps the SDK version it pinned and a host upgrade never swaps its hooks, while a zero-build view, which has no bundler to supply them, gets the host's copy. There is one instance per document, so every raw view shares `useCachedHostChannel`'s cache and `useNow`'s timers. The facade's exports are held to exactly the `/react` entry's runtime names (`src/pluginSdkReact/runtimeExports.ts`, pinned by a test against `packages/plugin-sdk/src/react.ts`).
- When the plugin bundle executes in Daintree's renderer, those imports resolve through the facades to the host's single React instance.

Chromium (Electron 42) supports import maps natively — no polyfill required.

**`react/jsx-runtime` is not optional.** JSX compiled with the new transform (`jsx: "react-jsx"` in tsconfig) desugars to `jsx()` / `jsxs()` calls imported from `react/jsx-runtime`. If the plugin bundles its own copy of that module, every JSX element creates a React element tied to a different React instance, and hooks inside the plugin view throw at runtime. The `@daintreehq/plugin-vite` preset enforces this externalization automatically — plugin authors don't configure it manually.

**Inline-script CSP gate.** The host CSP forbids `'unsafe-inline'` for `script-src`, so the inline `<script type="importmap">` is gated by an explicit SHA-256 hash. The build emits the hash both into the `<meta http-equiv="Content-Security-Policy">` tag and into a `dist/importmap-meta.json` sidecar that the Electron main process reads at startup to mirror the hash into the HTTP `Content-Security-Policy` header. The hash MUST stay aligned across both layers — Chromium intersects header and meta, and a divergence silently drops the importmap, leaving plugins with unresolvable bare `react` specifiers.

**Integrity attribute is forbidden on the importmap tag** per the HTML spec. Subresource integrity for the importmap's target chunks (when needed) lives as a top-level `"integrity"` block inside the JSON payload, supported in Chromium 127+.

**Why not Module Federation?** Module Federation handles version negotiation between host and plugin, but adds ~30 KB of runtime and significant build complexity. Daintree controls both the host React version and the plugin template, so negotiation isn't needed.

**Why not `window.__REACT__`?** Breaks ESM tree-shaking, doesn't cleanly handle `react/jsx-runtime`, and forces plugins into a non-standard module pattern.

### Version discipline

Plugins declare a `react` peer dependency in their own `package.json`. The host version is canonical. If Daintree bumps React's major version, the plugin template's published peer range is updated and installed plugins are revalidated against the new range as part of the `engines.daintree` compatibility gate.

### Import URL flow

Plugin view modules are loaded via Daintree's `plugin://` privileged protocol. When `PluginService.loadPlugin` matches a `contributes.views` entry to a panel by bare id, it stores the resolved URL on the `PanelKindConfig` and broadcasts it through `plugin:panel-kinds-changed`. The renderer's `PluginViewContent` imports that URL once activation has resolved ([The plugin view load path](#the-plugin-view-load-path)); Chromium resolves the protocol, the response carries the `plugin://` security headers, and the bare `react` / `react/jsx-runtime` specifiers in the bundle resolve through the host import map to Daintree's single React instance. Relative imports resolve against the same authority, and the protocol serves `.js` and `.mjs` alike as `text/javascript` (`electron/utils/appProtocol.ts`) — the responses carry `nosniff`, so a module shared between a worker and its view would otherwise fail as `application/octet-stream`.

**The URL authority is opaque, not the plugin id.** Every load mints an authority — `pi-` plus 32 hex characters from a CSPRNG — and host-built URLs use it: `plugin://pi-{token}/__dtv-{n}/dist/panel.js`. The authority is never reissued, so a URL captured before an unload 404s forever rather than resolving into whatever next occupies that plugin id, and two projects shipping the same manifest id get separate authorities and separate trees. `mintPluginAuthority` seeds a second key into the same resolver map as an **alias**: the plugin's host-side id, which is the manifest id for an installed plugin and the instance key for a project-local one. That alias is what keeps a hand-written `plugin://{pluginId}/…` URL working (`contribution-points.md` documents the form, and the `pluginId` a view is handed is exactly this key). It is rebound on every reload and dropped on unload. Treat the authority as the real addressing unit — nothing should assume the hostname is a bare manifest id — and do not treat it as a secret. It is a namespace, not a capability.

The resolved URL travels through the renderer over the existing panel-kinds IPC broadcast — no separate channel is required. `location: "sidebar"` and an unsafe `componentPath` (absolute paths, URL schemes, `..` segments) are rejected at manifest validation, so the whole plugin fails to load loudly rather than silently dropping the view. A view that targets a panel id with no matching `contributes.panels` entry is likewise rejected at manifest validation (#10620) — an orphaned view would otherwise never render, so the whole plugin fails to load rather than silently dropping it.

### Built-in plugin views

A built-in plugin's renderer is compiled into the host bundle, so the `plugin://` flow above has nothing to import. Built-in panel views resolve in-process instead, through `src/registry/builtinRendererRegistry.ts`.

- The renderer entry calls `registerBuiltinView(slotId, Component, { pluginId, label })` at module load, where **`slotId` is the runtime panel kind id `{pluginId}.{panelId}`**. Use literal ids: `src/registry/__tests__/builtinViewRegistrations.test.ts` reads each built-in's renderer entry as text and fails when a manifest panel view has no registration under its kind id, or is registered under a different plugin id.
- `PluginViewContent` takes the in-process path when a slot is registered under the kind id **and** its `pluginId` matches the kind's plugin. Otherwise it falls back to `plugin://` — which for a built-in fails as an import error or a timeout rather than a clear message, so a typo'd id shows up as a broken panel, not a helpful one.
- The in-process path keeps the lifecycle that matters: `activateForView`, the activation timeout, the diagnostics error boundary with Try again, `disposeSignal` and `panelRemovedSignal`, and the newer-state-version refusal. It skips style preparation, document runtime registration and the import itself; styling comes from the host's own Tailwind build. It does wait for the UI kit, exactly as a `plugin://` view does.
- **Builtins draw through the public kit.** A builtin renderer (`plugins/builtin/*/renderer/**`) imports `@daintreehq/plugin-ui`, not the host's `src/components/ui` primitives: an ESLint `no-restricted-imports` block in `eslint.config.js` lists every host export the kit covers and fails the import. A builtin that still needs one gets a file-scoped exception naming the exports and, in the block's `name`, the kit gap; `src/components/ui/__tests__/bundledPluginPrimitives.contract.test.ts` fails an exception the file no longer uses. That keeps first-party plugins on the same surface third parties get, so a gap in the kit is found and closed there. See [UI kit → Builtins draw through the kit](./ui-kit.md#builtins-draw-through-the-kit).
- Registration can arrive after the panel mounted. The attempt is replaced and the old `disposeSignal` aborts.
- `contributes.views[].componentPath` must still be present to satisfy the schema; it is never imported for a built-in.
- **A failed chunk load cannot be retried in place.** Chromium makes a rejected dynamic import permanent for its specifier, and a built-in's view chunk has a fixed, host-bundled URL, so there is no fresh generation to fall back to the way `plugin://` views get one (`requestRecoveryPath`). Try again recovers a view that _threw_, not one whose chunk failed to load; that needs the project view reloaded. Keep the view's first chunk small so this stays rare, and don't wrap it in a module-level `React.lazy` expecting retry to re-import it.
- **`disposeSignal` also fires for temporary unmounts** — a sibling panel maximised, a dock tab left. State that must survive those (a preview binding, an undo history) belongs in a controller keyed by `panelId` that subscribes to `panelRemovedSignal` itself; a listener registered by the view is lost when the panel is removed while the view is unmounted. Plugin deactivation is a third boundary distinct from both: the panel record survives it, but main-side state does not.

### The plugin view load path

`PluginViewContent` (`src/components/Plugin/PluginViewContent.tsx`) owns every open of a plugin view, builtin or `plugin://`. Three rules shape it.

**No Suspense on the load path.** Each open is a load attempt whose `run()` the component starts from an effect and whose result it takes as plain state. The earlier design suspended on a `React.lazy` view, and React holds a Suspense boundary's reveal until 300 ms after its fallback committed, so every open — even of a view already in memory — paid that throttle. A settled attempt is now an ordinary update the next commit shows. The load skeleton is gated separately (nothing for 200 ms, then held for its floor once shown), and the only Suspense fallback left is for a view that suspends on its own after it has loaded, such as a builtin's lazy chunk.

**Activation before render, always.** A cold attempt activates the plugin (`activateForView`), then imports the module; the plugin's Tailwind styles and the kit chunk load in parallel with activation, and the attempt resolves only once the import, the styles and the kit are all ready, so the first frame is styled and every kit control renders in it. A warm attempt — the module already imported, and the backend its activation reached still the one running, judged from main's pushed runtime status — skips the import but still awaits `activateForView` before it renders: the renderer's status can show the previous backend as ready for a moment after a restart or reload, and a view mounted then would run its effects against a plugin that has not activated. Main answers at once for an activated plugin, so that costs one IPC round trip, and it is the call that stamps the plugin's idle-dispose activity. After an idle dispose, a worker restart or crash, or a reload that republished the kind, the warm view is discarded and the attempt runs cold (#10523).

**Kit readiness is part of the load.** `whenPluginUiReady()` is awaited with the styles for a `plugin://` view and after activation for a builtin. A kit control that mounted before its chunk arrived would suspend inside its own boundary and pay the same reveal throttle this path avoids; a kit that fails to load is left to that control's boundary rather than failing the view.

Every attempt records its phases (`activate`, `import`, `styles`, `view-load`, `first-paint`) in the per-document metrics registry and as `daintree:plugin:<pluginId>:<phase>` User Timing measures ([Per-plugin metrics](#per-plugin-metrics)).

### Hot reload — dev only

In dev, the host can re-evaluate a plugin view's module after the source changes. For installed and builtin plugins there is no production hot-reload path; project-local plugins are the exception, and reload from a watched `dist/` in an ordinary session (see [Hot reload for project plugins](#hot-reload-for-project-plugins)). A `daintree-plugin dev` session reloads views too — a settled rebuild re-enters the ordinary load path and mints a fresh view generation, so it is the same mechanism rather than a view-less worker respawn (#12277). V8 caches ESM module records by URL string and Chromium offers no eviction API (Vite #14438 / Chromium #350426234, unresolved as of 2026). Every cache-busting query string permanently expands the renderer's module map; iterating against a long-lived production renderer would leak memory indefinitely. Treat hot reload as a dev affordance and assume production users reach a clean state by closing and reopening the panel.

### Renderer notification after teardown

The renderer is told _last_, after host teardown. `unregisterPluginPanelKinds` only schedules the `plugin:panel-kinds-changed` broadcast, and `PluginContributionBroadcaster` sends it from a microtask — after `unloadPlugin` has returned, which is to say after the plugin's IPC handlers were removed, its worker disposed and its entry deleted. `PluginViewContent` (`src/components/Plugin/PluginViewContent.tsx`) subscribes to that push and aborts the view's `disposeSignal` when its kind disappears from the payload, before React unmounts the subtree.

So a `disposeSignal` listener runs against a plugin that is already gone. Cleanups must tolerate host calls rejecting — an `invoke` to a removed handler, a push channel that will never fire again — and must not depend on a final round trip to the plugin succeeding. Abort fetches, close ports and drop subscriptions locally; if state has to reach the plugin before teardown, send it earlier (on change, or through `persistState`).

### Error boundaries

Every plugin view is wrapped in an error boundary by the host. A crash renders the component-variant fallback with a "Try again" button; the host wires `onReset` to start a new load attempt, and one that follows an import failure asks main for a fresh view generation, because Chromium caches a failed `import()` for its specifier forever. The rest of Daintree is unaffected — the panel grid keeps working, other plugins keep running, the user can close the failing panel normally.

### Trusted-inline → iframe contract

Today's inline host is the right trade for curated trust. The view host's API surface — the `PanelViewProps` shape and the broadcast-driven teardown ordering — is intentionally chosen to survive a future cutover to a trusted iframe model. `PanelViewProps` in `shared/types/plugin.ts` is the authority; today it carries `panelId`, `pluginId`, `disposeSignal`, `panelRemovedSignal`, `styleRootAttributes`, and the optional `initialArgs`, `stateVersion`, `persistState`, `requestReload`, `setHasUnsavedChanges`, `setToolbarItemState`, `runningActions`, `worktreeId` and `settingsContext`. `componentPath` would resolve to a sandboxed frame URL instead of a direct ESM import; the props would marshal over `postMessage`; `disposeSignal` would still abort on the same `panel-kinds-changed` removal event. No manifest change would be required on the plugin author's side.

### Inline, not iframe

Views render inline in Daintree's React tree. Plugins share Daintree's DOM, CSS cascade, and React context. This is optimal for a curated-trust model: richer integration, direct use of host UI components, native React hooks.

An iframe model would isolate plugins behind a `postMessage` bridge at the cost of heavy DX friction and rebuilt UI components per frame. That's the right trade for an untrusted-plugin model — if Daintree ever opens to fully untrusted third-party plugins, iframe isolation via a `plugin://` protocol handler is the upgrade path. Nothing in the current manifest shape needs to change — `componentPath` resolves differently for trusted vs untrusted plugins, but the field is the same.

### Plugin styling: a scoped runtime Tailwind sheet

Sharing the cascade is what lets Tailwind be the styling contract for plugin views (#12220). Tailwind v4 emits only the classes its build-time scan finds in this repo, so before this a plugin's class worked if and only if the host happened to use it too — which changed every release. Instead, the renderer compiles plugin classes itself, at runtime.

Three steps, deliberately kept separate:

1. **Collect candidates.** Two sources. The view module's source text is fetched and tokenised before the module is imported, which is what makes the first paint styled; and one `MutationObserver` reads `classList` as the DOM changes. The observer is authoritative — it sees template literals, sibling modules and runtime-computed names that source tokenisation cannot. Its callback is a microtask, so a class toggled on by state is styled before the next paint.

   The observer watches the document and keeps only what sits inside a marked style root, one `closest()` call per record. Watching each registered root instead is tempting and wrong twice over: a `MutationObserver` cannot drop a single target, so unregistering one view has to `disconnect()`, silently discarding every other root's queued records; and a `createPortal` container is never a descendant of the wrapper it was rendered from, so a portal would be scoped by the generated CSS but never observed. Filtering on the marker is what keeps the observed set identical to the set the CSS is scoped to.

2. **Compile.** `src/services/plugin/tailwind/pluginTailwindAdapter.ts` is the only place Tailwind's programmatic API is called. It compiles the host's own `src/styles/design-contract.css` — the same bytes `index.css` imports — with the stock theme pulled in as `reference`, so no `:root` variables and no preflight are re-emitted. Utilities land nested in `@layer utilities { @scope ([data-daintree-plugin-style-root]) { … } }`.
3. **Install.** One constructed `CSSStyleSheet` per document on `adoptedStyleSheets`, shared by every plugin root in it, replaced wholesale on each build because `build()` returns a cumulative sheet whose order can change.

Two properties are load-bearing. `@layer utilities` is a document-global layer name, so plugin utilities join the host's at the host's declared priority — layer membership, not specificity, decides the cascade here. And the `@scope` wrapper is what makes duplicate emission safe: a plugin using `p-4` emits its own `.p-4`, and without the scope that late rule would override a host element carrying `p-4 px-3`.

Each project view is its own `WebContentsView`, so each document compiles once (~10 ms) and owns its own sheet; a constructed stylesheet belongs to the document that made it and is never shared across them. The compiler chunk is lazy and loads in parallel with plugin activation.

**What a future iframe view host would need.** Keeping collection, compilation and installation separate is what makes that a wiring change rather than a rewrite: the same service runs inside the frame, or compiled CSS is handed across. But none of the ambient context crosses a frame boundary, so an explicit snapshot of the theme variables, the baseline CSS, the fonts and the approved extensions would have to cross with it.

## Plugin transport

Views reach their plugin over two channels: `plugin:invoke` (a view's request, answered by a `registerHandler` handler) and pushes (`postToPanel` / `broadcastToRenderer`, received by `window.electron.plugin.on` / `onPanel`). Both are bounded by the constants in `shared/config/pluginBudgets.ts`; the plugin-facing contract is [Host API → Deadlines and size limits](./host-api.md#deadlines-and-size-limits) and [Push delivery](./host-api.md#push-delivery).

**Invokes.** The `plugin:invoke` handler (`electron/ipc/handlers/plugin.ts`) checks the arguments against the 4 MiB cap (`assertPayloadWithinLimit` in `pluginPayloadLimits.ts`) before any dispatch work, so an oversize payload is never cloned into a worker. The IPC security wrapper's envelope budget for the channel (`electron/setup/security.ts`) is that cap plus 64 KiB of headroom, replacing the generic 1 MiB guard that used to refuse legitimate payloads first. The size estimate walks a value lazily and stops once past the limit, so an oversize payload costs about the limit in work. The handler's result is checked against the 16 MiB cap in main and, for a worker plugin, in the worker before it crosses the port. `PluginHostFactory` wraps each registered handler in its deadline (`runWithInvokeDeadline`, `pluginInvokeDeadline.ts`): on expiry the caller is rejected with `PLUGIN_INVOKE_TIMEOUT` and the deadline's signal aborts, which is how `PluginDevWorkerMainBridge` tells the worker to stop waiting — the worker drops the handler's eventual result rather than cloning it back, and an `agentMcp` tool's `execute` gets its own signal aborted. The signal travels beside the IPC context in a `WeakMap` rather than inside it, since the context is structured-cloned into the worker and an `AbortSignal` cannot be.

**Pushes.** Every push from every plugin goes through one process-wide `PluginPushBatcher` (`pluginPushBatcher.ts`). The host size-checks the payload (1 MiB) and structured-clones it at the call — a worker proxy applies the same cap before its port, and main re-checks on arrival — then queues it with its routing inputs, not its recipients. A flush, scheduled with `setImmediate`, resolves recipients against the renderers and panel locations that exist then: the binding's project views (every renderer for an app-global plugin), narrowed for a targeted push to the renderer(s) `PluginPanelLifecycleBroker.pushTargetsFor` says hold the panel. A panel not reported yet falls back to the scope, never wider; one reported removed at least two seconds ago (`CLOSED_PANEL_GRACE_MS`, the gap a panel moving between renderers leaves) and held by nobody receives nothing. Each renderer gets its queue FIFO, as `plugin-push:batch` messages of at most 256 entries and 1 MiB, and the preload fans them out to `on` / `onPanel` subscribers, still filtering by `panelId` as a second line of defence. A batch IPC refuses to serialize is retried entry by entry and only the failing entries are dropped. Every other host-to-renderer send on a plugin's behalf — dispatch, prompts, panel reloads, badges, decoration invalidations, toasts — goes through `withPushFlushBarrier` or `flushPluginPushes()` first, so it never overtakes a push made before it. Invoke replies are not behind that barrier, which is why pushes carry no ordering guarantee against them.

**Listener registry.** `PluginPushListenerRegistry` (`pluginPushListenerRegistry.ts`) knows which renderers subscribe to which push channels: each renderer's preload reports its full set of `[channel, panelId]` pairs over `plugin:report-push-listeners` whenever it changes (at most 50 reports a second per renderer; `electron/ipc/handlers/pluginPushListeners.ts`), and each report replaces the last, so a lost or superseded one never leaves a count drifting. A renderer that has not reported, or whose report was refused, counts as listening to everything. The registry is a **producer-side signal only** — it backs `host.hasListeners` and `host.onDidChangeListeners` and nothing else. Push delivery never consults it: a report always lags its renderer, there is no replay, and a subscriber registered after an empty report would lose whatever main filtered on it. Watchers re-evaluate on every report, renderer teardown and scope change, with a 2-second reconcile as a backstop while any active watcher exists; a worker's `hasListeners` cache uses a passive watcher that never keeps that timer running. A plugin's `onDidChangeListeners` registration is tracked with its other event subscriptions, so it holds the worker against idle disposal.

**Subscriptions.** The bursty host subscriptions (`onDidChangeWorktrees`, `onDidChangeActiveWorktree`, `onDidChangeAgentState`, `onDidChangeAllAgents`) coalesce in main (`pluginSubscriptionCoalescing.ts`), before anything crosses a worker port: a trailing window, 100 ms by default, with a deadline of four windows so a burst that never goes quiet still delivers. The worktree change argument is computed per subscription from the list it was last handed; agent state keeps each terminal's latest transition; the all-agents list keeps only the latest snapshot. A worker sends the caller's `debounceMs` across the port as given, so an omitted option gets the same default an in-process plugin does.

## Per-plugin metrics

The host measures what each plugin costs and serves it to the plugin manager and the dev CLI. Nothing on this path throttles, blocks or ranks a plugin; the budgets in `PLUGIN_PERF_BUDGETS` are reference points the UI compares against ([Development loop → Performance](./dev-loop.md#performance)).

**Renderer.** Each project view's document has one `pluginViewMetrics` registry (`src/services/plugin/pluginViewMetrics.ts`) fed from three places:

- the view load path, with each attempt's phases and first frame ([The plugin view load path](#the-plugin-view-load-path));
- a React `Profiler` around every plugin view, recording commit durations — production React never calls it, so commits exist only in development and profiling builds;
- `longTaskMonitor` (`src/utils/longTaskMonitor.ts`), whose Long Animation Frame observer hands every reported frame to `attributeLongFrameToPlugins`. A frame is recorded once per plugin under the first observation that matches: a script from the plugin's `plugin://` origin (resolved through the registered view authorities) ran in it; one of its views committed in it; a UI event was dispatched inside one of its style roots, found through the `data-daintree-plugin-owner` attribute on view roots and kit overlays; or the preload delivered a host push to its listeners during it (`pluginsWithPushDeliveriesDuring`). Each is an observation that the plugin was active, never that it caused the stall.

Pending deltas are bounded (512 commit durations, sampled beyond that; 32 view loads and 128 long frames, with the overflow counted). `pluginMetricsReporter.ts` drains them lazily — 2 s after the first delta, 250 ms after a view load, at once when a buffer reaches 75% of its cap or the page is hidden or goes away — as `plugin:report-view-metrics` envelopes `{ generation, report }`. `generation` is the `plugin://` authority the view module was served from; main mints a new one for every load and never reissues it, so it identifies the load the numbers belong to.

**Main.** `electron/ipc/handlers/pluginMetrics.ts` accepts at most five report messages per renderer per second, parses them at the boundary (`electron/schemas/pluginMetrics.ts`), and discards reports for a plugin the sender's project cannot see. `PluginMetricsService` (`electron/services/plugin/PluginMetricsService.ts`) drops any report for a plugin it has not loaded or tagged with a generation other than the live one — a buffer that outlived an unload and a same-id reload never folds into the new load — and accumulates the rest beside what main observes itself: activation time from `PluginService`, every `plugin:invoke` dispatch through `PluginService` (with errors, timeouts, and whether a host prompt the plugin had open overlapped it) plus the oversize arguments the IPC handler refuses, push messages and bytes from the batcher's flush observer plus pushes refused at the cap, and worker RSS, sampled every 5 s only while a snapshot subscriber or a CLI lease is active and on demand when a snapshot is read. Every `record*` is O(1); percentiles (over the last 256 samples per stream), rates (ten one-second buckets) and `overBudget` are computed when a snapshot is read. It tracks at most 256 plugins, keeps 20 view loads per plugin, and forgets a plugin when it unloads.

**Serving.** Renderers read `PluginPerfSnapshot[]` (`shared/types/pluginMetrics.ts`) through `window.electron.plugin.getPerfSnapshots()` (`plugin:perf-snapshots-get`) and `onPerfSnapshotsChanged` (a subscribe/unsubscribe pair and `plugin:perf-snapshots-changed` pushes, at most once a second, only to renderers that asked), each filtered to the plugins that renderer's project can see — app-global plugins everywhere, a project plugin only in its own project's views. The plugin manager's Performance tab reads them through `usePluginPerfSnapshot`. `daintree-plugin dev` polls `plugin.dev.metrics` over the CLI socket every 2 s; each poll takes a 15-second sampling lease so worker memory stays fresh while the dev session runs.

## MCP supervisor

`PluginMcpSupervisor` (`electron/services/PluginMcpSupervisor.ts`) manages plugin-shipped `mcpServers`. Daintree is the MCP client here: the supervisor spawns each server over stdio and the `pluginMcp` IPC handlers (`electron/ipc/handlers/pluginMcp.ts`) are the only way to reach its tools; the in-app Daintree Assistant is their consumer, and the plugin manager inspects and restarts servers. The `pluginMcp` namespace is exactly `list`, `getStderr`, `restart`, `listTools`, `getFullSchema`, `getConfig`, `setConfig`, `callTool` and `resolveConsent`; there is no separate start operation and no per-server enable switch. Nothing on this path feeds the MCP server terminal agents connect to (`electron/services/mcp-server/`). The inbound direction is [Agent MCP endpoints](#agent-mcp-endpoints).

### Spawn timing

Servers spawn **on first tool use**, not at plugin activation. The supervisor keeps a registry of available servers (their stdio command + args + env) but spawns one only when something asks for it — a `pluginMcp.listTools` / `pluginMcp.getFullSchema` / `pluginMcp.callTool` for that server, or a `pluginMcp.restart`.

Rationale: a user with 10 installed plugins, each shipping an MCP server, doesn't pay the startup cost of 10 subprocesses unless they actually use them. Many MCP servers are heavy at startup (loading SDKs, validating credentials, fetching schemas).

### Tool discovery

Tool definitions themselves are fetched lazily. The first `pluginMcp.listTools` for a server queries its `tools/list` and caches the result, and the IPC surface hands back terse summaries, capped at `maxToolsPerSession`. A tool's full schema crosses only when a caller asks for it by name through `pluginMcp.getFullSchema` — inspired by Claude Code's MCP Tool Search pattern.

This matters because tool definitions consume tokens in whatever model ends up reading them. An MCP server exposing 40 detailed tools can add 30K+ tokens to every turn. Lazy discovery pushes the cost to only the servers and tools actually used.

### Process lifecycle

- Spawn on first use.
- Keep alive until the plugin unloads or Daintree quits — teardown is keyed by plugin, not by any caller or session.
- On unexpected exit the supervisor transitions the server to `crashed`, records the error, invalidates the cached tool list, and rejects any pending calls. There is **no** automatic retry, backoff, or "degraded" state — the status enum is `spawning | ready | crashed | stopped`. Recovery is explicit: restart the server (the `pluginMcp.restart` IPC, which the plugin manager calls), or disable and re-enable the whole plugin, which unloads it and lets the next tool use spawn the server afresh. A restart also re-runs the trust-on-first-use tool comparison before any tool is re-injected.
- Teardown on plugin unload and on Daintree quit is execa-managed: `subprocess.kill()` with no explicit signal, so execa's own `forceKillAfterDelay` escalation stays armed (a 3-second grace before the hard kill). Passing a signal would disable that escalation, so the supervisor deliberately doesn't. On Windows it additionally shells out to `taskkill /T /F` after the grace window, because Windows does not cascade a kill to grandchildren.
- Subprocess `stderr` is captured and logged for debugging but not exposed to agents.

### Environment variable substitution

Plugin manifest `env` values support `${settings:settingId}` syntax. Substitution happens at spawn time, reading the current setting value from the plugin's **user scope** (never project scope). An unset or `null` setting resolves to an empty string; booleans and numbers are stringified, and objects/arrays are JSON-encoded. When a user-scope setting changes, every currently running server (status `ready` or `crashed`) that references it is automatically restarted so the new value is folded in (#10619) — the restart is debounced ~1s so a burst of edits coalesces into one respawn, and a server that was never lazily started is left stopped rather than eagerly booted. See [Agent Extensions → MCP servers → Lifecycle](./agent-extensions.md#lifecycle) for the full behavior.

Plugin-contributed **agent** `command` and `args` get the same `${settings:settingId}` resolution at PTY spawn time (#10619), also against user scope. The agent path differs from MCP `env` in one respect: a referenced setting that is unset throws rather than collapsing to an empty string, so the spawn fails with a clear error instead of silently launching the agent with a blank credential. Built-in agents and plain-shell spawns skip the resolution entirely — only a plugin-contributed agent whose command actually embeds a template pays for the lookup.

### Security

MCP subprocesses run with the full privileges of the Daintree process. There's no sandboxing. The curation model — human review and trusted-source install — is the primary defense; there is no signing or publisher verification (see the [trust model](./trust-model.md)).

An MCP server can do anything the plugin could do: make network requests, read and write files, spawn further processes. The manifest's declared `capabilities` are disclosed in the plugin manager — if a plugin declares `network:fetch` because its MCP server calls Linear's API, the user sees that in the plugin's detail pane after install and decides whether to keep trusting it.

## Agent MCP endpoints

`contributes.agentMcp` is the inbound direction: Daintree hosts a tools-only MCP endpoint for the plugin on the same loopback listener as its own MCP server, and agents in Daintree's terminals are the clients. The code lives in `electron/services/pluginAgentMcp/`; the listener side is documented in [MCP server → Plugin endpoints](../architecture/mcp-server.md#plugin-endpoints).

Six pieces, each keyed by plugin **instance** rather than manifest id, so two projects loading the same project plugin — or a project copy beside an installed one — never share consent, credentials or rosters:

| Piece | File | Holds |
| --- | --- | --- |
| Roster registry | `endpointRegistry.ts` | The validated, frozen tool descriptors plus an invoker, per instance and endpoint. Written by `host.mcp.registerTools` and by the database endpoint, dropped on unload. |
| Roster validation | `validateTools.ts`, `schemaValidation.ts` | Every registered tool is checked before it enters the registry — name pattern, reserved names, description and schema byte limits, tools per endpoint — and its input schema (and output schema, when declared) is compiled once, so each call's arguments are validated against it. |
| Database endpoint | `databaseEndpoint.ts`, `databaseTools.ts`, `databaseQueryProcess.ts`, `databaseQueryWorker.ts` | The host's own read-only roster over a plugin's declared `databases`, on the reserved endpoint id `@databases`. Bound at load, independent of activation, so listing or calling it never runs plugin code and idle worker disposal leaves it in place. Each call runs in its own short-lived `utilityProcess` (at most two at once, eight queued), because `node:sqlite` cannot interrupt a running statement and a process can be killed mid-step. |
| Enablement | `projectEnablement.ts`, `projectDefaults.ts` | The user's access level per plugin instance: `off`, `read-only` (the database tools) or `read-write` (those and the plugin's own tools). The first source that answers wins: the per-project answer (`projectAgentMcpAccess`, where `access: null` means "follow the default"), then an answer recorded before access levels existed (`projectAgentMcpEnablement`, per endpoint, read only), then — for an installed plugin — the user's answer for every project (`pluginAgentMcpAccess`), or — for a project plugin — the repository's `.daintree/mcp.json`, cached per project and re-read at every launch and settings read. A repository never answers for an installed plugin. Default off; reducing access revokes the affected credentials at once. |
| Grants | `grantRegistry.ts` | One credential per plugin server per terminal launch, with a tool scope (`{ databases, pluginEndpointId? }`) fixed when it is minted. Only the SHA-256 digest of the bearer is kept; the bearer itself is handed to the launch once, in its config file or its environment. |
| Declared endpoints | `declaredEndpoints.ts` | Which endpoints of which loaded instances a given project could expose. The launch path reads it; the route instead re-checks the grant, that the instance is loaded, and the project's enablement. |

**The request path.** An agent launch in a project (`electron/ipc/handlers/terminal/lifecycle.ts`) whose registry entry declares `capabilities.launchMcp` resolves the plugins with agent access in that project and loaded here, names each (`serverKeys.ts`), re-checks each immediately before minting its one grant, and has `McpPaneConfigService` render the grants, beside the Daintree orchestration entry when the tier is on, in that agent's dialect (`electron/services/launchMcp/renderLaunchMcp.ts`): a `0600` file under `userData` passed by flag or environment variable, `-c` overrides with bearers in the environment, or inline JSON in the environment. The lifecycle appends the args, shell-quoted, and merges the environment into the spawn. An agent request to `/mcp/plugin/<instance>` is branched off by `HttpLifecycle` before orchestration auth and handled by `pluginMcpRoute.ts`, which authenticates the grant, checks the path, the plugin and that the project's access still covers the grant on every request, and serves a per-session MCP server from `pluginSessionServer.ts` holding the host's database tools and the plugin's own, as the grant allows. A `tools/call` for one of the plugin's own tools activates the plugin if needed, looks the roster up, and invokes the plugin's `execute` — in-process for a builtin, across the worker's message port for everything else, where the result is serialized in the worker before it crosses.

**Lifetimes.** Grants die with the terminal launch (PTY exit, spawn failure, a restart of the same pane), with the plugin instance (disable, uninstall, project close, trust revoke), and with a reduction in the plugin's access. A revoke carries one of four reasons: `terminal-exited`, `plugin-unloaded`, `access-reduced` or `server-stopped` (the listener shutting down). A reload is the exception among unloads: `unloadPlugin(id, { reload: true })` _holds_ the instance's grants (`holdPlugin`) instead of revoking them, because a running agent cannot be handed a new bearer. A held grant still authenticates but reaches no plugin code; when the reload settles, the grants survive if the new generation declares the same agent surface and are revoked as `plugin-unloaded` otherwise, or if no generation comes back. Grants also survive idle worker disposal and a worker crash-respawn: the instance is still loaded, so its credentials stay valid, in-flight calls are rejected, and the roster returns when the worker re-activates. Nothing about a grant is persisted, so none outlives the app.

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

Plugin-supplied listeners across the host (`onDidChangeAgentState`, `onDidChangeAllAgents`, `onDidWake`, `storage.onDidChange`, `settings.onDidChange`, and the worktree subscriptions above) are dispatched through `invokeTrackedListener`, which quarantines a misbehaving callback. Each throw — synchronous or a rejected async return — increments a per-listener counter that is logged with its position (`1/3`, `2/3`, …); a single successful invocation resets it to zero, so intermittent failures never accumulate. After three consecutive throws the listener is auto-unsubscribed via its own disposer, so a buggy or adversarial plugin can't spam the log with a repeating error on every event.

## Capability disclosure

Capabilities are **disclosure-first with host-side policy effects** — a hybrid model. The host does not sandbox plugin code: a plugin declaring `capabilities: []` can still make network requests and write files via raw Node APIs. But declared capabilities are not purely advisory either. They drive host-side policy, most concretely danger classification on plugin-registered actions. See the [trust model](./trust-model.md) for the full decision record, decision matrix, and capability schema.

What disclosure does:

- An installed plugin's detail view shows the declared capabilities in a humanized list: "This plugin can read your worktree files, make network requests, and spawn subprocesses."
- That detail-pane list is the disclosure surface — it appears in the plugin manager after install, not as a pre-install consent gate. A fresh install runs without enumerating capabilities (see the [trust model](./trust-model.md)).

What the host derives from declared capabilities:

- **Danger classification (live today).** When a manifest holds any high-risk token in `CONFIRM_TRIGGERING_CAPABILITIES` (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`), every action that plugin registers is raised to `effectiveDanger: "confirm"` — gating the renderer's confirm dialog, MRU-rail eligibility, and `repeatLast`. The host may only raise danger, never lower it. This is host-side UX policy on Daintree's own action system; it does **not** block the plugin from executing code or calling IPC directly.
- **Compound-capability lattice (live, #9247).** Single capabilities that aren't individually irreversible can still combine into a threat. `manifestTriggersCompoundElevation()` (`electron/services/plugin/pluginDangerLattice.ts`) catches two compound classes: exfiltration (a sensitive read in `SENSITIVE_READ_CAPABILITIES` paired with an unconstrained `shell:exec` or `network:fetch` sink) and remote-controlled mutation (`network:fetch` paired with a local write or shell sink). A plugin attenuates the elevation by declaring a tight `scopes.network.allowedUrls` — a scoped `network:fetch` can't be remote-controlled, so the scope removes that class. Wildcard scopes are rejected at the schema boundary.
- **Just-in-time consent (live, #10524).** Declaring a capability is necessary but not sufficient for the sanctioned host surfaces. The first time a plugin actually calls `host.process.spawn` (`shell:exec`), `host.fs.writeFile` / `appendFile` / `mkdir`, a writable `host.db` open of a project database, `db.backup` or `host.documents.renderPdf` (`fs:*-write`), `host.git.add`/`commit` (`git:write`), or `host.sendToAgent` / `sendToActiveAgent` (`agent:input`), `ensureCapabilityConsent` (`PluginHostFactory.ts`) raises a first-use dialog through `PluginCapabilityConsentService`. A pinned grant makes later calls silent; a denial rejects with `PERMISSION_REQUIRED:`. Grants key on `(scopeKey, pluginId, capability)` with `scopeKey` taken from the host's own binding, so one project's approval never answers for another project's copy of the same manifest id. Built-in plugins skip the prompt. This is the only place a capability is a runtime gate rather than a label — and only on the host-mediated path.
- **MCP consent tier (live, #9234).** A plugin's declared capabilities cap the danger tier its MCP server's tool surface can reach (`electron/services/plugin-mcp/PluginMcpTierAuth.ts`): a server that didn't declare a high-risk capability can't trigger a D2 confirmation just by advertising `destructiveHint: true` — the call is denied, not silently downgraded. See the trust model for the complete list.
- **Agent MCP gate (live).** `contributes.agentMcp` is rejected at the manifest gate without `mcp:expose`, and `host.mcp.registerTools` throws `PERMISSION_REQUIRED:` without it. Declaring it exposes nothing: the plugin also needs the user's read-and-write agent access. See [Trust model → Agent MCP endpoints](./trust-model.md#agent-mcp-endpoints-mcpexpose).

The purpose is to let users judge plugins by what they claim to need and to apply proportional friction at high-risk intent surfaces. A simple theme-packager plugin declaring `shell:exec` looks suspicious; a Linear integration declaring `network:fetch` looks expected. Declaring honestly matters: a plugin that silently makes network requests without declaring `network:fetch` erodes the ecosystem's trust model, even though nothing blocks the call at runtime.

## Host-derived classification

The host is the sole authority on action danger classification. A plugin's self-reported `danger` in `registerPluginAction()` is advisory only — the host computes `effectiveDanger` and the renderer reads only that field for classification decisions.

### Why host-derived

Prior to #8321, the renderer trusted the plugin's self-reported `danger` field. A plugin could declare `danger: "safe"` on a destructive action and bypass the confirm dialog, MRU-rail exclusion, and `repeatLast` eligibility. The host now computes an authoritative `effectiveDanger` so a plugin cannot misclassify.

### Mechanism

The host consults the set `CONFIRM_TRIGGERING_CAPABILITIES` (defined in `shared/config/pluginCapabilities.ts`; the derivation lives in `electron/services/plugin/pluginDangerLattice.ts`, which `PluginService.ts` calls):

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

The host also computes an aggregate `pluginDanger` (`"safe" | "confirm"`) per plugin via `computePluginDanger()` (same module), surfaced on `LoadedPluginInfo.pluginDanger` so the manager UI can show an effective-danger summary without re-deriving the lattice in the renderer. It reuses the same `CONFIRM_TRIGGERING_CAPABILITIES` set and compound lattice — a single source of truth on main rather than a third copy.

### Renderer contract

The renderer reads `PluginActionDescriptor.effectiveDanger` (not `danger`) for:

- Whether the confirm dialog gates agent-initiated dispatches
- MRU-rail eligibility in the action palette
- `ActionService.repeatLast` eligibility

If `effectiveDanger` is absent (e.g. a stale descriptor from a pre-migration cache), the renderer must fail safe to `"confirm"`.

### Scope

This classification is host-side UX policy on Daintree's own action system. It does not block the plugin from executing code, calling IPC directly, or making network requests — those are gated by the curation trust model, not by runtime enforcement (see [Capability disclosure](#capability-disclosure)).

## Signing and kill-switch

**Signing:** sideloaded and URL-installed plugins aren't signed, and there is no publisher-identity verification. The SHA-256 archive hash establishes integrity, not authenticity. Trust is on the user. Detailed infrastructure for signed distribution is planned for the eventual Daintree-authored paid-plugin channel; it does not affect sideload or URL install.

**Kill-switch — shipped (#10891).** `PluginBlocklistService` (`electron/services/plugin/PluginBlocklistService.ts`) is the cheap, fast precursor to publisher identity: a small remote list of plugins Daintree refuses to load, fetched from `updates.daintree.org/plugins/blocklist.json` (`shared/config/pluginBlocklist.ts`) and cached on disk under `userData` for offline enforcement.

- **Resolved before any scan, refreshed after.** `PluginService.initialize()` awaits `getStartupBlocklist()` ahead of the first discovery pass, so every load gate in the scan reads one snapshot. That call never waits on the network while a validated list is on disk: a cached list is enforced at once even when stale, and the revalidated list, when it arrives, is adopted through `applyRefreshedBlocklist`, which unloads any loaded plugin it newly blocks and moves a newly blocked disabled plugin to the blocked set. Only a first run with no usable cache waits for the fetch, so it never loads against an empty list a fetch was about to fill. A refresh that fails never drops the list already enforced.
- **Fails open only without a list.** A network error, a timeout (8 s ceiling), or a parse failure leaves the last validated list (on disk or in memory) enforced; only when no validated list exists does every plugin load. A stale disk cache is still enforced while offline — stale-while-revalidate against a 6-hour TTL, deliberately shorter than the model-catalog TTL so an entry reaches running installs in hours, not a day.
- **Matched by `{ name, ranges }`.** Entries carry a plugin `name`, one or more semver `ranges`, a machine `reason` code, and an optional human `message`. `jti` is reserved for a future signed-identity model and unused today.
- **Refused before activation.** A match is checked _before_ the user-disabled gate, so a plugin that is both disabled and blocklisted still reads as blocked — the security signal wins. The plugin never enters `this.plugins` and `activate()` never runs; its name is reserved so a later directory scan can't hijack the namespace, and its manifest is retained so `listPlugins()` can surface the block. The user gets one rate-limited warning toast, and the plugin manager shows a **Blocked** badge with the reason and a disabled enable toggle (`blocklisted` / `blocklistReason` on `LoadedPluginInfo`).
- **A project plugin never claims the global namespace.** A blocklisted project-local manifest is refused for that project without reserving its id, so one repository can't deny an id to every other project or to the user's own installed plugins.

The mechanism is reserved for security responses to known-compromised plugins, not for normal version deprecation.

## Why these choices

A short rationale for the decisions most likely to feel arbitrary:

**Why `plugin.json` instead of extending `package.json`?** The VS Code pattern of putting manifest data inside `package.json`'s `contributes` field conflates npm dev dependencies with runtime manifest. For TypeScript plugins built with Vite, the two have genuinely different shapes and lifetimes. Keeping them separate avoids the "why is my build tool looking at my contribution points?" confusion.

**Why scoped names (`publisher.plugin-name`)?** Name collisions are inevitable without a central registry. Scoped names make collisions author-caused (you control your publisher namespace) rather than ecosystem-caused. Matches npm's scoped package convention.

**Why `.dntr` instead of `.zip`?** OS file association. Double-clicking a `.dntr` opens Daintree's install flow; double-clicking a `.zip` opens the OS archiver. Also prevents accidental manual unzipping into the wrong place. The CLI accepts either, so authors who only want to ship `.zip` can.

**Why dual-path action binding (filesystem convention + imperative)?** The filesystem convention (Raycast-style: `commands[].name` → `src/{name}.ts` default export) is delightful for simple cases — zero boilerplate, co-located with declaration. Imperative registration via `host.registerAction` is needed for truly dynamic commands and matches the existing imperative pattern Daintree uses for its own several-hundred built-in actions. Supporting both is cheap and handles both ends of the complexity spectrum.

**Why no runtime permission enforcement?** There is no Node sandbox. Moving user plugins into a `utilityProcess.fork` worker bought crash isolation and clean teardown, not privilege reduction: the worker is a full Node runtime running as the user, so a plugin bypasses any custom-API gate by calling `require("fs")` or `child_process.spawn` directly. (Node's experimental permission model was prototyped against the worker in #10890 and doesn't take — Electron's utility-process bootstrap never parses the `--permission` flags. `electron/services/plugin/pluginPermissionFlags.ts` keeps the mapping ready in case that changes.) Full enforcement would require Wasm sandboxing (Zed's approach — great DX cost), iframe isolation (worse DX, breaks React integration), or a prompt on every Node call (unusable). Instead of claiming enforcement we can't deliver, declared capabilities drive host-side policy effects (danger derivation, the compound-capability lattice, and the MCP consent tier) while the model stays honest that it does not sandbox arbitrary code. See the [trust model](./trust-model.md).

**Why no separate hooks contribution point (PreToolUse/PostToolUse)?** Intercepting an agent's tool calls means changing how the agent CLI behaves, which crosses the line Daintree holds on user-owned agent config. What a plugin gets instead is its own tools in the agent's hands through an [agent MCP endpoint](#agent-mcp-endpoints), using the ecosystem we're already committed to (MCP) rather than a parallel API. Those tools can refuse or annotate what they are asked to do; they never see the agent's other calls.

## SDK surface

`shared/types/plugin-sdk.ts` is the public export boundary for `@daintreehq/plugin-sdk` and the single source of truth for what a plugin author may name. Every symbol re-exported there is a contract: additions are non-breaking, removals are breaking. **Read that file rather than a table here** — it is grouped by area with a comment per group, and a list duplicated into prose only rots.

Four runtime entry points (plus `/testing`, the mock host):

- `@daintreehq/plugin-sdk` — manifest-authoring types, the host API and its sub-APIs, worktree/agent projections, the forge and file-decoration contracts, action dispatch and catalog types, a handful of runtime values (`localAuthStubs`, `PLUGIN_PROCESS_STREAM_CHANNEL`, `PLUGIN_STYLE_ROOT_ATTRIBUTE`, the agent-context drag constants and helpers), and one worker helper, `createSyncedCollection` with `syncedCollectionSnapshotChannel` (`packages/plugin-sdk/src/sync/`), the worker half of `useSyncedCollection`.
- `@daintreehq/plugin-sdk/react` — the renderer hooks for view components (`useHostChannel`, `usePluginEvent`, `usePluginPanelEvent`, `createViewScope`, `loadDocumentPackage` and the performance hooks) and their types, including every UI kit prop interface (`shared/types/plugin-sdk-react.ts`). The implementations live in `packages/plugin-sdk/src/react/`; Daintree's own `src/hooks/` re-exports them through thin shims so host and plugins run one implementation. A bundled view bundles its own copy; a raw `plugin://` view imports the host's through the import map's raw-only entry ([Sharing strategy](#sharing-strategy), [Host API → React hooks](./host-api.md#react-hooks--daintreehqplugin-sdkreact)).
- `@daintreehq/plugin-sdk/files` — the headless file-listing model Daintree's own file browser runs on (`packages/plugin-sdk/src/files/`). No components, no icons, no I/O. See [Host API → File listings](./host-api.md#file-listings--daintreehqplugin-sdkfiles).
- `@daintreehq/plugin-sdk/data` — frontmatter, JSON Lines and the conflict-checked `editFile` loop (`packages/plugin-sdk/src/data/`). See [Data helpers](./data-helpers.md).

Two more entries are types only. `@daintreehq/plugin-sdk/plugin-ui` declares `@daintreehq/plugin-ui`, whose runtime (`src/pluginUi`) the host serves to views through the import map ([UI kit](./ui-kit.md)). `@daintreehq/plugin-sdk/view-globals` declares `window.electron.plugin` — `invoke`, `on` and `onPanel`, and nothing else on `window.electron` — self-contained so a view that does not use React pulls in no React types; a type test holds it to the same shape as `/react`'s `PluginHostBridge`.

The plugin worker serves `.`, `/files` and `/data` to a plugin that has no SDK of its own. `plugin-dev-worker-bootstrap.ts` installs a `module.registerHooks` resolve hook (`electron/services/plugin/pluginSdkResolution.ts`) before any plugin code loads; it lets normal resolution run first and, only when that fails because no SDK is installed on the importer's `node_modules` path (a not-found error with none there) or the installed one does not export the entry (`ERR_PACKAGE_PATH_NOT_EXPORTED`), points the specifier at `dist-electron/electron/plugin-sdk/<entry>.js`. `scripts/build-main.mjs` builds those files from the SDK source with every dependency bundled (`scripts/lib/plugin-sdk-runtime.mjs`); in a packaged app they sit inside the ASAR beside the worker's own bundles. `/react` and `/testing` are refused by name.

### What is deliberately host-internal

These live in `shared/types/plugin.ts` but are **not** re-exported from the SDK barrel. A plugin author should never reference them:

| Symbol | Why internal |
| --- | --- |
| `BUILT_IN_PLUGIN_CAPABILITIES` | Runtime `const` array; the host schema narrows against it, plugins declare tokens in the manifest |
| `LoadedPluginInfo` | Host loading lifecycle, including host-private fields (`isBuiltin`, `blocklisted`, provenance) |
| `PluginActionDescriptor` | Carries host-computed fields (`pluginId`, `effectiveDanger`); a plugin never constructs one |

An ESLint guard warns when `plugin.ts` grows a new `forge.js` import, because that import has to be classified as SDK-public or host-internal before it can land.

### Adding a new export

1. Add the type to `shared/types/plugin.ts` or `shared/types/forge.ts` as appropriate.
2. Classify it: SDK-public, SDK-react-public, SDK-files-public, or host-internal.
3. If public, re-export it from `shared/types/plugin-sdk.ts` under the right group comment (or from `plugin-sdk-react.ts` / the `files` entry).
4. Add a type-level assertion in `shared/types/__tests__/plugin-sdk.test.ts`.

A symbol that appears in a `PluginHostApi` signature but not in the barrel is a bug: the plugin can call the method and cannot name its argument or result.

## Reference

Key source locations for contributors:

**Core**

- `electron/services/PluginService.ts` — discovery, load, activate, unload; the facade its collaborators hang off
- `electron/schemas/plugin.ts` — the Zod schema that accepts or rejects a manifest, per origin
- `shared/types/plugin.ts` — the type surface (`PluginManifest`, `PluginHostApi`, …); `shared/types/plugin-sdk.ts` is the public subset
- `electron/ipc/handlers/plugin.ts` — IPC handlers for plugin-invoked methods

**Collaborators (`electron/services/plugin/`)**

- `PluginHostFactory.ts` — builds the bound `host` object every capability gate lives in
- `ProjectPluginController.ts`, `projectPluginDiscovery.ts`, `ProjectPluginWatcher.ts` — the project-local root
- `pluginDangerLattice.ts` — `manifestTriggersCompoundElevation`, `computePluginDanger`
- `pluginFsContainment.ts` — the realpath containment behind `host.fs` / `host.git`
- `pluginDatabase.ts` (location) and `shared/utils/pluginDatabaseHandle.ts` (the connection) — `host.db`; `pluginDataBackup.ts` — the **Back up data…** panel-menu entry
- `pluginPdfRenderer.ts` — `host.documents.renderPdf`
- `pluginDevWorkerHostProxy.ts`, `PluginDevWorkerMainBridge.ts`, `pluginHostErrorFields.ts`, `pluginInternalApprovers.ts` — the worker port
- `pluginSdkResolution.ts` — the SDK resolve hook for zero-build workers
- `PluginBlocklistService.ts` — the remote kill-switch
- `pluginInvokeDeadline.ts`, `pluginPayloadLimits.ts`, `pluginPushBatcher.ts`, `pluginPushListenerRegistry.ts`, `pluginSubscriptionCoalescing.ts` — the [plugin transport](#plugin-transport); `pluginFsReadFiles.ts`, `pluginFsWalk.ts` — `host.fs.readFiles` / `walk`
- `PluginMetricsService.ts` — [per-plugin metrics](#per-plugin-metrics); `shared/config/pluginBudgets.ts` holds the limits and budgets, `shared/types/pluginMetrics.ts` the snapshot
- `PluginInstaller.ts`, `PluginSettingsManager.ts`, `PluginStorageManager.ts`, `PluginProcessManager.ts`, `PluginSurfaceRegistry.ts`, `PluginRecipeRegistry.ts`

**Consent and MCP**

- `electron/services/plugin-capability/` — just-in-time capability consent and its store
- `electron/services/plugin-mcp/` — MCP consent, tier auth, rate limiting, audit
- `electron/services/PluginMcpSupervisor.ts` — the MCP subprocess supervisor (`mcpServers`, Daintree as client)
- `electron/services/pluginAgentMcp/` — agent MCP endpoints (`agentMcp`, Daintree as host): roster validation, enablement, grants, the plugin route and its session server

**Renderer**

- `src/hooks/usePluginActions.ts` — renderer-side action sync
- `src/components/Plugin/` — the plugin manager (`PluginManagerView.tsx`, `PluginDetailPane.tsx`, `PluginPerformanceTab.tsx`) and the view host (`PluginViewContent.tsx`)
- `src/pluginUi/` and `src/components/PluginKit/` — the `@daintreehq/plugin-ui` facade and the host adapters behind it
- `src/services/plugin/pluginViewMetrics.ts`, `pluginMetricsReporter.ts`, `src/utils/longTaskMonitor.ts` — the renderer half of the metrics
- `src/utils/disposable.ts` — the disposable pattern
- `shared/config/panelKindRegistry.ts` / `toolbarButtonRegistry.ts` / `pluginIconIds.ts` — registries with plugin-scoped unregister
- `electron/services/pluginMenuRegistry.ts` — menu items

**Tests**

- `electron/services/__tests__/PluginService.*.test.ts` — unit tests split by concern (`core`, `install`, `actionRegistry`, `hostFsGit`, `manifestSchema`, `provenanceAndActivation`, …)
- `electron/services/__tests__/PluginService.integration.test.ts` — integration tests
- `plugins/sample/` — `hello-daintree`, `rich-daintree`, `file-tree`; `plugins/fixtures/project-local/` — the project-root discovery fixture

Tests are comprehensive — use them as the living reference when source comments don't answer the question.
