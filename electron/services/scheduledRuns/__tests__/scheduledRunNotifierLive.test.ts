import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule, ScheduledRun } from "../../../../shared/types/scheduledRuns.js";

const live = vi.hoisted(() => ({
  shutdown: null as unknown,
  settings: { enabled: true, soundEnabled: true, waitingSoundFile: "waiting.wav" } as Record<
    string,
    unknown
  >,
  quiet: false,
  muted: false,
  schedule: null as unknown,
  scheduleError: null as Error | null,
  onScheduleRead: null as (() => void) | null,
  scheduleReads: 0,
  show: vi.fn(),
  playFile: vi.fn(),
  open: vi.fn(),
}));

vi.mock("../../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => live.shutdown,
}));
vi.mock("../../../window/scheduledRunNotificationNavigation.js", () => ({
  openScheduledRunFromNotification: live.open,
}));
vi.mock("../../AgentNotificationService.js", () => ({
  agentNotificationService: { isSessionMuted: () => live.muted },
}));
vi.mock("../../NotificationService.js", () => ({
  notificationService: { showNativeNotification: live.show },
}));
vi.mock("../../SoundService.js", () => ({
  soundService: { playFile: live.playFile },
}));
vi.mock("../../../../shared/utils/quietHours.js", () => ({
  isScheduledQuietNow: () => live.quiet,
}));
vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getEffectiveNotificationSettings: () => live.settings,
    schedules: {
      get: async () => {
        live.scheduleReads++;
        live.onScheduleRead?.();
        if (live.scheduleError) throw live.scheduleError;
        return live.schedule;
      },
    },
  },
}));

import { notifyScheduledRunAttention } from "../scheduledRunNotifierLive.js";

const run: ScheduledRun = {
  id: "run-1",
  scheduleId: "schedule-1",
  projectId: "project-1",
  origin: { trigger: "scheduled", dueAt: 1, occurrenceKey: "k", coalesced: null },
  createdAt: 1,
  terminalId: "terminal-1",
  terminalSpawnedAt: 5,
  settlement: {
    state: "settled",
    settledAt: 9,
    outcome: "needs-you",
    evidence: {
      kind: "handback",
      report: "needs-you",
      summary: "SECRET agent words",
      truncated: false,
    },
  },
  process: { agent: { state: "not-started" }, pty: { state: "running", startedAt: 5 } },
  pane: { state: "none" },
  resume: {
    agentId: "codex",
    agentSessionId: null,
    cwd: "/repo",
    worktreeId: null,
    agentLaunchFlags: [],
    agentModelId: null,
    agentPresetId: null,
  },
};

const schedule = {
  id: "schedule-1",
  projectId: "project-1",
  name: "Nightly triage",
  launch: { agentId: "claude" },
} as unknown as Schedule;

beforeEach(() => {
  live.shutdown = null;
  live.settings = { enabled: true, soundEnabled: true, waitingSoundFile: "waiting.wav" };
  live.quiet = false;
  live.muted = false;
  live.schedule = schedule;
  live.scheduleError = null;
  live.onScheduleRead = null;
  live.scheduleReads = 0;
  live.show.mockReset();
  live.playFile.mockReset();
  live.open.mockReset();
});

describe("notifyScheduledRunAttention", () => {
  it("shows a local banner naming the schedule and the run's agent, with no agent text", async () => {
    await notifyScheduledRunAttention(run, { kind: "needs-you" });

    expect(live.show).toHaveBeenCalledTimes(1);
    const [title, body, options] = live.show.mock.calls[0];
    expect(title).toBe("Scheduled run needs you");
    expect(body).toContain('"Nightly triage"');
    expect(body).toContain("Codex");
    expect(`${title} ${body}`).not.toContain("SECRET");
    // No owning view: a remote Shell is never handed it.
    expect(options).not.toHaveProperty("ownerWebContentsId");
    expect(live.playFile).toHaveBeenCalledWith("waiting.wav");
  });

  it("opens the run's terminal on click, leaving the view to decide whether it has a pane", async () => {
    await notifyScheduledRunAttention(run, { kind: "needs-you" });
    live.show.mock.calls[0][2].onClick();
    expect(live.open).toHaveBeenLastCalledWith({
      projectId: "project-1",
      scheduleId: "schedule-1",
      runId: "run-1",
      terminalId: "terminal-1",
    });

    // A failed spawn can leave an error pane holding the run, so its id goes too.
    const failedSpawn: ScheduledRun = {
      ...run,
      terminalId: "terminal-7",
      settlement: {
        state: "settled",
        settledAt: 9,
        outcome: "failed",
        evidence: { kind: "launch-error", message: "spawn zsh ENOENT" },
      },
    };
    await notifyScheduledRunAttention(failedSpawn, { kind: "launch-failed" });
    live.show.mock.calls[1][2].onClick();
    expect(live.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalId: "terminal-7" })
    );
    expect(live.show.mock.calls[1][1]).not.toContain("ENOENT");
  });

  it("names the schedule's agent for a refused launch with no resume snapshot", async () => {
    await notifyScheduledRunAttention({ ...run, resume: null }, { kind: "launch-failed" });
    expect(live.show.mock.calls[0][1]).toContain("Claude");
  });

  it("still notifies when the schedule can't be read", async () => {
    live.scheduleError = new Error("schedules.json unreadable");
    await notifyScheduledRunAttention({ ...run, resume: null }, { kind: "launch-failed" });
    expect(live.show).toHaveBeenCalledTimes(1);
    expect(live.show.mock.calls[0][1]).toContain("a scheduled run");
  });

  const holdBacks: Array<[string, () => void]> = [
    ["notifications are off", () => (live.settings = { ...live.settings, enabled: false })],
    ["it is quiet hours", () => (live.quiet = true)],
    ["the session is muted", () => (live.muted = true)],
    ["Daintree is quitting", () => (live.shutdown = { phase: "running" })],
  ];

  it.each(holdBacks)(
    "holds the banner and its sound back when %s, without reading the schedule",
    async (_name, arrange) => {
      arrange();
      await notifyScheduledRunAttention(run, { kind: "needs-you" });
      expect(live.scheduleReads).toBe(0);
      expect(live.show).not.toHaveBeenCalled();
      expect(live.playFile).not.toHaveBeenCalled();
    }
  );

  it.each(holdBacks)("holds it back when %s while the schedule is read", async (_name, arrange) => {
    live.onScheduleRead = arrange;
    await notifyScheduledRunAttention(run, { kind: "needs-you" });
    expect(live.scheduleReads).toBe(1);
    expect(live.show).not.toHaveBeenCalled();
    expect(live.playFile).not.toHaveBeenCalled();
  });

  it("shows the banner without a sound when sounds are off", async () => {
    live.settings = { ...live.settings, soundEnabled: false };
    await notifyScheduledRunAttention(run, { kind: "exited", process: "pty", exitCode: 1 });
    expect(live.show).toHaveBeenCalledTimes(1);
    expect(live.playFile).not.toHaveBeenCalled();
  });
});
