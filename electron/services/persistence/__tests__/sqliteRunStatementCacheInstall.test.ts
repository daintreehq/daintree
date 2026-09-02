import { describe, expect, it, vi } from "vitest";

const { installSpy } = vi.hoisted(() => ({ installSpy: vi.fn() }));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

vi.mock("../sqliteRunStatementCache.js", () => ({
  installSqliteRunStatementCache: installSpy,
}));

import "../db.js";

describe("SQLite run statement cache install site", () => {
  // db.ts owns every connection Daintree opens. Installing from anywhere else —
  // schema.ts, say, which drizzle-kit also loads — can be silently undone by a
  // later `import type`, with no other test noticing.
  it("installs the cache when the database module loads", () => {
    expect(installSpy).toHaveBeenCalled();
  });
});
