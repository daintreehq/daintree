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

import {
  registerDeferredTask,
  finalizeDeferredRegistration,
  signalFirstInteractive,
  getDeferredQueueState,
  resetDeferredQueue,
} from "../deferredInitQueue.js";
import { notifyError } from "../../ipc/errorHandlers.js";
import { trackEvent } from "../../services/TelemetryService.js";

describe("deferredInitQueue", () => {
  beforeEach(() => {
    resetDeferredQueue();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetDeferredQueue();
    vi.useRealTimers();
  });

  // Helper to drain setImmediate-chained tasks: advance timers and flush
  // microtasks until the queue reports "drained".
  async function waitForDrain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (getDeferredQueueState().drainState !== "drained") {
      await vi.advanceTimersByTimeAsync(1);
      if (Date.now() > deadline) throw new Error("drain timeout");
    }
  }

  it("does not drain before first-interactive signal", async () => {
    const task = vi.fn();
    registerDeferredTask({ name: "t1", run: task });
    finalizeDeferredRegistration(10_000);

    // Give setImmediate a chance to run — should NOT drain
    await vi.advanceTimersByTimeAsync(0);
    expect(task).not.toHaveBeenCalled();
    expect(getDeferredQueueState().drainState).toBe("idle");
  });

  it("drains sequentially after first-interactive signal", async () => {
    const order: string[] = [];
    registerDeferredTask({ name: "a", run: () => void order.push("a") });
    registerDeferredTask({
      name: "b",
      run: async () => {
        order.push("b-start");
        await Promise.resolve();
        order.push("b-end");
      },
    });
    registerDeferredTask({ name: "c", run: () => void order.push("c") });

    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(42);

    await waitForDrain();

    expect(order).toEqual(["a", "b-start", "b-end", "c"]);
    expect(getDeferredQueueState().drainState).toBe("drained");
  });

  it("runs queued signal when finalize arrives after signal", async () => {
    const task = vi.fn();
    registerDeferredTask({ name: "early", run: task });

    // Signal arrives before finalize
    signalFirstInteractive(99);
    expect(task).not.toHaveBeenCalled();
    expect(getDeferredQueueState().drainState).toBe("idle");
    expect(getDeferredQueueState().firstInteractiveReceived).toBe(true);

    // Finalize — should trigger drain
    finalizeDeferredRegistration(10_000);
    await waitForDrain();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("fallback timer drains if signal never arrives", async () => {
    const task = vi.fn();
    registerDeferredTask({ name: "fb", run: task });
    finalizeDeferredRegistration(5_000);

    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForDrain();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it("signal after drain is a no-op", async () => {
    const task = vi.fn();
    registerDeferredTask({ name: "once", run: task });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(1);
    await waitForDrain();

    signalFirstInteractive(1); // same sender
    signalFirstInteractive(2); // different sender
    await vi.advanceTimersByTimeAsync(10);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it("isolates task failures — subsequent tasks still run", async () => {
    const ran: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    registerDeferredTask({
      name: "fail-sync",
      run: () => {
        throw new Error("boom");
      },
    });
    registerDeferredTask({
      name: "fail-async",
      run: async () => {
        throw new Error("async-boom");
      },
    });
    registerDeferredTask({ name: "ok", run: () => void ran.push("ok") });

    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(null);
    await waitForDrain();

    expect(ran).toEqual(["ok"]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();

    // Both failures are surfaced through the shared error infrastructure and
    // telemetry — not just swallowed into the console.
    expect(notifyError).toHaveBeenCalledTimes(2);
    for (const [error, options] of vi.mocked(notifyError).mock.calls) {
      expect(error).toBeInstanceOf(Error);
      expect(options).toEqual({ source: "deferred-init" });
    }
    const reportedMessages = vi
      .mocked(notifyError)
      .mock.calls.map(([error]) => (error as Error).message);
    expect(reportedMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fail-sync"),
        expect.stringContaining("fail-async"),
      ])
    );

    expect(trackEvent).toHaveBeenCalledTimes(2);
    expect(trackEvent).toHaveBeenCalledWith("deferred_init_task_failed", { taskName: "fail-sync" });
    expect(trackEvent).toHaveBeenCalledWith("deferred_init_task_failed", {
      taskName: "fail-async",
    });
  });

  it("queue still advances when failure reporting itself throws", async () => {
    const ran: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Simulate a store-write / serialization failure inside notifyError.
    // mockImplementationOnce auto-reverts so it can't leak into later tests.
    vi.mocked(notifyError).mockImplementationOnce(() => {
      throw new Error("reporting backend exploded");
    });

    registerDeferredTask({
      name: "fail-sync",
      run: () => {
        throw new Error("boom");
      },
    });
    registerDeferredTask({ name: "ok", run: () => void ran.push("ok") });

    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(null);
    await waitForDrain();

    // The reporter threw, but failure isolation held: the next task ran and the
    // queue reached "drained" instead of stalling in "draining".
    expect(ran).toEqual(["ok"]);
    expect(getDeferredQueueState().drainState).toBe("drained");
    consoleError.mockRestore();
  });

  it("reports non-Error thrown values without secondary failure", async () => {
    const ran: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    registerDeferredTask({
      name: "throws-string",
      run: () => {
        throw "plain string failure";
      },
    });
    registerDeferredTask({
      name: "throws-null",
      run: () => {
        throw null;
      },
    });
    registerDeferredTask({ name: "ok", run: () => void ran.push("ok") });

    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(null);
    await waitForDrain();

    expect(ran).toEqual(["ok"]);
    expect(getDeferredQueueState().drainState).toBe("drained");
    expect(notifyError).toHaveBeenCalledTimes(2);
    // Each reported error is a real Error with the original value preserved on cause.
    for (const [error] of vi.mocked(notifyError).mock.calls) {
      expect(error).toBeInstanceOf(Error);
    }
    consoleError.mockRestore();
  });

  it("late registration after drain runs immediately", async () => {
    const early = vi.fn();
    registerDeferredTask({ name: "early", run: early });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(1);
    await waitForDrain();

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const late = vi.fn();
    registerDeferredTask({ name: "late", run: late });

    expect(late).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();

    // A successful late task is not reported as a failure.
    expect(notifyError).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("reports late-registration failures through the error infrastructure", async () => {
    const early = vi.fn();
    registerDeferredTask({ name: "early", run: early });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(1);
    await waitForDrain();

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Late sync throw
    registerDeferredTask({
      name: "late-sync",
      run: () => {
        throw new Error("late-boom");
      },
    });

    // Late async rejection
    registerDeferredTask({
      name: "late-async",
      run: async () => {
        throw new Error("late-async-boom");
      },
    });
    await vi.advanceTimersByTimeAsync(1);

    consoleWarn.mockRestore();
    consoleError.mockRestore();

    expect(notifyError).toHaveBeenCalledTimes(2);
    for (const [, options] of vi.mocked(notifyError).mock.calls) {
      expect(options).toEqual({ source: "deferred-init" });
    }
    expect(trackEvent).toHaveBeenCalledWith("deferred_init_task_failed", { taskName: "late-sync" });
    expect(trackEvent).toHaveBeenCalledWith("deferred_init_task_failed", {
      taskName: "late-async",
    });
  });

  it("finalize is idempotent", async () => {
    const task = vi.fn();
    registerDeferredTask({ name: "t", run: task });
    finalizeDeferredRegistration(10_000);
    finalizeDeferredRegistration(10_000); // second call ignored

    signalFirstInteractive(1);
    await waitForDrain();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it("resetDeferredQueue clears state for a fresh cycle", async () => {
    const t1 = vi.fn();
    registerDeferredTask({ name: "t1", run: t1 });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(1);
    await waitForDrain();

    resetDeferredQueue();
    const s = getDeferredQueueState();
    expect(s.drainState).toBe("idle");
    expect(s.registrationComplete).toBe(false);
    expect(s.firstInteractiveReceived).toBe(false);
    expect(s.taskCount).toBe(0);

    const t2 = vi.fn();
    registerDeferredTask({ name: "t2", run: t2 });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(1);
    await waitForDrain();

    expect(t1).toHaveBeenCalledTimes(1);
    expect(t2).toHaveBeenCalledTimes(1);
  });

  it("reset during in-flight drain does not corrupt the fresh cycle", async () => {
    // Task that never settles — holds the drain chain open indefinitely.
    let releaseFirst: () => void = () => {};
    const firstRun = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        })
    );
    const secondRun = vi.fn();

    registerDeferredTask({ name: "hang", run: firstRun });
    registerDeferredTask({ name: "never", run: secondRun });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(1);

    // Let the first task start but not finish
    await vi.advanceTimersByTimeAsync(0);
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(getDeferredQueueState().drainState).toBe("draining");

    // Simulate last-window-close
    resetDeferredQueue();
    expect(getDeferredQueueState().drainState).toBe("idle");

    // Register a fresh task for the next cycle
    const freshTask = vi.fn();
    registerDeferredTask({ name: "fresh", run: freshTask });
    finalizeDeferredRegistration(10_000);
    signalFirstInteractive(99);
    await waitForDrain();
    expect(freshTask).toHaveBeenCalledTimes(1);

    // Now release the stale promise from the previous cycle. The stale
    // scheduleNext callback must NOT corrupt the fresh cycle's state.
    releaseFirst();
    await vi.advanceTimersByTimeAsync(100);

    // secondRun from the old cycle must never run
    expect(secondRun).not.toHaveBeenCalled();
    // Fresh cycle stays drained
    expect(getDeferredQueueState().drainState).toBe("drained");
  });

  it("does not drain if finalize is never called, even after signal", async () => {
    const task = vi.fn();
    registerDeferredTask({ name: "orphan", run: task });

    // Signal arrives (renderer painted) but finalize never happens
    signalFirstInteractive(42);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(task).not.toHaveBeenCalled();
    expect(getDeferredQueueState().drainState).toBe("idle");
    expect(getDeferredQueueState().firstInteractiveReceived).toBe(true);
  });
});
