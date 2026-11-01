import { describe, expect, it } from "vitest";
import type { ScheduledRun, ScheduledRunEvidence } from "../../../../shared/types/scheduledRuns.js";
import { outcomeForEvidence } from "../../../../shared/utils/scheduledRuns.js";
import {
  describeScheduledRunAttention,
  scheduledRunAttention,
  type ScheduledRunAttention,
} from "../scheduledRunAttention.js";

function settledOn(evidence: ScheduledRunEvidence): ScheduledRun {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    createdAt: 1,
    terminalId: "terminal-1",
    terminalSpawnedAt: null,
    settlement: {
      state: "settled",
      settledAt: 2,
      outcome: outcomeForEvidence(evidence),
      evidence,
    },
    process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
    pane: { state: "none" },
    resume: null,
  };
}

describe("scheduledRunAttention", () => {
  it.each<[string, ScheduledRunEvidence, ScheduledRunAttention | null]>([
    [
      "a launch error",
      { kind: "launch-error", message: "spawn zsh ENOENT" },
      { kind: "launch-failed" },
    ],
    [
      "a PTY exit with a non-zero code",
      { kind: "exit", process: "pty", exitCode: 1, signal: null },
      { kind: "exited", process: "pty", exitCode: 1 },
    ],
    [
      "an agent exit with a non-zero code, signal and all",
      { kind: "exit", process: "agent", exitCode: 137, signal: 9 },
      { kind: "exited", process: "agent", exitCode: 137 },
    ],
    [
      "a needs-you handback",
      { kind: "handback", report: "needs-you", summary: "a label needs a call", truncated: false },
      { kind: "needs-you" },
    ],
    ["a clean exit", { kind: "exit", process: "pty", exitCode: 0, signal: null }, null],
    [
      "an exit ended by a signal alone",
      { kind: "exit", process: "pty", exitCode: 0, signal: 1 },
      null,
    ],
    [
      "an exit with nothing known",
      { kind: "exit", process: "pty", exitCode: null, signal: null },
      null,
    ],
    [
      "a done handback",
      { kind: "handback", report: "done", summary: null, truncated: false },
      null,
    ],
    ["a skip for overlap", { kind: "skip", reason: { kind: "overlap", openRunId: "run-0" } }, null],
    ["a skip for a missed occurrence", { kind: "skip", reason: { kind: "missed" } }, null],
    [
      "a failed precondition",
      { kind: "skip", reason: { kind: "precondition", exitCode: 1, signal: null } },
      null,
    ],
    ["a cancel", { kind: "cancel" }, null],
    ["a replacement", { kind: "replace", replacedByRunId: "run-2" }, null],
    ["a lost terminal", { kind: "lost" }, null],
    ["an interruption", { kind: "interrupted" }, null],
  ])("reads %s", (_name, evidence, expected) => {
    expect(scheduledRunAttention(settledOn(evidence))).toEqual(expected);
  });

  it("reads nothing from a run still open", () => {
    expect(
      scheduledRunAttention({ ...settledOn({ kind: "cancel" }), settlement: { state: "open" } })
    ).toBeNull();
  });
});

describe("describeScheduledRunAttention", () => {
  const names = { scheduleName: "Nightly triage", agentName: "Codex" };

  it("names the schedule and agent, and an exit's code", () => {
    expect(describeScheduledRunAttention({ kind: "launch-failed" }, names)).toEqual({
      title: "Scheduled run couldn't start",
      body: 'Codex didn\'t launch for "Nightly triage". Its history says why.',
    });
    expect(
      describeScheduledRunAttention({ kind: "exited", process: "pty", exitCode: 2 }, names).body
    ).toBe('Codex\'s terminal exited with code 2 during "Nightly triage".');
    expect(
      describeScheduledRunAttention({ kind: "exited", process: "agent", exitCode: 2 }, names).body
    ).toBe('Codex exited with code 2 during "Nightly triage".');
    expect(describeScheduledRunAttention({ kind: "needs-you" }, names)).toEqual({
      title: "Scheduled run needs you",
      body: 'Codex handed back "Nightly triage" for you to look at.',
    });
  });

  it("still reads when the schedule's name couldn't be read", () => {
    expect(
      describeScheduledRunAttention(
        { kind: "needs-you" },
        { scheduleName: null, agentName: "Codex" }
      ).body
    ).toBe("Codex handed back a scheduled run for you to look at.");
  });
});
