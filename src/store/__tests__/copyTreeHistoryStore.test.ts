import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopyTreeHistoryRecord } from "@shared/types";

function makeRecord(id: string): CopyTreeHistoryRecord {
  return {
    id,
    dedupeKey: `key-${id}`,
    name: id,
    options: {},
    source: "toolbar",
    worktreeId: "wt-1",
    stats: { fileCount: 1 },
    createdAt: 0,
    lastUsedAt: 0,
    runCount: 1,
  };
}

type Push = { projectId: string; records: CopyTreeHistoryRecord[] };

let eventCallback: ((payload: Push) => void) | null = null;
const getRecords = vi.fn<() => Promise<CopyTreeHistoryRecord[]>>();
const eventsOn = vi.fn((_name: string, cb: (payload: Push) => void) => {
  eventCallback = cb;
  return () => {
    eventCallback = null;
  };
});
const logError = vi.fn();

vi.mock("@/utils/logger", () => ({ logError: (...args: unknown[]) => logError(...args) }));

(globalThis as { window?: unknown }).window = {
  electron: {
    copyTreeHistory: { getRecords },
    events: { on: eventsOn },
  },
};

// Imported after the window stub so the module's top-level references resolve.
const { useCopyTreeHistoryStore, _resetCopyTreeHistoryStoreForTest } =
  await import("../copyTreeHistoryStore.js");

describe("copyTreeHistoryStore", () => {
  beforeEach(() => {
    getRecords.mockReset().mockResolvedValue([]);
    eventsOn.mockClear();
    logError.mockClear();
    eventCallback = null;
    _resetCopyTreeHistoryStoreForTest();
  });

  afterEach(() => {
    _resetCopyTreeHistoryStoreForTest();
  });

  it("pulls a snapshot on init and clears the loading flag", async () => {
    getRecords.mockResolvedValue([makeRecord("a")]);
    useCopyTreeHistoryStore.getState().init();

    await vi.waitFor(() => {
      expect(useCopyTreeHistoryStore.getState().loading).toBe(false);
    });
    expect(useCopyTreeHistoryStore.getState().records.map((r) => r.id)).toEqual(["a"]);
  });

  it("is idempotent — repeated init subscribes only once", () => {
    useCopyTreeHistoryStore.getState().init();
    useCopyTreeHistoryStore.getState().init();
    expect(eventsOn).toHaveBeenCalledTimes(1);
    expect(getRecords).toHaveBeenCalledTimes(1);
  });

  it("subscribes before pulling, so a push during init is not missed", () => {
    let subscribedBeforePull = false;
    getRecords.mockImplementation(() => {
      subscribedBeforePull = eventCallback !== null;
      return Promise.resolve([]);
    });

    useCopyTreeHistoryStore.getState().init();
    expect(subscribedBeforePull).toBe(true);
  });

  it("applies a pushed snapshot", async () => {
    useCopyTreeHistoryStore.getState().init();
    await vi.waitFor(() => expect(eventCallback).not.toBeNull());

    eventCallback?.({ projectId: "p1", records: [makeRecord("pushed")] });

    expect(useCopyTreeHistoryStore.getState().records.map((r) => r.id)).toEqual(["pushed"]);
    expect(useCopyTreeHistoryStore.getState().loading).toBe(false);
  });

  it("does not let a slow pull overwrite a fresher push", async () => {
    let resolvePull: (records: CopyTreeHistoryRecord[]) => void = () => {};
    getRecords.mockReturnValue(
      new Promise<CopyTreeHistoryRecord[]>((resolve) => {
        resolvePull = resolve;
      })
    );

    useCopyTreeHistoryStore.getState().init();
    eventCallback?.({ projectId: "p1", records: [makeRecord("fresh")] });

    resolvePull([makeRecord("stale")]);
    await vi.waitFor(() => {
      expect(useCopyTreeHistoryStore.getState().loading).toBe(false);
    });

    expect(useCopyTreeHistoryStore.getState().records.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("clears loading and logs when the pull fails", async () => {
    getRecords.mockRejectedValue(new Error("nope"));
    useCopyTreeHistoryStore.getState().init();

    await vi.waitFor(() => {
      expect(useCopyTreeHistoryStore.getState().loading).toBe(false);
    });
    expect(useCopyTreeHistoryStore.getState().records).toEqual([]);
    expect(logError).toHaveBeenCalled();
  });

  it("unsubscribes on reset so a later push cannot reach a stale store", () => {
    useCopyTreeHistoryStore.getState().init();
    _resetCopyTreeHistoryStoreForTest();
    expect(eventCallback).toBeNull();
    expect(useCopyTreeHistoryStore.getState().loading).toBe(true);
    expect(useCopyTreeHistoryStore.getState().records).toEqual([]);
  });
});
