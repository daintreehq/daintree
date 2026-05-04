/**
 * PtyEventRouter - Pure-function router for transport-level PTY host events.
 *
 * Mirrors the {@link bridgePtyEvent} pattern: the caller delegates first to the
 * domain-event bridge; if that returns false, this router handles request/response
 * correlation (broker resolves), transport events (`data` / `exit` / `error`),
 * the ready/pong lifecycle, and the small set of unsolicited push events
 * (`spawn-result`, `terminal-pid`, `resource-metrics`, `broadcast-write-result`).
 *
 * State stays in {@link PtyClient}; the router takes shared maps by reference
 * (so the `exit` case mutates the same `pendingSpawns`/`pendingKillCount`/
 * `terminalPids` that `spawn()`/`kill()` read) and reaches everything else
 * through callbacks. The disposed check is delegated via {@link PtyEventRouterDeps.isDisposed}
 * so the router never owns lifecycle state.
 *
 * The `event as any` casts that used to live in `PtyClient.handleHostEvent` are
 * gone here: every broker case narrows via the discriminated union, and the
 * shared {@link isPtyHostResponseEvent} predicate is available for exhaustive
 * switches on `requestId`-bearing events.
 */

import type { EventEmitter } from "events";
import type {
  BroadcastWriteResultPayload,
  PtyHostEvent,
  PtyHostSpawnOptions,
  SpawnResult,
  TerminalResourceBatchPayload,
  TerminalStatusPayload,
} from "../../../shared/types/pty-host.js";
import type { TerminalSnapshot } from "../PtyManager.js";
import { bridgePtyEvent } from "./PtyEventsBridge.js";

/** Minimal broker contract — matches RequestResponseBroker's public surface. */
export interface PtyEventRouterBroker {
  resolve<T>(requestId: string, result: T): boolean;
}

/** Maps shared by reference between PtyClient and the router. */
export interface PtyEventRouterState {
  pendingSpawns: Map<string, PtyHostSpawnOptions>;
  pendingKillCount: Map<string, number>;
  terminalPids: Map<string, number>;
}

/** Callbacks invoked by the router for side effects that span multiple concerns. */
export interface PtyEventRouterCallbacks {
  /**
   * Invoked when the host emits `ready`. Concrete consumer is PtyClient, which
   * resolves its readyPromise, replays log-level overrides, runs respawn /
   * port-flush / project-resync, etc. Returning the set of pending port windowIds
   * lets the router skip them in the project resync (matches the previous
   * inline behavior).
   */
  onReady: () => void;
  /** Invoked on every `pong` so the watchdog can reset its missed-heartbeat counter. */
  onPong: () => void;
  /** Invoked when the host removes a trashed terminal (delegated to the tracker). */
  onTerminalRemovedFromTrash: (id: string) => void;
}

export interface PtyEventRouterDeps {
  isDisposed: () => boolean;
  broker: PtyEventRouterBroker;
  emitter: EventEmitter;
  state: PtyEventRouterState;
  callbacks: PtyEventRouterCallbacks;
  /** Logger for warnings — keeps the router free of console.* coupling. */
  logWarn: (message: string) => void;
}

/**
 * Route one host event. Returns true if the event was handled (either by the
 * domain bridge or this router); false for unknown event types so the caller
 * can decide whether to log.
 */
export function routeHostEvent(event: PtyHostEvent, deps: PtyEventRouterDeps): boolean {
  if (deps.isDisposed()) {
    return true;
  }

  const bridged = bridgePtyEvent(event, {
    onTerminalStatus: (payload) => {
      const statusPayload: TerminalStatusPayload = {
        id: payload.id,
        status: payload.status,
        bufferUtilization: payload.bufferUtilization,
        pauseDuration: payload.pauseDuration,
        reason: payload.reason,
        timestamp: payload.timestamp,
      };
      deps.emitter.emit("terminal-status", statusPayload);
    },
    onHostThrottled: (payload) => {
      deps.emitter.emit("host-throttled", payload);
    },
  });

  if (bridged) {
    return true;
  }

  const { broker, emitter, state, callbacks } = deps;

  switch (event.type) {
    case "ready": {
      callbacks.onReady();
      return true;
    }

    case "data":
      emitter.emit("data", event.id, event.data);
      return true;

    case "exit": {
      callbacks.onTerminalRemovedFromTrash(event.id);
      const killCount = state.pendingKillCount.get(event.id) ?? 0;
      if (killCount > 0) {
        // Exit from a kill() call — a new spawn() may have already
        // re-registered this id; don't clear pendingSpawns.
        const remaining = killCount - 1;
        if (remaining > 0) {
          state.pendingKillCount.set(event.id, remaining);
        } else {
          state.pendingKillCount.delete(event.id);
        }
      } else {
        // Normal exit (process ended on its own)
        state.pendingSpawns.delete(event.id);
      }
      state.terminalPids.delete(event.id);
      emitter.emit("exit", event.id, event.exitCode);
      return true;
    }

    case "error":
      emitter.emit("error", event.id, event.error);
      return true;

    case "snapshot":
      broker.resolve<TerminalSnapshot | null>(event.requestId, event.snapshot ?? null);
      return true;

    case "all-snapshots":
      broker.resolve<TerminalSnapshot[]>(event.requestId, event.snapshots ?? []);
      return true;

    case "transition-result":
      broker.resolve(event.requestId, event.success);
      return true;

    case "pong":
      callbacks.onPong();
      return true;

    case "terminals-for-project":
      broker.resolve(event.requestId, event.terminalIds ?? []);
      return true;

    case "terminal-info":
      broker.resolve(event.requestId, event.terminal ?? null);
      return true;

    case "replay-history-result":
      broker.resolve(event.requestId, event.replayed ?? 0);
      return true;

    case "available-terminals":
      broker.resolve(event.requestId, event.terminals ?? []);
      return true;

    case "terminals-by-state":
      broker.resolve(event.requestId, event.terminals ?? []);
      return true;

    case "all-terminals":
      broker.resolve(event.requestId, event.terminals ?? []);
      return true;

    case "semantic-search-result":
      broker.resolve(event.requestId, event.matches ?? []);
      return true;

    case "serialized-state":
      broker.resolve(event.requestId, event.state ?? null);
      return true;

    case "wake-result":
      broker.resolve(event.requestId, {
        state: event.state ?? null,
        warnings: event.warnings,
      });
      return true;

    case "kill-by-project-result":
      broker.resolve(event.requestId, event.killed ?? 0);
      return true;

    case "graceful-kill-result":
      broker.resolve(event.requestId, event.agentSessionId ?? null);
      return true;

    case "graceful-kill-by-project-result":
      broker.resolve(event.requestId, event.results ?? []);
      return true;

    case "project-stats":
      // Fallback shape preserves the legacy `terminalTypes` key — the
      // PtyClient public type signature still uses it, even though the host
      // actually sends `detectedAgents` on the stats payload. Don't tighten
      // this in a pure refactor.
      broker.resolve(
        event.requestId,
        event.stats ?? { terminalCount: 0, processIds: [], terminalTypes: {} }
      );
      return true;

    case "terminal-diagnostic-info":
      broker.resolve(event.requestId, event.info);
      return true;

    case "terminal-pid":
      state.terminalPids.set(event.id, event.pid);
      return true;

    case "spawn-result": {
      const spawnResultEvent: { id: string; result: SpawnResult } = event;
      if (!spawnResultEvent.result.success) {
        // Remove from pending spawns since spawn failed
        state.pendingSpawns.delete(spawnResultEvent.id);
      }
      emitter.emit("spawn-result", spawnResultEvent.id, spawnResultEvent.result);
      return true;
    }

    case "resource-metrics": {
      const rmEvent: { metrics: TerminalResourceBatchPayload; timestamp: number } = event;
      emitter.emit("resource-metrics", rmEvent.metrics, rmEvent.timestamp);
      return true;
    }

    case "broadcast-write-result": {
      const brEvent: BroadcastWriteResultPayload = event;
      emitter.emit("broadcast-write-result", { results: brEvent.results });
      return true;
    }

    default: {
      const unknownType = (event as { type: string }).type;
      deps.logWarn(`[PtyClient] Unknown event type: ${unknownType}`);
      return false;
    }
  }
}
