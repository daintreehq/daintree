import { beforeEach, describe, expect, it, vi } from "vitest";

const projectStoreMock = vi.hoisted(() => ({
  setCurrentProject: vi.fn(async (_id: string, _outgoing?: string | null) => {}),
  getProjectById: vi.fn((id: string) => ({ id, name: "A", path: "/work/a", status: "active" })),
}));
vi.mock("../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const broadcastMock = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/projectSwitchBroadcast.js", () => ({
  broadcastProjectSwitchUpdates: broadcastMock,
}));

const timingMock = vi.hoisted(() => ({ hostReady: vi.fn(), fail: vi.fn() }));
vi.mock("../../services/ProjectSwitchStatusTiming.js", () => ({
  projectSwitchStatusTiming: timingMock,
}));

const distributePortsMock = vi.hoisted(() => vi.fn());
vi.mock("../portDistribution.js", () => ({ distributePortsToView: distributePortsMock }));

const windowContext = vi.hoisted(() => ({ windowId: 3 }));
vi.mock("../windowRef.js", () => ({
  getWindowRegistry: () => ({
    getByWindowId: (id: number) => (id === 3 ? windowContext : undefined),
  }),
}));

import { CHANNELS } from "../../ipc/channels.js";
import { completeLocalProjectActivation } from "../localProjectActivation.js";
import type { Project } from "../../../shared/types/project.js";

const PROJECT = { id: "a", name: "A", path: "/work/a" } as Project;

function setup(isNew: boolean) {
  const webContents = { isDestroyed: () => false, send: vi.fn() };
  const workspace = {
    loadProject: vi.fn(async () => "warm" as const),
    attachDirectPort: vi.fn(),
    getHostForProject: vi.fn(() => ({ id: "host" })),
  };
  const broker = { brokerPort: vi.fn() };
  const pty = { onProjectSwitch: vi.fn() };
  const targetWindow = { id: 3, isDestroyed: () => false };
  const activation = {
    targetWindow: targetWindow as never,
    project: PROJECT,
    view: { webContents } as never,
    isNew,
    outgoingProjectId: null,
    switchId: "switch-1",
    clients: { workspace: workspace as never, broker: broker as never, pty: pty as never },
    logPrefix: "[test]",
  };
  return { activation, webContents, workspace, broker, pty, targetWindow };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("completeLocalProjectActivation", () => {
  it("gives a view back from the cache its producer ports and the window's PTY port", async () => {
    const { activation, webContents, workspace, broker, pty, targetWindow } = setup(false);

    await completeLocalProjectActivation(activation);

    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("a", null);
    expect(broadcastMock).toHaveBeenCalledWith(null, "a");
    expect(webContents.send).toHaveBeenCalledWith(
      CHANNELS.PROJECT_ON_SWITCH,
      expect.objectContaining({
        switchId: "switch-1",
        project: expect.objectContaining({ id: "a" }),
      })
    );
    expect(workspace.loadProject).toHaveBeenCalledWith("/work/a", 3);
    expect(timingMock.hostReady).toHaveBeenCalledWith("switch-1", "warm");
    expect(workspace.attachDirectPort).toHaveBeenCalledWith(3, webContents);
    expect(broker.brokerPort).toHaveBeenCalledWith({ id: "host" }, webContents);
    expect(pty.onProjectSwitch).toHaveBeenCalledWith(3, "a", "/work/a");
    expect(distributePortsMock).toHaveBeenCalledWith(targetWindow, windowContext, webContents, pty);
  });

  it("leaves a new view's PTY port to its own load", async () => {
    const { activation, pty } = setup(true);

    await completeLocalProjectActivation(activation);

    expect(pty.onProjectSwitch).toHaveBeenCalled();
    expect(distributePortsMock).not.toHaveBeenCalled();
  });

  it("backgrounds only the project of this machine the window is leaving", async () => {
    const { activation } = setup(false);

    await completeLocalProjectActivation({ ...activation, outgoingProjectId: "b" });

    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("a", "b");
    expect(broadcastMock).toHaveBeenCalledWith("b", "a");
  });

  it("still hands over the PTY port when the workspace load fails", async () => {
    const { activation, workspace, pty } = setup(false);
    workspace.loadProject.mockRejectedValueOnce(new Error("load failed"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await completeLocalProjectActivation(activation);

    expect(timingMock.fail).toHaveBeenCalledWith("switch-1", "load-failed");
    expect(workspace.attachDirectPort).not.toHaveBeenCalled();
    expect(pty.onProjectSwitch).toHaveBeenCalled();
    expect(distributePortsMock).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
