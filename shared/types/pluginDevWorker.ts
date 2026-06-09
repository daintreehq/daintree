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

import type { PluginIpcContext, PluginSettingsScope } from "./plugin.js";

/** Async host methods the worker proxy relays to main and awaits a reply for. */
export type PluginHostCallMethod =
  | "getActiveWorktree"
  | "getWorktrees"
  | "showToast"
  | "dispatch"
  | "settings.get"
  | "settings.set";

/** Fire-and-forget host methods (no reply needed). */
export type PluginHostNotifyMethod =
  | "registerAction"
  | "registerHandler"
  | "broadcastToRenderer"
  | "invalidateFileDecorations"
  | "logger.info"
  | "logger.warn"
  | "logger.error";

/** Event subscriptions the worker proxy can open against the host. */
export type PluginWorkerSubscriptionKind = "active-worktree" | "worktrees" | "settings";

/** Callback kinds main invokes back in the worker. */
export type PluginWorkerInvokeKind = "action" | "handler";

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
  /** Deliver a subscription event to a worker-held callback (fire-and-forget). */
  | { type: "subscription-event"; subscriptionId: string; payload: unknown }
  /**
   * Async outcome of a fire-and-forget registration (`registerAction` /
   * `registerHandler`). Lets the worker surface a registration that the real
   * host rejected — the proxy call already returned synchronously, so this is
   * the only channel for a deep-validation failure.
   */
  | { type: "register-error"; registrationKey: string; error: string };

/** Messages sent worker → main. */
export type PluginWorkerToHostMessage =
  /** Worker booted, parent-port listener attached, ready for `start`. */
  | { type: "ready" }
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
      scope?: PluginSettingsScope;
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

/** Params for `invalidateFileDecorations` (`host-notify`). */
export interface InvalidateFileDecorationsParams {
  scope: string;
  paths?: string[];
}

/** Params for a `logger.*` call (`host-notify`). */
export interface LoggerParams {
  message: string;
  fields?: Record<string, unknown>;
}

/** Params for `settings.get` (`host-call`). */
export interface SettingsGetParams {
  key: string;
  scope: PluginSettingsScope;
}

/** Params for `settings.set` (`host-call`). */
export interface SettingsSetParams {
  key: string;
  value: unknown;
  scope: PluginSettingsScope;
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
 * Env var name set on the forked worker so the worker module can assert it is
 * running in the intended utility-process kind (mirrors the
 * `DAINTREE_UTILITY_PROCESS_KIND` convention used by the other hosts).
 */
export const PLUGIN_DEV_WORKER_KIND = "plugin-dev-worker";
