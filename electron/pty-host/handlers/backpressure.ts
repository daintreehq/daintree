import { selectShard } from "../../../shared/utils/shardSelection.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createBackpressureHandlers(ctx: HostContext): HandlerMap {
  const {
    ptyManager,
    backpressureManager,
    ipcQueueManager,
    sendEvent,
    getPauseCoordinator,
    getOrCreatePauseCoordinator,
    tryReplayAndResume,
    resumePausedTerminal,
  } = ctx;

  return {
    "acknowledge-data": (msg) => {
      const acknowledgedBytes = msg.byteCount ?? 0;
      ipcQueueManager.removeBytes(msg.id, acknowledgedBytes);
      ipcQueueManager.tryResume(msg.id);

      // SAB ack-driven resume: try replaying pending segments or just resume if none left
      if (backpressureManager.isPaused(msg.id)) {
        if (backpressureManager.hasPendingSegments(msg.id)) {
          tryReplayAndResume(msg.id);
        } else {
          resumePausedTerminal(msg.id);
        }
      }

      ptyManager.acknowledgeData(msg.id, acknowledgedBytes);
    },

    "set-activity-tier": (msg) => {
      const tier = msg.tier === "background" ? "background" : "active";
      backpressureManager.setActivityTier(msg.id, tier, "set-activity-tier");

      // Clear any stall suspension and unblock the PTY
      backpressureManager.clearSuspended(msg.id);
      backpressureManager.clearPendingVisual(msg.id);

      const checkInterval = backpressureManager.getPausedInterval(msg.id);
      const wasPaused = checkInterval !== undefined;
      if (checkInterval) {
        clearTimeout(checkInterval);
        backpressureManager.deletePausedInterval(msg.id);
      }

      const pauseStart = backpressureManager.getPauseStartTime(msg.id);
      const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
      backpressureManager.deletePauseStartTime(msg.id);

      // Release backpressure hold (respects other holds like resource-governor or system-sleep)
      const atCoordinator = getPauseCoordinator(msg.id);
      atCoordinator?.resume("backpressure");

      // EXPERIMENT (hibernation teardown step 1 — #10807): do NOT clear the
      // port/IPC queues when a terminal is marked "background". The host
      // producer gate now streams unconditionally (pty-host.ts), so background
      // panes keep receiving live bytes; clearing the queues here would drop
      // genuinely in-flight bytes on the live path. The renderer is unchanged in
      // this step and may still send a "background" tier — ignore its
      // queue-clearing side effect. The suspended/pending-visual clears and the
      // backpressure coordinator resume above still run, and IPC watermarks /
      // hard caps / data-loss accounting are untouched. See
      // docs/HIBERNATION-REMOVAL-EXPERIMENT.md.
      //
      // Disabled for the experiment — was:
      //   if (tier === "background") {
      //     ipcQueueManager.clearQueue(msg.id);
      //     for (const conn of ctx.rendererConnections.values()) {
      //       conn.portQueueManager.clearQueue(msg.id);
      //     }
      //   }

      const terminal = ptyManager.getTerminal(msg.id);
      if (terminal) {
        // Tier-driven ActivityMonitor polling. The renderer-supplied hint
        // (issue #8596 — 200ms for VISIBLE-unfocused panes) takes precedence
        // when present and finite; otherwise fall back to the binary tier
        // default (50ms active, 500ms background).
        const hintedInterval = msg.pollingIntervalMs;
        const pollingInterval =
          typeof hintedInterval === "number" &&
          Number.isFinite(hintedInterval) &&
          hintedInterval > 0
            ? hintedInterval
            : tier === "active"
              ? 50
              : 500;
        ptyManager.setActivityMonitorTier(msg.id, tier, pollingInterval);
      }

      if (!atCoordinator?.isPaused) {
        backpressureManager.emitTerminalStatus(msg.id, "running");
      }

      // Emit metrics for pause-end (set-activity-tier unpause path)
      if (wasPaused && pauseDuration !== undefined) {
        backpressureManager.emitReliabilityMetric({
          terminalId: msg.id,
          metricType: "pause-end",
          timestamp: Date.now(),
          durationMs: pauseDuration,
        });
      }
    },

    "force-resume": (msg) => {
      const coordinator = getPauseCoordinator(msg.id);
      if (!coordinator) {
        console.warn(`[PtyHost] Cannot force resume - terminal ${msg.id} not found`);
        return;
      }
      coordinator.forceReleaseAll();
      backpressureManager.stats.forceResumeCount++;
      console.log(`[PtyHost] Force resumed PTY ${msg.id} via user request`);

      // Clean up any pending backpressure monitoring
      const checkInterval = backpressureManager.getPausedInterval(msg.id);
      if (checkInterval) {
        clearTimeout(checkInterval);
        backpressureManager.deletePausedInterval(msg.id);
      }
      backpressureManager.clearPendingVisual(msg.id);

      // Clear suspended flag to allow output to flow again
      backpressureManager.clearSuspended(msg.id);

      // Also clear IPC queue backpressure state
      ipcQueueManager.clearQueue(msg.id);

      // Drain every per-window port queue manager so stale pause maps and
      // queuedBytes don't leak across the disconnectWindow lifecycle that
      // force-resume bypasses (#7008). clearQueue is a no-op when the
      // terminal isn't tracked by that manager.
      for (const conn of ctx.rendererConnections.values()) {
        conn.portQueueManager.clearQueue(msg.id);
      }

      // Compute resume status with the actual held duration from the visual
      // buffer (SAB path) when available. The wire `pause-end` metric gets
      // its `durationMs` from the canonical funnel's closure map (the
      // multi-source-of-truth path) — see `emitReliabilityMetricWithTracking`.
      // We intentionally do NOT read from `backpressureManager.getPauseStartTime()`
      // (SAB-only, dead in production) for the metric; the funnel does that
      // work and clears all sources for this terminal atomically.
      const buffers = ctx.visualBuffers;
      const utilization =
        buffers.length > 0
          ? buffers[selectShard(msg.id, buffers.length)].getUtilization()
          : undefined;
      backpressureManager.emitTerminalStatus(msg.id, "running", utilization);

      // Emit the user force-resume's `pause-end` via the canonical funnel
      // (null source). The funnel populates `durationMs` from the closure
      // `pausedTerminals` map (or skips it when the terminal had no recorded
      // pause) and clears the map. This routes the wire event through the
      // load-bearing split so it always reaches the renderer in production
      // (issue #9898: the previous `backpressureManager.emitReliabilityMetric`
      // path was gated by `metricsEnabled()` and never fired).
      backpressureManager.emitReliabilityMetric({
        terminalId: msg.id,
        metricType: "pause-end",
        timestamp: Date.now(),
        bufferUtilization: utilization,
      });
    },

    "pause-all": () => {
      console.log("[PtyHost] Pausing all PTY processes for system sleep");
      const terminals = ptyManager.getAll();
      let pausedCount = 0;

      for (const terminal of terminals) {
        const coordinator = getOrCreatePauseCoordinator(terminal.id);
        if (coordinator) {
          coordinator.pause("system-sleep");
          pausedCount++;
        }
      }

      console.log(`[PtyHost] Paused ${pausedCount}/${terminals.length} PTY processes`);
    },

    "resume-all": () => {
      console.log("[PtyHost] Resuming all PTY processes after system wake");
      const terminals = ptyManager.getAll();

      if (terminals.length === 0) {
        console.log("[PtyHost] No PTY processes to resume");
        return;
      }

      // Resume incrementally to prevent thundering herd
      // Stagger by 50ms to spread disk/CPU load
      const RESUME_STAGGER_MS = 50;
      let i = 0;

      const resumeInterval = setInterval(() => {
        if (i >= terminals.length) {
          clearInterval(resumeInterval);
          console.log(`[PtyHost] Resumed all ${terminals.length} PTY processes`);
          return;
        }

        const terminal = terminals[i++];
        getPauseCoordinator(terminal.id)?.resume("system-sleep");
      }, RESUME_STAGGER_MS);
    },

    "health-check": () => {
      sendEvent({ type: "pong" });
    },
  };
}
