import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OPEN_WINDOWS_KEY,
  OPEN_WINDOWS_MANIFEST_VERSION,
  type OpenWindowRecord,
} from "../windowManifest.js";

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
}

const prepare = vi.fn<(sql: string) => Statement>();
const close = vi.fn();
const databaseCtor = vi.fn(() => ({ prepare, close }));

vi.mock("better-sqlite3", () => ({
  default: function Database(this: unknown, ...args: unknown[]) {
    return databaseCtor(...(args as []));
  },
}));

import { resolvePrimaryRestoreProjectId } from "../../../lifecycle/windowRestore.js";
import { readOpenWindowsManifestSync } from "../readLastProjectId.js";

const manifestJson = (windows: unknown[]): string =>
  JSON.stringify({ version: OPEN_WINDOWS_MANIFEST_VERSION, windows });

/**
 * Wire the two queries the reader issues: the app_state lookup and the batched
 * project-existence check.
 */
function withDb(opts: {
  manifest?: string | undefined;
  existingProjectIds?: string[];
  onProjectQuery?: (sql: string, ids: unknown[]) => void;
}) {
  prepare.mockImplementation((sql: string) => {
    if (sql.includes("app_state")) {
      return {
        get: (key: unknown) =>
          key === OPEN_WINDOWS_KEY && opts.manifest !== undefined
            ? { value: opts.manifest }
            : undefined,
        all: () => [],
      };
    }
    return {
      get: () => undefined,
      all: (...ids: unknown[]) => {
        opts.onProjectQuery?.(sql, ids);
        return (opts.existingProjectIds ?? [])
          .filter((id) => ids.includes(id))
          .map((id) => ({ id }));
      },
    };
  });
}

const ids = (records: OpenWindowRecord[]) => records.map((r) => r.projectId);

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
});

describe("readOpenWindowsManifestSync", () => {
  it("reports no manifest on first launch, without opening a database", () => {
    existsSync.mockReturnValue(false);
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: false, records: [] });
    expect(databaseCtor).not.toHaveBeenCalled();
  });

  it("opens the database read-only", () => {
    withDb({ manifest: undefined });
    readOpenWindowsManifestSync();
    expect(databaseCtor).toHaveBeenCalledWith(expect.any(String), { readonly: true });
  });

  it("reports no manifest when the row is absent", () => {
    withDb({ manifest: undefined });
    expect(readOpenWindowsManifestSync().hadManifest).toBe(false);
  });

  it("reports no manifest when the stored payload is corrupt", () => {
    withDb({ manifest: "{not json" });
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: false, records: [] });
  });

  it("restores surviving windows and drops the deleted one, preserving order", () => {
    withDb({
      manifest: manifestJson([
        { projectId: "a" },
        { projectId: null },
        { projectId: "gone" },
        { projectId: "b" },
      ]),
      existingProjectIds: ["a", "b"],
    });
    const result = readOpenWindowsManifestSync();
    expect(result.hadManifest).toBe(true);
    expect(ids(result.records)).toEqual(["a", null, "b"]);
  });

  it("keeps both windows when the same project appears twice", () => {
    withDb({
      manifest: manifestJson([{ projectId: "a" }, { projectId: null }, { projectId: "a" }]),
      existingProjectIds: ["a"],
    });
    expect(ids(readOpenWindowsManifestSync().records)).toEqual(["a", null, "a"]);
  });

  it("still reports a manifest existed when every project was deleted", () => {
    // The caller needs this to open a picker rather than falling back to the
    // global last-active project.
    withDb({ manifest: manifestJson([{ projectId: "gone" }]), existingProjectIds: [] });
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: true, records: [] });
  });

  it("reports no manifest when the stored manifest names zero windows", () => {
    // Closing the last window is the quit gesture on Windows and Linux, and its
    // `closed` save persists exactly this before the shutdown freeze latches.
    // Honouring it would put every relaunch on the project picker.
    withDb({ manifest: manifestJson([]) });
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: false, records: [] });
  });

  it("reports no manifest when every entry is malformed", () => {
    withDb({ manifest: manifestJson([{ projectId: 42 }, "junk"]) });
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: false, records: [] });
  });

  it("skips the project query entirely when every record is a picker window", () => {
    const onProjectQuery = vi.fn();
    withDb({ manifest: manifestJson([{ projectId: null }, { projectId: null }]), onProjectQuery });
    const result = readOpenWindowsManifestSync();
    expect(onProjectQuery).not.toHaveBeenCalled();
    expect(ids(result.records)).toEqual([null, null]);
  });

  it("binds project ids as parameters rather than interpolating them", () => {
    let seenSql = "";
    let seenIds: unknown[] = [];
    withDb({
      manifest: manifestJson([{ projectId: "a'; DROP TABLE projects;--" }]),
      existingProjectIds: [],
      onProjectQuery: (sql, boundIds) => {
        seenSql = sql;
        seenIds = boundIds;
      },
    });

    readOpenWindowsManifestSync();

    expect(seenSql).not.toContain("DROP TABLE");
    expect(seenSql).toContain("?");
    expect(seenIds).toEqual(["a'; DROP TABLE projects;--"]);
  });

  it("binds one placeholder per deduplicated project id", () => {
    let seenSql = "";
    let seenIds: unknown[] = [];
    withDb({
      manifest: manifestJson([{ projectId: "a" }, { projectId: "b" }, { projectId: "a" }]),
      existingProjectIds: ["a", "b"],
      onProjectQuery: (sql, boundIds) => {
        seenSql = sql;
        seenIds = boundIds;
      },
    });

    readOpenWindowsManifestSync();

    expect(seenIds).toEqual(["a", "b"]);
    expect(seenSql.match(/\?/g)).toHaveLength(seenIds.length);
  });

  it("closes the connection it opened", () => {
    withDb({ manifest: manifestJson([{ projectId: "a" }]), existingProjectIds: ["a"] });
    readOpenWindowsManifestSync();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the connection even when a query throws", () => {
    prepare.mockImplementation(() => {
      throw new Error("no such table: app_state");
    });
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: false, records: [] });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports no manifest when the database cannot be opened", () => {
    databaseCtor.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: false, records: [] });
  });

  it("reports no manifest when the projects table is missing", () => {
    prepare.mockImplementation((sql: string) => {
      if (sql.includes("app_state")) {
        return { get: () => ({ value: manifestJson([{ projectId: "a" }]) }), all: () => [] };
      }
      throw new Error("no such table: projects");
    });
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: false, records: [] });
  });
});

// The reader's two "nothing to restore" answers look identical in isolation but
// launch differently, so the pairing is asserted end to end rather than left to
// the caller's reading of `hadManifest`.
describe("the launch a stored manifest produces", () => {
  const primaryProjectFor = (manifest: string): string | undefined => {
    withDb({ manifest, existingProjectIds: ["a"] });
    const { hadManifest, records } = readOpenWindowsManifestSync();
    return resolvePrimaryRestoreProjectId(records, hadManifest, "last-active");
  };

  it("opens the last-active project when the manifest named zero windows", () => {
    expect(primaryProjectFor(manifestJson([]))).toBe("last-active");
  });

  it("opens a picker when the manifest named only projects that are now deleted", () => {
    expect(primaryProjectFor(manifestJson([{ projectId: "gone" }]))).toBeUndefined();
  });

  it("opens the manifest's own project when it still exists", () => {
    expect(primaryProjectFor(manifestJson([{ projectId: "a" }]))).toBe("a");
  });
});
