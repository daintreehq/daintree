/**
 * PtyShard - One host shard of the PTY fabric: a single UtilityProcess run of
 * the pty-host plus everything scoped to it on the main-process side.
 *
 * A shard owns exactly what used to live 1:1 inside PtyClient for the
 * singleton host: the {@link PtyHostLifecycle} (fork/exit/restart/backoff),
 * the {@link PtyHealthWatchdog} (heartbeat + force-kill), a
 * {@link RequestResponseBroker} (so a crashing shard rejects only ITS pending
 * requests, never a sibling's), the pending MessagePorts awaiting a live
 * child, and the respawn/resync flags consumed on `ready`.
 *
 * PtyClient is the router above this: it decides which shard a terminal,
 * project, or window port belongs to and holds all cross-shard state
 * (placement, terminal ownership, aggregation). The shard itself is
 * deliberately dumb — construction wiring plus lifecycle passthroughs — so
 * the routing policy stays in one place.
 */

import type { MessagePortMain } from "electron";
import type {
  CrashType,
  HostCrashPayload,
  PtyHostEvent,
  PtyHostRequest,
} from "../../../shared/types/pty-host.js";
import { RequestResponseBroker } from "../rpc/index.js";
import { PtyHealthWatchdog } from "./PtyHealthWatchdog.js";
import { PtyHostLifecycle } from "./PtyHostLifecycle.js";

export interface PtyShardConfig {
  /** Stable shard key: "main" for the default shard, the projectId otherwise. */
  key: string;
  /** UtilityProcess serviceName (see fabricConfig.shardServiceName). */
  serviceName: string;
  /** V8 --max-old-space-size for this shard's host process. */
  memoryLimitMb: number;
  electronDir: string;
  healthCheckIntervalMs: number;
  maxMissedHeartbeats: number;
  /** Read at each fork; see PtyHostLifecycleConfig.deferInitialPoolWarm. */
  deferInitialPoolWarm: () => boolean;
  /**
   * Project shards start with a pending context resync: their first messages
   * (project context, config) can be posted between fork and `ready`, where
   * the child's listener isn't attached yet, so the ready handler must replay
   * window contexts. The default shard keeps the legacy flag lifecycle
   * (set on exit / on a context send that finds no child).
   */
  resyncContextOnFirstReady: boolean;
}

export interface PtyShardCallbacks {
  onMessage: (shard: PtyShard, event: PtyHostEvent) => void;
  onExitSync: (
    shard: PtyShard,
    info: { code: number | null; wasReady: boolean; fallbackCrashType: CrashType }
  ) => void;
  onCrashClassified: (
    shard: PtyShard,
    info: {
      reportedCode: number | null;
      crashType: CrashType;
      signal: string | null;
      payload: HostCrashPayload | null;
    }
  ) => void;
  onMaxRestartsReached: (shard: PtyShard, code: number | null) => void;
  onForkFailed: (shard: PtyShard, error: unknown) => void;
  emitCrashDetails: (shard: PtyShard, payload: HostCrashPayload) => void;
  onBrokerTimeout: (shard: PtyShard, requestId: string, method?: string) => void;
  /** Whether the owning PtyClient has been disposed. */
  isClientDisposed: () => boolean;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
}

export class PtyShard {
  readonly key: string;
  readonly serviceName: string;
  readonly lifecycle: PtyHostLifecycle;
  readonly watchdog: PtyHealthWatchdog;
  readonly broker: RequestResponseBroker;

  /** Set by onBeforeRestart; consumed by the ready handler to replay this shard's spawns. */
  needsRespawn = false;
  /** Pending window-context resync, consumed on ready. See PtyShardConfig. */
  shouldResyncProjectContext: boolean;
  /** True once start() has forked (or requested) this shard's host. */
  started = false;
  /**
   * True once the shard has been removed from the fabric (idle retirement,
   * crash-loop migration, or client dispose). A retired shard's lifecycle
   * callbacks all no-op via isDisposed, so late exit/gone events can't
   * schedule restarts or mutate fabric state.
   */
  retired = false;
  /** MessagePorts awaiting a live child, keyed by windowId. */
  readonly pendingMessagePorts = new Map<number, MessagePortMain>();

  constructor(config: PtyShardConfig, callbacks: PtyShardCallbacks) {
    this.key = config.key;
    this.serviceName = config.serviceName;
    this.shouldResyncProjectContext = config.resyncContextOnFirstReady;

    this.broker = new RequestResponseBroker({
      defaultTimeoutMs: 5000,
      idPrefix: "pty",
      onTimeout: (requestId, method) => callbacks.onBrokerTimeout(this, requestId, method),
    });

    this.watchdog = new PtyHealthWatchdog({
      intervalMs: config.healthCheckIntervalMs,
      maxMissedHeartbeats: config.maxMissedHeartbeats,
      getChild: () => this.lifecycle.child,
      isHostInitialized: () => this.lifecycle.isInitialized,
      send: (request) => this.send(request),
      emitCrashDetails: (payload) => callbacks.emitCrashDetails(this, payload),
    });

    this.lifecycle = new PtyHostLifecycle(
      {
        memoryLimitMb: config.memoryLimitMb,
        electronDir: config.electronDir,
        serviceName: config.serviceName,
        deferInitialPoolWarm: config.deferInitialPoolWarm,
      },
      {
        onMessage: (event) => callbacks.onMessage(this, event),
        onExitSync: (info) => callbacks.onExitSync(this, info),
        onCrashClassified: (info) => callbacks.onCrashClassified(this, info),
        onMaxRestartsReached: (code) => callbacks.onMaxRestartsReached(this, code),
        onForkFailed: (error) => callbacks.onForkFailed(this, error),
        onBeforeRestart: () => {
          this.needsRespawn = true;
        },
        isDisposed: () => this.retired || callbacks.isClientDisposed(),
        logInfo: callbacks.logInfo,
        logWarn: callbacks.logWarn,
      }
    );
  }

  /** Fork this shard's host. Idempotent per shard (mirrors PtyClient.start's guard). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.lifecycle.start();
  }

  send(request: PtyHostRequest): void {
    this.lifecycle.postMessage(request);
  }

  isRunning(): boolean {
    return this.lifecycle.isRunning();
  }

  waitForReady(): Promise<void> {
    return this.lifecycle.waitForReady();
  }

  closePendingPorts(): void {
    for (const port of this.pendingMessagePorts.values()) {
      try {
        port.close();
      } catch {
        // ignore
      }
    }
    this.pendingMessagePorts.clear();
  }

  /**
   * Tear the shard down: watchdog first (no force-kill races the dispose),
   * then the lifecycle (posts `dispose` to the host, force-kills after 1s),
   * pending ports, and the broker (rejects this shard's pending requests).
   */
  dispose(): void {
    this.retired = true;
    this.watchdog.dispose();
    this.lifecycle.dispose();
    this.closePendingPorts();
    this.broker.dispose();
  }
}
