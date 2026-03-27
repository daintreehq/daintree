import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { cleanupQuarantinedProjectFiles } from "../projectQuarantineCleanup.js";

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
const TWENTY_NINE_DAYS_MS = 29 * 24 * 60 * 60 * 1000;

const VALID_PROJECT_ID = "a".repeat(64);
const VALID_PROJECT_ID_2 = "b".repeat(64);

const QUARANTINE_FILES = [
  "state.json.corrupted",
  "settings.json.corrupted",
  "recipes.json.corrupted",
  "workflows.json.corrupted",
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
      "state.json.corrupted",
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
      "state.json.corrupted",
      TWENTY_NINE_DAYS_MS,
      NOW
    );

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);

    expect(deleted).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("deletes all four known quarantine file types when old", async () => {
    const projectDir = await createProjectDir(VALID_PROJECT_ID);
    for (const filename of QUARANTINE_FILES) {
      await createCorruptedFile(projectDir, filename, THIRTY_ONE_DAYS_MS, NOW);
    }

    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, NOW);
    expect(deleted).toBe(4);

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

  it("skips directories with invalid project IDs", async () => {
    const invalidDir = path.join(tmpDir, "not-a-valid-hex-id");
    await fs.mkdir(invalidDir);
    const filePath = path.join(invalidDir, "state.json.corrupted");
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
      "state.json.corrupted",
      THIRTY_ONE_DAYS_MS,
      NOW
    );
    const oldFile2 = await createCorruptedFile(
      dir2,
      "settings.json.corrupted",
      THIRTY_ONE_DAYS_MS,
      NOW
    );
    const freshFile = await createCorruptedFile(
      dir2,
      "recipes.json.corrupted",
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
    await createCorruptedFile(projectDir, "state.json.corrupted", THIRTY_ONE_DAYS_MS, NOW);

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
      "state.json.corrupted",
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
      "state.json.corrupted",
      1 * 24 * 60 * 60 * 1000,
      Date.now()
    );

    // But if we pass a `now` far in the future, the file appears old
    const futureNow = Date.now() + 60 * 24 * 60 * 60 * 1000;
    const deleted = await cleanupQuarantinedProjectFiles(tmpDir, futureNow);
    expect(deleted).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });
});
