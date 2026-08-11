import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimeoutSignal, withTimeoutSignal } from "../timeoutSignal.js";

/**
 * Wraps a signal so the number of listeners currently attached to it is
 * observable — the leak these helpers exist to prevent is invisible otherwise.
 */
function trackListeners(signal: AbortSignal): { count: () => number } {
  let live = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => {
    live += 1;
    add(...args);
  }) as typeof add;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    live -= 1;
    remove(...args);
  }) as typeof remove;
  return { count: () => live };
}

describe("createTimeoutSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays un-aborted until the deadline, then aborts with a TimeoutError DOMException", async () => {
    const handle = createTimeoutSignal(100);

    await vi.advanceTimersByTimeAsync(99);
    expect(handle.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBeInstanceOf(DOMException);
    expect((handle.signal.reason as DOMException).name).toBe("TimeoutError");
  });

  it("matches the reason shape AbortSignal.timeout produces", async () => {
    vi.useRealTimers();
    const native = AbortSignal.timeout(1);
    await new Promise((resolve) => native.addEventListener("abort", resolve, { once: true }));

    vi.useFakeTimers();
    const handle = createTimeoutSignal(1);
    await vi.advanceTimersByTimeAsync(2);

    const ours = handle.signal.reason as DOMException;
    const theirs = native.reason as DOMException;
    expect(ours.constructor).toBe(theirs.constructor);
    expect(ours.name).toBe(theirs.name);
  });

  it("releases the timer once the deadline fires", async () => {
    createTimeoutSignal(100);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose() before the deadline clears the timer and prevents the abort", async () => {
    const handle = createTimeoutSignal(100);
    expect(vi.getTimerCount()).toBe(1);

    handle.dispose();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.signal.aborted).toBe(false);
  });

  it("dispose() is idempotent, before and after the signal has aborted", async () => {
    const early = createTimeoutSignal(100);
    early.dispose();
    early.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(early.signal.aborted).toBe(false);

    const expired = createTimeoutSignal(100);
    await vi.advanceTimersByTimeAsync(100);
    const reason = expired.signal.reason;
    expired.dispose();
    expired.dispose();
    expect(expired.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("short-circuits on an already-aborted linked signal without arming a timer", () => {
    const reason = new Error("session ended");
    const handle = createTimeoutSignal(100, null, undefined, AbortSignal.abort(reason));

    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prefers an already-aborted linked signal over a live one", () => {
    const live = new AbortController();
    const reason = new Error("already gone");
    const handle = createTimeoutSignal(100, live.signal, AbortSignal.abort(reason));

    expect(handle.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards an upstream abort with the upstream reason and clears the timer", async () => {
    const upstream = new AbortController();
    const handle = createTimeoutSignal(100, upstream.signal);
    expect(vi.getTimerCount()).toBe(1);

    const reason = new Error("upstream cancelled");
    upstream.abort(reason);

    expect(handle.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.signal.reason).toBe(reason);
  });

  it("stops tracking an upstream signal that aborts after dispose()", () => {
    const upstream = new AbortController();
    const handle = createTimeoutSignal(100, upstream.signal);

    handle.dispose();
    upstream.abort(new Error("too late"));

    expect(handle.signal.aborted).toBe(false);
  });

  it("leaves no listener on a long-lived upstream signal, whichever way it settles", async () => {
    const upstream = new AbortController();
    const tracker = trackListeners(upstream.signal);

    const disposed = createTimeoutSignal(100, upstream.signal);
    expect(tracker.count()).toBe(1);
    disposed.dispose();
    expect(tracker.count()).toBe(0);

    createTimeoutSignal(100, upstream.signal);
    expect(tracker.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(tracker.count()).toBe(0);

    for (let i = 0; i < 50; i++) {
      createTimeoutSignal(100, upstream.signal).dispose();
    }
    expect(tracker.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detaches every linked signal when one of them aborts", () => {
    const first = new AbortController();
    const second = new AbortController();
    const firstTracker = trackListeners(first.signal);
    const secondTracker = trackListeners(second.signal);

    createTimeoutSignal(100, first.signal, second.signal);
    expect(firstTracker.count() + secondTracker.count()).toBe(2);

    second.abort(new Error("second wins"));
    expect(firstTracker.count() + secondTracker.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withTimeoutSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the work's value and disposes the deadline once it settles", async () => {
    let armedDuringWork = 0;
    const result = await withTimeoutSignal(100, async (signal) => {
      armedDuringWork = vi.getTimerCount();
      expect(signal.aborted).toBe(false);
      return "done";
    });

    expect(result).toBe("done");
    expect(armedDuringWork).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes the deadline when the work rejects, and propagates the rejection", async () => {
    const boom = new Error("work failed");
    await expect(withTimeoutSignal(100, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the work's signal at the deadline", async () => {
    const pending = withTimeoutSignal(
      100,
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    const assertion = expect(pending).rejects.toThrow(DOMException);

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands the work an already-aborted signal, and arms no timer, when a linked signal is aborted", async () => {
    const reason = new Error("session ended");
    let seen: AbortSignal | undefined;

    const result = await withTimeoutSignal(
      100,
      async (signal) => {
        seen = signal;
        return "ran anyway";
      },
      AbortSignal.abort(reason)
    );

    expect(result).toBe("ran anyway");
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});
