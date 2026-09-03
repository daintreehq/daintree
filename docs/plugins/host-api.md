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

**Partial-activation rollback:** if `activate` throws after it has already registered some handlers, actions, or subscriptions, the host rolls all of them back automatically — the rollback is synchronous and host-owned, so you have no cleanup responsibility for a failed activation. A user-installed plugin gets the same guarantee from its worker being torn down on the failure. Don't try to undo your own registrations in a `catch` inside `activate`; just let the error propagate.

## `PluginHostApi`

```ts
interface PluginHostApi {
  readonly pluginId: string;

  // Action / command registration
  registerAction(descriptor: PluginActionContribution, handler: ActionHandler): Promise<void>;

  // IPC
  registerHandler<TArgs, TResult>(
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>
  ): Promise<void>;
  registerHandler(channel: string, handler: PluginIpcHandler): Promise<void>;
  broadcastToRenderer(channel: string, payload: unknown): Promise<void>;

  // Post-activation push into your panels
  postToPanel(channel: string, payload: unknown, panelId?: string | null): Promise<void>;

  // Worktree observation
  getActiveWorktree(): Promise<PluginWorktreeSnapshot | null>;
  getWorktrees(): Promise<PluginWorktreeSnapshot[]>;
  getWorktreesResult(): Promise<PluginWorktreesResult>;
  getWorktreeStatus(path: string): Promise<PluginWorktreeStatus | null>;
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void
  ): Promise<() => void>;
  onDidChangeWorktrees(
    callback: (snapshots: PluginWorktreeSnapshot[]) => void
  ): Promise<() => void>;

  // Agent observation — gated on the `agent:read` capability
  getAgentState(): Promise<PluginAgentSnapshot | null>;
  onDidChangeAgentState(callback: (snapshot: PluginAgentSnapshot) => void): Promise<() => void>;

  // Panel lifecycle for this plugin's own contributed panels — no capability
  onDidChangePanelLifecycle(
    callback: (event: PluginPanelLifecycleEvent) => void
  ): Promise<() => void>;

  // Forge / file-decoration providers
  registerForgeProvider(
    descriptor: ForgeProviderDescriptor,
    impl: ForgeProviderImpl
  ): Promise<() => void>;
  registerFileDecorationProvider(
    descriptor: FileDecorationProviderDescriptor,
    impl: FileDecorationProviderImpl
  ): Promise<() => void>;
  invalidateFileDecorations(scope: string, paths?: string[]): Promise<void>;

  // Panel title-chrome badge
  setPanelBadge(panelId: string, badge: PluginPanelBadge | null): Promise<void>;

  // Action dispatch + catalog
  dispatch(actionId: ActionId, args?: unknown): Promise<ActionDispatchResult>;
  readonly actions: PluginHostActionsApi;

  // Agent input — gated on the `agent:input` capability
  sendToActiveAgent(text: string, options?: { submit?: boolean }): Promise<void>;

  // Settings (user-facing, schema-declared) + private storage (machine-owned)
  readonly settings: SettingsApi;
  readonly storage: StorageApi;

  // Diagnostics
  readonly logger: PluginLogger;

  // UI helpers
  showToast(options: PluginToastOptions): Promise<void>;
  showQuickPick(
    items: PluginQuickPickItem[],
    options?: PluginQuickPickOptions
  ): Promise<PluginQuickPickItem | PluginQuickPickItem[] | undefined>;
  showInputBox(options?: PluginInputBoxOptions): Promise<string | undefined>;
  showConfirm(options: PluginConfirmOptions): Promise<boolean>;

  // Managed child processes — gated on the `shell:exec` capability
  readonly process: PluginProcessApi;

  // Host-mediated, scope-contained filesystem and git
  readonly fs: PluginFsApi;
  readonly git: PluginGitApi;

  // Host-mediated OS clipboard — gated on `clipboard:read` / `clipboard:write`
  readonly clipboard: PluginClipboardApi;
  // Open / reveal a file in the plugin's own declared fs scope
  readonly system: PluginSystemApi;
}
```

The authoritative definition is in `shared/types/plugin.ts` in the Daintree repo.

Nearly every host method now returns a Promise — the API became fully async in the move to the out-of-process worker model, so `registerAction`, `postToPanel`, `setPanelBadge`, and the rest resolve `Promise<void>`, and the subscription methods resolve `Promise<() => void>`. Always `await` a registration before assuming it took effect, and `await` the subscription methods to get the disposer. The synchronous `logger` accessor is the lone exception — its `info`/`warn`/`error` calls return `void`.

The revoke-guarded methods — `registerAction`, `registerHandler`, `broadcastToRenderer`, `registerForgeProvider`, `registerFileDecorationProvider`, `onDidChangeActiveWorktree`, `onDidChangeWorktrees`, `onDidChangeAgentState`, `onDidChangePanelLifecycle`, and `settings.onDidChange` — must be called during `activate()` and throw once the host is revoked. Subscribing counts as an activation-window operation even though the callback fires later: register all your subscriptions during `activate()`, then react to them for the plugin's lifetime. `postToPanel`, `setPanelBadge`, `getActiveWorktree`, `getWorktrees`, `getWorktreeStatus`, `getAgentState`, `invalidateFileDecorations`, `showToast`, `dispatch`, `sendToActiveAgent`, `process.spawn`, `fs.*`, `git.*`, `settings.get`/`settings.set`, and `logger` are deliberately NOT revoke-guarded: plugins call them from post-activation subscription callbacks and timers, so they stay callable for the plugin's lifetime and become a silent no-op (or, for `process.spawn`/`fs.*`/`git.*`, a rejection) after unload. This split is the load-bearing distinction between the activation-window registration surface and the live runtime surface — `postToPanel` is the canonical post-activation push: a plugin's `activate()` subscribes once (revoke-guarded `registerHandler`/worktree subscriptions), then streams live data into its panels with `postToPanel` for the rest of its lifetime.

**Where validation errors surface.** The two groups report errors differently. A revoke-guarded activation-window method (`registerAction`, `registerHandler`, the subscriptions) throws synchronously at the call site on a bad descriptor or a revoked host — wrap the `activate()` body in `try`/`catch` if you want to handle it. The post-activation runtime-surface methods (`postToPanel`, `setPanelBadge`, `invalidateFileDecorations`, `broadcastToRenderer` on an invalid channel) instead reject the returned Promise rather than throwing synchronously, so handle their validation errors with `await` + `.catch()`:

```ts
await host.postToPanel("build-status", status).catch((err) => host.logger.error(String(err)));
```

A liveness no-op (the plugin already unloaded) still resolves cleanly — only a genuine validation error (empty channel, malformed badge shape) rejects.

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
): Promise<void>;
```

**Rules:**

- `descriptor.id` must NOT include the plugin prefix — Daintree adds it. The above registers as `acme.linear-planner.plan-from-issue` at runtime (assuming your plugin is `acme.linear-planner`).
- `descriptor.danger` accepts `"safe"` or `"confirm"`. `"restricted"` is reserved for Daintree's internal use and rejected.
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

`postToPanel` is the post-activation sibling of `broadcastToRenderer`: it fans out over the exact same `plugin:{pluginId}:{channel}` transport, but unlike the revoke-guarded activation broadcast it stays callable for the plugin's whole lifetime. Use `broadcastToRenderer` for a one-shot push during `activate()`; use `postToPanel` for everything pushed afterward (the common case). `channel` must be a non-empty string without colons — an invalid channel rejects the returned Promise so authoring mistakes surface loudly (catch it with `await … .catch()`). It is membership-gated, not revoke-guarded: once the plugin is unloaded it becomes a silent no-op. There is no delivery acknowledgement — it is fire-and-forget; a panel that isn't mounted simply doesn't receive the payload. This is the push half of the renderer SDK; the pull half is `useHostChannel` (request/response over `registerHandler`).

**Targeting a single panel instance.** `postToPanel(channel, payload, panelId?)` takes an optional third argument. Omit it (or pass `null`) to broadcast to every open instance of the panel kind — every renderer subscribed via `window.electron.plugin.on(pluginId, channel, …)` / `usePluginEvent` receives the payload. Pass a non-empty `panelId` string to target one instance: only the renderer subscribed via `window.electron.plugin.onPanel(pluginId, channel, panelId, …)` (or the SDK's `usePluginPanelEvent`) receives it, so two open instances of the same panel kind no longer both get every push. An empty-string `panelId` is rejected. Inside a bundled view, `usePluginEvent` already filters to its own `panelId` automatically; the raw `plugin.onPanel(pluginId, channel, panelId, callback)` bridge requires you to pass the `panelId` explicitly.

## Worktree observation

Read-only access to Daintree's worktree state, allowlisted to prevent internal shape changes from leaking to plugins.

```ts
// Snapshot of the currently-active worktree, or null
const active = await host.getActiveWorktree();
if (active) {
  console.log(active.name, active.branch, active.path);
}

// All worktrees in the project the plugin is acting on behalf of — the one
// shown in the focused window. Empty when no window resolves (#11297).
const all = await host.getWorktrees();

// Subscribe to changes (await the disposer — the subscription methods are async)
const dispose = await host.onDidChangeActiveWorktree((snapshot) => {
  if (snapshot) console.log(`Active worktree changed: ${snapshot.name}`);
});

// Later: dispose() to unsubscribe (automatic on plugin unload)
```

### Telling "unavailable" from "empty"

`getWorktrees()` answers `[]` for seven different situations, and `getActiveWorktree()` answers `null` for the same set: the plugin is unloading, no workspace client is wired, no window scope resolves, the host's binding names a project with no root, the bound project has closed, the read failed — and, legitimately, the project genuinely has no worktrees. That sentinel is deliberate and stays: it fails closed, so a plugin never receives some other project's worktrees by accident (#11297, #9492). But it means a plugin cannot tell an unavailable answer from an authoritative empty one, and a validator that treats "my worktree isn't in this list" as "my worktree is gone" will fire spuriously during a project switch or after the machine wakes.

`getWorktreesResult()` is the same read with that ambiguity removed (#12174):

```ts
type PluginWorktreesResult =
  | { status: "ok"; projectId: string; worktrees: PluginWorktreeSnapshot[] }
  | { status: "unavailable"; reason: PluginWorktreesUnavailableReason };

type PluginWorktreesUnavailableReason =
  | "plugin-unloaded" // unloaded, or replaced by a same-id reload, mid-read
  | "workspace-unavailable" // no workspace client yet, or the host missed its readiness gate
  | "scope-unresolved" // an app-global plugin found no focused project view
  | "project-unavailable" // a bound host's project has no root, or has closed
  | "fetch-failed"; // a live host was asked and the read threw
```

`status: "ok"` is the only authoritative answer, and it names the project it describes. That second half matters as much as the first: an app-global (unbound) plugin reads whichever project is focused, and mid-switch that can still be the *outgoing* project — so a populated list that omits the worktree you are looking for may simply belong to a different project rather than confirm a mismatch. Compare `projectId` before drawing any conclusion from the contents.

Guard a binding validator like this:

```ts
const result = await host.getWorktreesResult();

// No answer — keep whatever you cached and try again later. Do not diagnose.
if (result.status !== "ok") return;

// A valid answer, but about a different project than the one you care about.
if (result.projectId !== storedProjectId) return;

const match = result.worktrees.find((w) => w.worktreeId === storedWorktreeId);
if (!match) {
  // Only now is the absence authoritative.
}
```

Like `getWorktrees()`, this never throws: once the plugin unloads it degrades to `{ status: "unavailable", reason: "plugin-unloaded" }`. `getWorktrees()` and `getActiveWorktree()` are unchanged and remain the right call when a missing worktree is not load-bearing.

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

`lastActivityTimestamp` is the canonical worktree activity time in milliseconds since the Unix epoch: the newer of HEAD's committer time and the newest currently dirty file's modification time. Invalid and future timestamps are ignored, and the field is `null` when neither source has a valid time.

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

## `onDidChangePanelLifecycle`

Observe what happens to your plugin's own panel instances. No capability is required — the host resolves panel ownership from its own kind registry, so you only ever receive events for kinds your plugin contributed.

```ts
export async function activate(host: PluginHostApi) {
  const servers = new Map<string, DevServer>();

  await host.onDidChangePanelLifecycle((event) => {
    if (event.phase === "removed") {
      servers.get(event.panelId)?.stop();
      servers.delete(event.panelId);
    }
  });
}
```

| Phase | Meaning |
| --- | --- |
| `mounted` | A view for this panel is rendered. |
| `hidden` | The panel record is live but no view is mounted — a sibling pane was maximized, its dock tab is inactive, its project view is cached, or a retry is loading. **Not** a close. |
| `backgrounded` | The panel is at `location: "background"`. |
| `trashed` | Soft close. Recoverable from the trash bin, so it is not permanent disposal. |
| `restored` | One-shot edge out of the trash, emitted immediately before the phase the panel landed in. |
| `removed` | Terminal. The panel is gone and will not return under this id. |
| `render-failed` | The current view attempt hit the host's error boundary. Cleared by a successful retry. The failure detail stays in the renderer's diagnostics pane; only the fact of failure reaches you. |

**This is where durable resources belong.** A view's `disposeSignal` aborts for a temporary unmount exactly as it does for a permanent close, so a plugin that treats it as deletion tears down work the user still wants back. Keep spawned processes and long-lived sessions in the worker, keyed by `panelId`, and release them on `"removed"`.

On subscribe the host **replays the current phase of every live panel** of your plugin. That matters because plugins activate lazily — opening a view is usually what triggers `activate()`, so without replay you would never see that panel's `mounted`. One-shot transitions (`restored`) and terminal ones (`removed`) are not replayed.

A renderer being destroyed or evicted never synthesizes `removed`: a cached project view says nothing about whether the user closed the panel, and a false terminal event is the exact misreading this API exists to prevent.

Like the other `onDidChange*` methods this is revoke-guarded — subscribe during `activate()`. Events themselves fire for the plugin's whole lifetime and fall silent after unload. Events are frozen before delivery.

## `registerForgeProvider`

Binds a runtime `ForgeProviderImpl` to a descriptor declared in `contributes.forgeProviders`.

```ts
const dispose = await host.registerForgeProvider({ id: "linear", name: "Linear" }, impl);
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
const dispose = await host.registerFileDecorationProvider({ id: "linear-status" }, impl);

// Later, from a subscription callback or timer. `scope` must match one of the
// provider's manifest-declared `scopes` (e.g. "worktree-diff:*"):
await host.invalidateFileDecorations("worktree-diff:main", ["src/foo.ts"]);
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

## `actions` — built-in action catalog

Discover what `dispatch` accepts and pre-flight a call, instead of hardcoding action ids and hoping. Projects Daintree's `ActionService` manifest to plugins.

```ts
const all = await host.actions.list(); // every dispatchable action (slim entries)
const entry = await host.actions.get("git.commit"); // single lookup, or null
if ((await host.actions.canDispatch("git.commit")) === "confirm") {
  // warn the user before dispatch triggers a confirm prompt
}
```

`list()` and `get(id)` mirror `ActionService.list()`/`get()`: `danger: "restricted"` actions are filtered out, so a plugin only ever sees `"safe"` or `"confirm"` entries (`get` returns `null` for an unknown or restricted id). `canDispatch(id)` returns `"ok"` for a safe action, `"confirm"` for one `dispatch` would reject with `CONFIRMATION_REQUIRED`, and `"restricted"` for an unknown or restricted id — use it to warn before you trigger a confirm dialog. `actions` is NOT revoke-guarded; after unload `list()` resolves `[]` and `get()` resolves `null`.

## `sendToActiveAgent` — inject text into the active agent

Send text to the currently-active agent terminal. Gated on the `agent:input` capability. This is the **sanctioned injection path** — the raw `terminal.sendCommand` action is closed to plugin dispatch, so plugins stop reinventing brittle `terminal.list` selection heuristics.

```ts
// Stage text for the user to review (default — no Enter appended):
await host.sendToActiveAgent("Summarize the failing test and propose a fix.");

// Run it immediately:
await host.sendToActiveAgent("/compact", { submit: true });
```

The host resolves the target itself, preferring the focused/visible agent terminal, then a `waiting` agent, then the most recently active agent terminal in the active project. `options.submit` defaults to `false` — the **stage-only**, default-safe mode: the text is pasted into the agent's input for the user to review and submit, with no Enter appended. Pass `{ submit: true }` to append Enter and execute immediately.

First use raises a just-in-time consent prompt (like `shell:exec`); a granted consent covers later calls. `sendToActiveAgent` is NOT revoke-guarded — call it from timers and subscription callbacks — but it becomes a no-op once the plugin is unloaded. It throws `PERMISSION_REQUIRED:` if the plugin did not declare `agent:input` or the user denies consent, and `NO_ACTIVE_AGENT:` if no agent terminal is available to receive the input.

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

// Subscribe to changes (await the disposer)
const dispose = await host.settings.onDidChange("linear.apiToken", (newValue) => {
  reconnect(newValue);
});
```

Scope defaults to `"user"`. `project` scope resolves the active project at call time, so it tracks project switches: `get` returns `undefined` and `set` throws when no project is active. `set` rejects `undefined` and non-JSON-serializable values; when the manifest declares `contributes.settings`, an undeclared key is rejected. `onDidChange` fires only on in-process writes — edits made to the JSON file by other processes don't fire until the plugin reloads.

**Storage:** values are stored as JSON at `~/.daintree/plugin-settings/{pluginId}.json` (user scope) or `<projectRoot>/.daintree/plugin-settings/{pluginId}.json` (project scope), with `chmod 0o600` applied on POSIX. `secret`-typed settings (#9167) are encrypted at rest through the OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret-kwallet via Electron `safeStorage`) by default — the value is persisted as a tagged ciphertext envelope, and the `host.settings.get`/`set` API shape is unchanged (encryption is transparent to your plugin). When no keychain is available (e.g. a headless Linux box without a secret service), `secret` settings fall back to plaintext and the settings UI says so honestly. Non-secret settings are stored as plaintext JSON. Don't rely on the plaintext fallback for secrets that must survive disk compromise on an unconfigured host.

## `storage` — private key/value storage

The machine-owned counterpart to `settings`: persist a plugin's own working state without declaring every key in `contributes.settings` and without it surfacing in the settings UI.

```ts
await host.storage.set("lastSyncCursor", cursor); // scope defaults to "user"
const cursor = await host.storage.get<string>("lastSyncCursor");
await host.storage.delete("lastSyncCursor");

// Per-worktree state that tracks the active worktree:
await host.storage.set("draft", text, "worktree");
```

Three scopes — `"user"` (default), `"project"`, `"worktree"` — stored as plaintext JSON at `~/.daintree/plugin-storage/{pluginId}.json`, `<projectRoot>/.daintree/plugin-storage/{pluginId}.json`, or `<worktreePath>/.daintree/plugin-storage/{pluginId}.json` (`chmod 0o600` on POSIX). **No secret encryption — never store credentials here** (use a `type: "secret"` setting for those). The `"project"` / `"worktree"` scopes resolve the active project / worktree at call time: `get` and `delete` are a no-op (returning `undefined` / void) and `set` throws when no project / worktree is active. `set` rejects `undefined` and non-JSON-serializable values. `onDidChange(key, cb, scope?)` fires on in-process writes only and is the one revoke-guarded member — subscribe during `activate()`. The rest of `storage` is NOT revoke-guarded.

**Reads stay fresh across a scope switch.** Storage is read through a per-path cache, but the host keeps it coherent for you. When the active worktree changes, the host invalidates the cache for `"worktree"`-scoped entries, so the next `get` reads the new worktree's file rather than a stale value. `"project"` scope is implicitly fresh — a different project resolves to a different file path, hence a different cache entry — and `"user"` scope is process-global and never evicted. You never have to manage cache invalidation yourself.

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
  env: { PORT: "5173" }, // added to a minimal allowlist, NOT the host environment
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

The returned `PluginProcessHandle` carries `id`, `kill()` (clean `SIGTERM`, then `SIGKILL` after a grace period), `restart()` (respawns with the same command/args/cwd/env, reusing the id and bumping a restart counter), and `onExit`/`onCrash` lifecycle subscriptions carrying the real exit code/signal — `onCrash` fires only on an unexpected (non-zero / signalled) exit you did not request. The child's stdout/stderr stream to your panels over `postToPanel("process", …)` keyed by the handle id; subscribe with `plugin.on(pluginId, "process")` in your view and discriminate on the event `kind` (`stdout` / `stderr` / `exit` / `crash`, or `data` for the single merged stream a `"pty"` child produces).

### Modes

`spawn` takes a `mode` that decides how the child's three stdio streams are wired. The returned handle's shape follows from it, so TypeScript gives you exactly the operations the backend can actually perform:

| `mode`             | stdin    | stdout / stderr                   | Handle adds           |
| ------------------ | -------- | --------------------------------- | --------------------- |
| `"pipe"` (default) | closed   | separate                          | —                     |
| `"duplex"`         | writable | separate                          | `write()`             |
| `"pty"`            | writable | **merged** into one `data` stream | `write()`, `resize()` |

Use `"duplex"` to drive a child that speaks a protocol over stdio — an MCP, LSP or ACP server, or anything else carrying JSON-RPC. Those need both a writable stdin _and_ a stdout the child's stderr diagnostics are not mixed into, which is exactly what `"pty"` cannot give you: a pseudo-terminal merges the two streams by construction.

The host is framing-agnostic — it moves bytes, you delimit messages. MCP and ACP use newline-delimited JSON; LSP uses `Content-Length` headers. The example below is NDJSON.

```ts
const rpc = await host.process.spawn("codex", {
  mode: "duplex",
  args: ["app-server", "--stdio"],
});

// onData hands you RAW chunks — the host does no framing, so a chunk may split
// or coalesce protocol messages. Buffer and split on the delimiter yourself.
let buffer = "";
rpc.onData(({ stream, chunk }) => {
  if (stream !== "stdout") return; // stderr stays separate — log it, don't parse it
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line) handleMessage(JSON.parse(line));
  }
});

// write() is verbatim and fire-and-forget: you supply the terminator, and it is
// a no-op (never a throw) once the process has exited.
rpc.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
```

`resize()` exists only on a `"pty"` handle — a duplex child has no terminal to resize.

`write()` is fire-and-forget: it queues on the child's stdin and does not report backpressure, which suits the low-volume control-plane traffic this is built for. Don't stream bulk data through it — if you write faster than the child reads, that buffer grows unboundedly.

One caveat inherited from the pipe-mode streaming path: output still in flight when the child exits can be dropped, because the handle settles on the process's `exit` rather than on its streams closing. That's a non-issue for a long-lived server you shut down yourself, but a one-shot command that writes its final reply and immediately exits may have that reply lost — don't build a request/response round trip on a child that exits to signal completion.

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

**Honest scope note:** `host.fs` gates the host-mediated path only. Your `main` is still un-sandboxed Node code (it runs in the plugin worker with full filesystem privileges) and can call raw `node:fs` directly, which the host cannot intercept until the sandbox/trust model changes (D3). `host.fs` gives a contained, audited path; it does not seal the un-mediated one.

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

`host.git` is scoped to a worktree your plugin may access — the `worktreePath` must resolve inside your `scopes.fs.allowedPaths` (same realpath containment as `host.fs`). It is implemented over Daintree's existing hardened git layer, not a reinvented one. Reads (`status`, `diff`) gate on `git:read`; mutations (`add`, `commit`) on `git:write` (and `commit` additionally requires `git:read`, since it returns the staged diff as its preview). Any pathspec you pass to `add` or `diff` must be **worktree-relative** — an absolute path, a `..` segment, or `:`-prefixed git pathspec magic is rejected with a `PATH_NOT_ALLOWED:` error, because git would otherwise resolve those against the whole repository and escape the contained worktree. Paths are also matched **literally, not as globs**: the hardened git layer runs with `GIT_LITERAL_PATHSPECS`, so `src/*.ts` selects a file named exactly `src/*.ts` rather than expanding, and a legal filename containing `*`, `?`, or `[...]` (a Next.js route like `pages/[...slug].tsx`) resolves to itself instead of to whatever its wildmatch pattern happens to hit. Pass concrete paths and expand any pattern yourself — for example by filtering the entries `status` already returns. `commit` enforces the **change-preview safeguard at the host layer** (incident #7880 / destructive-action tier D2): it refuses without an explicit non-empty `message` — there is no silent fallback to a derived commit message — and it computes the real staged diff as a preview before mutating, returned on the result so your UI can surface it. Mutations are recorded in the audit trail. `host.git` is NOT revoke-guarded.

## `clipboard` — host-mediated OS clipboard

Read and write the OS clipboard, gated on `clipboard:read` / `clipboard:write`. Runs in the main process, so it works from a headless plugin (no renderer or focused document required).

```ts
await host.clipboard.writeText("acme.linear-planner synced 12 issues"); // clipboard:write
await host.clipboard.writeImage(pngBytes); // clipboard:write
const text = await host.clipboard.readText(); // clipboard:read
```

`writeText` rejects with a `PAYLOAD_TOO_LARGE:` prefix when the text exceeds 8 MiB by UTF-8 byte count (mirroring the renderer IPC clipboard guard). `readText` resolves to `""` when the clipboard is empty or holds non-text content (image, file list) — it never rejects on content type. A call without the matching capability rejects with a `PERMISSION_REQUIRED:` error. `host.clipboard` is NOT revoke-guarded.

`writeImage` takes a `Uint8Array` of image bytes — PNG is the supported and tested input, though the underlying Electron decoder also accepts JPEG — and shares the `clipboard:write` token — putting an image on the clipboard is exactly as reversible as putting text there, so it needs no second capability and doesn't elevate your actions to `confirm`. It rejects with `PAYLOAD_TOO_LARGE:` above 20 MiB and `VALIDATION:` when the bytes don't decode to an image. Successful writes are audited by byte count (never the bytes). Decoding happens in the main process by necessity — a renderer-side `navigator.clipboard.write()` with binary PNG data crashes on Linux — so this is the supported path for image writes.

**Reads stay text-only.** There is no `readImage`/`readHtml`/`readFiles`: the read side is where richer payload types would let a plugin pull out more than it declared. Writes carry no such risk, since you already have the bytes.

## `system` — open and reveal files in your own scope

Hand a file to the OS default application, or reveal it in Finder/Explorer — scoped to your plugin's own filesystem roots.

```ts
const shot = `${dataDir}/screenshot.png`;
await host.system.showItemInFolder(shot); // reveal it, selected
await host.system.openPath(shot); // or open it in the default viewer
```

This exists because the built-in `system.openPath` action validates against the _user's_ roots — open projects, tracked worktrees, `userData` — and carries no caller identity, so dispatching it could never reach `~/.daintree/plugin-data/<plugin-id>/`, the one directory that is unambiguously yours. The workaround was shelling out to `/usr/bin/open`, trading a contained call for arbitrary execution.

Paths resolve against your declared `scopes.fs.allowedPaths` plus your implicit plugin-data namespace, with realpath containment (a symlink can't walk out of scope). Your plugin id is bound when the host is built rather than passed as an argument, so one plugin can never name another's namespace. Both methods are gated on the `fs:*` capability matching the resolved root's class — `fs:user-data-read` _or_ `fs:user-data-write` for the plugin-data namespace, `fs:project-*` for a project root — so a plugin that could legitimately create the file can always reveal it.

Errors carry prefixes: `PATH_NOT_ALLOWED:` for a path that is relative, unresolvable, traversing, or outside your scope (the same containment error `host.fs` raises); `INVALID_PATH:` for a path that resolves inside your scope but doesn't exist; `PERMISSION_REQUIRED:` for a missing capability; `PLUGIN_UNLOADED:` after unload. `openPath` additionally refuses executable file types (`.app`, `.exe`, `.sh`, …), checked on both the path you passed and its realpath target so a benignly-named symlink can't become a launch primitive; `showItemInFolder` has no such deny-list, since revealing a file shows it rather than running it. Successful calls are audited (rejected ones are not — nothing reached the OS). `host.system` is NOT revoke-guarded.

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

**Throwing listeners are quarantined.** A listener callback you pass to `onDidChangeAgentState`, `storage.onDidChange`, or `settings.onDidChange` runs inside the host's event dispatch. If it throws (synchronously or by rejecting), the host logs the failure with a running counter (`1/3`, `2/3`, …) and keeps the subscription alive. After three _consecutive_ failures it auto-unsubscribes the listener so a broken or adversarial callback can't spam the log forever. A single successful invocation resets the counter to zero, so a listener that fails only intermittently is never removed. Dispatch is fire-and-forget — a throw never propagates back into the host's own work or another plugin's listeners.

See [Architecture → Lifecycle](./architecture.md#lifecycle) for how disposal works internally.

## Testing against a mock host

`createMockHost` (in-repo at `shared/testing/createMockHost.ts`) returns a `PluginHostApi` that mirrors production validation and capability gating, so a unit test can run your `activate()` (and your handlers) against a faithful host and assert what it called. It validates the same things the real host does — `showToast` message/type/`durationMs` bounds, `setPanelBadge` shape, `postToPanel`/`broadcastToRenderer` channel format, and `showQuickPick` item arrays — so a malformed call fails the test the way it would fail in the app.

```ts
import { createMockHost } from "../../shared/testing/createMockHost";

const host = createMockHost({ capabilities: ["agent:read"], hasActiveAgent: false });
await activate(host);

// Recorded calls are exposed for assertions:
expect(host.registeredActions).toHaveLength(1);
expect(host.postToPanelCalls[0]).toMatchObject({ channel: "build-status" });

// Capability gating matches production: getAgentState needs `agent:read`,
// sendToActiveAgent needs `agent:input`.
await expect(host.sendToActiveAgent("hi")).rejects.toThrow(/PERMISSION_REQUIRED/);
```

Pass `capabilities` to restrict the declared capability set (the default is permissive — `agent:read` + `agent:input`) and assert the `PERMISSION_REQUIRED` rejection a plugin missing one would hit; pass `hasActiveAgent: false` to assert the `NO_ACTIVE_AGENT` rejection from `sendToActiveAgent`. The recording arrays (`registeredActions`, `registeredHandlers`, `postToPanelCalls`, `shownToasts`, `setPanelBadgeCalls`, `showQuickPickCalls`, and the rest) capture every host call in order.

## What's not exposed

Deliberately not part of the host API:

- Direct access to other plugins' state or registered handlers.
- Access to the active user's AI-provider API keys. If a plugin needs AI calls, the user configures keys separately in settings or the plugin ships its own `secret` setting.
- Full control of the active AI agent's runtime — driving, pausing, or reading back an agent session, and bridging plugin MCP into a driven agent — remains decision-gated (D1/rule #4100); see [the freeze plan](./freeze-plan.md). The one sanctioned exception is text injection: [`host.sendToActiveAgent`](#sendtoactiveagent--inject-text-into-the-active-agent) (gated on `agent:input`, JIT consent, stage-only by default) sends input to the active agent terminal. For everything else, `dispatch` into existing actions is the path.
- An inbound webhook / host-side HTTP fetch surface for receiving external callbacks. Deferred pending a decision; see [the freeze plan](./freeze-plan.md).
- Raw Electron main-process APIs are not _passed through_ the host — but the contained, audited equivalents are: `host.process` (managed child processes, gated on `shell:exec`), `host.fs` (scope-contained filesystem), and `host.git` (worktree-scoped git). You can still `import` Node modules directly in plugin code; the host doesn't intercept that until the sandbox decision (D3), so the host-mediated surfaces are the contained, audited path, not a seal on the in-process one.
- Daintree's internal event bus. Only the specific subscriptions listed above are exposed. Broad event access would tie plugins to internal shape changes we want to be free to make.

If you have a legitimate need that isn't covered, open an issue with the use case.

## Process model and memory

User-installed plugins — whether sideloaded, installed from a `.dntr` or URL, or `dev`-linked — run **out-of-process** in a `utilityProcess.fork` worker (#10526). Your `main` executes in a child process with its own module realm; the host bridges every `host.*` call and registration over a MessagePort. This is what makes teardown clean: when a plugin is unloaded (uninstall, disable, or dev reload), the host runs the full disposal cascade — IPC handlers, actions, forge and file-decoration providers, worktree subscriptions, and the cleanup function your `activate()` returned — and then **kills the worker**, so the plugin's entire module realm (module-scope `let`/`const` bindings, import-time singletons, stray timers or connections) is reclaimed. There is no ESM module-cache leak and no module-scope state surviving across a reload; dev hot-reload works for exactly this reason.

You should still keep teardown-able work inside `activate()` and its returned cleanup rather than module scope — that's the disposal contract — but you are not paying a per-reload memory penalty for getting it wrong, because the worker is discarded wholesale.

The one behavior to design around: **`registerForgeProvider` is a no-op out-of-process.** A forge provider's `parseRemote` and URL builders are synchronous and can't cross the async MessagePort, so forge providers are usable only by Daintree's **built-in** plugins — the exception to the worker model. Built-ins activate in-process via `import()` because they're trusted, app-bundled, and never unloaded. (An in-process built-in module is never evicted from V8's cache, but since built-ins are never uninstalled that residue is inert.) See [Architecture → Activation](./architecture.md#activation).
