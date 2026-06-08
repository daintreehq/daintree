import { useCallback, useEffect, useRef, useState } from "react";
import { useEffectEvent } from "react";
import type { TerminalReliabilityMetricPayload } from "@shared/types/pty-host";
import { terminalClient } from "@/clients";
import { notify } from "@/lib/notify";
import { logWarn } from "@/utils/logger";

/**
 * A `pause-end` reliability metric whose `durationMs` reaches this threshold was
 * a force-resume: the pty-host's bounded-pause safety timer fired at
 * `IPC_MAX_PAUSE_MS` (10000ms — `electron/services/pty/types.ts`) because the
 * renderer never drained to the low-watermark in time. The 100ms slack absorbs
 * scheduling jitter between the timer firing and the metric timestamp. A
 * natural drain always reports well under this; a missing `durationMs` is
 * ambiguous and is treated as neither a force-resume nor a drain.
 *
 * Kept as a local constant rather than imported: `IPC_MAX_PAUSE_MS` lives in an
 * Electron-main module and isn't part of the shared surface, so coupling the
 * renderer to it just for this derived bound isn't worth a shared-types move.
 */
const FORCE_RESUME_THRESHOLD_MS = 9900;

/**
 * Consecutive force-resume cycles that promote the terminal from the ambient
 * Tier-1 flow-status pill to a Tier-3 recovery banner. Three in a row means the
 * renderer is genuinely stuck (JS deadlock, GC thrash) rather than briefly
 * backpressured — the bounded-pause safety has fired repeatedly with no natural
 * recovery in between.
 */
const FORCE_RESUME_TIER_3_COUNT = 3;

export interface ForceResumeCycleWatchdog {
  /** True once the terminal has been force-resumed `FORCE_RESUME_TIER_3_COUNT` times in a row. */
  showBanner: boolean;
  /** Clears the watchdog state and force-resumes the terminal's paused queue. */
  resetQueue: () => void;
}

/**
 * Watches the `terminal:reliability-metric` event bus for a terminal that is
 * being force-resumed in a tight loop — the renderer never drains the IPC queue
 * before the pty-host's bounded-pause safety timer fires, so output keeps
 * stalling. After three consecutive force-resumes it surfaces a Tier-3 recovery
 * banner (see CLAUDE.md "Runtime Signals") and emits a one-shot low-priority
 * grid-bar warning. A single confirmed natural drain re-arms the watchdog.
 */
export function useForceResumeCycleWatchdog(id: string): ForceResumeCycleWatchdog {
  // Counter is hook-instance-local by design: if the pane unmounts/remounts for
  // the same id (LRU eviction → re-activation) the streak restarts from zero.
  // That's the intended trade-off — a stall that survives a remount re-proves
  // itself over three fresh cycles rather than persisting state in a store.
  const consecutiveRef = useRef(0);
  const notifyFiredRef = useRef(false);
  const [showBanner, setShowBanner] = useState(false);

  const onMetric = useEffectEvent((payload: TerminalReliabilityMetricPayload) => {
    if (payload.terminalId !== id || payload.metricType !== "pause-end") return;
    const { durationMs } = payload;
    // Ambiguous metric (pause-start time was lost upstream, or a non-finite
    // delta): don't count it as a force-resume, but don't reset either —
    // resetting on an unknown outcome would mask a genuine stall loop (lesson #8558).
    if (durationMs === undefined || !Number.isFinite(durationMs)) return;

    if (durationMs >= FORCE_RESUME_THRESHOLD_MS) {
      consecutiveRef.current += 1;
      if (consecutiveRef.current < FORCE_RESUME_TIER_3_COUNT) return;
      setShowBanner(true);
      if (notifyFiredRef.current) return;
      notifyFiredRef.current = true;
      notify({
        type: "warning",
        priority: "low",
        placement: "grid-bar",
        title: "Terminal output stalled",
        message: "Reset the queue from the terminal banner to recover.",
        supersedeKey: `terminal-force-resume-stalled:${id}`,
        context: { eventKind: "recovery", panelId: id },
      });
    } else {
      // Confirmed natural drain — the renderer caught up on its own. Re-arm.
      consecutiveRef.current = 0;
      notifyFiredRef.current = false;
      setShowBanner(false);
    }
  });

  useEffect(() => {
    consecutiveRef.current = 0;
    notifyFiredRef.current = false;
    setShowBanner(false);
    return window.electron.events.on("terminal:reliability-metric", onMetric);
    // `onMetric` is a stable `useEffectEvent` ref — intentionally excluded from
    // deps so a new `id` tears down the old subscription and resets the counter.
  }, [id]);

  const resetQueue = useCallback(() => {
    consecutiveRef.current = 0;
    notifyFiredRef.current = false;
    setShowBanner(false);
    void terminalClient.forceResume(id).catch((err: unknown) => {
      logWarn("Force-resume from stall banner failed", { terminalId: id, error: String(err) });
    });
  }, [id]);

  return { showBanner, resetQueue };
}
