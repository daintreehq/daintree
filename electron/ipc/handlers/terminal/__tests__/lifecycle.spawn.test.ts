import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: {
    getPath: vi.fn(() => "/tmp/test"),
  },
}));

const { mockGetCurrentProject, mockGetProjectById, mockGetProjectSettings } = vi.hoisted(() => ({
  mockGetCurrentProject: vi.fn(),
  mockGetProjectById: vi.fn(),
  mockGetProjectSettings: vi.fn(),
}));

vi.mock("../../../../services/ProjectStore.js", () => ({
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

  it("handles deleted projectId with no current project gracefully", async () => {
    mockGetProjectById.mockReturnValue(null);
    mockGetCurrentProject.mockReturnValue(null);

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
    expect(spawnArgs.projectId).toBeUndefined();
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

  it("fetches project settings using resolved projectId, not current project", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    mockGetCurrentProject.mockReturnValue(projectB);
    mockGetProjectSettings.mockResolvedValue({
      terminalSettings: { shell: "/bin/bash" },
    });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "project-a-id",
      cols: 80,
      rows: 24,
    });

    expect(mockGetProjectSettings).toHaveBeenCalledWith("project-a-id");
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.shell).toBe("/bin/bash");
  });
});

describe("terminal spawn handler - cwd fallback (#5139: worktree is now renderer-owned)", () => {
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
    mockGetCurrentProject.mockReturnValue(null);
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
  });

  it("falls back to the current project path when cwd is inaccessible", async () => {
    const os = await import("os");
    const tmpDir = os.tmpdir();
    mockGetCurrentProject.mockReturnValue({ id: "p1", path: tmpDir, name: "p" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      cwd: "/nonexistent/path",
      cols: 80,
      rows: 24,
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.cwd).toBe(tmpDir);
  });

  it("falls back to homedir when no project path is available", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    const os = await import("os");
    await handler({} as Electron.IpcMainInvokeEvent, {
      cwd: "/nonexistent/path",
      cols: 80,
      rows: 24,
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.cwd).toBe(os.homedir());
  });

  it("forwards worktreeId to the pty client for session-history persistence (#5182)", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    const os = await import("os");
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cwd: os.homedir(),
        cols: 80,
        rows: 24,
        worktreeId: "wt-123",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.worktreeId).toBe("wt-123");
  });
});
