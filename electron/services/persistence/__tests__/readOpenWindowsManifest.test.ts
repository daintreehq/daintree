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
import { readLastActiveProjectIdSync, readOpenWindowsManifestSync } from "../readLastProjectId.js";

const manifestJson = (windows: unknown[]): string =>
  JSON.stringify({ version: OPEN_WINDOWS_MANIFEST_VERSION, windows });

/**
 * Wire the statements the readers issue: the `app_state` lookups, the schema
 * probe, and the two batched existence checks.
 *
 * The scratch side models an actual table rather than returning a canned list.
 * `schema` decides which columns exist, tombstoned rows really are stored, and
 * only a statement that filters on `deleted_at` leaves them out — so the
 * soft-delete predicate and the pre-migration column states are exercised by
 * behaviour instead of restated as string assertions.
 *
 * Routing is fail-closed: an unrecognised statement throws rather than being
 * quietly answered by the projects branch.
 */
type ScratchSchema = "full" | "no-deleted-at" | "no-table";

function withDb(opts: {
  manifest?: string | undefined;
  pointers?: Record<string, string>;
  existingProjectIds?: string[];
  liveScratchIds?: string[];
  tombstonedScratchIds?: string[];
  scratchSchema?: ScratchSchema;
  onProjectQuery?: (sql: string, ids: unknown[]) => void;
  onScratchQuery?: (sql: string, ids: unknown[]) => void;
  onSchemaProbe?: () => void;
}) {
  const schema: ScratchSchema = opts.scratchSchema ?? "full";
  const storedRows = [
    ...(opts.liveScratchIds ?? []).map((id) => ({ id, deleted: false })),
    ...(opts.tombstonedScratchIds ?? []).map((id) => ({ id, deleted: true })),
  ];

  prepare.mockImplementation((sql: string) => {
    if (sql.includes("app_state")) {
      return {
        get: (key: unknown) => {
          if (key === OPEN_WINDOWS_KEY) {
            return opts.manifest !== undefined ? { value: opts.manifest } : undefined;
          }
          const value = opts.pointers?.[key as string];
          return value === undefined ? undefined : { value };
        },
        all: () => [],
      };
    }

    if (sql.includes("PRAGMA table_info(scratches)")) {
      opts.onSchemaProbe?.();
      const columns =
        schema === "no-table"
          ? []
          : schema === "no-deleted-at"
            ? [{ name: "id" }, { name: "path" }]
            : [{ name: "id" }, { name: "path" }, { name: "deleted_at" }];
      return { get: () => undefined, all: () => columns };
    }

    if (sql.includes("FROM scratches")) {
      return {
        get: () => undefined,
        all: (...ids: unknown[]) => {
          opts.onScratchQuery?.(sql, ids);
          const excludesTombstones = /deleted_at\s+IS\s+NULL/i.test(sql);
          return storedRows
            .filter((row) => ids.includes(row.id) && !(excludesTombstones && row.deleted))
            .map((row) => ({ id: row.id }));
        },
      };
    }

    if (sql.includes("FROM projects")) {
      return {
        get: () => undefined,
        all: (...ids: unknown[]) => {
          opts.onProjectQuery?.(sql, ids);
          return (opts.existingProjectIds ?? [])
            .filter((id) => ids.includes(id))
            .map((id) => ({ id }));
        },
      };
    }

    throw new Error(`Unexpected statement: ${sql}`);
  });
}

/**
 * Real id shapes: the reader routes each stored id to a table by its shape, so
 * a fixture of the wrong shape would exercise a branch the app never takes.
 */
const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const PROJECT_GONE = "c".repeat(64);
const SCRATCH_A = "11111111-1111-4111-8111-111111111111";
const SCRATCH_B = "22222222-2222-4222-9222-222222222222";
const SCRATCH_GONE = "33333333-3333-4333-a333-333333333333";

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
        { projectId: PROJECT_A },
        { projectId: null },
        { projectId: PROJECT_GONE },
        { projectId: PROJECT_B },
      ]),
      existingProjectIds: [PROJECT_A, PROJECT_B],
    });
    const result = readOpenWindowsManifestSync();
    expect(result.hadManifest).toBe(true);
    expect(ids(result.records)).toEqual([PROJECT_A, null, PROJECT_B]);
  });

  it("keeps both windows when the same project appears twice", () => {
    withDb({
      manifest: manifestJson([
        { projectId: PROJECT_A },
        { projectId: null },
        { projectId: PROJECT_A },
      ]),
      existingProjectIds: [PROJECT_A],
    });
    expect(ids(readOpenWindowsManifestSync().records)).toEqual([PROJECT_A, null, PROJECT_A]);
  });

  it("still reports a manifest existed when every project was deleted", () => {
    // The caller needs this to open a picker rather than falling back to the
    // global last-active project.
    withDb({ manifest: manifestJson([{ projectId: PROJECT_GONE }]), existingProjectIds: [] });
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

  it("sends an id of neither shape to no table at all", () => {
    // Ids are routed by shape, so a hand-edited or corrupt manifest cannot put
    // an arbitrary string on either side of the boot. The window is dropped for
    // the same reason a deleted workspace's is: nothing vouched for it.
    const onProjectQuery = vi.fn();
    const onScratchQuery = vi.fn();
    withDb({
      manifest: manifestJson([{ projectId: "a'; DROP TABLE projects;--" }, { projectId: null }]),
      onProjectQuery,
      onScratchQuery,
    });

    const result = readOpenWindowsManifestSync();

    expect(onProjectQuery).not.toHaveBeenCalled();
    expect(onScratchQuery).not.toHaveBeenCalled();
    expect(ids(result.records)).toEqual([null]);
  });

  it("binds one placeholder per deduplicated project id", () => {
    let seenSql = "";
    let seenIds: unknown[] = [];
    withDb({
      manifest: manifestJson([
        { projectId: PROJECT_A },
        { projectId: PROJECT_B },
        { projectId: PROJECT_A },
      ]),
      existingProjectIds: [PROJECT_A, PROJECT_B],
      onProjectQuery: (sql, boundIds) => {
        seenSql = sql;
        seenIds = boundIds;
      },
    });

    readOpenWindowsManifestSync();

    expect(seenIds).toEqual([PROJECT_A, PROJECT_B]);
    expect(seenSql.match(/\?/g)).toHaveLength(seenIds.length);
  });

  // A scratch is a workspace with no `projects` row (#11484). Validating one
  // against `projects` read it as a deleted project and dropped its window,
  // which relaunched structurally unbound (#11958).
  it("restores a window whose only workspace is a live scratch", () => {
    withDb({ manifest: manifestJson([{ projectId: SCRATCH_A }]), liveScratchIds: [SCRATCH_A] });
    const result = readOpenWindowsManifestSync();
    expect(result.hadManifest).toBe(true);
    expect(ids(result.records)).toEqual([SCRATCH_A]);
  });

  it("restores projects, scratches and pickers together, preserving order", () => {
    withDb({
      manifest: manifestJson([
        { projectId: SCRATCH_A },
        { projectId: PROJECT_A },
        { projectId: null },
        { projectId: SCRATCH_B },
      ]),
      existingProjectIds: [PROJECT_A],
      liveScratchIds: [SCRATCH_A, SCRATCH_B],
    });
    expect(ids(readOpenWindowsManifestSync().records)).toEqual([
      SCRATCH_A,
      PROJECT_A,
      null,
      SCRATCH_B,
    ]);
  });

  it("drops a scratch that no longer exists, keeping the surviving windows", () => {
    withDb({
      manifest: manifestJson([{ projectId: SCRATCH_GONE }, { projectId: PROJECT_A }]),
      existingProjectIds: [PROJECT_A],
      liveScratchIds: [SCRATCH_A],
    });
    expect(ids(readOpenWindowsManifestSync().records)).toEqual([PROJECT_A]);
  });

  it("drops a tombstoned scratch — the cleanup sweep already retired it", () => {
    withDb({
      manifest: manifestJson([{ projectId: SCRATCH_A }, { projectId: SCRATCH_B }]),
      liveScratchIds: [SCRATCH_A],
      tombstonedScratchIds: [SCRATCH_B],
    });
    expect(ids(readOpenWindowsManifestSync().records)).toEqual([SCRATCH_A]);
  });

  it("routes each id to the one table that could hold it", () => {
    let projectIds: unknown[] = [];
    let scratchIds: unknown[] = [];
    withDb({
      manifest: manifestJson([
        { projectId: SCRATCH_A },
        { projectId: PROJECT_A },
        { projectId: null },
      ]),
      existingProjectIds: [PROJECT_A],
      liveScratchIds: [SCRATCH_A],
      onProjectQuery: (_sql, bound) => (projectIds = bound),
      onScratchQuery: (_sql, bound) => (scratchIds = bound),
    });

    readOpenWindowsManifestSync();

    expect(projectIds).toEqual([PROJECT_A]);
    expect(scratchIds).toEqual([SCRATCH_A]);
  });

  it("skips the scratch query entirely when no record names a scratch", () => {
    const onScratchQuery = vi.fn();
    withDb({
      manifest: manifestJson([{ projectId: PROJECT_A }, { projectId: null }]),
      existingProjectIds: [PROJECT_A],
      onScratchQuery,
    });
    readOpenWindowsManifestSync();
    expect(onScratchQuery).not.toHaveBeenCalled();
  });

  it("binds scratch ids as parameters rather than interpolating them", () => {
    let seenSql = "";
    let seenIds: unknown[] = [];
    withDb({
      manifest: manifestJson([{ projectId: SCRATCH_A }, { projectId: SCRATCH_A }]),
      liveScratchIds: [SCRATCH_A],
      onScratchQuery: (sql, bound) => {
        seenSql = sql;
        seenIds = bound;
      },
    });

    const result = readOpenWindowsManifestSync();

    // Deduplicated for the lookup only — both windows still come back.
    expect(seenIds).toEqual([SCRATCH_A]);
    expect(seenSql.match(/\?/g)).toHaveLength(seenIds.length);
    expect(ids(result.records)).toEqual([SCRATCH_A, SCRATCH_A]);
  });

  // These readers run before migrations: `scratches` arrives in 0001 and its
  // `deleted_at` column in 0002, so an upgrading install can present either
  // partial shape and neither may cost the user their project windows.
  it("still restores project windows when the scratches table is missing", () => {
    const onSchemaProbe = vi.fn();
    const onScratchQuery = vi.fn();
    withDb({
      manifest: manifestJson([{ projectId: SCRATCH_A }, { projectId: PROJECT_A }]),
      existingProjectIds: [PROJECT_A],
      scratchSchema: "no-table",
      onSchemaProbe,
      onScratchQuery,
    });

    const result = readOpenWindowsManifestSync();

    expect(onSchemaProbe).toHaveBeenCalled();
    // Probed, not queried: asking a table that does not exist is what used to
    // take the whole read — projects included — down with it.
    expect(onScratchQuery).not.toHaveBeenCalled();
    expect(result.hadManifest).toBe(true);
    expect(ids(result.records)).toEqual([PROJECT_A]);
  });

  it("treats every row as live on a schema that predates the tombstone column", () => {
    // That schema cannot hold a tombstone, so filtering on the column would
    // throw and drop a scratch the user still has.
    withDb({
      manifest: manifestJson([{ projectId: SCRATCH_A }]),
      liveScratchIds: [SCRATCH_A],
      scratchSchema: "no-deleted-at",
    });
    expect(ids(readOpenWindowsManifestSync().records)).toEqual([SCRATCH_A]);
  });

  it("lets a failing scratch query surface instead of reading it as no scratches", () => {
    // A corrupt or locked database must not be mistaken for "the user has no
    // scratches" — that answer looks clean, and the successful boot then
    // rewrites the manifest without their windows.
    prepare.mockImplementation((sql: string) => {
      if (sql.includes("app_state")) {
        return {
          get: () => ({ value: manifestJson([{ projectId: SCRATCH_A }]) }),
          all: () => [],
        };
      }
      throw new Error("database disk image is malformed");
    });
    expect(readOpenWindowsManifestSync()).toEqual({ hadManifest: false, records: [] });
  });

  it("closes the connection it opened", () => {
    withDb({ manifest: manifestJson([{ projectId: PROJECT_A }]), existingProjectIds: [PROJECT_A] });
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
        return { get: () => ({ value: manifestJson([{ projectId: PROJECT_A }]) }), all: () => [] };
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
    withDb({ manifest, existingProjectIds: [PROJECT_A] });
    const { hadManifest, records } = readOpenWindowsManifestSync();
    return resolvePrimaryRestoreProjectId(records, hadManifest, "last-active");
  };

  it("opens the last-active project when the manifest named zero windows", () => {
    expect(primaryProjectFor(manifestJson([]))).toBe("last-active");
  });

  it("opens a picker when the manifest named only projects that are now deleted", () => {
    expect(primaryProjectFor(manifestJson([{ projectId: PROJECT_GONE }]))).toBeUndefined();
  });

  it("opens the manifest's own project when it still exists", () => {
    expect(primaryProjectFor(manifestJson([{ projectId: PROJECT_A }]))).toBe(PROJECT_A);
  });

  it("opens the manifest's own scratch rather than collapsing to a picker", () => {
    withDb({ manifest: manifestJson([{ projectId: SCRATCH_A }]), liveScratchIds: [SCRATCH_A] });
    const { hadManifest, records } = readOpenWindowsManifestSync();
    expect(resolvePrimaryRestoreProjectId(records, hadManifest, "last-active")).toBe(SCRATCH_A);
  });
});

// Closing the last window is the quit gesture on Windows and Linux: its
// `closed` save persists a manifest naming zero windows, which the reader
// deliberately treats as no manifest so the launch falls back to the workspace
// the user was last in. `scratch:switch` deletes `currentProjectId`, so for a
// session that ended inside a scratch that fallback has to read the scratch
// pointer or there is nothing left to fall back to (#11958).
describe("readLastActiveProjectIdSync", () => {
  it("prefers the current project when one is set", () => {
    withDb({
      pointers: { currentProjectId: PROJECT_A, currentScratchId: SCRATCH_A },
      liveScratchIds: [SCRATCH_A],
    });
    expect(readLastActiveProjectIdSync()).toBe(PROJECT_A);
  });

  it("falls back to the current scratch when no project is set", () => {
    withDb({ pointers: { currentScratchId: SCRATCH_A }, liveScratchIds: [SCRATCH_A] });
    expect(readLastActiveProjectIdSync()).toBe(SCRATCH_A);
  });

  it("refuses a tombstoned scratch", () => {
    // Its directory is on its way out; launching into it would open a workspace
    // with nothing behind it.
    withDb({ pointers: { currentScratchId: SCRATCH_A }, tombstonedScratchIds: [SCRATCH_A] });
    expect(readLastActiveProjectIdSync()).toBeNull();
  });

  it("refuses a scratch whose row is gone", () => {
    withDb({ pointers: { currentScratchId: SCRATCH_GONE }, liveScratchIds: [SCRATCH_A] });
    expect(readLastActiveProjectIdSync()).toBeNull();
  });

  it("refuses a stored pointer that is not scratch-shaped", () => {
    const onScratchQuery = vi.fn();
    withDb({ pointers: { currentScratchId: "not-a-uuid" }, onScratchQuery });
    expect(readLastActiveProjectIdSync()).toBeNull();
    expect(onScratchQuery).not.toHaveBeenCalled();
  });

  it("reports nothing when neither pointer is set", () => {
    withDb({});
    expect(readLastActiveProjectIdSync()).toBeNull();
  });

  it("reports nothing on first launch, without opening a database", () => {
    existsSync.mockReturnValue(false);
    expect(readLastActiveProjectIdSync()).toBeNull();
    expect(databaseCtor).not.toHaveBeenCalled();
  });
});

// The pairing that makes the fallback matter: a scratch session that ended by
// closing its last window has no manifest to restore, so the scratch pointer is
// the only thing standing between it and the project picker.
describe("the launch a zero-window manifest produces for a scratch session", () => {
  it("reopens the scratch instead of the picker", () => {
    withDb({
      manifest: manifestJson([]),
      pointers: { currentScratchId: SCRATCH_A },
      liveScratchIds: [SCRATCH_A],
    });

    const { hadManifest, records } = readOpenWindowsManifestSync();
    const fallback = readLastActiveProjectIdSync();

    expect(resolvePrimaryRestoreProjectId(records, hadManifest, fallback ?? undefined)).toBe(
      SCRATCH_A
    );
  });
});
