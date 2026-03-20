import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SESSION_SNAPSHOT_MAX_BYTES,
  getSessionPath,
  persistSessionSnapshotAsync,
  persistSessionSnapshotSync,
  restoreSessionFromFile,
  deleteSessionFile,
  evictSessionFiles,
  writeHibernatedMarker,
  readAndDeleteHibernatedMarker,
  getHibernatedMarkerPath,
} from "../terminalSessionPersistence.js";

function createMockHeadless(bufferType: "normal" | "alternate" = "normal") {
  let currentType = bufferType;
  let markerLine = 0;
  const writeFn = vi.fn().mockImplementation((data: string) => {
    if (data === "\x1b[?1049l") currentType = "normal";
    const newlines = (data.match(/\r\n/g) || []).length;
    markerLine += newlines;
  });
  return {
    write: writeFn,
    buffer: {
      get active() {
        return { type: currentType, length: 100 };
      },
      normal: { baseY: 0, cursorY: 0, length: 100 },
    },
    registerMarker: vi.fn().mockImplementation(() => ({
      line: markerLine,
      dispose: vi.fn(),
    })),
  };
}

describe("terminalSessionPersistence", () => {
  let userDataDir: string;
  const previousUserData = process.env.CANOPY_USER_DATA;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "canopy-session-persist-"));
    process.env.CANOPY_USER_DATA = userDataDir;
  });

  afterEach(async () => {
    process.env.CANOPY_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  it("rejects traversal-style terminal IDs when building session path", () => {
    expect(getSessionPath("../escape")).toBeNull();
    expect(getSessionPath("nested/term")).toBeNull();
    expect(getSessionPath("nested\\term")).toBeNull();
    expect(getSessionPath("/absolute")).toBeNull();
    expect(getSessionPath("")).toBeNull();
  });

  it("does not persist snapshots larger than max bytes", async () => {
    const oversized = "x".repeat(SESSION_SNAPSHOT_MAX_BYTES + 1);

    persistSessionSnapshotSync("term-sync", oversized);
    await persistSessionSnapshotAsync("term-async", oversized);

    const syncPath = path.join(userDataDir, "terminal-sessions", "term-sync.restore");
    const asyncPath = path.join(userDataDir, "terminal-sessions", "term-async.restore");
    expect(fs.existsSync(syncPath)).toBe(false);
    expect(fs.existsSync(asyncPath)).toBe(false);
  });

  it("restores valid snapshot and injects separator banner", async () => {
    const sessionDir = path.join(userDataDir, "terminal-sessions");
    await fsp.mkdir(sessionDir, { recursive: true });

    const validPath = path.join(sessionDir, "term-valid.restore");
    await fsp.writeFile(validPath, "hello world", "utf8");

    const headless = createMockHeadless();
    const result = restoreSessionFromFile(headless as never, "term-valid");

    expect(result.restored).toBe(true);
    expect(result.bannerStartMarker).not.toBeNull();
    expect(result.bannerEndMarker).not.toBeNull();

    expect(headless.write).toHaveBeenCalledWith("hello world");
    const bannerCall = headless.write.mock.calls.find((c: string[]) =>
      c[0].includes("Session restored")
    );
    expect(bannerCall).toBeDefined();

    // Start marker should be on the banner row (after the \r\n separator),
    // not on the last historical content line
    expect(result.bannerStartMarker!.line).toBeGreaterThan(0);
    expect(result.bannerEndMarker!.line).toBeGreaterThan(result.bannerStartMarker!.line);
  });

  it("ignores oversized snapshots and returns not restored", async () => {
    const sessionDir = path.join(userDataDir, "terminal-sessions");
    await fsp.mkdir(sessionDir, { recursive: true });

    const hugePath = path.join(sessionDir, "term-huge.restore");
    await fsp.writeFile(hugePath, "y".repeat(SESSION_SNAPSHOT_MAX_BYTES + 100), "utf8");

    const headless = createMockHeadless();
    const result = restoreSessionFromFile(headless as never, "term-huge");

    expect(result.restored).toBe(false);
    expect(headless.write).not.toHaveBeenCalled();
  });

  it("returns not restored when no session file exists", () => {
    const headless = createMockHeadless();
    const result = restoreSessionFromFile(headless as never, "nonexistent");

    expect(result.restored).toBe(false);
    expect(result.bannerStartMarker).toBeNull();
    expect(result.bannerEndMarker).toBeNull();
    expect(headless.write).not.toHaveBeenCalled();
  });

  it("handles alternate screen by exiting and showing TUI explanation", async () => {
    const sessionDir = path.join(userDataDir, "terminal-sessions");
    await fsp.mkdir(sessionDir, { recursive: true });

    const sessionPath = path.join(sessionDir, "term-alt.restore");
    await fsp.writeFile(sessionPath, "alt-screen-content", "utf8");

    const headless = createMockHeadless("alternate");
    const result = restoreSessionFromFile(headless as never, "term-alt");

    expect(result.restored).toBe(true);

    const writeArgs = headless.write.mock.calls.map((c: string[]) => c[0]);
    expect(writeArgs).toContain("\x1b[?1049l");
    const tuiBanner = writeArgs.find((a: string) => a.includes("full-screen app"));
    expect(tuiBanner).toBeDefined();
  });

  describe("deleteSessionFile", () => {
    it("deletes an existing .restore file", async () => {
      const sessionDir = path.join(userDataDir, "terminal-sessions");
      await fsp.mkdir(sessionDir, { recursive: true });
      const filePath = path.join(sessionDir, "term-1.restore");
      await fsp.writeFile(filePath, "data", "utf8");

      await deleteSessionFile("term-1");

      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("no-ops on a missing file (ENOENT-safe)", async () => {
      await expect(deleteSessionFile("nonexistent-term")).resolves.toBeUndefined();
    });

    it("no-ops for an invalid terminal ID", async () => {
      await expect(deleteSessionFile("../escape")).resolves.toBeUndefined();
    });
  });

  describe("evictSessionFiles", () => {
    let sessionDir: string;

    beforeEach(async () => {
      sessionDir = path.join(userDataDir, "terminal-sessions");
      await fsp.mkdir(sessionDir, { recursive: true });
    });

    async function createFile(name: string, content: string, ageMs: number = 0) {
      const filePath = path.join(sessionDir, name);
      await fsp.writeFile(filePath, content, "utf8");
      if (ageMs > 0) {
        const mtime = new Date(Date.now() - ageMs);
        await fsp.utimes(filePath, mtime, mtime);
      }
    }

    it("returns zeros when session directory does not exist", async () => {
      await fsp.rm(sessionDir, { recursive: true, force: true });
      const result = await evictSessionFiles({ ttlMs: 1000, maxBytes: 1024 });
      expect(result).toEqual({ deleted: 0, bytesFreed: 0 });
    });

    it("ignores .tmp files and non-.restore files", async () => {
      await createFile("term-1.restore.tmp", "atomic write in progress");
      await createFile("term-2.tmp", "other temporary data");
      await createFile("term-3.txt", "text data");
      await createFile("term-4.restore", "valid data");

      const result = await evictSessionFiles({
        ttlMs: 1000,
        maxBytes: 1024 * 1024,
        knownIds: new Set(["term-4"]),
      });

      expect(result.deleted).toBe(0);
      expect(fs.existsSync(path.join(sessionDir, "term-1.restore.tmp"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "term-2.tmp"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "term-3.txt"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "term-4.restore"))).toBe(true);
    });

    it("deletes orphan files whose IDs are not in knownIds", async () => {
      await createFile("known-term.restore", "keep me");
      await createFile("orphan-term.restore", "delete me");

      const result = await evictSessionFiles({
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        maxBytes: 1024 * 1024,
        knownIds: new Set(["known-term"]),
      });

      expect(result.deleted).toBe(1);
      expect(fs.existsSync(path.join(sessionDir, "known-term.restore"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "orphan-term.restore"))).toBe(false);
    });

    it("preserves files within TTL that are in knownIds", async () => {
      await createFile("term-1.restore", "recent data");

      const result = await evictSessionFiles({
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        maxBytes: 1024 * 1024,
        knownIds: new Set(["term-1"]),
      });

      expect(result.deleted).toBe(0);
      expect(fs.existsSync(path.join(sessionDir, "term-1.restore"))).toBe(true);
    });

    it("applies TTL with 30s buffer correctly at boundary", async () => {
      const ttlMs = 60_000; // 1 minute TTL
      // File at ttlMs + 15_000ms old (well within 30s buffer) should be kept
      await createFile("kept.restore", "data", ttlMs + 15_000);
      // File at ttlMs + 60_000ms old (well past buffer) should be deleted
      await createFile("deleted.restore", "data", ttlMs + 60_000);

      const result = await evictSessionFiles({
        ttlMs,
        maxBytes: 1024 * 1024,
      });

      expect(result.deleted).toBe(1);
      expect(fs.existsSync(path.join(sessionDir, "kept.restore"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "deleted.restore"))).toBe(false);
    });

    it("enforces maxBytes by deleting oldest files first", async () => {
      // Create 3 files of 100 bytes each, with different ages
      const content = "x".repeat(100);
      await createFile("oldest.restore", content, 3000);
      await createFile("middle.restore", content, 2000);
      await createFile("newest.restore", content, 1000);

      const result = await evictSessionFiles({
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        maxBytes: 200, // only room for 2 files
      });

      expect(result.deleted).toBe(1);
      expect(fs.existsSync(path.join(sessionDir, "oldest.restore"))).toBe(false);
      expect(fs.existsSync(path.join(sessionDir, "middle.restore"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "newest.restore"))).toBe(true);
    });

    it("reports accurate deleted count and bytesFreed", async () => {
      const content50 = "x".repeat(50);
      const content100 = "x".repeat(100);
      await createFile("orphan1.restore", content50);
      await createFile("orphan2.restore", content100);

      const result = await evictSessionFiles({
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        maxBytes: 1024 * 1024,
        knownIds: new Set(),
      });

      expect(result.deleted).toBe(2);
      expect(result.bytesFreed).toBe(150);
    });

    it("deletes known files that exceed TTL", async () => {
      const ttlMs = 60_000;
      await createFile("known-old.restore", "old data", ttlMs + 60_000);

      const result = await evictSessionFiles({
        ttlMs,
        maxBytes: 1024 * 1024,
        knownIds: new Set(["known-old"]),
      });

      expect(result.deleted).toBe(1);
      expect(fs.existsSync(path.join(sessionDir, "known-old.restore"))).toBe(false);
    });

    it("works without knownIds (TTL-only mode)", async () => {
      const ttlMs = 60_000;
      await createFile("old.restore", "data", ttlMs + 60_000);
      await createFile("recent.restore", "data", 1000);

      const result = await evictSessionFiles({ ttlMs, maxBytes: 1024 * 1024 });

      expect(result.deleted).toBe(1);
      expect(fs.existsSync(path.join(sessionDir, "old.restore"))).toBe(false);
      expect(fs.existsSync(path.join(sessionDir, "recent.restore"))).toBe(true);
    });
  });

  describe("hibernation markers", () => {
    it("writes and reads a hibernation marker", () => {
      writeHibernatedMarker("term-hibernate-1");

      const markerPath = getHibernatedMarkerPath("term-hibernate-1");
      expect(markerPath).not.toBeNull();
      expect(fs.existsSync(markerPath!)).toBe(true);

      const result = readAndDeleteHibernatedMarker("term-hibernate-1");
      expect(result).toBe(true);
      expect(fs.existsSync(markerPath!)).toBe(false);
    });

    it("returns false when no marker exists", () => {
      expect(readAndDeleteHibernatedMarker("nonexistent")).toBe(false);
    });

    it("deleteSessionFile also removes the hibernation marker", async () => {
      const sessionDir = path.join(userDataDir, "terminal-sessions");
      await fsp.mkdir(sessionDir, { recursive: true });
      await fsp.writeFile(path.join(sessionDir, "term-del.restore"), "data", "utf8");
      writeHibernatedMarker("term-del");

      expect(fs.existsSync(path.join(sessionDir, "term-del.hibernated"))).toBe(true);

      await deleteSessionFile("term-del");

      expect(fs.existsSync(path.join(sessionDir, "term-del.restore"))).toBe(false);
      expect(fs.existsSync(path.join(sessionDir, "term-del.hibernated"))).toBe(false);
    });

    it("restoreSessionFromFile shows hibernation banner when marker exists", async () => {
      const sessionDir = path.join(userDataDir, "terminal-sessions");
      await fsp.mkdir(sessionDir, { recursive: true });
      await fsp.writeFile(path.join(sessionDir, "term-hib.restore"), "content", "utf8");
      writeHibernatedMarker("term-hib");

      const headless = createMockHeadless();
      const result = restoreSessionFromFile(headless as never, "term-hib");

      expect(result.restored).toBe(true);
      const bannerCall = headless.write.mock.calls.find(
        ([arg]: unknown[]) => typeof arg === "string" && arg.includes("hibernated")
      );
      expect(bannerCall).toBeDefined();
      // Marker should be cleaned up
      expect(fs.existsSync(path.join(sessionDir, "term-hib.hibernated"))).toBe(false);
    });

    it("restoreSessionFromFile shows normal banner without marker", async () => {
      const sessionDir = path.join(userDataDir, "terminal-sessions");
      await fsp.mkdir(sessionDir, { recursive: true });
      await fsp.writeFile(path.join(sessionDir, "term-normal.restore"), "content", "utf8");

      const headless = createMockHeadless();
      const result = restoreSessionFromFile(headless as never, "term-normal");

      expect(result.restored).toBe(true);
      const bannerCall = headless.write.mock.calls.find(
        ([arg]: unknown[]) => typeof arg === "string" && arg.includes("Session restored")
      );
      expect(bannerCall).toBeDefined();
    });
  });
});
