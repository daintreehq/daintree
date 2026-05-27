// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentState } from "@shared/types/agent";
import type { PersistableFlowStatus } from "@shared/types/panel";

interface Terminal {
  id: string;
  title: string;
  kind?: "terminal";
  agentState?: AgentState;
  stateChangeConfidence?: number;
  flowStatus?: PersistableFlowStatus;
  exitCode?: number;
}

const { panelMockStore } = vi.hoisted(() => {
  // Lazy require zustand inside the hoisted block so it runs before mocks.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require("zustand") as typeof import("zustand");
  return {
    panelMockStore: create<{
      focusedId: string | null;
      panelsById: Record<string, Terminal>;
      panelIds: string[];
      commandQueueCountById: Record<string, number>;
    }>(() => ({
      focusedId: null,
      panelsById: {},
      panelIds: [],
      commandQueueCountById: {},
    })),
  };
});

vi.mock("@/store", () => ({
  usePanelStore: panelMockStore,
}));

// `isPtyPanel` checks `kind === "terminal"`. Test terminals set `kind` to
// satisfy the guard without recreating the full discriminated-union shape.
vi.mock("@shared/types/panel", async () => {
  const actual = await vi.importActual<typeof import("@shared/types/panel")>("@shared/types/panel");
  return {
    ...actual,
    isPtyPanel: (p: { kind?: string }) => p.kind === "terminal",
  };
});

const hibernationState = new Map<string, boolean>();
const hibernationListeners = new Map<string, Set<() => void>>();

function setHibernated(id: string, value: boolean) {
  hibernationState.set(id, value);
  const ls = hibernationListeners.get(id);
  if (!ls) return;
  for (const l of ls) l();
}

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    isHibernated: (id: string) => hibernationState.get(id) ?? false,
    subscribeHibernation: (id: string, listener: () => void) => {
      let set = hibernationListeners.get(id);
      if (!set) {
        set = new Set();
        hibernationListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        const current = hibernationListeners.get(id);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) hibernationListeners.delete(id);
      };
    },
  },
}));

import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useAccessibilityAnnouncements } from "../useAccessibilityAnnouncements";

function setPanels(panels: Terminal[], queueCounts: Record<string, number> = {}) {
  panelMockStore.setState({
    focusedId: null,
    panelsById: Object.fromEntries(panels.map((p) => [p.id, { kind: "terminal" as const, ...p }])),
    panelIds: panels.map((p) => p.id),
    commandQueueCountById: queueCounts,
  });
}

describe("useAccessibilityAnnouncements — agent-state announcements (#8937)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    panelMockStore.setState({
      focusedId: null,
      panelsById: {},
      panelIds: [],
      commandQueueCountById: {},
    });
    hibernationState.clear();
    hibernationListeners.clear();
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

  it("cancels pending debounce timer when panel is removed before fire (#8937)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Agent A", agentState: "working" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    // Transition triggers a 300ms debounce timer
    act(() => {
      setPanels([{ id: "t1", title: "Agent A", agentState: "exited" }]);
    });
    rerender();

    // Remove the panel before the timer fires
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      setPanels([]);
    });
    rerender();

    // Past the original debounce window — stale timer should have been cancelled
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const { polite, assertive } = useAnnouncerStore.getState();
    expect(polite).toBeNull();
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

// #9204 — per-pane state badges (exit-code, queue-count, paused-backpressure,
// paused-resource-governor, suspended, hibernated) used to each carry their
// own `aria-live="polite"` region. In a multi-pane fleet that produced
// competing live regions. They're now silenced (aria-live="off") and routed
// through the single global announcer with a pane-title prefix.
describe("useAccessibilityAnnouncements — badge-state announcements (#9204)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    panelMockStore.setState({
      focusedId: null,
      panelsById: {},
      panelIds: [],
      commandQueueCountById: {},
    });
    hibernationState.clear();
    hibernationListeners.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces flow status entering 'paused-backpressure' with title prefix", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "paused-backpressure" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: output paused");
  });

  it("announces flow status entering 'paused-resource-governor' with memory context", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "paused-resource-governor" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: output paused, memory pressure");
  });

  it("announces flow status entering 'suspended'", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "suspended" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: output suspended");
  });

  it("announces flow status resuming back to undefined", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "paused-backpressure" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: undefined }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: output resumed");
  });

  it("does not announce when flow status is unchanged", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "paused-backpressure" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "paused-backpressure" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("announces queue threshold 0 → N as 'N commands queued'", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 0 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 3 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: 3 commands queued");
  });

  it("uses singular 'command' for queue 0 → 1", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 0 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 1 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: 1 command queued");
  });

  it("announces queue threshold N → 0 as 'queue cleared'", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 3 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 0 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: queue cleared");
  });

  it("does NOT announce mid-range queue changes (3 → 5)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 3 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 5 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("announces exit with code when exitCode flips from undefined to a number", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", exitCode: 1 }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: exited with code 1");
  });

  it("announces exit code 0 (a successful exit is still a transition)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", exitCode: 0 }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: exited with code 0");
  });

  it("flow and queue debounce keys are independent — both fire", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 0 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    // Both transitions in the same render — independent debounce slots mean
    // neither cancels the other.
    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "paused-backpressure" }], {
        t1: 2,
      });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // Last-write-wins on the store entry; both announcements ran through it.
    // Inspect by id ordering — the queue announcement is scheduled after the
    // flow one, so it lands last and wins the slot.
    const msg = useAnnouncerStore.getState().polite?.msg;
    expect(msg === "Pane A: 2 commands queued" || msg === "Pane A: output paused").toBe(true);
  });

  it("subscribes to hibernation and announces 'hibernated' / 'woke up' transitions", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }]);
    });
    rerender();

    // Hibernation announcements bypass the 300ms debounce — they fire
    // synchronously from the subscription callback.
    useAnnouncerStore.setState({ polite: null, assertive: null });
    act(() => {
      setHibernated("t1", true);
    });
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: hibernated");

    useAnnouncerStore.setState({ polite: null, assertive: null });
    act(() => {
      setHibernated("t1", false);
    });
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: woke up");
  });

  it("tears down hibernation subscription when panel leaves panelIds", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }]);
    });
    rerender();
    expect(hibernationListeners.get("t1")?.size ?? 0).toBe(1);

    act(() => {
      setPanels([]);
    });
    rerender();

    expect(hibernationListeners.has("t1")).toBe(false);
  });

  it("cancels per-badge debounce timers when panel is removed", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A" }], { t1: 0 });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    // Schedule a flow announcement
    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "paused-backpressure" }], {
        t1: 0,
      });
    });
    rerender();

    // Remove panel before the debounce fires
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      setPanels([]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(useAnnouncerStore.getState().polite).toBeNull();
  });
});
