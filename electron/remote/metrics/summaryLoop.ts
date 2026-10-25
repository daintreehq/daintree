import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";
import { HOST_METRICS_INTERVAL_MS } from "./sampler.js";
import { elapsedSince, stampNow, type ElapsedStamp } from "../link/elapsed.js";
import type { SummaryReceipt } from "./summaryReceipt.js";
import { createLogger } from "../../utils/logger.js";
import { createKeyedLogLimiter } from "../../utils/keyedLogLimiter.js";

const logger = createLogger("main:summaryLoop");
const logLimiter = createKeyedLogLimiter();

export interface SummarySource {
  sample(): Promise<HostMetricsSummary>;
}

type Listener = (summary: HostMetricsSummary) => void;

/**
 * Samples this machine on a fixed cadence while anyone listens: the host
 * streaming to its Shells, and this Shell's own row in the host menu. One
 * loop feeds both, and it stops when the last listener leaves.
 */
export class SummaryLoop {
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private last: HostMetricsSummary | null = null;
  /** When the read behind `last` began: a slow read counts toward its age. */
  private lastStartedAt: ElapsedStamp | null = null;

  constructor(
    private readonly source: SummarySource,
    private readonly intervalMs: number = HOST_METRICS_INTERVAL_MS,
    private readonly clock: () => ElapsedStamp = stampNow
  ) {}

  latest(): HostMetricsSummary | null {
    return this.last;
  }

  /** How old the latest summary is by this machine's clocks; null for any other. */
  ageOf(summary: HostMetricsSummary): number | null {
    if (summary !== this.last || !this.lastStartedAt) return null;
    return elapsedSince(this.lastStartedAt, this.clock());
  }

  /** The latest summary as taken in hand when its read began, on this machine's own clocks. */
  receiptOf(summary: HostMetricsSummary): SummaryReceipt | null {
    const at = summary === this.last ? this.lastStartedAt : null;
    return at ? { receivedAt: at.wall, at, hostAgeMs: 0, maxAgeMs: 0, timed: true } : null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.timer === null) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref?.();
      void this.tick();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
        this.last = null;
        this.lastStartedAt = null;
      }
    };
  }

  private async tick(): Promise<void> {
    // A slow sample skips a beat rather than stacking reads.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const startedAt = this.clock();
      const summary = await this.source.sample();
      if (this.timer === null) return;
      this.last = summary;
      this.lastStartedAt = startedAt;
      for (const listener of [...this.listeners]) {
        try {
          listener(summary);
        } catch (error) {
          console.error("[HostMetrics] Summary listener failed:", error);
        }
      }
    } catch (error) {
      const suppressedCount = logLimiter.take("sampling");
      if (suppressedCount !== null) {
        logger.warn("Sampling failed", { error, suppressedCount });
      }
    } finally {
      this.inFlight = false;
    }
  }
}
