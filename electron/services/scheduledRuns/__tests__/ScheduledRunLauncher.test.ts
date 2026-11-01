import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";
import type { Project } from "../../../../shared/types/project.js";
import type { Schedule, ScheduledRun } from "../../../../shared/types/scheduledRuns.js";
import { createSchedule } from "../../../../shared/utils/scheduledRuns.js";
import {
  launchScheduledRun,
  ScheduledLaunchUnansweredError,
  type ScheduledLaunchRequest,
  type ScheduledRunLauncherDeps,
} from "../ScheduledRunLauncher.js";
import type { ScheduledRunRecorder } from "../ScheduledRunRecorder.js";
import {
  _resetScheduledRunAdmissionForTest,
  admitScheduledSpawn,
  cancelScheduledLaunches,
  hasPendingScheduledLaunch,
} from "../scheduledRunAdmission.js";

const RUN_NOW = { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null } as const;
const SESSION_ID = "0b6e3f9c-0d3e-4a55-8a0e-4b6ad8d6e9a1";

interface FakeView {
  id: number;
}

let ids: number;
let recorder: {
  registerLaunch: ReturnType<typeof vi.fn>;
  registerRefusedLaunch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
};
let schedule: Schedule;
let project: Project;
let deps: ScheduledRunLauncherDeps<FakeView>;

function launched(terminalId = "terminal-id-2"): ActionDispatchResult {
  return { ok: true, result: { launched: true, terminalId, spawnStatus: null } };
}

/** What the spawn handler does when the launch reaches it: starts in the worktree, else the root. */
function spawnFor(request: ScheduledLaunchRequest, overrides: Record<string, unknown> = {}): void {
  const cwd = request.args.worktreeId || "/repo";
  admitScheduledSpawn({
    terminalId: request.args.requestedId,
    projectId: "project-1",
    scheduledRun: request.scheduledRun,
    launchAgentId: request.args.agentId,
    requestedCwd: cwd,
    cwd,
    worktreeId: request.args.worktreeId || undefined,
    agentLaunchFlags: ["--model", "opus"],
    agentModelId: "opus",
    agentPresetId: request.args.presetId ?? undefined,
    agentSessionId: SESSION_ID,
    ...overrides,
  });
}

beforeEach(() => {
  ids = 0;
  recorder = {
    registerLaunch: vi.fn(),
    registerRefusedLaunch: vi.fn(),
    get: vi.fn(),
    settle: vi.fn(),
  };
  schedule = createSchedule(
    {
      id: "schedule-1",
      projectId: "project-1",
      name: "Nightly triage",
      launch: { agentId: "claude", prompt: "Triage the new issues.\n" },
    },
    Date.UTC(2026, 10, 1)
  );
  project = { id: "project-1", path: "/repo", name: "Repo", status: "active" } as Project;
  deps = {
    getRecorder: async () => recorder as unknown as ScheduledRunRecorder,
    getSchedule: async (_projectId, scheduleId) => (scheduleId === schedule.id ? schedule : null),
    getProject: (projectId) => (projectId === project.id ? project : null),
    folderExists: async () => true,
    isProjectSleeping: () => false,
    markProjectRunning: vi.fn(),
    findView: () => ({ id: 7 }),
    launchInView: vi.fn(async (_view, request) => {
      spawnFor(request);
      return launched(request.args.requestedId);
    }),
    launchWithoutView: vi.fn(async (_project, request) => {
      spawnFor(request);
      return launched(request.args.requestedId);
    }),
    newId: () => `id-${++ids}`,
    spawnTimeoutMs: 20,
    logWarn: () => {},
  };
});

afterEach(() => {
  _resetScheduledRunAdmissionForTest();
});

const run = (preferredWebContentsId?: number) =>
  launchScheduledRun(
    {
      projectId: "project-1",
      scheduleId: "schedule-1",
      origin: RUN_NOW,
      ...(preferredWebContentsId !== undefined ? { preferredWebContentsId } : {}),
    },
    deps
  );

describe("launchScheduledRun", () => {
  it("launches in the view showing the project, registering the run at the spawn", async () => {
    const findView = vi.fn(() => ({ id: 7 }));
    deps.findView = findView;

    await expect(run(7)).resolves.toEqual({
      status: "started",
      runId: "id-1",
      terminalId: "terminal-id-2",
    });

    expect(findView).toHaveBeenCalledWith("project-1", 7);
    expect(deps.launchInView).toHaveBeenCalledWith(
      { id: 7 },
      {
        args: {
          agentId: "claude",
          prompt: "Triage the new issues.\n",
          handback: true,
          presetId: null,
          worktreeId: "",
          location: "grid",
          focusPolicy: "preserve",
          requestedId: "terminal-id-2",
        },
        scheduledRun: { scheduleId: "schedule-1", runId: "id-1" },
      }
    );
    expect(deps.launchWithoutView).not.toHaveBeenCalled();
    expect(recorder.registerLaunch).toHaveBeenCalledWith({
      id: "id-1",
      scheduleId: "schedule-1",
      projectId: "project-1",
      origin: RUN_NOW,
      terminalId: "terminal-id-2",
      resume: {
        agentId: "claude",
        agentSessionId: SESSION_ID,
        cwd: "/repo",
        worktreeId: null,
        agentLaunchFlags: ["--model", "opus"],
        agentModelId: "opus",
        agentPresetId: null,
      },
    });
    expect(deps.markProjectRunning).toHaveBeenCalledWith("project-1");
    expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);
  });

  it("launches in main with the schedule's preset and worktree when no view shows the project", async () => {
    schedule = { ...schedule, launch: { ...schedule.launch, presetId: "p1", worktreeId: "/wt" } };
    deps.findView = () => null;

    await expect(run()).resolves.toMatchObject({ status: "started" });

    expect(deps.launchInView).not.toHaveBeenCalled();
    expect(deps.launchWithoutView).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        args: expect.objectContaining({ presetId: "p1", worktreeId: "/wt" }),
      })
    );
    expect(recorder.registerLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({ agentPresetId: "p1", worktreeId: "/wt" }),
      })
    );
  });

  it("waits for the spawn when the view answers before it reaches main", async () => {
    let request: ScheduledLaunchRequest | undefined;
    deps.spawnTimeoutMs = 5_000;
    deps.launchInView = async (_view, sent) => {
      request = sent;
      setTimeout(() => spawnFor(sent), 5);
      return launched(sent.args.requestedId);
    };

    await expect(run()).resolves.toMatchObject({ status: "started" });
    expect(request).toBeDefined();
    expect(recorder.registerLaunch).toHaveBeenCalledTimes(1);
  });

  it("records a declined launch as a failed run with the reason, and spawns nothing", async () => {
    deps.launchInView = async () => ({
      ok: true,
      result: { launched: false, terminalId: null, spawnStatus: "panel-limit" },
    });

    await expect(run()).resolves.toEqual({
      status: "failed",
      runId: "id-1",
      message: "The project already has as many panels as it can hold.",
    });
    expect(recorder.registerLaunch).not.toHaveBeenCalled();
    expect(recorder.registerRefusedLaunch).toHaveBeenCalledWith({
      id: "id-1",
      scheduleId: "schedule-1",
      projectId: "project-1",
      origin: RUN_NOW,
      terminalId: "terminal-id-2",
      message: "The project already has as many panels as it can hold.",
    });
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);
  });

  it("keeps the launcher's own refusal as the reason", async () => {
    deps.launchWithoutView = async () => ({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "Worktree '/wt' not found." },
    });
    deps.findView = () => null;

    await expect(run()).resolves.toMatchObject({
      status: "failed",
      message: "Worktree '/wt' not found.",
    });
  });

  it("fails a run whose view closed before it spawned, and refuses that late spawn", async () => {
    let sent: ScheduledLaunchRequest | undefined;
    deps.launchInView = async (_view, request) => {
      sent = request;
      throw new ScheduledLaunchUnansweredError("The window showing the project closed.");
    };

    await expect(run()).resolves.toMatchObject({
      status: "failed",
      message: "The window showing the project closed.",
    });
    expect(() => spawnFor(sent!)).toThrow(/given up/);
    expect(recorder.registerLaunch).not.toHaveBeenCalled();
  });

  it("counts a run whose spawn came through as started, even when its view never answered", async () => {
    deps.launchInView = async (_view, request) => {
      spawnFor(request);
      throw new ScheduledLaunchUnansweredError("The window showing the project didn't answer.");
    };

    await expect(run()).resolves.toMatchObject({ status: "started" });
    expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
  });

  it("gives up on a launch whose terminal never spawns", async () => {
    deps.launchInView = async (_view, request) => launched(request.args.requestedId);

    await expect(run()).resolves.toMatchObject({
      status: "failed",
      message: "The agent's terminal didn't start in time.",
    });
    expect(recorder.registerRefusedLaunch).toHaveBeenCalledTimes(1);
  });

  it("refuses a spawn that fell back from the schedule's preset", async () => {
    schedule = { ...schedule, launch: { ...schedule.launch, presetId: "deleted" } };
    deps.launchInView = async (_view, request) => {
      expect(() => spawnFor(request, { agentPresetId: "default" })).toThrow(/preset/);
      return launched(request.args.requestedId);
    };

    await expect(run()).resolves.toMatchObject({
      status: "failed",
      message: "The schedule's preset isn't available any more.",
    });
    expect(recorder.registerLaunch).not.toHaveBeenCalled();
    expect(recorder.registerRefusedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "terminal-id-2" })
    );
  });

  it("refuses a spawn that lost the schedule's worktree", async () => {
    schedule = { ...schedule, launch: { ...schedule.launch, worktreeId: "/wt" } };
    deps.launchInView = async (_view, request) => {
      expect(() => spawnFor(request, { worktreeId: undefined })).toThrow(/worktree/);
      return launched(request.args.requestedId);
    };

    await expect(run()).resolves.toMatchObject({ status: "failed" });
    expect(recorder.registerLaunch).not.toHaveBeenCalled();
  });

  it("refuses a run that would start in the project root instead of its worktree", async () => {
    schedule = { ...schedule, launch: { ...schedule.launch, worktreeId: "/wt" } };
    deps.findView = () => null;
    // With no worktree list, main's launch keeps the id and starts in the root.
    deps.launchWithoutView = async (_project, request) => {
      expect(() => spawnFor(request, { requestedCwd: "/repo", cwd: "/repo" })).toThrow(
        /worktree couldn't be found/
      );
      return { ok: true, result: { launched: false, spawnStatus: "spawn-failed" } };
    };

    await expect(run()).resolves.toMatchObject({
      status: "failed",
      message: "The schedule's worktree couldn't be found.",
    });
    expect(recorder.registerLaunch).not.toHaveBeenCalled();
  });

  it("records nothing for a launch whose schedule was removed while it ran", async () => {
    let sent: ScheduledLaunchRequest | undefined;
    deps.launchInView = async (_view, request) => {
      sent = request;
      cancelScheduledLaunches({ scheduleId: "schedule-1" });
      return launched(request.args.requestedId);
    };

    await expect(run()).resolves.toEqual({ status: "not-found" });
    expect(() => spawnFor(sent!)).toThrow(/given up/);
    expect(recorder.registerLaunch).not.toHaveBeenCalled();
    expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
  });

  it("records nothing for a launch refused at the spawn whose schedule was then removed", async () => {
    schedule = { ...schedule, launch: { ...schedule.launch, presetId: "deleted" } };
    deps.launchInView = async (_view, request) => {
      expect(() => spawnFor(request, { agentPresetId: "default" })).toThrow(/preset/);
      cancelScheduledLaunches({ scheduleId: "schedule-1" });
      return launched(request.args.requestedId);
    };

    await expect(run()).resolves.toEqual({ status: "not-found" });
    expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
  });

  it("records nothing when the project is removed before anything was asked for", async () => {
    deps.folderExists = async () => {
      deps.getProject = () => null;
      return false;
    };

    await expect(run()).resolves.toEqual({ status: "not-found" });
    expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);
  });

  it("gives up on main's own launch when it doesn't finish in time", async () => {
    deps.findView = () => null;
    deps.answerTimeoutMs = 10;
    let sent: ScheduledLaunchRequest | undefined;
    deps.launchWithoutView = (_project, request) => {
      sent = request;
      return new Promise(() => {});
    };

    await expect(run()).resolves.toMatchObject({
      status: "failed",
      message: "The launch didn't finish in time.",
    });
    expect(() => spawnFor(sent!)).toThrow(/given up/);
  });

  it("reports a spawn the PTY host refused as it was sent as failed, not started", async () => {
    recorder.get.mockReturnValue({
      settlement: {
        state: "settled",
        settledAt: 1,
        outcome: "failed",
        evidence: { kind: "launch-error", message: "Too many terminals" },
      },
    } as unknown as ScheduledRun);

    await expect(run()).resolves.toEqual({
      status: "failed",
      runId: "id-1",
      message: "Too many terminals",
    });
  });

  it("settles a registered run whose terminal then failed to start", async () => {
    deps.findView = () => null;
    deps.launchWithoutView = async (_project, request) => {
      spawnFor(request);
      return { ok: true, result: { launched: false, spawnStatus: "spawn-failed" } };
    };
    recorder.get.mockReturnValue({
      process: { pty: { state: "not-started" } },
    } as unknown as ScheduledRun);

    await expect(run()).resolves.toEqual({
      status: "failed",
      runId: "id-1",
      message: "The agent's terminal couldn't start.",
    });
    expect(recorder.settle).toHaveBeenCalledWith("id-1", {
      kind: "launch-error",
      message: "The agent's terminal couldn't start.",
    });
  });

  it("records a failed run without launching when the project's folder is missing", async () => {
    deps.folderExists = async () => false;

    await expect(run()).resolves.toEqual({
      status: "failed",
      runId: "id-1",
      message: "The project's folder is missing.",
    });
    expect(deps.launchInView).not.toHaveBeenCalled();
    expect(recorder.registerRefusedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: null })
    );
  });

  it("refuses to launch into a project that's going to sleep, at the spawn as well", async () => {
    let sleeping = true;
    deps.isProjectSleeping = () => sleeping;
    await expect(run()).resolves.toMatchObject({ status: "failed" });
    expect(deps.launchInView).not.toHaveBeenCalled();

    sleeping = false;
    deps.launchInView = async (_view, request) => {
      sleeping = true;
      expect(() => spawnFor(request)).toThrow(/sleep/);
      return launched(request.args.requestedId);
    };
    await expect(run()).resolves.toMatchObject({
      status: "failed",
      message: "The project was going to sleep.",
    });
    expect(recorder.registerLaunch).not.toHaveBeenCalled();
  });

  it("answers not-found for a schedule or project that's gone, recording nothing", async () => {
    deps.getSchedule = async () => null;
    await expect(run()).resolves.toEqual({ status: "not-found" });

    deps.getSchedule = async () => schedule;
    deps.getProject = () => null;
    await expect(run()).resolves.toEqual({ status: "not-found" });
    expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
  });

  it("refuses to run when the history can't record it", async () => {
    deps.getRecorder = async () => null;

    await expect(run()).resolves.toMatchObject({ status: "failed", runId: null });
    expect(deps.launchInView).not.toHaveBeenCalled();
  });
});
