/**
 * Tests for EventBuffer - Ring buffer for storing and filtering recent system events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBuffer } from "../EventBuffer.js";
import { events } from "../events.js";

describe("EventBuffer", () => {
  let buffer: EventBuffer;

  beforeEach(() => {
    buffer = new EventBuffer(10);
    buffer.start();
  });

  afterEach(() => {
    buffer.stop();
  });

  describe("basic operations", () => {
    it("starts with an empty buffer", () => {
      const freshBuffer = new EventBuffer(10);
      expect(freshBuffer.size()).toBe(0);
      expect(freshBuffer.getAll()).toEqual([]);
    });

    it("captures events when started", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(buffer.size()).toBe(1);
    });

    it("can be stopped and started", () => {
      buffer.stop();

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(buffer.size()).toBe(0);

      buffer.start();

      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "gemini",
        timestamp: Date.now(),
      });

      expect(buffer.size()).toBe(1);
    });

    it("clears the buffer", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(buffer.size()).toBe(1);
      buffer.clear();
      expect(buffer.size()).toBe(0);
    });
  });

  describe("ring buffer behavior", () => {
    it("enforces max size", () => {
      // Buffer is initialized with maxSize of 10
      for (let i = 0; i < 20; i++) {
        events.emit("agent:spawned", {
          agentId: `agent-${i}`,
          terminalId: `term-${i}`,
          type: "claude",
          timestamp: Date.now(),
        });
      }

      expect(buffer.size()).toBe(10);
    });

    it("keeps most recent events when buffer overflows", () => {
      for (let i = 0; i < 20; i++) {
        events.emit("agent:spawned", {
          agentId: `agent-${i}`,
          terminalId: `term-${i}`,
          type: "claude",
          timestamp: Date.now(),
        });
      }

      const all = buffer.getAll();
      expect(all.length).toBe(10);

      // Oldest event should be agent-10, newest should be agent-19
      expect(all[0].payload.agentId).toBe("agent-10");
      expect(all[9].payload.agentId).toBe("agent-19");
    });

    it("maintains FIFO order", () => {
      events.emit("agent:spawned", {
        agentId: "first",
        terminalId: "t1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "second",
        terminalId: "t2",
        type: "gemini",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      expect(all[0].payload.agentId).toBe("first");
      expect(all[1].payload.agentId).toBe("second");
    });
  });

  describe("filtering", () => {
    beforeEach(() => {
      // Clear and add test events
      buffer.clear();

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        worktreeId: "wt-1",
        timestamp: Date.now() - 5000,
      });
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now() - 4000,
        trigger: "output",
        confidence: 1.0,
      });
      events.emit("sys:worktree:update", {
        id: "wt-1",
        path: "/foo/bar",
        name: "bar",
        branch: "main",
        isCurrent: true,
        worktreeId: "wt-1",
        worktreeChanges: null,
        lastActivityTimestamp: null,
        aiStatus: "disabled",
        timestamp: Date.now() - 3000,
      } as any);
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "gemini",
        worktreeId: "wt-2",
        timestamp: Date.now() - 2000,
      });
    });

    it("filters by event type", () => {
      const filtered = buffer.getFiltered({ types: ["agent:spawned"] });
      expect(filtered.length).toBe(2);
      expect(filtered.every((e) => e.type === "agent:spawned")).toBe(true);
    });

    it("filters by multiple event types", () => {
      const filtered = buffer.getFiltered({
        types: ["agent:spawned", "agent:state-changed"],
      });
      expect(filtered.length).toBe(3);
    });

    it("filters by agentId", () => {
      const filtered = buffer.getFiltered({ agentId: "agent-1" });
      expect(filtered.length).toBe(2);
      expect(filtered.every((e) => e.payload.agentId === "agent-1")).toBe(true);
    });

    it("filters by worktreeId", () => {
      const filtered = buffer.getFiltered({ worktreeId: "wt-1" });
      expect(filtered.length).toBe(2);
    });

    it("filters by time range (after)", () => {
      // Get all events and find the timestamp of the first one
      const all = buffer.getAll();
      const firstTimestamp = all[0].timestamp;

      // Filter for events after the first one - should exclude the first
      const filtered = buffer.getFiltered({ after: firstTimestamp + 1 });
      expect(filtered.length).toBeLessThan(all.length);
    });

    it("filters by time range (before)", () => {
      // Get all events and find the timestamp of the last one
      const all = buffer.getAll();
      const lastTimestamp = all[all.length - 1].timestamp;

      // Filter for events before the last one - should exclude the last
      const filtered = buffer.getFiltered({ before: lastTimestamp - 1 });
      expect(filtered.length).toBeLessThan(all.length);
    });

    it("filters by combined time range", () => {
      const all = buffer.getAll();
      const firstTimestamp = all[0].timestamp;
      const lastTimestamp = all[all.length - 1].timestamp;

      // Get events in the middle (if timestamps differ)
      // At minimum, all events should be included if we use first/last as bounds
      const filtered = buffer.getFiltered({
        after: firstTimestamp,
        before: lastTimestamp + 1,
      });
      expect(filtered.length).toBe(all.length);
    });

    it("filters by text search in payload", () => {
      const filtered = buffer.getFiltered({ search: "agent-1" });
      expect(filtered.length).toBe(2);
    });

    it("filters by text search in event type", () => {
      const filtered = buffer.getFiltered({ search: "state-changed" });
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe("agent:state-changed");
    });

    it("combines multiple filters", () => {
      const filtered = buffer.getFiltered({
        types: ["agent:spawned"],
        agentId: "agent-1",
      });
      expect(filtered.length).toBe(1);
      expect(filtered[0].payload.agentId).toBe("agent-1");
    });

    it("returns empty array when no matches", () => {
      const filtered = buffer.getFiltered({ agentId: "nonexistent" });
      expect(filtered).toEqual([]);
    });

    it("returns all events when no filters provided", () => {
      const all = buffer.getFiltered({});
      expect(all.length).toBe(4);
    });
  });

  describe("sanitization", () => {
    beforeEach(() => {
      buffer.clear();
    });

    it("redacts agent:output data field", () => {
      events.emit("agent:output", {
        agentId: "agent-1",
        data: "API_KEY=secret123\nPassword: supersecret",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      const outputEvent = all.find((e) => e.type === "agent:output");

      expect(outputEvent).toBeDefined();
      expect(outputEvent?.payload.data).toBe("[REDACTED - May contain sensitive information]");
      expect(outputEvent?.payload.agentId).toBe("agent-1"); // agentId should not be redacted
    });

    it("ensures redacted secrets are unrecoverable via search", () => {
      events.emit("agent:output", {
        agentId: "agent-1",
        data: "API_KEY=secret123 and PASSWORD=topsecret",
        timestamp: Date.now(),
      });

      // Verify secrets cannot be found via text search
      const searchSecret = buffer.getFiltered({ search: "secret123" });
      expect(searchSecret.length).toBe(0);

      const searchPassword = buffer.getFiltered({ search: "topsecret" });
      expect(searchPassword.length).toBe(0);

      // But can still find the event by non-sensitive fields
      const searchAgent = buffer.getFiltered({ search: "agent-1" });
      expect(searchAgent.length).toBe(1);
    });

    it("redacts task:created description field", () => {
      events.emit("task:created", {
        taskId: "task-1",
        description: "Process user credentials for API_KEY=secret",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      const taskEvent = all.find((e) => e.type === "task:created");

      expect(taskEvent).toBeDefined();
      expect(taskEvent?.payload.description).toBe("[REDACTED - May contain sensitive information]");
      expect(taskEvent?.payload.taskId).toBe("task-1"); // taskId should not be redacted
    });

    it("does not redact non-sensitive events", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      const spawnedEvent = all.find((e) => e.type === "agent:spawned");

      expect(spawnedEvent).toBeDefined();
      expect(spawnedEvent?.payload.agentId).toBe("agent-1");
      expect(spawnedEvent?.payload.type).toBe("claude");
    });

    it("does not redact agent:state-changed events", () => {
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "heuristic",
        confidence: 0.9,
      });

      const all = buffer.getAll();
      const stateEvent = all.find((e) => e.type === "agent:state-changed");

      expect(stateEvent).toBeDefined();
      expect(stateEvent?.payload.state).toBe("working");
      expect(stateEvent?.payload.previousState).toBe("idle");
      // Verify trigger and confidence metadata survive sanitization
      expect(stateEvent?.payload.trigger).toBe("heuristic");
      expect(stateEvent?.payload.confidence).toBe(0.9);
    });
  });

  describe("event record structure", () => {
    it("generates unique IDs for events", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "gemini",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      expect(all[0].id).not.toBe(all[1].id);
    });

    it("includes timestamp in event records", () => {
      const before = Date.now();
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });
      const after = Date.now();

      const all = buffer.getAll();
      expect(all[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(all[0].timestamp).toBeLessThanOrEqual(after);
    });

    it("includes correct event type in records", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      expect(all[0].type).toBe("agent:spawned");
    });

    it("includes source as 'main' for all events", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      expect(all[0].source).toBe("main");
    });
  });

  describe("edge cases", () => {
    beforeEach(() => {
      buffer.clear();
    });

    it("handles empty buffer for getFiltered", () => {
      const filtered = buffer.getFiltered({ types: ["agent:spawned"] });
      expect(filtered).toEqual([]);
    });

    it("handles search with special characters", () => {
      events.emit("agent:spawned", {
        agentId: "agent-[1]",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      const filtered = buffer.getFiltered({ search: "[1]" });
      expect(filtered.length).toBe(1);
    });

    it("handles payload that cannot be stringified", () => {
      // Manually push an event with circular reference to test the catch block
      // We need to bypass sanitization to get a circular payload into the buffer
      const circularPayload: any = { agentId: "agent-circular" };
      circularPayload.self = circularPayload;

      // Access the private push method via type assertion for testing
      (buffer as any).push({
        id: "circular-test",
        timestamp: Date.now(),
        type: "agent:spawned",
        category: "agent",
        payload: circularPayload,
        source: "main",
      });

      // The getFiltered should not throw when it encounters the circular reference
      expect(() => buffer.getFiltered({ search: "agent-circular" })).not.toThrow();

      // The circular event should be excluded from search results (catch block returns false)
      const searchResults = buffer.getFiltered({ search: "agent-circular" });
      expect(searchResults.length).toBe(0);
    });

    it("warns when start is called multiple times", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      buffer.start(); // Already started in beforeEach

      expect(warnSpy).toHaveBeenCalledWith("[EventBuffer] Already started");

      warnSpy.mockRestore();
    });

    it("handles stop when not started", () => {
      const freshBuffer = new EventBuffer(10);
      expect(() => freshBuffer.stop()).not.toThrow();
    });
  });

  describe("filtering with taskId and traceId", () => {
    beforeEach(() => {
      buffer.clear();

      events.emit("task:created", {
        taskId: "task-1",
        description: "Test task",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });
      events.emit("task:assigned", {
        taskId: "task-1",
        agentId: "agent-1",
        timestamp: Date.now(),
      });
      events.emit("task:state-changed", {
        taskId: "task-1",
        state: "running",
        previousState: "queued",
        timestamp: Date.now(),
      });
    });

    it("filters by taskId", () => {
      const filtered = buffer.getFiltered({ taskId: "task-1" });
      expect(filtered.length).toBe(3);
    });

    it("filters by traceId", () => {
      buffer.clear();

      // Emit events with different trace IDs
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
        traceId: "trace-alpha",
      });
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        traceId: "trace-alpha",
        trigger: "output",
        confidence: 1.0,
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "gemini",
        timestamp: Date.now(),
        traceId: "trace-beta",
      });

      // Filter by first trace ID
      const traceAlpha = buffer.getFiltered({ traceId: "trace-alpha" });
      expect(traceAlpha.length).toBe(2);
      expect(traceAlpha.every((e) => e.payload.traceId === "trace-alpha")).toBe(true);

      // Filter by second trace ID
      const traceBeta = buffer.getFiltered({ traceId: "trace-beta" });
      expect(traceBeta.length).toBe(1);
      expect(traceBeta[0].payload.traceId).toBe("trace-beta");
    });

    it("combines traceId with other filters", () => {
      buffer.clear();

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
        traceId: "trace-1",
      });
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        traceId: "trace-1",
        trigger: "output",
        confidence: 1.0,
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "gemini",
        timestamp: Date.now(),
        traceId: "trace-1",
      });

      // Filter by trace ID AND agent ID
      const filtered = buffer.getFiltered({
        traceId: "trace-1",
        agentId: "agent-1",
      });
      expect(filtered.length).toBe(2);
    });
  });

  describe("category support", () => {
    beforeEach(() => {
      buffer.clear();
    });

    it("includes category in event records derived from EVENT_META", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      expect(all[0].category).toBe("agent");
    });

    it("assigns correct category to different event types", () => {
      events.emit("task:created", {
        taskId: "task-1",
        description: "Test task",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      events.emit("sys:worktree:update", {
        id: "wt-1",
        path: "/foo/bar",
        name: "bar",
        branch: "main",
        isCurrent: true,
        worktreeId: "wt-1",
        worktreeChanges: null,
        lastActivityTimestamp: null,
        aiStatus: "disabled",
      } as any);

      const all = buffer.getAll();
      const taskEvent = all.find((e) => e.type === "task:created");
      const sysEvent = all.find((e) => e.type === "sys:worktree:update");

      expect(taskEvent?.category).toBe("task");
      expect(sysEvent?.category).toBe("system");
    });

    it("filters by category", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });
      events.emit("task:created", {
        taskId: "task-1",
        description: "Test task",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      const agentEvents = buffer.getFiltered({ category: "agent" });
      expect(agentEvents.length).toBe(2);
      expect(agentEvents.every((e) => e.category === "agent")).toBe(true);

      const taskEvents = buffer.getFiltered({ category: "task" });
      expect(taskEvents.length).toBe(1);
      expect(taskEvents[0].category).toBe("task");
    });

    it("combines category filter with other filters", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "gemini",
        timestamp: Date.now(),
      });
      events.emit("task:created", {
        taskId: "task-1",
        description: "Test task",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      const filtered = buffer.getFiltered({
        category: "agent",
        agentId: "agent-1",
      });
      expect(filtered.length).toBe(1);
      expect(filtered[0].payload.agentId).toBe("agent-1");
    });

    it("getEventsByCategory returns events for specific category", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("task:created", {
        taskId: "task-1",
        description: "Test task",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      const agentEvents = buffer.getEventsByCategory("agent");
      expect(agentEvents.length).toBe(1);
      expect(agentEvents[0].type).toBe("agent:spawned");

      const taskEvents = buffer.getEventsByCategory("task");
      expect(taskEvents.length).toBe(1);
      expect(taskEvents[0].type).toBe("task:created");
    });

    it("getCategoryStats returns correct counts", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });
      events.emit("task:created", {
        taskId: "task-1",
        description: "Test task",
        worktreeId: "wt-1",
        timestamp: Date.now(),
      });

      const stats = buffer.getCategoryStats();
      expect(stats.agent).toBe(2);
      expect(stats.task).toBe(1);
      expect(stats.system).toBe(0);
    });

    it("returns empty array for category with no events", () => {
      // Don't emit any task events
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      const taskEvents = buffer.getEventsByCategory("task");
      expect(taskEvents).toEqual([]);

      const stats = buffer.getCategoryStats();
      expect(stats.task).toBe(0);
    });
  });

  describe("custom buffer sizes", () => {
    it("respects custom max size of 1", () => {
      const tinyBuffer = new EventBuffer(1);
      tinyBuffer.start();

      events.emit("agent:spawned", {
        agentId: "first",
        terminalId: "t1",
        type: "claude",
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "second",
        terminalId: "t2",
        type: "gemini",
        timestamp: Date.now(),
      });

      expect(tinyBuffer.size()).toBe(1);
      expect(tinyBuffer.getAll()[0].payload.agentId).toBe("second");

      tinyBuffer.stop();
    });

    it("handles large buffer size", () => {
      const largeBuffer = new EventBuffer(1000);
      largeBuffer.start();

      for (let i = 0; i < 100; i++) {
        events.emit("agent:spawned", {
          agentId: `agent-${i}`,
          terminalId: `term-${i}`,
          type: "claude",
          timestamp: Date.now(),
        });
      }

      expect(largeBuffer.size()).toBe(100);

      largeBuffer.stop();
    });
  });

  describe("onRecord callback", () => {
    beforeEach(() => {
      buffer.clear();
    });

    it("invokes callback when event is recorded", () => {
      const callback = vi.fn();
      buffer.onRecord(callback);

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:spawned",
          payload: expect.objectContaining({ agentId: "agent-1" }),
        })
      );
    });

    it("returns unsubscribe function", () => {
      const callback = vi.fn();
      const unsubscribe = buffer.onRecord(callback);

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        type: "gemini",
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("supports multiple callbacks", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      buffer.onRecord(callback1);
      buffer.onRecord(callback2);

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("continues with other callbacks if one throws", () => {
      const errorCallback = vi.fn(() => {
        throw new Error("Test error");
      });
      const normalCallback = vi.fn();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      buffer.onRecord(errorCallback);
      buffer.onRecord(normalCallback);

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(errorCallback).toHaveBeenCalledTimes(1);
      expect(normalCallback).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        "[EventBuffer] Error in onRecord callback:",
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it("unsubscribe is idempotent", () => {
      const callback = vi.fn();
      const unsubscribe = buffer.onRecord(callback);

      unsubscribe();
      unsubscribe();

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        type: "claude",
        timestamp: Date.now(),
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it("receives sanitized payload for sensitive events", () => {
      const callback = vi.fn();
      buffer.onRecord(callback);

      events.emit("agent:output", {
        agentId: "agent-1",
        data: "SECRET_KEY=12345",
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: "[REDACTED - May contain sensitive information]",
          }),
        })
      );
    });
  });
});
