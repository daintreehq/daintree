// Worker-side `PluginHostApi` implementation for the dev hot-reload worker
// (#9304). Plugin code running in the `utilityProcess.fork` child receives this
// proxy as its `host`. Every call is relayed over the parent MessagePort to
// `PluginDevWorkerMainBridge`, which forwards to the real host. Handlers the
// plugin registers (actions, IPC) stay HERE in the worker — main invokes them
// back over the port — so a reload (whole-worker respawn) discards them cleanly
// and there is no ESM module-cache leak (Vite #14438).
//
// Fidelity note: the real in-process host throws synchronously from
// `registerAction`/`registerHandler` during `activate()`. Over IPC, deep
// validation happens in main *after* the proxy call returns, so the proxy
// re-runs the host's structural checks locally (object/function/id shape) to
// preserve synchronous authoring feedback; deeper rejections (id format,
// capability gate) arrive asynchronously as a `register-error` and are logged
// loudly rather than thrown.

import type {
  ActionHandler,
  PluginChannelSchema,
  PluginHostApi,
  PluginIpcContext,
  PluginIpcHandler,
  PluginSettingsScope,
  PluginToastOptions,
  PluginTypedIpcHandler,
  PluginWorktreeSnapshot,
} from "../../../shared/types/plugin.js";
import type {
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderImpl,
} from "../../../shared/types/forge.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type {
  PluginHostCallMethod,
  PluginHostNotifyMethod,
  PluginHostToWorkerMessage,
  PluginWorkerToHostMessage,
} from "../../../shared/types/pluginDevWorker.js";

type Post = (message: PluginWorkerToHostMessage) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface RegisteredHandler {
  handler: PluginIpcHandler | PluginTypedIpcHandler<unknown, unknown>;
  schema?: PluginChannelSchema<unknown, unknown>;
}

export class PluginDevWorkerHostProxy {
  readonly host: PluginHostApi;
  private readonly post: Post;
  private readonly pluginId: string;

  private nextId = 1;
  private revoked = false;
  private disposed = false;

  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private readonly ipcHandlers = new Map<string, RegisteredHandler>();
  private readonly subscriptions = new Map<string, (payload: unknown) => void>();

  constructor(pluginId: string, post: Post) {
    this.pluginId = pluginId;
    this.post = post;
    this.host = this.buildHost();
  }

  /** Revoke the host registration surface once `activate()` resolves/times out,
   * mirroring the real host's revoke semantics. */
  revoke(): void {
    this.revoked = true;
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pendingCalls.values()) {
      pending.reject(new Error("Plugin dev worker disposed"));
    }
    this.pendingCalls.clear();
    this.actionHandlers.clear();
    this.ipcHandlers.clear();
    this.subscriptions.clear();
  }

  /** Route a message received from main. Returns true if it was consumed. */
  handleMessage(msg: PluginHostToWorkerMessage): boolean {
    switch (msg.type) {
      case "host-result": {
        const pending = this.pendingCalls.get(msg.requestId);
        if (!pending) return true;
        this.pendingCalls.delete(msg.requestId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error));
        return true;
      }
      case "invoke":
        void this.handleInvoke(msg);
        return true;
      case "subscription-event": {
        const cb = this.subscriptions.get(msg.subscriptionId);
        if (cb) {
          try {
            cb(msg.payload);
          } catch (err) {
            console.error(`[plugin-dev:${this.pluginId}] subscription callback threw:`, err);
          }
        }
        return true;
      }
      case "register-error":
        console.error(
          `[plugin-dev:${this.pluginId}] registration "${msg.registrationKey}" rejected by host: ${msg.error}`
        );
        return true;
      default:
        return false;
    }
  }

  private async handleInvoke(
    msg: Extract<PluginHostToWorkerMessage, { type: "invoke" }>
  ): Promise<void> {
    try {
      if (msg.kind === "action") {
        const handler = this.actionHandlers.get(msg.namespacedId);
        if (!handler) {
          throw new Error(`No action handler registered for "${msg.namespacedId}"`);
        }
        const result = await handler(msg.args);
        this.post({ type: "invoke-result", requestId: msg.requestId, ok: true, result });
        return;
      }
      // kind === "handler"
      const entry = this.ipcHandlers.get(msg.channel);
      if (!entry) {
        throw new Error(`No handler registered for channel "${msg.channel}"`);
      }
      const result = await this.invokeIpcHandler(entry, msg.ctx, msg.args);
      this.post({ type: "invoke-result", requestId: msg.requestId, ok: true, result });
    } catch (err) {
      this.post({
        type: "invoke-result",
        requestId: msg.requestId,
        ok: false,
        error: formatErrorMessage(err, "invocation failed"),
      });
    }
  }

  private async invokeIpcHandler(
    entry: RegisteredHandler,
    ctx: PluginIpcContext,
    args: unknown[]
  ): Promise<unknown> {
    if (entry.schema) {
      // Typed overload: validate the single args payload, invoke, validate result.
      const parsedArgs = entry.schema.args.safeParse(args[0]);
      if (!parsedArgs.success) {
        throw new Error(`SCHEMA_ERROR: ${formatZodIssues(parsedArgs.error)}`);
      }
      const typed = entry.handler as PluginTypedIpcHandler<unknown, unknown>;
      const result = await typed(ctx, parsedArgs.data);
      const parsedResult = entry.schema.result.safeParse(result);
      if (!parsedResult.success) {
        throw new Error(`SCHEMA_ERROR: ${formatZodIssues(parsedResult.error)}`);
      }
      return parsedResult.data;
    }
    const legacy = entry.handler as PluginIpcHandler;
    return legacy(ctx, ...args);
  }

  private call<T>(method: PluginHostCallMethod, params: unknown): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Plugin dev worker disposed"));
    }
    const requestId = `c${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      this.pendingCalls.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.post({ type: "host-call", requestId, method, params });
    });
  }

  private notify(method: PluginHostNotifyMethod, params: unknown, registrationKey?: string): void {
    if (this.disposed) return;
    this.post({ type: "host-notify", method, params, registrationKey });
  }

  private assertActivationOpen(name: string): void {
    if (this.revoked) {
      throw new Error(
        `Plugin "${this.pluginId}" host revoked: ${name} called after activate() returned or timed out`
      );
    }
  }

  private buildHost(): PluginHostApi {
    // Captured for the `pluginId` getter, whose own `this` would be the host
    // object literal, not this class instance. Every other member is an arrow
    // function that closes over the class `this` lexically.
    const pluginId = this.pluginId;
    const host: PluginHostApi = {
      get pluginId() {
        return pluginId;
      },
      registerAction: (descriptor, handler) => {
        this.assertActivationOpen("registerAction");
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(`Plugin "${this.pluginId}" registerAction: descriptor must be an object`);
        }
        if (typeof handler !== "function") {
          throw new Error(`Plugin "${this.pluginId}" registerAction: handler must be a function`);
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerAction: descriptor.id must be a non-empty string`
          );
        }
        if (descriptor.id.startsWith(`${this.pluginId}.`)) {
          throw new Error(
            `Plugin "${this.pluginId}" registerAction: descriptor.id "${descriptor.id}" must not include the plugin prefix — Daintree adds it`
          );
        }
        const namespacedId = `${this.pluginId}.${descriptor.id}`;
        // Replace semantics mirror the real host: re-registering the same id
        // overwrites the prior handler.
        this.actionHandlers.set(namespacedId, handler);
        this.notify(
          "registerAction",
          {
            descriptor: {
              id: descriptor.id,
              title: descriptor.title,
              description: descriptor.description,
              category: descriptor.category,
              kind: descriptor.kind,
              danger: descriptor.danger,
              keywords: descriptor.keywords,
              inputSchema: descriptor.inputSchema,
            },
          },
          `action:${namespacedId}`
        );
      },
      registerHandler: ((
        channel: string,
        schemaOrHandler:
          | PluginChannelSchema<unknown, unknown>
          | PluginIpcHandler
          | PluginTypedIpcHandler<unknown, unknown>,
        typedHandler?: PluginTypedIpcHandler<unknown, unknown>
      ) => {
        this.assertActivationOpen("registerHandler");
        if (typeof channel !== "string" || channel.length === 0) {
          throw new Error(`Plugin "${this.pluginId}" registerHandler: channel must be a string`);
        }
        if (typedHandler !== undefined) {
          if (!isChannelSchema(schemaOrHandler)) {
            throw new Error(
              `Plugin "${this.pluginId}" registerHandler: second argument must be a channel schema { args, result } when a typed handler is provided`
            );
          }
          const schema = schemaOrHandler;
          this.ipcHandlers.set(channel, { handler: typedHandler, schema });
          this.notify(
            "registerHandler",
            {
              channel,
              hasSchema: true,
              requires: schema.requires ? [...schema.requires] : undefined,
            },
            `handler:${channel}`
          );
        } else {
          if (typeof schemaOrHandler !== "function") {
            throw new Error(
              `Plugin "${this.pluginId}" registerHandler: handler must be a function`
            );
          }
          this.ipcHandlers.set(channel, { handler: schemaOrHandler as PluginIpcHandler });
          this.notify("registerHandler", { channel, hasSchema: false }, `handler:${channel}`);
        }
      }) as PluginHostApi["registerHandler"],
      broadcastToRenderer: (channel, payload) => {
        this.assertActivationOpen("broadcastToRenderer");
        if (typeof channel !== "string" || channel.includes(":")) {
          throw new Error(
            `Plugin broadcast channel must be a string without colons: ${String(channel)}`
          );
        }
        this.notify("broadcastToRenderer", { channel, payload });
      },
      getActiveWorktree: () =>
        this.call<PluginWorktreeSnapshot | null>("getActiveWorktree", undefined),
      getWorktrees: () => this.call<PluginWorktreeSnapshot[]>("getWorktrees", undefined),
      onDidChangeActiveWorktree: (callback) => {
        this.assertActivationOpen("onDidChangeActiveWorktree");
        return this.subscribe("active-worktree", (payload) =>
          callback(payload as PluginWorktreeSnapshot | null)
        );
      },
      onDidChangeWorktrees: (callback) => {
        this.assertActivationOpen("onDidChangeWorktrees");
        return this.subscribe("worktrees", (payload) =>
          callback(payload as PluginWorktreeSnapshot[])
        );
      },
      registerForgeProvider: (descriptor: ForgeProviderDescriptor, _impl: ForgeProviderImpl) => {
        // Forge providers require bidirectional impl proxying (callbacks the host
        // invokes per PR/CI/rate-limit query) not yet supported in dev mode.
        console.warn(
          `[plugin-dev:${this.pluginId}] registerForgeProvider("${descriptor?.id}") is not supported in dev mode — package + install the plugin to test forge providers`
        );
        return () => {};
      },
      registerFileDecorationProvider: (
        descriptor: FileDecorationProviderDescriptor,
        _impl: FileDecorationProviderImpl
      ) => {
        console.warn(
          `[plugin-dev:${this.pluginId}] registerFileDecorationProvider("${descriptor?.id}") is not supported in dev mode — package + install the plugin to test decoration providers`
        );
        return () => {};
      },
      invalidateFileDecorations: (scope, paths) => {
        if (typeof scope !== "string" || scope.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" invalidateFileDecorations: scope must be a non-empty string`
          );
        }
        this.notify("invalidateFileDecorations", { scope, paths });
      },
      showToast: (options: PluginToastOptions) =>
        this.call<void>("showToast", {
          message: options?.message,
          type: options?.type,
          durationMs: options?.durationMs,
        }),
      dispatch: (actionId, args) => this.call<ActionDispatchResult>("dispatch", { actionId, args }),
      logger: {
        info: (message, fields) => this.notify("logger.info", { message, fields }),
        warn: (message, fields) => this.notify("logger.warn", { message, fields }),
        error: (message, fields) => this.notify("logger.error", { message, fields }),
      },
      settings: {
        get: <T = unknown>(key: string, scope: PluginSettingsScope = "user") =>
          this.call<T | undefined>("settings.get", { key, scope }),
        set: <T = unknown>(key: string, value: T, scope: PluginSettingsScope = "user") =>
          this.call<void>("settings.set", { key, value, scope }),
        onDidChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
          scope: PluginSettingsScope = "user"
        ) => {
          this.assertActivationOpen("settings.onDidChange");
          return this.subscribe(
            "settings",
            (payload) => callback(payload as T | undefined),
            key,
            scope
          );
        },
      },
    };
    return host;
  }

  private subscribe(
    kind: "active-worktree" | "worktrees" | "settings",
    callback: (payload: unknown) => void,
    key?: string,
    scope?: PluginSettingsScope
  ): () => void {
    const subscriptionId = `s${this.nextId++}`;
    this.subscriptions.set(subscriptionId, callback);
    this.post({ type: "subscribe", subscriptionId, kind, key, scope });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.subscriptions.delete(subscriptionId);
      this.post({ type: "unsubscribe", subscriptionId });
    };
  }
}

/** Structural guard mirroring `isChannelSchema` from PluginChannelRegistry,
 * duplicated worker-side to avoid pulling main-process deps into the worker. */
function isChannelSchema(value: unknown): value is PluginChannelSchema<unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "args" in value &&
    "result" in value &&
    typeof (value as { args?: unknown }).args === "object" &&
    typeof (value as { result?: unknown }).result === "object"
  );
}

function formatZodIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
