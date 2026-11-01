import { describe, expect, it } from "vitest";
import type { ScheduledRun } from "@shared/types/scheduledRuns";
import { lastRunWords } from "../lastRunWords";

// Only the axes the wording reads; the rest of a record never changes the words.
function run(parts: { settlement: unknown; pty?: unknown; createdAt?: number }): ScheduledRun {
  return {
    createdAt: parts.createdAt ?? 1_000,
    settlement: parts.settlement,
    process: { agent: { state: "not-started" }, pty: parts.pty ?? { state: "not-started" } },
  } as unknown as ScheduledRun;
}

function settled(outcome: string, evidence: unknown) {
  return run({ settlement: { state: "settled", settledAt: 5_000, outcome, evidence } });
}

describe("lastRunWords", () => {
  it("never calls an open run running before its terminal was seen to start", () => {
    const registered = lastRunWords(run({ settlement: { state: "open" }, createdAt: 2_000 }));
    expect(registered).toMatchObject({ label: "Starting", at: 2_000, timePrefix: null });

    const started = lastRunWords(
      run({ settlement: { state: "open" }, pty: { state: "running", startedAt: 3_000 } })
    );
    expect(started).toMatchObject({ label: "Running", at: 3_000, timePrefix: "Started" });
  });

  it("reads a signal before the exit code it came with", () => {
    const words = lastRunWords(
      settled("failed", { kind: "exit", process: "pty", exitCode: 0, signal: 15 })
    );
    expect(words).toMatchObject({ label: "Signal 15", severity: "error" });
  });

  it("names the code of a non-zero exit, and a launch that never started", () => {
    expect(
      lastRunWords(settled("failed", { kind: "exit", process: "pty", exitCode: 2, signal: null }))
        .label
    ).toBe("Exited with 2");
    expect(lastRunWords(settled("failed", { kind: "launch-error", message: "x" })).label).toBe(
      "Failed to launch"
    );
  });

  it("says why a run was skipped without claiming more than the record holds", () => {
    const details = (["missed", "overlap", "precondition"] as const).map(
      (kind) =>
        lastRunWords(
          settled("skipped", {
            kind: "skip",
            reason:
              kind === "overlap"
                ? { kind, openRunId: "r" }
                : kind === "precondition"
                  ? { kind, exitCode: 1, signal: null, error: null }
                  : { kind },
          })
        ).detail
    );
    expect(new Set(details).size).toBe(3);
    expect(details.every((detail) => detail !== null && !/closed|quit/.test(detail))).toBe(true);
  });

  it("gives only done, needs-you, failed and lost a severity", () => {
    const severities = {
      done: lastRunWords(settled("done", { kind: "handback", report: "done" })).severity,
      needsYou: lastRunWords(settled("needs-you", { kind: "handback", report: "needs-you" }))
        .severity,
      lost: lastRunWords(settled("lost", { kind: "lost" })).severity,
      cancelled: lastRunWords(settled("cancelled", { kind: "cancel" })).severity,
      interrupted: lastRunWords(settled("interrupted", { kind: "interrupted" })).severity,
    };
    expect(severities).toEqual({
      done: "success",
      needsYou: "warning",
      lost: "error",
      cancelled: null,
      interrupted: null,
    });
  });
});
