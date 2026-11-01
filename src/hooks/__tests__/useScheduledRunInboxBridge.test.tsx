// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRunInboxItem } from "@shared/types/ipc/scheduledRuns";
import type { ScheduledRun } from "@shared/types/scheduledRuns";

const remote = vi.hoisted(() => ({ value: false }));
const order = vi.hoisted(() => [] as string[]);

vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => remote.value }));
vi.mock("@/store/slices/notificationHistorySlice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/slices/notificationHistorySlice")>();
  return {
    ...actual,
    flushNotificationHistory: () => {
      order.push("flush");
      actual.flushNotificationHistory();
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

const takeInbox = vi.fn<() => Promise<ScheduledRunInboxItem[]>>();
const ackInbox = vi.fn<(payload: { runIds: string[] }) => Promise<void>>();

beforeEach(() => {
  remote.value = false;
  order.length = 0;
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0, snoozedThreads: {} });
  takeInbox.mockReset();
  ackInbox.mockReset().mockImplementation(async () => {
    order.push("ack");
  });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { scheduledRuns: { takeInbox, ackInbox } },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

const entryIds = () => useNotificationHistoryStore.getState().entries.map((e) => e.id);

describe("useScheduledRunInboxBridge", () => {
  it("waits for the view's state, then files each run unread and acks once it's stored", async () => {
    takeInbox.mockResolvedValue([item("run-1"), item("run-2")]);
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

  it("files a run handed over twice once", async () => {
    takeInbox.mockResolvedValue([item("run-1")]);
    const first = renderHook(() => useScheduledRunInboxBridge(true));
    await vi.waitFor(() => expect(ackInbox).toHaveBeenCalledTimes(1));
    first.unmount();

    renderHook(() => useScheduledRunInboxBridge(true));
    await vi.waitFor(() => expect(ackInbox).toHaveBeenCalledTimes(2));
    expect(entryIds()).toEqual([scheduledRunInboxEntryId("run-1")]);
  });

  it("leaves the runs with main when the view goes before they arrive", async () => {
    let hand!: (items: ScheduledRunInboxItem[]) => void;
    takeInbox.mockReturnValue(new Promise((resolve) => (hand = resolve)));
    const { unmount } = renderHook(() => useScheduledRunInboxBridge(true));
    unmount();
    hand([item("run-1")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(entryIds()).toEqual([]);
    expect(ackInbox).not.toHaveBeenCalled();
  });

  it("acks nothing when it couldn't take the runs, and takes none in a remote host's window", async () => {
    takeInbox.mockRejectedValueOnce(new Error("main gone"));
    renderHook(() => useScheduledRunInboxBridge(true));
    await vi.waitFor(() => expect(takeInbox).toHaveBeenCalledTimes(1));
    expect(ackInbox).not.toHaveBeenCalled();

    remote.value = true;
    renderHook(() => useScheduledRunInboxBridge(true));
    expect(takeInbox).toHaveBeenCalledTimes(1);
  });
});
