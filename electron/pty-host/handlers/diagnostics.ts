import type {
  FlowControlQueueEntry,
  FlowControlSnapshot,
  FlowControlTerminalSnapshot,
  PtyHostWorkerGovernanceSnapshot,
} from "../../../shared/types/pty-host.js";
import { getEventLoopStats } from "../eventLoopMonitor.js";
import type { HandlerMap, HostContext } from "./types.js";

/**
 * On-demand diagnostic pulls assembled from live pty-host state. Unlike the
 * periodic reliability-metric push, these read the always-populated flow-control
 * maps directly and are NOT gated by `metricsEnabled()` — a support bundle must
 * be able to capture flow-control state regardless of the streaming-metrics flag.
 */
export function createDiagnosticsHandlers(ctx: HostContext): HandlerMap {
  const {
    backpressureManager,
    ipcQueueManager,
    resourceGovernor,
    pauseCoordinators,
    rendererConnections,
    getPauseCoordinator,
    getPausedDurationsSnapshot,
    getDropTallySnapshot,
    sendEvent,
  } = ctx;

  return {
    "get-flow-control-snapshot": (msg) => {
      const now = Date.now();

      // Authoritative held durations across SAB + live IPC/port pause sources.
      // `backpressureManager.pauseStartTimes` only tracks the dead SAB path, so
      // we read the cross-source snapshot instead — otherwise an IPC/port-paused
      // terminal would report null even after being wedged for minutes.
      const heldDurationById = new Map<string, number>();
      for (const { terminalId, heldDurationMs } of getPausedDurationsSnapshot()) {
        heldDurationById.set(terminalId, heldDurationMs);
      }

      // Per-terminal drop attribution: which terminals have had bytes
      // intentionally dropped (saturated port, IPC cap, disconnected batcher)
      // and how much. This is the "missing output" half of "why is this
      // terminal slow?" — pause state alone can't explain a scrollback gap.
      const dropTallyById = new Map<
        string,
        { droppedBytes: number; dropCount: number; lastDropAt: number }
      >();
      for (const { terminalId, ...tally } of getDropTallySnapshot()) {
        dropTallyById.set(terminalId, tally);
      }

      // Union every terminal id known to any flow-control map so a terminal
      // that is paused/suspended/held but has no recorded status still appears.
      const ids = new Set<string>();
      for (const id of backpressureManager.terminalStatusesMap.keys()) ids.add(id);
      for (const id of backpressureManager.suspendedSet) ids.add(id);
      for (const id of heldDurationById.keys()) ids.add(id);
      for (const id of pauseCoordinators.keys()) ids.add(id);
      for (const id of dropTallyById.keys()) ids.add(id);

      const terminals: FlowControlTerminalSnapshot[] = [];
      for (const id of ids) {
        const dropTally = dropTallyById.get(id);
        terminals.push({
          terminalId: id,
          flowStatus: backpressureManager.terminalStatusesMap.get(id) ?? null,
          heldTokens: Array.from(getPauseCoordinator(id)?.heldTokens ?? []).sort(),
          isSuspended: backpressureManager.isSuspended(id),
          activityTier: backpressureManager.getActivityTier(id),
          pausedDurationMs: heldDurationById.get(id) ?? null,
          droppedBytes: dropTally?.droppedBytes ?? 0,
          dropCount: dropTally?.dropCount ?? 0,
          lastDropAt: dropTally?.lastDropAt ?? null,
        });
      }
      terminals.sort((a, b) => a.terminalId.localeCompare(b.terminalId));

      // Live IPC + per-window MessagePort queue depths. The FUTURE_SAB path is
      // dead in production and excluded here to match the streaming
      // queue-depth gauge, keeping dead-code and live paths independently
      // observable. totalPendingBytes sums the same live paths.
      const queueDepth: FlowControlQueueEntry[] = [];
      let totalPendingBytes = 0;
      const ipc = ipcQueueManager.getQueueSnapshot();
      totalPendingBytes += ipc.totalPendingBytes;
      for (const { terminalId, pendingBytes } of ipc.perTerminal) {
        if (pendingBytes > 0) queueDepth.push({ terminalId, layer: "ipc", pendingBytes });
      }
      for (const conn of rendererConnections.values()) {
        // Isolate per-connection failures: a disposed/racing port queue manager
        // must not abort the whole snapshot, which would surface to the main
        // side as a 5s broker timeout returning an empty (no-pressure-looking)
        // fallback rather than the partial data we did gather.
        try {
          const port = conn.portQueueManager.getQueueSnapshot();
          totalPendingBytes += port.totalPendingBytes;
          for (const { terminalId, pendingBytes } of port.perTerminal) {
            if (pendingBytes > 0) queueDepth.push({ terminalId, layer: "port", pendingBytes });
          }
        } catch {
          // Skip this connection's contribution; the rest of the snapshot stands.
        }
      }

      const snapshot: FlowControlSnapshot = {
        timestamp: now,
        terminals,
        queueDepth,
        totalPendingBytes,
        // Spread-copy so later mutations don't bleed into the diagnostics object.
        stats: { ...backpressureManager.stats },
        resourceGovernor: resourceGovernor.getSnapshot(),
        eventLoop: getEventLoopStats(),
      };

      sendEvent({ type: "flow-control-snapshot", requestId: msg.requestId, snapshot });
    },

    // Per-slot analysis worker pool state plus this host process's memory —
    // worker_threads share the host process, so the host-level usage IS the
    // pool's memory story. Consumed by main's WorkerGovernanceService for the
    // diagnostics export; like the flow-control pull, never gated on the
    // streaming-metrics flag.
    "get-worker-governance-snapshot": (msg) => {
      const memory = process.memoryUsage();
      const snapshot: PtyHostWorkerGovernanceSnapshot = {
        timestamp: Date.now(),
        workers: ctx.analysisWorkerPool?.getGovernanceSnapshots() ?? [],
        hostMemory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external ?? 0,
        },
      };
      sendEvent({ type: "worker-governance-snapshot", requestId: msg.requestId, snapshot });
    },
  };
}
