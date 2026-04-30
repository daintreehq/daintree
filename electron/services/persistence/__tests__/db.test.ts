import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/fake/userData" },
}));

const mockGetCurrentDiskSpaceStatus = vi.fn();

vi.mock("../../DiskSpaceMonitor.js", () => ({
  getCurrentDiskSpaceStatus: () => mockGetCurrentDiskSpaceStatus(),
}));

const mockPragma = vi.fn();
const mockClose = vi.fn();
const mockExec = vi.fn();
const mockPrepare = vi.fn(() => ({ run: vi.fn() }));
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
      exec = mockExec;
      prepare = mockPrepare;
    },
  };
});

vi.mock("drizzle-orm/better-sqlite3", () => ({
  drizzle: vi.fn(() => ({})),
}));

import { probeDb, attemptRecovery, closeSharedDb, withDiskRecovery } from "../db.js";

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

describe("withDiskRecovery", () => {
  type SqliteHandle = Parameters<typeof withDiskRecovery>[0];
  let pragma: ReturnType<typeof vi.fn>;
  let sqlite: SqliteHandle;

  function makeError(code: string, message = code): Error & { code: string } {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    pragma = vi.fn();
    sqlite = { pragma } as unknown as SqliteHandle;
    mockGetCurrentDiskSpaceStatus.mockReturnValue({
      status: "normal",
      availableMb: 4096,
      writesSuppressed: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the result without retrying when fn succeeds", () => {
    const fn = vi.fn(() => "ok");

    expect(withDiskRecovery(sqlite, fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pragma).not.toHaveBeenCalled();
    expect(mockGetCurrentDiskSpaceStatus).not.toHaveBeenCalled();
  });

  it("checkpoints WAL and retries once on SQLITE_FULL when disk is not critical", () => {
    const fn = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw makeError("SQLITE_FULL", "database or disk is full");
      })
      .mockImplementationOnce(() => "recovered");

    expect(withDiskRecovery(sqlite, fn)).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
  });

  it("retries on SQLITE_IOERR_WRITE (extended IOERR variant)", () => {
    const fn = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw makeError("SQLITE_IOERR_WRITE", "io write failed");
      })
      .mockImplementationOnce(() => "recovered");

    expect(withDiskRecovery(sqlite, fn)).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
  });

  it("retries when disk status is warning (not just normal)", () => {
    mockGetCurrentDiskSpaceStatus.mockReturnValue({
      status: "warning",
      availableMb: 1024,
      writesSuppressed: false,
    });
    const fn = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw makeError("SQLITE_FULL", "disk full");
      })
      .mockImplementationOnce(() => "recovered");

    expect(withDiskRecovery(sqlite, fn)).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
  });

  it.each([
    "SQLITE_IOERR_READ",
    "SQLITE_IOERR_LOCK",
    "SQLITE_IOERR_ACCESS",
    "SQLITE_IOERR_SHMOPEN",
  ])("does not retry on non-write IOERR variant %s", (code) => {
    const err = makeError(code);
    const fn = vi.fn(() => {
      throw err;
    });

    expect(() => withDiskRecovery(sqlite, fn)).toThrow(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pragma).not.toHaveBeenCalled();
    expect(mockGetCurrentDiskSpaceStatus).not.toHaveBeenCalled();
  });

  it("does not crash and rethrows when error.code is not a string", () => {
    const weirdError = { code: 5 };
    const fn = vi.fn(() => {
      throw weirdError;
    });

    expect(() => withDiskRecovery(sqlite, fn)).toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pragma).not.toHaveBeenCalled();
  });

  it("re-throws original error and does not retry when disk is critical", () => {
    mockGetCurrentDiskSpaceStatus.mockReturnValue({
      status: "critical",
      availableMb: 100,
      writesSuppressed: true,
    });
    const fullErr = makeError("SQLITE_FULL", "no space left");
    const fn = vi.fn(() => {
      throw fullErr;
    });

    expect(() => withDiskRecovery(sqlite, fn)).toThrow(fullErr);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pragma).not.toHaveBeenCalled();
  });

  it("does not retry on non-recoverable error (e.g. SQLITE_CORRUPT)", () => {
    const corruptErr = makeError("SQLITE_CORRUPT", "image malformed");
    const fn = vi.fn(() => {
      throw corruptErr;
    });

    expect(() => withDiskRecovery(sqlite, fn)).toThrow(corruptErr);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pragma).not.toHaveBeenCalled();
    expect(mockGetCurrentDiskSpaceStatus).not.toHaveBeenCalled();
  });

  it("propagates the retry error if the second attempt also throws", () => {
    const firstErr = makeError("SQLITE_FULL", "first");
    const retryErr = makeError("SQLITE_FULL", "second");
    const fn = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw firstErr;
      })
      .mockImplementationOnce(() => {
        throw retryErr;
      });

    expect(() => withDiskRecovery(sqlite, fn)).toThrow(retryErr);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(pragma).toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
  });

  it("still attempts the retry when the recovery checkpoint itself throws", () => {
    pragma.mockImplementationOnce(() => {
      throw makeError("SQLITE_FULL", "checkpoint failed");
    });
    const fn = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw makeError("SQLITE_FULL", "first");
      })
      .mockImplementationOnce(() => "recovered");

    expect(withDiskRecovery(sqlite, fn)).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
