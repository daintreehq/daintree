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

  it("respects 50-entry cap (oldest evicted)", () => {
    for (let i = 0; i < 55; i++) {
      addEntry({ message: `msg-${i}` });
    }
    const { entries } = getState();
    expect(entries).toHaveLength(50);
    expect(entries[0].message).toBe("msg-54");
    expect(entries[49].message).toBe("msg-5");
  });

  it("unreadCount never exceeds 50 even with overflow", () => {
    for (let i = 0; i < 100; i++) {
      addEntry({ message: `msg-${i}` });
    }
    expect(getState().unreadCount).toBe(50);
    expect(getState().entries).toHaveLength(50);
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
});
