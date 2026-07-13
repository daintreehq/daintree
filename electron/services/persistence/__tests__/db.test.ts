import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/fake/userData" },
}));

const mockGetWritesSuppressed = vi.fn();

vi.mock("../../diskPressureState.js", () => ({
  getWritesSuppressed: () => mockGetWritesSuppressed(),
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

import {
  openDb,
  probeDb,
  probeDbFile,
  attemptRecovery,
  closeSharedDb,
  withDiskRecovery,
} from "../db.js";

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

  it("returns true for a healthy database (quick_check returns ok)", () => {
    const dbPath = path.join(tmpDir, "valid.db");
    fs.writeFileSync(dbPath, "dummy");

    mockDatabaseConstructor.mockImplementation(() => ({}));
    mockPragma.mockReturnValue("ok");

    expect(probeDb(dbPath)).toBe(true);
    expect(mockPragma).toHaveBeenCalledWith("quick_check", { simple: true });
    expect(mockClose).toHaveBeenCalled();
  });

  it("returns false when quick_check returns a corruption error string", () => {
    const dbPath = path.join(tmpDir, "corrupt.db");
    fs.writeFileSync(dbPath, "dummy");

    mockDatabaseConstructor.mockImplementation(() => ({}));
    mockPragma.mockReturnValue(
      "*** in database main ***\nPage 48: btreeInitPage() returns error code 11"
    );

    expect(probeDb(dbPath)).toBe(false);
    expect(mockPragma).toHaveBeenCalledWith("quick_check", { simple: true });
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

  it("returns false for extended corruption codes (e.g. SQLITE_CORRUPT_INDEX from constructor)", () => {
    const dbPath = path.join(tmpDir, "corrupt.db");
    fs.writeFileSync(dbPath, "dummy");

    mockDatabaseConstructor.mockImplementation(() => {
      const err = new Error("corrupt index") as Error & { code: string };
      err.code = "SQLITE_CORRUPT_INDEX";
      throw err;
    });

    expect(probeDb(dbPath)).toBe(false);
    expect(mockDatabaseConstructor).toHaveBeenCalled();
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
    mockPragma.mockReturnValue("ok");
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

    expect(result).toEqual({
      kind: "restored-from-backup",
      quarantinedPath: expect.stringContaining("daintree.db.corrupt-"),
    });
    // The reported path is the quarantined DB itself, and it still holds the
    // original bytes — a user handed this path must find the damaged file there.
    expect(fs.readFileSync(result!.quarantinedPath!, "utf8")).toBe("corrupt");
    // Backup was copied to dbPath
    expect(fs.readFileSync(dbPath, "utf8")).toBe("valid backup");
    // Original files quarantined
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);
    expect(fs.existsSync(dbPath + "-shm")).toBe(false);
    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes(".corrupt-")).length).toBe(3);
  });

  it("resets to a fresh database when no backup exists", () => {
    const dbPath = path.join(tmpDir, "daintree.db");
    fs.writeFileSync(dbPath, "corrupt");

    const result = attemptRecovery(dbPath);

    expect(result).toEqual({
      kind: "reset-to-fresh",
      quarantinedPath: expect.stringContaining("daintree.db.corrupt-"),
    });
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("resets to a fresh database when the backup is also corrupt", () => {
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

    expect(result).toEqual({
      kind: "reset-to-fresh",
      quarantinedPath: expect.stringContaining("daintree.db.corrupt-"),
    });
    // Both quarantined
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it("reports no recovery when quarantining the corrupt DB fails", () => {
    const dbPath = path.join(tmpDir, "daintree.db");
    fs.writeFileSync(dbPath, "corrupt");

    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("rename failed"), { code: "EPERM" });
    });

    // The corrupt DB is still in place, so claiming a restore or a reset here
    // would tell the user something that never happened.
    expect(attemptRecovery(dbPath)).toBeNull();
    expect(fs.existsSync(dbPath)).toBe(true);
    renameSpy.mockRestore();
  });

  it("still reports a reset when the DB moved but a later quarantine step failed", () => {
    const dbPath = path.join(tmpDir, "daintree.db");
    fs.writeFileSync(dbPath, "corrupt");
    fs.writeFileSync(dbPath + "-wal", "wal");

    // The main DB is quarantined, then the WAL rename fails. The DB is already
    // gone, so a fresh one WILL be created — staying silent here would lose the
    // user's data with no notification, which is the whole bug being fixed.
    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    const renameSpy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
        calls += 1;
        if (calls === 1) return realRename(from, to);
        throw Object.assign(new Error("rename failed"), { code: "EPERM" });
      });

    const result = attemptRecovery(dbPath);

    expect(result).toMatchObject({ kind: "reset-to-fresh" });
    expect(fs.existsSync(dbPath)).toBe(false);
    // A stale WAL left at its live name can be replayed into the replacement DB.
    // If it won't move aside it has to go.
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);
    renameSpy.mockRestore();
  });

  it("moves a surviving backup aside when it cannot be restored", () => {
    const dbPath = path.join(tmpDir, "daintree.db");
    const backupPath = dbPath + ".backup";
    fs.writeFileSync(dbPath, "corrupt");
    fs.writeFileSync(backupPath, "the user's real data");

    // The backup can't be read — not proven corrupt, just unverifiable.
    mockPragma.mockImplementation(() => {
      throw Object.assign(new Error("io error"), { code: "SQLITE_IOERR_SHORT_READ" });
    });

    const result = attemptRecovery(dbPath);

    // It must NOT be copied over the DB and announced as a successful restore...
    expect(result).toMatchObject({ kind: "reset-to-fresh" });
    // ...and it must not be left sitting at backupPath either: the app now comes
    // up on an empty database, and the first idle backup would copy that empty
    // DB straight over the user's last good data. Preserve it, don't destroy it.
    expect(fs.existsSync(backupPath)).toBe(false);
    const preserved = fs
      .readdirSync(tmpDir)
      .find((f) => f.startsWith("daintree.db.backup.corrupt-"));
    expect(preserved).toBeDefined();
    expect(fs.readFileSync(path.join(tmpDir, preserved!), "utf8")).toBe("the user's real data");
  });
});

describe("probeDbFile", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-db-probe-"));
    dbPath = path.join(tmpDir, "candidate.db");
    fs.writeFileSync(dbPath, "dummy");
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockDatabaseConstructor.mockImplementation(() => ({}));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("opens the candidate read-only and refuses to create a missing one", () => {
    mockPragma.mockReturnValue("ok");

    expect(probeDbFile(dbPath)).toBe("ok");
    expect(mockDatabaseConstructor).toHaveBeenCalledWith(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(mockClose).toHaveBeenCalled();
  });

  it("reports a failed quick_check as corrupt", () => {
    mockPragma.mockReturnValue("*** in database main ***\nPage 48: btreeInitPage() error");

    expect(probeDbFile(dbPath)).toBe("corrupt");
    expect(mockClose).toHaveBeenCalled();
  });

  it("reports SQLITE_CORRUPT and SQLITE_NOTADB as corrupt", () => {
    for (const code of ["SQLITE_CORRUPT_VTAB", "SQLITE_NOTADB"]) {
      mockPragma.mockImplementation(() => {
        throw Object.assign(new Error("bad"), { code });
      });
      expect(probeDbFile(dbPath)).toBe("corrupt");
    }
  });

  // The whole point of this function. probeDb is fail-open — it returns TRUE for
  // both of these, which is right at boot (don't quarantine a DB over a transient
  // EACCES) and catastrophic when promoting a backup (an unverifiable candidate
  // would overwrite the only good copy). Neither may ever come back "ok".
  it("reports an unreadable candidate as unknown, never as ok", () => {
    mockPragma.mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "SQLITE_IOERR_SHORT_READ" });
    });

    expect(probeDbFile(dbPath)).toBe("unknown");
    expect(probeDb(dbPath)).toBe(true); // ...whereas the fail-open probe says fine
    expect(mockClose).toHaveBeenCalled();
  });

  it("reports a missing candidate as unknown, never as ok", () => {
    const absent = path.join(tmpDir, "absent.db");

    expect(probeDbFile(absent)).toBe("unknown");
    expect(probeDb(absent)).toBe(true); // ...whereas the fail-open probe says fine
    expect(mockDatabaseConstructor).not.toHaveBeenCalled();
  });
});

describe("closeSharedDb", () => {
  it("does nothing when no shared instance exists", () => {
    expect(() => closeSharedDb({ checkpoint: true })).not.toThrow();
  });
});

describe("openDb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws before constructing a Database when disk space is critical", () => {
    mockGetWritesSuppressed.mockReturnValue(true);

    expect(() => openDb("/fake/userData/daintree.db", "/fake/migrations")).toThrow(
      /disk space is critical/
    );
    expect(mockDatabaseConstructor).not.toHaveBeenCalled();
  });

  it("does not block on the disk guard when status is warning (only critical bails)", () => {
    // status === "warning" should still allow opens — the guard fires only on
    // "critical" so writes can keep draining at the warning tier. We force the
    // constructor to throw a sentinel error so we don't depend on the rest of
    // openDb's wiring; reaching the constructor at all proves the guard passed.
    mockGetWritesSuppressed.mockReturnValue(false);
    const sentinel = new Error("sentinel — should not be reached on critical");
    mockDatabaseConstructor.mockImplementation(() => ({ error: sentinel }));

    expect(() => openDb("/fake/userData/daintree.db", "/fake/migrations")).toThrow(sentinel);
    expect(mockDatabaseConstructor).toHaveBeenCalled();
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
    mockGetWritesSuppressed.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the result without retrying when fn succeeds", () => {
    const fn = vi.fn(() => "ok");

    expect(withDiskRecovery(sqlite, fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pragma).not.toHaveBeenCalled();
    expect(mockGetWritesSuppressed).not.toHaveBeenCalled();
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
    mockGetWritesSuppressed.mockReturnValue(false);
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
    expect(mockGetWritesSuppressed).not.toHaveBeenCalled();
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
    mockGetWritesSuppressed.mockReturnValue(true);
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
    expect(mockGetWritesSuppressed).not.toHaveBeenCalled();
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
