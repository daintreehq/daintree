import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SESSION_OPEN_PROJECTS_KEY,
  SESSION_OPEN_PROJECTS_VERSION,
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

/** Wire the single app_state lookup the reader issues. */
function withStoredValue(value: string | undefined) {
  prepare.mockImplementation(() => ({
    get: (key: unknown) =>
      key === SESSION_OPEN_PROJECTS_KEY && value !== undefined ? { value } : undefined,
    all: () => [],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  withStoredValue(undefined);
});

/**
 * The eager, pre-window read of the session-open checkpoint (#11794). It runs
 * before `app.whenReady()` finishes and before any window can write the same
 * key, on its own throwaway read-only connection.
 */
describe("readSessionOpenProjectsSync", () => {
  it("returns the stored set", () => {
    withStoredValue(checkpointJson(["proj-a", "proj-b"]));

    expect(readSessionOpenProjectsSync().sort()).toEqual(["proj-a", "proj-b"]);
  });

  it("opens the database read-only, so the boot read can never mutate it", () => {
    withStoredValue(checkpointJson(["proj-a"]));

    readSessionOpenProjectsSync();

    expect(databaseCtor).toHaveBeenCalledWith(expect.stringContaining("daintree.db"), {
      readonly: true,
    });
  });

  it("closes its throwaway connection", () => {
    withStoredValue(checkpointJson(["proj-a"]));

    readSessionOpenProjectsSync();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the connection even when the query throws", () => {
    prepare.mockImplementation(() => {
      throw new Error("no such table: app_state");
    });

    expect(readSessionOpenProjectsSync()).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports nothing on first launch, without opening a database", () => {
    existsSync.mockReturnValue(false);

    expect(readSessionOpenProjectsSync()).toEqual([]);
    expect(databaseCtor).not.toHaveBeenCalled();
  });

  it("reports nothing when the key has never been written", () => {
    // The first launch after upgrading: no checkpoint yet, and deliberately no
    // fallback to project `status` — inferring it from `active`/`background`
    // rows IS the bug this replaces.
    withStoredValue(undefined);

    expect(readSessionOpenProjectsSync()).toEqual([]);
  });

  it("reports nothing when the stored value is corrupt", () => {
    withStoredValue("{not json");

    expect(readSessionOpenProjectsSync()).toEqual([]);
  });

  it("reports nothing when the database cannot be opened at all", () => {
    databaseCtor.mockImplementationOnce(() => {
      throw new Error("SQLITE_CORRUPT");
    });

    expect(readSessionOpenProjectsSync()).toEqual([]);
  });

  it("keeps the readable ids out of a partly corrupt list", () => {
    withStoredValue(checkpointJson(["proj-a", 7, null, "proj-b"]));

    expect(readSessionOpenProjectsSync().sort()).toEqual(["proj-a", "proj-b"]);
  });
});
