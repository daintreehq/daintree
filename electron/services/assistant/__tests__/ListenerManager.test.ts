import { describe, it, expect, beforeEach } from "vitest";
import { ListenerManager } from "../ListenerManager.js";

describe("ListenerManager", () => {
  let manager: ListenerManager;

  beforeEach(() => {
    manager = new ListenerManager();
  });

  describe("register", () => {
    it("registers a listener and returns an id", () => {
      const id = manager.register("session-1", "terminal:state-changed");
      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
      expect(manager.size()).toBe(1);
    });

    it("registers multiple listeners for the same session", () => {
      const id1 = manager.register("session-1", "terminal:state-changed");
      const id2 = manager.register("session-1", "agent:spawned");

      expect(id1).not.toBe(id2);
      expect(manager.size()).toBe(2);
    });

    it("registers listeners with filters", () => {
      const id = manager.register("session-1", "terminal:state-changed", {
        terminalId: "term-1",
      });

      const listener = manager.get(id);
      expect(listener?.filter).toEqual({ terminalId: "term-1" });
    });

    it("registers one-shot listeners with once: true", () => {
      const id = manager.register("session-1", "terminal:state-changed", undefined, true);

      const listener = manager.get(id);
      expect(listener?.once).toBe(true);
    });

    it("registers regular listeners without once flag", () => {
      const id = manager.register("session-1", "terminal:state-changed");

      const listener = manager.get(id);
      expect(listener?.once).toBeUndefined();
    });

    it("registers listeners with once: false", () => {
      const id = manager.register("session-1", "terminal:state-changed", undefined, false);

      const listener = manager.get(id);
      expect(listener?.once).toBe(false);
    });

    it("creates listeners with correct createdAt timestamp", () => {
      const before = Date.now();
      const id = manager.register("session-1", "terminal:state-changed");
      const after = Date.now();

      const listener = manager.get(id);
      expect(listener?.createdAt).toBeGreaterThanOrEqual(before);
      expect(listener?.createdAt).toBeLessThanOrEqual(after);
    });
  });

  describe("unregister", () => {
    it("removes a registered listener", () => {
      const id = manager.register("session-1", "terminal:state-changed");
      expect(manager.size()).toBe(1);

      const result = manager.unregister(id);
      expect(result).toBe(true);
      expect(manager.size()).toBe(0);
    });

    it("returns false when unregistering non-existent listener", () => {
      const result = manager.unregister("non-existent-id");
      expect(result).toBe(false);
    });

    it("does not affect other listeners when unregistering", () => {
      const id1 = manager.register("session-1", "terminal:state-changed");
      const id2 = manager.register("session-1", "agent:spawned");

      manager.unregister(id1);

      expect(manager.get(id1)).toBeUndefined();
      expect(manager.get(id2)).toBeDefined();
      expect(manager.size()).toBe(1);
    });
  });

  describe("get", () => {
    it("returns listener by id", () => {
      const id = manager.register("session-1", "terminal:state-changed", {
        terminalId: "term-1",
      });

      const listener = manager.get(id);
      expect(listener).toBeDefined();
      expect(listener?.id).toBe(id);
      expect(listener?.sessionId).toBe("session-1");
      expect(listener?.eventType).toBe("terminal:state-changed");
      expect(listener?.filter).toEqual({ terminalId: "term-1" });
    });

    it("returns undefined for non-existent listener", () => {
      const listener = manager.get("non-existent-id");
      expect(listener).toBeUndefined();
    });
  });

  describe("listForSession", () => {
    it("returns all listeners for a session", () => {
      manager.register("session-1", "terminal:state-changed");
      manager.register("session-1", "agent:spawned");
      manager.register("session-2", "terminal:state-changed");

      const listeners = manager.listForSession("session-1");
      expect(listeners.length).toBe(2);
      expect(listeners.every((l) => l.sessionId === "session-1")).toBe(true);
    });

    it("returns empty array for session with no listeners", () => {
      manager.register("session-1", "terminal:state-changed");

      const listeners = manager.listForSession("session-2");
      expect(listeners).toEqual([]);
    });

    it("returns empty array when manager is empty", () => {
      const listeners = manager.listForSession("session-1");
      expect(listeners).toEqual([]);
    });
  });

  describe("clearSession", () => {
    it("removes all listeners for a session", () => {
      manager.register("session-1", "terminal:state-changed");
      manager.register("session-1", "agent:spawned");
      manager.register("session-2", "terminal:state-changed");

      manager.clearSession("session-1");

      expect(manager.listForSession("session-1")).toEqual([]);
      expect(manager.listForSession("session-2").length).toBe(1);
      expect(manager.size()).toBe(1);
    });

    it("does nothing when session has no listeners", () => {
      manager.register("session-1", "terminal:state-changed");

      manager.clearSession("session-2");

      expect(manager.size()).toBe(1);
    });

    it("does nothing when manager is empty", () => {
      manager.clearSession("session-1");
      expect(manager.size()).toBe(0);
    });
  });

  describe("getMatchingListeners", () => {
    it("returns listeners matching event type without filters", () => {
      manager.register("session-1", "terminal:state-changed");
      manager.register("session-2", "terminal:state-changed");
      manager.register("session-3", "agent:spawned");

      const listeners = manager.getMatchingListeners("terminal:state-changed", {
        terminalId: "term-1",
      });

      expect(listeners.length).toBe(2);
      expect(listeners.every((l) => l.eventType === "terminal:state-changed")).toBe(true);
    });

    it("returns listeners matching event type and filter", () => {
      manager.register("session-1", "terminal:state-changed", { terminalId: "term-1" });
      manager.register("session-2", "terminal:state-changed", { terminalId: "term-2" });
      manager.register("session-3", "terminal:state-changed");

      const listeners = manager.getMatchingListeners("terminal:state-changed", {
        terminalId: "term-1",
        state: "working",
      });

      expect(listeners.length).toBe(2);
      expect(listeners.some((l) => l.filter?.terminalId === "term-1")).toBe(true);
      expect(listeners.some((l) => l.filter === undefined)).toBe(true);
    });

    it("excludes listeners with non-matching filters", () => {
      manager.register("session-1", "terminal:state-changed", { terminalId: "term-1" });
      manager.register("session-2", "terminal:state-changed", { terminalId: "term-2" });

      const listeners = manager.getMatchingListeners("terminal:state-changed", {
        terminalId: "term-1",
      });

      expect(listeners.length).toBe(1);
      expect(listeners[0].filter?.terminalId).toBe("term-1");
    });

    it("returns empty array when no listeners match event type", () => {
      manager.register("session-1", "terminal:state-changed");

      const listeners = manager.getMatchingListeners("agent:spawned", {});
      expect(listeners).toEqual([]);
    });

    it("handles multiple filter criteria", () => {
      manager.register("session-1", "terminal:state-changed", {
        terminalId: "term-1",
        worktreeId: "wt-1",
      });
      manager.register("session-2", "terminal:state-changed", {
        terminalId: "term-1",
        worktreeId: "wt-2",
      });
      manager.register("session-3", "terminal:state-changed", {
        terminalId: "term-1",
      });

      const listeners = manager.getMatchingListeners("terminal:state-changed", {
        terminalId: "term-1",
        worktreeId: "wt-1",
      });

      expect(listeners.length).toBe(2);
    });

    it("returns empty array when data does not match any filter", () => {
      manager.register("session-1", "terminal:state-changed", { terminalId: "term-1" });

      const listeners = manager.getMatchingListeners("terminal:state-changed", {
        terminalId: "term-2",
      });

      expect(listeners).toEqual([]);
    });

    it("handles non-object data with filters", () => {
      manager.register("session-1", "terminal:state-changed", { terminalId: "term-1" });
      manager.register("session-2", "terminal:state-changed");

      const listeners = manager.getMatchingListeners("terminal:state-changed", "string-data");

      expect(listeners.length).toBe(1);
      expect(listeners[0].filter).toBeUndefined();
    });

    it("handles null data with filters", () => {
      manager.register("session-1", "terminal:state-changed", { terminalId: "term-1" });
      manager.register("session-2", "terminal:state-changed");

      const listeners = manager.getMatchingListeners("terminal:state-changed", null);

      expect(listeners.length).toBe(1);
      expect(listeners[0].filter).toBeUndefined();
    });

    it("handles empty filter object", () => {
      manager.register("session-1", "terminal:state-changed", {});

      const listeners = manager.getMatchingListeners("terminal:state-changed", {
        terminalId: "term-1",
      });

      expect(listeners.length).toBe(1);
    });
  });

  describe("size", () => {
    it("returns 0 for empty manager", () => {
      expect(manager.size()).toBe(0);
    });

    it("returns correct count after registrations", () => {
      manager.register("session-1", "terminal:state-changed");
      manager.register("session-2", "agent:spawned");

      expect(manager.size()).toBe(2);
    });

    it("returns correct count after unregistrations", () => {
      const id1 = manager.register("session-1", "terminal:state-changed");
      manager.register("session-2", "agent:spawned");

      manager.unregister(id1);

      expect(manager.size()).toBe(1);
    });
  });

  describe("clear", () => {
    it("removes all listeners", () => {
      manager.register("session-1", "terminal:state-changed");
      manager.register("session-2", "agent:spawned");

      manager.clear();

      expect(manager.size()).toBe(0);
    });

    it("does nothing when manager is empty", () => {
      manager.clear();
      expect(manager.size()).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles registering listeners with same event type across sessions", () => {
      const id1 = manager.register("session-1", "terminal:state-changed");
      const id2 = manager.register("session-2", "terminal:state-changed");

      expect(id1).not.toBe(id2);
      expect(manager.size()).toBe(2);
    });

    it("filter matching uses Object.is equality", () => {
      manager.register("session-1", "terminal:state-changed", { count: 1 });
      manager.register("session-2", "terminal:state-changed", { value: 0 });
      manager.register("session-3", "terminal:state-changed", { flag: false });

      const listenersWithNumber = manager.getMatchingListeners("terminal:state-changed", {
        count: 1,
      });
      const listenersWithString = manager.getMatchingListeners("terminal:state-changed", {
        count: "1",
      });
      const listenersWithZero = manager.getMatchingListeners("terminal:state-changed", {
        value: 0,
      });
      const listenersWithNegativeZero = manager.getMatchingListeners("terminal:state-changed", {
        value: -0,
      });

      expect(listenersWithNumber.length).toBe(1);
      expect(listenersWithString.length).toBe(0);
      expect(listenersWithZero.length).toBe(1);
      expect(listenersWithNegativeZero.length).toBe(0);
    });

    it("filter requires exact property presence", () => {
      manager.register("session-1", "terminal:state-changed", { terminalId: "term-1" });

      const listenersWithExtraProps = manager.getMatchingListeners("terminal:state-changed", {
        terminalId: "term-1",
        extraProp: "value",
      });
      const listenersWithMissingProps = manager.getMatchingListeners("terminal:state-changed", {
        differentProp: "value",
      });

      expect(listenersWithExtraProps.length).toBe(1);
      expect(listenersWithMissingProps.length).toBe(0);
    });

    it("undefined filter matches any object data", () => {
      manager.register("session-1", "terminal:state-changed");

      const listenersWithData = manager.getMatchingListeners("terminal:state-changed", {
        terminalId: "term-1",
      });
      const listenersWithNull = manager.getMatchingListeners("terminal:state-changed", null);
      const listenersWithString = manager.getMatchingListeners("terminal:state-changed", "string");

      expect(listenersWithData.length).toBe(1);
      expect(listenersWithNull.length).toBe(1);
      expect(listenersWithString.length).toBe(1);
    });

    it("filter with null value matches null exactly", () => {
      manager.register("session-1", "terminal:state-changed", { status: null });

      const listenersWithNull = manager.getMatchingListeners("terminal:state-changed", {
        status: null,
      });
      const listenersWithUndefined = manager.getMatchingListeners("terminal:state-changed", {
        status: undefined,
      });
      const listenersWithString = manager.getMatchingListeners("terminal:state-changed", {
        status: "active",
      });

      expect(listenersWithNull.length).toBe(1);
      expect(listenersWithUndefined.length).toBe(0);
      expect(listenersWithString.length).toBe(0);
    });

    it("rejects invalid filter with non-primitive values", () => {
      expect(() =>
        manager.register("session-1", "terminal:state-changed", {
          nested: { value: 123 },
        } as unknown as any)
      ).toThrow("Invalid listener registration");
    });

    it("rejects registration with empty sessionId", () => {
      expect(() => manager.register("", "terminal:state-changed")).toThrow(
        "Invalid listener registration"
      );
    });

    it("rejects registration with empty eventType", () => {
      expect(() => manager.register("session-1", "")).toThrow("Invalid listener registration");
    });

    it("double unregister returns false on second call", () => {
      const id = manager.register("session-1", "terminal:state-changed");

      const first = manager.unregister(id);
      const second = manager.unregister(id);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it("repeated clearSession is safe", () => {
      manager.register("session-1", "terminal:state-changed");

      manager.clearSession("session-1");
      manager.clearSession("session-1");

      expect(manager.size()).toBe(0);
    });

    it("repeated clear is safe", () => {
      manager.register("session-1", "terminal:state-changed");

      manager.clear();
      manager.clear();

      expect(manager.size()).toBe(0);
    });
  });
});
