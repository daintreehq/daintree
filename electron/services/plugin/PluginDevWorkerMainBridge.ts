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
import type { PluginHostApi, PluginMcpCaller } from "../../../shared/types/plugin.js";
import type {
  PluginHostCallMethod,
  PluginHostNotifyMethod,
  PluginWorkerSubscriptionKind,
  PluginWorkerToHostMessage,
} from "../../../shared/types/pluginDevWorker.js";
import {
  ENDED_SERVICE_INVOCATION,
  currentServiceInvocation,
  runWithServiceInvocation,
  type PluginServiceInvocation,
} from "./pluginServiceInvocation.js";
import type { PluginDevWorkerHost } from "./PluginDevWorkerHost.js";
import { parseWorkerToHostMessage } from "../../schemas/pluginDevWorker.js";
import { abortErrorFor } from "./pluginAbortError.js";
import { serializableErrorFields } from "./pluginHostErrorFields.js";
import {
  currentPluginInvocation,
  runWithEndedPluginInvocation,
  runWithPluginInvocation,
  type EndedPluginInvocation,
  type PluginInvocationScope,
} from "./pluginFrontendRouting.js";
import {
  routesFrom,
  type ActivationPhase,
  type DevWorkerBridgeContext,
  type HostCallHandler,
  type HostNotifyHandler,
  type InvokeTarget,
  type RoutesCover,
  type SubscribeHandler,
} from "./devWorkerBridge/bridgeContext.js";
import { ContributionsDomain } from "./devWorkerBridge/contributionsDomain.js";
import { DataDomain } from "./devWorkerBridge/dataDomain.js";
import { ResourcesDomain } from "./devWorkerBridge/resourcesDomain.js";
import { WorkspaceDomain } from "./devWorkerBridge/workspaceDomain.js";

const logger = createLogger("main:PluginDevWorkerBridge");

// Every method and kind the protocol allows has a route: one added to the
// shared vocabulary without a handler fails typecheck here.
void ([true, true, true] satisfies [
  RoutesCover<
    PluginHostCallMethod,
    | keyof WorkspaceDomain["hostCalls"]
    | keyof DataDomain["hostCalls"]
    | keyof ResourcesDomain["hostCalls"]
  >,
  RoutesCover<
    PluginHostNotifyMethod,
    | keyof WorkspaceDomain["notifications"]
    | keyof ContributionsDomain["notifications"]
    | keyof ResourcesDomain["notifications"]
    | "pushRejected"
  >,
  RoutesCover<
    PluginWorkerSubscriptionKind,
    | keyof WorkspaceDomain["subscriptions"]
    | keyof DataDomain["subscriptions"]
    | keyof ContributionsDomain["subscriptions"]
    | keyof ResourcesDomain["subscriptions"]
  >,
]);

/**
 * The provenance an `mcp-tool` invoke carries into the worker, copied field by
 * field. Whatever object the route hands over, only the public descriptor's
 * fields cross the port — an extra property picked up upstream (a grant, a
 * bearer) cannot ride along into plugin code.
 */
function projectMcpCaller(caller: PluginMcpCaller): PluginMcpCaller {
  return {
    credentialId: caller.credentialId,
    projectId: caller.projectId,
    terminalId: caller.terminalId,
    ...(caller.launchAgentIdHint !== undefined
      ? { launchAgentIdHint: caller.launchAgentIdHint }
      : {}),
  };
}

/** Request-id prefix of a `service-method` invoke; every other kind uses `i`. */
const SERVICE_INVOKE_PREFIX = "s";

/**
 * How many returned calls' callers a bridge remembers for the work they left
 * running. Work arriving after its call has dropped out is held to the lease
 * as a caller nobody knows, which drives nothing.
 */
const SETTLED_CALLERS_MAX = 1024;

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
  /**
   * Fires once when this worker breaks the protocol and the instance is
   * terminated (#12276). Distinct from `onActivationResult`, which only records
   * provenance: the owner also has to release the runtime state it holds — the
   * worker entry, the activation cache, and any prompt this plugin left on
   * screen — or the plugin is stuck dead with no path back.
   */
  onTerminalFailure?: () => void;
  /** The worker refused a push before sending it (size cap or clone failure). */
  onPushRejected?: () => void;
}

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** The frontend invocation this call runs for, re-entered for its host calls. */
  scope: PluginInvocationScope | null;
  /**
   * The service call this invoke runs inside (#14105), re-entered for its host
   * calls so a nested `services.call` carries the chain and deadline it is
   * part of — never one the worker could supply.
   */
  service: PluginServiceInvocation | null;
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

export class PluginDevWorkerMainBridge {
  private readonly pluginId: string;
  private readonly host: PluginHostApi;
  private readonly workerHost: PluginDevWorkerHost;
  private readonly getCapabilities: () => readonly string[];
  private readonly clearPriorRegistrations: () => void;
  private readonly onActivationResult?: (
    result: { ok: true } | { ok: false; error: string; stack?: string }
  ) => void;
  private readonly onTerminalFailure?: () => void;
  private readonly onPushRejected?: () => void;

  private disposed = false;
  /**
   * Latched once this worker generation has broken the protocol. Terminal: the
   * plugin instance is torn down, so it is never cleared.
   */
  private protocolViolated = false;
  private invokeSeq = 1;
  private readonly pendingInvokes = new Map<string, PendingInvoke>();
  /**
   * Who made each returned frontend call, oldest first, for work it started
   * that reaches the host afterwards; null for a call that belonged to nobody.
   */
  private readonly settledCallers = new Map<
    string,
    Pick<PluginInvocationScope["endpoint"], "endpointId" | "clientId"> | null
  >();

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
  private readonly workspace: WorkspaceDomain;
  private readonly data: DataDomain;
  private readonly contributions: ContributionsDomain;
  private readonly resources: ResourcesDomain;
  private readonly hostCallRoutes: ReadonlyMap<string, HostCallHandler>;
  private readonly hostNotifyRoutes: ReadonlyMap<string, HostNotifyHandler>;
  private readonly subscribeRoutes: ReadonlyMap<string, SubscribeHandler>;

  /**
   * Required registrations still awaiting main-side deep validation (#12282).
   * A `host-notify` carrying a `registrationKey` is a contribution the plugin
   * believes it made — the worker proxy already returned success to it — so the
   * activation commit waits on this set draining. Cleared when a generation is
   * retired and on dispose, with the rest of that generation's state.
   */
  private readonly pendingRegistrations = new Set<PendingRegistration>();
  private activationPhase: ActivationPhase = "activating";
  /**
   * True between retiring a generation and the respawned child's boot `ready`.
   *
   * The generation counter alone cannot attribute these: a message the outgoing
   * child posted before it died is delivered AFTER `reloadGeneration` was
   * bumped, so it reads as belonging to the incoming one. That is harmless for
   * a late `host-result` (the id is simply dropped) but not for an activation
   * outcome — a dying worker's `activate-error` would otherwise latch a failure
   * onto its replacement and veto the replacement's own success. `ready` is
   * posted by the new child at boot, so it is the first message that provably
   * belongs to the incoming generation.
   */
  private awaitingReplacement = false;

  /** First-activation gate. Resolved on `activated`, rejected on activate/crash
   * errors. A later generation's activation doesn't re-await this. */
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
    this.onTerminalFailure = deps.onTerminalFailure;
    this.onPushRejected = deps.onPushRejected;

    const context: DevWorkerBridgeContext = {
      pluginId: this.pluginId,
      host: this.host,
      isDisposed: () => this.disposed,
      generation: () => this.reloadGeneration,
      activationPhase: () => this.activationPhase,
      getCapabilities: () => this.getCapabilities(),
      send: (message) => this.workerHost.send(message),
      invoke: (target, signal) => this.invoke(target, signal),
      trackSubscription: (subscriptionId, dispose) => {
        this.subscriptionDisposers.set(subscriptionId, dispose);
      },
    };
    this.workspace = new WorkspaceDomain(context);
    this.data = new DataDomain(context);
    this.contributions = new ContributionsDomain(context);
    this.resources = new ResourcesDomain(context);
    this.hostCallRoutes = routesFrom<HostCallHandler>([
      this.workspace.hostCalls,
      this.data.hostCalls,
      this.resources.hostCalls,
    ]);
    this.hostNotifyRoutes = routesFrom<HostNotifyHandler>([
      this.workspace.notifications,
      this.contributions.notifications,
      this.resources.notifications,
      {
        pushRejected: async () => {
          if (this.disposed) return;
          this.onPushRejected?.();
        },
      },
    ]);
    this.subscribeRoutes = routesFrom<SubscribeHandler>([
      this.workspace.subscriptions,
      this.data.subscriptions,
      this.contributions.subscriptions,
      this.resources.subscriptions,
    ]);

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
    this.contributions.disposeProviders();
    this.resources.disposeProcessHandles();
    this.resources.disposeTaskHandles();
    this.abortAllHostCalls();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(new Error("Plugin dev worker bridge disposed"));
    }
    this.pendingInvokes.clear();
    this.settledCallers.clear();
    // Nothing can commit an activation after this point; drop the tracking so a
    // registration settling late can't resurrect the drain.
    this.pendingRegistrations.clear();
    this.activationPhase = "failed";
    this.rejectActivation(new Error(`Plugin dev worker "${this.pluginId}" disposed`));
    // Disposal drops the activate-time registrations too (#12275). Everything
    // else here is torn down by hand, but `clearPriorRegistrations` was reachable
    // only through retirement — so a disposed bridge still left its actions and
    // IPC handlers bound to a worker that no longer exists. Not routed through
    // `retireGeneration`: no replacement is coming, so this must not re-open the
    // activation phase or mark a successor awaited.
    // ...unless retirement already did it. `awaitingReplacement` means this
    // generation was retired, which clears them; clearing twice would double-fire
    // the owner's deregistration.
    if (!this.awaitingReplacement) {
      try {
        this.clearPriorRegistrations();
      } catch {
        // best-effort — teardown is already complete either way
      }
    }
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

  /** The crash-respawned child booted — everything from here belongs to it. */
  private onWorkerReady = (): void => {
    this.awaitingReplacement = false;
  };

  /**
   * Retire everything bound to the outgoing worker generation.
   *
   * Reached from an unexpected worker exit. A rebuild no longer routes through
   * here: it replaces the whole plugin, so this bridge is disposed outright
   * rather than carried across the boundary (#12277).
   *
   * Bumping `reloadGeneration` is the load-bearing part: request ids are a
   * per-worker counter that restarts at 1, so a result from the outgoing
   * generation settling late would otherwise be delivered to the incoming one
   * under a colliding id. Registrations, subscriptions, providers and spawned
   * processes go too — the replacement re-runs `activate()` and re-registers
   * from its own module realm, so anything left behind is a duplicate the new
   * generation cannot address.
   */
  /**
   * Retire this generation from outside (#12275).
   *
   * The owner's activation deadline blew, so no worker message is coming to do
   * it — the plugin is wedged mid-`activate()`, which is exactly when its
   * half-made registrations most need dropping.
   */
  retire(reason: string): void {
    if (this.disposed) return;
    this.retireGeneration(reason);
  }

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
    this.contributions.disposeProviders();
    this.resources.disposeProcessHandles();
    this.resources.disposeTaskHandles();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingInvokes.clear();
    this.settledCallers.clear();
  }

  /**
   * The worker process is gone (#12216).
   *
   * An INTENTIONAL exit is a dispose, and this bridge is disposed before the
   * host that owns the worker — so the handler has normally already returned
   * above. The branch below only settles a straggler admitted in the gap.
   *
   * A CRASH announces nothing. The host respawns a worker that has never seen
   * the outstanding request ids, so without this every in-flight invoke hangs
   * its caller forever, the crashed generation's subscriptions and providers
   * stay registered against a worker that cannot serve them, and a late
   * host-result can be delivered to the replacement under a colliding id. It
   * is a generation boundary like any other, so it gets the same teardown.
   *
   * Deliberately no wall-clock timeout on `invoke` itself. This bridge carries
   * actions, IPC handlers and decoration calls whose legitimate durations
   * differ by orders of magnitude — a plugin action that runs a build or a
   * clone is not hung — so a blanket deadline would break working plugins to
   * catch a case the caller can bound better. Callers that DO have a budget
   * already own one (`DECORATION_PROVIDER_TIMEOUT_MS` in ipc/handlers/plugin.ts,
   * and the per-channel `plugin:invoke` deadline the host wraps around every
   * registered handler, which reaches here as the invoke's signal).
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
    this.settledCallers.clear();
    // Nothing left to settle in the ordinary case; anything still here entered
    // during the gap before the process actually went away.
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
    if (this.protocolViolated) {
      // A first pass whose reporting threw must not leave the worker running.
      this.contain("worker dispose", () => this.workerHost.dispose());
      return;
    }
    if (this.disposed) return;
    this.protocolViolated = true;
    const error = `Plugin "${this.pluginId}" dev worker stopped: ${reason}`;
    // Every step is contained on its own and the teardown sits in a `finally`:
    // a throw anywhere in the reporting must not be what leaves the misbehaving
    // worker running — or, worse, escape into `uncaughtException` and cause the
    // very fatal recovery this whole path exists to prevent.
    try {
      this.contain("failure log", () => logger.error(`[${this.pluginId}] ${error}`));
      // Through the latch, not around it (#12282): a registration this
      // generation already rejected names the thing the author has to fix, and
      // this phrase is the vaguer of the two. Latching also stops a later
      // `activated` clearing the loadError.
      this.contain("activation failure report", () => this.failActivation(error));
      // Belt and braces on the gate itself: `failActivation` skips its own
      // rejection when the latch already held, and skips the rest if the
      // provenance listener throws. `rejectActivation` is idempotent, so a
      // second call is inert once the promise has settled.
      this.contain("activation rejection", () => this.rejectActivation(new Error(error)));
      this.contain("generation retire", () => this.retireGeneration(error));
      this.contain("bridge dispose", () => this.dispose());
    } finally {
      this.contain("worker dispose", () => this.workerHost.dispose());
      // Owner-level teardown last: it re-enters `dispose()` on both sides, which
      // is inert by now, and it is the step that lets the plugin be retried.
      this.contain("owner teardown", () => this.onTerminalFailure?.());
    }
  }

  /** Run one teardown step, absorbing (and best-effort logging) a throw. */
  private contain(what: string, step: () => void): void {
    try {
      step();
    } catch (err) {
      try {
        logger.error(`[${this.pluginId}] ${what} threw during protocol teardown`, err);
      } catch {
        // swallowed
      }
    }
  }

  /**
   * An exception from validating, reporting or dispatching a worker message.
   * The handlers below report their own operational failures, so reaching here
   * means the reporting itself broke — terminal, and it must not escape as an
   * uncaught exception or an unhandled rejection.
   */
  private failHandlerException(err: unknown): void {
    try {
      logger.error(`[${this.pluginId}] worker message handling threw`, err);
    } catch {
      // swallowed: the teardown below is what matters
    }
    this.failProtocolViolation("worker message handling failed");
  }

  private onWorkerMessage = (raw: unknown): void => {
    if (this.disposed || this.protocolViolated) return;
    // Second ingress point (#12276): `worker-message` is an ordinary emitter
    // event, not a runtime-typed channel, so validate here too rather than
    // trusting that every emitter upstream already did. Validation and its own
    // diagnostic log sit INSIDE the guard — a logger that throws must not be
    // what escapes this listener.
    try {
      const parsed = parseWorkerToHostMessage(raw);
      if (!parsed.ok) {
        logger.error(`[${this.pluginId}] worker message violates the protocol`, undefined, {
          issues: parsed.issues,
        });
        this.failProtocolViolation("worker sent a malformed message");
        return;
      }
      this.dispatchWorkerMessage(parsed.message);
    } catch (err) {
      this.failHandlerException(err);
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
        void this.handleHostCall(msg).catch((err) => this.failHandlerException(err));
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
        void this.handleHostNotify(msg, registration).catch((err) =>
          this.failHandlerException(err)
        );
        return;
      }
      case "subscribe":
        void this.handleSubscribe(msg).catch((err) => this.failHandlerException(err));
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
        this.rememberSettledCaller(msg.requestId, pending.scope);
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
      const result = await this.runAsInvocation(msg.invocationId, () =>
        this.dispatchHostCall(msg.method, msg.params, controller.signal)
      );
      if (this.disposed || generation !== this.reloadGeneration) return;
      this.workerHost.send({ type: "host-result", requestId: msg.requestId, ok: true, result });
    } catch (err) {
      if (this.disposed || generation !== this.reloadGeneration) return;
      const errorFields = serializableErrorFields(err);
      this.workerHost.send({
        type: "host-result",
        requestId: msg.requestId,
        ok: false,
        error: formatErrorMessage(err, "host call failed"),
        ...(errorFields && { errorFields }),
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

  /**
   * Run a worker message's work as the invocation it names. It answers the
   * invocation it was made for while that invocation is still outstanding;
   * once it has returned, only the drive lease still sees whose call it was
   * (`endedInvocation`). Resolved synchronously, before `fn` can await.
   */
  private runAsInvocation<T>(invocationId: string | undefined, fn: () => T): T {
    const pending = invocationId !== undefined ? this.pendingInvokes.get(invocationId) : undefined;
    const scope = pending?.scope ?? null;
    // A service method's call has ended once its invoke is gone; what its
    // work starts afterwards is refused rather than made as a fresh call.
    // Request ids never repeat on a bridge, so the prefix alone says so.
    const service =
      pending?.service ??
      (invocationId?.startsWith(SERVICE_INVOKE_PREFIX) ? ENDED_SERVICE_INVOCATION : null);
    const ended = pending === undefined ? this.endedInvocation(invocationId) : null;
    return runWithPluginInvocation(scope, () =>
      runWithEndedPluginInvocation(ended, () => runWithServiceInvocation(service, fn))
    );
  }

  private rememberSettledCaller(requestId: string, scope: PluginInvocationScope | null): void {
    if (requestId.startsWith(SERVICE_INVOKE_PREFIX)) return;
    this.settledCallers.set(
      requestId,
      scope && { endpointId: scope.endpoint.endpointId, clientId: scope.endpoint.clientId }
    );
    if (this.settledCallers.size > SETTLED_CALLERS_MAX) {
      const oldest = this.settledCallers.keys().next();
      if (!oldest.done) this.settledCallers.delete(oldest.value);
    }
  }

  /**
   * The returned frontend call a late host call names (#14251): its work still
   * answers to the drive lease as that call's caller. A call that belonged to
   * nobody stays nobody's, and an id this bridge can't place — cancelled,
   * dropped out of memory, or never issued — is held as a caller nobody knows.
   */
  private endedInvocation(invocationId: string | undefined): EndedPluginInvocation | null {
    if (invocationId === undefined || invocationId.startsWith(SERVICE_INVOKE_PREFIX)) return null;
    const caller = this.settledCallers.get(invocationId);
    if (caller === null) return null;
    return { pluginId: this.pluginId, caller: caller ?? null };
  }

  private dispatchHostCall(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const handler = this.hostCallRoutes.get(method);
    if (!handler) return Promise.reject(new Error(`Unknown host-call method "${method}"`));
    return handler(params, signal, method);
  }

  private async handleHostNotify(
    msg: Extract<PluginWorkerToHostMessage, { type: "host-notify" }>,
    registration?: PendingRegistration
  ): Promise<void> {
    // Captured before the await: a reload replaces the worker mid-validation,
    // and the outgoing generation's verdict must not land on the incoming one.
    const generation = this.reloadGeneration;
    try {
      // A notify made while handling a view's call is that call's work, as a
      // host call is: a process write it makes is held to the caller's lease.
      await this.runAsInvocation(msg.invocationId, () =>
        this.dispatchHostNotify(msg.method, msg.params)
      );
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
    const handler = this.hostNotifyRoutes.get(method);
    if (!handler) {
      logger.warn(`[${this.pluginId}] unknown host-notify method "${method}"`);
      return;
    }
    await handler(params, method);
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
      const subscribe = this.subscribeRoutes.get(kind);
      if (!subscribe) {
        logger.warn(`[${this.pluginId}] unknown subscription kind "${kind}"`);
        return;
      }
      const dispose = await subscribe(msg, push);
      if (!dispose) return;
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

  /**
   * Run a manifest-declared command's handler inside this plugin's worker
   * (#12274). The only invoke kind main initiates on its own rather than
   * against something the worker registered: the handler module is imported
   * lazily, worker-side, from `resolvedPath` — the absolute path
   * `PluginService.resolveCommandHandlerPath` already probed and containment-
   * checked. Public because `PluginService` is the caller; every other kind is
   * driven by the proxies `ContributionsDomain` registers on the host.
   */
  invokeCommand(namespacedId: string, resolvedPath: string, args: unknown): Promise<unknown> {
    // Only a generation that has COMMITTED activation can serve a command.
    // `workerHost.isReady()` alone is not that test: it is true the instant a
    // child exists, which after a crash means the replacement counts as ready
    // while it is still booting — before it has been sent `start`, so its proxy
    // does not exist yet and the worker drops the message on the floor. Nothing
    // ever answers, and an invoke has no timeout, so the caller would hang and
    // the phantom pending invoke would block idle disposal too. Every other
    // invoke kind is implicitly protected by re-registration (a retired
    // generation's handlers are unregistered, so main has nothing to call);
    // manifest commands are resolved from the plugin's manifest and survive
    // retirement, so they need the check made explicitly.
    if (this.activationPhase !== "succeeded") {
      return Promise.reject(
        new Error(`Plugin "${this.pluginId}" worker is not ready to run command "${namespacedId}"`)
      );
    }
    return this.invoke({ kind: "command", namespacedId, resolvedPath, args });
  }

  /**
   * Run a worker-held callback and settle with its `invoke-result`.
   *
   * `signal` is the caller's own budget — this method still has no timeout of
   * its own (see {@link onWorkerExit}). Aborting settles the caller at once with
   * the signal's reason, drops the pending entry so a late `invoke-result` finds
   * nothing to deliver to, and posts `invoke-cancel` so the worker can abort the
   * signal it handed the plugin. Request ids come from a per-bridge counter that
   * never restarts, so a cancelled id is never reused by a later invoke.
   */
  private invoke(target: InvokeTarget, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed || !this.workerHost.isReady()) {
      return Promise.reject(new Error(`Plugin "${this.pluginId}" dev worker is not running`));
    }
    if (signal?.aborted) return Promise.reject(abortErrorFor(signal));
    const requestId = `${target.kind === "service-method" ? SERVICE_INVOKE_PREFIX : "i"}${this.invokeSeq++}`;
    // Only this plugin's own invocation: another plugin's call that reached
    // this one (an action it dispatched) is not this plugin's caller.
    const current = currentPluginInvocation();
    const scope = current?.pluginId === this.pluginId ? current : null;
    const service = currentServiceInvocation();
    return new Promise<unknown>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const detach = (): void => {
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      };
      this.pendingInvokes.set(requestId, {
        resolve: (value) => {
          detach();
          resolve(value);
        },
        reject: (error) => {
          detach();
          reject(error);
        },
        scope,
        service,
      });
      if (signal) {
        onAbort = (): void => {
          // Only while still pending: a result, crash or dispose that already
          // claimed the entry has settled the caller, and the worker has nothing
          // left to cancel.
          if (!this.pendingInvokes.delete(requestId)) return;
          detach();
          this.workerHost.send({ type: "invoke-cancel", requestId });
          reject(abortErrorFor(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      let sent: boolean;
      if (target.kind === "mcp-tool") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "mcp-tool",
          endpointId: target.endpointId,
          toolName: target.toolName,
          args: target.args,
          caller: projectMcpCaller(target.caller),
        });
      } else if (target.kind === "action") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "action",
          namespacedId: target.namespacedId,
          args: target.args,
        });
      } else if (target.kind === "command") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "command",
          namespacedId: target.namespacedId,
          resolvedPath: target.resolvedPath,
          args: target.args,
        });
      } else if (target.kind === "search-provider") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "search-provider",
          providerId: target.providerId,
          query: target.query,
          context: target.context,
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
      } else if (target.kind === "worktree-setup-step") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "worktree-setup-step",
          stepId: target.stepId,
          context: target.context,
        });
      } else if (target.kind === "context-provider-method") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "context-provider-method",
          providerId: target.providerId,
          method: target.method,
          args: target.args,
        });
      } else if (target.kind === "service-method") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "service-method",
          serviceName: target.serviceName,
          method: target.method,
          args: target.args,
          // Field by field, so nothing beyond the public shape crosses the port.
          caller: { pluginId: target.caller.pluginId, projectId: target.caller.projectId },
        });
      } else if (target.kind === "worktree-delete-notes") {
        sent = this.workerHost.send({
          type: "invoke",
          requestId,
          kind: "worktree-delete-notes",
          providerId: target.providerId,
          worktree: target.worktree,
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
        detach();
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
