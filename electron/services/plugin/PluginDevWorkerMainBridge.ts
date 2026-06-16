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
import type {
  PluginHostApi,
  PluginIpcContext,
  PluginProcessHandle,
} from "../../../shared/types/plugin.js";
import type { FileDecoration, FileDecorationProviderImpl } from "../../../shared/types/forge.js";
import type {
  BroadcastToRendererParams,
  DispatchParams,
  InvalidateFileDecorationsParams,
  LoggerParams,
  PluginWorkerToHostMessage,
  PostToPanelParams,
  RegisterActionParams,
  RegisterFileDecorationProviderParams,
  RegisterHandlerParams,
  SettingsGetParams,
  SettingsSetParams,
  ShowToastParams,
  ShowQuickPickParams,
  ShowInputBoxParams,
  ShowConfirmParams,
  UnregisterFileDecorationProviderParams,
  FsPathParams,
  FsWriteFileParams,
  FsWatchParams,
  GitOpParams,
  ProcessSpawnParams,
  ProcessHandleRefParams,
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
   * `stack` carries the worker's `activate-error` stack so the provenance record
   * keeps it (parity with the old in-process `toPluginLoadError` path).
   */
  onActivationResult?: (
    result: { ok: true } | { ok: false; error: string; stack?: string }
  ) => void;
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
    result: { ok: true } | { ok: false; error: string; stack?: string }
  ) => void;

  private disposed = false;
  private invokeSeq = 1;
  private readonly pendingInvokes = new Map<string, PendingInvoke>();
  private readonly subscriptionDisposers = new Map<string, () => void>();
  /** AbortControllers for in-flight `host-call`s, keyed by requestId. A worker
   * `host-cancel` (the caller's AbortSignal fired) aborts the matching one. */
  private readonly hostCallAborts = new Map<string, AbortController>();
  /** Bumped on every reload. A host-call that started before a reload must not
   * deliver its late `host-result` to the new worker generation, whose proxy
   * resets its requestId counter and could collide on the same id. */
  private reloadGeneration = 0;
  /** Disposers for providers (file decoration) the worker registered on the real
   * host, keyed by provider id. Torn down on reload and dispose so a reloaded
   * generation re-registers cleanly. */
  private readonly providerDisposers = new Map<string, () => void>();
  /** Live handles for processes the worker spawned via `host.process.spawn`,
   * keyed by the host-assigned handle id. The worker addresses `kill` /
   * `restart` / `onExit` / `onCrash` by id; all are killed on reload and dispose
   * (a reloaded generation re-spawns from its fresh module realm). */
  private readonly processHandles = new Map<string, PluginProcessHandle>();

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
    this.disposeProcessHandles();
    this.abortAllHostCalls();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(new Error("Plugin dev worker bridge disposed"));
    }
    this.pendingInvokes.clear();
    this.rejectActivation(new Error(`Plugin dev worker "${this.pluginId}" disposed`));
  }

  /** Abort every in-flight host call (worker is going away — cancel the I/O). */
  private abortAllHostCalls(): void {
    for (const controller of this.hostCallAborts.values()) {
      try {
        controller.abort();
      } catch {
        // best-effort
      }
    }
    this.hostCallAborts.clear();
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

  /** Kill every process the worker spawned (worker is going away or reloading —
   * a fresh generation re-spawns from its own module realm). */
  private disposeProcessHandles(): void {
    for (const handle of this.processHandles.values()) {
      try {
        handle.kill();
      } catch {
        // best-effort
      }
    }
    this.processHandles.clear();
  }

  private onReloading = (): void => {
    // The new worker generation will re-register from scratch; drop the prior
    // generation's activate-time registrations and tear down subscriptions so
    // they don't double up. Pending invokes target a now-dead worker — fail them.
    this.reloadGeneration++;
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
    this.disposeProcessHandles();
    this.abortAllHostCalls();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(new Error("Plugin reloaded before invocation completed"));
    }
    this.pendingInvokes.clear();
  };

  private onCrashLoop = (code: number): void => {
    logger.error(
      `[${this.pluginId}] dev worker entered a crash loop (code ${code}); reload halted until next edit`
    );
    // Persist the crash to the owner's provenance — unlike activate-error/error,
    // a crash loop can trip after a successful activation (on a later reload), so
    // the loadError write must go through onActivationResult, not just the
    // activation promise rejection (which has no listener post-activation).
    this.onActivationResult?.({
      ok: false,
      error: `Plugin "${this.pluginId}" dev worker crash loop (code ${code})`,
    });
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
        this.onActivationResult?.({ ok: false, error: msg.error, stack: msg.stack });
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
      case "host-cancel": {
        const controller = this.hostCallAborts.get(msg.requestId);
        if (controller) controller.abort();
        return;
      }
      case "host-notify":
        void this.handleHostNotify(msg);
        return;
      case "subscribe":
        void this.handleSubscribe(msg);
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
    // Track an AbortController so a worker `host-cancel` can cancel the in-flight
    // read/mutation (signal-bearing host methods honor it).
    const controller = new AbortController();
    this.hostCallAborts.set(msg.requestId, controller);
    // Capture the generation so a result that resolves after a reload is dropped
    // rather than mis-delivered to the new worker (whose requestIds collide).
    const generation = this.reloadGeneration;
    try {
      const result = await this.dispatchHostCall(msg.method, msg.params, controller.signal);
      if (this.disposed || generation !== this.reloadGeneration) return;
      this.workerHost.send({ type: "host-result", requestId: msg.requestId, ok: true, result });
    } catch (err) {
      if (this.disposed || generation !== this.reloadGeneration) return;
      this.workerHost.send({
        type: "host-result",
        requestId: msg.requestId,
        ok: false,
        error: formatErrorMessage(err, "host call failed"),
      });
    } finally {
      this.hostCallAborts.delete(msg.requestId);
    }
  }

  private async dispatchHostCall(
    method: string,
    params: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    switch (method) {
      case "getActiveWorktree":
        return this.host.getActiveWorktree();
      case "getWorktrees":
        return this.host.getWorktrees();
      case "getWorktreeStatus":
        return this.host.getWorktreeStatus(params as string, { signal });
      case "getAgentState":
        return this.host.getAgentState();
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
      case "showQuickPick": {
        // Reuse the real host so validation/provenance/cancellation all match
        // the installed-plugin path. On reload the dialog auto-resolves when the
        // user dismisses or the plugin unloads (promptDispatcher.cancelForPlugin).
        const p = params as ShowQuickPickParams;
        return this.host.showQuickPick(p.items, p.options ?? {});
      }
      case "showInputBox": {
        const p = params as ShowInputBoxParams;
        return this.host.showInputBox(p.options);
      }
      case "showConfirm": {
        const p = params as ShowConfirmParams;
        return this.host.showConfirm(p.options);
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
      case "fs.readFile":
        return this.host.fs.readFile((params as FsPathParams).path, { signal });
      case "fs.writeFile": {
        const p = params as FsWriteFileParams;
        await this.host.fs.writeFile(p.path, p.contents);
        return undefined;
      }
      case "fs.readdir":
        return this.host.fs.readdir((params as FsPathParams).path, { signal });
      case "fs.stat":
        return this.host.fs.stat((params as FsPathParams).path, { signal });
      case "fs.watch": {
        const p = params as FsWatchParams;
        const generation = this.reloadGeneration;
        // The real watcher lives in main; relay each change as a
        // subscription-event keyed by the worker-supplied subscription id.
        const dispose = await this.host.fs.watch(
          p.paths,
          (changedPath) => {
            if (this.disposed) return;
            this.workerHost.send({
              type: "subscription-event",
              subscriptionId: p.subscriptionId,
              payload: changedPath,
            });
          },
          { signal }
        );
        // Disposed or reloaded while the watch was settling — tear it down
        // rather than leak it past the cleanup pass that already ran.
        if (this.disposed || generation !== this.reloadGeneration) {
          try {
            dispose();
          } catch {
            // best-effort
          }
          return undefined;
        }
        this.subscriptionDisposers.set(p.subscriptionId, dispose);
        return undefined;
      }
      case "process.spawn": {
        const p = params as ProcessSpawnParams;
        const generation = this.reloadGeneration;
        const handle = await this.host.process.spawn(p.command, p.options);
        // Disposed or reloaded while the spawn was settling — the worker that
        // requested it is gone; kill the orphan rather than leak it.
        if (this.disposed || generation !== this.reloadGeneration) {
          try {
            handle.kill();
          } catch {
            // best-effort
          }
          return { id: handle.id };
        }
        this.processHandles.set(handle.id, handle);
        return { id: handle.id };
      }
      case "process.restart": {
        const p = params as ProcessHandleRefParams;
        const handle = this.processHandles.get(p.processId);
        if (!handle) {
          throw new Error(`No live process "${p.processId}" to restart`);
        }
        await handle.restart();
        return undefined;
      }
      case "git.status":
        return this.host.git.status((params as GitOpParams).worktreePath, { signal });
      case "git.diff": {
        const p = params as GitOpParams;
        return this.host.git.diff(p.worktreePath, p.filePath, { signal });
      }
      case "git.add": {
        const p = params as GitOpParams;
        await this.host.git.add(p.worktreePath, p.paths, { signal });
        return undefined;
      }
      case "git.commit": {
        const p = params as GitOpParams;
        return this.host.git.commit(p.worktreePath, { message: p.message ?? "" }, { signal });
      }
      default:
        throw new Error(`Unknown host-call method "${method}"`);
    }
  }

  private async handleHostNotify(
    msg: Extract<PluginWorkerToHostMessage, { type: "host-notify" }>
  ): Promise<void> {
    try {
      await this.dispatchHostNotify(msg.method, msg.params);
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

  private async dispatchHostNotify(method: string, params: unknown): Promise<void> {
    switch (method) {
      case "registerAction": {
        const { descriptor } = params as RegisterActionParams;
        const namespacedId = `${this.pluginId}.${descriptor.id}`;
        // The host registers synchronously and resolves; await so a deep-
        // validation rejection routes to the register-error channel.
        await this.host.registerAction(descriptor, (args) =>
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
        await this.host.registerHandler(p.channel, handler);
        return;
      }
      case "broadcastToRenderer": {
        const p = params as BroadcastToRendererParams;
        await this.host.broadcastToRenderer(p.channel, p.payload);
        return;
      }
      case "postToPanel": {
        const p = params as PostToPanelParams;
        await this.host.postToPanel(p.channel, p.payload);
        return;
      }
      case "invalidateFileDecorations": {
        const p = params as InvalidateFileDecorationsParams;
        await this.host.invalidateFileDecorations(p.scope, p.paths);
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
        const generation = this.reloadGeneration;
        const dispose = await this.host.registerFileDecorationProvider(descriptor, proxyImpl);
        // The bridge may have been torn down (dispose) or reloaded while the host
        // registration was settling — don't leak the freshly bound provider past
        // the cleanup pass that already ran.
        if (this.disposed || generation !== this.reloadGeneration) {
          try {
            dispose();
          } catch {
            // best-effort
          }
          return;
        }
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
        // Logger stays synchronous fire-and-forget (the #10519 carve-out).
        this.host.logger[level](p.message, p.fields);
        return;
      }
      case "process.kill": {
        // `PluginProcessHandle.kill()` is sync (no reply) — fire-and-forget. A
        // no-op if the handle already exited or was torn down on reload.
        const { processId } = params as ProcessHandleRefParams;
        this.processHandles.get(processId)?.kill();
        return;
      }
      default:
        logger.warn(`[${this.pluginId}] unknown host-notify method "${method}"`);
    }
  }

  private async handleSubscribe(
    msg: Extract<PluginWorkerToHostMessage, { type: "subscribe" }>
  ): Promise<void> {
    const { subscriptionId, kind } = msg;
    const push = (payload: unknown): void => {
      if (this.disposed) return;
      this.workerHost.send({ type: "subscription-event", subscriptionId, payload });
    };
    const generation = this.reloadGeneration;
    try {
      let dispose: () => void;
      if (kind === "active-worktree") {
        dispose = await this.host.onDidChangeActiveWorktree((snapshot) => push(snapshot));
      } else if (kind === "worktrees") {
        dispose = await this.host.onDidChangeWorktrees((snapshots) => push(snapshots), {
          debounceMs: msg.debounceMs,
        });
      } else if (kind === "agent-state") {
        dispose = await this.host.onDidChangeAgentState((snapshot) => push(snapshot));
      } else if (kind === "process-exit" || kind === "process-crash") {
        if (!msg.processId) {
          logger.warn(`[${this.pluginId}] ${kind} subscribe missing processId`);
          return;
        }
        const handle = this.processHandles.get(msg.processId);
        if (!handle) {
          // The handle was killed (reload/dispose) between spawn and subscribe.
          logger.warn(`[${this.pluginId}] ${kind} subscribe for unknown process "${msg.processId}"`);
          return;
        }
        dispose =
          kind === "process-exit"
            ? handle.onExit((info) => push(info))
            : handle.onCrash((info) => push(info));
      } else {
        // settings
        if (!msg.key) {
          logger.warn(`[${this.pluginId}] settings subscribe missing key`);
          return;
        }
        dispose = await this.host.settings.onDidChange(msg.key, (value) => push(value), msg.scope);
      }
      // The bridge may have been disposed or reloaded while the subscription was
      // settling — tear it down rather than leak it past the cleanup pass.
      if (this.disposed || generation !== this.reloadGeneration) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return;
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
