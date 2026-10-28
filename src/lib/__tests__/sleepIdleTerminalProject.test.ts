import { describe, it, expect, vi, beforeEach } from "vitest";

const idleTerminalClientMock = vi.hoisted(() => ({
  closeProject: vi.fn<(projectId: string) => Promise<unknown>>(async () => null),
}));
vi.mock("@/clients/idleTerminalClient", () => ({ idleTerminalClient: idleTerminalClientMock }));

const noticeMock = vi.hoisted(() => ({ notifyPluginWorkStopped: vi.fn() }));
vi.mock("@/lib/pluginWorkStoppedNotice", () => noticeMock);

const projectState = vi.hoisted(() => ({
  currentProject: null as { id: string } | null,
  projects: [{ id: "proj-1", name: "Web" }],
  sleepProject: vi.fn<(projectId: string) => Promise<unknown>>(async () => ({})),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => projectState },
}));

import { sleepIdleTerminalProject } from "../sleepIdleTerminalProject";

describe("sleepIdleTerminalProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.currentProject = null;
  });

  it("reports the plugin work main says the sleep stopped (#14093)", async () => {
    const stopped = { tasks: [{ pluginName: "Sync", title: "Uploading" }], processes: 0, calls: 0 };
    idleTerminalClientMock.closeProject.mockResolvedValueOnce(stopped);

    await sleepIdleTerminalProject("proj-1");

    expect(noticeMock.notifyPluginWorkStopped).toHaveBeenCalledWith("Web", stopped);
  });

  it("asks main to sleep a project this window isn't showing", async () => {
    projectState.currentProject = { id: "other" };

    await sleepIdleTerminalProject("proj-1");

    expect(idleTerminalClientMock.closeProject).toHaveBeenCalledWith("proj-1");
    expect(projectState.sleepProject).not.toHaveBeenCalled();
  });

  it("runs this window's own Sleep for the project it is showing", async () => {
    // The reminder outlives the moment it was raised: by the time it is
    // pressed the user may have opened the project here, and only the window's
    // Sleep settles its pending layout save before main writes into it.
    projectState.currentProject = { id: "proj-1" };

    await sleepIdleTerminalProject("proj-1");

    expect(projectState.sleepProject).toHaveBeenCalledWith("proj-1");
    expect(idleTerminalClientMock.closeProject).not.toHaveBeenCalled();
  });

  it("passes a failed sleep on to its caller", async () => {
    idleTerminalClientMock.closeProject.mockRejectedValueOnce(new Error("Project not found"));

    await expect(sleepIdleTerminalProject("ghost")).rejects.toThrow("Project not found");
  });
});
