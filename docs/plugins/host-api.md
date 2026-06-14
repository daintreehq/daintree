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

  // Worktree observation
  getActiveWorktree(): Promise<PluginWorktreeSnapshot | null>;
  getWorktrees(): Promise<PluginWorktreeSnapshot[]>;
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
  dispatch(actionId: string, args?: unknown): Promise<ActionDispatchResult>;

  // Settings
  readonly settings: SettingsApi;

  // Diagnostics
  readonly logger: PluginLogger;

  // UI helpers
  showToast(options: PluginToastOptions): Promise<void>;
}
```

The authoritative definition is in `shared/types/plugin.ts` in the Daintree repo.

The revoke-guarded methods — `registerAction`, `registerHandler`, `broadcastToRenderer`, `registerForgeProvider`, `registerFileDecorationProvider`, `onDidChangeActiveWorktree`, `onDidChangeWorktrees`, and `settings.onDidChange` — must be called during `activate()` and throw once the host is revoked. Subscribing counts as an activation-window operation even though the callback fires later: register all your subscriptions during `activate()`, then react to them for the plugin's lifetime. `getActiveWorktree`, `getWorktrees`, `invalidateFileDecorations`, `showToast`, `dispatch`, `settings.get`/`settings.set`, and `logger` are deliberately NOT revoke-guarded: plugins call them from post-activation subscription callbacks and timers, so they stay callable for the plugin's lifetime and become a silent no-op after unload.

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
// renderer side (in a view component) — useHostChannel ships under the
// @daintreehq/plugin-sdk/react subpath, which is Planned (F15/F36) and has no
// exports in v1. See "React hooks" below.
import { useHostChannel } from "@daintreehq/plugin-sdk/react";

const invoke = useHostChannel();
const result = await invoke("sync-now", {});
```

**Channel naming rules:**

- No colons (reserved for Daintree's internal namespacing).
- Plugin-registered channels are addressed as `{pluginId}:{channel}` internally; the SDK handles the prefix.

Handlers are unregistered on plugin unload.

**Typed overload (preferred for new code):** pass a `PluginChannelSchema` with Zod `args`/`result` schemas and a `requires` capability list. The host rejects registration if any `requires` capability is missing from `manifest.capabilities` (fail-closed at the registration boundary). At dispatch, args are `safeParse`d before the handler runs and the result is `safeParse`d before returning to the renderer — schema failures throw with a `SCHEMA_ERROR:` prefix, missing capabilities throw with a `PERMISSION_REQUIRED:` prefix, and the renderer-side `useHostChannel` hook discriminates on those prefixes. The untyped overload above does no host-side validation and is retained only for plugins that haven't migrated to per-channel schemas.

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

All snapshots are frozen — attempting to mutate one throws. Fields are an explicit allowlist; adding a new field requires a Daintree SDK release.

Subscriptions registered during `activate` — before Daintree's worktree service is ready — are queued and replayed once the service comes online. Your callback never misses events.

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

**Storage:** values are stored as plaintext JSON at `~/.daintree/plugin-settings/{pluginId}.json` (user scope) or `<projectRoot>/.daintree/plugin-settings/{pluginId}.json` (project scope), with `chmod 0o600` applied on POSIX. There is deliberately no OS-keychain integration (#9167) — `secret`-typed settings are kept out of logs and error reports, but they are NOT encrypted at rest. Do not store secrets that must survive disk compromise.

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

## React hooks — `@daintreehq/plugin-sdk/react` — _Planned (F15/F36)_

The `@daintreehq/plugin-sdk/react` subpath is reserved for F15/F36 and ships no exports in v1. The hooks below describe the intended surface; the renderer implementations exist in Daintree's `src/hooks/` but are not yet wired into the SDK subpath. Do not import from this path in a v1 plugin — it resolves to an empty module.

Import path lives separately so non-view code doesn't pull React into the main-process bundle.

```ts
import {
  useWorktree,
  useWorktrees,
  useSetting,
  useHostChannel,
  useCommand,
} from "@daintreehq/plugin-sdk/react";
```

- `useWorktree()` — currently-active worktree as a reactive value. Re-renders on change.
- `useWorktrees()` — full worktree list.
- `useSetting<T>(id)` — reactive setting value with setter.
- `useHostChannel()` — returns an `invoke(channel, payload)` function bound to the plugin.
- `useCommand(id)` — returns a function that dispatches the given command.

Hooks follow standard React rules — call them at the top of a component, don't call conditionally.

## Disposables

Anything that takes a callback and returns a cleanup function follows the VS Code-style Disposable pattern. You can safely ignore the return value — the plugin's disposal cascade cleans everything up on unload. If you need explicit control (e.g., unsubscribe from a worktree change listener after a one-shot reaction), keep the reference and call it.

See [Architecture → Lifecycle](./architecture.md#lifecycle) for how disposal works internally.

## What's not exposed

Deliberately not part of the host API:

- Direct access to other plugins' state or registered handlers.
- Access to the active user's AI-provider API keys. If a plugin needs AI calls, the user configures keys separately in settings or the plugin ships its own `secret` setting.
- Direct Electron main-process APIs (fs, net, child_process). You can import Node modules normally in plugin code, but the host doesn't pass them through.
- Daintree's internal event bus. Only the specific subscriptions listed above are exposed. Broad event access would tie plugins to internal shape changes we want to be free to make.

If you have a legitimate need that isn't covered, open an issue with the use case.

## Module cache and memory

Production plugins are loaded by `import()`-ing the plugin's main module into Daintree's main process — in-process, not in an isolated worker. Node's ESM module cache is keyed by the module's file URL and is never evicted within a process lifetime, and Daintree does not bust that cache on unload. This is an accepted limitation for 1.0; the behavior below is the contract, not a bug.

When a plugin is unloaded (uninstall, disable, or hot reload), the host runs the full disposal cascade: every registration is torn down — IPC handlers, actions, forge and file-decoration providers, worktree subscriptions, and the cleanup function your `activate()` returned. What it cannot do is evict the plugin module from V8's module cache. The module's namespace object, and any state held in module-scope (top-level `let`/`const` bindings, singletons constructed at import time, timers or connections opened outside `activate()`), stay resident in the main-process heap for the rest of the session.

Two consequences follow for production plugins:

- **No hot reload.** Re-importing the same file URL returns the cached module rather than re-evaluating it, so editing an installed plugin's code has no effect until Daintree restarts. Put all teardown-able work inside `activate()` and its returned cleanup; never rely on module-scope re-initialization between loads.
- **Module-scope state persists across load/unload cycles.** If a plugin is unloaded and re-loaded in the same session, module-level variables retain their prior values and static-init memory is not reclaimed. Treat module scope as process-lifetime state and keep per-activation state inside `activate()`.

Dev-mode plugins (`daintree-plugin dev`) are exempt: they run in a separate `utilityProcess.fork` child, so each reload gets a fresh module cache and module-scope state never leaks across reloads. Hot reload works in dev for exactly this reason. The limitation above applies only to installed production plugins running in-process.
