import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    getAppPath: () => "/fake/appPath",
  },
}));

const mockRunDbWork = vi.hoisted(() => vi.fn());
const mockFence = vi.hoisted(() => vi.fn());

vi.mock("../dbWorkerClient.js", () => ({
  runDbWork: mockRunDbWork,
  fenceDbWorkerWrites: mockFence,
}));

const mockSqlite = vi.hoisted(() => {
  const insert = { run: vi.fn() };
  const trim = { run: vi.fn() };
  const clear = { run: vi.fn() };
  const read = { all: vi.fn(() => [] as { record: string }[]) };
  return {
    insert,
    trim,
    clear,
    read,
    handle: {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("INSERT")) return insert;
        if (sql.startsWith("SELECT")) return read;
        if (sql.includes("NOT IN")) return trim;
        return clear;
      }),
      transaction: vi.fn((fn: () => void) => ({ immediate: () => fn() })),
    },
  };
});

vi.mock("../db.js", () => ({
  getSharedSqlite: () => mockSqlite.handle,
}));

import { auditRingStore } from "../auditRingStore.js";

describe("auditRingStore.writeAll routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunDbWork.mockResolvedValue(undefined);
  });

  it("routes background writes through the worker without touching the main connection", () => {
    auditRingStore.writeAll("mcpAuditLog", [{ a: 1 }], 5);

    expect(mockRunDbWork).toHaveBeenCalledWith(
      { op: "ringWriteAll", ring: "mcpAuditLog", records: ['{"a":1}'], maxRecords: 5 },
      expect.any(Function)
    );
    expect(mockFence).not.toHaveBeenCalled();
    expect(mockSqlite.insert.run).not.toHaveBeenCalled();
  });

  it("sync writes fence queued worker snapshots first, then persist on the main connection", () => {
    auditRingStore.writeAll("mcpAuditLog", [{ a: 1 }, { b: 2 }], 5, { sync: true });

    expect(mockRunDbWork).not.toHaveBeenCalled();
    expect(mockFence).toHaveBeenCalledTimes(1);
    expect(mockSqlite.clear.run).toHaveBeenCalledWith("mcpAuditLog");
    expect(mockSqlite.insert.run).toHaveBeenCalledTimes(2);
    expect(mockSqlite.insert.run).toHaveBeenCalledWith(
      "mcpAuditLog",
      '{"a":1}',
      expect.any(Number)
    );
    expect(mockSqlite.trim.run).toHaveBeenCalledWith("mcpAuditLog", "mcpAuditLog", 5);
    // Fence moves BEFORE the write, so a stale queued snapshot can never land
    // on top of this one.
    expect(mockFence.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSqlite.insert.run.mock.invocationCallOrder[0]!
    );
  });

  it("runs the main-connection write when the worker path falls back", async () => {
    mockRunDbWork.mockImplementation((_op: unknown, fallback: () => unknown) =>
      Promise.resolve(fallback())
    );

    auditRingStore.writeAll("forgeAuditLog", [{ c: 3 }], 4);
    await Promise.resolve();

    expect(mockFence).not.toHaveBeenCalled();
    expect(mockSqlite.insert.run).toHaveBeenCalledWith(
      "forgeAuditLog",
      '{"c":3}',
      expect.any(Number)
    );
  });
});
