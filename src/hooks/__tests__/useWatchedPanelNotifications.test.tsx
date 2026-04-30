// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetState, mockSubscribe, fireWatchNotificationMock } = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockSubscribe: vi.fn(),
  fireWatchNotificationMock: vi.fn(),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: Object.assign(vi.fn(), {
    getState: mockGetState,
    subscribe: mockSubscribe,
  }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ setActiveWorktree: vi.fn() })),
  }),
}));

vi.mock("@/lib/watchNotification", () => ({
  fireWatchNotification: fireWatchNotificationMock,
}));

import {
  MAX_STAGGER_QUEUE_LENGTH,
  applyStaggerQueueCap,
  useWatchedPanelNotifications,
} from "../useWatchedPanelNotifications";

type TerminalShape = {
  id: string;
  agentState?: string;
  location?: string;
  title?: string;
};

type PanelStoreState = {
  watchedPanels: Set<string>;
  panelsById: Record<string, TerminalShape>;
  panelIds: string[];
  unwatchPanel: ReturnType<typeof vi.fn>;
  setFocused: ReturnType<typeof vi.fn>;
};

function buildState(
  terminals: TerminalShape[],
  watchedIds: string[] = terminals.map((t) => t.id)
): PanelStoreState {
  return {
    watchedPanels: new Set(watchedIds),
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
    unwatchPanel: vi.fn(),
    setFocused: vi.fn(),
  };
}

describe("applyStaggerQueueCap", () => {
  it("returns false and leaves the queue untouched when under the cap", () => {
    const queue = Array.from(
      { length: MAX_STAGGER_QUEUE_LENGTH - 1 },
      (_, i) => (): void => void i
    );
    const initialFirst = queue[0];
    const initialLength = queue.length;

    const dropped = applyStaggerQueueCap(queue);

    expect(dropped).toBe(false);
    expect(queue.length).toBe(initialLength);
    expect(queue[0]).toBe(initialFirst);
  });

  it("drops the oldest entry and returns true when the queue is at the cap", () => {
    const queue = Array.from({ length: MAX_STAGGER_QUEUE_LENGTH }, (_, i) => (): number => i);
    const originalFirst = queue[0];
    const originalSecond = queue[1];

    const dropped = applyStaggerQueueCap(queue);

    expect(dropped).toBe(true);
    expect(queue.length).toBe(MAX_STAGGER_QUEUE_LENGTH - 1);
    expect(queue).not.toContain(originalFirst);
    expect(queue[0]).toBe(originalSecond);
  });

  it("drops the oldest each call when invoked repeatedly past the cap", () => {
    const queue = Array.from({ length: MAX_STAGGER_QUEUE_LENGTH + 5 }, (_, i) => (): number => i);
    const firstThree = queue.slice(0, 3);

    applyStaggerQueueCap(queue);
    applyStaggerQueueCap(queue);
    applyStaggerQueueCap(queue);

    expect(queue.length).toBe(MAX_STAGGER_QUEUE_LENGTH + 2);
    for (const dropped of firstThree) {
      expect(queue).not.toContain(dropped);
    }
  });
});

describe("useWatchedPanelNotifications", () => {
  let subscribers: Array<(state: PanelStoreState) => void>;
  let currentState: PanelStoreState;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    subscribers = [];
    currentState = buildState([]);

    mockGetState.mockImplementation(() => currentState);
    mockSubscribe.mockImplementation((cb: (state: PanelStoreState) => void) => {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    });

    fireWatchNotificationMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    Object.defineProperty(window, "electron", {
      value: {
        notification: {
          syncWatchedPanels: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  function fireUpdate(next: PanelStoreState): void {
    currentState = next;
    // Copy subscribers array to avoid mutation during iteration.
    for (const cb of [...subscribers]) {
      cb(next);
    }
  }

  it("fires a notification and clears the watch when a panel transitions to completed", () => {
    currentState = buildState(
      [{ id: "p1", agentState: "working", location: "grid", title: "Panel 1" }],
      ["p1"]
    );
    renderHook(() => useWatchedPanelNotifications());

    const next = buildState(
      [{ id: "p1", agentState: "completed", location: "grid", title: "Panel 1" }],
      ["p1"]
    );

    act(() => {
      fireUpdate(next);
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(fireWatchNotificationMock).toHaveBeenCalledTimes(1);
    expect(fireWatchNotificationMock).toHaveBeenCalledWith("p1", "Panel 1", "completed");
    expect(next.unwatchPanel).toHaveBeenCalledWith("p1");
  });

  it.each([
    ["waiting" as const, "Agent waiting"],
    ["exited" as const, "Agent exited"],
  ])("fires a notification when a panel transitions to %s", (targetState, title) => {
    currentState = buildState(
      [{ id: "p1", agentState: "working", location: "grid", title }],
      ["p1"]
    );
    renderHook(() => useWatchedPanelNotifications());

    act(() => {
      fireUpdate(
        buildState([{ id: "p1", agentState: targetState, location: "grid", title }], ["p1"])
      );
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(fireWatchNotificationMock).toHaveBeenCalledTimes(1);
    expect(fireWatchNotificationMock).toHaveBeenCalledWith("p1", title, targetState);
  });

  it("ignores transitions that are not completed/waiting/exited", () => {
    currentState = buildState(
      [{ id: "p1", agentState: "idle", location: "grid", title: "Panel 1" }],
      ["p1"]
    );
    renderHook(() => useWatchedPanelNotifications());

    act(() => {
      fireUpdate(
        buildState(
          [{ id: "p1", agentState: "working", location: "grid", title: "Panel 1" }],
          ["p1"]
        )
      );
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(fireWatchNotificationMock).not.toHaveBeenCalled();
  });

  it("skips notifications for trashed panels and unwatches them", () => {
    currentState = buildState(
      [{ id: "p1", agentState: "working", location: "grid", title: "Panel 1" }],
      ["p1"]
    );
    renderHook(() => useWatchedPanelNotifications());

    const next = buildState(
      [{ id: "p1", agentState: "completed", location: "trash", title: "Panel 1" }],
      ["p1"]
    );

    act(() => {
      fireUpdate(next);
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(fireWatchNotificationMock).not.toHaveBeenCalled();
    expect(next.unwatchPanel).toHaveBeenCalledWith("p1");
  });

  it("does not emit an overflow warning under a normal-sized burst", () => {
    const workingPanels: TerminalShape[] = Array.from(
      { length: MAX_STAGGER_QUEUE_LENGTH },
      (_, i) => ({
        id: `p${i}`,
        agentState: "working",
        location: "grid",
        title: `Panel ${i}`,
      })
    );
    const watchedIds = workingPanels.map((p) => p.id);
    currentState = buildState(workingPanels, watchedIds);
    renderHook(() => useWatchedPanelNotifications());

    const completedPanels = workingPanels.map((p) => ({ ...p, agentState: "completed" }));

    act(() => {
      fireUpdate(buildState(completedPanels, watchedIds));
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fireWatchNotificationMock).toHaveBeenCalledTimes(MAX_STAGGER_QUEUE_LENGTH);
  });

  it("tears down all subscriptions on unmount", () => {
    const { unmount } = renderHook(() => useWatchedPanelNotifications());

    // Two internal subscribe() calls are expected: watchedPanels sync + agent state.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(subscribers.length).toBe(2);

    unmount();

    // Unsubscribers returned by mockSubscribe splice their cb out of subscribers.
    expect(subscribers.length).toBe(0);
  });

  it("does not fire notifications after unmount even with subsequent transitions", () => {
    currentState = buildState(
      [{ id: "p1", agentState: "working", location: "grid", title: "Panel 1" }],
      ["p1"]
    );
    const { unmount } = renderHook(() => useWatchedPanelNotifications());

    unmount();

    act(() => {
      fireUpdate(
        buildState(
          [{ id: "p1", agentState: "completed", location: "grid", title: "Panel 1" }],
          ["p1"]
        )
      );
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(fireWatchNotificationMock).not.toHaveBeenCalled();
  });
});
