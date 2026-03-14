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
});
