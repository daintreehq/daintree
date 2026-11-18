import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema.js";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let open = true;
const reopened = vi.fn();

vi.mock("../db.js", () => ({
  getSharedDb: () => {
    if (!open) reopened();
    return db;
  },
  getSharedSqlite: () => (open ? sqlite : null),
}));

import { appStateClaudeUsageStorage } from "../claudeUsageStore.js";

describe("appStateClaudeUsageStorage (#17610)", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db = drizzle(sqlite, { schema });
    open = true;
    reopened.mockClear();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("reads nothing before the first save, then the latest save, in a row of its own", () => {
    sqlite
      .prepare("INSERT INTO app_state (key, value) VALUES (?, ?)")
      .run("openWindows", "untouched");

    expect(appStateClaudeUsageStorage.read()).toBeNull();

    appStateClaudeUsageStorage.write('{"first":1}');
    appStateClaudeUsageStorage.write('{"second":2}');

    expect(appStateClaudeUsageStorage.read()).toBe('{"second":2}');
    const rows = sqlite.prepare("SELECT key, value FROM app_state ORDER BY key").all() as {
      key: string;
      value: string;
    }[];
    // The row's name is part of the saved format: a rename loses every saved reading.
    expect(rows).toEqual([
      { key: "claudeUsageObservations", value: '{"second":2}' },
      { key: "openWindows", value: "untouched" },
    ]);
  });

  it("drops a save that arrives once the database has closed, rather than reopening it", () => {
    appStateClaudeUsageStorage.write('{"before":1}');
    open = false;

    appStateClaudeUsageStorage.write('{"after":1}');

    expect(reopened).not.toHaveBeenCalled();
    open = true;
    expect(appStateClaudeUsageStorage.read()).toBe('{"before":1}');
  });
});
