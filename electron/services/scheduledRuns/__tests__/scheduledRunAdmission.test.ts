import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRunResume } from "../../../../shared/types/scheduledRuns.js";
import {
  _resetScheduledRunAdmissionForTest,
  admitScheduledSpawn,
  cancelScheduledLaunches,
  hasPendingScheduledLaunch,
  reserveScheduledLaunch,
  type ScheduledLaunchReservation,
  type ScheduledSpawn,
} from "../scheduledRunAdmission.js";

afterEach(() => {
  _resetScheduledRunAdmissionForTest();
});

function reservation(
  admit: (resume: ScheduledRunResume) => void = () => {}
): ScheduledLaunchReservation {
  return {
    runId: "run-1",
    scheduleId: "schedule-1",
    projectId: "project-1",
    terminalId: "terminal-1",
    agentId: "claude",
    admit,
  };
}

function spawn(overrides: Partial<ScheduledSpawn> = {}): ScheduledSpawn {
  return {
    terminalId: "terminal-1",
    projectId: "project-1",
    scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
    launchAgentId: "claude",
    requestedCwd: "/repo/wt",
    cwd: "/repo/wt",
    worktreeId: "/repo/wt",
    agentLaunchFlags: ["--model", "opus"],
    agentModelId: "opus",
    agentPresetId: "preset-1",
    agentSessionId: "0b6e3f9c-0d3e-4a55-8a0e-4b6ad8d6e9a1",
    ...overrides,
  };
}

describe("scheduled run admission", () => {
  it("registers the run from the spawn's own values, once", async () => {
    const admit = vi.fn();
    const reserved = reserveScheduledLaunch(reservation(admit));
    expect(hasPendingScheduledLaunch("project-1")).toBe(true);

    admitScheduledSpawn(spawn());

    expect(admit).toHaveBeenCalledWith({
      agentId: "claude",
      agentSessionId: "0b6e3f9c-0d3e-4a55-8a0e-4b6ad8d6e9a1",
      cwd: "/repo/wt",
      worktreeId: "/repo/wt",
      agentLaunchFlags: ["--model", "opus"],
      agentModelId: "opus",
      agentPresetId: "preset-1",
    });
    await expect(reserved.admitted).resolves.toBeUndefined();
    expect(reserved.state()).toEqual({ kind: "registered" });
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);

    // A restart of the run's pane names the run too, and spawns as any pane does.
    admitScheduledSpawn(spawn());
    expect(admit).toHaveBeenCalledTimes(1);
    expect(reserved.giveUp()).toBe(false);
  });

  it("fills what the spawn left out as null, never as a guess", () => {
    const admit = vi.fn();
    reserveScheduledLaunch(reservation(admit));
    admitScheduledSpawn(
      spawn({
        worktreeId: undefined,
        agentLaunchFlags: undefined,
        agentModelId: undefined,
        agentPresetId: undefined,
        agentSessionId: undefined,
      })
    );
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: null,
        agentLaunchFlags: [],
        agentModelId: null,
        agentPresetId: null,
        agentSessionId: null,
      })
    );
  });

  it("refuses the spawn when registering refuses, and tells the launcher why", async () => {
    const reserved = reserveScheduledLaunch(
      reservation(() => {
        throw new Error("The schedule's preset isn't available any more.");
      })
    );

    expect(() => admitScheduledSpawn(spawn())).toThrow(/preset isn't available/);
    await expect(reserved.admitted).rejects.toThrow(/preset isn't available/);
    expect(reserved.state()).toEqual({
      kind: "refused",
      message: "The schedule's preset isn't available any more.",
    });
  });

  it.each([
    ["terminal", { terminalId: "terminal-other" }],
    ["schedule", { scheduledRun: { scheduleId: "schedule-other", runId: "run-1" } }],
    ["project", { projectId: "project-other" }],
    ["agent", { launchAgentId: "codex" }],
  ] as const)("refuses a spawn that names the run with another %s", (_what, overrides) => {
    const admit = vi.fn();
    const reserved = reserveScheduledLaunch(reservation(admit));

    expect(() => admitScheduledSpawn(spawn(overrides))).toThrow(/isn't the one/);
    expect(admit).not.toHaveBeenCalled();
    expect(reserved.state().kind).toBe("refused");
  });

  it("refuses a spawn that fell back from the directory it was asked to start in", () => {
    const admit = vi.fn();
    const reserved = reserveScheduledLaunch(reservation(admit));

    expect(() => admitScheduledSpawn(spawn({ requestedCwd: "/repo/gone", cwd: "/repo" }))).toThrow(
      /working directory is missing/
    );
    expect(admit).not.toHaveBeenCalled();
    expect(reserved.state()).toEqual({
      kind: "refused",
      message: "The run's working directory is missing.",
    });
  });

  it("passes spawns that name no reserved run", () => {
    const admit = vi.fn();
    reserveScheduledLaunch(reservation(admit));

    admitScheduledSpawn(spawn({ scheduledRun: undefined }));
    admitScheduledSpawn(spawn({ scheduledRun: { scheduleId: "schedule-1", runId: "run-9" } }));

    expect(admit).not.toHaveBeenCalled();
    expect(hasPendingScheduledLaunch("project-1")).toBe(true);
  });

  it("refuses the first late spawn of a run given up on, and only that one", async () => {
    const admit = vi.fn();
    const reserved = reserveScheduledLaunch(reservation(admit));

    expect(reserved.giveUp()).toBe(true);
    expect(reserved.giveUp()).toBe(false);
    await expect(reserved.admitted).rejects.toThrow();
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);

    expect(() => admitScheduledSpawn(spawn())).toThrow(/given up/);
    // The user restarting the failed pane by hand still gets a terminal.
    expect(() => admitScheduledSpawn(spawn())).not.toThrow();
    expect(admit).not.toHaveBeenCalled();
  });

  it("keeps refusing the late spawn however many other launches are given up meanwhile", () => {
    const reserved = reserveScheduledLaunch(reservation());
    reserved.giveUp();
    for (let i = 0; i < 200; i++) {
      reserveScheduledLaunch({ ...reservation(), runId: `run-other-${i}` }).giveUp();
    }

    expect(() => admitScheduledSpawn(spawn())).toThrow(/given up/);
  });

  it("withdraws a launch that was never asked for without refusing anything later", () => {
    const admit = vi.fn();
    const reserved = reserveScheduledLaunch(reservation(admit));

    expect(reserved.withdraw()).toBe(true);
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);
    expect(() => admitScheduledSpawn(spawn())).not.toThrow();
    expect(admit).not.toHaveBeenCalled();
  });

  it("cancels the launches of a removed schedule or project, and refuses their spawn", async () => {
    const admit = vi.fn();
    const ofSchedule = reserveScheduledLaunch(reservation(admit));
    const ofOtherSchedule = reserveScheduledLaunch({
      ...reservation(admit),
      runId: "run-2",
      scheduleId: "schedule-2",
      terminalId: "terminal-2",
    });
    const ofOtherProject = reserveScheduledLaunch({
      ...reservation(admit),
      runId: "run-3",
      scheduleId: "schedule-3",
      projectId: "project-2",
      terminalId: "terminal-3",
    });

    cancelScheduledLaunches({ scheduleId: "schedule-1" });
    expect(ofSchedule.state()).toEqual({ kind: "cancelled" });
    await expect(ofSchedule.admitted).rejects.toThrow();
    expect(ofOtherSchedule.state().kind).toBe("pending");
    expect(() => admitScheduledSpawn(spawn())).toThrow(/given up/);

    cancelScheduledLaunches({ projectId: "project-1" });
    expect(ofOtherSchedule.state()).toEqual({ kind: "cancelled" });
    expect(ofOtherProject.state().kind).toBe("pending");
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);
    expect(hasPendingScheduledLaunch("project-2")).toBe(true);
    expect(ofSchedule.giveUp()).toBe(false);
    expect(admit).not.toHaveBeenCalled();
  });

  it("refuses a second reservation of the same run", () => {
    reserveScheduledLaunch(reservation());
    expect(() => reserveScheduledLaunch(reservation())).toThrow(/already reserved/);
  });
});
