// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

type LifecyclePhase = "cached" | "active" | "revealed";

const listeners = new Set<(phase: LifecyclePhase) => void>();

const subscribeProjectViewLifecycleMock = vi.hoisted(() =>
  vi.fn<(cb: (phase: LifecyclePhase) => void) => () => void>()
);

vi.mock("@/lib/viewCacheState", () => ({
  subscribeProjectViewLifecycle: subscribeProjectViewLifecycleMock,
}));

import { useProjectViewRevealed } from "../useProjectViewRevealed";

function emit(phase: LifecyclePhase): void {
  act(() => {
    for (const listener of Array.from(listeners)) listener(phase);
  });
}

beforeEach(() => {
  listeners.clear();
  subscribeProjectViewLifecycleMock.mockReset();
  // A real registry rather than a bare stub, so unsubscribe assertions mean
  // something: a leaked listener keeps firing here exactly as it would in the
  // app.
  subscribeProjectViewLifecycleMock.mockImplementation((cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  });
});

describe("useProjectViewRevealed", () => {
  it("runs the callback on revealed and ignores the other phases", () => {
    const callback = vi.fn();
    renderHook(() => useProjectViewRevealed(callback));

    emit("cached");
    emit("active");
    expect(callback).not.toHaveBeenCalled();

    emit("revealed");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe again when the callback identity changes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useProjectViewRevealed(cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    expect(subscribeProjectViewLifecycleMock).toHaveBeenCalledTimes(1);

    // The newest closure runs, not the one captured when the listener was
    // registered — this is what lets a caller pass an inline closure over live
    // state without churning the subscription.
    emit("revealed");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("defers a reveal that lands while disabled and runs it once on enable", () => {
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useProjectViewRevealed(callback, { enabled }),
      {
        initialProps: { enabled: false },
      }
    );

    emit("revealed");
    expect(callback).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("coalesces several deferred reveals into a single catch-up", () => {
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useProjectViewRevealed(callback, { enabled }),
      {
        initialProps: { enabled: false },
      }
    );

    emit("revealed");
    emit("revealed");
    emit("revealed");

    rerender({ enabled: true });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not run a catch-up on enable when no reveal was missed", () => {
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useProjectViewRevealed(callback, { enabled }),
      {
        initialProps: { enabled: false },
      }
    );

    rerender({ enabled: true });
    expect(callback).not.toHaveBeenCalled();
  });

  it("clears the pending catch-up once it has run", () => {
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useProjectViewRevealed(callback, { enabled }),
      {
        initialProps: { enabled: false },
      }
    );

    emit("revealed");
    rerender({ enabled: true });
    expect(callback).toHaveBeenCalledTimes(1);

    // Going away and coming back must not replay the reveal that was already
    // paid for.
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("runs the callback directly while enabled instead of deferring", () => {
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useProjectViewRevealed(callback, { enabled }),
      {
        initialProps: { enabled: true },
      }
    );

    emit("revealed");
    expect(callback).toHaveBeenCalledTimes(1);

    // No pending work was recorded, so toggling away and back adds nothing.
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount", () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useProjectViewRevealed(callback));

    unmount();
    expect(listeners.size).toBe(0);

    emit("revealed");
    expect(callback).not.toHaveBeenCalled();
  });
});
