import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

import { openDb } from "../../persistence/db.js";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";
import type { Project } from "../../../../shared/types/project.js";
import type {
  ProjectScheduleSwitches,
  Schedule,
  ScheduledRunOrigin,
} from "../../../../shared/types/scheduledRuns.js";
import type { WorktreeSetupStatus } from "../../../../shared/types/worktree.js";
import { createSchedule, occurrenceKeyFor } from "../../../../shared/utils/scheduledRuns.js";
import {
  launchScheduledRun,
  type ScheduledLaunchRequest,
  type ScheduledRunLauncherDeps,
} from "../ScheduledRunLauncher.js";
import { ScheduledRunRecorder } from "../ScheduledRunRecorder.js";
import { ScheduledRunStore } from "../ScheduledRunStore.js";
import {
  _resetScheduledRunAdmissionForTest,
  admitScheduledSpawn,
  cancelScheduledLaunches,
} from "../scheduledRunAdmission.js";
import type { RunWorktreeListing, ScheduledRunWorktreeHost } from "../scheduledRunWorktree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const SCHEDULE_ID = "schedule-1";
const PROJECT_ID = "project-1";
const RUN_NOW = { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null } as const;
const READY: WorktreeSetupStatus = { state: "ready", startedAt: 1, completedAt: 2 };
const T0 = Date.UTC(2026, 10, 8, 9);

function occurrence(dueAt: number): ScheduledRunOrigin {
  return {
    trigger: "catch-up",
    dueAt,
    occurrenceKey: occurrenceKeyFor(dueAt),
    coalesced: { after: dueAt - 1, through: dueAt },
  };
}

/** The workspace host: `git worktree add` refuses a branch it already has. */
function fakeHost() {
  const worktrees = new Map<string, RunWorktreeListing>();
  const host = {
    worktrees,
    /** What a new worktree's setup reads as once created. */
    setupAfterCreate: READY as WorktreeSetupStatus | undefined,
    list: vi.fn<ScheduledRunWorktreeHost["list"]>(async () => [...worktrees.values()]),
    create: vi.fn<ScheduledRunWorktreeHost["create"]>(async (_project, { branch }) => {
      if (worktrees.has(branch)) throw new Error(`Branch '${branch}' already exists`);
      const id = `/worktrees/${branch}`;
      worktrees.set(branch, { id, path: id, branch, setupStatus: host.setupAfterCreate });
      return id;
    }),
  };
  return host;
}

let dir: string;
let dbPath: string;
let sqlite: Database.Database;
let store: ScheduledRunStore;
let recorder: ScheduledRunRecorder;
let host: ReturnType<typeof fakeHost>;
let schedule: Schedule;
let switches: ProjectScheduleSwitches;
let deps: ScheduledRunLauncherDeps<{ id: number }>;
let ids: number;
let shuttingDown: boolean;
let order: string[];

function openHistory(): void {
  sqlite = openDb(dbPath, migrationsFolder).sqlite;
  store = new ScheduledRunStore(sqlite);
  recorder = new ScheduledRunRecorder({ store, logWarn: () => {} });
}

/** A quit or crash: the database closes, and nothing in memory survives. */
function restart(): void {
  sqlite.close();
  _resetScheduledRunAdmissionForTest();
  shuttingDown = false;
  openHistory();
  for (const [branch, worktree] of host.worktrees) {
    // Setup status lives in the host's memory, so a new one can't say.
    host.worktrees.set(branch, { ...worktree, setupStatus: undefined });
  }
}

function launched(request: ScheduledLaunchRequest): ActionDispatchResult {
  order.push("launch");
  const cwd = request.args.worktreeId || "/repo";
  admitScheduledSpawn({
    terminalId: request.args.requestedId,
    projectId: PROJECT_ID,
    scheduledRun: request.scheduledRun,
    launchAgentId: request.args.agentId,
    requestedCwd: cwd,
    cwd,
    worktreeId: request.args.worktreeId || undefined,
    agentLaunchFlags: [],
    agentModelId: undefined,
    agentPresetId: undefined,
    agentSessionId: undefined,
    handbackCode: undefined,
    assistant: false,
  });
  return {
    ok: true,
    result: { launched: true, terminalId: request.args.requestedId, spawnStatus: null },
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-run-worktree-"));
  dbPath = path.join(dir, "app.db");
  openHistory();
  host = fakeHost();
  ids = 0;
  shuttingDown = false;
  order = [];
  schedule = createSchedule(
    {
      id: SCHEDULE_ID,
      projectId: PROJECT_ID,
      name: "Nightly triage",
      launch: {
        agentId: "claude",
        prompt: "Triage.",
        newWorktree: { baseBranch: "main", fromRemote: false },
      },
      policies: { overlap: "start-another" },
    },
    T0
  );
  switches = { schedulesOn: true, startWhenClosed: false, schedulesOnSince: null };
  const project = { id: PROJECT_ID, path: "/repo", name: "Repo", status: "active" } as Project;
  deps = {
    getRecorder: async () => recorder,
    getSchedule: async (_projectId, scheduleId) =>
      scheduleId === schedule.id ? { schedule, switches } : null,
    getProject: () => project,
    folderExists: async () => true,
    isProjectSleeping: () => false,
    markProjectRunning: () => {},
    findView: () => ({ id: 7 }),
    launchInView: vi.fn(async (_view, request) => launched(request)),
    launchWithoutView: vi.fn(async (_project, request) => launched(request)),
    launchAssistant: vi.fn(async () => ({ status: "started" as const })),
    worktreeHost: host,
    sleep: async () => {},
    runPrecondition: vi.fn(async () => {
      order.push("precondition");
      return null;
    }),
    closeRunTerminal: vi.fn(async () => null),
    removeRunPane: vi.fn(async () => {}),
    newId: () => `id${(++ids).toString().padStart(6, "0")}`,
    spawnTimeoutMs: 20,
    isShuttingDown: () => shuttingDown,
    logWarn: () => {},
  };
});

afterEach(() => {
  _resetScheduledRunAdmissionForTest();
  if (sqlite.open) sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const launch = (origin: ScheduledRunOrigin = RUN_NOW) =>
  launchScheduledRun({ projectId: PROJECT_ID, scheduleId: SCHEDULE_ID, origin }, deps);

const expectNothingLaunched = () => {
  expect(deps.launchInView).not.toHaveBeenCalled();
  expect(deps.launchWithoutView).not.toHaveBeenCalled();
};

describe("a schedule that runs each time in a new worktree (#16369)", () => {
  it("makes one worktree on a generated branch, launches there, and records it", async () => {
    const outcome = await launch();

    expect(outcome.status).toBe("started");
    expect(host.create).toHaveBeenCalledTimes(1);
    const request = host.create.mock.calls[0]![1];
    expect(request.branch).toMatch(/^schedule-nightly-triage-\d{8}-\d{4}-id\d{6}$/);
    expect(request).toMatchObject({ baseBranch: "main", fromRemote: false });
    const worktreeId = `/worktrees/${request.branch}`;

    const launchRequest = vi.mocked(deps.launchInView).mock.calls[0]![1];
    expect(launchRequest.args.worktreeId).toBe(worktreeId);
    expect(launchRequest.newWorktree).toBe(true);

    const [run] = recorder.listBySchedule(SCHEDULE_ID);
    expect(run?.newWorktree).toEqual({
      branch: request.branch,
      baseBranch: "main",
      worktreeId,
    });
    // Open and Resume read this, so they land in the run's worktree.
    expect(run?.resume).toMatchObject({ worktreeId, cwd: worktreeId });
    expect(store.worktreeClaim(SCHEDULE_ID)).toBeNull();
  });

  it("launches in main the same way with no view showing the project", async () => {
    deps.findView = () => null;

    await expect(launch()).resolves.toMatchObject({ status: "started" });

    const launchRequest = vi.mocked(deps.launchWithoutView).mock.calls[0]![1];
    expect(launchRequest.args.worktreeId).toMatch(/^\/worktrees\/schedule-nightly-triage-/);
  });

  it("gives each concurrent run under start-another its own worktree", async () => {
    const outcomes = await Promise.all([launch(), launch(), launch()]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["started", "started", "started"]);
    expect(host.create).toHaveBeenCalledTimes(3);
    const branches = host.create.mock.calls.map((call) => call[1].branch);
    expect(new Set(branches).size).toBe(3);
    const runs = recorder.listBySchedule(SCHEDULE_ID);
    expect(new Set(runs.map((run) => run.newWorktree?.worktreeId)).size).toBe(3);
    expect(runs.every((run) => run.settlement.state === "open")).toBe(true);
  });

  describe("exactly one worktree, whatever happens to a launch", () => {
    it("takes the same worktree when a crash mid-setup replays under a later occurrence", async () => {
      host.setupAfterCreate = { state: "running", stage: "setup-script", startedAt: 1 };
      host.list.mockImplementationOnce(async () => {
        shuttingDown = true;
        return [...host.worktrees.values()];
      });
      await expect(launch(occurrence(T0))).resolves.toEqual({ status: "not-found" });
      expect(recorder.listBySchedule(SCHEDULE_ID)).toEqual([]);
      const { branch } = host.create.mock.calls[0]![1];

      restart();
      const outcome = await launch(occurrence(T0 + 3_600_000));

      expect(host.create).toHaveBeenCalledTimes(1);
      expect(outcome.status).toBe("failed");
      expectNothingLaunched();
      const [run] = recorder.listBySchedule(SCHEDULE_ID);
      expect(run?.newWorktree).toMatchObject({ branch, worktreeId: `/worktrees/${branch}` });
      expect(run?.settlement).toMatchObject({
        outcome: "failed",
        evidence: {
          kind: "launch-error",
          message: expect.stringContaining("can't tell whether the new worktree's setup finished"),
        },
      });
      // That attempt is over, so the next run starts a worktree of its own.
      expect(store.worktreeClaim(SCHEDULE_ID)).toBeNull();
      host.setupAfterCreate = READY;
      await expect(launch(occurrence(T0 + 7_200_000))).resolves.toMatchObject({
        status: "started",
      });
      expect(host.create).toHaveBeenCalledTimes(2);
      expect(host.create.mock.calls[1]![1].branch).not.toBe(branch);
    });

    it("creates under the claimed branch when a crash came before the worktree was made", async () => {
      host.create.mockImplementationOnce(async () => {
        shuttingDown = true;
        throw new Error("The process is exiting");
      });
      await expect(launch(occurrence(T0))).resolves.toEqual({ status: "not-found" });
      const { branch } = host.create.mock.calls[0]![1];
      expect(store.worktreeClaim(SCHEDULE_ID)?.branch).toBe(branch);

      restart();
      await expect(launch(occurrence(T0 + 3_600_000))).resolves.toMatchObject({
        status: "started",
      });

      expect(host.create.mock.calls.map((call) => call[1].branch)).toEqual([branch, branch]);
      expect(host.worktrees.size).toBe(1);
    });

    it("takes the same worktree when the scheduler retries a launch that recorded nothing", async () => {
      const refuse = vi.spyOn(recorder, "registerRefusedLaunch").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      host.create.mockImplementationOnce(async (_project, { branch }) => {
        const id = `/worktrees/${branch}`;
        host.worktrees.set(branch, { id, path: id, branch, setupStatus: READY });
        return id;
      });
      deps.launchInView = vi.fn(async () => ({
        ok: false as const,
        error: { code: "EXECUTION_ERROR", message: "No" },
      }));

      await expect(launch(occurrence(T0))).resolves.toMatchObject({
        status: "failed",
        runId: null,
      });
      expect(refuse).toHaveBeenCalledTimes(1);
      const { branch } = host.create.mock.calls[0]![1];
      expect(store.worktreeClaim(SCHEDULE_ID)?.branch).toBe(branch);

      deps.launchInView = vi.fn(async (_view, request) => launched(request));
      await expect(launch(occurrence(T0 + 60_000))).resolves.toMatchObject({ status: "started" });

      expect(host.create).toHaveBeenCalledTimes(1);
      expect(recorder.listBySchedule(SCHEDULE_ID)[0]?.newWorktree?.branch).toBe(branch);
    });

    it("refuses rather than making a second worktree when git says the branch is taken", async () => {
      await launch();
      const { branch } = host.create.mock.calls[0]![1];
      store.saveWorktreeClaim({
        scheduleId: SCHEDULE_ID,
        projectId: PROJECT_ID,
        branch,
        baseBranch: "main",
        fromRemote: false,
      });
      host.list.mockResolvedValueOnce([]);

      const outcome = await launch();

      expect(outcome).toMatchObject({
        status: "failed",
        message: expect.stringContaining("already exists"),
      });
      expect(host.worktrees.size).toBe(1);
    });

    it("never launches when the claim can't be written, and creates nothing", async () => {
      vi.spyOn(recorder, "saveWorktreeClaim").mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      const outcome = await launch();

      expect(outcome.status).toBe("failed");
      expect(host.create).not.toHaveBeenCalled();
      expectNothingLaunched();
      expect(recorder.listBySchedule(SCHEDULE_ID)[0]?.newWorktree).toBeUndefined();
    });

    it("starts afresh when the schedule's base changed since the claim", async () => {
      store.saveWorktreeClaim({
        scheduleId: SCHEDULE_ID,
        projectId: PROJECT_ID,
        branch: "schedule-old",
        baseBranch: "old-base",
        fromRemote: false,
      });

      await expect(launch()).resolves.toMatchObject({ status: "started" });

      expect(host.create.mock.calls[0]![1].branch).not.toBe("schedule-old");
      expect(host.create.mock.calls[0]![1].baseBranch).toBe("main");
    });
  });

  describe("refusing, and launching nowhere else", () => {
    const refusalCases: Array<{
      name: string;
      setup: WorktreeSetupStatus | undefined;
      reason: string;
    }> = [
      {
        name: "fails",
        setup: { state: "failed", stage: "setup-script", startedAt: 1, error: "npm ci exited 1" },
        reason: "setup failed while running its setup commands",
      },
      {
        name: "times out",
        setup: { state: "timed-out", stage: "setup-script", startedAt: 1 },
        reason: "setup timed out",
      },
      {
        name: "is waiting for command approval",
        setup: { state: "needs-approval", startedAt: 1 },
        reason: "waiting for you to approve its commands",
      },
      {
        name: "can't be read",
        setup: undefined,
        reason: "can't tell whether the new worktree's setup finished",
      },
    ];

    for (const { name, setup, reason } of refusalCases) {
      it(`records a refusal naming the worktree when its setup ${name}`, async () => {
        host.setupAfterCreate = setup;

        const outcome = await launch();

        expect(outcome).toMatchObject({
          status: "failed",
          message: expect.stringContaining(reason),
        });
        expectNothingLaunched();
        const [run] = recorder.listBySchedule(SCHEDULE_ID);
        expect(run?.settlement).toMatchObject({ outcome: "failed" });
        expect(run?.newWorktree?.worktreeId).toMatch(/^\/worktrees\//);
        expect(run?.resume).toBeNull();
        expect(store.worktreeClaim(SCHEDULE_ID)).toBeNull();
        // Nothing deletes it: it stays for review.
        expect(host.worktrees.size).toBe(1);
      });
    }

    it("records a refusal when the worktree can't be created", async () => {
      host.create.mockRejectedValueOnce(new Error("fatal: invalid reference: main"));

      const outcome = await launch();

      expect(outcome).toMatchObject({
        status: "failed",
        message: expect.stringContaining("invalid reference: main"),
      });
      expectNothingLaunched();
      const [run] = recorder.listBySchedule(SCHEDULE_ID);
      expect(run?.newWorktree?.worktreeId).toBeNull();
      expect(run?.newWorktree?.baseBranch).toBe("main");
    });

    it("refuses a spawn that lands anywhere but the run's worktree", async () => {
      deps.launchInView = vi.fn(async (_view, request) => {
        order.push("launch");
        try {
          admitScheduledSpawn({
            terminalId: request.args.requestedId,
            projectId: PROJECT_ID,
            scheduledRun: request.scheduledRun,
            launchAgentId: request.args.agentId,
            requestedCwd: "/repo",
            cwd: "/repo",
            worktreeId: request.args.worktreeId || undefined,
            agentLaunchFlags: [],
            agentModelId: undefined,
            agentPresetId: undefined,
            agentSessionId: undefined,
            handbackCode: undefined,
            assistant: false,
          });
        } catch (error) {
          return {
            ok: false as const,
            error: { code: "EXECUTION_ERROR", message: (error as Error).message },
          };
        }
        return { ok: true as const, result: { launched: true } };
      });

      const outcome = await launch();

      expect(outcome).toMatchObject({
        status: "failed",
        message: "The run's new worktree couldn't be found.",
      });
      expect(recorder.listBySchedule(SCHEDULE_ID)[0]?.resume).toBeNull();
    });

    it("closes no open run for one that can't get a worktree", async () => {
      await launch();
      schedule = { ...schedule, policies: { ...schedule.policies, overlap: "replace" } };
      host.setupAfterCreate = { state: "failed", startedAt: 1 };
      const answer = await launchScheduledRun(
        {
          projectId: PROJECT_ID,
          scheduleId: SCHEDULE_ID,
          origin: occurrence(T0),
        },
        deps
      );

      expect(answer.status).toBe("failed");
      expect(deps.closeRunTerminal).not.toHaveBeenCalled();
    });
  });

  describe("the precondition", () => {
    beforeEach(() => {
      schedule = {
        ...schedule,
        policies: { ...schedule.policies, precondition: { command: "true" } },
      };
    });

    it("runs in the project's folder, before anything is made", async () => {
      host.create.mockImplementationOnce(async (_project, { branch }) => {
        order.push("create");
        const id = `/worktrees/${branch}`;
        host.worktrees.set(branch, { id, path: id, branch, setupStatus: READY });
        return id;
      });

      await expect(launch()).resolves.toMatchObject({ status: "started" });

      expect(order).toEqual(["precondition", "create", "launch"]);
      expect(vi.mocked(deps.runPrecondition).mock.calls[0]![0].cwd).toBe("/repo");
    });

    it("leaves no worktree behind when it skips the run", async () => {
      deps.runPrecondition = vi.fn(async () => ({
        kind: "precondition" as const,
        exitCode: 1,
        signal: null,
        error: null,
      }));

      await expect(launch()).resolves.toMatchObject({ status: "skipped" });

      expect(host.create).not.toHaveBeenCalled();
      expect(store.worktreeClaim(SCHEDULE_ID)).toBeNull();
      expect(recorder.listBySchedule(SCHEDULE_ID)[0]?.newWorktree).toBeUndefined();
    });
  });

  it("makes nothing for an overlap the schedule skips", async () => {
    await launch();
    schedule = { ...schedule, policies: { ...schedule.policies, overlap: "skip" } };

    const outcome = await launch(occurrence(T0));

    expect(outcome.status).toBe("skipped");
    expect(host.create).toHaveBeenCalledTimes(1);
  });

  describe("cancelled while its worktree sets up", () => {
    beforeEach(() => {
      host.setupAfterCreate = { state: "running", startedAt: 1 };
    });

    it("records nothing and lets the claim go on a switch-off, keeping the worktree", async () => {
      host.list.mockImplementationOnce(async () => {
        cancelScheduledLaunches({ scheduleId: SCHEDULE_ID, automaticOnly: true });
        return [...host.worktrees.values()];
      });

      await expect(launch(occurrence(T0))).resolves.toEqual({ status: "not-found" });

      expectNothingLaunched();
      expect(recorder.listBySchedule(SCHEDULE_ID)).toEqual([]);
      expect(store.worktreeClaim(SCHEDULE_ID)).toBeNull();
      expect(host.worktrees.size).toBe(1);
    });

    it("keeps the claim on a quit, for the occurrence the next startup catches up", async () => {
      host.list.mockImplementationOnce(async () => {
        shuttingDown = true;
        return [...host.worktrees.values()];
      });

      await expect(launch(occurrence(T0))).resolves.toEqual({ status: "not-found" });

      expectNothingLaunched();
      expect(recorder.listBySchedule(SCHEDULE_ID)).toEqual([]);
      expect(store.worktreeClaim(SCHEDULE_ID)).not.toBeNull();
    });
  });

  it("forgets the claim when the schedule is deleted, and never touches the worktree", async () => {
    store.saveWorktreeClaim({
      scheduleId: SCHEDULE_ID,
      projectId: PROJECT_ID,
      branch: "schedule-x",
      baseBranch: "main",
      fromRemote: false,
    });

    recorder.deleteForSchedule(SCHEDULE_ID);

    expect(store.worktreeClaim(SCHEDULE_ID)).toBeNull();
  });

  it("never asks the host for anything on a schedule with a fixed target", async () => {
    for (const worktreeId of [null, "/worktrees/fixed"]) {
      schedule = {
        ...schedule,
        launch: { ...schedule.launch, worktreeId, newWorktree: null },
      };
      deps.launchInView = vi.fn(async (_view, request) => {
        expect(request.newWorktree).toBeUndefined();
        return launched(request);
      });

      await expect(launch()).resolves.toMatchObject({ status: "started" });
    }

    expect(host.list).not.toHaveBeenCalled();
    expect(host.create).not.toHaveBeenCalled();
    expect(store.worktreeClaim(SCHEDULE_ID)).toBeNull();
  });
});
