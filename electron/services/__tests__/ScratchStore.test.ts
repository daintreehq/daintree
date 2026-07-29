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
    deleted_at INTEGER
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
