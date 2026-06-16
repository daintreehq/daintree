# Host API

The host API is the runtime surface a plugin's `activate` function receives. It exposes Daintree's state and lets plugins register dynamic behavior beyond what's declared in the manifest.

The canonical import source is `@daintreehq/plugin-sdk`. Types referenced here live in that package.

> `@daintreehq/plugin-sdk` is not yet published on npm, so the imports shown below won't resolve from the registry today. The types it will ship currently live in-repo at `shared/types/plugin-sdk.ts`; import them via a relative path for now.

## Activation

A plugin's main module exports an `activate` function:

```ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi) {
  // setup
  return () => {
    // optional cleanup
  };
}
```

The returned cleanup function (if any) runs when the plugin is unloaded — during hot reload, uninstall, or Daintree shutdown. Anything you register via the host API is cleaned up automatically; the cleanup function is for resources you own outside the host (e.g., a subprocess you spawned directly).

**Activation timeout:** 5 seconds. If `activate` doesn't resolve within the timeout, Daintree marks the plugin as failed and surfaces a toast. Keep activate fast; defer heavy work to command handlers.

**Error handling:** if `activate` throws, the plugin fails to load and the error is logged to the main process console plus surfaced as a toast. Other plugins continue loading.

## `PluginHostApi`

```ts
interface PluginHostApi {
  readonly pluginId: string;

  // Action / command registration
  registerAction(descriptor: PluginActionContribution, handler: ActionHandler): void;

  // IPC
  registerHandler<TArgs, TResult>(
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>
  ): void;
  registerHandler(channel: string, handler: PluginIpcHandler): void;
  broadcastToRenderer(channel: string, payload: unknown): void;

  // Post-activation push into your panels
  postToPanel(channel: string, payload: unknown): void;

  // Worktree observation
  getActiveWorktree(): Promise<PluginWorktreeSnapshot | null>;
  getWorktrees(): Promise<PluginWorktreeSnapshot[]>;
  getWorktreeStatus(path: string): Promise<PluginWorktreeStatus | null>;
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void
  ): () => void;
  onDidChangeWorktrees(callback: (snapshots: PluginWorktreeSnapshot[]) => void): () => void;

  // Forge / file-decoration providers
  registerForgeProvider(descriptor: ForgeProviderDescriptor, impl: ForgeProviderImpl): () => void;
  registerFileDecorationProvider(
    descriptor: FileDecorationProviderDescriptor,
    impl: FileDecorationProviderImpl
  ): () => void;
  invalidateFileDecorations(scope: string, paths?: string[]): void;

  // Action dispatch
  dispatch(actionId: ActionId, args?: unknown): Promise<ActionDispatchResult>;

  // Settings
  readonly settings: SettingsApi;

  // Diagnostics
  readonly logger: PluginLogger;

  // UI helpers
  showToast(options: PluginToastOptions): Promise<void>;

  // Managed child processes — gated on the `shell:exec` capability
  readonly process: PluginProcessApi;

  // Host-mediated, scope-contained filesystem and git
  readonly fs: PluginFsApi;
  readonly git: PluginGitApi;
}
```

The authoritative definition is in `shared/types/plugin.ts` in the Daintree repo.

The revoke-guarded methods — `registerAction`, `registerHandler`, `broadcastToRenderer`, `registerForgeProvider`, `registerFileDecorationProvider`, `onDidChangeActiveWorktree`, `onDidChangeWorktrees`, and `settings.onDidChange` — must be called during `activate()` and throw once the host is revoked. Subscribing counts as an activation-window operation even though the callback fires later: register all your subscriptions during `activate()`, then react to them for the plugin's lifetime. `postToPanel`, `getActiveWorktree`, `getWorktrees`, `getWorktreeStatus`, `invalidateFileDecorations`, `showToast`, `dispatch`, `process.spawn`, `fs.*`, `git.*`, `settings.get`/`settings.set`, and `logger` are deliberately NOT revoke-guarded: plugins call them from post-activation subscription callbacks and timers, so they stay callable for the plugin's lifetime and become a silent no-op (or, for `process.spawn`/`fs.*`/`git.*`, a rejection) after unload. This split is the load-bearing distinction between the activation-window registration surface and the live runtime surface — `postToPanel` is the canonical post-activation push: a plugin's `activate()` subscribes once (revoke-guarded `registerHandler`/worktree subscriptions), then streams live data into its panels with `postToPanel` for the rest of its lifetime.

This split is encoded in the type surface, not just in prose: the revoke-guarded host methods are factored into a `PluginActivationApi` sub-interface that `PluginHostApi extends` (`settings.onDidChange` stays on `SettingsApi`, since the `settings` accessor itself is post-activation-safe). Each revoke-guarded method also carries a `@throws` JSDoc tag describing the revoke condition, so it shows up on hover in your editor. The `host` passed to `activate()` stays typed as the full `PluginHostApi` (every method is callable during activation); `PluginActivationApi` is exported from `@daintreehq/plugin-sdk` for the narrower case where you want a helper to accept only the registration window and have the post-activation methods be statically absent.

## `registerAction`

Imperative action registration for cases where manifest-declared commands aren't enough (dynamic IDs, programmatic danger levels, runtime-driven categories).

```ts
host.registerAction(
  {
    id: "plan-from-issue",
    title: "Plan From Issue",
    description: "Turn a Linear issue into a branch and agent session.",
    category: "Linear Planner",
    kind: "command",
    danger: "confirm",
    keywords: ["linear", "plan"],
  },
  async (args) => {
    // handler body
    return { ok: true };
  }
);
```

**Signature:**

```ts
registerAction(
  descriptor: PluginActionContribution,
  handler: ActionHandler
): void;
```

**Rules:**

- `descriptor.id` must NOT include the plugin prefix — Daintree adds it. The above registers as `acme.linear-planner.plan-from-issue` at runtime (assuming your plugin is `acme.linear-planner`).
- `descriptor.danger` accepts `"safe"` or `"confirm"`. `"restricted"` is reserved for Daintree's internal use and rejected.
- Agents invoking a `"confirm"` action must include `{ confirmed: true }` in the dispatch options, per the [action system](../architecture/action-system.md).
- Calling `registerAction` with a previously-registered ID replaces the existing registration.

Unregistered automatically on plugin unload.

## `registerHandler` and `broadcastToRenderer`

Low-level IPC for plugin-specific communication between main and renderer. Rarely needed — most plugins use `registerAction` and UI components via the SDK's React hooks.

```ts
// main side (in activate)
host.registerHandler("sync-now", async (ctx, opts) => {
  // ctx.projectId, ctx.worktreeId, ctx.webContentsId, ctx.pluginId
  return { synced: true, timestamp: Date.now() };
});

host.broadcastToRenderer("sync-status", { status: "syncing" });
```

```ts
// renderer side (in a view component) — useHostChannel resolves when the view is
// bundled with @daintreehq/plugin-vite (the SDK is bundled into your output; it is
// NOT served by the host import map). In a raw, un-bundled plugin:// view, call
// window.electron.plugin.invoke(pluginId, "sync-now", args) directly. See "React hooks" below.
import { useHostChannel } from "@daintreehq/plugin-sdk/react";

const { invoke } = useHostChannel<SyncArgs, SyncResult>(pluginId, "sync-now");
const result = await invoke({});
```

**Channel naming rules:**

- No colons (reserved for Daintree's internal namespacing).
- Plugin-registered channels are addressed as `{pluginId}:{channel}` internally; the SDK handles the prefix.

Handlers are unregistered on plugin unload.

**Typed overload (preferred for new code):** pass a `PluginChannelSchema` with Zod `args`/`result` schemas and a `requires` capability list. The host rejects registration if any `requires` capability is missing from `manifest.capabilities` (fail-closed at the registration boundary). At dispatch, args are `safeParse`d before the handler runs and the result is `safeParse`d before returning to the renderer — schema failures throw with a `SCHEMA_ERROR:` prefix, missing capabilities throw with a `PERMISSION_REQUIRED:` prefix, and the renderer-side `useHostChannel` hook discriminates on those prefixes. The untyped overload above does no host-side validation and is retained only for plugins that haven't migrated to per-channel schemas.

## `postToPanel`

The post-activation-safe push channel: stream live data from your `main` into every renderer subscribed to `(pluginId, channel)`, without the renderer falling back to `invoke()` polling.

```ts
// main side — from a timer, poll, or subscription callback (NOT just activate)
setInterval(async () => {
  const status = await fetchBuildStatus();
  host.postToPanel("build-status", status);
}, 5000);
```

```ts
// renderer side (in a view component) — usePluginEvent resolves when the view is
// bundled with @daintreehq/plugin-vite. In a raw, un-bundled plugin:// view, call
// window.electron.plugin.on(pluginId, "build-status", cb) directly; it returns an
// unsubscribe function. See "React hooks" below.
import { usePluginEvent } from "@daintreehq/plugin-sdk/react";

usePluginEvent<BuildStatus>(pluginId, "build-status", (status) => {
  setBuildStatus(status);
});
```

`postToPanel` is the post-activation sibling of `broadcastToRenderer`: it fans out over the exact same `plugin:{pluginId}:{channel}` transport, but unlike the revoke-guarded activation broadcast it stays callable for the plugin's whole lifetime. Use `broadcastToRenderer` for a one-shot push during `activate()`; use `postToPanel` for everything pushed afterward (the common case). `channel` must be a non-empty string without colons — an invalid channel throws so authoring mistakes surface loudly. It is membership-gated, not revoke-guarded: once the plugin is unloaded it becomes a silent no-op. There is no delivery acknowledgement — it is fire-and-forget; a panel that isn't mounted simply doesn't receive the payload. This is the push half of the renderer SDK; the pull half is `useHostChannel` (request/response over `registerHandler`).

## Worktree observation

Read-only access to Daintree's worktree state, allowlisted to prevent internal shape changes from leaking to plugins.

```ts
// Snapshot of the currently-active worktree, or null
const active = await host.getActiveWorktree();
if (active) {
  console.log(active.name, active.branch, active.path);
}

// All worktrees across all projects
const all = await host.getWorktrees();

// Subscribe to changes
const dispose = host.onDidChangeActiveWorktree((snapshot) => {
  if (snapshot) console.log(`Active worktree changed: ${snapshot.name}`);
});

// Later: dispose() to unsubscribe (automatic on plugin unload)
```

**`PluginWorktreeSnapshot` shape:**

```ts
interface PluginWorktreeSnapshot {
  readonly id: string;
  readonly worktreeId: string;
  readonly path: string;
  readonly name: string;
  readonly isCurrent: boolean;
  readonly branch?: string;
  readonly isMainWorktree?: boolean;
  readonly aheadCount?: number;
  readonly behindCount?: number;
  readonly linked: PluginWorktreeLinked | null;
  readonly status: PluginWorktreeStatus | null;
  readonly mood?: "stable" | "active" | "stale" | "error";
  readonly lastActivityTimestamp?: number | null;
  readonly createdAt?: number;
}

interface PluginWorktreeLinked {
  readonly providerId: string;
  readonly issue?: PluginWorktreeLinkedIssue;
  readonly pr?: PluginWorktreeLinkedPR;
}

interface PluginWorktreeLinkedIssue {
  readonly ref: ResourceRef;
  readonly title?: string;
}

interface PluginWorktreeLinkedPR {
  readonly ref: ResourceRef;
  readonly title?: string;
  readonly url: string;
  readonly state: NormalizedPRState;
  readonly ciStatus?: CIStatus;
  readonly baseRef?: string; // branch this PR merges into; drives base-branch divergence display
}
```

`linked` is a provider-agnostic projection of the worktree's linked forge resources (issue and/or PR), or `null` when none is linked. It replaces the removed GitHub-shaped `issueNumber` / `issueTitle` / `prNumber` / `prUrl` / `prState` / `prTitle` fields — route through `linked.providerId` and the shared `ResourceRef` shape instead.

`status` is a changed-file / git-status projection of the worktree, or `null` when the host hasn't polled a status yet:

```ts
interface PluginWorktreeStatus {
  readonly files: readonly PluginWorktreeStatusFile[];
  readonly changedFileCount: number;
  readonly counts: Readonly<Record<PluginWorktreeFileState, number>>;
}

interface PluginWorktreeStatusFile {
  readonly path: string; // relative to the worktree root, as git reports it
  readonly state: PluginWorktreeFileState;
}

type PluginWorktreeFileState = "added" | "modified" | "deleted" | "untracked" | "renamed";
```

It projects the host's already-polled worktree changes (the same data driving the dashboard) — reading it does NOT shell out to a fresh `git status`. The internal git vocabulary is collapsed to the five states above (copied → `added`, conflicted → `modified`, ignored dropped); `files` is sorted by path and the whole projection is frozen. For richer ad-hoc status — staged vs. unstaged, diffs — use `host.git` (below), which runs a real query against the worktree.

All snapshots are frozen — attempting to mutate one throws. Fields are an explicit allowlist; adding a new field requires a Daintree SDK release.

Subscriptions registered during `activate` — before Daintree's worktree service is ready — are queued and replayed once the service comes online. Your callback never misses events.

### `getWorktreeStatus`

```ts
const status = await host.getWorktreeStatus("/Users/me/project/.worktrees/feature-x");
if (status) {
  console.log(`${status.changedFileCount} changed`, status.counts.modified, "modified");
}
```

Returns the same `PluginWorktreeStatus` carried on `PluginWorktreeSnapshot.status` for the worktree at the given absolute `path`, or `null` when no worktree matches or the host hasn't polled a status yet. Use it when you have a path in hand (e.g. from a context-menu dispatch arg) and don't want to scan `getWorktrees()`. Like the snapshot field it reads the host's already-polled status — it never triggers a fresh `git status`. It is NOT revoke-guarded: callable from timers and subscription callbacks, degrading to `null` once the plugin is unloaded.

## `registerForgeProvider`

Binds a runtime `ForgeProviderImpl` to a descriptor declared in `contributes.forgeProviders`.

```ts
const dispose = host.registerForgeProvider({ id: "linear", name: "Linear" }, impl);
```

**Rules:**

- Must be called during `activate()` — the host is revoked once activation resolves or times out.
- `descriptor.id` must match an entry in `contributes.forgeProviders`; undeclared ids are rejected so the impl can't drift away from the manifest's routing table. At runtime the id is namespaced to `{pluginId}.{descriptor.id}`.
- Returns a disposer that unbinds the single impl. Calling `registerForgeProvider` again with the same `descriptor.id` overwrites the prior binding; the older disposer becomes inert.
- All bindings are automatically removed on plugin unload.

For the end-to-end walkthrough — manifest entry, implementing `ForgeProviderImpl`, state normalization, capabilities, and tests — see [Implementing a forge provider](./forge-provider.md).

## `registerFileDecorationProvider` and `invalidateFileDecorations`

Binds a runtime `FileDecorationProviderImpl` to a descriptor declared in `contributes.fileDecorationProviders`.

```ts
const dispose = host.registerFileDecorationProvider({ id: "linear-status" }, impl);

// Later, from a subscription callback or timer:
host.invalidateFileDecorations("worktree", ["src/foo.ts"]);
```

**Rules:**

- `registerFileDecorationProvider` is revoke-guarded — call it during `activate()`. `descriptor.id` must match an entry in `contributes.fileDecorationProviders`; undeclared ids are rejected so the impl can't drift from the manifest's scope-routing table. At runtime the id is namespaced to `{pluginId}.{descriptor.id}`.
- Returns a disposer that unbinds the single impl. Re-registering with the same `descriptor.id` overwrites the prior binding; the older disposer becomes inert. All bindings are removed on plugin unload.
- `invalidateFileDecorations(scope, paths?)` signals that decorations for `scope` (optionally narrowed to `paths`) changed so any renderer showing them re-pulls. It is NOT revoke-guarded — call it from your subscription callbacks and timers throughout the plugin's lifetime. It becomes a silent no-op after unload.

## `dispatch`

Invoke an action by id through Daintree's `ActionService` with a `"plugin"` source — your own registered actions, actions from other plugins, or any built-in action — always through the audited, validated dispatch path.

```ts
const result = await host.dispatch("acme.linear-planner.sync-now", { team: "engineering" });
if (!result.ok) {
  // result.error.code: "RESTRICTED" | "CONFIRMATION_REQUIRED" | "PLUGIN_UNLOADED" | ...
}
```

Args are validated against the action's `argsSchema` by `ActionService`; the host does not re-validate. Actions classified `danger: "restricted"` reject with `RESTRICTED`; `danger: "confirm"` actions return `CONFIRMATION_REQUIRED` — plugins cannot bypass confirm-gating (there is no `confirmed` flag). `dispatch` is NOT revoke-guarded; once the plugin is unloaded it returns `{ ok: false, error: { code: "PLUGIN_UNLOADED" } }` without dispatching.

## `logger`

Structured diagnostic logger backed by a bounded per-plugin ring buffer (most recent ~500 entries) in the main process.

```ts
host.logger.info("Synced 12 issues", { team: "engineering" });
host.logger.warn("Rate limited, backing off");
host.logger.error("Token expired");
```

Lines are mirrored to the host console prefixed with `[plugin:{pluginId}]` and retained so they can be folded into an error report on demand. Calls return `void`, never throw, and never reject — an unserializable `fields` payload is coerced to a string rather than thrown. `logger` is NOT revoke-guarded; writes become a silent no-op after unload.

## `settings`

Persistent, plugin-scoped key/value settings. Reads, writes, and subscribes.

```ts
// Current value (scope defaults to "user")
const token = await host.settings.get<string>("linear.apiToken");

// Update
await host.settings.set("linear.defaultTeam", "engineering");

// Subscribe to changes
const dispose = host.settings.onDidChange("linear.apiToken", (newValue) => {
  reconnect(newValue);
});
```

Scope defaults to `"user"`. `project` scope resolves the active project at call time, so it tracks project switches: `get` returns `undefined` and `set` throws when no project is active. `set` rejects `undefined` and non-JSON-serializable values; when the manifest declares `contributes.settings`, an undeclared key is rejected. `onDidChange` fires only on in-process writes — edits made to the JSON file by other processes don't fire until the plugin reloads.

**Storage:** values are stored as JSON at `~/.daintree/plugin-settings/{pluginId}.json` (user scope) or `<projectRoot>/.daintree/plugin-settings/{pluginId}.json` (project scope), with `chmod 0o600` applied on POSIX. `secret`-typed settings (#9167) are encrypted at rest through the OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret-kwallet via Electron `safeStorage`) by default — the value is persisted as a tagged ciphertext envelope, and the `host.settings.get`/`set` API shape is unchanged (encryption is transparent to your plugin). When no keychain is available (e.g. a headless Linux box without a secret service), `secret` settings fall back to plaintext and the settings UI says so honestly. Non-secret settings are stored as plaintext JSON. Don't rely on the plaintext fallback for secrets that must survive disk compromise on an unconfigured host.

## `showToast`

```ts
await host.showToast({
  message: "Fetched 12 issues from Linear",
  type: "success", // "info" | "success" | "warning" | "error" — defaults to "info"
  durationMs: 4000, // optional; defaults to the app's per-type duration
});
```

The host prefixes `message` with your plugin id (`{pluginId}: {message}`) so users can tell which plugin raised the toast — you don't add the prefix yourself. `message` is a string only (max 2000 chars); `priority` and action buttons aren't exposed to plugins. `durationMs` must be a positive integer up to 60000 (60s). An empty message, an unknown `type`, or an out-of-range `durationMs` rejects.

Toasts route through Daintree's standard `notify()` path, so quiet-hours and inbox-history semantics apply. The rate-limit bucket is scoped per plugin and type, so a noisy plugin can't suppress another plugin's toasts (or system toasts). Audit your toasts against the four-question checklist (timely, helpful, not already visible, ignorable) — the host delivers what you ask for, it doesn't second-guess. There's no "sticky" or "action required" toast type — for persistent UI, register a panel view instead.

## `process` — managed child processes

```ts
const handle = await host.process.spawn("npm", {
  args: ["run", "dev"],
  cwd: "/path/to/project", // defaults to the active worktree, then the host cwd
  env: { PORT: "5173" }, // merged over the host environment
});

handle.onExit(({ exitCode, signal }) =>
  host.logger.info("dev server exited", { exitCode, signal })
);
handle.onCrash(({ exitCode, signal }) =>
  host.showToast({ message: "Dev server crashed", type: "error" })
);

// later — restart on file change, or tear down
await handle.restart();
handle.kill();
```

`host.process` lets a process- or task-orchestrator plugin (dev server, CI runner, watcher) spawn and supervise real child processes instead of hijacking a user terminal. It is the **first host method gated on a declared capability**: a `spawn` from a plugin that did not declare `shell:exec` rejects with a `PERMISSION_REQUIRED:` error — unlike the disclosure-first capabilities, this one is enforced at runtime. Argv is passed verbatim (no shell, so no shell-injection surface).

The returned `PluginProcessHandle` carries `id`, `kill()` (clean `SIGTERM`, then `SIGKILL` after a grace period), `restart()` (respawns with the same command/args/cwd/env, reusing the id and bumping a restart counter), and `onExit`/`onCrash` lifecycle subscriptions carrying the real exit code/signal — `onCrash` fires only on an unexpected (non-zero / signalled) exit you did not request. The child's stdout/stderr stream to your panels over `postToPanel("process", …)` keyed by the handle id; subscribe with `plugin.on(pluginId, "process")` in your view and discriminate on the event `kind` (`stdout` / `stderr` / `exit` / `crash`).

Every spawned process is tied to your plugin's lifetime: on unload/disable/revoke the host SIGTERMs (then SIGKILLs) every outstanding process — a dev server can't leak past a reload. A per-plugin concurrency cap bounds how many processes can run at once; a `spawn` past the cap rejects rather than queueing. `process.spawn` is NOT revoke-guarded — call it from timers and subscription callbacks — but once the plugin unloads it rejects rather than spawning. Spawns are recorded in the plugin audit trail so process execution stays observable. The child does **not** inherit Daintree's full environment — only an allowlist of essentials (`PATH`, locale, temp, OS basics) plus whatever you pass in `env`, so the main process's tokens never leak to a `shell:exec` child; pass anything else the command needs explicitly. `cwd` is a process concern, not an `fs` scope — it is not contained to `scopes.fs.allowedPaths` (it defaults to the active worktree).

## `fs` — host-mediated, scope-contained filesystem

```ts
const text = await host.fs.readFile("/Users/me/.acme/data/notes.md");
await host.fs.writeFile("/Users/me/.acme/data/out.json", JSON.stringify(result));
const entries = await host.fs.readdir("/Users/me/.acme/data");
const meta = await host.fs.stat("/Users/me/.acme/data/notes.md");

const dispose = await host.fs.watch(["/Users/me/.acme/data"], (changedPath) => {
  host.logger.info("file changed", { changedPath });
});
// dispose() tears the watcher down; it is also torn down automatically on unload.
```

`host.fs` is a sanctioned, contained, audited filesystem path. Every argument is resolved against your declared `scopes.fs.allowedPaths` and realpath-contained to one of those roots — a `..` traversal or a symlink that escapes a root is rejected with a `PATH_NOT_ALLOWED:` error, mirroring the `plugin://` protocol handler's discipline. This is the **runtime enforcement of `scopes.fs.allowedPaths`** (previously advisory). Reads gate on `fs:project-read` / `fs:user-data-read`, writes on `fs:project-write` / `fs:user-data-write`; a missing capability rejects with a `PERMISSION_REQUIRED:` error. Unlike the app's `files.read` IPC, `readFile` carries **no 500KB / binary cap** — it is a deliberate plugin API. Writes are recorded in the audit trail, and `watch` watchers are torn down on unload. `host.fs` is NOT revoke-guarded — call it from timers and subscription callbacks.

**Honest scope note:** `host.fs` gates the host-mediated path only. Your `main` still runs in-process and can call raw `node:fs` directly, which the host cannot intercept until the sandbox/trust model changes (D3). `host.fs` gives a contained, audited path; it does not seal the in-process one.

## `git` — host-mediated git, scoped to a worktree

```ts
const status = await host.git.status("/Users/me/project"); // worktree inside allowedPaths
const diff = await host.git.diff("/Users/me/project", "src/index.ts");

await host.git.add("/Users/me/project", ["src/index.ts"]);
const { commit, preview } = await host.git.commit("/Users/me/project", {
  message: "fix: typo", // REQUIRED — the host refuses an empty/derived message
});
// `preview` is the real staged diff the host computed before committing.
```

`host.git` is scoped to a worktree your plugin may access — the `worktreePath` must resolve inside your `scopes.fs.allowedPaths` (same realpath containment as `host.fs`). It is implemented over Daintree's existing hardened git layer, not a reinvented one. Reads (`status`, `diff`) gate on `git:read`; mutations (`add`, `commit`) on `git:write` (and `commit` additionally requires `git:read`, since it returns the staged diff as its preview). Any pathspec you pass to `add` or `diff` must be **worktree-relative** — an absolute path, a `..` segment, or `:`-prefixed git pathspec magic is rejected with a `PATH_NOT_ALLOWED:` error, because git would otherwise resolve those against the whole repository and escape the contained worktree. `commit` enforces the **change-preview safeguard at the host layer** (incident #7880 / destructive-action tier D2): it refuses without an explicit non-empty `message` — there is no silent fallback to a derived commit message — and it computes the real staged diff as a preview before mutating, returned on the result so your UI can surface it. Mutations are recorded in the audit trail. `host.git` is NOT revoke-guarded.

## React hooks — `@daintreehq/plugin-sdk/react`

The `@daintreehq/plugin-sdk/react` subpath carries the renderer hooks for plugin view components. It is a separate import path so non-view code (your `main`) doesn't pull React into the main-process bundle. The runtime implementations live in Daintree's `src/hooks/` — the renderer's home, where the `window.electron` ambient global is in scope — and are re-exported verbatim by the SDK so plugin authors and the host share one implementation.

**These hooks resolve only in a bundled view.** `@daintreehq/plugin-vite` bundles the SDK into your plugin output, so the hooks ship inside your bundle. The host import map serves only React specifiers — it has no `@daintreehq/plugin-sdk/react` entry — so a raw, un-bundled `plugin://` view that bare-imports this subpath fails at runtime with an unresolved specifier. For hand-authored views without the build preset, use the `window.electron.plugin` bridge directly ([Raw ESM views](#raw-esm-views--windowelectronplugin) below) — it is exactly what these hooks wrap.

```ts
import { useHostChannel, usePluginEvent } from "@daintreehq/plugin-sdk/react";
```

### `useHostChannel` — request/response (the pull half)

```ts
const { invoke, loading, error } = useHostChannel<SyncArgs, SyncResult>(pluginId, "sync-now");

// later, e.g. in a click handler:
const result = await invoke({ team: "engineering" });
```

`useHostChannel(pluginId, channel)` binds a single-flight `invoke(args)` to your plugin's `registerHandler(channel, …)`. It resolves with the validated channel result on success, or `undefined` when the host rejected the call (the rejection surfaces on `error`, never throws out of `invoke`). `loading` reflects the latest call only; if you fire a second `invoke` before the first resolves, the stale earlier call is dropped so concurrent invocations stay coherent. When the typed `registerHandler` overload rejects with a `SCHEMA_ERROR:` / `PERMISSION_REQUIRED:` prefix, that surfaces on `error` for the renderer to discriminate.

### `usePluginEvent` — subscription (the push half)

```ts
usePluginEvent<BuildStatus>(pluginId, "build-status", (status) => {
  setBuildStatus(status);
});
```

`usePluginEvent(pluginId, channel, handler)` subscribes over `window.electron.plugin.on` to every payload your `main` pushes via `host.postToPanel(channel, payload)` (or a one-shot `broadcastToRenderer` during activation). The handler is kept ref-stable, so passing an inline closure does not re-subscribe on every render; the subscription is torn down automatically on unmount. Payloads arrive untyped over IPC — `TPayload` narrows the call site, the hook does no runtime validation (the plugin owns the shape it pushes, mirroring `useHostChannel`'s host-owns-validation contract).

Together these are the two halves of the panel ↔ main channel: `useHostChannel` pulls on demand, `usePluginEvent` receives pushes. Both follow standard React rules — call them at the top of a component, never conditionally.

### Raw ESM views — `window.electron.plugin`

A hand-authored `plugin://` view that doesn't go through `@daintreehq/plugin-vite` can't bare-import `@daintreehq/plugin-sdk/react` (the host import map doesn't serve it). Use the host bridge directly — it is the same transport the hooks above wrap.

```ts
// Subscription (the push half) — mirrors usePluginEvent. Returns a () => void
// disposer; wire it into a useEffect cleanup so the listener is torn down on unmount.
const off = window.electron.plugin.on(pluginId, "build-status", (status) => {
  setBuildStatus(status as BuildStatus);
});
// later: off();

// Request/response (the pull half) — mirrors useHostChannel's invoke().
const result = await window.electron.plugin.invoke(pluginId, "sync-now", { team: "engineering" });
```

`window.electron.plugin.on(pluginId, channel, callback)` subscribes to every payload your `main` pushes via `host.postToPanel(channel, payload)` (or a one-shot `broadcastToRenderer` during activation) and returns a `() => void` disposer. `window.electron.plugin.invoke(pluginId, channel, ...args)` calls your `registerHandler(channel, …)` and resolves with its result. Payloads and results arrive untyped over IPC — cast at the call site (the bundled hooks do the same; the plugin owns the shape it pushes). Prefer the hooks when you bundle with `@daintreehq/plugin-vite`; reach for this bridge only when authoring a raw ESM module.

## Disposables

Anything that takes a callback and returns a cleanup function follows the VS Code-style Disposable pattern. You can safely ignore the return value — the plugin's disposal cascade cleans everything up on unload. If you need explicit control (e.g., unsubscribe from a worktree change listener after a one-shot reaction), keep the reference and call it.

See [Architecture → Lifecycle](./architecture.md#lifecycle) for how disposal works internally.

## What's not exposed

Deliberately not part of the host API:

- Direct access to other plugins' state or registered handlers.
- Access to the active user's AI-provider API keys. If a plugin needs AI calls, the user configures keys separately in settings or the plugin ships its own `secret` setting.
- Control of the active AI agent's runtime — driving, pausing, or reading an agent session, and bridging plugin MCP into a driven agent. These are decision-gated (D1/rule #4100); see [the freeze plan](./freeze-plan.md). The sanctioned path is `dispatch` into existing actions.
- An inbound webhook / host-side HTTP fetch surface for receiving external callbacks. Deferred pending a decision; see [the freeze plan](./freeze-plan.md).
- Raw Electron main-process APIs are not _passed through_ the host — but the contained, audited equivalents are: `host.process` (managed child processes, gated on `shell:exec`), `host.fs` (scope-contained filesystem), and `host.git` (worktree-scoped git). You can still `import` Node modules directly in plugin code; the host doesn't intercept that until the sandbox decision (D3), so the host-mediated surfaces are the contained, audited path, not a seal on the in-process one.
- Daintree's internal event bus. Only the specific subscriptions listed above are exposed. Broad event access would tie plugins to internal shape changes we want to be free to make.

If you have a legitimate need that isn't covered, open an issue with the use case.

## Module cache and memory

Production plugins are loaded by `import()`-ing the plugin's main module into Daintree's main process — in-process, not in an isolated worker. Node's ESM module cache is keyed by the module's file URL and is never evicted within a process lifetime, and Daintree does not bust that cache on unload. This is an accepted limitation for 1.0; the behavior below is the contract, not a bug.

When a plugin is unloaded (uninstall, disable, or hot reload), the host runs the full disposal cascade: every registration is torn down — IPC handlers, actions, forge and file-decoration providers, worktree subscriptions, and the cleanup function your `activate()` returned. What it cannot do is evict the plugin module from V8's module cache. The module's namespace object, and any state held in module-scope (top-level `let`/`const` bindings, singletons constructed at import time, timers or connections opened outside `activate()`), stay resident in the main-process heap for the rest of the session.

Two consequences follow for production plugins:

- **No hot reload.** Re-importing the same file URL returns the cached module rather than re-evaluating it, so editing an installed plugin's code has no effect until Daintree restarts. Put all teardown-able work inside `activate()` and its returned cleanup; never rely on module-scope re-initialization between loads.
- **Module-scope state persists across load/unload cycles.** If a plugin is unloaded and re-loaded in the same session, module-level variables retain their prior values and static-init memory is not reclaimed. Treat module scope as process-lifetime state and keep per-activation state inside `activate()`.

Dev-mode plugins (`daintree-plugin dev`) are exempt: they run in a separate `utilityProcess.fork` child, so each reload gets a fresh module cache and module-scope state never leaks across reloads. Hot reload works in dev for exactly this reason. The limitation above applies only to installed production plugins running in-process.
