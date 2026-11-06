// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRunFinishRequest } from "@shared/types/ipc/schedules";

const store = vi.hoisted(() => ({
  panelsById: {} as Record<string, unknown>,
  removePanel: vi.fn(),
  backgroundTerminal: vi.fn(),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => store },
}));

import { useScheduledRunFinishBridge } from "@/hooks/useScheduledRunFinishBridge";

let requestFinish: ((request: ScheduledRunFinishRequest) => void) | null = null;
const unsubscribe = vi.fn();

function runPane(location: string, runId = "run-1") {
  return {
    id: "terminal-1",
    kind: "terminal",
    location,
    scheduledRun: { scheduleId: "schedule-1", runId },
  };
}

beforeEach(() => {
  store.panelsById = {};
  store.removePanel.mockReset();
  store.backgroundTerminal.mockReset();
  unsubscribe.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      schedules: {
        onFinishRequest: (cb: typeof requestFinish) => {
          requestFinish = cb;
          return unsubscribe;
        },
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  requestFinish = null;
});

describe("useScheduledRunFinishBridge (#15982)", () => {
  it("moves the run's pane to the background from the grid or the dock", () => {
    renderHook(() => useScheduledRunFinishBridge());

    store.panelsById = { "terminal-1": runPane("grid") };
    requestFinish?.({ runId: "run-1", terminalId: "terminal-1", action: "background" });
    store.panelsById = { "terminal-1": runPane("dock") };
    requestFinish?.({ runId: "run-1", terminalId: "terminal-1", action: "background" });

    expect(store.backgroundTerminal).toHaveBeenCalledTimes(2);
    expect(store.backgroundTerminal).toHaveBeenCalledWith("terminal-1");
  });

  it("leaves a pane the user already took out of the grid and dock where it is", () => {
    renderHook(() => useScheduledRunFinishBridge());
    store.panelsById = { "terminal-1": runPane("trash") };

    requestFinish?.({ runId: "run-1", terminalId: "terminal-1", action: "background" });

    expect(store.backgroundTerminal).not.toHaveBeenCalled();
  });

  it("removes the run's pane without killing its terminal a second time", () => {
    renderHook(() => useScheduledRunFinishBridge());
    store.panelsById = { "terminal-1": runPane("grid") };

    requestFinish?.({ runId: "run-1", terminalId: "terminal-1", action: "remove" });

    expect(store.removePanel).toHaveBeenCalledWith("terminal-1", { backendAlreadyClosed: true });
  });

  it("touches no pane that isn't the run's", () => {
    renderHook(() => useScheduledRunFinishBridge());
    store.panelsById = {
      "terminal-1": runPane("grid", "run-2"),
      "terminal-2": { id: "terminal-2", kind: "terminal", location: "grid" },
    };

    requestFinish?.({ runId: "run-1", terminalId: "terminal-1", action: "remove" });
    requestFinish?.({ runId: "run-1", terminalId: "terminal-2", action: "background" });
    requestFinish?.({ runId: "run-1", terminalId: "terminal-3", action: "remove" });

    expect(store.removePanel).not.toHaveBeenCalled();
    expect(store.backgroundTerminal).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", () => {
    const { unmount } = renderHook(() => useScheduledRunFinishBridge());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
