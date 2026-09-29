// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { shallowEqual, useHostStore, usePluginEventSelector } from "../react/useHostStore.js";

afterEach(() => vi.unstubAllGlobals());

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => state,
    set(next: T) {
      state = next;
      for (const l of listeners) l();
    },
    listeners,
  };
}

function stubBridge() {
  const subs = new Map<string, (payload: unknown) => void>();
  const bridge = {
    invoke: vi.fn(),
    on: vi.fn((pluginId: string, channel: string, cb: (p: unknown) => void) => {
      subs.set(`${pluginId}:${channel}`, cb);
      return () => subs.delete(`${pluginId}:${channel}`);
    }),
    onPanel: vi.fn(
      (pluginId: string, channel: string, panelId: string, cb: (p: unknown) => void) => {
        subs.set(`${pluginId}:${channel}:${panelId}`, cb);
        return () => subs.delete(`${pluginId}:${channel}:${panelId}`);
      }
    ),
  };
  vi.stubGlobal("electron", { plugin: bridge });
  return {
    bridge,
    subs,
    push: (key: string, payload: unknown) => act(() => subs.get(key)?.(payload)),
  };
}

describe("shallowEqual", () => {
  it("compares one level deep", () => {
    expect(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual([1], { 0: 1 })).toBe(false);
    expect(shallowEqual({ a: {} }, { a: {} })).toBe(false);
    expect(shallowEqual(null, null)).toBe(true);
  });
});

describe("useHostStore", () => {
  it("re-renders only when the selected slice changes", () => {
    const store = createStore({ count: 0, noise: 0 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useHostStore(store.subscribe, store.getSnapshot, (s) => s.count);
    });
    expect(result.current).toBe(0);
    const base = renders;

    act(() => store.set({ count: 0, noise: 1 }));
    act(() => store.set({ count: 0, noise: 2 }));
    expect(renders).toBe(base);

    act(() => store.set({ count: 5, noise: 2 }));
    expect(result.current).toBe(5);
    expect(renders).toBe(base + 1);
  });

  it("keeps the previous reference for an equal fresh object, across re-renders too", () => {
    const store = createStore({ a: 1, b: 2, c: 3 });
    let renders = 0;
    const { result, rerender } = renderHook(() => {
      renders++;
      return useHostStore(
        store.subscribe,
        store.getSnapshot,
        (s) => ({ a: s.a, b: s.b }),
        shallowEqual
      );
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    const base = renders;
    act(() => store.set({ a: 1, b: 2, c: 99 }));
    expect(renders).toBe(base);
    expect(result.current).toBe(first);

    act(() => store.set({ a: 2, b: 2, c: 99 }));
    expect(result.current).toEqual({ a: 2, b: 2 });
  });

  it("unsubscribes on unmount", () => {
    const store = createStore(1);
    const { unmount } = renderHook(() =>
      useHostStore(store.subscribe, store.getSnapshot, (s) => s)
    );
    expect(store.listeners.size).toBe(1);
    unmount();
    expect(store.listeners.size).toBe(0);
  });

  it("re-selects when isEqual becomes stricter", () => {
    const store = createStore({ a: 1, b: 1 });
    const loose = (_x: { a: number }, _y: { a: number }) => true;
    const { result, rerender } = renderHook(
      ({ isEqual }: { isEqual: (x: { a: number }, y: { a: number }) => boolean }) =>
        useHostStore(store.subscribe, store.getSnapshot, (s) => ({ a: s.a }), isEqual),
      { initialProps: { isEqual: loose } }
    );
    act(() => store.set({ a: 2, b: 1 }));
    expect(result.current).toEqual({ a: 1 });
    rerender({ isEqual: shallowEqual });
    expect(result.current).toEqual({ a: 2 });
  });
});

describe("usePluginEventSelector", () => {
  it("selects from `initial` until a push arrives, then re-renders only on slice changes", () => {
    const { push } = stubBridge();
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return usePluginEventSelector(
        "acme",
        "status",
        (s: { items: string[]; tick: number }) => s.items.length,
        { initial: { items: [], tick: 0 } }
      );
    });
    expect(result.current).toBe(0);
    const base = renders;

    push("acme:status", { items: ["a"], tick: 1 });
    expect(result.current).toBe(1);
    push("acme:status", { items: ["b"], tick: 2 });
    push("acme:status", { items: ["c"], tick: 3 });
    expect(renders).toBe(base + 1);
  });

  it("does not resubscribe when `initial` is an inline literal", () => {
    const { bridge } = stubBridge();
    const { rerender } = renderHook(() =>
      usePluginEventSelector("acme", "status", (s: { n: number }) => s.n, { initial: { n: 0 } })
    );
    rerender();
    rerender();
    expect(bridge.on).toHaveBeenCalledTimes(1);
  });

  it("scopes to a panel and resets to `initial` when the target changes", () => {
    const { bridge, subs, push } = stubBridge();
    const { result, rerender } = renderHook(
      ({ panelId }) =>
        usePluginEventSelector("acme", "status", (s: number) => s, { initial: -1, panelId }),
      { initialProps: { panelId: "p1" } }
    );
    push("acme:status:p1", 7);
    expect(result.current).toBe(7);

    rerender({ panelId: "p2" });
    expect(result.current).toBe(-1);
    expect(bridge.onPanel).toHaveBeenLastCalledWith("acme", "status", "p2", expect.any(Function));
    expect(subs.has("acme:status:p1")).toBe(false);
  });
});
