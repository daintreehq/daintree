import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventBuffer } from "../EventBuffer.js";
import { events, type DaintreeEventMap } from "../events.js";

type NotifyEventPayload = DaintreeEventMap["ui:notify"] & { timestamp: number };

describe("EventBuffer adversarial", () => {
  let buffer: EventBuffer;

  beforeEach(() => {
    buffer = new EventBuffer(3);
    buffer.start();
  });

  afterEach(() => {
    buffer.stop();
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
    expect(buffer.getAll()[0].payload.data).toBe("[REDACTED - May contain sensitive information]");
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

  it("removes evicted entries from the search index", () => {
    for (let i = 0; i < 3; i++) {
      events.emit("agent:spawned", {
        agentId: `agent-${i}`,
        terminalId: `term-${i}`,
        timestamp: i + 1,
      });
    }

    // All three should be searchable
    expect(buffer.getFiltered({ search: "agent-0" })).toHaveLength(1);
    expect(buffer.getFiltered({ search: "agent-1" })).toHaveLength(1);
    expect(buffer.getFiltered({ search: "agent-2" })).toHaveLength(1);

    // Evict agent-0
    events.emit("agent:spawned", {
      agentId: "agent-3",
      terminalId: "term-3",
      timestamp: 4,
    });

    expect(buffer.getFiltered({ search: "agent-0" })).toHaveLength(0);
    expect(buffer.getFiltered({ search: "agent-1" })).toHaveLength(1);
    expect(buffer.getFiltered({ search: "agent-3" })).toHaveLength(1);
  });

  it("indexes void-payload events by event type for search", () => {
    // sys:refresh has no meaningful payload
    events.emit("agent:spawned", {
      agentId: "agent-x",
      terminalId: "term-x",
      timestamp: 1,
    });

    // Search by event type name should find it
    const byType = buffer.getFiltered({ search: "agent:spawned" });
    expect(byType.length).toBeGreaterThanOrEqual(1);
    expect(byType.some((e) => e.payload.agentId === "agent-x")).toBe(true);

    // Search by payload content should also work
    const byPayload = buffer.getFiltered({ search: "agent-x" });
    expect(byPayload.length).toBe(1);
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
