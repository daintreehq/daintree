import { selectShard } from "../../../shared/utils/shardSelection.js";
import { metricsEnabled } from "../index.js";
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
      const acknowledgedBytes = msg.charCount ?? 0;
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
      backpressureManager.setActivityTier(msg.id, tier);

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

      const terminal = ptyManager.getTerminal(msg.id);
      if (terminal) {
        // Apply tier-driven ActivityMonitor polling: 50ms active, 500ms background
        const pollingInterval = tier === "active" ? 50 : 500;
        ptyManager.setActivityMonitorTier(msg.id, pollingInterval);
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

    "wake-terminal": async (msg) => {
      const wakeStartTime = Date.now();

      // Wake implies we want a faithful snapshot + resume streaming.
      backpressureManager.setActivityTier(msg.id, "active");
      backpressureManager.clearSuspended(msg.id);
      backpressureManager.clearPendingVisual(msg.id);

      // Clear any active pause interval and timing, and resume the PTY
      const checkInterval = backpressureManager.getPausedInterval(msg.id);
      const wasPaused = checkInterval !== undefined;
      if (checkInterval) {
        clearTimeout(checkInterval);
        backpressureManager.deletePausedInterval(msg.id);
      }
      backpressureManager.deletePauseStartTime(msg.id);

      // Release backpressure hold via coordinator (respects other holds)
      const wakeCoordinator = getPauseCoordinator(msg.id);
      if (wasPaused) {
        wakeCoordinator?.resume("backpressure");
      }

      // Apply active tier polling (50ms) when waking
      const terminal = ptyManager.getTerminal(msg.id);
      if (terminal) {
        ptyManager.setActivityMonitorTier(msg.id, 50);
      }

      // Best-effort warning: cwd missing
      const warnings: string[] = [];
      try {
        const t = ptyManager.getTerminal(msg.id);
        if (t?.cwd && typeof t.cwd === "string") {
          const fs = await import("node:fs");
          if (!fs.existsSync(t.cwd)) {
            warnings.push("cwd-missing");
          }
        }
      } catch {
        // ignore
      }

      let state: string | null = null;
      try {
        state = await ptyManager.getSerializedStateAsync(msg.id);
      } catch {
        state = ptyManager.getSerializedState(msg.id);
      }

      const wakeLatencyMs = Date.now() - wakeStartTime;

      if (!wakeCoordinator?.isPaused) {
        backpressureManager.emitTerminalStatus(msg.id, "running");
      }

      // Emit wake latency metrics (only if enabled to avoid overhead)
      if (metricsEnabled() && state) {
        const { Buffer } = await import("node:buffer");
        const serializedStateBytes = Buffer.byteLength(state, "utf8");
        backpressureManager.emitReliabilityMetric({
          terminalId: msg.id,
          metricType: "wake-latency",
          timestamp: Date.now(),
          wakeLatencyMs,
          serializedStateBytes,
        });
      }

      sendEvent({
        type: "wake-result",
        requestId: msg.requestId,
        id: msg.id,
        state,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    },

    "force-resume": (msg) => {
      const coordinator = getPauseCoordinator(msg.id);
      if (!coordinator) {
        console.warn(`[PtyHost] Cannot force resume - terminal ${msg.id} not found`);
        return;
      }
      coordinator.forceReleaseAll();
      console.log(`[PtyHost] Force resumed PTY ${msg.id} via user request`);

      // Clean up any pending backpressure monitoring
      const checkInterval = backpressureManager.getPausedInterval(msg.id);
      if (checkInterval) {
        clearTimeout(checkInterval);
        backpressureManager.deletePausedInterval(msg.id);
      }
      backpressureManager.clearPendingVisual(msg.id);

      // Calculate pause duration if we have a start time
      const pauseStart = backpressureManager.getPauseStartTime(msg.id);
      const pauseDuration = pauseStart ? Date.now() - pauseStart : undefined;
      backpressureManager.deletePauseStartTime(msg.id);

      // Clear suspended flag to allow output to flow again
      backpressureManager.clearSuspended(msg.id);

      // Also clear IPC queue backpressure state
      ipcQueueManager.clearQueue(msg.id);

      // Emit resume status (uses current visualBuffers via ctx getter)
      const buffers = ctx.visualBuffers;
      const utilization =
        buffers.length > 0
          ? buffers[selectShard(msg.id, buffers.length)].getUtilization()
          : undefined;
      backpressureManager.emitTerminalStatus(msg.id, "running", utilization, pauseDuration);

      // Emit metrics for pause-end (user force-resume path)
      if (pauseDuration !== undefined) {
        backpressureManager.emitReliabilityMetric({
          terminalId: msg.id,
          metricType: "pause-end",
          timestamp: Date.now(),
          durationMs: pauseDuration,
          bufferUtilization: utilization,
        });
      }
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
