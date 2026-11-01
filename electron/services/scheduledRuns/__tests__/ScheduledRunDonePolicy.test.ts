import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRun, ScheduledRunEvidence } from "../../../../shared/types/scheduledRuns.js";
import { outcomeForEvidence } from "../../../../shared/utils/scheduledRuns.js";
import {
  ScheduledRunDonePolicy,
  type ArmedScheduledRun,
  type ScheduledRunDonePolicyDeps,
} from "../ScheduledRunDonePolicy.js";

const T0 = Date.UTC(2026, 10, 1, 9);

function runRecord(evidence: ScheduledRunEvidence | null, runId = "run-1"): ScheduledRun {
  return {
    id: runId,
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    createdAt: T0,
    terminalId: "terminal-1",
    terminalSpawnedAt: T0 + 40,
    settlement:
      evidence === null
        ? { state: "open" }
        : {
            state: "settled",
            settledAt: T0 + 5_000,
            outcome: outcomeForEvidence(evidence),
            evidence,
          },
    process: { agent: { state: "not-started" }, pty: { state: "running", startedAt: T0 + 40 } },
    pane: { state: "none" },
    resume: null,
  };
}

const handback = (report: "done" | "needs-you"): ScheduledRunEvidence => ({
  kind: "handback",
  report,
  summary: "triaged all six",
  truncated: false,
});

function armed(overrides: Partial<ArmedScheduledRun> = {}): ArmedScheduledRun {
  return {
    runId: "run-1",
    scheduleId: "schedule-1",
    projectId: "project-1",
    terminalId: "terminal-1",
    onDone: "close",
    ...overrides,
  };
}

let runs: Map<string, ScheduledRun>;
let shuttingDown: boolean;
let apply: ReturnType<typeof vi.fn<ScheduledRunDonePolicyDeps["apply"]>>;
let policy: ScheduledRunDonePolicy;

/** The run settles as the recorder settles it, then its end event fires. */
function settle(evidence: ScheduledRunEvidence, runId = "run-1"): void {
  runs.set(runId, runRecord(evidence, runId));
  policy.handleRunEnded({ runId, outcome: outcomeForEvidence(evidence) });
}

beforeEach(() => {
  runs = new Map([["run-1", runRecord(null)]]);
  shuttingDown = false;
  apply = vi.fn<ScheduledRunDonePolicyDeps["apply"]>(async () => {});
  policy = new ScheduledRunDonePolicy({
    getRun: (runId) => runs.get(runId) ?? null,
    isShuttingDown: () => shuttingDown,
    apply,
    logWarn: () => {},
  });
});

describe("ScheduledRunDonePolicy (#15982)", () => {
  it("closes or backgrounds the terminal when the agent hands back done, once", () => {
    policy.arm(armed({ onDone: "close" }));
    settle(handback("done"));
    expect(apply).toHaveBeenCalledWith(armed({ onDone: "close" }), "close", runs.get("run-1"));

    runs.set("run-2", runRecord(null, "run-2"));
    policy.arm(armed({ runId: "run-2", onDone: "background" }));
    settle(handback("done"), "run-2");
    expect(apply).toHaveBeenLastCalledWith(
      armed({ runId: "run-2", onDone: "background" }),
      "background",
      runs.get("run-2")
    );

    // The run ends once; a repeat of the event finds nothing armed.
    policy.handleRunEnded({ runId: "run-1", outcome: "done" });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(policy.armedCount()).toBe(0);
  });

  it("keeps the terminal where it is on needs-you, whatever the policy", () => {
    policy.arm(armed({ onDone: "close" }));
    settle(handback("needs-you"));
    expect(apply).not.toHaveBeenCalled();
    expect(policy.armedCount()).toBe(0);
  });

  it("never acts on a done the agent didn't report, such as an exit with code 0", () => {
    policy.arm(armed({ onDone: "close" }));
    settle({ kind: "exit", process: "pty", exitCode: 0, signal: null });
    expect(apply).not.toHaveBeenCalled();
  });

  it("arms nothing for a schedule that keeps its terminals", () => {
    policy.arm(armed({ onDone: "keep" }));
    settle(handback("done"));
    expect(apply).not.toHaveBeenCalled();
    expect(policy.armedCount()).toBe(0);
  });

  it("acts at once on a run that handed back before its launch finished", () => {
    runs.set("run-1", runRecord(handback("done")));
    policy.arm(armed({ onDone: "background" }));
    expect(apply).toHaveBeenCalledWith(
      armed({ onDone: "background" }),
      "background",
      runs.get("run-1")
    );
    expect(policy.armedCount()).toBe(0);

    runs.set("run-2", runRecord(handback("needs-you"), "run-2"));
    policy.arm(armed({ runId: "run-2" }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("forgets runs whose history was deleted, by schedule or with their project", () => {
    runs.set("run-2", runRecord(null, "run-2"));
    runs.set("run-3", runRecord(null, "run-3"));
    policy.arm(armed());
    policy.arm(armed({ runId: "run-2", scheduleId: "schedule-2" }));
    policy.arm(armed({ runId: "run-3", projectId: "project-2" }));

    policy.handleRunsDeleted({ projectId: "project-1", scheduleId: "schedule-2" });
    expect(policy.armedCount()).toBe(2);
    settle(handback("done"), "run-2");
    expect(apply).not.toHaveBeenCalled();
    // Another project's run outlives this project's removal.
    policy.handleRunsDeleted({ projectId: "project-1", scheduleId: null });
    expect(policy.armedCount()).toBe(1);
    settle(handback("done"));
    expect(apply).not.toHaveBeenCalled();
    settle(handback("done"), "run-3");
    expect(apply).toHaveBeenCalledWith(
      armed({ runId: "run-3", projectId: "project-2" }),
      "close",
      runs.get("run-3")
    );
  });

  it("keeps a run armed when another schedule's history is deleted", () => {
    policy.arm(armed());
    policy.handleRunsDeleted({ projectId: "project-1", scheduleId: "schedule-2" });
    settle(handback("done"));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("moves nothing while Daintree is quitting", () => {
    policy.arm(armed());
    shuttingDown = true;
    settle(handback("done"));
    expect(apply).not.toHaveBeenCalled();
  });

  it("logs a policy that failed to apply instead of throwing into the run's end", async () => {
    const logWarn = vi.fn();
    policy = new ScheduledRunDonePolicy({
      getRun: (runId) => runs.get(runId) ?? null,
      isShuttingDown: () => false,
      apply: () => Promise.reject(new Error("host gone")),
      logWarn,
    });
    policy.arm(armed());
    expect(() => settle(handback("done"))).not.toThrow();
    await vi.waitFor(() => expect(logWarn).toHaveBeenCalledTimes(1));
  });
});
