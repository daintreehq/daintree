# Host API

The host API is the runtime surface a plugin's `activate` function receives. It exposes Daintree's state and lets plugins register dynamic behavior beyond what's declared in the manifest.

The canonical import source is `@daintreehq/plugin-sdk`. Types referenced here live in that package.

> `@daintreehq/plugin-sdk` is not yet published on npm, so the imports shown below won't resolve from the registry today. The package exists in-repo at `packages/plugin-sdk` (workspace-linked, so these imports build inside the Daintree repo) and re-exports the types from `shared/types/plugin-sdk.ts`. Outside the workspace, point your `tsconfig.json` `paths` at that directory, or import the types by relative path.

## Calling conventions

Every callback a plugin hands the host has a fixed shape, and the one for `registerHandler` is the one every first plugin gets wrong. The whole set, in one place:

| You register | Your function receives | Notes |
| --- | --- | --- |
| `registerAction(descriptor, handler)` | `(args)` | The dispatched args payload only. No `host`, no context; close over `host` from `activate()` if the handler needs it. |
| `registerHandler(channel, handler)` (untyped) | `(ctx, ...args)` | **Context first.** `ctx` is `{ projectId, worktreeId, webContentsId, pluginId }`; the arguments the view passed to `invoke(pluginId, channel, ...args)` follow it. Read the payload from the first parameter and you get the context object instead. |
| `registerHandler(channel, schema, handler)` (typed) | `(ctx, args)` | Same order; `args` is the single, schema-parsed payload. |
| `postToPanel(channel, payload)` | view: `on(pluginId, channel, cb)` receives `payload` | Broadcast. Subscriptions are keyed by plugin and channel only, so it reaches every `on` subscriber your plugin has on that channel, across all of its panel kinds. `usePluginEvent` in a bundled view. |
| `postToPanel(channel, payload, panelId)` | view: `onPanel(pluginId, channel, panelId, cb)` receives `payload` | One instance only, disjoint from the broadcast. `usePluginPanelEvent` in a bundled view. |
| `onDidChangeActiveWorktree`, `onDidChangeWorktrees`, `onDidChangeAgentState`, `onDidChangePanelLifecycle`, `onDidWake`, `settings.onDidChange`, `storage.onDidChange` | `(event)` | One frozen argument. A listener that throws three times in a row is unsubscribed. |
| Filesystem-convention command, `src/{id}.js` | `(args)` | Installed plugins only; a project plugin registers from `activate()` instead. |

An argument-less handler ignores both parameters and works whichever way it was written, which is why the bug in an argument-taking one hides: the panel looks healthy and only the buttons that pass something do nothing. If a handler's first parameter has a `webContentsId`, it is reading the context.

```ts
// Correct. `ctx` first, payload second.
await host.registerHandler("describe-file", async (ctx, args: unknown) => {
  const { path } = (args ?? {}) as { path?: string };
  if (!path) throw new Error("describe-file requires a path");
  return { path, projectId: ctx.projectId };
});

// Wrong. `args` is the context, so `path` is always undefined and this handler
// throws on every call — rejecting that one `invoke` and nothing else. Every
// argument-less channel keeps working, so the panel looks healthy.
await host.registerHandler("describe-file", async (args: unknown) => {
  const { path } = (args ?? {}) as { path?: string };
});
```

`plugins/sample-project/acme.tour/` is a working plugin built against the untyped-handler, action, and targeted-push rows.

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
  getWorktreeStatus(
    path: string,
    options?: PluginHostCallOptions
  ): Promise<PluginWorktreeStatus | null>;
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void
  ): Promise<() => void>;
  onDidChangeWorktrees(
    callback: (snapshots: PluginWorktreeSnapshot[]) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;

  // Agent observation — gated on the `agent:read` capability
  getAgentState(): Promise<PluginAgentSnapshot | null>;
  onDidChangeAgentState(callback: (snapshot: PluginAgentSnapshot) => void): Promise<() => void>;

  // Panel lifecycle for this plugin's own contributed panels — no capability
  onDidChangePanelLifecycle(
    callback: (event: PluginPanelLifecycleEvent) => void
  ): Promise<() => void>;

  // Machine resumed from sleep — no capability
  onDidWake(callback: (event: PluginSystemWakeEvent) => void): Promise<() => void>;

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

  // UI helpers — overloaded so `canSelectMany: true` types as an array
  showToast(options: PluginToastOptions): Promise<void>;
  showQuickPick(
    items: PluginQuickPickItem[],
    options: PluginQuickPickOptions & { canSelectMany: true }
  ): Promise<PluginQuickPickItem[] | undefined>;
  showQuickPick(
    items: PluginQuickPickItem[],
    options?: PluginQuickPickOptions
  ): Promise<PluginQuickPickItem | undefined>;
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

The authoritative definition is `PluginHostApi` in `shared/types/plugin.ts`, re-exported through `shared/types/plugin-sdk.ts`. The block above is a readable summary — where it disagrees with the type, the type wins.

Two option bags recur. `PluginHostCallOptions` is the trailing argument on long-running calls (`getWorktreeStatus`, `fs.*` except `writeFile`, all of `git.*`) and carries an optional `signal: AbortSignal` so a call whose consumer has gone away can be cancelled. `PluginHostSubscriptionOptions` is the trailing argument on `onDidChangeWorktrees` and carries `debounceMs`, which coalesces a burst into one trailing callback — the host re-emits the worktree set on every git-status poll, so a UI-updating plugin should almost always pass one. Values under ~50 ms are clamped up; `0` or omitted means fire on every change.

Nearly every host method now returns a Promise — the API became fully async in the move to the out-of-process worker model, so `registerAction`, `postToPanel`, `setPanelBadge`, and the rest resolve `Promise<void>`, and the subscription methods resolve `Promise<() => void>`. Always `await` a registration before assuming it took effect, and `await` the subscription methods to get the disposer. The synchronous `logger` accessor is the lone exception — its `info`/`warn`/`error` calls return `void`.

The revoke-guarded methods — `registerAction`, `registerHandler`, `broadcastToRenderer`, `registerForgeProvider`, `registerFileDecorationProvider`, `onDidChangeActiveWorktree`, `onDidChangeWorktrees`, `onDidChangeAgentState`, `onDidChangePanelLifecycle`, `onDidWake`, and `settings.onDidChange` — must be called during `activate()` and throw once the host is revoked. Subscribing counts as an activation-window operation even though the callback fires later: register all your subscriptions during `activate()`, then react to them for the plugin's lifetime. `postToPanel`, `setPanelBadge`, `getActiveWorktree`, `getWorktrees`, `getWorktreesResult`, `getWorktreeStatus`, `getAgentState`, `invalidateFileDecorations`, `showToast`, `showQuickPick`, `showInputBox`, `showConfirm`, `dispatch`, `actions.*`, `sendToActiveAgent`, `process.spawn`, `fs.*`, `git.*`, `clipboard.*`, `system.*`, `settings.get`/`settings.set`, `storage.get`/`set`/`delete`, and `logger` are deliberately NOT revoke-guarded: plugins call them from post-activation subscription callbacks and timers, so they stay callable for the plugin's lifetime and become a silent no-op (or, for `process.spawn`/`fs.*`/`git.*`, a rejection) after unload. This split is the load-bearing distinction between the activation-window registration surface and the live runtime surface — `postToPanel` is the canonical post-activation push: a plugin's `activate()` subscribes once (revoke-guarded `registerHandler`/worktree subscriptions), then streams live data into its panels with `postToPanel` for the rest of its lifetime.

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
// main side (in activate). The IPC context is the FIRST parameter; the
// view's payload is the second. `(opts) => …` would receive the context.
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

**Targeting a single panel instance.** `postToPanel(channel, payload, panelId?)` takes an optional third argument. Omit it (or pass `null`) to broadcast to every open instance of the panel kind — every renderer subscribed via `window.electron.plugin.on(pluginId, channel, …)` / `usePluginEvent` receives the payload. Pass a non-empty `panelId` string to target one instance: only the renderer subscribed via `window.electron.plugin.onPanel(pluginId, channel, panelId, …)` (or the SDK's `usePluginPanelEvent`) receives it, so two open instances of the same panel kind no longer both get every push. An empty-string `panelId` is rejected. `usePluginEvent` does **not** filter by `panelId` — it is the broadcast subscription, and it never receives a targeted push. Use `usePluginPanelEvent(pluginId, channel, panelId, cb)` (or the raw `plugin.onPanel(pluginId, channel, panelId, cb)`) with the `panelId` prop your view was handed. The two are disjoint: a broadcast reaches only `usePluginEvent` subscribers, a targeted push only `usePluginPanelEvent` ones.

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

`status: "ok"` is the only authoritative answer, and it names the project it describes. That second half matters as much as the first: an app-global (unbound) plugin reads whichever project is focused, and mid-switch that can still be the _outgoing_ project — so a populated list that omits the worktree you are looking for may simply belong to a different project rather than confirm a mismatch. Compare `projectId` before drawing any conclusion from the contents.

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

## Agent observation

Read the state of the agent session Daintree is watching. Gated on the `agent:read` capability — a plugin that didn't declare it gets a `PERMISSION_REQUIRED:` rejection.

```ts
export async function activate(host: PluginHostApi) {
  const current = await host.getAgentState(); // null when nothing has been observed yet

  await host.onDidChangeAgentState((snapshot) => {
    if (snapshot.state === "waiting") {
      void host.showToast({ message: `Agent is waiting: ${snapshot.waitingReason ?? "unknown"}` });
    }
  });
}
```

`PluginAgentSnapshot` is an explicit allowlist, frozen before delivery:

| Field | Notes |
| --- | --- |
| `agentId` | Stable session id, when the host could attribute the transition to one. Absent for detector-only flows that route by terminal. |
| `state` / `previousState` | `idle` \| `working` \| `waiting` \| `directing` \| `completed` \| `exited`. |
| `running` | Convenience flag — `true` while the session is doing in-flight work (`working` / `waiting` / `directing`). Derived from the host's own `ACTIVE_AGENT_STATES` set so you don't re-maintain the membership list. |
| `waitingReason` | Present only when `state === "waiting"`. |
| `sessionCost` / `sessionTokens` | Cumulative for the session. Present only on `completed` / `exited` transitions. |
| `timestamp` | Epoch milliseconds when the transition was committed. |

Two things this surface deliberately does **not** carry. It omits the internal routing ids (`terminalId`, `worktreeId`, `cwd`) and the detector internals (`trigger`, `confidence`, …): a plugin holding only `agent:read` has no declared capability reaching PTY or worktree internals, so exposing them here would let it cross-reference state it otherwise can't. And it is **observation only** — nothing here drives, pauses, or resumes a session.

**Treat the state as an observation, not a fact.** Agent state comes from passive PTY output heuristics and is frequently wrong. Surface what the host saw; don't build a control flow that assumes it.

`getAgentState` is NOT revoke-guarded (callable from timers, resolves `null` after unload); `onDidChangeAgentState` is — subscribe during `activate()`. A throwing listener is quarantined after three consecutive failures, as with every host subscription.

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

## `onDidWake`

Observe the machine waking from sleep. No capability is required — the event describes the machine's own suspend/resume timing and nothing about the workspace, the user, or any other plugin.

```ts
export async function activate(host: PluginHostApi) {
  await host.onDidWake(({ sleepDuration }) => {
    // Anything cached before the sleep is now suspect.
    void refreshIssueCache();
    // `0` means "unknown", so it must reauthenticate too — not be read as short.
    if (sleepDuration === 0 || sleepDuration > 60 * 60 * 1000) void reauthenticate();
  });
}
```

| Field | Meaning |
| --- | --- |
| `sleepDuration` | Milliseconds from the observed suspend to the start of the host's post-wake recovery, so it includes the settle delay but not however long recovery itself took — a coarse staleness figure, not a precise hardware sleep time. `0` is a sentinel meaning the matching suspend edge was never observed; treat it as _unknown_, not as a short sleep. |
| `timestamp` | `Date.now()` at the moment the wake was published. |

**This is the signal background work has no other way to get.** `onDidChangePanelLifecycle` gives a _view_ a re-validation point, but your timers, forge providers, and reconciliation passes keep running against state frozen at suspend. The host's own resume path only re-enables workspace polling if a window is focused, so a machine that wakes while Daintree is blurred — lid opened, user not back at the desk — leaves that state stale for an unbounded stretch with nothing else announcing the wake.

Delivered at most once per resume, after the host has attempted to resync its pty and workspace hosts, so re-reading worktree state from the callback is not racing the host's own recovery. That recovery is best-effort — the wake is announced even when part of it failed, because a half-recovered host is exactly when you need to revalidate. Rapid resumes coalesce into one delivery, and a re-suspend during the settle window cancels the wake outright rather than emitting a spurious one.

Nothing is replayed on subscribe: a wake is a one-shot pulse with no resting state. The event is machine-scoped, not project-scoped — every loaded instance of your plugin receives it, including one bound to a project whose window is not focused.

Like the other subscriptions this is revoke-guarded — subscribe during `activate()`. Events fire for the plugin's whole lifetime and fall silent after unload. Events are frozen before delivery.

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

## `setPanelBadge`

Put a small live badge on the title chrome of one of your plugin's panels — a status dot or a short label — so per-worktree or per-agent state surfaces without the user opening the panel.

```ts
await host.setPanelBadge(panelId, { kind: "dot", color: "warning", tooltip: "2 checks failing" });
await host.setPanelBadge(panelId, { kind: "label", text: "3", color: "error" });
await host.setPanelBadge(panelId, null); // clear
```

A badge is either `{ kind: "dot" }` or `{ kind: "label", text }`, each taking an optional `color` (`"default"` / `"success"` / `"warning"` / `"error"` — you pick intent, the theme picks the pixel) and an optional `tooltip`. Label text is capped host-side (`PLUGIN_PANEL_BADGE_LABEL_MAX`); a longer one rejects rather than being truncated.

Badges are keyed by `(pluginId, panelId)`, so two plugins never clobber each other's badge on the same panel, and all of a plugin's badges are cleared on unload. Not revoke-guarded — call it from timers and subscription callbacks; it becomes a silent no-op once the plugin unloads. An invalid `panelId` or badge shape rejects the returned Promise, so `await` it with a `.catch()` if you want the authoring mistake in your own logs.

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

## User prompts — `showQuickPick`, `showInputBox`, `showConfirm`

Three imperative dialogs, rendered through the app's own surfaces so they look and behave like the rest of Daintree. All three resolve rather than throw when the user backs out, and all three are post-activation-safe — call them from a command handler, a timer, or a subscription callback.

```ts
const pick = await host.showQuickPick(
  [
    { id: "LIN-1", label: "Fix the login redirect", description: "In Progress" },
    { id: "LIN-2", label: "Flaky checkout test", detail: "Assigned to you" },
  ],
  { title: "Plan which issue?", placeholder: "Search issues", matchOnDescription: true }
);
if (!pick) return; // user cancelled

const branch = await host.showInputBox({
  title: "Branch name",
  prompt: "Created from the selected issue.",
  value: `fix/${pick.id.toLowerCase()}`,
  validationPattern: "^[a-z0-9/._-]+$",
  validationMessage: "Lowercase, digits, and / . _ - only.",
});
if (branch === undefined) return;

if (
  await host.showConfirm({
    title: `Discard the draft on ${branch}?`,
    message: "The draft has unsaved edits. This cannot be undone.",
    confirmLabel: "Discard draft",
    destructive: true,
  })
) {
  // …
}
```

**`showQuickPick(items, options?)`** resolves the chosen `PluginQuickPickItem`, or `undefined` on cancel. Each item is `{ id, label, description?, detail? }` — plain strings so it survives the structured-clone boundary; `description` renders dimmed after the label, `detail` on a second muted line. `matchOnDescription` widens fuzzy matching beyond `label`. Passing `canSelectMany: true` changes the resolved value to an array, and the overloads type that for you.

**`showInputBox(options?)`** resolves the entered string, or `undefined` on cancel. `validationPattern` is a regex **source string** enforced client-side at submit time (no per-keystroke IPC); an invalid pattern is ignored rather than blocking the user, so test yours. `password: true` masks the field.

**`showConfirm(options)`** resolves `true` on confirm, `false` on cancel, dismiss, or the plugin unloading while the dialog is open. For anything irreversible set `destructive: true` and give `confirmLabel` a verb-noun (`"Delete file"`), never a bare `OK` — the label is the last thing the user reads before committing.

**Where the dialog appears.** A project-bound plugin's prompt is delivered into that project's view, so the user finds it when they switch to that project — never wherever focus happens to be. If the bound project has no live renderer the call rejects with `PROJECT_VIEW_UNAVAILABLE` rather than landing somewhere else. See [Project-local plugins → Binding](./project-local.md#binding--which-project-a-host-call-reaches).

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

`host.process` lets a process- or task-orchestrator plugin (dev server, CI runner, watcher) spawn and supervise real child processes instead of hijacking a user terminal. It is **capability-gated twice**: a `spawn` from a plugin that did not declare `shell:exec` rejects with a `PERMISSION_REQUIRED:` error, and the first spawn a plugin actually makes raises a [just-in-time consent dialog](./trust-model.md#2-host-side-policy-input-load-bearing) the user must approve — a denial rejects with the same prefix. A granted, pinned consent covers later spawns; built-in plugins skip the prompt. Concurrent first-use spawns coalesce onto one dialog rather than stacking. Argv is passed verbatim (no shell, so no shell-injection surface).

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

`host.fs` is a sanctioned, contained, audited filesystem path. Every argument is resolved against your declared `scopes.fs.allowedPaths` and realpath-contained to one of those roots — a `..` traversal or a symlink that escapes a root is rejected with a `PATH_NOT_ALLOWED:` error, mirroring the `plugin://` protocol handler's discipline. This is the **runtime enforcement of `scopes.fs.allowedPaths`** (previously advisory). Reads gate on `fs:project-read` / `fs:user-data-read`, writes on `fs:project-write` / `fs:user-data-write`; a missing capability rejects with a `PERMISSION_REQUIRED:` error. The first `writeFile` additionally raises a [just-in-time consent dialog](./trust-model.md#2-host-side-policy-input-load-bearing) — reads don't. Unlike the app's `files.read` IPC, `readFile` carries **no 500KB / binary cap** — it is a deliberate plugin API. Writes are recorded in the audit trail, and `watch` watchers are torn down on unload. `host.fs` is NOT revoke-guarded — call it from timers and subscription callbacks.

`readFile`, `readdir`, `stat`, and `watch` take a trailing options object carrying an optional `signal: AbortSignal`, so a read feeding a panel that has since unmounted can be cancelled — chain it off the view's `disposeSignal`. An already-aborted signal rejects before any I/O; aborting mid-flight rejects with the signal's reason. `writeFile` deliberately takes none: half-written files are not a state worth offering.

**Honest scope note:** `host.fs` gates the host-mediated path only. Your `main` is still un-sandboxed Node code (it runs in the plugin worker with full filesystem privileges) and can call raw `node:fs` directly, which the host cannot intercept without a real sandbox (see the [trust model](./trust-model.md)). `host.fs` gives a contained, audited path; it does not seal the un-mediated one.

### `readdir` and the detailed listing

`readdir` defaults to a bare directory read — one syscall, and each entry carries only `name` plus the three kind flags. That is the right cost when you are looking for a filename.

It is the wrong cost when you are _presenting_ files. Pass `{ detail: true }` and you get the same listing Daintree's own file browser renders:

```ts
const entries = await host.fs.readdir(projectRoot, { detail: true });
for (const entry of entries) {
  // entry.size, entry.mtimeMs, entry.symlink?.target, entry.symlink?.targetKind
}
```

What the detailed read adds beyond the flags:

| Field | Notes |
| --- | --- |
| `size` | Bytes. Omitted for directories, and for a symlink whose target could not be resolved — a link's own size is the byte length of the stored target string, which renders as a real but meaningless file size. |
| `mtimeMs` | Epoch milliseconds. A resolved symlink reports its **target's** time, because that is what opening the entry would give you. |
| `symlink` | Present only on links: `target` (absolute, resolved the way the kernel would) and `targetKind`. |
| ordering | Directories first, then a numeric-aware name collation — so `file2` sorts before `file10`, and ties break deterministically regardless of host locale. |

`targetKind` is one of `"file"`, `"directory"`, `"broken"`, `"external"`, `"unknown"`. `"external"` means the target resolves **outside the allowed root that contains the listed directory**, so the host will refuse to read it through that listing — the classification is scoped to what _your_ plugin may reach, not to some global notion of the workspace. It is conservative: a link into a _different_ one of your allowed roots also reads as `"external"`. It is kept distinct from `"unknown"` (a link loop, permission denied) so your UI never tells someone a link points out of scope when the truth is that it could not be read. `isDirectory` is true for a link only when `targetKind` is `"directory"`, so code routing on `isDirectory` alone stays correct and can ignore `symlink` entirely.

Reach for `{ detail: true }` rather than calling `stat` per entry: that costs one host round trip **per entry**, and it still would not reproduce the link classification or the ordering. Both paths apply identical containment and capability checks; `detail` changes what is read, never what is allowed.

Two things to know about the detailed path:

- **`symlink.target` is an absolute path and may point outside your scope.** That is the point of `targetKind: "external"` — it tells you the link leaves what you may read. The host will refuse to read it, but the pathname itself is visible, because it is the literal content of a link that sits inside your scope.
- **Errors read differently.** A plain read surfaces Node's own filesystem errors (`ENOTDIR`, `ENOENT`, with `err.code`); a detailed read surfaces the listing service's messages (`Path is not a directory: …`). The `PATH_NOT_ALLOWED:` and `PERMISSION_REQUIRED:` prefixes are unaffected — containment and capability are checked before either branch runs — so discriminating on those keeps working. Don't discriminate on `err.code` across both modes.

`createMockHost` honours `detail` too, supplying `size`, `mtimeMs` and the same ordering for its in-memory files — an in-memory filesystem has no links to classify, so `symlink` is never present there.

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

`host.git` is scoped to a worktree your plugin may access — the `worktreePath` must resolve inside your `scopes.fs.allowedPaths` (same realpath containment as `host.fs`). It is implemented over Daintree's existing hardened git layer, not a reinvented one. Reads (`status`, `diff`) gate on `git:read`; mutations (`add`, `commit`) on `git:write` (and `commit` additionally requires `git:read`, since it returns the staged diff as its preview), with a [just-in-time consent dialog](./trust-model.md#2-host-side-policy-input-load-bearing) on the plugin's first mutation. Every method takes a trailing options object with an optional `signal: AbortSignal` to cancel the call. Any pathspec you pass to `add` or `diff` must be **worktree-relative** — an absolute path, a `..` segment, or `:`-prefixed git pathspec magic is rejected with a `PATH_NOT_ALLOWED:` error, because git would otherwise resolve those against the whole repository and escape the contained worktree. Paths are also matched **literally, not as globs**: the hardened git layer runs with `GIT_LITERAL_PATHSPECS`, so `src/*.ts` selects a file named exactly `src/*.ts` rather than expanding, and a legal filename containing `*`, `?`, or `[...]` (a Next.js route like `pages/[...slug].tsx`) resolves to itself instead of to whatever its wildmatch pattern happens to hit. Pass concrete paths and expand any pattern yourself — for example by filtering the entries `status` already returns. `commit` enforces the **change-preview safeguard at the host layer** (incident #7880 / destructive-action tier D2): it refuses without an explicit non-empty `message` — there is no silent fallback to a derived commit message — and it computes the real staged diff as a preview before mutating, returned on the result so your UI can surface it. Mutations are recorded in the audit trail. `host.git` is NOT revoke-guarded.

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

The `@daintreehq/plugin-sdk/react` subpath carries the renderer hooks for plugin view components. It is a separate import path so non-view code (your `main`) doesn't pull React into the main-process bundle. The runtime implementations live in the SDK package itself (`packages/plugin-sdk/src/react/`) and Daintree's own `src/hooks/` re-exports them, so plugin authors and the host run one implementation rather than two that can drift.

**These hooks resolve only in a bundled view.** `@daintreehq/plugin-vite` bundles the SDK into your plugin output, so the hooks ship inside your bundle. The host import map serves only React specifiers — it has no `@daintreehq/plugin-sdk/react` entry — so a raw, un-bundled `plugin://` view that bare-imports this subpath fails at runtime with an unresolved specifier. For hand-authored views without the build preset, use the `window.electron.plugin` bridge directly ([Raw ESM views](#raw-esm-views--windowelectronplugin) below) — it is exactly what these hooks wrap.

```ts
import { useHostChannel, usePluginEvent, usePluginPanelEvent } from "@daintreehq/plugin-sdk/react";
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

### `usePluginPanelEvent` — subscription, one instance only

```ts
usePluginPanelEvent<BuildStatus>(pluginId, "build-status", panelId, (status) => {
  setBuildStatus(status);
});
```

The per-instance sibling of `usePluginEvent`, and the one to reach for when two copies of the same panel kind can be open at once. It receives only what your `main` targeted at this exact `panelId` via `host.postToPanel(channel, payload, panelId)`, using the `panelId` prop the host handed your view.

The two are **disjoint, not nested**: a broadcast (`postToPanel` with no `panelId`) reaches `usePluginEvent` subscribers only, and a targeted push reaches `usePluginPanelEvent` subscribers only. Subscribe to both if your view needs both kinds. Same teardown contract as `usePluginEvent` — the handler is ref-stable, and only a change to `pluginId`, `channel`, or `panelId` re-subscribes.

Together these are the two halves of the panel ↔ main channel: `useHostChannel` pulls on demand, `usePluginEvent` / `usePluginPanelEvent` receive pushes. All three follow standard React rules — call them at the top of a component, never conditionally.

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

## File listings — `@daintreehq/plugin-sdk/files`

If your plugin presents files, this subpath is the machinery Daintree's own file browser runs on. It exists so a plugin building a custom browser, asset picker or log explorer does not have to rebuild the parts that are genuinely hard.

```ts
import {
  flattenTree,
  buildFolderListingRows,
  countHiddenRows,
  createVisibilityFilter,
  resolveTypeahead,
  buildFileBrowserGitStatusIndex,
  getFileTypeCategory,
} from "@daintreehq/plugin-sdk/files";
```

What it gives you:

| Area | Exports |
| --- | --- |
| Tree model | `flattenTree` (a lazily-expanded directory map → the flat row list a virtualised list renders), `buildFolderListingRows`, `findNodeInListings`, `sortFileNodes` |
| Sorting | `DEFAULT_FILE_SORT`, `isDefaultFileSort`, and the `FileBrowserSortOrder` shape — name/modified/size/type, ascending or descending |
| Hidden entries | `createVisibilityFilter`, `countHiddenRows`, `isRowPathVisible`, `NO_HIDDEN_ROWS` — dotfiles plus a caller-supplied always-hidden pattern list, with the counts a "N hidden" affordance needs |
| Keyboard | `resolveTypeahead`, `resolveTreeKey`, `TYPEAHEAD_RESET_MS` — type-to-select and arrow/expand/collapse resolution over the flat rows |
| Changed files | `buildFileBrowserGitStatusIndex`, `getFileBrowserRowGitStatus` — per-row status plus the folder roll-up, so a collapsed directory can show that something under it changed |
| Classification | `getFileTypeCategory` — several hundred curated extensions and basenames, plus the patterns that catch `.eslintrc.json`, `Dockerfile.dev` and `compose.override.yaml`, resolved most-specific-first |

**It is headless on purpose.** No components, no icons, no styling. A plugin building its own browser wants its own chrome, and exporting Daintree's would freeze the app's internal component contract into the plugin API — the mistake that made Obsidian's CodeMirror upgrade an ecosystem break. `getFileTypeCategory` returns a category name, not an icon, so you map it to whatever glyph set you already ship.

**Nothing here performs I/O.** Feed it listings from [`host.fs.readdir(dir, { detail: true })`](#readdir-and-the-detailed-listing), which returns exactly the shape the model consumes — that pairing is the point of the two features. A view gets those listings the ordinary way: register a channel in `main` that calls `readdir`, and `useHostChannel` it from the view.

Daintree's own file browser imports the same modules from the same package, so this is not a parallel implementation that can quietly drift from the one we maintain — it is the one we maintain.

**A worked example ships in the repo**: `plugins/sample/file-tree/` is a functioning file browser — lazy expansion, hidden-entry filtering with counts, keyboard navigation, per-type classification, and expansion that survives a remount — built on nothing but this subpath, `host.fs.readdir(dir, { detail: true })` and `PanelViewProps.persistState`. Its `main` half is 30 lines (one channel that forwards to `readdir`); everything else is the model plus the plugin's own row markup. It is deliberately built through the published package boundary rather than by relative import, so a missing or reshaped export breaks _it_ — in typecheck and in its bundle — rather than reaching you.

## Disposables

Anything that takes a callback and returns a cleanup function follows the VS Code-style Disposable pattern. You can safely ignore the return value — the plugin's disposal cascade cleans everything up on unload. If you need explicit control (e.g., unsubscribe from a worktree change listener after a one-shot reaction), keep the reference and call it.

**Throwing listeners are quarantined.** A listener callback you pass to `onDidChangeAgentState`, `storage.onDidChange`, or `settings.onDidChange` runs inside the host's event dispatch. If it throws (synchronously or by rejecting), the host logs the failure with a running counter (`1/3`, `2/3`, …) and keeps the subscription alive. After three _consecutive_ failures it auto-unsubscribes the listener so a broken or adversarial callback can't spam the log forever. A single successful invocation resets the counter to zero, so a listener that fails only intermittently is never removed. Dispatch is fire-and-forget — a throw never propagates back into the host's own work or another plugin's listeners.

See [Architecture → Lifecycle](./architecture.md#lifecycle) for how disposal works internally.

## Testing against a mock host

`createMockHost` returns a `PluginHostApi` that mirrors production validation and capability gating, so a unit test can run your `activate()` (and your handlers) against a faithful host and assert what it called. It validates the same things the real host does — `showToast` message/type/`durationMs` bounds, `setPanelBadge` shape, `postToPanel`/`broadcastToRenderer` channel format, and `showQuickPick` item arrays — so a malformed call fails the test the way it would fail in the app.

It ships as `@daintreehq/plugin-testing` (`packages/plugin-testing`), which re-exports the implementation from `shared/testing/createMockHost.ts` along with its record types. The package is not on npm yet, so import it by relative path (or through the workspace link) until it publishes.

```ts
import { createMockHost } from "@daintreehq/plugin-testing"; // workspace-linked; not yet on npm

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
- Full control of the active AI agent's runtime — driving, pausing, or resuming an agent session, and bridging a plugin's MCP tools into an agent Daintree is itself driving. Both cross the agent-config boundary (precedent #4100: never mutate user-owned agent config or session behaviour the user didn't opt into) and stay deferred. Passive observation is offered instead: [`getAgentState` / `onDidChangeAgentState`](#agent-observation) under `agent:read`. The one sanctioned write is text injection: [`host.sendToActiveAgent`](#sendtoactiveagent--inject-text-into-the-active-agent) (gated on `agent:input`, JIT consent, stage-only by default) sends input to the active agent terminal. For everything else, `dispatch` into existing actions is the path.
- An inbound webhook listener or a host-mediated `host.fetch`. Deferred: `scopes.network.allowedUrls` is still advisory rather than a request filter, and an inbound listener widens the attack surface in a way that wants the network-enforcement question settled first. Make outbound calls from your own `main` for now, and declare `network:fetch` with a tight `scopes.network.allowedUrls`.
- Raw Electron main-process APIs are not _passed through_ the host — but the contained, audited equivalents are: `host.process` (managed child processes, gated on `shell:exec`), `host.fs` (scope-contained filesystem), and `host.git` (worktree-scoped git). You can still `import` Node modules directly in plugin code and the host cannot intercept that, so the host-mediated surfaces are the contained, audited path — not a seal on the un-mediated one.
- Daintree's internal event bus. Only the specific subscriptions listed above are exposed. Broad event access would tie plugins to internal shape changes we want to be free to make.

If you have a legitimate need that isn't covered, open an issue with the use case.

## Process model and memory

User-installed plugins — whether sideloaded, installed from a `.dntr` or URL, or `dev`-linked — run **out-of-process** in a `utilityProcess.fork` worker (#10526). Your `main` executes in a child process with its own module realm; the host bridges every `host.*` call and registration over a MessagePort. This is what makes teardown clean: when a plugin is unloaded (uninstall, disable, or dev reload), the host runs the full disposal cascade — IPC handlers, actions, forge and file-decoration providers, worktree subscriptions, and the cleanup function your `activate()` returned — and then **kills the worker**, so the plugin's entire module realm (module-scope `let`/`const` bindings, import-time singletons, stray timers or connections) is reclaimed. There is no ESM module-cache leak and no module-scope state surviving across a reload; dev hot-reload works for exactly this reason.

You should still keep teardown-able work inside `activate()` and its returned cleanup rather than module scope — that's the disposal contract — but you are not paying a per-reload memory penalty for getting it wrong, because the worker is discarded wholesale.

The one behavior to design around: **`registerForgeProvider` is a no-op out-of-process.** A forge provider's `parseRemote` and URL builders are synchronous and can't cross the async MessagePort, so forge providers are usable only by Daintree's **built-in** plugins — the exception to the worker model. Built-ins activate in-process via `import()` because they're trusted, app-bundled, and never unloaded. (An in-process built-in module is never evicted from V8's cache, but since built-ins are never uninstalled that residue is inert.) See [Architecture → Activation](./architecture.md#activation).
