import { logInfo } from "../utils/logger.js";
import type { WorkspaceHostEvent } from "../../shared/types/workspace-host.js";

/**
 * How long the switched-to view waits for every worktree status before it
 * reports what it has. Measured from the switch request, not from the view.
 */
export const STATUS_TIMING_DEADLINE_MS = 15_000;

/**
 * Extra time main allows for the view's deadline report to cross the renderer →
 * host → main relay before writing the record without it. The host is the busy
 * party in exactly the switches worth measuring, so this is not tight.
 */
export const STATUS_TIMING_REPORT_GRACE_MS = 5_000;

export type HostLoadKind = "warm" | "cold";

export type StatusTimingOutcome =
  | "applied"
  | "timeout"
  | "no-report"
  | "superseded"
  | "load-failed"
  | "swap-failed";

type StatusTimingReport = Extract<WorkspaceHostEvent, { type: "switch-status-timing" }>;

interface PendingSwitch {
  switchId: string;
  projectId: string;
  windowId: number;
  requestedAt: number;
  host: HostLoadKind | null;
  hostReadyAt: number | null;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One `projectswitch.status-timing` record per project switch: when the host
 * was ready (and whether it was reused), when it listed its worktrees and
 * emitted its first snapshot, when each worktree's first status was emitted,
 * and when the switched-to view had every status applied (#12461).
 *
 * Main owns the record because the host can die mid-switch and take any state
 * of its own with it. Every path out — the view's report, a failure, a newer
 * switch in the same window, or the backstop timer — goes through `finish`, so
 * a switch logs exactly once and leaves nothing behind.
 */
export class ProjectSwitchStatusTiming {
  private readonly pending = new Map<string, PendingSwitch>();
  private readonly byWindow = new Map<number, string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Starts timing a switch and returns the view's wall-clock report deadline. */
  begin(switchId: string, projectId: string, windowId: number, requestedAt: number): number {
    const previousInWindow = this.byWindow.get(windowId);
    if (previousInWindow !== undefined) this.finishById(previousInWindow, "superseded");
    this.finishById(switchId, "superseded");

    const pending: PendingSwitch = {
      switchId,
      projectId,
      windowId,
      requestedAt,
      host: null,
      hostReadyAt: null,
      timer: setTimeout(
        () => this.finish(pending, "no-report"),
        Math.max(0, requestedAt + STATUS_TIMING_DEADLINE_MS + STATUS_TIMING_REPORT_GRACE_MS - this.now())
      ),
    };
    this.pending.set(switchId, pending);
    this.byWindow.set(windowId, switchId);
    return requestedAt + STATUS_TIMING_DEADLINE_MS;
  }

  hostReady(switchId: string, host: HostLoadKind | undefined): void {
    const pending = this.pending.get(switchId);
    if (!pending) return;
    pending.host = host ?? null;
    pending.hostReadyAt = this.now();
  }

  fail(switchId: string, outcome: "load-failed" | "swap-failed"): void {
    this.finishById(switchId, outcome);
  }

  /** The view's report, relayed by the host. Late or unknown reports are dropped. */
  complete(report: StatusTimingReport): void {
    const pending = this.pending.get(report.switchId);
    if (!pending) return;
    this.finish(pending, report.rendererAppliedAt === null ? "timeout" : "applied", report);
  }

  /** Test seam: live switch count, so suites can assert nothing leaked. */
  get size(): number {
    return this.pending.size;
  }

  private finishById(switchId: string, outcome: StatusTimingOutcome): void {
    const pending = this.pending.get(switchId);
    if (pending) this.finish(pending, outcome);
  }

  private finish(
    pending: PendingSwitch,
    outcome: StatusTimingOutcome,
    report?: StatusTimingReport
  ): void {
    if (this.pending.get(pending.switchId) !== pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(pending.switchId);
    if (this.byWindow.get(pending.windowId) === pending.switchId) {
      this.byWindow.delete(pending.windowId);
    }

    const { requestedAt } = pending;
    // Marks that predate the request belong to an earlier load of a reused
    // host; they are not part of this switch, so they read as null.
    const since = (at: number | null | undefined): number | null =>
      at == null || at < requestedAt ? null : at - requestedAt;

    const host = report?.host;
    const firstStatusMs: number[] = [];
    let preExistingStatusCount = 0;
    for (const at of host?.firstStatusAt ?? []) {
      if (at < requestedAt) preExistingStatusCount++;
      else firstStatusMs.push(at - requestedAt);
    }
    firstStatusMs.sort((a, b) => a - b);

    logInfo("projectswitch.status-timing", {
      projectId: pending.projectId,
      switchId: pending.switchId,
      outcome,
      host: pending.host,
      worktreeCount: host?.monitorCount ?? null,
      hostReadyMs: since(pending.hostReadyAt),
      hostLoadStartMs: since(host?.loadStartedAt),
      worktreesEnumeratedMs: since(host?.enumeratedAt),
      firstSnapshotMs: since(host?.firstSnapshotAt),
      firstStatusMs,
      preExistingStatusCount,
      missingStatusCount: host ? host.monitorCount - host.firstStatusAt.length : null,
      statusAppliedMs: since(report?.rendererAppliedAt),
      appliedStatusCount: report?.rendererStatusCount ?? null,
      totalMs: this.now() - requestedAt,
    });
  }
}

export const projectSwitchStatusTiming = new ProjectSwitchStatusTiming();
