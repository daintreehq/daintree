import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";
import type { Project } from "../../../../shared/types/project.js";
import type {
  Schedule,
  ScheduledRun,
  ScheduledRunOrigin,
} from "../../../../shared/types/scheduledRuns.js";
import { createSchedule, occurrenceKeyFor } from "../../../../shared/utils/scheduledRuns.js";
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
  registerSkip: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
  listBySchedule: ReturnType<typeof vi.fn>;
  beginReplacement: ReturnType<typeof vi.fn>;
  handleSessionCaptured: ReturnType<typeof vi.fn>;
};
/** The schedule's recorded runs, newest first, as the history lists them. */
let history: ScheduledRun[];
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
    handbackCode: "k7f3qa",
    ...overrides,
  });
}

beforeEach(() => {
  ids = 0;
  history = [];
  recorder = {
    registerLaunch: vi.fn(),
    registerRefusedLaunch: vi.fn(),
    registerSkip: vi.fn(),
    get: vi.fn((runId: string) => history.find((recorded) => recorded.id === runId) ?? null),
    settle: vi.fn(),
    listBySchedule: vi.fn(() => history),
    beginReplacement: vi.fn(() => null),
    handleSessionCaptured: vi.fn(),
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
    runPrecondition: vi.fn(async () => null),
    closeRunTerminal: vi.fn(async () => null),
    removeRunPane: vi.fn(async () => {}),
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
      handbackCode: "k7f3qa",
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

  it("arms the done policy its launch read once the run started, and only then (#15982)", async () => {
    const onLaunched = vi.fn();
    deps.onLaunched = onLaunched;
    schedule = { ...schedule, policies: { ...schedule.policies, onDone: "close" } };
    let answer!: () => void;
    deps.launchInView = vi.fn(async (_view, request) => {
      spawnFor(request);
      // An edit made while the run launches applies to later runs.
      schedule = { ...schedule, policies: { ...schedule.policies, onDone: "keep" } };
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return launched(request.args.requestedId);
    });

    const started = run();
    await vi.waitFor(() => expect(recorder.registerLaunch).toHaveBeenCalled());
    // Registered at the spawn, but the launch hasn't finished committing its pane.
    expect(onLaunched).not.toHaveBeenCalled();
    answer();
    await expect(started).resolves.toMatchObject({ status: "started" });
    expect(onLaunched).toHaveBeenCalledWith({
      runId: "id-1",
      scheduleId: "schedule-1",
      projectId: "project-1",
      terminalId: "terminal-id-2",
      onDone: "close",
    });

    onLaunched.mockClear();
    deps.launchInView = async () => ({
      ok: true,
      result: { launched: false, terminalId: null, spawnStatus: "panel-limit" },
    });
    await expect(run()).resolves.toMatchObject({ status: "failed" });
    expect(onLaunched).not.toHaveBeenCalled();
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

  it("fires nothing for a scheduled occurrence of a schedule switched off since, but Run now runs it", async () => {
    schedule = { ...schedule, enabled: false };
    const dueAt = Date.UTC(2026, 10, 2, 9);
    const scheduled = {
      trigger: "scheduled",
      dueAt,
      occurrenceKey: new Date(dueAt).toISOString(),
      coalesced: null,
    } as const;

    await expect(
      launchScheduledRun(
        { projectId: "project-1", scheduleId: "schedule-1", origin: scheduled },
        deps
      )
    ).resolves.toEqual({ status: "not-found" });
    expect(deps.launchInView).not.toHaveBeenCalled();
    expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);

    await expect(run()).resolves.toMatchObject({ status: "started" });
  });

  it("refuses to run when the history can't record it", async () => {
    deps.getRecorder = async () => null;

    await expect(run()).resolves.toMatchObject({ status: "failed", runId: null });
    expect(deps.launchInView).not.toHaveBeenCalled();
  });
});

const DUE_AT = Date.UTC(2026, 10, 2, 9);
const SCHEDULED: ScheduledRunOrigin = {
  trigger: "scheduled",
  dueAt: DUE_AT,
  occurrenceKey: occurrenceKeyFor(DUE_AT),
  coalesced: null,
};
const CATCH_UP: ScheduledRunOrigin = {
  trigger: "catch-up",
  dueAt: DUE_AT,
  occurrenceKey: occurrenceKeyFor(DUE_AT),
  coalesced: { after: DUE_AT - 86_400_000, through: DUE_AT + 60_000 },
};

/** A run of the schedule as the history holds it: open unless settled. */
function recordedRun(id: string, settled = false): ScheduledRun {
  return {
    id,
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: RUN_NOW,
    createdAt: 1,
    terminalId: `terminal-of-${id}`,
    terminalSpawnedAt: 5,
    settlement: settled
      ? {
          state: "settled",
          settledAt: 9,
          outcome: "done",
          evidence: { kind: "handback", report: "done", summary: null, truncated: false },
        }
      : { state: "open" },
    process: { agent: { state: "not-started" }, pty: { state: "running", startedAt: 5 } },
    pane: { state: "open", since: 5 },
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
}

/**
 * A replacement the recorder hands out; the run's PTY is gone once `markGone`
 * is called. Finishing with a successor settles `runId` in the history, as the
 * recorder's write would; with no `runId` that write fails and it stays open.
 */
function fakeReplacement(runId?: string) {
  let resolveGone!: () => void;
  let gone = false;
  return {
    gone: new Promise<void>((resolve) => {
      resolveGone = resolve;
    }),
    isGone: () => gone,
    finish: vi.fn((successorId: string | null) => {
      if (successorId === null || runId === undefined) return null;
      history = history.map((recorded) =>
        recorded.id === runId
          ? {
              ...recorded,
              settlement: {
                state: "settled",
                settledAt: 10,
                outcome: "replaced",
                evidence: { kind: "replace", replacedByRunId: successorId },
              },
            }
          : recorded
      );
      return null;
    }),
    markGone: () => {
      gone = true;
      resolveGone();
    },
  };
}

function withPolicies(policies: Partial<Schedule["policies"]>): void {
  schedule = { ...schedule, policies: { ...schedule.policies, ...policies } };
}

const launchWith = (origin: ScheduledRunOrigin, extra: Record<string, unknown> = {}) =>
  launchScheduledRun({ projectId: "project-1", scheduleId: "schedule-1", origin, ...extra }, deps);

describe("launchScheduledRun's overlap policy and precondition", () => {
  it("skips an occurrence while an earlier run is open, linked to the newest, running nothing", async () => {
    withPolicies({ precondition: { command: "test -f ready" } });
    history = [recordedRun("run-b"), recordedRun("run-a")];

    await expect(launchWith(SCHEDULED)).resolves.toEqual({
      status: "skipped",
      runId: "id-1",
      reason: { kind: "overlap", openRunId: "run-b" },
    });
    expect(recorder.registerSkip).toHaveBeenCalledWith({
      id: "id-1",
      scheduleId: "schedule-1",
      projectId: "project-1",
      origin: SCHEDULED,
      reason: { kind: "overlap", openRunId: "run-b" },
      terminalId: null,
    });
    expect(deps.runPrecondition).not.toHaveBeenCalled();
    expect(deps.launchInView).not.toHaveBeenCalled();
    expect(hasPendingScheduledLaunch("project-1")).toBe(false);
  });

  it("isn't held back by a settled run whose terminal is still running", async () => {
    history = [recordedRun("run-a", true)];

    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({ status: "started" });
    expect(recorder.registerSkip).not.toHaveBeenCalled();
  });

  it("starts another alongside an open run under start-another", async () => {
    withPolicies({ overlap: "start-another" });
    history = [recordedRun("run-a")];

    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({ status: "started" });
    await expect(run()).resolves.toMatchObject({ status: "started" });
    expect(deps.closeRunTerminal).not.toHaveBeenCalled();
  });

  it("replaces an open run: checks the precondition, closes the run, then launches", async () => {
    withPolicies({ overlap: "replace", precondition: { command: "test -f ready" } });
    const open = recordedRun("run-a");
    history = [open];
    const replacement = fakeReplacement("run-a");
    recorder.beginReplacement.mockReturnValue(replacement);
    const order: string[] = [];
    deps.runPrecondition = vi.fn(async () => {
      order.push("precondition");
      return null;
    });
    deps.closeRunTerminal = vi.fn(async () => {
      order.push("close");
      replacement.markGone();
      return "codex-session";
    });
    deps.removeRunPane = vi.fn(async () => {
      order.push("remove pane");
    });
    deps.launchInView = vi.fn(async (_view, request) => {
      order.push("launch");
      spawnFor(request);
      return launched(request.args.requestedId);
    });

    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({
      status: "started",
      runId: "id-1",
    });
    expect(order).toEqual(["precondition", "close", "remove pane", "launch"]);
    expect(recorder.beginReplacement).toHaveBeenCalledWith("run-a");
    expect(deps.closeRunTerminal).toHaveBeenCalledWith(open);
    expect(replacement.finish).toHaveBeenCalledExactlyOnceWith("id-1");
    // The id the close captured reaches the run's resume snapshot.
    expect(recorder.handleSessionCaptured).toHaveBeenCalledWith({
      record: {
        sessionId: "codex-session",
        agentId: "codex",
        projectId: "project-1",
        terminal: { id: "terminal-of-run-a", spawnedAt: 5 },
      },
    });
  });

  it("waits for the closed run's PTY to be gone before replacing it and launching", async () => {
    withPolicies({ overlap: "replace" });
    history = [recordedRun("run-a")];
    const replacement = fakeReplacement("run-a");
    recorder.beginReplacement.mockReturnValue(replacement);
    deps.replaceExitTimeoutMs = 5_000;
    let closed!: () => void;
    const answered = new Promise<void>((resolve) => {
      closed = resolve;
    });
    deps.closeRunTerminal = vi.fn(async () => {
      closed();
      return null;
    });

    const launching = launchWith(SCHEDULED);
    await answered;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replacement.finish).not.toHaveBeenCalled();
    expect(deps.removeRunPane).not.toHaveBeenCalled();
    expect(deps.launchInView).not.toHaveBeenCalled();

    replacement.markGone();
    await expect(launching).resolves.toMatchObject({ status: "started", runId: "id-1" });
    expect(replacement.finish).toHaveBeenCalledExactlyOnceWith("id-1");
    expect(deps.removeRunPane).toHaveBeenCalledTimes(1);
  });

  it("replaces every open run, and stops at the first that won't close", async () => {
    withPolicies({ overlap: "replace" });
    history = [recordedRun("run-c"), recordedRun("run-b"), recordedRun("run-a")];
    const replacements = new Map(history.map((open) => [open.id, fakeReplacement(open.id)]));
    recorder.beginReplacement.mockImplementation((runId: string) => replacements.get(runId));
    deps.closeRunTerminal = vi.fn(async (open: ScheduledRun) => {
      replacements.get(open.id)!.markGone();
      return null;
    });

    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({ status: "started" });
    for (const id of ["run-c", "run-b", "run-a"]) {
      expect(replacements.get(id)!.finish).toHaveBeenCalledExactlyOnceWith("id-1");
    }
    expect(vi.mocked(deps.removeRunPane).mock.calls.map(([open]) => open.id)).toEqual([
      "run-c",
      "run-b",
      "run-a",
    ]);

    // Again, with the middle one refusing to close.
    history = [recordedRun("run-c"), recordedRun("run-b"), recordedRun("run-a")];
    const second = new Map(history.map((open) => [open.id, fakeReplacement(open.id)]));
    recorder.beginReplacement.mockClear();
    recorder.beginReplacement.mockImplementation((runId: string) => second.get(runId));
    vi.mocked(deps.removeRunPane).mockClear();
    deps.launchInView = vi.fn();
    deps.closeRunTerminal = vi.fn(async (open: ScheduledRun) => {
      if (open.id === "run-b") throw new Error("host gone");
      second.get(open.id)!.markGone();
      return null;
    });

    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({ status: "failed" });
    expect(second.get("run-c")!.finish).toHaveBeenCalledExactlyOnceWith("id-3");
    expect(second.get("run-b")!.finish).toHaveBeenCalledExactlyOnceWith(null);
    expect(recorder.beginReplacement).not.toHaveBeenCalledWith("run-a");
    expect(vi.mocked(deps.closeRunTerminal).mock.calls.map(([open]) => open.id)).toEqual([
      "run-c",
      "run-b",
    ]);
    expect(deps.launchInView).not.toHaveBeenCalled();
  });

  it("starts nothing when the replacement couldn't be recorded, though the pane goes", async () => {
    withPolicies({ overlap: "replace" });
    history = [recordedRun("run-a")];
    const replacement = fakeReplacement();
    recorder.beginReplacement.mockReturnValue(replacement);
    deps.closeRunTerminal = vi.fn(async () => {
      replacement.markGone();
      return null;
    });

    // The settlement write fails: the history still reads the run as open.
    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({
      status: "failed",
      message: expect.stringMatching(/couldn't be recorded/),
    });
    expect(replacement.finish).toHaveBeenCalledExactlyOnceWith("id-1");
    expect(deps.removeRunPane).toHaveBeenCalledTimes(1);
    expect(deps.launchInView).not.toHaveBeenCalled();
  });

  it("closes nothing when the precondition skips the run", async () => {
    withPolicies({ overlap: "replace", precondition: { command: "test -f ready" } });
    history = [recordedRun("run-a")];
    const reason = { kind: "precondition", exitCode: 1, signal: null, error: null } as const;
    deps.runPrecondition = vi.fn(async () => reason);

    await expect(launchWith(SCHEDULED)).resolves.toEqual({
      status: "skipped",
      runId: "id-1",
      reason,
    });
    expect(recorder.beginReplacement).not.toHaveBeenCalled();
    expect(deps.closeRunTerminal).not.toHaveBeenCalled();
  });

  it("launches nothing when an open run's terminal can't be closed, leaving it open", async () => {
    withPolicies({ overlap: "replace" });
    history = [recordedRun("run-a")];
    const replacement = fakeReplacement();
    recorder.beginReplacement.mockReturnValue(replacement);
    deps.closeRunTerminal = vi.fn(async () => {
      throw new Error("host gone");
    });

    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({
      status: "failed",
      runId: "id-1",
      message: expect.stringMatching(/couldn't be closed/),
    });
    expect(replacement.finish).toHaveBeenCalledExactlyOnceWith(null);
    expect(deps.removeRunPane).not.toHaveBeenCalled();
    expect(deps.launchInView).not.toHaveBeenCalled();
    expect(recorder.registerRefusedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id-1", terminalId: null })
    );
  });

  it("launches nothing when the closed run's terminal never exits", async () => {
    withPolicies({ overlap: "replace" });
    history = [recordedRun("run-a")];
    const replacement = fakeReplacement();
    recorder.beginReplacement.mockReturnValue(replacement);
    deps.replaceExitTimeoutMs = 10;

    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({
      status: "failed",
      message: expect.stringMatching(/didn't close in time/),
    });
    expect(replacement.finish).toHaveBeenCalledExactlyOnceWith(null);
    expect(deps.launchInView).not.toHaveBeenCalled();
  });

  it("leaves a run alone that settled before it could be replaced", async () => {
    withPolicies({ overlap: "replace" });
    history = [recordedRun("run-a")];

    await expect(launchWith(SCHEDULED)).resolves.toMatchObject({ status: "started" });
    expect(deps.closeRunTerminal).not.toHaveBeenCalled();
    expect(deps.removeRunPane).not.toHaveBeenCalled();
  });

  describe("Run now", () => {
    it("asks before running alongside open runs, recording and reserving nothing", async () => {
      history = [recordedRun("run-b"), recordedRun("run-a")];

      await expect(run()).resolves.toEqual({
        status: "confirm-overlap",
        policy: "skip",
        openRunIds: ["run-b", "run-a"],
        scheduleName: "Nightly triage",
      });
      expect(recorder.registerSkip).not.toHaveBeenCalled();
      expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
      expect(deps.launchInView).not.toHaveBeenCalled();
      expect(hasPendingScheduledLaunch("project-1")).toBe(false);
    });

    it("runs alongside once the user agreed to the runs it named", async () => {
      history = [recordedRun("run-b"), recordedRun("run-a")];

      await expect(
        launchWith(RUN_NOW, {
          overlapConfirmed: { policy: "skip", openRunIds: ["run-a", "run-b"] },
        })
      ).resolves.toMatchObject({ status: "started" });
      expect(deps.closeRunTerminal).not.toHaveBeenCalled();
    });

    it("asks again when a run opened since, or the policy changed", async () => {
      history = [recordedRun("run-b"), recordedRun("run-a")];

      await expect(
        launchWith(RUN_NOW, { overlapConfirmed: { policy: "skip", openRunIds: ["run-a"] } })
      ).resolves.toMatchObject({ status: "confirm-overlap", openRunIds: ["run-b", "run-a"] });
      await expect(
        launchWith(RUN_NOW, {
          overlapConfirmed: { policy: "replace", openRunIds: ["run-a", "run-b"] },
        })
      ).resolves.toMatchObject({ status: "confirm-overlap", policy: "skip" });
      expect(deps.launchInView).not.toHaveBeenCalled();
    });

    it("replaces under the replace policy once the user agreed", async () => {
      withPolicies({ overlap: "replace" });
      history = [recordedRun("run-a")];
      const replacement = fakeReplacement("run-a");
      recorder.beginReplacement.mockReturnValue(replacement);
      deps.closeRunTerminal = vi.fn(async () => {
        replacement.markGone();
        return null;
      });

      await expect(run()).resolves.toEqual({
        status: "confirm-overlap",
        policy: "replace",
        openRunIds: ["run-a"],
        scheduleName: "Nightly triage",
      });
      expect(deps.closeRunTerminal).not.toHaveBeenCalled();

      await expect(
        launchWith(RUN_NOW, { overlapConfirmed: { policy: "replace", openRunIds: ["run-a"] } })
      ).resolves.toMatchObject({ status: "started" });
      expect(replacement.finish).toHaveBeenCalledExactlyOnceWith("id-3");
      expect(recorder.handleSessionCaptured).not.toHaveBeenCalled();
    });
  });

  describe("precondition", () => {
    it("runs in the schedule's worktree and launches when it passes", async () => {
      schedule = { ...schedule, launch: { ...schedule.launch, worktreeId: "/wt" } };
      withPolicies({ precondition: { command: "gh pr list | grep -q ." } });

      await expect(launchWith(SCHEDULED)).resolves.toMatchObject({ status: "started" });
      expect(deps.runPrecondition).toHaveBeenCalledWith({
        projectId: "project-1",
        command: "gh pr list | grep -q .",
        cwd: "/wt",
        signal: expect.any(AbortSignal),
      });
    });

    it("records its skip with the exit code, holding the reserved terminal id", async () => {
      withPolicies({ precondition: { command: "exit 3" } });
      const reason = { kind: "precondition", exitCode: 3, signal: null, error: null } as const;
      deps.runPrecondition = vi.fn(async () => reason);

      await expect(launchWith(SCHEDULED)).resolves.toEqual({
        status: "skipped",
        runId: "id-1",
        reason,
      });
      expect(recorder.registerSkip).toHaveBeenCalledWith({
        id: "id-1",
        scheduleId: "schedule-1",
        projectId: "project-1",
        origin: SCHEDULED,
        reason,
        terminalId: "terminal-id-2",
      });
      expect(deps.launchInView).not.toHaveBeenCalled();
      expect(hasPendingScheduledLaunch("project-1")).toBe(false);
    });

    it("applies to Run now too", async () => {
      withPolicies({ precondition: { command: "exit 1" } });
      const reason = { kind: "precondition", exitCode: 1, signal: null, error: null } as const;
      deps.runPrecondition = vi.fn(async () => reason);

      await expect(run()).resolves.toMatchObject({ status: "skipped", reason });
    });

    it("holds the project's sleep while it runs, and stops when the schedule is removed", async () => {
      withPolicies({ precondition: { command: "sleep 30" } });
      let aborted = false;
      deps.runPrecondition = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        expect(hasPendingScheduledLaunch("project-1")).toBe(true);
        cancelScheduledLaunches({ scheduleId: "schedule-1" });
        await Promise.resolve();
        aborted = signal.aborted;
        return { kind: "precondition", exitCode: null, signal: 15, error: null } as const;
      });

      await expect(launchWith(SCHEDULED)).resolves.toEqual({ status: "not-found" });
      expect(aborted).toBe(true);
      expect(recorder.registerSkip).not.toHaveBeenCalled();
      expect(recorder.registerRefusedLaunch).not.toHaveBeenCalled();
    });

    it("refuses to run in a worktree that's gone, rather than anywhere else", async () => {
      schedule = { ...schedule, launch: { ...schedule.launch, worktreeId: "/wt" } };
      withPolicies({ precondition: { command: "true" } });
      deps.folderExists = async (path) => path !== "/wt";

      await expect(launchWith(SCHEDULED)).resolves.toMatchObject({
        status: "failed",
        message: "The schedule's worktree couldn't be found.",
      });
      expect(deps.runPrecondition).not.toHaveBeenCalled();
    });
  });

  it("never acts on an occurrence the history already has a run for", async () => {
    withPolicies({ overlap: "replace", precondition: { command: "true" } });
    history = [recordedRun("run-a"), { ...recordedRun("run-old", true), origin: SCHEDULED }];

    await expect(launchWith(SCHEDULED)).resolves.toEqual({
      status: "already-recorded",
      runId: "run-old",
    });
    expect(deps.runPrecondition).not.toHaveBeenCalled();
    expect(recorder.beginReplacement).not.toHaveBeenCalled();
    expect(recorder.registerSkip).not.toHaveBeenCalled();
  });

  it("judges a second trigger against the run the first one started", async () => {
    withPolicies({ precondition: { command: "test -f ready" } });
    recorder.registerLaunch.mockImplementation(
      (input: { id: string; origin: ScheduledRunOrigin }) => {
        history = [{ ...recordedRun(input.id), origin: input.origin }, ...history];
      }
    );
    let pass!: () => void;
    deps.runPrecondition = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          pass = () => resolve(null);
        })
    );

    const catchUp = launchWith(CATCH_UP);
    const runNow = run();
    await vi.waitFor(() => expect(deps.runPrecondition).toHaveBeenCalledTimes(1));
    // Run now waits its turn rather than finding no open run.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deps.runPrecondition).toHaveBeenCalledTimes(1);
    pass();

    await expect(catchUp).resolves.toMatchObject({ status: "started", runId: "id-1" });
    await expect(runNow).resolves.toEqual({
      status: "confirm-overlap",
      policy: "skip",
      openRunIds: ["id-1"],
      scheduleName: "Nightly triage",
    });
    // The first trigger's occurrence is recorded; replaying it does nothing.
    expect(history[0]?.origin).toEqual(CATCH_UP);
    await expect(launchWith(CATCH_UP)).resolves.toEqual({
      status: "already-recorded",
      runId: "id-1",
    });
    expect(deps.runPrecondition).toHaveBeenCalledTimes(1);
  });

  it("doesn't hold up another schedule", async () => {
    let pass!: () => void;
    withPolicies({ precondition: { command: "test -f ready" } });
    deps.runPrecondition = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          pass = () => resolve(null);
        })
    );
    const first = launchWith(SCHEDULED);
    await vi.waitFor(() => expect(deps.runPrecondition).toHaveBeenCalledTimes(1));

    const other = {
      ...schedule,
      id: "schedule-2",
      policies: { ...schedule.policies, precondition: null },
    };
    deps.getSchedule = async (_projectId, scheduleId) =>
      scheduleId === "schedule-2" ? other : schedule;
    await expect(
      launchScheduledRun(
        { projectId: "project-1", scheduleId: "schedule-2", origin: RUN_NOW },
        deps
      )
    ).resolves.toMatchObject({ status: "started" });

    pass();
    await expect(first).resolves.toMatchObject({ status: "started" });
  });
});
