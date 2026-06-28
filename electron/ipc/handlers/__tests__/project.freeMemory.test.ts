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

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(),
  getProjectById:
    vi.fn<
      (projectId: string) => { id: string; name: string; status?: string; path?: string } | null
    >(),
  updateProjectStatus:
    vi.fn<(projectId: string, status: "active" | "background" | "closed") => unknown>(),
}));

const evictProjectRendererMock = vi.hoisted(() => vi.fn<(projectId: string) => number>());
const writeHibernatedMarkerMock = vi.hoisted(() => vi.fn<(terminalId: string) => void>());

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../../../services/HibernationService.js", () => ({
  getHibernationService: () => ({ evictProjectRenderer: evictProjectRendererMock }),
}));

vi.mock("../../../services/pty/terminalSessionPersistence.js", () => ({
  writeHibernatedMarker: writeHibernatedMarkerMock,
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: class MockProjectSwitchService {
    onSwitch = vi.fn();
  },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectCrudHandlers } from "../projectCrud/index.js";
import type { HandlerDependencies } from "../../types.js";

type FreeMemoryResult = {
  terminalsKilled: number;
  rendererEvicted: boolean;
  workspaceEvicted: boolean;
};

type FreeMemoryHandler = (event: unknown, projectId: string) => Promise<FreeMemoryResult>;

function getFreeMemoryHandler(deps: HandlerDependencies): FreeMemoryHandler {
  registerProjectCrudHandlers(deps);
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  const call = calls.find((c) => c[0] === CHANNELS.PROJECT_FREE_MEMORY);
  expect(call).toBeTruthy();
  return call?.[1] as unknown as FreeMemoryHandler;
}

const EVENT = { senderFrame: { url: "http://localhost:5173" } };

describe("project:free-memory handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects freeing memory for the active project", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");

    const ptyClient = { gracefulKillByProject: vi.fn(async () => []) };
    const worktreeService = { evictProject: vi.fn(() => true) };
    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
      worktreeService,
    } as unknown as HandlerDependencies;

    const handler = getFreeMemoryHandler(deps);

    await expect(handler(EVENT, "project-active")).rejects.toThrow("Switch to another project");
    expect(ptyClient.gracefulKillByProject).not.toHaveBeenCalled();
    expect(worktreeService.evictProject).not.toHaveBeenCalled();
  });

  it("throws when the project does not exist", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");
    projectStoreMock.getProjectById.mockReturnValue(null);

    const deps = {
      mainWindow: {} as unknown,
      ptyClient: { gracefulKillByProject: vi.fn(async () => []) },
      worktreeService: { evictProject: vi.fn(() => false) },
    } as unknown as HandlerDependencies;

    const handler = getFreeMemoryHandler(deps);

    await expect(handler(EVENT, "missing")).rejects.toThrow("Project not found");
  });

  it("is idempotent for an already-closed project (no kills)", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "project-closed",
      name: "Closed Project",
      status: "closed",
      path: "/test/project-closed",
    });

    const ptyClient = { gracefulKillByProject: vi.fn(async () => []) };
    const worktreeService = { evictProject: vi.fn(() => true) };
    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
      worktreeService,
    } as unknown as HandlerDependencies;

    const handler = getFreeMemoryHandler(deps);
    const result = await handler(EVENT, "project-closed");

    expect(result).toEqual({
      terminalsKilled: 0,
      rendererEvicted: false,
      workspaceEvicted: false,
    });
    expect(ptyClient.gracefulKillByProject).not.toHaveBeenCalled();
    expect(evictProjectRendererMock).not.toHaveBeenCalled();
    expect(worktreeService.evictProject).not.toHaveBeenCalled();
    expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
  });

  it("frees a background project: graceful kill, markers, renderer + workspace eviction, marks closed", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "project-bg",
      name: "Background Project",
      status: "background",
      path: "/test/project-bg",
    });
    evictProjectRendererMock.mockReturnValue(1);

    const ptyClient = {
      gracefulKillByProject: vi.fn(async () => [
        { id: "term-1", agentSessionId: "sess-1" },
        { id: "term-2", agentSessionId: null },
      ]),
    };
    const worktreeService = { evictProject: vi.fn(() => true) };
    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
      worktreeService,
    } as unknown as HandlerDependencies;

    const handler = getFreeMemoryHandler(deps);
    const result = await handler(EVENT, "project-bg");

    // Session-preserving graceful kill — NOT the destructive killByProject.
    expect(ptyClient.gracefulKillByProject).toHaveBeenCalledWith("project-bg", {
      preserveSession: true,
    });
    // A hibernation marker is written per killed terminal so reopen restores warm.
    expect(writeHibernatedMarkerMock).toHaveBeenCalledTimes(2);
    expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("term-1");
    expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("term-2");

    expect(evictProjectRendererMock).toHaveBeenCalledWith("project-bg");
    expect(worktreeService.evictProject).toHaveBeenCalledWith("/test/project-bg");

    // Marked closed WITHOUT clearProjectState — layout survives for reopen.
    expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("project-bg", "closed");

    expect(result).toEqual({
      terminalsKilled: 2,
      rendererEvicted: true,
      workspaceEvicted: true,
    });
  });

  it("reports rendererEvicted=false / workspaceEvicted=false when nothing was resident", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-active");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "project-bg",
      name: "Background Project",
      status: "background",
      path: "/test/project-bg",
    });
    evictProjectRendererMock.mockReturnValue(0);

    const ptyClient = { gracefulKillByProject: vi.fn(async () => []) };
    // Held by another window (refCount > 0) → eviction skipped.
    const worktreeService = { evictProject: vi.fn(() => false) };
    const deps = {
      mainWindow: {} as unknown,
      ptyClient,
      worktreeService,
    } as unknown as HandlerDependencies;

    const handler = getFreeMemoryHandler(deps);
    const result = await handler(EVENT, "project-bg");

    expect(result).toEqual({
      terminalsKilled: 0,
      rendererEvicted: false,
      workspaceEvicted: false,
    });
    expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("project-bg", "closed");
  });
});
