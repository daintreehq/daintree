import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("electron", () => ({
  app: { getPath: () => "/userData" },
}));

const shared = vi.hoisted(() => ({ current: null as InstanceType<typeof Database> | null }));
vi.mock("../db.js", () => ({ getSharedSqlite: () => shared.current }));

import { isLiveScratchSync } from "../readLastProjectId.js";

const LIVE = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const TOMBSTONED = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

describe("isLiveScratchSync", () => {
  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE scratches (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_opened INTEGER NOT NULL,
        deleted_at INTEGER
      );
    `);
    const insert = sqlite.prepare(
      "INSERT INTO scratches (id, path, name, created_at, last_opened, deleted_at) VALUES (?, ?, ?, 1, 1, ?)"
    );
    insert.run(LIVE, `/scratches/${LIVE}`, "Live", null);
    insert.run(TOMBSTONED, `/scratches/${TOMBSTONED}`, "Tombstoned", 2);
    shared.current = sqlite;
  });

  afterEach(() => {
    shared.current?.close();
    shared.current = null;
  });

  it("answers for a scratch with a row that isn't tombstoned", () => {
    expect(isLiveScratchSync(LIVE)).toBe(true);
  });

  it("says no for a tombstoned scratch and one with no row", () => {
    expect(isLiveScratchSync(TOMBSTONED)).toBe(false);
    expect(isLiveScratchSync("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d")).toBe(false);
  });

  it("says no when the database can't answer", () => {
    shared.current!.exec("DROP TABLE scratches");

    expect(isLiveScratchSync(LIVE)).toBe(false);
  });
});
