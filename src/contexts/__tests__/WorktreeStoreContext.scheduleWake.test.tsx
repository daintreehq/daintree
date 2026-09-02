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
  restoreTerminalFocusOnReveal: () => false,
  wakeActiveWorktreeTerminals: () => wakeMock(),
  repaintActiveWorktreeTerminals: () => repaintMock(),
}));

let viewRevealedCb: (() => void) | null = null;
let viewWarmActivatedCb: (() => void) | null = null;
let viewCachedCb: (() => void) | null = null;

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
  viewWarmActivatedCb = null;
  viewCachedCb = null;
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
      onViewWarmActivated: (cb: () => void) => {
        viewWarmActivatedCb = cb;
        return () => {
          viewWarmActivatedCb = null;
        };
      },
      onViewCached: (cb: () => void) => {
        viewCachedCb = cb;
        return () => {
          viewCachedCb = null;
        };
      },
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  // Restore the prototype getter shadowed by setVisibilityState.
  delete (document as unknown as Record<string, unknown>)["visibilityState"];
  useProjectStore.setState({ currentProject: null });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Drive scheduleRepaint's double-rAF gate to completion (the repaint lands on
// the second frame), returning how many times the repaint actually fired.
function flushRepaintGate(): void {
  act(() => flushFrame());
  act(() => flushFrame());
}

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

  it("cancels a pending post-reveal repaint when the view is cached (switched away)", async () => {
    await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    repaintMock.mockClear();
    expect(viewCachedCb).not.toBeNull();

    // Schedule a repaint; it parks on the gate's second frame.
    act(() => viewRevealedCb?.());
    act(() => flushFrame());
    expect(repaintMock).not.toHaveBeenCalled();

    // The view is cached (project switched away) before the second frame — the
    // pending repaint rAF must be cancelled so it can't fire against the now
    // occluded/about-to-freeze view.
    act(() => viewCachedCb?.());
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

  it("re-runs the repaint on the timed backstop cadence after the reveal", async () => {
    // toFake only the timers so the manually-installed rAF mock survives.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    repaintMock.mockClear();

    // The reveal itself drives the immediate frame-sweep repaint.
    act(() => viewRevealedCb?.());
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(1);

    // Each backstop delay (1s / 3s) re-runs the same repaint without any further
    // user action — this is what replaces the manual Redraw click.
    act(() => vi.advanceTimersByTime(1000));
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(2000));
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(3);

    // No further passes are scheduled past the last backstop.
    act(() => vi.advanceTimersByTime(10_000));
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(3);
  });

  it("suppresses backstop repaints once the view is hidden again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    repaintMock.mockClear();

    act(() => viewRevealedCb?.());
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(1);

    // User switches away before the backstops fire: the timers still elapse but
    // their visibility guard no-ops, so a backgrounded view is never repainted.
    setVisibilityState("hidden");
    act(() => vi.advanceTimersByTime(5000));
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a prior switch's pending backstops on re-reveal (no stacking)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    repaintMock.mockClear();

    // Reveal 1 at t=0 arms its first backstop for t=1000.
    act(() => viewRevealedCb?.());
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(1);

    // Reveal 2 at t=500 (rapid back-and-forth) must cancel reveal 1's pending
    // timers and re-arm its own, now due at t=1500.
    act(() => vi.advanceTimersByTime(500));
    act(() => viewRevealedCb?.());
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(2);

    // At t=1000 reveal 1's stale backstop WOULD have fired if it weren't
    // cancelled — confirm nothing repaints, proving no stacking.
    act(() => vi.advanceTimersByTime(500));
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(2);

    // Reveal 2's own first backstop fires on schedule at t=1500.
    act(() => vi.advanceTimersByTime(500));
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(3);
  });

  it("cancels pending backstops when the provider unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { unmount } = await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    repaintMock.mockClear();

    act(() => viewRevealedCb?.());
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(1);

    unmount();
    act(() => vi.advanceTimersByTime(5000));
    flushRepaintGate();
    expect(repaintMock).toHaveBeenCalledTimes(1);
  });

  it("runs the wake fan-out synchronously on the warm-activation signal", async () => {
    await renderProvider();
    // Drain the mount-scheduled missed-event wake first.
    act(() => flushFrame());
    act(() => flushFrame());
    wakeMock.mockClear();
    expect(viewWarmActivatedCb).not.toBeNull();

    // A detached setVisible(false) view receives no visibilitychange/resume on
    // reattach, so main's explicit warm-activation send is the only trigger
    // this path can rely on. It must NOT wait for animation frames: the view is
    // undrawn behind the bridge and its frames are throttled, and main holds
    // the bridge until the fan-out reports back.
    act(() => viewWarmActivatedCb?.());
    expect(wakeMock).toHaveBeenCalledTimes(1);

    act(() => flushFrame());
    act(() => flushFrame());
    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces a warm-activation signal with a same-turn lifecycle event into one wake", async () => {
    await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    wakeMock.mockClear();
    expect(viewWarmActivatedCb).not.toBeNull();

    // When Chromium DOES emit lifecycle events (e.g. the Efficiency-profile
    // freeze path fires `resume`), the explicit trigger must dedupe with them
    // rather than double-running the fan-out.
    act(() => {
      viewWarmActivatedCb?.();
      document.dispatchEvent(new Event("resume"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => flushFrame());
    act(() => flushFrame());

    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("runs the warm-activation wake even while the document reports hidden", async () => {
    await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    wakeMock.mockClear();
    expect(viewWarmActivatedCb).not.toBeNull();

    // Main asserts the activation and is holding the anti-flash bridge on the
    // reply, so a visibility guard here would only trade a fan-out for a stall.
    setVisibilityState("hidden");
    act(() => viewWarmActivatedCb?.());

    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("folds a pending frame-deferred wake into the warm-activation wake and runs nothing more once cached", async () => {
    await renderProvider();
    act(() => flushFrame());
    act(() => flushFrame());
    wakeMock.mockClear();
    expect(viewWarmActivatedCb).not.toBeNull();
    expect(viewCachedCb).not.toBeNull();

    // A lifecycle event queued a frame-deferred wake; the warm activation runs
    // the fan-out immediately and absorbs that pending frame. Rapid A→B→A→B
    // then caches the view again before any frame fires: nothing further runs.
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => viewWarmActivatedCb?.());
    expect(wakeMock).toHaveBeenCalledTimes(1);

    act(() => viewCachedCb?.());
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
