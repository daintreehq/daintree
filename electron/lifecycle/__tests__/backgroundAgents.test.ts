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

/** A window as `browser-window-created` hands it over, shown or not yet. */
function createdWindow(visible: boolean) {
  const win = Object.assign(new EventEmitter(), { isVisible: () => visible });
  electronMock.app.emit("browser-window-created", {}, win);
  return win;
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

  it("ends when a window is on screen again, and lets the manifest go once", () => {
    const deps = makeDeps();
    electronMock.windows = [makeWindow()];
    keepAgentsRunningWithoutWindows(deps);

    createdWindow(true);
    expect(isKeepingAgentsRunning()).toBe(false);
    expect(deps.releaseOpenWindows).toHaveBeenCalledOnce();

    createdWindow(true);
    expect(deps.releaseOpenWindows).toHaveBeenCalledOnce();
    expect(electronMock.app.listenerCount("browser-window-created")).toBe(0);
  });

  it("waits for a window created hidden to show", () => {
    const deps = makeDeps();
    keepAgentsRunningWithoutWindows(deps);

    const win = createdWindow(false);
    expect(isKeepingAgentsRunning()).toBe(true);
    expect(deps.releaseOpenWindows).not.toHaveBeenCalled();

    win.emit("show");
    expect(isKeepingAgentsRunning()).toBe(false);
    expect(deps.releaseOpenWindows).toHaveBeenCalledOnce();
  });

  it("isn't ended by a hidden window that never shows, such as a PDF render", () => {
    const deps = makeDeps();
    keepAgentsRunningWithoutWindows(deps);

    createdWindow(false);

    expect(isKeepingAgentsRunning()).toBe(true);
    expect(deps.releaseOpenWindows).not.toHaveBeenCalled();
  });

  it("listens once however many times it is chosen before a window shows", () => {
    keepAgentsRunningWithoutWindows(makeDeps());
    const second = makeDeps();
    keepAgentsRunningWithoutWindows(second);

    expect(electronMock.app.listenerCount("browser-window-created")).toBe(1);
    createdWindow(true);
    expect(isKeepingAgentsRunning()).toBe(false);
    expect(second.releaseOpenWindows).toHaveBeenCalledOnce();
  });

  it("can't be ended by a window from an earlier cycle that shows late", () => {
    const first = makeDeps();
    keepAgentsRunningWithoutWindows(first);
    const late = createdWindow(false);
    createdWindow(true);

    const second = makeDeps();
    keepAgentsRunningWithoutWindows(second);
    late.emit("show");

    expect(isKeepingAgentsRunning()).toBe(true);
    expect(first.releaseOpenWindows).toHaveBeenCalledOnce();
    expect(second.releaseOpenWindows).not.toHaveBeenCalled();
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
    electronMock.windows = [];
    expect(hasOpenWindows()).toBe(false);
    electronMock.windows = [makeWindow(true)];
    expect(hasOpenWindows()).toBe(false);
    electronMock.windows = [makeWindow(true), makeWindow()];
    expect(hasOpenWindows()).toBe(true);
  });
});
