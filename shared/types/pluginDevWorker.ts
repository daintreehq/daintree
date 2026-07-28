// IPC protocol for the plugin dev-mode hot-reload worker (#9304).
//
// A dev-symlinked plugin (one carrying a `.dev-marker` file, written by
// `daintree-plugin dev`) runs its code inside a `utilityProcess.fork` child
// instead of the in-process `import()` loader. This avoids the Node ESM
// module-cache leak (Vite issue #14438) — cache-busting query params leave
// module-scope state behind, so the only robust reload is to kill the whole
// worker and fork a fresh one on every `dist/index.js` rebuild.
//
// The worker can't hold the real `PluginHostApi` (the host's closures, Zod
// schemas, and service references all live in the main process), so the worker
// constructs a *proxy* host whose every call is relayed over the MessagePort to
// `PluginDevWorkerMainBridge`, which forwards to the real host returned by
// `PluginService.createHost`. Handlers the plugin registers (action handlers,
// IPC handlers) stay in the worker; main invokes them back over the same port.
//
// Every message is structured-clone-safe: no functions, no Zod instances, no
// class instances. Requests that expect a reply carry a `requestId`.

import type {
  PluginIpcContext,
  PluginSettingsScope,
  PluginStorageScope,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginInputBoxOptions,
  PluginConfirmOptions,
  PluginProcessSpawnOptions,
  PluginPtyProcessSpawnOptions,
  PluginProcessMode,
  PluginPanelBadge,
  BuiltInPluginCapability,
} from "./plugin.js";

/** Async host methods the worker proxy relays to main and awaits a reply for. */
export type PluginHostCallMethod =
  | "getActiveWorktree"
  | "getWorktrees"
  | "getWorktreeStatus"
  | "getAgentState"
  | "sendToActiveAgent"
  | "showToast"
  | "dispatch"
  | "actions.list"
  | "actions.get"
  | "settings.get"
  | "settings.set"
  | "storage.get"
  | "storage.set"
  | "storage.delete"
  | "fs.readFile"
  | "fs.writeFile"
  | "fs.readdir"
  | "fs.stat"
  | "fs.watch"
  | "git.status"
  | "git.diff"
  | "git.add"
  | "git.commit"
  | "clipboard.writeText"
  | "clipboard.writeImage"
  | "clipboard.readText"
  | "system.openPath"
  | "system.showItemInFolder"
  | "showQuickPick"
  | "showInputBox"
  | "showConfirm"
  | "process.spawn"
  | "process.restart";

/** Fire-and-forget host methods (no reply needed). */
export type PluginHostNotifyMethod =
  | "registerAction"
  | "registerHandler"
  | "broadcastToRenderer"
  | "postToPanel"
  | "invalidateFileDecorations"
  | "setPanelBadge"
  | "registerFileDecorationProvider"
  | "unregisterFileDecorationProvider"
  | "logger.info"
  | "logger.warn"
  | "logger.error"
  | "process.kill"
  // Interactive-process input (#11300). Fire-and-forget like `process.kill`:
  // `write`/`resize` are void in the public handle contract, so there is no
  // reply for the worker to await.
  | "process.write"
  | "process.resize";

/**
 * Event subscriptions the worker proxy can open against the host. The
 * `process-exit` / `process-crash` / `process-data` kinds wire a spawned
 * process's lifecycle and output callbacks back to the worker, keyed by the
 * handle id carried in `processId`. `panel-lifecycle` streams this plugin's
 * own panel transitions (#11301) — the host replays each live panel's current
 * phase at subscribe time.
 */
export type PluginWorkerSubscriptionKind =
  | "active-worktree"
  | "worktrees"
  | "settings"
  | "storage"
  | "agent-state"
  | "panel-lifecycle"
  | "process-exit"
  | "process-crash"
  | "process-data";

/**
 * Callback kinds main invokes back in the worker. `file-decoration-method`
 * round-trips a registered `FileDecorationProviderImpl` method (just
 * `provideDecorations`, which is async — see {@link RegisterFileDecorationProviderParams}).
 * Forge providers are deliberately absent: `ForgeProviderImpl` has required
 * SYNCHRONOUS methods (`parseRemote`, the URL builders, `classifyPushError`)
 * the host calls and consumes synchronously, which can't cross this async port.
 */
export type PluginWorkerInvokeKind = "action" | "handler" | "file-decoration-method";

/** Messages sent main → worker. */
export type PluginHostToWorkerMessage =
  /** Kick off: import the plugin bundle at `bundleUrl` and call `activate(proxy)`. */
  | { type: "start"; bundleUrl: string; pluginId: string }
  /** Graceful shutdown request — worker runs the plugin's cleanup then exits. */
  | { type: "dispose" }
  /** Reply to a worker `host-call`. */
  | { type: "host-result"; requestId: string; ok: true; result: unknown }
  | { type: "host-result"; requestId: string; ok: false; error: string }
  /**
   * Invoke a worker-held callback (action or IPC handler) and await its result
   * via a matching `invoke-result` from the worker.
   */
  | {
      type: "invoke";
      requestId: string;
      kind: "action";
      namespacedId: string;
      args: unknown;
    }
  | {
      type: "invoke";
      requestId: string;
      kind: "handler";
      channel: string;
      ctx: PluginIpcContext;
      args: unknown[];
    }
  | {
      type: "invoke";
      requestId: string;
      kind: "file-decoration-method";
      providerId: string;
      method: string;
      args: unknown[];
    }
  /** Deliver a subscription event to a worker-held callback (fire-and-forget). */
  | { type: "subscription-event"; subscriptionId: string; payload: unknown }
  /**
   * Async outcome of a fire-and-forget registration (`registerAction` /
   * `registerHandler`). Lets the worker surface a registration that the real
   * host rejected — the proxy call already returned synchronously, so this is
   * the only channel for a deep-validation failure.
   */
  | { type: "register-error"; registrationKey: string; error: string };

/**
 * Empirical permission-model self-check the worker reports at boot (spike
 * #10890). `present` is `true` when Node's permission model is actually active
 * in the worker (`process.permission` exists). It lets the host record whether
 * Electron honored the `--permission` `execArgv` flags — expected `false` on
 * Electron 42, whose utility-process bootstrap does not run Node's permission
 * CLI parsing. Optional so older workers (no self-check) stay protocol-compatible.
 */
export interface PluginWorkerPermissionStatus {
  present: boolean;
}

/** Messages sent worker → main. */
export type PluginWorkerToHostMessage =
  /** Worker booted, parent-port listener attached, ready for `start`. */
  | { type: "ready"; permission?: PluginWorkerPermissionStatus }
  /** `activate(proxy)` resolved. `hasCleanup` records whether it returned a disposer. */
  | { type: "activated"; hasCleanup: boolean }
  /** `activate(proxy)` threw or rejected. */
  | { type: "activate-error"; error: string; stack?: string }
  /** Bootstrap / uncaught error before or after activation. */
  | { type: "error"; error: string }
  /** Async host method call expecting a `host-result`. */
  | {
      type: "host-call";
      requestId: string;
      method: PluginHostCallMethod;
      params: unknown;
    }
  /**
   * Cancel an in-flight `host-call`. The proxy posts this when the caller's
   * `AbortSignal` fires — the signal itself isn't structured-clone-safe, so the
   * `requestId` is the cancellation handle. The bridge aborts the matching
   * in-flight host call; a no-op if it already settled.
   */
  | { type: "host-cancel"; requestId: string }
  /** Fire-and-forget host method call. `registrationKey` correlates `register-error`. */
  | {
      type: "host-notify";
      method: PluginHostNotifyMethod;
      params: unknown;
      registrationKey?: string;
    }
  /** Open an event subscription against the host. */
  | {
      type: "subscribe";
      subscriptionId: string;
      kind: PluginWorkerSubscriptionKind;
      key?: string;
      scope?: PluginSettingsScope | PluginStorageScope;
      /**
       * Opt-in debounce for the `worktrees` subscription (host-side coalescing).
       * Ignored for other kinds. Mirrors `PluginHostSubscriptionOptions.debounceMs`.
       */
      debounceMs?: number;
      /** Handle id for `process-exit` / `process-crash` / `process-data` subscriptions. */
      processId?: string;
    }
  /** Close a previously opened subscription. */
  | { type: "unsubscribe"; subscriptionId: string }
  /** Reply to a main `invoke`. */
  | { type: "invoke-result"; requestId: string; ok: true; result: unknown }
  | { type: "invoke-result"; requestId: string; ok: false; error: string };

/** Params for `registerAction` (`host-notify`). Mirrors `PluginActionContribution`. */
export interface RegisterActionParams {
  descriptor: {
    id: string;
    title: string;
    description: string;
    category: string;
    kind: "command" | "query";
    danger: "safe" | "confirm";
    keywords?: string[];
    inputSchema?: Record<string, unknown>;
    /**
     * Per-action capability intent (#11299). Must cross the port explicitly:
     * the bridge reconstructs the descriptor field by field, so an omitted
     * field is silently dropped rather than failing to compile. Dropping it
     * would send a dev plugin's one-click action back to whole-manifest
     * elevation — the exact bug this field exists to fix, visible only in the
     * dev loop.
     */
    requires?: readonly BuiltInPluginCapability[];
  };
}

/**
 * Params for `registerHandler` (`host-notify`). The Zod schema can't cross the
 * port, so only the declared `requires` capabilities travel — the bridge
 * registers an untyped wrapper and the worker keeps the schema for local
 * `safeParse` validation. `hasSchema` distinguishes the typed overload (so the
 * bridge can fail-closed on the capability gate) from the legacy untyped one.
 */
export interface RegisterHandlerParams {
  channel: string;
  hasSchema: boolean;
  requires?: string[];
}

/** Params for `broadcastToRenderer` (`host-notify`). */
export interface BroadcastToRendererParams {
  channel: string;
  payload: unknown;
}

/**
 * Params for `postToPanel` (`host-notify`) — the post-activation-safe sibling
 * of `broadcastToRenderer`. Relayed off the activation-window guard so it stays
 * callable from worker timers and subscription callbacks. `panelId` carries the
 * per-instance target (#10618): a non-empty string targets one panel instance,
 * `null`/absent broadcasts. Forwarded verbatim — the main-side host resolves the
 * routing and wraps the renderer envelope.
 */
export interface PostToPanelParams {
  channel: string;
  payload: unknown;
  panelId?: string | null;
}

/** Params for `invalidateFileDecorations` (`host-notify`). */
export interface InvalidateFileDecorationsParams {
  scope: string;
  paths?: string[];
}

/** Params for `setPanelBadge` (`host-notify`). `null` clears the badge. */
export interface SetPanelBadgeParams {
  panelId: string;
  badge: PluginPanelBadge | null;
}

/**
 * Params for `registerFileDecorationProvider` (`host-notify`). Only the
 * structured-clone-safe descriptor fields travel; the `provideDecorations` impl
 * stays in the worker and main invokes it back via a `file-decoration-method`
 * `invoke` (mirrors the `registerAction` handler round-trip).
 */
export interface RegisterFileDecorationProviderParams {
  descriptor: {
    id: string;
    scopes?: string[];
  };
}

/** Params for `unregisterFileDecorationProvider` (`host-notify`). */
export interface UnregisterFileDecorationProviderParams {
  providerId: string;
}

/** Params for a `logger.*` call (`host-notify`). */
export interface LoggerParams {
  message: string;
  fields?: Record<string, unknown>;
}

/** Params for `settings.get` (`host-call`). */
export interface SettingsGetParams {
  key: string;
  /**
   * Omitted (`undefined`) when the plugin passed no scope, so the host resolves
   * the key's manifest-declared scope on read (#10586) rather than a defaulted
   * "user" that a project-scoped key would reject.
   */
  scope?: PluginSettingsScope;
}

/** Params for `settings.set` (`host-call`). */
export interface SettingsSetParams {
  key: string;
  value: unknown;
  scope: PluginSettingsScope;
}

/** Params for `storage.get` (`host-call`). */
export interface StorageGetParams {
  key: string;
  scope: PluginStorageScope;
}

/** Params for `storage.set` (`host-call`). */
export interface StorageSetParams {
  key: string;
  value: unknown;
  scope: PluginStorageScope;
}

/** Params for `storage.delete` (`host-call`). */
export interface StorageDeleteParams {
  key: string;
  scope: PluginStorageScope;
}

/** Params for `showToast` (`host-call`). */
export interface ShowToastParams {
  message: string;
  type?: string;
  durationMs?: number;
}

/** Params for `dispatch` (`host-call`). */
export interface DispatchParams {
  actionId: string;
  args?: unknown;
}

/**
 * Params for `actions.get` (`host-call`, #10561). `actions.list` takes no
 * params. `actions.canDispatch` is derived worker-side from `actions.get`, so it
 * has no dedicated host-call method.
 */
export interface ActionsGetParams {
  actionId: string;
}

/** Params for `sendToActiveAgent` (`host-call`). */
export interface SendToActiveAgentParams {
  text: string;
  options?: { submit?: boolean };
}

/** Params for `showQuickPick` (`host-call`). */
export interface ShowQuickPickParams {
  items: PluginQuickPickItem[];
  options?: PluginQuickPickOptions;
}

/** Params for `showInputBox` (`host-call`). */
export interface ShowInputBoxParams {
  options?: PluginInputBoxOptions;
}

/** Params for `showConfirm` (`host-call`). */
export interface ShowConfirmParams {
  options: PluginConfirmOptions;
}

/** Params for `fs.readFile` / `fs.readdir` / `fs.stat` (`host-call`). */
export interface FsPathParams {
  path: string;
}

/** Params for `fs.writeFile` (`host-call`). */
export interface FsWriteFileParams {
  path: string;
  contents: string;
}

/** Params for `git.status` / `git.diff` / `git.add` / `git.commit` (`host-call`). */
export interface GitOpParams {
  worktreePath: string;
  filePath?: string;
  paths?: string[];
  message?: string;
}

/** Params for `clipboard.writeText` (`host-call`). `clipboard.readText` takes no params. */
export interface ClipboardWriteTextParams {
  text: string;
}

/**
 * Params for `clipboard.writeImage` (`host-call`). The bytes ride the port as a
 * `Uint8Array`; structured clone preserves the typed array, so the bridge hands
 * the host the same view the plugin passed. The host re-checks the size cap on
 * its side — the worker is the untrusted party here.
 */
export interface ClipboardWriteImageParams {
  pngData: Uint8Array;
}

/** Params for `system.openPath` / `system.showItemInFolder` (`host-call`). */
export interface SystemPathParams {
  targetPath: string;
}

/** Params for `process.spawn` (`host-call`). */
export interface ProcessSpawnParams {
  command: string;
  options?: PluginProcessSpawnOptions | PluginPtyProcessSpawnOptions;
}

/**
 * Result of `process.spawn` (`host-call`). The host-assigned handle id the
 * worker proxy uses to address `process.kill` / `process.restart` / `process.write`
 * / `process.resize` and to open the `process-exit` / `process-crash` /
 * `process-data` subscriptions.
 *
 * `mode` is authoritative, not an echo of what the worker asked for: the proxy
 * builds the interactive handle shape only when the host actually allocated a
 * PTY, so a plugin can never be handed a `write()` that silently goes nowhere.
 */
export interface ProcessSpawnResult {
  id: string;
  mode: PluginProcessMode;
}

/** Params for `process.kill` (`host-notify`) and `process.restart` (`host-call`). */
export interface ProcessHandleRefParams {
  processId: string;
}

/** Params for `process.write` (`host-notify`) — interactive processes only. */
export interface ProcessWriteParams {
  processId: string;
  data: string;
}

/** Params for `process.resize` (`host-notify`) — interactive processes only. */
export interface ProcessResizeParams {
  processId: string;
  cols: number;
  rows: number;
}

/**
 * Params for `fs.watch` (`host-call`). The call both establishes the watcher —
 * rejecting on a missing capability / out-of-scope path so the in-process
 * `watch` rejection contract is preserved — and opens the subscription whose
 * change events arrive as `subscription-event`s keyed by `subscriptionId`.
 */
export interface FsWatchParams {
  subscriptionId: string;
  paths: string[];
}

/**
 * Env var name set on the forked worker so the worker module can assert it is
 * running in the intended utility-process kind (mirrors the
 * `DAINTREE_UTILITY_PROCESS_KIND` convention used by the other hosts).
 */
export const PLUGIN_DEV_WORKER_KIND = "plugin-dev-worker";

/**
 * Sibling of {@link PLUGIN_DEV_WORKER_KIND} for production plugins. They run in
 * the same `utilityProcess.fork` worker but without the dev hot-reload file
 * watcher; the distinct kind keeps the two apart in process-monitor logs.
 */
export const PLUGIN_PROD_WORKER_KIND = "plugin-prod-worker";
