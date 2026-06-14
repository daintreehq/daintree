// Main-side bridge for the plugin dev hot-reload worker (#9304). It owns the
// translation between the worker's MessagePort protocol and the real
// `PluginHostApi` returned by `PluginService.createHost`:
//
//   - worker `host-call`     → real host async method  → `host-result`
//   - worker `host-notify`   → real host sync method (register*/broadcast/log)
//   - worker `subscribe`     → real host onDidChange*   → `subscription-event`
//   - real action/IPC dispatch → `invoke` → worker handler → `invoke-result`
//
// Handlers the plugin registers live in the worker; the bridge registers thin
// wrappers on the real host that round-trip each invocation back to the worker.
// Reusing the real host (rather than re-implementing every method against raw
// service refs) keeps all the host's validation, provenance, and revoke
// semantics intact for free.

import { createLogger } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { PluginHostApi, PluginIpcContext } from "../../../shared/types/plugin.js";
import type { FileDecoration, FileDecorationProviderImpl } from "../../../shared/types/forge.js";
import type {
  BroadcastToRendererParams,
  DispatchParams,
  InvalidateFileDecorationsParams,
  LoggerParams,
  PluginWorkerToHostMessage,
  RegisterActionParams,
  RegisterFileDecorationProviderParams,
  RegisterHandlerParams,
  SettingsGetParams,
  SettingsSetParams,
  ShowToastParams,
  UnregisterFileDecorationProviderParams,
} from "../../../shared/types/pluginDevWorker.js";
import type { PluginDevWorkerHost } from "./PluginDevWorkerHost.js";

const logger = createLogger("main:PluginDevWorkerBridge");

export interface PluginDevWorkerMainBridgeDeps {
  pluginId: string;
  /** Real host from `PluginService.createHost` — kept un-revoked for the dev
   * plugin's whole lifetime so the worker can re-register on every reload. */
  host: PluginHostApi;
  workerHost: PluginDevWorkerHost;
  /** Declared manifest capabilities, for the typed-handler fail-closed gate. */
  getCapabilities: () => readonly string[];
  /** Clear activate-time registrations (actions + IPC handlers) before a reload
   * re-registers them, so a handler the new code drops doesn't linger. */
  clearPriorRegistrations: () => void;
  /**
   * Fires on EVERY activation outcome — the initial activation and each reload.
   * Lets the owner keep the provenance `loadError` in sync across reloads (the
   * first-activation promise settles once and can't observe later outcomes).
   */
  onActivationResult?: (result: { ok: true } | { ok: false; error: string }) => void;
}

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class PluginDevWorkerMainBridge {
  private readonly pluginId: string;
  private readonly host: PluginHostApi;
  private readonly workerHost: PluginDevWorkerHost;
  private readonly getCapabilities: () => readonly string[];
  private readonly clearPriorRegistrations: () => void;
  private readonly onActivationResult?: (
    result: { ok: true } | { ok: false; error: string }
  ) => void;

  private disposed = false;
  private invokeSeq = 1;
  private readonly pendingInvokes = new Map<string, PendingInvoke>();
  private readonly subscriptionDisposers = new Map<string, () => void>();
  /** Disposers for providers (file decoration) the worker registered on the real
   * host, keyed by provider id. Torn down on reload and dispose so a reloaded
   * generation re-registers cleanly. */
  private readonly providerDisposers = new Map<string, () => void>();

  /** First-activation gate. Resolved on `activated`, rejected on activate/crash
   * errors. Subsequent reload activations don't re-await this. */
  private activationSettled = false;
  private activationResolve: (() => void) | null = null;
  private activationReject: ((error: Error) => void) | null = null;
  private readonly activationPromise: Promise<void>;

  constructor(deps: PluginDevWorkerMainBridgeDeps) {
    this.pluginId = deps.pluginId;
    this.host = deps.host;
    this.workerHost = deps.workerHost;
    this.getCapabilities = deps.getCapabilities;
    this.clearPriorRegistrations = deps.clearPriorRegistrations;
    this.onActivationResult = deps.onActivationResult;

    this.activationPromise = new Promise<void>((resolve, reject) => {
      this.activationResolve = resolve;
      this.activationReject = reject;
    });

    this.workerHost.on("worker-message", this.onWorkerMessage);
    this.workerHost.on("reloading", this.onReloading);
    this.workerHost.on("crash-loop", this.onCrashLoop);
  }

  /** Resolves once the worker's first `activate()` completes (or rejects). */
  waitForActivation(): Promise<void> {
    return this.activationPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workerHost.off("worker-message", this.onWorkerMessage);
    this.workerHost.off("reloading", this.onReloading);
    this.workerHost.off("crash-loop", this.onCrashLoop);
    for (const dispose of this.subscriptionDisposers.values()) {
      try {
        dispose();
      } catch {
        // best-effort
      }
    }
    this.subscriptionDisposers.clear();
    this.disposeProviders();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(new Error("Plugin dev worker bridge disposed"));
    }
    this.pendingInvokes.clear();
    this.rejectActivation(new Error(`Plugin dev worker "${this.pluginId}" disposed`));
  }

  /** Tear down every provider the worker registered on the real host. */
  private disposeProviders(): void {
    for (const dispose of this.providerDisposers.values()) {
      try {
        dispose();
      } catch {
        // best-effort
      }
    }
    this.providerDisposers.clear();
  }

  private onReloading = (): void => {
    // The new worker generation will re-register from scratch; drop the prior
    // generation's activate-time registrations and tear down subscriptions so
    // they don't double up. Pending invokes target a now-dead worker — fail them.
    this.clearPriorRegistrations();
    for (const dispose of this.subscriptionDisposers.values()) {
      try {
        dispose();
      } catch {
        // best-effort
      }
    }
    this.subscriptionDisposers.clear();
    this.disposeProviders();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(new Error("Plugin reloaded before invocation completed"));
    }
    this.pendingInvokes.clear();
  };

  private onCrashLoop = (code: number): void => {
    logger.error(
      `[${this.pluginId}] dev worker entered a crash loop (code ${code}); reload halted until next edit`
    );
    this.rejectActivation(new Error(`Plugin "${this.pluginId}" dev worker crash loop`));
  };

  private onWorkerMessage = (msg: PluginWorkerToHostMessage): void => {
    if (this.disposed) return;
    switch (msg.type) {
      case "activated":
        // Fires on initial activation and every reload — keep the owner's
        // provenance in sync on each, not just the first.
        this.onActivationResult?.({ ok: true });
        this.resolveActivation();
        return;
      case "activate-error":
        logger.error(`[${this.pluginId}] activate() failed: ${msg.error}`, {
          stack: msg.stack,
        });
        this.onActivationResult?.({ ok: false, error: msg.error });
        this.rejectActivation(new Error(msg.error));
        return;
      case "error":
        logger.error(`[${this.pluginId}] worker error: ${msg.error}`);
        this.onActivationResult?.({ ok: false, error: msg.error });
        this.rejectActivation(new Error(msg.error));
        return;
      case "host-call":
        void this.handleHostCall(msg);
        return;
      case "host-notify":
        this.handleHostNotify(msg);
        return;
      case "subscribe":
        this.handleSubscribe(msg);
        return;
      case "unsubscribe": {
        const dispose = this.subscriptionDisposers.get(msg.subscriptionId);
        if (dispose) {
          this.subscriptionDisposers.delete(msg.subscriptionId);
          try {
            dispose();
          } catch {
            // best-effort
          }
        }
        return;
      }
      case "invoke-result": {
        const pending = this.pendingInvokes.get(msg.requestId);
        if (!pending) return;
        this.pendingInvokes.delete(msg.requestId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error));
        return;
      }
      case "ready":
        // Handled inside PluginDevWorkerHost; never re-emitted here.
        return;
    }
  };

  private async handleHostCall(
    msg: Extract<PluginWorkerToHostMessage, { type: "host-call" }>
  ): Promise<void> {
    try {
      const result = await this.dispatchHostCall(msg.method, msg.params);
      this.workerHost.send({ type: "host-result", requestId: msg.requestId, ok: true, result });
    } catch (err) {
      this.workerHost.send({
        type: "host-result",
        requestId: msg.requestId,
        ok: false,
        error: formatErrorMessage(err, "host call failed"),
      });
    }
  }

  private async dispatchHostCall(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "getActiveWorktree":
        return this.host.getActiveWorktree();
      case "getWorktrees":
        return this.host.getWorktrees();
      case "showToast": {
        const p = params as ShowToastParams;
        // `type` is validated against the NotificationType enum by the host's
        // PluginToastOptionsSchema, so an invalid value rejects there.
        await this.host.showToast({
          message: p.message,
          type: p.type as Parameters<PluginHostApi["showToast"]>[0]["type"],
          durationMs: p.durationMs,
        });
        return undefined;
      }
      case "dispatch": {
        const p = params as DispatchParams;
        return this.host.dispatch(p.actionId, p.args);
      }
      case "settings.get": {
        const p = params as SettingsGetParams;
        return this.host.settings.get(p.key, p.scope);
      }
      case "settings.set": {
        const p = params as SettingsSetParams;
        await this.host.settings.set(p.key, p.value, p.scope);
        return undefined;
      }
      default:
        throw new Error(`Unknown host-call method "${method}"`);
    }
  }

  private handleHostNotify(msg: Extract<PluginWorkerToHostMessage, { type: "host-notify" }>): void {
    try {
      this.dispatchHostNotify(msg.method, msg.params);
    } catch (err) {
      const error = formatErrorMessage(err, "registration failed");
      if (msg.registrationKey) {
        // The proxy call already returned synchronously in the worker — this is
        // the only channel for a deep-validation rejection.
        this.workerHost.send({
          type: "register-error",
          registrationKey: msg.registrationKey,
          error,
        });
      } else {
        logger.warn(`[${this.pluginId}] host-notify "${msg.method}" threw: ${error}`);
      }
    }
  }

  private dispatchHostNotify(method: string, params: unknown): void {
    switch (method) {
      case "registerAction": {
        const { descriptor } = params as RegisterActionParams;
        const namespacedId = `${this.pluginId}.${descriptor.id}`;
        this.host.registerAction(descriptor, (args) =>
          this.invoke({ kind: "action", namespacedId, args })
        );
        return;
      }
      case "registerHandler": {
        const p = params as RegisterHandlerParams;
        if (p.hasSchema && p.requires && p.requires.length > 0) {
          // Fail-closed capability gate — the untyped wrapper we register on the
          // host doesn't carry the schema's `requires`, so enforce it here to
          // match the typed overload's contract.
          const declared = new Set(this.getCapabilities());
          const missing = p.requires.filter((cap) => !declared.has(cap));
          if (missing.length > 0) {
            throw new Error(
              `PERMISSION_REQUIRED: channel "${p.channel}" requires capabilities not declared in the manifest: ${missing.join(", ")}`
            );
          }
        }
        const handler = (ctx: PluginIpcContext, ...args: unknown[]) =>
          this.invoke({ kind: "handler", channel: p.channel, ctx, args });
        this.host.registerHandler(p.channel, handler);
        return;
      }
      case "broadcastToRenderer": {
        const p = params as BroadcastToRendererParams;
        this.host.broadcastToRenderer(p.channel, p.payload);
        return;
      }
      case "invalidateFileDecorations": {
        const p = params as InvalidateFileDecorationsParams;
        this.host.invalidateFileDecorations(p.scope, p.paths);
        return;
      }
      case "registerFileDecorationProvider": {
        const { descriptor } = params as RegisterFileDecorationProviderParams;
        const providerId = descriptor.id;
        // A re-register on the same id replaces the prior binding — dispose it
        // first so the host registry doesn't accumulate stale proxy impls.
        const prior = this.providerDisposers.get(providerId);
        if (prior) {
          try {
            prior();
          } catch {
            // best-effort
          }
        }
        // The impl lives in the worker; register a thin proxy whose single
        // method round-trips each call back over the port (mirrors the action
        // wrapper). `provideDecorations` is async, so this composes cleanly.
        const proxyImpl: FileDecorationProviderImpl = {
          provideDecorations: (scope: string, paths: string[]) =>
            this.invoke({
              kind: "file-decoration-method",
              providerId,
              method: "provideDecorations",
              args: [scope, paths],
            }) as Promise<Record<string, FileDecoration>>,
        };
        const dispose = this.host.registerFileDecorationProvider(descriptor, proxyImpl);
        this.providerDisposers.set(providerId, dispose);
        return;
      }
      case "unregisterFileDecorationProvider": {
        const { providerId } = params as UnregisterFileDecorationProviderParams;
        const dispose = this.providerDisposers.get(providerId);
        if (dispose) {
          this.providerDisposers.delete(providerId);
          dispose();
        }
        return;
      }
      case "logger.info":
      case "logger.warn":
      case "logger.error": {
        const p = params as LoggerParams;
        const level = method.split(".")[1] as "info" | "warn" | "error";
        this.host.logger[level](p.message, p.fields);
        return;
      }
      default:
        logger.warn(`[${this.pluginId}] unknown host-notify method "${method}"`);
    }
  }

  private handleSubscribe(msg: Extract<PluginWorkerToHostMessage, { type: "subscribe" }>): void {
    const { subscriptionId, kind } = msg;
    const push = (payload: unknown): void => {
      if (this.disposed) return;
      this.workerHost.send({ type: "subscription-event", subscriptionId, payload });
    };
    try {
      let dispose: () => void;
      if (kind === "active-worktree") {
        dispose = this.host.onDidChangeActiveWorktree((snapshot) => push(snapshot));
      } else if (kind === "worktrees") {
        dispose = this.host.onDidChangeWorktrees((snapshots) => push(snapshots));
      } else {
        // settings
        if (!msg.key) {
          logger.warn(`[${this.pluginId}] settings subscribe missing key`);
          return;
        }
        dispose = this.host.settings.onDidChange(msg.key, (value) => push(value), msg.scope);
      }
      this.subscriptionDisposers.set(subscriptionId, dispose);
    } catch (err) {
      logger.warn(
        `[${this.pluginId}] subscribe "${kind}" failed: ${formatErrorMessage(err, "subscribe failed")}`
      );
    }
  }

  private invoke(
    target:
      | { kind: "action"; namespacedId: string; args: unknown }
      | { kind: "handler"; channel: string; ctx: PluginIpcContext; args: unknown[] }
      | { kind: "file-decoration-method"; providerId: string; method: string; args: unknown[] }
  ): Promise<unknown> {
    if (this.disposed || !this.workerHost.isReady()) {
      return Promise.reject(new Error(`Plugin "${this.pluginId}" dev worker is not running`));
    }
    const requestId = `i${this.invokeSeq++}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingInvokes.set(requestId, { resolve, reject });
      let sent: boolean;
      if (target.kind === "action") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "action",
          namespacedId: target.namespacedId,
          args: target.args,
        });
      } else if (target.kind === "handler") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "handler",
          channel: target.channel,
          ctx: target.ctx,
          args: target.args,
        });
      } else {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "file-decoration-method",
          providerId: target.providerId,
          method: target.method,
          args: target.args,
        });
      }
      if (!sent) {
        this.pendingInvokes.delete(requestId);
        reject(new Error(`Plugin "${this.pluginId}" dev worker is not running`));
      }
    });
  }

  private resolveActivation(): void {
    if (this.activationSettled) return;
    this.activationSettled = true;
    this.activationResolve?.();
    this.activationResolve = null;
    this.activationReject = null;
  }

  private rejectActivation(error: Error): void {
    if (this.activationSettled) return;
    this.activationSettled = true;
    this.activationReject?.(error);
    this.activationResolve = null;
    this.activationReject = null;
  }
}
