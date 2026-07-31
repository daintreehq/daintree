import { describe, it, expect, vi, beforeEach } from "vitest";
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

vi.mock("../../utils.js", () => ({
  checkRateLimit: checkRateLimitMock,
  broadcastToRenderer: vi.fn(),
  sendToRenderer: vi.fn(),
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

vi.mock("../../../window/deferredInitQueue.js", () => ({
  registerDeferredTask: vi.fn(),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectCrudHandlers } from "../projectCrud/index.js";
import type { HandlerDependencies } from "../../types.js";
import { registerDeferredTask } from "../../../window/deferredInitQueue.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { scratchStore } from "../../../services/ScratchStore.js";

function makePtyClient(overrides: Record<string, unknown> = {}) {
  return {
    getProjectStats: vi.fn().mockResolvedValue({
      terminalCount: 2,
      terminalTypes: { terminal: 1, agent: 1 },
      processIds: [100, 200],
    }),
    getAllTerminalsAsync: vi.fn().mockResolvedValue([]),
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

  it("answers for a requested scratch id", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi
        .fn()
        .mockResolvedValue([completedTerminal(SCRATCH_ID, 2_000, "t1")]),
    });
    registerProjectCrudHandlers(makeDeps(ptyClient));

    const result = (await getBulkStatsHandler()(fakeEvent, [SCRATCH_ID])) as Record<
      string,
      { completedAgentCount: number; unacknowledgedCompletedAgentCount: number }
    >;

    expect(result[SCRATCH_ID]!.completedAgentCount).toBe(1);
    expect(result[SCRATCH_ID]!.unacknowledgedCompletedAgentCount).toBe(1);
  });

  // Read against the project-only map, every scratch completion would report as
  // unacknowledged forever — the row would never leave "ready for review".
  it("honours the scratch's own acknowledgement watermark", async () => {
    (scratchStore.getLastCompletionSeenMap as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([[SCRATCH_ID, 5_000]])
    );
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi
        .fn()
        .mockResolvedValue([completedTerminal(SCRATCH_ID, 2_000, "t1")]),
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
