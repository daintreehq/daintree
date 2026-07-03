import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunHistoryLog } from "../runHistoryLog.js";
import {
  RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH,
  RUN_HISTORY_MAX_TARGETS,
  RUN_HISTORY_REASON_MAX_LENGTH,
  RUN_HISTORY_SCHEMA_VERSION,
  type RunHistoryAppendInput,
  type RunHistoryRecord,
} from "../../../../shared/types/ipc/runHistory.js";

function makeFixture(initial: RunHistoryRecord[] = [], maxRecords?: number) {
  let stored: RunHistoryRecord[] = [...initial];
  const saveRecords = vi.fn((records: RunHistoryRecord[]) => {
    stored = records;
  });
  const log = new RunHistoryLog(saveRecords, () => stored, maxRecords);
  return { log, saveRecords, getStored: () => stored };
}

function recipeInput(overrides: Partial<RunHistoryAppendInput> = {}): RunHistoryAppendInput {
  return {
    kind: "recipe",
    recipeName: "Build & test",
    totalTerminals: 2,
    spawned: [{ index: 0, terminalId: "t1", title: "Claude" }],
    failed: [],
    ...overrides,
  } as RunHistoryAppendInput;
}

describe("RunHistoryLog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("stamps id, schemaVersion, and timestamp on append", () => {
    const { log } = makeFixture();
    const record = log.append(recipeInput());
    expect(record.id).toMatch(/[0-9a-f-]{36}/);
    expect(record.schemaVersion).toBe(RUN_HISTORY_SCHEMA_VERSION);
    expect(typeof record.timestamp).toBe("number");
  });

  it("returns records newest-first", () => {
    const { log } = makeFixture();
    log.append(recipeInput({ recipeName: "first" } as Partial<RunHistoryAppendInput>));
    log.append(recipeInput({ recipeName: "second" } as Partial<RunHistoryAppendInput>));
    const records = log.getRecords();
    expect(records).toHaveLength(2);
    expect((records[0] as { recipeName: string }).recipeName).toBe("second");
    expect((records[1] as { recipeName: string }).recipeName).toBe("first");
  });

  it("trims to the cap, dropping the oldest", () => {
    const { log } = makeFixture([], 3);
    for (let i = 0; i < 5; i++) {
      log.append(recipeInput({ recipeName: `run-${i}` } as Partial<RunHistoryAppendInput>));
    }
    const records = log.getRecords();
    expect(records).toHaveLength(3);
    // Newest-first: run-4, run-3, run-2 survive; run-0/run-1 trimmed.
    expect(records.map((r) => (r as { recipeName: string }).recipeName)).toEqual([
      "run-4",
      "run-3",
      "run-2",
    ]);
  });

  it("debounces persistence and flushNow writes synchronously", () => {
    const { log, saveRecords } = makeFixture();
    log.append(recipeInput());
    expect(saveRecords).not.toHaveBeenCalled();
    log.flushNow();
    expect(saveRecords).toHaveBeenCalledTimes(1);
    expect(saveRecords.mock.calls[0]![0]).toHaveLength(1);
  });

  it("flushes after the debounce window elapses", () => {
    const { log, saveRecords } = makeFixture();
    log.append(recipeInput());
    vi.advanceTimersByTime(2000);
    expect(saveRecords).toHaveBeenCalledTimes(1);
  });

  it("clear empties the ring and persists immediately", () => {
    const { log, saveRecords, getStored } = makeFixture();
    log.append(recipeInput());
    log.clear();
    expect(log.getRecords()).toHaveLength(0);
    expect(saveRecords).toHaveBeenCalled();
    expect(getStored()).toHaveLength(0);
  });

  it("hydrates from persisted records, trimming to the cap", () => {
    const seed: RunHistoryRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `seed-${i}`,
      schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
      timestamp: i,
      kind: "recipe",
      recipeName: `seed-${i}`,
      totalTerminals: 1,
      spawned: [],
      failed: [],
    }));
    const { log } = makeFixture(seed, 2);
    const records = log.getRecords();
    expect(records).toHaveLength(2);
  });

  it("ignores non-array / malformed persisted data", () => {
    const saveRecords = vi.fn();
    const log = new RunHistoryLog(saveRecords, () => "not-an-array" as unknown);
    expect(log.getRecords()).toEqual([]);
  });

  it("backfills missing array fields on hydrate so consumers can't crash", () => {
    // A corrupted / hand-edited record with `kind` but no `spawned`/`failed`.
    const corrupt = [{ id: "c", schemaVersion: 1, timestamp: 0, kind: "recipe" }];
    const saveRecords = vi.fn();
    const log = new RunHistoryLog(saveRecords, () => corrupt as unknown);
    const [record] = log.getRecords();
    expect(record!.kind).toBe("recipe");
    expect((record as { spawned: unknown[] }).spawned).toEqual([]);
    expect((record as { failed: unknown[] }).failed).toEqual([]);
  });

  it("backfills a corrupt fleet record's perTarget array", () => {
    const corrupt = [{ id: "f", schemaVersion: 1, timestamp: 0, kind: "fleet" }];
    const log = new RunHistoryLog(vi.fn(), () => corrupt as unknown);
    const [record] = log.getRecords();
    expect((record as { perTarget: unknown[] }).perTarget).toEqual([]);
  });

  it("caps fleet reason and draft preview lengths", () => {
    const { log } = makeFixture();
    const longReason = "x".repeat(RUN_HISTORY_REASON_MAX_LENGTH + 50);
    const longDraft = "y".repeat(RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH + 50);
    const record = log.append({
      kind: "fleet",
      draftPreview: longDraft,
      targetCount: 1,
      successCount: 0,
      failureCount: 1,
      cancelled: false,
      perTarget: [{ terminalId: "t1", status: "rejected", reason: longReason }],
    });
    if (record.kind !== "fleet") throw new Error("expected fleet record");
    expect(record.draftPreview!.length).toBe(RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH);
    expect(record.perTarget[0]!.reason!.length).toBe(RUN_HISTORY_REASON_MAX_LENGTH);
  });

  it("caps the number of persisted per-target entries", () => {
    const { log } = makeFixture();
    const perTarget = Array.from({ length: RUN_HISTORY_MAX_TARGETS + 20 }, (_, i) => ({
      terminalId: `t${i}`,
      status: "fulfilled" as const,
    }));
    const record = log.append({
      kind: "fleet",
      targetCount: perTarget.length,
      successCount: perTarget.length,
      failureCount: 0,
      cancelled: false,
      perTarget,
    });
    if (record.kind !== "fleet") throw new Error("expected fleet record");
    expect(record.perTarget).toHaveLength(RUN_HISTORY_MAX_TARGETS);
  });

  it("normalizes negative / fractional counts to safe integers", () => {
    const { log } = makeFixture();
    const record = log.append({
      kind: "fleet",
      targetCount: -3,
      successCount: 2.7,
      failureCount: 0,
      cancelled: false,
      perTarget: [],
    });
    if (record.kind !== "fleet") throw new Error("expected fleet record");
    expect(record.targetCount).toBe(0);
    expect(record.successCount).toBe(3);
  });

  it("persists supervised-run fields: runId, status, isRetry, per-target failureKind/finalAgentState", () => {
    const { log } = makeFixture();
    const record = log.append({
      kind: "fleet",
      runId: "run-123",
      status: "completed",
      isRetry: true,
      targetCount: 2,
      successCount: 1,
      failureCount: 1,
      cancelled: false,
      perTarget: [
        { terminalId: "t1", status: "fulfilled", finalAgentState: "waiting" },
        { terminalId: "t2", status: "rejected", reason: "EPIPE", failureKind: "permanent" },
      ],
    });
    if (record.kind !== "fleet") throw new Error("expected fleet record");
    expect(record.runId).toBe("run-123");
    expect(record.status).toBe("completed");
    expect(record.isRetry).toBe(true);
    expect(record.perTarget[0]!.finalAgentState).toBe("waiting");
    expect(record.perTarget[0]!.failureKind).toBeUndefined();
    expect(record.perTarget[1]!.failureKind).toBe("permanent");
  });

  it("drops unknown supervised-run enum values instead of persisting them", () => {
    const { log } = makeFixture();
    const record = log.append({
      kind: "fleet",
      status: "exploded",
      targetCount: 1,
      successCount: 1,
      failureCount: 0,
      cancelled: false,
      perTarget: [{ terminalId: "t1", status: "fulfilled", failureKind: "weird" }],
    } as unknown as RunHistoryAppendInput);
    if (record.kind !== "fleet") throw new Error("expected fleet record");
    expect(record.status).toBeUndefined();
    expect(record.isRetry).toBeUndefined();
    expect(record.perTarget[0]!.failureKind).toBeUndefined();
  });
});
