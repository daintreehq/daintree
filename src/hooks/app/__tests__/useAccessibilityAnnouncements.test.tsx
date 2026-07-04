// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { PanelLocation, TerminalFlowStatus } from "@shared/types/panel";

interface Terminal {
  id: string;
  title: string;
  kind?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  stateChangeConfidence?: number;
  // FUTURE_SAB: widened to `TerminalFlowStatus` (not `PersistableFlowStatus`)
  // so the suspended-flow tests can drive the formatter with a skeleton
  // value (#9900). In production the panel's flowStatus is always
  // `PersistableFlowStatus`; the wider type here is purely so the test
  // fixture matches the formatter's accepted input.
  flowStatus?: TerminalFlowStatus;
  exitCode?: number;
  location?: PanelLocation;
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
      maximizedId: string | null;
    }>(() => ({
      focusedId: null,
      panelsById: {},
      panelIds: [],
      commandQueueCountById: {},
      maximizedId: null,
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

function setMaximizedId(maximizedId: string | null) {
  panelMockStore.setState({ maximizedId });
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

  it("announces the classified waiting reason instead of the generic phrasing", () => {
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
      setPanels([{ id: "t1", title: "Agent A", agentState: "waiting", waitingReason: "approval" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Agent A is waiting for approval");
  });

  it("keeps the generic waiting phrasing for the prompt fallback", () => {
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
      setPanels([{ id: "t1", title: "Agent A", agentState: "waiting", waitingReason: "prompt" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Agent A is waiting for input");
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

  // FUTURE_SAB: `suspended` is a skeleton value with no production
  // producer (#9900). The formatter accepts the full union and emits the
  // message; in production the formatter never sees this value because
  // the lifecycle listener drops it at the boundary.
  it("announces flow status entering 'suspended' (FUTURE_SAB; #9900)", () => {
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

  it("announces flow status resuming back to 'running' (IPC resume signal)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "paused-backpressure" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    // In production the IPC resume signal flips flowStatus to "running",
    // not undefined. The badge UI hides because it gates on specific paused
    // values, so the announcer must treat "running" as the resume edge.
    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "running" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: output resumed");
  });

  // FUTURE_SAB: `suspended` is a skeleton value (#9900); the resume
  // edge in the formatter is exercised here for the future state.
  it("announces resume from 'suspended' to 'running' (FUTURE_SAB; #9900)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "suspended" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "running" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A: output resumed");
  });

  it("does NOT announce 'resumed' when transitioning 'running' → 'running'", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "running" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", flowStatus: "running" }]);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(useAnnouncerStore.getState().polite).toBeNull();
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

// #9932 — panel location changes (minimize → dock, restore → grid) and
// maximize/unmaximize were silent to screen readers. They now route through the
// global announcer immediately (discrete user actions — no debounce).
describe("useAccessibilityAnnouncements — location and maximize announcements (#9932)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    panelMockStore.setState({
      focusedId: null,
      panelsById: {},
      panelIds: [],
      commandQueueCountById: {},
      maximizedId: null,
    });
    hibernationState.clear();
    hibernationListeners.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces 'minimized to dock' on a grid → dock transition", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "dock" }]);
    });
    rerender();

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A minimized to dock");
  });

  it("announces 'restored to grid' on a dock → grid transition", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "dock" }]);
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
    });
    rerender();

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A restored to grid");
  });

  it("announces location changes immediately without debounce", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "dock" }]);
    });
    rerender();

    // No timer advance — the announcement is already present.
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A minimized to dock");
  });

  it("announces location changes for non-PTY panels (browser/dev-preview/review)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      panelMockStore.setState({
        focusedId: null,
        panelsById: { b1: { id: "b1", title: "Preview", kind: "browser", location: "grid" } },
        panelIds: ["b1"],
        commandQueueCountById: {},
      });
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      panelMockStore.setState({
        panelsById: { b1: { id: "b1", title: "Preview", kind: "browser", location: "dock" } },
      });
    });
    rerender();

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Preview minimized to dock");
  });

  it("does not announce on first mount with a location set", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
    });
    rerender();

    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("does not announce for internal locations (overlay, background, trash)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    for (const dest of ["overlay", "background", "trash"] as const) {
      act(() => {
        setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
      });
      rerender();
      useAnnouncerStore.setState({ polite: null, assertive: null });

      act(() => {
        setPanels([{ id: "t1", title: "Pane A", location: dest }]);
      });
      rerender();
      expect(useAnnouncerStore.getState().polite).toBeNull();
    }

    // dock → trash is also silent (only dock → grid is reported).
    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "dock" }]);
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "trash" }]);
    });
    rerender();
    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("announces 'maximized' when maximizedId goes null → id", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setMaximizedId("t1");
    });
    rerender();

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A maximized");
  });

  it("announces 'unmaximized' when maximizedId goes id → null", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
      setMaximizedId("t1");
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setMaximizedId(null);
    });
    rerender();

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane A unmaximized");
  });

  it("does not announce on first mount when nothing is maximized", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
    });
    rerender();

    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("does not announce on first mount when a panel is already maximized", () => {
    act(() => {
      setMaximizedId("t1");
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
    });

    const { rerender } = renderHook(() => useAccessibilityAnnouncements());
    rerender();

    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("announces only the new panel on an in-group representative switch (t1 → t2)", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([
        { id: "t1", title: "Pane A", location: "grid" },
        { id: "t2", title: "Pane B", location: "grid" },
      ]);
      setMaximizedId("t1");
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setMaximizedId("t2");
    });
    rerender();

    // The group is still maximized; only the new representative is announced —
    // no spurious "Pane A unmaximized".
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Pane B maximized");
  });

  it("falls back to a generic title when the panel was removed before unmaximize", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([{ id: "t1", title: "Pane A", location: "grid" }]);
      setMaximizedId("t1");
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    act(() => {
      setPanels([]);
      setMaximizedId(null);
    });
    rerender();

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Panel unmaximized");
  });

  it("does not re-announce maximize when an unrelated panel updates", () => {
    const { rerender } = renderHook(() => useAccessibilityAnnouncements());

    act(() => {
      setPanels([
        { id: "t1", title: "Pane A", location: "grid" },
        { id: "t2", title: "Pane B", location: "grid" },
      ]);
      setMaximizedId("t1");
    });
    rerender();
    useAnnouncerStore.setState({ polite: null, assertive: null });

    // Update an unrelated panel's title while t1 stays maximized.
    act(() => {
      setPanels([
        { id: "t1", title: "Pane A", location: "grid" },
        { id: "t2", title: "Pane B renamed", location: "grid" },
      ]);
      setMaximizedId("t1");
    });
    rerender();

    expect(useAnnouncerStore.getState().polite).toBeNull();
  });
});
