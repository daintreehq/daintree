import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

// Explicit factories — loading the real better-sqlite3 binding fails on CI.
const existsSync = vi.fn<(p: string) => boolean>(() => true);
vi.mock("node:fs", () => ({
  default: { existsSync: (p: string) => existsSync(p) },
  existsSync: (p: string) => existsSync(p),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/userData" },
}));

type Row = { name: string; emoji: string; color: string | null } | { path: string | null };

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

import { readLastActiveProjectIdentitySync, readProjectPathSync } from "../readLastProjectId.js";

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
    expect(databaseCtor).toHaveBeenCalledWith(path.join("/userData", "daintree.db"), {
      readonly: true,
    });
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

describe("readProjectPathSync", () => {
  beforeEach(() => {
    existsSync.mockReturnValue(true);
    databaseCtor.mockClear();
    throwaway.current = fakeConnection({ p1: { path: "/home/u/projects/hello-web" } });
    shared.current = null;
  });

  it("reads a project's folder on a throwaway connection before the shared DB is open", () => {
    expect(readProjectPathSync("p1")).toBe("/home/u/projects/hello-web");
    expect(databaseCtor).toHaveBeenCalledWith(path.join("/userData", "daintree.db"), {
      readonly: true,
    });
    expect(throwaway.current.close).toHaveBeenCalledTimes(1);
  });

  it("reads through the shared connection once it is open", () => {
    shared.current = fakeConnection({ p1: { path: "/home/u/projects/daintree" } });

    expect(readProjectPathSync("p1")).toBe("/home/u/projects/daintree");
    expect(databaseCtor).not.toHaveBeenCalled();
  });

  it("returns null for an id with no project row, an empty path, or a failed read", () => {
    expect(readProjectPathSync("scratch-1")).toBeNull();

    throwaway.current = fakeConnection({ p1: { path: "" } });
    expect(readProjectPathSync("p1")).toBeNull();

    existsSync.mockReturnValue(false);
    expect(readProjectPathSync("p1")).toBeNull();
  });
});
