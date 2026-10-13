/**
 * Tests for EventBuffer - Ring buffer for storing and filtering recent system events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBuffer } from "../EventBuffer.js";
import { events, type DaintreeEventMap } from "../events.js";
import type { WorktreeState } from "../../../shared/types/index.js";

type NotifyEventPayload = DaintreeEventMap["ui:notify"] & { timestamp: number };

describe("EventBuffer", () => {
  let buffer: EventBuffer;

  beforeEach(() => {
    buffer = new EventBuffer(10);
    buffer.start();
  });

  afterEach(() => {
    buffer.stop();
  });

  describe("by-reference snapshot events", () => {
    it("hands readers isolated copies of sys:worktree:update payloads", () => {
      const snapshot = {
        worktreeId: "wt-1",
        branch: "a",
        timestamp: 1,
      } as unknown as WorktreeState;
      events.emit("sys:worktree:update", snapshot);

      const first = buffer.getAll()[0];
      expect(first.payload).toEqual(snapshot);
      expect(first.payload).not.toBe(snapshot);
      first.payload.branch = "mutated";

      expect(buffer.getAll()[0].payload.branch).toBe("a");
      expect(buffer.getFiltered({ worktreeId: "wt-1" })[0].payload).not.toBe(snapshot);
    });
  });

  describe("basic operations", () => {
    it("can be stopped and started", () => {
      buffer.stop();

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(buffer.size()).toBe(0);

      buffer.start();

      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        timestamp: Date.now(),
      });

      expect(buffer.size()).toBe(1);
    });
  });

  describe("at capacity 3", () => {
    beforeEach(() => {
      buffer.stop();
      buffer = new EventBuffer(3);
      buffer.start();
    });

    it("evicts only after crossing the exact capacity boundary", () => {
      for (let i = 0; i < 3; i++) {
        events.emit("agent:spawned", {
          agentId: `agent-${i}`,
          terminalId: `term-${i}`,
          timestamp: i + 1,
        });
      }

      expect(buffer.getAll().map((event) => event.payload.agentId)).toEqual([
        "agent-0",
        "agent-1",
        "agent-2",
      ]);

      events.emit("agent:spawned", {
        agentId: "agent-3",
        terminalId: "term-3",
        timestamp: 4,
      });

      expect(buffer.getAll().map((event) => event.payload.agentId)).toEqual([
        "agent-1",
        "agent-2",
        "agent-3",
      ]);
    });

    it("keeps callback dispatch stable when listeners unsubscribe and subscribe during eviction", () => {
      const calls: string[] = [];

      let offFirst = () => {};
      let offSecond = () => {};

      offFirst = buffer.onRecord((record) => {
        calls.push(`first:${record.payload.agentId}`);
        offFirst();
        offSecond();
        buffer.onRecord((nextRecord) => {
          calls.push(`third:${nextRecord.payload.agentId}`);
        });
      });

      offSecond = buffer.onRecord((record) => {
        calls.push(`second:${record.payload.agentId}`);
      });

      events.emit("agent:spawned", {
        agentId: "agent-a",
        terminalId: "term-a",
        timestamp: 1,
      });
      events.emit("agent:spawned", {
        agentId: "agent-b",
        terminalId: "term-b",
        timestamp: 2,
      });

      expect(calls).toEqual(["first:agent-a", "second:agent-a", "third:agent-b"]);
    });

    it("preserves redaction even if a caller mutates a record returned by getAll", () => {
      events.emit("agent:output", {
        agentId: "agent-1",
        data: "TOKEN=super-secret",
        timestamp: 1,
      });

      const [record] = buffer.getAll();
      record.payload.data = "TOKEN=super-secret";

      expect(buffer.getFiltered({ search: "super-secret" })).toEqual([]);
      expect(buffer.getAll()[0].payload.data).toBe(
        "[REDACTED - May contain sensitive information]"
      );
    });

    it("returns filtered snapshots that cannot reintroduce redacted payloads", () => {
      events.emit("agent:output", {
        agentId: "agent-1",
        data: "apiKey=super-secret",
        timestamp: 1,
      });

      const [record] = buffer.getFiltered({ agentId: "agent-1" });
      record.payload.data = "apiKey=super-secret";

      expect(buffer.getFiltered({ search: "super-secret" })).toEqual([]);
      expect(buffer.getFiltered({ agentId: "agent-1" })[0].payload.data).toBe(
        "[REDACTED - May contain sensitive information]"
      );
    });

    it("filters large payloads without truncating searchable fields", () => {
      const payload: NotifyEventPayload = {
        message: `${"x".repeat(250_000)}needle`,
        type: "info",
        timestamp: 1,
      };

      events.emit("ui:notify", payload);

      const matches = buffer.getFiltered({ search: "needle" });

      expect(matches).toHaveLength(1);
      expect(matches[0].type).toBe("ui:notify");
    });
  });

  describe("filtering", () => {
    beforeEach(() => {
      // Clear and add test events
      buffer.clear();

      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
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
        worktreeId: "wt-2",
        timestamp: Date.now() - 2000,
      });
    });

    it("filters by event type", () => {
      const filtered = buffer.getFiltered({ types: ["agent:spawned"] });
      expect(filtered.length).toBe(2);
      expect(filtered.every((e) => e.type === "agent:spawned")).toBe(true);
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

    it("redacts a handback message but keeps the rest of the transition (#12488)", () => {
      events.emit("agent:state-changed", {
        agentId: "claude",
        terminalId: "term-1",
        state: "waiting",
        previousState: "working",
        trigger: "activity",
        confidence: 1,
        timestamp: Date.now(),
        lastHandback: {
          message: "HANDBACK-SENTINEL migrated the schema",
          observedAt: 1_700_000_000_000,
          submissionToken: "tok-1",
          truncated: false,
        },
      });

      const event = buffer.getAll().find((e) => e.type === "agent:state-changed");

      expect(event?.payload.state).toBe("waiting");
      expect(event?.payload.lastHandback).toEqual({
        message: "[REDACTED - May contain sensitive information]",
        observedAt: 1_700_000_000_000,
        submissionToken: "tok-1",
        truncated: false,
      });
      expect(buffer.getFiltered({ search: "HANDBACK-SENTINEL" })).toHaveLength(0);
    });

    it("leaves a state change without a handback message as it was", () => {
      const payload = {
        agentId: "claude",
        terminalId: "term-1",
        state: "waiting" as const,
        previousState: "working" as const,
        trigger: "activity" as const,
        confidence: 1,
        timestamp: Date.now(),
        lastHandback: { message: null, observedAt: 1, truncated: false },
      };
      events.emit("agent:state-changed", payload);

      const event = buffer.getAll().find((e) => e.type === "agent:state-changed");
      expect(event?.payload).toEqual(payload);
    });
  });

  describe("event record structure", () => {
    it("generates unique IDs for events", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });
      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        timestamp: Date.now(),
      });

      const all = buffer.getAll();
      expect(all[0].id).not.toBe(all[1].id);
    });
  });

  describe("edge cases", () => {
    beforeEach(() => {
      buffer.clear();
    });

    it("handles search with special characters", () => {
      events.emit("agent:spawned", {
        agentId: "agent-[1]",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      const filtered = buffer.getFiltered({ search: "[1]" });
      expect(filtered.length).toBe(1);
    });

    it("handles payload with circular references", () => {
      // structuredClone and safeStringify both handle circular references natively
      const circularPayload: any = { agentId: "agent-circular" };
      circularPayload.self = circularPayload;

      (buffer as any).push({
        id: "circular-test",
        timestamp: Date.now(),
        type: "agent:spawned",
        category: "agent",
        payload: circularPayload,
        source: "main",
      });

      expect(() => buffer.getFiltered({ search: "agent-circular" })).not.toThrow();

      const searchResults = buffer.getFiltered({ search: "agent-circular" });
      expect(searchResults.length).toBe(1);
    });

    it("start() skips non-cloneable events and logs error", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Emit via event bus — the start() listener catches the push() throw
      events.emit("agent:spawned" as any, {
        agentId: "agent-skip",
        fn: () => {},
        timestamp: Date.now(),
      });

      expect(errorSpy).toHaveBeenCalledWith(
        "[EventBuffer] Failed to buffer event agent:spawned:",
        expect.any(Error)
      );
      // Valid events still buffer after the failure
      events.emit("agent:spawned", {
        agentId: "agent-valid",
        terminalId: "term-1",
        timestamp: Date.now(),
      });
      expect(buffer.size()).toBeGreaterThanOrEqual(1);
      const all = buffer.getAll();
      expect(all.some((e) => e.payload.agentId === "agent-skip")).toBe(false);

      errorSpy.mockRestore();
    });

    it("warns when start is called multiple times", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      buffer.start(); // Already started in beforeEach

      expect(warnSpy).toHaveBeenCalledWith("[EventBuffer] Already started");

      warnSpy.mockRestore();
    });
  });

  describe("filtering with traceId", () => {
    beforeEach(() => {
      buffer.clear();
    });

    it("filters by traceId", () => {
      buffer.clear();

      // Emit events with different trace IDs
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
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
  });

  describe("category support", () => {
    beforeEach(() => {
      buffer.clear();
    });

    it("assigns correct category to different event types", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
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
      const agentEvent = all.find((e) => e.type === "agent:spawned");
      const sysEvent = all.find((e) => e.type === "sys:worktree:update");

      expect(agentEvent?.category).toBe("agent");
      expect(sysEvent?.category).toBe("system");
    });

    it("filters by category", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
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

      const agentEvents = buffer.getFiltered({ category: "agent" });
      expect(agentEvents.length).toBe(2);
      expect(agentEvents.every((e) => e.category === "agent")).toBe(true);

      const systemEvents = buffer.getFiltered({ category: "system" });
      expect(systemEvents.length).toBe(1);
      expect(systemEvents[0].category).toBe("system");
    });

    it("getEventsByCategory returns events for specific category", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
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

      const agentEvents = buffer.getEventsByCategory("agent");
      expect(agentEvents.length).toBe(1);
      expect(agentEvents[0].type).toBe("agent:spawned");

      const sysEvents = buffer.getEventsByCategory("system");
      expect(sysEvents.length).toBe(1);
      expect(sysEvents[0].type).toBe("sys:worktree:update");
    });

    it("getCategoryStats returns correct counts", () => {
      events.emit("agent:spawned", {
        agentId: "agent-1",
        terminalId: "term-1",
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

      const stats = buffer.getCategoryStats();
      expect(stats.agent).toBe(2);
      expect(stats.system).toBe(1);
      expect(stats.file).toBe(0);
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
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      events.emit("agent:spawned", {
        agentId: "agent-2",
        terminalId: "term-2",
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledTimes(1);
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
