import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalReliabilityMetricPayload } from "@shared/types/pty-host";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { logWarn } from "@/utils/logger";
import { clearTerminalStallEscalation, reportTerminalStallEscalated } from "./terminalStallNotice";

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
 * Consecutive force-resumes that count as a stall rather than a burst of
 * backpressure. The first streak triggers an automatic resync; a second one
 * after that resync escalates to the pane's error banner.
 */
const FORCE_RESUME_STREAK = 3;

/** Bounds one resync so a host that never answers can't hold a pane in recovery. */
const RECOVERY_TIMEOUT_MS = 15_000;

export interface ForceResumeCycleWatchdog {
  /** True once automatic recovery has been tried and output still stalls. */
  showBanner: boolean;
  /** True while a Retry from the banner is running. */
  isRetrying: boolean;
  /** Forced redraw plus a resync from the host's copy of the terminal. */
  retry: () => void;
}

/**
 * - `watching` — counting force-resumes; automatic recovery is still unspent.
 * - `recovering` — an automatic resync is queued or running.
 * - `recovered` — a resync ran; the next streak escalates instead of retrying it.
 * - `escalated` — the banner is up and the terminal counts toward the grid-bar notice.
 */
type StallStage = "watching" | "recovering" | "recovered" | "escalated";

/**
 * Runs `work` with a deadline. On expiry the signal aborts, so a snapshot that
 * arrives late is dropped instead of resetting a pane the watchdog has already
 * escalated, or that a Retry is now redrawing.
 */
function withDeadline(
  work: (signal: AbortSignal) => Promise<boolean>,
  ms: number
): Promise<boolean> {
  const controller = new AbortController();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, ms);
    const settle = (result: boolean) => {
      clearTimeout(timer);
      resolve(result);
    };
    try {
      work(controller.signal).then(settle, () => settle(false));
    } catch {
      settle(false);
    }
  });
}

/**
 * Redraws the pane from the host's headless copy. The restore's stream fence
 * then skips the queued output the snapshot already covers, which is what lets
 * a backed-up pane catch up. A manual retry also forces the renderer repair
 * the automatic path leaves to its shared budget.
 */
async function resyncFromHost(id: string, manual: boolean): Promise<boolean> {
  const service = peekTerminalService();
  if (!service) return false;
  try {
    if (manual) service.resetRenderer(id, { force: true });
    return await withDeadline(
      (signal) => service.fetchAndRestore(id, { settlePendingWrites: true, signal }),
      RECOVERY_TIMEOUT_MS
    );
  } catch (error) {
    logWarn("Terminal stall resync failed", { terminalId: id, error: String(error) });
    return false;
  }
}

// Automatic resyncs run one at a time: several panes stalling together is the
// common case, and replaying every snapshot at once would add to whatever load
// stalled them. Each job is bounded by RECOVERY_TIMEOUT_MS, so the chain moves.
let automaticResyncChain: Promise<unknown> = Promise.resolve();

function queueAutomaticResync(id: string, isCurrent: () => boolean): Promise<boolean> {
  const job = () => (isCurrent() ? resyncFromHost(id, false) : Promise.resolve(false));
  const run = automaticResyncChain.then(job, job);
  automaticResyncChain = run.catch(() => undefined);
  return run;
}

export function __resetAutomaticResyncQueueForTests(): void {
  automaticResyncChain = Promise.resolve();
}

interface StallUi {
  setShowBanner: (show: boolean) => void;
  setIsRetrying: (retrying: boolean) => void;
}

class ForceResumeStallWatch {
  private streak = 0;
  private stage: StallStage = "watching";
  // Only pauses that begin after this count. Moved on mount, on every
  // visibility change and after each resync, so a pause that spans time the
  // pane was hidden or being resynced never adds to a streak.
  private epochStart = Date.now();
  // Bumped whenever the episode resets, so a resync that settles afterwards
  // can't act on state it no longer owns.
  private attempt = 0;
  private retrying = false;
  private disposed = false;

  constructor(
    private readonly id: string,
    private readonly ui: StallUi
  ) {}

  readonly handleMetric = (payload: TerminalReliabilityMetricPayload): void => {
    if (this.disposed || payload.terminalId !== this.id || payload.metricType !== "pause-end") {
      return;
    }
    const { durationMs } = payload;
    // Ambiguous metric (pause-start time was lost upstream, or a non-finite
    // delta): don't count it as a force-resume, but don't reset either —
    // resetting on an unknown outcome would mask a genuine stall loop (lesson #8558).
    if (durationMs === undefined || !Number.isFinite(durationMs)) return;
    // Nobody can see this view, and the visibility edge already cleared the
    // episode. Stalls are judged only on what happens while it's on screen.
    if (!isProjectViewObservable()) return;

    if (durationMs < FORCE_RESUME_THRESHOLD_MS) {
      // Confirmed natural drain — the renderer caught up on its own.
      this.resetEpisode(false);
      return;
    }
    // Measured against this renderer's clock with the duration alone, so a
    // remote host's clock skew can't move it.
    if (Date.now() - durationMs < this.epochStart) return;
    if (this.stage === "recovering" || this.stage === "escalated") return;

    this.streak += 1;
    if (this.streak < FORCE_RESUME_STREAK) return;
    this.streak = 0;
    if (this.stage === "watching") {
      this.recoverAutomatically();
    } else {
      this.escalate();
    }
  };

  readonly handleObservabilityChange = (): void => {
    if (this.disposed) return;
    // Either edge starts over: a hidden view's stall is no longer shown, and a
    // view coming back is judged only on what happens from now on.
    this.resetEpisode(true);
  };

  retry(): void {
    if (this.disposed || this.retrying) return;
    this.retrying = true;
    this.ui.setIsRetrying(true);
    const attempt = this.attempt;
    void resyncFromHost(this.id, true).then((recovered) => {
      if (this.disposed) return;
      this.retrying = false;
      this.ui.setIsRetrying(false);
      // A drain or visibility change already cleared the episode meanwhile.
      if (attempt !== this.attempt || !recovered) return;
      this.markRecovered();
      this.ui.setShowBanner(false);
      clearTerminalStallEscalation(this.id);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.attempt += 1;
    this.ui.setShowBanner(false);
    this.ui.setIsRetrying(false);
    clearTerminalStallEscalation(this.id);
  }

  private resetEpisode(newEpoch: boolean): void {
    this.attempt += 1;
    this.streak = 0;
    this.stage = "watching";
    if (newEpoch) this.epochStart = Date.now();
    this.ui.setShowBanner(false);
    clearTerminalStallEscalation(this.id);
  }

  private markRecovered(): void {
    this.stage = "recovered";
    this.streak = 0;
    this.epochStart = Date.now();
  }

  private recoverAutomatically(): void {
    this.stage = "recovering";
    const attempt = ++this.attempt;
    const isCurrent = () => !this.disposed && attempt === this.attempt;
    void queueAutomaticResync(this.id, isCurrent).then((recovered) => {
      if (!isCurrent()) return;
      if (recovered) {
        this.markRecovered();
      } else {
        this.escalate();
      }
    });
  }

  private escalate(): void {
    this.stage = "escalated";
    this.ui.setShowBanner(true);
    reportTerminalStallEscalated(this.id);
  }
}

/**
 * Watches the `terminal:reliability-metric` event bus for a terminal the
 * pty-host keeps force-resuming because the renderer never drained its output
 * in time. Recovery is automatic first: three consecutive force-resumes while
 * the project view is on screen resync the pane from the host's headless copy.
 * Only if that resync fails, or three more force-resumes follow it, does the
 * pane show its error banner and join the shared grid-bar notice
 * (`terminalStallNotice`). A natural drain, the view being hidden or shown, or
 * a restart (`restartKey`) clears everything.
 */
export function useForceResumeCycleWatchdog(
  id: string,
  restartKey?: number
): ForceResumeCycleWatchdog {
  const [showBanner, setShowBanner] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const watchRef = useRef<ForceResumeStallWatch | null>(null);

  useEffect(() => {
    const watch = new ForceResumeStallWatch(id, { setShowBanner, setIsRetrying });
    watchRef.current = watch;
    const offMetric = window.electron.events.on("terminal:reliability-metric", watch.handleMetric);
    const offObservability = subscribeProjectViewObservability(watch.handleObservabilityChange);
    return () => {
      offMetric();
      offObservability();
      watch.dispose();
      if (watchRef.current === watch) watchRef.current = null;
    };
    // A restart keeps the id but starts a new process: its predecessor's
    // stall, which no drain will now clear, must not carry over.
  }, [id, restartKey]);

  const retry = useCallback(() => {
    watchRef.current?.retry();
  }, []);

  return { showBanner, isRetrying, retry };
}
