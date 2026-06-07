import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunHistoryRecord } from "@shared/types";

function makeRecord(id: string): RunHistoryRecord {
  return {
    id,
    schemaVersion: 1,
    timestamp: 0,
    kind: "recipe",
    recipeName: id,
    totalTerminals: 1,
    spawned: [],
    failed: [],
  };
}

let eventCallback: ((records: RunHistoryRecord[]) => void) | null = null;
const getRecords = vi.fn<[], Promise<RunHistoryRecord[]>>();
const clear = vi.fn<[], Promise<void>>();
const eventsOn = vi.fn((_name: string, cb: (records: RunHistoryRecord[]) => void) => {
  eventCallback = cb;
  return () => {
    eventCallback = null;
  };
});

(globalThis as { window?: unknown }).window = {
  electron: {
    runHistory: { getRecords, clear },
    events: { on: eventsOn },
  },
};

// Imported after the window stub so the module's top-level references resolve.
const { useRunHistoryStore, _resetRunHistoryStoreForTest } = await import("../runHistoryStore.js");

describe("runHistoryStore", () => {
  beforeEach(() => {
    getRecords.mockReset().mockResolvedValue([]);
    clear.mockReset().mockResolvedValue(undefined);
    eventsOn.mockClear();
    eventCallback = null;
    _resetRunHistoryStoreForTest();
  });
  afterEach(() => {
    _resetRunHistoryStoreForTest();
  });

  it("pulls a snapshot on init and clears the loading flag", async () => {
    getRecords.mockResolvedValue([makeRecord("a")]);
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => {
      expect(useRunHistoryStore.getState().loading).toBe(false);
    });
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["a"]);
  });

  it("is idempotent — repeated init subscribes only once", () => {
    useRunHistoryStore.getState().init();
    useRunHistoryStore.getState().init();
    expect(eventsOn).toHaveBeenCalledTimes(1);
  });

  it("updates records when the event bus pushes a fresh snapshot", async () => {
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(eventCallback).not.toBeNull());
    eventCallback!([makeRecord("x"), makeRecord("y")]);
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["x", "y"]);
    expect(useRunHistoryStore.getState().loading).toBe(false);
  });

  it("clear calls the IPC and optimistically empties the local mirror", async () => {
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(eventCallback).not.toBeNull());
    eventCallback!([makeRecord("x")]);
    await useRunHistoryStore.getState().clear();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(useRunHistoryStore.getState().records).toEqual([]);
  });

  it("survives a getRecords rejection without staying in loading", async () => {
    getRecords.mockRejectedValue(new Error("boom"));
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => {
      expect(useRunHistoryStore.getState().loading).toBe(false);
    });
  });
});
