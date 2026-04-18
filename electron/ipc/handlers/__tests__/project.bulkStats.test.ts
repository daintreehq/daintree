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

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectCrudHandlers } from "../projectCrud.js";
import type { HandlerDependencies } from "../../types.js";

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
          kind: "agent",
          agentId: "claude",
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
          kind: "agent",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
        {
          id: "t2",
          projectId: "proj-a",
          kind: "agent",
          agentState: "waiting",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 2,
        },
        {
          id: "t3",
          projectId: "proj-a",
          kind: "agent",
          agentState: "running",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 3,
        },
        {
          id: "t4",
          projectId: "proj-a",
          kind: "agent",
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

    expect(result["proj-a"].activeAgentCount).toBe(2); // working + running
    expect(result["proj-a"].waitingAgentCount).toBe(1); // waiting only
  });

  it("filters out trashed, dev-preview, exited, and non-agent terminals", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "agent",
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
          kind: "agent",
          agentState: "working",
          hasPty: false,
          cwd: "/tmp",
          spawnedAt: 3,
        },
        {
          id: "t4",
          projectId: "proj-a",
          kind: "terminal",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 4,
        },
        {
          id: "t5",
          projectId: "proj-a",
          kind: "agent",
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

  it("counts terminals with agentId as agents even without kind=agent", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        {
          id: "t1",
          projectId: "proj-a",
          kind: "terminal",
          agentId: "claude",
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
          kind: "agent",
          agentState: "working",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 1,
        },
        {
          id: "t2",
          projectId: "proj-a",
          kind: "agent",
          agentState: "waiting",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 2,
        },
        {
          id: "t3",
          projectId: "proj-b",
          kind: "agent",
          agentState: "running",
          hasPty: true,
          cwd: "/tmp",
          spawnedAt: 3,
        },
        {
          id: "t4",
          projectId: "proj-c",
          kind: "agent",
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
          kind: "agent",
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

  it("skips terminals without a projectId", async () => {
    const ptyClient = makePtyClient({
      getAllTerminalsAsync: vi.fn().mockResolvedValue([
        { id: "t1", kind: "agent", agentState: "working", hasPty: true, cwd: "/tmp", spawnedAt: 1 }, // no projectId
        {
          id: "t2",
          projectId: "proj-a",
          kind: "agent",
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
