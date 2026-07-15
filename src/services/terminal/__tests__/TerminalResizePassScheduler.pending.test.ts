// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ focusedId: null }) },
}));

import { TerminalResizePassScheduler } from "../TerminalResizePassScheduler";
import { GRID_RESIZE_COALESCE_MS } from "../types";

describe("TerminalResizePassScheduler pending ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createScheduler() {
    return new TerminalResizePassScheduler({
      getInstance: vi.fn(() => undefined),
      isResizeLocked: vi.fn(() => false),
      resize: vi.fn(),
    });
  }

  it("retains ownership across coalescing, frame handoff, and a deferred active pass", async () => {
    let frameCallback: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 1;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    let runTask: (() => Promise<void>) | undefined;
    vi.stubGlobal("scheduler", {
      postTask: vi.fn(
        (callback: () => unknown) =>
          new Promise<void>((resolve, reject) => {
            runTask = async () => {
              try {
                await callback();
                resolve();
              } catch (error) {
                reject(error);
              }
            };
          })
      ),
    });
    const resizeScheduler = createScheduler();

    resizeScheduler.scheduleBatchResize(["term-1"]);
    expect(resizeScheduler.isResizePending("term-1")).toBe(true);

    vi.advanceTimersByTime(GRID_RESIZE_COALESCE_MS);
    expect(frameCallback).toBeDefined();
    expect(resizeScheduler.isResizePending("term-1")).toBe(true);

    frameCallback!(0);
    expect(resizeScheduler.isResizePending("term-1")).toBe(true);

    await runTask!();
    await vi.runAllTicks();
    expect(resizeScheduler.isResizePending("term-1")).toBe(false);
  });

  it("carries superseded pass obligations into the replacement", () => {
    vi.stubGlobal("scheduler", undefined);
    const resizeScheduler = createScheduler();

    resizeScheduler.runResizePass(["old-first", "old-pending"]);
    expect(resizeScheduler.isResizePending("old-first")).toBe(false);
    expect(resizeScheduler.isResizePending("old-pending")).toBe(true);

    resizeScheduler.runResizePass(["replacement"]);

    expect(resizeScheduler.isResizePending("old-pending")).toBe(true);
    expect(resizeScheduler.isResizePending("replacement")).toBe(false);
  });

  it("clears active and scheduled ownership when cancelled or disposed", () => {
    vi.stubGlobal("scheduler", undefined);
    const resizeScheduler = createScheduler();

    resizeScheduler.runResizePass(["first", "pending"]);
    expect(resizeScheduler.isResizePending("pending")).toBe(true);
    resizeScheduler.cancelActiveResizePass();
    expect(resizeScheduler.isResizePending("pending")).toBe(false);

    resizeScheduler.scheduleBatchResize(["scheduled"]);
    expect(resizeScheduler.isResizePending("scheduled")).toBe(true);
    resizeScheduler.dispose();
    expect(resizeScheduler.isResizePending("scheduled")).toBe(false);
  });
});
