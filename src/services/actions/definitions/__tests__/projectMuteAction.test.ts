// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSettingsMock = vi.hoisted(() => vi.fn());
const saveSettingsMock = vi.hoisted(() => vi.fn());
const openDialogMock = vi.hoisted(() => vi.fn());
const getAllMock = vi.hoisted(() => vi.fn());
const getCurrentMock = vi.hoisted(() => vi.fn());
const detectRunnersMock = vi.hoisted(() => vi.fn());
const getStatsMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: getSettingsMock,
    saveSettings: saveSettingsMock,
    openDialog: openDialogMock,
    getAll: getAllMock,
    getCurrent: getCurrentMock,
    detectRunners: detectRunnersMock,
    getStats: getStatsMock,
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({}) },
}));

vi.mock("@/lib/projectMru", () => ({
  getMruProjects: () => [],
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

import type { ActionRegistry, ActionCallbacks } from "../../actionTypes";
import { registerProjectActions } from "../projectActions";

function register() {
  const actions: ActionRegistry = new Map();
  const callbacks = {
    onOpenProjectSwitcherPalette: vi.fn(),
  } as unknown as ActionCallbacks;
  registerProjectActions(actions, callbacks);
  return actions;
}

function muteAction() {
  const actions = register();
  const factory = actions.get("project.muteNotifications");
  if (!factory) throw new Error("project.muteNotifications is not registered");
  return factory();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project.muteNotifications", () => {
  it("registers a command action with a projectId schema", () => {
    const action = muteAction();
    expect(action.id).toBe("project.muteNotifications");
    expect(action.kind).toBe("command");
    expect(action.danger).toBe("safe");
    expect(action.argsSchema).toBeDefined();
    expect(() => action.argsSchema!.parse({ projectId: "p1" })).not.toThrow();
    expect(() => action.argsSchema!.parse({})).toThrow();
    // Empty projectId is treated as invalid — avoids masking upstream bugs
    // where a caller forgot to pipe the ID through.
    expect(() => action.argsSchema!.parse({ projectId: "" })).toThrow();
  });

  it("writes completedEnabled/waitingEnabled=false into notificationOverrides", async () => {
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    saveSettingsMock.mockResolvedValue(undefined);

    const action = muteAction();
    await action.run({ projectId: "p1" }, {} as never);

    expect(getSettingsMock).toHaveBeenCalledWith("p1");
    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    const firstCall = saveSettingsMock.mock.calls[0]!;
    expect(firstCall[0]).toBe("p1");
    expect(firstCall[1].notificationOverrides).toEqual({
      completedEnabled: false,
      waitingEnabled: false,
    });
  });

  it("merges with existing notificationOverrides without clobbering unrelated fields", async () => {
    getSettingsMock.mockResolvedValue({
      runCommands: [],
      notificationOverrides: {
        completedEnabled: true,
        waitingEnabled: true,
        soundEnabled: true,
      },
    });
    saveSettingsMock.mockResolvedValue(undefined);

    const action = muteAction();
    await action.run({ projectId: "p1" }, {} as never);

    const firstCall = saveSettingsMock.mock.calls[0]!;
    expect(firstCall[1].notificationOverrides).toEqual({
      completedEnabled: false,
      waitingEnabled: false,
      soundEnabled: true,
    });
  });

  it("surfaces an error notification when getSettings fails and does not save", async () => {
    getSettingsMock.mockRejectedValue(new Error("read failed"));

    const action = muteAction();
    await action.run({ projectId: "p1" }, {} as never);

    expect(saveSettingsMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({
      type: "error",
      title: "Failed to mute notifications",
      message: "read failed",
    });
  });

  it("surfaces an error notification when saveSettings fails", async () => {
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    saveSettingsMock.mockRejectedValue(new Error("write failed"));

    const action = muteAction();
    await action.run({ projectId: "p1" }, {} as never);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: "write failed" })
    );
  });

  it("emits a success notification on the happy path", async () => {
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    saveSettingsMock.mockResolvedValue(undefined);

    const action = muteAction();
    await action.run({ projectId: "p1" }, {} as never);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", message: "Project notifications muted" })
    );
  });

  it("is idempotent — already-muted settings still write through without error", async () => {
    getSettingsMock.mockResolvedValue({
      runCommands: [],
      notificationOverrides: { completedEnabled: false, waitingEnabled: false },
    });
    saveSettingsMock.mockResolvedValue(undefined);

    const action = muteAction();
    await expect(action.run({ projectId: "p1" }, {} as never)).resolves.not.toThrow();
    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
  });
});
