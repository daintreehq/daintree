import { describe, it, expect, beforeEach } from "vitest";
import {
  useNotificationHistoryStore,
  getEntriesByCorrelationId,
} from "../slices/notificationHistorySlice";

const { getState } = useNotificationHistoryStore;

function addEntry(
  overrides: Partial<{
    type: "success" | "error" | "info" | "warning";
    title: string;
    message: string;
    correlationId: string;
  }> = {}
) {
  getState().addEntry({
    type: overrides.type ?? "info",
    message: overrides.message ?? "Test notification",
    title: overrides.title,
    correlationId: overrides.correlationId,
  });
}

describe("notificationHistorySlice", () => {
  beforeEach(() => {
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
  });

  it("adds an entry with id and timestamp", () => {
    addEntry({ message: "Hello" });
    const { entries } = getState();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("Hello");
    expect(entries[0].id).toBeDefined();
    expect(entries[0].timestamp).toBeGreaterThan(0);
  });

  it("prepends new entries (most recent first)", () => {
    addEntry({ message: "first" });
    addEntry({ message: "second" });
    const { entries } = getState();
    expect(entries[0].message).toBe("second");
    expect(entries[1].message).toBe("first");
  });

  it("increments unreadCount on each add", () => {
    addEntry();
    addEntry();
    addEntry();
    expect(getState().unreadCount).toBe(3);
  });

  it("respects 200-entry cap (oldest evicted)", () => {
    for (let i = 0; i < 205; i++) {
      addEntry({ message: `msg-${i}` });
    }
    const { entries } = getState();
    expect(entries).toHaveLength(200);
    expect(entries[0].message).toBe("msg-204");
    expect(entries[199].message).toBe("msg-5");
  });

  it("unreadCount never exceeds 200 even with overflow", () => {
    for (let i = 0; i < 250; i++) {
      addEntry({ message: `msg-${i}` });
    }
    expect(getState().unreadCount).toBe(200);
    expect(getState().entries).toHaveLength(200);
  });

  it("markAllRead resets unread count but keeps entries", () => {
    addEntry();
    addEntry();
    expect(getState().unreadCount).toBe(2);
    getState().markAllRead();
    expect(getState().unreadCount).toBe(0);
    expect(getState().entries).toHaveLength(2);
  });

  it("clearAll empties entries and resets count", () => {
    addEntry();
    addEntry();
    getState().clearAll();
    expect(getState().entries).toHaveLength(0);
    expect(getState().unreadCount).toBe(0);
  });

  it("stores correlationId on entries", () => {
    addEntry({ message: "first", correlationId: "panel-1" });
    addEntry({ message: "second", correlationId: "panel-1" });
    addEntry({ message: "third" });
    const { entries } = getState();
    expect(entries[0].correlationId).toBeUndefined();
    expect(entries[1].correlationId).toBe("panel-1");
    expect(entries[2].correlationId).toBe("panel-1");
  });

  it("getEntriesByCorrelationId returns matching entries", () => {
    addEntry({ message: "first", correlationId: "panel-1" });
    addEntry({ message: "second", correlationId: "panel-2" });
    addEntry({ message: "third", correlationId: "panel-1" });
    const results = getEntriesByCorrelationId("panel-1");
    expect(results).toHaveLength(2);
    expect(results.every((e: { correlationId?: string }) => e.correlationId === "panel-1")).toBe(
      true
    );
  });

  describe("history actions", () => {
    it("stores actions on the entry when provided", () => {
      getState().addEntry({
        type: "success",
        message: "Agent done",
        actions: [
          { label: "Go to terminal", actionId: "panel.focus", actionArgs: { panelId: "p1" } },
        ],
      });
      const entry = getState().entries[0];
      expect(entry.actions).toHaveLength(1);
      expect(entry.actions![0].label).toBe("Go to terminal");
      expect(entry.actions![0].actionId).toBe("panel.focus");
      expect(entry.actions![0].actionArgs).toEqual({ panelId: "p1" });
    });

    it("works with no actions (backward compat)", () => {
      addEntry({ message: "No actions" });
      const entry = getState().entries[0];
      expect(entry.actions).toBeUndefined();
    });

    it("stores multiple actions", () => {
      getState().addEntry({
        type: "info",
        message: "Multi-action",
        actions: [
          { label: "Action 1", actionId: "panel.focus", actionArgs: { panelId: "p1" } },
          { label: "Action 2", actionId: "panel.focus", variant: "secondary" },
        ],
      });
      expect(getState().entries[0].actions).toHaveLength(2);
    });
  });

  describe("seenAsToast and badge count", () => {
    it("defaults seenAsToast to false when not provided", () => {
      addEntry({ message: "test" });
      expect(getState().entries[0].seenAsToast).toBe(false);
    });

    it("stores seenAsToast=true when provided", () => {
      getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      expect(getState().entries[0].seenAsToast).toBe(true);
    });

    it("does not increment unreadCount when seenAsToast is true", () => {
      getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      getState().addEntry({ type: "info", message: "seen again", seenAsToast: true });
      expect(getState().unreadCount).toBe(0);
    });

    it("increments unreadCount only for entries with seenAsToast=false", () => {
      getState().addEntry({ type: "success", message: "seen", seenAsToast: true });
      getState().addEntry({ type: "error", message: "missed", seenAsToast: false });
      getState().addEntry({ type: "info", message: "seen too", seenAsToast: true });
      getState().addEntry({ type: "warning", message: "missed too", seenAsToast: false });
      expect(getState().unreadCount).toBe(2);
    });

    it("markAllRead sets seenAsToast to true on all entries", () => {
      addEntry({ message: "missed 1" });
      addEntry({ message: "missed 2" });
      getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      expect(getState().entries.filter((e) => !e.seenAsToast)).toHaveLength(2);
      getState().markAllRead();
      expect(getState().entries.every((e) => e.seenAsToast)).toBe(true);
      expect(getState().unreadCount).toBe(0);
    });

    it("markAllRead does not mutate already-seen entries unnecessarily", () => {
      getState().addEntry({ type: "info", message: "already seen", seenAsToast: true });
      const before = getState().entries[0];
      getState().markAllRead();
      const after = getState().entries[0];
      expect(after).toBe(before);
    });

    it("unreadCount stays accurate when overflow evicts an unseen entry", () => {
      for (let i = 0; i < 200; i++) {
        addEntry({ message: `missed-${i}` });
      }
      expect(getState().unreadCount).toBe(200);
      getState().addEntry({ type: "success", message: "seen", seenAsToast: true });
      expect(getState().entries).toHaveLength(200);
      expect(getState().unreadCount).toBe(199);
    });
  });

  describe("dismissEntry", () => {
    it("removes the entry and decrements unreadCount when entry is unread", () => {
      addEntry({ message: "missed" });
      const id = getState().entries[0].id;
      expect(getState().unreadCount).toBe(1);
      getState().dismissEntry(id);
      expect(getState().entries).toHaveLength(0);
      expect(getState().unreadCount).toBe(0);
    });

    it("removes the entry without changing unreadCount when entry is read", () => {
      getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      addEntry({ message: "missed" });
      expect(getState().unreadCount).toBe(1);
      const seenId = getState().entries[1].id;
      getState().dismissEntry(seenId);
      expect(getState().entries).toHaveLength(1);
      expect(getState().entries[0].message).toBe("missed");
      expect(getState().unreadCount).toBe(1);
    });

    it("is a no-op when id does not exist", () => {
      addEntry({ message: "test" });
      getState().dismissEntry("nonexistent-id");
      expect(getState().entries).toHaveLength(1);
      expect(getState().unreadCount).toBe(1);
    });

    it("works correctly with markAllRead", () => {
      addEntry({ message: "missed 1" });
      addEntry({ message: "missed 2" });
      const id = getState().entries[0].id;
      getState().dismissEntry(id);
      expect(getState().unreadCount).toBe(1);
      expect(getState().entries[0].message).toBe("missed 1");
      getState().markAllRead();
      expect(getState().unreadCount).toBe(0);
      expect(getState().entries).toHaveLength(1);
      expect(getState().entries[0].message).toBe("missed 1");
    });
  });
});
