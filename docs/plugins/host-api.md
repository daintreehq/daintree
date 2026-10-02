# Host API

The host API is the runtime surface a plugin's `activate` function receives. It exposes Daintree's state and lets plugins register dynamic behavior beyond what's declared in the manifest.

The canonical import source is `@daintreehq/plugin-sdk` (`npm install --save-dev @daintreehq/plugin-sdk`). Types referenced here live in that package, which re-exports them from `shared/types/plugin-sdk.ts`; inside the Daintree repo the workspace link resolves the same imports to the local build.

**What the npm release has.** `@daintreehq/plugin-sdk@0.1.0` on npm ships the root, `/react`, `/files` and `/testing` entries. Its `/react` exports `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent` and `loadDocumentPackage` only, and its root exports the types plus `PLUGIN_PROCESS_STREAM_CHANNEL`, `PLUGIN_STYLE_ROOT_ATTRIBUTE` and `localAuthStubs`; there is no `/data`, `/plugin-ui` or `/view-globals`. Everything else this page lists for the SDK — the performance hooks, `createViewScope`, `createSyncedCollection`, the agent-context drag helpers, `/data` and `/view-globals` — is marked where it is introduced. A raw, zero-build view is unaffected: it gets the host's copy of `/react` through the import map, and a zero-build worker gets the copy shipped with the app ([Data files](#data-files--daintreehqplugin-sdkdata)).

This page is the reference: every member, its gates and its failure modes. For a walkthrough of building a plugin that is really an application, see [Building apps](./building-apps.md).

## Contents

- Conventions: [Calling conventions](#calling-conventions) · [Activation](#activation) · [`PluginHostApi`](#pluginhostapi) · [Errors and error codes](#errors-and-error-codes) · [Capabilities and consent](#capabilities-and-consent) · [Identity](#identity--pluginid-plugininfo-panelkindid)
- Registration: [`registerAction`](#registeraction) · [`registerHandler` and `broadcastToRenderer`](#registerhandler-and-broadcasttorenderer) · [Deadlines and size limits](#deadlines-and-size-limits) · [`postToPanel`](#posttopanel) · [Push delivery](#push-delivery) · [Listener hints](#listener-hints--haslisteners-ondidchangelisteners) · [`registerForgeProvider`](#registerforgeprovider) · [File decorations](#registerfiledecorationprovider-and-invalidatefiledecorations) · [`mcp.registerTools`](#mcpregistertools)
- Observation: [Worktrees](#worktree-observation) · [Agent state](#agent-observation) · [Panel lifecycle](#ondidchangepanellifecycle) · [`onDidWake`](#ondidwake)
- Panels and actions: [`reloadPanel`](#reloadpanel) · [`setPanelBadge`](#setpanelbadge) · [`dispatch`](#dispatch) · [`actions`](#actions--built-in-action-catalog)
- Agents: [`sendToActiveAgent`](#sendtoactiveagent--inject-text-into-the-active-agent) · [`sendToAgent`](#sendtoagent--hand-work-to-an-agents-draft) · [`agents.list`](#agentslist--the-projects-agent-panes) · [`agents.listAll`](#agentslistall--every-agent-in-every-open-project)
- State: [`settings`](#settings) · [`storage`](#storage--private-keyvalue-storage) · [`db`](#db--host-managed-sqlite)
- UI: [`logger`](#logger) · [`showToast`](#showtoast) · [User prompts](#user-prompts--showquickpick-showinputbox-showconfirm)
- System: [`process`](#process--managed-child-processes) · [`fs`](#fs--host-mediated-scope-contained-filesystem) · [`git`](#git--host-mediated-git-scoped-to-a-worktree) · [`clipboard`](#clipboard--host-mediated-os-clipboard) · [`system`](#system--open-and-reveal-files-in-your-own-scope) · [`documents`](#documents--render-html-to-pdf)
- SDK entries: [React hooks](#react-hooks--daintreehqplugin-sdkreact) · [Root entry](#root-entry-runtime-values--daintreehqplugin-sdk) · [File listings](#file-listings--daintreehqplugin-sdkfiles) · [Data files](#data-files--daintreehqplugin-sdkdata) · [UI kit](./ui-kit.md)
- Lifecycle and testing: [Disposables](#disposables) · [Testing against a mock host](#testing-against-a-mock-host) · [What's not exposed](#whats-not-exposed) · [Process model](#process-model-and-memory)

## Calling conventions

Every callback a plugin hands the host has a fixed shape, and the one for `registerHandler` is the one every first plugin gets wrong. The whole set, in one place:

| You register | Your function receives | Notes |
| --- | --- | --- |
| `registerAction(descriptor, handler)` | `(args)` | The dispatched args payload only. No `host`, no context; close over `host` from `activate()` if the handler needs it. |
| `registerHandler(channel, handler, options?)` (untyped) | `(ctx, ...args)` | **Context first.** `ctx` is `{ projectId, worktreeId, webContentsId, pluginId }`; the arguments the view passed to `invoke(pluginId, channel, ...args)` follow it. Read the payload from the first parameter and you get the context object instead. |
| `registerHandler(channel, schema, handler, options?)` (typed) | `(ctx, args)` | Same order; `args` is the single, schema-parsed payload. `options.timeoutMs` sets the invoke deadline for either overload ([Deadlines and size limits](#deadlines-and-size-limits)). |
| `postToPanel(channel, payload)` | view: `on(pluginId, channel, cb)` receives `payload` | Broadcast. Subscriptions are keyed by plugin and channel only, so it reaches every `on` subscriber your plugin has on that channel, across all of its panel kinds. `usePluginEvent` in a view. |
| `postToPanel(channel, payload, panelId)` | view: `onPanel(pluginId, channel, panelId, cb)` receives `payload` | One instance only, disjoint from the broadcast. `usePluginPanelEvent` in a view. |
| `onDidChangeActiveWorktree`, `onDidChangeAgentState`, `onDidChangeAllAgents`, `onDidChangePanelLifecycle`, `onDidWake`, `settings.onDidChange`, `storage.onDidChange` | `(event)` | One argument. A listener that throws is logged; see [Disposables](#disposables) for which ones are unsubscribed after three failures in a row. The first three coalesce bursts by default ([`PluginHostSubscriptionOptions`](#pluginhostapi)). |
| `onDidChangeWorktrees` | `(snapshots, change)` | The full list, then `{ added, removed, changed }` snapshot ids since this subscription's previous delivery. Coalesced by default. |
| `onDidChangeListeners(channel, cb)` | `(hasListeners)` | A boolean. Returns its disposer synchronously. |
| `db` handle `onDidChange(cb)` | `({ origin })` | Frozen, and at most one per 50 ms window. Returns its disposer synchronously, not a Promise. |
| `fs.watch(paths, cb, options?)` | `(changedPath)` | The absolute path that changed. |
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

**Activation timeout:** 5 seconds. If `activate` doesn't resolve within the timeout, Daintree marks the plugin as failed and surfaces a toast. Keep activate fast; defer heavy work to command handlers. A plugin running in a worker (every installed and project plugin) has one 5-second budget shared by importing `main` and settling `activate()`, so a top-level `await` that never settles fails the plugin the same way. Built-ins, which load in-process, have separate 5-second limits for the import and for `activate()`.

**Error handling:** if `activate` throws, the plugin fails to load and the error is logged to the main process console plus surfaced as a toast. Other plugins continue loading.

**Partial-activation rollback:** if `activate` throws after it has already registered some handlers, actions, or subscriptions, the host rolls all of them back automatically — the rollback is synchronous and host-owned, so you have no cleanup responsibility for a failed activation. A user-installed plugin gets the same guarantee from its worker being torn down on the failure. Don't try to undo your own registrations in a `catch` inside `activate`; just let the error propagate.

## `PluginHostApi`

```ts
interface PluginHostApi {
  // Identity — static, readable forever
  readonly pluginId: string;
  readonly pluginInfo: PluginIdentity;
  panelKindId(bareId: string): string;

  // Action / command registration
  registerAction(descriptor: PluginActionContribution, handler: ActionHandler): Promise<void>;

  // IPC
  registerHandler<TArgs, TResult>(
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>,
    options?: PluginHandlerOptions // { timeoutMs?: number }
  ): Promise<void>;
  registerHandler(
    channel: string,
    handler: PluginIpcHandler,
    options?: PluginHandlerOptions
  ): Promise<void>;
  broadcastToRenderer(channel: string, payload: unknown): Promise<void>;

  // Post-activation push into your panels
  postToPanel(channel: string, payload: unknown, panelId?: string | null): Promise<void>;
  // Producer-side hint: may any renderer be subscribed to `channel`?
  hasListeners?(channel: string): boolean;
  onDidChangeListeners?(channel: string, callback: (hasListeners: boolean) => void): () => void;

  // Worktree observation
  getActiveWorktree(): Promise<PluginWorktreeSnapshot | null>;
  getWorktrees(): Promise<PluginWorktreeSnapshot[]>;
  getWorktreesResult(): Promise<PluginWorktreesResult>;
  getWorktreeStatus(
    path: string,
    options?: PluginHostCallOptions
  ): Promise<PluginWorktreeStatus | null>;
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  onDidChangeWorktrees(
    callback: (snapshots: PluginWorktreeSnapshot[], change: PluginWorktreesChange) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;

  // Agent observation — gated on the `agent:read` capability
  getAgentState(): Promise<PluginAgentSnapshot | null>;
  onDidChangeAgentState(
    callback: (snapshot: PluginAgentSnapshot) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  // Every agent in every open project — `agent:read`, installed and built-in plugins only
  onDidChangeAllAgents(
    callback: (snapshot: PluginAllAgentsSnapshot) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;

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

  // Tools served to terminal agents — gated on the `mcp:expose` capability
  readonly mcp: PluginMcpApi;

  // Panel title-chrome badge
  setPanelBadge(panelId: string, badge: PluginPanelBadge | null): Promise<void>;

  // Remount one of your own panels' views
  reloadPanel(panelId: string): Promise<PanelReloadResult>;

  // Action dispatch + catalog
  dispatch(
    actionId: ActionId,
    args?: unknown,
    options?: PluginDispatchOptions
  ): Promise<ActionDispatchResult>;
  readonly actions: PluginHostActionsApi;

  // Agent input — gated on the `agent:input` capability
  sendToActiveAgent(text: string, options?: { submit?: boolean }): Promise<void>;
  sendToAgent(
    text: string,
    options?: PluginSendToAgentOptions,
    callOptions?: PluginHostCallOptions
  ): Promise<PluginSendToAgentResult>;
  // The project's agent panes — gated on `agent:read`
  readonly agents: PluginAgentsApi;
  // What a terminal's screen shows, as plain text — gated on `terminal:read`
  readonly terminals: PluginTerminalsApi;

  // Settings (user-facing, schema-declared; get/set/onDidChange/open/missingRequired)
  // + private storage (machine-owned)
  readonly settings: SettingsApi;
  readonly storage: StorageApi;
  // Host-managed SQLite, declared in contributes.databases
  readonly db: PluginDatabaseApi;

  // Diagnostics
  readonly logger: PluginLogger;

  // UI helpers — overloaded so `canSelectMany: true` types as an array
  showToast(options: PluginToastOptions): Promise<void>;
  showQuickPick(
    items: PluginQuickPickItem[],
    options: PluginQuickPickOptions & { canSelectMany: true },
    callOptions?: PluginHostCallOptions
  ): Promise<PluginQuickPickItem[] | undefined>;
  showQuickPick(
    items: PluginQuickPickItem[],
    options?: PluginQuickPickOptions,
    callOptions?: PluginHostCallOptions
  ): Promise<PluginQuickPickItem | undefined>;
  showInputBox(
    options?: PluginInputBoxOptions,
    callOptions?: PluginHostCallOptions
  ): Promise<string | undefined>;
  showConfirm(options: PluginConfirmOptions, callOptions?: PluginHostCallOptions): Promise<boolean>;

  // Managed child processes — gated on the `shell:exec` capability
  readonly process: PluginProcessApi;

  // Host-mediated, scope-contained filesystem and git
  readonly fs: PluginFsApi;
  readonly git: PluginGitApi;

  // Host-mediated OS clipboard — gated on `clipboard:read` / `clipboard:write`
  readonly clipboard: PluginClipboardApi;
  // Open / reveal a file in the plugin's own declared fs scope
  readonly system: PluginSystemApi;
  // HTML to PDF, written under the same gates as fs.writeFile
  readonly documents: PluginDocumentsApi;
}
```

The authoritative definition is `PluginHostApi` in `shared/types/plugin.ts`, re-exported through `shared/types/plugin-sdk.ts`. The block above is a readable summary — where it disagrees with the type, the type wins.

Two option bags recur. `PluginHostCallOptions` is the trailing argument on long-running calls (`getWorktreeStatus`, `fs.*` except `writeFile`, `appendFile` and `mkdir`, all of `git.*`, `sendToAgent`, and the three prompts) and carries an optional `signal: AbortSignal` so a call whose consumer has gone away can be cancelled. An already-aborted signal rejects before any work and an abort mid-flight rejects with the signal's reason — except on the prompts, where an abort dismisses the dialog and resolves as a cancel (`undefined` / `false`), and `sendToAgent`, where it resolves `{ status: "cancelled" }` while the picker is still open. `PluginHostSubscriptionOptions` is the trailing argument on the three bursty subscriptions — `onDidChangeWorktrees`, `onDidChangeActiveWorktree` and `onDidChangeAgentState` — and carries `debounceMs`. **They coalesce by default**: a burst becomes one trailing callback `debounceMs` after the last event, and a burst that never goes quiet still fires at least every `4 × debounceMs`, so sustained churn can't withhold the latest state indefinitely. Omitted (or not a number) means the 100 ms default; `0` or a negative number delivers every event raw; any other value is the window, clamped to 50–60,000 ms. The latest value is always delivered — what a coalesced callback carries is described under [Worktree observation](#worktree-observation) and [Agent observation](#agent-observation). The one other `debounceMs` in the API, on `fs.watch`, keeps the opposite default: omitted means every event.

Nearly every host method now returns a Promise — the API became fully async in the move to the out-of-process worker model, so `registerAction`, `postToPanel`, `setPanelBadge`, and the rest resolve `Promise<void>`, and the subscription methods resolve `Promise<() => void>`. Always `await` a registration before assuming it took effect, and `await` the subscription methods to get the disposer. The synchronous exceptions are `logger` (its `info`/`warn`/`error` calls return `void`), `pluginInfo` and `panelKindId` (static data), a database handle's `onDidChange`, which returns its disposer directly, and `hasListeners` / `onDidChangeListeners`, which answer and return their disposer synchronously and throw at the call on an invalid channel or callback.

The revoke-guarded methods — `registerAction`, `registerHandler`, `broadcastToRenderer`, `registerForgeProvider`, `registerFileDecorationProvider`, `mcp.registerTools`, `onDidChangeActiveWorktree`, `onDidChangeWorktrees`, `onDidChangeAgentState`, `onDidChangeAllAgents`, `onDidChangePanelLifecycle`, `onDidWake`, `settings.onDidChange` and `storage.onDidChange` — must be called during `activate()` and throw once the host is revoked. Subscribing counts as an activation-window operation even though the callback fires later: register all your subscriptions during `activate()`, then react to them for the plugin's lifetime. Everything else is deliberately NOT revoke-guarded — `postToPanel`, `hasListeners`, `onDidChangeListeners`, `setPanelBadge`, `reloadPanel`, the worktree and agent reads, `invalidateFileDecorations`, `showToast`, the prompts, `dispatch`, `actions.*`, `sendToActiveAgent`, `sendToAgent`, `agents.list`, `settings.get`/`set`/`open`/`missingRequired`, `storage.get`/`set`/`delete`, `db.*` (including a handle's `onDidChange`), `process.spawn`, `fs.*` (including `watch`), `git.*`, `clipboard.*`, `system.*`, `documents.renderPdf` and `logger`. Plugins call them from post-activation subscription callbacks and timers, so they stay callable for the plugin's lifetime and become a silent no-op or an empty answer after unload — except the ones that act on disk or on a process, which reject: new `fs.*`, `git.*`, `clipboard.*`, `system.*`, `documents.renderPdf` and `db.*` calls with a `PLUGIN_UNLOADED:` message, `process.spawn` and `settings.open` with a plain "plugin is no longer loaded" one. A database handle the host closed at unload rejects `DB_CLOSED`, and in a worker any call still outstanding when the worker is torn down rejects "Plugin dev worker disposed" (see [Worker and in-process differences](#worker-and-in-process-differences)). `pluginId`, `pluginInfo` and `panelKindId` are static data and keep working even after unload. This split is the load-bearing distinction between the activation-window registration surface and the live runtime surface — `postToPanel` is the canonical post-activation push: a plugin's `activate()` subscribes once (revoke-guarded `registerHandler`/worktree subscriptions), then streams live data into its panels with `postToPanel` for the rest of its lifetime.

**Where validation errors surface.** The two groups report errors differently. A revoke-guarded activation-window method (`registerAction`, `registerHandler`, the subscriptions) throws synchronously at the call site on a bad descriptor or a revoked host — wrap the `activate()` body in `try`/`catch` if you want to handle it. `broadcastToRenderer` is in that group and throws at the call for a channel that is not a string or contains a colon (an empty one is accepted), or a payload over the push cap. The post-activation runtime-surface methods (`postToPanel`, `setPanelBadge`, `invalidateFileDecorations`) instead reject the returned Promise rather than throwing synchronously — `postToPanel` on an invalid channel, an empty-string `panelId`, an oversize or uncloneable payload — so handle their validation errors with `await` + `.catch()` (the exception is the synchronous `hasListeners` / `onDidChangeListeners`, which throw on an invalid channel):

```ts
await host.postToPanel("build-status", status).catch((err) => host.logger.error(String(err)));
```

A liveness no-op (the plugin already unloaded) still resolves cleanly — only a genuine validation error (empty channel, malformed badge shape) rejects.

This split is encoded in the type surface, not just in prose: the revoke-guarded host methods are factored into a `PluginActivationApi` sub-interface that `PluginHostApi extends` (`settings.onDidChange` and `storage.onDidChange` stay on `SettingsApi` and `StorageApi`, since those accessors are otherwise post-activation-safe). Each revoke-guarded method also carries a `@throws` JSDoc tag describing the revoke condition, so it shows up on hover in your editor. The `host` passed to `activate()` stays typed as the full `PluginHostApi` (every method is callable during activation); `PluginActivationApi` is exported from `@daintreehq/plugin-sdk` for the narrower case where you want a helper to accept only the registration window and have the post-activation methods be statically absent.

## Errors and error codes

A host call that fails for a reason a plugin can act on names the reason with a code. Branch on the code, never on the rest of the message, which is prose and changes.

Where the code lives depends on the error. Most coded errors carry it on `err.code` **and** as the first token of `err.message` (`"REVISION_MISMATCH: …"`). The older gates — capability, containment, liveness, argument checks — put it in the message prefix only, and `PROJECT_VIEW_UNAVAILABLE` is the reverse: on `err.code`, not in the message. `code` and, for a revision conflict, `currentRevision` survive the trip from main to a plugin worker, so a worker plugin sees the same fields an in-process one does; nothing else on the error object crosses — no `name`, `cause`, subclass or other property. Read both places:

```ts
function hostErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return /^([A-Z][A-Z_]+):/.exec(err.message)?.[1];
}
```

Node's own filesystem errors (`ENOENT`, `ENOTDIR`, `EISDIR`, `EACCES`) reach you the same way, with Node's `code`. An aborted `signal` rejects with the signal's reason — Node's `AbortError` unless you aborted with your own `Error`.

| Code | Where | Raised by | Meaning → what to do |
| --- | --- | --- | --- |
| `PERMISSION_REQUIRED` | message | every capability-gated call (see [below](#capabilities-and-consent)), a typed `registerHandler`'s `requires` | The capability is not in `manifest.capabilities`, or the just-in-time prompt was denied, timed out or could not be shown (the message says which). Declare the capability; for a refusal, tell the user and let them retry — never loop. |
| `PATH_NOT_ALLOWED` | message (`fs`, `git`, `system`, `documents`); both (`db`) | path arguments, `git` pathspecs, a database's resolved location | Outside every declared root, a `..` or symlink escape, a git pathspec that is absolute, uses `..` or `:` magic, or a project database inside `.git`. Fix the path or `scopes.fs.allowedPaths`; not retryable. |
| `REVISION_MISMATCH` | both, plus `currentRevision` | `fs.writeFile` with `expectedRevision` | The file changed since you read it. Enter a conflict state with `currentRevision`, or re-read, re-apply and retry ([`editFile`](./data-helpers.md#conflict-checked-edits) does this). |
| `TARGET_EXISTS` | both | `fs.writeFile` with `expectedRevision: null`; `fs.mkdir` over a non-directory | Someone created it first. Re-read and decide. |
| `TARGET_UNAVAILABLE` | both | `fs` reads and writes, `appendFile`, `mkdir`, `walk`, `documents.renderPdf`, `db.open`, `db` reopen, `backup` | The target is missing where a revision was expected, or moved or was replaced mid-call; for `appendFile`, `mkdir`, a database or a backup, something other than a regular file (or directory) stands there. Usually a race with a replace: re-read and retry. `readFile`, `readFileBytes`, `readFileWithRevision` and `writeFile` aimed at a directory fail with Node's own error (`EISDIR`) instead. |
| `TARGET_IS_SYMLINK` | both | `fs` reads and writes, `renderPdf` input and output, a database file, a backup destination | The leaf is, or became, a symlink. Refused by design. |
| `INVALID_PATH` | message; `code` only for an executable | `system.openPath` / `showItemInFolder`, `documents.renderPdf` | Inside your scope but missing, or the output's parent directory does not exist, or `htmlPath` is not a regular file. Create it first. `openPath` refusing an executable file type carries the code on `err.code` with the message `Refusing to open executable file type: .ext`. |
| `VALIDATION` | message (`clipboard`, `renderPdf` options); both (`db`) | argument checks | An authoring mistake: wrong type, unknown option, a readonly open with `migrations`, a backup onto the database itself or a journal-named file. Fix the call. |
| `PAYLOAD_TOO_LARGE` | message; both for a PDF over the cap | `clipboard.writeText` (8 MiB), `clipboard.writeImage` (20 MiB), `renderPdf` `htmlPath` (5 MiB) and output (50 MiB) | Send less. Inline `html` over 5 MiB is `VALIDATION`. |
| `PLUGIN_INVOKE_TIMEOUT` | message (only the message reaches a view) | a view's `invoke` of a `registerHandler` channel | The handler did not settle within its deadline (five minutes unless it registered its own `timeoutMs`). The message names the plugin, channel and deadline. The handler may still be running; make it idempotent or give it a longer deadline. See [Deadlines and size limits](#deadlines-and-size-limits). |
| `PLUGIN_PAYLOAD_TOO_LARGE` | message; also `code` on a rejected `postToPanel` / `broadcastToRenderer` | invoke arguments (4 MiB), invoke results (16 MiB), `postToPanel` / `broadcastToRenderer` payloads (1 MiB) | The serialized payload is over its transport cap. Send less, page it, or send deltas. |
| `PLUGIN_PAYLOAD_UNCLONEABLE` | message and `code` | the same payloads | Structured clone refuses the value (a function, a symbol, a throwing getter). In a worker, a push the port cannot clone rejects with the port's own `DataCloneError` instead. |
| `PLUGIN_UNLOADED` | message; `dispatch` result code | `fs`, `git`, `clipboard`, `system`, `documents`, `db` after unload | You are being torn down; stop. |
| `PROJECT_VIEW_UNAVAILABLE` | `code` only | `dispatch` and the prompts from a project plugin; `settings.open` folds it into its message | Your project has no live window. Try again when it is open. (`agents.list` and `actions.*` answer empty instead, and `sendToAgent` refuses with `project-unavailable`.) |
| `RATE_LIMITED` | both | `terminals.readScreen` | More than 60 calls in a second. Nothing is queued; slow the poll and call again. |
| `NO_ACTIVE_AGENT` | message | `sendToActiveAgent` | The terminal host is not available, or — for an app-global plugin only — no agent terminal can take the input. A project plugin with no eligible agent resolves silently instead and logs a warning. Tell the user, or use `sendToAgent`. |
| `PROCESS_LIMIT_REACHED` | both | `process.spawn` | Eight of your processes are already running. Wait for one to exit, or kill one. |
| `SCHEMA_ERROR` | message | a typed `registerHandler` channel | Args or result failed the schema; reaches the view's `useHostChannel` `error`. |
| `COMMIT_MESSAGE_REQUIRED` | message | `git.commit` | Empty message. The host never derives one. |
| `DB_NOT_DECLARED` | message | `db.resolve`, `db.open` | The id is not in `contributes.databases`. |
| `DB_NOT_FOUND` | both | a `readonly` `db.resolve` / `db.open` | The file (or its directory) does not exist yet. Show an empty state, or open writable once. |
| `DB_READONLY` | both | `run`, `exec`, `transaction` on a readonly handle | Open without `readonly` to write. |
| `DB_SCHEMA_TOO_NEW` | both | `db.open` | `user_version` is past your migration list — a newer copy of the plugin wrote it. Do not guess; ask the user to update. |
| `DB_MIGRATION_FAILED` | both | `db.open` | A migration threw and was rolled back. The message names it. |
| `DB_DEFINITIONS_FAILED` | both | `db.open` | `definitions` threw and was rolled back. |
| `DB_MULTIPLE_STATEMENTS` | both | `query`, `get`, `run`, `columns` | SQL follows the first statement. Use `exec` for a batch. |
| `DB_STATEMENT_NOT_ALLOWED` | both | every statement, `migrations`, `definitions` | SQL that would reach another file (`ATTACH`, `DETACH`, `VACUUM INTO`, a directory pragma). Use `backup` for a copy. |
| `DB_CLOSED` | both | any call on a closed handle | Open it again. |
| `DB_UNSUPPORTED` | both | `columns`, `backup` | The runtime's `node:sqlite` lacks the feature, or this host cannot approve a backup destination. |
| `SQLITE_UNAVAILABLE` | both | the first `db.open` | The runtime has no `node:sqlite`. |
| `PROJECT_UNAVAILABLE` | both | `db` for a `"project"` database | The plugin has no project to put the file in. |
| `DESTINATION_HAS_JOURNAL` | both | `backup`, the panel menu's **Back up data…** | A `-wal`, `-shm` or `-journal` file sits beside the destination and SQLite would replay it into the copy. Choose another destination. |
| `RENDER_BUSY` | both | `documents.renderPdf` | Too many of your calls are waiting on consent or rendering. Retry later. |
| `RENDER_TIMEOUT` | both | `documents.renderPdf` | Not finished within 30 seconds of taking a render slot. |
| `RENDER_FAILED` | both | `documents.renderPdf` | The page failed to load or print. |
| `RENDER_CANCELLED` | both | `documents.renderPdf` | The plugin unloaded while the call was queued or rendering. |
| `FRONTMATTER_INVALID` | `code` (SDK) | `parseFrontmatter`, `updateFrontmatter` | See [Data helpers](./data-helpers.md#frontmatter); the error carries `line` and `column`. |

`fs.readFiles` reports a refusal per entry rather than rejecting, with its own code set (`NOT_FOUND`, `NOT_A_FILE`, `TOO_LARGE`, `RESULT_TOO_LARGE`, `READ_FAILED` beside the shared ones) — see [`readFiles` and `walk`](#readfiles-and-walk--bulk-reads).

`dispatch` does not throw for a refused action: it resolves `{ ok: false, error: { code } }` with an `ActionErrorCode` — see [`dispatch`](#dispatch). `sendToAgent` resolves a refusal too, with a `reason` rather than a code.

## Capabilities and consent

A capability is declared in `manifest.capabilities` and checked on every call — an undeclared one rejects with `PERMISSION_REQUIRED` before anything else happens. Some also raise a **just-in-time consent** prompt the first time the plugin uses them. The prompt offers a remembered grant or a one-time approval; a remembered grant is keyed by plugin and capability, and for a project plugin by project too, so approving one project's copy never answers for another's. Concurrent first uses share one prompt. Built-in plugins skip consent. A call's arguments are validated before the prompt, so a malformed call can never bank a grant.

| Capability | Unlocks | Consent |
| --- | --- | --- |
| `agent:read` | `getAgentState`, `onDidChangeAgentState`, `agents.list`, `agents.listAll`, `onDidChangeAllAgents` | — |
| `agent:input` | `sendToActiveAgent`, `sendToAgent` | First use |
| `terminal:read` | `terminals.readScreen` | First use. Not granted by `agent:read`. |
| `fs:project-read`, `fs:user-data-read` | `fs` reads, `readdir`, `stat`, `watch`; `renderPdf`'s `htmlPath`; `system.*` (read or write of the root class) | — |
| `fs:project-write`, `fs:user-data-write` | `fs.writeFile`, `appendFile`, `mkdir`; `renderPdf`'s output; `db` handle `backup` destination | First write. The prompt is keyed on the strongest write capability you declare (`fs:project-write` when declared, else `fs:user-data-write`), not on the target's root class, so one grant covers writes to every root, your data directory included. |
| `fs:project-write` | A `location: "project"` database — required by the manifest check, which also limits it to `"scope": "project"` plugins | The first writable `db.open` / `db.resolve`: the same grant as `fs.writeFile`. A `"local"` database and a `readonly` open need none. |
| `git:read` | `git.status`, `git.diff`, and `git.commit` (for its preview) | — |
| `git:write` | `git.add`, `git.commit` | First mutation |
| `shell:exec` | `process.spawn` | First spawn |
| `clipboard:read` | `clipboard.readText` | — |
| `clipboard:write` | `clipboard.writeText`, `writeImage` | — |
| `mcp:expose` | `mcp.registerTools` and `contributes.agentMcp` | — (the user sets the plugin's agent access per project) |
| `project:dispatch` | `dispatch` with `options.projectId` from an installed plugin | — (the user turns on **Allow project targeting** in the plugin's Permissions; there is no prompt) |

No capability: `settings`, `storage`, a `"local"` database, `logger`, `showToast`, the prompts, `postToPanel`, `hasListeners`, `onDidChangeListeners`, `setPanelBadge`, `reloadPanel`, `onDidChangePanelLifecycle`, `onDidWake`, the worktree reads and subscriptions, `dispatch` (the action's own `danger` still applies) and `actions`. How capabilities raise an action's effective danger is in the [trust model](./trust-model.md).

## Identity — `pluginId`, `pluginInfo`, `panelKindId`

```ts
host.pluginInfo;
// { instanceId, manifestId: "acme.board", origin: "project", projectId, projectRoot }
await host.dispatch("panel.openPluginPanel", { kind: host.panelKindId("board") });
```

`pluginId` is the key this instance is registered under. For an installed plugin that is the manifest id; for a project plugin it is an instance key that also encodes the project, so never parse it. `pluginInfo` gives you the parts instead, frozen when the host was built:

| Field | Notes |
| --- | --- |
| `instanceId` | Byte-identical to `pluginId`. |
| `manifestId` | `publisher.name` — the id to write into anything the repository sees, since a project id is machine-local. |
| `origin` | `"project"` for a `.daintree/plugins` plugin, `"global"` otherwise. |
| `projectId`, `projectRoot` | The owning project and its absolute root, or both `null` for an installed or built-in plugin. |

`panelKindId(bareId)` turns one of your own `contributes.panels[].id` values into the runtime kind id that `panel.openPluginPanel` expects — `{manifestId}.{bareId}` for a global plugin, `project:{projectId}/{manifestId}/{bareId}` for a project plugin — from the host's own binding, so the same code works under either. It is synchronous and throws on an empty id. All three stay readable after unload.

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

- `descriptor.id` must NOT include the plugin prefix — Daintree adds it. The above registers as `acme.linear-planner.plan-from-issue` at runtime (assuming your plugin is `acme.linear-planner`). The bare id is non-empty and uses letters, digits, `.`, `_` and `-`; starting it with a lowercase letter keeps it consistent with built-in ids.
- `title` and `category` are required non-empty strings, `description` a required string, and `kind` is `"command"` or `"query"`.
- `descriptor.danger` accepts `"safe"` or `"confirm"`. `"restricted"` is reserved for Daintree's internal use and rejected. The host raises `"safe"` to `"confirm"`, never the reverse, when the plugin holds a high-risk capability or a risky pair of them ([trust model](./trust-model.md)).
- `requires`, when given, is the capabilities this action exercises and must be a subset of `manifest.capabilities` — an undeclared one throws `PERMISSION_REQUIRED`. It narrows which capabilities the danger elevation consults (`[]` means none) and grants nothing; omitted, the whole manifest counts.
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
// renderer side (in a view component). A bundled view ships its own copy of the
// SDK; a raw plugin:// view gets the host's through the import map. Either can call
// window.electron.plugin.invoke(pluginId, "sync-now", args) directly. See "React hooks" below.
import { useHostChannel } from "@daintreehq/plugin-sdk/react";

const { invoke } = useHostChannel<SyncArgs, SyncResult>(pluginId, "sync-now");
const result = await invoke({});
```

**Channel naming rules:**

- No colons (reserved for Daintree's internal namespacing). The host enforces this everywhere a channel is named: `registerHandler` throws `Plugin channel must not contain colons`, which fails `activate()` on its first registration, and the push and listener methods refuse it too. `createMockHost` enforces it in the same places: its `registerHandler` throws the same `Plugin channel must not contain colons: <channel>` at the call, so an activation test that registers a colon channel fails rather than the app.
- Plugin-registered channels are addressed as `{pluginId}:{channel}` internally; the SDK handles the prefix.

Registering a channel again replaces its handler. An untyped re-registration of a typed channel also drops that channel's schema and `requires`, so nothing validates it afterwards. `ctx.projectId` and `ctx.worktreeId` are `string | null` — `null` when the calling view has no project or worktree. Handlers are unregistered on plugin unload.

**Typed overload (preferred for new code):** pass a `PluginChannelSchema` with Zod `args`/`result` schemas and a `requires` capability list. The host rejects registration if any `requires` capability is missing from `manifest.capabilities` (fail-closed at the registration boundary). At dispatch, args are `safeParse`d before the handler runs and the result is `safeParse`d before returning to the renderer — schema failures throw with a `SCHEMA_ERROR:` prefix, missing capabilities throw with a `PERMISSION_REQUIRED:` prefix, and the renderer-side `useHostChannel` hook discriminates on those prefixes. The untyped overload above does no host-side validation and is retained only for plugins that haven't migrated to per-channel schemas.

**The mock host does not validate typed channels.** `createMockHost().registerHandler` records the handler but neither keeps nor applies its schema, so a handler that returns a shape your own protocol rejects still passes. Wrap it in tests: keep the schema, parse args on the way in and the result on the way out, and invoke through that wrapper — then a schema mismatch fails in the test exactly as it would at the host boundary.

### Deadlines and size limits

Every `plugin:invoke` round trip is bounded. The limits live in `shared/config/pluginBudgets.ts`, and a call that breaks one fails with a named error rather than stalling or taking the app down with it.

```ts
// A build legitimately runs long: give it its own deadline.
await host.registerHandler("build-site", buildSite, { timeoutMs: 20 * 60_000 });
// A handler that waits on something unbounded by design opts out.
await host.registerHandler("tail-log", tailLog, { timeoutMs: 0 });
```

**Deadlines.** `registerHandler(channel, handler, options?)` and `registerHandler(channel, schema, handler, options?)` take `PluginHandlerOptions { timeoutMs?: number }`. Omitted, the deadline is five minutes (`PLUGIN_INVOKE_DEFAULT_TIMEOUT_MS`); `0` disables it; anything that is not a number from `0` to `2147483647` throws at registration, so a typo fails `activate()` rather than the first call. When the deadline passes, the view's `invoke` rejects with `PLUGIN_INVOKE_TIMEOUT: plugin "<id>" handler "<channel>" did not settle within <ms> ms`, and `useHostChannel` surfaces that on `error`. The handler itself is not interrupted: an in-process builtin's keeps running with nobody waiting on it, and a worker plugin's keeps running but its result is dropped in the worker instead of being cloned back. Write handlers so a retry after a timeout is safe. Actions registered with `registerAction` have no invoke deadline; they are long-running by design.

**Size limits.** Payloads are measured by an estimate of their structured-clone size (UTF-8 bytes for strings and keys, `byteLength` for binary data, a small fixed cost per other value), stopping as soon as a cap is passed, so an oversize payload costs about the cap in work however large it is:

| Payload | Cap | Refused as |
| --- | --- | --- |
| Arguments of one invoke | 4 MiB (`PLUGIN_INVOKE_MAX_ARGS_BYTES`) | The view's `invoke` rejects before the handler runs, and before a worker plugin is sent a copy |
| Result of one invoke, including an action result returned over `plugin:invoke` | 16 MiB (`PLUGIN_INVOKE_MAX_RESULT_BYTES`) | The view's `invoke` rejects; a worker refuses it before it crosses the port |
| One `postToPanel` or `broadcastToRenderer` payload | 1 MiB (`PLUGIN_PUSH_MAX_PAYLOAD_BYTES`) | `postToPanel` rejects its Promise; `broadcastToRenderer` throws at the call |

The error reads `PLUGIN_PAYLOAD_TOO_LARGE: plugin "<id>" <what> exceeds the <limit>-byte limit (at least <n> bytes)`, where `<what>` is `arguments to "<channel>"`, `result of "<channel>"` or `push payload on "<channel>"`, and `<n>` is how far the estimate had counted when it stopped — a lower bound, not the payload's size. A payload structured clone cannot carry fails with `PLUGIN_PAYLOAD_UNCLONEABLE: plugin "<id>" <what> cannot be cloned: <reason>`. The `plugin:invoke` IPC envelope itself admits the 4 MiB argument cap plus 64 KiB for the ids and channel, so a view can actually send what the cap allows; a message far past that is refused by the IPC layer before the handler runs.

The caps are ceilings, not targets. A list the worker changes belongs in a synced collection (`createSyncedCollection` in the worker, `useSyncedCollection` in the view), which sends deltas and splits a large change set under the push cap by itself; a large read belongs behind paging or [`fs.readFiles`](#readfiles-and-walk--bulk-reads).

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
// renderer side (in a view component), bundled or raw. The bridge underneath is
// window.electron.plugin.on(pluginId, "build-status", cb), which returns an
// unsubscribe function. See "React hooks" below.
import { usePluginEvent } from "@daintreehq/plugin-sdk/react";

usePluginEvent<BuildStatus>(pluginId, "build-status", (status) => {
  setBuildStatus(status);
});
```

`postToPanel` is the post-activation sibling of `broadcastToRenderer`: it fans out over the exact same `plugin:{pluginId}:{channel}` transport, but unlike the revoke-guarded activation broadcast it stays callable for the plugin's whole lifetime. Use `broadcastToRenderer` for a one-shot push during `activate()`; use `postToPanel` for everything pushed afterward (the common case). `channel` must be a non-empty string without colons — an invalid channel rejects the returned Promise so authoring mistakes surface loudly (catch it with `await … .catch()`). It is membership-gated, not revoke-guarded: once the plugin is unloaded it becomes a silent no-op. A payload over 1 MiB rejects with `PLUGIN_PAYLOAD_TOO_LARGE` ([Deadlines and size limits](#deadlines-and-size-limits)). There is no delivery acknowledgement — it is fire-and-forget; a panel that isn't mounted simply doesn't receive the payload, and nothing is replayed to a subscriber that arrives later. This is the push half of the renderer SDK; the pull half is `useHostChannel` (request/response over `registerHandler`).

**Targeting a single panel instance.** `postToPanel(channel, payload, panelId?)` takes an optional third argument. Omit it (or pass `null`) to broadcast to every open instance of the panel kind — every renderer subscribed via `window.electron.plugin.on(pluginId, channel, …)` / `usePluginEvent` receives the payload. Pass a non-empty `panelId` string to target one instance: only the renderer subscribed via `window.electron.plugin.onPanel(pluginId, channel, panelId, …)` (or the SDK's `usePluginPanelEvent`) receives it, so two open instances of the same panel kind no longer both get every push. An empty-string `panelId` rejects the returned Promise, like the channel check. `usePluginEvent` does **not** filter by `panelId` — it is the broadcast subscription, and it never receives a targeted push. Use `usePluginPanelEvent(pluginId, channel, panelId, cb)` (or the raw `plugin.onPanel(pluginId, channel, panelId, cb)`) with the `panelId` prop your view was handed. The two are disjoint: a broadcast reaches only `usePluginEvent` subscribers, a targeted push only `usePluginPanelEvent` ones.

### Push delivery

`postToPanel` and `broadcastToRenderer` share one transport, and what it promises is:

- **Batched per macrotask, per renderer.** Pushes made in the same task reach a renderer as one IPC message (at most 256 entries and 1 MiB per message; a larger flush goes out as several consecutive messages). Batching only removes per-message overhead: nothing is merged, coalesced or dropped to save work, so a thousand pushes are a thousand callbacks. Coalescing is the producer's job, or the view's (`useThrottledCallback`, `useStreamBuffer`).
- **Ordered.** A renderer sees pushes in the order they were made, across every plugin and channel on the transport. Anything else the host sends a renderer on your behalf — a toast, a prompt, a dispatch, a panel reload, a badge, a decoration invalidation — first delivers the pushes you made before it, so a toast never overtakes the panel update that preceded it.
- **Snapshotted at the call.** The payload is size-checked and structured-cloned when you call, not when the batch flushes, so mutating and re-posting one object sends two distinct values. An uncloneable payload fails the call that made it rather than a whole batch later.
- **Scoped, and targeted to the owner.** A broadcast goes to every renderer in your binding's scope — the bound project's views for a project plugin, every renderer for an app-global one. A targeted push goes only to the renderer that holds that panel, so other project views never deserialize it (the preload still filters by `panelId`). A panel not yet reported by its renderer falls back to the scope, never wider.
- **Dropped only with nowhere to go.** A push is lost when no live renderer is in scope, when it targets a panel that was reported removed at least two seconds earlier and that no renderer holds (the grace covers a panel moving between renderers), or when IPC itself refuses to serialize that one entry, which is logged.
- **No ordering against invoke results.** A push and an `invoke` reply travel different paths, so a view can receive a push the worker made after answering its pull before the answer itself, or the reverse. Subscribe first, then pull, and tag both with a revision so the view keeps the newest; `createSyncedCollection` and `useSyncedCollection` implement exactly that for a keyed list.

Delivery never depends on [listener hints](#listener-hints--haslisteners-ondidchangelisteners): there is no replay, so a push filtered on a renderer's listener report — which always lags the renderer — would be lost for a subscriber that registered a moment later.

### Listener hints — `hasListeners`, `onDidChangeListeners`

```ts
const produce = () => {
  if (host.hasListeners?.("build-log") === false) return; // nobody is looking; a view pulls on mount
  host.postToPanel("build-log", nextChunk());
};
const off = host.onDidChangeListeners?.("build-log", (listening) => {
  if (listening) startTailing();
  else stopTailing();
});
```

`host.hasListeners(channel)` answers whether any renderer this host pushes to may currently be subscribed to `channel`, through `window.electron.plugin.on` / `onPanel` or the SDK hooks built on them. It is a hint for the producer only — the host delivers every push whatever it says — and it errs towards `true`: a renderer that has not reported its subscriptions yet counts as listening, and in a worker the first read for a channel answers `true` until main's first report for it arrives a moment later. It answers `false` once the plugin is unloaded, and it is synchronous and cheap enough to read on every produce. `channel` is validated like `postToPanel`'s, and an invalid one throws.

A push you skip because it said `false` is gone for good, and a view can subscribe the moment after you read it. Only skip work a view can recover by pulling state when it mounts — the way a synced collection's snapshot does — never a one-off event.

`host.onDidChangeListeners(channel, callback)` calls `callback(false)` when the last subscriber anywhere in scope goes away and `callback(true)` when one appears. It is not called with the current value; read that with `hasListeners`. It returns its disposer synchronously, and every registration is removed when the plugin unloads. Neither method is revoke-guarded or capability-gated.

**Idle disposal.** A live `onDidChangeListeners` registration is an event subscription like `onDidChangeWorktrees`: while one exists, an idle worker is not disposed, because a disposed worker could not be called back. Reading `hasListeners` never holds the worker. So a plugin that only wants to pause work reads `hasListeners`; one that must resume on its own when a view opens registers the callback and accepts that its worker stays up.

Both are optional in the type so hand-written `PluginHostApi` fakes keep compiling; Daintree's host, the worker host and `createMockHost` always provide them. A worker watches at most 256 channels this way; past that, `hasListeners` answers `true`.

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

It projects the host's already-polled worktree changes (the same data driving the dashboard) — reading it does NOT shell out to a fresh `git status`. The internal git vocabulary is collapsed to the five states above (copied → `added`, conflicted → `modified`, ignored dropped); `files` is sorted by path and the whole projection is frozen. For a fresh status read or a diff, use `host.git` (below), which runs a real query against the worktree.

All snapshots are frozen — attempting to mutate one throws. Fields are an explicit allowlist; adding a new field requires a Daintree SDK release.

Subscriptions registered during `activate` — before Daintree's worktree service is ready — are queued and replayed once the service comes online. Your callback never misses events.

**Both worktree subscriptions coalesce by default.** The host re-emits the worktree set on every git-status poll, so with no options a burst becomes one callback 100 ms after it goes quiet, and a burst that never does still delivers every 400 ms. `onDidChangeActiveWorktree` then delivers the worktree active at the end of the burst; `onDidChangeWorktrees` delivers the latest list. Pass `{ debounceMs: 0 }` to receive every event, or another window as described under [`PluginHostApi`](#pluginhostapi).

`onDidChangeWorktrees` also hands its callback a second argument saying what changed since the previous delivery to that same subscription, as snapshot `id`s:

```ts
await host.onDidChangeWorktrees((worktrees, { added, removed, changed }) => {
  if (added.length + removed.length + changed.length === 0) return; // the same set, re-sent
  for (const id of removed) cache.delete(id);
  for (const w of worktrees) if (added.includes(w.id) || changed.includes(w.id)) cache.set(w.id, w);
});
```

The host computes it from the list it last delivered, so a coalesced burst reports its net change (a worktree added and removed within one window is in neither list), and the first delivery compares against an empty set, so every worktree is `added`. A worktree is `changed` when any field of its snapshot differs — branch, the current and main flags, ahead/behind counts, mood, activity and creation times, the linked issue/PR, or its status counts and changed files.

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
| `terminalId` | The terminal the transition came from — the same id `agents.list()` reports and `sendToAgent` takes. Absent when the host could not attribute the transition to a terminal. |
| `workspaceId` | The workspace (project or scratch) that owns that terminal. Opaque: compare it, don't parse it. A project plugin only ever sees its own project's id. Resolved when the transition arrives; absent when the host could not tell which workspace owned the terminal then, e.g. one already torn down. A project plugin never receives a transition it can't attribute to its own project. |
| `state` / `previousState` | `idle` \| `working` \| `waiting` \| `directing` \| `completed` \| `exited`. |
| `running` | Convenience flag — `true` while the session is doing in-flight work (`working` / `waiting` / `directing`). Derived from the host's own `ACTIVE_AGENT_STATES` set so you don't re-maintain the membership list. |
| `waitingReason` | `prompt` \| `question` \| `approval` \| `error`. Present only when `state === "waiting"`. |
| `sessionCost` / `sessionTokens` | Cumulative for the session. Present only on `completed` / `exited` transitions. |
| `timestamp` | Epoch milliseconds when the transition was committed. |

`terminalId` and `workspaceId` say where a transition came from, so an installed plugin, which observes every project, can tell which agent needs attention and join the event to an `agents.list()` entry. The ids add no targeting: `agents.list()` and `sendToAgent` still cover only the plugin's own project (the focused one for an installed plugin), so a transition from another workspace has no matching pane there, and neither does an agent that has exited. Nothing else about the terminal comes with them: the snapshot omits the worktree id, `cwd`, the detector internals (`trigger`, `confidence`, …) and all terminal content, so it is safe to send off the machine. And it is **observation only** — nothing here drives, pauses, or resumes a session.

**Treat the state as an observation, not a fact.** Agent state comes from passive PTY output heuristics and is frequently wrong. Surface what the host saw; don't build a control flow that assumes it.

**Coalesced by default, per terminal.** Agents change state many times a second, so within one window (100 ms unless you pass `debounceMs`) only each terminal's latest transition is delivered: one callback per terminal, in the order of those latest transitions. The final state of every terminal always arrives; the transitions in between may be skipped, so a delivered snapshot's `previousState` is the state just before that last transition, not necessarily the one you were last told about. Pass `{ debounceMs: 0 }` to receive every transition.

`getAgentState` is NOT revoke-guarded (callable from timers, resolves `null` after unload); `onDidChangeAgentState` is — subscribe during `activate()`. A throwing listener is logged; see [Disposables](#disposables) for when it is unsubscribed.

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

Each event is `{ panelId, panelKindId, pluginId, phase }`. `panelKindId` is the runtime kind id — the value [`panelKindId(bareId)`](#identity--pluginid-plugininfo-panelkindid) returns: `{manifestId}.{bareId}` for an installed or built-in plugin, `project:{projectId}/{manifestId}/{bareId}` for a project plugin. `pluginId` is always your own.

| Phase | Meaning |
| --- | --- |
| `mounted` | A view for this panel is rendered. |
| `hidden` | The panel record is live but no view is mounted — a sibling pane was maximized, its dock tab is inactive, or a retry is loading. **Not** a close, and **not** a project switch: backgrounding a project view unmounts nothing. |
| `backgrounded` | The panel is at `location: "background"`. |
| `trashed` | Soft close. Recoverable from the trash bin, so it is not permanent disposal. |
| `restored` | One-shot edge out of the trash, emitted immediately before the phase the panel landed in. |
| `removed` | Terminal. The panel is gone and will not return under this id. |
| `render-failed` | The panel has no working view: the current attempt hit the host's error boundary, or the host stopped a view that kept calling `requestReload`. Clears when a retry starts or the user reloads the panel; the phases after that are the new attempt's. The failure detail stays in the renderer; only the fact of failure reaches you. |

**This is where durable resources belong.** A view's `disposeSignal` aborts for a temporary unmount exactly as it does for a permanent close, so a plugin that treats it as deletion tears down work the user still wants back. Keep spawned processes and long-lived sessions in the worker, keyed by `panelId`, and release them on `"removed"`.

On subscribe the host **replays the current phase of every live panel** of your plugin. That matters because plugins activate lazily — opening a view is usually what triggers `activate()`, so without replay you would never see that panel's `mounted`. One-shot transitions (`restored`) and terminal ones (`removed`) are not replayed.

A renderer being destroyed or evicted never synthesizes `removed`: a cached project view says nothing about whether the user closed the panel, and a false terminal event is the exact misreading this API exists to prevent.

**A project switch is not a phase change.** Switching away detaches and hides the outgoing project's `WebContentsView` without unmounting anything inside it, so as long as that renderer is retained, a panel in the project the user left keeps the phase it already had and you are told nothing in either direction. Reclaiming the renderer under memory pressure is silent too — no phase is synthesized for it — but the view the user comes back to is then a new mount, and that is reported. That is correct — the panel really is still there — but it means this is the wrong subscription to hang "refresh when the user comes back to this project" on, and so is `document.visibilityState`, which does not change for a backgrounded project view. The signal is main's own lifecycle broadcast, read in the view; see [Views → Project switches and staleness](./views.md#project-switches-and-staleness).

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

## `mcp.registerTools`

Binds the tool roster for an endpoint declared in `contributes.agentMcp`, which Daintree then serves to agents in its terminals over MCP, on the plugin's one server (`daintree-<mcpName>`) beside the host's read-only database tools when the plugin declares a database. Agents get the roster once the plugin's agent access is at **Read and write**. Requires the `mcp:expose` capability. This is the inbound direction — for a stdio server Daintree itself connects to, see [`mcpServers`](./contribution-points.md#mcp-servers--shipped). The end-to-end walkthrough, including when an agent actually receives the endpoint, is [Agent extensions → Agent MCP endpoints](./agent-extensions.md#agent-mcp-endpoints).

```ts
const dispose = await host.mcp.registerTools("ledger", {
  list_entries: {
    description: "List ledger entries, newest first.",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    outputSchema: { type: "object", properties: { entries: { type: "array" } } },
    async execute(args, caller, signal) {
      const limit = typeof args.limit === "number" ? args.limit : 20;
      return { entries: await readEntries(caller.projectId, limit, signal) };
    },
  },
});
```

**Signature:**

```ts
interface PluginMcpApi {
  registerTools(
    endpointId: string,
    tools: Record<string, PluginMcpToolDefinition>
  ): Promise<() => void>;
}

interface PluginMcpToolDefinition {
  description: string;
  inputSchema: PluginMcpJsonSchema; // { type: "object", ... }
  outputSchema?: PluginMcpJsonSchema;
  annotations?: PluginMcpToolAnnotations;
  execute(
    args: Record<string, unknown>,
    caller: PluginMcpCaller,
    signal: AbortSignal
  ): unknown | Promise<unknown>;
}

interface PluginMcpToolAnnotations {
  destructiveHint?: boolean; // MCP default true; only true is accepted
  idempotentHint?: boolean; // MCP default false
  openWorldHint?: boolean; // MCP default true; only true is accepted
}

interface PluginMcpCaller {
  readonly credentialId: string;
  readonly projectId: string;
  readonly terminalId: string;
  readonly launchAgentIdHint?: string;
}
```

All of these, plus `PluginAgentMcpContribution`, are exported from `@daintreehq/plugin-sdk`.

**Rules:**

- Revoke-guarded — call it during `activate()`. The tools' `execute` functions run for the plugin's whole lifetime; only binding the roster is restricted to the activation window.
- `endpointId` must name an entry in `contributes.agentMcp`; an undeclared id is rejected, because the plugin's server is built from the manifest and a roster for an undeclared endpoint could never be reached.
- The roster is validated whole and rejected whole, never trimmed: at least one and at most 16 tools (8 before Daintree 0.39.0, where a larger roster throws; set `engines.daintree` to `>=0.39.0` when registering more than 8 so an older host at least warns that the plugin may not work); names matching `^[a-z][a-z0-9_]{0,31}$`, other than the host's reserved `database_schema` and `database_query`; each description non-empty and at most 400 UTF-8 bytes; each schema a plain object with `type: "object"`, at most 8 KiB serialized. Only own keys of `tools` count. Schemas are snapshotted at registration, so mutating your schema object afterwards changes nothing an agent sees, and each tool's `execute` is captured then too.
- `annotations` are MCP tool hints advertised on `tools/list` as declared; omit one to leave the MCP default. Only `destructiveHint`, `idempotentHint` and `openWorldHint` are accepted, each a boolean, and any other key rejects the roster. Hints may only add caution: `destructiveHint: false` and `openWorldHint: false` are refused, as is `readOnlyHint` (or a `readOnly` field on the tool), because only the host may say a tool is safer than the MCP default and some clients ask less, or not at all, for one described that way ([Trust model → Agent MCP endpoints](./trust-model.md#agent-mcp-endpoints-mcpexpose)). `idempotentHint` takes either value, since no client gates approval on it. Hints are never checked against what `execute` does, and `destructiveHint: true` does not guarantee a client asks before calling.
- Each schema is compiled at registration and must be enforceable as written: valid JSON Schema 2020-12, or draft-07 when it declares `"$schema": "http://json-schema.org/draft-07/schema#"`, in one dialect throughout; every `$ref` it follows resolving within the schema itself, never to a remote or other document; no `$dynamicRef`, `$recursiveRef` or `$async`; and every `format` one Daintree knows (the `ajv-formats` set). Anything else rejects the roster, naming the tool and field. Keywords beside a `$ref` are applied in both dialects, and vendor keywords such as `x-` keys are ignored.
- Calling it again for the same `endpointId` replaces the roster; connected agents are sent `notifications/tools/list_changed`, and a call still running against the old roster is aborted. The replaced roster's disposer becomes inert.
- Returns a disposer that unbinds this roster. Every roster is dropped when the plugin unloads.

**Errors.** For a builtin, every one of these throws synchronously at the call site, like the other activation-window methods:

- `PERMISSION_REQUIRED: plugin "…" mcp.registerTools requires "mcp:expose", which is not declared in manifest.capabilities` when the capability is missing. In practice the manifest gate already rejects `contributes.agentMcp` without `mcp:expose`, so this fires only for a plugin that declares no endpoint at all.
- An undeclared-endpoint error, or a roster error naming the tool and the limit it broke.
- A revoked-host error when called after `activate()` resolves or times out.

In a worker plugin — every installed and project plugin — only the revoked-host and roster errors throw at your call site; the promise then resolves. The capability and declared-endpoint checks run afterwards in main, where the manifest lives, and a failure there fails activation with the error named. A `try`/`catch` around the `await` does not see it.

**What `execute` receives.**

- `args` — the arguments the agent sent, already checked against `inputSchema`. Nothing is coerced, defaulted or stripped: a call that does not match is answered with a tool error naming the failure (`MCP error -32602: Input validation error: …`) and never reaches `execute`. What a schema cannot express stays yours to check — path containment, ownership of the resource named, destructive intent. `pattern` regexes run in Daintree's main process against strings the agent chooses, so keep them simple and bound string lengths with `maxLength`.
- `caller` — frozen **provenance**, not identity. The credential was issued for one terminal launch in one project: `projectId` is that project, `terminalId` that terminal, `credentialId` a stable correlation id for the credential (never the credential itself, so it is safe to log), and `launchAgentIdHint` what the terminal was launched as. Any process that read the credential can present it, so treat `launchAgentIdHint` as a hint, not proof of what is calling. An installed plugin serves every project that enabled it from one instance, so scope its data by `caller.projectId`; a project plugin's `caller.projectId` is always its own project.
- `signal` — aborted when the call times out (60 seconds, counted from the request, activation included), when the agent cancels, when the session closes or the credential is revoked, and when the endpoint's roster is replaced or dropped. Once it aborts the host stops waiting: the agent is answered with a tool error (or its session is closed), and your eventual result is discarded. Nothing stops an `execute` that ignores the signal — it runs on until it returns.

**What the agent receives.** The return value is `JSON.stringify`-ed — `undefined` becomes `null`, and `toJSON` is honoured — and sent as the tool's text content. A worker plugin's result is serialized in the worker, before it crosses to main. A result over 256 KiB serialized, or one that cannot be serialized, becomes a tool error. With an `outputSchema`, the result must also serialize to a JSON object that matches the schema, which is sent as `structuredContent` as well; anything else is a tool error. A thrown error becomes a tool error carrying its message, truncated past 2,000 characters. A session may have at most 16 calls in flight; past that the agent gets a tool error asking it to retry.

The mock host records rosters in `registeredMcpTools`, but it has no manifest model, so it skips the `mcp:expose` and declared-endpoint checks and leaves the roster limits to the real host.

## `reloadPanel`

Ask the host to throw away one of your panels' views and mount a fresh one — the backend-side twin of a view's [`requestReload`](./views.md). Use it when the worker has finished work whose view should start clean, instead of restarting the worker, which rebinds every panel it owns and drops in-flight work. Panel ids come from [`onDidChangePanelLifecycle`](#ondidchangepanellifecycle).

```ts
await host.onDidChangePanelLifecycle(async (event) => {
  if (event.phase !== "mounted") return;
  // …later, when a heavy job for this panel finishes:
  const result = await host.reloadPanel(event.panelId);
});
```

It resolves with a `PanelReloadResult`, an acknowledgment of scheduling and nothing more: it never tells you the new view rendered or that memory was freed.

| Result | Meaning |
| --- | --- |
| `scheduled` | The view was mounted and a fresh attempt is queued. |
| `not-mounted` | The panel has no mounted view (hidden, backgrounded, trashed), or the host knows no such panel. Nothing is opened or focused; its next ordinary mount is already fresh. |
| `rate-limited` | The panel's reload budget is spent, or its view is already stopped for reloading too often. |
| `unavailable` | The host could not act: the panel's project view is cached, closed or unresponsive, the view is showing an error, your backend is restarting, or your plugin has unloaded. |

No capability is needed. You can only reach panels of kinds your plugin instance contributed — for a project plugin, only in its own project — and the host identifies you by your binding, never by an argument. An empty `panelId` rejects, and so does a panel that belongs to another plugin or to no plugin. Reloads share the per-panel budget of `requestReload`: three in any rolling 30 seconds, after which the view is stopped until the user reloads it. There is no kind-wide variant. `createMockHost` records calls in `reloadPanelCalls` and answers from the phases you push through `simulatePanelLifecycleChange`, or from a `reloadPanel` option you supply.

## `setPanelBadge`

Put a small live badge on the title chrome of one of your plugin's panels — a status dot or a short label — so per-worktree or per-agent state surfaces without the user opening the panel.

```ts
await host.setPanelBadge(panelId, { kind: "dot", color: "warning", tooltip: "2 checks failing" });
await host.setPanelBadge(panelId, { kind: "label", text: "3", color: "error" });
await host.setPanelBadge(panelId, null); // clear
```

A badge is either `{ kind: "dot" }` or `{ kind: "label", text }`, each taking an optional `color` (`"default"` / `"success"` / `"warning"` / `"error"` — you pick intent, the theme picks the pixel) and an optional `tooltip`. Label `text` is trimmed and must then be 1 to 6 characters (`PLUGIN_PANEL_BADGE_LABEL_MAX`); a longer one rejects rather than being truncated. `tooltip` is trimmed and must then be 1 to 200 characters. Both shapes are strict: an unknown key rejects.

Badges are keyed by `(pluginId, panelId)`, so two plugins never clobber each other's badge on the same panel, and all of a plugin's badges are cleared on unload. Not revoke-guarded — call it from timers and subscription callbacks; it becomes a silent no-op once the plugin unloads. An invalid `panelId` or badge shape rejects the returned Promise, so `await` it with a `.catch()` if you want the authoring mistake in your own logs.

## `dispatch`

Invoke an action by id through Daintree's `ActionService` with a `"plugin"` source — your own registered actions, actions from other plugins, or any built-in action — always through the audited, validated dispatch path.

```ts
const result = await host.dispatch("acme.linear-planner.sync-now", { team: "engineering" });
if (!result.ok) {
  // result.error.code: "RESTRICTED" | "CONFIRMATION_REQUIRED" | "PLUGIN_UNLOADED" | ...
}
```

Args are validated against the action's `argsSchema` by `ActionService`; the host does not re-validate. Actions classified `danger: "restricted"` reject with `RESTRICTED`; `danger: "confirm"` actions return `CONFIRMATION_REQUIRED` — plugins cannot bypass confirm-gating (there is no `confirmed` flag), and no dialog is shown, so a confirm-tier action can never be run through `host.dispatch`, your own included. Check [`actions.canDispatch`](#actions--built-in-action-catalog) first and route the user to the action instead. `dispatch` is NOT revoke-guarded; once the plugin is unloaded it returns `{ ok: false, error: { code: "PLUGIN_UNLOADED" } }` without dispatching. A renderer that does not answer within 30 seconds resolves `EXECUTION_ERROR` with the message `Plugin action dispatch timed out: <actionId>`.

`error.code` is an `ActionErrorCode`: `NOT_FOUND`, `VALIDATION_ERROR`, `RESULT_VALIDATION_ERROR` (the action ran but its result failed its own schema), `DISABLED`, `RESTRICTED`, `CONFIRMATION_REQUIRED`, `EXECUTION_ERROR`, `USER_REJECTED`, `CONFIRMATION_TIMEOUT`, `BINDING_STALE`, `PLUGIN_UNLOADED`, `TIER_NOT_PERMITTED`, `RESOURCE_NOT_OWNED`, `PARTIAL_SUCCESS` (something real was created before a later step failed; `details` says what), `TERMINAL_IN_OTHER_PROJECT`, `INVALID_URL`, and the legacy `ELICITATION_FAILED`, which is no longer produced. `error.message` is prose and `error.details` is optional.

### Targeting a project

By default an installed plugin's dispatch runs in whichever project is in front. An installed plugin that serves several projects can name one instead with `options.projectId` — ids come from `host.dispatch("project.getAll")`:

```ts
await host.dispatch(
  "agent.launch",
  { agentId: "claude", cwd, focusPolicy: "preserve" },
  { projectId }
);
```

The plugin must declare `project:dispatch`, and the user must turn on **Allow project targeting** in the plugin's Permissions tab. It is off by default and never prompts, so an unattended plugin fails fast: without the declaration or the switch the call rejects with `PERMISSION_REQUIRED` naming what is missing, and nothing is dispatched. With both, the action runs in that project's view without switching to it, and each targeted dispatch is recorded in the plugin audit log (target and action id, with an args hash, never the args). A backgrounded project still counts, and its view is woken for the call if it was frozen; a project with no open view rejects with `PROJECT_VIEW_UNAVAILABLE` — nothing opens it for you, so `project.switch` first if you need one. An empty or non-string `projectId` is refused rather than read as "no target". A project plugin may pass only its own project's id; any other is refused whatever the user has granted. The switch changes where an action runs, not which actions a plugin can dispatch.

A dispatch that times out is not cancelled: the action can still run after `dispatch` resolved with the timeout, so don't blindly retry a launch.

## `actions` — built-in action catalog

Discover what `dispatch` accepts and pre-flight a call, instead of hardcoding action ids and hoping. Projects Daintree's `ActionService` manifest to plugins.

```ts
const all = await host.actions.list(); // every dispatchable action (slim entries)
const entry = await host.actions.get("git.commit"); // single lookup, or null
if ((await host.actions.canDispatch("git.commit")) === "confirm") {
  // warn the user before dispatch triggers a confirm prompt
}
```

`list()` and `get(id)` mirror `ActionService.list()`/`get()`: `danger: "restricted"` actions are filtered out, so a plugin only ever sees `"safe"` or `"confirm"` entries (`get` returns `null` for an unknown or restricted id). `canDispatch(id)` returns `"ok"` for a safe action, `"confirm"` for one `dispatch` would reject with `CONFIRMATION_REQUIRED`, and `"restricted"` for an unknown or restricted id — use it to warn before you trigger a confirm dialog. `actions` is NOT revoke-guarded; after unload `list()` resolves `[]`, `get()` resolves `null` and `canDispatch()` resolves `"restricted"`.

Each entry is a `PluginActionManifestEntry`: `id`, `title`, `description`, `category`, `kind` (`"command"` / `"query"`), `danger` (the base rating, `"safe"` or `"confirm"`), `inputSchema` (JSON Schema for the args, absent when it takes none), `requiresArgs` (the schema rejects `{}`), and, when the action declares them, `keywords`, `examples` and `dangerRationale`. The type is exported from `@daintreehq/plugin-sdk` and `/testing`.

## `sendToActiveAgent` — inject text into the active agent

Send text to the currently-active agent terminal. Gated on the `agent:input` capability. This is the **sanctioned injection path** — the raw `terminal.sendCommand` action is closed to plugin dispatch, so plugins stop reinventing brittle `terminal.list` selection heuristics.

```ts
// Stage text for the user to review (default — no Enter appended):
await host.sendToActiveAgent("Summarize the failing test and propose a fix.");

// Run it immediately:
await host.sendToActiveAgent("/compact", { submit: true });
```

The host resolves the target itself among the agent terminals in scope — a project plugin's own project, or the focused project for an app-global one — ranking a visible terminal first, then a `waiting` one, then the one with the latest output. A `completed` or `exited` agent is never a target. `options.submit` defaults to `false` — the **stage-only**, default-safe mode: the text is pasted into the agent's input for the user to review and submit, with no Enter appended. Pass `{ submit: true }` to append Enter and execute immediately.

First use raises a just-in-time consent prompt (like `shell:exec`); a remembered grant covers later calls. `sendToActiveAgent` is NOT revoke-guarded — call it from timers and subscription callbacks — but it becomes a no-op once the plugin is unloaded. It throws `PERMISSION_REQUIRED:` if the plugin did not declare `agent:input` or the user denies consent, and throws on empty or whitespace-only text before the consent prompt. With no eligible agent, an app-global plugin's call throws `NO_ACTIVE_AGENT:`; a project plugin's resolves without sending anything and logs a warning, since it may only reach its own project's agents.

For handing a piece of work to an agent the user chooses, use [`sendToAgent`](#sendtoagent--hand-work-to-an-agents-draft) instead: it drafts where the user can see it and never submits.

## `sendToAgent` — hand work to an agent's draft

Put a piece of work — a card, a message, a row — into an agent's draft for the user to instruct the agent about. Gated on `agent:input`, with the same first-use consent prompt as `sendToActiveAgent`. It is draft-only by design: there is no `submit` option, nothing is ever sent to the agent until the user presses Enter, and it never waits for an agent to look idle.

```ts
// Let the user pick the agent (or start one):
const result = await host.sendToAgent(card.body, {
  title: card.title, // heading above the text in the draft, at most 120 characters
  worktreeId, // steers the picker — typically PanelViewProps.worktreeId
});

// Or straight into a pane you already know, e.g. from host.agents.list():
await host.sendToAgent(card.body, { terminalId, title: card.title });
```

**What lands in the draft.** One fenced block tagged `daintree-context`: a heading made of your plugin's display name and `title` (`Acme Board: Fix login redirect`), a blank line, then the text. It is appended after whatever the user has already typed — kept exactly as they left it, never replaced — starting on its own line after a blank one, and the caret is left on a fresh line after it. The heading's source name comes from the host, not from you, and is cut to one line of 80 characters. Text is at most 32,768 characters; line endings are normalised and control characters other than tab and newline are removed. The fence is longer than any backtick run in the content, and the input bar does not expand `@diff`, `@terminal` or `@selection` inside a `daintree-context` block on submit (it still does in fences the user writes), so the handoff reaches the agent literally, whatever it mentions. If the draft ends inside a code block the user left open, that block is closed first, so the handoff never lands inside it.

**Without `terminalId`** the user gets a picker of this project's agents, grouped by worktree, each marked with its last observed state ("Last seen working", "Last seen waiting" — read off the terminal, often wrong). It opens on a draftable agent in `worktreeId`, else on the focused agent. Two more rows start an agent for the handoff: **New agent here** launches the user's default agent in that worktree (it only appears when that worktree, the preselected agent's or the active one is in this project), and **New agent in new worktree** asks for a branch name (prefilled from `title`), creates the worktree, waits for its setup, launches the agent and drafts into it — the text is never passed as the launch prompt, which the agent would submit. If that setup fails, needs the user's approval or is still running after about two minutes, the handoff stops there and the refusal carries the new `worktreeId`. Once the user picks either row the launch is theirs: aborting your `signal` or unloading no longer cancels it, and the call resolves with what the launch actually did. Neither row appears while the input bar is off. Agents that cannot take a draft are listed, disabled, with the reason.

**With `terminalId`** there is no picker: the draft goes straight to that pane, or is refused. The call is atomic — aborting your `signal` or unloading does not cancel it, and it always resolves with what actually happened.

It resolves:

| Result | When |
| --- | --- |
| `{ status: "drafted", terminalId }` | The text is in that agent's draft. |
| `{ status: "cancelled" }` | The user dismissed the picker, or your `signal` aborted or the plugin unloaded while it was still open. |
| `{ status: "refused", reason, worktreeId? }` | Nothing was drafted. `worktreeId` names a worktree a failed "New agent in new worktree" had already created. |

`reason` is one of: `unknown-terminal`, `not-agent` (a shell, or an agent Daintree has no input bar for), `exited`, `input-bar-off` (the user's input-bar setting is off), `backend-unavailable`, `input-locked`, `restarting`, `input-busy` (dictation is about to submit that draft), `not-in-grid` (docked or backgrounded), `fleet-armed` (Enter there would broadcast to a fleet), `launch-failed` (a new agent or its worktree didn't come up), `project-unavailable` (your project has no open view, or it didn't take a targeted call within 10 seconds — in which case nothing was drafted), `prompt-open` (you already have a picker or prompt open — one at a time, as with `showQuickPick`; a targeted call is never blocked by one), or `busy` (eight targeted calls from your plugin are already in flight). The user sees the reason for a refusal about their agent — every reason up to `launch-failed` — in the same moment; `project-unavailable`, `prompt-open` and `busy` are only reported to you, so tell the user yourself if it matters.

It never moves focus: a small receipt names the agent the text went to. A project plugin only reaches its own project's panes; an installed plugin reaches the project the user is looking at. It throws `PERMISSION_REQUIRED:` without `agent:input` or on a denied consent, and throws on blank or oversized text, an over-long title, a `terminalId` or `worktreeId` that is empty or longer than 512 characters, or an option of the wrong type — all checked before the consent prompt. NOT revoke-guarded.

**From a view.** A view has no host object; add a handler in your worker and `invoke` it — the call is gated and bound on the worker's host, where your plugin's identity is not something a view asserts:

```js
// worker
host.registerHandler("sendToAgent", (_ctx, { text, title, worktreeId, terminalId }) =>
  host.sendToAgent(text, { title, worktreeId, terminalId })
);
// view
const result = await window.electron.plugin.invoke(pluginId, "sendToAgent", {
  text: card.body,
  title: card.title,
  worktreeId: props.worktreeId,
});
```

Dragging a card onto an agent terminal needs no worker at all — see [Views → Handing work to an agent by drag](./views.md#handing-work-to-an-agent-by-drag).

## `agents.list` — the project's agent panes

```ts
const agents = await host.agents.list();
// [{ terminalId, title, agentId, worktree: { id, name, branch? } | null,
//    observedState?, isFocused, canDraft, draftRefusal? }]
```

The live agent panes in this plugin's project, in grid order — the same set the `sendToAgent` picker offers. Exited and demoted agents are left out; a docked or locked agent is listed with `canDraft: false` and its `draftRefusal`. `observedState` is the agent state Daintree last read off the terminal: an observation, often wrong, never a promise about what the agent is doing. Gated on `agent:read`; resolves `[]` when the project has no open view or the plugin has unloaded. NOT revoke-guarded.

## `agents.listAll` — every agent in every open project

```ts
// Subscribe first, then read, so no change between the two is missed.
await host.onDidChangeAllAgents((snapshot) => render(snapshot));
render(await host.agents.listAll());
// { agents: [{ workspaceId, workspaceKind: "project" | "scratch", terminalId,
//              worktreeId?, title?, agentId?, observedState? }],
//   degraded, lastSuccessfulAt }
```

Every agent run across every open project and scratch, answered by main — so a project whose view is not loaded still shows up, which `agents.list` cannot do. The same set the All agents view shows: exited and demoted agents are left out. `observedState` is the agent state Daintree last read off the terminal: an observation, often wrong, never a promise about what the agent is doing. `title` is the pane's own title, not the composed one its header shows; `worktreeId` is an id only. `terminalId` is what `sendToAgent` takes, but it is not a lasting identity — a restarted pane can come back under the same id.

An empty list only means "no agents" when `degraded` is `false`. `degraded: true` means the host could not read every terminal, so `agents` is the last complete view — show it as stale. Before the first read, and after the plugin unloads, `listAll` answers `{ agents: [], degraded: true, lastSuccessfulAt: null }`: "can't tell", not "nothing running".

Gated on `agent:read`, and only for installed and built-in plugins. A project plugin is scoped to its own project everywhere else, so both calls throw `PERMISSION_REQUIRED:` for one — in a worker, `listAll` rejects with it, while a refused `onDidChangeAllAgents` is logged by main and resolves a disposer that never fires, like every worker subscription. `listAll` is NOT revoke-guarded; subscribing is.

`onDidChangeAllAgents` fires with the whole new snapshot, frozen, when a run is added or removed or one's state, title or worktree changes, and when the host loses or regains sight of the fleet. There is no initial callback. A callback can repeat the previous snapshot, when something the plugin cannot see changed. Coalesced to the latest snapshot by default ([`PluginHostSubscriptionOptions`](#pluginhostapi)). In process it throws `FLEET_UNAVAILABLE:` if the host is not tracking agents at all.

## `terminals.readScreen` — what a terminal shows

```ts
const screen = await host.terminals.readScreen(terminalId, { lines: 12 });
switch (screen.status) {
  case "ok": // screen.text, screen.lineCount, screen.truncated
  case "exited": // the process exited; the pane may still be open
  case "not-found": // no terminal this plugin may read has that id
  case "unavailable": // could not read it right now; try again later
}
```

The terminal's current screen as plain text: its last `lines` lines (1–100, default 20; a line soft-wrapped across rows counts once) with blank padding trimmed and no ANSI, never its scrollback or the serialized buffer. A blank screen is `{ status: "ok", text: "", lineCount: 0 }`, so an empty screen is never confused with a missing terminal. `truncated` is `true` when lines above the returned ones, or text past the 16 KiB cap, were left out; the newest content is kept. Take ids from [`agents.list`](#agentslist--the-projects-agent-panes).

It is answered in main from the terminal host's own copy of the screen, so a terminal in a project whose view is closed still reads. A project plugin reads only its own project's terminals; an installed plugin may read any user terminal by id. An unknown id, one in another project and one that is not a user terminal all answer the same `not-found`. Nothing about the terminal changes: no input, no resize.

Gated on `terminal:read`, which `agent:read` does not imply, with a first-use consent prompt telling the user the plugin can read what their terminals show. Arguments are checked before the prompt. Calls are limited to 60 a second per plugin — a grid polling twenty cards once a second uses a third of it — and a call past that throws `RATE_LIMITED:` at once rather than waiting. Resolves `unavailable` once the plugin is unloaded. NOT revoke-guarded, so poll from a timer.

The host does not log or store the text. Treat it as a secret: terminals show tokens, env dumps and customer data, and once it reaches your plugin, keeping it on the machine is your code's job.

The `terminal.getOutput` and `terminal.copy` actions, and `terminal.getStatus` with `includeOutput`, are closed to plugin dispatch; `readScreen` is the plugin path to terminal text.

## `logger`

Structured diagnostic logger backed by a bounded per-plugin ring buffer (most recent ~500 entries) in the main process.

```ts
host.logger.info("Synced 12 issues", { team: "engineering" });
host.logger.warn("Rate limited, backing off");
host.logger.error("Token expired");
```

Lines are mirrored to the host console prefixed with `[plugin:{pluginId}]` and retained so they can be folded into an error report on demand; the retained lines are also listed in the plugin manager's detail pane. The ring keeps the newest 500 entries. Each line is the message plus its serialised `fields`, with secrets scrubbed, cut to 2048 code points. `warn` and `error` lines are also written to `daintree.log`, without `fields`, cut to 1000 characters and rate-limited per plugin; `info` stays in the ring. Calls return `void` and never reject. In process an unserializable `fields` payload is coerced to a string rather than thrown; in a worker the call is posted over a `MessagePort`, so a `fields` value that cannot be structured-cloned (a function, a class instance with methods) throws `DataCloneError` synchronously — log plain data. `logger` is NOT revoke-guarded; writes become a silent no-op after unload.

## `settings`

User-facing configuration: declared in [`contributes.settings`](./contribution-points.md#settings-schema--shipped), rendered as a form in Settings, and read by your code. For state the user never edits, use [`storage`](#storage--private-keyvalue-storage). No capability and no consent.

```ts
const token = await host.settings.get<string>("apiToken"); // declared default while unset
await host.settings.set("defaultTeam", "engineering");

// In activate(): subscribing is revoke-guarded
const dispose = await host.settings.onDidChange("apiToken", (value) => reconnect(value));

// Gate on setup, then take the user straight to what's missing
const missing = await host.settings.missingRequired(); // e.g. ["apiToken"]
if (missing.length > 0) await host.settings.open(missing[0]);
```

| Member | Notes |
| --- | --- |
| `get(key, scope?)` | The stored value; while nothing is stored, the key's declared `default` (a fresh copy each call), or `undefined` when it declares none. A stored `null` reads as `null`. |
| `set(key, value, scope?)` | Rejects `undefined` and anything `JSON.stringify` cannot represent; the value is stored as its JSON round-trip, so `NaN` becomes `null`. When the manifest declares any settings, an undeclared key is rejected. `set` does **not** check the declared `type`, `min`/`max` or enum `options` — the form enforces those, so validate your own writes. There is no delete: only the user can clear a value, from the form. |
| `onDidChange(key, cb, scope?)` | Revoke-guarded. Fires after a `set` or a form edit that changes the stored JSON, with the new value — or with the declared `default` when the user clears it. A subscription is keyed by key and scope only, so an installed plugin's `"project"` or `"local"` subscriber also fires for a write made while another project was active. An edit made to the file outside Daintree never fires it. |
| `open(key?)` | Shows your settings where they live and, when `key` names a declared setting, scrolls to it and highlights it briefly. See below. |
| `missingRequired()` | Your declared `required: true` settings that are still unset, in manifest order. See below. |

**Scopes.** A key's scope is set once, in its declaration:

| Scope | Stored at | Use for |
| --- | --- | --- |
| `"user"` (default) | `~/.daintree/plugin-settings/{pluginId}.json` | One value for every project. |
| `"project"` | `<projectRoot>/.daintree/plugin-settings/{manifestId}.json` | A value committed with the repository, shared by every clone. |
| `"local"` | `~/.daintree/plugin-settings/local/{projectId}/{pluginId}.json` | Per project and per machine, never committed — an interpreter path, a local port. |

`{pluginId}` is the instance id (for a project plugin it encodes the project); the committed file uses the manifest id so no machine-local id reaches the repository. Files are written atomically with mode `0600` on POSIX.

Keys are non-empty strings; anything else throws. Leave `scope` out and `get`, `set` and `onDidChange` all use the key's declared scope — `"user"` for an undeclared key — so the manifest is the one place a scope is written down. An explicit scope that conflicts with the declaration throws. `get` and `onDidChange` accept an undeclared key; `set` refuses one once the manifest declares settings.

A project plugin's `"project"` and `"local"` scopes always mean its own project. An installed plugin's resolve the active project at call time, so they follow project switches; with no project active, `get` returns the declared default and `set` throws.

**Changes on disk.** Every read checks the file's identity (inode, size, modification time), so a `git pull` or branch switch that rewrites the committed project file is picked up by the next `get`, and the next `set` merges into the fresh file rather than writing a stale copy back. No `onDidChange` fires for such a change — re-read when it matters (for example on [`onDidWake`](#ondidwake) or when a panel mounts).

**Secrets.** A `type: "secret"` setting is encrypted at rest through the OS keychain (Electron `safeStorage`); the API is unchanged. A secret is never stored under the project root: a `"project"`-scoped secret is still read, written and subscribed to as `"project"`, but its value lives in the `"local"` file, so it is never committed and each collaborator enters their own. With no keychain available — a headless Linux box, or Chromium's `basic_text` backend — `set` rejects rather than storing plaintext, and the form says secrets can't be saved. Keep secrets to strings: a number or object reads back from `get` as its JSON text, while `onDidChange` delivers the value you passed. Non-secret settings are plaintext JSON — never put a credential in one.

**`open(key?)`.** Don't build a settings screen into a panel; send the user to the one home your settings already have. An installed plugin's `"user"` settings open in the plugin manager; a project plugin's settings, and any `"project"` or `"local"` key, open in Project settings → Plugins — in the project plugin's own window. An undeclared `key` is ignored. It resolves once the request reaches the renderer, and rejects when no window can show it, when the destination is Project settings and no project is open, or once the plugin has unloaded. It is the same `plugin.openSettings` action your panels' **Plugin settings…** menu entry dispatches.

**`missingRequired()`.** A declared `default` never counts as set; a stored `null` or `""` counts as unset; a secret counts once a value is stored (checked without decrypting it); a `"project"` or `"local"` key with no project to read is missing; and a key whose file can't be read is listed too, since you couldn't read it either, without hiding the others. While the list is non-empty, your open panels and surfaces show a "needs setup" strip above their content that opens the setting, so a panel doesn't need to draw its own.

**Your own settings view.** A setting declared `editor: "view"` is left out of the generated form and edited by your `location: "settings"` view instead, through the same `get` and `set` — see [Views → A settings section](./views.md#a-settings-section).

## `storage` — private key/value storage

The machine-owned counterpart to `settings`: persist a plugin's own working state without declaring every key in `contributes.settings` and without it surfacing in the settings UI.

```ts
await host.storage.set("lastSyncCursor", cursor); // scope defaults to "user"
const cursor = await host.storage.get<string>("lastSyncCursor");
await host.storage.delete("lastSyncCursor");

// Per-worktree state that tracks the active worktree:
await host.storage.set("draft", text, "worktree");
```

Three scopes — `"user"` (default), `"project"`, `"worktree"` — stored as plaintext JSON at `~/.daintree/plugin-storage/{pluginId}.json`, `<projectRoot>/.daintree/plugin-storage/{manifestId}.json`, or `<worktreePath>/.daintree/plugin-storage/{manifestId}.json` (`chmod 0o600` on POSIX). **No secret encryption — never store credentials here** (use a `type: "secret"` setting for those). The `"project"` / `"worktree"` scopes resolve at call time — for an installed plugin the active project and worktree, for a project plugin its own project and that project's active worktree: `get` and `delete` are a no-op (returning `undefined` / void) and `set` throws when no project / worktree is active. Keys are non-empty strings. `set` rejects `undefined` and non-JSON-serializable values. `onDidChange(key, cb, scope?)` fires on in-process writes only — with the new value, or `undefined` after a `delete` — and is keyed by key and scope, not by project or worktree, so a `"worktree"` subscriber fires for that key in whichever worktree was written. It is the one revoke-guarded member — subscribe during `activate()`. The rest of `storage` is NOT revoke-guarded.

**Changes on disk.** As with settings, every read checks the file's identity, so a `"project"` or `"worktree"` file rewritten by `git pull`, a branch switch or an agent is picked up by the next `get`, and the next `set` merges into the fresh file. No `onDidChange` fires for such a change.

**Reads stay fresh across a scope switch.** Storage is read through a per-path cache, but the host keeps it coherent for you. When the active worktree changes, the host invalidates the cache for `"worktree"`-scoped entries, so the next `get` reads the new worktree's file rather than a stale value. `"project"` scope is implicitly fresh — a different project resolves to a different file path, hence a different cache entry — and `"user"` scope is process-global and never evicted. You never have to manage cache invalidation yourself.

## `db` — host-managed SQLite

Structured data for a plugin that is really an application — a ledger, a CRM, a stock list — without reimplementing path containment, connection policy and change detection in every plugin. Declare the database in [`contributes.databases`](./contribution-points.md#databases--shipped), then open it by id:

```ts
const db = await host.db.open("ledger", {
  migrations: [
    `CREATE TABLE tx (
       id INTEGER PRIMARY KEY,
       date TEXT NOT NULL,          -- YYYY-MM-DD
       amount_cents INTEGER NOT NULL,
       category TEXT NOT NULL,
       memo TEXT
     )`,
    `CREATE INDEX tx_date ON tx (date)`,
  ],
});

const rows = await db.query("SELECT * FROM tx WHERE date >= ? ORDER BY date DESC", ["2026-09-01"]);
await db.run("INSERT INTO tx (date, amount_cents, category) VALUES (:date, :cents, :cat)", {
  date: "2026-09-26",
  cents: -4250,
  cat: "meals",
});

// Fires for this handle's own commits AND for commits by anything else —
// typically an agent in the project's terminal running `sqlite3` on the file.
db.onDidChange(() => void host.postToPanel("ledger-changed", null));
```

The queries run in your plugin's own process, over the runtime's built-in `node:sqlite`; only the location is resolved by the host. Every method returns a Promise except a handle's `onDidChange`, which returns its disposer directly. `host.db` is not revoke-guarded; open handles close when the plugin unloads or reloads.

| Member | Notes |
| --- | --- |
| `db.resolve(id, { readonly? })` | The declared database's `{ id, location, path, projectRelativePath, journalMode }` without opening it — hand `path` (or `projectRelativePath`) to agents. By default it prepares the location for writing: it creates the directory and, for a `"project"` database, raises the write consent the first time. With `readonly: true` it only locates an existing file (`DB_NOT_FOUND` otherwise). |
| `db.open(id, { migrations?, definitions?, readonly? })` | Resolves as above, creates the file if needed, applies the policy and schema below, and returns a handle. `DB_NOT_DECLARED` for an id not in `contributes.databases`. |
| `readonly: true` | Creates nothing, asks for no consent, and refuses `run`, `exec` and `transaction` with `DB_READONLY`; SQLite itself refuses a write a query attempts. It cannot be combined with `migrations` or `definitions` (`VALIDATION`), and a missing file rejects `DB_NOT_FOUND`. SQLite may still add `-wal` / `-shm` sidecars when reading a file an agent switched to WAL mode. The mode for a dashboard over data agents write. |
| `query(sql, params?)` / `get(sql, params?)` | All rows / the first row (or `undefined`), as plain objects keyed by column name. `params` is an array for `?` placeholders or an object for `:name`, `$name`, `@name`; values are `string`, `number`, `bigint`, `null` or `Uint8Array`. |
| `run(sql, params?)` | One statement that returns no rows; resolves `{ changes, lastInsertRowid }`. |
| `exec(sql)` | One or more statements with no parameters. |
| `columns(sql)` | The result columns (`name`, source `table` / `column`, declared `type`, each `null` for an expression) without running the statement — headers for a result with no rows. |
| `transaction(fn)` | `BEGIN IMMEDIATE`, `fn(tx)`, `COMMIT` — rolled back if `fn` throws. Use the `tx` you are handed: calling the outer handle inside `fn` waits for the transaction and deadlocks. `tx` is a `PluginDatabaseStatements` — `query`, `get`, `run`, `exec` and `columns` only, so no nested `transaction`, `backup`, `onDidChange` or `close`. |
| `backup(destPath)` | A consistent snapshot, resolved as `{ path, bytes }`. See [Backups](#backups). |
| `onDidChange(cb)` | `cb({ origin: "self" \| "external" })`, at most once per 50 ms window. Returns a disposer. A `cb` that is not a function throws `VALIDATION`. |
| `id`, `location`, `readonly` | The id, the frozen resolved location, and whether the handle is readonly. |
| `close()` | Idempotent; waits for queued calls. Any later call rejects `DB_CLOSED`. |

**Where the file lives.** A `"project"` database defaults to `<projectRoot>/.daintree/data/{manifestId}/{id}.db`, or the declaration's `path`; only a project plugin can declare one, and it must declare `fs:project-write`. A `"local"` database is `databases/{id}.db` inside your plugin data directory, out of the repository.

**Open it lazily.** A `"project"` database is a file in the repository, so the first writable `open` (or `resolve`) raises the same one-time `fs:project-write` consent prompt as a first `host.fs.writeFile`, before the host creates the directory or the file. Do not await it inside `activate()` — a prompt the user has not answered yet would run the activation past its 5-second budget. Open it from the first handler that needs it and keep the promise, dropping it if the open fails so a declined prompt can be asked again: `let ledger; const db = () => (ledger ??= host.db.open("ledger", { migrations }).catch((err) => { ledger = undefined; throw err; }));`. A `"local"` database and a readonly open need no consent.

**What the host does on open.** Resolves the path against your bound project root (or your data directory for `"local"`), refusing a symlinked ancestor that escapes it, a path inside `.git` (`PATH_NOT_ALLOWED`), a symlinked file (`TARGET_IS_SYMLINK`) and anything that is not a regular file (`TARGET_UNAVAILABLE`); a `"project"` database for a plugin with no project rejects `PROJECT_UNAVAILABLE`. It opens the file with foreign keys enforced and a 5-second busy timeout, and — on every writable open — sets the declared journal mode, so an agent that ran `PRAGMA journal_mode=WAL` cannot leave committed data in a `-wal` sidecar that a commit of the `.db` alone misses. Then it runs your migrations: migration `n` (0-based) runs when `PRAGMA user_version` is `n`, in its own `BEGIN IMMEDIATE` transaction, and bumps the version to `n + 1`; the version is read under the write lock, so two processes opening the file at once never both run a migration. Append new migrations; never edit or reorder a shipped one. A file whose version is higher than your list was written by a newer copy of the plugin and is refused (`DB_SCHEMA_TOO_NEW`) rather than guessed at. A failed migration is rolled back and rejects `DB_MIGRATION_FAILED`.

**`definitions`** is SQL applied after the migrations, in one transaction, whenever its text differs from what the file last received — the home for views and triggers, which you want to change freely without a numbered migration or a data wipe. Write it to be idempotent: `DROP VIEW IF EXISTS on_hand; CREATE VIEW on_hand AS …`. The host records a hash of the applied text in a small `_daintree_meta` table inside the database (created only when you use `definitions`), so an open with unchanged definitions never rewrites the file — a committed database does not show as modified just because a panel opened. The hash covers the schema version, so definitions are also re-applied on the first open after `user_version` changes — recreating a table in a migration drops its triggers — even when the process stopped between committing the migration and applying them. A view or trigger dropped by hand stays dropped until one of those happens. Tell agents in your data contract to leave `_daintree_meta` alone. A failure rolls back and rejects `DB_DEFINITIONS_FAILED`.

**Change detection.** An agent writing the file with the `sqlite3` CLI is a different process, invisible to your connection's own bookkeeping. While any `onDidChange` listener is attached, the handle watches the file's directory (checking 75 ms after the last filesystem event) and polls once a second; the watcher stops when the last listener is disposed. It compares `PRAGMA data_version`, which advances only when _another_ connection commits, and the file's device and inode, which change when the file is replaced by `git checkout`, `git stash` or a restore script. A replaced or deleted file is reopened transparently before the next statement — re-resolved and re-contained first, with the migrations run again (a deleted file is recreated, except by a readonly handle, which rejects `DB_NOT_FOUND` instead) — and announced as `"external"`, so a long-lived handle never keeps reading an unlinked inode. Your own commits announce themselves as `"self"`: `run`, `exec`, committed transactions, a write made through `query` (`INSERT … RETURNING`), and schema changes such as `CREATE VIEW` that change no rows. A rolled-back transaction announces nothing. A listener that throws is logged and stays subscribed.

**Changes are coalesced.** Every change within a 50 ms window — this handle's own commits and external ones alike — is delivered as one event at the end of the window, which opens at the first change rather than trailing the last, so a steady stream of writes still reports every 50 ms and 200 awaited inserts cost a handful of refetches rather than 200. A window that saw any external change reports `origin: "external"`; one that saw only this handle's commits reports `"self"`. The last change is always delivered, including one whose window is still open when the handle closes. Disposing the last listener drops a pending event.

**One statement per call.** `query`, `get`, `run` and `columns` compile exactly one statement; SQL after it (other than whitespace, semicolons and comments) rejects with `DB_MULTIPLE_STATEMENTS` instead of being silently dropped. Use `exec` for a batch. Queries run synchronously in your plugin's process: a runaway query stalls your plugin (never Daintree) until it finishes, and cannot be interrupted.

**One file per database.** SQL that would open or create another file is refused with `DB_STATEMENT_NOT_ALLOWED` on every handle, readonly included, and in `migrations`, `definitions` and `exec`: `ATTACH`, `DETACH`, `VACUUM INTO`, and `PRAGMA temp_store_directory` / `data_store_directory`. Those would reach files outside the declared location without the containment and consent the host applies to it. The connection also runs an authorizer that denies the same statements and the `load_extension()` function; a call to that function fails with SQLite's own "not authorized" error rather than a `DB_*` code, and `node:sqlite` never enables extension loading anyway. A plain `VACUUM` is fine. For a copy, use `backup`.

**Integers are exact.** An integer within ±(2^53 − 1) (`Number.MAX_SAFE_INTEGER`) comes back as a `number`; one outside that range comes back as a `bigint`, in rows and in `run`'s `lastInsertRowid`, rather than being rounded. A `bigint` does not mix with `number` arithmetic and `JSON.stringify` throws on it, so convert deliberately before serialising one. Bind a `bigint` parameter to write one. Store money as integer cents.

**Calls are serialised per handle.** A statement issued while a transaction is running waits for it, so a panel refresh can never read half of a multi-row write. Separate handles to the same file are separate connections and are not serialised with each other — SQLite's own locking and the busy timeout apply.

**`VALIDATION`** from `db` means an authoring mistake: empty `sql`, `params` that are neither an array nor an object, `migrations` that are not an array of strings, `definitions` that is not a string, a readonly open with either, a non-function `onDidChange` callback, an empty `backup` path, or a backup onto the database, its journal files or a journal-named file.

### Backups

`backup(destPath)` writes a consistent snapshot with SQLite's online backup, staged in a fresh `.daintree-backup-*` directory beside the destination and then renamed into place, so a reader or a sync client never sees a half-written copy. The destination is approved exactly like a `host.fs.writeFile` target — absolute, inside your declared roots or your data directory, the matching `fs:*-write` capability, first-use consent, no symlink leaf — and checked again just before the rename:

| Refusal | Code |
| --- | --- |
| The database itself, or one of its `-wal` / `-shm` / `-journal` files (by name, case-insensitively, or by identity) | `VALIDATION` |
| A name ending in `-wal`, `-shm` or `-journal` | `VALIDATION` |
| A symlink at the destination | `TARGET_IS_SYMLINK` |
| Something other than a regular file at the destination, or a directory on the way that moved after approval | `TARGET_UNAVAILABLE` |
| A `-wal`, `-shm` or `-journal` file already beside the destination — SQLite would replay it into the copy the next time it is opened | `DESTINATION_HAS_JOURNAL` |

It is the way to give a sync folder such as Dropbox a copy — never put the live file there. For a copy the user asks for, you need nothing: your panels' **Back up data…** menu entry does it for every declared database under the same rules (see [Databases](./contribution-points.md#databases--shipped)).

### Agents read and write it too

Agents reach a declared database three ways: they read it through the host's `database_schema` and `database_query` on the plugin's MCP server, they write it through your own [`agentMcp` tools](#mcpregistertools), which run through this same handle, and an agent without those tools — launched outside Daintree, or before the plugin's agent access was on — opens a `"project"` file directly with `sqlite3`. The contract agents see for the database tools is in [Agent extensions](./agent-extensions.md). Offer the tools, and design the database so the direct route is safe too:

- **Put integrity in the schema, not in your code.** Your tools are the validated path, but the `sqlite3` CLI does not enforce foreign keys unless a session asks for it, and agents never do, so a `REFERENCES` clause only binds your own writes. Use `CHECK` constraints and `BEFORE INSERT` / `BEFORE UPDATE` triggers with `RAISE(ABORT, '<what to do instead>')` — the agent sees the message and corrects itself.
- **Describe the schema where the agent will read it.** Column comments in the `CREATE TABLE` survive into `database_schema` and `sqlite3 <file> .schema`, which is the first thing an agent runs. Point to the file from your plugin's `AGENTS.md` by its `projectRelativePath`.

**What it does not do.** There is no remote or synced backend: the file is where the declaration says, and a sync folder should receive a copy, never the live file.

## `showToast`

```ts
await host.showToast({
  message: "Fetched 12 issues from Linear",
  type: "success", // "info" | "success" | "warning" | "error" — defaults to "info"
  durationMs: 4000, // optional; defaults to the app's per-type duration
});
```

The host prefixes `message` with your plugin's display name (`{displayName}: {message}`, falling back to the manifest `name`) so users can tell which plugin raised the toast — you don't add the prefix yourself. `message` is a string only, trimmed and then 1 to 2000 characters; `priority` and action buttons aren't exposed to plugins. `durationMs` must be a positive integer up to 60000 (60s). An empty message, an unknown `type`, an out-of-range `durationMs` or any other key rejects.

Toasts route through Daintree's standard `notify()` path, so quiet-hours and inbox-history semantics apply. The rate-limit bucket is scoped per plugin id and type (two plugins sharing a display name still get separate buckets), so a noisy plugin can't suppress another plugin's toasts (or system toasts). Audit your toasts against the four-question checklist (timely, helpful, not already visible, ignorable) — the host delivers what you ask for, it doesn't second-guess. There's no "sticky" or "action required" toast type — for persistent UI, register a panel view instead. A toast with an action button, or an Undo toast, comes from the view instead: [`useToast`](./ui-kit.md#hooks) in `@daintreehq/plugin-ui` routes through the same `notify()` path under the same limits, and its button calls straight back into the view.

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

**`showQuickPick(items, options?)`** resolves the chosen `PluginQuickPickItem`, or `undefined` on cancel. Each item is `{ id, label, description?, detail? }` — plain strings so it survives the structured-clone boundary; `description` renders dimmed after the label, `detail` on a second muted line. `matchOnDescription` widens fuzzy matching beyond `label`. Passing `canSelectMany: true` changes the resolved value to an array, and the overloads type that for you. Item ids must be non-empty and unique within the call; a duplicate throws. `options` also takes `title` and `placeholder`.

**`showInputBox(options?)`** resolves the entered string, or `undefined` on cancel. Options are `title`, `prompt`, `placeholder`, `value` (prefilled text), `password`, `validationPattern` and `validationMessage`. `validationPattern` is a regex **source string** enforced client-side at submit time (no per-keystroke IPC); an invalid pattern is ignored rather than blocking the user, so test yours. `password: true` masks the field.

**`showConfirm(options)`** resolves `true` on confirm, `false` on cancel, dismiss, or the plugin unloading while the dialog is open. `title` is required and must be a string; `message`, `confirmLabel`, `cancelLabel` and `destructive` are optional. For anything irreversible set `destructive: true` and give `confirmLabel` a verb-noun (`"Delete file"`), never a bare `OK` — the label is the last thing the user reads before committing.

**Where the dialog appears.** A project-bound plugin's prompt is delivered into that project's view, so the user finds it when they switch to that project — never wherever focus happens to be. If the bound project has no live renderer the call rejects with `PROJECT_VIEW_UNAVAILABLE` rather than landing somewhere else. See [Project-local plugins → Binding](./project-local.md#binding--which-project-a-host-call-reaches).

**One dialog at a time.** A plugin has at most one dialog open — the three prompts and a `sendToAgent` picker share the slot. A second request while one is open is never shown: it resolves its cancel value (`undefined` / `false`) at once, so a loop of prompts does not stack dialogs.

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

`host.process` lets a process- or task-orchestrator plugin (dev server, CI runner, watcher) spawn and supervise real child processes instead of hijacking a user terminal. It is **capability-gated twice**: a `spawn` from a plugin that did not declare `shell:exec` rejects with a `PERMISSION_REQUIRED:` error, and the first spawn a plugin actually makes raises a [just-in-time consent dialog](./trust-model.md#2-host-side-policy-input-load-bearing) the user must approve — a denial rejects with the same prefix. A remembered grant covers later spawns; built-in plugins skip the prompt. Concurrent first-use spawns coalesce onto one dialog rather than stacking. Argv is passed verbatim (no shell, so no shell-injection surface).

The returned `PluginProcessHandle` carries `id`, `kill()` (clean `SIGTERM`, then `SIGKILL` after a 3-second grace), `restart()` (respawns with the same command/args/cwd/env, reusing the id and bumping a restart counter), `onExit`/`onCrash` lifecycle subscriptions carrying the real exit code/signal — `onCrash` fires only on an unexpected (non-zero / signalled) exit you did not request — and `onData`, which hands your own code each output chunk as `{ stream, chunk }`. Each subscription returns its disposer. The child's stdout/stderr also stream to your panels over `postToPanel("process", …)` keyed by the handle id; subscribe with `plugin.on(pluginId, "process")` in your view and discriminate on the event `kind` (`stdout` / `stderr` / `exit` / `crash`, or `data` for the single merged stream a `"pty"` child produces).

Output produced before the first `onData` subscriber attaches is buffered — up to 64 KiB, oldest chunks dropped first — and replayed to that subscriber, so a child that greets the moment it starts is not missed; after that, delivery is live only. A process that has already ended keeps that buffer for 30 seconds. `onExit` and `onCrash` registered after the process ended still fire, with the recorded outcome.

| Spawn option | Notes |
| --- | --- |
| `args` | Passed verbatim. Entries that are not strings are dropped silently. |
| `cwd` | Defaults to the active worktree, then the host's cwd. Not contained to your `fs` scope. |
| `env` | Added to the minimal allowlist. Values that are not strings are dropped silently. |
| `mode` | `"pipe"` (default), `"duplex"` or `"pty"` — see [Modes](#modes). |
| `panelId` | Sends this process's panel events to one panel instead of broadcasting. `null` or omitted broadcasts; an empty string rejects. |
| `cols`, `rows` | `"pty"` only. The initial size, default 80 × 24; each must be a positive integer. |

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

**Output at exit.** In `"pipe"` and `"duplex"` mode the handle settles once the child's stdio has closed, or two seconds after it exits if the pipes stay open (a grandchild that inherited them), so the last lines a one-shot command prints arrive before `onExit` fires. A `"pty"` child settles on its own exit path.

Every spawned process is tied to your plugin's lifetime: on unload/disable/revoke the host SIGTERMs (then SIGKILLs) every outstanding process — a dev server can't leak past a reload. A plugin may have at most eight processes running at once; a `spawn` past the cap rejects with `PROCESS_LIMIT_REACHED` rather than queueing, and an exited process frees its slot. `process.spawn` is NOT revoke-guarded — call it from timers and subscription callbacks — but once the plugin unloads it rejects rather than spawning. Spawns are recorded in the plugin audit trail so process execution stays observable. The child does **not** inherit Daintree's full environment — only an allowlist of essentials (`PATH`, locale, temp, OS basics) plus whatever you pass in `env`, so the main process's tokens never leak to a `shell:exec` child; pass anything else the command needs explicitly. `cwd` is a process concern, not an `fs` scope — it is not contained to `scopes.fs.allowedPaths` (it defaults to the active worktree).

## `fs` — host-mediated, scope-contained filesystem

```ts
const text = await host.fs.readFile("/Users/me/.acme/data/notes.md");
await host.fs.writeFile("/Users/me/.acme/data/out.json", JSON.stringify(result));
const entries = await host.fs.readdir("/Users/me/.acme/data");
const meta = await host.fs.stat("/Users/me/.acme/data/notes.md");

// Read-modify-write that refuses to clobber an agent's edit made in between.
const { contents, revision } = await host.fs.readFileWithRevision(
  "/Users/me/.acme/data/board.json"
);
await host.fs.writeFile("/Users/me/.acme/data/board.json", update(contents), {
  expectedRevision: revision,
});

await host.fs.mkdir("/Users/me/.acme/data/2026/09");
await host.fs.appendFile("/Users/me/.acme/data/log.jsonl", JSON.stringify(entry) + "\n");

const dispose = await host.fs.watch(
  ["/Users/me/.acme/data"],
  (changedPath) => host.logger.info("file changed", { changedPath }),
  { recursive: true, debounceMs: 200 }
);
// dispose() tears the watcher down; it is also torn down automatically on unload.
```

`host.fs` is a sanctioned, contained, audited filesystem path. Every argument is resolved against your declared `scopes.fs.allowedPaths` and realpath-contained to one of those roots — a `..` traversal or a symlink that escapes a root is rejected with a `PATH_NOT_ALLOWED:` error, mirroring the `plugin://` protocol handler's discipline. This is the **runtime enforcement of `scopes.fs.allowedPaths`** (previously advisory). Reads gate on `fs:project-read` / `fs:user-data-read`, writes on `fs:project-write` / `fs:user-data-write`; a missing capability rejects with a `PERMISSION_REQUIRED:` error. The first write — `writeFile`, `appendFile` or `mkdir` — additionally raises a [just-in-time consent dialog](./trust-model.md#2-host-side-policy-input-load-bearing) — reads don't. Unlike the app's `files.read` IPC, `readFile` carries **no 500KB / binary cap** — it is a deliberate plugin API. Reads follow a symlink you name when it resolves inside a root, but once open the descriptor must be the entry standing at the contained path: a leaf swapped for a symlink after the check rejects with `TARGET_IS_SYMLINK`, and a descriptor that is not the file now at the path with `TARGET_UNAVAILABLE` (safe to retry). Writes are recorded in the audit trail, and `watch` watchers are torn down on unload. `host.fs` is NOT revoke-guarded — call it from timers and subscription callbacks.

**Paths.** Every path is absolute; a relative one is refused with `PATH_NOT_ALLOWED` rather than resolved against some cwd. Besides your declared roots, your plugin data directory (`~/.daintree/plugin-data/{pluginId}`) is always an allowed root of the user-data class, declared or not. `readFileBytes` is `readFile` returning a `Uint8Array` of the raw bytes, with the same gates, containment, verified open and absence of a size cap. `stat` follows symlinks and resolves `{ isDirectory, isFile, isSymbolicLink, size, mtimeMs }` — so `isSymbolicLink` is always `false` — and a missing path rejects with Node's `ENOENT`.

`readFile`, `readFileBytes`, `readFileWithRevision`, `readFiles`, `readdir`, `walk`, `stat`, and `watch` take a trailing options object carrying an optional `signal: AbortSignal`, so a read feeding a panel that has since unmounted can be cancelled — chain it off the view's `disposeSignal`. An already-aborted signal rejects before any I/O; aborting mid-flight rejects with the signal's reason. `writeFile`, `appendFile` and `mkdir` deliberately take none: half-written files are not a state worth offering.

`writeFile(path, contents, options?)` resolves `{ revision }` — the sha256 hex of the bytes written — for every call. Every write is checked, with or without `options` (omitting them is the same as passing `{}`): the host serialises writes per resolved path, re-proves containment inside that critical section once the consent prompt and queue wait are over (a target that moved meanwhile rejects with `TARGET_UNAVAILABLE`), refuses a symlink leaf (`TARGET_IS_SYMLINK`), and replaces the file atomically through a sibling temp file, flush and rename with the original mode preserved — so a watcher sees a rename and the file gets a new inode. A create-new write (`expectedRevision: null`, below) is an exclusive create at the target instead. Outside your data directory the parent directory must already exist; inside it, missing parents are created after consent, each one audited. `options.expectedRevision` is 64 lowercase hex characters or `null` (anything else throws) and compares the file's current bytes before anything is touched: a mismatch rejects with `REVISION_MISMATCH` and the error carries `currentRevision` so the caller can enter a conflict state without a second read; a missing target rejects with `TARGET_UNAVAILABLE`; `expectedRevision: null` means the file must not exist yet (`TARGET_EXISTS` otherwise). The `code` (and, for a mismatch, `currentRevision`) ride on the error object whether the plugin runs in process or in its worker, and the code also prefixes the message. What the write does not promise is a lock against an uncooperative external process — a write that lands between the hash check and the rename is overwritten. The window is small, and callers that care keep their own copy of what they asked to write (the built-in Markdown editor keeps its draft until a save is verified).

`readFileWithRevision(path)` resolves `{ contents, revision }`: the text exactly as `readFile` returns it, and the sha256 hex of the very bytes that were decoded — the same hash `writeFile` returns — so the revision can go straight into `expectedRevision` without hashing anything yourself. It has the same gates, containment and verified open as `readFile`.

`mkdir(path)` creates the directory and any missing ancestors, and resolves quietly when the directory already exists; something other than a directory at the path rejects with `TARGET_EXISTS`. It is a write in every respect that matters — gated on the write capability for the path's root class, behind the same consent prompt, serialised per path — and every directory it actually creates gets its own audit record. The capability gate, containment and consent all come before anything is created: the deepest existing ancestor is realpathed, so a symlinked directory that leads out of your roots rejects with `PATH_NOT_ALLOWED` and nothing is made, and a denied consent prompt leaves the disk untouched. The one directory that can be created before containment is your own plugin data dir (with any missing `~/.daintree` ancestors), which has to exist before a path inside it can be contained — and that happens only after the capability check and consent, one audited directory at a time. The missing tail is then created one component at a time, and a component that turns up as anything but a real directory rejects with `TARGET_UNAVAILABLE`.

`appendFile(path, text)` appends through one `O_APPEND` descriptor and resolves `void`. It creates the file when it is missing (the parent must exist, except inside your plugin data dir, which fills in parents exactly as `writeFile` does — after consent, each one audited), refuses a symlink leaf with `TARGET_IS_SYMLINK` and anything that is not a regular file — a FIFO, a device, a directory — with `TARGET_UNAVAILABLE`, and is serialised per path with `writeFile`, so an append never lands between a checked write's hash compare and its rename. Because the kernel positions every `O_APPEND` write at the end of the file, an agent appending to the same JSONL log from outside Daintree does not lose lines to your append, which a read-and-rewrite would. Each call is issued as a single `write()`; if that write comes up short, the remainder follows in further writes, and an append that fails after some bytes landed — a failed close included — is audited as an error carrying the number of bytes written. No revision comes back: computing one would mean reading the whole file again — call `readFileWithRevision` when you need it.

`watch(paths, callback, options?)` takes three more options. `recursive: true` watches every directory beneath each path, including directories created after you subscribed, and calls back with the absolute path of whatever changed at any depth; a plain watch still reports only a directory's immediate children, and the two never share a native watcher. `debounceMs` coalesces a burst into one trailing callback per subscription, fired that long after the last change and carrying the most recent changed path; `0` or omitted delivers every event, and any other value is clamped to between 50 ms and 60 s. An empty `paths` array, a `callback` that is not a function, a `debounceMs` that is not a finite, non-negative number, or a `recursive` or `allowMissing` that is not a boolean rejects the watch. The path a callback carries is the realpath — `/private/var/…` on macOS where you watched `/var/…` — so compare against realpaths. A debounced callback is an invalidation hint — re-read what you care about rather than trusting the one path it names. A reported path that does not sit lexically inside the watched path is dropped rather than delivered. On Linux, Node implements a recursive watch in JavaScript: subscribing walks the whole tree synchronously and holds one inotify watch per file and directory, so point a recursive watch at your data directory, never at a whole worktree with `node_modules` in it. The Linux caveats are listed below.

`allowMissing: true` accepts a path that does not exist yet and keeps watching through a deletion: the host checks a missing path once a second, and an attached one every second for three seconds after it attaches or its watcher fires, then every ten seconds as a backstop. It attaches when the path appears (proving containment again first, so a symlink created there cannot redirect the watch), detaches when it disappears or is replaced by a new directory, and calls back with the path each time. Without it a missing path rejects the watch and a deleted directory silently stops reporting — use it for a data folder that an agent or a first-run step creates later.

**Honest scope note:** `host.fs` gates the host-mediated path only. Your `main` is still un-sandboxed Node code (it runs in the plugin worker with full filesystem privileges) and can call raw `node:fs` directly, which the host cannot intercept without a real sandbox (see the [trust model](./trust-model.md)). `host.fs` gives a contained, audited path; it does not seal the un-mediated one.

### What `host.fs` does not do

These are not bugs, but each one has cost a plugin author a debugging cycle.

- **Eleven methods, no more.** `readFile`, `readFileBytes`, `readFileWithRevision`, `readFiles`, `writeFile`, `appendFile`, `mkdir`, `readdir`, `walk`, `stat`, `watch`. There is no `rm`, `rmdir`, `rename` or `copyFile`. Keep drafts, journals and caches in `host.storage` or under a user-data path rather than planning around deleting project files.
- **A write is contained at the leaf, not along the whole path.** `writeFile`, `appendFile` and `mkdir` prove containment, then prove it again inside their per-path critical section, and `mkdir` creates one component at a time and realpaths the result — but the final open or `mkdir` is still by pathname. An ancestor directory swapped for a symlink out of scope between that recheck and the syscall can land the mutation outside your roots; `O_NOFOLLOW` protects only the leaf. The checks shrink the window, they do not close it, and it is the same limit `writeFile` has always had. Closing it would need every path opened directory by directory, and since your `main` is unsandboxed Node that could reach the same place through raw `node:fs`, the host does not pretend to.
- **Containment is to a declared root, not to the directory you meant.** A path is realpath-contained to one of your `scopes.fs.allowedPaths` roots. If your plugin works inside a narrower directory — an app inside a monorepo worktree — a symlinked directory inside that narrower directory can still reach elsewhere in the root, and the write's symlink refusal only looks at the leaf. Resolve the path on disk and check it against your own narrower root before reading or writing.
- **A bare `readdir` reports a symlinked directory as neither a file nor a directory.** Code that walks a tree on `isFile`/`isDirectory` silently loses those subtrees. Either pass `{ detail: true }` or `stat` entries whose kind is unknown.
- **`readFile` cannot tell missing from denied.** A read that fails is not proof the file is absent. Code that climbs a directory chain looking for a manifest must decide what a failure means, and should stop climbing on an unreadable file rather than silently reporting a hoisted copy further up.
- **A rejected write does not prove the bytes did not land.** Never record a write as yours because the file now happens to match what you planned; treat a rejection as a failure and re-read if you need to know the truth.
- **`watch` events can arrive before `writeFile` resolves.** If you watch files you also write, track the revisions of your in-flight writes, or your own edits come back as external changes. A watch is non-recursive and undebounced unless you pass `recursive` and `debounceMs`.
- **`appendFile` is not a transaction.** Each call is one `write()` on an `O_APPEND` descriptor, so a small line from you and a small line from another `O_APPEND` writer (an agent's `>>`, for instance) each land whole at the end in practice. That is not a guarantee: `PIPE_BUF`-sized atomicity is a pipe rule and does not apply to regular files, a short write is completed by a second `write()` that another appender can interleave with, and a writer that does not use `O_APPEND` can overwrite either of you. A reader can also see a file mid-way through a burst of appends, and nothing stops an external writer truncating or replacing the file between two of yours. Write one complete, reasonably small record per call, and make readers tolerate a trailing partial or interleaved line.
- **A recursive watch on Linux can report names under symlinked subdirectories.** Node's JavaScript recursive watcher watches a symlink's target as it stood when it was first seen, so a change reached through a link inside the watched tree can be reported under the link's name even when the target is outside your scope. The host drops any reported path that is not lexically inside the watched path, but it does not realpath each event — treat a callback as "something under this name may have changed" and read through `host.fs`, which does contain.
- **A recursive watch on Linux can go deaf to a file that is replaced atomically.** When a file is replaced by rename — which is how `writeFile`, most editors and many agents save — Node's Linux recursive watcher can keep watching the old inode and stop reporting that path. It is fixed upstream (nodejs/node#65486), but not in the Node that Daintree's Electron ships. For a file that is rewritten atomically, also watch its parent directory without `recursive` (that watch sees the rename), or add a slow fallback poll with `readFileWithRevision`.
- **Decode text with care about the BOM.** `TextDecoder`'s default strips a byte-order mark, which shifts every offset by one against tools that count it. Decide which convention your offsets use and keep it on both sides — and note that some compilers (Svelte's among them) strip it too.

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

### `readFiles` and `walk` — bulk reads

A search, an index build or a tree of small config files costs one host round trip per `readFile` or `readdir`. These two do the same work in one:

```ts
const { entries, truncated } = await host.fs.walk!(worktreeRoot, {
  include: ["**/*.md"],
  exclude: ["node_modules", "**/dist"],
  limit: 5_000,
});
const files = await host.fs.readFiles!(
  entries.filter((e) => e.type === "file").map((e) => `${worktreeRoot}/${e.path}`),
  { maxBytesPerFile: 256 * 1024, signal: disposeSignal }
);
for (const file of files) {
  if (file.ok) index(file.path, file.content);
  else if (file.error.code === "RESULT_TOO_LARGE") later.push(file.path);
}
```

**`fs.readFiles(paths, options?)`** reads up to 1024 paths (more rejects the call) and resolves one entry per path, in request order: `{ path, ok: true, content }` or `{ path, ok: false, error: { code, message } }`. `encoding: "utf-8"` (the default) decodes each file as `readFile` does and `"bytes"` returns a `Uint8Array` as `readFileBytes` does; the overloads type `content` to match. Every path gets exactly the checks `readFile` applies — containment, the root's read capability, the verified open — but a refusal fails only its own entry:

| Entry code | Meaning |
| --- | --- |
| `PATH_NOT_ALLOWED`, `PERMISSION_REQUIRED` | Outside every allowed root, or the read capability for that root's class is not declared |
| `NOT_FOUND` | Nothing at the path |
| `NOT_A_FILE` | A directory, FIFO, device or other non-regular file |
| `TARGET_IS_SYMLINK`, `TARGET_UNAVAILABLE` | The verified-open refusals `readFile` documents |
| `TOO_LARGE` | Bigger than `maxBytesPerFile` (a non-negative integer; the file is not read past it) |
| `RESULT_TOO_LARGE` | The call's 8 MiB content budget, spent in request order and measured as returned, could not hold this file — usually because earlier entries spent it, so read the path in a later call. A file larger than 8 MiB by itself gets this code even first in the request, as does one whose remaining budget was smaller than `maxBytesPerFile`; retrying cannot help such a file, so read it with `readFileBytes`. The same request always defers the same entries |
| `READ_FAILED` | Anything else; the `message` says what |

The whole call rejects only when the plugin declares neither `fs:project-read` nor `fs:user-data-read`, when the plugin has unloaded, on invalid arguments (`VALIDATION:`), or when `signal` aborts. With one of them declared, a path in a root whose class needs the other fails only its own entry, with `PERMISSION_REQUIRED`.

**`fs.walk(root, options?)`** lists a directory tree and resolves `{ entries, truncated }`, each entry `{ path, type: "file" | "dir", size? }` with `path` relative to `root`, `/`-separated and never starting with `/` or `./`. `root` gets the checks `readdir` applies, and the walk stays inside it: symbolic links are neither followed nor listed, FIFOs, sockets and devices are skipped, and a directory's listing is dropped unless it still resolves to where it was reached both before and after it is read. A subdirectory that vanishes or cannot be read is left out silently, without setting `truncated`; a root that cannot be read rejects, and one that moved while it was read rejects with `TARGET_UNAVAILABLE`.

| Option | Default | Meaning |
| --- | --- | --- |
| `include` | every entry | Globs (`path.matchesGlob`: `*`, `**`, `?`, `[…]`, `{a,b}`) over the root-relative path; only matches are returned, but every directory is still walked, so `["**/*.ts"]` finds every TypeScript file. At most 64 patterns, each non-empty and at most 1024 characters |
| `exclude` | none | Globs as above; a match is left out, and a matching directory is not descended into. Same limits as `include` |
| `maxDepth` | 64 | `1` lists `root`'s own children, `2` their children too; an integer from 1 to 64 |
| `limit` | 10,000 | Most entries returned, counted after `include`; an integer from 1 to 50,000 |
| `respectGitignore` | `true` | Inside a git repository, leave out (and do not descend into) what git ignores and does not track, skip `.git`, and list a nested repository or submodule without entering it. No effect outside a repository |
| `includeSize` | `false` | Report each file's size in bytes, at the cost of one stat per file. A size is omitted for a file whose directory no longer resolves to where the walk listed it |

Entries come back sorted by path, each directory before the entries inside it. The walk is breadth-first, so when `limit` or the 8 MiB result budget cuts it short, `truncated` is `true` and what was kept is the shallowest part of the tree, the same way every time. The host also bounds a walk's cost at 200,000 directory entries examined and 1,000,000 glob tests; reaching either returns what it had with `truncated: true`. A single directory with more entries than the examine bound has left is read only that far, so what is kept from it is whichever entries the filesystem enumerated first — still sorted, but not necessarily the first by path and not guaranteed to repeat. On macOS and Windows, a repository that tracks a file matching its own ignore rules is walked without ignore filtering, since git can misreport such a file under a different letter case as ignored.

Both are optional in the type (`readFiles?`, `walk?`) so hand-written `PluginFsApi` fakes keep compiling; Daintree's host, the worker host and `createMockHost` always provide them.

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

| Method | Resolves |
| --- | --- |
| `status(worktreePath)` | `{ worktreePath, files, changedFileCount }`, each file `{ path, state }` in the five-state vocabulary of [`PluginWorktreeStatus`](#worktree-observation). A fresh read, not the polled snapshot — but there is no staged/unstaged split. |
| `diff(worktreePath, filePath?)` | The unstaged diff — working tree against the index — as text, run with `--no-color --no-ext-diff --no-textconv`, optionally narrowed to one path. There is no staged-diff call; the staged diff appears only as `commit`'s `preview`. |
| `add(worktreePath, paths?)` | `void`. With no paths (or an empty array) it stages every change in the worktree. |
| `commit(worktreePath, { message })` | `{ commit, message, preview }`: the short SHA, your message echoed back, and the staged diff computed before committing. |

`host.git` is scoped to a worktree your plugin may access — the `worktreePath` must resolve inside your `scopes.fs.allowedPaths` (same realpath containment as `host.fs`). Your plugin data directory is not a valid git root, even though `host.fs` accepts it. It is implemented over Daintree's existing hardened git layer, not a reinvented one. Reads (`status`, `diff`) gate on `git:read`; mutations (`add`, `commit`) on `git:write` (and `commit` additionally requires `git:read`, since it returns the staged diff as its preview), with a [just-in-time consent dialog](./trust-model.md#2-host-side-policy-input-load-bearing) on the plugin's first mutation. Every method takes a trailing options object with an optional `signal: AbortSignal` to cancel the call; the signal is checked between steps, so an abort cannot interrupt a git command already running. Any pathspec you pass to `add` or `diff` must be **worktree-relative** — an absolute path, a `..` segment, `:`-prefixed git pathspec magic, or a leading `-` (which git would read as an option) is rejected with a `PATH_NOT_ALLOWED:` error, because git would otherwise resolve those against the whole repository and escape the contained worktree. Paths are also matched **literally, not as globs**: the hardened git layer runs with `GIT_LITERAL_PATHSPECS`, so `src/*.ts` selects a file named exactly `src/*.ts` rather than expanding, and a legal filename containing `*`, `?`, or `[...]` (a Next.js route like `pages/[...slug].tsx`) resolves to itself instead of to whatever its wildmatch pattern happens to hit. Pass concrete paths and expand any pattern yourself — for example by filtering the entries `status` already returns. `commit` enforces the **change-preview safeguard at the host layer** (incident #7880 / destructive-action tier D2): it refuses without an explicit non-empty `message` — there is no silent fallback to a derived commit message — and it computes the real staged diff as a preview before mutating, returned on the result so your UI can surface it. Mutations are recorded in the audit trail. `host.git` is NOT revoke-guarded.

## `clipboard` — host-mediated OS clipboard

Read and write the OS clipboard, gated on `clipboard:read` / `clipboard:write`. Runs in the main process, so it works from a headless plugin (no renderer or focused document required).

```ts
await host.clipboard.writeText("acme.linear-planner synced 12 issues"); // clipboard:write
await host.clipboard.writeImage(pngBytes); // clipboard:write
const text = await host.clipboard.readText(); // clipboard:read
```

`writeText` rejects with a `PAYLOAD_TOO_LARGE:` prefix when the text exceeds 8 MiB by UTF-8 byte count (mirroring the renderer IPC clipboard guard). `readText` resolves to `""` when the clipboard is empty or holds non-text content (image, file list) — it never rejects on content type. A call without the matching capability rejects with a `PERMISSION_REQUIRED:` error. `host.clipboard` is NOT revoke-guarded.

`writeImage` takes a `Uint8Array` of image bytes — PNG is the supported and tested input, though the underlying Electron decoder also accepts JPEG — and shares the `clipboard:write` token — putting an image on the clipboard is exactly as reversible as putting text there, so it needs no second capability and doesn't elevate your actions to `confirm`. It rejects with `PAYLOAD_TOO_LARGE:` above 20 MiB and `VALIDATION:` when the bytes don't decode to an image. Successful writes are audited by byte count (never the bytes). Decoding happens in the main process by necessity — a renderer-side `navigator.clipboard.write()` with binary PNG data crashes on Linux — so this is the supported path for image writes.

**Reads stay text-only.** There is no `clipboard.readImage`, `readHtml` or `readFiles` (a copied file list; not to be confused with [`fs.readFiles`](#readfiles-and-walk--bulk-reads)): the read side is where richer payload types would let a plugin pull out more than it declared. Writes carry no such risk, since you already have the bytes.

## `system` — open and reveal files in your own scope

Hand a file to the OS default application, or reveal it in Finder/Explorer — scoped to your plugin's own filesystem roots.

```ts
const shot = `${dataDir}/screenshot.png`;
await host.system.showItemInFolder(shot); // reveal it, selected
await host.system.openPath(shot); // or open it in the default viewer
```

This exists because the built-in `system.openPath` action validates against the _user's_ roots — open projects, tracked worktrees, `userData` — and carries no caller identity, so dispatching it could never reach `~/.daintree/plugin-data/<plugin-id>/`, the one directory that is unambiguously yours. The workaround was shelling out to `/usr/bin/open`, trading a contained call for arbitrary execution.

Paths resolve against your declared `scopes.fs.allowedPaths` plus your implicit plugin-data namespace, with realpath containment (a symlink can't walk out of scope). Your plugin id is bound when the host is built rather than passed as an argument, so one plugin can never name another's namespace. Both methods are gated on the `fs:*` capability matching the resolved root's class — `fs:user-data-read` _or_ `fs:user-data-write` for the plugin-data namespace, `fs:project-*` for a project root — so a plugin that could legitimately create the file can always reveal it.

Errors carry prefixes: `PATH_NOT_ALLOWED:` for a path that is relative, unresolvable, traversing, or outside your scope (the same containment error `host.fs` raises); `INVALID_PATH:` for a path that resolves inside your scope but doesn't exist; `PERMISSION_REQUIRED:` for a missing capability; `PLUGIN_UNLOADED:` after unload. `openPath` additionally refuses executable file types, checked on both the path you passed and its realpath target so a benignly-named symlink can't become a launch primitive; `showItemInFolder` has no such deny-list, since revealing a file shows it rather than running it. The refusal carries `err.code === "INVALID_PATH"` with the message `Refusing to open executable file type: .ext` (no prefix), and the list depends on the platform:

| Platform | Refused extensions |
| --- | --- |
| macOS | `.app` `.command` `.terminal` `.scpt` `.scptd` `.pkg` `.dmg` `.desktop` |
| Linux | `.desktop` `.sh` `.appimage` `.run` |
| Windows | `.exe` `.bat` `.cmd` `.com` `.scr` `.pif` `.vbs` `.ps1` `.msi` `.lnk` `.jar` `.reg` `.cpl` `.wsf` `.hta` |

Matching is case-insensitive. When the OS cannot open the file (no default application, say), `openPath` rejects with `plugin "…" system.openPath failed: <reason>`, which carries no code. Successful calls are audited (rejected ones are not — nothing reached the OS). `host.system` is NOT revoke-guarded.

## `documents` — render HTML to PDF

Turn HTML into a PDF file. Electron's `printToPDF` lives in the main process, out of reach of plugin code, so this is the only way a plugin can produce a PDF — an invoice, a quote, a report, a contract.

```ts
const { path, bytes, revision } = await host.documents.renderPdf({
  htmlPath: `${dataDir}/invoices/INV-0042.html`, // or html: "<!doctype html>…" (max 5 MiB)
  outputPath: `${dataDir}/invoices/INV-0042.pdf`,
  pageSize: "Letter", // "A4" (default) | "Letter" | "Legal" | "A3" | "A5" | "Tabloid"
  landscape: false,
  printBackground: true, // default true
  margins: { top: 0.5, bottom: 0.5, left: 0.6, right: 0.6 }, // inches, 0–3
  pageRanges: "1-2", // omit for every page
});
await host.system.openPath(path);
```

Pass exactly one of `html` or `htmlPath`; `htmlPath` and `outputPath` must be absolute. An unknown option, a wrong type, a margin outside 0–3 inches or a malformed `pageRanges` rejects with `VALIDATION:` rather than being ignored. `pageRanges` is at most 200 characters of 1-based pages and ranges (`"1-3, 5"`), each range's end no lower than its start. A margin you leave out keeps Chromium's default of 1 cm. CSS `@page size` is not honoured — the paper size is `pageSize` — while `page-break-*` rules apply as they do when printing from Chrome.

**The output** is gated exactly like [`fs.writeFile`](#fs--host-mediated-scope-contained-filesystem): `outputPath` must be absolute, end in `.pdf`, and resolve inside your declared roots (or your plugin-data namespace); its parent directory must already exist (`INVALID_PATH:` otherwise). The data directory itself is created on first use, after consent, but nothing below it is, so `mkdir` a subfolder before writing into it. The result's `path` is the realpath of the file written. It needs `fs:project-write` or `fs:user-data-write` for the matched root's class, and the first write raises the same just-in-time consent prompt — one grant covers both surfaces. A symlink at the output leaf is refused with `TARGET_IS_SYMLINK`, containment is proven again once the render is done (`TARGET_UNAVAILABLE` if the target moved), and the file is replaced atomically with its mode preserved. The result's `revision` is the same sha256 `fs.writeFile` returns, so it can go straight back in as an `expectedRevision`. Writes are audited on the same trail as `fs.writeFile`.

**The input.** `htmlPath` is read-contained like `fs.readFile` and needs the read capability for its root class (`fs:project-read` / `fs:user-data-read`); it must be a regular file of at most 5 MiB, read as UTF-8. It is read once, after the consent prompt, through the same verified non-following read `fs.readFile` uses, and the window renders that snapshot rather than the path — a file swapped out while the call waited rejects with `TARGET_UNAVAILABLE` or `TARGET_IS_SYMLINK` instead of rendering. Relative images, stylesheets and fonts resolve against the file's directory, as long as they stay inside the same allowed root. Inline `html` (also at most 5 MiB) has no base URL — a relative reference resolves to nothing — so embed assets as `data:` URIs, or write the HTML to disk first and pass `htmlPath`. An absolute `file:` URL in inline HTML loads only inside the output's root, and only when you hold the read capability for it.

**The render window** is hidden and locked down: JavaScript disabled, sandboxed, context-isolated, no Node, web security on, a throwaway in-memory session wiped after each render, every permission request denied, and navigation, popups, webviews and downloads blocked. **Nothing is fetched from the network** — the snapshot carries a Content-Security-Policy that admits only `file:` and `data:` images, stylesheets and fonts, and every request other than a `data:` URI or a contained `file:` URL is cancelled, so remote images, web fonts and CDN stylesheets simply do not appear. A `file:` URL naming a host, or any UNC path, is refused before the filesystem is touched. Resource hints Chromium acts on without a request (`dns-prefetch`, `preconnect`, `prefetch`, `prerender`, `preload`) are stripped from the snapshot — every `<link>` except a stylesheet goes — and DNS prefetching is switched off. Local assets pass an admission check as each is requested: it must be a non-empty regular file — a FIFO, a device, a directory or a size-0 special such as a `/proc` file is refused — and its size at that moment must fit in what remains of a 100 MiB per-render budget. The check is on the size `stat` reports, not a bound on the bytes then read, so a file that grows after it is admitted delivers more. The PDF itself is capped at 50 MiB (`PAYLOAD_TOO_LARGE:`). Bundle what the document needs. Because JavaScript is off, a template must be fully rendered HTML; client-side charting libraries will not run.

A call goes through two bounded phases. While the consent prompt is open it holds no render slot and no clock runs — the prompt goes at the user's pace — but a plugin may have at most two calls waiting on it; a third rejects with `RENDER_BUSY:`. Once consent is given the call takes a render slot, and a plugin with two calls already holding slots, or a call arriving when eight are held in total, rejects with `RENDER_BUSY:`. At most two renders run at once across all plugins and the rest queue. The 30-second limit starts when the slot is taken and covers reading `htmlPath`, the queue wait and the render (`RENDER_TIMEOUT:`); a page that fails to load or print rejects with `RENDER_FAILED:`, and a call still queued or rendering when the plugin unloads is cancelled (`RENDER_CANCELLED:`). The window is destroyed on every path.

`createMockHost` records each call in `documentsRenderPdfCalls` and writes a small placeholder (`%PDF-1.4 …`) to its in-memory filesystem at `outputPath`, so a plugin that reads, lists or opens its export afterwards sees a file. Nothing is rendered: the options go through the host's own validator, and `htmlPath` must exist in the in-memory filesystem. `host.documents` is NOT revoke-guarded.

## React hooks — `@daintreehq/plugin-sdk/react`

The `@daintreehq/plugin-sdk/react` subpath carries the renderer hooks for plugin view components. It is a separate import path so non-view code (your `main`) doesn't pull React into the main-process bundle. The runtime implementations live in the SDK package itself (`packages/plugin-sdk/src/react/`) and Daintree's own `src/hooks/` re-exports them, so plugin authors and the host run one implementation rather than two that can drift.

**Bundled and raw views both get them, from different copies.** A view built with `@daintreehq/plugin-vite` bundles the SDK version it was built against, so a Daintree upgrade never swaps its hooks out from under it. A raw, zero-build `plugin://` view has no bundler, so the host import map serves `@daintreehq/plugin-sdk/react` to it from the host's own copy — one module instance per document, shared by every raw view, so they share `useCachedHostChannel`'s cache and `useNow`'s timers. That specifier is raw-only: the preset deliberately does not externalize it (see [Architecture → Sharing strategy](./architecture.md#sharing-strategy)). The host copy tracks the running Daintree, so a raw view gets whatever that release's SDK does.

The runtime names served are exactly the `/react` entry's: `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent`, `loadDocumentPackage`, `createViewScope`, `lazyWithPreload`, `usePreloadOnIntent`, `useProgressiveList`, `useVirtualList`, `useHostStore`, `usePluginEventSelector`, `shallowEqual`, `useCachedHostChannel`, `HOST_CHANNEL_CACHE_LIMIT`, `resetHostChannelCache`, `useThrottledCallback`, `useAnimationFrame`, `useNow`, `useStreamBuffer` and `useSyncedCollection`. The hooks are thin wrappers over the `window.electron.plugin` bridge ([Raw ESM views](#raw-esm-views--windowelectronplugin) below), which stays available to either kind of view.

```ts
import { useHostChannel, usePluginEvent, usePluginPanelEvent } from "@daintreehq/plugin-sdk/react";
```

### `useHostChannel` — request/response (the pull half)

```ts
const { invoke, loading, error } = useHostChannel<SyncArgs, SyncResult>(pluginId, "sync-now");

// later, e.g. in a click handler:
const result = await invoke({ team: "engineering" });
```

`useHostChannel(pluginId, channel)` binds a single-flight `invoke(args)` to your plugin's `registerHandler(channel, …)`. It resolves with the validated channel result on success, or `undefined` when the host rejected the call (the rejection surfaces on `error`, never throws out of `invoke`). `invoke` forwards exactly one argument to the handler, so a handler expecting `(ctx, a, b)` never sees `b`. `loading` reflects the latest call only; if you fire a second `invoke` before the first resolves, the earlier call is superseded and resolves `undefined`, so concurrent invocations stay coherent — and a fan-out of loads through one hook loses all but the last, so queue them or use one hook per load. When the typed `registerHandler` overload rejects with a `SCHEMA_ERROR:` / `PERMISSION_REQUIRED:` prefix, that surfaces on `error` for the renderer to discriminate.

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

### Performance hooks

The rest of the entry packages the patterns behind Daintree's own fast panels. Each is dependency-free and takes `react` from the view's module graph. Not in the 0.1.0 release on npm; it ships in the next one. That covers every export in this section except `loadDocumentPackage`, and only bundled views: a raw view already gets them from the host's copy.

| Export | Use it when |
| --- | --- |
| `lazyWithPreload(load, pick?)`, `usePreloadOnIntent(Component)` | A dialog, tab or editor lives in its own chunk. Preload on hover or focus so it renders in the first frame instead of behind a Suspense fallback. |
| `useProgressiveList(items, { initial, step, resetKey, minIndex })` | Up to a few hundred rows: the first screenful paints at once, the rest arrives in transitions that never block input. |
| `useVirtualList({ count, estimateSize, overscan, getScrollElement })` | Thousands of rows with fixed or known heights: only the rows in view are mounted. The kit's `VirtualList` is the component form. |
| `usePluginEventSelector(pluginId, channel, selector, { initial, isEqual, panelId })`, `useHostStore(subscribe, getSnapshot, selector, isEqual)`, `shallowEqual` | A pushed snapshot is large and the component shows one slice; it re-renders only when the selected value changes. |
| `useCachedHostChannel(pluginId, channel, args, { staleMs, cacheKey, signal, enabled, invalidateOn, debounceMs })` | A read repeated on every open. The cached result paints first and revalidates in the background; concurrent mounts share one request. The cache aims for `HOST_CHANNEL_CACHE_LIMIT` (50) entries in total by dropping unused entries, least recently used first; entries a mounted view shows, or with a request in flight, are never dropped, so the total can exceed 50. `invalidateOn` takes one push channel or an array of them; a burst of pushes across them costs one refetch after `debounceMs` (default 100) of quiet. In tests, call `resetHostChannelCache()` in `beforeEach`: the cache is module-global, so one test's results otherwise paint first in the next. |
| `useThrottledCallback(callback, { ms })` | A replaceable value (progress, latest status) arrives faster than a frame. Keeps only the latest arguments per window, so never use it for appended data. |
| `useStreamBuffer({ maxItems, flush })` | Appended data — log lines, events. Lossless up to `maxItems` (default 1000, older items dropped and counted), committing at most once per frame or per `flush` ms. |
| `useSyncedCollection(pluginId, channel, { signal, enabled })` | A keyed list the worker owns, mirrored from `createSyncedCollection` in the worker: subscribe, pull a revisioned snapshot, apply deltas, resync on a gap or a worker restart. |
| `useNow({ intervalMs, align })` | Relative times ("5m ago"). One shared timer per interval that pauses while the view is hidden or cached. |
| `useAnimationFrame(callback, { enabled, signal })` | A canvas or simulation loop that pauses while the document is hidden or the project view is cached. |
| `createViewScope(disposeSignal, options?)` | Listeners, timers, observers, workers and WebGL contexts that must be released with the mount. See [Views → Resources your view owns](./views.md#resources-your-view-owns). |
| `loadDocumentPackage(import.meta.url, descriptor)` | Loading a shared editor adapter once per document. See [Document packages](./document-packages.md). In 0.1.0. |

What each hook returns, and the defaults that matter:

| Hook | Returns | Defaults and behaviour |
| --- | --- | --- |
| `useProgressiveList` | `{ visible, isComplete }` | `initial` 30. |
| `useVirtualList` | `{ rows, totalSize, scrollToIndex(index, align?) }`, each row `{ index, start, size }` | `overscan` 4 rows beyond each edge. |
| `useCachedHostChannel` | `{ data, error, validating, updatedAt, revalidate }` | `staleMs` 0 (always revalidate on mount, never wait to paint), `debounceMs` 100. `data` keeps the last good result beside an `error`; `revalidate()` supersedes a request in flight and resolves `undefined` if it failed or was superseded. |
| `useThrottledCallback` | The throttled function, stable for the component's life, with `.cancel()` | Without `ms`, one trailing call per animation frame with the latest arguments. With `ms`, the first call runs at once and later ones in the window collapse into one trailing call. |
| `useStreamBuffer` | `{ items, dropped, push, pushMany, clear }` | `maxItems` 1000, `flush` `"frame"` (or a number of ms). `clear()` resets `dropped` too. |
| `useSyncedCollection` | `{ items, revision, loading, error, resync }` | `revision` is 0 until the first snapshot; `resync()` pulls again and retries after an `error`. |
| `usePluginEventSelector` | The selected value | The options object is required, and so is its `initial` payload: it is what `selector` reads until the first push, and what the store resets to when `pluginId`, `channel` or `panelId` changes. `isEqual` defaults to `Object.is`. |

`createSyncedCollection(host, channel, { key, initial?, flushMs?, maxDeltaBytes? })` and `syncedCollectionSnapshotChannel(channel)` (the `<channel>-snapshot` handler it registers) come from the SDK's root entry, which zero-build workers are served too. Not in the 0.1.0 release on npm; it ships in the next one — a bundled worker needs a later SDK, while a zero-build worker already gets it from the copy shipped with the app, unless an installed `@daintreehq/plugin-sdk` beside it or in an ancestor `node_modules` resolves first (an installed 0.1.0 wins over the shipped copy and lacks it). It is async — `await` it during `activate()`, since it registers a handler. The collection gathers changes for `flushMs` (default 16) into one delta, splits a change set larger than `maxDeltaBytes` (default 512 KiB, half the push cap) across consecutive revisions, and sends a `resync` delta when one item alone is too large. Apart from one empty delta announcing its epoch (so a view left over from a previous worker resyncs), it sends no deltas until a view has pulled, and afterwards only while [`hasListeners`](#listener-hints--haslisteners-ondidchangelisteners) reports a listener; a view that opens later pulls the changes it missed from the snapshot. A push that fails is retried up to three times, with backoff, while it is still the newest delta; one refused as too large is replaced by a `resync` delta.

The returned `SyncedCollection` has `channel`, `snapshotChannel`, `revision` (the collection's latest revision, which advances even when a push was skipped because no view has pulled or is listening) and `size`; reads `get(key)`, `has(key)` and `values()` (a new array in order); writes `upsert(item)`, `upsertMany(items)`, `remove(key)` (returns whether it was present), `removeMany(keys)`, `replace(items)` (one `reset` delta) and `clear()`; `flush()`, which processes pending changes now and resolves once the first attempt to post them has settled (it does not wait for retries, and does not guarantee delivery); and `dispose()`, which stops deltas while the snapshot channel keeps answering until unload.

For controls rather than hooks — buttons, lists, dialogs, the theme — see the [UI kit](./ui-kit.md).

### Raw ESM views — `window.electron.plugin`

A hand-authored `plugin://` view can import `@daintreehq/plugin-sdk/react` through the host import map (above), or talk to the host bridge directly — the same transport the hooks wrap. `@daintreehq/plugin-sdk/view-globals` declares exactly this bridge (`invoke`, `on`, `onPanel`) for TypeScript: add it to `compilerOptions.types`. Nothing else on `window.electron` is declared, on purpose. `/view-globals` is types only: Not in the 0.1.0 release on npm; it ships in the next one.

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

`window.electron.plugin.on(pluginId, channel, callback)` subscribes to every payload your `main` pushes via `host.postToPanel(channel, payload)` (or a one-shot `broadcastToRenderer` during activation) and returns a `() => void` disposer. `window.electron.plugin.invoke(pluginId, channel, ...args)` calls your `registerHandler(channel, …)` and resolves with its result. Payloads and results arrive untyped over IPC — cast at the call site (the bundled hooks do the same; the plugin owns the shape it pushes). The hooks add what the bridge lacks — ref-stable handlers, unmount teardown, caching and coalescing — so prefer them in either kind of view.

## Root entry runtime values — `@daintreehq/plugin-sdk`

The root entry is types plus a handful of runtime values: `PLUGIN_PROCESS_STREAM_CHANNEL` (`"process"`, see [`process`](#process--managed-child-processes)), `PLUGIN_STYLE_ROOT_ATTRIBUTE`, `localAuthStubs` for a local forge provider, the [synced collection](#performance-hooks) (`createSyncedCollection`, `syncedCollectionSnapshotChannel`), and the agent-context drag contract a view uses to hand work to an agent by drag: `AGENT_CONTEXT_DRAG_MIME`, the limits `AGENT_CONTEXT_MAX_TEXT_LENGTH` (32,768), `AGENT_CONTEXT_MAX_TITLE_LENGTH` (120) and `AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH` (80), `encodeAgentContextDragPayload(payload)`, which returns the serialised payload and throws a `TypeError` on one the drop would refuse, and `setAgentContextDragData(dataTransfer, payload)`, which sets it plus `text/plain` at `dragstart`. See [Views → Handing work to an agent by drag](./views.md#handing-work-to-an-agent-by-drag). For the synced collection and the drag contract in a bundled view or worker: Not in the 0.1.0 release on npm; it ships in the next one.

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
| Paths | `parentDirectoryOf`, `canonicalizeRootPath`, `parentRootPath`, `ancestorDirectories` — lexical helpers over `/`-separated root-relative paths; none touches the filesystem |
| Changed files | `buildFileBrowserGitStatusIndex`, `getFileBrowserRowGitStatus` — per-row status plus the folder roll-up, so a collapsed directory can show that something under it changed |
| Classification | `getFileTypeCategory` — several hundred curated extensions and basenames, plus the patterns that catch `.eslintrc.json`, `Dockerfile.dev` and `compose.override.yaml`, resolved most-specific-first |

The signatures most code calls, schematically (parameters with a default are shown with it):

```ts
flattenTree(listings, expandedPaths, loadingPaths, rootPath = "", isVisible?, sort = DEFAULT_FILE_SORT): FlatTreeRow[];
countHiddenRows(listings, expandedPaths, rootPath = "", visibility): HiddenRowCounts; // { dotfiles, alwaysHidden }
resolveTypeahead(buffer: string, rows: readonly FlatTreeRow[], cursorPath: string | null): string | null;
resolveTreeKey(key: string, rows: readonly FlatTreeRow[], cursorPath: string | null): TreeKeyIntent | null;
// TreeKeyIntent: { type: "select" | "expand" | "collapse" | "activate"; path: string }
buildFileBrowserGitStatusIndex(changes: readonly { relativePath: string; status: GitStatus }[]): FileBrowserGitStatusIndex;
```

`listings` is a `DirectoryListings`: a `Map` keyed by root-relative directory, `""` for the root, each value that directory's nodes. `GitStatus` has eight states (`added`, `modified`, `deleted`, `renamed`, `copied`, `untracked`, `ignored`, `conflicted`); the five a plugin's `{ path, state }` status files use are all among them, so map `files.map((f) => ({ relativePath: f.path, status: f.state }))`.

**It is headless on purpose.** No components, no icons, no styling. A plugin building its own browser wants its own chrome, and exporting Daintree's would freeze the app's internal component contract into the plugin API — the mistake that made Obsidian's CodeMirror upgrade an ecosystem break. `getFileTypeCategory` returns a category name, not an icon, so you map it to whatever glyph set you already ship.

**Nothing here performs I/O.** Feed it listings from [`host.fs.readdir(dir, { detail: true })`](#readdir-and-the-detailed-listing), which returns everything a node needs except its `path` — a `readdir` only knows the directory it read, while the model keys every node from the browse root. Add it as you store each listing:

```ts
next.set(
  dir,
  entries.map((entry) => ({ ...entry, path: dir === "" ? entry.name : `${dir}/${entry.name}` }))
);
```

A view gets those listings the ordinary way: register a channel in `main` that calls `readdir`, and `useHostChannel` it from the view.

Daintree's own file browser imports the same modules from the same package, so this is not a parallel implementation that can quietly drift from the one we maintain — it is the one we maintain.

**A worked example ships in the repo**: `plugins/sample/file-tree/` is a functioning file browser — lazy expansion, hidden-entry filtering with counts, keyboard navigation, per-type classification, and expansion that survives a remount — built on nothing but this subpath, `host.fs.readdir(dir, { detail: true })` and `PanelViewProps.persistState`. Its `main` half is 30 lines (one channel that forwards to `readdir`); everything else is the model plus the plugin's own row markup. It is deliberately built through the published package boundary rather than by relative import, so a missing or reshaped export breaks _it_ — in typecheck and in its bundle — rather than reaching you.

## Data files — `@daintreehq/plugin-sdk/data`

For plugins whose data is files in the repository. Everything here runs in a worker and in a view alike, and only `editFile` does I/O, through the `host.fs` it is handed:

| Export | What it does |
| --- | --- |
| `parseFrontmatter`, `stringifyFrontmatter` | YAML frontmatter in and out, with the body kept byte-for-byte. |
| `updateFrontmatter` | Changes only the top-level keys you name and preserves every other byte; refuses an edit that would lose a tag or break an alias. |
| `FrontmatterError` | What the frontmatter functions throw, with `code: "FRONTMATTER_INVALID"`, `line` and `column`. |
| `parseJsonl`, `stringifyJsonlLine` | JSON Lines, with bad lines reported rather than thrown. |
| `contentRevision` | The revision `fs.writeFile` compares, computed with Web Crypto. |
| `editFile(host, path, transform)` | The read → transform → `writeFile({ expectedRevision })` → retry-on-conflict loop. |

A zero-build worker imports it with no install — the plugin worker serves this entry, `/files` and the root from a copy shipped with the app when the plugin has none of its own. For bundled code: Not in the 0.1.0 release on npm; it ships in the next one. Signatures and behaviour are in [Data helpers](./data-helpers.md).

## Disposables

Anything that takes a callback and returns a cleanup function follows the VS Code-style Disposable pattern. You can safely ignore the return value — the plugin's disposal cascade cleans everything up on unload. If you need explicit control (e.g., unsubscribe from a worktree change listener after a one-shot reaction), keep the reference and call it.

**Throwing listeners are quarantined in process.** A listener you pass to `onDidChangeAgentState`, `onDidChangeAllAgents`, `onDidChangePanelLifecycle`, `onDidWake`, `onDidChangeListeners`, `settings.onDidChange` or `storage.onDidChange` runs inside the host's event dispatch. If it throws (synchronously or by rejecting), an in-process host logs the failure with a running counter (`1/3`, `2/3`, …) and keeps the subscription alive; after three _consecutive_ failures it unsubscribes the listener so a broken callback can't spam the log forever. A single successful invocation resets the counter, so a listener that fails only intermittently is never removed. The worktree subscriptions, `fs.watch` callbacks and database `onDidChange` listeners are only logged, and so is every listener in a worker plugin, which never quarantines. Either way dispatch is fire-and-forget — a throw never propagates back into the host's own work or another plugin's listeners.

See [Architecture → Lifecycle](./architecture.md#lifecycle) for how disposal works internally.

## Testing against a mock host

`createMockHost(options?)` returns a `PluginHostApi & MockHostState` backed by in-memory state, so a unit test can run your `activate()` (and your handlers) without Electron and assert what it called. It ships as the `@daintreehq/plugin-sdk/testing` entry of the SDK, which re-exports the implementation from `shared/testing/createMockHost.ts`, and installs from npm with the rest of the package.

```ts
import { createMockHost } from "@daintreehq/plugin-sdk/testing";

const host = createMockHost({ capabilities: ["agent:read"], hasActiveAgent: false });
await activate(host);

// Recorded calls are exposed for assertions:
expect(host.registeredActions).toHaveLength(1);
expect(host.postToPanelCalls[0]).toMatchObject({ channel: "build-status" });

// Capability gating matches production for the agent APIs:
await expect(host.sendToActiveAgent("hi")).rejects.toThrow(/PERMISSION_REQUIRED/);
```

It validates argument shapes the way the real host does — `registerAction` descriptors (id grammar, kind, danger, required strings), `showToast` message/type/`durationMs` bounds and unknown keys, `setPanelBadge` shape and unknown keys, the channel format of `postToPanel`, `broadcastToRenderer`, `hasListeners` and `onDidChangeListeners` (only `registerHandler` skips it), `showConfirm`'s string `title`, `showQuickPick` item arrays, `fs.watch` options, `sendToAgent` text, title and ids, `documents.renderPdf` options (with the host's own validator), and `git.commit`'s non-empty message — so a malformed call fails the test the way it would fail in the app.

### Options

| Option | Default | Effect |
| --- | --- | --- |
| `pluginId` | `"test.mock"` | `host.pluginId`. A `project__{projectId}__{manifestId}` key makes it a project plugin, and `pluginInfo` / `panelKindId` follow from it with the real parsers. |
| `projectRoot` | `/projects/{projectId}` | `pluginInfo.projectRoot` for a project `pluginId`; ignored for a global one. |
| `pluginDataDir` | `~/.daintree/plugin-data/{pluginId}` | Inside it, `fs.appendFile` creates missing parents, as the host does for your data directory. `fs.writeFile` never checks or creates parents anywhere: a stored file implies its directories. |
| `capabilities` | `["agent:read", "agent:input"]` | The declared set the agent APIs check. |
| `hasActiveAgent` | `true` | `false` makes `sendToActiveAgent` reject `NO_ACTIVE_AGENT`. |
| `agents` | `[]` | The panes `agents.list()` returns and `sendToAgent({ terminalId })` resolves against. |
| `allAgents` | `{ agents: [], degraded: false, lastSuccessfulAt: 0 }` | What `agents.listAll()` returns, reduced to the allowlist and frozen as production does. |
| `terminalScreens` | `{}` | What `terminals.readScreen` finds, by terminal id; an unlisted id reads `not-found`. An `ok` screen is trimmed to the call's `lines`. There is no rate limit and no byte cap. |
| `activeWorktree`, `worktrees`, `worktreesResult` | `null`, `[]`, derived | What the worktree reads return. Without `worktreesResult`, `getWorktreesResult()` answers `{ status: "ok", projectId: "test-project", worktrees }`; with one, it also drives `getWorktrees()` (`[]` unless `ok`) and `getActiveWorktree()` (the `isCurrent` entry). Worktree roots also count as existing directories in the mock `fs`, and the active one keys `"worktree"` storage. |
| `manifestSettings` | none | Your `contributes.settings` declarations. With them, `get`, `set` and `onDidChange` follow declared scopes (a conflicting scope throws), `get` returns declared defaults, and `missingRequired` works; without them, scopes are whatever you pass and nothing is required. |
| `settings`, `storage` | empty | Starting values per scope (`user` / `project` / `local`; `user` / `project` / `worktree`). A `storage.worktree` seed goes to the initial active worktree, and is dropped when there is none. |
| `databases` | temp directory, any id | `{ directory?, declared?, journalMode? }` for `host.db`. Each id is a real SQLite file run through the same handle code as production, so migrations, `definitions`, readonly, `DB_*` codes and `onDidChange` behave for real. Pass `declared` to get `DB_NOT_DECLARED` for anything else. |
| `dispatch` | built-in routing | A resolver for `host.dispatch`. By default a dispatch reaches your own registered actions by their namespaced id (`{pluginId}.{id}`) only, answers `NOT_FOUND` otherwise, and turns a handler that throws into `EXECUTION_ERROR`. It never answers `RESTRICTED`, `CONFIRMATION_REQUIRED` or `PROJECT_VIEW_UNAVAILABLE`, runs a `confirm` action's handler anyway, and ignores `options.projectId`, so none of those gates is tested. |
| `reloadPanel` | lifecycle-derived | A resolver for `host.reloadPanel`. By default the answer follows the last phase you pushed for that panel with `simulatePanelLifecycleChange`: `mounted` → `scheduled`, `render-failed` → `unavailable`, any other phase or an unknown panel → `not-mounted`, and a panel reported for another plugin rejects. |

There is no option to seed files; write them with `host.fs.writeFile` (which records the call in `fsWriteCalls`).

### Recorders

All are read-only arrays in call order.

- **Current registrations**, not a history — re-registering the same id replaces the entry in place, and disposing a provider or MCP roster removes it: `registeredActions`, `registeredForgeProviders`, `registeredFileDecorationProviders`, `registeredMcpTools` (with each tool's `execute`, so a test can call a tool directly).
- **Subscription windows:** `subscriptionOptions` has one `{ kind, debounceMs }` per `onDidChangeWorktrees` (`"worktrees"`), `onDidChangeActiveWorktree` (`"active-worktree"`), `onDidChangeAgentState` (`"agent-state"`) and `onDidChangeAllAgents` (`"all-agents"`) subscription, with the window the host would apply — 100 for an omitted option, `0` for raw, otherwise clamped to 50–60,000 — so a test can assert a plugin kept the default or opted out.
- **Append-only call records:** `registeredHandlers`, `broadcastCalls`, `postToPanelCalls` (`panelId` is `null` for a broadcast), `shownToasts`, `dispatchedActions` (every call, including `settings.open`, recorded as `plugin.openSettings`), `sentToActiveAgentCalls`, `sentToAgentCalls` (`{ text, options, result }`), `invalidationCalls`, `setPanelBadgeCalls`, `reloadPanelCalls`, `showQuickPickCalls`, `showInputBoxCalls`, `showConfirmCalls`, `spawnCalls`, `fsWriteCalls`, `fsAppendCalls` (the appended text only), `fsMkdirCalls`, `gitCommitCalls`, `clipboardWriteCalls`, `clipboardWriteImageCalls` (byte lengths), `systemOpenPathCalls`, `systemShowItemCalls`, `documentsRenderPdfCalls`.

Calls that fail validation, and prompts or `sendToAgent` calls whose signal was already aborted, are not recorded. `/testing` exports some record types by name (`RegisteredActionRecord`, `RegisteredHandlerRecord`, `ShownToastRecord`, `ShowConfirmRecord`, …) but not all: the elements of `postToPanelCalls`, `spawnCalls`, `setPanelBadgeCalls`, `fsWriteCalls`, `gitCommitCalls`, `sentToActiveAgentCalls` and `subscriptionOptions` have no importable type, so infer them from the array — `MockHostState["postToPanelCalls"][number]`.

### Driving it

| Method | Effect |
| --- | --- |
| `simulateActiveWorktreeChange(snapshot \| null)` | Sets the active worktree and notifies `onDidChangeActiveWorktree`. |
| `simulateWorktreesChange(snapshots)` | Replaces the list and notifies `onDidChangeWorktrees` at once, with the same `{ added, removed, changed }` change argument the host computes per subscription. |
| `simulateWorktreesResult(result \| null)` | Forces what `getWorktreesResult()` answers; `null` goes back to deriving it. Notifies nobody. |
| `simulateAgentStateChange(snapshot)` | Sets what `getAgentState()` returns and notifies `onDidChangeAgentState`. |
| `simulateAgentsChange(panes)` | Replaces what `agents.list()` returns. |
| `simulateAllAgentsChange(snapshot)` | Replaces what `agents.listAll()` returns and notifies `onDidChangeAllAgents` at once, ignoring its window. |
| `simulateTerminalScreen(terminalId, screen \| null)` | Sets what `terminals.readScreen(terminalId)` finds; `null` forgets the terminal, so it reads `not-found`. Every call that passes validation lands in `readScreenCalls` as `{ terminalId, lines, result }`. |
| `simulateSendToAgentPick(terminalId \| null)` | What the picker "chooses" when `sendToAgent` has no `terminalId`; `null` (the default) cancels. A pane with `canDraft: false` refuses with its `draftRefusal`, an unknown one with `unknown-terminal`. |
| `simulatePanelLifecycleChange(event)` | Notifies `onDidChangePanelLifecycle` and updates the phases `reloadPanel` reads. |
| `simulateSystemWake(event)` | Notifies `onDidWake`. |
| `simulateListenersChange(channel, hasListeners)` | Sets what `hasListeners(channel)` answers and, when that changes it, calls that channel's `onDidChangeListeners` callbacks. Every channel starts out listened to, as on a real host that has not heard from a renderer. |
| `simulateFsWatch(changedPath)` | Fires the watchers whose path is `changedPath` or its parent — or any ancestor, for a `recursive` watch. A `debounceMs` watcher gets one trailing callback on a real timer, so drive it with fake timers. |
| `simulateQuickPickResponse(result)`, `simulateInputBoxResponse(result)`, `simulateConfirmResponse(result)` | What the next prompts resolve (`undefined`, `undefined`, `false` by default). |
| `setDispatchResult(actionId, result)` | A fixed `dispatch` answer for one id, ahead of the `dispatch` option. |
| `seedActionCatalog(entries)` | Replaces the catalog behind `actions.list` / `get` / `canDispatch`. |

### What the mock does not do

It has no manifest model and no processes behind it, so a test that passes against it is not proof the real host will accept the plugin. The gaps, from `shared/testing/createMockHost.ts`:

- **Capabilities and consent.** Only `getAgentState`, `agents.list`, `agents.listAll`, `onDidChangeAllAgents`, `sendToActiveAgent`, `sendToAgent` and `terminals.readScreen` check `capabilities`. `onDidChangeAgentState` subscribes without `agent:read`, and `fs`, `git`, `process`, `clipboard`, `system`, `documents`, `db` and `mcp` run without their capabilities. No just-in-time consent is modelled anywhere, and `sendToAgent` draws no picker.
- **`fs`** is an in-memory map of text with no containment and no symlinks. A directory exists when `mkdir` made it (with every ancestor), when something stored sits beneath it, or when it is a worktree root; a path holding a file is never a directory. `appendFile` refuses a directory target and a missing parent (outside `pluginDataDir`); `writeFile` does not check parents. A missing file rejects with an `ENOENT:` message but no `err.code`. `stat` reports `isDirectory` only for `mkdir`-made directories and never throws; `readdir` of a missing directory resolves `[]`; `size` in a detailed listing is the string length, not bytes, and `mtimeMs` is `0`. `watch` validates `allowMissing` but otherwise ignores it.
- **`db`** always reports `location: "local"`, and `backup` approves any absolute destination — the fs gate is not modelled.
- **`documents.renderPdf`** renders nothing: it validates the options, requires an in-memory `htmlPath`, and writes a small `%PDF-1.4` placeholder to `outputPath` so a plugin that reads or lists its export sees a file. That write is not in `fsWriteCalls`, and the parent directory is not checked.
- **`process.spawn`** records the call and returns an inert handle: `kill`, `restart`, `write` and `resize` are no-ops, and `onData` / `onExit` / `onCrash` never fire.
- **`git.status`** returns no files, `git.diff` returns `""`, `git.add` does nothing, and `git.commit` answers a synthetic `mock-N` hash.
- **Settings and storage.** `settings.set` neither refuses an undeclared key nor checks that the value survives JSON (`NaN` is kept as `NaN`), and `onDidChange` fires when the new value is not `Object.is` the old one rather than when the stored JSON changes. A `secret` is held in plain memory, not encrypted, so a keychain failure is never simulated.
- **`clipboard` and `system`** check no capability and no containment; `system` records paths and opens nothing, and the clipboard starts empty with no option to seed it.
- **Snapshots** you pass in (worktrees, agent state) are handed back as they are, not frozen, so a plugin that mutates one passes here and throws in the app.
- **Registration gates.** `registerHandler` checks only the channel name, refusing a colon as the host does: the typed overload discards the schema, so nothing validates a payload against it. `broadcastToRenderer` rejects a bad channel where the real host throws at the call. `registerForgeProvider`, `registerFileDecorationProvider` and `mcp.registerTools` skip the manifest-declaration gates; `mcp.registerTools` neither enforces the roster budget nor compiles the schemas, and does not reject a tool's `annotations`, including a read-only or other safety claim; `invalidateFileDecorations` accepts any non-empty scope.
- **Subscriptions.** Nothing is replayed on subscribe, a throwing listener is never quarantined, and nothing is coalesced: the mock records the window each subscription would get (`subscriptionOptions`) but delivers every simulated event synchronously. A database handle's `onDidChange` is the exception, since `host.db` runs the production handle code.
- **Transport limits.** No invoke deadline runs, and no payload cap or clone snapshot applies to handlers, results or pushes; `postToPanelCalls` holds the payload object you passed. Push batching and ordering are not modelled. Test a large payload's path against the caps in `shared/config/pluginBudgets.ts` yourself.
- **`fs.walk` and `fs.readFiles`** run the host's validation, ordering, pruning, truncation and budgets over the in-memory files. There is no git and there are no symlinks, so `respectGitignore` is accepted with nothing to act on.
- **`logger`** calls are no-ops: nothing is printed and nothing is recorded.
- **Lifecycle.** Registrations made before a throwing `activate()` are not rolled back, and no revoke ever runs, so a handle keeps working after the point at which the real host would have cut it off.

## What's not exposed

Deliberately not part of the host API:

- Direct access to other plugins' state or registered handlers.
- Access to the active user's AI-provider API keys. If a plugin needs AI calls, the user configures keys separately in settings or the plugin ships its own `secret` setting.
- Full control of the active AI agent's runtime — driving, pausing, or resuming an agent session. That crosses the agent-config boundary (precedent #4100: never mutate user-owned agent config or session behaviour the user didn't opt into) and stays deferred. Getting a plugin's tools into an agent is the one exception, and only in the sanctioned shape: [`mcp.registerTools`](#mcpregistertools) tools reach agent launches through a Daintree-owned file or launch environment in each CLI's own additive mechanism ([Agent extensions → Reaching an agent](./agent-extensions.md#reaching-an-agent)), never through the user's own agent config, and only in projects where the plugin's agent access is on. Passive observation is offered instead of the rest: [`getAgentState` / `onDidChangeAgentState`](#agent-observation) under `agent:read`. The sanctioned writes are text, never control: [`host.sendToActiveAgent`](#sendtoactiveagent--inject-text-into-the-active-agent) (gated on `agent:input`, JIT consent, stage-only by default) sends input to the active agent terminal, and [`host.sendToAgent`](#sendtoagent--hand-work-to-an-agents-draft) (same gate) appends to a chosen agent's visible draft and can never submit it. For everything else, `dispatch` into existing actions is the path.
- An inbound webhook listener or a host-mediated `host.fetch`. Deferred: `scopes.network.allowedUrls` is still advisory rather than a request filter, and an inbound listener widens the attack surface in a way that wants the network-enforcement question settled first. Make outbound calls from your own `main` for now, and declare `network:fetch` with a tight `scopes.network.allowedUrls`.
- Raw Electron main-process APIs are not _passed through_ the host — but the contained, audited equivalents are: `host.process` (managed child processes, gated on `shell:exec`), `host.fs` (scope-contained filesystem), and `host.git` (worktree-scoped git). You can still `import` Node modules directly in plugin code and the host cannot intercept that, so the host-mediated surfaces are the contained, audited path — not a seal on the un-mediated one.
- Daintree's internal event bus. Only the specific subscriptions listed above are exposed. Broad event access would tie plugins to internal shape changes we want to be free to make.

If you have a legitimate need that isn't covered, open an issue with the use case.

## Process model and memory

User-installed plugins — whether sideloaded, installed from a `.dntr` or URL, or `dev`-linked — run **out-of-process** in a `utilityProcess.fork` worker (#10526). Your `main` executes in a child process with its own module realm; the host bridges every `host.*` call and registration over a MessagePort. This is what makes teardown clean: when a plugin is unloaded (uninstall, disable, or dev reload), the host runs the full disposal cascade — IPC handlers, actions, forge and file-decoration providers, worktree subscriptions, and the cleanup function your `activate()` returned — and then **kills the worker**, so the plugin's entire module realm (module-scope `let`/`const` bindings, import-time singletons, stray timers or connections) is reclaimed. There is no ESM module-cache leak and no module-scope state surviving across a reload; dev hot-reload works for exactly this reason.

You should still keep teardown-able work inside `activate()` and its returned cleanup rather than module scope — that's the disposal contract — but you are not paying a per-reload memory penalty for getting it wrong, because the worker is discarded wholesale.

The one behavior to design around: **`registerForgeProvider` is a no-op out-of-process.** A forge provider's `parseRemote` and URL builders are synchronous and can't cross the async MessagePort, so forge providers are usable only by Daintree's **built-in** plugins — the exception to the worker model. Built-ins activate in-process via `import()` because they're trusted, app-bundled, and never unloaded. (An in-process built-in module is never evicted from V8's cache, but since built-ins are never uninstalled that residue is inert.) See [Architecture → Activation](./architecture.md#activation).

### Worker and in-process differences

The worker host implements the same `PluginHostApi`, but some checks run in main, across the port, rather than at your call site. What a worker plugin sees differently from a built-in:

- **Registration errors arrive late.** A worker checks only the shape of a registration locally (non-empty ids and channels, function handlers, the MCP roster). The deeper checks — a colon in a `registerHandler` channel, a typed channel's `requires` capabilities, an action descriptor's grammar, an undeclared file-decoration provider or `agentMcp` endpoint, `mcp:expose` — run in main and fail the activation by name instead of throwing where you called. A `try`/`catch` around the `await` does not see them.
- **Some runtime validation only logs.** An invalid `setPanelBadge` shape or an undeclared `invalidateFileDecorations` scope resolves in a worker and is logged in main; in process it rejects. An empty `panelId` on `postToPanel` or `setPanelBadge` rejects on both, like the channel check.
- **A failed subscription is silent.** `settings.onDidChange` / `storage.onDidChange` with a conflicting scope, or `onDidChangeAgentState` without `agent:read`, throws synchronously in process. In a worker only the revoked-host check throws; the rest is logged in main and you get a disposer whose callback never fires.
- **Arguments must structured-clone.** A worker sends every call over a `MessagePort`. A call that returns a Promise rejects with `DataCloneError` on an uncloneable argument, but the fire-and-forget ones — `logger.*`, `broadcastToRenderer`, `setPanelBadge`, the `register*` calls — throw it synchronously, `logger` included. `postToPanel` rejects its Promise instead, and both push methods check the 1 MiB cap in the worker before the payload crosses, so an oversize push fails at your call either way. An in-process push that structured clone refuses fails with `PLUGIN_PAYLOAD_UNCLONEABLE` instead of `DataCloneError`. In process, `logger` coerces an unserializable `fields` payload to a string and `showQuickPick` narrows items to their declared fields.
- **Errors are rebuilt.** Only `message`, `code` and `currentRevision` survive the port (see [Errors](#errors-and-error-codes)); a failed `appendFile`'s bytes-written count does not. In the other direction, an error your action, handler or provider throws reaches main as its message only.
- **Aborts settle locally.** For `fs.*`, `git.*` and `getWorktreeStatus` the worker rejects with an `AbortError` the moment the signal fires, while main may still finish the operation — a `git.add` or `git.commit` can land after you saw the abort. A prompt aborted in a worker resolves its dismiss value at once. `sendToAgent` is the exception: an abort only asks main to dismiss an unanswered picker, and the call resolves with what actually happened. An already-aborted signal short-circuits in a worker before any validation, capability check or consent; in process those still run first.
- **After unload.** A worker's pending and later calls reject with `Plugin dev worker disposed`, except the ones with documented fallbacks (`getWorktreesResult`, `reloadPanel`, `actions.*`, `agents.list`, `sendToAgent`, the prompts), which answer them on both hosts. In process, the reads degrade to `null` / `[]` and `showToast` / `sendToActiveAgent` become no-ops.
- **Listeners are never quarantined** in a worker; each throw is logged ([Disposables](#disposables)).
- **A timed-out invoke keeps running.** When a handler's [deadline](#deadlines-and-size-limits) passes, main rejects the view's call and tells the worker; the handler is not interrupted, but its result is dropped in the worker rather than cloned back. An in-process builtin's handler runs on with nobody waiting.
- **`hasListeners`** reads a per-channel value main keeps the worker told about, so the first read for a channel answers `true` until main's first report arrives. A worker watches at most 256 channels; past that it answers `true`.
- **`pluginInfo`** is a structured-cloned copy in a worker, not frozen.
- **`host.db`** resolves the location and approves a backup destination in main, but opens `node:sqlite` in the worker, so queries, `transaction`, `onDidChange` and the backup's snapshot never cross the port.
- **`host.fs.watch`** runs the watcher in main and delivers events over the port.
- **`registerForgeProvider`** is a no-op that logs a warning (above).
- **Built-in only:** `fsForWorkspace` and `fs.readFileBounded` exist on the built-in host type and never in a worker.

The worker runs with a 256 MB heap, a minimal allowlisted environment rather than Daintree's own, and its working directory set to the plugin's directory.
