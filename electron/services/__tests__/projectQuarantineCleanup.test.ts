import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";

const { logInfo } = vi.hoisted(() => ({
  logInfo: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo,
  logError: vi.fn(),
}));
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import {
  cleanupQuarantinedProjectFiles,
  cleanupGlobalQuarantineFiles,
  cleanupUserDataRootQuarantineFiles,
} from "../projectQuarantineCleanup.js";

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
const TWENTY_NINE_DAYS_MS = 29 * 24 * 60 * 60 * 1000;

const VALID_PROJECT_ID = "a".repeat(64);
const VALID_PROJECT_ID_2 = "b".repeat(64);

const QUARANTINE_FILES = [
  "state.json.corrupted.1234567890",
  "settings.json.corrupted.1234567890",
  "recipes.json.corrupted.1234567890",
];

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quarantine-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createProjectDir(projectId: string): Promise<string> {
  const dir = path.join(tmpDir, projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function createCorruptedFile(
  projectDir: string,
  filename: string,
  ageMs: number,
  now: number
): Promise<string> {
  const filePath = path.join(projectDir, filename);
  await fs.writeFile(filePath, "corrupted data");
  const mtime = new Date(now - ageMs);
  await fs.utimes(filePath, mtime, mtime);
  return filePath;
}

describe("cleanupQuarantinedProjectFiles", () => {
  // Round to second boundary to avoid mtime truncation on Linux (ext4 has 1s granularity)
  const NOW = Math.floor(Date.now() / 1000) * 1000;

  it("deletes .corrupted files older than 30 days", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    const filePath = await createCorruptedFile(
      projectDir,
      "state.json.corrupted.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    expect(deleted).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("preserves .corrupted files newer than 30 days", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    const filePath = await createCorruptedFile(
      projectDir,
      "state.json.corrupted.1234567890",
      TWENTY_NINE_DAYS_MS,
      NOW
    );

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    expect(deleted).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("deletes all three known quarantine file types when old", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    for (const filename of QUARANTINE_FILES) {
      await createCorruptedFile(projectDir, filename, THIRTY_ONE_DAYS_MS, NOW);
    }

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(3);

    for (const filename of QUARANTINE_FILES) {
      await expect(fs.access(path.join(projectDir, filename))).rejects.toThrow();
    }
  });

  it("ignores unknown .corrupted files", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    const unknownFile = path.join(projectDir, "unknown.json.corrupted");
    await fs.writeFile(unknownFile, "data");
    const oldTime = new Date(NOW - THIRTY_ONE_DAYS_MS);
    await fs.utimes(unknownFile, oldTime, oldTime);

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    expect(deleted).toBe(0);
    await expect(fs.access(unknownFile)).resolves.toBeUndefined();
  });

  it("sweeps a scratch's state directory too (#11484)", async () => {
    // Scratches persist their panel grid under the same `projects/<id>/`
    // layout, so a corrupted scratch state file must be reaped on the same
    // schedule rather than sitting there forever.
    const scratchDir = await createProjectDir(randomUUID());
    const filePath = await createCorruptedFile(
      scratchDir,
      "state.json.corrupted.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    expect(deleted).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("skips directories with invalid project IDs", async () => {
    const invalidDir = path.join(tmpDir, "not-a-valid-hex-id");
    await fs.mkdir(invalidDir);
    const filePath = path.join(invalidDir, "state.json.corrupted.1234567890");
    await fs.writeFile(filePath, "data");
    const oldTime = new Date(NOW - THIRTY_ONE_DAYS_MS);
    await fs.utimes(filePath, oldTime, oldTime);

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    expect(deleted).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("skips non-directory entries in projects root", async () => {
    const filePath = path.join(tmpDir, VALID_PROJECT_ID);
    await fs.writeFile(filePath, "not a directory");

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
  });

  it("handles missing projectsConfigDir gracefully", async () => {
    const nonexistent = path.join(tmpDir, "does-not-exist");
    const deleted = await cleanupQuarantinedProjectFiles(nonexistent, NOW);
    expect(deleted).toBe(0);
  });

  it("handles empty projects directory", async () => {
    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
  });

  it("handles missing .corrupted files gracefully (no errors)", async () => {
    await createProjectDir(VALID_PROJECT_ID);
    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
  });

  it("processes multiple project directories", async () => {
    const dir1 = await createProjectDir(VALID_PROJECT_ID);
    const dir2 = await createProjectDir(VALID_PROJECT_ID_2);

    const oldFile1 = await createCorruptedFile(
      dir1,
      "state.json.corrupted.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );
    const oldFile2 = await createCorruptedFile(
      dir2,
      "settings.json.corrupted.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );
    const freshFile = await createCorruptedFile(
      dir2,
      "recipes.json.corrupted.1234567890",
      TWENTY_NINE_DAYS_MS,
      NOW
    );

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(2);

    await expect(fs.access(oldFile1)).rejects.toThrow();
    await expect(fs.access(oldFile2)).rejects.toThrow();
    await expect(fs.access(freshFile)).resolves.toBeUndefined();
  });

  it("is idempotent — calling twice is safe", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    await createCorruptedFile(
      projectDir,
      "state.json.corrupted.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );

    const deleted1 = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted1).toBe(1);

    const deleted2 = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted2).toBe(0);
  });

  it("boundary: exactly 30 days old is preserved (uses > not >=)", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    const exactlyThirtyDays = 30 * 24 * 60 * 60 * 1000;
    const filePath = await createCorruptedFile(
      projectDir,
      "state.json.corrupted.1234567890",
      exactlyThirtyDays,
      NOW
    );

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("uses the now parameter for age calculation, not wall clock", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    // File is only 1 day old relative to wall clock
    const filePath = await createCorruptedFile(
      projectDir,
      "state.json.corrupted.1234567890",
      1 * 24 * 60 * 60 * 1000,
      Date.now()
    );

    // But if we pass a `now` far in the future, the file appears old
    const futureNow = Date.now() + 60 * 24 * 60 * 60 * 1000;
    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, futureNow);
    expect(deleted).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("deletes state.json.future-v<N> files older than 30 days", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    const futureV2 = await createCorruptedFile(
      projectDir,
      "state.json.future-v2",
      THIRTY_ONE_DAYS_MS,
      NOW
    );
    const futureV2Stamped = await createCorruptedFile(
      projectDir,
      "state.json.future-v2.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );
    const futureV999999 = await createCorruptedFile(
      projectDir,
      "state.json.future-v999999",
      THIRTY_ONE_DAYS_MS,
      NOW
    );

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(3);
    await expect(fs.access(futureV2)).rejects.toThrow();
    await expect(fs.access(futureV2Stamped)).rejects.toThrow();
    await expect(fs.access(futureV999999)).rejects.toThrow();
  });

  it("preserves fresh state.json.future-v<N> files", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    const filePath = await createCorruptedFile(
      projectDir,
      "state.json.future-v2",
      TWENTY_NINE_DAYS_MS,
      NOW
    );

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("preserves files with future mtime (clock-skew safety)", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    const filePath = path.join(projectDir, "state.json.corrupted.1234567890");
    await fs.writeFile(filePath, "data");
    // mtime in the future relative to NOW
    const futureMtime = new Date(NOW + 7 * 24 * 60 * 60 * 1000);
    await fs.utimes(filePath, futureMtime, futureMtime);

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("isolates per-project sweep failures (one bad dir does not abort others)", async () => {
    const dir1 = await createProjectDir(VALID_PROJECT_ID);
    const dir2 = await createProjectDir(VALID_PROJECT_ID_2);
    const oldFile2 = await createCorruptedFile(
      dir2,
      "state.json.corrupted.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );

    const realReaddir = fs.readdir;
    const spy = vi.spyOn(fs, "readdir").mockImplementation(((p: string, opts?: unknown) => {
      if (p === dir1) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        return Promise.reject(err);
      }
      return (realReaddir as (p: string, opts?: unknown) => Promise<unknown>)(p, opts);
    }) as typeof fs.readdir);

    try {
      const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
      expect(deleted).toBe(1);
      await expect(fs.access(oldFile2)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("logs quarantine-file-reaped with filename, ageMs, and projectId", async () => {
    logInfo.mockClear();

    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    await createCorruptedFile(
      projectDir,
      "state.json.corrupted.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );

    await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    expect(logInfo).toHaveBeenCalledWith(
      "quarantine-file-reaped",
      expect.objectContaining({
        filename: "state.json.corrupted.1234567890",
        ageMs: expect.any(Number),
        projectId: VALID_PROJECT_ID,
      })
    );
  });

  it("does not log reap for fresh files preserved by the age gate", async () => {
    logInfo.mockClear();

    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    await createCorruptedFile(
      projectDir,
      "state.json.corrupted.1234567890",
      TWENTY_NINE_DAYS_MS,
      NOW
    );

    await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    const reapCalls = logInfo.mock.calls.filter(
      (call: unknown[]) => call[0] === "quarantine-file-reaped"
    );
    expect(reapCalls).toHaveLength(0);
  });

  it("reap log context does not contain absolute file path", async () => {
    logInfo.mockClear();

    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    await createCorruptedFile(
      projectDir,
      "state.json.corrupted.1234567890",
      THIRTY_ONE_DAYS_MS,
      NOW
    );

    await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    const reapCall = logInfo.mock.calls.find(
      (call: unknown[]) => call[0] === "quarantine-file-reaped"
    );
    expect(reapCall).toBeDefined();
    const context = reapCall![1] as Record<string, unknown>;
    expect(JSON.stringify(context)).not.toContain(tmpDir);
    expect(JSON.stringify(context)).not.toContain(os.homedir());
  });
});

describe("cleanupGlobalQuarantineFiles", () => {
  const NOW = Math.floor(Date.now() / 1000) * 1000;

  it("deletes recipes.json.corrupted.* older than 30 days", async () => {
    const filePath = path.join(tmpDir, "recipes.json.corrupted.1234567890");
    await fs.writeFile(filePath, "data");
    const oldTime = new Date(NOW - THIRTY_ONE_DAYS_MS);
    await fs.utimes(filePath, oldTime, oldTime);

    const deleted = await cleanupGlobalQuarantineFiles(tmpDir, NOW);
    expect(deleted).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("preserves fresh recipes.json.corrupted.* files", async () => {
    const filePath = path.join(tmpDir, "recipes.json.corrupted.1234567890");
    await fs.writeFile(filePath, "data");
    const recentTime = new Date(NOW - TWENTY_NINE_DAYS_MS);
    await fs.utimes(filePath, recentTime, recentTime);

    const deleted = await cleanupGlobalQuarantineFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("ignores the live recipes.json file and other unrelated files", async () => {
    const liveFile = path.join(tmpDir, "recipes.json");
    const unrelatedFile = path.join(tmpDir, "other.json");
    await fs.writeFile(liveFile, "live");
    await fs.writeFile(unrelatedFile, "data");
    const oldTime = new Date(NOW - THIRTY_ONE_DAYS_MS);
    await fs.utimes(liveFile, oldTime, oldTime);
    await fs.utimes(unrelatedFile, oldTime, oldTime);

    const deleted = await cleanupGlobalQuarantineFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
    await expect(fs.access(liveFile)).resolves.toBeUndefined();
    await expect(fs.access(unrelatedFile)).resolves.toBeUndefined();
  });

  it("returns 0 when global config dir is missing", async () => {
    const nonexistent = path.join(tmpDir, "does-not-exist");
    const deleted = await cleanupGlobalQuarantineFiles(nonexistent, NOW);
    expect(deleted).toBe(0);
  });
});

describe("cleanupUserDataRootQuarantineFiles", () => {
  const NOW = Math.floor(Date.now() / 1000) * 1000;

  it("deletes config.json.corrupted.* older than 30 days", async () => {
    const filePath = path.join(tmpDir, "config.json.corrupted.1234567890");
    await fs.writeFile(filePath, "data");
    const oldTime = new Date(NOW - THIRTY_ONE_DAYS_MS);
    await fs.utimes(filePath, oldTime, oldTime);

    const deleted = await cleanupUserDataRootQuarantineFiles(tmpDir, NOW);
    expect(deleted).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("preserves fresh config.json.corrupted.* files", async () => {
    const filePath = path.join(tmpDir, "config.json.corrupted.1234567890");
    await fs.writeFile(filePath, "data");
    const recentTime = new Date(NOW - TWENTY_NINE_DAYS_MS);
    await fs.utimes(filePath, recentTime, recentTime);

    const deleted = await cleanupUserDataRootQuarantineFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("does not recurse into Chromium-managed subdirectories", async () => {
    const localStorageDir = path.join(tmpDir, "Local Storage");
    const indexedDbDir = path.join(tmpDir, "IndexedDB");
    await fs.mkdir(localStorageDir, { recursive: true });
    await fs.mkdir(indexedDbDir, { recursive: true });

    const nestedQuarantine = path.join(localStorageDir, "config.json.corrupted.1234567890");
    await fs.writeFile(nestedQuarantine, "data");
    const oldTime = new Date(NOW - THIRTY_ONE_DAYS_MS);
    await fs.utimes(nestedQuarantine, oldTime, oldTime);

    const deleted = await cleanupUserDataRootQuarantineFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
    await expect(fs.access(nestedQuarantine)).resolves.toBeUndefined();
    await expect(fs.access(localStorageDir)).resolves.toBeUndefined();
    await expect(fs.access(indexedDbDir)).resolves.toBeUndefined();
  });

  it("ignores the live config.json file and other unrelated files", async () => {
    const liveConfig = path.join(tmpDir, "config.json");
    const unrelatedFile = path.join(tmpDir, "Preferences");
    await fs.writeFile(liveConfig, "{}");
    await fs.writeFile(unrelatedFile, "data");
    const oldTime = new Date(NOW - THIRTY_ONE_DAYS_MS);
    await fs.utimes(liveConfig, oldTime, oldTime);
    await fs.utimes(unrelatedFile, oldTime, oldTime);

    const deleted = await cleanupUserDataRootQuarantineFiles(tmpDir, NOW);
    expect(deleted).toBe(0);
    await expect(fs.access(liveConfig)).resolves.toBeUndefined();
    await expect(fs.access(unrelatedFile)).resolves.toBeUndefined();
  });

  it("returns 0 when userData dir is missing", async () => {
    const nonexistent = path.join(tmpDir, "does-not-exist");
    const deleted = await cleanupUserDataRootQuarantineFiles(nonexistent, NOW);
    expect(deleted).toBe(0);
  });
});
