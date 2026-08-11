import { describe, expect, it } from "vitest";
import { decodeCopyTreeHistoryFile, encodeCopyTreeHistoryFile } from "../copyTreeHistoryCodec.js";
import {
  COPY_TREE_HISTORY_MAX_RECORDS,
  COPY_TREE_HISTORY_SCHEMA_VERSION,
} from "../../../shared/types/ipc/copyTreeHistory.js";
import type { CopyTreeHistoryRecord } from "../../../shared/types/ipc/copyTreeHistory.js";

function record(overrides: Partial<CopyTreeHistoryRecord> = {}): CopyTreeHistoryRecord {
  return {
    id: "id-1",
    dedupeKey: "key-1",
    name: "Full context",
    options: { format: "xml" },
    source: "toolbar",
    worktreeId: "wt-1",
    stats: { fileCount: 4, totalSize: 40, duration: 12 },
    createdAt: 1_000,
    lastUsedAt: 2_000,
    runCount: 2,
    ...overrides,
  };
}

describe("encode/decode round trip", () => {
  it("returns exactly what was written", () => {
    const records = [record(), record({ id: "id-2", dedupeKey: "key-2", stats: { fileCount: 0 } })];
    const decoded = decodeCopyTreeHistoryFile(encodeCopyTreeHistoryFile(records));
    expect(decoded).toEqual({ ok: true, records });
  });

  it("stamps the current schema version on write", () => {
    const parsed = JSON.parse(encodeCopyTreeHistoryFile([])) as { _schemaVersion: number };
    expect(parsed._schemaVersion).toBe(COPY_TREE_HISTORY_SCHEMA_VERSION);
  });

  it("survives a round trip through an empty history", () => {
    expect(decodeCopyTreeHistoryFile(encodeCopyTreeHistoryFile([]))).toEqual({
      ok: true,
      records: [],
    });
  });
});

describe("decodeCopyTreeHistoryFile", () => {
  it("never throws, whatever it is handed", () => {
    const inputs = [
      "",
      "   ",
      "not json",
      "null",
      "[]",
      "42",
      '"a string"',
      "{}",
      '{"records":[]}',
      '{"_schemaVersion":"one","records":[]}',
      '{"_schemaVersion":-1,"records":[]}',
      '{"_schemaVersion":1.5,"records":[]}',
      '{"_schemaVersion":1,"records":{}}',
      '{"_schemaVersion":1}',
    ];
    for (const raw of inputs) {
      expect(() => decodeCopyTreeHistoryFile(raw)).not.toThrow();
      expect(decodeCopyTreeHistoryFile(raw).ok).toBe(false);
    }
  });

  it("reports unparseable content as damage", () => {
    expect(decodeCopyTreeHistoryFile("{ oh no")).toEqual({ ok: false, reason: "corrupt" });
  });

  it("reports a bare array as damage rather than accepting a legacy shape", () => {
    // There is no legacy format for this file — an array root means something
    // else wrote it, and quarantining beats silently adopting it.
    expect(decodeCopyTreeHistoryFile(JSON.stringify([record()]))).toEqual({
      ok: false,
      reason: "corrupt",
    });
  });

  it("distinguishes a newer app's file from a damaged one, and says how new", () => {
    const raw = JSON.stringify({
      _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION + 3,
      records: [],
    });
    expect(decodeCopyTreeHistoryFile(raw)).toEqual({
      ok: false,
      reason: "future-version",
      onDiskVersion: COPY_TREE_HISTORY_SCHEMA_VERSION + 3,
    });
  });

  it("classifies a newer version before its shape, so a new field is not misread as damage", () => {
    const raw = JSON.stringify({
      _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION + 1,
      records: [{ totallyDifferent: true }],
    });
    const decoded = decodeCopyTreeHistoryFile(raw);
    expect(decoded).toMatchObject({ ok: false, reason: "future-version" });
  });

  it("rejects the whole file when a record is malformed", () => {
    const raw = JSON.stringify({
      _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION,
      records: [record(), { id: "id-2" }],
    });
    expect(decodeCopyTreeHistoryFile(raw)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("rejects a record whose run count is not a positive integer", () => {
    for (const runCount of [0, -1, 1.5]) {
      const raw = JSON.stringify({
        _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION,
        records: [record({ runCount })],
      });
      expect(decodeCopyTreeHistoryFile(raw)).toEqual({ ok: false, reason: "corrupt" });
    }
  });

  it("rejects a record whose source is not a known surface", () => {
    const raw = JSON.stringify({
      _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION,
      records: [record({ source: "telepathy" as never })],
    });
    expect(decodeCopyTreeHistoryFile(raw)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("rejects options the generate handlers would themselves have refused", () => {
    // An empty scopePaths would resolve to the worktree root, widening a folder
    // copy into a full one — the IPC schema blocks it, so rehydration must too.
    const raw = JSON.stringify({
      _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION,
      records: [record({ options: { scopePaths: [] } })],
    });
    expect(decodeCopyTreeHistoryFile(raw)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("accepts a record whose stats carry only a file count", () => {
    const raw = JSON.stringify({
      _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION,
      records: [record({ stats: { fileCount: 7 } })],
    });
    const decoded = decodeCopyTreeHistoryFile(raw);
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.records[0].stats).toEqual({ fileCount: 7 });
  });

  it("rejects a version below the current one, which nothing ever wrote", () => {
    // No v0 exists, so an older number means another writer produced the file —
    // reading it through today's schema would misinterpret a stranger's shape.
    const raw = JSON.stringify({ _schemaVersion: 0, records: [] });
    expect(decodeCopyTreeHistoryFile(raw)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("never writes more records than it will read back", () => {
    const records = Array.from({ length: COPY_TREE_HISTORY_MAX_RECORDS + 5 }, (_, i) =>
      record({ id: `id-${i}`, dedupeKey: `key-${i}` })
    );
    const parsed = JSON.parse(encodeCopyTreeHistoryFile(records)) as { records: unknown[] };
    expect(parsed.records).toHaveLength(COPY_TREE_HISTORY_MAX_RECORDS);
  });

  it("bounds how many records a hand-edited file can push through", () => {
    const records = Array.from({ length: COPY_TREE_HISTORY_MAX_RECORDS + 25 }, (_, i) =>
      record({ id: `id-${i}`, dedupeKey: `key-${i}`, lastUsedAt: 10_000 - i })
    );
    const decoded = decodeCopyTreeHistoryFile(
      JSON.stringify({ _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION, records })
    );
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.records).toHaveLength(COPY_TREE_HISTORY_MAX_RECORDS);
    // Newest-first on disk, so the head is what survives.
    expect(decoded.ok && decoded.records[0].id).toBe("id-0");
  });

  it("drops an unknown top-level key a newer same-version build added", () => {
    const raw = JSON.stringify({
      _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION,
      records: [record()],
      somethingElse: 1,
    });
    expect(decodeCopyTreeHistoryFile(raw).ok).toBe(true);
  });
});
