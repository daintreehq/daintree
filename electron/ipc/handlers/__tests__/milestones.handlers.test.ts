import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import { registerMilestonesHandlers } from "../milestones.js";

function getHandler(channel: string) {
  return ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
    _e: unknown,
    ...args: unknown[]
  ) => unknown;
}

describe("registerMilestonesHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
  });

  it("registers two IPC handlers and cleanup removes them", () => {
    const cleanup = registerMilestonesHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(2);
    expect(ipcMainMock.handle).toHaveBeenCalledWith("milestones:get", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("milestones:mark-shown", expect.any(Function));
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(2);
  });

  it("get returns empty object for fresh store", () => {
    registerMilestonesHandlers();
    const result = getHandler("milestones:get")(null);
    expect(result).toEqual({});
  });

  it("markShown persists a milestone and get returns it", () => {
    registerMilestonesHandlers();
    const mark = getHandler("milestones:mark-shown");
    const get = getHandler("milestones:get");

    mark(null, "first-agent-completed");
    expect(storeMock.set).toHaveBeenCalledWith("orchestrationMilestones", {
      "first-agent-completed": true,
    });

    storeMock._data["orchestrationMilestones"] = { "first-agent-completed": true };
    const result = get(null);
    expect(result).toEqual({ "first-agent-completed": true });
  });

  it("markShown is idempotent", () => {
    registerMilestonesHandlers();
    const mark = getHandler("milestones:mark-shown");

    storeMock._data["orchestrationMilestones"] = { "first-agent-completed": true };
    mark(null, "first-agent-completed");
    expect(storeMock.set).toHaveBeenCalledWith("orchestrationMilestones", {
      "first-agent-completed": true,
    });
  });

  it("markShown ignores non-string input", () => {
    registerMilestonesHandlers();
    const mark = getHandler("milestones:mark-shown");
    mark(null, 42);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("markShown preserves existing milestones", () => {
    registerMilestonesHandlers();
    const mark = getHandler("milestones:mark-shown");

    storeMock._data["orchestrationMilestones"] = { "first-agent-completed": true };
    mark(null, "first-pr-merged");
    expect(storeMock.set).toHaveBeenCalledWith("orchestrationMilestones", {
      "first-agent-completed": true,
      "first-pr-merged": true,
    });
  });
});
