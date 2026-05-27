import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Mock electron so importing the clipboard handler module doesn't pull in the
// real native bindings. The cleanup logic under test never touches these.
vi.mock("electron", () => ({
  clipboard: { readImage: vi.fn(), writeImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

// Redirect os.tmpdir() to a throwaway directory so the cleanup operates on real
// files we control. The base dir is created inside the factory where the real
// os module is still available.
const osMockState = vi.hoisted(() => ({ base: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  osMockState.base = nodeFs.mkdtempSync(nodePath.join(actual.tmpdir(), "clipboard-test-"));
  return { ...actual, tmpdir: () => osMockState.base };
});

// Dynamic import so the mocks apply before the module loads.
const { cleanupOldClipboardImages } = await import("../ipc/handlers/clipboard.js");

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_COUNT = 20;
// Round to a second boundary to avoid mtime truncation on filesystems with 1s
// granularity (ext4).
const NOW = Math.floor(Date.now() / 1000) * 1000;

function clipboardDir(): string {
  return path.join(osMockState.base, "daintree-clipboard");
}

async function createClipboardFile(name: string, ageMs: number): Promise<string> {
  const filePath = path.join(clipboardDir(), name);
  await fs.writeFile(filePath, "png-bytes");
  const mtime = new Date(NOW - ageMs);
  await fs.utimes(filePath, mtime, mtime);
  return filePath;
}

async function listClipboardFiles(): Promise<string[]> {
  const entries = await fs.readdir(clipboardDir());
  return entries.sort();
}

beforeEach(async () => {
  await fs.rm(clipboardDir(), { recursive: true, force: true });
  await fs.mkdir(clipboardDir(), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(osMockState.base, { recursive: true, force: true });
});

describe("cleanupOldClipboardImages — age eviction", () => {
  it("deletes files older than the 24h window", async () => {
    const old = await createClipboardFile("clipboard-1-aaa.png", MAX_AGE_MS + 60_000);
    await cleanupOldClipboardImages(NOW);
    await expect(fs.access(old)).rejects.toThrow();
  });

  it("preserves files within the 24h window", async () => {
    const fresh = await createClipboardFile("clipboard-2-bbb.png", MAX_AGE_MS - 60_000);
    await cleanupOldClipboardImages(NOW);
    await expect(fs.access(fresh)).resolves.toBeUndefined();
  });

  it("preserves a file exactly at the 24h boundary but evicts one past it", async () => {
    const atBoundary = await createClipboardFile("clipboard-at-boundary.png", MAX_AGE_MS);
    const pastBoundary = await createClipboardFile(
      "clipboard-past-boundary.png",
      MAX_AGE_MS + 1000
    );
    await cleanupOldClipboardImages(NOW);
    await expect(fs.access(atBoundary)).resolves.toBeUndefined();
    await expect(fs.access(pastBoundary)).rejects.toThrow();
  });

  it("ignores files that don't match the clipboard naming pattern", async () => {
    const other = path.join(clipboardDir(), "unrelated.txt");
    await fs.writeFile(other, "keep me");
    const mtime = new Date(NOW - (MAX_AGE_MS + 60_000));
    await fs.utimes(other, mtime, mtime);

    await cleanupOldClipboardImages(NOW);
    await expect(fs.access(other)).resolves.toBeUndefined();
  });

  it("returns without error when the clipboard dir doesn't exist", async () => {
    await fs.rm(clipboardDir(), { recursive: true, force: true });
    await expect(cleanupOldClipboardImages(NOW)).resolves.toBeUndefined();
  });
});

describe("cleanupOldClipboardImages — count cap", () => {
  it("keeps only the newest MAX_FILE_COUNT files when more survive the age check", async () => {
    const total = MAX_FILE_COUNT + 5;
    // Older index => older mtime. All within the 24h window so age eviction
    // doesn't apply; only the count cap should.
    for (let i = 0; i < total; i++) {
      const ageMs = (total - i) * 60_000; // i=0 oldest, i=total-1 newest
      await createClipboardFile(`clipboard-${i}-x.png`, ageMs);
    }

    await cleanupOldClipboardImages(NOW);

    const remaining = await listClipboardFiles();
    expect(remaining).toHaveLength(MAX_FILE_COUNT);
    // The 5 oldest (indices 0-4) should be gone; the newest 20 (5-24) kept.
    expect(remaining).not.toContain("clipboard-0-x.png");
    expect(remaining).not.toContain("clipboard-4-x.png");
    expect(remaining).toContain("clipboard-5-x.png");
    expect(remaining).toContain(`clipboard-${total - 1}-x.png`);
  });

  it("does not evict when exactly MAX_FILE_COUNT files survive", async () => {
    for (let i = 0; i < MAX_FILE_COUNT; i++) {
      await createClipboardFile(`clipboard-${i}-x.png`, (i + 1) * 60_000);
    }

    await cleanupOldClipboardImages(NOW);

    const remaining = await listClipboardFiles();
    expect(remaining).toHaveLength(MAX_FILE_COUNT);
  });

  it("applies age eviction before the count cap", async () => {
    // 3 old (evicted by age) + 22 fresh. After age eviction 22 survive; count
    // cap trims to 20.
    for (let i = 0; i < 3; i++) {
      await createClipboardFile(`clipboard-old-${i}.png`, MAX_AGE_MS + (i + 1) * 60_000);
    }
    for (let i = 0; i < 22; i++) {
      await createClipboardFile(`clipboard-fresh-${i}.png`, (i + 1) * 1_000);
    }

    await cleanupOldClipboardImages(NOW);

    const remaining = await listClipboardFiles();
    expect(remaining).toHaveLength(MAX_FILE_COUNT);
    expect(remaining.every((name) => name.startsWith("clipboard-fresh-"))).toBe(true);
    // fresh-21 and fresh-20 carry the largest age offsets (oldest mtimes), so
    // the count cap evicts exactly those two.
    expect(remaining).not.toContain("clipboard-fresh-21.png");
    expect(remaining).not.toContain("clipboard-fresh-20.png");
    expect(remaining).toContain("clipboard-fresh-0.png");
  });
});
