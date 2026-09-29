// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  HOST_CHANNEL_CACHE_LIMIT,
  resetHostChannelCacheForTests,
  useCachedHostChannel,
} from "../react/useCachedHostChannel.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetHostChannelCacheForTests();
  invoke = vi.fn();
  vi.stubGlobal("electron", { plugin: { invoke, on: vi.fn(), onPanel: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

describe("useCachedHostChannel", () => {
  it("fetches on first mount, then paints the cached value first on the next mount and revalidates", async () => {
    invoke.mockResolvedValueOnce(["a"]);
    const first = renderHook(() => useCachedHostChannel("acme", "list", { repo: "x" }));
    expect(first.result.current.data).toBeUndefined();
    await waitFor(() => expect(first.result.current.data).toEqual(["a"]));
    first.unmount();

    const next = deferred<string[]>();
    invoke.mockReturnValueOnce(next.promise);
    const second = renderHook(() => useCachedHostChannel("acme", "list", { repo: "x" }));
    expect(second.result.current.data).toEqual(["a"]);
    await waitFor(() => expect(second.result.current.validating).toBe(true));

    await act(async () => next.resolve(["a", "b"]));
    expect(second.result.current.data).toEqual(["a", "b"]);
    expect(second.result.current.validating).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("acme", "list", { repo: "x" });
  });

  it("skips revalidation while the entry is fresh", async () => {
    invoke.mockResolvedValue(1);
    const a = renderHook(() => useCachedHostChannel("acme", "n", null, { staleMs: 60_000 }));
    await waitFor(() => expect(a.result.current.data).toBe(1));
    a.unmount();
    renderHook(() => useCachedHostChannel("acme", "n", null, { staleMs: 60_000 }));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent mounts and treats key order in args as equal", async () => {
    const d = deferred<number>();
    invoke.mockReturnValue(d.promise);
    const a = renderHook(() => useCachedHostChannel("acme", "q", { a: 1, b: 2 }));
    const b = renderHook(() => useCachedHostChannel("acme", "q", { b: 2, a: 1 }));
    await act(async () => d.resolve(3));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(a.result.current.data).toBe(3);
    expect(b.result.current.data).toBe(3);
  });

  it("does not refetch when args are a fresh but equal object each render", async () => {
    invoke.mockResolvedValue("ok");
    const { rerender } = renderHook(() => useCachedHostChannel("acme", "q", { id: 1 }));
    rerender();
    rerender();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good data alongside an error", async () => {
    invoke.mockResolvedValueOnce("good").mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useCachedHostChannel("acme", "q", 1));
    await waitFor(() => expect(result.current.data).toBe("good"));
    await act(async () => {
      expect(await result.current.revalidate()).toBeUndefined();
    });
    expect(result.current.data).toBe("good");
    expect(result.current.error?.message).toBe("boom");
  });

  it("lets a revalidate supersede an older in-flight request", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    invoke.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const { result } = renderHook(() => useCachedHostChannel("acme", "q", 1));
    let revalidated: Promise<string | undefined> | undefined;
    act(() => {
      revalidated = result.current.revalidate() as Promise<string | undefined>;
    });
    await act(async () => fast.resolve("new"));
    await act(async () => slow.resolve("old"));
    expect(await revalidated).toBe("new");
    expect(result.current.data).toBe("new");
  });

  it("starts nothing once the signal has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = renderHook(() =>
      useCachedHostChannel("acme", "q", 1, { signal: controller.signal })
    );
    await act(async () => {
      expect(await result.current.revalidate()).toBeUndefined();
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("surfaces a missing bridge as an error rather than throwing from render", async () => {
    vi.unstubAllGlobals();
    const { result } = renderHook(() => useCachedHostChannel("acme", "q", 1));
    await waitFor(() => expect(result.current.error?.message).toMatch(/unavailable/));
  });

  it("requires a cacheKey for args it cannot serialise", () => {
    expect(() => renderHook(() => useCachedHostChannel("acme", "q", { n: 1n }))).toThrow(
      /cacheKey/
    );
    invoke.mockResolvedValue(0);
    expect(() =>
      renderHook(() => useCachedHostChannel("acme", "q", { n: 1n }, { cacheKey: "one" }))
    ).not.toThrow();
  });

  it("bounds the cache, evicting unused entries before ones a view is showing", async () => {
    invoke.mockImplementation(async (_p: string, _c: string, n: number) => n);
    const pinned = renderHook(() => useCachedHostChannel("acme", "q", -1));
    await waitFor(() => expect(pinned.result.current.data).toBe(-1));

    for (let i = 0; i < HOST_CHANNEL_CACHE_LIMIT + 10; i++) {
      const h = renderHook(() => useCachedHostChannel("acme", "q", i));
      await waitFor(() => expect(h.result.current.data).toBe(i));
      h.unmount();
    }
    expect(pinned.result.current.data).toBe(-1);

    invoke.mockClear();
    const oldest = renderHook(() => useCachedHostChannel("acme", "q", 0));
    expect(oldest.result.current.data).toBeUndefined();
    const newest = renderHook(() =>
      useCachedHostChannel("acme", "q", HOST_CHANNEL_CACHE_LIMIT + 9)
    );
    expect(newest.result.current.data).toBe(HOST_CHANNEL_CACHE_LIMIT + 9);
    await act(async () => {});
  });

  it("keys args the host would tell apart separately", async () => {
    invoke.mockResolvedValue(0);
    const argsList: unknown[] = [
      {},
      { a: undefined },
      { a: null },
      { a: NaN },
      { a: 0 },
      { a: -0 },
      { a: "0" },
    ];
    for (const args of argsList) renderHook(() => useCachedHostChannel("acme", "k", args));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(argsList.length);
  });

  it("never evicts an entry a mounted view is showing, even past the limit", async () => {
    invoke.mockImplementation(async (_p: string, _c: string, n: number) => n);
    const views = [];
    for (let i = 0; i < HOST_CHANNEL_CACHE_LIMIT + 5; i++) {
      views.push(renderHook(() => useCachedHostChannel("acme", "live", i)));
    }
    await act(async () => {});
    invoke.mockClear();
    const again = renderHook(() => useCachedHostChannel("acme", "live", 0, { staleMs: 60_000 }));
    expect(again.result.current.data).toBe(0);
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("useCachedHostChannel invalidateOn", () => {
  let subs: Map<string, Set<(p: unknown) => void>>;
  const push = (channel: string) => {
    for (const cb of [...(subs.get(channel) ?? [])]) cb(null);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    subs = new Map();
    const on = vi.fn((_p: string, channel: string, cb: (p: unknown) => void) => {
      let set = subs.get(channel);
      if (!set) subs.set(channel, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    });
    vi.stubGlobal("electron", { plugin: { invoke, on, onPanel: vi.fn() } });
  });
  afterEach(() => vi.useRealTimers());

  it("refetches once per burst of invalidations", async () => {
    let n = 0;
    invoke.mockImplementation(async () => ++n);
    const { result } = renderHook(() =>
      useCachedHostChannel("acme", "list-notes", null, { invalidateOn: "notes-changed" })
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current.data).toBe(1);

    for (let i = 0; i < 200; i++) {
      push("notes-changed");
      await act(async () => void (await vi.advanceTimersByTimeAsync(5)));
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe(2);
  });

  it("queues one refetch behind a request in flight instead of superseding it", async () => {
    const first = deferred<number>();
    invoke.mockResolvedValueOnce(0).mockReturnValueOnce(first.promise).mockResolvedValue(2);
    const { result } = renderHook(() =>
      useCachedHostChannel("acme", "q", null, { invalidateOn: "q-changed", debounceMs: 10 })
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    push("q-changed");
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(invoke).toHaveBeenCalledTimes(2);
    push("q-changed");
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    push("q-changed");
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve(1));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.current.data).toBe(2);
  });

  it("drops a scheduled refetch when the only view's signal aborts first", async () => {
    invoke.mockResolvedValue(1);
    const controller = new AbortController();
    renderHook(() =>
      useCachedHostChannel("acme", "s", null, {
        invalidateOn: "s-changed",
        signal: controller.signal,
      })
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    push("s-changed");
    controller.abort();
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not refetch twice when a push re-arms the timer behind a queued refetch", async () => {
    const first = deferred<number>();
    invoke.mockResolvedValueOnce(0).mockReturnValueOnce(first.promise).mockResolvedValue(2);
    renderHook(() =>
      useCachedHostChannel("acme", "d", null, { invalidateOn: "d-changed", debounceMs: 10 })
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    push("d-changed");
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    push("d-changed");
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    push("d-changed");
    await act(async () => first.resolve(1));
    await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("shares one refetch between views on the same key, and unsubscribes on unmount", async () => {
    invoke.mockResolvedValue("x");
    const opts = { invalidateOn: "k-changed" };
    const a = renderHook(() => useCachedHostChannel("acme", "k", 1, opts));
    const b = renderHook(() => useCachedHostChannel("acme", "k", 1, opts));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(invoke).toHaveBeenCalledTimes(1);
    push("k-changed");
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    expect(invoke).toHaveBeenCalledTimes(2);

    a.unmount();
    b.unmount();
    expect(subs.get("k-changed")?.size ?? 0).toBe(0);
    push("k-changed");
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
