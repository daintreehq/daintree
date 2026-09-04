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

Plugin directory names must match the plugin's `name` field. A plugin named `acme.linear-planner` must live in `~/.daintree/plugins/acme.linear-planner/`. Mismatched names produce a warning and the plugin is skipped.

The `plugins` root is configurable for testing via the `PluginService` constructor argument but otherwise fixed.

There are three discovery roots, and which one a manifest was found under is its **origin** (`PluginOrigin = "builtin" | "user" | "project"` in `shared/types/plugin.ts`). The origin is what the manifest gate keys its three-way rules off, and it replaced the older `isBuiltin` boolean, which could only say "first-party or not":

- `"builtin"` — shipped inside the app bundle (`plugins/builtin/`), plus the E2E sideload root, loaded on the same trust footing.
- `"user"` — the startup scan of `~/.daintree/plugins/`.
- `"project"` — `<projectRoot>/.daintree/plugins/`, scanned per project on open rather than once at startup. Unlike the other two this root is plural and dynamic: one per open project. See [Project-local plugins](#project-local-plugins).

`discoverProjectPlugins` (`electron/services/plugin/projectPluginDiscovery.ts`) is the project-root scan. It deliberately does not compare the directory name against the manifest `name`: identity comes from the manifest, and the shipping `plugins/builtin/github` directory already declares `daintree.github`, so making the rule hard for one root alone would leave the roots disagreeing about what a plugin folder is.

### Manifest validation

Validation is strict. The manifest is parsed by `PluginManifestSchema` (Zod) in strict mode, which rejects unknown top-level keys and unknown keys inside `contributes` (both the inner object itself and contributions whose individual entry schemas opt into `.strict()`). The reason is conservative: unknown keys are almost always typos, and silently dropping typo'd contributions is a bad debugging experience.

Validation also runs structural checks across the whole `contributes` block via a `superRefine` pass (#10620), not just per-field shape:

- **Duplicate contribution IDs** within any one array (`panels`, `commands`, `views`, `mcpServers`, `agents`, `settings`, `forgeProviders`, `fileDecorationProviders`, …) are rejected with a `duplicate_contribution_id` error.
- **Dangling cross-references** are rejected: a `forgeProvider`'s `settingsScopeRef` and `viewRefs[]` must resolve to declared settings/views; every `view.id` must match a declared `panels[].id` (an orphaned view that names no panel is now a hard manifest error, not a load-time warning); and `${settings:settingId}` tokens inside an MCP server's `command`/`args`/`env` must reference a declared setting (unknown tokens fail with `settings_token_unknown` / `settings_token_malformed`).

The schema is built per origin — `getPluginManifestSchema(origin)` — so a handful of rules differ by discovery root. The reserved `daintree.*` namespace is builtin-only, and `scope: "project"` is enforced in both directions: required under the project root (`project_scope_required`), rejected under the user and builtin roots (`project_scope_not_allowed`). A project-scoped manifest additionally may not declare the contribution groups that are still structurally app-wide, or claim `contributes.surfaces` unless it is project-scoped — see [Project-local plugins](#project-local-plugins).

Agent `command`/`args` are the one exception to the token check: the schema does **not** validate their `${settings:*}` tokens at parse time even though the runtime resolves them at spawn (see [Environment variable substitution](#environment-variable-substitution)).

The `engines.daintree` semver range is validated and compared against the running Daintree version. A mismatch produces a user-visible toast and the plugin is skipped.

### Registration

The manifest `contributes` object has 16 contribution points (`electron/schemas/plugin.ts`): fifteen arrays — `panels`, `toolbarButtons`, `menuItems`, `keybindings`, `contextMenus`, `commands`, `views`, `mcpServers`, `skills`, `forgeProviders`, `fileDecorationProviders`, `agents`, `processTools`, `settings`, `recipes` — each with a per-array cap in `MANIFEST_CONTRIBUTION_CAPS`, plus the non-array `surfaces` object. Most register eagerly at plugin-load time so the UI reflects them immediately — the command palette, toolbars, menus, keybindings, and context menus populate before any plugin code runs:

- `panels` → `registerPanelKind()` in `shared/config/panelKindRegistry.ts`
- `toolbarButtons` → `registerToolbarButton()` in `shared/config/toolbarButtonRegistry.ts`
- `menuItems` → `registerPluginMenuItem()` in `electron/services/pluginMenuRegistry.ts`
- `keybindings` → `registerPluginKeybinding()` (each entry's `when` expression is tracked so context changes re-evaluate)
- `contextMenus` → `registerPluginContextMenuItem()` (`when`-tracked like keybindings)
- `agents` → `registerPluginAgents()` — gated behind the `agent:register` capability (schema rejects `contributes.agents` without it, #9560)
- `settings` → registered through `PluginSettingsManager`, so a settings form renders whether or not the plugin is running

Commands have two registration paths. They MAY be declared in `contributes.commands` — these are registered eagerly at load as `PluginActionDescriptor`s so they appear in the palette before any plugin code runs, with their handler lazily bound to `src/{id}.{ext}` on first dispatch. Or they register imperatively via `host.registerAction()` during `activate()`. The manifest stays a static shape contract; the action system resolves handlers at runtime.

`forgeProviders` and `fileDecorationProviders` register their manifest-declared descriptors eagerly (`registerForgeProviders` / `registerFileDecorationProviders`), but their runtime implementations bind imperatively in `activate()` via `host.registerForgeProvider()` / `host.registerFileDecorationProvider()` against a declared descriptor id.

Contributions that require code are registered as **resolvers** — thunks that import the actual code when first needed. `views` are resolved lazily when their panel is first opened (#10523), and `mcpServers` are resolved lazily on first tool enumeration (#9235), not at activation. These two are the contribution points whose runtime never loads until used.

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
8. MCP subprocess lifecycle (`PluginMcpSupervisor.shutdown({ pluginId })`, with execa's kill escalation — see [MCP supervisor → Process lifecycle](#process-lifecycle))

For a user-installed plugin the disposal cascade is followed by killing its worker, which reclaims the plugin's entire module realm — module-scope state never survives a reload. For a built-in (which runs in-process) the module is merely orphaned: Node's module cache still holds it but no live references point to it, and since built-ins are never uninstalled that residue never accumulates.

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

Panels, commands/actions, toolbar buttons, keybindings, context menus and settings scope cleanly. The groups that register into a registry with no project axis at all — `menuItems`, `agents`, `skills`, `recipes`, `fileDecorationProviders`, `processTools`, `mcpServers` — are rejected at manifest validation for `scope: "project"`, each with an error naming its structural obstacle, rather than accepted and silently over-published. `forgeProviders` is rejected for a different reason: its host methods are synchronous and cannot cross the worker's message port. `PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS` in `electron/schemas/plugin.ts` is the enumerated set, so a group that later grows a project axis is removed in one place.

### Host binding

`createPluginHost` takes a `PluginHostBinding` (`{ projectId, projectRoot }`) and captures it **once, at construction**. Every closure reads the captured values; no bound host method resolves a project, worktree, or renderer from focus. That covers renderer dispatch and `host.actions.*`, the UI prompts, worktree getters and events, agent-state events, `sendToActiveAgent`, toasts and renderer pushes, and settings and storage `"project"` scope resolution. One gap is worth knowing: `PluginHostFactory` passes only `projectRoot` into `resolveStorageFilePath`, so `host.storage` at `scope: "worktree"` still falls back to the app-global active worktree and can follow focus rather than the binding.

A bound round-trip with no live renderer for its own project throws `PROJECT_VIEW_UNAVAILABLE` (`shared/types/appError.ts`) rather than falling back — the fallback _is_ the confused-deputy bug. `resolveTargetWebContents` in `electron/services/plugin/rendererTargeting.ts` is the single decision point: nullish `projectId` means unbound and resolves ambiently, anything else resolves that project or throws. The throw reaches the plugin as a rejection from `host.dispatch` and the UI prompts; the read-only catalog surfaces (`host.actions.list` / `get` / `canDispatch`) are documented never to throw, so they catch exactly this code and answer empty. A cached (evicted-but-retained) view still counts as live; a visible view wins when the project is open in more than one window.

Installed and builtin plugins keep an unbound binding (`UNBOUND_PLUGIN_HOST_BINDING`) and the ambient behaviour they always had. Making them project-bound is a separate product decision; what this feature delivers is that the binding exists, project plugins always have one, and a bound plugin's resolution path never consults focus.

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

## Renderer host

Plugin views render inside Daintree's existing panel system. They must share Daintree's React 19 instance — two React copies on one page produce "Invalid hook call" errors even if the versions match exactly.

### Sharing strategy

**Import maps + Vite externals.**

- Plugin bundles externalize React via the `@daintreehq/plugin-vite` preset, which sets `build.rollupOptions.external` to `[/^react($|\/)/, /^react-dom($|\/)/]`. The regex form covers every subpath; `external: ["react"]` matches only the literal string `"react"` and silently bundles `react/jsx-runtime` into plugin output.
- Daintree's `index.html` injects a `<script type="importmap">` at build time, mapping `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, and `react-dom/client` to the host's `vendor-react` chunk.
- When the plugin bundle executes in Daintree's renderer, those imports resolve to the host's single React instance.

Chromium (Electron 42) supports import maps natively — no polyfill required.

**`react/jsx-runtime` is not optional.** JSX compiled with the new transform (`jsx: "react-jsx"` in tsconfig) desugars to `jsx()` / `jsxs()` calls imported from `react/jsx-runtime`. If the plugin bundles its own copy of that module, every JSX element creates a React element tied to a different React instance, and hooks inside the plugin view throw at runtime. The `@daintreehq/plugin-vite` preset enforces this externalization automatically — plugin authors don't configure it manually.

**Inline-script CSP gate.** The host CSP forbids `'unsafe-inline'` for `script-src`, so the inline `<script type="importmap">` is gated by an explicit SHA-256 hash. The build emits the hash both into the `<meta http-equiv="Content-Security-Policy">` tag and into a `dist/importmap-meta.json` sidecar that the Electron main process reads at startup to mirror the hash into the HTTP `Content-Security-Policy` header. The hash MUST stay aligned across both layers — Chromium intersects header and meta, and a divergence silently drops the importmap, leaving plugins with unresolvable bare `react` specifiers.

**Integrity attribute is forbidden on the importmap tag** per the HTML spec. Subresource integrity for the importmap's target chunks (when needed) lives as a top-level `"integrity"` block inside the JSON payload, supported in Chromium 127+.

**Why not Module Federation?** Module Federation handles version negotiation between host and plugin, but adds ~30 KB of runtime and significant build complexity. Daintree controls both the host React version and the plugin template, so negotiation isn't needed.

**Why not `window.__REACT__`?** Breaks ESM tree-shaking, doesn't cleanly handle `react/jsx-runtime`, and forces plugins into a non-standard module pattern.

### Version discipline

Plugins declare a `react` peer dependency in their own `package.json`. The host version is canonical. If Daintree bumps React's major version, the plugin template's published peer range is updated and installed plugins are revalidated against the new range as part of the `engines.daintree` compatibility gate.

### Import URL flow

Plugin view modules are loaded via Daintree's `plugin://` privileged protocol. When `PluginService.loadPlugin` matches a `contributes.views` entry to a panel by bare id, it stores the resolved URL on the `PanelKindConfig` and broadcasts it through `plugin:panel-kinds-changed`. The renderer's `PluginViewHost` calls `React.lazy(() => import(componentPath))` against that URL; Chromium resolves the protocol, the response carries the `plugin://` security headers, and the bare `react` / `react/jsx-runtime` specifiers in the bundle resolve through the host import map to Daintree's single React instance.

**The URL authority is opaque, not the plugin id.** Every load mints an authority — `pi-` plus 32 hex characters from a CSPRNG — and host-built URLs use it: `plugin://pi-{token}/__dtv-{n}/dist/panel.js`. The authority is never reissued, so a URL captured before an unload 404s forever rather than resolving into whatever next occupies that plugin id, and two projects shipping the same manifest id get separate authorities and separate trees. `mintPluginAuthority` seeds a second key into the same resolver map as an **alias**: the plugin's host-side id, which is the manifest id for an installed plugin and the instance key for a project-local one. That alias is what keeps a hand-written `plugin://{pluginId}/…` URL working (`contribution-points.md` documents the form, and the `pluginId` a view is handed is exactly this key). It is rebound on every reload and dropped on unload. Treat the authority as the real addressing unit — nothing should assume the hostname is a bare manifest id — and do not treat it as a secret. It is a namespace, not a capability.

The resolved URL travels through the renderer over the existing panel-kinds IPC broadcast — no separate channel is required. `location: "sidebar"` and an unsafe `componentPath` (absolute paths, URL schemes, `..` segments) are rejected at manifest validation, so the whole plugin fails to load loudly rather than silently dropping the view. A view that targets a panel id with no matching `contributes.panels` entry is likewise rejected at manifest validation (#10620) — an orphaned view would otherwise never render, so the whole plugin fails to load rather than silently dropping it.

### Hot reload — dev only

In dev, the host can re-evaluate a plugin view's module after the source changes. For installed and builtin plugins there is no production hot-reload path; project-local plugins are the exception, and reload from a watched `dist/` in an ordinary session (see [Hot reload for project plugins](#hot-reload-for-project-plugins)). V8 caches ESM module records by URL string and Chromium offers no eviction API (Vite #14438 / Chromium #350426234, unresolved as of 2026). Every cache-busting query string permanently expands the renderer's module map; iterating against a long-lived production renderer would leak memory indefinitely. Treat hot reload as a dev affordance and assume production users reach a clean state by closing and reopening the panel.

### Renderer-first teardown

The renderer is the first surface to know that a plugin's panel kind has been removed: `PluginService.unloadPlugin` fires `plugin:panel-kinds-changed` before it deletes the in-memory plugin entry, so the broadcast crosses the IPC boundary while host APIs are still live. `PluginViewHost` subscribes to that push and aborts its `disposeSignal` synchronously when its kind disappears from the payload — _before_ React unmounts the subtree. Plugin `useEffect` cleanups that listen on `disposeSignal` (fetch aborts, subscription teardown, MessagePort closes) therefore run while the plugin's IPC handlers and host APIs are still answering, instead of racing against the main-side teardown.

### Error boundaries

Every plugin view is wrapped in an error boundary by the host. A crash renders the component-variant fallback with a "Try again" button; the host wires `onReset` to bump a retry counter that produces a fresh `lazy()` reference, so `import()` is re-evaluated rather than returning the cached failed promise. The rest of Daintree is unaffected — the panel grid keeps working, other plugins keep running, the user can close the failing panel normally.

### Trusted-inline → iframe contract

Today's inline host is the right trade for curated trust. The `PluginViewHost` API surface — the `PanelViewProps` shape (`panelId`, `pluginId`, `disposeSignal`) and the broadcast-driven teardown ordering — is intentionally chosen to survive a future cutover to a trusted iframe model. `componentPath` would resolve to a sandboxed frame URL instead of a direct ESM import; the props would marshal over `postMessage`; `disposeSignal` would still abort on the same `panel-kinds-changed` removal event. No manifest change would be required on the plugin author's side.

### Inline, not iframe

Views render inline in Daintree's React tree. Plugins share Daintree's DOM, CSS cascade, and React context. This is optimal for a curated-trust model: richer integration, direct use of host UI components, native React hooks.

An iframe model would isolate plugins behind a `postMessage` bridge at the cost of heavy DX friction and rebuilt UI components per frame. That's the right trade for an untrusted-plugin model — if Daintree ever opens to fully untrusted third-party plugins, iframe isolation via a `plugin://` protocol handler is the upgrade path. Nothing in the current manifest shape needs to change — `componentPath` resolves differently for trusted vs untrusted plugins, but the field is the same.

### Plugin styling: a scoped runtime Tailwind sheet

Sharing the cascade is what lets Tailwind be the styling contract for plugin views (#12220). Tailwind v4 emits only the classes its build-time scan finds in this repo, so before this a plugin's class worked if and only if the host happened to use it too — which changed every release. Instead, the renderer compiles plugin classes itself, at runtime.

Three steps, deliberately kept separate:

1. **Collect candidates.** Two sources. The view module's source text is fetched and tokenised before the module is imported, which is what makes the first paint styled; and one `MutationObserver`, attached to plugin roots only, reads `classList` as the DOM changes. The observer is authoritative — it sees template literals, sibling modules and runtime-computed names that source tokenisation cannot. Its callback is a microtask, so a class toggled on by state is styled before the next paint.
2. **Compile.** `src/services/plugin/tailwind/pluginTailwindAdapter.ts` is the only place Tailwind's programmatic API is called. It compiles the host's own `src/styles/design-contract.css` — the same bytes `index.css` imports — with the stock theme pulled in as `reference`, so no `:root` variables and no preflight are re-emitted. Utilities land nested in `@layer utilities { @scope ([data-daintree-plugin-style-root]) { … } }`.
3. **Install.** One constructed `CSSStyleSheet` per document on `adoptedStyleSheets`, shared by every plugin root in it, replaced wholesale on each build because `build()` returns a cumulative sheet whose order can change.

Two properties are load-bearing. `@layer utilities` is a document-global layer name, so plugin utilities join the host's at the host's declared priority — layer membership, not specificity, decides the cascade here. And the `@scope` wrapper is what makes duplicate emission safe: a plugin using `p-4` emits its own `.p-4`, and without the scope that late rule would override a host element carrying `p-4 px-3`.

Each project view is its own `WebContentsView`, so each document compiles once (~10 ms) and owns its own sheet; a constructed stylesheet belongs to the document that made it and is never shared across them. The compiler chunk is lazy and loads in parallel with plugin activation.

**What a future iframe view host would need.** Keeping collection, compilation and installation separate is what makes that a wiring change rather than a rewrite: the same service runs inside the frame, or compiled CSS is handed across. But none of the ambient context crosses a frame boundary, so an explicit snapshot of the theme variables, the baseline CSS, the fonts and the approved extensions would have to cross with it.

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
- Teardown on plugin unload and on Daintree quit is execa-managed: `subprocess.kill()` with no explicit signal, so execa's own `forceKillAfterDelay` escalation stays armed (a 3-second grace before the hard kill). Passing a signal would disable that escalation, so the supervisor deliberately doesn't. On Windows it additionally shells out to `taskkill /T /F` after the grace window, because Windows does not cascade a kill to grandchildren.
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

Plugin-supplied listeners across the host (`onDidChangeAgentState`, `onDidWake`, `storage.onDidChange`, `settings.onDidChange`, and the worktree subscriptions above) are dispatched through `invokeTrackedListener`, which quarantines a misbehaving callback. Each throw — synchronous or a rejected async return — increments a per-listener counter that is logged with its position (`1/3`, `2/3`, …); a single successful invocation resets it to zero, so intermittent failures never accumulate. After three consecutive throws the listener is auto-unsubscribed via its own disposer, so a buggy or adversarial plugin can't spam the log with a repeating error on every event.

## Capability disclosure

Capabilities are **disclosure-first with host-side policy effects** — a hybrid model. The host does not sandbox plugin code: a plugin declaring `capabilities: []` can still make network requests and write files via raw Node APIs. But declared capabilities are not purely advisory either. They drive host-side policy, most concretely danger classification on plugin-registered actions. See the [trust model](./trust-model.md) for the full decision record, decision matrix, and capability schema.

What disclosure does:

- An installed plugin's detail view shows the declared capabilities in a humanized list: "This plugin can read your worktree files, make network requests, and spawn subprocesses."
- That detail-pane list is the disclosure surface — it appears in the plugin manager after install, not as a pre-install consent gate. A fresh install runs without enumerating capabilities (see the [trust model](./trust-model.md)).

What the host derives from declared capabilities:

- **Danger classification (live today).** When a manifest holds any high-risk token in `CONFIRM_TRIGGERING_CAPABILITIES` (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`), every action that plugin registers is raised to `effectiveDanger: "confirm"` — gating the renderer's confirm dialog, MRU-rail eligibility, and `repeatLast`. The host may only raise danger, never lower it. This is host-side UX policy on Daintree's own action system; it does **not** block the plugin from executing code or calling IPC directly.
- **Compound-capability lattice (live, #9247).** Single capabilities that aren't individually irreversible can still combine into a threat. `manifestTriggersCompoundElevation()` (`electron/services/plugin/pluginDangerLattice.ts`) catches two compound classes: exfiltration (a sensitive read in `SENSITIVE_READ_CAPABILITIES` paired with an unconstrained `shell:exec` or `network:fetch` sink) and remote-controlled mutation (`network:fetch` paired with a local write or shell sink). A plugin attenuates the elevation by declaring a tight `scopes.network.allowedUrls` — a scoped `network:fetch` can't be remote-controlled, so the scope removes that class. Wildcard scopes are rejected at the schema boundary.
- **Just-in-time consent (live, #10524).** Declaring a capability is necessary but not sufficient for the sanctioned host surfaces. The first time a plugin actually calls `host.process.spawn` (`shell:exec`), `host.fs.writeFile` (`fs:*-write`), `host.git.add`/`commit` (`git:write`), or `host.sendToActiveAgent` (`agent:input`), `ensureCapabilityConsent` (`PluginHostFactory.ts`) raises a first-use dialog through `PluginCapabilityConsentService`. A pinned grant makes later calls silent; a denial rejects with `PERMISSION_REQUIRED:`. Grants key on `(scopeKey, pluginId, capability)` with `scopeKey` taken from the host's own binding, so one project's approval never answers for another project's copy of the same manifest id. Built-in plugins skip the prompt. This is the only place a capability is a runtime gate rather than a label — and only on the host-mediated path.
- **MCP consent tier (live, #9234).** A plugin's declared capabilities cap the danger tier its MCP server's tool surface can reach (`electron/services/plugin-mcp/PluginMcpTierAuth.ts`): a server that didn't declare a high-risk capability can't trigger a D2 confirmation just by advertising `destructiveHint: true` — the call is denied, not silently downgraded. See the trust model for the complete list.

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

- **Resolved once, before any scan.** `PluginService.initialize()` awaits `getBlocklist()` ahead of the first discovery pass and holds the result for the whole session, so the answer can't change halfway through a scan.
- **Fails open.** A network error, a timeout (8 s ceiling), or a parse failure returns `null` and every plugin loads. A stale disk cache is still enforced while offline — stale-while-revalidate against a 6-hour TTL, deliberately shorter than the model-catalog TTL so an entry reaches running installs in hours, not a day.
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

**Why no separate hooks contribution point (PreToolUse/PostToolUse)?** An MCP server can act as a proxy in front of other tools, intercepting and modifying tool calls. This uses the ecosystem we're already committed to (MCP) rather than inventing a parallel API. Plugins that genuinely need this can build it cleanly.

## SDK surface

`shared/types/plugin-sdk.ts` is the public export boundary for `@daintreehq/plugin-sdk` and the single source of truth for what a plugin author may name. Every symbol re-exported there is a contract: additions are non-breaking, removals are breaking. **Read that file rather than a table here** — it is grouped by area with a comment per group, and a list duplicated into prose only rots.

Three entry points:

- `@daintreehq/plugin-sdk` — manifest-authoring types, the host API and its sub-APIs, worktree/agent projections, the forge and file-decoration contracts, action dispatch and catalog types, plus two runtime values (`localAuthStubs`, `PLUGIN_PROCESS_STREAM_CHANNEL`).
- `@daintreehq/plugin-sdk/react` — the renderer hooks for view components (`useHostChannel`, `usePluginEvent`, `usePluginPanelEvent`) and their types (`shared/types/plugin-sdk-react.ts`). The implementations live in `packages/plugin-sdk/src/react/`; Daintree's own `src/hooks/` re-exports them through thin shims so host and plugins run one implementation. This subpath is **not** in the host import map (which serves only React specifiers), so it resolves only in a view bundled by `@daintreehq/plugin-vite`; a raw, un-bundled `plugin://` view talks to the host through `window.electron.plugin.on` / `.invoke` directly (see [Host API → React hooks](./host-api.md#react-hooks--daintreehqplugin-sdkreact)).
- `@daintreehq/plugin-sdk/files` — the headless file-listing model Daintree's own file browser runs on (`packages/plugin-sdk/src/files/`). No components, no icons, no I/O. See [Host API → File listings](./host-api.md#file-listings--daintreehqplugin-sdkfiles).

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
- `PluginBlocklistService.ts` — the remote kill-switch
- `PluginInstaller.ts`, `PluginSettingsManager.ts`, `PluginStorageManager.ts`, `PluginProcessManager.ts`, `PluginSurfaceRegistry.ts`, `PluginRecipeRegistry.ts`

**Consent and MCP**

- `electron/services/plugin-capability/` — just-in-time capability consent and its store
- `electron/services/plugin-mcp/` — MCP consent, tier auth, rate limiting, audit
- `electron/services/PluginMcpSupervisor.ts` — the MCP subprocess supervisor

**Renderer**

- `src/hooks/usePluginActions.ts` — renderer-side action sync
- `src/components/Plugin/` — the plugin manager (`PluginManagerView.tsx`, `PluginDetailPane.tsx`)
- `src/utils/disposable.ts` — the disposable pattern
- `shared/config/panelKindRegistry.ts` / `toolbarButtonRegistry.ts` / `pluginIconIds.ts` — registries with plugin-scoped unregister
- `electron/services/pluginMenuRegistry.ts` — menu items

**Tests**

- `electron/services/__tests__/PluginService.*.test.ts` — unit tests split by concern (`core`, `install`, `actionRegistry`, `hostFsGit`, `manifestSchema`, `provenanceAndActivation`, …)
- `electron/services/__tests__/PluginService.integration.test.ts` — integration tests
- `plugins/sample/` — `hello-daintree`, `rich-daintree`, `file-tree`; `plugins/fixtures/project-local/` — the project-root discovery fixture

Tests are comprehensive — use them as the living reference when source comments don't answer the question.
