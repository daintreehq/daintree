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
const getRecords = vi.fn<() => Promise<RunHistoryRecord[]>>();
const clear = vi.fn<() => Promise<void>>();
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

  it("clear does not clobber a concurrent append push from another window", async () => {
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(eventCallback).not.toBeNull());
    eventCallback!([makeRecord("x")]);
    // Another window appends mid-clear: its broadcast arrives before clear resolves.
    const clearPromise = useRunHistoryStore.getState().clear();
    eventCallback!([makeRecord("x"), makeRecord("y")]);
    await clearPromise;
    // No optimistic wipe — the concurrent push survives.
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["x", "y"]);
  });

  it("a stale getRecords snapshot does not overwrite a fresher push", async () => {
    let resolveGet: (records: RunHistoryRecord[]) => void = () => {};
    getRecords.mockReturnValue(
      new Promise<RunHistoryRecord[]>((resolve) => {
        resolveGet = resolve;
      })
    );
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(eventCallback).not.toBeNull());
    // A push lands before the pull resolves.
    eventCallback!([makeRecord("fresh")]);
    // The pull resolves later with stale data — it must not overwrite.
    resolveGet([makeRecord("stale")]);
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loading).toBe(false));
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("flags a getRecords rejection instead of passing for an empty log", async () => {
    getRecords.mockRejectedValue(new Error("boom"));
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => {
      expect(useRunHistoryStore.getState().loading).toBe(false);
    });
    expect(useRunHistoryStore.getState().loadFailed).toBe(true);
    expect(useRunHistoryStore.getState().records).toEqual([]);
  });

  it("retry re-reads after a failure and clears the flag", async () => {
    getRecords.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([makeRecord("a")]);
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(true));

    useRunHistoryStore.getState().retry();
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(false));
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["a"]);
    expect(getRecords).toHaveBeenCalledTimes(2);
  });

  it("a later init after a failed read pulls again; after a good read it does not", async () => {
    getRecords.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(true));

    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(false));
    expect(getRecords).toHaveBeenCalledTimes(2);

    useRunHistoryStore.getState().init();
    expect(getRecords).toHaveBeenCalledTimes(2);
  });

  it("keeps the records on screen when a later read fails", async () => {
    getRecords.mockRejectedValueOnce(new Error("boom"));
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(true));
    useRunHistoryStore.setState({ records: [makeRecord("kept")] });

    getRecords.mockRejectedValueOnce(new Error("still down"));
    useRunHistoryStore.getState().retry();
    await vi.waitFor(() => expect(getRecords).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(true));
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["kept"]);
  });

  it("a push after a failed read clears the failed flag", async () => {
    getRecords.mockRejectedValue(new Error("boom"));
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(true));
    eventCallback!([makeRecord("late")]);
    expect(useRunHistoryStore.getState().loadFailed).toBe(false);
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["late"]);
  });

  it("a retry over shown records does not drop back to the loading skeleton", async () => {
    getRecords.mockRejectedValueOnce(new Error("boom"));
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(true));
    useRunHistoryStore.setState({ records: [makeRecord("kept")] });

    let rejectGet: (err: Error) => void = () => {};
    getRecords.mockReturnValueOnce(
      new Promise<RunHistoryRecord[]>((_, reject) => {
        rejectGet = reject;
      })
    );
    useRunHistoryStore.getState().retry();
    expect(useRunHistoryStore.getState().loading).toBe(false);
    expect(useRunHistoryStore.getState().loadFailed).toBe(false);
    rejectGet(new Error("still down"));
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loadFailed).toBe(true));
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["kept"]);
  });

  it("a push clears the failed flag, and a failure that races a push does not set it", async () => {
    let rejectGet: (err: Error) => void = () => {};
    getRecords.mockReturnValue(
      new Promise<RunHistoryRecord[]>((_, reject) => {
        rejectGet = reject;
      })
    );
    useRunHistoryStore.getState().init();
    await vi.waitFor(() => expect(eventCallback).not.toBeNull());
    eventCallback!([makeRecord("fresh")]);
    rejectGet(new Error("boom"));
    await vi.waitFor(() => expect(useRunHistoryStore.getState().loading).toBe(false));
    await Promise.resolve();
    expect(useRunHistoryStore.getState().loadFailed).toBe(false);
    expect(useRunHistoryStore.getState().records.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("clear reports whether it landed, so the caller can say it failed", async () => {
    expect(await useRunHistoryStore.getState().clear()).toBe(true);
    clear.mockRejectedValueOnce(new Error("disk full"));
    expect(await useRunHistoryStore.getState().clear()).toBe(false);
  });
});
