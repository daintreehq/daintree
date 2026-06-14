import { metricsEnabled } from "../index.js";
import type { HostContext } from "./types.js";

export interface WakeOutcome {
  state: string | null;
  warnings?: string[];
  /**
   * The buffer provably hasn't changed since the requesting window's last
   * faithful sync — the renderer keeps its pane as-is instead of replaying.
   * Only ever true for port wakes that asserted `canSkipUnchanged`.
   */
  noChange?: boolean;
}

export interface WakeOptions {
  /** Requesting window — required for the per-window no-change short-circuit. */
  windowId?: number;
  /**
   * Renderer assertion that its pane currently reflects the last wake
   * snapshot it applied plus every port chunk received since. Without it the
   * host must serialize even when the epochs match (e.g. a fresh xterm
   * instance behind the same window).
   */
  canSkipUnchanged?: boolean;
}

/**
 * Shared wake implementation behind both transports: the `wake-terminal`
 * utility-process message (responds via Main) and the per-window port `wake`
 * request (responds on the port, skipping Main entirely). `respond` is invoked
 * exactly where the legacy handler sent its wake-result — before the stale-wake
 * tier reconciliation — so renderer-observable ordering is unchanged.
 */
export function createWakeExecutor(ctx: HostContext) {
  const { ptyManager, backpressureManager, getPauseCoordinator } = ctx;

  return async function executeWake(
    id: string,
    respond: (outcome: WakeOutcome) => void,
    opts?: WakeOptions
  ): Promise<void> {
    const wakeStartTime = Date.now();

    // Capture the tier before the wake promotes it. A trailing-edge wake that
    // fires after the renderer already backgrounded the pane (#9906) arrives
    // here with the host still at "background" — the signal that this wake is
    // stale and must be undone once the snapshot is served, so the host
    // doesn't stream at full rate into a hidden terminal forever.
    const preWakeTier = backpressureManager.getActivityTier(id);

    // Wake implies we want a faithful snapshot + resume streaming.
    backpressureManager.setActivityTier(id, "active", "wake-terminal");
    backpressureManager.clearSuspended(id);
    backpressureManager.clearPendingVisual(id);

    // Clear any active pause interval and timing, and resume the PTY
    const checkInterval = backpressureManager.getPausedInterval(id);
    const wasPaused = checkInterval !== undefined;
    if (checkInterval) {
      clearTimeout(checkInterval);
      backpressureManager.deletePausedInterval(id);
    }
    backpressureManager.deletePauseStartTime(id);

    // Hold the backpressure pause until after serialization — resuming the
    // PTY first lets bytes emitted in the gap land in both the snapshot and
    // the live stream, duplicating them on replay (#9897). The resume
    // happens in the finally below.
    const wakeCoordinator = getPauseCoordinator(id);

    // Apply active tier polling (50ms) when waking
    const terminal = ptyManager.getTerminal(id);
    if (terminal) {
      ptyManager.setActivityMonitorTier(id, "active", 50);
    }

    let state: string | null = null;
    let noChange = false;
    const syncedEpoch =
      opts?.canSkipUnchanged && opts.windowId !== undefined
        ? terminal?.wakeSyncedEpochByWindow?.get(opts.windowId)
        : undefined;
    if (terminal && syncedEpoch !== undefined && syncedEpoch === terminal.contentEpoch) {
      // No-change short-circuit: every buffer mutation bumps contentEpoch, so
      // epoch equality with this window's last faithful sync proves nothing
      // could have changed since — skip serialize entirely. There's no
      // snapshot to keep the live stream out of (#9897), so the paused PTY
      // can resume immediately.
      noChange = true;
      if (wasPaused) {
        wakeCoordinator?.resume("backpressure");
      }
    } else {
      // Capture before the serialize await: bytes arriving mid-serialize bump
      // the epoch past this value, keeping the next wake conservative. Only
      // trust the capture when xterm's async parser has drained — an
      // arrived-but-unparsed tail is counted by the epoch but absent from the
      // snapshot, and serve-marking it would strand the tail behind a future
      // no-change skip.
      const epochBeforeSerialize =
        terminal && (terminal.pendingHeadlessWrites ?? 0) === 0 ? terminal.contentEpoch : undefined;
      try {
        state = await ptyManager.getSerializedStateAsync(id);
      } catch {
        state = ptyManager.getSerializedState(id);
      } finally {
        // Resume even when serialization throws so wake always unblocks the
        // terminal (#9896). Reuses the coordinator captured above — the
        // terminal may have been torn down during the await.
        if (wasPaused) {
          wakeCoordinator?.resume("backpressure");
        }
      }
      if (
        state !== null &&
        terminal &&
        opts?.windowId !== undefined &&
        epochBeforeSerialize !== undefined
      ) {
        (terminal.wakeSyncedEpochByWindow ??= new Map()).set(opts.windowId, epochBeforeSerialize);
      }
    }

    const wakeLatencyMs = Date.now() - wakeStartTime;

    // Best-effort warning: cwd missing. Runs after the resume so a slow
    // stat (stale network mount) can't extend the pause window.
    const warnings: string[] = [];
    try {
      const t = ptyManager.getTerminal(id);
      if (t?.cwd && typeof t.cwd === "string") {
        const fs = await import("node:fs");
        if (!fs.existsSync(t.cwd)) {
          warnings.push("cwd-missing");
        }
      }
    } catch {
      // ignore
    }

    if (!wakeCoordinator?.isPaused) {
      backpressureManager.emitTerminalStatus(id, "running");
    }

    // Emit wake latency metrics (only if enabled to avoid overhead)
    if (metricsEnabled() && state) {
      const { Buffer } = await import("node:buffer");
      const serializedStateBytes = Buffer.byteLength(state, "utf8");
      backpressureManager.emitReliabilityMetric({
        terminalId: id,
        metricType: "wake-latency",
        timestamp: Date.now(),
        wakeLatencyMs,
        serializedStateBytes,
      });
    }

    respond({
      state,
      warnings: warnings.length > 0 ? warnings : undefined,
      noChange: noChange || undefined,
    });

    // Reconcile a stale wake (#9906). If the host was already "background"
    // when this wake arrived, the renderer had moved the pane offscreen and
    // this wake is a trailing-edge artifact (a rate-limited timer that fired
    // after the BACKGROUND transition). The snapshot has been served, so
    // re-demote the host to "background" and push a tier-changed correction
    // to reset the renderer's setActivityTier dedup baseline — otherwise its
    // lastBackendTier stays "background" and it can never re-send the
    // "background" correction, leaving the host streaming at 50ms into a
    // hidden pane indefinitely. Posted unconditionally when preWakeTier was
    // "background" (setActivityTier dedupes same-tier, so the broadcast, not
    // the set, is what reconciles the renderer). FIFO-ordered after the data
    // path on the same per-window port, project-filtered exactly like
    // recomputeActivityTiers.
    if (preWakeTier === "background") {
      backpressureManager.setActivityTier(id, "background", "wake-terminal-correction");
      ptyManager.setActivityMonitorTier(id, "background", 500);
      const wakeTerminal = ptyManager.getTerminal(id);
      const termProject = wakeTerminal?.projectId ?? null;
      for (const [windowId, conn] of ctx.rendererConnections) {
        const windowProject = ctx.windowProjectMap.get(windowId) ?? null;
        if (windowProject !== null && termProject !== windowProject) continue;
        try {
          conn.port.postMessage({ type: "tier-changed", id, tier: "background" });
        } catch {
          // Port closing between iteration and post — disconnect handles cleanup.
        }
      }
    }
  };
}
