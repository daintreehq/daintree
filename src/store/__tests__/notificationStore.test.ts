import { describe, it, expect, beforeEach } from "vitest";
import { useNotificationStore, MAX_VISIBLE_TOASTS, type Notification } from "../notificationStore";
import { useNotificationHistoryStore } from "../slices/notificationHistorySlice";

const { getState } = useNotificationStore;

function addToast(overrides: Partial<Omit<Notification, "id">> = {}): string {
  return getState().addNotification({
    type: "info",
    priority: "high",
    message: overrides.message ?? "Test toast",
    ...overrides,
  });
}

describe("notificationStore — toast cap", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
  });

  it("exports MAX_VISIBLE_TOASTS as 3", () => {
    expect(MAX_VISIBLE_TOASTS).toBe(3);
  });

  it("allows up to MAX_VISIBLE_TOASTS active toasts", () => {
    addToast({ message: "toast-1" });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });

    const active = getState().notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(3);
  });

  it("displaces oldest toast when adding beyond the cap", () => {
    const id1 = addToast({ message: "toast-1" });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });
    addToast({ message: "toast-4" });

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(4);

    const displaced = notifications.find((n) => n.id === id1);
    expect(displaced?.dismissed).toBe(true);

    const active = notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(3);
    expect(active.map((n) => n.message)).toEqual(["toast-2", "toast-3", "toast-4"]);
  });

  it("does not count dismissed toasts toward the cap", () => {
    const id1 = addToast({ message: "toast-1" });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });

    getState().dismissNotification(id1);

    addToast({ message: "toast-4" });

    const active = getState().notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(3);
    expect(active.map((n) => n.message)).toEqual(["toast-2", "toast-3", "toast-4"]);
  });

  it("does not count grid-bar notifications toward the cap", () => {
    addToast({ message: "grid-1", placement: "grid-bar" });
    addToast({ message: "grid-2", placement: "grid-bar" });
    addToast({ message: "grid-3", placement: "grid-bar" });
    addToast({ message: "grid-4", placement: "grid-bar" });

    addToast({ message: "toast-1" });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });

    const active = getState().notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(7);
  });

  it("adding a grid-bar notification does not displace an active toast", () => {
    addToast({ message: "toast-1" });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });

    addToast({ message: "grid-bar-1", placement: "grid-bar" });

    const active = getState().notifications.filter(
      (n) => !n.dismissed && n.placement !== "grid-bar"
    );
    expect(active).toHaveLength(3);
    expect(active.every((n) => !n.dismissed)).toBe(true);
  });

  it("marks displaced toast's history entry as unseen", () => {
    useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "entry-for-toast-1",
      seenAsToast: true,
    });
    const entryId = useNotificationHistoryStore.getState().entries[0].id;

    addToast({ message: "toast-1", historyEntryId: entryId });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });
    addToast({ message: "toast-4" });

    const entry = useNotificationHistoryStore.getState().entries.find((e) => e.id === entryId);
    expect(entry?.seenAsToast).toBe(false);
  });

  it("increments unreadCount when a displaced toast is marked unseen", () => {
    const entryId = useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "will be displaced",
      seenAsToast: true,
    });
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);

    addToast({ message: "toast-1", historyEntryId: entryId });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });
    addToast({ message: "toast-4" });

    expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
  });

  it("does not crash when displaced toast has no historyEntryId", () => {
    addToast({ message: "toast-1" });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });

    expect(() => addToast({ message: "toast-4" })).not.toThrow();

    const active = getState().notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(3);
  });

  it("handles rapid succession — 5 toasts leaves 3 active", () => {
    for (let i = 0; i < 5; i++) {
      addToast({ message: `toast-${i}` });
    }

    const active = getState().notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(3);
    expect(active.map((n) => n.message)).toEqual(["toast-2", "toast-3", "toast-4"]);
  });
});
