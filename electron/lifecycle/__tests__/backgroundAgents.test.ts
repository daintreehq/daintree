import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  app: null as unknown as EventEmitter,
  windows: [] as Array<{ close: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }>,
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  electronMock.app = new Emitter();
  return {
    app: electronMock.app,
    BrowserWindow: { getAllWindows: () => electronMock.windows },
  };
});

const coordinatorMock = vi.hoisted(() => ({
  getActiveShutdown: vi.fn<() => unknown>(() => null),
}));

vi.mock("../shutdownCoordinator.js", () => coordinatorMock);

import {
  hasOpenWindows,
  isKeepingAgentsRunning,
  keepAgentsRunningWithoutWindows,
  resetBackgroundAgentsForTests,
} from "../backgroundAgents.js";

function makeWindow(destroyed = false) {
  return { close: vi.fn(), isDestroyed: () => destroyed };
}

function makeDeps() {
  return { holdOpenWindows: vi.fn(), releaseOpenWindows: vi.fn(), armReopen: vi.fn() };
}

describe("keepAgentsRunningWithoutWindows", () => {
  beforeEach(() => {
    coordinatorMock.getActiveShutdown.mockReturnValue(null);
    electronMock.windows = [];
  });

  afterEach(() => {
    resetBackgroundAgentsForTests();
  });

  it("keeps the process up, pins the window set and arms the reopen before any window closes", () => {
    const order: string[] = [];
    const deps = {
      holdOpenWindows: vi.fn(() => order.push("hold")),
      releaseOpenWindows: vi.fn(),
      armReopen: vi.fn(() => order.push("arm")),
    };
    const closing = makeWindow();
    closing.close.mockImplementation(() =>
      order.push(`close while kept=${isKeepingAgentsRunning()}`)
    );
    const gone = makeWindow(true);
    electronMock.windows = [closing, gone, makeWindow()];

    expect(keepAgentsRunningWithoutWindows(deps)).toBe(true);

    expect(order).toEqual(["hold", "arm", "close while kept=true"]);
    expect(gone.close).not.toHaveBeenCalled();
    expect(electronMock.windows[2]!.close).toHaveBeenCalledOnce();
    expect(isKeepingAgentsRunning()).toBe(true);
    expect(deps.releaseOpenWindows).not.toHaveBeenCalled();
  });

  it("ends when a window opens again, and lets the manifest go once", () => {
    const deps = makeDeps();
    electronMock.windows = [makeWindow()];
    keepAgentsRunningWithoutWindows(deps);

    electronMock.app.emit("browser-window-created", {}, {});
    expect(isKeepingAgentsRunning()).toBe(false);
    expect(deps.releaseOpenWindows).toHaveBeenCalledOnce();

    electronMock.app.emit("browser-window-created", {}, {});
    expect(deps.releaseOpenWindows).toHaveBeenCalledOnce();
    expect(electronMock.app.listenerCount("browser-window-created")).toBe(0);
  });

  it("listens once however many times it is chosen before a window opens", () => {
    keepAgentsRunningWithoutWindows(makeDeps());
    const second = makeDeps();
    keepAgentsRunningWithoutWindows(second);

    expect(electronMock.app.listenerCount("browser-window-created")).toBe(1);
    electronMock.app.emit("browser-window-created", {}, {});
    expect(isKeepingAgentsRunning()).toBe(false);
  });

  it("does nothing once a shutdown owns the process", () => {
    coordinatorMock.getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });
    const deps = makeDeps();
    const win = makeWindow();
    electronMock.windows = [win];

    expect(keepAgentsRunningWithoutWindows(deps)).toBe(false);

    expect(isKeepingAgentsRunning()).toBe(false);
    expect(deps.holdOpenWindows).not.toHaveBeenCalled();
    expect(deps.armReopen).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
    expect(electronMock.app.listenerCount("browser-window-created")).toBe(0);
  });
});

describe("hasOpenWindows", () => {
  it("counts only windows that are still alive", () => {
    electronMock.windows = [makeWindow(true)];
    expect(hasOpenWindows()).toBe(false);
    electronMock.windows = [makeWindow(true), makeWindow()];
    expect(hasOpenWindows()).toBe(true);
  });
});
