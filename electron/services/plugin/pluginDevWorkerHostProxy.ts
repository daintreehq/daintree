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
  PluginIdentity,
  PluginIpcContext,
  PluginIpcHandler,
  PluginSettingsScope,
  PluginStorageScope,
  PluginToastOptions,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginTypedIpcHandler,
  PluginWorktreeSnapshot,
  PluginWorktreeStatus,
  PluginWorktreesResult,
  PluginAgentSnapshot,
  PluginPanelLifecycleEvent,
  PluginSystemWakeEvent,
  PluginFsDirEntry,
  PluginFsStat,
  PluginGitStatus,
  PluginGitCommitResult,
  PluginProcessHandle,
  PluginDuplexProcessHandle,
  PluginPtyProcessHandle,
  PluginProcessDataChunk,
  PluginProcessMode,
} from "../../../shared/types/plugin.js";
import { toRuntimePanelKindId } from "../../../shared/config/panelKindRegistry.js";
import type {
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderImpl,
} from "../../../shared/types/forge.js";
import type {
  ActionDispatchResult,
  PluginActionManifestEntry,
} from "../../../shared/types/actions.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type {
  PluginHostCallMethod,
  PluginHostNotifyMethod,
  PluginHostToWorkerMessage,
  PluginWorkerSubscriptionKind,
  PluginWorkerToHostMessage,
} from "../../../shared/types/pluginDevWorker.js";

type Post = (message: PluginWorkerToHostMessage) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Detach the abort listener once the call settles (no-op when no signal was passed). */
  cleanup?: () => void;
  /**
   * When set, {@link PluginDevWorkerHostProxy.dispose} resolves this call with
   * `grace.value` instead of rejecting it. Used by the imperative UI prompts
   * (#10522), whose contract is to resolve the dismiss value (undefined/false)
   * on plugin unload rather than throw.
   */
  grace?: { value: unknown };
}

interface RegisteredHandler {
  handler: PluginIpcHandler | PluginTypedIpcHandler<unknown, unknown>;
  schema?: PluginChannelSchema<unknown, unknown>;
}

export class PluginDevWorkerHostProxy {
  readonly host: PluginHostApi;
  private readonly post: Post;
  private readonly pluginId: string;
  private readonly identity: PluginIdentity;

  private nextId = 1;
  private revoked = false;
  private disposed = false;

  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private readonly ipcHandlers = new Map<string, RegisteredHandler>();
  private readonly subscriptions = new Map<string, (payload: unknown) => void>();
  private readonly fileDecorationProviders = new Map<string, FileDecorationProviderImpl>();

  constructor(pluginId: string, post: Post, identity: PluginIdentity) {
    this.pluginId = pluginId;
    this.post = post;
    this.identity = identity;
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
      pending.cleanup?.();
      if (pending.grace) {
        pending.resolve(pending.grace.value);
      } else {
        pending.reject(new Error("Plugin dev worker disposed"));
      }
    }
    this.pendingCalls.clear();
    this.actionHandlers.clear();
    this.ipcHandlers.clear();
    this.subscriptions.clear();
    this.fileDecorationProviders.clear();
  }

  /** Route a message received from main. Returns true if it was consumed. */
  handleMessage(msg: PluginHostToWorkerMessage): boolean {
    switch (msg.type) {
      case "host-result": {
        const pending = this.pendingCalls.get(msg.requestId);
        if (!pending) return true;
        this.pendingCalls.delete(msg.requestId);
        pending.cleanup?.();
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
      if (msg.kind === "file-decoration-method") {
        const impl = this.fileDecorationProviders.get(msg.providerId);
        if (!impl) {
          throw new Error(`No file decoration provider registered for "${msg.providerId}"`);
        }
        if (msg.method !== "provideDecorations") {
          throw new Error(`Unknown file decoration provider method "${msg.method}"`);
        }
        const [scope, paths] = msg.args as [string, string[]];
        const result = await impl.provideDecorations(scope, paths);
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

  /**
   * Like {@link call} but, instead of rejecting when the proxy is disposed
   * (plugin unload), resolves the pending promise with `graceValue`. Used by the
   * imperative UI prompts (#10522): their host contract resolves the dismiss
   * value (undefined / false) on unload rather than throwing.
   */
  private callWithGrace<T>(
    method: PluginHostCallMethod,
    params: unknown,
    graceValue: T
  ): Promise<T> {
    if (this.disposed) {
      return Promise.resolve(graceValue);
    }
    return this.call<T>(method, params, undefined, { value: graceValue });
  }

  private call<T>(
    method: PluginHostCallMethod,
    params: unknown,
    signal?: AbortSignal,
    grace?: { value: unknown }
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Plugin dev worker disposed"));
    }
    // An already-aborted signal rejects before anything crosses the port.
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    const requestId = `c${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const cleanup = (): void => {
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      };
      this.pendingCalls.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup,
        grace,
      });
      if (signal) {
        onAbort = (): void => {
          const pending = this.pendingCalls.get(requestId);
          if (!pending) return;
          this.pendingCalls.delete(requestId);
          cleanup();
          // Tell main to abort the in-flight host call (AbortSignal itself is not
          // structured-clone-safe, so the requestId is the cancellation handle).
          this.post({ type: "host-cancel", requestId });
          reject(abortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        this.post({ type: "host-call", requestId, method, params });
      } catch (err) {
        // A non-structured-clone-safe `params` makes `postMessage` throw
        // (DataCloneError). Drop the pending entry so it doesn't leak until
        // dispose, then reject the caller.
        this.pendingCalls.delete(requestId);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
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
    // The identity the main-process host computed, relayed verbatim in the
    // `start` message. Not reconstructed from `pluginId`: `projectRoot` lives on
    // the host's binding and cannot be recovered from an instance key, and a
    // project plugin — which reaches this worker like any other plugin with a
    // `main` — would otherwise report a project with no root.
    const pluginInfo = this.identity;
    const manifestId = pluginInfo.manifestId;
    const projectId = pluginInfo.projectId;
    const host: PluginHostApi = {
      get pluginId() {
        return pluginId;
      },
      pluginInfo,
      panelKindId: (bareId: string) => {
        if (typeof bareId !== "string" || bareId.length === 0) {
          throw new Error(`Plugin "${pluginId}" panelKindId: bareId must be a non-empty string`);
        }
        const qualified = toRuntimePanelKindId(
          { origin: pluginInfo.origin, pluginId: manifestId, kindId: bareId },
          projectId
        );
        if (qualified === null) {
          throw new Error(
            `Plugin "${pluginId}" panelKindId: cannot qualify panel kind "${bareId}" for this plugin`
          );
        }
        return qualified;
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
              requires: descriptor.requires,
            },
          },
          `action:${namespacedId}`
        );
        // Sync structural validation + handler capture happen above (sync throws
        // still surface at the call site); only the return value is async.
        return Promise.resolve();
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
        return Promise.resolve();
      }) as PluginHostApi["registerHandler"],
      broadcastToRenderer: (channel, payload) => {
        this.assertActivationOpen("broadcastToRenderer");
        if (typeof channel !== "string" || channel.includes(":")) {
          throw new Error(
            `Plugin broadcast channel must be a string without colons: ${String(channel)}`
          );
        }
        this.notify("broadcastToRenderer", { channel, payload });
        return Promise.resolve();
      },
      // Post-activation-safe sibling of broadcastToRenderer: no
      // assertActivationOpen guard, so dev-worker plugins can stream live data
      // to their panels from timers and subscription callbacks.
      postToPanel: (channel, payload, panelId) => {
        if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
          // Reject (not sync throw): runtime-surface Promise method must keep
          // validation errors inside the Promise contract, mirroring the
          // main-side host (#10617). notify() is fire-and-forget/sync, so this
          // method can't simply be `async`.
          return Promise.reject(
            new Error(
              `Plugin "${this.pluginId}" postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
            )
          );
        }
        if (panelId !== undefined && panelId !== null) {
          if (typeof panelId !== "string" || panelId.length === 0) {
            throw new Error(
              `Plugin "${this.pluginId}" postToPanel: panelId must be a non-empty string, null, or undefined: ${String(panelId)}`
            );
          }
        }
        // Forward panelId verbatim (including `undefined`/`null`) — the real
        // main-side host wraps the envelope and resolves the broadcast-vs-target
        // routing. Structured clone over the parent-port preserves `undefined`.
        this.notify("postToPanel", { channel, payload, panelId });
        return Promise.resolve();
      },
      getActiveWorktree: () =>
        this.call<PluginWorktreeSnapshot | null>("getActiveWorktree", undefined),
      getWorktrees: () => this.call<PluginWorktreeSnapshot[]>("getWorktrees", undefined),
      // callWithGrace, not call: the host contract for this method is that it
      // degrades to an `unavailable` result on unload rather than throwing, so a
      // dev-worker call in flight when the proxy is disposed must resolve the
      // same way the real host would (#12174).
      getWorktreesResult: () =>
        this.callWithGrace<PluginWorktreesResult>("getWorktreesResult", undefined, {
          status: "unavailable",
          reason: "plugin-unloaded",
        }),
      getWorktreeStatus: (path, options) =>
        this.call<PluginWorktreeStatus | null>("getWorktreeStatus", path, options?.signal),
      getAgentState: () => this.call<PluginAgentSnapshot | null>("getAgentState", undefined),
      onDidChangeAgentState: (callback) => {
        this.assertActivationOpen("onDidChangeAgentState");
        // Subscription wired synchronously; only the disposer is async.
        const dispose = this.subscribe("agent-state", (payload) =>
          callback(payload as PluginAgentSnapshot)
        );
        return Promise.resolve(dispose);
      },
      onDidChangePanelLifecycle: (callback) => {
        this.assertActivationOpen("onDidChangePanelLifecycle");
        // Subscription wired synchronously; only the disposer is async. The
        // host replays live panels on its side, so a plugin activated by a view
        // opening still receives that panel's phase (#11301).
        // Re-freeze on arrival: main freezes the event, but the port's
        // structured clone reconstructs a plain mutable object — frozen
        // descriptors do not survive the hop. Without this the documented
        // "events are frozen" contract would hold in-process and silently not
        // hold for every user-installed plugin, which all run in a worker.
        const dispose = this.subscribe("panel-lifecycle", (payload) =>
          callback(Object.freeze(payload as PluginPanelLifecycleEvent))
        );
        return Promise.resolve(dispose);
      },
      onDidWake: (callback) => {
        this.assertActivationOpen("onDidWake");
        // Subscription wired synchronously; only the disposer is async. Same
        // re-freeze as panel-lifecycle above: the port's structured clone hands
        // back a plain mutable object, so main's freeze does not survive the
        // hop and the documented contract has to be re-established here.
        const dispose = this.subscribe("system-wake", (payload) =>
          callback(Object.freeze(payload as PluginSystemWakeEvent))
        );
        return Promise.resolve(dispose);
      },
      onDidChangeActiveWorktree: (callback) => {
        this.assertActivationOpen("onDidChangeActiveWorktree");
        // Subscription wired synchronously; only the disposer is async.
        const dispose = this.subscribe("active-worktree", (payload) =>
          callback(payload as PluginWorktreeSnapshot | null)
        );
        return Promise.resolve(dispose);
      },
      onDidChangeWorktrees: (callback, options) => {
        this.assertActivationOpen("onDidChangeWorktrees");
        // Debounce is applied host-side: the worker forwards `debounceMs` in the
        // subscribe message and the real host coalesces before pushing events.
        const dispose = this.subscribe(
          "worktrees",
          (payload) => callback(payload as PluginWorktreeSnapshot[]),
          undefined,
          undefined,
          options?.debounceMs
        );
        return Promise.resolve(dispose);
      },
      registerForgeProvider: (descriptor: ForgeProviderDescriptor, _impl: ForgeProviderImpl) => {
        this.assertActivationOpen("registerForgeProvider");
        // Forge providers can't run from the worker: `ForgeProviderImpl`'s
        // required `parseRemote` (the routing gate), URL builders, and
        // `classifyPushError` are SYNCHRONOUS — the host calls them and uses the
        // return value immediately — but every worker host call is async over
        // this MessagePort. A partial async-only proxy would be worse than
        // honest: the provider would never become routable because
        // `parseRemote` resolves to a Promise. This is the ONE permanent
        // dev/prod-identical gap — both run in the worker, so neither supports
        // it; a fix needs the forge API's sync surface to change.
        console.warn(
          `[plugin:${this.pluginId}] registerForgeProvider("${descriptor?.id}") is not supported — forge providers require synchronous host methods (parseRemote, URL builders) that can't cross the worker's async boundary.`
        );
        return Promise.resolve(() => {});
      },
      registerFileDecorationProvider: (
        descriptor: FileDecorationProviderDescriptor,
        impl: FileDecorationProviderImpl
      ) => {
        this.assertActivationOpen("registerFileDecorationProvider");
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(
            `Plugin "${this.pluginId}" registerFileDecorationProvider: descriptor must be an object`
          );
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerFileDecorationProvider: descriptor.id must be a non-empty string`
          );
        }
        if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
          throw new Error(
            `Plugin "${this.pluginId}" registerFileDecorationProvider: impl must expose provideDecorations()`
          );
        }
        const providerId = descriptor.id;
        // Replace semantics mirror the real host: a second register on the same
        // id overwrites the prior impl held here.
        this.fileDecorationProviders.set(providerId, impl);
        this.notify(
          "registerFileDecorationProvider",
          { descriptor: { id: providerId, scopes: descriptor.scopes } },
          `fileDecorationProvider:${providerId}`
        );
        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          // Identity-guard the delete so a stale disposer (from a prior register
          // on the same id that a later register overwrote) can't drop the
          // currently-active impl — mirrors the real host's registry semantics.
          if (this.fileDecorationProviders.get(providerId) === impl) {
            this.fileDecorationProviders.delete(providerId);
          }
          this.notify("unregisterFileDecorationProvider", { providerId });
        };
        return Promise.resolve(dispose);
      },
      invalidateFileDecorations: (scope, paths) => {
        if (typeof scope !== "string" || scope.length === 0) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${this.pluginId}" invalidateFileDecorations: scope must be a non-empty string`
            )
          );
        }
        this.notify("invalidateFileDecorations", { scope, paths });
        return Promise.resolve();
      },
      // Post-activation-safe sibling of invalidateFileDecorations: forward the
      // badge fire-and-forget; the real host re-validates the badge shape.
      setPanelBadge: (panelId, badge) => {
        if (typeof panelId !== "string" || panelId.length === 0) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" setPanelBadge: panelId must be a non-empty string`)
          );
        }
        this.notify("setPanelBadge", { panelId, badge: badge ?? null });
        return Promise.resolve();
      },
      showToast: (options: PluginToastOptions) =>
        this.call<void>("showToast", {
          message: options?.message,
          type: options?.type,
          durationMs: options?.durationMs,
        }),
      dispatch: (actionId, args) => this.call<ActionDispatchResult>("dispatch", { actionId, args }),
      // Built-in action catalog (#10561). list/get relay over the port like
      // dispatch; canDispatch is derived locally from get() (no extra
      // round-trip), mirroring the real host. callWithGrace resolves the
      // empty/absent fallback ([] / null / "restricted") on plugin unload
      // instead of rejecting, matching the host contract.
      actions: {
        list: () => this.callWithGrace<PluginActionManifestEntry[]>("actions.list", undefined, []),
        get: (actionId) =>
          this.callWithGrace<PluginActionManifestEntry | null>("actions.get", { actionId }, null),
        canDispatch: async (actionId) => {
          // Honor the never-throws contract: a host-side error on the underlying
          // get() degrades to "restricted" rather than rejecting.
          let entry: PluginActionManifestEntry | null;
          try {
            entry = await this.callWithGrace<PluginActionManifestEntry | null>(
              "actions.get",
              { actionId },
              null
            );
          } catch {
            return "restricted";
          }
          if (!entry) return "restricted";
          if (entry.danger === "confirm") return "confirm";
          // Fail closed: only an explicit "safe" entry maps to "ok".
          if (entry.danger === "safe") return "ok";
          return "restricted";
        },
      },
      // Capability check, consent prompt, active-agent resolution, and the PTY
      // write all run on the real main-side host — the worker only relays.
      sendToActiveAgent: (text, options) => this.call<void>("sendToActiveAgent", { text, options }),
      // Imperative UI prompts (#10522). Post-activation-safe (no
      // assertActivationOpen): plugins prompt from command handlers. They use
      // callWithGrace so a plugin unload mid-prompt resolves the dismiss value
      // (undefined / false) instead of rejecting — matching the host contract.
      showQuickPick: ((items: PluginQuickPickItem[], options?: PluginQuickPickOptions) =>
        this.callWithGrace<PluginQuickPickItem | PluginQuickPickItem[] | undefined>(
          "showQuickPick",
          { items, options },
          undefined
        )) as PluginHostApi["showQuickPick"],
      showInputBox: (options) =>
        this.callWithGrace<string | undefined>("showInputBox", { options }, undefined),
      showConfirm: (options) => this.callWithGrace<boolean>("showConfirm", { options }, false),
      logger: {
        info: (message, fields) => this.notify("logger.info", { message, fields }),
        warn: (message, fields) => this.notify("logger.warn", { message, fields }),
        error: (message, fields) => this.notify("logger.error", { message, fields }),
      },
      process: {
        // The real `PluginProcessHandle` lives in main (PluginProcessManager);
        // `spawn` relays over the port and returns a proxy handle whose id
        // addresses `kill` / `restart` and the exit/crash subscriptions. `kill`
        // is sync (a fire-and-forget notify); `restart` awaits the host. Late
        // exit/crash events ride the existing subscription-event channel.
        // One implementation behind an overloaded signature: the public `spawn`
        // narrows its return on the `mode` literal, which a single arrow
        // function can't express — the cast is the standard overload-impl seam.
        spawn: (async (command: string, options?: unknown) => {
          const { id, mode } = await this.call<{ id: string; mode?: PluginProcessMode }>(
            "process.spawn",
            { command, options }
          );
          // A host that somehow omits the mode is treated as pipe — the least
          // capable shape, so a missing field can never manufacture a `write`.
          return this.buildProcessHandle(id, mode ?? "pipe");
        }) as PluginHostApi["process"]["spawn"],
      },
      // host.fs request/response methods are fully async, so they relay over the
      // port to the real (contained, capability-gated) host like settings/get.
      // `watch` is a host-call that BOTH wires the watcher (rejecting on a
      // missing capability / out-of-scope path, preserving the in-process
      // contract) and opens a subscription whose change events arrive over the
      // subscription-event channel keyed by the same id.
      fs: {
        readFile: (filePath, options) =>
          this.call<string>("fs.readFile", { path: filePath }, options?.signal),
        readFileBytes: (filePath, options) =>
          this.call<Uint8Array>("fs.readFileBytes", { path: filePath }, options?.signal),
        writeFile: (filePath, contents) =>
          this.call<void>("fs.writeFile", { path: filePath, contents }),
        readdir: (dirPath, options) =>
          this.call<PluginFsDirEntry[]>(
            "fs.readdir",
            { path: dirPath, ...(options?.detail === true && { detail: true }) },
            options?.signal
          ),
        stat: (targetPath, options) =>
          this.call<PluginFsStat>("fs.stat", { path: targetPath }, options?.signal),
        watch: async (paths, callback, options) => {
          const subscriptionId = `s${this.nextId++}`;
          // Register the change callback before the call so an event can't race
          // ahead of the subscription map; tear it down if the watch rejects.
          this.subscriptions.set(subscriptionId, (payload) => callback(payload as string));
          try {
            await this.call<void>("fs.watch", { subscriptionId, paths }, options?.signal);
          } catch (err) {
            this.subscriptions.delete(subscriptionId);
            throw err;
          }
          let disposed = false;
          return () => {
            if (disposed) return;
            disposed = true;
            this.subscriptions.delete(subscriptionId);
            this.post({ type: "unsubscribe", subscriptionId });
          };
        },
      },
      git: {
        status: (worktreePath, options) =>
          this.call<PluginGitStatus>("git.status", { worktreePath }, options?.signal),
        diff: (worktreePath, filePath, options) =>
          this.call<string>("git.diff", { worktreePath, filePath }, options?.signal),
        add: (worktreePath, paths, options) =>
          this.call<void>("git.add", { worktreePath, paths }, options?.signal),
        commit: (worktreePath, options, callOptions) =>
          this.call<PluginGitCommitResult>(
            "git.commit",
            {
              worktreePath,
              message: options?.message,
            },
            callOptions?.signal
          ),
      },
      clipboard: {
        writeText: (text) => this.call<void>("clipboard.writeText", { text }),
        // The typed array survives structured clone, so the bytes reach the
        // real host unchanged and are validated there — the worker is the
        // untrusted side, so no size check is worth doing here.
        writeImage: (pngData) => this.call<void>("clipboard.writeImage", { pngData }),
        readText: () => this.call<string>("clipboard.readText", undefined),
      },
      system: {
        openPath: (targetPath) => this.call<void>("system.openPath", { targetPath }),
        showItemInFolder: (targetPath) =>
          this.call<void>("system.showItemInFolder", { targetPath }),
      },
      settings: {
        // Forward an omitted scope as `undefined` (not a defaulted "user") so the
        // real host resolves the key's manifest-declared scope on read (#10586) —
        // defaulting here would send an explicit "user" that a project-scoped key
        // rejects.
        get: <T = unknown>(key: string, scope?: PluginSettingsScope) =>
          this.call<T | undefined>("settings.get", { key, scope }),
        set: <T = unknown>(key: string, value: T, scope: PluginSettingsScope = "user") =>
          this.call<void>("settings.set", { key, value, scope }),
        onDidChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
          scope: PluginSettingsScope = "user"
        ) => {
          this.assertActivationOpen("settings.onDidChange");
          const dispose = this.subscribe(
            "settings",
            (payload) => callback(payload as T | undefined),
            key,
            scope
          );
          return Promise.resolve(dispose);
        },
      },
      storage: {
        get: <T = unknown>(key: string, scope: PluginStorageScope = "user") =>
          this.call<T | undefined>("storage.get", { key, scope }),
        set: <T = unknown>(key: string, value: T, scope: PluginStorageScope = "user") =>
          this.call<void>("storage.set", { key, value, scope }),
        delete: (key: string, scope: PluginStorageScope = "user") =>
          this.call<void>("storage.delete", { key, scope }),
        onDidChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
          scope: PluginStorageScope = "user"
        ) => {
          this.assertActivationOpen("storage.onDidChange");
          const dispose = this.subscribe(
            "storage",
            (payload) => callback(payload as T | undefined),
            key,
            scope
          );
          return Promise.resolve(dispose);
        },
      },
    };
    return host;
  }

  private subscribe(
    kind: PluginWorkerSubscriptionKind,
    callback: (payload: unknown) => void,
    key?: string,
    scope?: PluginSettingsScope | PluginStorageScope,
    debounceMs?: number
  ): () => void {
    const subscriptionId = `s${this.nextId++}`;
    return this.openSubscription(
      { type: "subscribe", subscriptionId, kind, key, scope, debounceMs },
      callback
    );
  }

  /** Register `callback`, post the (fully-formed) subscribe message, and return
   * an idempotent disposer that drops the callback and posts `unsubscribe`. */
  private openSubscription(
    message: Extract<PluginWorkerToHostMessage, { type: "subscribe" }>,
    callback: (payload: unknown) => void
  ): () => void {
    this.subscriptions.set(message.subscriptionId, callback);
    this.post(message);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.subscriptions.delete(message.subscriptionId);
      this.post({ type: "unsubscribe", subscriptionId: message.subscriptionId });
    };
  }

  /**
   * Build a worker-side {@link PluginProcessHandle} proxy for a process the host
   * spawned on our behalf, addressing it by the host-assigned `id`. `interactive`
   * comes from the host's reported mode, so `write`/`resize` exist only when
   * there is a real PTY behind them.
   */
  private buildProcessHandle(id: string, mode: PluginProcessMode): PluginProcessHandle {
    const subscribeLifecycle = (
      kind: "process-exit" | "process-crash",
      callback: (info: { exitCode: number | null; signal: string | null }) => void
    ): (() => void) =>
      this.openSubscription(
        { type: "subscribe", subscriptionId: `s${this.nextId++}`, kind, processId: id },
        (payload) => callback(payload as { exitCode: number | null; signal: string | null })
      );
    const base: PluginProcessHandle = {
      id,
      kill: () => {
        // Sync in the public contract — fire-and-forget over the port.
        this.notify("process.kill", { processId: id });
      },
      restart: () => this.call<void>("process.restart", { processId: id }),
      onExit: (callback) => subscribeLifecycle("process-exit", callback),
      onCrash: (callback) => subscribeLifecycle("process-crash", callback),
      onData: (callback) =>
        this.openSubscription(
          {
            type: "subscribe",
            subscriptionId: `s${this.nextId++}`,
            kind: "process-data",
            processId: id,
          },
          (payload) => callback(payload as PluginProcessDataChunk)
        ),
    };
    if (mode === "pipe") return base;
    // Void in the public contract, like `kill` — fire-and-forget over the port.
    const writableHandle: PluginDuplexProcessHandle = {
      ...base,
      write: (data) => this.notify("process.write", { processId: id, data }),
    };
    if (mode === "duplex") return writableHandle;
    const ptyHandle: PluginPtyProcessHandle = {
      ...writableHandle,
      resize: (cols, rows) => this.notify("process.resize", { processId: id, cols, rows }),
    };
    return ptyHandle;
  }
}

/**
 * Normalize an aborted signal's reason into an `Error` for rejection. Node sets
 * `signal.reason` to a `DOMException` (name `AbortError`) by default, which is
 * not an `Error` instance — wrap anything non-Error so callers always get one.
 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Structural guard mirroring `isChannelSchema` from PluginChannelRegistry,
 * duplicated worker-side to avoid pulling main-process deps into the worker. */
function isChannelSchema(value: unknown): value is PluginChannelSchema<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { args?: { safeParse?: unknown }; result?: { safeParse?: unknown } };
  // Require `safeParse` on both sides so a plain `{ args: {}, result: {} }`
  // object is rejected at registration with a clear error instead of throwing an
  // opaque "safeParse is not a function" TypeError at the first dispatch.
  return (
    typeof v.args === "object" &&
    v.args !== null &&
    typeof v.args.safeParse === "function" &&
    typeof v.result === "object" &&
    v.result !== null &&
    typeof v.result.safeParse === "function"
  );
}

function formatZodIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
