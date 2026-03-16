import { events } from "../events.js";

export class ApprovalManager {
  private pendingApprovals: Map<
    string,
    { resolve: (approved: boolean, feedback?: string) => void }
  > = new Map();

  private approvalTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

  setupApprovalWait(
    runId: string,
    nodeId: string,
    timeoutMs: number | undefined,
    onTimeout: () => void
  ): void {
    const key = `${runId}::${nodeId}`;

    this.pendingApprovals.set(key, {
      resolve: (_approved: boolean, _feedback?: string) => {
        // Placeholder — resolveApproval() calls handleApprovalResolution directly
      },
    });

    if (timeoutMs) {
      const handle = setTimeout(() => {
        this.pendingApprovals.delete(key);
        onTimeout();
      }, timeoutMs);
      handle.unref?.();
      this.approvalTimeouts.set(key, handle);
    }
  }

  hasPendingApproval(runId: string, nodeId: string): boolean {
    return this.pendingApprovals.has(`${runId}::${nodeId}`);
  }

  deletePendingApproval(runId: string, nodeId: string): void {
    const key = `${runId}::${nodeId}`;
    this.pendingApprovals.delete(key);

    const timeoutHandle = this.approvalTimeouts.get(key);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.approvalTimeouts.delete(key);
    }
  }

  pendingApprovalKeys(): IterableIterator<string> {
    return this.pendingApprovals.keys();
  }

  clearPendingApprovals(
    runId?: string,
    reason: "resolved" | "cancelled" | "timeout" = "cancelled"
  ): void {
    const now = Date.now();
    const keysToRemove: string[] = [];

    for (const key of this.pendingApprovals.keys()) {
      if (!runId || key.startsWith(`${runId}::`)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.pendingApprovals.delete(key);
      const timeoutHandle = this.approvalTimeouts.get(key);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        this.approvalTimeouts.delete(key);
      }
      const [rId, nId] = key.split("::");
      events.emit("workflow:approval-cleared", {
        runId: rId,
        nodeId: nId,
        reason,
        timestamp: now,
      });
    }
  }

  dispose(): void {
    this.clearPendingApprovals(undefined, "cancelled");
  }
}
