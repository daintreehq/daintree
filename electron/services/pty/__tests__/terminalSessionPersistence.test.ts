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

  it("restores valid snapshot content but ignores oversized snapshots", async () => {
    const sessionDir = path.join(userDataDir, "terminal-sessions");
    await fsp.mkdir(sessionDir, { recursive: true });

    const validPath = path.join(sessionDir, "term-valid.restore");
    const hugePath = path.join(sessionDir, "term-huge.restore");

    await fsp.writeFile(validPath, "hello world", "utf8");
    await fsp.writeFile(hugePath, "y".repeat(SESSION_SNAPSHOT_MAX_BYTES + 100), "utf8");

    const headless = {
      write: vi.fn(),
    };

    restoreSessionFromFile(headless as never, "term-valid");
    restoreSessionFromFile(headless as never, "term-huge");

    expect(headless.write).toHaveBeenCalledTimes(1);
    expect(headless.write).toHaveBeenCalledWith("hello world");
  });
});
