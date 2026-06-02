// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginDeepLinkIntent } from "@shared/types/plugin";

const onDeepLinkMock = vi.hoisted(() =>
  vi.fn<(cb: (intent: PluginDeepLinkIntent) => void) => () => void>()
);

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    plugin: {
      onDeepLink: onDeepLinkMock,
    },
  },
});

import { usePluginDeepLink } from "../usePluginDeepLink";

const INSTALL: PluginDeepLinkIntent = { action: "install", url: "https://example.com/p.dntr" };
const OPEN: PluginDeepLinkIntent = { action: "open", pluginId: "acme.notes" };

describe("usePluginDeepLink", () => {
  let lastCallback: ((intent: PluginDeepLinkIntent) => void) | null = null;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribe = vi.fn();
    lastCallback = null;
    onDeepLinkMock.mockImplementation((cb) => {
      lastCallback = cb;
      return unsubscribe as () => void;
    });
  });

  it("subscribes on mount regardless of isStateLoaded", () => {
    renderHook(({ loaded }) => usePluginDeepLink(loaded), { initialProps: { loaded: false } });
    expect(onDeepLinkMock).toHaveBeenCalledTimes(1);
  });

  it("buffers the intent until hydration completes", () => {
    const { result, rerender } = renderHook(({ loaded }) => usePluginDeepLink(loaded), {
      initialProps: { loaded: false },
    });

    act(() => lastCallback?.(INSTALL));
    expect(result.current.intent).toBeNull();

    rerender({ loaded: true });
    expect(result.current.intent).toEqual(INSTALL);
  });

  it("surfaces the intent immediately when already hydrated", () => {
    const { result } = renderHook(({ loaded }) => usePluginDeepLink(loaded), {
      initialProps: { loaded: true },
    });

    act(() => lastCallback?.(OPEN));
    expect(result.current.intent).toEqual(OPEN);
  });

  it("clear() resets the intent", () => {
    const { result } = renderHook(({ loaded }) => usePluginDeepLink(loaded), {
      initialProps: { loaded: true },
    });

    act(() => lastCallback?.(OPEN));
    expect(result.current.intent).toEqual(OPEN);

    act(() => result.current.clear());
    expect(result.current.intent).toBeNull();
  });

  it("latest-wins when a second intent arrives", () => {
    const { result } = renderHook(({ loaded }) => usePluginDeepLink(loaded), {
      initialProps: { loaded: true },
    });

    act(() => lastCallback?.(INSTALL));
    act(() => lastCallback?.(OPEN));
    expect(result.current.intent).toEqual(OPEN);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(({ loaded }) => usePluginDeepLink(loaded), {
      initialProps: { loaded: false },
    });
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
