// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePluginEvent, usePluginPanelEvent } from "../usePluginEvent";
import { useHostChannel } from "../useHostChannel";

type Subscriber = (payload: unknown) => void;

let subscribers: Map<string, Set<Subscriber>>;
let removeCalls: number;
let invokeMock: ReturnType<typeof vi.fn>;

function channelKey(pluginId: string, channel: string): string {
  return `${pluginId}:${channel}`;
}

function panelKey(pluginId: string, channel: string, panelId: string): string {
  return `${pluginId}:${channel}:${panelId}`;
}

beforeEach(() => {
  subscribers = new Map();
  removeCalls = 0;
  invokeMock = vi.fn();

  const subscribe = (key: string, cb: Subscriber): (() => void) => {
    const set = subscribers.get(key) ?? new Set<Subscriber>();
    set.add(cb);
    subscribers.set(key, set);
    return () => {
      removeCalls += 1;
      set.delete(cb);
    };
  };

  const plugin = {
    invoke: invokeMock,
    on: (pluginId: string, channel: string, cb: Subscriber) =>
      subscribe(channelKey(pluginId, channel), cb),
    onPanel: (pluginId: string, channel: string, panelId: string, cb: Subscriber) =>
      subscribe(panelKey(pluginId, channel, panelId), cb),
  };
  // The SDK hooks resolve the bridge from `globalThis.electron.plugin`
  // (see hostBridge.ts). Stub only `electron` so jsdom's `window`/`document`
  // — required by renderHook — stay intact.
  vi.stubGlobal("electron", { plugin });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function emit(pluginId: string, channel: string, payload: unknown): void {
  for (const cb of subscribers.get(channelKey(pluginId, channel)) ?? []) cb(payload);
}

function emitPanel(pluginId: string, channel: string, panelId: string, payload: unknown): void {
  for (const cb of subscribers.get(panelKey(pluginId, channel, panelId)) ?? []) cb(payload);
}

describe("@daintreehq/plugin-sdk/react entry", () => {
  it("resolves the runtime hooks as callables", async () => {
    // The package /react entry re-exports the same canonical implementation the
    // in-repo hooks wrap; assert it loads and exposes both hooks as functions.
    const mod = await import("../../../packages/plugin-sdk/src/react");
    expect(typeof mod.useHostChannel).toBe("function");
    expect(typeof mod.usePluginEvent).toBe("function");
    expect(typeof mod.usePluginPanelEvent).toBe("function");
  });
});

describe("usePluginEvent", () => {
  it("delivers host pushes to the handler", () => {
    const handler = vi.fn();
    renderHook(() => usePluginEvent("acme.p", "tick", handler));

    act(() => emit("acme.p", "tick", { count: 1 }));
    act(() => emit("acme.p", "tick", { count: 2 }));

    expect(handler).toHaveBeenNthCalledWith(1, { count: 1 });
    expect(handler).toHaveBeenNthCalledWith(2, { count: 2 });
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => usePluginEvent("acme.p", "tick", vi.fn()));
    expect(subscribers.get(channelKey("acme.p", "tick"))?.size).toBe(1);

    unmount();

    expect(removeCalls).toBe(1);
    expect(subscribers.get(channelKey("acme.p", "tick"))?.size).toBe(0);
  });

  it("does NOT re-subscribe when only the handler identity changes", () => {
    const { rerender } = renderHook(({ h }) => usePluginEvent("acme.p", "tick", h), {
      initialProps: { h: vi.fn() },
    });
    // Pass a fresh closure each render — a naive [handler] dep would tear down
    // and re-open the subscription, dropping pushes in the gap.
    rerender({ h: vi.fn() });
    rerender({ h: vi.fn() });

    expect(removeCalls).toBe(0);
    expect(subscribers.get(channelKey("acme.p", "tick"))?.size).toBe(1);
  });

  it("routes the latest handler after a re-render without re-subscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ h }) => usePluginEvent("acme.p", "tick", h), {
      initialProps: { h: first },
    });
    rerender({ h: second });

    act(() => emit("acme.p", "tick", { n: 1 }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ n: 1 });
  });

  it("re-subscribes when the channel target changes", () => {
    const { rerender } = renderHook(({ ch }) => usePluginEvent("acme.p", ch, vi.fn()), {
      initialProps: { ch: "tick" },
    });
    rerender({ ch: "tock" });

    expect(removeCalls).toBe(1);
    expect(subscribers.get(channelKey("acme.p", "tick"))?.size).toBe(0);
    expect(subscribers.get(channelKey("acme.p", "tock"))?.size).toBe(1);
  });
});

describe("usePluginPanelEvent", () => {
  it("delivers only the pushes targeted at its panelId", () => {
    const handler = vi.fn();
    renderHook(() => usePluginPanelEvent("acme.p", "tick", "panel-a", handler));

    // A push to this instance's panelId is delivered...
    act(() => emitPanel("acme.p", "tick", "panel-a", { count: 1 }));
    // ...while a push to a sibling instance and a broadcast (via `on`) are not —
    // the whole point of #10618: instances stop receiving each other's pushes.
    act(() => emitPanel("acme.p", "tick", "panel-b", { count: 99 }));
    act(() => emit("acme.p", "tick", { count: 7 }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ count: 1 });
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => usePluginPanelEvent("acme.p", "tick", "panel-a", vi.fn()));
    expect(subscribers.get(panelKey("acme.p", "tick", "panel-a"))?.size).toBe(1);

    unmount();

    expect(removeCalls).toBe(1);
    expect(subscribers.get(panelKey("acme.p", "tick", "panel-a"))?.size).toBe(0);
  });

  it("re-subscribes when the panelId changes", () => {
    const { rerender } = renderHook(
      ({ id }) => usePluginPanelEvent("acme.p", "tick", id, vi.fn()),
      { initialProps: { id: "panel-a" } }
    );
    rerender({ id: "panel-b" });

    expect(removeCalls).toBe(1);
    expect(subscribers.get(panelKey("acme.p", "tick", "panel-a"))?.size).toBe(0);
    expect(subscribers.get(panelKey("acme.p", "tick", "panel-b"))?.size).toBe(1);
  });

  it("does NOT re-subscribe when only the handler identity changes", () => {
    const { rerender } = renderHook(
      ({ h }) => usePluginPanelEvent("acme.p", "tick", "panel-a", h),
      { initialProps: { h: vi.fn() } }
    );
    rerender({ h: vi.fn() });
    rerender({ h: vi.fn() });

    expect(removeCalls).toBe(0);
    expect(subscribers.get(panelKey("acme.p", "tick", "panel-a"))?.size).toBe(1);
  });
});

describe("useHostChannel", () => {
  it("resolves with the host result and clears loading", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useHostChannel("acme.p", "query"));

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.invoke({ q: 1 });
    });

    expect(invokeMock).toHaveBeenCalledWith("acme.p", "query", { q: 1 });
    expect(resolved).toEqual({ ok: true });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a rejection as error and returns undefined", async () => {
    invokeMock.mockRejectedValue(new Error("PERMISSION_REQUIRED: forge.read"));
    const { result } = renderHook(() => useHostChannel("acme.p", "query"));

    let resolved: unknown = "sentinel";
    await act(async () => {
      resolved = await result.current.invoke({});
    });

    expect(resolved).toBeUndefined();
    expect(result.current.error?.message).toMatch(/PERMISSION_REQUIRED/);
  });

  it("drops a superseded earlier invoke so the latest call wins", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    invokeMock.mockImplementation(() => new Promise<unknown>((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useHostChannel("acme.p", "query"));

    let firstResult: unknown = "unset";
    let secondResult: unknown = "unset";
    await act(async () => {
      const firstPromise = result.current.invoke({ call: 1 });
      const secondPromise = result.current.invoke({ call: 2 });
      const [resolveFirst, resolveSecond] = resolvers;
      if (!resolveFirst || !resolveSecond) throw new Error("both invokes should have registered");
      // Resolve out of order: the older call resolves last.
      resolveSecond({ call: 2 });
      resolveFirst({ call: 1 });
      secondResult = await secondPromise;
      firstResult = await firstPromise;
    });

    // The latest call keeps its result; the superseded earlier call is dropped.
    expect(secondResult).toEqual({ call: 2 });
    expect(firstResult).toBeUndefined();
  });
});
