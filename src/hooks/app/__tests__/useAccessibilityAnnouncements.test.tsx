// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentState } from "@shared/types/agent";

interface Terminal {
  id: string;
  title: string;
  agentState?: AgentState;
  stateChangeConfidence?: number;
}

const { panelMockStore } = vi.hoisted(() => {
  // Lazy require zustand inside the hoisted block so it runs before mocks.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require("zustand") as typeof import("zustand");
  return {
    panelMockStore: create<{
      focusedId: string | null;
      panelsById: Record<
        string,
        { id: string; title: string; agentState?: AgentState; stateChangeConfidence?: number }
      >;
      panelIds: string[];
    }>(() => ({
      focusedId: null,
      panelsById: {},
      panelIds: [],
    })),
  };
});

vi.mock("@/store", () => ({
  usePanelStore: panelMockStore,
}));

import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useAccessibilityAnnouncements } from "../useAccessibilityAnnouncements";

function setPanels(panels: Terminal[]) {
  panelMockStore.setState({
    focusedId: null,
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

describe("useAccessibilityAnnouncements — agent-state announcements (#8937)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    panelMockStore.setState({ focusedId: null, panelsById: {}, panelIds: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces 'exited' state politely after the debounce window", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Agent A", agentState: "working" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Agent A", agentState: "exited" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    const { polite, assertive } = useAnnouncerStore.getState();
    expect(polite?.msg).toBe("Agent A exited");
    expect(assertive).toBeNull();
  });

  it("announces 'completed' (unchanged behavior — regression guard)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Agent A", agentState: "working" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Agent A", agentState: "completed" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Agent A finished");
  });
});
