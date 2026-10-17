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

import { registerShortcutHintsHandlers } from "../shortcutHints.js";

describe("registerShortcutHintsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
  });

  it("incrementCount increments the count for an action", () => {
    registerShortcutHintsHandlers();
    const incrementHandler = ipcMainMock.handle.mock.calls.find(
      (c: unknown[]) => c[0] === "shortcut-hints:increment-count"
    )![1] as (_e: unknown, actionId: unknown) => void;

    storeMock._data["shortcutHintCounts"] = {};
    incrementHandler(null, "nav.quickSwitcher");

    expect(storeMock.set).toHaveBeenCalledWith("shortcutHintCounts", { "nav.quickSwitcher": 1 });
  });

  it("incrementCount accumulates counts across calls", () => {
    registerShortcutHintsHandlers();
    const incrementHandler = ipcMainMock.handle.mock.calls.find(
      (c: unknown[]) => c[0] === "shortcut-hints:increment-count"
    )![1] as (_e: unknown, actionId: unknown) => void;

    storeMock._data["shortcutHintCounts"] = { "nav.quickSwitcher": 2 };
    incrementHandler(null, "nav.quickSwitcher");

    expect(storeMock.set).toHaveBeenCalledWith("shortcutHintCounts", { "nav.quickSwitcher": 3 });
  });

  it("incrementCount ignores non-string actionId", () => {
    registerShortcutHintsHandlers();
    const incrementHandler = ipcMainMock.handle.mock.calls.find(
      (c: unknown[]) => c[0] === "shortcut-hints:increment-count"
    )![1] as (_e: unknown, actionId: unknown) => void;

    incrementHandler(null, 42);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("setHintedHover ignores a non-array payload", () => {
    registerShortcutHintsHandlers();
    const setHandler = ipcMainMock.handle.mock.calls.find(
      (c: unknown[]) => c[0] === "shortcut-hints:set-hinted-hover"
    )![1] as (_e: unknown, keys: unknown) => void;

    setHandler(null, "not-an-array");
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("setHintedHover drops non-string entries", () => {
    registerShortcutHintsHandlers();
    const setHandler = ipcMainMock.handle.mock.calls.find(
      (c: unknown[]) => c[0] === "shortcut-hints:set-hinted-hover"
    )![1] as (_e: unknown, keys: unknown) => void;

    setHandler(null, ["nav.quickSwitcher@1", 42, null, "nav.commandPalette@0"]);
    expect(storeMock.set).toHaveBeenCalledWith("shortcutHintHoveredKeys", [
      "nav.quickSwitcher@1",
      "nav.commandPalette@0",
    ]);
  });
});
