# Host API

The host API is the runtime surface a plugin's `activate` function receives. It exposes Daintree's state and lets plugins register dynamic behavior beyond what's declared in the manifest.

The canonical import source is `@daintreehq/plugin-sdk`. Types referenced here live in that package.

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
  registerHandler(channel: string, handler: PluginIpcHandler): void;
  broadcastToRenderer(channel: string, payload: unknown): void;

  // Worktree observation
  getActiveWorktree(): Promise<PluginWorktreeSnapshot | null>;
  getWorktrees(): Promise<PluginWorktreeSnapshot[]>;
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void
  ): () => void;
  onDidChangeWorktrees(callback: (snapshots: PluginWorktreeSnapshot[]) => void): () => void;

  // Settings (planned)
  settings: SettingsApi;

  // UI helpers
  showToast(options: ToastOptions): Promise<void>;
}
```

The authoritative definition is in `shared/types/plugin.ts` in the Daintree repo.

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
// renderer side (in a view component)
import { useHostChannel } from "@daintreehq/plugin-sdk/react";

const invoke = useHostChannel();
const result = await invoke("sync-now", {});
```

**Channel naming rules:**

- No colons (reserved for Daintree's internal namespacing).
- Plugin-registered channels are addressed as `{pluginId}:{channel}` internally; the SDK handles the prefix.

Handlers are unregistered on plugin unload.

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
  readonly issueNumber?: number;
  readonly issueTitle?: string;
  readonly prNumber?: number;
  readonly prUrl?: string;
  readonly prState?: "open" | "merged" | "closed";
  readonly prTitle?: string;
  readonly mood?: "stable" | "active" | "stale" | "error";
  readonly lastActivityTimestamp?: number | null;
  readonly createdAt?: number;
}
```

All snapshots are frozen — attempting to mutate one throws. Fields are an explicit allowlist; adding a new field requires a Daintree SDK release.

Subscriptions registered during `activate` — before Daintree's worktree service is ready — are queued and replayed once the service comes online. Your callback never misses events.

## `settings` — _Planned_

Reads and subscribes to plugin-declared settings.

```ts
// Current value
const token = await host.settings.get<string>("linear.apiToken");

// Update (user scope usually not writable from plugin code)
await host.settings.set("linear.defaultTeam", "engineering");

// Subscribe to changes
const dispose = host.settings.onDidChange("linear.apiToken", (newValue) => {
  reconnect(newValue);
});
```

Scope resolution: `project` scope reads from the active project's config; if no project is active, returns undefined. `user` scope reads from Daintree's global config.

Secret-type settings are stored in the OS keychain via `keytar`. They're returned from `get()` transparently but never logged or included in error reports.

## `showToast`

```ts
await host.showToast({
  title: "Synced",
  description: "Fetched 12 issues from Linear",
  type: "success", // "info" | "success" | "warning" | "error"
  durationMs: 4000,
});
```

Toasts render in Daintree's standard toast container. There's no "sticky" or "action required" toast type — for persistent UI, register a panel view instead.

## React hooks — `@daintreehq/plugin-sdk/react`

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
