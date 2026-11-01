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
      { kind: "skip", reason: { kind: "precondition", exitCode: 1, signal: null, error: null } },
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
  const kinds: ScheduledRunAttention[] = [
    { kind: "launch-failed" },
    { kind: "exited", process: "pty", exitCode: 2 },
    { kind: "needs-you" },
  ];

  it("gives each reason its own title", () => {
    const names = { scheduleName: "Nightly triage", agentName: "Codex" };
    const titles = kinds.map((attention) => describeScheduledRunAttention(attention, names).title);
    expect(new Set(titles).size).toBe(kinds.length);
  });

  it.each([
    ["Nightly triage", "Codex"],
    ["Weekly deps", "Claude"],
  ])("names %s and %s in every body", (scheduleName, agentName) => {
    for (const attention of kinds) {
      const { title, body } = describeScheduledRunAttention(attention, { scheduleName, agentName });
      expect(body).toContain(`"${scheduleName}"`);
      expect(body).toContain(agentName);
      expect(body).not.toContain(title);
    }
  });

  it("says which process exited, with its code", () => {
    const names = { scheduleName: "Nightly triage", agentName: "Codex" };
    const pty = describeScheduledRunAttention(
      { kind: "exited", process: "pty", exitCode: 3 },
      names
    ).body;
    const agent = describeScheduledRunAttention(
      { kind: "exited", process: "agent", exitCode: 127 },
      names
    ).body;
    expect(pty).toContain("terminal");
    expect(pty).toContain("code 3");
    expect(agent).not.toContain("terminal");
    expect(agent).toContain("code 127");
  });

  it("still reads when the schedule's name couldn't be read", () => {
    for (const attention of kinds) {
      const { body } = describeScheduledRunAttention(attention, {
        scheduleName: null,
        agentName: "Codex",
      });
      expect(body).toContain("a scheduled run");
      expect(body).not.toContain("null");
      expect(body).not.toContain('""');
    }
  });
});
