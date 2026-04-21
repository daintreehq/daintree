import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
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

const mockGetWindowForWebContents = vi.fn();
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: (...args: unknown[]) => mockGetWindowForWebContents(...args),
}));

vi.mock("../../../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

import { ipcMain, dialog } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectCrudHandlers } from "../projectCrud/index.js";
import type { HandlerDependencies } from "../../types.js";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handleMap = new Map<string, (...args: unknown[]) => unknown>();
  for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
    handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
  }
  const handler = handleMap.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler;
}

describe("handleProjectOpenDialog", () => {
  let handler: (...args: unknown[]) => unknown;

  beforeEach(() => {
    vi.clearAllMocks();

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: {
        getPrimary: () => ({
          windowId: 1,
          webContentsId: 10,
          browserWindow: { id: 1, isDestroyed: () => false },
        }),
        getByWindowId: () => undefined,
        getByWebContentsId: () => undefined,
        all: () => [],
        size: 1,
      },
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    handler = getHandler(CHANNELS.PROJECT_OPEN_DIALOG);
  });

  it("parents the dialog to the sender window when getWindowForWebContents returns a window", async () => {
    const fakeWindow = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow);
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      filePaths: ["/projects/my-repo"],
    });

    const fakeEvent = { sender: { id: 20 } };
    const result = await handler(fakeEvent);

    expect(mockGetWindowForWebContents).toHaveBeenCalledWith(fakeEvent.sender);
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      fakeWindow,
      expect.objectContaining({
        title: "Open Git Repository",
        properties: ["openDirectory", "createDirectory"],
      })
    );
    expect(result).toBe("/projects/my-repo");
  });

  it("calls dialog without parent when getWindowForWebContents returns null", async () => {
    mockGetWindowForWebContents.mockReturnValue(null);
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      filePaths: ["/projects/fallback"],
    });

    const fakeEvent = { sender: { id: 99 } };
    const result = await handler(fakeEvent);

    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Open Git Repository",
      })
    );
    // Should NOT have been called with a window as first arg
    const callArgs = (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs).toHaveLength(1); // only opts, no window
    expect(result).toBe("/projects/fallback");
  });

  it("returns null when dialog is canceled", async () => {
    mockGetWindowForWebContents.mockReturnValue({ id: 1 });
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: true,
      filePaths: [],
    });

    const result = await handler({ sender: { id: 10 } });
    expect(result).toBeNull();
  });

  it("returns null when filePaths is empty", async () => {
    mockGetWindowForWebContents.mockReturnValue({ id: 1 });
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      filePaths: [],
    });

    const result = await handler({ sender: { id: 10 } });
    expect(result).toBeNull();
  });

  it("returns the first file path on success", async () => {
    mockGetWindowForWebContents.mockReturnValue({ id: 1 });
    (dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      filePaths: ["/first/path", "/second/path"],
    });

    const result = await handler({ sender: { id: 10 } });
    expect(result).toBe("/first/path");
  });
});
