// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

type NotifyPayload = {
  type: "warning";
  priority: "low";
  placement: "grid-bar";
  title: string;
  message: string;
  supersedeKey: string;
};

// Stands in for `notify()`'s grid-bar path: an inbox row plus a live row that
// links to it, written to the real stores the grid bar and inbox read.
const notifyMock = vi.fn((payload: NotifyPayload) => {
  const historyEntryId = useNotificationHistoryStore.getState().addEntry({
    type: payload.type,
    title: payload.title,
    message: payload.message,
    supersedeKey: payload.supersedeKey,
  });
  return useNotificationStore.getState().addNotification({ ...payload, historyEntryId });
});
vi.mock("@/lib/notify", () => ({
  notify: (payload: NotifyPayload) => notifyMock(payload),
}));

import {
  clearTerminalStallEscalation,
  reportTerminalStallEscalated,
  __resetTerminalStallNoticeForTests,
} from "../terminalStallNotice";

function liveGridBar() {
  return useNotificationStore
    .getState()
    .notifications.filter((n) => n.placement === "grid-bar" && !n.dismissed);
}

function inboxMessage(id: string | undefined): string | undefined {
  const entry = useNotificationHistoryStore.getState().entries.find((e) => e.id === id);
  return typeof entry?.message === "string" ? entry.message : undefined;
}

beforeEach(() => {
  __resetTerminalStallNoticeForTests();
  useNotificationStore.getState().reset();
  useNotificationHistoryStore.setState({ entries: [] });
  notifyMock.mockClear();
});

describe("terminalStallNotice", () => {
  it("posts one notice for four stalled terminals and counts them in it", () => {
    for (const id of ["t1", "t2", "t3", "t4"]) reportTerminalStallEscalated(id);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const rows = liveGridBar();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toContain("4 terminals");
    expect(inboxMessage(rows[0]!.historyEntryId)).toContain("4 terminals");
  });

  it("counts each terminal once however often it reports", () => {
    reportTerminalStallEscalated("t1");
    reportTerminalStallEscalated("t2");
    reportTerminalStallEscalated("t2");

    expect(liveGridBar()[0]!.message).toContain("2 terminals");
  });

  it("keeps the count current as terminals recover", () => {
    reportTerminalStallEscalated("t1");
    reportTerminalStallEscalated("t2");
    reportTerminalStallEscalated("t3");
    clearTerminalStallEscalation("t2");

    expect(liveGridBar()[0]!.message).toContain("2 terminals");
    clearTerminalStallEscalation("t3");
    expect(liveGridBar()[0]!.message).not.toContain("terminals");
  });

  it("removes the notice once every terminal has recovered", () => {
    reportTerminalStallEscalated("t1");
    reportTerminalStallEscalated("t2");
    clearTerminalStallEscalation("t1");
    expect(liveGridBar()).toHaveLength(1);

    clearTerminalStallEscalation("t2");
    expect(liveGridBar()).toHaveLength(0);
  });

  it("stays dismissed when more terminals stall in the same incident", () => {
    reportTerminalStallEscalated("t1");
    // The grid bar's dismiss hard-removes the row.
    useNotificationStore.getState().removeNotification(liveGridBar()[0]!.id);

    reportTerminalStallEscalated("t2");
    reportTerminalStallEscalated("t3");
    clearTerminalStallEscalation("t1");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(liveGridBar()).toHaveLength(0);
  });

  it("posts again for a stall after the previous incident ended", () => {
    reportTerminalStallEscalated("t1");
    useNotificationStore.getState().removeNotification(liveGridBar()[0]!.id);
    clearTerminalStallEscalation("t1");

    reportTerminalStallEscalated("t2");

    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(liveGridBar()).toHaveLength(1);
  });

  it("ignores a clear for a terminal that never escalated", () => {
    reportTerminalStallEscalated("t1");
    clearTerminalStallEscalation("t9");

    expect(liveGridBar()).toHaveLength(1);
  });
});
