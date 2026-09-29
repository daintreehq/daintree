import { describe, it, expect, vi, beforeEach } from "vitest";

// Explicit factories — loading the real better-sqlite3 binding fails on CI.
const existsSync = vi.fn<(p: string) => boolean>(() => true);
vi.mock("node:fs", () => ({
  default: { existsSync: (p: string) => existsSync(p) },
  existsSync: (p: string) => existsSync(p),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/userData" },
}));

type Row = { name: string; emoji: string; color: string | null };

function fakeConnection(rows: Record<string, Row>) {
  return {
    prepare: vi.fn(() => ({ get: (id: string) => rows[id] })),
    close: vi.fn(),
  };
}

const throwaway = { current: fakeConnection({}) };
const databaseCtor = vi.fn();
vi.mock("better-sqlite3", () => ({
  default: function Database(...args: unknown[]) {
    databaseCtor(...args);
    return throwaway.current;
  },
}));

const shared = { current: null as ReturnType<typeof fakeConnection> | null };
vi.mock("../db.js", () => ({ getSharedSqlite: () => shared.current }));

import { readLastActiveProjectIdentitySync } from "../readLastProjectId.js";

const PROJECT = { name: "Daintree", emoji: "🌲", color: null };

describe("readLastActiveProjectIdentitySync", () => {
  beforeEach(() => {
    existsSync.mockReturnValue(true);
    databaseCtor.mockClear();
    throwaway.current = fakeConnection({ p1: PROJECT });
    shared.current = null;
  });

  it("opens and closes a read-only connection before the shared DB is open", () => {
    expect(readLastActiveProjectIdentitySync("p1")).toEqual({
      name: "Daintree",
      emoji: "🌲",
      color: undefined,
    });
    expect(databaseCtor).toHaveBeenCalledWith("/userData/daintree.db", { readonly: true });
    expect(throwaway.current.close).toHaveBeenCalledTimes(1);
  });

  it("reads through the shared connection once it is open", () => {
    shared.current = fakeConnection({ p1: { ...PROJECT, color: "#10b981" } });

    expect(readLastActiveProjectIdentitySync("p1")).toEqual({
      name: "Daintree",
      emoji: "🌲",
      color: "#10b981",
    });
    expect(databaseCtor).not.toHaveBeenCalled();
    expect(shared.current.close).not.toHaveBeenCalled();
  });

  it("returns null for a missing project or a failing shared read", () => {
    shared.current = fakeConnection({});
    expect(readLastActiveProjectIdentitySync("gone")).toBeNull();

    shared.current.prepare.mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT");
    });
    expect(readLastActiveProjectIdentitySync("p1")).toBeNull();
    expect(databaseCtor).not.toHaveBeenCalled();
  });
});
