// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { logWarnMock } = vi.hoisted(() => ({ logWarnMock: vi.fn() }));
vi.mock("@/utils/logger", () => ({ logWarn: logWarnMock }));

import { useSettledSidebarFailure, type SidebarFailure } from "../useSettledSidebarFailure";

const SETTLE_MS = 2_000;
const DISCONNECTED: SidebarFailure = {
  kind: "load-error",
  message: "The workspace service isn't connected to this project.",
};
const SERVICE: SidebarFailure = { kind: "service-error", message: "Host did not connect" };

function render(initial: SidebarFailure | null) {
  return renderHook(
    ({ failure }: { failure: SidebarFailure | null }) =>
      useSettledSidebarFailure(failure, SETTLE_MS),
    { initialProps: { failure: initial } }
  );
}

function logged(message: string) {
  return logWarnMock.mock.calls.filter(([m]) => m === message).map(([, context]) => context);
}

describe("useSettledSidebarFailure (#14311)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logWarnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never settles a failure that clears inside the window", () => {
    const { result, rerender } = render(null);
    rerender({ failure: DISCONNECTED });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(SETTLE_MS - 1);
    });
    expect(result.current).toBe(false);
    rerender({ failure: null });
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS * 2);
    });

    expect(result.current).toBe(false);
    expect(logged("Worktree sidebar failure banner shown")).toHaveLength(0);
    expect(logged("Worktree sidebar failure pending")).toEqual([
      expect.objectContaining({ kind: "load-error", message: DISCONNECTED.message }),
    ]);
    expect(logged("Worktree sidebar failure cleared")).toEqual([
      expect.objectContaining({ kind: "load-error", message: DISCONNECTED.message, shown: false }),
    ]);
  });

  it("settles a failure that persists past the window, and logs it as shown", () => {
    const { result } = render(SERVICE);
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS);
    });

    expect(result.current).toBe(true);
    expect(logged("Worktree sidebar failure banner shown")).toEqual([
      expect.objectContaining({ kind: "service-error", message: SERVICE.message }),
    ]);
  });

  it("keeps the clock running when one failure hands over to another", () => {
    const { result, rerender } = render(DISCONNECTED);
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS - 500);
    });
    rerender({ failure: SERVICE });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(true);
    expect(logged("Worktree sidebar failure pending").map((c) => c?.kind)).toEqual([
      "load-error",
      "service-error",
    ]);
    expect(logged("Worktree sidebar failure banner shown")).toEqual([
      expect.objectContaining({ kind: "service-error", message: SERVICE.message }),
    ]);
  });

  it("starts a fresh window for a failure that returns after clearing", () => {
    const { result, rerender } = render(SERVICE);
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS);
    });
    expect(result.current).toBe(true);

    rerender({ failure: null });
    expect(result.current).toBe(false);
    rerender({ failure: SERVICE });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(SETTLE_MS);
    });
    expect(result.current).toBe(true);
    expect(logged("Worktree sidebar failure cleared")).toEqual([
      expect.objectContaining({ shown: true }),
    ]);
  });

  it("does not reset the window when the same failure re-renders", () => {
    const { result, rerender } = render({ ...SERVICE });
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS - 1);
    });
    rerender({ failure: { ...SERVICE } });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(result.current).toBe(true);
    expect(logged("Worktree sidebar failure pending")).toHaveLength(1);
  });
});
