import { describe, expect, it } from "vitest";
import type { ScheduledRun } from "@shared/types/scheduledRuns";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { runAction, runDetail, workerWords } from "../runWords";

function assistantRun(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    createdAt: 1,
    terminalId: "terminal-1",
    terminalSpawnedAt: 2,
    settlement: {
      state: "settled",
      settledAt: 9,
      outcome: "done",
      evidence: { kind: "handback", report: "done", summary: null, truncated: false },
    },
    process: {
      agent: { state: "not-started" },
      pty: { state: "exited", startedAt: 2, exitedAt: 9, exitCode: 0, signal: null },
    },
    pane: { state: "none" },
    resume: {
      agentId: "claude",
      agentSessionId: "0b6e3f9c-0d3e-4a55-8a0e-4b6ad8d6e9a1",
      cwd: "/help-sessions/abc",
      worktreeId: null,
      agentLaunchFlags: [],
      agentModelId: null,
      agentPresetId: null,
    },
    assistant: true,
    workers: [],
    ...overrides,
  };
}

const context = { terminalExists: false, worktreeIds: new Set<string>() };

describe("an Assistant's run in the history (#16169)", () => {
  it("offers its conversation back by its exact id once its terminal is gone", () => {
    expect(runAction(assistantRun(), context)).toEqual({
      kind: "resume",
      sessionId: "0b6e3f9c-0d3e-4a55-8a0e-4b6ad8d6e9a1",
    });
  });

  it("says why when the Assistant's CLI can't be reopened in an Assistant tab", () => {
    const run = assistantRun({
      resume: { ...assistantRun().resume!, agentId: "copilot", agentSessionId: "s-1" },
    });
    expect(runAction(run, context)).toMatchObject({ kind: "none", label: "Can't resume" });
  });

  it("says a run skipped for full sessions was the sessions, not the schedule", () => {
    const run = assistantRun({
      terminalId: null,
      terminalSpawnedAt: null,
      process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
      resume: null,
      settlement: {
        state: "settled",
        settledAt: 9,
        outcome: "skipped",
        evidence: { kind: "skip", reason: { kind: "assistant-sessions-full" } },
      },
    });
    expect(runDetail(run)).toEqual({
      kind: "reason",
      text: `All ${MAX_ASSISTANT_SLOTS} of the project's Assistant sessions were in use`,
    });
  });

  it("words a worker by its agent, its machine and its project", () => {
    const worker = {
      terminalId: "t-1",
      hostId: null,
      hostName: null,
      projectId: "project-1",
      projectName: "Repo",
      agentId: "claude",
      observedAt: 3,
    };
    expect(workerWords(worker)).toBe("Claude on this machine, in Repo");
    expect(
      workerWords({
        ...worker,
        hostId: "studio",
        hostName: "Studio",
        agentId: null,
        projectName: null,
      })
    ).toBe("An agent on Studio, in project-1");
  });
});
