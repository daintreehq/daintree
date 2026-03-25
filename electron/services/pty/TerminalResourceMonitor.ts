import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import type { PtyManager } from "../PtyManager.js";
import type { PtyHostEvent, TerminalResourceBatchPayload } from "../../../shared/types/pty-host.js";

export class TerminalResourceMonitor {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private processTreeCache: ProcessTreeCache,
    private ptyManager: PtyManager,
    private sendEvent: (event: PtyHostEvent) => void
  ) {}

  setEnabled(enabled: boolean): void {
    if (enabled && !this.unsubscribe) {
      this.unsubscribe = this.processTreeCache.onRefresh(() => {
        this.collectAndEmit();
      });
    } else if (!enabled && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private collectAndEmit(): void {
    const terminals = this.ptyManager.getAll();
    const metrics: TerminalResourceBatchPayload = {};

    for (const terminal of terminals) {
      const pid = terminal.ptyProcess?.pid;
      if (pid === undefined || pid <= 0) continue;

      const summary = this.processTreeCache.getTreeResourceSummary(pid);
      if (!summary) continue;

      metrics[terminal.id] = {
        cpuPercent: summary.cpuPercent,
        memoryKb: summary.memoryKb,
        breakdown: summary.breakdown,
      };
    }

    if (Object.keys(metrics).length > 0) {
      this.sendEvent({
        type: "resource-metrics",
        metrics,
        timestamp: Date.now(),
      });
    }
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
