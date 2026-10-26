// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

type FocusPayload =
  | { intent: "focus-next-waiting" }
  | { intent: "focus-panel"; panelId: string }
  | { intent: "open-assistant"; subject: Record<string, unknown> };

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

const activateLaneMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/assistantSubject", () => ({ activateAssistantLane: activateLaneMock }));

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

const { landOnWorktreeMock, cancelLandingMock, worktreeStore } = vi.hoisted(() => {
  const cancelLandingMock = vi.fn();
  return {
    cancelLandingMock,
    landOnWorktreeMock: vi.fn(() => cancelLandingMock),
    worktreeStore: { name: "the view's worktree store" },
  };
});
vi.mock("@/services/worktreeLanding", () => ({ landOnWorktree: landOnWorktreeMock }));
vi.mock("@/hooks/useWorktreeStore", () => ({ useWorktreeStoreApi: () => worktreeStore }));

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

  it("opens the exact assistant lane it was sent, once hydrated, dispatching nothing else", () => {
    const subject = {
      hostId: "local",
      scope: { kind: "project", projectId: "p1" },
      terminalId: "t1",
      incarnation: 3,
      lane: 2,
    };
    const { rerender } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });
    act(() => {
      lastCallback?.({ intent: "open-assistant", subject });
    });
    expect(activateLaneMock).not.toHaveBeenCalled();
    rerender({ loaded: true });
    expect(activateLaneMock).toHaveBeenCalledWith(subject);
    expect(dispatchMock).not.toHaveBeenCalled();
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

  it("runs a plugin banner's first action with its args once hydrated (#13505)", async () => {
    dispatchMock.mockResolvedValue({ ok: true, data: undefined });
    const { rerender } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });

    act(() => {
      lastCallback?.({
        intent: "run-plugin-action",
        pluginId: "acme",
        actionId: "acme.openRun",
        args: { runId: "r1" },
      } as never);
    });
    expect(dispatchMock).not.toHaveBeenCalled();

    rerender({ loaded: true });
    expect(dispatchMock).toHaveBeenCalledWith("acme.openRun", { runId: "r1" }, { source: "user" });
  });

  it("refuses a plugin banner action outside that plugin's namespace", () => {
    renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: true },
    });

    act(() => {
      lastCallback?.({
        intent: "run-plugin-action",
        pluginId: "acme",
        actionId: "terminal.closeAll",
      } as never);
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("focuses a named terminal that is still there without saying anything", async () => {
    dispatchMock.mockResolvedValue({ ok: true, data: undefined });
    renderHook(() => useFocusOnActivateIntent(true));
    await act(async () => {
      lastCallback?.({ intent: "focus-panel", panelId: "t1" });
    });
    expect(dispatchMock).toHaveBeenCalledWith("panel.focus", { panelId: "t1" });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("says once, in plain words, that the named terminal is gone", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "Terminal panel no longer exists" },
    });
    renderHook(() => useFocusOnActivateIntent(true));
    await act(async () => {
      lastCallback?.({ intent: "focus-panel", panelId: "t1" });
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Terminal is gone" }));
  });

  it("lands on the worktree it was sent once hydrated, dispatching nothing else (#14569)", () => {
    const { rerender } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });
    act(() => {
      lastCallback?.({ intent: "focus-worktree", worktreeId: "/repo-feature" } as never);
    });
    expect(landOnWorktreeMock).not.toHaveBeenCalled();

    rerender({ loaded: true });
    expect(landOnWorktreeMock).toHaveBeenCalledTimes(1);
    expect(landOnWorktreeMock).toHaveBeenCalledWith("/repo-feature", worktreeStore);
    expect(dispatchMock).not.toHaveBeenCalled();
    rerender({ loaded: true });
    expect(landOnWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it("drops a landing still waiting when a newer intent arrives or the view unmounts", () => {
    const { unmount } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: true },
    });
    act(() => {
      lastCallback?.({ intent: "focus-worktree", worktreeId: "/repo-feature" } as never);
    });
    expect(cancelLandingMock).not.toHaveBeenCalled();

    act(() => {
      lastCallback?.({ intent: "focus-next-waiting" });
    });
    expect(cancelLandingMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("agent.focusNextWaiting");

    act(() => {
      lastCallback?.({ intent: "focus-worktree", worktreeId: "/repo-other" } as never);
    });
    unmount();
    expect(cancelLandingMock).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(({ loaded }) => useFocusOnActivateIntent(loaded), {
      initialProps: { loaded: false },
    });
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
