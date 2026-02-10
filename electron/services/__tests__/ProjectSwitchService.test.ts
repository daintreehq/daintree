import { beforeEach, describe, expect, it, vi } from "vitest";

const projectStoreMock = vi.hoisted(() => ({
  getProjectById:
    vi.fn<(id: string) => { id: string; name: string; path: string; status?: string } | null>(),
  getCurrentProjectId: vi.fn<() => string | null>(),
  setCurrentProject: vi.fn<(id: string) => Promise<void>>(),
  getProjectState: vi.fn<(id: string) => Promise<Record<string, unknown>>>(),
  saveProjectState: vi.fn<(id: string, state: Record<string, unknown>) => Promise<void>>(),
}));

const logBufferMock = vi.hoisted(() => ({
  onProjectSwitch: vi.fn(() => undefined),
}));

const taskQueueServiceMock = vi.hoisted(() => ({
  onProjectSwitch: vi.fn(async () => undefined),
}));

const assistantServiceMock = vi.hoisted(() => ({
  clearAllSessions: vi.fn(() => undefined),
}));

const sendToRendererMock = vi.hoisted(() => vi.fn());
const randomUUIDMock = vi.hoisted(() => vi.fn(() => "switch-id-1"));

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => ({
    activeWorktreeId: "wt-old",
    sidebarWidth: 320,
  })),
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../LogBuffer.js", () => ({
  logBuffer: logBufferMock,
}));

vi.mock("../TaskQueueService.js", () => ({
  taskQueueService: taskQueueServiceMock,
}));

vi.mock("../AssistantService.js", () => ({
  assistantService: assistantServiceMock,
}));

vi.mock("../../ipc/utils.js", () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock("crypto", () => ({
  randomUUID: randomUUIDMock,
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

import { CHANNELS } from "../../ipc/channels.js";
import { ProjectSwitchService } from "../ProjectSwitchService.js";

describe("ProjectSwitchService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    projectStoreMock.getCurrentProjectId.mockReturnValue("project-old");
    projectStoreMock.getProjectById.mockImplementation((id: string) => {
      if (id === "project-new") {
        return { id, name: "New Project", path: "/tmp/new", status: "active" };
      }
      if (id === "project-old") {
        return { id, name: "Old Project", path: "/tmp/old", status: "active" };
      }
      return null;
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "project-old",
      sidebarWidth: 350,
      terminals: [],
    });
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    logBufferMock.onProjectSwitch.mockImplementation(() => undefined);
    taskQueueServiceMock.onProjectSwitch.mockResolvedValue(undefined);
    assistantServiceMock.clearAllSessions.mockImplementation(() => undefined);
  });

  function createService(overrides?: {
    ptyClient?: Partial<{
      onProjectSwitch: (projectId: string | null) => unknown;
      setActiveProject: (projectId: string | null) => unknown;
    }>;
    worktreeService?: Partial<{
      onProjectSwitch: () => unknown;
      loadProject: (path: string) => Promise<void>;
    }>;
    eventBuffer?: Partial<{
      onProjectSwitch: () => unknown;
    }>;
  }) {
    const ptyClient = {
      onProjectSwitch: vi.fn(() => undefined),
      setActiveProject: vi.fn(() => undefined),
      ...(overrides?.ptyClient ?? {}),
    };

    const worktreeService =
      overrides?.worktreeService === undefined
        ? {
            onProjectSwitch: vi.fn(() => undefined),
            loadProject: vi.fn(async () => undefined),
          }
        : (overrides.worktreeService as {
            onProjectSwitch: () => unknown;
            loadProject: (path: string) => Promise<void>;
          });

    const eventBuffer = {
      onProjectSwitch: vi.fn(() => undefined),
      ...(overrides?.eventBuffer ?? {}),
    };

    const service = new ProjectSwitchService({
      mainWindow: {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: vi.fn(),
        },
      } as never,
      ptyClient: ptyClient as never,
      worktreeService: worktreeService as never,
      eventBuffer: eventBuffer as never,
    });

    return { service, ptyClient, worktreeService, eventBuffer };
  }

  it("switches projects successfully and emits switch event", async () => {
    const { service, ptyClient, worktreeService, eventBuffer } = createService();

    const result = await service.switchProject("project-new");

    expect(result.id).toBe("project-new");
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("project-new");
    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "project-old",
      expect.objectContaining({
        projectId: "project-old",
        activeWorktreeId: "wt-old",
      })
    );
    expect(ptyClient.onProjectSwitch).toHaveBeenCalledWith("project-new");
    expect(worktreeService.loadProject).toHaveBeenCalledWith("/tmp/new");
    expect(eventBuffer.onProjectSwitch).toHaveBeenCalled();
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      CHANNELS.PROJECT_ON_SWITCH,
      expect.objectContaining({
        project: expect.objectContaining({ id: "project-new" }),
        switchId: "switch-id-1",
      })
    );
  });

  it("continues switch even when cleanup services throw synchronously", async () => {
    const { service } = createService({
      ptyClient: {
        onProjectSwitch: () => {
          throw new Error("pty sync throw");
        },
      },
      worktreeService: {
        onProjectSwitch: () => {
          throw new Error("workspace sync throw");
        },
        loadProject: async () => undefined,
      },
      eventBuffer: {
        onProjectSwitch: () => {
          throw new Error("eventBuffer sync throw");
        },
      },
    });
    logBufferMock.onProjectSwitch.mockImplementation(() => {
      throw new Error("logBuffer sync throw");
    });
    taskQueueServiceMock.onProjectSwitch.mockImplementation(() => {
      throw new Error("taskQueue sync throw");
    });

    await expect(service.switchProject("project-new")).resolves.toMatchObject({
      id: "project-new",
    });
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("project-new");
  });

  it("preserves original switch error when rollback throws", async () => {
    const originalError = new Error("setCurrent failed");
    projectStoreMock.setCurrentProject.mockRejectedValue(originalError);

    const { service } = createService({
      ptyClient: {
        onProjectSwitch: () => {
          throw new Error("rollback failed");
        },
      },
    });

    await expect(service.switchProject("project-new")).rejects.toThrow("setCurrent failed");
  });
});
