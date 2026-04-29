// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSlowCall } from "../useSlowCall";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSlowCall", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false flags before run() is called", () => {
    const fn = vi.fn(async () => "value");
    const { result } = renderHook(() => useSlowCall(fn));
    expect(result.current.isPending).toBe(false);
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isVerySlow).toBe(false);
  });

  it("flips isPending to true while the call is in flight", async () => {
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn));

    let runPromise: Promise<string | undefined>;
    act(() => {
      runPromise = result.current.run();
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));

    deferred.resolve("ok");
    await act(async () => {
      await runPromise;
    });
    expect(result.current.isPending).toBe(false);
  });

  it("does not flip isSlow before slowMs elapses", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn, { slowMs: 3000, verySlowMs: 10000 }));

    act(() => {
      void result.current.run();
    });

    await act(async () => {
      vi.advanceTimersByTime(2999);
    });
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isVerySlow).toBe(false);
  });

  it("flips isSlow to true after slowMs", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn, { slowMs: 3000, verySlowMs: 10000 }));

    act(() => {
      void result.current.run();
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.isSlow).toBe(true);
    expect(result.current.isVerySlow).toBe(false);
  });

  it("flips isVerySlow to true after verySlowMs", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn, { slowMs: 3000, verySlowMs: 10000 }));

    act(() => {
      void result.current.run();
    });

    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(result.current.isSlow).toBe(true);
    expect(result.current.isVerySlow).toBe(true);
  });

  it("resets all flags after a fast resolve", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn));

    let runPromise: Promise<string | undefined>;
    act(() => {
      runPromise = result.current.run();
    });

    deferred.resolve("ok");
    await act(async () => {
      await runPromise;
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isVerySlow).toBe(false);
  });

  it("resets all flags after a slow resolve", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn, { slowMs: 3000, verySlowMs: 10000 }));

    let runPromise: Promise<string | undefined>;
    act(() => {
      runPromise = result.current.run();
    });

    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.isSlow).toBe(true);

    deferred.resolve("ok");
    await act(async () => {
      await runPromise;
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isVerySlow).toBe(false);
  });

  it("propagates rejection and resets flags", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn));

    let runPromise: Promise<string | undefined>;
    act(() => {
      runPromise = result.current.run();
    });

    deferred.reject(new Error("boom"));
    await act(async () => {
      await expect(runPromise).rejects.toThrow("boom");
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isVerySlow).toBe(false);
  });

  it("cancel() aborts the signal and resets flags", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | null = null;
    const deferred = createDeferred<string>();
    const fn = vi.fn(async (signal: AbortSignal) => {
      capturedSignal = signal;
      return deferred.promise;
    });

    const { result } = renderHook(() => useSlowCall(fn, { slowMs: 3000, verySlowMs: 10000 }));

    act(() => {
      void result.current.run();
    });

    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.isSlow).toBe(true);

    act(() => {
      result.current.cancel();
    });

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(true);
    expect(result.current.isPending).toBe(false);
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isVerySlow).toBe(false);
  });

  it("calling cancel() before run() is a no-op", () => {
    const fn = vi.fn(async () => "value");
    const { result } = renderHook(() => useSlowCall(fn));

    act(() => {
      result.current.cancel();
    });

    expect(result.current.isPending).toBe(false);
  });

  it("calling cancel() twice is harmless", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn));

    act(() => {
      void result.current.run();
    });

    act(() => {
      result.current.cancel();
    });
    act(() => {
      result.current.cancel();
    });

    expect(result.current.isPending).toBe(false);
  });

  it("starting a new run while one is pending aborts the previous", async () => {
    vi.useFakeTimers();
    const deferredA = createDeferred<string>();
    const deferredB = createDeferred<string>();
    const calls: AbortSignal[] = [];
    let invocation = 0;
    const fn = vi.fn(async (signal: AbortSignal) => {
      calls.push(signal);
      invocation += 1;
      return invocation === 1 ? deferredA.promise : deferredB.promise;
    });

    const { result } = renderHook(() => useSlowCall(fn, { slowMs: 3000, verySlowMs: 10000 }));

    act(() => {
      void result.current.run();
    });
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.isSlow).toBe(true);

    act(() => {
      void result.current.run();
    });

    expect(calls[0]?.aborted).toBe(true);
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isPending).toBe(true);

    deferredA.resolve("late");
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isPending).toBe(true);
    expect(result.current.isSlow).toBe(false);
  });

  it("does not flip flags after unmount", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result, unmount } = renderHook(() =>
      useSlowCall(fn, { slowMs: 3000, verySlowMs: 10000 })
    );

    act(() => {
      void result.current.run();
    });

    unmount();

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(15000);
      });
    }).not.toThrow();
  });

  it("aborts the signal on unmount", async () => {
    let capturedSignal: AbortSignal | null = null;
    const deferred = createDeferred<string>();
    const fn = vi.fn(async (signal: AbortSignal) => {
      capturedSignal = signal;
      return deferred.promise;
    });

    const { result, unmount } = renderHook(() => useSlowCall(fn));

    act(() => {
      void result.current.run();
    });

    unmount();

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("handles synchronous throw from fn", async () => {
    const fn = vi.fn(async (_signal: AbortSignal): Promise<string> => {
      throw new Error("sync boom");
    });
    const { result } = renderHook(() => useSlowCall(fn));

    await act(async () => {
      await expect(result.current.run()).rejects.toThrow("sync boom");
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isVerySlow).toBe(false);
  });

  it("flips isSlow and isVerySlow independently when verySlowMs < slowMs", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn, { slowMs: 5000, verySlowMs: 1000 }));

    act(() => {
      void result.current.run();
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.isSlow).toBe(false);
    expect(result.current.isVerySlow).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.isSlow).toBe(true);
    expect(result.current.isVerySlow).toBe(true);
  });

  it("uses default thresholds (3000/10000) when options are omitted", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn));

    act(() => {
      void result.current.run();
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.isSlow).toBe(true);
    expect(result.current.isVerySlow).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    expect(result.current.isVerySlow).toBe(true);
  });

  it("passes a fresh AbortSignal to fn on each run", async () => {
    const deferred1 = createDeferred<string>();
    const deferred2 = createDeferred<string>();
    const signals: AbortSignal[] = [];
    let count = 0;
    const fn = vi.fn(async (signal: AbortSignal) => {
      signals.push(signal);
      count += 1;
      return count === 1 ? deferred1.promise : deferred2.promise;
    });

    const { result } = renderHook(() => useSlowCall(fn));

    act(() => {
      void result.current.run();
    });

    deferred1.resolve("first");
    await act(async () => {
      await Promise.resolve();
    });

    let secondPromise: Promise<string | undefined>;
    act(() => {
      secondPromise = result.current.run();
    });
    deferred2.resolve("second");
    await act(async () => {
      await secondPromise;
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBeDefined();
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("uses the latest fn and thresholds even when run() reference is stable", async () => {
    vi.useFakeTimers();
    const deferredA = createDeferred<string>();
    const deferredB = createDeferred<string>();
    const fnA = vi.fn(async () => deferredA.promise);
    const fnB = vi.fn(async () => deferredB.promise);

    type Props = { fn: typeof fnA; slowMs: number; verySlowMs: number };
    const { result, rerender } = renderHook(
      ({ fn, slowMs, verySlowMs }: Props) => useSlowCall(fn, { slowMs, verySlowMs }),
      { initialProps: { fn: fnA, slowMs: 3000, verySlowMs: 10000 } }
    );

    const stableRun = result.current.run;
    await act(async () => {
      rerender({ fn: fnB, slowMs: 500, verySlowMs: 1500 });
    });

    let runPromise: Promise<string | undefined>;
    act(() => {
      runPromise = stableRun();
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.isSlow).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.isVerySlow).toBe(true);

    deferredB.resolve("B");
    await act(async () => {
      const value = await runPromise;
      expect(value).toBe("B");
    });

    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and swallows AbortError when cancel() races a rejection", async () => {
    const deferred = createDeferred<string>();
    const fn = vi.fn(async (signal: AbortSignal) => {
      return new Promise<string>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("AbortError")));
        deferred.promise.then(resolve, reject);
      });
    });
    const { result } = renderHook(() => useSlowCall(fn));

    let runPromise: Promise<string | undefined>;
    act(() => {
      runPromise = result.current.run();
    });

    act(() => {
      result.current.cancel();
    });

    await act(async () => {
      const value = await runPromise;
      expect(value).toBeUndefined();
    });

    expect(result.current.isPending).toBe(false);
  });

  it("returns undefined when superseded by a newer run()", async () => {
    const deferred1 = createDeferred<string>();
    const deferred2 = createDeferred<string>();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? deferred1.promise : deferred2.promise;
    });

    const { result } = renderHook(() => useSlowCall(fn));

    let firstPromise: Promise<string | undefined>;
    act(() => {
      firstPromise = result.current.run();
    });

    let secondPromise: Promise<string | undefined>;
    act(() => {
      secondPromise = result.current.run();
    });

    deferred1.resolve("late-A");
    deferred2.resolve("B");

    await act(async () => {
      const firstValue = await firstPromise;
      expect(firstValue).toBeUndefined();
      const secondValue = await secondPromise;
      expect(secondValue).toBe("B");
    });
  });

  it("clears all timers after a fast resolve", async () => {
    vi.useFakeTimers();
    const initial = vi.getTimerCount();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn));

    let runPromise: Promise<string | undefined>;
    act(() => {
      runPromise = result.current.run();
    });

    expect(vi.getTimerCount()).toBe(initial + 2);

    deferred.resolve("ok");
    await act(async () => {
      await runPromise;
    });

    expect(vi.getTimerCount()).toBe(initial);
  });

  it("clears all timers after cancel()", async () => {
    vi.useFakeTimers();
    const initial = vi.getTimerCount();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result } = renderHook(() => useSlowCall(fn));

    act(() => {
      void result.current.run();
    });
    expect(vi.getTimerCount()).toBe(initial + 2);

    act(() => {
      result.current.cancel();
    });
    expect(vi.getTimerCount()).toBe(initial);
  });

  it("clears all timers on unmount", () => {
    vi.useFakeTimers();
    const initial = vi.getTimerCount();
    const deferred = createDeferred<string>();
    const fn = vi.fn(async () => deferred.promise);
    const { result, unmount } = renderHook(() => useSlowCall(fn));

    act(() => {
      void result.current.run();
    });
    expect(vi.getTimerCount()).toBe(initial + 2);

    unmount();
    expect(vi.getTimerCount()).toBe(initial);
  });
});
