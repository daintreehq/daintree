// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const listeners = new Map<string, Function[]>();

const ipcRendererMock = {
  on: vi.fn((channel: string, handler: Function) => {
    if (!listeners.has(channel)) listeners.set(channel, []);
    listeners.get(channel)!.push(handler);
  }),
  removeListener: vi.fn((channel: string, handler: Function) => {
    const arr = listeners.get(channel);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx !== -1) arr.splice(idx, 1);
    }
  }),
  send: vi.fn(),
};

const webFrameMock = {
  getZoomFactor: vi.fn(() => 1),
  setZoomFactor: vi.fn(),
};

// Mock window.require for Electron modules
const originalRequire = (window as unknown as { require?: Function }).require;
(window as unknown as { require: Function }).require = (mod: string) => {
  if (mod === "electron") return { ipcRenderer: ipcRendererMock, webFrame: webFrameMock };
  throw new Error(`Unexpected require: ${mod}`);
};

// Stub Element.prototype.animate (jsdom doesn't support WAAPI)
const mockAnimation = {
  finished: Promise.resolve(),
  cancel: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(),
};
Element.prototype.animate = vi.fn(() => mockAnimation as unknown as Animation);

import { DemoCursor } from "../DemoCursor";

function emit(channel: string, payload?: unknown) {
  const handlers = listeners.get(channel) ?? [];
  for (const h of handlers) {
    h({}, payload);
  }
}

describe("DemoCursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders cursor SVG", () => {
    const { container } = render(<DemoCursor />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg!.querySelector("path")).toBeTruthy();
  });

  it("registers IPC listeners on mount", () => {
    render(<DemoCursor />);
    expect(ipcRendererMock.on).toHaveBeenCalledWith("demo:exec-move-to", expect.any(Function));
    expect(ipcRendererMock.on).toHaveBeenCalledWith("demo:exec-click", expect.any(Function));
    expect(ipcRendererMock.on).toHaveBeenCalledWith("demo:exec-type", expect.any(Function));
    expect(ipcRendererMock.on).toHaveBeenCalledWith("demo:exec-set-zoom", expect.any(Function));
    expect(ipcRendererMock.on).toHaveBeenCalledWith(
      "demo:exec-wait-for-selector",
      expect.any(Function)
    );
    expect(ipcRendererMock.on).toHaveBeenCalledWith("demo:exec-pause", expect.any(Function));
    expect(ipcRendererMock.on).toHaveBeenCalledWith("demo:exec-resume", expect.any(Function));
  });

  it("removes IPC listeners on unmount", () => {
    const { unmount } = render(<DemoCursor />);
    unmount();
    expect(ipcRendererMock.removeListener).toHaveBeenCalledWith(
      "demo:exec-move-to",
      expect.any(Function)
    );
    expect(ipcRendererMock.removeListener).toHaveBeenCalledWith(
      "demo:exec-click",
      expect.any(Function)
    );
  });

  it("moveTo calls element.animate and sends done", async () => {
    render(<DemoCursor />);
    emit("demo:exec-move-to", { x: 30, y: 40, durationMs: 500 });

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 10));

    expect(Element.prototype.animate).toHaveBeenCalled();
    expect(ipcRendererMock.send).toHaveBeenCalledWith("demo:command-done", {
      channel: "demo:exec-move-to",
    });
  });

  it("click calls element.animate for press and release", async () => {
    render(<DemoCursor />);
    emit("demo:exec-click");

    await new Promise((r) => setTimeout(r, 10));

    // Press + release = at least 2 animate calls
    expect(
      (Element.prototype.animate as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThanOrEqual(2);
    expect(ipcRendererMock.send).toHaveBeenCalledWith("demo:command-done", {
      channel: "demo:exec-click",
    });
  });

  it("pause sends done immediately", () => {
    render(<DemoCursor />);
    emit("demo:exec-pause");

    expect(ipcRendererMock.send).toHaveBeenCalledWith("demo:command-done", {
      channel: "demo:exec-pause",
    });
  });

  it("resume sends done immediately", () => {
    render(<DemoCursor />);
    emit("demo:exec-resume");

    expect(ipcRendererMock.send).toHaveBeenCalledWith("demo:command-done", {
      channel: "demo:exec-resume",
    });
  });

  it("waitForSelector resolves immediately when element exists", async () => {
    const el = document.createElement("div");
    el.id = "test-target";
    document.body.appendChild(el);

    render(<DemoCursor />);
    emit("demo:exec-wait-for-selector", { selector: "#test-target" });

    await new Promise((r) => setTimeout(r, 10));

    expect(ipcRendererMock.send).toHaveBeenCalledWith("demo:command-done", {
      channel: "demo:exec-wait-for-selector",
    });

    document.body.removeChild(el);
  });
});

// Restore window.require
afterAll(() => {
  if (originalRequire) {
    (window as unknown as { require: Function }).require = originalRequire;
  } else {
    delete (window as unknown as { require?: Function }).require;
  }
});

function afterAll(fn: () => void) {
  // vitest provides this globally
  (globalThis as unknown as { afterAll: (fn: () => void) => void }).afterAll(fn);
}
