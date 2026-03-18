import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const mockGetCurrentProject = vi.fn();
const mockGetProjectById = vi.fn();
const mockGetProjectSettings = vi.fn();

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: mockGetCurrentProject,
    getProjectById: mockGetProjectById,
    getProjectSettings: mockGetProjectSettings,
  },
}));

vi.mock("../../../services/pty/terminalShell.js", () => ({
  getDefaultShell: vi.fn(() => "/bin/zsh"),
}));

vi.mock("../../utils.js", () => ({
  waitForRateLimitSlot: vi.fn(),
  consumeRestoreQuota: vi.fn(() => false),
}));

vi.mock("../../../../shared/config/agentRegistry.js", () => ({
  isRegisteredAgent: vi.fn(() => false),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { registerTerminalLifecycleHandlers } from "../lifecycle.js";
import type { HandlerDependencies } from "../../../types.js";

function getSpawnHandler() {
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  const spawnCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_SPAWN);
  return spawnCall?.[1] as unknown as (
    event: Electron.IpcMainInvokeEvent,
    options: Record<string, unknown>
  ) => Promise<string>;
}

describe("terminal spawn handler - projectId resolution", () => {
  const projectA = { id: "project-a-id", name: "Project A", path: "/projects/a" };
  const projectB = { id: "project-b-id", name: "Project B", path: "/projects/b" };

  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    mockGetCurrentProject.mockReturnValue(projectB);
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
  });

  it("uses explicit projectId when provided and valid", async () => {
    mockGetProjectById.mockReturnValue(projectA);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "project-a-id",
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("project-a-id");
  });

  it("falls back to current project when projectId is not provided", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("project-b-id");
  });

  it("falls back to current project when explicit projectId references deleted project", async () => {
    mockGetProjectById.mockReturnValue(null);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "deleted-project-id",
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("project-b-id");
  });

  it("uses explicit projectId even when current project differs", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    mockGetCurrentProject.mockReturnValue(projectB);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "project-a-id",
      cols: 80,
      rows: 24,
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("project-a-id");
    expect(mockGetProjectById).toHaveBeenCalledWith("project-a-id");
  });
});
