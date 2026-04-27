import { describe, it, expect, beforeEach, vi } from "vitest";
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
    const entryId = useNotificationHistoryStore.getState().entries[0]!.id;

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

describe("notificationStore — error-protected eviction", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
  });

  it("keeps the error visible when three rapid successes follow it (#5861)", () => {
    const errorId = addToast({ type: "error", message: "boom" });
    const successId1 = addToast({ type: "success", message: "ok-1" });
    addToast({ type: "success", message: "ok-2" });
    addToast({ type: "success", message: "ok-3" });

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(4);

    expect(notifications.find((n) => n.id === errorId)?.dismissed).toBeFalsy();
    expect(notifications.find((n) => n.id === successId1)?.dismissed).toBe(true);

    const active = notifications.filter((n) => !n.dismissed);
    expect(active.map((n) => n.message)).toEqual(["boom", "ok-2", "ok-3"]);
  });

  it("falls back to oldest-first FIFO when every visible toast is an error", () => {
    const id1 = addToast({ type: "error", message: "err-1" });
    addToast({ type: "error", message: "err-2" });
    addToast({ type: "error", message: "err-3" });
    addToast({ type: "error", message: "err-4" });

    const notifications = getState().notifications;
    expect(notifications.find((n) => n.id === id1)?.dismissed).toBe(true);

    const active = notifications.filter((n) => !n.dismissed);
    expect(active.map((n) => n.message)).toEqual(["err-2", "err-3", "err-4"]);
  });

  it("treats warning as evictable (warnings are not protected like errors)", () => {
    const warnId = addToast({ type: "warning", message: "warn" });
    addToast({ type: "info", message: "info-1" });
    addToast({ type: "info", message: "info-2" });
    addToast({ type: "success", message: "ok" });

    const notifications = getState().notifications;
    expect(notifications.find((n) => n.id === warnId)?.dismissed).toBe(true);

    const active = notifications.filter((n) => !n.dismissed);
    expect(active.map((n) => n.message)).toEqual(["info-1", "info-2", "ok"]);
  });

  it("evicts the oldest non-error from a mixed-severity set", () => {
    addToast({ type: "error", message: "err" });
    const warnId = addToast({ type: "warning", message: "warn" });
    addToast({ type: "info", message: "info" });
    addToast({ type: "success", message: "ok" });

    const notifications = getState().notifications;
    expect(notifications.find((n) => n.id === warnId)?.dismissed).toBe(true);

    const active = notifications.filter((n) => !n.dismissed);
    expect(active.map((n) => n.message)).toEqual(["err", "info", "ok"]);
  });

  it("marks the evicted non-error's history entry as unseen even when an error is present", () => {
    const entryId = useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "history-for-info",
      seenAsToast: true,
    });

    addToast({ type: "error", message: "err" });
    addToast({ type: "info", message: "info-1", historyEntryId: entryId });
    addToast({ type: "info", message: "info-2" });
    addToast({ type: "success", message: "ok" });

    const entry = useNotificationHistoryStore.getState().entries.find((e) => e.id === entryId);
    expect(entry?.seenAsToast).toBe(false);
  });

  it("does not invoke onDismiss when a non-error toast is evicted", () => {
    const onDismiss = vi.fn();
    addToast({ type: "error", message: "err" });
    addToast({ type: "info", message: "info-1", onDismiss });
    addToast({ type: "info", message: "info-2" });
    addToast({ type: "success", message: "ok" });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("admits an incoming error by evicting the oldest non-error from a full cap", () => {
    const successId1 = addToast({ type: "success", message: "ok-1" });
    addToast({ type: "success", message: "ok-2" });
    addToast({ type: "success", message: "ok-3" });
    addToast({ type: "error", message: "boom" });

    const notifications = getState().notifications;
    expect(notifications.find((n) => n.id === successId1)?.dismissed).toBe(true);

    const active = notifications.filter((n) => !n.dismissed);
    expect(active.map((n) => n.message)).toEqual(["ok-2", "ok-3", "boom"]);
  });

  it("flips only the evicted toast's history entry — bystanders stay seen", () => {
    const evictedEntry = useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "evicted-history",
      seenAsToast: true,
    });
    const survivorEntry = useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "survivor-history",
      seenAsToast: true,
    });

    addToast({ type: "error", message: "err" });
    addToast({ type: "info", message: "info-1", historyEntryId: evictedEntry });
    addToast({ type: "info", message: "info-2", historyEntryId: survivorEntry });
    addToast({ type: "success", message: "ok" });

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === evictedEntry)?.seenAsToast).toBe(false);
    expect(entries.find((e) => e.id === survivorEntry)?.seenAsToast).toBe(true);
  });

  it("does not invoke onDismiss in the all-errors FIFO fallback path", () => {
    const onDismiss = vi.fn();
    addToast({ type: "error", message: "err-1", onDismiss });
    addToast({ type: "error", message: "err-2" });
    addToast({ type: "error", message: "err-3" });
    addToast({ type: "error", message: "err-4" });

    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("notificationStore — correlationId collapse", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
  });

  it("collapses a same-correlationId toast into the live one and does not add a new entry", () => {
    const id1 = addToast({ message: "first", correlationId: "entity-a" });
    const id2 = addToast({ message: "second", correlationId: "entity-a" });

    // Returned id is the live toast id (not a newly generated one).
    expect(id2).toBe(id1);

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.id).toBe(id1);
    expect(notifications[0]!.message).toBe("second");
    expect(notifications[0]!.count).toBe(2);
  });

  it("increments count across multiple collapses for the same correlationId", () => {
    const id = addToast({ message: "m-1", correlationId: "entity-a" });
    addToast({ message: "m-2", correlationId: "entity-a" });
    addToast({ message: "m-3", correlationId: "entity-a" });
    addToast({ message: "m-4", correlationId: "entity-a" });

    const active = getState().notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(id);
    expect(active[0]!.count).toBe(4);
    expect(active[0]!.message).toBe("m-4");
  });

  it("bumps updatedAt when collapsing so auto-dismiss timers reset", () => {
    const originalNow = Date.now;
    let mockNow = 1000;
    Date.now = () => mockNow;
    try {
      const id = addToast({ correlationId: "entity-a", message: "first" });
      const first = getState().notifications.find((n) => n.id === id)!;
      expect(first.updatedAt).toBe(1000);

      mockNow = 2500;
      addToast({ correlationId: "entity-a", message: "second" });

      const after = getState().notifications.find((n) => n.id === id)!;
      expect(after.updatedAt).toBe(2500);
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not collapse when the prior same-correlationId toast was dismissed", () => {
    const id1 = addToast({ message: "first", correlationId: "entity-a" });
    getState().dismissNotification(id1);

    const id2 = addToast({ message: "second", correlationId: "entity-a" });

    expect(id2).not.toBe(id1);
    const active = getState().notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(1);
    expect(active[0]!.message).toBe("second");
    expect(active[0]!.count).toBeUndefined();
  });

  it("falls back to FIFO eviction when no live correlationId match exists", () => {
    const id1 = addToast({ message: "toast-1" });
    addToast({ message: "toast-2" });
    addToast({ message: "toast-3" });
    addToast({ message: "toast-4", correlationId: "entity-a" });

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(4);

    const displaced = notifications.find((n) => n.id === id1);
    expect(displaced?.dismissed).toBe(true);

    const active = notifications.filter((n) => !n.dismissed);
    expect(active).toHaveLength(3);
    expect(active.map((n) => n.message)).toEqual(["toast-2", "toast-3", "toast-4"]);
  });

  it("does not displace a third unrelated toast when a fourth event collapses onto an existing entity", () => {
    const idA = addToast({ message: "entity-a v1", correlationId: "entity-a" });
    const idB = addToast({ message: "entity-b", correlationId: "entity-b" });
    const idC = addToast({ message: "unrelated-c" });

    // 4th event targets entity-a, which is live — should collapse, NOT evict unrelated-c.
    addToast({ message: "entity-a v2", correlationId: "entity-a" });

    const notifications = getState().notifications;
    expect(notifications.filter((n) => n.dismissed)).toHaveLength(0);

    const active = notifications.filter((n) => !n.dismissed);
    expect(active.map((n) => n.id)).toEqual([idA, idB, idC]);
    expect(notifications.find((n) => n.id === idA)!.message).toBe("entity-a v2");
    expect(notifications.find((n) => n.id === idA)!.count).toBe(2);
  });

  it("preserves existing actions when the incoming payload has no actions", () => {
    const id = addToast({
      correlationId: "entity-a",
      message: "first",
      actions: [{ label: "Retry", onClick: () => {} }],
    });

    addToast({ correlationId: "entity-a", message: "second" });

    const n = getState().notifications.find((x) => x.id === id)!;
    expect(n.actions).toHaveLength(1);
    expect(n.actions![0]!.label).toBe("Retry");
  });

  it("replaces actions when the incoming payload has non-empty actions", () => {
    const id = addToast({
      correlationId: "entity-a",
      message: "first",
      actions: [{ label: "Retry", onClick: () => {} }],
    });

    addToast({
      correlationId: "entity-a",
      message: "second",
      actions: [
        { label: "Approve", onClick: () => {} },
        { label: "Reject", onClick: () => {} },
      ],
    });

    const n = getState().notifications.find((x) => x.id === id)!;
    expect(n.actions).toHaveLength(2);
    expect(n.actions!.map((a) => a.label)).toEqual(["Approve", "Reject"]);
  });

  it("preserves existing onDismiss when the incoming payload has no onDismiss", () => {
    const onDismiss = () => {};
    const id = addToast({ correlationId: "entity-a", message: "first", onDismiss });

    addToast({ correlationId: "entity-a", message: "second" });

    const n = getState().notifications.find((x) => x.id === id)!;
    expect(n.onDismiss).toBe(onDismiss);
  });

  it("replaces onDismiss when the incoming payload provides a new one", () => {
    const first = () => {};
    const second = () => {};
    const id = addToast({ correlationId: "entity-a", message: "m", onDismiss: first });

    addToast({ correlationId: "entity-a", message: "m2", onDismiss: second });

    const n = getState().notifications.find((x) => x.id === id)!;
    expect(n.onDismiss).toBe(second);
  });

  it("treats an empty correlationId string as entity-less (no collapse)", () => {
    addToast({ message: "a", correlationId: "" });
    addToast({ message: "b", correlationId: "" });

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(2);
    expect(notifications.every((n) => n.count === undefined)).toBe(true);
  });

  it("does not collapse grid-bar notifications", () => {
    addToast({ message: "a", correlationId: "entity-a", placement: "grid-bar" });
    addToast({ message: "b", correlationId: "entity-a", placement: "grid-bar" });

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(2);
    expect(notifications.every((n) => n.count === undefined)).toBe(true);
  });

  it("preserves existing action when incoming omits the action key entirely", () => {
    const action = { label: "Retry", onClick: () => {} };
    const id = addToast({ correlationId: "entity-a", message: "first", action });

    addToast({ correlationId: "entity-a", message: "second" });

    const n = getState().notifications.find((x) => x.id === id)!;
    expect(n.action).toBe(action);
  });

  it("clears the existing action when the incoming payload explicitly passes action: undefined", () => {
    const action = { label: "Restart", onClick: () => {} };
    const id = addToast({ correlationId: "entity-a", message: "first", action });

    addToast({ correlationId: "entity-a", message: "second", action: undefined });

    const n = getState().notifications.find((x) => x.id === id)!;
    expect(n.action).toBeUndefined();
  });

  it("replaces the existing action when the incoming payload provides a new one", () => {
    const first = { label: "Retry", onClick: () => {} };
    const second = { label: "Cancel", onClick: () => {} };
    const id = addToast({ correlationId: "entity-a", message: "m", action: first });

    addToast({ correlationId: "entity-a", message: "m2", action: second });

    const n = getState().notifications.find((x) => x.id === id)!;
    expect(n.action).toBe(second);
  });

  it("does not mark history entries unseen when collapsing", () => {
    const entryId = useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "first-entry",
      seenAsToast: true,
    });

    addToast({ message: "first", correlationId: "entity-a", historyEntryId: entryId });
    addToast({ message: "second", correlationId: "entity-a" });

    const entry = useNotificationHistoryStore.getState().entries.find((e) => e.id === entryId);
    expect(entry?.seenAsToast).toBe(true);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
  });
});
