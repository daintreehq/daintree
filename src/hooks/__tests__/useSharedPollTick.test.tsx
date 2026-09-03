// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { logError } from "@/utils/logger";
import { useSharedPollTick, sharedPollTickerCount } from "../useSharedPollTick";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

describe("useSharedPollTick", () => {
  let visibilityState: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "hidden", {
      get: () => visibilityState === "hidden",
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      get: () => visibilityState,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setVisibility(state: DocumentVisibilityState) {
    visibilityState = state;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  it("fires every subscriber on one interval", () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = renderHook(() => useSharedPollTick(first, 2_000));
    const b = renderHook(() => useSharedPollTick(second, 2_000));

    expect(sharedPollTickerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    a.unmount();
    b.unmount();
  });

  it("keeps subscribers in phase no matter when they mounted", () => {
    const early = vi.fn();
    const a = renderHook(() => useSharedPollTick(early, 2_000));

    // A second pane appears mid-cycle. With a per-caller interval it would run
    // 1200ms out of phase forever; on the shared ticker it lands with the first.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    const late = vi.fn();
    const b = renderHook(() => useSharedPollTick(late, 2_000));

    act(() => {
      vi.advanceTimersByTime(1_200);
    });

    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(early).toHaveBeenCalledTimes(2);
    expect(late).toHaveBeenCalledTimes(2);

    a.unmount();
    b.unmount();
  });

  it("stops polling while the document is hidden", () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useSharedPollTick(callback, 2_000));

    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(callback).not.toHaveBeenCalled();
    unmount();
  });

  it("samples immediately when the document becomes visible again", () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useSharedPollTick(callback, 2_000));

    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(callback).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(callback).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("tears the interval down once the last subscriber unmounts", () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = renderHook(() => useSharedPollTick(first, 2_000));
    const b = renderHook(() => useSharedPollTick(second, 2_000));

    a.unmount();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    // The surviving subscriber still ticks.
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(sharedPollTickerCount()).toBe(1);

    b.unmount();
    expect(sharedPollTickerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe while disabled", () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useSharedPollTick(callback, 2_000, false));

    expect(sharedPollTickerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(callback).not.toHaveBeenCalled();

    unmount();
  });

  it("gives different intervals their own tickers", () => {
    const fast = vi.fn();
    const slow = vi.fn();
    const a = renderHook(() => useSharedPollTick(fast, 1_000));
    const b = renderHook(() => useSharedPollTick(slow, 5_000));

    expect(sharedPollTickerCount()).toBe(2);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(fast).toHaveBeenCalledTimes(1);
    expect(slow).not.toHaveBeenCalled();

    a.unmount();
    b.unmount();
  });

  it("keeps ticking the other subscribers when one throws", () => {
    const thrower = vi.fn(() => {
      throw new Error("subscriber boom");
    });
    const healthy = vi.fn();
    const a = renderHook(() => useSharedPollTick(thrower, 2_000));
    const b = renderHook(() => useSharedPollTick(healthy, 2_000));

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalled();

    a.unmount();
    b.unmount();
  });

  it("does not re-subscribe when the callback identity changes", () => {
    const calls: string[] = [];
    const { rerender, unmount } = renderHook(
      ({ tag }: { tag: string }) =>
        useSharedPollTick(() => {
          calls.push(tag);
        }, 2_000),
      { initialProps: { tag: "a" } }
    );

    // A fresh inline closure every render must not re-phase the shared ticker.
    rerender({ tag: "bb" });
    rerender({ tag: "ccc" });
    expect(sharedPollTickerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    // The newest closure ran, exactly once, and no superseded one did.
    expect(calls).toEqual(["ccc"]);

    unmount();
  });

  it("leaves no interval running when the last subscriber unmounts during a visibility restore", () => {
    // The restore path fires subscribers synchronously and then restarts the
    // interval. A subscriber that tears down the last subscription mid-fire
    // drops the ticker from the map, so an unconditional restart would leave a
    // timer running on a ticker nothing can ever reach or clean up — and the
    // map would look perfectly healthy. Assert on live timers, not the map.
    let unmountSelf: () => void = () => {};
    const callback = vi.fn(() => unmountSelf());
    const view = renderHook(() => useSharedPollTick(callback, 2_000));
    unmountSelf = view.unmount;

    setVisibility("hidden");
    setVisibility("visible");

    expect(callback).toHaveBeenCalledTimes(1);
    expect(sharedPollTickerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not call a subscriber released by an earlier subscriber in the same tick", () => {
    const second = vi.fn();
    let releaseSecond: () => void = () => {};
    const first = vi.fn(() => releaseSecond());

    const a = renderHook(() => useSharedPollTick(first, 2_000));
    const b = renderHook(() => useSharedPollTick(second, 2_000));
    releaseSecond = b.unmount;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(first).toHaveBeenCalledTimes(1);
    // It was in the dispatch snapshot but had been released before its turn.
    expect(second).not.toHaveBeenCalled();

    a.unmount();
  });

  it("starts no interval when mounted while the document is already hidden", () => {
    visibilityState = "hidden";
    const callback = vi.fn();
    const { unmount } = renderHook(() => useSharedPollTick(callback, 2_000));

    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(callback).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins the running phase when a subscriber is enabled late", () => {
    const running = vi.fn();
    const a = renderHook(() => useSharedPollTick(running, 2_000));

    const late = vi.fn();
    const b = renderHook(
      ({ enabled }: { enabled: boolean }) => useSharedPollTick(late, 2_000, enabled),
      { initialProps: { enabled: false } }
    );

    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    b.rerender({ enabled: true });
    expect(sharedPollTickerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    // It adopted the existing phase rather than starting its own timer.
    expect(running).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    a.unmount();
    b.unmount();
  });

  it("keeps the ticker alive when one of several subscribers is disabled", () => {
    const staying = vi.fn();
    const leaving = vi.fn();
    const a = renderHook(() => useSharedPollTick(staying, 2_000));
    const b = renderHook(
      ({ enabled }: { enabled: boolean }) => useSharedPollTick(leaving, 2_000, enabled),
      { initialProps: { enabled: true } }
    );

    b.rerender({ enabled: false });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(staying).toHaveBeenCalledTimes(1);
    expect(leaving).not.toHaveBeenCalled();
    expect(sharedPollTickerCount()).toBe(1);

    a.unmount();
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up fully across repeated mount and unmount cycles", () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const { unmount } = renderHook(() => useSharedPollTick(vi.fn(), 2_000));
      expect(sharedPollTickerCount()).toBe(1);
      unmount();
      expect(sharedPollTickerCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
