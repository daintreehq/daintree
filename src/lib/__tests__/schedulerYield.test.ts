import { afterEach, describe, expect, it, vi } from "vitest";
import { yieldToScheduler } from "../schedulerYield";

describe("yieldToScheduler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("prefers scheduler.yield() when the API exposes it", async () => {
    const yieldFn = vi.fn(() => Promise.resolve());
    const postTask = vi.fn(() => Promise.resolve());
    vi.stubGlobal("scheduler", { yield: yieldFn, postTask });

    await yieldToScheduler();

    // scheduler.yield()'s continuation resumes ahead of newly-queued tasks —
    // it is the preferred path when available.
    expect(yieldFn).toHaveBeenCalledTimes(1);
    expect(postTask).not.toHaveBeenCalled();
  });

  it("falls back to scheduler.postTask at user-visible priority when yield is absent", async () => {
    const postTask = vi.fn(() => Promise.resolve());
    vi.stubGlobal("scheduler", { postTask });

    await yieldToScheduler();

    // A survivor reflow is directly observable UI work, so the postTask
    // fallback must not be backgrounded.
    expect(postTask).toHaveBeenCalledTimes(1);
    expect(postTask).toHaveBeenCalledWith(expect.any(Function), { priority: "user-visible" });
  });

  it("falls back to a macrotask when the scheduler API is unavailable", async () => {
    vi.stubGlobal("scheduler", undefined);
    vi.useFakeTimers();

    let resolved = false;
    const pending = yieldToScheduler().then(() => {
      resolved = true;
    });

    // The fallback is a real macrotask — still pending until the timer fires.
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(resolved).toBe(true);
  });
});
