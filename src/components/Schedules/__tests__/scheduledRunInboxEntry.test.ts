import { describe, expect, it } from "vitest";
import type { ScheduledRun } from "@shared/types/scheduledRuns";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { machineTimeZone } from "@shared/utils/cron";
import { formatRunInstant } from "../scheduleWords";
import { scheduledRunInboxEntry, scheduledRunInboxEntryId } from "../scheduledRunInboxEntry";

const NOW = Date.UTC(2026, 10, 1, 9);
const STARTED = Date.UTC(2026, 10, 1, 2);
const SETTLED = STARTED + 20 * 60_000;
const ZONE = "Asia/Tokyo";

const DONE: ScheduledRun = {
  id: "run-1",
  scheduleId: "schedule-1",
  projectId: "project-1",
  origin: {
    trigger: "scheduled",
    dueAt: STARTED,
    occurrenceKey: new Date(STARTED).toISOString(),
    coalesced: null,
  },
  createdAt: STARTED,
  terminalId: "terminal-1",
  terminalSpawnedAt: STARTED,
  settlement: {
    state: "settled",
    settledAt: SETTLED,
    outcome: "done",
    evidence: { kind: "handback", report: "done", summary: "Triaged six issues", truncated: false },
  },
  process: {
    agent: { state: "not-started" },
    pty: { state: "running", startedAt: STARTED },
  },
  pane: { state: "none" },
  resume: {
    agentId: "claude",
    agentSessionId: "session-1",
    cwd: "/repo/wt",
    worktreeId: "/repo/wt",
    agentLaunchFlags: [],
    agentModelId: null,
    agentPresetId: null,
  },
};

const REFUSED: ScheduledRun = {
  ...DONE,
  id: "run-2",
  terminalId: "terminal-2",
  terminalSpawnedAt: null,
  settlement: {
    state: "settled",
    settledAt: STARTED,
    outcome: "failed",
    evidence: { kind: "launch-error", message: "The worktree is gone." },
  },
  process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
  resume: null,
};

const schedule = { name: "Nightly triage", timeZone: ZONE };

describe("scheduledRunInboxEntry", () => {
  it("files a run under its schedule, unread, as of when it settled, keyed by the run", () => {
    const entry = scheduledRunInboxEntry({ run: DONE, schedule }, NOW);
    expect(entry).toMatchObject({
      id: scheduledRunInboxEntryId("run-1"),
      type: "success",
      title: "Nightly triage",
      timestamp: SETTLED,
      seenAsToast: false,
      countable: true,
      archivedAt: null,
    });
    expect(scheduledRunInboxEntryId("run-1")).not.toBe(scheduledRunInboxEntryId("run-2"));
  });

  it("says the outcome, when it started in the schedule's zone, and the agent's summary as its own", () => {
    const message = scheduledRunInboxEntry({ run: DONE, schedule }, NOW)?.message ?? "";
    const agentName = getEffectiveAgentConfig("claude")?.name ?? "claude";
    expect(message.startsWith("Done")).toBe(true);
    expect(message).toContain(`started ${formatRunInstant(STARTED, ZONE, NOW)}`);
    expect(message).toContain(`${agentName}: Triaged six issues`);
  });

  it("points at the run's terminal and worktree, with its history a click away", () => {
    const entry = scheduledRunInboxEntry({ run: DONE, schedule }, NOW);
    expect(entry?.context).toEqual({
      projectId: "project-1",
      worktreeId: "/repo/wt",
      panelId: "terminal-1",
      eventKind: "agent",
    });
    expect(entry?.actions).toEqual([
      {
        label: "View history",
        actionId: "schedules.open",
        actionArgs: { scheduleId: "schedule-1", projectId: "project-1" },
      },
    ]);
  });

  it("names no terminal for a launch that never started, and says when it was due and why", () => {
    const entry = scheduledRunInboxEntry({ run: REFUSED, schedule }, NOW);
    expect(entry?.type).toBe("error");
    expect(entry?.context).toEqual({ projectId: "project-1", eventKind: "agent" });
    expect(entry?.message).toContain("Failed to launch");
    expect(entry?.message).toContain(`due ${formatRunInstant(STARTED, ZONE, NOW)}`);
    expect(entry?.message).toContain("The worktree is gone");
  });

  it("reads a schedule that's gone in this machine's zone, with no history to open", () => {
    const entry = scheduledRunInboxEntry({ run: DONE, schedule: null }, NOW);
    expect(entry?.title).toBe("Scheduled run");
    expect(entry?.actions).toBeUndefined();
    expect(entry?.message).toContain(formatRunInstant(STARTED, machineTimeZone(), NOW));
  });

  it("files nothing for a run that hasn't settled", () => {
    expect(
      scheduledRunInboxEntry({ run: { ...DONE, settlement: { state: "open" } }, schedule }, NOW)
    ).toBeNull();
  });
});
