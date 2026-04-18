// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VISIBLE_TOASTS, useNotificationStore, type Notification } from "../notificationStore";
import { useNotificationHistoryStore } from "../slices/notificationHistorySlice";

let uuidCounter = 0;

beforeEach(() => {
  uuidCounter = 0;
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn(() => `uuid-${++uuidCounter}`),
  });
  vi.spyOn(Date, "now").mockReturnValue(1000);
  useNotificationStore.setState({ notifications: [] });
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useNotificationStore.setState({ notifications: [] });
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
});

function addHistoryEntry(seenAsToast: boolean): string {
  return useNotificationHistoryStore.getState().addEntry({
    type: "info",
    message: "m",
    seenAsToast,
  });
}

function addToast(overrides: Partial<Omit<Notification, "id">> = {}) {
  return useNotificationStore.getState().addNotification({
    type: "info",
    priority: "low",
    message: "m",
    ...overrides,
  });
}

describe("notificationStore adversarial", () => {
  it("overflow demotes the oldest toast once per add and marks its history entry unseen", () => {
    const h1 = addHistoryEntry(true);
    const h2 = addHistoryEntry(true);
    const h3 = addHistoryEntry(true);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);

    addToast({ historyEntryId: h1 });
    addToast({ historyEntryId: h2 });
    addToast({ historyEntryId: h3 });

    // 3 toasts, all active — no displacement yet.
    const state = useNotificationStore.getState();
    expect(state.notifications.filter((n) => !n.dismissed)).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);

    addToast({ historyEntryId: "h-new" });

    const dismissedIds = useNotificationStore
      .getState()
      .notifications.filter((n) => n.dismissed)
      .map((n) => n.historyEntryId);
    expect(dismissedIds).toEqual([h1]);
    const h1Entry = useNotificationHistoryStore.getState().entries.find((e) => e.id === h1);
    expect(h1Entry?.seenAsToast).toBe(false);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
  });

  it("repeated overflow demotes a different history entry each time", () => {
    const h1 = addHistoryEntry(true);
    const h2 = addHistoryEntry(true);
    const h3 = addHistoryEntry(true);
    const h4 = addHistoryEntry(true);
    const h5 = addHistoryEntry(true);

    addToast({ historyEntryId: h1 });
    addToast({ historyEntryId: h2 });
    addToast({ historyEntryId: h3 });
    addToast({ historyEntryId: h4 });
    addToast({ historyEntryId: h5 });

    const hStore = useNotificationHistoryStore.getState();
    const unseen = hStore.entries.filter((e) => !e.seenAsToast).map((e) => e.id);
    expect(unseen.sort()).toEqual([h1, h2].sort());
    expect(hStore.unreadCount).toBe(2);
  });

  it("grid-bar notifications never participate in toast cap demotion", () => {
    const h1 = addHistoryEntry(true);
    addToast({ historyEntryId: h1 });
    addToast({ historyEntryId: "h-x" });
    addToast({ historyEntryId: "h-y" });

    addToast({ placement: "grid-bar", historyEntryId: "h-bar" });
    addToast({ placement: "grid-bar", historyEntryId: "h-bar2" });

    const dismissed = useNotificationStore.getState().notifications.filter((n) => n.dismissed);
    expect(dismissed).toHaveLength(0);
    const entry1 = useNotificationHistoryStore.getState().entries.find((e) => e.id === h1);
    expect(entry1?.seenAsToast).toBe(true);
  });

  it("updateNotification merges patch and bumps updatedAt without clobbering unrelated fields", () => {
    const id = addToast({
      title: "orig",
      message: "orig-msg",
      correlationId: "corr-1",
    });
    vi.spyOn(Date, "now").mockReturnValue(2000);

    useNotificationStore.getState().updateNotification(id, { title: "new", dismissed: true });

    const n = useNotificationStore.getState().notifications.find((x) => x.id === id);
    expect(n?.title).toBe("new");
    expect(n?.dismissed).toBe(true);
    expect(n?.message).toBe("orig-msg");
    expect(n?.correlationId).toBe("corr-1");
    expect(n?.updatedAt).toBe(2000);
  });

  it("updateNotification on a missing id is a pure no-op", () => {
    const id = addToast({ title: "keep" });
    const before = JSON.parse(JSON.stringify(useNotificationStore.getState().notifications));

    useNotificationStore.getState().updateNotification("does-not-exist", { title: "changed" });

    const after = JSON.parse(JSON.stringify(useNotificationStore.getState().notifications));
    expect(after).toEqual(before);
    expect(after.find((n: Notification) => n.id === id)?.title).toBe("keep");
  });

  it("removeNotification on a missing id is a pure no-op", () => {
    const id = addToast({ title: "stay" });
    useNotificationStore.getState().removeNotification("does-not-exist");

    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0]!.id).toBe(id);
  });

  it("clearNotifications and reset clear toasts but not history", () => {
    addHistoryEntry(false);
    addHistoryEntry(false);
    addToast();
    addToast();

    useNotificationStore.getState().clearNotifications();

    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(2);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(2);

    addToast();
    useNotificationStore.getState().reset();

    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(2);
  });

  it("dismissNotification flips only the dismissed flag, leaves others intact", () => {
    const id = addToast({ title: "t" });
    useNotificationStore.getState().dismissNotification(id);

    const n = useNotificationStore.getState().notifications.find((x) => x.id === id);
    expect(n?.dismissed).toBe(true);
    expect(n?.title).toBe("t");
  });

  it("dismissNotification on missing id is a pure no-op", () => {
    const id = addToast({ title: "t" });
    useNotificationStore.getState().dismissNotification("missing");
    const n = useNotificationStore.getState().notifications.find((x) => x.id === id);
    expect(n?.dismissed).toBeFalsy();
  });

  it("overflow without historyEntryId on the displaced toast does not call markUnseenAsToast", () => {
    addToast();
    addToast();
    addToast();

    const spy = vi.spyOn(useNotificationHistoryStore.getState(), "markUnseenAsToast");
    addToast();

    expect(spy).not.toHaveBeenCalled();
  });
});
