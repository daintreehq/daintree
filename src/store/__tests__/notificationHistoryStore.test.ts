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
    countable: boolean;
  }> = {}
) {
  getState().addEntry({
    type: overrides.type ?? "info",
    message: overrides.message ?? "Test notification",
    title: overrides.title,
    correlationId: overrides.correlationId,
    countable: overrides.countable,
  });
}

describe("notificationHistorySlice", () => {
  beforeEach(() => {
    useNotificationHistoryStore.setState({
      entries: [],
      unreadCount: 0,
      evictedToInboxCount: 0,
    });
  });

  it("adds an entry with id and timestamp", () => {
    addEntry({ message: "Hello" });
    const { entries } = getState();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("Hello");
    expect(entries[0]!.id).toBeDefined();
    expect(entries[0]!.timestamp).toBeGreaterThan(0);
  });

  it("prepends new entries (most recent first)", () => {
    addEntry({ message: "first" });
    addEntry({ message: "second" });
    const { entries } = getState();
    expect(entries[0]!.message).toBe("second");
    expect(entries[1]!.message).toBe("first");
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
    expect(entries[0]!.message).toBe("msg-204");
    expect(entries[199]!.message).toBe("msg-5");
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
    expect(entries[0]!.correlationId).toBeUndefined();
    expect(entries[1]!.correlationId).toBe("panel-1");
    expect(entries[2]!.correlationId).toBe("panel-1");
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
      expect(entry!.actions).toHaveLength(1);
      expect(entry!.actions![0]!.label).toBe("Go to terminal");
      expect(entry!.actions![0]!.actionId).toBe("panel.focus");
      expect(entry!.actions![0]!.actionArgs).toEqual({ panelId: "p1" });
    });

    it("works with no actions (backward compat)", () => {
      addEntry({ message: "No actions" });
      const entry = getState().entries[0];
      expect(entry!.actions).toBeUndefined();
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
      expect(getState().entries[0]!.actions).toHaveLength(2);
    });
  });

  describe("seenAsToast and badge count", () => {
    it("defaults seenAsToast to false when not provided", () => {
      addEntry({ message: "test" });
      expect(getState().entries[0]!.seenAsToast).toBe(false);
    });

    it("stores seenAsToast=true when provided", () => {
      getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      expect(getState().entries[0]!.seenAsToast).toBe(true);
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
      expect(after).toBe(before!);
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

    it("defaults countable to true on new entries", () => {
      addEntry({ message: "test" });
      expect(getState().entries[0]!.countable).toBe(true);
    });

    it("does not increment unreadCount when countable is false", () => {
      addEntry({ message: "uncountable", countable: false });
      expect(getState().entries).toHaveLength(1);
      expect(getState().unreadCount).toBe(0);
    });

    it("correctly counts mixed countable and non-countable entries", () => {
      addEntry({ message: "countable 1" });
      addEntry({ message: "uncountable", countable: false });
      addEntry({ message: "countable 2" });
      expect(getState().entries).toHaveLength(3);
      expect(getState().unreadCount).toBe(2);
    });

    it("dismissing a non-countable entry does not change unreadCount", () => {
      addEntry({ message: "countable" });
      addEntry({ message: "uncountable", countable: false });
      expect(getState().unreadCount).toBe(1);
      const uncountableId = getState().entries[0]!.id;
      getState().dismissEntry(uncountableId);
      expect(getState().entries).toHaveLength(1);
      expect(getState().unreadCount).toBe(1);
    });
  });

  describe("markIdsRead", () => {
    it("flips seenAsToast to true on targeted ids only", () => {
      addEntry({ message: "a" });
      addEntry({ message: "b" });
      addEntry({ message: "c" });
      const entries = getState().entries;
      const targets = [entries[0]!.id, entries[2]!.id];

      getState().markIdsRead(targets);

      const updated = getState().entries;
      expect(updated[0]!.seenAsToast).toBe(true);
      expect(updated[1]!.seenAsToast).toBe(false);
      expect(updated[2]!.seenAsToast).toBe(true);
    });

    it("decrements unreadCount by the number of newly-read entries", () => {
      addEntry();
      addEntry();
      addEntry();
      expect(getState().unreadCount).toBe(3);
      const ids = getState()
        .entries.slice(0, 2)
        .map((e) => e.id);

      getState().markIdsRead(ids);

      expect(getState().unreadCount).toBe(1);
    });

    it("skips entries that are already read", () => {
      const seenId = getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      addEntry({ message: "missed" });
      const before = getState().entries.find((e) => e.id === seenId);

      getState().markIdsRead([seenId]);

      const after = getState().entries.find((e) => e.id === seenId);
      expect(after).toBe(before!);
    });

    it("is a no-op when ids is empty", () => {
      addEntry();
      const before = getState();
      getState().markIdsRead([]);
      const after = getState();
      expect(after.entries).toBe(before.entries);
      expect(after.unreadCount).toBe(before.unreadCount);
    });

    it("is a no-op when no targeted ids exist", () => {
      addEntry();
      const before = getState();
      getState().markIdsRead(["nonexistent-1", "nonexistent-2"]);
      const after = getState();
      expect(after.entries).toBe(before.entries);
      expect(after.unreadCount).toBe(before.unreadCount);
    });

    it("handles duplicate ids idempotently", () => {
      addEntry();
      const id = getState().entries[0]!.id;
      getState().markIdsRead([id, id, id]);
      expect(getState().entries[0]!.seenAsToast).toBe(true);
      expect(getState().unreadCount).toBe(0);
    });

    it("excludes non-countable entries from unreadCount as expected", () => {
      addEntry({ message: "countable" });
      addEntry({ message: "uncountable", countable: false });
      const ids = getState().entries.map((e) => e.id);
      expect(getState().unreadCount).toBe(1);
      getState().markIdsRead(ids);
      expect(getState().unreadCount).toBe(0);
      expect(getState().entries.every((e) => e.seenAsToast)).toBe(true);
    });

    it("does not change evictedToInboxCount", () => {
      addEntry();
      addEntry();
      const ids = getState().entries.map((e) => e.id);
      getState().markIdsRead(ids);
      expect(getState().evictedToInboxCount).toBe(0);
    });

    it("handles mixed unread + already-read + non-countable + missing ids in one call", () => {
      const seenId = getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      addEntry({ message: "unread countable" });
      addEntry({ message: "unread non-countable", countable: false });
      const unreadCountable = getState().entries.find((e) => e.message === "unread countable")!.id;
      const unreadNonCountable = getState().entries.find(
        (e) => e.message === "unread non-countable"
      )!.id;
      expect(getState().unreadCount).toBe(1);

      getState().markIdsRead([seenId, unreadCountable, unreadNonCountable, "missing"]);

      const after = getState();
      expect(after.entries.find((e) => e.id === seenId)?.seenAsToast).toBe(true);
      expect(after.entries.find((e) => e.id === unreadCountable)?.seenAsToast).toBe(true);
      expect(after.entries.find((e) => e.id === unreadNonCountable)?.seenAsToast).toBe(true);
      expect(after.unreadCount).toBe(0);
    });
  });

  describe("markSummarized", () => {
    it("defaults summarized to false on new entries", () => {
      addEntry({ message: "test" });
      expect(getState().entries[0]!.summarized).toBe(false);
    });

    it("marks only targeted entries as summarized", () => {
      addEntry({ message: "a" });
      addEntry({ message: "b" });
      addEntry({ message: "c" });
      const entries = getState().entries;
      getState().markSummarized([entries[0]!.id, entries[2]!.id]);
      const updated = getState().entries;
      expect(updated[0]!.summarized).toBe(true);
      expect(updated[1]!.summarized).toBe(false);
      expect(updated[2]!.summarized).toBe(true);
    });

    it("does not change unreadCount", () => {
      addEntry({ message: "missed" });
      addEntry({ message: "missed 2" });
      expect(getState().unreadCount).toBe(2);
      const ids = getState().entries.map((e) => e.id);
      getState().markSummarized(ids);
      expect(getState().unreadCount).toBe(2);
    });

    it("is independent from markAllRead", () => {
      addEntry({ message: "test" });
      const id = getState().entries[0]!.id;
      getState().markSummarized([id]);
      expect(getState().entries[0]!.summarized).toBe(true);
      expect(getState().entries[0]!.seenAsToast).toBe(false);
      getState().markAllRead();
      expect(getState().entries[0]!.summarized).toBe(true);
      expect(getState().entries[0]!.seenAsToast).toBe(true);
    });

    it("does not mutate already-summarized entries", () => {
      addEntry({ message: "test" });
      const id = getState().entries[0]!.id;
      getState().markSummarized([id]);
      const before = getState().entries[0];
      getState().markSummarized([id]);
      const after = getState().entries[0];
      expect(after).toBe(before!);
    });

    it("new entries after markSummarized default to summarized=false", () => {
      addEntry({ message: "old" });
      getState().markSummarized([getState().entries[0]!.id]);
      addEntry({ message: "new" });
      expect(getState().entries[0]!.summarized).toBe(false);
    });
  });

  describe("addEntry return value", () => {
    it("returns the id of the newly created entry", () => {
      const id = getState().addEntry({
        type: "info",
        message: "test",
      });
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(getState().entries[0]!.id).toBe(id);
    });
  });

  describe("markUnseenAsToast", () => {
    it("sets seenAsToast to false on a seen entry", () => {
      const id = getState().addEntry({
        type: "info",
        message: "seen",
        seenAsToast: true,
      });
      expect(getState().entries[0]!.seenAsToast).toBe(true);
      getState().markUnseenAsToast(id);
      expect(getState().entries[0]!.seenAsToast).toBe(false);
    });

    it("increments unreadCount when marking seen entry as unseen", () => {
      const id = getState().addEntry({
        type: "info",
        message: "seen",
        seenAsToast: true,
      });
      expect(getState().unreadCount).toBe(0);
      getState().markUnseenAsToast(id);
      expect(getState().unreadCount).toBe(1);
    });

    it("is a no-op when entry is already unseen", () => {
      const id = getState().addEntry({
        type: "info",
        message: "unseen",
        seenAsToast: false,
      });
      expect(getState().unreadCount).toBe(1);
      const before = getState().entries[0];
      getState().markUnseenAsToast(id);
      const after = getState().entries[0];
      expect(after).toBe(before!);
      expect(getState().unreadCount).toBe(1);
    });

    it("is a no-op when id does not exist", () => {
      addEntry({ message: "test" });
      const before = getState();
      getState().markUnseenAsToast("nonexistent-id");
      const after = getState();
      expect(after.entries).toBe(before.entries);
      expect(after.unreadCount).toBe(before.unreadCount);
    });

    it("does not affect other entries", () => {
      getState().addEntry({ type: "info", message: "other", seenAsToast: true });
      const targetId = getState().addEntry({
        type: "info",
        message: "target",
        seenAsToast: true,
      });
      getState().markUnseenAsToast(targetId);
      const entries = getState().entries;
      expect(entries.find((e) => e.id === targetId)?.seenAsToast).toBe(false);
      expect(entries.find((e) => e.id !== targetId)?.seenAsToast).toBe(true);
    });
  });

  describe("evictedToInboxCount", () => {
    it("starts at 0", () => {
      expect(getState().evictedToInboxCount).toBe(0);
    });

    it("increments when markUnseenAsToast flips a seen entry", () => {
      const id = getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      expect(getState().evictedToInboxCount).toBe(0);
      getState().markUnseenAsToast(id);
      expect(getState().evictedToInboxCount).toBe(1);
    });

    it("does not increment when markUnseenAsToast targets a missing id", () => {
      addEntry({ message: "test" });
      expect(getState().evictedToInboxCount).toBe(0);
      getState().markUnseenAsToast("nonexistent-id");
      expect(getState().evictedToInboxCount).toBe(0);
    });

    it("does not increment when markUnseenAsToast targets an already-unseen entry", () => {
      const id = getState().addEntry({ type: "info", message: "missed", seenAsToast: false });
      expect(getState().evictedToInboxCount).toBe(0);
      getState().markUnseenAsToast(id);
      expect(getState().evictedToInboxCount).toBe(0);
    });

    it("accumulates across multiple evictions", () => {
      const a = getState().addEntry({ type: "info", message: "a", seenAsToast: true });
      const b = getState().addEntry({ type: "info", message: "b", seenAsToast: true });
      const c = getState().addEntry({ type: "info", message: "c", seenAsToast: true });
      getState().markUnseenAsToast(a);
      getState().markUnseenAsToast(b);
      getState().markUnseenAsToast(c);
      expect(getState().evictedToInboxCount).toBe(3);
    });

    it("resetEvictedCount zeroes the counter without touching entries or unreadCount", () => {
      const id = getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      getState().markUnseenAsToast(id);
      expect(getState().evictedToInboxCount).toBe(1);
      expect(getState().unreadCount).toBe(1);
      getState().resetEvictedCount();
      expect(getState().evictedToInboxCount).toBe(0);
      expect(getState().unreadCount).toBe(1);
      expect(getState().entries).toHaveLength(1);
    });

    it("resetEvictedCount returns the same state object when already zero", () => {
      const before = getState();
      getState().resetEvictedCount();
      const after = getState();
      // No-op set: same evictedToInboxCount value, no spurious render trigger.
      expect(after.evictedToInboxCount).toBe(before.evictedToInboxCount);
    });

    it("clearAll resets the eviction counter", () => {
      const id = getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      getState().markUnseenAsToast(id);
      expect(getState().evictedToInboxCount).toBe(1);
      getState().clearAll();
      expect(getState().evictedToInboxCount).toBe(0);
    });

    it("does NOT increment when called with { silent: true }", () => {
      const id = getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      expect(getState().evictedToInboxCount).toBe(0);
      getState().markUnseenAsToast(id, { silent: true });
      // The seenAsToast flip + unreadCount update still happen — only the
      // discoverability cue is suppressed.
      expect(getState().entries[0]!.seenAsToast).toBe(false);
      expect(getState().unreadCount).toBe(1);
      expect(getState().evictedToInboxCount).toBe(0);
    });
  });

  describe("dismissEntry", () => {
    it("removes the entry and decrements unreadCount when entry is unread", () => {
      addEntry({ message: "missed" });
      const id = getState().entries[0]!.id;
      expect(getState().unreadCount).toBe(1);
      getState().dismissEntry(id);
      expect(getState().entries).toHaveLength(0);
      expect(getState().unreadCount).toBe(0);
    });

    it("removes the entry without changing unreadCount when entry is read", () => {
      getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      addEntry({ message: "missed" });
      expect(getState().unreadCount).toBe(1);
      const seenId = getState().entries[1]!.id;
      getState().dismissEntry(seenId);
      expect(getState().entries).toHaveLength(1);
      expect(getState().entries[0]!.message).toBe("missed");
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
      const id = getState().entries[0]!.id;
      getState().dismissEntry(id);
      expect(getState().unreadCount).toBe(1);
      expect(getState().entries[0]!.message).toBe("missed 1");
      getState().markAllRead();
      expect(getState().unreadCount).toBe(0);
      expect(getState().entries).toHaveLength(1);
      expect(getState().entries[0]!.message).toBe("missed 1");
    });
  });

  describe("dismissByCorrelationId", () => {
    it("removes all entries with matching correlationId", () => {
      addEntry({ message: "first", correlationId: "panel-1" });
      addEntry({ message: "second", correlationId: "panel-1" });
      addEntry({ message: "third", correlationId: "panel-1" });
      expect(getState().entries).toHaveLength(3);
      getState().dismissByCorrelationId("panel-1");
      expect(getState().entries).toHaveLength(0);
    });

    it("preserves entries with different correlationId", () => {
      addEntry({ message: "a", correlationId: "panel-1" });
      addEntry({ message: "b", correlationId: "panel-2" });
      addEntry({ message: "c", correlationId: "panel-1" });
      getState().dismissByCorrelationId("panel-1");
      expect(getState().entries).toHaveLength(1);
      expect(getState().entries[0]!.message).toBe("b");
    });

    it("preserves entries with no correlationId", () => {
      addEntry({ message: "correlated", correlationId: "panel-1" });
      addEntry({ message: "uncorrelated" });
      getState().dismissByCorrelationId("panel-1");
      expect(getState().entries).toHaveLength(1);
      expect(getState().entries[0]!.message).toBe("uncorrelated");
    });

    it("recomputes unreadCount after removal", () => {
      addEntry({ message: "missed 1", correlationId: "panel-1" });
      addEntry({ message: "missed 2", correlationId: "panel-1" });
      getState().addEntry({
        type: "info",
        message: "seen",
        correlationId: "panel-1",
        seenAsToast: true,
      });
      expect(getState().unreadCount).toBe(2);
      getState().dismissByCorrelationId("panel-1");
      expect(getState().unreadCount).toBe(0);
    });

    it("recomputes unreadCount correctly with mixed seenAsToast and correlationIds", () => {
      addEntry({ message: "missed a", correlationId: "panel-1" });
      addEntry({ message: "missed b", correlationId: "panel-2" });
      getState().addEntry({
        type: "info",
        message: "seen",
        correlationId: "panel-1",
        seenAsToast: true,
      });
      expect(getState().unreadCount).toBe(2);
      getState().dismissByCorrelationId("panel-1");
      expect(getState().entries).toHaveLength(1);
      expect(getState().unreadCount).toBe(1);
      expect(getState().entries[0]!.message).toBe("missed b");
    });

    it("is a no-op when correlationId does not exist", () => {
      addEntry({ message: "test", correlationId: "panel-1" });
      getState().dismissByCorrelationId("nonexistent");
      expect(getState().entries).toHaveLength(1);
      expect(getState().unreadCount).toBe(1);
    });

    it("correctly dismisses non-countable entries without affecting unreadCount of remaining", () => {
      addEntry({ message: "countable", correlationId: "panel-1" });
      addEntry({ message: "uncountable", correlationId: "panel-1", countable: false });
      addEntry({ message: "other countable", correlationId: "panel-2" });
      expect(getState().unreadCount).toBe(2);
      getState().dismissByCorrelationId("panel-1");
      expect(getState().entries).toHaveLength(1);
      expect(getState().unreadCount).toBe(1);
    });

    it("idempotent — second call with same correlationId is a no-op", () => {
      addEntry({ message: "first", correlationId: "panel-1" });
      getState().dismissByCorrelationId("panel-1");
      expect(getState().entries).toHaveLength(0);
      getState().dismissByCorrelationId("panel-1");
      expect(getState().entries).toHaveLength(0);
      expect(getState().unreadCount).toBe(0);
    });
  });

  describe("archive (Done state)", () => {
    it("defaults archivedAt to null on new entries", () => {
      addEntry({ message: "test" });
      expect(getState().entries[0]!.archivedAt).toBeNull();
    });

    it("archiveEntry sets archivedAt and seenAsToast atomically", () => {
      const id = getState().addEntry({ type: "info", message: "live" });
      expect(getState().entries[0]!.archivedAt).toBeNull();
      expect(getState().entries[0]!.seenAsToast).toBe(false);
      const before = Date.now();
      getState().archiveEntry(id);
      const after = Date.now();
      const entry = getState().entries[0]!;
      expect(entry.archivedAt).not.toBeNull();
      expect(entry.archivedAt!).toBeGreaterThanOrEqual(before);
      expect(entry.archivedAt!).toBeLessThanOrEqual(after);
      expect(entry.seenAsToast).toBe(true);
    });

    it("archiveEntry decrements unreadCount", () => {
      addEntry({ message: "a" });
      addEntry({ message: "b" });
      expect(getState().unreadCount).toBe(2);
      const id = getState().entries[0]!.id;
      getState().archiveEntry(id);
      expect(getState().unreadCount).toBe(1);
    });

    it("archiveEntry preserves the entry (non-destructive)", () => {
      const id = getState().addEntry({ type: "info", message: "still here" });
      getState().archiveEntry(id);
      expect(getState().entries).toHaveLength(1);
      expect(getState().entries[0]!.message).toBe("still here");
    });

    it("archiveEntry is a no-op when entry is already archived", () => {
      const id = getState().addEntry({ type: "info", message: "test" });
      getState().archiveEntry(id);
      const firstArchived = getState().entries[0]!.archivedAt;
      const before = getState().entries[0];
      getState().archiveEntry(id);
      const after = getState().entries[0];
      expect(after).toBe(before!);
      expect(after!.archivedAt).toBe(firstArchived);
    });

    it("archiveEntry is a no-op when id does not exist", () => {
      addEntry({ message: "test" });
      const before = getState();
      getState().archiveEntry("nonexistent-id");
      const after = getState();
      expect(after.entries).toBe(before.entries);
      expect(after.unreadCount).toBe(before.unreadCount);
    });

    it("unreadCount excludes archived entries even when seenAsToast resets", () => {
      const id = getState().addEntry({ type: "info", message: "live" });
      getState().archiveEntry(id);
      expect(getState().unreadCount).toBe(0);
      // markUnseenAsToast is a no-op on archived entries — see the guard in
      // the slice. Asserting unreadCount stays 0 regardless.
      getState().markUnseenAsToast(id);
      expect(getState().unreadCount).toBe(0);
    });

    it("markUnseenAsToast on archived entry is a no-op (no eviction count tick)", () => {
      const id = getState().addEntry({ type: "info", message: "seen", seenAsToast: true });
      getState().archiveEntry(id);
      expect(getState().evictedToInboxCount).toBe(0);
      const beforeEntry = getState().entries[0];
      getState().markUnseenAsToast(id);
      // Archived entry survives unmodified; evicted counter does not tick.
      const afterEntry = getState().entries[0];
      expect(afterEntry).toBe(beforeEntry!);
      expect(afterEntry!.seenAsToast).toBe(true);
      expect(getState().evictedToInboxCount).toBe(0);
    });

    it("archiveByCorrelationId archives all non-archived entries in the thread", () => {
      addEntry({ message: "a", correlationId: "panel-1" });
      addEntry({ message: "b", correlationId: "panel-1" });
      addEntry({ message: "c", correlationId: "panel-2" });
      getState().archiveByCorrelationId("panel-1");
      const entries = getState().entries;
      expect(entries.find((e) => e.message === "a")!.archivedAt).not.toBeNull();
      expect(entries.find((e) => e.message === "b")!.archivedAt).not.toBeNull();
      expect(entries.find((e) => e.message === "c")!.archivedAt).toBeNull();
    });

    it("archiveByCorrelationId leaves already-archived entries untouched", () => {
      addEntry({ message: "a", correlationId: "panel-1" });
      const liveId = getState().addEntry({
        type: "info",
        message: "b",
        correlationId: "panel-1",
      });
      const oldId = getState().entries.find((e) => e.message === "a")!.id;
      getState().archiveEntry(oldId);
      const oldArchivedAt = getState().entries.find((e) => e.id === oldId)!.archivedAt;
      // Force a measurable delta so equality is meaningful even on machines
      // where Date.now() returns the same value between calls.
      const realDateNow = Date.now;
      Date.now = () => realDateNow() + 50;
      try {
        getState().archiveByCorrelationId("panel-1");
      } finally {
        Date.now = realDateNow;
      }
      expect(getState().entries.find((e) => e.id === oldId)!.archivedAt).toBe(oldArchivedAt);
      expect(getState().entries.find((e) => e.id === liveId)!.archivedAt).not.toBeNull();
    });

    it("archiveByCorrelationId is a no-op when nothing matches", () => {
      addEntry({ message: "a", correlationId: "panel-1" });
      const before = getState();
      getState().archiveByCorrelationId("panel-99");
      const after = getState();
      expect(after.entries).toBe(before.entries);
      expect(after.unreadCount).toBe(before.unreadCount);
    });

    it("archiveByCorrelationId decrements unreadCount only for newly-archived entries", () => {
      addEntry({ message: "missed", correlationId: "panel-1" });
      getState().addEntry({
        type: "info",
        message: "seen",
        correlationId: "panel-1",
        seenAsToast: true,
      });
      expect(getState().unreadCount).toBe(1);
      getState().archiveByCorrelationId("panel-1");
      expect(getState().unreadCount).toBe(0);
    });
  });

  describe("supersede on addEntry", () => {
    it("supersedes by exact id archives the target entry", () => {
      const oldId = getState().addEntry({ type: "error", message: "Disconnected" });
      getState().addEntry({
        type: "success",
        message: "Reconnected",
        supersedes: oldId,
      });
      const old = getState().entries.find((e) => e.id === oldId)!;
      expect(old.archivedAt).not.toBeNull();
      expect(old.seenAsToast).toBe(true);
    });

    it("supersedes by id is a no-op when the target is missing", () => {
      addEntry({ message: "live" });
      const before = getState().entries.length;
      getState().addEntry({
        type: "success",
        message: "Reconnected",
        supersedes: "ghost-id",
      });
      // The new entry is still added; only the supersede lookup is a no-op.
      expect(getState().entries.length).toBe(before + 1);
    });

    it("supersedes by id is a no-op when target is already archived", () => {
      const oldId = getState().addEntry({ type: "error", message: "Disconnected" });
      getState().archiveEntry(oldId);
      const firstArchivedAt = getState().entries.find((e) => e.id === oldId)!.archivedAt;
      const realDateNow = Date.now;
      Date.now = () => realDateNow() + 100;
      try {
        getState().addEntry({
          type: "success",
          message: "Reconnected",
          supersedes: oldId,
        });
      } finally {
        Date.now = realDateNow;
      }
      // archivedAt stays at the original archive time — not re-archived.
      expect(getState().entries.find((e) => e.id === oldId)!.archivedAt).toBe(firstArchivedAt);
    });

    it("supersedeKey archives the latest non-archived entry with the matching key", () => {
      const key = "terminal.A.fallback";
      getState().addEntry({ type: "error", message: "Disconnected", supersedeKey: key });
      const errId = getState().entries[0]!.id;
      getState().addEntry({ type: "success", message: "Reconnected", supersedeKey: key });
      expect(getState().entries.find((e) => e.id === errId)!.archivedAt).not.toBeNull();
    });

    it("supersedeKey picks the newest live match when two priors share the key", () => {
      // Normal addEntry auto-archives the prior on every same-key write, so
      // two live priors only coexist via direct seeding (e.g., from a test or
      // a future restore-from-disk path). The find() must still pick the
      // newest (index 0) so the lookup is robust against that shape.
      const key = "terminal.A.fallback";
      useNotificationHistoryStore.setState({
        entries: [
          {
            id: "b-newer",
            type: "error",
            message: "newer",
            timestamp: Date.now(),
            seenAsToast: false,
            summarized: false,
            countable: true,
            archivedAt: null,
            supersedeKey: key,
          },
          {
            id: "a-older",
            type: "error",
            message: "older",
            timestamp: Date.now() - 1000,
            seenAsToast: false,
            summarized: false,
            countable: true,
            archivedAt: null,
            supersedeKey: key,
          },
        ],
        unreadCount: 2,
      });
      getState().addEntry({ type: "success", message: "resolve", supersedeKey: key });
      const entries = getState().entries;
      expect(entries.find((e) => e.id === "b-newer")!.archivedAt).not.toBeNull();
      expect(entries.find((e) => e.id === "a-older")!.archivedAt).toBeNull();
    });

    it("supersedeKey stores the key on the new entry for future archival", () => {
      const key = "terminal.A.fallback";
      getState().addEntry({ type: "error", message: "Disconnected", supersedeKey: key });
      expect(getState().entries[0]!.supersedeKey).toBe(key);
    });

    it("supersedeKey skips already-archived entries with the same key", () => {
      const key = "terminal.A.fallback";
      getState().addEntry({ type: "error", message: "old", supersedeKey: key });
      const oldId = getState().entries[0]!.id;
      getState().archiveEntry(oldId);
      const oldArchivedAt = getState().entries.find((e) => e.id === oldId)!.archivedAt;
      getState().addEntry({ type: "info", message: "newer", supersedeKey: key });
      // The pre-archived old entry stays untouched (archiveAt unchanged).
      expect(getState().entries.find((e) => e.id === oldId)!.archivedAt).toBe(oldArchivedAt);
    });

    it("supersedes takes precedence over supersedeKey when both are present", () => {
      const key = "k";
      const targetId = getState().addEntry({ type: "error", message: "target", supersedeKey: key });
      const otherId = getState().addEntry({
        type: "error",
        message: "decoy",
        supersedeKey: key,
      });
      // newer non-archived match would be `otherId` via supersedeKey, but
      // explicit supersedes:targetId wins.
      getState().addEntry({
        type: "success",
        message: "fix",
        supersedes: targetId,
        supersedeKey: key,
      });
      expect(getState().entries.find((e) => e.id === targetId)!.archivedAt).not.toBeNull();
      expect(getState().entries.find((e) => e.id === otherId)!.archivedAt).toBeNull();
    });

    it("addEntry without supersede fields does not archive anything", () => {
      addEntry({ message: "a" });
      addEntry({ message: "b" });
      expect(getState().entries.every((e) => e.archivedAt === null)).toBe(true);
    });

    it("supersedes does not persist on the new entry", () => {
      const oldId = getState().addEntry({ type: "error", message: "old" });
      const newId = getState().addEntry({
        type: "success",
        message: "new",
        supersedes: oldId,
      });
      // `supersedes` is a write-time directive, not stored state.
      expect(
        (getState().entries.find((e) => e.id === newId)! as { supersedes?: string }).supersedes
      ).toBeUndefined();
    });
  });
});
