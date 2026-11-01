// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useDockBlockedState,
  getGroupBlockedAgentState,
  getGroupAmbientAgentState,
  isDockAgentStateDeprioritized,
  isGroupDeprioritized,
} from "../useDockBlockedState";
import type { AgentState } from "@shared/types/agent";

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

  it("returns 'waiting' after debounce delay", () => {
    const { result } = renderHook(() => useDockBlockedState("waiting"));
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(result.current).toBe("waiting");
  });

  it("clears immediately when leaving blocked state", () => {
    const { result, rerender } = renderHook(({ state }) => useDockBlockedState(state), {
      initialProps: { state: "waiting" as AgentState },
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
      initialProps: { state: "waiting" as AgentState },
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

  it("handles rapid flapping without stale state updates", () => {
    const { result, rerender } = renderHook(({ state }) => useDockBlockedState(state), {
      initialProps: { state: "waiting" as AgentState },
    });

    // Flap: waiting -> working -> waiting -> working
    act(() => vi.advanceTimersByTime(200));
    rerender({ state: "working" as const });
    act(() => vi.advanceTimersByTime(200));
    rerender({ state: "waiting" as const });
    act(() => vi.advanceTimersByTime(200));
    rerender({ state: "working" as const });

    // Should still be null — never stayed blocked long enough
    act(() => vi.advanceTimersByTime(800));
    expect(result.current).toBe(null);
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

  it("ignores stale waiting state on demoted runtime terminals", () => {
    const panels = [
      {
        agentState: "waiting" as const,
        runtimeIdentity: {
          kind: "process" as const,
          id: "npm",
          iconId: "npm",
          processId: "npm",
        },
      },
    ];
    expect(getGroupBlockedAgentState(panels)).toBe(undefined);
  });

  it("returns undefined for empty panels", () => {
    expect(getGroupBlockedAgentState([])).toBe(undefined);
  });
});

describe("getGroupAmbientAgentState", () => {
  const NONE: ReadonlySet<string> = new Set();

  it("returns undefined when all panels are idle or completed", () => {
    const panels = [{ agentState: "idle" as const }, { agentState: "completed" as const }];
    expect(getGroupAmbientAgentState(panels, NONE)).toBe(undefined);
  });

  it("returns 'waiting' for a hidden tab the fleet places in needs-you, over work", () => {
    const panels = [
      { id: "shown", agentState: "working" as const },
      { id: "asking", agentState: "completed" as const },
    ];
    expect(getGroupAmbientAgentState(panels, new Set(["asking"]), "shown")).toBe("waiting");
  });

  it("takes no wait from a prompt, a hand-back or an unread wait the band doesn't call needs-you", () => {
    const panels = [
      { id: "prompt", agentState: "waiting" as const, waitingReason: "prompt" as const },
      { id: "approval", agentState: "waiting" as const, waitingReason: "approval" as const },
      { id: "done", agentState: "completed" as const },
    ];
    expect(getGroupAmbientAgentState(panels, NONE, "prompt")).toBe(undefined);
    expect(getGroupAmbientAgentState(panels, new Set(["elsewhere"]), "prompt")).toBe(undefined);
  });

  it("leaves the shown tab's ask to the pane itself", () => {
    const panels = [{ id: "shown", agentState: "waiting" as const }];
    expect(getGroupAmbientAgentState(panels, new Set(["shown"]), "shown")).toBe(undefined);
  });

  it("drops a needs-you tab its pane has since seen go back to work, exit or error", () => {
    const asking = new Set(["t"]);
    for (const panel of [
      { id: "t", agentState: "exited" as const },
      { id: "t", agentState: "directing" as const },
      { id: "t", agentState: "waiting" as const, waitingReason: "error" as const },
    ]) {
      expect(getGroupAmbientAgentState([panel], asking)).toBe(undefined);
    }
    expect(getGroupAmbientAgentState([{ id: "t", agentState: "working" as const }], asking)).toBe(
      "working"
    );
  });

  it("returns 'working' when any panel is working and none is asking", () => {
    const panels = [
      { id: "shown", agentState: "working" as const },
      { id: "prompt", agentState: "waiting" as const },
    ];
    expect(getGroupAmbientAgentState(panels, NONE, "shown")).toBe("working");
  });

  it("ignores stale working state when runtime identity is no longer agent", () => {
    const panels = [
      {
        agentState: "working" as const,
        detectedAgentId: undefined,
        runtimeIdentity: undefined,
      },
    ];
    expect(getGroupAmbientAgentState(panels, NONE)).toBe(undefined);
  });

  it("returns undefined for empty panels", () => {
    expect(getGroupAmbientAgentState([], NONE)).toBe(undefined);
  });

  it("returns undefined for undefined agentState panels", () => {
    const panels = [{ agentState: undefined }, { agentState: undefined }];
    expect(getGroupAmbientAgentState(panels, NONE)).toBe(undefined);
  });

  it("ignores directing state (not in working tier)", () => {
    const panels = [{ agentState: "directing" as const }, { agentState: "idle" as const }];
    expect(getGroupAmbientAgentState(panels, NONE)).toBe(undefined);
  });
});

describe("isDockAgentStateDeprioritized", () => {
  // States that recede: the pill should dim because nothing is in flight.
  it.each([undefined, "idle", "completed", "exited"] as const)(
    "returns true for receding state %s",
    (state) => {
      expect(isDockAgentStateDeprioritized(state)).toBe(true);
    }
  );

  // Active states keep the pill at full emphasis.
  it.each(["working", "waiting", "directing"] as const)(
    "returns false for active state %s",
    (state) => {
      expect(isDockAgentStateDeprioritized(state)).toBe(false);
    }
  );

  // The shared predicate is the single source of truth for both pill types, so a
  // single-panel group must recede under the same conditions as a lone pill. Assert
  // the group helper's observable output for each state (not a copy of its body).
  it.each([
    ["idle", true],
    ["completed", true],
    ["exited", true],
    ["working", false],
    ["waiting", false],
    ["directing", false],
  ] as const)("isGroupDeprioritized for a single %s panel is %s", (state, expected) => {
    expect(isGroupDeprioritized([{ agentState: state }])).toBe(expected);
  });
});

describe("isGroupDeprioritized", () => {
  it("returns true for mix of idle, completed, and undefined", () => {
    const panels = [
      { agentState: "idle" as const },
      { agentState: "completed" as const },
      { agentState: undefined },
    ];
    expect(isGroupDeprioritized(panels)).toBe(true);
  });

  it("returns false when any panel is working", () => {
    const panels = [{ agentState: "idle" as const }, { agentState: "working" as const }];
    expect(isGroupDeprioritized(panels)).toBe(false);
  });

  it("returns true for single panel with undefined agentState", () => {
    expect(isGroupDeprioritized([{ agentState: undefined }])).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(isGroupDeprioritized([])).toBe(false);
  });
});
