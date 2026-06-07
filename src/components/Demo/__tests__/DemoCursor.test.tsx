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
};

const terminalWriteMock = vi.fn();

// terminalInstanceService is imported at module scope by DemoCursor for
// reading xterm cursor-key mode; mock it so tests can control the mode.
const terminalGetMock = vi.fn();
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: (id: string) => terminalGetMock(id),
  },
}));

// Set up window.electron.demo before importing the component
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const originalElectron = (window as unknown as { electron?: unknown }).electron;
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
(window as unknown as { electron: unknown }).electron = {
  demo: demoMock,
  terminal: { write: terminalWriteMock },
};

// Stub Element.prototype.animate (jsdom doesn't support WAAPI)
function createMockAnimation() {
  return {
    finished: Promise.resolve(),
    cancel: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(),
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const animateSpy = vi.fn((() => createMockAnimation()) as any) as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
Element.prototype.animate = animateSpy as unknown as typeof Element.prototype.animate;

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
    // Set window dimensions for % to px conversion
    Object.defineProperty(window, "innerWidth", {
      value: 1000,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      writable: true,
      configurable: true,
    });
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
    expect(demoMock.onExecCommand).toHaveBeenCalledWith(
      "demo:exec-move-to-selector",
      expect.any(Function)
    );
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-click", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-type", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith(
      "demo:exec-wait-for-selector",
      expect.any(Function)
    );
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-sleep", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-pause", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-resume", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-scroll", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith("demo:exec-drag", expect.any(Function));
    expect(demoMock.onExecCommand).toHaveBeenCalledWith(
      "demo:exec-press-key",
      expect.any(Function)
    );
    expect(demoMock.onExecCommand).toHaveBeenCalledWith(
      "demo:exec-wait-for-idle",
      expect.any(Function)
    );
    expect(demoMock.onExecCommand).toHaveBeenCalledWith(
      "demo:exec-type-in-terminal",
      expect.any(Function)
    );
    expect(demoMock.onExecCommand).toHaveBeenCalledWith(
      "demo:exec-send-key-to-terminal",
      expect.any(Function)
    );
  });

  it("cleans up listeners on unmount", () => {
    const { unmount } = render(<DemoCursor />);
    // All 14 onExecCommand calls return cleanup functions (move-to, move-to-selector, click, type, wait-for-selector, sleep, pause, resume, scroll, drag, press-key, wait-for-idle, type-in-terminal, send-key-to-terminal)
    expect(demoMock.onExecCommand).toHaveBeenCalledTimes(14);
    unmount();
    // After unmount, listeners should be removed
    expect(listenerMap.get("demo:exec-move-to")?.length ?? 0).toBe(0);
    expect(listenerMap.get("demo:exec-move-to-selector")?.length ?? 0).toBe(0);
    expect(listenerMap.get("demo:exec-click")?.length ?? 0).toBe(0);
  });

  it("moveTo converts percent to px and calls element.animate", async () => {
    render(<DemoCursor />);
    emit("demo:exec-move-to", { x: 30, y: 40, durationMs: 500, requestId: "req-1" });

    await new Promise((r) => setTimeout(r, 10));

    expect(animateSpy).toHaveBeenCalled();
    const keyframes = animateSpy.mock.calls[0]![0] as Array<{ transform: string }>;
    expect(keyframes[0]).toHaveProperty("transform");
    expect(keyframes[keyframes.length - 1]!.transform).toContain("translate(");
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-1", undefined);
  });

  it("moveToSelector animates to element center", async () => {
    const el = document.createElement("div");
    el.id = "selector-target";
    el.checkVisibility = vi.fn(() => true);
    el.scrollIntoView = vi.fn();
    el.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 100,
          top: 200,
          width: 50,
          height: 30,
          right: 150,
          bottom: 230,
          x: 100,
          y: 200,
          toJSON: () => {},
        }) as DOMRect
    );
    document.body.appendChild(el);

    render(<DemoCursor />);
    emit("demo:exec-move-to-selector", {
      selector: "#selector-target",
      durationMs: 400,
      requestId: "req-sel-1",
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      behavior: "instant",
      block: "nearest",
      inline: "nearest",
    });
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-sel-1", undefined);

    document.body.removeChild(el);
  });

  it("moveToSelector rejects when no visible element matches", async () => {
    render(<DemoCursor />);
    emit("demo:exec-move-to-selector", {
      selector: "#nonexistent",
      durationMs: 400,
      requestId: "req-sel-2",
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(demoMock.sendCommandDone).toHaveBeenCalledWith(
      "req-sel-2",
      "Selector not found or not visible: #nonexistent"
    );
  });

  it("click dispatches mousedown/mouseup/click events", async () => {
    render(<DemoCursor />);

    const target = document.createElement("button");
    const events: string[] = [];
    target.addEventListener("mousedown", () => events.push("mousedown"));
    target.addEventListener("mouseup", () => events.push("mouseup"));
    target.addEventListener("click", () => events.push("click"));

    const origElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => target);

    emit("demo:exec-click", { requestId: "req-click-1" });

    await new Promise((r) => setTimeout(r, 10));

    expect(events).toEqual(["mousedown", "mouseup", "click"]);
    // Verify elementFromPoint was called with cursor position (near viewport center, shifted by settle drift)
    const efp = document.elementFromPoint as ReturnType<typeof vi.fn>;
    const [calledX, calledY] = efp.mock.calls[0]!;
    expect(calledX).toBeCloseTo(window.innerWidth / 2, -1);
    expect(calledY).toBeCloseTo(window.innerHeight / 2, -1);
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-click-1", undefined);

    document.elementFromPoint = origElementFromPoint;
  });

  it("click calls element.animate for press and release on SVG wrapper", async () => {
    render(<DemoCursor />);

    const origElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => null);

    emit("demo:exec-click", { requestId: "req-2" });

    await new Promise((r) => setTimeout(r, 10));

    // press + release + ripple + settle = at least 3 calls (ripple may be skipped if ref is null)
    expect(animateSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-2", undefined);

    document.elementFromPoint = origElementFromPoint;
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

  it("type() inserts characters into native input and sends done", async () => {
    const input = document.createElement("input");
    input.id = "native-input";
    document.body.appendChild(input);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    try {
      render(<DemoCursor />);
      emit("demo:exec-type", {
        selector: "#native-input",
        text: "hi",
        cps: 1000,
        requestId: "req-type-native",
      });

      await vi.waitFor(
        () => expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-type-native", undefined),
        { timeout: 2000, interval: 20 }
      );

      expect(input.value).toBe("hi");
    } finally {
      randomSpy.mockRestore();
      document.body.removeChild(input);
    }
  });

  it("type() dispatches CodeMirror transactions when target is a CM editor", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");

    const container = document.createElement("div");
    container.id = "cm-container";
    document.body.appendChild(container);

    const view = new EditorView({
      state: EditorState.create({ doc: "" }),
      parent: container,
    });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    try {
      render(<DemoCursor />);
      emit("demo:exec-type", {
        selector: "#cm-container",
        text: "ab",
        cps: 1000,
        requestId: "req-type-cm",
      });

      await vi.waitFor(
        () => expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-type-cm", undefined),
        { timeout: 2000, interval: 20 }
      );

      expect(view.state.doc.toString()).toBe("ab");
    } finally {
      randomSpy.mockRestore();
      view.destroy();
      document.body.removeChild(container);
    }
  });

  it("sleep completes after the specified duration", async () => {
    vi.useFakeTimers();

    render(<DemoCursor />);
    let done = false;
    const original = demoMock.sendCommandDone.getMockImplementation();
    demoMock.sendCommandDone.mockImplementation((requestId: string, error?: string) => {
      if (requestId === "req-sleep") done = true;
      original?.(requestId, error);
    });

    emit("demo:exec-sleep", { durationMs: 200, requestId: "req-sleep" });

    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(150);
    expect(done).toBe(true);

    vi.useRealTimers();
  });

  it("moveTo without durationMs auto-computes duration via Fitts's law", async () => {
    render(<DemoCursor />);
    emit("demo:exec-move-to", { x: 30, y: 40, requestId: "req-fitts" });

    await new Promise((r) => setTimeout(r, 10));

    expect(animateSpy).toHaveBeenCalled();
    const options = animateSpy.mock.calls[0]![1] as KeyframeAnimationOptions;
    expect(options.duration).toBeGreaterThan(0);
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-fitts", undefined);
  });

  it("moveTo produces more keyframes for longer distances", async () => {
    render(<DemoCursor />);

    // Short move: 10% of 1000px = 100px from center (500,400)
    emit("demo:exec-move-to", { x: 60, y: 50, durationMs: 300, requestId: "req-short" });
    await new Promise((r) => setTimeout(r, 10));
    const shortFrameCount = (animateSpy.mock.calls[0]![0] as unknown[]).length;

    animateSpy.mockClear();

    // Long move: from current position to far corner — need a fresh render
    cleanup();
    render(<DemoCursor />);
    emit("demo:exec-move-to", { x: 95, y: 95, durationMs: 300, requestId: "req-long" });
    await new Promise((r) => setTimeout(r, 10));
    const longFrameCount = (animateSpy.mock.calls[0]![0] as unknown[]).length;

    expect(longFrameCount).toBeGreaterThan(shortFrameCount);
  });

  it("moveTo long-distance move calls animate twice (ballistic + acquisition)", async () => {
    // Pin random above both overshoot probabilities so the cosmetic overshoot never fires,
    // isolating the two-phase ballistic + acquisition structure.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      render(<DemoCursor />);
      // cursor starts at (500, 400). Move to (100, 0) = (1000, 0). Distance ~500+px > 300px threshold
      emit("demo:exec-move-to", { x: 100, y: 0, durationMs: 800, requestId: "req-twophase" });

      await new Promise((r) => setTimeout(r, 10));

      // Two phases = two animate calls on the cursor element
      const cursorCalls = animateSpy.mock.calls.filter((call) => {
        const keyframes = call[0] as Array<{ transform: string }>;
        return Array.isArray(keyframes) && keyframes[0]?.transform?.includes("translate(");
      });
      expect(cursorCalls.length).toBe(2);
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-twophase", undefined);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("moveTo short move calls animate once", async () => {
    render(<DemoCursor />);
    // cursor starts at (500, 400). Move to (55, 50) = (550, 400). Distance = 50px < 300px
    emit("demo:exec-move-to", { x: 55, y: 50, durationMs: 200, requestId: "req-onephase" });

    await new Promise((r) => setTimeout(r, 10));

    const cursorCalls = animateSpy.mock.calls.filter((call) => {
      const keyframes = call[0] as Array<{ transform: string }>;
      return Array.isArray(keyframes) && keyframes[0]?.transform?.includes("translate(");
    });
    expect(cursorCalls.length).toBe(1);
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-onephase", undefined);
  });

  it("moveTo short move accelerates from rest (bell-shaped easing, not ease-out)", async () => {
    render(<DemoCursor />);
    // Short move: (500,400) → (550,400), 50px < 300px threshold
    emit("demo:exec-move-to", { x: 55, y: 50, durationMs: 200, requestId: "req-easing" });

    await new Promise((r) => setTimeout(r, 10));

    const cursorCall = animateSpy.mock.calls.find((call) => {
      const keyframes = call[0] as Array<{ transform: string }>;
      return Array.isArray(keyframes) && keyframes[0]?.transform?.includes("translate(");
    })!;
    const options = cursorCall[1] as KeyframeAnimationOptions;
    // Easing must have zero slope at t=0 (accelerate from rest), i.e. a cubic-bezier whose
    // first control-point x-handle starts the curve in — not "ease-out" which begins at full speed.
    expect(options.easing).not.toBe("ease-out");
    expect(String(options.easing)).toMatch(/^cubic-bezier\(/);
    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-easing", undefined);
  });

  it("moveTo long move overshoots and corrects when the probability roll triggers", async () => {
    // Pin random below the overshoot probability so the cosmetic overshoot fires.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.05);
    try {
      render(<DemoCursor />);
      // (500,400) → (1000,0), distance ~640px > 300px threshold
      emit("demo:exec-move-to", { x: 100, y: 0, durationMs: 800, requestId: "req-overshoot" });

      await new Promise((r) => setTimeout(r, 10));

      const cursorCalls = animateSpy.mock.calls.filter((call) => {
        const keyframes = call[0] as Array<{ transform: string }>;
        return Array.isArray(keyframes) && keyframes[0]?.transform?.includes("translate(");
      });
      // ballistic + acquisition + overshoot = 3 cursor animate calls
      expect(cursorCalls.length).toBe(3);

      // The overshoot is the final cursor call: starts and ends settled on target, peaks past it.
      const overshoot = cursorCalls[cursorCalls.length - 1]![0] as Array<{
        transform: string;
        offset: number;
      }>;
      expect(overshoot.length).toBe(3);
      expect(overshoot[0]!.transform).toBe("translate(0px, 0px)");
      expect(overshoot[0]!.offset).toBe(0);
      expect(overshoot[1]!.offset).toBeGreaterThan(0);
      expect(overshoot[1]!.offset).toBeLessThan(1);
      expect(overshoot[1]!.transform).not.toBe("translate(0px, 0px)");
      expect(overshoot[2]!.transform).toBe("translate(0px, 0px)");
      expect(overshoot[2]!.offset).toBe(1);
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-overshoot", undefined);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("moveTo long move skips overshoot when the probability roll does not trigger", async () => {
    // Pin random above the overshoot probability so no overshoot phase is added.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      render(<DemoCursor />);
      emit("demo:exec-move-to", { x: 100, y: 0, durationMs: 800, requestId: "req-no-overshoot" });

      await new Promise((r) => setTimeout(r, 10));

      const cursorCalls = animateSpy.mock.calls.filter((call) => {
        const keyframes = call[0] as Array<{ transform: string }>;
        return Array.isArray(keyframes) && keyframes[0]?.transform?.includes("translate(");
      });
      expect(cursorCalls.length).toBe(2);
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-no-overshoot", undefined);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("overshoot peak lies forward along the travel vector", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.05);
    try {
      render(<DemoCursor />);
      // (500,400) → (1000,0): travel vector (dx, dy) = (500, -400)
      emit("demo:exec-move-to", { x: 100, y: 0, durationMs: 800, requestId: "req-dir" });
      await new Promise((r) => setTimeout(r, 10));

      const cursorCalls = animateSpy.mock.calls.filter((call) => {
        const keyframes = call[0] as Array<{ transform: string }>;
        return Array.isArray(keyframes) && keyframes[0]?.transform?.includes("translate(");
      });
      const overshoot = cursorCalls[cursorCalls.length - 1]![0] as Array<{ transform: string }>;
      const m = overshoot[1]!.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)!;
      const peakX = parseFloat(m[1]!);
      const peakY = parseFloat(m[2]!);
      // Dot product of overshoot peak with travel vector must be positive (forward, not backward).
      const dot = peakX * 500 + peakY * -400;
      expect(dot).toBeGreaterThan(0);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("after overshoot, a click reads the real target — not the overshoot peak", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.05);
    const origElementFromPoint = document.elementFromPoint;
    const efp = vi.fn((_x: number, _y: number) => null);
    document.elementFromPoint = efp as unknown as typeof document.elementFromPoint;
    try {
      render(<DemoCursor />);
      // Move to a mid-viewport target so settle jitter stays in range: (1000*0.7, 800*0.5) = (700, 400)
      emit("demo:exec-move-to", { x: 70, y: 50, durationMs: 800, requestId: "req-posref" });
      await new Promise((r) => setTimeout(r, 10));

      emit("demo:exec-click", { requestId: "req-posref-click" });
      await new Promise((r) => setTimeout(r, 10));

      // Click position (posRef + ≤1.5px settle) must be the committed target, not the overshoot peak.
      const [clickX, clickY] = efp.mock.calls[efp.mock.calls.length - 1]!;
      expect(clickX).toBeCloseTo(700, -1);
      expect(clickY).toBeCloseTo(400, -1);
    } finally {
      randomSpy.mockRestore();
      document.elementFromPoint = origElementFromPoint;
    }
  });

  it("a cosmetic overshoot failure does not fail the move command", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.05);
    // Make only the overshoot animation (keyframes carry an `offset`) reject its finished promise.
    animateSpy.mockImplementation(((keyframes: Array<{ offset?: number }>) => {
      const isOvershoot = Array.isArray(keyframes) && keyframes[0]?.offset === 0;
      return {
        finished: isOvershoot ? Promise.reject(new Error("aborted")) : Promise.resolve(),
        cancel: vi.fn(),
        pause: vi.fn(),
        play: vi.fn(),
      };
    }) as unknown as typeof animateSpy.getMockImplementation);
    try {
      render(<DemoCursor />);
      emit("demo:exec-move-to", { x: 100, y: 0, durationMs: 800, requestId: "req-cosmetic-fail" });
      await new Promise((r) => setTimeout(r, 10));

      // Cosmetic failure swallowed — command still reports success.
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-cosmetic-fail", undefined);
    } finally {
      randomSpy.mockRestore();
      animateSpy.mockImplementation((() => createMockAnimation()) as never);
    }
  });

  it("click includes settle animation on cursor element", async () => {
    render(<DemoCursor />);

    const origElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => null);

    emit("demo:exec-click", { requestId: "req-settle" });
    await new Promise((r) => setTimeout(r, 10));

    // Should have press + release + ripple + settle = at least 4 animate calls
    // (ripple fires on the ripple element, settle on the cursor element)
    expect(animateSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Verify settle animation keyframes include small translate
    const lastCall = animateSpy.mock.calls[animateSpy.mock.calls.length - 1]!;
    const lastKeyframes = lastCall[0] as Array<{ transform: string }>;
    if (lastKeyframes.length === 2) {
      expect(lastKeyframes[0]!.transform).toBe("translate(0px, 0px)");
      expect(lastKeyframes[1]!.transform).toMatch(/translate\([^)]+\)/);
    }

    expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-settle", undefined);
    document.elementFromPoint = origElementFromPoint;
  });

  it("type() applies variable delays (not uniform)", async () => {
    const input = document.createElement("input");
    input.id = "type-delay-input";
    document.body.appendChild(input);

    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const randomValues = [
      0.5, 0.5, 0, 0.5, 0.5, 0.5, 0.5, 0.2, 0, 0.5, 0.5, 0, 0.5, 0.5, 0.5,
    ];
    let randomIndex = 0;
    const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => {
      return randomValues[randomIndex++] ?? 0.5;
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number
    ) => {
      if (ms !== undefined && ms > 0) delays.push(ms);
      return origSetTimeout(fn, 0);
    }) as typeof setTimeout);

    try {
      render(<DemoCursor />);
      emit("demo:exec-type", {
        selector: "#type-delay-input",
        text: "ab cd",
        cps: 12,
        requestId: "req-type-delays",
      });

      await new Promise((r) => origSetTimeout(r, 500));

      // With Gaussian variance, not all delays should be identical
      const uniqueDelays = new Set(delays.filter((d) => d >= 10));
      expect(uniqueDelays.size).toBeGreaterThan(1);

      expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-type-delays", undefined);
    } finally {
      randomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      document.body.removeChild(input);
    }
  });

  it("typeInTerminal writes each character to the PTY and sends done", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-1");
    document.body.appendChild(panel);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    try {
      render(<DemoCursor />);
      emit("demo:exec-type-in-terminal", {
        selector: '[data-panel-id="term-1"]',
        text: "hi",
        cps: 1000,
        requestId: "req-term-type",
      });

      await vi.waitFor(
        () => expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-term-type", undefined),
        { timeout: 2000, interval: 20 }
      );

      const writtenChars = terminalWriteMock.mock.calls.map((c) => c[1]).join("");
      expect(writtenChars).toBe("hi");
      expect(terminalWriteMock.mock.calls.every((c) => c[0] === "term-1")).toBe(true);
    } finally {
      randomSpy.mockRestore();
      document.body.removeChild(panel);
    }
  });

  it("typeInTerminal resolves the panel id from a child element", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-child");
    const child = document.createElement("div");
    child.className = "xterm-screen";
    panel.appendChild(child);
    document.body.appendChild(panel);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    try {
      render(<DemoCursor />);
      emit("demo:exec-type-in-terminal", {
        selector: ".xterm-screen",
        text: "x",
        cps: 1000,
        requestId: "req-term-child",
      });

      await vi.waitFor(
        () => expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-term-child", undefined),
        { timeout: 2000, interval: 20 }
      );

      expect(terminalWriteMock).toHaveBeenCalledWith("term-child", "x");
    } finally {
      randomSpy.mockRestore();
      document.body.removeChild(panel);
    }
  });

  it("typeInTerminal reports an error when the terminal panel is not found", async () => {
    render(<DemoCursor />);
    emit("demo:exec-type-in-terminal", {
      selector: '[data-panel-id="missing"]',
      text: "hi",
      requestId: "req-term-missing",
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(demoMock.sendCommandDone).toHaveBeenCalledWith(
      "req-term-missing",
      'Terminal panel not found: [data-panel-id="missing"]'
    );
    expect(terminalWriteMock).not.toHaveBeenCalled();
  });

  it("sendKeyToTerminal writes the normal-mode escape sequence for arrows", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-key");
    document.body.appendChild(panel);
    terminalGetMock.mockReturnValue({
      terminal: { modes: { applicationCursorKeysMode: false } },
    });

    try {
      render(<DemoCursor />);
      emit("demo:exec-send-key-to-terminal", {
        selector: '[data-panel-id="term-key"]',
        key: "up",
        requestId: "req-key-up",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).toHaveBeenCalledWith("term-key", "\x1b[A");
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-key-up", undefined);
    } finally {
      document.body.removeChild(panel);
    }
  });

  it("sendKeyToTerminal writes the application-mode escape sequence when DECCKM is on", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-app");
    document.body.appendChild(panel);
    terminalGetMock.mockReturnValue({
      terminal: { modes: { applicationCursorKeysMode: true } },
    });

    try {
      render(<DemoCursor />);
      emit("demo:exec-send-key-to-terminal", {
        selector: '[data-panel-id="term-app"]',
        key: "up",
        requestId: "req-key-app",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).toHaveBeenCalledWith("term-app", "\x1bOA");
    } finally {
      document.body.removeChild(panel);
    }
  });

  it("sendKeyToTerminal sends ctrl-c regardless of cursor mode", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-ctrlc");
    document.body.appendChild(panel);
    terminalGetMock.mockReturnValue({
      terminal: { modes: { applicationCursorKeysMode: true } },
    });

    try {
      render(<DemoCursor />);
      emit("demo:exec-send-key-to-terminal", {
        selector: '[data-panel-id="term-ctrlc"]',
        key: "ctrl-c",
        requestId: "req-key-ctrlc",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).toHaveBeenCalledWith("term-ctrlc", "\x03");
    } finally {
      document.body.removeChild(panel);
    }
  });

  it("sendKeyToTerminal falls back to normal mode when the instance is unavailable", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-noinst");
    document.body.appendChild(panel);
    terminalGetMock.mockReturnValue(null);

    try {
      render(<DemoCursor />);
      emit("demo:exec-send-key-to-terminal", {
        selector: '[data-panel-id="term-noinst"]',
        key: "left",
        requestId: "req-key-noinst",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).toHaveBeenCalledWith("term-noinst", "\x1b[D");
    } finally {
      document.body.removeChild(panel);
    }
  });

  it.each([
    ["enter", "\r"],
    ["tab", "\t"],
    ["escape", "\x1b"],
    ["backspace", "\x7f"],
    ["down", "\x1b[B"],
    ["right", "\x1b[C"],
    ["left", "\x1b[D"],
    ["home", "\x1b[H"],
    ["end", "\x1b[F"],
    ["pageup", "\x1b[5~"],
    ["pagedown", "\x1b[6~"],
    ["ctrl-d", "\x04"],
    ["ctrl-u", "\x15"],
  ])("sendKeyToTerminal writes the correct byte sequence for %s", async (key, expected) => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-map");
    document.body.appendChild(panel);
    terminalGetMock.mockReturnValue(null);

    try {
      render(<DemoCursor />);
      emit("demo:exec-send-key-to-terminal", {
        selector: '[data-panel-id="term-map"]',
        key,
        requestId: `req-key-${key}`,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).toHaveBeenCalledWith("term-map", expected);
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith(`req-key-${key}`, undefined);
    } finally {
      document.body.removeChild(panel);
    }
  });

  it("sendKeyToTerminal rejects an unknown key without writing", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-unknown");
    document.body.appendChild(panel);
    terminalGetMock.mockReturnValue(null);

    try {
      render(<DemoCursor />);
      emit("demo:exec-send-key-to-terminal", {
        selector: '[data-panel-id="term-unknown"]',
        key: "ctrl-z",
        requestId: "req-key-unknown",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).not.toHaveBeenCalled();
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith(
        "req-key-unknown",
        "Unknown terminal key: ctrl-z"
      );
    } finally {
      document.body.removeChild(panel);
    }
  });

  it("sendKeyToTerminal resolves a selector that targets the panel root directly", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-root");
    document.body.appendChild(panel);
    terminalGetMock.mockReturnValue(null);

    try {
      render(<DemoCursor />);
      emit("demo:exec-send-key-to-terminal", {
        selector: '[data-panel-id="term-root"]',
        key: "enter",
        requestId: "req-key-root",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).toHaveBeenCalledWith("term-root", "\r");
    } finally {
      document.body.removeChild(panel);
    }
  });

  it("sendKeyToTerminal reports an error when the element has no panel ancestor", async () => {
    const orphan = document.createElement("div");
    orphan.id = "orphan-no-panel";
    document.body.appendChild(orphan);

    try {
      render(<DemoCursor />);
      emit("demo:exec-send-key-to-terminal", {
        selector: "#orphan-no-panel",
        key: "enter",
        requestId: "req-key-orphan",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).not.toHaveBeenCalled();
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith(
        "req-key-orphan",
        "Terminal panel not found: #orphan-no-panel"
      );
    } finally {
      document.body.removeChild(orphan);
    }
  });

  it("typeInTerminal sends done and writes nothing for empty text", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-id", "term-empty");
    document.body.appendChild(panel);

    try {
      render(<DemoCursor />);
      emit("demo:exec-type-in-terminal", {
        selector: '[data-panel-id="term-empty"]',
        text: "",
        requestId: "req-term-empty",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(terminalWriteMock).not.toHaveBeenCalled();
      expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-term-empty", undefined);
    } finally {
      document.body.removeChild(panel);
    }
  });

  describe("drag", () => {
    let rafClock = 0;
    let origElementFromPoint: typeof document.elementFromPoint;

    beforeEach(() => {
      vi.useFakeTimers();
      rafClock = 0;
      // Drive rAF off the fake-timer clock with a synthetic monotonic timestamp
      // so elapsed-time pacing in the drag loop advances deterministically.
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        return setTimeout(() => {
          rafClock += 16;
          cb(rafClock);
        }, 16) as unknown as number;
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => {
        clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      });
      // jsdom has no elementFromPoint; null falls back to the source/target els.
      origElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn(() => null);
    });

    afterEach(() => {
      document.elementFromPoint = origElementFromPoint;
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    function makeDragTarget(id: string, cx: number, cy: number): HTMLElement {
      const el = document.createElement("div");
      el.id = id;
      el.getBoundingClientRect = vi.fn(
        () =>
          ({
            left: cx,
            top: cy,
            width: 0,
            height: 0,
            right: cx,
            bottom: cy,
            x: cx,
            y: cy,
            toJSON: () => {},
          }) as DOMRect
      );
      document.body.appendChild(el);
      return el;
    }

    it("drives the glyph along the path instead of teleporting to target", async () => {
      // Horizontal drag keeps x strictly monotonic (perpendicular bow + jitter are vertical).
      const src = makeDragTarget("drag-src", 100, 100);
      const dst = makeDragTarget("drag-dst", 500, 100);
      const { container } = render(<DemoCursor />);
      const cursorEl = container.querySelector("[data-demo-cursor]") as HTMLElement;

      try {
        emit("demo:exec-drag", {
          fromSelector: "#drag-src",
          toSelector: "#drag-dst",
          durationMs: 500,
          requestId: "req-drag",
        });

        // Mid-drag: glyph has left the source but not reached the target.
        await vi.advanceTimersByTimeAsync(200);
        const midLeft = parseFloat(cursorEl.style.left);
        expect(midLeft).toBeGreaterThan(100);
        expect(midLeft).toBeLessThan(500);

        // Run to completion: glyph lands exactly on the target.
        await vi.advanceTimersByTimeAsync(600);
        expect(parseFloat(cursorEl.style.left)).toBeCloseTo(500);
        expect(parseFloat(cursorEl.style.top)).toBeCloseTo(100);
        expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-drag", undefined);
      } finally {
        document.body.removeChild(src);
        document.body.removeChild(dst);
      }
    });

    it("dispatches pointermove at multiple intermediate coordinates", async () => {
      const src = makeDragTarget("drag-src2", 100, 100);
      const dst = makeDragTarget("drag-dst2", 500, 100);
      render(<DemoCursor />);

      const moveXs: number[] = [];
      const onMove = (e: Event) => moveXs.push((e as PointerEvent).clientX);
      document.addEventListener("pointermove", onMove);

      try {
        emit("demo:exec-drag", {
          fromSelector: "#drag-src2",
          toSelector: "#drag-dst2",
          durationMs: 500,
          requestId: "req-drag2",
        });

        await vi.advanceTimersByTimeAsync(800);

        // At least one move fired strictly between source and target (not teleport-only).
        expect(moveXs.some((x) => x > 100 && x < 500)).toBe(true);
        // Movement traverses many distinct positions, not two endpoints.
        expect(new Set(moveXs).size).toBeGreaterThan(2);
        expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-drag2", undefined);
      } finally {
        document.removeEventListener("pointermove", onMove);
        document.body.removeChild(src);
        document.body.removeChild(dst);
      }
    });

    it("freezes the glyph while paused and completes after resume", async () => {
      const src = makeDragTarget("drag-src3", 100, 100);
      const dst = makeDragTarget("drag-dst3", 500, 100);
      const { container } = render(<DemoCursor />);
      const cursorEl = container.querySelector("[data-demo-cursor]") as HTMLElement;

      let moveCount = 0;
      const onMove = () => moveCount++;
      document.addEventListener("pointermove", onMove);

      try {
        emit("demo:exec-drag", {
          fromSelector: "#drag-src3",
          toSelector: "#drag-dst3",
          durationMs: 500,
          requestId: "req-drag3",
        });

        await vi.advanceTimersByTimeAsync(150);
        emit("demo:exec-pause", { requestId: "req-drag3-pause" });
        const pausedLeft = parseFloat(cursorEl.style.left);
        const pausedMoveCount = moveCount;

        // While paused, frames keep firing but progress is frozen and no
        // further move events are dispatched.
        await vi.advanceTimersByTimeAsync(400);
        expect(parseFloat(cursorEl.style.left)).toBe(pausedLeft);
        expect(moveCount).toBe(pausedMoveCount);
        expect(demoMock.sendCommandDone).not.toHaveBeenCalledWith("req-drag3", undefined);

        // Resume and run to completion.
        emit("demo:exec-resume", { requestId: "req-drag3-resume" });
        await vi.advanceTimersByTimeAsync(600);
        expect(parseFloat(cursorEl.style.left)).toBeCloseTo(500);
        expect(moveCount).toBeGreaterThan(pausedMoveCount);
        expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-drag3", undefined);
      } finally {
        document.removeEventListener("pointermove", onMove);
        document.body.removeChild(src);
        document.body.removeChild(dst);
      }
    });

    it("keeps glyph and move events on the same coordinates for a diagonal drag", async () => {
      const src = makeDragTarget("drag-src4", 100, 100);
      const dst = makeDragTarget("drag-dst4", 500, 400);
      const { container } = render(<DemoCursor />);
      const cursorEl = container.querySelector("[data-demo-cursor]") as HTMLElement;

      // Sample event coords against the glyph position at dispatch time.
      const samples: Array<{ ex: number; ey: number; gx: number; gy: number }> = [];
      const onMove = (e: Event) => {
        const pe = e as PointerEvent;
        samples.push({
          ex: pe.clientX,
          ey: pe.clientY,
          gx: parseFloat(cursorEl.style.left),
          gy: parseFloat(cursorEl.style.top),
        });
      };
      document.addEventListener("pointermove", onMove);

      try {
        emit("demo:exec-drag", {
          fromSelector: "#drag-src4",
          toSelector: "#drag-dst4",
          durationMs: 500,
          requestId: "req-drag4",
        });
        await vi.advanceTimersByTimeAsync(800);

        expect(samples.length).toBeGreaterThan(2);
        // Glyph and events share the exact same coordinate each frame (no desync,
        // and Y is tracked — a missing top update would break this).
        for (const s of samples) {
          expect(s.ex).toBe(s.gx);
          expect(s.ey).toBe(s.gy);
        }
        // Both axes actually move (not parked, not single-axis).
        expect(new Set(samples.map((s) => s.ex)).size).toBeGreaterThan(2);
        expect(new Set(samples.map((s) => s.ey)).size).toBeGreaterThan(2);
        // Lands on the target.
        expect(parseFloat(cursorEl.style.left)).toBeCloseTo(500);
        expect(parseFloat(cursorEl.style.top)).toBeCloseTo(400);
        expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-drag4", undefined);
      } finally {
        document.removeEventListener("pointermove", onMove);
        document.body.removeChild(src);
        document.body.removeChild(dst);
      }
    });

    it("handles a zero-distance drag without NaN or hanging", async () => {
      const src = makeDragTarget("drag-src5", 300, 300);
      const dst = makeDragTarget("drag-dst5", 300, 300);
      const { container } = render(<DemoCursor />);
      const cursorEl = container.querySelector("[data-demo-cursor]") as HTMLElement;

      const seen = new Set<string>();
      const record = (e: Event) => seen.add(e.type);
      for (const type of ["pointerdown", "pointerup", "pointermove"]) {
        document.addEventListener(type, record);
      }

      try {
        emit("demo:exec-drag", {
          fromSelector: "#drag-src5",
          toSelector: "#drag-dst5",
          durationMs: 300,
          requestId: "req-drag5",
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(Number.isNaN(parseFloat(cursorEl.style.left))).toBe(false);
        expect(Number.isNaN(parseFloat(cursorEl.style.top))).toBe(false);
        expect(parseFloat(cursorEl.style.left)).toBeCloseTo(300);
        expect(parseFloat(cursorEl.style.top)).toBeCloseTo(300);
        expect(seen.has("pointerdown")).toBe(true);
        expect(seen.has("pointerup")).toBe(true);
        expect(demoMock.sendCommandDone).toHaveBeenCalledWith("req-drag5", undefined);
      } finally {
        for (const type of ["pointerdown", "pointerup", "pointermove"]) {
          document.removeEventListener(type, record);
        }
        document.body.removeChild(src);
        document.body.removeChild(dst);
      }
    });
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    (window as unknown as { electron: unknown }).electron = originalElectron;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    delete (window as unknown as { electron?: unknown }).electron;
  }
});
