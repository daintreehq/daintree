import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/fake/userData" },
}));

const mockPragma = vi.fn();
const mockClose = vi.fn();
const mockDatabaseConstructor = vi.fn();

vi.mock("better-sqlite3", () => {
  return {
    default: class MockDatabase {
      constructor(...args: unknown[]) {
        mockDatabaseConstructor(...args);
        const result = mockDatabaseConstructor.getMockImplementation()?.(...args);
        if (result?.error) throw result.error;
      }
      pragma = mockPragma;
      close = mockClose;
    },
  };
});

import { probeDb, attemptRecovery, closeSharedDb } from "../db.js";

describe("probeDb", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-db-test-"));
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns true when database file does not exist", () => {
    expect(probeDb(path.join(tmpDir, "nonexistent.db"))).toBe(true);
    expect(mockDatabaseConstructor).not.toHaveBeenCalled();
  });

  it("returns true for a healthy database (pragma succeeds)", () => {
    const dbPath = path.join(tmpDir, "valid.db");
    fs.writeFileSync(dbPath, "dummy");

    mockDatabaseConstructor.mockImplementation(() => ({}));
    mockPragma.mockReturnValue(1);

    expect(probeDb(dbPath)).toBe(true);
    expect(mockPragma).toHaveBeenCalledWith("schema_version");
    expect(mockClose).toHaveBeenCalled();
  });

  it("returns false when pragma throws SQLITE_CORRUPT", () => {
    const dbPath = path.join(tmpDir, "corrupt.db");
    fs.writeFileSync(dbPath, "dummy");

    mockDatabaseConstructor.mockImplementation(() => ({}));
    mockPragma.mockImplementation(() => {
      const err = new Error("database disk image is malformed") as Error & { code: string };
      err.code = "SQLITE_CORRUPT";
      throw err;
    });

    expect(probeDb(dbPath)).toBe(false);
    expect(mockClose).toHaveBeenCalled();
  });

  it("returns false when pragma throws SQLITE_NOTADB", () => {
    const dbPath = path.join(tmpDir, "notadb.db");
    fs.writeFileSync(dbPath, "dummy");

    mockDatabaseConstructor.mockImplementation(() => ({}));
    mockPragma.mockImplementation(() => {
      const err = new Error("file is not a database") as Error & { code: string };
      err.code = "SQLITE_NOTADB";
      throw err;
    });

    expect(probeDb(dbPath)).toBe(false);
  });

  it("returns true for non-corruption errors (safe default)", () => {
    const dbPath = path.join(tmpDir, "perms.db");
    fs.writeFileSync(dbPath, "dummy");

    mockDatabaseConstructor.mockImplementation(() => ({}));
    mockPragma.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(probeDb(dbPath)).toBe(true);
  });
});

describe("attemptRecovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-db-recovery-"));
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // By default probeDb succeeds for backup verification
    mockDatabaseConstructor.mockImplementation(() => ({}));
    mockPragma.mockReturnValue(1);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("quarantines corrupt DB, WAL, SHM and restores from backup", () => {
    const dbPath = path.join(tmpDir, "daintree.db");
    const backupPath = dbPath + ".backup";

    fs.writeFileSync(dbPath, "corrupt");
    fs.writeFileSync(dbPath + "-wal", "wal");
    fs.writeFileSync(dbPath + "-shm", "shm");
    fs.writeFileSync(backupPath, "valid backup");

    const result = attemptRecovery(dbPath);

    expect(result).toBe(true);
    // Backup was copied to dbPath
    expect(fs.readFileSync(dbPath, "utf8")).toBe("valid backup");
    // Original files quarantined
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);
    expect(fs.existsSync(dbPath + "-shm")).toBe(false);
    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes(".corrupt-")).length).toBe(3);
  });

  it("returns false when no backup exists", () => {
    const dbPath = path.join(tmpDir, "daintree.db");
    fs.writeFileSync(dbPath, "corrupt");

    const result = attemptRecovery(dbPath);

    expect(result).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("returns false when backup is also corrupt", () => {
    const dbPath = path.join(tmpDir, "daintree.db");
    const backupPath = dbPath + ".backup";

    fs.writeFileSync(dbPath, "corrupt");
    fs.writeFileSync(backupPath, "also corrupt");

    // Make probeDb return false for the backup
    mockPragma.mockImplementation(() => {
      const err = new Error("corrupt") as Error & { code: string };
      err.code = "SQLITE_CORRUPT";
      throw err;
    });

    const result = attemptRecovery(dbPath);

    expect(result).toBe(false);
    // Both quarantined
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(false);
  });
});

describe("closeSharedDb", () => {
  it("does nothing when no shared instance exists", () => {
    expect(() => closeSharedDb({ checkpoint: true })).not.toThrow();
  });
});
