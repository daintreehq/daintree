import { describe, expect, it } from "vitest";
import type {
  ScheduledRun,
  ScheduledRunEvidence,
  ScheduledRunOutcome,
} from "@shared/types/scheduledRuns";
import { lastRunWords } from "../lastRunWords";

const BASE: ScheduledRun = {
  id: "run-1",
  scheduleId: "schedule-1",
  projectId: "project-1",
  origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
  createdAt: 1_000,
  terminalId: null,
  terminalSpawnedAt: null,
  settlement: { state: "open" },
  process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
  pane: { state: "none" },
  resume: null,
};

function open(pty: ScheduledRun["process"]["pty"], createdAt = 1_000): ScheduledRun {
  return { ...BASE, createdAt, process: { agent: { state: "not-started" }, pty } };
}

function settled(outcome: ScheduledRunOutcome, evidence: ScheduledRunEvidence): ScheduledRun {
  return { ...BASE, settlement: { state: "settled", settledAt: 5_000, outcome, evidence } };
}

describe("lastRunWords", () => {
  it("never calls an open run running before its terminal was seen to start", () => {
    expect(lastRunWords(open({ state: "not-started" }, 2_000))).toMatchObject({
      label: "Starting",
      at: 2_000,
      timePrefix: null,
    });
    expect(lastRunWords(open({ state: "running", startedAt: 3_000 }))).toMatchObject({
      label: "Running",
      at: 3_000,
      timePrefix: "Started",
    });
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
    const reasons: ScheduledRunEvidence[] = [
      { kind: "skip", reason: { kind: "missed" } },
      { kind: "skip", reason: { kind: "overlap", openRunId: "run-0" } },
      {
        kind: "skip",
        reason: { kind: "precondition", exitCode: 1, signal: null, error: null },
      },
    ];
    const details = reasons.map((evidence) => lastRunWords(settled("skipped", evidence)).detail);
    expect(new Set(details).size).toBe(3);
    expect(details.every((detail) => detail !== null && !/closed|quit/.test(detail))).toBe(true);
  });

  it("gives only done, needs-you, failed and lost a severity", () => {
    expect({
      done: lastRunWords(
        settled("done", { kind: "handback", report: "done", summary: null, truncated: false })
      ).severity,
      needsYou: lastRunWords(
        settled("needs-you", {
          kind: "handback",
          report: "needs-you",
          summary: null,
          truncated: false,
        })
      ).severity,
      lost: lastRunWords(settled("lost", { kind: "lost" })).severity,
      cancelled: lastRunWords(settled("cancelled", { kind: "cancel" })).severity,
      interrupted: lastRunWords(settled("interrupted", { kind: "interrupted" })).severity,
    }).toEqual({
      done: "success",
      needsYou: "warning",
      lost: "error",
      cancelled: null,
      interrupted: null,
    });
  });
});
