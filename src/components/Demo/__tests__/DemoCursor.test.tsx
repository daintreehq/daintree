// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, cleanup } from "@testing-library/react";

type Listener = (payload: Record<string, unknown>) => void;
const listenerMap = new Map<string, Listener[]>();

const demoMock = {
  onExecCommand: vi.fn((channel: string, callback: Listener): (() => void) => {
    if (!listenerMap.has(channel)) listenerMap.set(channel, []);
    listenerMap.get(channel)!.push(callback);
    return () => {
      const arr = listenerMap.get(channel);
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }),
  sendCommandDone: vi.fn(),
  getZoomFactor: vi.fn(() => 1),
  setZoomFactor: vi.fn(),
};

// Set up window.electron.demo before importing the component
const originalElectron = (window as unknown as { electron?: unknown }).electron;
(window as unknown as { electron: unknown }).electron = { demo: demoMock };

// Stub Element.prototype.animate (jsdom doesn't support WAAPI)
const mockAnimation = {
  finished: Promise.resolve(),
  cancel: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(),
};
Element.prototype.animate = vi.fn(() => mockAnimation as unknown as Animation);

import { DemoCursor } from "../DemoCursor";

function emit(channel: string, payload: Record<string, unknown> = {}) {
  const handlers = listenerMap.get(channel) ?? [];
  for (const h of handlers) {
    h(payload);
  }
}

describe("DemoCursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenerMap.clear();
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

  it("registers exec command listeners on mount", () => {
    render(<DemoCursor />);
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-move-to", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-click", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-type", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-set-zoom", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith(
      "demo:exec-wait-for-selector",
      expect.any(Function)
    );
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-pause", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-resume", expect.any(Function));
  });

  it("cleans up listeners on unmount", () => {
    const { unmount } = render(<DemoCursor />);
    // All 7 onExecCommand calls return cleanup functions
    expect(demoMock.onExecCommand).toHaveBeenCalledTimes(7);
    unmount();
    // After unmount, listeners should be removed
    expect(listenerMap.get("demo:exec-move-to")?.length ?? 0).toBe(0);
    expect(listenerMap.get("demo:exec-click")?.length ?? 0).toBe(0);
  });

  it("moveTo calls element.animate and sends done with requestId", async () => {
    render(<DemoCursor />);
    emit("demo:exec-move-to", { x: 30, y: 40, durationMs: 500, requestId: "req-1" });

    await new Promise((r) => setTimeout(r, 10));

    expect(Element.prototype.animate).toHaveBeenCalled();
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-1", undefined);
  });

  it("click calls element.animate for press and release", async () => {
    render(<DemoCursor />);
    emit("demo:exec-click", { requestId: "req-2" });

    await new Promise((r) => setTimeout(r, 10));

    expect(
      (Element.prototype.animate as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThanOrEqual(2);
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-2", undefined);
  });

  it("pause sends done immediately", () => {
    render(<DemoCursor />);
    emit("demo:exec-pause", { requestId: "req-3" });

    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-3", undefined);
  });

  it("resume sends done and releases paused commands", () => {
    render(<DemoCursor />);
    emit("demo:exec-pause", { requestId: "req-4" });
    emit("demo:exec-resume", { requestId: "req-5" });

    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-4", undefined);
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-5", undefined);
  });

  it("waitForSelector resolves immediately when element exists", async () => {
    const el = document.createElement("div");
    el.id = "test-target";
    document.body.appendChild(el);

    render(<DemoCursor />);
    emit("demo:exec-wait-for-selector", { selector: "#test-target", requestId: "req-6" });

    await new Promise((r) => setTimeout(r, 10));

    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-6", undefined);

    document.body.removeChild(el);
  });
});

afterAll(() => {
  if (originalElectron) {
    (window as unknown as { electron: unknown }).electron = originalElectron;
  } else {
    delete (window as unknown as { electron?: unknown }).electron;
  }
});
