import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const instances: Array<{
    deps: Record<string, unknown>;
    start: ReturnType<typeof vi.fn>;
    suspend: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    unlock: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    instances,
    activeShutdown: null as object | null,
    launchScheduledRunLive: vi.fn(async () => ({ status: "not-found" as const })),
    list: vi.fn(async (projectId: string) => ({ projectId, schedules: [], revision: 3 })),
    unsubscribe: vi.fn(),
    subscribe: vi.fn(),
    recorder: { evaluationPoint: () => null },
    cancelScheduledLaunches: vi.fn(),
  };
});

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return { powerMonitor: new Emitter() };
});

vi.mock("../../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => mocks.activeShutdown,
}));

vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getAllProjectIdentities: () => [{ id: "project-1", path: "/repo", name: "Repo" }],
    getProjectById: (id: string) => (id === "project-1" ? { id } : null),
    schedules: {
      list: (projectId: string) => mocks.list(projectId),
      subscribe: (listener: unknown) => {
        mocks.subscribe(listener);
        return mocks.unsubscribe;
      },
    },
  },
}));

vi.mock("../index.js", () => ({ getScheduledRunRecorder: async () => mocks.recorder }));

vi.mock("../scheduledRunAdmission.js", () => ({
  cancelScheduledLaunches: mocks.cancelScheduledLaunches,
}));

vi.mock("../scheduledRunLaunchLive.js", () => ({
  launchScheduledRunLive: mocks.launchScheduledRunLive,
}));

vi.mock("../ScheduledRunScheduler.js", () => ({
  ScheduledRunScheduler: class {
    deps: Record<string, unknown>;
    start = vi.fn(async () => {});
    suspend = vi.fn();
    resume = vi.fn();
    unlock = vi.fn();
    check = vi.fn();
    dispose = vi.fn(async () => {});
    constructor(deps: Record<string, unknown>) {
      this.deps = deps;
      mocks.instances.push(this);
    }
  },
}));

import { powerMonitor } from "electron";
import {
  checkDueSchedules,
  startScheduledRunScheduler,
  stopScheduledRunScheduler,
} from "../scheduledRunSchedulerLive.js";

const power = powerMonitor as unknown as EventEmitter;

const originalArgv = process.argv;

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.activeShutdown = null;
});

afterEach(async () => {
  process.argv = originalArgv;
  await stopScheduledRunScheduler();
});

describe("scheduledRunSchedulerLive", () => {
  it("starts one scheduler and sends it the raw power events", () => {
    startScheduledRunScheduler();
    startScheduledRunScheduler();

    expect(mocks.instances).toHaveLength(1);
    const scheduler = mocks.instances[0]!;
    expect(scheduler.start).toHaveBeenCalledTimes(1);

    power.emit("suspend");
    expect(scheduler.suspend).toHaveBeenCalledTimes(1);
    expect(scheduler.resume).not.toHaveBeenCalled();
    expect(scheduler.unlock).not.toHaveBeenCalled();
    power.emit("resume");
    expect(scheduler.resume).toHaveBeenCalledTimes(1);
    expect(scheduler.unlock).not.toHaveBeenCalled();
    power.emit("unlock-screen");
    expect(scheduler.unlock).toHaveBeenCalledTimes(1);
    expect(scheduler.suspend).toHaveBeenCalledTimes(1);
    expect(scheduler.resume).toHaveBeenCalledTimes(1);
  });

  it("lists local projects and launches through the scheduled-run launcher", async () => {
    startScheduledRunScheduler();
    const deps = mocks.instances[0]!.deps as {
      listProjectIds: () => string[];
      projectExists: (id: string) => boolean;
      listSchedules: (projectId: string) => Promise<unknown>;
      subscribeSchedules: (listener: () => void) => () => void;
      getRecorder: () => Promise<unknown>;
      cancelLaunches: (scheduleId: string) => void;
      launch: (input: unknown) => Promise<unknown>;
      isShuttingDown: () => boolean;
    };

    expect(deps.listProjectIds()).toEqual(["project-1"]);
    expect(deps.projectExists("project-1")).toBe(true);
    expect(deps.projectExists("gone")).toBe(false);
    await expect(deps.listSchedules("project-1")).resolves.toEqual({
      projectId: "project-1",
      schedules: [],
      revision: 3,
    });
    const listener = () => {};
    expect(deps.subscribeSchedules(listener)).toBe(mocks.unsubscribe);
    expect(mocks.subscribe).toHaveBeenCalledWith(listener);
    await expect(deps.getRecorder()).resolves.toBe(mocks.recorder);
    deps.cancelLaunches("schedule-1");
    expect(mocks.cancelScheduledLaunches).toHaveBeenCalledWith({
      scheduleId: "schedule-1",
      automaticOnly: true,
    });
    const input = {
      projectId: "project-1",
      scheduleId: "schedule-1",
      origin: { trigger: "scheduled", dueAt: 0, occurrenceKey: "k", coalesced: null },
    };
    await deps.launch(input);
    expect(mocks.launchScheduledRunLive).toHaveBeenCalledWith(input);

    expect(deps.isShuttingDown()).toBe(false);
    mocks.activeShutdown = {};
    expect(deps.isShuttingDown()).toBe(true);
  });

  it("stops listening and disposes the scheduler on stop", async () => {
    startScheduledRunScheduler();
    const scheduler = mocks.instances[0]!;

    await stopScheduledRunScheduler();
    expect(scheduler.dispose).toHaveBeenCalledTimes(1);
    expect(power.listenerCount("suspend")).toBe(0);
    expect(power.listenerCount("resume")).toBe(0);
    expect(power.listenerCount("unlock-screen")).toBe(0);
  });

  /** A fresh copy of the module, as a new process has. */
  async function freshLive() {
    vi.resetModules();
    return import("../scheduledRunSchedulerLive.js");
  }

  it("gives the first scheduler of a process an OS job started its launch on both clocks", async () => {
    process.argv = [...originalArgv, "--run-due-schedules"];
    const live = await freshLive();
    live.startScheduledRunScheduler();
    const osLaunch = mocks.instances[0]!.deps.osLaunch as { at: number; monotonicAt: number };
    expect(osLaunch.at).toBe(performance.timeOrigin);
    expect(osLaunch.at + performance.now()).toBeCloseTo(Date.now(), -3);

    await live.stopScheduledRunScheduler();
    live.startScheduledRunScheduler();
    expect(mocks.instances[1]!.deps.osLaunch).toBeNull();
    await live.stopScheduledRunScheduler();
  });

  it("gives any other launch no OS launch", async () => {
    const live = await freshLive();
    live.startScheduledRunScheduler();
    expect(mocks.instances[0]!.deps.osLaunch).toBeNull();
    await live.stopScheduledRunScheduler();
  });

  it("asks a running scheduler to look at once, and does nothing before it starts", () => {
    checkDueSchedules();
    startScheduledRunScheduler();
    const scheduler = mocks.instances[0]!;
    expect(scheduler.check).not.toHaveBeenCalled();

    checkDueSchedules();
    expect(scheduler.check).toHaveBeenCalledTimes(1);
  });

  it("starts nothing once shutdown has begun", () => {
    mocks.activeShutdown = {};
    startScheduledRunScheduler();

    expect(mocks.instances).toEqual([]);
    expect(power.listenerCount("resume")).toBe(0);
  });
});
