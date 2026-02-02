import { describe, it, expect, beforeEach } from "vitest";
import { PendingEventQueue } from "../PendingEventQueue.js";

describe("PendingEventQueue", () => {
  let queue: PendingEventQueue;

  beforeEach(() => {
    queue = new PendingEventQueue();
  });

  describe("push", () => {
    it("adds an event and returns it with generated id", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", {
        terminalId: "term-1",
      });

      expect(event.id).toBeDefined();
      expect(typeof event.id).toBe("string");
      expect(event.sessionId).toBe("session-1");
      expect(event.listenerId).toBe("listener-1");
      expect(event.eventType).toBe("terminal:state-changed");
      expect(event.data).toEqual({ terminalId: "term-1" });
      expect(event.acknowledged).toBe(false);
    });

    it("creates event with timestamp", () => {
      const before = Date.now();
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", {});
      const after = Date.now();

      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });

    it("allows multiple events for the same session", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.push("session-1", "listener-2", "terminal:state-changed", {});

      expect(queue.countAll("session-1")).toBe(2);
    });

    it("isolates events across sessions", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.push("session-2", "listener-2", "terminal:state-changed", {});

      expect(queue.countAll("session-1")).toBe(1);
      expect(queue.countAll("session-2")).toBe(1);
    });

    it("enforces FIFO eviction at max capacity (100 events)", () => {
      // Push 100 events
      for (let i = 0; i < 100; i++) {
        queue.push("session-1", `listener-${i}`, "terminal:state-changed", { index: i });
      }

      expect(queue.countAll("session-1")).toBe(100);

      // Push one more - should evict the oldest
      queue.push("session-1", "listener-100", "terminal:state-changed", { index: 100 });

      expect(queue.countAll("session-1")).toBe(100);

      // The oldest event (index: 0) should be gone
      const events = queue.getPending("session-1");
      const indexes = events.map((e) => (e.data as { index: number }).index);
      expect(indexes).not.toContain(0);
      expect(indexes).toContain(100);
    });

    it("prefers evicting acknowledged events over pending events", () => {
      // Push 100 events
      const events: string[] = [];
      for (let i = 0; i < 100; i++) {
        const event = queue.push("session-1", `listener-${i}`, "terminal:state-changed", {
          index: i,
        });
        events.push(event.id);
      }

      // Acknowledge the first 50 events
      for (let i = 0; i < 50; i++) {
        queue.acknowledge(events[i]);
      }

      expect(queue.countPending("session-1")).toBe(50);
      expect(queue.countAll("session-1")).toBe(100);

      // Push one more - should evict the oldest acknowledged event (index: 0)
      queue.push("session-1", "listener-100", "terminal:state-changed", { index: 100 });

      expect(queue.countAll("session-1")).toBe(100);

      // Pending events (50-99) should still exist
      const pending = queue.getPending("session-1");
      expect(pending.length).toBe(51); // 50-99 + new event 100
      const pendingIndexes = pending.map((e) => (e.data as { index: number }).index);
      expect(pendingIndexes).toContain(50);
      expect(pendingIndexes).toContain(99);
      expect(pendingIndexes).toContain(100);

      // Event 0 (acknowledged) should be gone
      const all = queue.getAll("session-1");
      const allIndexes = all.map((e) => (e.data as { index: number }).index);
      expect(allIndexes).not.toContain(0);
    });

    it("evicts oldest pending when all events are acknowledged", () => {
      // Push 100 events and acknowledge all
      for (let i = 0; i < 100; i++) {
        const event = queue.push("session-1", `listener-${i}`, "terminal:state-changed", {
          index: i,
        });
        queue.acknowledge(event.id);
      }

      expect(queue.countPending("session-1")).toBe(0);
      expect(queue.countAll("session-1")).toBe(100);

      // Push one more - should still evict (oldest acknowledged)
      queue.push("session-1", "listener-100", "terminal:state-changed", { index: 100 });

      expect(queue.countAll("session-1")).toBe(100);

      // Event 0 should be gone
      const all = queue.getAll("session-1");
      const allIndexes = all.map((e) => (e.data as { index: number }).index);
      expect(allIndexes).not.toContain(0);
      expect(allIndexes).toContain(100);
    });
  });

  describe("getPending", () => {
    it("returns unacknowledged events for a session", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", { id: 1 });
      queue.push("session-1", "listener-2", "terminal:state-changed", { id: 2 });

      const pending = queue.getPending("session-1");

      expect(pending.length).toBe(2);
      expect(pending.every((e) => !e.acknowledged)).toBe(true);
    });

    it("excludes acknowledged events", () => {
      const event1 = queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.push("session-1", "listener-2", "terminal:state-changed", {});

      queue.acknowledge(event1.id);

      const pending = queue.getPending("session-1");
      expect(pending.length).toBe(1);
      expect(pending[0].id).not.toBe(event1.id);
    });

    it("returns events sorted by timestamp (oldest first)", async () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", { order: 1 });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 5));

      queue.push("session-1", "listener-2", "terminal:state-changed", { order: 2 });

      const pending = queue.getPending("session-1");

      expect(pending[0].data).toEqual({ order: 1 });
      expect(pending[1].data).toEqual({ order: 2 });
    });

    it("returns empty array for session with no events", () => {
      const pending = queue.getPending("session-1");
      expect(pending).toEqual([]);
    });

    it("returns empty array for non-existent session", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});

      const pending = queue.getPending("session-2");
      expect(pending).toEqual([]);
    });
  });

  describe("getAll", () => {
    it("returns all events including acknowledged", () => {
      const event1 = queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.push("session-1", "listener-2", "terminal:state-changed", {});

      queue.acknowledge(event1.id);

      const all = queue.getAll("session-1");
      expect(all.length).toBe(2);
    });

    it("returns events sorted by timestamp", async () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", { order: 1 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      queue.push("session-1", "listener-2", "terminal:state-changed", { order: 2 });

      const all = queue.getAll("session-1");

      expect(all[0].data).toEqual({ order: 1 });
      expect(all[1].data).toEqual({ order: 2 });
    });

    it("returns empty array for non-existent session", () => {
      const all = queue.getAll("non-existent");
      expect(all).toEqual([]);
    });
  });

  describe("acknowledge", () => {
    it("marks event as acknowledged", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", {});

      const result = queue.acknowledge(event.id);

      expect(result).toBe(true);

      const all = queue.getAll("session-1");
      expect(all[0].acknowledged).toBe(true);
    });

    it("returns false for non-existent event", () => {
      const result = queue.acknowledge("non-existent-id");
      expect(result).toBe(false);
    });

    it("can acknowledge same event multiple times", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", {});

      queue.acknowledge(event.id);
      const result = queue.acknowledge(event.id);

      expect(result).toBe(true);
    });

    it("enforces session ownership when sessionId is provided", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", {});

      // Try to acknowledge with wrong session
      const result = queue.acknowledge(event.id, "session-2");

      expect(result).toBe(false);

      const all = queue.getAll("session-1");
      expect(all[0].acknowledged).toBe(false);
    });

    it("allows acknowledgment with correct sessionId", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", {});

      const result = queue.acknowledge(event.id, "session-1");

      expect(result).toBe(true);

      const all = queue.getAll("session-1");
      expect(all[0].acknowledged).toBe(true);
    });
  });

  describe("acknowledgeAll", () => {
    it("acknowledges all pending events for a session", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.push("session-1", "listener-2", "terminal:state-changed", {});
      queue.push("session-2", "listener-3", "terminal:state-changed", {});

      const count = queue.acknowledgeAll("session-1");

      expect(count).toBe(2);
      expect(queue.countPending("session-1")).toBe(0);
      expect(queue.countPending("session-2")).toBe(1);
    });

    it("returns 0 when no pending events", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.acknowledge(event.id);

      const count = queue.acknowledgeAll("session-1");
      expect(count).toBe(0);
    });

    it("returns 0 for non-existent session", () => {
      const count = queue.acknowledgeAll("non-existent");
      expect(count).toBe(0);
    });
  });

  describe("clearSession", () => {
    it("removes all events for a session", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.push("session-1", "listener-2", "terminal:state-changed", {});
      queue.push("session-2", "listener-3", "terminal:state-changed", {});

      const count = queue.clearSession("session-1");

      expect(count).toBe(2);
      expect(queue.countAll("session-1")).toBe(0);
      expect(queue.countAll("session-2")).toBe(1);
    });

    it("returns 0 when session has no events", () => {
      const count = queue.clearSession("non-existent");
      expect(count).toBe(0);
    });

    it("can be called multiple times safely", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});

      queue.clearSession("session-1");
      const count = queue.clearSession("session-1");

      expect(count).toBe(0);
    });
  });

  describe("clearAll", () => {
    it("removes all events across all sessions", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.push("session-2", "listener-2", "terminal:state-changed", {});
      queue.push("session-3", "listener-3", "terminal:state-changed", {});

      const count = queue.clearAll();

      expect(count).toBe(3);
      expect(queue.countAll("session-1")).toBe(0);
      expect(queue.countAll("session-2")).toBe(0);
      expect(queue.countAll("session-3")).toBe(0);
    });

    it("returns 0 when queue is empty", () => {
      const count = queue.clearAll();
      expect(count).toBe(0);
    });

    it("can be called multiple times safely", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});

      queue.clearAll();
      const count = queue.clearAll();

      expect(count).toBe(0);
    });
  });

  describe("countPending", () => {
    it("returns count of unacknowledged events", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});
      const event2 = queue.push("session-1", "listener-2", "terminal:state-changed", {});
      queue.push("session-1", "listener-3", "terminal:state-changed", {});

      queue.acknowledge(event2.id);

      expect(queue.countPending("session-1")).toBe(2);
    });

    it("returns 0 for session with no events", () => {
      expect(queue.countPending("session-1")).toBe(0);
    });

    it("returns 0 when all events are acknowledged", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", {});
      queue.acknowledge(event.id);

      expect(queue.countPending("session-1")).toBe(0);
    });
  });

  describe("countAll", () => {
    it("returns total count including acknowledged events", () => {
      queue.push("session-1", "listener-1", "terminal:state-changed", {});
      const event2 = queue.push("session-1", "listener-2", "terminal:state-changed", {});

      queue.acknowledge(event2.id);

      expect(queue.countAll("session-1")).toBe(2);
    });

    it("returns 0 for session with no events", () => {
      expect(queue.countAll("session-1")).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles events with null data", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", null);
      expect(event.data).toBeNull();
    });

    it("handles events with undefined data", () => {
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", undefined);
      expect(event.data).toBeUndefined();
    });

    it("handles events with complex nested data", () => {
      const data = {
        terminal: { id: "term-1", state: "working" },
        metadata: { tags: ["a", "b"], count: 5 },
      };
      const event = queue.push("session-1", "listener-1", "terminal:state-changed", data);
      expect(event.data).toEqual(data);
    });

    it("isolates acknowledged state between events", () => {
      const event1 = queue.push("session-1", "listener-1", "terminal:state-changed", {});
      const event2 = queue.push("session-1", "listener-2", "terminal:state-changed", {});

      queue.acknowledge(event1.id);

      const all = queue.getAll("session-1");
      const found1 = all.find((e) => e.id === event1.id);
      const found2 = all.find((e) => e.id === event2.id);

      expect(found1?.acknowledged).toBe(true);
      expect(found2?.acknowledged).toBe(false);
    });

    it("generates unique event IDs", () => {
      const ids = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const event = queue.push("session-1", `listener-${i}`, "terminal:state-changed", {});
        expect(ids.has(event.id)).toBe(false);
        ids.add(event.id);
      }

      expect(ids.size).toBe(50);
    });
  });
});
