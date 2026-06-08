import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, timeoutSignal, withTimeout } from "../withTimeout.js";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the value when the promise settles before the deadline", async () => {
    const result = withTimeout(Promise.resolve("ok"), 1000, "too slow");
    await expect(result).resolves.toBe("ok");
  });

  it("rejects with TimeoutError when the promise outlives the deadline", async () => {
    const never = new Promise<string>(() => {});
    const result = withTimeout(never, 50, "watchdog tripped");
    const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it("carries the supplied message on the TimeoutError", async () => {
    const never = new Promise<string>(() => {});
    const result = withTimeout(never, 10, "specific message");
    const assertion = expect(result).rejects.toThrow("specific message");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it("propagates the underlying rejection unchanged", async () => {
    const boom = new Error("underlying failure");
    await expect(withTimeout(Promise.reject(boom), 1000, "unused")).rejects.toBe(boom);
  });

  it("does not leave a timer armed after a fast resolve", async () => {
    await withTimeout(Promise.resolve(1), 1000, "unused");
    // If the timer were still armed, an unhandled rejection would fire here.
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("timeoutSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts un-aborted and aborts after the deadline with a TimeoutError reason", async () => {
    const { signal, dispose } = timeoutSignal(100);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(120);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(TimeoutError);
    dispose();
  });

  it("dispose() clears the timer so the signal never aborts", async () => {
    const { signal, dispose } = timeoutSignal(100);
    dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts immediately when the parent is already aborted", () => {
    const parent = AbortSignal.abort(new Error("parent gone"));
    const { signal, dispose } = timeoutSignal(100, parent);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("parent gone");
    dispose();
  });

  it("aborts when the parent aborts before the deadline", () => {
    const controller = new AbortController();
    const { signal, dispose } = timeoutSignal(100, controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort(new Error("parent cancelled"));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("parent cancelled");
    dispose();
  });

  it("dispose detaches the parent listener so a later parent abort doesn't propagate", () => {
    const controller = new AbortController();
    const { signal, dispose } = timeoutSignal(100, controller.signal);
    dispose();
    controller.abort(new Error("parent aborted after dispose"));
    // The listener was removed on dispose, so our signal must stay un-aborted.
    expect(signal.aborted).toBe(false);
  });
});
