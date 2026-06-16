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

import { registerForgeRecommendationHandlers } from "../forgeRecommendation.js";

function getHandler(channel: string) {
  return ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
    _e: unknown,
    ...args: unknown[]
  ) => unknown;
}

describe("registerForgeRecommendationHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
  });

  it("registers two IPC handlers and cleanup removes them", () => {
    const cleanup = registerForgeRecommendationHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(2);
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge-recommendation:get-dismissed",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge-recommendation:mark-dismissed",
      expect.any(Function)
    );
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(2);
  });

  it("getDismissed returns empty object for a fresh store", () => {
    registerForgeRecommendationHandlers();
    expect(getHandler("forge-recommendation:get-dismissed")(null)).toEqual({});
  });

  it("markDismissed persists a project path and getDismissed returns it", () => {
    registerForgeRecommendationHandlers();
    const mark = getHandler("forge-recommendation:mark-dismissed");

    mark(null, "/Users/dev/project-a");
    expect(storeMock.set).toHaveBeenCalledWith("forgeEnableDismissedPaths", {
      "/Users/dev/project-a": true,
    });

    const result = getHandler("forge-recommendation:get-dismissed")(null);
    expect(result).toEqual({ "/Users/dev/project-a": true });
  });

  it("markDismissed preserves existing paths", () => {
    registerForgeRecommendationHandlers();
    const mark = getHandler("forge-recommendation:mark-dismissed");

    storeMock._data["forgeEnableDismissedPaths"] = { "/Users/dev/project-a": true };
    mark(null, "/Users/dev/project-b");
    expect(storeMock.set).toHaveBeenCalledWith("forgeEnableDismissedPaths", {
      "/Users/dev/project-a": true,
      "/Users/dev/project-b": true,
    });
  });

  it("markDismissed is idempotent", () => {
    registerForgeRecommendationHandlers();
    const mark = getHandler("forge-recommendation:mark-dismissed");

    storeMock._data["forgeEnableDismissedPaths"] = { "/Users/dev/project-a": true };
    mark(null, "/Users/dev/project-a");
    expect(storeMock.set).toHaveBeenCalledWith("forgeEnableDismissedPaths", {
      "/Users/dev/project-a": true,
    });
  });

  it("markDismissed ignores non-string input", () => {
    registerForgeRecommendationHandlers();
    const mark = getHandler("forge-recommendation:mark-dismissed");
    mark(null, 42);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("markDismissed ignores an empty string", () => {
    registerForgeRecommendationHandlers();
    const mark = getHandler("forge-recommendation:mark-dismissed");
    mark(null, "");
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});
