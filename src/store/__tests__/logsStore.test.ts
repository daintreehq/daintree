import { beforeEach, describe, expect, it } from "vitest";
import { collapseConsecutiveDuplicates, filterLogs, useLogsStore } from "../logsStore";
import type { LogEntry, LogLevel } from "@/types";

function makeLog(index: number): LogEntry {
  return {
    id: `log-${index}`,
    timestamp: 1000 + index,
    level: index % 2 === 0 ? "info" : "error",
    message: `message-${index}`,
    source: index % 2 === 0 ? "renderer" : "main",
  };
}

function makeLogExplicit(
  index: number,
  overrides: Partial<LogEntry> & { level: LogLevel; message: string }
): LogEntry {
  return {
    id: `log-${index}`,
    timestamp: 1000 + index,
    source: "test",
    ...overrides,
  };
}

describe("logsStore", () => {
  beforeEach(() => {
    useLogsStore.getState().reset();
  });

  it("clamps logs to max size and prunes expanded ids", () => {
    const store = useLogsStore.getState();
    const seeded = Array.from({ length: 500 }, (_, index) => makeLog(index));

    store.setLogs(seeded);
    store.toggleExpanded("log-0");
    store.toggleExpanded("log-499");
    store.addLog(makeLog(500));

    const state = useLogsStore.getState();
    expect(state.logs.length).toBe(500);
    expect(state.logs[0]?.id).toBe("log-1");
    expect(state.expandedIds.has("log-0")).toBe(false);
    expect(state.expandedIds.has("log-499")).toBe(true);
  });

  it("ignores empty addLogs payloads", () => {
    const store = useLogsStore.getState();
    store.addLogs([]);
    expect(useLogsStore.getState().logs).toEqual([]);
  });

  it("does not crash when searching malformed log payloads", () => {
    const malformed = {
      id: "bad-1",
      timestamp: Date.now(),
      level: "error",
      message: 42,
      source: 123,
      context: undefined,
    } as unknown as LogEntry;

    expect(() => filterLogs([malformed], { search: "42" })).not.toThrow();
    const filtered = filterLogs([malformed], { search: "42" });
    expect(filtered).toHaveLength(1);
  });
});

describe("filterLogs — search tokens", () => {
  const logs: LogEntry[] = [
    makeLogExplicit(0, { level: "info", message: "startup complete", source: "PtyManager" }),
    makeLogExplicit(1, { level: "error", message: "connection refused", source: "PtyManager" }),
    makeLogExplicit(2, {
      level: "error",
      message: "timeout waiting for ack",
      source: "PtyManager",
    }),
    makeLogExplicit(3, { level: "warn", message: "slow response", source: "WorkspaceService" }),
    makeLogExplicit(4, {
      level: "error",
      message: "db error",
      source: "WorkspaceService",
      context: { code: "ECONN", nested: { kind: "fatal" } },
    }),
  ];

  it("filters by level: token only", () => {
    const result = filterLogs(logs, { search: "level:error" });
    expect(result.map((l) => l.id)).toEqual(["log-1", "log-2", "log-4"]);
  });

  it("filters by source: token only", () => {
    const result = filterLogs(logs, { search: "source:PtyManager" });
    expect(result.map((l) => l.id)).toEqual(["log-0", "log-1", "log-2"]);
  });

  it("combines tokens with remainder matched against message", () => {
    const result = filterLogs(logs, { search: "level:error source:PtyManager timeout" });
    expect(result.map((l) => l.id)).toEqual(["log-2"]);
  });

  it("applies remainder to message only, not source", () => {
    const result = filterLogs(logs, { search: "PtyManager" });
    expect(result).toHaveLength(0);
  });

  it("ignores unknown level: tokens", () => {
    const result = filterLogs(logs, { search: "level:verbose" });
    expect(result.map((l) => l.id)).toEqual(logs.map((l) => l.id));
  });

  it("matches nested context via context.<path>: tokens", () => {
    const result = filterLogs(logs, { search: "context.code:ECONN" });
    expect(result.map((l) => l.id)).toEqual(["log-4"]);
  });

  it("matches deeply nested context paths", () => {
    const result = filterLogs(logs, { search: "context.nested.kind:fatal" });
    expect(result.map((l) => l.id)).toEqual(["log-4"]);
  });

  it("does not crash when context path is missing", () => {
    const result = filterLogs(logs, { search: "context.missing.path:x" });
    expect(result).toEqual([]);
  });

  it("unions level: tokens with explicit filters.levels", () => {
    const result = filterLogs(logs, { levels: ["warn"], search: "level:error" });
    expect(result.map((l) => l.id)).toEqual(["log-1", "log-2", "log-3", "log-4"]);
  });

  it("handles quoted values with spaces", () => {
    const withSpaces: LogEntry[] = [
      makeLogExplicit(10, { level: "error", message: "x", source: "Workspace Service" }),
      makeLogExplicit(11, { level: "error", message: "x", source: "PtyManager" }),
    ];
    const result = filterLogs(withSpaces, { search: 'source:"Workspace Service"' });
    expect(result.map((l) => l.id)).toEqual(["log-10"]);
  });

  it("leaves hyphenated context keys in the remainder text", () => {
    const hyphenLogs: LogEntry[] = [
      makeLogExplicit(0, {
        level: "info",
        message: "context.request-id:abc123 payload received",
      }),
      makeLogExplicit(1, { level: "info", message: "other event" }),
    ];
    const result = filterLogs(hyphenLogs, { search: "context.request-id:abc123" });
    expect(result.map((l) => l.id)).toEqual(["log-0"]);
  });
});

describe("collapseConsecutiveDuplicates", () => {
  it("returns empty for empty input", () => {
    expect(collapseConsecutiveDuplicates([])).toEqual([]);
  });

  it("returns singletons with count 1", () => {
    const logs = [
      makeLogExplicit(0, { level: "info", message: "a" }),
      makeLogExplicit(1, { level: "info", message: "b" }),
    ];
    const result = collapseConsecutiveDuplicates(logs);
    expect(result).toEqual([
      { entry: logs[0], count: 1 },
      { entry: logs[1], count: 1 },
    ]);
  });

  it("collapses consecutive duplicates on {level, message, source}", () => {
    const logs = [
      makeLogExplicit(0, { level: "info", message: "same", source: "s1" }),
      makeLogExplicit(1, { level: "info", message: "same", source: "s1" }),
      makeLogExplicit(2, { level: "info", message: "same", source: "s1" }),
    ];
    const result = collapseConsecutiveDuplicates(logs);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(3);
    expect(result[0]?.entry.id).toBe("log-0");
  });

  it("does not collapse when level differs", () => {
    const logs = [
      makeLogExplicit(0, { level: "info", message: "x" }),
      makeLogExplicit(1, { level: "warn", message: "x" }),
    ];
    expect(collapseConsecutiveDuplicates(logs)).toHaveLength(2);
  });

  it("does not collapse when source differs", () => {
    const logs = [
      makeLogExplicit(0, { level: "info", message: "x", source: "a" }),
      makeLogExplicit(1, { level: "info", message: "x", source: "b" }),
    ];
    expect(collapseConsecutiveDuplicates(logs)).toHaveLength(2);
  });

  it("does not collapse non-consecutive duplicates", () => {
    const logs = [
      makeLogExplicit(0, { level: "info", message: "a" }),
      makeLogExplicit(1, { level: "info", message: "b" }),
      makeLogExplicit(2, { level: "info", message: "a" }),
    ];
    const result = collapseConsecutiveDuplicates(logs);
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.count === 1)).toBe(true);
  });

  it("collapses entries with differing context when level+message+source match", () => {
    const logs = [
      makeLogExplicit(0, {
        level: "info",
        message: "same",
        source: "s1",
        context: { requestId: "a" },
      }),
      makeLogExplicit(1, {
        level: "info",
        message: "same",
        source: "s1",
        context: { requestId: "b" },
      }),
    ];
    const result = collapseConsecutiveDuplicates(logs);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(2);
    expect(result[0]?.entry.id).toBe("log-0");
  });

  it("collapses 500 identical logs into one entry with count 500", () => {
    const logs = Array.from({ length: 500 }, (_, i) =>
      makeLogExplicit(i, { level: "info", message: "same", source: "s1" })
    );
    const result = collapseConsecutiveDuplicates(logs);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(500);
  });
});
