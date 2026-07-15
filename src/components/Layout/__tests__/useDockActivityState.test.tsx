// @vitest-environment jsdom
/**
 * useDockActivityState (#11187) — plain-terminal dock running/finished state.
 *
 * Covers the pure resolution helpers (agent suppression, group aggregation,
 * the deliberately-ignored waiting/failure statuses) and the transient
 * "finished" cue hook: the working→success flash, its dwell, and the guards
 * against a rapid flap or a group-membership change manufacturing a stale or
 * spurious cue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { UI_TRANSIENT_HINT_DWELL_MS } from "@/lib/animationUtils";
import {
  getDockDisplayActivityState,
  getGroupDockDisplayActivityState,
  getGroupActivityScopeKey,
  useTransientDockFinishedCue,
  type DockDisplayActivityState,
} from "../useDockActivityState";

// Isolate the helpers from chrome derivation: an agent is anything carrying an
// agent identity field. Mirrors the real isAgentTerminal contract for the
// suppression branch without pulling in the full chrome pipeline.
vi.mock("@/utils/terminalType", () => ({
  isAgentTerminal: (t: { launchAgentId?: string; detectedAgentId?: string }) =>
    Boolean(t.launchAgentId || t.detectedAgentId),
}));

type State = DockDisplayActivityState | undefined;

describe("getDockDisplayActivityState", () => {
  it("returns 'working' for a running plain terminal", () => {
    expect(getDockDisplayActivityState({ activityStatus: "working" })).toBe("working");
  });

  it("returns 'success' for an idle plain terminal", () => {
    expect(getDockDisplayActivityState({ activityStatus: "success" })).toBe("success");
  });

  it("ignores 'waiting' and 'failure' — shells never emit them", () => {
    expect(getDockDisplayActivityState({ activityStatus: "waiting" })).toBeUndefined();
    expect(getDockDisplayActivityState({ activityStatus: "failure" })).toBeUndefined();
  });

  it("returns undefined when there is no activity status", () => {
    expect(getDockDisplayActivityState({})).toBeUndefined();
  });

  it("suppresses activity for agent terminals — the agent path owns their slot", () => {
    expect(
      getDockDisplayActivityState({ launchAgentId: "claude", activityStatus: "working" })
    ).toBeUndefined();
  });
});

describe("getGroupDockDisplayActivityState", () => {
  it("returns 'working' when any plain terminal is running", () => {
    expect(
      getGroupDockDisplayActivityState([
        { activityStatus: "success" },
        { activityStatus: "working" },
      ])
    ).toBe("working");
  });

  it("returns 'success' when every plain terminal is idle", () => {
    expect(
      getGroupDockDisplayActivityState([
        { activityStatus: "success" },
        { activityStatus: "success" },
      ])
    ).toBe("success");
  });

  it("skips agent terminals when aggregating", () => {
    expect(
      getGroupDockDisplayActivityState([{ launchAgentId: "claude", activityStatus: "working" }])
    ).toBeUndefined();
    // A running agent alongside an idle plain shell aggregates to the shell's
    // idle state — the agent's activity does not leak into the plain path.
    expect(
      getGroupDockDisplayActivityState([
        { launchAgentId: "claude", activityStatus: "working" },
        { activityStatus: "success" },
      ])
    ).toBe("success");
  });

  it("returns undefined for an empty group", () => {
    expect(getGroupDockDisplayActivityState([])).toBeUndefined();
  });
});

describe("getGroupActivityScopeKey", () => {
  it("keys on plain contributors, so an agent-detected tab re-baselines", () => {
    const before = getGroupActivityScopeKey([
      { id: "a", activityStatus: "success" },
      { id: "b", activityStatus: "working" },
    ]);
    // b's command is detected as an agent — it leaves the plain aggregate.
    const after = getGroupActivityScopeKey([
      { id: "a", activityStatus: "success" },
      { id: "b", activityStatus: "working", launchAgentId: "claude" },
    ]);
    expect(before).not.toBe(after);
  });

  it("stays stable across a working→success transition of the same members", () => {
    const running = getGroupActivityScopeKey([
      { id: "a", activityStatus: "working" },
      { id: "b", activityStatus: "success" },
    ]);
    const done = getGroupActivityScopeKey([
      { id: "a", activityStatus: "success" },
      { id: "b", activityStatus: "success" },
    ]);
    // Membership is unchanged, so a real completion is still detectable.
    expect(running).toBe(done);
  });

  it("is order-independent", () => {
    expect(
      getGroupActivityScopeKey([
        { id: "b", activityStatus: "working" },
        { id: "a", activityStatus: "success" },
      ])
    ).toBe(
      getGroupActivityScopeKey([
        { id: "a", activityStatus: "success" },
        { id: "b", activityStatus: "working" },
      ])
    );
  });
});

describe("useTransientDockFinishedCue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays quiet on mount even when starting in 'success'", () => {
    const { result } = renderHook(() => useTransientDockFinishedCue("success", "t-1"));
    expect(result.current).toBe(false);
  });

  it("stays quiet on a late undefined→success (only working→success finishes)", () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: State }) => useTransientDockFinishedCue(state, "t-1"),
      { initialProps: { state: undefined as State } }
    );
    act(() => {
      rerender({ state: "success" });
    });
    expect(result.current).toBe(false);
  });

  it("stays quiet on success→working with no prior completion", () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: State }) => useTransientDockFinishedCue(state, "t-1"),
      { initialProps: { state: "success" as State } }
    );
    act(() => {
      rerender({ state: "working" });
    });
    expect(result.current).toBe(false);
  });

  it("shows the cue on working→success and clears it after the dwell", () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: State }) => useTransientDockFinishedCue(state, "t-1"),
      { initialProps: { state: "working" as State } }
    );
    expect(result.current).toBe(false);

    act(() => {
      rerender({ state: "success" });
    });
    expect(result.current).toBe(true);

    // Still visible right up to the dwell boundary…
    act(() => {
      vi.advanceTimersByTime(UI_TRANSIENT_HINT_DWELL_MS - 1);
    });
    expect(result.current).toBe(true);

    // …then gone.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("hides the cue immediately when a command restarts (working wins)", () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: State }) => useTransientDockFinishedCue(state, "t-1"),
      { initialProps: { state: "working" as State } }
    );
    act(() => {
      rerender({ state: "success" });
    });
    expect(result.current).toBe(true);

    act(() => {
      rerender({ state: "working" });
    });
    expect(result.current).toBe(false);
  });

  it("resets to a fresh dwell on a finish→restart→finish flap", () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: State }) => useTransientDockFinishedCue(state, "t-1"),
      { initialProps: { state: "working" as State } }
    );
    act(() => {
      rerender({ state: "success" }); // finish #1
    });
    expect(result.current).toBe(true);

    // Near the first deadline, restart then finish again.
    act(() => {
      vi.advanceTimersByTime(UI_TRANSIENT_HINT_DWELL_MS - 100);
    });
    act(() => {
      rerender({ state: "working" });
    });
    expect(result.current).toBe(false);
    act(() => {
      rerender({ state: "success" }); // finish #2
    });
    expect(result.current).toBe(true);

    // The first completion's leftover 100ms must not clear the fresh cue.
    act(() => {
      vi.advanceTimersByTime(UI_TRANSIENT_HINT_DWELL_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("re-baselines on a scope change instead of flashing a completion", () => {
    // A running tab is removed: the aggregate flips working→success AND the
    // membership scope key changes. That must NOT read as a finished command.
    const { result, rerender } = renderHook(
      ({ state, scope }: { state: State; scope: string }) =>
        useTransientDockFinishedCue(state, scope),
      { initialProps: { state: "working" as State, scope: "a|b" } }
    );
    act(() => {
      rerender({ state: "success", scope: "b" });
    });
    expect(result.current).toBe(false);
  });

  it("clears a visible cue when the scope changes while still on 'success'", () => {
    // Cue is legitimately showing from a real completion; then an unrelated idle
    // tab is closed (membership changes, aggregate stays "success"). The cue must
    // clear — no stale cue lingering under the new subject — and its timer too.
    const { result, rerender } = renderHook(
      ({ state, scope }: { state: State; scope: string }) =>
        useTransientDockFinishedCue(state, scope),
      { initialProps: { state: "working" as State, scope: "s1" } }
    );
    act(() => {
      rerender({ state: "success", scope: "s1" });
    });
    expect(result.current).toBe(true);

    act(() => {
      rerender({ state: "success", scope: "s2" });
    });
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("establishes a fresh baseline after a scope change", () => {
    const { result, rerender } = renderHook(
      ({ state, scope }: { state: State; scope: string }) =>
        useTransientDockFinishedCue(state, scope),
      { initialProps: { state: "working" as State, scope: "s1" } }
    );
    act(() => {
      rerender({ state: "working", scope: "s2" }); // membership changed mid-run
    });
    expect(result.current).toBe(false);

    act(() => {
      rerender({ state: "success", scope: "s2" }); // completes in the new scope
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(UI_TRANSIENT_HINT_DWELL_MS);
    });
    expect(result.current).toBe(false);
  });

  it("clears its dwell timer on unmount", () => {
    const { result, rerender, unmount } = renderHook(
      ({ state }: { state: State }) => useTransientDockFinishedCue(state, "t-1"),
      { initialProps: { state: "working" as State } }
    );
    act(() => {
      rerender({ state: "success" });
    });
    expect(result.current).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
