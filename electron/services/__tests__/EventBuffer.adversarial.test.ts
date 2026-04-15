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
        type: "claude",
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
      type: "claude",
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
      type: "claude",
      timestamp: 1,
    });
    events.emit("agent:spawned", {
      agentId: "agent-b",
      terminalId: "term-b",
      type: "claude",
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
    events.emit("task:created", {
      taskId: "task-1",
      worktreeId: "wt-1",
      description: "apiKey=super-secret",
      timestamp: 1,
    });

    const [record] = buffer.getFiltered({ taskId: "task-1" });
    record.payload.description = "apiKey=super-secret";

    expect(buffer.getFiltered({ search: "super-secret" })).toEqual([]);
    expect(buffer.getFiltered({ taskId: "task-1" })[0].payload.description).toBe(
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
