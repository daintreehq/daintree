// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRunInboxItem, ScheduledRunInboxTake } from "@shared/types/ipc/scheduledRuns";
import type { ScheduledRun } from "@shared/types/scheduledRuns";

const remote = vi.hoisted(() => ({ value: false }));
const order = vi.hoisted(() => [] as string[]);
const storage = vi.hoisted(() => ({ withhold: new Set<string>() }));
const project = vi.hoisted(() => ({ current: { id: "project-1" } as { id: string } | null }));

vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => remote.value }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (select: (state: { currentProject: { id: string } | null }) => unknown) =>
    select({ currentProject: project.current }),
}));
vi.mock("@/store/slices/notificationHistorySlice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/slices/notificationHistorySlice")>();
  return {
    ...actual,
    flushNotificationHistory: () => {
      order.push("flush");
      actual.flushNotificationHistory();
    },
    // What storage holds, less what a test says never reached it.
    notificationHistoryIdsInStorage: () => {
      const ids = actual.notificationHistoryIdsInStorage();
      for (const id of storage.withhold) ids.delete(id);
      return ids;
    },
  };
});

import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useScheduledRunInboxBridge } from "@/hooks/useScheduledRunInboxBridge";
import { scheduledRunInboxEntryId } from "@/components/Schedules/scheduledRunInboxEntry";

const SETTLED = Date.UTC(2026, 10, 1, 2);

function item(id: string): ScheduledRunInboxItem {
  const run: ScheduledRun = {
    id,
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    createdAt: SETTLED,
    terminalId: null,
    terminalSpawnedAt: null,
    settlement: {
      state: "settled",
      settledAt: SETTLED,
      outcome: "failed",
      evidence: { kind: "launch-error", message: "The project's folder is missing." },
    },
    process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
    pane: { state: "none" },
    resume: null,
  };
  return { run, schedule: { name: "Nightly", timeZone: "UTC" } };
}

const take = (items: ScheduledRunInboxItem[], retryInMs: number | null = null) => ({
  items,
  retryInMs,
});

const takeInbox = vi.fn<() => Promise<ScheduledRunInboxTake>>();
const ackInbox = vi.fn<(payload: { runIds: string[] }) => Promise<void>>();
let reveal: (() => void) | null = null;
let park: (() => void) | null = null;
const offRevealed = vi.fn();

beforeEach(() => {
  remote.value = false;
  project.current = { id: "project-1" };
  order.length = 0;
  storage.withhold.clear();
  localStorage.clear();
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0, snoozedThreads: {} });
  takeInbox.mockReset().mockResolvedValue(take([]));
  ackInbox.mockReset().mockImplementation(async () => {
    order.push("ack");
  });
  offRevealed.mockReset();
  reveal = null;
  park = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      scheduledRuns: { takeInbox, ackInbox },
      app: {
        onViewRevealed: (callback: () => void) => {
          reveal = callback;
          return offRevealed;
        },
        onViewCached: (callback: () => void) => {
          park = callback;
          return () => {};
        },
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "electron");
});

const entryIds = () => useNotificationHistoryStore.getState().entries.map((e) => e.id);

describe("useScheduledRunInboxBridge", () => {
  it("waits for the view's state, then files each run unread and acks once storage holds it", async () => {
    takeInbox.mockResolvedValue(take([item("run-1"), item("run-2")]));
    const { rerender } = renderHook(({ loaded }) => useScheduledRunInboxBridge(loaded), {
      initialProps: { loaded: false },
    });
    expect(takeInbox).not.toHaveBeenCalled();

    rerender({ loaded: true });
    await vi.waitFor(() => expect(ackInbox).toHaveBeenCalled());

    expect(entryIds().sort()).toEqual(
      [scheduledRunInboxEntryId("run-1"), scheduledRunInboxEntryId("run-2")].sort()
    );
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(2);
    expect(ackInbox).toHaveBeenCalledWith({ runIds: ["run-1", "run-2"] });
    expect(order).toEqual(["flush", "ack"]);
  });

  it("acks only the runs storage holds, as when the entry cap cut one", async () => {
    storage.withhold.add(scheduledRunInboxEntryId("run-2"));
    takeInbox.mockResolvedValue(take([item("run-1"), item("run-2")]));
    renderHook(() => useScheduledRunInboxBridge(true));

    await vi.waitFor(() => expect(ackInbox).toHaveBeenCalled());
    expect(ackInbox).toHaveBeenCalledExactlyOnceWith({ runIds: ["run-1"] });
  });

  it("writes a run a full storage refused once it's handed over again, then acks it", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    takeInbox.mockResolvedValue(take([item("run-1")]));
    renderHook(() => useScheduledRunInboxBridge(true));
    await vi.waitFor(() => expect(takeInbox).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(order).toContain("flush"));
    expect(ackInbox).not.toHaveBeenCalled();
    expect(entryIds()).toEqual([scheduledRunInboxEntryId("run-1")]);

    setItem.mockRestore();
    act(() => reveal?.());
    await vi.waitFor(() => expect(ackInbox).toHaveBeenCalledWith({ runIds: ["run-1"] }));
    expect(entryIds()).toEqual([scheduledRunInboxEntryId("run-1")]);
  });

  it("leaves runs that arrive while the view is parked for the view on screen", async () => {
    let hand!: (value: ScheduledRunInboxTake) => void;
    takeInbox.mockReturnValueOnce(new Promise((resolve) => (hand = resolve)));
    renderHook(() => useScheduledRunInboxBridge(true));
    act(() => park?.());
    hand(take([item("run-1")]));
    await Promise.resolve();
    await Promise.resolve();
    expect(entryIds()).toEqual([]);
    expect(ackInbox).not.toHaveBeenCalled();

    takeInbox.mockResolvedValueOnce(take([item("run-1")]));
    act(() => reveal?.());
    await vi.waitFor(() => expect(ackInbox).toHaveBeenCalledWith({ runIds: ["run-1"] }));
  });

  it("asks again when shown, and when another view's hold lapses", async () => {
    vi.useFakeTimers();
    // Only timers this test moves: vi.waitFor would advance them as it polls.
    const settle = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    const { unmount } = renderHook(() => useScheduledRunInboxBridge(true));
    await settle();
    expect(takeInbox).toHaveBeenCalledTimes(1);

    takeInbox.mockResolvedValueOnce(take([], 5_000));
    act(() => reveal?.());
    await settle();
    expect(takeInbox).toHaveBeenCalledTimes(2);

    takeInbox.mockResolvedValueOnce(take([item("run-1")]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_999);
    });
    expect(takeInbox).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    expect(ackInbox).toHaveBeenCalledWith({ runIds: ["run-1"] });

    unmount();
    expect(offRevealed).toHaveBeenCalled();
  });

  it("asks once at a time, and once more for a request that came meanwhile", async () => {
    let hand!: (value: ScheduledRunInboxTake) => void;
    takeInbox.mockReturnValueOnce(new Promise((resolve) => (hand = resolve)));
    renderHook(() => useScheduledRunInboxBridge(true));
    act(() => {
      reveal?.();
      reveal?.();
    });
    expect(takeInbox).toHaveBeenCalledTimes(1);

    hand(take([]));
    await vi.waitFor(() => expect(takeInbox).toHaveBeenCalledTimes(2));
  });

  it("leaves the runs with main when the view goes before they arrive", async () => {
    let hand!: (value: ScheduledRunInboxTake) => void;
    takeInbox.mockReturnValue(new Promise((resolve) => (hand = resolve)));
    const { unmount } = renderHook(() => useScheduledRunInboxBridge(true));
    unmount();
    hand(take([item("run-1")]));
    await Promise.resolve();
    await Promise.resolve();

    expect(entryIds()).toEqual([]);
    expect(ackInbox).not.toHaveBeenCalled();
  });

  it("takes none outside a local project's view, and acks nothing when it couldn't take them", async () => {
    project.current = null;
    renderHook(() => useScheduledRunInboxBridge(true));
    remote.value = true;
    project.current = { id: "project-1" };
    renderHook(() => useScheduledRunInboxBridge(true));
    expect(takeInbox).not.toHaveBeenCalled();

    remote.value = false;
    takeInbox.mockRejectedValueOnce(new Error("main gone"));
    renderHook(() => useScheduledRunInboxBridge(true));
    await vi.waitFor(() => expect(takeInbox).toHaveBeenCalledTimes(1));
    expect(ackInbox).not.toHaveBeenCalled();
  });
});
