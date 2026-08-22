import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  dialog: {
    showOpenDialog: vi.fn(),
    showErrorBox: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const checkRateLimitMock = vi.hoisted(() => vi.fn());

// Kept strictly hand-listed rather than spreading the real module: an export
// that goes missing here fails loudly the moment a new effectful dependency
// crosses this unit's boundary, which is the signal we want. Spreading would
// silence that by running the real thing — real rate-limit queues, real timers,
// real renderer plumbing — and it would not even be complete, since overriding
// the export object does not rewrite calls made inside the module itself.
vi.mock("../../utils.js", () => ({
  checkRateLimit: checkRateLimitMock,
  broadcastToRenderer: vi.fn(),
  sendToRenderer: vi.fn(),
  // Registering the CRUD handlers starts real `ProjectStatsService` and
  // `FleetSnapshotService` pollers whose compute broadcasts through this.
  // Omitting it is what produced the CI red: the poller tick rejected with
  // "No 'typedBroadcast' export is defined on the mock", and because that
  // rejection only lands if the tick fires before teardown, it surfaced on a
  // loaded runner and not locally. The disposer below stops the pollers; this
  // stub keeps a tick that fires mid-test inside the unit boundary.
  typedBroadcast: vi.fn(),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: (channel: string, _schema: unknown, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      (event: { sender?: { id?: number } } | null | undefined, ...args: unknown[]) => {
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: null,
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProjectId: vi.fn(),
    getProjectById: vi.fn(),
    setCurrentProject: vi.fn(),
    getProjectState: vi.fn(),
    saveProjectState: vi.fn(),
    getAllProjects: vi.fn(() => []),
    getCurrentProject: vi.fn(() => null),
    updateProjectStatus: vi.fn(),
    updateProject: vi.fn(),
    getLastCompletionSeenMap: vi.fn(() => new Map<string, number>()),
  },
}));

const ackDepsCapture = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

// Captured rather than exercised on its timer: the routing decision inside
// `markSeen` is the whole point, and driving the real 1s sampler to reach it
// would test the dwell clock instead.
vi.mock("../../../services/CompletionAcknowledgementService.js", () => ({
  CompletionAcknowledgementService: class {
    constructor(deps: Record<string, unknown>) {
      ackDepsCapture.current = deps;
    }
    start() {}
    stop() {}
  },
}));

vi.mock("../../../services/ScratchStore.js", () => ({
  scratchStore: {
    getAllScratches: vi.fn(() => []),
    getLastCompletionSeenMap: vi.fn(() => new Map<string, number>()),
    markCompletionSeen: vi.fn(),
  },
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: class MockProjectSwitchService {
    onSwitch = vi.fn();
    switchProject = vi.fn();
    reopenProject = vi.fn();
  },
}));

vi.mock("../../../services/RunCommandDetector.js", () => ({
  runCommandDetector: { detect: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(),
}));

vi.mock("../../../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

// Same default as the push-path suite: on screen unless a test hides it.
const helpSessionMock = vi.hoisted(() => ({
  isPanelVisible: vi.fn<(id: string) => boolean>(() => true),
}));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: helpSessionMock,
}));
vi.mock("../../../window/deferredInitQueue.js", () => ({
  registerDeferredTask: vi.fn(),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import { registerDeferredTask } from "../../../window/deferredInitQueue.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { scratchStore } from "../../../services/ScratchStore.js";
import { createProjectCrudRegistrar } from "./helpers/projectCrudLifecycle.js";
import { getAgentAvailabilityStore } from "../../../services/AgentAvailabilityStore.js";
import {
  ASSISTANT_PROJECTION_PARITY,
  PARITY_ASSISTANT_TERMINAL,
} from "../../../services/__tests__/helpers/assistantProjectionParity.js";

// Disposes the stats/fleet pollers after each test; see the helper for why
// dropping the disposer is what produced this file's CI flake. Still returns
// the disposer, because two tests below stop the services themselves to assert
// the post-stop behaviour of the deferred initial compute.
const registerProjectCrudHandlers = createProjectCrudRegistrar();

function makePtyClient(overrides: Record<string, unknown> = {}) {
  return {
    getProjectStats: vi.fn().mockResolvedValue({
      terminalCount: 2,
      terminalTypes: { terminal: 1, agent: 1 },
      processIds: [100, 200],
    }),
    getAllTerminalsAsync: vi.fn().mockResolvedValue([]),
    // FleetSnapshotService's poll calls this. Answering it explicitly — rather
    // than letting the fake come up short and throw a caught TypeError inside
    // the poller — keeps a tick that fires mid-test from muddying these tests'
    // logs. `degraded: false` is the honest fake: the shards all answered.
    getAllTerminalsWithCompletenessAsync: vi
      .fn()
      .mockResolvedValue({ terminals: [], degraded: false }),
    getTerminalsForProjectAsync: vi.fn().mockResolvedValue([]),
    getTerminalAsync: vi.fn().mockResolvedValue(null),
    getMemoryRollup: vi.fn().mockResolvedValue({
      byProject: [],
      totalMemoryKb: 0,
      totalProcessCount: 0,
      terminalCount: 0,
      available: false,
      sampledAt: 0,
    }),
    ...overrides,
  };
}

function makeDeps(ptyClient: ReturnType<typeof makePtyClient>): HandlerDependencies {
  return {
    mainWindow: { id: 1 } as unknown,
    ptyClient,
    windowRegistry: {
      getByWindowId: () => undefined,
      getByWebContentsId: () => undefined,
      getPrimary: () => undefined,
      all: () => [],
      size: 0,
    },
  } as unknown as HandlerDependencies;
}

function getBulkStatsHandler(): (...args: unknown[]) => Promise<unknown> {
  const handleMap = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
    handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => Promise<unknown>);
  }
  const handler = handleMap.get(CHANNELS.PROJECT_GET_BULK_STATS);
  if (!handler) throw new Error("PROJECT_GET_BULK_STATS handler not registered");
  return handler;
}

const fakeEvent = { sender: { id: 10 } } as unknown as Electron.IpcMainInvokeEvent;

describe("handleProjectGetBulkStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls getAllTerminalsAsync once instead of per-terminal getTerminalAsync", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: Date.now(),
        },
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    await handler(fakeEvent, ["proj-a"]);

    expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(ptyClient.getTerminalsForProjectAsync).not.toHaveBeenCalled();
  });

  it("computes active and waiting agent counts from bulk terminal list", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
        {
          id: "t2",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "waiting",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 2,
        },
        {
          id: "t3",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 3,
        },
        {
          id: "t4",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "idle",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 4,
        },
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { activeAgentCount: number; waitingAgentCount: number }
    >;

    expect(result["proj-a"].activeAgentCount).toBe(2); // working only
    expect(result["proj-a"].waitingAgentCount).toBe(1); // waiting only
  });

  it("filters out trashed, dev-preview, exited, and non-agent terminals", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          isTrashed: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
        {
          id: "t2",
          projectId: "proj-a",
          kind: "dev-preview",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 2,
        },
        {
          id: "t3",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: false,
          cwd: "/tmp",
          spawnedAt: 3,
        },
        {
          id: "t4",
          projectId: "proj-a",
          kind: "terminal",
          // Plain terminal (no launchAgentId/detectedAgentId) — filtered out by the agent-count guard.
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 4,
        },
        {
          id: "t5",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 5,
        },
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { activeAgentCount: number }
    >;

    // Only t5 passes all filters
    expect(result["proj-a"].activeAgentCount).toBe(1);
  });

  it("counts launchAgentId only as a boot-window agent before detection commits", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { activeAgentCount: number }
    >;

    expect(result["proj-a"].activeAgentCount).toBe(1);
  });

  it("does not count demoted launch-agent terminals as active agents", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          everDetectedAgent: true,
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { activeAgentCount: number }
    >;

    expect(result["proj-a"].activeAgentCount).toBe(0);
  });

  it("counts runtime-detected agents launched from plain terminals", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "terminal",
          detectedAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { activeAgentCount: number }
    >;

    expect(result["proj-a"].activeAgentCount).toBe(1);
  });

  it("groups terminals by projectId across multiple projects", async () => {
    const ptyClient = makePtyClient({
      getProjectStats: vi.fn().mockImplementation((id: string) =>
        Promise.resolve({
          terminalCount: id === "proj-a" ? 2 : 1,
          terminalTypes: { agent: id === "proj-a" ? 2 : 1 },
          processIds: id === "proj-a" ? [100, 200] : [300],
        })
      ),
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
        {
          id: "t2",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "waiting",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 2,
        },
        {
          id: "t3",
          projectId: "proj-b",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 3,
        },
        {
          id: "t4",
          projectId: "proj-c",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 4,
        }, // not requested
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a", "proj-b"])) as Record<
      string,
      { activeAgentCount: number; waitingAgentCount: number }
    >;

    expect(result["proj-a"].activeAgentCount).toBe(1);
    expect(result["proj-a"].waitingAgentCount).toBe(1);
    expect(result["proj-b"].activeAgentCount).toBe(1);
    expect(result["proj-b"].waitingAgentCount).toBe(0);
    expect(result["proj-c"]).toBeUndefined();
  });

  it("deduplicates input project IDs", async () => {
    const ptyClient = makePtyClient();
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    await handler(fakeEvent, ["proj-a", "proj-a", "proj-a"]);

    expect(ptyClient.getProjectStats).toHaveBeenCalledTimes(1);
  });

  it("returns empty object for empty input", async () => {
    const ptyClient = makePtyClient();
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = await handler(fakeEvent, []);

    expect(result).toEqual({});
    expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
    expect(ptyClient.getProjectStats).not.toHaveBeenCalled();
  });

  it("omits projects whose getProjectStats call rejects", async () => {
    const ptyClient = makePtyClient({
      getProjectStats: vi.fn().mockImplementation((id: string) =>
        id === "proj-bad"
          ? Promise.reject(new Error("stats failed"))
          : Promise.resolve({
              terminalCount: 1,
              terminalTypes: { agent: 1 },
              processIds: [100],
            })
      ),
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-ok",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-ok", "proj-bad"])) as Record<string, unknown>;

    expect(result["proj-ok"]).toBeDefined();
    expect(result["proj-bad"]).toBeUndefined();
  });

  it("returns zero agent counts when getAllTerminalsAsync fails", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([]), // PtyClient.getAllTerminalsAsync catches errors and returns []
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { activeAgentCount: number; waitingAgentCount: number; terminalCount: number }
    >;

    expect(result["proj-a"].activeAgentCount).toBe(0);
    expect(result["proj-a"].waitingAgentCount).toBe(0);
    // ptyStats fields are still populated
    expect(result["proj-a"].terminalCount).toBe(2);
  });

  it("calls checkRateLimit with project:get-bulk-stats limits", async () => {
    const ptyClient = makePtyClient();
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    await handler(fakeEvent, ["proj-a"]);

    expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.PROJECT_GET_BULK_STATS, 10, 10_000);
  });

  it("propagates rate-limit errors without fetching terminals or stats", async () => {
    checkRateLimitMock.mockImplementationOnce(() => {
      throw new Error("Rate limit exceeded");
    });
    const ptyClient = makePtyClient();
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    await expect(handler(fakeEvent, ["proj-a"])).rejects.toThrow("Rate limit exceeded");
    expect(ptyClient.getAllTerminalsAsync).not.toHaveBeenCalled();
    expect(ptyClient.getProjectStats).not.toHaveBeenCalled();
  });

  it("populates measured terminalMemoryMB and topProcess from the memory rollup", async () => {
    const ptyClient = makePtyClient({
      getProjectStats: vi.fn().mockResolvedValue({
        terminalCount: 2,
        terminalTypes: { agent: 2 },
        processIds: [100, 200],
      }),
      getMemoryRollup: vi.fn().mockResolvedValue({
        available: true,
        totalMemoryKb: 1_572_864,
        totalProcessCount: 3,
        terminalCount: 2,
        sampledAt: 1,
        byProject: [
          {
            projectId: "proj-a",
            terminalCount: 2,
            processCount: 3,
            memoryKb: 1_572_864, // 1536 MB
            topProcesses: [{ pid: 101, comm: "node", cpuPercent: 12, memoryKb: 931_840 }], // 910 MB
          },
        ],
      }),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      {
        terminalMemoryMB?: number;
        topProcess?: { name: string; memoryMB: number };
        estimatedMemoryMB: number;
      }
    >;

    expect(result["proj-a"].terminalMemoryMB).toBe(1536);
    expect(result["proj-a"].topProcess).toEqual({ name: "node", memoryMB: 910 });
    // The synthetic estimate stays as a fallback alongside the measurement.
    expect(result["proj-a"].estimatedMemoryMB).toBe(100);
  });

  it("does not request the memory rollup for empty input", async () => {
    const ptyClient = makePtyClient();
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    await handler(fakeEvent, []);

    expect(ptyClient.getMemoryRollup).not.toHaveBeenCalled();
  });

  it("leaves terminalMemoryMB undefined when the measured project has zero processes", async () => {
    const ptyClient = makePtyClient({
      getProjectStats: vi.fn().mockResolvedValue({
        terminalCount: 1,
        terminalTypes: { agent: 1 },
        processIds: [100],
      }),
      getMemoryRollup: vi.fn().mockResolvedValue({
        available: true,
        byProject: [
          // Terminal exists but its shell pid isn't in the process table yet.
          { projectId: "proj-a", terminalCount: 1, processCount: 0, memoryKb: 0, topProcesses: [] },
        ],
        totalMemoryKb: 0,
        totalProcessCount: 0,
        terminalCount: 1,
        sampledAt: 1,
      }),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { terminalMemoryMB?: number; topProcess?: unknown }
    >;

    expect(result["proj-a"].terminalMemoryMB).toBeUndefined();
    expect(result["proj-a"].topProcess).toBeUndefined();
  });

  it("leaves terminalMemoryMB undefined when the rollup is unavailable", async () => {
    const ptyClient = makePtyClient({
      getProjectStats: vi.fn().mockResolvedValue({
        terminalCount: 1,
        terminalTypes: { agent: 1 },
        processIds: [100],
      }),
      getMemoryRollup: vi.fn().mockResolvedValue({
        available: false,
        byProject: [
          {
            projectId: "proj-a",
            terminalCount: 1,
            processCount: 1,
            memoryKb: 999_999,
            topProcesses: [],
          },
        ],
        totalMemoryKb: 0,
        totalProcessCount: 0,
        terminalCount: 0,
        sampledAt: 0,
      }),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { terminalMemoryMB?: number }
    >;

    expect(result["proj-a"].terminalMemoryMB).toBeUndefined();
  });

  it("skips terminals without a projectId", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        }, // no projectId
        {
          id: "t2",
          projectId: "proj-a",
          kind: "terminal",
          launchAgentId: "claude",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 2,
        },
      ]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));
    const handler = getBulkStatsHandler();

    const result = (await handler(fakeEvent, ["proj-a"])) as Record<
      string,
      { activeAgentCount: number }
    >;

    expect(result["proj-a"].activeAgentCount).toBe(1); // only t2
  });
});

describe("registerProjectStatsHandlers — deferred initial compute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defers the initial compute via registerDeferredTask instead of firing it eagerly", async () => {
    (projectStore.getAllProjects as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "p1" }]);
    const ptyClient = makePtyClient();
    const cleanup = registerProjectCrudHandlers(makeDeps(ptyClient));

    expect(ptyClient.getAllTerminalsAsync).not.toHaveBeenCalled();
    expect(ptyClient.getProjectStats).not.toHaveBeenCalled();

    const mock = registerDeferredTask as unknown as ReturnType<typeof vi.fn>;
    const taskCall = mock.mock.calls.find(
      ([t]) => (t as { name?: string } | undefined)?.name === "project-stats-initial-compute"
    );
    expect(taskCall).toBeDefined();
    const task = taskCall![0] as { name: string; run: () => void };

    task.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("deferred initial compute is a no-op once the service has stopped", async () => {
    (projectStore.getAllProjects as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "p1" }]);
    const ptyClient = makePtyClient();
    const cleanup = registerProjectCrudHandlers(makeDeps(ptyClient));

    const mock = registerDeferredTask as unknown as ReturnType<typeof vi.fn>;
    const task = (mock.mock.calls.find(
      ([t]) => (t as { name?: string } | undefined)?.name === "project-stats-initial-compute"
    )?.[0] ?? null) as { name: string; run: () => void } | null;
    expect(task).not.toBeNull();

    cleanup();

    task!.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyClient.getAllTerminalsAsync).not.toHaveBeenCalled();
  });
});

/**
 * Scratch workspaces in the bulk pull and the acknowledgement loop (#11518).
 *
 * The palette's open-time pull is the guaranteed hydration path — the push
 * channel is best-effort — so it has to answer for scratch ids too. And once a
 * scratch carries a status entry, the dwell that clears "ready for review" is
 * reachable with a scratch id, which `projectStore` has no row for.
 */
describe("bulk stats and acknowledgement for scratch workspaces", () => {
  const SCRATCH_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  beforeEach(() => {
    vi.clearAllMocks();
    ackDepsCapture.current = null;
    (scratchStore.getLastCompletionSeenMap as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map<string, number>()
    );
    (projectStore.getLastCompletionSeenMap as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map<string, number>()
    );
  });

  function completedTerminal(workspaceId: string, at: number, id: string) {
    return {
      id,
      projectId: workspaceId,
      kind: "terminal",
      launchAgentId: "claude",
      agentState: "completed",
      hasPty: true,
      cwd: "/tmp",
      spawnedAt: 0,
      lastStateChange: at,
    };
  }

  // Read against the project-only map, every scratch completion would report as
  // unacknowledged forever — the row would never leave "ready for review".
  it("honours the scratch's own acknowledgement watermark", async () => {
    (scratchStore.getLastCompletionSeenMap as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([[SCRATCH_ID, 5_000]])
    );
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([completedTerminal(SCRATCH_ID, 2_000, "t1")]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));

    const result = (await getBulkStatsHandler()(fakeEvent, [SCRATCH_ID])) as Record<
      string,
      { completedAgentCount: number; unacknowledgedCompletedAgentCount: number }
    >;

    expect(result[SCRATCH_ID]!.completedAgentCount).toBe(1);
    expect(result[SCRATCH_ID]!.unacknowledgedCompletedAgentCount).toBe(0);
  });

  it("stamps a scratch acknowledgement on the scratch store, never the project store", () => {
    registerProjectCrudHandlers(makeDeps(makePtyClient()));
    const markSeen = ackDepsCapture.current!.markSeen as (id: string, seen: number) => void;

    markSeen(SCRATCH_ID, 7_000);

    expect(scratchStore.markCompletionSeen).toHaveBeenCalledWith(SCRATCH_ID, 7_000);
    expect(projectStore.updateProject).not.toHaveBeenCalled();
  });

  it("leaves the project path untouched", () => {
    registerProjectCrudHandlers(makeDeps(makePtyClient()));
    const markSeen = ackDepsCapture.current!.markSeen as (id: string, seen: number) => void;

    markSeen("a".repeat(64), 7_000);

    expect(projectStore.updateProject).toHaveBeenCalledWith("a".repeat(64), {
      lastCompletionSeenAt: 7_000,
    });
    expect(scratchStore.markCompletionSeen).not.toHaveBeenCalled();
  });
});

describe("bulk stats assistant presence (#11806)", () => {
  const PROJECT_ID = "b".repeat(64);
  const HELP_TERMINAL_ID = "help-1";

  function helpTerminal(over: Record<string, unknown> = {}) {
    return {
      id: HELP_TERMINAL_ID,
      projectId: PROJECT_ID,
      kind: "terminal",
      launchAgentId: "daintree-assistant",
      hasPty: true,
      ...over,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    helpSessionMock.isPanelVisible.mockReturnValue(true);
    // The real availability store, because that is what decides `"help"` and
    // this test exists to prove the seed reads the same verdict the push does.
    getAgentAvailabilityStore().markAsHelp(HELP_TERMINAL_ID);
  });

  afterEach(() => {
    // The store is a module singleton — a mark left behind would make every
    // later test in this process treat that id as the assistant.
    getAgentAvailabilityStore().unmarkAsHelp(HELP_TERMINAL_ID);
  });

  it("seeds the same assistant facts the pushed status map reports", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([helpTerminal(PARITY_ASSISTANT_TERMINAL)]),
      getProjectStats: vi.fn().mockResolvedValue({
        terminalCount: 1,
        terminalTypes: { terminal: 1 },
        processIds: [100],
      }),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));

    const result = (await getBulkStatsHandler()(fakeEvent, [PROJECT_ID])) as Record<
      string,
      Record<string, unknown>
    >;

    const entry = result[PROJECT_ID]!;
    // The same expectation `ProjectStatsService.adversarial.test.ts` asserts
    // against the push producer for the same terminal — a seed that let the
    // assistant into the worker counts, or dropped a presence field the push
    // keeps, is the seed-vs-push disagreement #10989 removed.
    expect({
      assistantState: entry.assistantState,
      assistantWaitingReason: entry.assistantWaitingReason,
      assistantStateSince: entry.assistantStateSince,
      activeAgentCount: entry.activeAgentCount,
      waitingAgentCount: entry.waitingAgentCount,
      processCount: entry.processCount,
    }).toEqual(ASSISTANT_PROJECTION_PARITY);
  });

  it("omits them again once the user hides the panel", async () => {
    // The seed reads the same visibility gate the push does. A palette opened
    // with a hidden assistant would otherwise hydrate the row with a wait the
    // pushed map has already stopped reporting, and the push suppresses
    // unchanged payloads — so nothing would take it back down.
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([helpTerminal(PARITY_ASSISTANT_TERMINAL)]),
      getProjectStats: vi.fn().mockResolvedValue({
        terminalCount: 1,
        terminalTypes: { terminal: 1 },
        processIds: [100],
      }),
    });
    helpSessionMock.isPanelVisible.mockReturnValue(false);
    registerProjectCrudHandlers(makeDeps(ptyClient));

    const result = (await getBulkStatsHandler()(fakeEvent, [PROJECT_ID])) as Record<
      string,
      Record<string, unknown>
    >;

    const entry = result[PROJECT_ID]!;
    expect(entry).not.toHaveProperty("assistantState");
    expect(entry).not.toHaveProperty("assistantWaitingReason");
    expect(entry).not.toHaveProperty("assistantStateSince");
    expect(entry.processCount).toBe(0);
  });

  it("omits the assistant fields when the project has no live assistant", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));

    const result = (await getBulkStatsHandler()(fakeEvent, [PROJECT_ID])) as Record<
      string,
      Record<string, unknown>
    >;

    expect(result[PROJECT_ID]).not.toHaveProperty("assistantState");
    expect(result[PROJECT_ID]).not.toHaveProperty("assistantWaitingReason");
    expect(result[PROJECT_ID]).not.toHaveProperty("assistantStateSince");
  });
});
