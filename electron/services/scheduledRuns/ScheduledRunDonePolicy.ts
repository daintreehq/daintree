import type { ScheduledRun, Schedule } from "../../../shared/types/scheduledRuns.js";

export type ScheduledRunDoneAction = "background" | "close";

/** A launched run whose done policy moves its terminal, as its launch read the policy. */
export interface ArmedScheduledRun {
  readonly runId: string;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly terminalId: string;
  readonly onDone: Schedule["policies"]["onDone"];
}

export interface ScheduledRunDonePolicyDeps {
  getRun: (runId: string) => ScheduledRun | null;
  isShuttingDown: () => boolean;
  /**
   * Moves the run's terminal to the background, or closes it with its session
   * captured for resuming. `run` is the settled record, for its incarnation.
   */
  apply: (
    target: ArmedScheduledRun,
    action: ScheduledRunDoneAction,
    run: ScheduledRun
  ) => Promise<void>;
  logWarn?: (message: string, error?: unknown) => void;
}

/** Whether the run settled on its agent's `done` handback: the one outcome the policy acts on. */
function handedBackDone(run: ScheduledRun | null): run is ScheduledRun {
  const settlement = run?.settlement;
  return (
    settlement?.state === "settled" &&
    settlement.evidence.kind === "handback" &&
    settlement.evidence.report === "done"
  );
}

/**
 * Applies a schedule's done policy to its run's terminal (#15982), once the
 * agent hands the run back as `done`: keep it, move it to the background, or
 * close it with its session left resumable. `needs-you` leaves the terminal
 * where it is whatever the policy says, and so does every other way a run can
 * settle, an exit with code 0 included: only the agent's own report is the
 * word that it's finished.
 *
 * The policy is the one the launch read, so editing the schedule changes later
 * runs. A run is armed once its launch has finished, its pane committed and
 * saved, so moving the pane can't race the launch writing it; a run that
 * settled before then is handled as it's armed.
 */
export class ScheduledRunDonePolicy {
  private readonly armed = new Map<string, ArmedScheduledRun>();
  private readonly logWarn: (message: string, error?: unknown) => void;

  constructor(private readonly deps: ScheduledRunDonePolicyDeps) {
    this.logWarn = deps.logWarn ?? console.warn;
  }

  arm(target: ArmedScheduledRun): void {
    if (target.onDone === "keep") return;
    const run = this.deps.getRun(target.runId);
    if (!run) return;
    if (run.settlement.state === "settled") {
      if (handedBackDone(run)) this.act(target, run);
      return;
    }
    this.armed.set(target.runId, target);
  }

  /** `scheduled-run:ended`: the run settled, once. */
  handleRunEnded(payload: { runId: string; outcome: string }): void {
    const target = this.armed.get(payload.runId);
    if (!target) return;
    this.armed.delete(payload.runId);
    if (payload.outcome !== "done") return;
    const run = this.deps.getRun(payload.runId);
    if (handedBackDone(run)) this.act(target, run);
  }

  /** `scheduled-runs:deleted`: these runs will never end. */
  handleRunsDeleted(payload: { projectId: string; scheduleId: string | null }): void {
    for (const [runId, target] of this.armed) {
      if (target.projectId !== payload.projectId) continue;
      if (payload.scheduleId !== null && target.scheduleId !== payload.scheduleId) continue;
      this.armed.delete(runId);
    }
  }

  /** @internal Tests only. */
  armedCount(): number {
    return this.armed.size;
  }

  private act(target: ArmedScheduledRun, run: ScheduledRun): void {
    // A quit is closing every terminal its own way.
    if (this.deps.isShuttingDown()) return;
    const action: ScheduledRunDoneAction = target.onDone === "close" ? "close" : "background";
    void this.deps.apply(target, action, run).catch((error: unknown) => {
      this.logWarn(`[ScheduledRuns] Couldn't apply run ${target.runId}'s done policy:`, error);
    });
  }
}
