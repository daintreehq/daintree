import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "fs/promises";
import path from "path";
import os from "os";

const { mockedOpen, mockedSync, mockedClose } = vi.hoisted(() => ({
  mockedOpen: vi.fn(),
  mockedSync: vi.fn(),
  mockedClose: vi.fn(),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, open: mockedOpen };
});

import { resilientAtomicWriteFile } from "../fs.js";

describe("syncParentDirectory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-dirsync-test-"));
    vi.clearAllMocks();
    mockedOpen.mockResolvedValue({ sync: mockedSync, close: mockedClose });
    mockedSync.mockResolvedValue(undefined);
    mockedClose.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("opens parent dir, syncs, and closes after rename", async () => {
    const calls: string[] = [];
    mockedSync.mockImplementation(() => {
      calls.push("dir-sync");
      return Promise.resolve();
    });

    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, "data");

    expect(mockedOpen).toHaveBeenCalledWith(tmpDir, "r");
    expect(mockedSync).toHaveBeenCalled();
    expect(mockedClose).toHaveBeenCalled();
    // Sync must happen after rename (rename occurs before syncParentDirectory call)
    expect(calls).toEqual(["dir-sync"]);
  });

  it("propagates sync error and still closes handle", async () => {
    mockedSync.mockRejectedValue(new Error("EIO: fsync failed"));

    const target = path.join(tmpDir, "test.json");
    await expect(resilientAtomicWriteFile(target, "data")).rejects.toThrow("EIO");

    expect(mockedClose).toHaveBeenCalled();
  });

  it("opens correct parent dir for nested paths", async () => {
    const nestedDir = path.join(tmpDir, "sub", "nested");
    const target = path.join(nestedDir, "file.json");

    await mkdir(nestedDir, { recursive: true });
    await resilientAtomicWriteFile(target, "data");

    expect(mockedOpen).toHaveBeenCalledWith(nestedDir, "r");
  });
});

describe("syncParentDirectory win32 skip", () => {
  let tmpDir: string;
  let platformRestore: () => void;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-dirsync-win-test-"));
    vi.clearAllMocks();
    platformRestore = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    platformRestore();
    vi.restoreAllMocks();
  });

  it("skips dir fsync on win32", async () => {
    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, "data");

    expect(mockedOpen).not.toHaveBeenCalled();
  });
});
