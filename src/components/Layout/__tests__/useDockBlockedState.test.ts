// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDockBlockedState, getGroupBlockedAgentState } from "../useDockBlockedState";

describe("useDockBlockedState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null initially for non-blocked states", () => {
    const { result } = renderHook(() => useDockBlockedState("idle"));
    expect(result.current).toBe(null);
  });

  it("returns null initially for waiting state (debounce pending)", () => {
    const { result } = renderHook(() => useDockBlockedState("waiting"));
    expect(result.current).toBe(null);
  });

  it("returns 'waiting' after debounce delay", () => {
    const { result } = renderHook(() => useDockBlockedState("waiting"));
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(result.current).toBe("waiting");
  });

  it("returns 'failed' after debounce delay", () => {
    const { result } = renderHook(() => useDockBlockedState("failed"));
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(result.current).toBe("failed");
  });

  it("clears immediately when leaving blocked state", () => {
    const { result, rerender } = renderHook(({ state }) => useDockBlockedState(state), {
      initialProps: { state: "waiting" as const },
    });

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current).toBe("waiting");

    rerender({ state: "working" as const });
    expect(result.current).toBe(null);
  });

  it("cancels debounce if state clears before delay", () => {
    const { result, rerender } = renderHook(({ state }) => useDockBlockedState(state), {
      initialProps: { state: "waiting" as const },
    });

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBe(null);

    rerender({ state: "working" as const });

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current).toBe(null);
  });

  it("swaps immediately between blocked states", () => {
    const { result, rerender } = renderHook(({ state }) => useDockBlockedState(state), {
      initialProps: { state: "waiting" as const },
    });

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current).toBe("waiting");

    rerender({ state: "failed" as const });
    expect(result.current).toBe("failed");
  });

  it("returns null for undefined agentState", () => {
    const { result } = renderHook(() => useDockBlockedState(undefined));
    expect(result.current).toBe(null);
  });
});

describe("getGroupBlockedAgentState", () => {
  it("returns undefined when no panels are blocked", () => {
    const panels = [{ agentState: "working" as const }, { agentState: "idle" as const }];
    expect(getGroupBlockedAgentState(panels)).toBe(undefined);
  });

  it("returns 'waiting' when any panel is waiting", () => {
    const panels = [{ agentState: "working" as const }, { agentState: "waiting" as const }];
    expect(getGroupBlockedAgentState(panels)).toBe("waiting");
  });

  it("returns 'failed' when any panel is failed and none waiting", () => {
    const panels = [{ agentState: "working" as const }, { agentState: "failed" as const }];
    expect(getGroupBlockedAgentState(panels)).toBe("failed");
  });

  it("returns 'waiting' when both waiting and failed are present", () => {
    const panels = [{ agentState: "waiting" as const }, { agentState: "failed" as const }];
    expect(getGroupBlockedAgentState(panels)).toBe("waiting");
  });

  it("returns undefined for empty panels", () => {
    expect(getGroupBlockedAgentState([])).toBe(undefined);
  });
});
