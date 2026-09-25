import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";
import { HOST_METRICS_INTERVAL_MS } from "./sampler.js";

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

  constructor(
    private readonly source: SummarySource,
    private readonly intervalMs: number = HOST_METRICS_INTERVAL_MS
  ) {}

  latest(): HostMetricsSummary | null {
    return this.last;
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
      }
    };
  }

  private async tick(): Promise<void> {
    // A slow sample skips a beat rather than stacking reads.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const summary = await this.source.sample();
      if (this.timer === null) return;
      this.last = summary;
      for (const listener of [...this.listeners]) {
        try {
          listener(summary);
        } catch (error) {
          console.error("[HostMetrics] Summary listener failed:", error);
        }
      }
    } catch (error) {
      console.warn("[HostMetrics] Sampling failed:", error);
    } finally {
      this.inFlight = false;
    }
  }
}
