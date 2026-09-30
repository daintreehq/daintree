// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNow } from "../react/useNow.js";

let cached = false;
const cachedListeners = new Set<() => void>();
const activeListeners = new Set<() => void>();
let hidden = false;

function setHidden(next: boolean): void {
  hidden = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function setCached(next: boolean): void {
  cached = next;
  for (const cb of [...(next ? cachedListeners : activeListeners)]) cb();
}

// 12:00:20.000 UTC: 40 s short of a minute boundary.
const START = Date.UTC(2026, 8, 30, 12, 0, 20);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(START);
  cached = false;
  hidden = false;
  cachedListeners.clear();
  activeListeners.clear();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("electron", {
    plugin: { invoke: vi.fn(), on: vi.fn(), onPanel: vi.fn() },
    app: {
      isViewCached: () => cached,
      onViewCached: (cb: () => void) => {
        cachedListeners.add(cb);
        return () => cachedListeners.delete(cb);
      },
      onViewWarmActivated: (cb: () => void) => {
        activeListeners.add(cb);
        return () => activeListeners.delete(cb);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useNow", () => {
  it("returns the current time and ticks on the minute boundary", () => {
    const renders = vi.fn();
    const { result, unmount } = renderHook(() => {
      renders();
      return useNow();
    });
    expect(result.current).toBe(START);
    const before = renders.mock.calls.length;

    advance(39_999);
    expect(result.current).toBe(START);
    advance(1);
    expect(result.current).toBe(START + 40_000);
    expect(result.current % 60_000).toBe(0);
    expect(renders.mock.calls.length).toBe(before + 1);

    advance(60_000);
    expect(result.current).toBe(START + 100_000);
    unmount();
  });

  it("ticks intervalMs after mount when align is false", () => {
    const { result, unmount } = renderHook(() => useNow({ intervalMs: 5000, align: false }));
    advance(4999);
    expect(result.current).toBe(START);
    advance(1);
    expect(result.current).toBe(START + 5000);
    unmount();
  });

  it("shares one timer across every subscriber of the same interval, and stops with the last", () => {
    const a = renderHook(() => useNow());
    const b = renderHook(() => useNow());
    const c = renderHook(() => useNow({ intervalMs: 60_000 }));
    expect(vi.getTimerCount()).toBe(1);

    const other = renderHook(() => useNow({ intervalMs: 1000 }));
    expect(vi.getTimerCount()).toBe(2);

    advance(40_000);
    expect(a.result.current).toBe(b.result.current);
    expect(b.result.current).toBe(c.result.current);

    other.unmount();
    expect(vi.getTimerCount()).toBe(1);
    a.unmount();
    b.unmount();
    expect(vi.getTimerCount()).toBe(1);
    c.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps intervals below a second", () => {
    const { result, unmount } = renderHook(() => useNow({ intervalMs: 0, align: false }));
    advance(999);
    expect(result.current).toBe(START);
    advance(1);
    expect(result.current).toBe(START + 1000);
    unmount();
  });

  it("pauses while the document is hidden and catches up at once when it is shown", () => {
    const { result, unmount } = renderHook(() => useNow());
    act(() => setHidden(true));
    expect(vi.getTimerCount()).toBe(0);
    advance(180_000);
    expect(result.current).toBe(START);

    act(() => setHidden(false));
    expect(result.current).toBe(START + 180_000);
    expect(vi.getTimerCount()).toBe(1);
    // Realigned: the next tick lands on the next whole minute.
    advance(40_000);
    expect(result.current % 60_000).toBe(0);
    unmount();
  });

  it("pauses while the project view is cached, including when it mounts cached", () => {
    cached = true;
    const { result, unmount } = renderHook(() => useNow());
    expect(vi.getTimerCount()).toBe(0);
    advance(120_000);
    expect(result.current).toBe(START);

    act(() => setCached(false));
    expect(result.current).toBe(START + 120_000);
    act(() => setCached(true));
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("reads the same value on every call between ticks, even across a boundary", () => {
    const { result, unmount } = renderHook(() => useNow());
    vi.setSystemTime(START + 50_000);
    // No timer has run: the value stays put until the tick notifies.
    expect(result.current).toBe(START);
    unmount();
  });

  it("a subscriber mounting after an idle spell reads the current time, not the last tick", () => {
    const first = renderHook(() => useNow());
    first.unmount();
    vi.setSystemTime(START + 600_000);
    const second = renderHook(() => useNow());
    expect(second.result.current).toBe(START + 600_000);
    second.unmount();
  });
});
