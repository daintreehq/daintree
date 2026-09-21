import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  _resetCrashRecoveryInspectionForTests,
  isCrashRecoveryInspectionComplete,
  markCrashRecoveryInspectionComplete,
  pruneCrashDumps,
  type CrashDumpRetentionPolicy,
} from "../crashDumpRetention.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

const POLICY: CrashDumpRetentionPolicy = {
  maxAgeMs: 30 * DAY,
  maxCount: 3,
  maxBytes: 1_000,
  activeWriteGraceMs: 10 * MINUTE,
};

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("pruneCrashDumps", () => {
  let dumpsDir: string;

  function writeFile(relPath: string, ageMs: number, size = 16): string {
    const filePath = path.join(dumpsDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.alloc(size));
    const mtime = new Date(NOW - ageMs);
    fs.utimesSync(filePath, mtime, mtime);
    return filePath;
  }

  function exists(relPath: string): boolean {
    return fs.existsSync(path.join(dumpsDir, relPath));
  }

  function prune(
    overrides: { policy?: CrashDumpRetentionPolicy; platform?: NodeJS.Platform } = {}
  ) {
    return pruneCrashDumps(dumpsDir, {
      policy: overrides.policy ?? POLICY,
      nowMs: NOW,
      platform: overrides.platform ?? "darwin",
    });
  }

  beforeEach(() => {
    dumpsDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-dump-retention-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dumpsDir, { recursive: true, force: true });
  });

  it("returns an empty inventory when the database directory does not exist", async () => {
    const result = await pruneCrashDumps(path.join(dumpsDir, "missing"), {
      policy: POLICY,
      nowMs: NOW,
      platform: "darwin",
    });

    expect(result).toEqual({
      count: 0,
      bytes: 0,
      oldestAgeMs: null,
      inProgressCount: 0,
      inProgressBytes: 0,
      deletedCount: 0,
      deletedBytes: 0,
      protectedCount: 0,
      failures: {},
      deletionSupported: true,
    });
  });

  it("tolerates missing lifecycle subdirectories", async () => {
    writeFile("completed/a.dmp", 2 * DAY);

    const result = await prune();

    expect(result.count).toBe(1);
    expect(result.failures).toEqual({});
    expect(exists("completed/a.dmp")).toBe(true);
  });

  it("deletes dumps past the maximum age and keeps recent ones", async () => {
    writeFile("pending/old.dmp", 40 * DAY, 100);
    writeFile("pending/recent.dmp", 2 * DAY, 50);

    const result = await prune();

    expect(exists("pending/old.dmp")).toBe(false);
    expect(exists("pending/recent.dmp")).toBe(true);
    expect(result).toMatchObject({
      count: 2,
      bytes: 150,
      oldestAgeMs: 40 * DAY,
      deletedCount: 1,
      deletedBytes: 100,
    });
  });

  it("ages out the newest dump too once it passes the maximum age", async () => {
    writeFile("pending/a.dmp", 31 * DAY);

    const result = await prune();

    expect(exists("pending/a.dmp")).toBe(false);
    expect(result.deletedCount).toBe(1);
  });

  it("enforces the count budget across pending and completed, oldest first", async () => {
    writeFile("pending/h1.dmp", 1 * HOUR);
    writeFile("completed/h2.dmp", 2 * HOUR);
    writeFile("pending/h3.dmp", 3 * HOUR);
    writeFile("completed/h4.dmp", 4 * HOUR);
    writeFile("pending/h5.dmp", 5 * HOUR);

    const result = await prune();

    expect(exists("pending/h1.dmp")).toBe(true);
    expect(exists("completed/h2.dmp")).toBe(true);
    expect(exists("pending/h3.dmp")).toBe(true);
    expect(exists("completed/h4.dmp")).toBe(false);
    expect(exists("pending/h5.dmp")).toBe(false);
    expect(result.deletedCount).toBe(2);
  });

  it("enforces the byte budget as a newest-first prefix", async () => {
    const policy = { ...POLICY, maxCount: 10 };
    writeFile("pending/h1.dmp", 1 * HOUR, 400);
    writeFile("pending/h2.dmp", 2 * HOUR, 400);
    writeFile("pending/h3.dmp", 3 * HOUR, 400);
    // Small enough to fit on its own, but older than a dump that missed the
    // budget, so it must go too.
    writeFile("pending/h4.dmp", 4 * HOUR, 100);

    const result = await prune({ policy });

    expect(exists("pending/h1.dmp")).toBe(true);
    expect(exists("pending/h2.dmp")).toBe(true);
    expect(exists("pending/h3.dmp")).toBe(false);
    expect(exists("pending/h4.dmp")).toBe(false);
    expect(result.deletedBytes).toBe(500);
  });

  it("keeps the newest dump even when it alone exceeds the byte budget", async () => {
    writeFile("pending/huge.dmp", 1 * HOUR, 5_000);
    writeFile("pending/older.dmp", 2 * HOUR, 10);

    const result = await prune();

    expect(exists("pending/huge.dmp")).toBe(true);
    expect(exists("pending/older.dmp")).toBe(false);
    expect(result.deletedCount).toBe(1);
  });

  it("never deletes dumps in new/, and reports them separately", async () => {
    writeFile("new/writing.dmp", 90 * DAY, 5_000);

    const result = await prune();

    expect(exists("new/writing.dmp")).toBe(true);
    expect(result).toMatchObject({
      count: 0,
      inProgressCount: 1,
      inProgressBytes: 5_000,
      deletedCount: 0,
    });
  });

  it("keeps dumps with a Crashpad .lock sidecar and leaves the lock alone", async () => {
    writeFile("pending/locked.dmp", 90 * DAY);
    writeFile("pending/locked.lock", 90 * DAY, 0);

    const result = await prune();

    expect(exists("pending/locked.dmp")).toBe(true);
    expect(exists("pending/locked.lock")).toBe(true);
    expect(result.protectedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
  });

  it("keeps dumps modified within the active-write grace window, including future mtimes", async () => {
    const policy = { ...POLICY, maxCount: 0, maxBytes: 0 };
    writeFile("pending/just-written.dmp", 5 * MINUTE);
    writeFile("pending/skewed.dmp", -HOUR);

    const result = await prune({ policy });

    expect(exists("pending/just-written.dmp")).toBe(true);
    expect(exists("pending/skewed.dmp")).toBe(true);
    expect(result.protectedCount).toBe(2);
  });

  it("counts protected dumps against the budget", async () => {
    writeFile("pending/w1.dmp", 1 * MINUTE);
    writeFile("pending/w2.dmp", 2 * MINUTE);
    writeFile("pending/w3.dmp", 3 * MINUTE);
    writeFile("completed/older.dmp", 2 * DAY);

    const result = await prune();

    expect(exists("completed/older.dmp")).toBe(false);
    expect(result).toMatchObject({ protectedCount: 3, deletedCount: 1 });
  });

  it("removes a Linux .meta sidecar with its dump and preserves unrelated Crashpad files", async () => {
    writeFile("pending/old.dmp", 40 * DAY);
    writeFile("pending/old.meta", 40 * DAY);
    writeFile("pending/keep.meta", 40 * DAY);
    writeFile("settings.dat", 40 * DAY);
    writeFile("metadata", 40 * DAY);
    writeFile("attachments/old/extra.txt", 40 * DAY);
    writeFile("pending/notes.txt", 40 * DAY);
    fs.mkdirSync(path.join(dumpsDir, "completed", "dir.dmp"), { recursive: true });
    const outside = writeFile("outside/target.dmp", 40 * DAY);
    fs.symlinkSync(outside, path.join(dumpsDir, "completed", "link.dmp"));

    const result = await prune();

    expect(exists("pending/old.dmp")).toBe(false);
    expect(exists("pending/old.meta")).toBe(false);
    expect(exists("pending/keep.meta")).toBe(true);
    expect(exists("settings.dat")).toBe(true);
    expect(exists("metadata")).toBe(true);
    expect(exists("attachments/old/extra.txt")).toBe(true);
    expect(exists("pending/notes.txt")).toBe(true);
    expect(exists("completed/dir.dmp")).toBe(true);
    expect(fs.lstatSync(path.join(dumpsDir, "completed", "link.dmp")).isSymbolicLink()).toBe(true);
    expect(exists("outside/target.dmp")).toBe(true);
    expect(result.count).toBe(1);
  });

  it("records a failed dump deletion, keeps its metadata, and carries on", async () => {
    const stuck = writeFile("pending/stuck.dmp", 40 * DAY);
    writeFile("pending/stuck.meta", 40 * DAY);
    writeFile("pending/gone.dmp", 41 * DAY);
    const realUnlink = fsp.unlink.bind(fsp);
    vi.spyOn(fsp, "unlink").mockImplementation(async (target) => {
      if (target === stuck) throw errnoError("EBUSY");
      return realUnlink(target);
    });

    const result = await prune();

    expect(exists("pending/stuck.dmp")).toBe(true);
    expect(exists("pending/stuck.meta")).toBe(true);
    expect(exists("pending/gone.dmp")).toBe(false);
    expect(result.failures).toEqual({ "unlink:EBUSY": 1 });
    expect(result.deletedCount).toBe(1);
  });

  it("records a failed .meta deletion after its dump is gone", async () => {
    writeFile("pending/old.dmp", 40 * DAY);
    const meta = writeFile("pending/old.meta", 40 * DAY);
    const realUnlink = fsp.unlink.bind(fsp);
    vi.spyOn(fsp, "unlink").mockImplementation(async (target) => {
      if (target === meta) throw errnoError("EACCES");
      return realUnlink(target);
    });

    const result = await prune();

    expect(exists("pending/old.dmp")).toBe(false);
    expect(result.failures).toEqual({ "unlink-meta:EACCES": 1 });
    expect(result.deletedCount).toBe(1);
  });

  it("treats a dump that disappears before deletion as benign", async () => {
    const vanishing = writeFile("pending/old.dmp", 40 * DAY);
    const realUnlink = fsp.unlink.bind(fsp);
    vi.spyOn(fsp, "unlink").mockImplementation(async (target) => {
      if (target === vanishing) {
        await realUnlink(target);
        throw errnoError("ENOENT");
      }
      return realUnlink(target);
    });

    const result = await prune();

    expect(result.failures).toEqual({});
    expect(result.deletedCount).toBe(0);
  });

  it("skips a dump whose lock appears between the scan and the deletion", async () => {
    writeFile("pending/old.dmp", 40 * DAY);
    const lockPath = path.join(dumpsDir, "pending", "old.lock");
    const realLstat = fsp.lstat.bind(fsp);
    let lockChecks = 0;
    vi.spyOn(fsp, "lstat").mockImplementation((async (target: fs.PathLike) => {
      if (target === lockPath && ++lockChecks === 1) {
        try {
          return await realLstat(target);
        } finally {
          fs.writeFileSync(lockPath, "");
        }
      }
      return realLstat(target);
    }) as typeof fsp.lstat);

    const result = await prune();

    expect(exists("pending/old.dmp")).toBe(true);
    expect(result).toMatchObject({ deletedCount: 0, protectedCount: 1 });
  });

  it("records an unreadable directory without aborting the rest of the sweep", async () => {
    writeFile("pending/a.dmp", 2 * DAY);
    writeFile("completed/old.dmp", 40 * DAY);
    const pendingDir = path.join(dumpsDir, "pending");
    const realOpendir = fsp.opendir.bind(fsp);
    vi.spyOn(fsp, "opendir").mockImplementation(async (dir, opts) => {
      if (dir === pendingDir) throw errnoError("EACCES");
      return realOpendir(dir, opts);
    });

    const result = await prune();

    expect(result.failures).toEqual({ "scan:EACCES": 1 });
    expect(exists("pending/a.dmp")).toBe(true);
    expect(exists("completed/old.dmp")).toBe(false);
  });

  it("inventories Windows reports/ without deleting anything", async () => {
    writeFile("reports/old.dmp", 90 * DAY, 300);
    writeFile("reports/recent.dmp", 1 * HOUR, 200);
    writeFile("metadata", 90 * DAY);

    const result = await prune({ platform: "win32" });

    expect(exists("reports/old.dmp")).toBe(true);
    expect(exists("reports/recent.dmp")).toBe(true);
    expect(result).toMatchObject({
      count: 2,
      bytes: 500,
      oldestAgeMs: 90 * DAY,
      deletedCount: 0,
      deletionSupported: false,
    });
  });

  it("is idempotent across repeated sweeps", async () => {
    writeFile("pending/h1.dmp", 1 * HOUR);
    writeFile("pending/h2.dmp", 2 * HOUR);
    writeFile("pending/h3.dmp", 3 * HOUR);
    writeFile("pending/h4.dmp", 4 * HOUR);

    const first = await prune();
    const second = await prune();

    expect(first.deletedCount).toBe(1);
    expect(second).toMatchObject({ count: 3, deletedCount: 0 });
  });
});

describe("crash recovery inspection gate", () => {
  afterEach(() => {
    _resetCrashRecoveryInspectionForTests();
  });

  it("is closed until crash recovery marks its inspection complete", () => {
    _resetCrashRecoveryInspectionForTests();
    expect(isCrashRecoveryInspectionComplete()).toBe(false);

    markCrashRecoveryInspectionComplete();

    expect(isCrashRecoveryInspectionComplete()).toBe(true);
  });
});
