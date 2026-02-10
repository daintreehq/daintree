import { beforeEach, describe, expect, it } from "vitest";
import { filterLogs, useLogsStore } from "../logsStore";
import type { LogEntry } from "@/types";

function makeLog(index: number): LogEntry {
  return {
    id: `log-${index}`,
    timestamp: 1000 + index,
    level: index % 2 === 0 ? "info" : "error",
    message: `message-${index}`,
    source: index % 2 === 0 ? "renderer" : "main",
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
