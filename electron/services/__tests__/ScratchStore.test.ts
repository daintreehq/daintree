import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../persistence/schema.js";

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS scratches (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_opened INTEGER NOT NULL,
    deleted_at INTEGER,
    last_completion_seen_at INTEGER
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
