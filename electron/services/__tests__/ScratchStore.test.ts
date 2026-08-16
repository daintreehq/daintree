import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../persistence/schema.js";

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS scratches (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_opened INTEGER NOT NULL,
    deleted_at INTEGER,
    last_completion_seen_at INTEGER,
    resumable_agent_count INTEGER
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("../persistence/db.js", () => ({
  getSharedDb: () => db,
  openDb: vi.fn(),
}));

vi.mock("../scratchStorePaths.js", async () => {
  const actual =
    await vi.importActual<typeof import("../scratchStorePaths.js")>("../scratchStorePaths.js");
  return {
    ...actual,
    getScratchDir: (id: string) => `/tmp/daintree-scratch-test/${id}`,
    getScratchesRoot: () => "/tmp/daintree-scratch-test",
  };
});

vi.mock("../../utils/logger.js", () => ({
  logError: vi.fn(),
}));

const { removeWorkspaceStateDirMock } = vi.hoisted(() => ({
  removeWorkspaceStateDirMock: vi.fn(async (_workspaceId: string) => {}),
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: { removeWorkspaceStateDir: removeWorkspaceStateDirMock },
}));

import { ScratchStore } from "../ScratchStore.js";

describe("ScratchStore transaction mode", () => {
  let store: ScratchStore;
  let scratchId: string;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    const now = Date.now();
    scratchId = randomUUID();
    db.insert(schema.scratches)
      .values({
        id: scratchId,
        path: "/tmp/daintree-scratch-test/" + scratchId,
        name: "Test Scratch",
        createdAt: now - 86_400_000,
        lastOpened: now - 3600_000,
      })
      .run();

    store = new ScratchStore();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("runs setCurrentScratch transaction in IMMEDIATE mode", () => {
    const spy = vi.spyOn(db, "transaction");
    store.setCurrentScratch(scratchId);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { behavior: "immediate" });
    spy.mockRestore();
  });
});

describe("removeScratch state cleanup (#11484)", () => {
  let store: ScratchStore;
  let scratchId: string;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    const now = Date.now();
    scratchId = randomUUID();
    db.insert(schema.scratches)
      .values({
        id: scratchId,
        path: "/tmp/daintree-scratch-test/" + scratchId,
        name: "Test Scratch",
        createdAt: now - 86_400_000,
        lastOpened: now - 3600_000,
      })
      .run();

    store = new ScratchStore();
    removeWorkspaceStateDirMock.mockClear();
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it("drops the persisted panel state along with the scratch directory", async () => {
    // The grid is persisted under `projects/<scratchId>/`, outside the scratch
    // folder, so removing the folder alone would leave it orphaned forever.
    vi.spyOn(fs, "rm").mockResolvedValue(undefined);

    await store.removeScratch(scratchId);

    expect(removeWorkspaceStateDirMock).toHaveBeenCalledWith(scratchId);
    expect(db.select().from(schema.scratches).all()).toHaveLength(0);
  });

  it("keeps the row and the state when the directory removal fails", async () => {
    // Bailing out before the hard delete is what lets a later sweep retry; the
    // state directory must not be destroyed ahead of the row it belongs to.
    vi.spyOn(fs, "rm").mockRejectedValue(new Error("EBUSY"));

    await store.removeScratch(scratchId);

    expect(removeWorkspaceStateDirMock).not.toHaveBeenCalled();
    expect(db.select().from(schema.scratches).all()).toHaveLength(1);
  });
});

describe("createScratch rollback", () => {
  let store: ScratchStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    store = new ScratchStore();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("removes the scratch directory when db.insert fails", async () => {
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

    vi.spyOn(db, "insert").mockImplementationOnce(() => {
      throw new Error("DB insert failure");
    });

    await expect(store.createScratch()).rejects.toThrow("DB insert failure");
    expect(rmSpy).toHaveBeenCalledWith(mkdirSpy.mock.calls[0]![0], {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });

    mkdirSpy.mockRestore();
    rmSpy.mockRestore();
  });
});

/**
 * Completion acknowledgement watermark (#11518).
 *
 * Scratches carry agent-status rows now, so the dwell that clears a project's
 * "ready for review" state has to be able to clear a scratch's too — landing in
 * the store that owns the row rather than in `projectStore`.
 */
describe("ScratchStore.markCompletionSeen", () => {
  let store: ScratchStore;
  let scratchId: string;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    scratchId = randomUUID();
    db.insert(schema.scratches)
      .values({
        id: scratchId,
        path: "/tmp/daintree-scratch-test/" + scratchId,
        name: "Test Scratch",
        createdAt: 1_000,
        lastOpened: 2_000,
      })
      .run();

    store = new ScratchStore();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("persists the watermark and surfaces it on read", () => {
    store.markCompletionSeen(scratchId, 5_000);

    expect(store.getScratchById(scratchId)?.lastCompletionSeenAt).toBe(5_000);
    expect(store.getLastCompletionSeenMap().get(scratchId)).toBe(5_000);
  });

  // The stamp records attention, not use — advancing `lastOpened` would reorder
  // the section and restart the auto-cleanup countdown as a side effect.
  it("leaves the sort and cleanup clock untouched", () => {
    store.markCompletionSeen(scratchId, 5_000);

    expect(store.getScratchById(scratchId)?.lastOpened).toBe(2_000);
  });

  it("reports an absent watermark rather than defaulting one", () => {
    expect(store.getScratchById(scratchId)?.lastCompletionSeenAt).toBeUndefined();
    expect(store.getLastCompletionSeenMap().has(scratchId)).toBe(false);
  });

  // The acknowledger samples on a timer and races deletion. Throwing is what
  // its existing catch expects — the same contract a deleted project has.
  it("throws when the scratch is gone", () => {
    expect(() => store.markCompletionSeen(randomUUID(), 5_000)).toThrow(/not found/i);
  });

  it("throws for a tombstoned scratch rather than reviving it", () => {
    store.tombstoneScratch(scratchId, 9_000);

    expect(() => store.markCompletionSeen(scratchId, 5_000)).toThrow(/not found/i);
    expect(store.getLastCompletionSeenMap().has(scratchId)).toBe(false);
  });

  it("rejects a malformed id or watermark", () => {
    expect(() => store.markCompletionSeen("not-a-uuid", 5_000)).toThrow(/invalid scratch id/i);
    expect(() => store.markCompletionSeen(scratchId, 0)).toThrow(/invalid completion watermark/i);
    expect(() => store.markCompletionSeen(scratchId, Number.NaN)).toThrow(
      /invalid completion watermark/i
    );
  });

  it("excludes tombstoned rows from the watermark map", () => {
    const other = randomUUID();
    db.insert(schema.scratches)
      .values({
        id: other,
        path: "/tmp/daintree-scratch-test/" + other,
        name: "Other",
        createdAt: 1_000,
        lastOpened: 2_000,
        lastCompletionSeenAt: 7_000,
        deletedAt: 8_000,
      })
      .run();
    store.markCompletionSeen(scratchId, 5_000);

    expect([...store.getLastCompletionSeenMap().keys()]).toEqual([scratchId]);
  });
});

describe("ScratchStore resumable agent count (#11821)", () => {
  let store: ScratchStore;
  let scratchId: string;

  const storedCount = (id = scratchId): number | null => {
    const row = db.select().from(schema.scratches).where(eq(schema.scratches.id, id)).get();
    return row?.resumableAgentCount ?? null;
  };

  const setStoredCount = (value: number | null, id = scratchId) => {
    db.update(schema.scratches)
      .set({ resumableAgentCount: value })
      .where(eq(schema.scratches.id, id))
      .run();
  };

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    scratchId = randomUUID();
    db.insert(schema.scratches)
      .values({
        id: scratchId,
        path: "/tmp/daintree-scratch-test/" + scratchId,
        name: "Test Scratch",
        createdAt: 1_000,
        lastOpened: 2_000,
      })
      .run();

    store = new ScratchStore();
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("what a row reports", () => {
    it("says nothing at all for a row that has never been counted", () => {
      // The column is NULL for every scratch that predates the field. Reporting
      // 0 there would claim it restores nothing, which nobody checked.
      expect(store.getScratchById(scratchId)?.resumableAgentCount).toBeUndefined();
    });

    it("carries a counted zero as an answer, distinct from never having counted", () => {
      setStoredCount(0);
      expect(store.getScratchById(scratchId)?.resumableAgentCount).toBe(0);
    });

    it("carries a positive count through both read paths", () => {
      setStoredCount(4);
      expect(store.getScratchById(scratchId)?.resumableAgentCount).toBe(4);
      expect(store.getAllScratches()[0]?.resumableAgentCount).toBe(4);
    });

    it("treats a corrupt count as never counted rather than as a claim", () => {
      // Both read paths, because the palette's browse list comes from
      // `getAllScratches` while a single row lookup comes from `getScratchById`
      // — a guard applied to one only would leave the other making the claim.
      for (const corrupt of [-1, 1.5]) {
        setStoredCount(corrupt);
        expect(store.getScratchById(scratchId)?.resumableAgentCount).toBeUndefined();
        expect(store.getAllScratches()[0]?.resumableAgentCount).toBeUndefined();
      }
    });

    it("treats a non-numeric cell as never counted", () => {
      // SQLite's INTEGER affinity keeps a non-coercible TEXT as TEXT, so the
      // reader has to reject by type rather than assume the column's declared
      // one. Written through raw SQL: the typed builder would refuse it.
      sqlite
        .prepare("UPDATE scratches SET resumable_agent_count = 'lots' WHERE id = ?")
        .run(scratchId);
      expect(store.getScratchById(scratchId)?.resumableAgentCount).toBeUndefined();
      expect(store.getAllScratches()[0]?.resumableAgentCount).toBeUndefined();
    });
  });

  describe("reconciling a row the write path never reached", () => {
    it("fills in a row that had no count", () => {
      expect(store.reconcileResumableAgentCount(scratchId, null, 3)?.resumableAgentCount).toBe(3);
      expect(storedCount()).toBe(3);
    });

    it("reports no change when the row already agrees", () => {
      setStoredCount(2);
      expect(store.reconcileResumableAgentCount(scratchId, 2, 2)).toBeNull();
    });

    it("repairs a row whose stored count has gone stale", () => {
      setStoredCount(5);
      expect(store.reconcileResumableAgentCount(scratchId, 5, 1)?.resumableAgentCount).toBe(1);
      expect(storedCount()).toBe(1);
    });

    it("leaves a row alone when a newer write landed since it was read", () => {
      // The sweep read NULL, then a real save wrote 7 while it was still
      // loading state off disk. Its answer is older than the row's.
      setStoredCount(7);
      expect(store.reconcileResumableAgentCount(scratchId, null, 2)).toBeNull();
      expect(storedCount()).toBe(7);
    });

    it("leaves a row alone when its known count moved to a different one", () => {
      setStoredCount(3);
      expect(store.reconcileResumableAgentCount(scratchId, 1, 9)).toBeNull();
      expect(storedCount()).toBe(3);
    });

    it("retracts the claim when the scratch's state can no longer be read", () => {
      setStoredCount(3);
      const updated = store.reconcileResumableAgentCount(scratchId, 3, null);
      expect(updated?.resumableAgentCount).toBeUndefined();
      expect(storedCount()).toBeNull();
    });

    it.each([
      ["negative", -1],
      ["fractional", 1.5],
    ])("repairs a %s cell that reads back as unknown", (_label, corrupt) => {
      // `readPersistedCount` reports both as unknown, so the sweep arrives with
      // previousCount null. Matching SQL NULL alone would never match these rows
      // and they would stay corrupt forever — the fractional case is the one the
      // `<> CAST(... AS INTEGER)` arm exists for.
      setStoredCount(corrupt);
      expect(store.reconcileResumableAgentCount(scratchId, null, 2)?.resumableAgentCount).toBe(2);
      expect(storedCount()).toBe(2);
    });

    it("does not touch a tombstoned row", () => {
      db.update(schema.scratches)
        .set({ deletedAt: 9_000 })
        .where(eq(schema.scratches.id, scratchId))
        .run();
      expect(store.reconcileResumableAgentCount(scratchId, null, 4)).toBeNull();
      expect(storedCount()).toBeNull();
    });

    it("rejects a malformed id instead of addressing the row it names", () => {
      // The row genuinely exists under that id — SQLite holds any TEXT primary
      // key — so this fails if the guard stops running. Pointed at a row with
      // some other id the UPDATE would miss anyway and prove nothing.
      const malformed = "not-a-uuid";
      db.insert(schema.scratches)
        .values({
          id: malformed,
          path: "/tmp/daintree-scratch-test/malformed",
          name: "Malformed",
          createdAt: 1_000,
          lastOpened: 2_000,
          resumableAgentCount: 1,
        })
        .run();

      expect(store.reconcileResumableAgentCount(malformed, 1, 6)).toBeNull();
      expect(storedCount(malformed)).toBe(1);
    });
  });

  describe("surviving the other writers", () => {
    it("keeps the count across a rename", () => {
      setStoredCount(3);
      expect(store.updateScratch(scratchId, { name: "Renamed" }).resumableAgentCount).toBe(3);
    });

    it("keeps the count across a switch that restamps lastOpened", () => {
      setStoredCount(3);
      store.setCurrentScratch(scratchId);
      expect(storedCount()).toBe(3);
    });

    it("keeps the count across a completion watermark stamp", () => {
      setStoredCount(3);
      store.markCompletionSeen(scratchId, 5_000);
      expect(storedCount()).toBe(3);
    });
  });
});
