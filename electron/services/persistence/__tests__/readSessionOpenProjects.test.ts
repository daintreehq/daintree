import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SESSION_OPEN_PROJECTS_KEY,
  SESSION_OPEN_PROJECTS_VERSION,
  parseSessionOpenProjects,
} from "../sessionOpenProjects.js";

// Explicit factories throughout — spreading importOriginal() here would load the
// real better-sqlite3 binding and electron, which passes locally and fails on CI.
const existsSync = vi.fn<(p: string) => boolean>(() => true);
vi.mock("node:fs", () => ({
  default: { existsSync: (p: string) => existsSync(p) },
  existsSync: (p: string) => existsSync(p),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/userData" },
}));

interface Statement {
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => unknown;
}

const prepare = vi.fn<(sql: string) => Statement>();
const close = vi.fn();
const databaseCtor = vi.fn(() => ({ prepare, close }));

vi.mock("better-sqlite3", () => ({
  default: function Database(this: unknown, ...args: unknown[]) {
    return databaseCtor(...(args as []));
  },
}));

import { readSessionOpenProjectsSync } from "../readLastProjectId.js";

const checkpointJson = (projectIds: unknown[]): string =>
  JSON.stringify({ version: SESSION_OPEN_PROJECTS_VERSION, projectIds });

/** Every INSERT/UPDATE the reader issued, as [sql, ...bindings]. */
let writes: unknown[][];

/**
 * Stand in for the whole `app_state` table, plus a populated `projects` table.
 *
 * The projects rows matter: they are what a status-inferred fallback would find
 * if one were ever reintroduced at this boundary, so a reader that quietly
 * started answering from `active`/`background` rows would show up here as a
 * non-empty result instead of passing on an empty stub.
 */
function withStoredValue(value: string | undefined) {
  const table = new Map<string, string>();
  if (value !== undefined) table.set(SESSION_OPEN_PROJECTS_KEY, value);

  prepare.mockImplementation((sql: string) => {
    const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
    return {
      get: (...args: unknown[]) => {
        if (/from\s+projects/i.test(sql)) return { id: "status-inferred-project" };
        const stored = table.get(String(args[0]));
        return stored === undefined ? undefined : { value: stored };
      },
      all: () => {
        if (/from\s+projects/i.test(sql)) {
          // What `status IN ('active','background')` used to return — #11794.
          return [{ id: "status-inferred-a" }, { id: "status-inferred-b" }];
        }
        return [];
      },
      run: (...args: unknown[]) => {
        if (isWrite) {
          writes.push([sql, ...args]);
          table.set(String(args[0]), String(args[1]));
        }
        return { changes: 1 };
      },
    };
  });
  return table;
}

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  existsSync.mockReturnValue(true);
  withStoredValue(undefined);
});

/**
 * The eager, pre-window read of the session-open checkpoint (#11794). It runs
 * before any window can write the same key, on its own throwaway connection,
 * and hands the row over rather than merely reading it.
 */
describe("readSessionOpenProjectsSync", () => {
  describe("reading", () => {
    it("returns the stored set", () => {
      withStoredValue(checkpointJson(["proj-a", "proj-b"]));

      expect(readSessionOpenProjectsSync({ clear: false }).sort()).toEqual(["proj-a", "proj-b"]);
    });

    it("closes its throwaway connection", () => {
      withStoredValue(checkpointJson(["proj-a"]));

      readSessionOpenProjectsSync({ clear: false });

      expect(close).toHaveBeenCalledTimes(1);
    });

    it("closes the connection even when the query throws", () => {
      prepare.mockImplementation(() => {
        throw new Error("no such table: app_state");
      });

      expect(readSessionOpenProjectsSync({ clear: true })).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("reports nothing on first launch, without opening a database", () => {
      existsSync.mockReturnValue(false);

      expect(readSessionOpenProjectsSync({ clear: true })).toEqual([]);
      expect(databaseCtor).not.toHaveBeenCalled();
    });

    it("reports nothing when the key has never been written, even with open projects on disk", () => {
      // The first launch after upgrading. The mock's `projects` table is full of
      // rows a status query would happily return; the reader must not have one.
      withStoredValue(undefined);

      expect(readSessionOpenProjectsSync({ clear: false })).toEqual([]);
    });

    it("reports nothing when the stored value is corrupt", () => {
      withStoredValue("{not json");

      expect(readSessionOpenProjectsSync({ clear: false })).toEqual([]);
    });

    it("reports nothing when the database cannot be opened at all", () => {
      databaseCtor.mockImplementationOnce(() => {
        throw new Error("SQLITE_CORRUPT");
      });

      expect(readSessionOpenProjectsSync({ clear: true })).toEqual([]);
    });

    it("keeps the readable ids out of a partly corrupt list", () => {
      withStoredValue(checkpointJson(["proj-a", 7, null, "proj-b"]));

      expect(readSessionOpenProjectsSync({ clear: false }).sort()).toEqual(["proj-a", "proj-b"]);
    });
  });

  describe("consuming the row", () => {
    it("hands back the previous set and leaves an empty one behind", () => {
      const table = withStoredValue(checkpointJson(["proj-a", "proj-b"]));

      const previous = readSessionOpenProjectsSync({ clear: true });

      // The value belongs to the session that just ended; this one starts with
      // nothing open, so a picker-only session cannot relight `proj-a` twice.
      expect(previous.sort()).toEqual(["proj-a", "proj-b"]);
      expect(parseSessionOpenProjects(table.get(SESSION_OPEN_PROJECTS_KEY))).toEqual([]);
    });

    it("opens the database writable only when it is going to clear", () => {
      withStoredValue(checkpointJson(["proj-a"]));

      readSessionOpenProjectsSync({ clear: true });

      expect(databaseCtor).toHaveBeenCalledWith(expect.stringContaining("daintree.db"), {
        readonly: false,
      });
    });

    it("opens read-only when it is not clearing, so a recovery boot cannot mutate", () => {
      withStoredValue(checkpointJson(["proj-a"]));

      readSessionOpenProjectsSync({ clear: false });

      expect(databaseCtor).toHaveBeenCalledWith(expect.stringContaining("daintree.db"), {
        readonly: true,
      });
      expect(writes).toEqual([]);
    });

    it("leaves the row intact for a recovery launch", () => {
      const table = withStoredValue(checkpointJson(["proj-a"]));

      readSessionOpenProjectsSync({ clear: false });

      // Safe mode opens one window on purpose; consuming here would throw away
      // the set the user actually had.
      expect(parseSessionOpenProjects(table.get(SESSION_OPEN_PROJECTS_KEY))).toEqual(["proj-a"]);
    });

    it("clears even when there was nothing readable to hand back", () => {
      // A corrupt value has to be replaced too, or it is re-parsed every launch.
      const table = withStoredValue("{not json");

      readSessionOpenProjectsSync({ clear: true });

      expect(parseSessionOpenProjects(table.get(SESSION_OPEN_PROJECTS_KEY))).toEqual([]);
      expect(writes).toHaveLength(1);
    });

    it("fails closed and still closes up when the clear itself throws", () => {
      withStoredValue(checkpointJson(["proj-a"]));
      const base = prepare.getMockImplementation()!;
      prepare.mockImplementation((sql: string) => {
        const stmt = base(sql);
        if (/^\s*INSERT/i.test(sql)) {
          return {
            ...stmt,
            run: () => {
              throw new Error("attempt to write a readonly database");
            },
          };
        }
        return stmt;
      });

      // A database this launch cannot write is not one to hand out dots from:
      // fewer marks is the safe direction, and the launch itself is unaffected.
      expect(readSessionOpenProjectsSync({ clear: true })).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
