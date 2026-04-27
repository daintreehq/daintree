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

  it("updateNotification does not bump contentKey for non-message patches", () => {
    const id = addToast({ message: "msg" });
    const initial = useNotificationStore.getState().notifications.find((x) => x.id === id)!;
    expect(initial.contentKey).toBe(1);

    useNotificationStore.getState().updateNotification(id, { title: "new-title" });
    expect(useNotificationStore.getState().notifications.find((x) => x.id === id)!.contentKey).toBe(
      1
    );

    useNotificationStore.getState().updateNotification(id, { message: "msg" }); // unchanged
    expect(useNotificationStore.getState().notifications.find((x) => x.id === id)!.contentKey).toBe(
      1
    );

    useNotificationStore.getState().updateNotification(id, { message: "new-msg" });
    expect(useNotificationStore.getState().notifications.find((x) => x.id === id)!.contentKey).toBe(
      2
    );
  });

  it("updateNotification preserves firstShownAt even when patch tries to overwrite it", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const id = addToast({ message: "m" });
    const initial = useNotificationStore.getState().notifications.find((x) => x.id === id)!;
    expect(initial.firstShownAt).toBe(1000);

    vi.spyOn(Date, "now").mockReturnValue(5000);
    useNotificationStore
      .getState()
      .updateNotification(id, { firstShownAt: 9999, message: "changed" });

    const after = useNotificationStore.getState().notifications.find((x) => x.id === id)!;
    expect(after.firstShownAt).toBe(1000);
    expect(after.updatedAt).toBe(5000);
  });

  it("updateNotification resets firstShownAt when promoting duration:0 to auto-dismiss", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const id = addToast({ message: "Copying…", duration: 0 });
    expect(
      useNotificationStore.getState().notifications.find((x) => x.id === id)!.firstShownAt
    ).toBe(1000);

    // Long-running async operation completes 30s later; toast is promoted.
    vi.spyOn(Date, "now").mockReturnValue(31000);
    useNotificationStore.getState().updateNotification(id, { message: "Done", duration: 3000 });

    const after = useNotificationStore.getState().notifications.find((x) => x.id === id)!;
    expect(after.firstShownAt).toBe(31000);
  });

  it("updateNotification does NOT reset firstShownAt when patching auto-dismiss → auto-dismiss", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const id = addToast({ message: "m", duration: 3000 });
    expect(
      useNotificationStore.getState().notifications.find((x) => x.id === id)!.firstShownAt
    ).toBe(1000);

    vi.spyOn(Date, "now").mockReturnValue(2000);
    useNotificationStore.getState().updateNotification(id, { message: "m2", duration: 5000 });

    const after = useNotificationStore.getState().notifications.find((x) => x.id === id)!;
    expect(after.firstShownAt).toBe(1000);
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

  it("collapse never fires markUnseenAsToast — no history demotion when merging into a live toast", () => {
    const h1 = addHistoryEntry(true);
    addToast({ correlationId: "entity-a", historyEntryId: h1 });
    addToast({ correlationId: "entity-a" });
    addToast({ correlationId: "entity-a" });

    const spy = vi.spyOn(useNotificationHistoryStore.getState(), "markUnseenAsToast");
    addToast({ correlationId: "entity-a" });
    addToast({ correlationId: "entity-a" });

    expect(spy).not.toHaveBeenCalled();
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
  });

  it("mixed entity/entity-less burst — collapse preserves 3 cap slots and does not evict unrelated", () => {
    // A1, B1, A2, C1 — all three slots stay, A collapses, count=2 on A.
    addToast({ correlationId: "entity-a", message: "a-1" });
    addToast({ correlationId: "entity-b", message: "b-1" });
    addToast({ correlationId: "entity-a", message: "a-2" });
    addToast({ correlationId: "entity-c", message: "c-1" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications.filter((n) => n.dismissed)).toHaveLength(0);

    const byCorr = notifications.reduce(
      (acc, n) => {
        acc[n.correlationId!] = n;
        return acc;
      },
      {} as Record<string, Notification>
    );
    expect(byCorr["entity-a"]!.message).toBe("a-2");
    expect(byCorr["entity-a"]!.count).toBe(2);
    expect(byCorr["entity-b"]!.count).toBeUndefined();
    expect(byCorr["entity-c"]!.count).toBeUndefined();
  });

  it("five collapses of the same entity still show one toast and a monotonically increasing count", () => {
    for (let i = 0; i < 5; i++) {
      addToast({ correlationId: "entity-a", message: `m-${i}` });
    }

    const active = useNotificationStore.getState().notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(1);
    expect(active[0]!.count).toBe(5);
    expect(active[0]!.message).toBe("m-4");
  });

  it("empty actions array on incoming payload is treated as 'no actions' (preserves existing)", () => {
    const id = addToast({
      correlationId: "entity-a",
      message: "m",
      actions: [{ label: "Retry", onClick: () => {} }],
    });

    addToast({ correlationId: "entity-a", message: "m2", actions: [] });

    const n = useNotificationStore.getState().notifications.find((x) => x.id === id)!;
    expect(n.actions).toHaveLength(1);
    expect(n.actions![0]!.label).toBe("Retry");
  });

  it("collapse does not re-trigger FIFO even when the cap is at the edge", () => {
    // Fill the cap with three distinct entities
    addToast({ correlationId: "entity-a", message: "a" });
    addToast({ correlationId: "entity-b", message: "b" });
    addToast({ correlationId: "entity-c", message: "c" });

    // Another entity-a collapses — no FIFO eviction even though cap is already full.
    addToast({ correlationId: "entity-a", message: "a-updated" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications.filter((n) => n.dismissed)).toHaveLength(0);
    expect(notifications).toHaveLength(3);
  });
});
