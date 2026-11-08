import { describe, expect, it } from "vitest";
import type { ScheduledRun } from "@shared/types/scheduledRuns";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { runAction, runDetail, runWorktreeNote, workerWords } from "../runWords";

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
  it("only opens a run whose Assistant still runs, taken over by this view or not", () => {
    const running = assistantRun({
      settlement: { state: "open" },
      process: { agent: { state: "not-started" }, pty: { state: "running", startedAt: 2 } },
    });
    expect(runAction(running, context)).toEqual({ kind: "open" });
    expect(runAction(running, { ...context, terminalExists: true })).toEqual({ kind: "open" });
  });

  it("points an ended run to the Assistant's past sessions rather than reopening it here", () => {
    // Reopened from here, it could land in a tab whose Assistant this view hasn't taken over.
    for (const agentId of ["claude", "copilot"]) {
      const run = assistantRun({ resume: { ...assistantRun().resume!, agentId } });
      expect(runAction(run, context)).toMatchObject({ kind: "none", label: "In past sessions" });
    }
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

describe("runAction: a run in its own new worktree (#16369)", () => {
  const resume = {
    agentId: "claude",
    agentSessionId: "0b6e3f9c-0d3e-4a55-8a0e-4b6ad8d6e9a1",
    cwd: "/wt/new",
    worktreeId: "/wt/new",
    agentLaunchFlags: [],
    agentModelId: null,
    agentPresetId: null,
  };
  const newWorktree = { branch: "schedule-x", baseBranch: "main", worktreeId: "/wt/new" };
  const run = (overrides: Partial<ScheduledRun>) =>
    assistantRun({ assistant: undefined, resume, newWorktree, ...overrides });

  it("opens the terminal while it's there, and resumes in the run's worktree after", () => {
    expect(runAction(run({}), { terminalExists: true, worktreeIds: new Set() })).toEqual({
      kind: "open",
    });
    expect(
      runAction(run({}), { terminalExists: false, worktreeIds: new Set(["/wt/new"]) })
    ).toEqual({ kind: "resume", sessionId: resume.agentSessionId });
  });

  it("says its worktree was removed once it's been deleted", () => {
    expect(runAction(run({}), { terminalExists: false, worktreeIds: new Set() })).toMatchObject({
      kind: "none",
      label: "Worktree removed",
    });
  });

  it("can't tell a worktree is gone before the project's worktrees have loaded", () => {
    expect(runAction(run({}), { terminalExists: false, worktreeIds: null })).toEqual({
      kind: "resume",
      sessionId: resume.agentSessionId,
    });
  });

  it("offers no conversation for a run refused with its worktree left standing", () => {
    const refused = run({
      resume: null,
      terminalId: null,
      terminalSpawnedAt: null,
      process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
      settlement: {
        state: "settled",
        settledAt: 9,
        outcome: "failed",
        evidence: { kind: "launch-error", message: "The setup failed." },
      },
    });

    expect(
      runAction(refused, { terminalExists: false, worktreeIds: new Set(["/wt/new"]) })
    ).toMatchObject({ kind: "none", label: null });
  });
});

describe("runWorktreeNote (#16406)", () => {
  const newWorktree = { branch: "schedule-x", baseBranch: "main", worktreeId: "/wt/new" };
  const run = (overrides: Partial<ScheduledRun>) =>
    assistantRun({ assistant: undefined, resume: null, newWorktree, ...overrides });

  it("names the branch while the worktree is still there", () => {
    expect(runWorktreeNote(run({}), new Set(["/wt/new"]))).toEqual({
      branch: "schedule-x",
      removed: false,
    });
  });

  it("says it's gone once the worktrees are known and it isn't among them, with or without a session", () => {
    expect(runWorktreeNote(run({}), new Set(["/wt/other"]))).toEqual({
      branch: "schedule-x",
      removed: true,
    });
    expect(runWorktreeNote(run({}), new Set())).toMatchObject({ removed: true });
  });

  it("claims nothing removed before the worktrees have loaded", () => {
    expect(runWorktreeNote(run({}), null)).toEqual({ branch: "schedule-x", removed: false });
  });

  it("names nothing for a run whose worktree was never made, or any other schedule's run", () => {
    expect(
      runWorktreeNote(
        run({ newWorktree: { branch: "schedule-x", baseBranch: "main", worktreeId: null } }),
        new Set()
      )
    ).toBeNull();
    expect(runWorktreeNote(run({ newWorktree: undefined }), new Set())).toBeNull();
  });
});
