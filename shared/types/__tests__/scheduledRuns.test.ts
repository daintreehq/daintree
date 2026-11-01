import { describe, expect, it } from "vitest";
import { createSchedule, occurrenceKeyFor } from "../../utils/scheduledRuns.js";
import { ScheduleSchema, ScheduledRunSchema, type ScheduledRun } from "../scheduledRuns.js";

const NOW = Date.parse("2026-06-02T02:00:00Z");
const DUE = Date.parse("2026-06-02T02:00:00Z");

function schedule() {
  return createSchedule(
    {
      id: "schedule-1",
      projectId: "project-1",
      name: "Nightly",
      launch: { agentId: "claude", prompt: "Triage" },
      timeZone: "UTC",
    },
    NOW
  );
}

function registered(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: {
      trigger: "scheduled",
      dueAt: DUE,
      occurrenceKey: occurrenceKeyFor(DUE),
      coalesced: null,
    },
    createdAt: NOW,
    terminalId: null,
    terminalSpawnedAt: null,
    settlement: { state: "open" },
    process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
    pane: { state: "none" },
    resume: null,
    ...overrides,
  };
}

function issues(value: unknown): string[] {
  const result = ScheduledRunSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("ScheduleSchema", () => {
  it("carries the cron parser's reason for a bad cadence", () => {
    const result = ScheduleSchema.safeParse({
      ...schedule(),
      cadence: { cron: "0 0 30 2 *", timeZone: "UTC" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["cadence", "cron"]);
    expect(result.error?.issues[0]?.message).toMatch(/never runs/);
  });

  it("refuses an unknown zone, a blank name or prompt, and unknown policies", () => {
    const base = schedule();
    expect(
      ScheduleSchema.safeParse({ ...base, cadence: { ...base.cadence, timeZone: " UTC " } }).success
    ).toBe(false);
    expect(
      ScheduleSchema.safeParse({ ...base, cadence: { ...base.cadence, timeZone: "Nowhere/Here" } })
        .success
    ).toBe(false);
    expect(ScheduleSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(
      ScheduleSchema.safeParse({ ...base, launch: { ...base.launch, prompt: " \n" } }).success
    ).toBe(false);
    expect(
      ScheduleSchema.safeParse({ ...base, policies: { ...base.policies, overlap: "queue" } })
        .success
    ).toBe(false);
    expect(
      ScheduleSchema.safeParse({
        ...base,
        policies: { ...base.policies, precondition: { command: "" } },
      }).success
    ).toBe(false);
  });

  it("refuses a record with a field missing rather than filling a default", () => {
    const { policies, ...rest } = schedule();
    const { runWhenClosed: _dropped, ...partialPolicies } = policies;
    expect(ScheduleSchema.safeParse({ ...rest, policies: partialPolicies }).success).toBe(false);
  });
});

describe("ScheduledRunSchema", () => {
  it("accepts a run registered before anything spawns", () => {
    expect(issues(registered())).toEqual([]);
  });

  it("keeps settlement, process exit and pane close apart", () => {
    // Settled on the agent's marker while its PTY still runs and the pane stays open.
    const settledRunning = registered({
      terminalId: "terminal-1",
      settlement: {
        state: "settled",
        settledAt: NOW + 60_000,
        outcome: "done",
        evidence: { kind: "handback", report: "done" },
      },
      process: {
        agent: { state: "running", startedAt: NOW + 1_000 },
        pty: { state: "running", startedAt: NOW },
      },
      pane: { state: "open", since: NOW },
    });
    expect(issues(settledRunning)).toEqual([]);

    // The agent exits to its shell, then the pane closes: settlement doesn't move.
    const closedLater = registered({
      ...settledRunning,
      process: {
        agent: {
          state: "exited",
          startedAt: NOW + 1_000,
          exitedAt: NOW + 120_000,
          exitCode: null,
          signal: null,
        },
        pty: { state: "running", startedAt: NOW },
      },
      pane: { state: "closed", closedAt: NOW + 180_000 },
    });
    expect(issues(closedLater)).toEqual([]);
  });

  it("records a skipped occurrence with its reason and nothing launched", () => {
    const skipped = registered({
      settlement: {
        state: "settled",
        settledAt: NOW,
        outcome: "skipped",
        evidence: {
          kind: "skip",
          reason: { kind: "precondition", exitCode: 1, signal: null, error: null },
        },
      },
    });
    expect(issues(skipped)).toEqual([]);
    // Registration can reserve a terminal id before the precondition runs.
    expect(issues({ ...skipped, terminalId: "terminal-1" })).toEqual([]);
    const launched = "a skipped run never launches";
    expect(
      issues({ ...skipped, terminalId: "terminal-1", pane: { state: "open", since: NOW } })
    ).toContain(launched);
    expect(
      issues({
        ...skipped,
        process: { ...skipped.process, agent: { state: "running", startedAt: NOW } },
      })
    ).toContain(launched);
    expect(
      issues({
        ...skipped,
        process: { ...skipped.process, pty: { state: "running", startedAt: NOW } },
      })
    ).toContain(launched);
  });

  it("gives a skipped run nothing to resume", () => {
    const skipped = registered({
      settlement: {
        state: "settled",
        settledAt: NOW,
        outcome: "skipped",
        evidence: { kind: "skip", reason: { kind: "overlap", openRunId: "run-0" } },
      },
      resume: {
        agentId: "claude",
        agentSessionId: "session-1",
        cwd: "/repo",
        worktreeId: null,
        agentLaunchFlags: [],
        agentModelId: null,
        agentPresetId: null,
      },
    });
    expect(issues(skipped)).toContain("a skipped run has nothing to resume");
  });

  it("stores no signal as null, never 0", () => {
    const run = registered({
      terminalId: "terminal-1",
      settlement: {
        state: "settled",
        settledAt: NOW,
        outcome: "done",
        evidence: { kind: "exit", process: "pty", exitCode: 0, signal: null },
      },
    });
    expect(issues(run)).toEqual([]);
    expect(
      ScheduledRunSchema.safeParse({
        ...run,
        settlement: {
          ...run.settlement,
          evidence: { kind: "exit", process: "pty", exitCode: 0, signal: 0 },
        },
      }).success
    ).toBe(false);
  });

  it("reports a due time outside Date's range instead of throwing", () => {
    for (const dueAt of [8_640_000_000_000_001, -8_640_000_000_000_001]) {
      const run = registered({
        origin: { trigger: "scheduled", dueAt, occurrenceKey: "x", coalesced: null },
      });
      expect(() => ScheduledRunSchema.safeParse(run)).not.toThrow();
      expect(ScheduledRunSchema.safeParse(run).success).toBe(false);
    }
  });

  it("refuses a precondition skip whose command passed", () => {
    const run = registered({
      settlement: {
        state: "settled",
        settledAt: NOW,
        outcome: "skipped",
        evidence: {
          kind: "skip",
          reason: { kind: "precondition", exitCode: 0, signal: null, error: null },
        },
      },
    });
    expect(issues(run)).toContain("a precondition that exited 0 passed");
  });

  it("refuses an outcome the evidence doesn't support", () => {
    const run = registered({
      settlement: {
        state: "settled",
        settledAt: NOW,
        outcome: "done",
        evidence: { kind: "exit", process: "pty", exitCode: 1, signal: null },
      },
    });
    expect(issues(run)).toContain("outcome must follow from the evidence");
  });

  it("ties the occurrence key to the due time", () => {
    const run = registered({
      origin: {
        trigger: "scheduled",
        dueAt: DUE,
        occurrenceKey: occurrenceKeyFor(DUE + 60_000),
        coalesced: null,
      },
    });
    expect(issues(run)).toContain("occurrenceKey must be occurrenceKeyFor(dueAt)");
  });

  it("requires a catch-up run to name the window it stands for, around its due time", () => {
    const window = { after: DUE - 3 * 86_400_000, through: DUE + 3_600_000 };
    const catchUp = registered({
      origin: {
        trigger: "catch-up",
        dueAt: DUE,
        occurrenceKey: occurrenceKeyFor(DUE),
        coalesced: window,
      },
    });
    expect(issues(catchUp)).toEqual([]);
    expect(
      issues({ ...catchUp, origin: { ...catchUp.origin, coalesced: null } }).length
    ).toBeGreaterThan(0);
    const outside = "dueAt must fall in (after, through]";
    expect(
      issues({ ...catchUp, origin: { ...catchUp.origin, coalesced: { ...window, after: DUE } } })
    ).toContain(outside);
    expect(
      issues({
        ...catchUp,
        origin: { ...catchUp.origin, coalesced: { ...window, through: DUE - 1 } },
      })
    ).toContain(outside);
    expect(
      issues({ ...catchUp, origin: { ...catchUp.origin, coalesced: { ...window, through: DUE } } })
    ).toEqual([]);
  });

  it("gives a run-now run no occurrence, and never a missed skip", () => {
    const runNow = registered({
      origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    });
    expect(issues(runNow)).toEqual([]);
    expect(
      issues({ ...runNow, origin: { ...runNow.origin, occurrenceKey: "2026-06-02T02:00:00.000Z" } })
        .length
    ).toBeGreaterThan(0);
    expect(
      issues({
        ...runNow,
        settlement: {
          state: "settled",
          settledAt: NOW,
          outcome: "skipped",
          evidence: { kind: "skip", reason: { kind: "missed" } },
        },
      })
    ).toContain("only an occurrence can be missed");
  });

  it("needs a terminal id for a matched incarnation", () => {
    expect(issues(registered({ terminalSpawnedAt: NOW }))).toContain(
      "an incarnation needs its terminal id"
    );
    expect(issues(registered({ terminalId: "terminal-1", terminalSpawnedAt: NOW }))).toEqual([]);
  });

  it("needs a terminal id once there's a pane", () => {
    expect(issues(registered({ pane: { state: "open", since: NOW } }))).toContain(
      "a pane needs its terminal id"
    );
  });

  it("accepts a resume snapshot whose session id isn't captured yet", () => {
    const run = registered({
      terminalId: "terminal-1",
      resume: {
        agentId: "claude",
        agentSessionId: null,
        cwd: "/repo",
        worktreeId: null,
        agentLaunchFlags: ["--model", "opus"],
        agentModelId: null,
        agentPresetId: null,
      },
    });
    expect(issues(run)).toEqual([]);
  });
});
