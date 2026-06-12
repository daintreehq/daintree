// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

const wakeMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
const repaintMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
vi.mock("@/store/wakeActiveWorktreeTerminals", () => ({
  wakeActiveWorktreeTerminals: () => wakeMock(),
  repaintActiveWorktreeTerminals: () => repaintMock(),
}));

let viewRevealedCb: (() => void) | null = null;

vi.mock("@/lib/notify", () => ({ notify: vi.fn(() => "notif-id") }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

const rafQueue = new Map<number, FrameRequestCallback>();
let rafIdCounter = 0;

function flushFrame(): void {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of pending) cb(0);
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  rafQueue.clear();
  rafIdCounter = 0;
  wakeMock.mockClear();
  repaintMock.mockClear();
  viewRevealedCb = null;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = ++rafIdCounter;
    rafQueue.set(id, cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
    rafQueue.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;
  setVisibilityState("visible");
  useProjectStore.setState({
    currentProject: { id: "p1", name: "p1", path: "/repo/proj" } as unknown as Project,
  });

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: (_name: string) => Promise.resolve({ states: [] as WorktreeSnapshot[] }),
      onEvent: (_name: string, _cb: (data: unknown) => void) => () => {},
      onReady: (_cb: () => void) => () => {},
      onDisconnected: (_cb: () => void) => () => {},
      onFatalDisconnect: (_cb: () => void) => () => {},
    },
    worktree: {
      getAllIssueAssociations: () => Promise.resolve({}),
      getPRStatus: () => Promise.resolve(null),
    },
    app: {
      onViewRevealed: (cb: () => void) => {
        viewRevealedCb = cb;
        return () => {
          viewRevealedCb = null;
        };
      },
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  // Restore the prototype getter shadowed by setVisibilityState.
  delete (document as unknown as Record<string, unknown>)["visibilityState"];
  useProjectStore.setState({ currentProject: null });
  vi.restoreAllMocks();
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const { result, unmount } = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!result.current) throw new Error("WorktreeStoreContext is null");
  return { store: result.current, unmount };
}

describe("WorktreeStoreProvider — wake fan-out scheduling (#10362)", () => {
  it("defers the missed-event guard through the double-rAF gate on mount when already visible", async () => {
    await renderProvider();
    // Pre-#10362 the guard fired synchronously here; it now rides the same
    // double-rAF settle as the visibilitychange/resume paths so it can't run
    // before the reactivated view's layout settles.
    expect(wakeMock).not.toHaveBeenCalled();

    act(() => flushFrame());
    expect(wakeMock).not.toHaveBeenCalled();

    act(() => flushFrame());
    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("repaints on the post-reveal signal, deferred to the second frame, without re-waking", async () => {
    await renderProvider();
    // Drain the mount-scheduled missed-event wake before exercising the reveal.
    act(() => flushFrame());
    act(() => flushFrame());
    wakeMock.mockClear();
    repaintMock.mockClear();
    expect(viewRevealedCb).not.toBeNull();

    act(() => viewRevealedCb?.());
    // First frame: not yet — the repaint must land on a settled foreground frame.
    act(() => flushFrame());
    expect(repaintMock).not.toHaveBeenCalled();

    act(() => flushFrame());
    expect(repaintMock).toHaveBeenCalledTimes(1);
    // The reveal path repaints only; it must not re-run the byte-pulling wake
    // (the headless-mirror sync already ran behind the bridge).
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it("skips the post-reveal repaint when the view is re-hidden before the second frame", async () => {
    await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    repaintMock.mockClear();

    act(() => viewRevealedCb?.());
    act(() => flushFrame());
    setVisibilityState("hidden");
    act(() => flushFrame());

    expect(repaintMock).not.toHaveBeenCalled();
  });

  it("cancels a pending post-reveal repaint when the provider unmounts", async () => {
    const { unmount } = await renderProvider();
    repaintMock.mockClear();

    act(() => viewRevealedCb?.());
    act(() => flushFrame());
    unmount();
    act(() => flushFrame());

    expect(repaintMock).not.toHaveBeenCalled();
  });

  it("defers the wake to the second animation frame, not a microtask or first frame", async () => {
    await renderProvider();
    wakeMock.mockClear();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Microtask checkpoint: the pre-#10362 scheduler fired here, before the
    // unfrozen renderer's first layout pass.
    await act(async () => {
      await Promise.resolve();
    });
    expect(wakeMock).not.toHaveBeenCalled();

    act(() => flushFrame());
    expect(wakeMock).not.toHaveBeenCalled();

    act(() => flushFrame());
    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces a same-turn resume + visibilitychange pair into one wake", async () => {
    await renderProvider();
    wakeMock.mockClear();

    act(() => {
      document.dispatchEvent(new Event("resume"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => flushFrame());
    act(() => flushFrame());

    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("skips the wake when the view is re-hidden before the second frame", async () => {
    await renderProvider();
    wakeMock.mockClear();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => flushFrame());
    setVisibilityState("hidden");
    act(() => flushFrame());

    expect(wakeMock).not.toHaveBeenCalled();
  });

  it("clears the pending flag after a skipped wake so the next cycle fires", async () => {
    await renderProvider();
    wakeMock.mockClear();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    setVisibilityState("hidden");
    act(() => flushFrame());
    act(() => flushFrame());
    expect(wakeMock).not.toHaveBeenCalled();

    setVisibilityState("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => flushFrame());
    act(() => flushFrame());
    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending wake when the provider unmounts mid-schedule", async () => {
    const { unmount } = await renderProvider();
    wakeMock.mockClear();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    unmount();
    act(() => flushFrame());
    act(() => flushFrame());

    expect(wakeMock).not.toHaveBeenCalled();
  });

  it("services a show arriving mid-dedup window with the already-pending wake", async () => {
    await renderProvider();
    wakeMock.mockClear();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => flushFrame());
    setVisibilityState("hidden");
    setVisibilityState("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => flushFrame());
    act(() => flushFrame());

    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("ignores visibilitychange dispatched while hidden", async () => {
    await renderProvider();
    wakeMock.mockClear();

    setVisibilityState("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("resume"));
    });
    act(() => flushFrame());
    act(() => flushFrame());

    expect(wakeMock).not.toHaveBeenCalled();
  });
});
