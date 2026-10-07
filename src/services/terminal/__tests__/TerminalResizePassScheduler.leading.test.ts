// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ focusedId: null }) },
}));

import { TerminalResizePassScheduler } from "../TerminalResizePassScheduler";
import { GRID_RESIZE_COALESCE_MS } from "../types";
import type { ManagedTerminal } from "../types";

function host(): ManagedTerminal {
  const hostElement = document.createElement("div");
  document.body.appendChild(hostElement);
  hostElement.checkVisibility = () => true;
  hostElement.getBoundingClientRect = () =>
    ({ width: 400, height: 300, x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300 }) as DOMRect;
  return { hostElement } as unknown as ManagedTerminal;
}

describe("TerminalResizePassScheduler leading-edge batches", () => {
  const instances = new Map<string, ManagedTerminal>();
  type ResizeFn = (
    id: string,
    width: number,
    height: number,
    options?: { immediate?: boolean }
  ) => unknown;
  let resize: ReturnType<typeof vi.fn<ResizeFn>>;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("scheduler", undefined);
    frames = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        frames.push(cb);
        return frames.length;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    instances.clear();
    for (const id of ["a", "b", "c"]) instances.set(id, host());
    resize = vi.fn<ResizeFn>();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function createScheduler() {
    return new TerminalResizePassScheduler({
      getInstance: (id) => instances.get(id),
      isResizeLocked: () => false,
      resize,
    });
  }

  function resizedIds(): string[] {
    return resize.mock.calls.map((call) => call[0] as string);
  }

  it("starts the first pass of a burst immediately, without the large-buffer debounce", async () => {
    const s = createScheduler();
    s.scheduleBatchResize(["a", "b"], { leading: true });
    await vi.runAllTicks();
    // One terminal per task: the first resizes synchronously, the rest after yields.
    await vi.advanceTimersByTimeAsync(0);
    expect(resizedIds()).toEqual(["a", "b"]);
    expect(resize.mock.calls.every((call) => call[3]?.immediate === true)).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("coalesces the rest of the burst into one trailing pass", async () => {
    const s = createScheduler();
    s.scheduleBatchResize(["a"], { leading: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(resizedIds()).toEqual(["a"]);

    s.scheduleBatchResize(["b"], { leading: true });
    s.scheduleBatchResize(["c"], { leading: true });
    expect(s.isResizePending("b")).toBe(true);
    expect(s.isResizePending("c")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(resizedIds()).toEqual(["a"]);

    await vi.advanceTimersByTimeAsync(GRID_RESIZE_COALESCE_MS);
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(resizedIds()).toEqual(["a", "b", "c"]);
  });

  it("schedules nothing trailing when the burst was a single leading call", async () => {
    const s = createScheduler();
    s.scheduleBatchResize(["a"], { leading: true });
    await vi.advanceTimersByTimeAsync(GRID_RESIZE_COALESCE_MS * 2);
    expect(frames).toHaveLength(0);
    expect(resizedIds()).toEqual(["a"]);

    // The window has closed, so the next change leads again.
    s.scheduleBatchResize(["b"], { leading: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(resizedIds()).toEqual(["a", "b"]);
  });

  it("keeps the trailing-only behaviour without the option", async () => {
    const s = createScheduler();
    s.scheduleBatchResize(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(resize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GRID_RESIZE_COALESCE_MS);
    frames[0]!(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(resizedIds()).toEqual(["a"]);
    expect(resize.mock.calls[0]![3]).toBeUndefined();
  });

  it("keeps a later add/close's immediacy in the trailing pass", async () => {
    const s = createScheduler();
    s.scheduleBatchResize(["a"], { leading: true });
    s.scheduleBatchResize(["b"], { leading: true });
    s.scheduleBatchResize(["c"]);
    await vi.advanceTimersByTimeAsync(GRID_RESIZE_COALESCE_MS);
    frames[0]!(0);
    await vi.advanceTimersByTimeAsync(0);

    const byId = new Map(resize.mock.calls.slice(1).map((call) => [call[0], call[3]]));
    expect(byId.get("b")).toEqual({ immediate: true });
    expect(byId.get("c")).toBeUndefined();
  });

  it("treats a pass waiting on its frame as part of the burst", async () => {
    const s = createScheduler();
    s.scheduleBatchResize(["a"]);
    await vi.advanceTimersByTimeAsync(GRID_RESIZE_COALESCE_MS);
    expect(frames).toHaveLength(1);

    s.scheduleBatchResize(["b"], { leading: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(resize).not.toHaveBeenCalled();
    expect(s.isResizePending("b")).toBe(true);
  });
});
