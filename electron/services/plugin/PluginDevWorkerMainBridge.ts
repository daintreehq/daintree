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
  PluginDuplexProcessHandle,
  PluginPtyProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessMode,
  PluginSettingsScope,
  PluginStorageScope,
} from "../../../shared/types/plugin.js";
import type { FileDecoration, FileDecorationProviderImpl } from "../../../shared/types/forge.js";
import type {
  ActionsGetParams,
  BroadcastToRendererParams,
  DispatchParams,
  SendToActiveAgentParams,
  InvalidateFileDecorationsParams,
  LoggerParams,
  PluginWorkerToHostMessage,
  PostToPanelParams,
  SetPanelBadgeParams,
  RegisterActionParams,
  RegisterFileDecorationProviderParams,
  RegisterHandlerParams,
  SettingsGetParams,
  SettingsSetParams,
  StorageGetParams,
  StorageSetParams,
  StorageDeleteParams,
  ShowToastParams,
  ShowQuickPickParams,
  ShowInputBoxParams,
  ShowConfirmParams,
  UnregisterFileDecorationProviderParams,
  FsPathParams,
  FsWriteFileParams,
  FsWatchParams,
  GitOpParams,
  ClipboardWriteTextParams,
  ClipboardWriteImageParams,
  SystemPathParams,
  ProcessSpawnParams,
  ProcessHandleRefParams,
  ProcessWriteParams,
  ProcessResizeParams,
} from "../../../shared/types/pluginDevWorker.js";
import type { PluginDevWorkerHost } from "./PluginDevWorkerHost.js";
import { parseWorkerToHostMessage } from "../../schemas/pluginDevWorker.js";

const logger = createLogger("main:PluginDevWorkerBridge");

/**
 * Structural narrowing for an interactive process handle (#11300). The host adds
 * `resize` only for a real PTY, so its presence — not what the worker
 * requested — is what decides whether the resize relay is available.
 *
 * Must be tested BEFORE {@link isWritableHandle}: a PTY handle satisfies both.
 */
function isPtyHandle(handle: PluginProcessHandle): handle is PluginPtyProcessHandle {
  const candidate = handle as Partial<PluginPtyProcessHandle>;
  return typeof candidate.write === "function" && typeof candidate.resize === "function";
}

/**
 * Structural narrowing for any handle whose input the plugin can drive (#11871)
 * — a duplex child's stdin or a PTY. Same principle as {@link isPtyHandle}: the
 * shape the host actually built decides what the relay forwards, so a worker
 * cannot fabricate a `write` onto a pipe-mode process that has no stdin.
 */
function isWritableHandle(handle: PluginProcessHandle): handle is PluginDuplexProcessHandle {
  return typeof (handle as Partial<PluginDuplexProcessHandle>).write === "function";
}

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

/**
 * One in-flight required registration (#12282). A distinct object per proposal,
 * not a key-based entry: the same `registrationKey` can legitimately be proposed
 * twice in one `activate()` (replace semantics), and identity is what keeps the
 * second proposal from releasing the first one's slot.
 */
interface PendingRegistration {
  readonly registrationKey: string;
}

/**
 * Where the current generation's activation stands (#12282).
 *
 * `activating` → the worker has not reported `activated` yet; a registration
 * settling now must not commit anything. `draining` → `activated` arrived and
 * the commit is waiting on the last required registration. `succeeded` /
 * `failed` are terminal for the generation, and `failed` latches: the FIRST
 * failure is the one the author sees, so a rejected contribution isn't
 * overwritten by a later, vaguer `activate-error`.
 */
type ActivationPhase = "activating" | "draining" | "succeeded" | "failed";

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
  /**
   * Latched once this worker generation has broken the protocol. Terminal: the
   * plugin instance is torn down, so it is never cleared.
   */
  private protocolViolated = false;
  private invokeSeq = 1;
  private readonly pendingInvokes = new Map<string, PendingInvoke>();

  /** In-flight main→worker invokes — the governance "action in flight" signal. */
  get pendingInvokeCount(): number {
    return this.pendingInvokes.size;
  }

  /**
   * In-flight worker→main host calls (fs, git, prompts like showQuickPick —
   * which can legitimately sit open for a long time). Governance must treat
   * these as live work: disposing the worker would abort the call and dismiss
   * any visible prompt out from under the user.
   */
  get pendingHostCallCount(): number {
    return this.hostCallAborts.size;
  }
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

  /**
   * Required registrations still awaiting main-side deep validation (#12282).
   * A `host-notify` carrying a `registrationKey` is a contribution the plugin
   * believes it made — the worker proxy already returned success to it — so the
   * activation commit waits on this set draining. Cleared on reload and dispose
   * with the rest of the generation's state.
   */
  private readonly pendingRegistrations = new Set<PendingRegistration>();
  private activationPhase: ActivationPhase = "activating";
  /**
   * True between retiring a generation and the replacement child's boot `ready`.
   *
   * The generation counter alone cannot attribute these: a message the outgoing
   * child posted before it was killed is delivered AFTER `reloadGeneration` was
   * bumped, so it reads as belonging to the incoming one. That is harmless for
   * a late `host-result` (the id is simply dropped) but not for an activation
   * outcome — a dying worker's `activate-error` would otherwise latch a failure
   * onto its replacement and veto the replacement's own success. `ready` is
   * posted by the new child at boot, so it is the first message that provably
   * belongs to the incoming generation.
   */
  private awaitingReplacement = false;

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
    // Guard the first-activation promise so a rejection that lands before any
    // consumer awaited it (dispose / crash-loop right after construction) can't
    // surface as an unhandled rejection. The real consumer still observes the
    // rejection via `waitForActivation()`. Mirrors `PluginDevWorkerHost`'s
    // `readyPromise.catch` guard.
    this.activationPromise.catch(() => undefined);

    this.workerHost.on("worker-message", this.onWorkerMessage);
    this.workerHost.on("ready", this.onWorkerReady);
    this.workerHost.on("reloading", this.onReloading);
    this.workerHost.on("exit", this.onWorkerExit);
    this.workerHost.on("crash-loop", this.onCrashLoop);
    this.workerHost.on("protocol-violation", this.onProtocolViolation);
  }

  /** Resolves once the worker's first `activate()` completes (or rejects). */
  waitForActivation(): Promise<void> {
    return this.activationPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workerHost.off("worker-message", this.onWorkerMessage);
    this.workerHost.off("ready", this.onWorkerReady);
    this.workerHost.off("reloading", this.onReloading);
    this.workerHost.off("exit", this.onWorkerExit);
    this.workerHost.off("crash-loop", this.onCrashLoop);
    this.workerHost.off("protocol-violation", this.onProtocolViolation);
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
    // Nothing can commit an activation after this point; drop the tracking so a
    // registration settling late can't resurrect the drain.
    this.pendingRegistrations.clear();
    this.activationPhase = "failed";
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

  /** The replacement child booted — everything from here belongs to it. */
  private onWorkerReady = (): void => {
    this.awaitingReplacement = false;
  };

  private onReloading = (): void => {
    this.retireGeneration("Plugin reloaded before invocation completed");
  };

  /**
   * Retire everything bound to the outgoing worker generation.
   *
   * Bumping `reloadGeneration` is the load-bearing part: request ids are a
   * per-worker counter that restarts at 1, so a result from the outgoing
   * generation settling late would otherwise be delivered to the incoming one
   * under a colliding id. Registrations, subscriptions, providers and spawned
   * processes go too — the replacement re-runs `activate()` and re-registers
   * from its own module realm, so anything left behind is a duplicate the new
   * generation cannot address.
   */
  private retireGeneration(reason: string): void {
    this.reloadGeneration++;
    // Before the fallible steps: aborting the outgoing generation's host calls
    // is what takes its open prompts off the user's screen, and a throw from
    // plugin-supplied registration cleanup must not strand a visible dialog.
    this.abortAllHostCalls();
    try {
      this.clearPriorRegistrations();
    } catch {
      // best-effort — one failed step must not skip the rest of the teardown
    }
    // The replacement re-runs activate() and re-proposes its contributions from
    // scratch, so the outgoing generation's registration tracking and activation
    // verdict both start over (#12282).
    this.pendingRegistrations.clear();
    this.activationPhase = "activating";
    this.awaitingReplacement = true;
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
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingInvokes.clear();
  }

  /**
   * The worker process is gone (#12216).
   *
   * An INTENTIONAL exit (reload, dispose) announces itself first — the host
   * emits `reloading` before the kill — so the generation is already retired
   * and only a straggler admitted in the gap needs settling.
   *
   * A CRASH announces nothing. The host respawns a worker that has never seen
   * the outstanding request ids, so without this every in-flight invoke hangs
   * its caller forever, the crashed generation's subscriptions and providers
   * stay registered against a worker that cannot serve them, and a late
   * host-result can be delivered to the replacement under a colliding id. It
   * is the same generation boundary a reload is, so it gets the same teardown.
   *
   * Deliberately no wall-clock timeout on `invoke` itself. This bridge carries
   * actions, IPC handlers and decoration calls whose legitimate durations
   * differ by orders of magnitude — a plugin action that runs a build or a
   * clone is not hung — so a blanket deadline would break working plugins to
   * catch a case the caller can bound better. Callers that DO have a budget
   * already own one (`DECORATION_PROVIDER_TIMEOUT_MS` in ipc/handlers/plugin.ts).
   * What was genuinely unbounded is a dead worker, and that is what this fixes.
   */
  private onWorkerExit = (code: number, expected: boolean): void => {
    if (this.disposed) return;
    if (!expected) {
      this.retireGeneration(
        `Plugin "${this.pluginId}" dev worker crashed (code ${code}) before invocation completed`
      );
      return;
    }
    // `reloading` already retired the generation; anything still here entered
    // during the gap between that and the process actually going away.
    if (this.pendingInvokes.size === 0 && this.hostCallAborts.size === 0) return;
    this.abortAllHostCalls();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(
        new Error(`Plugin "${this.pluginId}" dev worker stopped before invocation completed`)
      );
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
    this.failActivation(`Plugin "${this.pluginId}" dev worker crash loop (code ${code})`);
  };

  /** The host rejected a message at the transport boundary (#12276). */
  private onProtocolViolation = (reason: string): void => {
    this.failProtocolViolation(reason);
  };

  /**
   * Terminal, plugin-scoped failure for a worker that broke the protocol.
   *
   * Mirrors {@link onCrashLoop}'s reporting — `onActivationResult` is the only
   * channel that reaches provenance after a successful activation, so a
   * violation on a later reload still records a `loadError` — then tears the
   * instance down: registrations, subscriptions, providers and spawned
   * processes go with the generation, and the worker itself is stopped rather
   * than left posting messages main will not read.
   *
   * The reason is a fixed main-authored phrase. Nothing derived from the
   * rejected message reaches it: this string becomes the plugin's user-visible
   * `loadError`, and Zod's own error text inlines the offending input.
   *
   * Each teardown step is contained separately so a throw in one cannot leave
   * the misbehaving worker running.
   */
  private failProtocolViolation(reason: string): void {
    if (this.protocolViolated || this.disposed) return;
    this.protocolViolated = true;
    const error = `Plugin "${this.pluginId}" dev worker stopped: ${reason}`;
    logger.error(`[${this.pluginId}] ${error}`);
    try {
      this.onActivationResult?.({ ok: false, error });
    } catch (err) {
      logger.error(`[${this.pluginId}] activation-result listener threw`, {
        error: formatErrorMessage(err, "listener threw"),
      });
    }
    this.rejectActivation(new Error(error));
    try {
      this.retireGeneration(error);
    } catch (err) {
      logger.error(`[${this.pluginId}] generation retire threw`, {
        error: formatErrorMessage(err, "retire threw"),
      });
    }
    try {
      this.dispose();
    } catch (err) {
      logger.error(`[${this.pluginId}] bridge dispose threw`, {
        error: formatErrorMessage(err, "dispose threw"),
      });
    }
    this.workerHost.dispose();
  }

  private onWorkerMessage = (raw: unknown): void => {
    if (this.disposed || this.protocolViolated) return;
    // Second ingress point (#12276): `worker-message` is an ordinary emitter
    // event, not a runtime-typed channel, so validate here too rather than
    // trusting that every emitter upstream already did.
    const parsed = parseWorkerToHostMessage(raw);
    if (!parsed.ok) {
      logger.error(`[${this.pluginId}] worker message violates the protocol`, {
        issues: parsed.issues,
      });
      this.failProtocolViolation("worker sent a malformed message");
      return;
    }
    try {
      this.dispatchWorkerMessage(parsed.message);
    } catch (err) {
      logger.error(`[${this.pluginId}] worker message handling threw`, {
        error: formatErrorMessage(err, "handler threw"),
      });
      this.failProtocolViolation("worker message handling failed");
    }
  };

  private dispatchWorkerMessage(msg: PluginWorkerToHostMessage): void {
    // An `activated` from a child that has already been retired describes the
    // outgoing generation. Committing on it would close the incoming
    // generation's registration gate before that worker has proposed anything
    // (#12282). Its failure counterparts still report — see `failActivation`.
    if (this.awaitingReplacement && msg.type === "activated") return;
    switch (msg.type) {
      case "activated":
        // The worker posts this the moment activate() returns, which says
        // nothing about the contributions it proposed on the way: every
        // register* was fire-and-forget, so its deep validation may still be in
        // flight here (#12282). Open the drain instead of committing, and let
        // whichever finishes last do the commit. With nothing pending — the
        // common case, and every pre-existing caller — this commits inline.
        if (this.activationPhase === "activating") this.activationPhase = "draining";
        this.tryCommitActivation();
        return;
      case "activate-error":
        logger.error(`[${this.pluginId}] activate() failed: ${msg.error}`, {
          stack: msg.stack,
        });
        this.failActivation(msg.error, msg.stack);
        return;
      case "error":
        logger.error(`[${this.pluginId}] worker error: ${msg.error}`);
        this.failActivation(msg.error);
        return;
      case "host-call":
        void this.handleHostCall(msg);
        return;
      case "host-cancel": {
        const controller = this.hostCallAborts.get(msg.requestId);
        if (controller) controller.abort();
        return;
      }
      case "host-notify": {
        // A `registrationKey` marks a required registration — a contribution the
        // plugin believes it made. Enlist it synchronously, before dispatch, so
        // an `activated` arriving behind it (FIFO port, so it always does) finds
        // it pending rather than racing it (#12282).
        const registration =
          msg.registrationKey && !this.awaitingReplacement
            ? { registrationKey: msg.registrationKey }
            : undefined;
        if (registration) this.pendingRegistrations.add(registration);
        void this.handleHostNotify(msg, registration);
        return;
      }
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
  }

  private async handleHostCall(
    msg: Extract<PluginWorkerToHostMessage, { type: "host-call" }>
  ): Promise<void> {
    // A second call under an id that is still outstanding is a protocol
    // violation, not a retry: the two would share one reply and one
    // cancellation handle, so the reply is no longer attributable to either.
    // Ids become reusable once a call settles and `finally` clears the entry.
    if (this.hostCallAborts.has(msg.requestId)) {
      this.failProtocolViolation("worker reused an outstanding request id");
      return;
    }
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
      // Only if this controller is still the one registered: a worker that
      // crashed mid-call is replaced by one whose requestId counter restarts
      // from scratch, so an unconditional delete here can drop the SUCCESSOR's
      // controller and leave its call unabortable.
      if (this.hostCallAborts.get(msg.requestId) === controller) {
        this.hostCallAborts.delete(msg.requestId);
      }
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
      case "getWorktreesResult":
        return this.host.getWorktreesResult();
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
      case "actions.list":
        return this.host.actions.list();
      case "actions.get": {
        const p = params as ActionsGetParams;
        return this.host.actions.get(p.actionId);
      }
      case "sendToActiveAgent": {
        const p = params as SendToActiveAgentParams;
        await this.host.sendToActiveAgent(p.text, p.options);
        return undefined;
      }
      case "showQuickPick": {
        // Reuse the real host so validation/provenance/cancellation all match
        // the installed-plugin path. `signal` is what ties the dialog to this
        // generation: retiring one aborts every in-flight host call, which
        // dismisses the question rather than leaving it on screen owned by a
        // worker that no longer exists (#12279).
        const p = params as ShowQuickPickParams;
        return this.host.showQuickPick(p.items, p.options ?? {}, { signal });
      }
      case "showInputBox": {
        const p = params as ShowInputBoxParams;
        return this.host.showInputBox(p.options, { signal });
      }
      case "showConfirm": {
        const p = params as ShowConfirmParams;
        return this.host.showConfirm(p.options, { signal });
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
      case "storage.get": {
        const p = params as StorageGetParams;
        return this.host.storage.get(p.key, p.scope);
      }
      case "storage.set": {
        const p = params as StorageSetParams;
        await this.host.storage.set(p.key, p.value, p.scope);
        return undefined;
      }
      case "storage.delete": {
        const p = params as StorageDeleteParams;
        await this.host.storage.delete(p.key, p.scope);
        return undefined;
      }
      case "fs.readFile":
        return this.host.fs.readFile((params as FsPathParams).path, { signal });
      case "fs.readFileBytes":
        return this.host.fs.readFileBytes((params as FsPathParams).path, { signal });
      case "fs.writeFile": {
        const p = params as FsWriteFileParams;
        await this.host.fs.writeFile(p.path, p.contents);
        return undefined;
      }
      case "fs.readdir": {
        const p = params as FsPathParams;
        return this.host.fs.readdir(p.path, { signal, ...(p.detail === true && { detail: true }) });
      }
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
        const handle = await this.host.process.spawn(
          p.command,
          p.options as PluginProcessSpawnOptions
        );
        // Report the mode from the handle the host actually built, not from what
        // the worker asked for, so the proxy can't hand a plugin `write()` on a
        // process that has no writable input. PTY is tested first — it satisfies
        // the writable check too.
        const mode: PluginProcessMode = isPtyHandle(handle)
          ? "pty"
          : isWritableHandle(handle)
            ? "duplex"
            : "pipe";
        // Disposed or reloaded while the spawn was settling — the worker that
        // requested it is gone; kill the orphan rather than leak it.
        if (this.disposed || generation !== this.reloadGeneration) {
          try {
            handle.kill();
          } catch {
            // best-effort
          }
          return { id: handle.id, mode };
        }
        this.processHandles.set(handle.id, handle);
        return { id: handle.id, mode };
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
      case "clipboard.writeText": {
        await this.host.clipboard.writeText((params as ClipboardWriteTextParams).text);
        return undefined;
      }
      case "clipboard.writeImage": {
        await this.host.clipboard.writeImage((params as ClipboardWriteImageParams).pngData);
        return undefined;
      }
      case "system.openPath": {
        await this.host.system.openPath((params as SystemPathParams).targetPath);
        return undefined;
      }
      case "system.showItemInFolder": {
        await this.host.system.showItemInFolder((params as SystemPathParams).targetPath);
        return undefined;
      }
      case "clipboard.readText":
        return this.host.clipboard.readText();
      default:
        throw new Error(`Unknown host-call method "${method}"`);
    }
  }

  private async handleHostNotify(
    msg: Extract<PluginWorkerToHostMessage, { type: "host-notify" }>,
    registration?: PendingRegistration
  ): Promise<void> {
    // Captured before the await: a reload replaces the worker mid-validation,
    // and the outgoing generation's verdict must not land on the incoming one.
    const generation = this.reloadGeneration;
    try {
      await this.dispatchHostNotify(msg.method, msg.params);
    } catch (err) {
      const error = formatErrorMessage(err, "registration failed");
      if (this.disposed || generation !== this.reloadGeneration) return;
      if (!msg.registrationKey) {
        logger.warn(`[${this.pluginId}] host-notify "${msg.method}" threw: ${error}`);
        return;
      }
      // The proxy call already returned success to the plugin, so this is the
      // only channel for a deep-validation rejection.
      this.workerHost.send({
        type: "register-error",
        registrationKey: msg.registrationKey,
        error,
      });
      // ...and the log line the author wasn't watching is not a report. A
      // rejected required registration means the plugin is live but missing a
      // contribution it thinks it has, so it fails activation by name (#12282).
      // Only for one this generation actually enlisted: a straggler from a
      // retired child must not veto the replacement that is booting.
      if (registration) {
        this.failActivation(
          `Plugin "${this.pluginId}" registration "${msg.registrationKey}" was rejected: ${error}`,
          err instanceof Error ? err.stack : undefined
        );
      }
    } finally {
      if (registration) {
        // A no-op once the generation was retired (the set is already cleared),
        // which is exactly what a stale settlement should be.
        this.pendingRegistrations.delete(registration);
        if (!this.disposed && generation === this.reloadGeneration) this.tryCommitActivation();
      }
    }
  }

  /**
   * Commit the activation once `activated` has arrived AND every required
   * registration has settled (#12282). Called from both edges of that join, so
   * whichever lands last performs the commit; a no-op from any other phase.
   */
  private tryCommitActivation(): void {
    if (this.activationPhase !== "draining" || this.pendingRegistrations.size > 0) return;
    this.activationPhase = "succeeded";
    // Fires on initial activation and every reload — keep the owner's
    // provenance in sync on each, not just the first.
    this.onActivationResult?.({ ok: true });
    this.resolveActivation();
  }

  /**
   * Record an activation failure for the current generation.
   *
   * Latches on the FIRST failure: a rejected contribution names the thing the
   * author has to fix, and a later `activate-error` from the same broken
   * activation would otherwise overwrite it with something vaguer. Reports even
   * after a successful commit — a failure that lands post-activation still has
   * to reach provenance, since the settled promise has no listener left (the
   * crash-loop precedent).
   */
  private failActivation(error: string, stack?: string): void {
    // Latch the failure onto the CURRENT generation — unless it came from a
    // child already retired, whose outcome should still reach provenance but
    // must not veto the replacement now booting, whose own `activated` has to
    // stay able to clear the loadError (#12282).
    if (!this.awaitingReplacement) {
      if (this.activationPhase === "failed") return;
      this.activationPhase = "failed";
      this.pendingRegistrations.clear();
    }
    this.onActivationResult?.({ ok: false, error, stack });
    this.rejectActivation(new Error(error));
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
        await this.host.postToPanel(p.channel, p.payload, p.panelId);
        return;
      }
      case "invalidateFileDecorations": {
        const p = params as InvalidateFileDecorationsParams;
        await this.host.invalidateFileDecorations(p.scope, p.paths);
        return;
      }
      case "setPanelBadge": {
        const p = params as SetPanelBadgeParams;
        await this.host.setPanelBadge(p.panelId, p.badge);
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
      case "process.write": {
        const p = params as ProcessWriteParams;
        const handle = this.processHandles.get(p.processId);
        // Silently ignored for a pipe-mode handle: the worker proxy only exposes
        // `write` on a writable handle (duplex or PTY), so reaching here means a
        // plugin fabricated the call. Warn rather than throw — this is a notify.
        if (!handle || !isWritableHandle(handle)) {
          logger.warn(`[${this.pluginId}] process.write on non-writable "${p.processId}"`);
          return;
        }
        if (typeof p.data !== "string") return;
        handle.write(p.data);
        return;
      }
      case "process.resize": {
        const p = params as ProcessResizeParams;
        const handle = this.processHandles.get(p.processId);
        // Stays PTY-only: a duplex child has no terminal to resize.
        if (!handle || !isPtyHandle(handle)) {
          logger.warn(`[${this.pluginId}] process.resize on non-interactive "${p.processId}"`);
          return;
        }
        handle.resize(p.cols, p.rows);
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
    const generation = this.reloadGeneration;
    const push = (payload: unknown): void => {
      // Drop events queued before a reload tore this subscription down: the new
      // worker generation resets its requestId/subscriptionId counter, so a
      // stale event could otherwise misdeliver to a same-id new subscription.
      if (this.disposed || generation !== this.reloadGeneration) return;
      this.workerHost.send({ type: "subscription-event", subscriptionId, payload });
    };
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
      } else if (kind === "panel-lifecycle") {
        dispose = await this.host.onDidChangePanelLifecycle((event) => push(event));
      } else if (kind === "system-wake") {
        dispose = await this.host.onDidWake((event) => push(event));
      } else if (kind === "process-exit" || kind === "process-crash" || kind === "process-data") {
        if (!msg.processId) {
          logger.warn(`[${this.pluginId}] ${kind} subscribe missing processId`);
          return;
        }
        const handle = this.processHandles.get(msg.processId);
        if (!handle) {
          // The handle was killed (reload/dispose) between spawn and subscribe.
          logger.warn(
            `[${this.pluginId}] ${kind} subscribe for unknown process "${msg.processId}"`
          );
          return;
        }
        dispose =
          kind === "process-exit"
            ? handle.onExit((info) => push(info))
            : kind === "process-crash"
              ? handle.onCrash((info) => push(info))
              : handle.onData((chunk) => push(chunk));
      } else if (kind === "storage") {
        if (!msg.key) {
          logger.warn(`[${this.pluginId}] storage subscribe missing key`);
          return;
        }
        dispose = await this.host.storage.onDidChange(
          msg.key,
          (value) => push(value),
          msg.scope as PluginStorageScope | undefined
        );
      } else {
        // settings
        if (!msg.key) {
          logger.warn(`[${this.pluginId}] settings subscribe missing key`);
          return;
        }
        dispose = await this.host.settings.onDidChange(
          msg.key,
          (value) => push(value),
          msg.scope as PluginSettingsScope | undefined
        );
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
