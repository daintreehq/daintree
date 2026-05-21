// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

type FocusPayload = { intent: "focus-next-waiting" };

const onFocusOnActivateMock = vi.hoisted(() =>
  vi.fn<(cb: (payload: FocusPayload) => void) => () => void>()
);

const dispatchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    project: {
      onFocusOnActivate: onFocusOnActivateMock,
    },
  },
});

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

import { useFocusOnActivateIntent } from "../useFocusOnActivateIntent";

describe("useFocusOnActivateIntent", () => {
  let lastCallback: ((payload: FocusPayload) => void) | null = null;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribe = vi.fn();
    lastCallback = null;
    onFocusOnActivateMock.mockImplementation((cb) => {
      lastCallback = cb;
      return unsubscribe as () => void;
    });
  });

  it("subscribes on mount regardless of isStateLoaded", () => {
    renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });
    expect(onFocusOnActivateMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT dispatch when intent arrives before hydration completes", () => {
    renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });

    act(() => {
      lastCallback?.({ intent: "focus-next-waiting" });
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("dispatches when hydration completes after intent received", () => {
    const { rerender } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });

    act(() => {
      lastCallback?.({ intent: "focus-next-waiting" });
    });
    expect(dispatchMock).not.toHaveBeenCalled();

    rerender({ loaded: true });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("agent.focusNextWaiting");
  });

  it("dispatches immediately when intent arrives after hydration completes", () => {
    renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: true },
    });

    act(() => {
      lastCallback?.({ intent: "focus-next-waiting" });
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("agent.focusNextWaiting");
  });

  it("only fires once per intent — consecutive renders do not redispatch", () => {
    const { rerender } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });

    act(() => {
      lastCallback?.({ intent: "focus-next-waiting" });
    });

    rerender({ loaded: true });
    rerender({ loaded: true });
    rerender({ loaded: true });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("dispatches again on a second intent", () => {
    const { rerender: _rerender } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: true },
    });

    act(() => {
      lastCallback?.({ intent: "focus-next-waiting" });
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    act(() => {
      lastCallback?.({ intent: "focus-next-waiting" });
    });
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores payloads with unrecognized intent strings", () => {
    renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: true },
    });

    act(() => {
      lastCallback?.({ intent: "garbage" as never });
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
