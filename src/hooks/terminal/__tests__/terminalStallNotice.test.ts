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
// links to it, written to the real stores the grid bar and inbox read. Quiet
// hours write the inbox row and return "" without a live row.
let quiet = false;
const notifyMock = vi.fn((payload: NotifyPayload) => {
  const historyEntryId = useNotificationHistoryStore.getState().addEntry({
    type: payload.type,
    title: payload.title,
    message: payload.message,
    supersedeKey: payload.supersedeKey,
  });
  if (quiet) return "";
  return useNotificationStore.getState().addNotification({ ...payload, historyEntryId });
});
vi.mock("@/lib/notify", () => ({
  notify: (payload: NotifyPayload) => notifyMock(payload),
}));

let currentProjectId = "p1";
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: currentProjectId } }) },
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

function activeInboxRows() {
  return useNotificationHistoryStore.getState().entries.filter((e) => !e.archivedAt);
}

beforeEach(() => {
  __resetTerminalStallNoticeForTests();
  useNotificationStore.getState().reset();
  useNotificationHistoryStore.setState({ entries: [] });
  notifyMock.mockClear();
  quiet = false;
  currentProjectId = "p1";
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
    reportTerminalStallEscalated("t1");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(liveGridBar()).toHaveLength(1);
    expect(activeInboxRows()).toHaveLength(1);

    reportTerminalStallEscalated("t2");
    reportTerminalStallEscalated("t2");
    expect(liveGridBar()[0]!.message).toContain("2 terminals");
  });

  it("keeps the bar and inbox counts current as terminals recover", () => {
    reportTerminalStallEscalated("t1");
    reportTerminalStallEscalated("t2");
    reportTerminalStallEscalated("t3");
    const single = liveGridBar()[0]!;
    clearTerminalStallEscalation("t2");

    expect(liveGridBar()[0]!.message).toContain("2 terminals");
    expect(inboxMessage(single.historyEntryId)).toContain("2 terminals");

    clearTerminalStallEscalation("t3");
    const singular = liveGridBar()[0]!.message;
    expect(singular).toContain("Use Retry in the terminal");
    expect(inboxMessage(single.historyEntryId)).toBe(singular);
  });

  it("removes only its own notice once every terminal has recovered", () => {
    const unrelated = useNotificationStore.getState().addNotification({
      type: "info",
      priority: "low",
      placement: "grid-bar",
      message: "Something else",
      context: { eventKind: "recovery" },
    });
    reportTerminalStallEscalated("t1");
    reportTerminalStallEscalated("t2");
    const stallId = liveGridBar().find((n) => n.id !== unrelated)!.id;
    clearTerminalStallEscalation("t1");
    expect(liveGridBar()).toHaveLength(2);

    clearTerminalStallEscalation("t2");
    const ids = useNotificationStore.getState().notifications.map((n) => n.id);
    expect(ids).toEqual([unrelated]);
    expect(ids).not.toContain(stallId);
  });

  it("stays dismissed when more terminals stall in the same incident", () => {
    reportTerminalStallEscalated("t1");
    // The grid bar's dismiss hard-removes the row.
    useNotificationStore.getState().removeNotification(liveGridBar()[0]!.id);

    reportTerminalStallEscalated("t1");
    reportTerminalStallEscalated("t2");
    reportTerminalStallEscalated("t3");
    clearTerminalStallEscalation("t1");
    clearTerminalStallEscalation("t2");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(liveGridBar()).toHaveLength(0);
  });

  it("keeps the inbox count current after the bar was dismissed", () => {
    reportTerminalStallEscalated("t1");
    const { id, historyEntryId } = liveGridBar()[0]!;
    useNotificationStore.getState().removeNotification(id);

    reportTerminalStallEscalated("t2");
    reportTerminalStallEscalated("t3");

    expect(inboxMessage(historyEntryId)).toContain("3 terminals");
  });

  it("counts in the inbox row when quiet hours kept the bar from showing", () => {
    quiet = true;
    for (const id of ["t1", "t2", "t3", "t4"]) reportTerminalStallEscalated(id);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(liveGridBar()).toHaveLength(0);
    const rows = activeInboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toContain("4 terminals");

    for (const id of ["t1", "t2", "t3", "t4"]) clearTerminalStallEscalation(id);
    quiet = false;
    reportTerminalStallEscalated("t5");
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(liveGridBar()).toHaveLength(1);
  });

  it("leaves another project's active stall row alone", () => {
    currentProjectId = "p2";
    reportTerminalStallEscalated("other-window-terminal");
    const otherRow = activeInboxRows()[0]!;
    // That project's incident lives in another view; this module only shares the inbox with it.
    __resetTerminalStallNoticeForTests();

    currentProjectId = "p1";
    reportTerminalStallEscalated("t1");
    reportTerminalStallEscalated("t2");

    const other = useNotificationHistoryStore.getState().entries.find((e) => e.id === otherRow.id)!;
    expect(other.archivedAt).toBeNull();
    expect(other.message).toBe(otherRow.message);
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
