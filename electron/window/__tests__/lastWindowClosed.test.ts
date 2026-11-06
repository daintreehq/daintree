import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/performance.js", () => ({
  markPerformance: vi.fn(),
}));

vi.mock("../../ipc/errorHandlers.js", () => ({
  notifyError: vi.fn(),
}));

vi.mock("../../services/TelemetryService.js", () => ({
  trackEvent: vi.fn(),
}));

import { releaseDeferredQueueOnWindowClosed } from "../lastWindowClosed.js";
import {
  registerDeferredTask,
  finalizeDeferredRegistration,
  signalFirstInteractive,
  getDeferredQueueState,
  __resetDeferredQueueForTests,
} from "../deferredInitQueue.js";

describe("releaseDeferredQueueOnWindowClosed", () => {
  beforeEach(() => {
    __resetDeferredQueueForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetDeferredQueueForTests();
    vi.useRealTimers();
  });

  async function drainedQueue(): Promise<void> {
    registerDeferredTask({ name: "global", run: vi.fn() });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(getDeferredQueueState().drainState).toBe("drained");
  }

  it("resets a drained queue once the last window has closed", async () => {
    await drainedQueue();

    releaseDeferredQueueOnWindowClosed({ openWindowCount: 0, hostRuntimeActive: false });

    expect(getDeferredQueueState().drainState).toBe("idle");
  });

  it("leaves the queue alone while another window is still open", async () => {
    await drainedQueue();

    releaseDeferredQueueOnWindowClosed({ openWindowCount: 1, hostRuntimeActive: false });

    expect(getDeferredQueueState().drainState).toBe("drained");
  });

  it("leaves the queue to a Host runtime", async () => {
    await drainedQueue();

    releaseDeferredQueueOnWindowClosed({ openWindowCount: 0, hostRuntimeActive: true });

    expect(getDeferredQueueState().drainState).toBe("drained");
  });

  it("keeps the tasks an in-flight drain has left", async () => {
    let release: () => void = () => {};
    const after = vi.fn();
    registerDeferredTask({
      name: "slow",
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    registerDeferredTask({ name: "after", run: after });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(1);
    await vi.advanceTimersByTimeAsync(0);

    releaseDeferredQueueOnWindowClosed({ openWindowCount: 0, hostRuntimeActive: false });
    release();
    await vi.advanceTimersByTimeAsync(10);

    expect(after).toHaveBeenCalledTimes(1);
  });
});
